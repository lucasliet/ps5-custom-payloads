# PS5 Custom Payloads

Custom payload repository for [Payload Manager](https://github.com/itsPLK/ps5-payload-manager) (pldmgr) on jailbroken PS5s. This repository mirrors the latest GitHub release ELF of each tracked payload into its own snapshot releases, and serves a catalog JSON telling the app where to download them — so payloads stay available even if an upstream repository disappears.

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
| WebKit Autoloader | `itsPLK/ps5-webkit-autoloader` | `webkit-autoloader-installer.elf` (+ pattern) | Autoloader |
| AnyPad | `mistervampi/AnyPad-PS5` | `AnyPad-PS5.elf` (+ pattern) | Controllers |
| OmniPad | `diegobarbosaa/OmniPad-PS5` | `OmniPad-PS5.elf` (+ pattern) | Controllers |
| Orbit Store (Beta) | `saawant12/orbit-store-ps5` | `orbit_store.elf` | Utilities |

## Architecture

`sources.json` is the single source of truth: what to track and the metadata shown in the app. The download flow is:

1. **Mirror (CI)** — `scripts/mirror.mjs` (`npm run mirror`) resolves every source against its upstream GitHub Releases, downloads each ELF, and publishes a snapshot release in this repository (tag `mirror-<UTC timestamp>`, e.g. `mirror-20261006031745`) holding one versioned ELF per payload plus a `payloads.json` manifest asset. A GitHub Action runs it daily at `03:17 UTC`, on pushes to `main` that change `sources.json` (including merged PRs), or manually via `workflow_dispatch`. No new snapshot is published when every payload already matches the latest snapshot, so unchanged days produce no releases.
2. **Static catalog (primary)** — `payloads.json` at the repo root is the manifest of the latest snapshot, committed by the mirror run. GitHub Pages serves it from `main` / `/(root)` (branch-based deployment, no Pages workflow needed). `scripts/generate.mjs` (`npm run generate`) re-syncs it read-only from the latest snapshot without publishing anything.
3. **Dynamic endpoint** — `main.py` is a FastAPI app, deployed on [FastAPI Cloud](https://fastapicloud.com), that resolves every source against its upstream GitHub Releases at request time, so a payload published minutes ago is already listed without waiting for the daily mirror. Only sources the upstream no longer serves are filled in from this repository's newest snapshot release (falling back to the bundled `payloads.json` when the mirror API itself is unreachable). GitHub Pages is static and cannot query the API per request; the app exists for request-time freshness. It also serves FastAPI's interactive docs at `/docs`.

`url` and `source_direct` always point at this repository's snapshot releases; every other field keeps the upstream metadata (name, version, description, category, `last_update`, `source`).

### Backup and retention policy

- Each snapshot is self-contained: when a payload has no newer upstream version, the snapshot repeats the previous release's ELF for it.
- Upstream is always tried first; only when an upstream repository is unreachable (deleted, renamed) is that payload's ELF copied from the previous snapshot instead of downloaded.
- The last 5 snapshot releases are kept — on the 6th, the oldest release **and its tag** are deleted. Old catalog URLs therefore rot after ~5 snapshots; clients always consume the latest catalog, which points at the latest snapshot.

## How each catalog entry is built

For every source in `sources.json`, the mirror run:

1. **Release resolution** — fetch the repository's last 30 releases, skip drafts, and take the first (newest) release containing a matching asset. Prereleases are accepted — that is how Prospero Manager's rolling `beta` tag works. An asset matches by exact `asset` name, or by the optional `asset_pattern` regex when the upstream renames assets between releases (e.g. `apr_emu_updater_v2.0.6.elf`).
2. **Version** — if the tag contains any digit, the version is the tag verbatim (`v1.7.0`). Otherwise (rolling tags like `beta`) the version becomes `<tag>-<asset update timestamp>` (e.g. `beta-20260825204814`), so replacing the ELF under the same tag still counts as a new version.
3. **Filename** — the catalog `filename` is `<asset stem>_v<version>.elf` (e.g. `pegasus_dl_v1.7.0.elf`). The mirrored asset is uploaded under exactly this name. When the version has a non-numeric head (e.g. `beta-20260825204814`), the suffix starts at the first digit (`ProsperoMgr_v20260825204814.elf`). See [Payload Manager compatibility](#payload-manager-compatibility) for why.
4. **Mirroring** — the upstream ELF is downloaded byte-for-byte and uploaded to the new snapshot release; `url` and `source_direct` point at the mirrored copy (`https://github.com/lucasliet/ps5-custom-payloads/releases/download/<snapshot-tag>/<filename>`).
5. **Checksum** — SHA-256 computed over the mirrored bytes (warns when it differs from the upstream release digest).
6. **Metadata** — `source` stays the upstream repository's releases page, `last_update` is the upstream asset update date (`YYYY-MM-DD`); `description`, `category` and `version` are kept verbatim from the original.

## Catalog schema

The catalog is a **bare top-level JSON array**:

```json
[
  {
    "name": "Pegasus DL",
    "filename": "pegasus_dl_v1.7.0.elf",
    "url": "https://github.com/lucasliet/ps5-custom-payloads/releases/download/mirror-20261006031745/pegasus_dl_v1.7.0.elf",
    "source": "https://github.com/pegasus-ps5/pegasus-dl/releases",
    "source_direct": "https://github.com/lucasliet/ps5-custom-payloads/releases/download/mirror-20261006031745/pegasus_dl_v1.7.0.elf",
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

`asset_pattern` is optional (omit it when the asset name never changes). Keep the asset stem free of version-like suffixes (`_v1`, `-2`) so the derived base name stays stable. Commit and push the change to `main` (or merge a PR): the mirror workflow automatically publishes the snapshot and commits the regenerated `payloads.json`. Then force-refresh the source in the app. For a local preview without publishing anything, use `DRY_RUN=1 npm run mirror`; to publish locally, use `npm run mirror` and commit the regenerated `payloads.json`.

Categories are free-form strings (custom categories are supported since the app's v0.3.3).

## Operations

### Static catalog and mirror

```bash
npm run mirror   # resolve upstream, publish a snapshot release, rewrite payloads.json
npm run generate # read-only: re-sync payloads.json from the latest snapshot
```

The `Mirror payloads` Action (`.github/workflows/mirror-payloads.yml`) runs daily at `03:17 UTC`, on pushes to `main` that change `sources.json`, or manually via `workflow_dispatch`. Pushes that only change the generated `payloads.json` or unrelated files do not trigger the mirror. It uses the built-in `GITHUB_TOKEN` (needs `contents: write` to publish/prune snapshot releases), publishes a new snapshot only when something changed, and commits `payloads.json` only when it changes. GitHub Pages publishes `main` automatically.

### Dynamic endpoint

```bash
pip install "fastapi[standard]"   # brings the FastAPI Cloud CLI
fastapi dev                       # run locally on http://127.0.0.1:8000
```

Deploying:

```bash
fastapi cloud env set --secret GITHUB_TOKEN   # optional: better API rate limits
fastapi deploy
```

The first `fastapi deploy` prompts for login, then for the team and whether to create a new app or link an existing one. It stores the link in `.fastapicloud/`, which the CLI gitignores for you — the app ID is per-checkout, not repository state.

Set environment variables **before** deploying: `env set` does not redeploy on its own, so a variable added afterwards only takes effect on the next deploy. Omitting the value makes the CLI prompt for it with hidden input, keeping the token out of your shell history.

`GITHUB_TOKEN` needs **no scopes at all** — every tracked repository is public and the app only reads release metadata. Create a classic token with nothing checked, or a fine-grained one with no permissions (those already carry read-only access to public repositories). Scopes do not affect rate limits; authenticating is what raises the ceiling from 60 to 5,000 requests/hour. Each catalog request costs one API call per source — nine today, plus two more only when some source needs the snapshot fallback — and responses are `no-store` — so unauthenticated the endpoint runs dry after a handful of fetches an hour. It still works without a token for low-volume use.

`pyproject.toml` declares the dependencies and the entrypoint (`main:app`); together with `.python-version` it tells FastAPI Cloud which Python to build against.

**Remember to redeploy it after changing `main.py`** — GitHub Pages updates on push, the deployed app does not. To close that gap, let the CLI wire up a deploy workflow (it provisions a deploy token, sets the repository secrets and writes the workflow file):

```bash
fastapi cloud setup-ci --branch main   # add --dry-run first to see what it would do
```

Day to day:

```bash
fastapi cloud logs                 # stream logs (--no-follow to fetch and exit)
fastapi cloud env list             # what the deployed app has configured
fastapi cloud deployments list     # deployment history
```

### Troubleshooting an empty or stale source in the app

The app caches each custom source for 24 hours, and a stale or corrupt cache can survive a fixed catalog (see itsPLK/ps5-payload-manager issue #92). Restarting the console does not clear it. In order:

1. Press the source's refresh button, or open `http://<PS5_IP>:8084/repository_refresh` in a browser.
2. Check what the daemon has: `http://<PS5_IP>:8084/sources_list` (registered URLs) and `http://<PS5_IP>:8084/repository_payloads` (per-source `error` and payload list).
3. Remove and re-add the source in Manage Sources (URL must be the full path to the JSON file — the app appends nothing).
4. Delete `/data/pldmgr/repository_cache.json.src*.json` and the matching `.ts` files via FTP/web file manager; the next listing re-downloads.
