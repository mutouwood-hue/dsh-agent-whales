"""候选帧 vs 运行时基准帧的定量验收（Pillow + numpy）。

对应 PRD §35.8.6 的验收项：

  取景一致   → bbox、宽高比、25/50/75% 高度处的轮廓宽度、轮廓 IoU、宽度剖面相关度
  眨眼对位   → m-* 与 m-base 的逐像素差：眼球带内 / 带外的差异能量占比
  抠图干净   → alpha 半透明边缘占比（越接近 0 越好）、三底 200% 目检图
  表情可辨   → 96px 对照（浅底 + 深底），人眼判读；脚本负责渲染
  像素皮肤   → 最近邻缩放 + 调色板/颗粒/基线检查（--classic）

用法：
  python tools/qa-frames.py --cand _scratch/candidates/art-staging.json --out _scratch/qa
  python tools/qa-frames.py --cand ... --classic
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_B = r"C:\Windows\Fonts\msyhbd.ttc"
INK = (20, 22, 28)
MUTED = (110, 115, 125)
RULE = (226, 228, 234)
LIGHT = (245, 246, 250)
DARK = (22, 24, 30)
BRAND = (29, 78, 216)


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT_B if bold else FONT, size)
    except OSError:
        return ImageFont.load_default(size=size)


def load_sprite(entry):
    raw = base64.b64decode(entry["uri"].split(";base64,", 1)[1])
    return Image.open(io.BytesIO(raw)).convert("RGBA")


def rgba_of(img):
    return np.asarray(img).astype(np.float32) / 255.0


def alpha_of(img):
    return rgba_of(img)[:, :, 3]


def bbox(mask, thr=0.2):
    ys, xs = np.nonzero(mask > thr)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def width_at(mask, frac):
    """在给定高度比例处，轮廓宽度占 bbox 宽度的比例（取该行附近 3 行的最大宽度）。"""
    bb = bbox(mask)
    if not bb:
        return 0.0
    x0, y0, x1, y1 = bb
    row = y0 + int((y1 - y0) * frac)
    rows = [mask[max(0, row + d)] for d in (-1, 0, 1)]
    wide = np.max(np.stack(rows), axis=0) > 0.2
    return float(wide.sum()) / float(x1 - x0)


def iou_aligned(base_mask, cand_img, size):
    same = cand_img.resize(size, Image.LANCZOS)
    a, b = base_mask > 0.2, alpha_of(same) > 0.2
    inter, union = np.logical_and(a, b).sum(), np.logical_or(a, b).sum()
    return float(inter) / float(union) if union else 0.0


def profile_corr(base_mask, cand_img, size, n=96):
    same = alpha_of(cand_img.resize(size, Image.LANCZOS))
    wa = (base_mask > 0.2).sum(axis=1).astype(np.float32)
    wb = (same > 0.2).sum(axis=1).astype(np.float32)

    def resample(w):
        return np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(w)), w / max(w.max(), 1))

    a, b = resample(wa), resample(wb)
    if a.std() == 0 or b.std() == 0:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def eye_band_diff(base_img, cand_img):
    """把候选叠到基准尺寸后，比较「眼球带内」与「带外」的差异能量。

    眼带取 bbox 的 28%~58% 高、18%~82% 宽（这两批都是正脸头肩/全身，够用）。
    判据：带外几乎无差异 ⇒ 整帧可直接用；带外差异显著 ⇒ 必须只合成眼部区域。
    """
    w, h = base_img.size
    cand = cand_img.resize((w, h), Image.LANCZOS)
    a, b = rgba_of(base_img), rgba_of(cand)
    both = (a[:, :, 3] > 0.5) & (b[:, :, 3] > 0.5)
    diff = np.abs(a[:, :, :3] - b[:, :, :3]).mean(axis=2)
    diff = diff * both
    bb = bbox(a[:, :, 3])
    if not bb:
        return None
    x0, y0, x1, y1 = bb
    yb0, yb1 = y0 + int((y1 - y0) * 0.28), y0 + int((y1 - y0) * 0.58)
    xb0, xb1 = x0 + int((x1 - x0) * 0.18), x0 + int((x1 - x0) * 0.82)
    band = np.zeros_like(both)
    band[yb0:yb1, xb0:xb1] = True
    inside = diff[both & band]
    outside = diff[both & ~band]
    return {
        "inside_mean": float(inside.mean()) if inside.size else 0.0,
        "outside_mean": float(outside.mean()) if outside.size else 0.0,
        "outside_p99": float(np.percentile(outside, 99)) if outside.size else 0.0,
        "outside_hot": float((outside > 0.15).mean() * 100) if outside.size else 0.0,
    }


def edge_soft_ratio(img):
    a = alpha_of(img)
    return float(((a > 0.05) & (a < 0.95)).sum()) / max((a > 0.05).sum(), 1) * 100


def tile(img, cell, bg, pad=14, nearest=False):
    """把图**等比**放进 cell×cell 的格子里（不能拉成正方形——像素皮 111×192 会被横向撑宽，判断全错）。"""
    scale = min(cell / img.width, cell / img.height)
    w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    resample = Image.NEAREST if nearest else Image.LANCZOS
    out = Image.new("RGBA", (cell + pad * 2, cell + pad * 2), bg + (255,))
    out.alpha_composite(img.resize((w, h), resample), (pad + (cell - w) // 2, pad + (cell - h) // 2))
    return out.convert("RGB")


def sheet(rows, out_path, title, subtitle, classic=False):
    pad = 16
    label_w = 460
    cells = [("基准 192", 192, LIGHT), ("候选 192", 192, LIGHT), ("基准 96 浅", 96, LIGHT),
             ("候选 96 浅", 96, LIGHT), ("候选 96 深", 96, DARK)]
    row_h = 220 + 10
    width = label_w + sum(c + pad * 2 for _, c, _ in cells)
    height = 104 + row_h * len(rows) + 24
    sh = Image.new("RGB", (width, height), (255, 255, 255))
    d = ImageDraw.Draw(sh)
    d.text((pad, 16), title, fill=INK, font=font(26, True))
    d.text((pad, 52), subtitle, fill=MUTED, font=font(14))
    x = label_w
    for name, _c, _bg in cells:
        d.text((x + 6, 84), name, fill=MUTED, font=font(14))
        x += _c + pad * 2
    d.line([(pad, 104), (width - pad, 104)], fill=RULE, width=2)
    for i, (label, base, cand, note) in enumerate(rows):
        y = 104 + i * row_h
        d.text((pad, y + 10), label, fill=INK, font=font(20, True))
        for j, line in enumerate(note.split(" · ")):
            d.text((pad, y + 42 + j * 22), "· " + line, fill=MUTED, font=font(14))
        x = label_w
        for idx, (_n, cell, bg) in enumerate(cells):
            img = base if idx in (0, 2) else cand
            sh.paste(tile(img, cell, bg, nearest=classic), (x, y))
            d.rectangle([x, y, x + cell + pad * 2 - 1, y + cell + pad * 2 - 1], outline=RULE)
            x += cell + pad * 2
    sh.save(out_path, "PNG", optimize=True)
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.path.join(ROOT, "assets", "art.json"))
    ap.add_argument("--cand", required=True)
    ap.add_argument("--out", default=os.path.join(ROOT, "_scratch", "qa"))
    ap.add_argument("--classic", action="store_true", help="经典像素皮肤：用最近邻 + 专属对照")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    base = json.load(open(args.base, encoding="utf-8"))["sprites"]
    cand = json.load(open(args.cand, encoding="utf-8"))["sprites"]

    # 先做一次「量纲校准」：同一角色、只差眨眼的帧 vs 明显换姿势的帧，给读者一把尺
    if not args.classic and "q-smile" in base and "q-blink" in base and "q-sleepy" in base:
        b = load_sprite(base["q-smile"])
        bm = alpha_of(b)
        refs = {
            "校准·只差眨眼 q-blink": iou_aligned(bm, load_sprite(base["q-blink"]), b.size),
            "校准·换了姿势 q-sleepy": iou_aligned(bm, load_sprite(base["q-sleepy"]), b.size),
        }
        print("量纲校准（IoU，越高越像）：", " ".join(f"{k.split('·')[1]}={v:.3f}" for k, v in refs.items()))

    header = f"{'key':<10}{'尺寸':<10}{'bbox':<12}{'IoU':>7}{'剖面':>7}{'w25':>7}{'w50':>7}{'w75':>7}{'软边%':>7}"
    eye_header = f"{'key':<10}{'眼带内':>8}{'眼带外':>8}{'带外p99':>9}{'带外>0.15':>10}"
    rows = []
    eye_rows = []
    for key in sorted(cand):
        ref = "q-smile" if key.startswith("q-") else ("m-base" if key.startswith("m-") else "c-idle")
        if ref not in base:
            print(f"[skip] {key}: 缺基准 {ref}")
            continue
        bi, ci = load_sprite(base[ref]), load_sprite(cand[key])
        bm, cm = alpha_of(bi), alpha_of(ci)
        bb, cb = bbox(bm), bbox(cm)
        i_val = iou_aligned(bm, ci, bi.size)
        corr = profile_corr(bm, ci, bi.size)
        soft = edge_soft_ratio(ci)
        w25, w50, w75 = (width_at(bm, f) for f in (0.25, 0.5, 0.75))
        c25, c50, c75 = (width_at(cm, f) for f in (0.25, 0.5, 0.75))
        if key == sorted(cand)[0]:
            print(header)
        print(f"{key:<10}{ci.width}x{ci.height:<6}{f'{cb[2]-cb[0]}x{cb[3]-cb[1]}':<12}"
              f"{i_val:>7.3f}{corr:>7.3f}"
              f"{w25:>7.2f}{w50:>7.2f}{w75:>7.2f}{soft:>7.1f}")
        note = (f"IoU {i_val:.3f}（校准见上行）· 剖面 {corr:.3f} · "
                f"轮廓宽 25/50/75% 基准 {w25:.2f}/{w50:.2f}/{w75:.2f} vs 候选 {c25:.2f}/{c50:.2f}/{c75:.2f} · "
                f"半透明软边 {soft:.1f}%")
        rows.append((f"{key}  vs  {ref}", bi, ci, note))

        if key.startswith("m-"):
            ed = eye_band_diff(bi, ci)
            if ed:
                if not eye_rows:
                    print("\n" + eye_header)
                print(f"{key:<10}{ed['inside_mean']:>8.4f}{ed['outside_mean']:>8.4f}"
                      f"{ed['outside_p99']:>9.4f}{ed['outside_hot']:>9.2f}%")
                eye_rows.append((key, ed))

    name = "_qa-classic.png" if args.classic else "_qa-frames.png"
    title = "经典皮肤候选 vs 现有帧（最近邻）" if args.classic else "候选帧 vs 运行时基准帧"
    sub = ("最近邻缩放，看像素颗粒/头身比/脚底基线是否一致" if args.classic
           else "左起：基准 192 → 候选 192 → 96px 浅底 → 96px 深底；软边% 越小抠图越干净")
    print("\nsheet:", sheet(rows, os.path.join(args.out, name), title, sub, classic=args.classic))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
