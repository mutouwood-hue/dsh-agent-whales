#!/usr/bin/env python3
"""重建旧版办公室素材（鲸鱼娘坐姿帧与配套家具）。

用法：python tools/build-office.py <源图目录> [--qa <质检输出目录>]

源图目录里放 1024x1024 的 PNG，文件名就是 Notion 第二期 PRD 里的逐帧文件名：
  o-sit-idle.png、o-sit-type-1.png …（坐姿 12 帧）
  o-desk.png、o-chair.png、o-plant.png、o-shelf.png（纯白底，要抠）
  o-floor-tile.png、o-wall.png（整张不透明，只缩放）
源图每张约 1MB，不进仓库，只进 Notion。

产出（key = 文件名去掉 .webp）：
  o-sit-<姿势>      坐姿横条。成对的循环帧拼成一条，浏览器用 steps() 翻帧
  o-station-back    工位底层：办公椅（座面对齐人物臀部）
  o-station-front   工位顶层：只取桌子的前半截（桌沿、花边桌布、抽屉、桌腿）
  o-plant / o-shelf 装饰
  o-floor / o-wall  地砖（可平铺）/ 墙（横向平铺）

为什么这样做：
  - 抠白底、羽化、去白边、预乘缩放，全部复用 tools/build-assets.py 里已验收的函数，不另写一套；
  - 同一批坐姿帧用「同一个裁切框 + 同一个缩放」，循环动画才不抖；
  - 家具按「与坐姿帧同一个像素比例」缩放，椅子和桌子的对位在这里算好，页面只负责叠三层：
    椅子 → 人 → 桌子前半截。桌子整张带显示器，会把坐着的人挡住，所以只取桌沿以下；
    人的腿从花边桌布下面露出来，与简报「桌面盖住膝盖以下」的约定一致；
  - 不去地面阴影：这批图本来就没有地面。
manifest.json 是宿主路由的白名单（运行时不扫目录）；frames 是横条里的帧数，w/h 是整条的尺寸；
layout 保留旧版工位的对位数据。
"""
import argparse
import importlib.util
import json
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "assets", "office")
HEIGHT = 336  # 坐姿单帧高度（像素）。页面按 0.5 倍显示（168px 高），留 2 倍给高分屏。

# 姿势 → 源帧（顺序即翻帧顺序）。key = "o-sit-" + 姿势。
POSES = {
    "idle": ["o-sit-idle"],
    "type": ["o-sit-type-1", "o-sit-type-2"],
    "wait": ["o-sit-wait-1", "o-sit-wait-2"],
    "sleep": ["o-sit-sleep"],
    "read": ["o-sit-read"],
    "run": ["o-sit-run-1", "o-sit-run-2"],
    "think": ["o-sit-think"],
    "done": ["o-sit-done"],
    "oops": ["o-sit-oops"],
}

# 站立与行走（key = "o-" + 名字）。侧面帧画的是面朝画面左，向右走由页面水平镜像。
# 只做页面用到的一条：空闲的成员离开椅子，在自己桌前来回踱步（侧面行走两帧循环，向右走时页面水平镜像）。
# 站立正面（o-stand-front）只当「头宽」的参照，用来把站着的人缩放到和坐着的同一个大小，不进包。
# 正面 / 背面行走（o-walk-front-*、o-walk-back-*）已出图，等「在整个地板上自由走动」时才用得到，现在不进包。
WALKS = {
    "walk-side": ["o-walk-side-1", "o-walk-side-2"],
}
WALK_SCALE_REF = "o-stand-front"

# 工位对位，数值是「坐姿帧高 240」时的基准，按 HEIGHT/240 等比放大。原型里肉眼定的（见 Notion 第二期 PRD 3.2）。
REF = 240.0
STATION_W, STATION_H = 260, 330   # 工位画布
GIRL_Y = 70                        # 人物帧顶部在工位画布里的位置（给头顶的徽标和椅背留空）
HIP = 160                          # 人物臀部相对帧顶部的位置
DESK_OFFSET = 150                  # 桌沿相对帧顶部的位置：手刚好搭在桌沿上
DESK_LIP_SRC = 526                 # 桌子源图（1024 画布）从这一行往下取：以上是显示器和桌面摆件
CHAIR_MUL = 0.95                   # 椅子相对人物比例的缩放
CHAIR_SEAT = 0.62                  # 椅子源图里座面中心在椅子高度的位置

PLANT_H, SHELF_H = 192, 300        # 装饰件高度（像素，2 倍图）
FLOOR_PX, WALL_PX = 256, 512       # 地砖与墙的边长（像素）


