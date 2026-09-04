import sourcesConfig from "../sources.json" with { type: "json" };

const GITHUB_API = "https://api.github.com";

function githubHeaders(env) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ps5-custom-payloads-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

function normalizeVersion(release, asset) {
  const tag = release.tag_name || "unknown";
  if (/\d/.test(tag)) return tag;

  const timestamp = asset.updated_at || release.published_at || release.created_at;
  if (!timestamp) return tag;

  return `${tag}-${timestamp.replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

function checksumFromAsset(asset) {
  const digest = asset.digest;
  if (typeof digest !== "string") return undefined;
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest);
  return match?.[1]?.toLowerCase();
}

async function resolveSource(source, env) {
  const response = await fetch(`${GITHUB_API}/repos/${source.repo}/releases?per_page=30`, {
    headers: githubHeaders(env),
  });

  if (!response.ok) {
    throw new Error(`${source.repo}: GitHub API returned ${response.status}`);
  }

  const releases = await response.json();
  const match = releases
    .filter((release) => !release.draft)
    .map((release) => ({
      release,
      asset: release.assets?.find((asset) => asset.name === source.asset),
    }))
    .find(({ asset }) => Boolean(asset));

  if (!match) {
    throw new Error(`${source.repo}: no non-draft release contains ${source.asset}`);
  }

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

async function buildCatalog(env) {
  const payloads = await Promise.all(
    sourcesConfig.sources.map((source) => resolveSource(source, env)),
  );

  return {
    name: sourcesConfig.name,
    payloads,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "Content-Type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (!["/", "/payloads.json"].includes(url.pathname)) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    try {
      const catalog = await buildCatalog(env);
      if (request.method === "HEAD") {
        const response = jsonResponse(catalog);
        return new Response(null, { status: response.status, headers: response.headers });
      }
      return jsonResponse(catalog);
    } catch (error) {
      return jsonResponse(
        {
          error: "Failed to build payload catalog",
          detail: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  },
};
