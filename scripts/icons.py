"""Extract a dashboard icon for every source in sources.json.

Ports the official mirror's icon pipeline (itsPLK/ps5-payloads-mirror:
icon_utils.py compression and set_icon.py suggestion order) so this catalog
shows the same kind of icons. For each source it probes the upstream
repository for the standard PS5 icon locations, falls back to the owner's
GitHub avatar, and compresses the image into a bounded data URI that PS5
WebKit can decode (PNG/JPEG/SVG only, no WebP).

Writes, at the repository root:

- icons.json       {"icons": {sha256(data_uri): data_uri}} - content-addressed,
                   the same scheme as the official mirror (keys are the SHA-256
                   of the data URI, so identical images share one entry and
                   unreferenced entries disappear on the next run).
- payloads_v2.json the catalog in the object-wrapper form pldmgr v0.6+ expects
                   for icons: {"name", "icons_url": "icons.json", "payloads":
                   [...]} with an icon_key added to every payload that got one.
                   The bare payloads.json stays untouched so v0.5.x clients
                   keep working (their parser mishandles the wrapper).

Run with `npm run icons` (uv) or `python scripts/icons.py` (needs Pillow).
A payload whose icon cannot be resolved is skipped with a warning; the run
never fails because of one bad image.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SOURCES_PATH = ROOT / "sources.json"
CATALOG_PATH = ROOT / "payloads.json"
V2_CATALOG_PATH = ROOT / "payloads_v2.json"
ICONS_PATH = ROOT / "icons.json"

MAX_ICON_BYTES = 12_000  # compression target (< 12,288 hard backend limit)
HARD_LIMIT = 12_288
MAX_DIM = 128
USER_AGENT = "ps5-custom-payloads-icons"

# set_icon.py's common asset locations, probed in this order.
ICON_PATHS = [
    "assets/icon0.png",
    "assets/icon.png",
    "icon0.png",
    "icon.png",
    "assets/logo.png",
    "logo.png",
]


def http_get(url: str, timeout: float = 20) -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers.get("Content-Type", "")


def resolve_icon_source(source: str) -> str:
    """Normalize @user / GitHub profile / GitHub blob URLs to a direct URL."""
    source = source.strip()
    if source.startswith("data:image/"):
        return source
    if source.startswith("@"):
        return f"https://github.com/{source[1:].strip()}.png"
    profile = re.match(r"^https?://github\.com/([a-zA-Z0-9\-_]+)/?$", source)
    if profile and profile.group(1) not in (
        "features",
        "marketplace",
        "explore",
        "topics",
        "trending",
        "collections",
    ):
        return f"https://github.com/{profile.group(1)}.png"
    blob = re.match(r"^https?://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.*)$", source)
    if blob:
        owner, repo, branch, path = blob.groups()
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"
    return source


def fetch_icon_bytes(url: str, timeout: float = 20) -> tuple[bytes, str] | None:
    try:
        return http_get(url, timeout)
    except Exception as error:
        print(f"warning: {url}: {error}", file=sys.stderr)
        return None


def find_repo_icon(repo: str) -> tuple[str, bytes] | None:
    """Probe the repo's default branch (HEAD) for the standard icon locations."""
    for path in ICON_PATHS:
        url = f"https://raw.githubusercontent.com/{repo}/HEAD/{path}"
        fetched = fetch_icon_bytes(url, timeout=5)
        if fetched is not None:
            return url, fetched[0]
    return None


def owner_avatar(repo: str) -> tuple[str, bytes]:
    url = f"https://github.com/{repo.split('/')[0]}.png"
    data, _ = http_get(url)
    return url, data


