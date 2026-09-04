import fs from "node:fs/promises";
import sourcesConfig from "../sources.json" with { type: "json" };

const GITHUB_API = "https://api.github.com";

function headers() {
  const h = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ps5-custom-payloads-generator",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

function normalizeVersion(release, asset) {
  const tag = release.tag_name || "unknown";
  if (/\d/.test(tag)) return tag;
  const timestamp = asset.updated_at || release.published_at || release.created_at;
  if (!timestamp) return tag;
  return `${tag}-${timestamp.replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

function checksumFromAsset(asset) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "");
  return match?.[1]?.toLowerCase();
}

async function resolveSource(source) {
  const response = await fetch(`${GITHUB_API}/repos/${source.repo}/releases?per_page=30`, {
    headers: headers(),
  });
  if (!response.ok) throw new Error(`${source.repo}: GitHub API returned ${response.status}`);

  const releases = await response.json();
  const match = releases
    .filter((release) => !release.draft)
    .map((release) => ({
      release,
      asset: release.assets?.find((asset) => asset.name === source.asset),
    }))
    .find(({ asset }) => Boolean(asset));

  if (!match) throw new Error(`${source.repo}: no non-draft release contains ${source.asset}`);

  const { release, asset } = match;
  const payload = {
    name: source.name,
    filename: source.asset,
    url: asset.browser_download_url,
    description: source.description,
    version: normalizeVersion(release, asset),
    category: source.category,
  };

  const checksum = checksumFromAsset(asset);
  if (checksum) payload.checksum = checksum;
  return payload;
}

const catalog = {
  name: sourcesConfig.name,
  payloads: await Promise.all(sourcesConfig.sources.map(resolveSource)),
};

await fs.writeFile("payloads.json", JSON.stringify(catalog, null, 2) + "\n");
console.log(JSON.stringify(catalog, null, 2));
