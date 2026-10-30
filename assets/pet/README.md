# assets/pet —— 经典皮肤（像素小人）的源图

这两张 PNG 是 `c-idle` / `c-work` 两个精灵的**唯一上游源**。之前它们只存在于开发机的
`_scratch/` 里（不入库），导致这两张图**在仓库里不可复现**——只有成品 WebP 躺在
`assets/` 里、以及一段内联在 `lib/client.js` 里的 data URI。现在把源图放进来，至少
"它长什么样 / 从来哪" 这件事是可核对的了。

| 文件 | 对应精灵 | 来源 |
|---|---|---|
| `liang-idle.png` | `c-idle`（收工 / 灰显，竖手指「嘘」） | [openma-ai/Martty](https://github.com/openma-ai/Martty) `assets/pet/liang-idle.png` |
| `liang-working.png` | `c-work`（干活中，抱着终端键盘） | 同上，`assets/pet/liang-working.png` |

原图 192×208、**RGBA 透明底**；产物是等比缩到 192 高、预乘 LANCZOS 重采样后编码的
WebP（各约 7.2–7.4KB）。

## 授权

Martty 仓库整体 **MIT**。这里只做**等比缩放 + 转 WebP**，未改动形象本身；原图自带
透明通道，**没有抠图**。署名与完整的素材分层说明见仓库根部 `NOTICE.md`。

## 复现：目前是**手工一步**，不是脚本

`tools/build-assets.py` 只处理 AATINF 素材包的**白底**图（它默认走白底洪水填充
`background_alpha()`，对已经带 alpha 的图会把不透明区域当背景处理）。所以这两张
**不能用它重建**，当时的做法是一次性的：

```
等比缩放到高 192
  → 预乘 alpha 的 LANCZOS 重采样（避免透明边缘发灰）
  → WebP 编码（quality ≈ 92, method 6, 保留 alpha）
  → 把 { source, w, h, bytes, uri } 合并进 assets/art.json
  → node tools/embed-art.mjs   # 内联进 lib/client.js
```

**这是一个已知的复现缺口**，处置建议（按性价比排序）：

1. 给 `build-assets.py` 加一个 `--alpha-passthrough`（或 `--pat`）入口：源图已带 alpha 时
   跳过 `background_alpha` / `despilled_white` / `remove_ground_shadow`，只走
   `resize_premultiplied` + `encode_webp`。这一步能同时修掉历史上「`--bust` 误裁近景图」
   那类问题的根因（工具不知道源图已经是成品构图）。
2. 在补上之前，以 `assets/art.json` 里的 `source` 字段 + `lib/client.js` 里对应 key 的
   data URI 作为**可核对的事实**，不要声称"一条命令可重建"。

## 为什么不随 npm 包发布

`package.json` 的 `files` 白名单**不含 `assets/`**：浏览器半边是单文件 bundle，全部精灵
已由 `tools/embed-art.mjs` 以 data URI 形式内联进 `lib/client.js`。`assets/` 只服务于
「重新生成素材」这条开发链路——它必须在仓库里，但不必进安装包。
