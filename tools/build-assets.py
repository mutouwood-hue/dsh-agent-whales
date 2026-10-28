#!/usr/bin/env python
"""Build the whale-girl sprite sheet assets for dsh-agent-whales.

Pipeline (repeatable, offline-friendly):
  1. fetch the source art from the AATINF/deepseek-whale-girl-assets repo into
     .assets-cache/ (skipped when the file is already cached),
  2. matte the pure-white background with a border flood fill (keeps the white
     apron/ruffles, which are enclosed by line art),
  3. delete the soft grey contact shadow on the ground (per-column foot line),
  4. feather the silhouette and un-premultiply the white spill,
  5. frame it: either the whole figure, or (m-bust) a head->chest window,
  6. downscale to a fixed height with a premultiplied LANCZOS pass,
  7. write assets/<key>.webp (quality 86, method 6),
  8. write assets/art.json (key -> source/w/h/bytes/data-URI),
  9. render assets/_contact.png (every sprite on white / dark / brand blue).

Run:  python tools/build-assets.py
      python tools/build-assets.py --only q-smile m-full --no-shadows

Only assets/ and .assets-cache/ are written; nothing else in the plugin is
touched.
"""
from __future__ import annotations

import argparse
import base64
import datetime as _dt
import io
import json
import os
import subprocess
import sys
import time
import urllib.request

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, ".assets-cache")
OUT = os.path.join(ROOT, "assets")

SOURCE_URL = (
    "https://raw.githubusercontent.com/AATINF/deepseek-whale-girl-assets"
    "/main/share-1600/{variant}.jpg"
)

# key -> source variant, target height, and an optional framing tweak.
#   mode "body" (default): whole figure, normalised so the content height = 192
#   mode "bust": head->chest portrait window anchored on the head, ~1:1 box
SPRITES = [
    {"key": "q-smile", "source": "C12", "height": 192},
    {"key": "q-blink", "source": "C19", "height": 192},
    {"key": "q-wave", "source": "C23", "height": 192},
    {"key": "q-proud", "source": "C21", "height": 192},
    {"key": "q-sleepy", "source": "C27", "height": 192},
    # the portrait is cropped out of P1 so it matches m-full exactly (same
    # drawing, so the UI can zoom between the two without a jump)
    {"key": "m-bust", "source": "P1", "height": 192,
     "bust": {"height_frac": 0.34, "aspect": 0.95}},
    {"key": "m-full", "source": "P1", "height": 192},
]

BUST_HEAD_BAND = 0.16      # top slice of the figure used to locate the head

WEBP_QUALITY = 86
WEBP_METHOD = 6

# --- matting knobs -----------------------------------------------------------
BG_TOLERANCE = 26          # flood-fill tolerance against the white backdrop
FEATHER_RADIUS = 0.8       # gaussian blur applied to the binary matte
FEATHER_LO = 40            # alpha below this collapses to 0
FEATHER_HI = 210           # alpha above this snaps to 255
FEATHER_GAIN = 1.35        # contrast boost for the in-between ramp
EDGE_REF_RADIUS = 2        # px walked inwards to find the foreground colour
CROP_PAD = 4               # px of slack around the content bbox

# --- ground shadow removal ---------------------------------------------------
SOLID_LUM = 160            # darker than this counts as character line art/body
SOLID_SAT = 45             # chroma above this counts as character (hair/tail)
SHADOW_MARGIN = 4          # px kept below the foot line before the cut
SHADOW_WINDOW_FRAC = 0.012  # running-max window (+- columns) for a smooth floor
SHADOW_LUM_MAX = 250       # pixels brighter than this are never cut
CROPPED_ROW_FRAC = 0.02    # last row this "solid" => art bleeds off the frame

CONTACT_BACKGROUNDS = [
    ("white", (255, 255, 255)),
    ("dark", (0x11, 0x13, 0x18)),
    ("brand", (0x3B, 0x55, 0xF0)),
]


