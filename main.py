"""Request-time payload catalog API, deployed on FastAPI Cloud.

GitHub Pages serves the daily `payloads.json` snapshot; this app resolves
every source against its upstream GitHub Releases on each request, so a
payload published minutes ago is already listed. Sources the upstream no
longer serves are filled in from this repository's newest `mirror-*`
snapshot release (falling back to the bundled `payloads.json`), so the
catalog stays up even when an upstream repository disappears.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Callable

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.exceptions import HTTPException

GITHUB_API = "https://api.github.com"
USER_AGENT = "ps5-custom-payloads-api"
MIRROR_OWNER = "lucasliet"
MIRROR_REPO = "ps5-custom-payloads"
MIRROR_PREFIX = "mirror-"
MANIFEST_ASSET = "payloads.json"
RELEASES_PER_PAGE = 30
REQUEST_TIMEOUT = 10.0

BUNDLED_CATALOG_PATH = Path(__file__).resolve().parent / "payloads.json"
SOURCES_PATH = Path(__file__).resolve().parent / "sources.json"

Release = dict[str, Any]
Asset = dict[str, Any]
Source = dict[str, Any]
PayloadEntry = dict[str, Any]


class CatalogError(RuntimeError):
    """A source could not be resolved, neither upstream nor from the mirror."""


def load_sources() -> list[Source]:
    return json.loads(SOURCES_PATH.read_text(encoding="utf-8"))["sources"]


def github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def asset_timestamp(release: Release, asset: Asset) -> str | None:
    return asset.get("updated_at") or release.get("published_at") or release.get("created_at")


def normalize_version(release: Release, asset: Asset) -> str:
    tag = release.get("tag_name") or "unknown"
    if re.search(r"[0-9]", tag):
        return tag

    timestamp = asset_timestamp(release, asset)
    if not timestamp:
        return tag

    return f"{tag}-{re.sub(r'[-:TZ.]', '', timestamp)[:14]}"


def checksum_from_asset(asset: Asset) -> str | None:
    digest = asset.get("digest")
    if not isinstance(digest, str):
        return None
    match = re.fullmatch(r"sha256:([a-f0-9]{64})", digest, re.IGNORECASE)
    return match.group(1).lower() if match else None


def last_update_date(release: Release, asset: Asset) -> str | None:
    timestamp = asset_timestamp(release, asset)
    return timestamp[:10] if timestamp else None


def versioned_filename(asset_name: str, version: str) -> str:
    dot = asset_name.rfind(".")
    stem = asset_name[:dot] if dot > 0 else asset_name
    extension = asset_name[dot:] if dot > 0 else ""
    digit = re.search(r"[0-9]", version)
    suffix = version if digit is None else f"v{version[digit.start():]}"
    return f"{stem}_{suffix}{extension}"


def asset_matcher(source: Source) -> Callable[[Asset], bool]:
    pattern = source.get("asset_pattern")
    if pattern:
        compiled = re.compile(pattern)
        return lambda asset: bool(compiled.search(asset.get("name") or ""))
    return lambda asset: asset.get("name") == source["asset"]


def find_release_asset(
    releases: list[Release],
    matches_asset: Callable[[Asset], bool],
) -> tuple[Release, Asset] | None:
    """Newest non-draft release holding a matching asset. Prereleases count."""
    for release in releases:
        if release.get("draft"):
            continue
        for asset in release.get("assets") or []:
            if matches_asset(asset):
                return release, asset
    return None


async def resolve_source(client: httpx.AsyncClient, source: Source) -> PayloadEntry:
    response = await client.get(
        f"{GITHUB_API}/repos/{source['repo']}/releases",
        params={"per_page": RELEASES_PER_PAGE},
    )
    if not response.is_success:
        raise CatalogError(f"{source['repo']}: GitHub API returned {response.status_code}")

    match = find_release_asset(response.json(), asset_matcher(source))
    if match is None:
        raise CatalogError(f"{source['repo']}: no non-draft release contains {source['asset']}")

    release, asset = match
    version = normalize_version(release, asset)
    entry = {
        "name": source["name"],
        "filename": versioned_filename(source["asset"], version),
        "url": asset["browser_download_url"],
        "source": f"https://github.com/{source['repo']}/releases",
        "source_direct": asset["browser_download_url"],
        "description": source.get("description"),
        "last_update": last_update_date(release, asset),
        "version": version,
        "category": source.get("category"),
        "checksum": checksum_from_asset(asset),
    }
    return {key: value for key, value in entry.items() if value is not None}


def load_bundled_catalog() -> list[PayloadEntry]:
    """The last snapshot manifest committed to the repo (pre-mirror fallback)."""
    catalog = json.loads(BUNDLED_CATALOG_PATH.read_text(encoding="utf-8"))
    if not isinstance(catalog, list):
        raise CatalogError("bundled payloads.json is not an array")
    return catalog


async def fetch_snapshot_manifest(client: httpx.AsyncClient) -> list[PayloadEntry]:
    """The manifest attached to the newest mirror-* snapshot release."""
    response = await client.get(
        f"{GITHUB_API}/repos/{MIRROR_OWNER}/{MIRROR_REPO}/releases",
        params={"per_page": RELEASES_PER_PAGE},
    )
    if not response.is_success:
        raise CatalogError(f"mirror releases returned {response.status_code}")

    snapshot = next(
        (
            release
            for release in response.json()
            if not release.get("draft") and (release.get("tag_name") or "").startswith(MIRROR_PREFIX)
        ),
        None,
    )
    if snapshot is None:
        raise CatalogError("no mirror-* snapshot release found")

    manifest_asset = next(
        (asset for asset in snapshot.get("assets") or [] if asset.get("name") == MANIFEST_ASSET),
        None,
    )
    if manifest_asset is None:
        raise CatalogError(f"{snapshot.get('tag_name')}: snapshot has no {MANIFEST_ASSET} asset")

    download = await client.get(manifest_asset["browser_download_url"])
    if not download.is_success:
        raise CatalogError(f"manifest download returned {download.status_code}")

    manifest = download.json()
    if not isinstance(manifest, list):
        raise CatalogError("snapshot manifest is not an array")
    return manifest


async def fallback_entries(client: httpx.AsyncClient) -> dict[str, PayloadEntry]:
    """Snapshot manifest by payload name, or the bundled catalog when the
    mirror API itself is unreachable."""
    try:
        manifest = await fetch_snapshot_manifest(client)
    except Exception as error:
        print(f"snapshot unreachable ({error}); using bundled payloads.json")
        manifest = load_bundled_catalog()
    return {entry["name"]: entry for entry in manifest if isinstance(entry, dict)}


async def build_catalog() -> list[PayloadEntry]:
    sources = load_sources()
    async with httpx.AsyncClient(
        headers=github_headers(),
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
    ) as client:
        results = await asyncio.gather(
            *(resolve_source(client, source) for source in sources),
            return_exceptions=True,
        )
        if not any(isinstance(result, Exception) for result in results):
            return list(results)

        # Upstream-first, mirror as backup: only unreachable sources are
        # filled from this repository's snapshot.
        fallbacks = await fallback_entries(client)
        catalog = []
        for source, result in zip(sources, results):
            if isinstance(result, Exception):
                entry = fallbacks.get(source["name"])
                if entry is None:
                    raise CatalogError(f"{result} (no snapshot fallback)")
                print(f"fallback to snapshot for {source['name']}: {result}")
                catalog.append(entry)
            else:
                catalog.append(result)
        return catalog


app = FastAPI(
    title="PS5 Custom Payloads",
    description="Payload Manager catalog resolved from upstream GitHub Releases at request time, with snapshot fallback.",
    version="1.0.0",
)

CATALOG_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
}

PREFLIGHT_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
}

ERROR_MESSAGES = {404: "Not found", 405: "Method not allowed"}


def json_response(body: object, status_code: int = 200) -> Response:
    """Serialize the catalog the way Payload Manager sources expect to read it."""
    content = json.dumps(body, indent=2, ensure_ascii=False) + "\n"
    return Response(content=content, status_code=status_code, headers=CATALOG_HEADERS)


@app.middleware("http")
async def cors_and_method_guard(request: Request, call_next):
    """Answer preflights and reject writes before routing, as the catalog is read-only."""
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=PREFLIGHT_HEADERS)
    if request.method not in ("GET", "HEAD"):
        return json_response({"error": ERROR_MESSAGES[405]}, 405)
    return await call_next(request)


@app.exception_handler(HTTPException)
async def error_response(request: Request, exc: HTTPException) -> Response:
    message = ERROR_MESSAGES.get(exc.status_code, str(exc.detail))
    return json_response({"error": message}, exc.status_code)


@app.api_route("/", methods=["GET", "HEAD"])
@app.api_route("/payloads.json", methods=["GET", "HEAD"])
async def payload_catalog() -> Response:
    """The catalog as a bare JSON array, ready to be added as a Payload Manager source."""
    try:
        catalog = await build_catalog()
    except Exception as error:  # mirror and bundled fallback both failed
        return json_response(
            {"error": "Failed to build payload catalog", "detail": str(error)},
            502,
        )
    return json_response(catalog)