def load_matting():
    spec = importlib.util.spec_from_file_location("build_assets", os.path.join(HERE, "build-assets.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def matte(ba, path):
    """整张画布抠白底，不裁切：返回 (rgb, alpha)。"""
    with Image.open(path) as im:
        im = im.convert("RGB")
        rgb = np.asarray(im).copy()
        alpha = ba.background_alpha(im)
    alpha = ba.feather(alpha)
    alpha = ba.refine_edge_alpha(rgb, alpha)
    rgb = ba.despill_white(rgb, alpha)
    return rgb, alpha


def content_box(alpha):
    ys, xs = np.nonzero(alpha > 8)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def head_width(alpha):
    """头宽：内容框最上面四分之一那几行的水平跨度。用来把站着和坐着的同一个人对齐到同一个大小。"""
    x0, y0, x1, y1 = content_box(alpha)
    band = alpha[y0:y0 + max(1, (y1 - y0) // 4)] > 8
    cols = np.nonzero(band.any(axis=0))[0]
    return int(cols.max() - cols.min())


def furniture(ba, src, name, top=None):
    """抠出一件家具，裁到内容框（可指定从哪一行往下取），返回 RGBA 的 PIL 图（原始分辨率）。"""
    rgb, alpha = matte(ba, os.path.join(src, name + ".png"))
    x0, y0, x1, y1 = content_box(alpha)
    if top is not None:
        y0 = max(y0, top)
    rgba = np.dstack([rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]])
    return Image.fromarray(rgba, "RGBA")


def scaled(ba, img, factor):
    """按倍数缩放（预乘空间，不出黑边）。"""
    arr = np.asarray(img)
    height = max(1, round(arr.shape[0] * factor))
    return Image.fromarray(ba.resize_premultiplied(arr, height), "RGBA")


def to_height(ba, img, height):
    return Image.fromarray(ba.resize_premultiplied(np.asarray(img), height), "RGBA")


def save(ba, img, key, keys, frames=1):
    path = os.path.join(OUT_DIR, key + ".webp")
    with open(path, "wb") as handle:
        handle.write(ba.encode_webp(img))
    keys[key] = {"w": img.width, "h": img.height, "bytes": os.path.getsize(path), "frames": frames}
    print(f"  {key}: {img.width}x{img.height}, {frames} 帧, {keys[key]['bytes']} 字节")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("src", help="源图目录")
    parser.add_argument("--qa", help="质检输出目录（联系表，不进仓库）")
    args = parser.parse_args()

    ba = load_matting()
    frames = {}
    for names in POSES.values():
        for name in names:
            path = os.path.join(args.src, name + ".png")
            if not os.path.isfile(path):
                raise SystemExit("缺源图：" + path)
            frames[name] = matte(ba, path)

    # 全部坐姿帧的并集包围盒（alpha>8 才算内容，滤掉羽化残点），四周留 6px。
    top = left = 10 ** 9
    bottom = right = -1
    for _, alpha in frames.values():
        x0, y0, x1, y1 = content_box(alpha)
        top, bottom = min(top, y0), max(bottom, y1)
        left, right = min(left, x0), max(right, x1)
    pad = 6
    h, w = next(iter(frames.values()))[1].shape
    top, left = max(0, top - pad), max(0, left - pad)
    bottom, right = min(h, bottom + pad), min(w, right + pad)
    print(f"并集框 x{left}-{right} y{top}-{bottom}（画布 {w}x{h}）")
    scale = HEIGHT / float(bottom - top)  # 坐姿帧的像素比例：家具与它用同一个

    os.makedirs(OUT_DIR, exist_ok=True)
    for old in os.listdir(OUT_DIR):
        if old.endswith(".webp"):
            os.remove(os.path.join(OUT_DIR, old))

    keys = {}
    sheet_items = []
    frame_w = None
    for pose, names in POSES.items():
        cells = []
        for name in names:
            rgb, alpha = frames[name]
            rgba = np.dstack([rgb[top:bottom, left:right], alpha[top:bottom, left:right]])
            cells.append(Image.fromarray(ba.resize_premultiplied(rgba, HEIGHT), "RGBA"))
        frame_w = cells[0].width
        strip = Image.new("RGBA", (sum(c.width for c in cells), HEIGHT), (0, 0, 0, 0))
        x = 0
        for cell in cells:
            strip.paste(cell, (x, 0))
            x += cell.width
        save(ba, strip, "o-sit-" + pose, keys, len(cells))
        sheet_items.append(("o-sit-" + pose, strip))

    # —— 站立与行走：与坐姿同一个人，按「头宽」对齐比例（站着的人比坐着的高，不能按身高对齐，否则头会变大变小）——
    walk_frames = {}
    for names in WALKS.values():
        for name in names:
            path = os.path.join(args.src, name + ".png")
            if not os.path.isfile(path):
                raise SystemExit("缺源图：" + path)
            walk_frames[name] = matte(ba, path)
    w_top = w_left = 10 ** 9
    w_bottom = w_right = -1
    for _, alpha in walk_frames.values():
        x0, y0, x1, y1 = content_box(alpha)
        w_top, w_bottom = min(w_top, y0), max(w_bottom, y1)
        w_left, w_right = min(w_left, x0), max(w_right, x1)
    w_top, w_left = max(0, w_top - pad), max(0, w_left - pad)
    w_bottom, w_right = min(h, w_bottom + pad), min(w, w_right + pad)
    ref_path = os.path.join(args.src, WALK_SCALE_REF + ".png")
    if not os.path.isfile(ref_path):
        raise SystemExit("缺源图：" + ref_path)
    sit_head = head_width(frames["o-sit-idle"][1])
    stand_head = head_width(matte(ba, ref_path)[1])
    walk_scale = scale * sit_head / float(stand_head)
    walk_h = round((w_bottom - w_top) * walk_scale)
    print(f"站立并集框 x{w_left}-{w_right} y{w_top}-{w_bottom}；头宽 坐 {sit_head} / 站 {stand_head}；比例 {walk_scale:.4f}（坐姿 {scale:.4f}）")
    walker_w = None
    for key, names in WALKS.items():
        cells = []
        for name in names:
            rgb, alpha = walk_frames[name]
            rgba = np.dstack([rgb[w_top:w_bottom, w_left:w_right], alpha[w_top:w_bottom, w_left:w_right]])
            cells.append(Image.fromarray(ba.resize_premultiplied(rgba, walk_h), "RGBA"))
        walker_w = cells[0].width
        strip = Image.new("RGBA", (sum(c.width for c in cells), walk_h), (0, 0, 0, 0))
        x = 0
        for cell in cells:
            strip.paste(cell, (x, 0))
            x += cell.width
        save(ba, strip, "o-" + key, keys, len(cells))
        sheet_items.append(("o-" + key, strip))

    # —— 工位：椅子（底层）与桌子前半截（顶层），同一张画布，页面把「椅子 → 人 → 桌子」叠起来 ——
    f = HEIGHT / REF
    sw, sh = round(STATION_W * f), round(STATION_H * f)
    gx, gy = (sw - frame_w) // 2, round(GIRL_Y * f)
    chair = scaled(ba, furniture(ba, args.src, "o-chair"), scale * CHAIR_MUL)
    desk = scaled(ba, furniture(ba, args.src, "o-desk", top=DESK_LIP_SRC), scale)
    back = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    seat_y = round(gy + HIP * f - CHAIR_SEAT * chair.height)
    back.alpha_composite(chair, ((sw - chair.width) // 2, seat_y))
    front = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    front.alpha_composite(desk, ((sw - desk.width) // 2, gy + round(DESK_OFFSET * f)))
    save(ba, back, "o-station-back", keys)
    save(ba, front, "o-station-front", keys)

    # —— 装饰与地面 ——
    save(ba, to_height(ba, furniture(ba, args.src, "o-plant"), PLANT_H), "o-plant", keys)
    save(ba, to_height(ba, furniture(ba, args.src, "o-shelf"), SHELF_H), "o-shelf", keys)
    for name, key, edge in (("o-floor-tile", "o-floor", FLOOR_PX), ("o-wall", "o-wall", WALL_PX)):
        with Image.open(os.path.join(args.src, name + ".png")) as im:
            tile = im.convert("RGB").resize((edge, edge), Image.LANCZOS).convert("RGBA")
        save(ba, tile, key, keys)

    layout = {
        "frame": {"w": frame_w, "h": HEIGHT},
        "walker": {"w": walker_w, "h": walk_h},
        "station": {"w": sw, "h": sh, "girlX": gx, "girlY": gy},
    }
    # 工作室场景是独立素材，重建旧的姿势帧时仍把它们写入白名单。
    for name in os.listdir(OUT_DIR):
        if not name.startswith("o-studio-") or not name.endswith(".webp"):
            continue
        path = os.path.join(OUT_DIR, name)
        with Image.open(path) as im:
            keys[name[:-5]] = {"bytes": os.path.getsize(path), "frames": 1, "w": im.width, "h": im.height}
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump({"version": 1, "keys": keys, "layout": layout}, handle, ensure_ascii=False, indent=1, sort_keys=True)
        handle.write("\n")
    print("layout:", json.dumps(layout))

    if args.qa:
        os.makedirs(args.qa, exist_ok=True)
        grounds = [("white", (255, 255, 255)), ("dark", (0x11, 0x13, 0x18)), ("brand", (0x3B, 0x55, 0xF0))]
        for label, color in grounds:
            sheet = Image.new("RGB", (frame_w * 2 + 8, (HEIGHT + 8) * len(sheet_items)), color)
            for row, (_, strip) in enumerate(sheet_items):
                sheet.paste(strip, (0, row * (HEIGHT + 8)), strip)
            sheet.save(os.path.join(args.qa, f"contact-{label}.png"))
        print("质检联系表 →", args.qa)


if __name__ == "__main__":
    main()
