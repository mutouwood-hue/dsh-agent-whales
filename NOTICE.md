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
- **2026-10-30 返工帧**（`q-laugh` / `q-pout` / `m-blink` / `m-pout` / `m-proud`）：以上游 C12 / C13 作
  参考图**重新图生图**生成，用来修正原帧取景不一致（半身/到腰 vs 全身/头肩）。这些帧**不是**上游原图，
  `assets/art.json` 的 `source` 字段已逐条标注。
- `q-surprise` 于同日**未重画**，只按同一条管线重抠并清掉脚下灰影（构图与表情不变）。
- **2026-10-30 新增帧**：`m-wave`（成熟版入场招手）、`q-shy` / `m-shy`（心情帧）——同一套 AI 生成流程
  （图生图参考 C12 / C13）。`m-wave` 取代了原先「成熟版入场只能回退 `m-base`」的做法。
- **2026-10-30 状态帧**（同日一并接入运行时）：`q-think` / `q-oops` / `q-heart` / `q-cry`（Q 版）、
  `m-think` / `m-oops`（成熟版）——图生图参考 C12 / C13；`c-think` / `c-oops` / `c-done`（经典皮肤）
  是基于 **Martty / Liang 形象**的 **AI 衍生帧**（不是 Martty 上游原始素材），已按 c-idle 的画布几何对齐。
  这 9 张的验收数据与接入记录见 PRD §35.14–§35.16。

再分发或二次修改时请保留以上署名，并说明图片为 AI 生成。
上游声明「不设定标准人设、欢迎变体」，因此素材与母图存在风格差异属预期。

## 办公室工作室

- 日夜工作室、小猫、金鱼娘和梁叔叔为 **OpenAI 图像生成工具生成的原创 3D 风格插画**。`assets/office/o-studio-*.webp` 为优化后的分发素材。

## 旧版办公室角色（鲸鱼娘坐姿帧）

- 角色：与上面「角色素材」同一个鲸鱼娘形象（参考 C12 站立正面图），办公室里的坐姿、打字、举手、睡觉等 9 组动作
- 来源：**由 Notion AI 图像工具生成**（模型名称未提供），需求与逐帧要求见 Notion「dsh-agent-whales 第二期 PRD」第二节
- 这些图片均为 **AI 生成**；再分发或二次修改时请保留这一说明
- 加工：`tools/build-office.py` 抠白底、去白边、按同一个裁切框缩放，并把成对的循环帧拼成横条（`assets/office/o-sit-*.webp`）；**没有改动形象本身**
- 成员之间的区分由页面用色相旋转完成，不是另外出图
- 源图（1024×1024 PNG，每张约 1MB）不进仓库，保存在 Notion 该页
- 此前的 MetroCity（jik-a-4，CC0）原型素材已被替换，不再随包分发

## 图标

`icon.svg` 为本插件自绘，随插件一同分发。

## show_view 视图卡片（拷自 deep-view / DS Bot）

- 来源：**deep-view 0.1.2**（<https://github.com/Fei2411/deep-view>，Apache License 2.0），其视图组件与共享核心又移植自 **DS Bot**（<https://github.com/Fei2411/DS-Bot>，同为 Apache-2.0）
- 拷入范围：
  - `lib/view/`（视图校验、公式引擎、回答协议、工具 schema）——**宿主与浏览器两半共用同一份**
  - `tools/flow-chunk/view/react/`（图表、表格、输入、选项 / 确认 / 表单、沙箱 HTML 的渲染层），构建后进入 `lib/client.view.js`
- 拷入日期：2026-11-18。**此后在本仓库内独立迭代**，与上游不再同步；每个被拷文件头部保留了出处与「已拷入、之后在此维护」的说明
- 本仓库做过的改动（相对上游）：
  - `tools/flow-chunk/view/react/ui.js`：`useSyncExternalStore` 补第三个参数（服务端快照），否则 `react-dom/server` 渲染选项卡会抛错
  - 宿主侧（`lib/view-host.js`）是**重写**的，不是拷贝：卡片落盘 / 作答 / 作废、工具参数展开成完整 JSON Schema、判根改用 `subagents.rootOf`（上游的 `agents.roots()` 是旧宿主 API，在本宿主上不存在）
  - 视图节点的外壳与样式（`tools/flow-chunk/view/entry.jsx`）是本仓库自写，跟随画布主题
- 许可证全文随包分发：`lib/view/LICENSE-deep-view`（Apache-2.0；再分发需保留该许可证与本节署名）
- 侧聊（`lib/view-host.js` 的 `createSideService` 与 `SideNode`）的**思路**参考 DS Bot 的 `/side`（对话快照 + 不调工具 + 不写回原对话），代码为自写，未拷贝其实现

## 经典皮肤（像素小人）

- 形象：**Martty** 的内置宠物 Liang（`liang-idle.png`、`liang-working.png`）
- 来源：**openma-ai/Martty**（MIT License）
- 用法：等比缩放到 192px 高后转成 WebP（key `c-idle` / `c-work` 等），**未改动形象本身**
- 原图自带透明通道，未做抠图
- 这两张上游 PNG **随本仓库分发在 `assets/pet/`**（MIT，署名见本节），它们是 `c-idle` / `c-work`
  的唯一源；复现方式与当前工具链的缺口见 `assets/pet/README.md`，成品可核对点是
  `assets/art.json` 里 `c-idle` / `c-work` 的 `source: Martty:liang-*.png`，以及随包分发的
  `assets/c-idle.webp` / `assets/c-work.webp`（**不再内联进 `lib/client.js`**：D1 起素材由宿主路由按皮肤提供）。

## 按名字引用的官方包（默认层）

`cordis.patch.yml`（默认生效）只对官方 `agent-team` 行做一次 id 覆盖（`defaultEnabled: true`），
不插入、不按包名引用任何官方包；团队相关包（`@deepseek-ai/dsh-agent-team` 等）由 DSH 自己的
`dsh-base` / `dsh-web-app` bundle 挂载，版权归 DeepSeek，MIT License，**随 DSH 运行时分发，不随本包分发**。
（2026-11-17 之前的版本曾按名字插入 `@deepseek-ai/dsh-experimental-*` 三个包，已随宿主迁移移除。）