# --------------------------------------------------------------------------- #
# download
# --------------------------------------------------------------------------- #
def _download(url: str, dst: str, retries: int = 3) -> None:
    """Fetch url -> dst atomically. urllib first, curl.exe as a fallback."""
    tmp = dst + ".part"
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "dsh-agent-whales/asset-build"}
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = resp.read()
            if len(data) < 1024:
                raise IOError(f"short body ({len(data)} bytes)")
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, dst)
            return
        except Exception as exc:  # noqa: BLE001 - report and retry
            last = exc
            if attempt == retries:
                break
            time.sleep(1.2 * attempt)
    # last resort: the system curl binary
    try:
        if os.path.exists(tmp):
            os.remove(tmp)
        subprocess.run(
            ["curl.exe", "-sS", "-L", "--max-time", "60", "-o", tmp, url],
            check=True,
            capture_output=True,
        )
        if os.path.getsize(tmp) >= 1024:
            os.replace(tmp, dst)
            return
        raise IOError("curl produced a short body")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            f"could not download {url} ({last}; curl: {exc}). "
            f"Drop the file into {CACHE} manually to build offline."
        ) from exc


def ensure_source(variant: str, allow_download: bool = True) -> str:
    path = os.path.join(CACHE, f"{variant}.jpg")
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        try:
            with Image.open(path) as probe:
                probe.verify()
            return path
        except Exception:  # noqa: BLE001 - cached file is corrupt, refetch
            os.remove(path)
    if not allow_download:
        raise RuntimeError(f"{path} is missing and --no-download was given")
    _download(SOURCE_URL.format(variant=variant), path)
    with Image.open(path) as probe:
        probe.verify()
    return path


# --------------------------------------------------------------------------- #
# matting
# --------------------------------------------------------------------------- #
def background_alpha(img: Image.Image, thresh: int = BG_TOLERANCE) -> np.ndarray:
    """Border flood fill -> uint8 matte (0 = background, 255 = keep)."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    probe = rgb.copy()
    sentinel = (255, 0, 255)
    seeds = [
        (0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
        (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2),
        (w // 4, 0), (3 * w // 4, 0), (w // 4, h - 1), (3 * w // 4, h - 1),
    ]
    for seed in seeds:
        if probe.getpixel(seed) == sentinel:
            continue
        ImageDraw.floodfill(probe, seed, sentinel, thresh=thresh)
    diff = ImageChops.difference(probe, Image.new("RGB", rgb.size, sentinel))
    return np.asarray(diff.convert("L").point(lambda v: 0 if v == 0 else 255))


def _luma_chroma(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    luma = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    chroma = rgb.max(axis=2).astype(np.float32) - rgb.min(axis=2).astype(np.float32)
    return luma, chroma


def remove_ground_shadow(
    rgb: np.ndarray, alpha: np.ndarray, verbose: bool = True
) -> tuple[np.ndarray, dict]:
    """Zero the alpha of the soft grey contact shadow under the feet.

    The shadow is a neutral grey ellipse painted on the white backdrop, so it
    cannot be told apart from white clothing by colour alone. Instead we use
    geometry: per column, find the lowest *solid* character pixel (dark line
    art / saturated hair - white fabric is always bounded by line art, so this
    lands on real character, never on a wash of grey) and drop everything
    below it, smoothed over a small window so the cut follows the ground line.
    """
    h, w = alpha.shape
    luma, chroma = _luma_chroma(rgb)
    solid = (luma < SOLID_LUM) | (chroma > SOLID_SAT)
    info = {"cropped": False, "killed_px": 0, "foot_line": None}

    # artwork that bleeds off the bottom edge has no ground line to cut at
    if solid[h - 1].mean() > CROPPED_ROW_FRAC:
        info["cropped"] = True
        if verbose:
            print("    shadow: skipped (art runs off the bottom edge)")
        return alpha, info

    solid_rows = np.nonzero(solid.any(axis=1))[0]
    if solid_rows.size == 0:
        info["cropped"] = True
        return alpha, info

    # lowest solid row per column (-1 = column has no character at all)
    col_floor = np.full(w, -1, dtype=np.int32)
    for x in range(w):
        rows = np.nonzero(solid[:, x])[0]
        if rows.size:
            col_floor[x] = rows[-1]

    window = max(4, int(round(w * SHADOW_WINDOW_FRAC)))
    known = np.nonzero(col_floor >= 0)[0]
    floor = np.full(w, -1, dtype=np.int32)
    if known.size:
        # running max over a +-window, evaluated only where something is known,
        # so columns of pure backdrop borrow the neighbouring foot line
        span_lo = np.searchsorted(known, np.arange(w) - window, side="left")
        span_hi = np.searchsorted(known, np.arange(w) + window, side="right")
        for x in range(w):
            if span_hi[x] > span_lo[x]:
                floor[x] = col_floor[known[span_lo[x]:span_hi[x]]].max()

    rows = np.arange(h, dtype=np.int32)[:, None]
    cut_from = np.where(floor >= 0, floor[None, :] + SHADOW_MARGIN, 10 ** 6)
    kill = (rows > cut_from) & (luma <= SHADOW_LUM_MAX) & (alpha > 0)
    killed = int(kill.sum())
    if killed:
        alpha = alpha.copy()
        alpha[kill] = 0
    info["killed_px"] = killed
    info["foot_line"] = int(solid_rows[-1])
    if verbose:
        print(
            f"    shadow: foot line y={info['foot_line']}, "
            f"cleared {killed:,} px"
        )
    return alpha, info


def feather(alpha: np.ndarray) -> np.ndarray:
    img = Image.fromarray(alpha, "L")
    img = img.filter(ImageFilter.GaussianBlur(FEATHER_RADIUS))
    lut = [
        0 if v < FEATHER_LO
        else 255 if v > FEATHER_HI
        else min(255, int(v * FEATHER_GAIN))
        for v in range(256)
    ]
    return np.asarray(img.point(lut))


def despill_white(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Un-premultiply pixels that were blended into the white backdrop."""
    a = alpha.astype(np.float32) / 255.0
    af = np.clip(a, 1e-3, 1.0)[..., None]
    fixed = (rgb.astype(np.float32) - (1.0 - af) * 255.0) / af
    out = np.where(a[..., None] <= 0.0, rgb, np.clip(fixed, 0, 255))
    return np.uint8(np.clip(out, 0, 255))