def convert_image_to_data_uri(
    raw_bytes: bytes,
    mime_hint: str = "",
    max_dim: int = MAX_DIM,
    max_len: int = MAX_ICON_BYTES,
) -> str:
    """Compress an image into a data URI PS5 WebKit can render.

    Same strategy as the official icon_utils.py: SVG passes through when it
    fits, raster images are resized through descending dimensions and encoded
    as optimized PNG, palette-quantized PNG (alpha) or JPEG (opaque) until the
    base64 URI fits the budget. WebP is never produced.
    """
    stripped = raw_bytes.strip()
    is_svg = (
        "svg" in mime_hint.lower()
        or (stripped.startswith(b"<?xml") and b"<svg" in stripped[:300])
        or stripped.startswith(b"<svg")
        or b"<svg" in stripped[:200]
    )
    if is_svg:
        svg_text = re.sub(r"<!--.*?-->", "", raw_bytes.decode("utf-8", errors="ignore"), flags=re.DOTALL)
        svg_text = re.sub(r"\s+", " ", svg_text).strip()
        uri = "data:image/svg+xml;base64," + base64.b64encode(svg_text.encode("utf-8")).decode("ascii")
        if len(uri) <= max_len:
            return uri
        # Oversized SVG falls through to rasterization below (Pillow declines
        # it without an SVG plugin, surfacing as a normal decode failure).

    try:
        img = Image.open(io.BytesIO(raw_bytes))
    except Exception as error:
        raise ValueError(f"failed to decode image: {error}") from error

    try:
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    has_alpha = False
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        alpha = rgba.split()[-1]
        if alpha.getextrema()[0] < 250:
            has_alpha = True
            img = rgba
        else:
            img = rgba.convert("RGB")
    else:
        img = img.convert("RGB")

    best: str | None = None
    for dim in (d for d in (max_dim, 96, 80, 64, 48) if d <= max_dim):
        resized = img.copy()
        resized.thumbnail((dim, dim), Image.Resampling.LANCZOS)

        if has_alpha:
            buffer = io.BytesIO()
            resized.save(buffer, format="PNG", optimize=True)
            uri = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
            if len(uri) <= max_len:
                best = uri
                break
            for colors in (128, 64, 32):
                quantized = resized.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)
                buffer = io.BytesIO()
                quantized.save(buffer, format="PNG", optimize=True)
                uri = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
                if len(uri) <= max_len:
                    best = uri
                    break
            if best:
                break
            continue

        buffer = io.BytesIO()
        resized.save(buffer, format="PNG", optimize=True)
        uri_png = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

        uri_jpeg = None
        rgb = resized if resized.mode == "RGB" else resized.convert("RGB")
        for quality in (85, 80, 75):
            buffer = io.BytesIO()
            rgb.save(buffer, format="JPEG", quality=quality, optimize=True)
            candidate = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
            if len(candidate) <= max_len:
                uri_jpeg = candidate
                break

        # Opaque icons: PNG wins whenever it fits, else the smaller JPEG.
        if len(uri_png) <= max_len:
            best = uri_png
            break
        if uri_jpeg:
            best = uri_jpeg
            break

    if best is None:
        raise ValueError(f"could not compress image under {max_len} bytes")
    if not best.startswith("data:image/") or "image/webp" in best or len(best) >= HARD_LIMIT:
        raise ValueError("compressed icon violates the backend data URI constraints")
    return best


def resolve_payload_icon(source: dict) -> tuple[str, str] | None:
    """(source URL, data URI) for one source, or None when everything fails.

    Order: explicit `icon` override, upstream repo icon locations, owner
    avatar - the same suggestion order the official mirror uses.
    """
    repo = source["repo"]
    override = source.get("icon")
    if override:
        url = resolve_icon_source(override)
        fetched = fetch_icon_bytes(url)
        if fetched is not None:
            try:
                return url, convert_image_to_data_uri(fetched[0], fetched[1])
            except ValueError as error:
                print(f"warning: {source['name']}: icon override unusable ({error})", file=sys.stderr)

    repo_icon = find_repo_icon(repo)
    if repo_icon is not None:
        url, data = repo_icon
        try:
            return url, convert_image_to_data_uri(data)
        except ValueError as error:
            print(f"warning: {source['name']}: {url} unusable ({error})", file=sys.stderr)

    url, data = owner_avatar(repo)
    try:
        return url, convert_image_to_data_uri(data)
    except ValueError as error:
        print(f"warning: {source['name']}: avatar unusable ({error})", file=sys.stderr)
    return None


def build_icon_catalog(config: dict) -> tuple[dict[str, str], dict[str, str]]:
    """(icon_key by payload name, icons map) resolved for every source."""
    keys_by_name: dict[str, str] = {}
    icons: dict[str, str] = {}
    for source in config["sources"]:
        resolved = resolve_payload_icon(source)
        if resolved is None:
            print(f"warning: {source['name']}: no icon resolved; it gets the generated fallback", file=sys.stderr)
            continue
        url, data_uri = resolved
        key = hashlib.sha256(data_uri.encode("ascii")).hexdigest()
        keys_by_name[source["name"]] = key
        icons[key] = data_uri
        print(f"{source['name']}: {url} -> {len(data_uri)} chars ({key[:12]})")
    return keys_by_name, icons


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    config = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
    keys_by_name, icons = build_icon_catalog(config)

    write_json(ICONS_PATH, {"icons": dict(sorted(icons.items()))})

    payloads_v2 = []
    if CATALOG_PATH.exists():
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        if not isinstance(catalog, list):
            raise SystemExit("payloads.json is not a bare catalog array")
        for entry in catalog:
            key = keys_by_name.get(entry.get("name"))
            payloads_v2.append({**entry, **({"icon_key": key} if key else {})})
    else:
        print("warning: payloads.json not found; writing icons without the v2 catalog", file=sys.stderr)

    write_json(
        V2_CATALOG_PATH,
        {"name": config.get("name"), "icons_url": "icons.json", "payloads": payloads_v2},
    )
    print(
        f"wrote icons.json ({len(icons)} icons) and payloads_v2.json "
        f"({sum(1 for p in payloads_v2 if 'icon_key' in p)}/{len(payloads_v2)} with icons)"
    )


if __name__ == "__main__":
    main()
