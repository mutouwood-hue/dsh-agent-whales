"""经典皮肤（像素小人）候选帧的接入处理。

与 `ingest-generated.py` 的区别，全在「像素风」这三个字上：

1. **不羽化、不去溢色**：像素画是硬边，羽化会糊边；白边也不该柔化。
2. **白底转透明用 flood fill 哨兵色**（不是亮度阈值）：白衬衫、眼白这些「内部白色」
   不能被抠掉，只有从画布四角连通的白色才算背景。
3. **缩放用最近邻**：LANCZOS 会把像素颗粒插值成糊块（PRD §35.11.5 明确要求 NEAREST）。
4. **不裁到内容后重排**：裁 bbox 保证脚底基线一致（所有帧 bottom 对齐）。

用法：
  python tools/ingest-classic.py _scratch/candidates/classic \
      --art _scratch/candidates/art-classic.json --out _scratch/candidates/classic-out
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPPORTED = (".png", ".jpg", ".jpeg", ".webp")
SENTINEL = (255, 0, 255)


def knockout_white(path: str, tol: int = 30) -> tuple[np.ndarray, np.ndarray]:
    """从四角 + 四边中点 flood fill 掉连通背景；返回 (rgb, alpha)。内部白色（衬衫/眼白）保留。

    为什么默认 tol=30 且要 8 个种子：AI 生成的「白底」实测常带一条 220~230 的浅灰渐变带
    （底部最常见，像是给它加了个「台面」）。只用 4 个角、tol=12 时，这条带子没被吃掉，
    会把内容 bbox 撑到接近整幅画布（实测 c-done 从 570 宽虚增到 963 宽）。
    """
    with Image.open(path) as im:
        rgb_img = im.convert("RGB")
    probe = rgb_img.copy()
    w, h = probe.size
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for seed in seeds:
        if probe.getpixel(seed) != SENTINEL:
            ImageDraw.floodfill(probe, seed, SENTINEL, thresh=tol)
    arr = np.asarray(probe)
    bg = np.all(np.abs(arr.astype(np.int16) - np.array(SENTINEL, dtype=np.int16)) == 0, axis=2)
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    rgb = np.asarray(rgb_img).copy()
    return rgb, alpha


def crop_to_content(rgb, alpha):
    ys, xs = np.nonzero(alpha > 0)
    if len(ys) == 0:
        return rgb, alpha
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]


def resize_nearest(rgba, height: int):
    img = Image.fromarray(rgba, "RGBA")
    w = max(1, round(img.width * height / img.height))
    return img.resize((w, height), Image.NEAREST)


def encode(img, quality=95):
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=quality, method=6)
    return buf.getvalue()


def alpha_bbox(img: Image.Image):
    a = np.asarray(img)[:, :, 3]
    ys, xs = np.nonzero(a > 0)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def align_to_reference(img: Image.Image, ref: Image.Image) -> Image.Image:
    """把帧对齐到参考帧的**画布几何**：同画布尺寸、同「内容高度占画布」比例、同脚底基线、同水平中心。

    为什么必须做：现有 c-idle / c-work 的 webp 是 177×192 的画布，但**可见内容只有 101×170**
    （四周带透明留白）；而新生成的候选是紧裁到内容的。直接把两者都按「高 192」丢进轮换，
    新帧会凭空放大 13%，脚底基线也对不上——这正是 PRD §35.11.5 第 1 条要求「统一画布 + 头部大小 +
    脚底基线 + 主体占比」的原因。缩放用最近邻，避免像素被插值糊掉。
    """
    rb = alpha_bbox(ref)
    cb = alpha_bbox(img)
    if rb is None or cb is None:
        return img
    ref_w, ref_h = ref.size
    ref_cw, ref_ch = rb[2] - rb[0], rb[3] - rb[1]
    cand_cw, cand_ch = cb[2] - cb[0], cb[3] - cb[1]
    scale = ref_ch / cand_ch
    new_w, new_h = max(1, round(cand_cw * scale)), max(1, round(cand_ch * scale))
    content = img.crop(cb).resize((new_w, new_h), Image.NEAREST)

    canvas = Image.new("RGBA", (ref_w, ref_h), (0, 0, 0, 0))
    # 水平：与参考内容中心对齐；垂直：脚底基线对齐
    x = round((rb[0] + rb[2]) / 2 - new_w / 2)
    y = rb[3] - new_h
    canvas.alpha_composite(content, (x, y))
    return canvas


def main() -> int:
    parser_help = "经典像素皮肤候选帧接入"
    ap = argparse.ArgumentParser(description=parser_help)
    ap.add_argument("drop")
    ap.add_argument("--art", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--height", type=int, default=192)
    ap.add_argument("--quality", type=int, default=95)
    ap.add_argument("--tol", type=int, default=30, help="白底 flood fill 容差（AI 图常带浅灰渐变带，默认 30）")
    ap.add_argument("--align-to", default=None,
                    help="参考帧的 art.json 路径（如 assets/art.json）+ 冒号 + key，例如 "
                         "assets/art.json:c-idle —— 把画布尺寸/内容高度/脚底基线/水平中心对齐到该帧")
    args = ap.parse_args()

    ref_img = None
    if args.align_to:
        ref_art, _, ref_key = args.align_to.rpartition(":")
        ref_sprites = (json.load(open(ref_art, encoding="utf-8")) or {}).get("sprites", {})
        entry = ref_sprites.get(ref_key)
        if not entry:
            print(f"--align-to 找不到参考帧：{args.align_to}")
            return 2
        raw = base64.b64decode(entry["uri"].split(";base64,", 1)[1])
        ref_img = Image.open(io.BytesIO(raw)).convert("RGBA")
        print(f"对齐参考：{ref_key} {ref_img.size}，内容 bbox {alpha_bbox(ref_img)}")

    files = sorted(n for n in os.listdir(args.drop) if os.path.splitext(n)[1].lower() in SUPPORTED)
    if not files:
        print(f"{args.drop} 里没有图片")
        return 2
    os.makedirs(args.out, exist_ok=True)
    art_path = args.art
    sprites = {}
    if os.path.exists(art_path):
        sprites = (json.load(open(art_path, encoding="utf-8")) or {}).get("sprites", {})

    print(f"{'key':<12}{'原图':<14}{'内容bbox':<12}{'导出':<10}{'字节':>8}{'可见色数':>8}")
    for name in files:
        key = os.path.splitext(name)[0]
        src = os.path.join(args.drop, name)
        rgb, alpha = knockout_white(src, tol=args.tol)
        rgb, alpha = crop_to_content(rgb, alpha)
        rgba = np.dstack([rgb, alpha])
        img = resize_nearest(rgba, args.height)
        if ref_img is not None:
            img = align_to_reference(img, ref_img)
        data = encode(img, args.quality)
        with Image.open(src) as im:
            dims = f"{im.width}x{im.height}"
        visible = np.asarray(img)[:, :, 3] > 0
        colors = len(np.unique(np.asarray(img)[:, :, :3][visible].reshape(-1, 3), axis=0))
        print(f"{key:<12}{dims:<14}{f'{rgba.shape[1]}x{rgba.shape[0]}':<12}"
              f"{f'{img.width}x{img.height}':<10}{len(data):>8,}{colors:>8}")
        path = os.path.join(args.out, f"{key}.webp")
        img.save(path, "WEBP", quality=args.quality, method=6)
        sprites[key] = {
            "source": f"AI 衍生候选 ← Martty/Liang（{os.path.basename(name)}）",
            "w": img.width,
            "h": img.height,
            "bytes": len(data),
            "uri": "data:image/webp;base64," + base64.b64encode(data).decode("ascii"),
        }

    json.dump({"sprites": {**sprites}}, open(art_path, "w", encoding="utf-8"), ensure_ascii=False, indent="\t")
    print(f"\n已写出 {len(sprites)} 张 → {args.out}，素材表 → {art_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