def crop_to_content(rgb: np.ndarray, alpha: np.ndarray, pad: int = CROP_PAD):
    ys, xs = np.nonzero(alpha)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    h, w = alpha.shape
    y0, x0 = max(0, y0 - pad), max(0, x0 - pad)
    y1, x1 = min(h, y1 + pad), min(w, x1 + pad)
    return rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]


def head_center_x(alpha: np.ndarray, band: float = BUST_HEAD_BAND) -> float:
    """Horizontal centroid of the matte in the top band = the head."""
    h, w = alpha.shape
    top = alpha[: max(1, int(h * band))] > 40
    col = top.sum(axis=0).astype(np.float64)
    if col.sum() <= 0:
        return w / 2.0
    return float((col * np.arange(w)).sum() / col.sum())


def bust_crop(
    rgb: np.ndarray,
    alpha: np.ndarray,
    height_frac: float = 0.34,
    aspect: float = 0.95,
    top_frac: float = 0.0,
):
    """Cut a head->chest portrait out of the matted figure.

    Anchored on the top of the content (so the headband / ahoge always
    survive) and horizontally on the head centroid, so the face sits in the
    middle of a roughly 1:1 frame instead of the whole standing figure.
    """
    h, w = alpha.shape
    ch = min(h, max(1, int(round(h * height_frac))))
    cw = min(w, max(1, int(round(ch * aspect))))
    cx = head_center_x(alpha)
    x0 = max(0, min(w - cw, int(round(cx - cw / 2.0))))
    y0 = max(0, min(h - ch, int(round(h * top_frac))))
    return (
        rgb[y0:y0 + ch, x0:x0 + cw],
        alpha[y0:y0 + ch, x0:x0 + cw],
        (x0, y0, cw, ch),
    )


