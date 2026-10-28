"""把「生成出来的新表情图」接进插件素材表。

用法（在插件根目录）：

    python tools/ingest-generated.py _incoming
    python tools/ingest-generated.py _incoming --dry-run

约定：**文件名去掉扩展名就是精灵 key**。例如 `_incoming/q-laugh.png` → key `q-laugh`。
每张图按与 build-assets.py 完全相同的管线处理（白底洪水填充 → 羽化 → 去白溢色 →
收 bbox → 预乘 LANCZOS 缩放 → WebP），因此接进来的图与现有 7 张同源同规格。

产出：
  - `assets/<key>.webp`
  - 合并进 `assets/art.json`（保留已有条目，覆盖同名 key）

接完之后记得内联进客户端：

    node tools/embed-art.mjs

再跑一次测试确认素材表断言没坏：

    node --test test/client.test.mjs
"""
import argparse
import base64
import importlib.util
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SUPPORTED = (".png", ".jpg", ".jpeg", ".webp")


def load_pipeline():
    """按文件路径加载 build-assets.py（文件名带连字符，不能直接 import）。"""
    path = os.path.join(HERE, "build-assets.py")
    spec = importlib.util.spec_from_file_location("build_assets", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def matte(ba, source: str, height: int, bust: bool = False) -> np.ndarray:
    """一张白底图 → 目标高度的 RGBA。

    bust=True 时在缩放前裁成「头顶→胸口」的头肩像，用来把成熟版那批
    构图不一的表情（有的抱手半身、有的特写）统一成同一种取景。
    """
    with Image.open(source) as im:
        rgb = np.asarray(im.convert("RGB")).copy()
    alpha = ba.background_alpha(Image.fromarray(rgb))
    alpha = ba.feather(alpha)
    rgb = ba.despill_white(rgb, alpha)
    rgb, alpha = ba.crop_to_content(rgb, alpha)
    if bust:
        rgb, alpha, _window = ba.bust_crop(rgb, alpha)
    rgba = np.dstack([rgb, alpha])
    return ba.resize_premultiplied(rgba, height)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="把生成的新表情接进素材表")
    parser.add_argument("drop", nargs="?", default=os.path.join(ROOT, "_incoming"),
                        help="放生成图的目录（默认 _incoming）")
    parser.add_argument("--height", type=int, default=192, help="导出高度（默认 192）")
    parser.add_argument("--art", default=os.path.join(ROOT, "assets", "art.json"))
    parser.add_argument("--out", default=os.path.join(ROOT, "assets"))
    parser.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    parser.add_argument("--bust", action="store_true", help="裁成头肩像（成熟版表情集构图不一，必须先统一）")
    args = parser.parse_args(argv)

    if not os.path.isdir(args.drop):
        print(f"目录不存在：{args.drop}")
        print("先建一个 `_incoming/`，把生成的 PNG 丢进去（文件名就是 key）。")
        return 2

    files = sorted(
        name for name in os.listdir(args.drop)
        if os.path.splitext(name)[1].lower() in SUPPORTED
    )
    if not files:
        print(f"{args.drop} 里没有图片（支持 {'/'.join(SUPPORTED)}）")
        return 2

    ba = load_pipeline()
    os.makedirs(args.out, exist_ok=True)
    sprites = {}
    if os.path.exists(args.art):
        with open(args.art, encoding="utf-8") as fh:
            sprites = (json.load(fh) or {}).get("sprites", {})

    total = 0
    for name in files:
        key = os.path.splitext(name)[0]
        source = os.path.join(args.drop, name)
        rgba = matte(ba, source, args.height, bust=args.bust)
        webp = ba.encode_webp(Image.fromarray(rgba, "RGBA"))
        h, w = rgba.shape[0], rgba.shape[1]
        total += len(webp)
        print(f"  {key:<14} {w}x{h}  {len(webp):>6,} B  ← {name}")
        if args.dry_run:
            continue
        with open(os.path.join(args.out, f"{key}.webp"), "wb") as fh:
            fh.write(webp)
        sprites[key] = {
            "source": f"generated:{name}",
            "w": w,
            "h": h,
            "bytes": len(webp),
            "uri": "data:image/webp;base64," + base64.b64encode(webp).decode("ascii"),
        }

    if args.dry_run:
        print(f"\n[dry-run] {len(files)} 张，合计 {total:,} B；未写入任何文件")
        return 0

    payload = {"generatedAt": "ingested", "sprites": sprites}
    with open(args.art, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    try:
        shown = os.path.relpath(args.art, ROOT)
    except ValueError:  # Windows 跨盘符无法求相对路径
        shown = args.art
    print(f"\n已合并 {len(files)} 张进 {shown}（现有 {len(sprites)} 个 key）")
    print("下一步： node tools/embed-art.mjs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
