# PS5 Custom Payloads

Custom payload repository for [Payload Manager](https://github.com/itsPLK/ps5-payload-manager) (pldmgr) on jailbroken PS5s. Instead of hosting ELF binaries, this repository tracks the latest GitHub releases of each payload and serves a catalog JSON telling the app where to download them.

Live endpoints:

- Static (GitHub Pages): `https://lucasliet.github.io/ps5-custom-payloads/payloads.json`
- Dynamic (FastAPI Cloud): `/` and `/payloads.json` on the deployed app

## Tracked payloads

| Name | Repository | Asset | Category |
|---|---|---|---|
| Pegasus DL | `pegasus-ps5/pegasus-dl` | `pegasus_dl.elf` | Downloads |
| OnionHEN | `aydencharles/onionHEN` | `OnionHEN.elf` | HEN |
| Prospero Manager | `notmaj0r/ProsperoMgr` | `ProsperoMgr.elf` | Management |
| Game Compressor | `juma-sayeh/PS5-Game-Compressor` | `game-compressor.elf` | Storage |
| APR Emu Updater | `tsuramatsu1/apr-emu-updater` | `apr_emu_updater.elf` (+ pattern) | Emulation |

## Architecture

`sources.json` is the single source of truth: what to track and the metadata shown in the app. Two generators read it and must stay logically identical:

1. **Static catalog (primary)** — `scripts/generate.mjs` (`npm run generate`) resolves every source against the GitHub Releases API and writes `payloads.json`. A GitHub Action regenerates it daily at `03:17 UTC` and commits only when the result changes. GitHub Pages serves the file from `main` / `/(root)` (branch-based deployment, no Pages workflow needed).
2. **Dynamic endpoint** — `main.py` is a FastAPI app, deployed on [FastAPI Cloud](https://fastapicloud.com), that builds the same catalog at request time, so every fetch resolves the newest release without waiting for the daily Action. GitHub Pages is static and cannot query the API per request; the app exists for request-time freshness. It also serves FastAPI's interactive docs at `/docs`.

Both emit byte-identical JSON (same key order, same trailing newline).

## How each catalog entry is built

For every source in `sources.json`:

1. **Release resolution** — fetch the repository's last 30 releases, skip drafts, and take the first (newest) release containing a matching asset. Prereleases are accepted — that is how Prospero Manager's rolling `beta` tag works. An asset matches by exact `asset` name, or by the optional `asset_pattern` regex when the upstream renames assets between releases (e.g. `apr_emu_updater_v2.0.6.elf`).
2. **Version** — if the tag contains any digit, the version is the tag verbatim (`v1.7.0`). Otherwise (rolling tags like `beta`) the version becomes `<tag>-<asset update timestamp>` (e.g. `beta-20260825204814`), so replacing the ELF under the same tag still counts as a new version.
3. **Filename** — the catalog `filename` is `<asset stem>_v<version>.elf` (e.g. `pegasus_dl_v1.7.0.elf`), even though `url` points at the upstream asset's real (possibly versionless) name. When the version has a non-numeric head (e.g. `beta-20260825204814`), the suffix starts at the first digit (`ProsperoMgr_v20260825204814.elf`). See [Payload Manager compatibility](#payload-manager-compatibility) for why.
4. **Checksum** — GitHub's release-asset SHA-256 digest, omitted when GitHub does not provide one (the field is optional in the app).
5. **Metadata** — `source` is the repository's releases page, `source_direct` mirrors the download URL, `last_update` is the asset update date (`YYYY-MM-DD`).

## Catalog schema

The catalog is a **bare top-level JSON array**:

```json
[
  {
    "name": "Pegasus DL",
    "filename": "pegasus_dl_v1.7.0.elf",
    "url": "https://github.com/pegasus-ps5/pegasus-dl/releases/download/v1.7.0/pegasus_dl.elf",
    "source": "https://github.com/pegasus-ps5/pegasus-dl/releases",
    "source_direct": "https://github.com/pegasus-ps5/pegasus-dl/releases/download/v1.7.0/pegasus_dl.elf",
    "description": "Direct package downloader for PS5 with a local web interface, catalog sources, queue management and file management.",
    "last_update": "2026-06-24",
    "version": "v1.7.0",
    "category": "Downloads",
    "checksum": "cb2a4b3c..."
  }
]
```

This matches the format of the official mirror (`itsplk.github.io/ps5-payloads-mirror`) field for field.

## Payload Manager compatibility

Every formatting decision above is driven by how the app actually parses and uses the catalog (verified against `itsPLK/ps5-payload-manager` v0.5.1):

- **Parser** — the daemon has no real JSON parser; it scans the text for `{`…`}` blocks and extracts string keys. Only `name`, `filename` and `url` are required; everything else is optional metadata. A top-level object wrapper also parses, but the outer `{` pairs with the first payload's `}`, shadowing the first payload's `name` with the repository title — hence the bare array, and hence the top-level `name` in `sources.json` is not emitted.
- **Update detection is filename-only** — the dashboard marks a payload `installed` when its `filename` matches an on-disk file exactly, and flags an update when the exact name is absent but the version-stripped base name still matches (it strips a `[_-]v?<digits>…` suffix). The catalog's `version` and `checksum` are **never compared** for updates; they are display and download-verification metadata only. A fixed filename would therefore match as installed forever — the versioned filename scheme is what makes updates visible.
- **Install path** — the daemon saves the ELF under the catalog `filename` (never the URL basename), at `/data/pldmgr/payloads/<base>/<filename>` with a `<filename>.json` sidecar. Both versions of a payload derive the same `<base>` folder, and the daemon deletes every other file in that folder on install, so updating automatically removes the old version.
- **Suffix must start with a digit** — the app's version-stripping regex only recognizes `[_-]` + optional `v` + digit. That is why `beta-20260825204814` becomes suffix `v20260825204814`: every release of a payload reduces to the same base name (`ProsperoMgr`), whether the upstream tag is a rolling `beta` or a stable `v1.0.0`.

## Adding a payload

Append an entry to `sources.json`:

```json
{
  "name": "Example Payload",
  "repo": "owner/example-payload",
  "asset": "example.elf",
  "asset_pattern": "^example(_v[\\d.]+)?\\.elf$",
  "description": "One-line description shown in the app.",
  "category": "Utilities"
}
```

`asset_pattern` is optional (omit it when the asset name never changes). Keep the asset stem free of version-like suffixes (`_v1`, `-2`) so the derived base name stays stable. Then run `npm run generate`, commit the regenerated `payloads.json`, and force-refresh the source in the app.

Categories are free-form strings (custom categories are supported since the app's v0.3.3).

## Operations

### Static catalog

```bash
npm run generate   # rebuild payloads.json locally
```

The `Update static catalog` Action (`.github/workflows/update-static.yml`) runs daily at `03:17 UTC` with the built-in `GITHUB_TOKEN` and commits `payloads.json` only when it changes. GitHub Pages publishes `main` automatically.

### Dynamic endpoint

```bash
pip install "fastapi[standard]"   # brings the FastAPI Cloud CLI
fastapi dev                       # run locally on http://127.0.0.1:8000
fastapi login                     # once, to authenticate
fastapi deploy                    # deploy this directory
fastapi cloud env set --secret GITHUB_TOKEN <token>   # optional: better API rate limits
```

`pyproject.toml` declares the dependencies and the entrypoint (`main:app`); together with `.python-version` it tells FastAPI Cloud which Python to build against. The app reads `GITHUB_TOKEN` from the environment and works without one for low-volume use.

**Remember to redeploy it after changing `main.py`** — GitHub Pages updates on push, the deployed app does not.

### Troubleshooting an empty or stale source in the app

The app caches each custom source for 24 hours, and a stale or corrupt cache can survive a fixed catalog (see itsPLK/ps5-payload-manager issue #92). Restarting the console does not clear it. In order:

1. Press the source's refresh button, or open `http://<PS5_IP>:8084/repository_refresh` in a browser.
2. Check what the daemon has: `http://<PS5_IP>:8084/sources_list` (registered URLs) and `http://<PS5_IP>:8084/repository_payloads` (per-source `error` and payload list).
3. Remove and re-add the source in Manage Sources (URL must be the full path to the JSON file — the app appends nothing).
4. Delete `/data/pldmgr/repository_cache.json.src*.json` and the matching `.ts` files via FTP/web file manager; the next listing re-downloads.
