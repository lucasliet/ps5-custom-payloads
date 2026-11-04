# PS5 Custom Payloads

Custom payload repository for [Payload Manager](https://github.com/itsPLK/ps5-payload-manager) (pldmgr) on jailbroken PS5s. This repository mirrors the latest GitHub release ELF of each tracked payload into its own snapshot releases, and serves a catalog JSON telling the app where to download them — so payloads stay available even if an upstream repository disappears.

Live endpoints:

- Static (GitHub Pages): `https://lucasliet.github.io/ps5-custom-payloads/payloads.json`
- Static with icons (pldmgr v0.6+): `https://lucasliet.github.io/ps5-custom-payloads/payloads_v2.json`
- Dynamic (FastAPI Cloud): `/`, `/payloads.json`, `/payloads_v2.json` and `/icons.json` on the deployed app

## Tracked payloads

| Name | Repository | Asset | Category |
|---|---|---|---|
| Pegasus DL | `pegasus-ps5/pegasus-dl` | `pegasus_dl.elf` | Stores |
| Orbit Store | `saawant12/orbit-store-ps5` | `orbit_store.elf` | Stores |
| RecompStore | `elripalda/RecompStore` | `RecompStore-Installer.elf` | Stores |
| OnionHEN | `aydencharles/onionHEN` | `OnionHEN.elf` | Unlocking |
| WebKit Autoloader | `itsPLK/ps5-webkit-autoloader` | `webkit-autoloader-installer.elf` (+ pattern) | Unlocking |
| Prospero Manager | `notmaj0r/ProsperoMgr` | `ProsperoMgr.elf` | Utilities |
| Game Compressor | `juma-sayeh/PS5-Game-Compressor` | `game-compressor.elf` | Utilities |
| APR Emu Updater | `tsuramatsu1/apr-emu-updater` | `apr_emu_updater.elf` (+ pattern) | Utilities |
| AnyPad | `mistervampi/AnyPad-PS5` | `AnyPad-PS5.elf` (+ pattern) | Utilities |
| OmniPad | `diegobarbosaa/OmniPad-PS5` | `OmniPad-PS5.elf` (+ pattern) | Utilities |
| Tailscale | `holdmysocks/ps5-tailscale` | `tailscale.elf` | Utilities |
| PS4Mount | `gasb07/ps4mount` | `ps4mount.elf` | Utilities |

## Architecture

`sources.json` is the single source of truth: what to track and the metadata shown in the app. The download flow is:

1. **Mirror (CI)** — `scripts/mirror.mjs` (`npm run mirror`) resolves every source against its upstream GitHub Releases, downloads each ELF, and publishes a snapshot release in this repository (tag `mirror-<UTC timestamp>`, e.g. `mirror-20261006031745`) holding one versioned ELF per payload plus a `payloads.json` manifest asset. A GitHub Action runs it daily at `03:17 UTC`, on pushes to `main` that change `sources.json` (including merged PRs), or manually via `workflow_dispatch`. No new snapshot is published when every payload already matches the latest snapshot, so unchanged days produce no releases.
2. **Icons (CI)** — after the mirror, the same workflow runs `scripts/icons.py` (`npm run icons`). For every source it probes the upstream repository's default branch for the standard PS5 icon locations (`assets/icon0.png`, `assets/icon.png`, `icon0.png`, `icon.png`, `assets/logo.png`, `logo.png`), falls back to the owner's GitHub avatar — the same suggestion order the official mirror uses — and compresses the image (port of the official `icon_utils.py`): SVG passes through when it fits, otherwise 128px PNG, palette-quantized PNG (transparency) or JPEG (opaque), always under the 12,288-character data URI budget PS5 WebKit imposes. It writes `icons.json` (content-addressed: the key is the SHA-256 of the data URI, so identical images share one entry and stale keys are pruned on the next run) and `payloads_v2.json` (the catalog wrapped with `icons_url`, each payload carrying its `icon_key`).
3. **Static catalog (primary)** — `payloads.json` (bare array) and `payloads_v2.json` (icon wrapper) at the repo root are committed by the mirror run; `icons.json` ships alongside them. GitHub Pages serves all three from `main`. `scripts/generate.mjs` (`npm run generate`) re-syncs `payloads.json` from the latest snapshot without publishing anything, rebuilding `payloads_v2.json` with the icon keys `icons.json` still holds.
4. **Dynamic endpoint** — `main.py` is a FastAPI app, deployed on [FastAPI Cloud](https://fastapicloud.com), that resolves every source against its upstream GitHub Releases at request time, so a payload published minutes ago is already listed without waiting for the daily mirror. `/payloads_v2.json` serves the icon wrapper (keys re-attached from the committed v2 catalog — no image processing at request time) and `/icons.json` serves the icon data. Only sources the upstream no longer serves are filled in from this repository's newest snapshot release (falling back to the bundled `payloads.json` when the mirror API itself is unreachable). GitHub Pages is static and cannot query the API per request; the app exists for request-time freshness. It also serves FastAPI's interactive docs at `/docs`.

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
7. **Icon** — `scripts/icons.py` resolves one icon per source (explicit `icon` override in `sources.json`, then the repo's standard icon locations, then the owner avatar), compresses it to a ≤12,000-character data URI, and keys it by its SHA-256 in `icons.json`. Payloads whose icon cannot be resolved are skipped (the app generates a fallback) without failing the run.

## Catalog schema

Two files describe the same catalog, both a **bare top-level JSON array** payload list plus the v0.6+ icon wrapper:

`payloads.json` (works on every pldmgr version):

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

`payloads_v2.json` (same entries plus `icon_key`, wrapped so pldmgr v0.6+ picks up `icons_url`):

```json
{
  "name": "Lucas PS5 Payloads",
  "icons_url": "icons.json",
  "payloads": [
    {
      "name": "Pegasus DL",
      "...": "...",
      "icon_key": "36a564c7d0a8..."
    }
  ]
}
```

`icons.json` maps each key to a base64 PNG/JPEG/SVG data URI ≤12,288 characters (square ~128px, never WebP — PS5 WebKit limits). Constraints the daemon enforces: the file must stay under 4 MiB with at most 4,096 keys of ≤127 bytes; malformed values reject the icon update while the last valid cache survives.

This matches the format of the official mirror (`itsplk.github.io/ps5-payloads-mirror`) field for field, including its two-file split: the bare array there is `payloads.json`, the icon wrapper `payloads_v2.json`.

Use the bare `payloads.json` URL with any app version; use `payloads_v2.json` on pldmgr v0.6.0+ (older releases mis-parse the wrapper and mislabel the first payload — see below).

## Payload Manager compatibility

Every formatting decision above is driven by how the app actually parses and uses the catalog (verified against `itsPLK/ps5-payload-manager` v0.6.3 / `CUSTOM_REPOSITORIES.md`; the previous notes targeted v0.5.1 and several behaviours changed in v0.6.x):

- **Parser** — a native-ish scanner extracts `{`…`}` blocks and string keys; only `name`, `filename` and `url` are required. **Changed in v0.6.x**: both top-level formats parse correctly now. The scanner detects an object wrapper containing a `"payloads"` key and skips into it, so the v0.5.1 bug where the outer `{` shadowed the first payload's `name` is gone. The bare array is kept anyway because icon support (`icons_url`) exists only in the wrapper — and v0.5.x clients, which mishandle the wrapper, stay on the bare URL.
- **Update detection no longer filename-only** — v0.6.x compares `version` tokens (numeric runs numerically, `1.11 > 1.2`; alphabetical tokens lose to numeric at the same position; a trailing alphabetical token is a pre-release, so `1.7 > 1.7beta3`), with `last_update` as tie-breaker, and a slot matches its catalog entry by stable `id` (default `slug(name)`) plus source URL — which is why payload names here never change casually. The `filename` no longer participates in update detection; the versioned filename scheme (`_v<version>`) is kept anyway: v0.5.x clients still detect updates that way, and it keeps every mirrored release visibly distinct.
- **Suffix must start with a digit (v0.5.x legacy)** — v0.5.1's update check stripped a `[_-]v?<digit>…` suffix from filenames; that is why rolling tags become `beta-20260825204814` with the suffix starting at the first digit, so every release reduces to the same base name (`ProsperoMgr`) on old clients. v0.6.x ignores the filename and compares `version` directly.
- **Checksum is now strict** — a `checksum` that is present but not exactly 64 hex characters **rejects the whole entry** (v0.5.1 ignored it). The mirror therefore only emits real SHA-256 digests. A missing checksum stays legal.
- **New optional fields** — `id` (stable slot identity for favorites/autoload; defaults to `slug(name)`, which is why payload names here stay stable), `author`, `details_url` (README shown in the details page) and `release_notes` (legacy; the frontend fetches notes from GitHub instead). The catalog does not emit them yet — `slug(name)` already yields stable slots.
- **Install path** — managed installs now use slots under `/data/pldmgr/payloads/repo/<id>/` with staged writes so a failed install cannot destroy the previous version (v0.5.1 kept flat `<base>/` folders and wiped siblings on install). Update visibility still comes from the changing `filename`.
- **Icons** — declared via top-level `icons_url` on the wrapper (relative URLs resolve against the catalog URL; HTTPS never downgrades to HTTP). Per payload, `icon_key` selects an entry in `{"icons": {key: data URI}}`. Only base64 PNG/JPEG/SVG data URIs ≤12,288 chars work — no inline `icon` field, no direct image URLs, no WebP. The daemon caches icon catalogs persistently and refreshes them when the cache is seven days old, when `icons_url` changes, or when a referenced key is missing; because keys are SHA-256s of the URI, a re-compressed icon automatically triggers that refresh.

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

`asset_pattern` is optional (omit it when the asset name never changes). Keep the asset stem free of version-like suffixes (`_v1`, `-2`) so the derived base name stays stable. Commit and push the change to `main` (or merge a PR): the mirror workflow automatically publishes the snapshot, extracts the payload's icon and commits the regenerated catalogs. Then force-refresh the source in the app. For a local preview without publishing anything, use `DRY_RUN=1 npm run mirror`; to publish locally, use `npm run mirror` and commit the regenerated `payloads.json`.

The icon is automatic: the mirror probes the repository's default branch for `assets/icon0.png`, `assets/icon.png`, `icon0.png`, `icon.png`, `assets/logo.png` and `logo.png`, then falls back to the owner's GitHub avatar. Set `"icon"` on the source to override that — an `@owner` handle, a GitHub image URL (profile or blob), a direct URL or a `data:image/...;base64,...` URI all work.

Categories are free-form strings (custom categories are supported since the app's v0.3.3).

## Operations

### Static catalog and mirror

```bash
npm run mirror   # resolve upstream, publish a snapshot release, rewrite payloads.json
npm run generate # read-only: re-sync payloads.json and payloads_v2.json from the latest snapshot
npm run icons    # re-extract icons from upstream repos into icons.json + payloads_v2.json
```

`npm run icons` runs `scripts/icons.py` through uv with the `icons` dependency group (Pillow). Plain `python scripts/icons.py` works too with Pillow installed. The script never fails on a single bad image: it warns and leaves that payload to the app's generated fallback icon.

The `Mirror payloads` Action (`.github/workflows/mirror-payloads.yml`) runs daily at `03:17 UTC`, on pushes to `main` that change `sources.json`, or manually via `workflow_dispatch`. It runs `npm test`, mirrors a snapshot (`npm run mirror`), extracts icons (`python scripts/icons.py`, Pillow via `setup-python`), and commits `payloads.json`, `payloads_v2.json` and `icons.json` when any changed. Pushes that only change the generated files or unrelated files do not trigger the mirror. It uses the built-in `GITHUB_TOKEN` (needs `contents: write` to publish/prune snapshot releases), publishes a new snapshot only when something changed, and skips the commit when nothing did. GitHub Pages publishes `main` automatically.

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

`GITHUB_TOKEN` needs **no scopes at all** — every tracked repository is public and the app only reads release metadata. Create a classic token with nothing checked, or a fine-grained one with no permissions (those already carry read-only access to public repositories). Scopes do not affect rate limits; authenticating is what raises the ceiling from 60 to 5,000 requests/hour. Each catalog request costs one API call per source — twelve today, plus two more only when some source needs the snapshot fallback — and responses are `no-store` — so unauthenticated the endpoint runs dry after a handful of fetches an hour. It still works without a token for low-volume use.

`/payloads_v2.json` and `/icons.json` serve the icon wrapper and the icon data; the icon keys come from the committed `payloads_v2.json`, so after changing icons **remember to redeploy** (pushing refreshes Pages immediately, the deployed app does not).

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
