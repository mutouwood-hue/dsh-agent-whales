# 授权与署名

> 范围：`LICENSE`（MIT）覆盖本仓库的**代码**；角色素材的出处与署名要求见下面各节。

## 代码

本插件代码以 **MIT License** 发布，全文见 [LICENSE](LICENSE)，Copyright (c) 2026 mutouwood-hue。
可以自由使用、修改、分发与商用，保留版权声明即可。

## 角色素材

- 角色参考：**TreapGoGo/deepseek-whale-girl**（MIT License，Copyright (c) 2026 TreapGoGo）
- 素材来源：**AATINF/deepseek-whale-girl-assets**（在该角色参考之上扩展的二创素材包，93 张）
- 本插件使用的鲸鱼娘精灵图（Q 版 8 张 + 成熟版 6 张），是从上述素材包里按变体号挑出来，经抠白底、去溢色、裁切与压缩得到的
- 这 14 张的源文件随仓库提供（`assets/*.webp`，另见 `assets/art.json` 的 `source` 字段标注原始变体号）
- 这些图片均为 **AI 生成**（`wan2.7-image` 图生图）

再分发或二次修改时请保留以上署名，并说明图片为 AI 生成。
上游声明「不设定标准人设、欢迎变体」，因此素材与母图存在风格差异属预期。

## 图标

`icon.svg` 为本插件自绘，随插件一同分发。

## 经典皮肤（像素小人）

- 形象：**Martty** 的内置宠物 Liang（`liang-idle.png`、`liang-working.png`）
- 来源：**openma-ai/Martty**（MIT License）
- 用法：等比缩放到 192px 高后转成 WebP 内联（key `c-idle` / `c-work`），**未改动形象本身**
- 原图自带透明通道，未做抠图
- 这两张上游 PNG **随本仓库分发在 `assets/pet/`**（MIT，署名见本节），它们是 `c-idle` / `c-work`
  的唯一源；复现方式与当前工具链的缺口见 `assets/pet/README.md`，成品可核对点是
  `assets/art.json` 里 `c-idle` / `c-work` 的 `source: Martty:liang-*.png` 与内联在 `lib/client.js` 的 data URI。

## 随 bundle 插入的上游实验包（默认层）

`cordis.patch.yml`（默认生效）会按名字引用三个 DeepSeek 官方包：

- `@deepseek-ai/dsh-experimental-agent-team`
- `@deepseek-ai/dsh-experimental-tool-agent-team`
- `@deepseek-ai/dsh-experimental-client-ui-agent-team`

它们版权归 DeepSeek，MIT License，**随 DSH 运行时分发，不随本包分发**；本仓库只是在自己的
补丁里按名字引用，未复制其代码或素材。不想要这三行时按 README §关闭团队 / 回滚 在用户层关掉即可，
不需要（也不应该）修改本仓库。

