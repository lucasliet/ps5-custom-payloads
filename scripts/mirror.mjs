import fs from "node:fs/promises";
import {
  GITHUB_API,
  MANIFEST_ASSET,
  MIRROR_OWNER,
  MIRROR_PREFIX,
  MIRROR_REPO,
  SNAPSHOTS_TO_KEEP,
  UPLOAD_API,
  checksumFromDigest,
  downloadBytes,
  fetchJson,
  headers,
  lastUpdateDate,
  manifestEntryMatches,
  resolveUpstream,
  sha256Hex,
  snapshotTag,
  snapshotsToPrune,
  versionedFilename,
} from "./lib.mjs";
import sourcesConfig from "../sources.json" with { type: "json" };

const DRY_RUN = process.env.DRY_RUN === "1";
const token = () => process.env.GITHUB_TOKEN;

function mirrorUrl(tag, filename) {
  return `https://github.com/${MIRROR_OWNER}/${MIRROR_REPO}/releases/download/${tag}/${filename}`;
}

function manifestEntry(source, { version, lastUpdate, checksum }, tag) {
  const filename = versionedFilename(source.asset, version);
  const url = mirrorUrl(tag, filename);
  return {
    name: source.name,
    filename,
    url,
    source: `https://github.com/${source.repo}/releases`,
    source_direct: url,
    description: source.description,
    last_update: lastUpdate,
    version,
    category: source.category,
    checksum,
  };
}

async function createSnapshotRelease(tag, notes) {
  const release = await fetchJson(
    `${GITHUB_API}/repos/${MIRROR_OWNER}/${MIRROR_REPO}/releases`,
    token(),
    {
      method: "POST",
      headers: { ...headers(token()), "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        name: `Payload snapshot ${tag.slice(MIRROR_PREFIX.length)}`,
        body: notes,
        draft: false,
        prerelease: false,
      }),
    },
  );
  return release;
}

async function deleteReleaseAndTag(release) {
  await fetchJson(
    `${GITHUB_API}/repos/${MIRROR_OWNER}/${MIRROR_REPO}/releases/${release.id}`,
    token(),
    { method: "DELETE" },
  );
  // Deleting a release leaves its tag behind; remove it so the tag namespace
  // only holds live snapshots.
  await fetchJson(
    `${GITHUB_API}/repos/${MIRROR_OWNER}/${MIRROR_REPO}/git/refs/tags/${release.tag_name}`,
    token(),
    { method: "DELETE" },
  );
}

