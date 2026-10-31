"""生成「补图交接口」用的风格锚点图（只依赖 Pillow，不需要 numpy）。

为什么单独一个脚本：`build-assets.py` 需要 numpy（洪水填充抠图），而交接图只是
把现成精灵拼起来 + 加中文标注，不该让画师/模型那边为了生成一张图去装 numpy。

用法：
    python tools/contact-sheet.py                 # 输出到 _scratch/sheets/
    python tools/contact-sheet.py --out D:\\some\\dir

产出三张：
    _sheet-q.png         Q 版全身 8 张（浅底 / 深底两列）
    _sheet-m.png         成熟版头肩 6 张
    _sheet-classic.png   经典皮肤 2 帧

每张都带：中文语义 + 精灵 key + 实际像素尺寸；表头写清该组的构图与授权约定。
"""
from __future__ import annotations

import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

LIGHT = (245, 246, 250)
DARK = (20, 22, 28)
INK = (24, 26, 32)
MUTED = (110, 115, 125)
RULE = (226, 228, 234)

FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


def font(size: int, bold: bool = False):
    path = FONT_BOLD if bold else FONT_PATH
    try:
        return ImageFont.truetype(path, size)
    except OSError:  # 非 Windows 或精简系统
        return ImageFont.load_default(size=size)


# key -> (中文语义, 什么时候出现)
MEANING = {
    "q-smile": ("微笑 · 常态", "默认形象"),
    "q-blink": ("眨眼", "随机眨眼帧"),
    "q-wave": ("挥手打招呼", "刚开工 / 被点开"),
    "q-proud": ("得意", "退场 / 完成"),
    "q-sleepy": ("打瞌睡抱膝", "收工后挂着"),
    "q-laugh": ("大笑", "心情帧轮换"),
    "q-pout": ("鼓脸不满", "心情帧轮换"),
    "q-surprise": ("惊讶", "心情帧轮换"),
    "m-base": ("微笑 · 常态", "Lead 默认"),
    "m-blink": ("眨眼", "Lead 随机眨眼"),
    "m-laugh": ("大笑", "心情帧轮换"),
    "m-pout": ("不满", "心情帧轮换"),
    "m-surprise": ("惊讶", "心情帧轮换"),
    "m-proud": ("得意", "Lead 退场 / 完成"),
    "c-idle": ("待命「嘘」", "经典皮肤 · 收工"),
    "c-work": ("抱着终端键盘", "经典皮肤 · 干活中"),
}

GROUPS = [
    (
        "q",
        "Q 版 · 全身（默认皮肤）",
        "9 张 / 全身完整入画（含鞋子与身后鲸尾）/ 纯白底抠图 / 高 192px / 约 2.5 头身",
        ["q-smile", "q-blink", "q-wave", "q-proud", "q-sleepy", "q-laugh", "q-pout", "q-surprise", "q-shy"],
        "补图要求：同一批 C10–C21 的构图与配色，**不要**改服装（黑白女仆装 + 蓝发）、不要改头身比、"
        "不要加文字/水印/分栏；背景纯白（便于走同一条抠图管线）。",
    ),
    (
        "m",
        "成熟版 · 头肩近景",
        "8 张 / 头肩构图（不是全身）/ 同批近景取景 / 高 192px",
        ["m-base", "m-blink", "m-laugh", "m-pout", "m-surprise", "m-proud", "m-wave", "m-shy"],
        "补图要求：这是**近景**，不要按全身画；头肩取景、视线平视、肩膀以上占满画面，"
        "与 C11/C13/C16/C18 同一取景（历史坑：拿全身图硬裁顶部 34% 会把脸切掉）。",
    ),
    (
        "classic",
        "经典皮肤 · 像素小人（Martty）",
        "2 帧 / 上游自带透明通道，未抠图 / 等比缩到高 192px / MIT",
        ["c-idle", "c-work"],
        "补图要求：像素风、透明底、单角色。新补帧必须按 `--align-to assets/art.json:c-idle` 对齐："
        "同画布 177×192、可见内容高 170、脚底基线一致（现有画布带透明留白，紧裁图直接投放会凭空放大 13%）。",
    ),
]


def load(key: str, art: dict) -> Image.Image:
    """优先读 assets/{key}.webp（便于人眼核对源文件）；c-* 这类只有内联 data URI 的，
    从 art.json 里解回来——art.json 是「真正进 bundle 的那份」，用它才不会画错。"""
    path = os.path.join(ASSETS, f"{key}.webp")
    if os.path.exists(path):
        return Image.open(path).convert("RGBA")
    entry = (art.get("sprites") or {}).get(key) or {}
    uri = entry.get("uri") or ""
    if uri.startswith("data:image/") and ";base64," in uri:
        import base64
        import io

        raw = base64.b64decode(uri.split(";base64,", 1)[1])
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    raise FileNotFoundError(f"{key}: 既没有 assets/{key}.webp，art.json 里也没有 data URI")


