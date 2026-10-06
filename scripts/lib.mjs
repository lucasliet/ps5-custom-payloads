/* Shared catalog logic for the mirror architecture.

`sources.json` tracks upstream repositories. A snapshot release in this
repository (`mirror-<UTC timestamp>` tag) holds one ELF per payload plus a
`payloads.json` manifest asset. The catalog served to Payload Manager points
`url`/`source_direct` at the mirrored assets; every other field keeps the
upstream metadata (name, version, description, category, last_update).

Kept dependency-free (global fetch only) so `mirror.mjs`, `generate.mjs`
and tests can all import it.
*/

import { createHash } from "node:crypto";

export const MIRROR_OWNER = "lucasliet";
export const MIRROR_REPO = "ps5-custom-payloads";
export const MIRROR_PREFIX = "mirror-";
export const MANIFEST_ASSET = "payloads.json";
export const GITHUB_API = "https://api.github.com";
export const UPLOAD_API = "https://uploads.github.com";
export const RELEASES_PER_PAGE = 30;
export const SNAPSHOTS_TO_KEEP = 5;

export function headers(token) {
  const h = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ps5-custom-payloads-mirror",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export function assetTimestamp(release, asset) {
  return asset.updated_at || release.published_at || release.created_at;
}

export function normalizeVersion(release, asset) {
  const tag = release.tag_name || "unknown";
  if (/\d/.test(tag)) return tag;
  const timestamp = assetTimestamp(release, asset);
  if (!timestamp) return tag;
  return `${tag}-${timestamp.replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

export function checksumFromDigest(digest) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest || "");
  return match?.[1]?.toLowerCase();
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function lastUpdateDate(release, asset) {
  const timestamp = assetTimestamp(release, asset);
  return timestamp ? timestamp.slice(0, 10) : undefined;
}

export function versionedFilename(assetName, version) {
  const dot = assetName.lastIndexOf(".");
  const stem = dot > 0 ? assetName.slice(0, dot) : assetName;
  const extension = dot > 0 ? assetName.slice(dot) : "";
  const firstDigit = version.search(/\d/);
  const suffix =
    firstDigit < 0 ? version : `v${firstDigit === 0 ? version : version.slice(firstDigit)}`;
  return `${stem}_${suffix}${extension}`;
}

export function assetMatcher(source) {
  if (source.asset_pattern) {
    const pattern = new RegExp(source.asset_pattern);
    return (asset) => pattern.test(asset.name);
  }
  return (asset) => asset.name === source.asset;
}

export function findReleaseAsset(releases, matchesAsset) {
  for (const release of releases) {
    if (release.draft) continue;
    const asset = release.assets?.find(matchesAsset);
    if (asset) return { release, asset };
  }
  return null;
}

export async function fetchJson(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: headers(token) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${url}: GitHub API returned ${response.status}${detail ? ` (${detail.slice(0, 200)})` : ""}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function resolveUpstream(source, token) {
  const releases = await fetchJson(
    `${GITHUB_API}/repos/${source.repo}/releases?per_page=${RELEASES_PER_PAGE}`,
    token,
  );
  const match = findReleaseAsset(releases, assetMatcher(source));
  if (!match) throw new Error(`${source.repo}: no non-draft release contains ${source.asset}`);
  const { release, asset } = match;
  return { release, asset, version: normalizeVersion(release, asset) };
}

export async function downloadBytes(url, token) {
  const response = await fetch(url, { headers: headers(token), redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: download returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Newest non-draft `mirror-*` release, or null when no snapshot exists yet. */
export async function latestSnapshot(token) {
  const releases = await fetchJson(
    `${GITHUB_API}/repos/${MIRROR_OWNER}/${MIRROR_REPO}/releases?per_page=${RELEASES_PER_PAGE}`,
    token,
  );
  return (
    releases.find((r) => !r.draft && (r.tag_name || "").startsWith(MIRROR_PREFIX)) ?? null
  );
}

/** The manifest (catalog array) attached to a snapshot release. */
export async function snapshotManifest(snapshotRelease, token) {
  const manifestAsset = snapshotRelease.assets?.find((a) => a.name === MANIFEST_ASSET);
  if (!manifestAsset) {
    throw new Error(`${snapshotRelease.tag_name}: snapshot has no ${MANIFEST_ASSET} asset`);
  }
  const response = await fetch(manifestAsset.browser_download_url, {
    headers: headers(token),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${manifestAsset.browser_download_url}: download returned ${response.status}`);
  }
  const manifest = await response.json();
  if (!Array.isArray(manifest)) throw new Error(`${snapshotRelease.tag_name}: manifest is not an array`);
  return manifest;
}

/**
 * Compare a freshly resolved upstream entry against a manifest entry.
 * `url`/`source_direct` are intentionally ignored: they carry the snapshot
 * tag, which changes on every snapshot even when the payload is identical.
 * `upstreamDigest` is GitHub's digest of the upstream bytes; when the
 * upstream provides none, version + date + metadata decide.
 */
export function manifestEntryMatches(entry, { version, upstreamDigest, source, lastUpdate }) {
  return (
    entry.version === version &&
    (!upstreamDigest || entry.checksum === upstreamDigest) &&
    entry.source === `https://github.com/${source.repo}/releases` &&
    entry.last_update === lastUpdate &&
    entry.description === source.description &&
    entry.category === source.category
  );
}

/** Oldest-first list of snapshot releases beyond the retention window. */
export function snapshotsToPrune(allReleases, keep = SNAPSHOTS_TO_KEEP) {
  const snapshots = allReleases.filter(
    (r) => !r.draft && (r.tag_name || "").startsWith(MIRROR_PREFIX),
  );
  if (snapshots.length <= keep) return [];
  const byNewest = [...snapshots].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return byNewest.slice(keep).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export function snapshotTag(now = new Date()) {
  return `${MIRROR_PREFIX}${now.toISOString().replace(/\D/g, "").slice(0, 14)}`;
}