async function uploadAsset(releaseId, filename, bytes, contentType) {
  const url =
    `${UPLOAD_API}/repos/${MIRROR_OWNER}/${MIRROR_REPO}/releases/${releaseId}` +
    `/assets?name=${encodeURIComponent(filename)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers(token()),
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`${filename}: asset upload returned ${response.status}`);
  }
  return response.json();
}

const allReleases = await fetchJson(
  `${GITHUB_API}/repos/${MIRROR_OWNER}/${MIRROR_REPO}/releases?per_page=100`,
  token(),
);
const snapshots = allReleases.filter(
  (r) => !r.draft && (r.tag_name || "").startsWith(MIRROR_PREFIX),
);
const previous = [...snapshots].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;
const previousManifest = new Map();
if (previous) {
  const manifestAsset = previous.assets?.find((a) => a.name === MANIFEST_ASSET);
  if (!manifestAsset) throw new Error(`${previous.tag_name}: snapshot has no ${MANIFEST_ASSET} asset`);
  const response = await fetch(manifestAsset.browser_download_url, {
    headers: headers(token()),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`previous manifest download returned ${response.status}`);
  for (const entry of await response.json()) previousManifest.set(entry.name, entry);
}

// 1. Resolve every source against its upstream repo. Unreachable upstreams
// fall back to the previous snapshot (backup policy); without one, fail.
const planned = [];
for (const source of sourcesConfig.sources) {
  let resolved = null;
  let fallback = false;
  try {
    resolved = await resolveUpstream(source, token());
  } catch (error) {
    const entry = previousManifest.get(source.name);
    if (!entry) throw new Error(`${source.repo}: ${error.message} (no snapshot fallback)`);
    console.warn(`fallback to previous snapshot for ${source.name}: ${error.message}`);
    fallback = true;
    resolved = { entry };
  }
  if (fallback) {
    planned.push({ source, fallbackEntry: resolved.entry });
    continue;
  }
  const { release, asset, version } = resolved;
  planned.push({
    source,
    version,
    lastUpdate: lastUpdateDate(release, asset),
    upstreamDigest: checksumFromDigest(asset.digest),
    upstreamUrl: asset.browser_download_url,
    unchanged: manifestEntryMatches(previousManifest.get(source.name) ?? {}, {
      version,
      upstreamDigest: checksumFromDigest(asset.digest),
      source,
      lastUpdate: lastUpdateDate(release, asset),
    }),
  });
}

const changed = planned.filter((p) => !p.unchanged && !p.fallbackEntry);
if (!previous) console.log("no previous snapshot found; a full snapshot will be created");
if (previous && changed.length === 0) {
  // Fallback bytes are copies of the previous snapshot, so a snapshot with
  // no upstream changes would only burn a retention slot for zero benefit.
  console.log(`no upstream changes since ${previous.tag_name}; nothing to do`);
  process.exit(0);
}
console.log(
  `snapshot needed: ${changed.map((p) => `${p.source.name} ${p.version}`).join(", ") || "first snapshot"}`,
);
if (DRY_RUN) {
  console.log("DRY_RUN=1: skipping download, release creation and upload");
  process.exit(0);
}

// 2. Download bytes (upstream first, previous snapshot as fallback) and build
// the manifest with checksums computed over the mirrored bytes.
const tag = snapshotTag();
const manifest = [];
const payloads = [];
for (const item of planned) {
  let bytes;
  let base;
  if (item.fallbackEntry) {
    const asset = previous.assets?.find((a) => a.name === item.fallbackEntry.filename);
    if (!asset) throw new Error(`${item.source.name}: fallback asset missing from ${previous.tag_name}`);
    bytes = await downloadBytes(asset.browser_download_url, token());
    base = { version: item.fallbackEntry.version, lastUpdate: item.fallbackEntry.last_update };
  } else {
    bytes = await downloadBytes(item.upstreamUrl, token());
    if (item.upstreamDigest && sha256Hex(bytes) !== item.upstreamDigest) {
      console.warn(`${item.source.name}: downloaded bytes differ from upstream digest`);
    }
    base = { version: item.version, lastUpdate: item.lastUpdate };
  }
  const checksum = sha256Hex(bytes);
  const entry = manifestEntry(item.source, { ...base, checksum }, tag);
  manifest.push(entry);
  payloads.push({ filename: entry.filename, bytes });
}
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");

// 3. Create the snapshot release (replacing a half-finished one when the tag
// already exists) and upload every asset.
const stale = snapshots.find((r) => r.tag_name === tag);
if (stale) {
  console.log(`${tag} already exists; replacing it`);
  await deleteReleaseAndTag(stale);
}
const notes = [
  "Mirrored payload snapshot. Each ELF is an unmodified copy of the upstream asset below.",
  "",
  ...manifest.map(
    (e, i) => `- ${e.name} ${e.version} (${planned[i].source.repo}, sha256 ${e.checksum})`,
  ),
].join("\n");
const release = await createSnapshotRelease(tag, notes);
for (const { filename, bytes } of payloads) {
  await uploadAsset(release.id, filename, bytes, "application/octet-stream");
  console.log(`uploaded ${filename} (${bytes.length} bytes)`);
}
await uploadAsset(release.id, MANIFEST_ASSET, manifestBytes, "application/json");
console.log(`uploaded ${MANIFEST_ASSET}`);

// 4. Point the static catalog at the new snapshot and prune old snapshots.
await fs.writeFile("payloads.json", manifestBytes);
console.log("wrote payloads.json");

// The replaced stale release (same tag) is already gone; exclude it so the
// prune pass never issues a second DELETE for it.
const pruned = snapshotsToPrune(
  [...allReleases.filter((r) => r.tag_name !== tag), release],
  SNAPSHOTS_TO_KEEP,
);
for (const old of pruned) {
  await deleteReleaseAndTag(old);
  console.log(`pruned ${old.tag_name}`);
}
console.log(JSON.stringify(manifest, null, 2));