def refine_edge_alpha(rgb: np.ndarray, alpha: np.ndarray,
                      radius: int = EDGE_REF_RADIUS) -> np.ndarray:
    """Pull the soft edge band back to real coverage so no white fringe is left.

    A soft matte pixel observed over white can only be so opaque: if the
    nearest opaque foreground pixel is dark, a pale boundary pixel must be a
    *low coverage* blend, not an opaque light pixel. Walking a couple of pixels
    inwards along the 8 compass directions gives us that foreground reference;
    the pixel's own white-distance then caps its alpha, and the white spill is
    un-blended in despill_white. Without this, boundary pixels that the feather
    snapped to opaque keep a pale colour and show up as a 1px halo on dark
    backgrounds.
    """
    lum = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    lum = lum.astype(np.float32)
    a = alpha.astype(np.float32)
    interior = a >= 250.0
    h, w = a.shape

    best_a = np.zeros_like(a)
    best_ref = np.zeros_like(lum)
    for dy in (-radius, 0, radius):
        for dx in (-radius, 0, radius):
            if dy == 0 and dx == 0:
                continue
            a_sh = np.zeros_like(a)
            l_sh = np.zeros_like(lum)
            i_sh = np.zeros(interior.shape, dtype=bool)
            ys0, ys1 = max(0, -dy), h - max(0, dy)
            xs0, xs1 = max(0, -dx), w - max(0, dx)
            a_sh[ys0:ys1, xs0:xs1] = a[ys0 + dy:ys1 + dy, xs0 + dx:xs1 + dx]
            l_sh[ys0:ys1, xs0:xs1] = lum[ys0 + dy:ys1 + dy, xs0 + dx:xs1 + dx]
            i_sh[ys0:ys1, xs0:xs1] = interior[ys0 + dy:ys1 + dy, xs0 + dx:xs1 + dx]
            better = i_sh & (a_sh > best_a)
            best_a = np.where(better, a_sh, best_a)
            best_ref = np.where(better, l_sh, best_ref)

    band = (a > 0.0) & (a < 250.0) & (best_a > 0.0)
    denom = np.maximum(16.0, 255.0 - best_ref)
    cap = np.clip((255.0 - lum) / denom, 0.0, 1.0) * 255.0
    out = np.where(band, np.minimum(a, cap), a)
    return np.uint8(np.clip(out + 0.5, 0, 255))


def resize_premultiplied(rgba: np.ndarray, height: int) -> np.ndarray:
    """Downscale RGBA with LANCZOS in premultiplied space (no dark fringe)."""
    h, w = rgba.shape[:2]
    width = max(1, int(round(w * height / h)))
    a = rgba[..., 3].astype(np.float32) / 255.0
    chans = [
        Image.fromarray((rgba[..., c].astype(np.float32) * a), "F")
        for c in range(3)
    ]
    chans.append(Image.fromarray(a * 255.0, "F"))
    small = [c.resize((width, height), Image.LANCZOS) for c in chans]
    pm = np.dstack([np.asarray(c, dtype=np.float32) for c in small])
    al = np.clip(pm[..., 3], 0.0, 255.0) / 255.0
    pm_rgb = np.clip(pm[..., :3], 0.0, 255.0)
    pm_rgb = np.minimum(pm_rgb, al[..., None] * 255.0)  # LANCZOS overshoot
    safe = np.clip(al, 1e-3, 1.0)[..., None]
    rgb = np.where(al[..., None] > 0.0, pm_rgb / safe, 0.0)
    out = np.dstack([np.clip(rgb, 0, 255), al * 255.0])
    return np.uint8(np.clip(out + 0.5, 0, 255))


# --------------------------------------------------------------------------- #
# build one sprite
# --------------------------------------------------------------------------- #
def build_sprite(variant: str, height: int, *, bust=None, shadows: bool = True,
                 edge_fix: bool = True):
    src = ensure_source(variant)
    with Image.open(src) as im:
        im = im.convert("RGB")
        rgb = np.asarray(im).copy()
        print(f"  {variant}: {im.width}x{im.height} from {os.path.basename(src)}")

    alpha = background_alpha(im)
    if shadows:
        alpha, info = remove_ground_shadow(rgb, alpha)
    else:
        info = {"cropped": True, "killed_px": 0, "foot_line": None}
    alpha = feather(alpha)
    if edge_fix:
        alpha = refine_edge_alpha(rgb, alpha)
    rgb, alpha = crop_to_content(rgb, alpha)
    print(f"    crop: {alpha.shape[1]}x{alpha.shape[0]}")
    rgb = despill_white(rgb, alpha)
    if bust:
        rgb, alpha, box = bust_crop(rgb, alpha, **bust)
        print(f"    bust window: x{box[0]} y{box[1]} {box[2]}x{box[3]}")
    rgba = np.dstack([rgb, alpha])
    small = resize_premultiplied(rgba, height)
    return Image.fromarray(small, "RGBA"), info


