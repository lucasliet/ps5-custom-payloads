# PS5 Custom Payloads

Dynamic custom payload repository for PS5 Payload Manager.

This repository tracks the latest GitHub release assets for:

- Pegasus DL — `pegasus-ps5/pegasus-dl`
- OnionHEN — `aydencharles/onionHEN`
- Prospero Manager — `notmaj0r/ProsperoMgr`
- Game Compressor — `juma-sayeh/PS5-Game-Compressor`

## Architecture

There are two delivery modes:

1. **Dynamic endpoint (recommended)** — a Cloudflare Worker builds the repository JSON at request time from the GitHub Releases API. Every request resolves the newest non-draft release containing the configured ELF asset.
2. **Static fallback** — `payloads.json` is regenerated once per day by GitHub Actions, committed to `main`, and served directly by GitHub Pages configured as **Deploy from a branch → main → /(root)**.

GitHub Pages itself is static, so it cannot query the Releases API when `payloads.json` is requested. The Worker exists specifically to provide request-time freshness.

## Dynamic endpoint

The Worker entrypoint is `src/index.js`. It returns the required schema at both `/` and `/payloads.json`, including CORS headers.

Deploy with Wrangler:

```bash
npm install
npx wrangler deploy
```

For better GitHub API rate limits, configure an optional read-only GitHub token:

```bash
npx wrangler secret put GITHUB_TOKEN
```

The Worker still works without a token for low-volume usage against public repositories.

## Static fallback

Generate locally:

```bash
npm run generate
```

The `Update static catalog` GitHub Action runs once per day at `03:17 UTC` and commits `payloads.json` only when the resolved releases change.

GitHub Pages should be configured as:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/(root)`

No separate Pages deployment workflow is required. When the daily Action updates `payloads.json` on `main`, the branch-based Pages deployment publishes that new file automatically.

## Notes

The catalog is a bare top-level JSON array, field-compatible with the official mirror format consumed by Payload Manager (`itsplk.github.io/ps5-payloads-mirror`). Payload Manager's parser also accepts a top-level object wrapper, but it then pairs the outer `{` with the first payload's `}`, shadowing the first payload's `name` with the repository title — the array form avoids that quirk. Because of this, the top-level `name` (repository title) in `sources.json` is no longer emitted into the catalog; each source's own `name` still becomes the payload item name.

If a custom source shows an empty list in Payload Manager, force-refresh the source: the app caches custom sources for 24 hours and a stale cache can survive a broken fetch (see itsPLK/ps5-payload-manager issue #92).

Prospero Manager currently uses a rolling prerelease tag named `beta`. If a prerelease tag contains no numeric version, the generated version includes the release asset update timestamp, e.g. `beta-20260825204814`, so replacing the ELF under the same tag is still detected as an update.

`checksum` uses GitHub's release-asset SHA-256 digest when available. Because the field is optional in PS5 Payload Manager, it is omitted if GitHub does not provide a SHA-256 digest for a future asset.