def wrap(d: ImageDraw.ImageDraw, text: str, f, max_w: int) -> list[str]:
    """按像素宽度折行（逐字，CJK 友好；拉丁词会被拆，但这里只有说明文字）。"""
    lines, cur = [], ""
    for ch in text:
        if d.textlength(cur + ch, font=f) <= max_w or not cur:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def build(group_key: str, title: str, spec: str, keys: list[str], note: str, out_dir: str, art: dict) -> str:
    imgs = [(k, load(k, art)) for k in keys]
    pad = 18
    label_w = 300
    cell_h = max(im.height for _, im in imgs) + pad * 2
    cell_w = max(im.width for _, im in imgs) + pad * 2
    header_h = 132
    sheet_w = label_w + 2 * cell_w + pad * 2

    # 先量出脚注要几行，再决定画布高度（否则长句会被裁掉右边缘）。
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    f_note = font(17)
    note_lines = wrap(probe, note.replace("**", ""), f_note, sheet_w - pad * 2)
    f_src = font(16)
    src = ("来源：AATINF/deepseek-whale-girl-assets（AI 生成 · 角色参考 TreapGoGo，MIT）／Martty（MIT）  ·  "
           "生成日期 2026-10-30  ·  精灵已内联进 lib/client.js")
    src_lines = wrap(probe, src, f_src, sheet_w - pad * 2)
    footer_h = 20 + len(note_lines) * 26 + len(src_lines) * 24 + 18
    sheet_h = header_h + len(imgs) * (cell_h + pad) + footer_h

    sheet = Image.new("RGB", (sheet_w, sheet_h), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    f_title = font(34, bold=True)
    f_spec = font(18)
    f_key = font(24, bold=True)
    f_meta = font(17)
    f_col = font(16)

    # header
    d.text((pad, 20), title, fill=INK, font=f_title)
    d.text((pad, 64), spec, fill=MUTED, font=f_spec)
    d.line([(pad, header_h - 14), (sheet_w - pad, header_h - 14)], fill=RULE, width=2)
    for i, name in enumerate(["浅底（编辑器默认）", "深底（暗色主题）"]):
        x = label_w + i * cell_w + pad
        d.text((x + 8, header_h - 44), name, fill=MUTED, font=f_col)

    # rows
    for row, (key, im) in enumerate(imgs):
        y = header_h + row * (cell_h + pad)
        cn, when = MEANING.get(key, ("", ""))
        d.text((pad, y + cell_h // 2 - 34), cn, fill=INK, font=f_key)
        d.text((pad, y + cell_h // 2 - 2), key, fill=MUTED, font=f_meta)
        d.text((pad, y + cell_h // 2 + 22), f"{im.width}×{im.height}", fill=MUTED, font=f_meta)
        d.text((pad, y + cell_h // 2 + 46), when, fill=MUTED, font=f_meta)

        for col, bg in enumerate([LIGHT, DARK]):
            x = label_w + col * cell_w
            tile = Image.new("RGBA", (cell_w, cell_h), bg + (255,))
            tile.alpha_composite(im, ((cell_w - im.width) // 2, (cell_h - im.height) // 2))
            sheet.paste(tile.convert("RGB"), (x, y))
            d.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=RULE)

    # footer
    fy = sheet_h - footer_h + 16
    d.line([(pad, fy - 12), (sheet_w - pad, fy - 12)], fill=RULE, width=2)
    for i, line in enumerate(note_lines):
        d.text((pad, fy + i * 26), line, fill=MUTED, font=f_note)
    sy = fy + len(note_lines) * 26 + 6
    for i, line in enumerate(src_lines):
        d.text((pad, sy + i * 24), line, fill=MUTED, font=f_src)

    path = os.path.join(out_dir, f"_sheet-{group_key}.png")
    sheet.save(path, "PNG", optimize=True)
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description="generate style-handoff contact sheets")
    ap.add_argument("--out", default=os.path.join(ROOT, "_scratch", "sheets"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    art = json.load(open(os.path.join(ASSETS, "art.json"), encoding="utf-8"))
    have = set((art.get("sprites") or {}).keys())
    for group_key, title, spec, keys, note in GROUPS:
        missing = [k for k in keys if k not in have]
        if missing:
            print(f"[skip] {group_key}: art.json 缺 {', '.join(missing)}")
            continue
        path = build(group_key, title, spec, keys, note, args.out, art)
        print(f"{os.path.basename(path)}  {Image.open(path).size[0]}x{Image.open(path).size[1]}  "
              f"{os.path.getsize(path) / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