def encode_webp(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# contact sheet
# --------------------------------------------------------------------------- #
def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except Exception:  # noqa: BLE001 - very old Pillow
        return ImageFont.load_default()


def contact_sheet(items, cell: int = 192, gutter: int = 132, pad: int = 10):
    """items: [(key, rgba Image)] -> path of assets/_contact.png."""
    label_font = _font(22)
    sub_font = _font(15)
    cell_w = max(cell, max(im.width for _, im in items))
    sheet_w = gutter + pad + len(CONTACT_BACKGROUNDS) * (cell_w + pad * 2)
    row_h = cell + pad * 2
    sheet_h = pad + len(items) * row_h
    sheet = Image.new("RGB", (sheet_w, sheet_h), (245, 246, 250))
    draw = ImageDraw.Draw(sheet)

    for i, (bg_name, bg_rgb) in enumerate(CONTACT_BACKGROUNDS):
        x = gutter + pad + i * (cell_w + pad * 2)
        draw.text((x + 6, 1), bg_name, fill=(90, 95, 105), font=sub_font)

    for row, (key, im) in enumerate(items):
        y = pad + row * row_h
        draw.text((12, y + cell // 2 - 16), key, fill=(20, 20, 20), font=label_font)
        draw.text(
            (12, y + cell // 2 + 10),
            f"{im.width}x{im.height}",
            fill=(110, 115, 125),
            font=sub_font,
        )
        for col, (_, bg_rgb) in enumerate(CONTACT_BACKGROUNDS):
            x = gutter + pad + col * (cell_w + pad * 2)
            tile = Image.new("RGBA", (cell_w + pad * 2, cell), bg_rgb + (255,))
            tile.alpha_composite(
                im, ((tile.width - im.width) // 2, (tile.height - im.height) // 2)
            )
            sheet.paste(tile.convert("RGB"), (x, y + pad))
            draw.rectangle(
                [x, y + pad, x + tile.width - 1, y + pad + tile.height - 1],
                outline=(225, 227, 232),
            )

    path = os.path.join(OUT, "_contact.png")
    tmp = path + ".part"
    sheet.save(tmp, "PNG", optimize=True)
    os.replace(tmp, path)
    return path


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="build the whale-girl sprite assets")
    ap.add_argument("--only", nargs="*", default=None,
                    help="build only these keys (default: all 7)")
    ap.add_argument("--no-download", action="store_true",
                    help="never hit the network; use .assets-cache only")
    ap.add_argument("--no-shadows", action="store_true",
                    help="skip ground-shadow removal (debug)")
    ap.add_argument("--no-edge-fix", action="store_true",
                    help="skip the edge coverage cap (debug)")
    ap.add_argument("--strict", action="store_true",
                    help="fail if the total sprite payload exceeds --budget-kb")
    ap.add_argument("--budget-kb", type=float, default=150.0)
    args = ap.parse_args(argv)

    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    wanted = [
        s for s in SPRITES if args.only is None or s["key"] in set(args.only)
    ]
    if not wanted:
        print(f"no sprite matches {args.only}", file=sys.stderr)
        return 2

    sprites, renders, total = {}, [], 0
    for spec in wanted:
        key, variant, height = spec["key"], spec["source"], spec["height"]
        print(f"[{key}] source {variant} -> {height}px")
        img, _info = build_sprite(
            variant, height, bust=spec.get("bust"),
            shadows=not args.no_shadows, edge_fix=not args.no_edge_fix,
        )
        data = encode_webp(img)
        path = os.path.join(OUT, f"{key}.webp")
        tmp = path + ".part"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
        total += len(data)
        sprites[key] = {
            "source": variant,
            "w": img.width,
            "h": img.height,
            "bytes": len(data),
            "uri": "data:image/webp;base64," + base64.b64encode(data).decode("ascii"),
        }
        renders.append((key, img))
        print(f"    -> {key}.webp {img.width}x{img.height} {len(data):,} bytes")

    art = {
        "generatedAt": _dt.datetime.now(_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "sprites": sprites,
    }
    art_path = os.path.join(OUT, "art.json")
    tmp = art_path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(art, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, art_path)

    if args.only is None:
        sheet = contact_sheet(renders)
        print(f"contact sheet: {sheet}")

    kb = total / 1024.0
    print(f"\ntotal: {len(sprites)} sprites, {total:,} bytes ({kb:.1f} KB)"
          f" / budget {args.budget_kb:.0f} KB")
    print(f"art.json: {art_path}")
    if args.strict and kb > args.budget_kb:
        print(f"over budget: {kb:.1f} KB > {args.budget_kb:.0f} KB", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
