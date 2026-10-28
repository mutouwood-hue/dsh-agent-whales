# dsh-agent-whales

DeepSeek Harness Web UI 的「智能体鲸鱼」插件：**每多一个正在干活的智能体（Lead、teammate 或子 agent），页面顶端就多一只游动的鲸鱼娘**。
角色会轻轻浮动、偶尔眨眼、冒气泡；智能体一收工，对应的角色摆个得意的姿势沉下去消失。

形象来自社区二创「鲸鱼娘」素材（来源仓库 AATINF/deepseek-whale-girl-assets，角色参考 TreapGoGo/deepseek-whale-girl，MIT License，图片由 AI 生成）；
早期的手绘矢量鲸鱼作为「经典皮肤」保留，可随时切回。

插件分两半：

- **浏览器半边**（`lib/client.js`）：角色图层、家族树、任务行、气泡与设置页。
- **宿主半边**（`lib/index.js`）：向系统提示注册一段「团队协作（默认开启）」策略，让每个新会话默认先起团队。

## 效果

- 页面顶端（窗口标题栏下方）一排鲸鱼娘，数量 = 当前正在干活的智能体数。
- **Q 版**（默认）：全队统一用 Q 版全身，头大脸清、96px 也认得出来；想区分 Lead 可以在设置里切「混合」（Lead 成熟版头肩 + 成员 Q 版）。
- **家族树**：按会话父子关系排布。默认只露到第 1 层（Lead + 直接子），有下级的角色脚下带「+N」按钮，点开才展开它的子 agent；再点收回去。
- **已收工的子级会灰显留在原位**（不是消失），所以一个跑过一堆 subagent 的会话仍然看得出「谁是谁带出来的」；不想要可在设置里关掉。
- **任务行**：角色脚下显示任务板里挂在它名下的任务（进行中优先，最多两条）。Lead 额外接管**还没人认领**的团队任务。
- **头顶气泡**：显示这个角色当前在干的最新一件事——优先级是「名下进行中的任务 → **当前正在跑的工具**（在读文件 / 在跑命令…，宿主侧 `tools/execute` 采集）→ 俏皮话（按状态分池、8 秒轮换，≤5 字，可在设置里关）」。
- 生命周期：挥手入场（淡出成常态）→ 浮动 + 呼吸光晕 + 气泡 + 按角色错开节奏的眨眼 → 收工叉腰退场。
- 状态差异：`provisioning`（还在起）的角色换成抱膝坐姿并加头顶三点。
- 数量多时先线性缩小，超过 8 只收成「+N」。
- 整层 `pointer-events:none`，只有展开按钮与（开启可拖拽时的）角色本体可点，其余部分不遮挡按钮和输入框。
- 没有智能体在干活时，角色灰显**挂着**（可在设置里关掉，关掉即整层消失、不占位）。
- **可以拖**：按住任意一只拖到页面任意位置，位置按会话记住（刷新仍在）；**双击那一只**复位。父鱼被拖走时，它的小鱼会跟着走到右下方。
- **点一下**：有下级的角色**点开/收起**它的下级（点大的放出小的）；叶子节点单击才切到它的会话（teammate / 子 agent 走 addressed 子会话）。双击仍是复位位置。
- 页面切到后台时所有动画自动暂停。

## 计数口径

| 情况 | 是否算「正在干活」 | 依据 |
|---|---|---|
| Lead 会话 `running = true` | 算 | `useSessionStatus` → `byId[lead].running` 兜底 |
| teammate `phase = "active"` 且会话在跑 | 算 | `agentTeam.members[].phase` + 会话 running |
| teammate `phase = "provisioning"` | 算 | 正在起，属干活过程 |
| teammate `phase = "failed"` | 不算 | 鲸鱼沉了 |
| teammate 空闲（没在跑） | 不算 | — |
| 子 agent 会话 `running = true` | 算 | `byId` 行里的 `parentId` 把它挂到父角色下 |
| 子 agent 已收工 | 不算在「干活」，但灰显保留 | 关掉「已收工子级」后才会消失 |

数据来源全部是宿主已有的槽位能力。插件**不读别人的 DOM**，但会做两件自己的事：往 `document.head` 插一个 `<style>`（`ctx.effect` 负责回收），以及监听 `document.visibilitychange` 来暂停动画。

- `useSessions(sel)` — 全局座位（`client-ui-session` 的 `slots.provideRoot`），快照为
  `{ ids, byId, phase, projectionsBySession }`。
- `useSessionStatus(sel)` — 同一座位暴露的 `uiSession` 状态表（`Map: id → { running, ... }`），
  由 remote 事件 `api-session/status` 与列表基线驱动。**子智能体会话的列表行 `running` 不可信，故状态表优先。**
- `agentTeam` 投影 — Agent Teams 挂在 Lead 会话上的投影
  `projectionsBySession[leadId].values.agentTeam = { members, tasks, failure? }`。
- 当前会话若自己就是 teammate，会先经 `sessions.binding(id).session.subagent.address.parentSessionId`
  找到它的 Lead，再读该 Lead 的团队名册。

## 家族树、任务与气泡

三个能力都只用宿主已经送进浏览器的数据，没有新增 RPC、没有改宿主：

| 能力 | 数据来源 | 说明 |
|---|---|---|
| 父子关系 | `useSessions` 的 `byId[].parentId` | 宿主组装快照时已经算好；teammate 本身就是 Lead 的 continuable 子会话，所以「团队名册」天然就是树的第一层。`origin` 字段目前不参与判断。 |
| 子 agent | 沿 `parentId` 逐层 BFS（上限 12 个） | 在跑的亮显，已收工的灰显留档；名册里出现过的会话一律交给名册规则处理——failed 的成员不会被当成子 agent 又冒出来 |
| 任务行 | `projectionsBySession[lead].values.agentTeam.tasks`，按 `ownerName` 匹配成员名 | 只显示未删除的，进行中 → 待办 → 完成排序，最多两条；Lead 额外接管 `ownerName` 为空的任务 |
| 头顶气泡 | 同上取 `in_progress` 的 `subject`；回退 `byId[].title`；Lead 再回退团队里任意进行中的任务 | 客户端拿不到逐条工具调用级别的话术，所以不编造 |

展开状态放在模块级 store 里而不是组件 state：重渲染不掉状态，离线测试也能直接驱动。
默认只露出第 0、1 层；更深的层要有祖先被点开才出现，父子成环有步数上限兜底，
父会话已收工时子会话降级为根、不会凭空消失。

没有团队投影（profile 没开 Agent Teams）时退化为「当前会话自己」：这只 Lead 一干活就有一只鲸鱼娘，
它如果有 running 的子会话，子会话也会一起画出来。

## 形象与素材

16 张精灵图，全部 WebP + alpha，长边 192px（96px 显示的 2x 屏）：

| key | 来源变体 | 尺寸 | 字节 | 用在哪 |
|---|---|---|---|---|
| `q-smile` | C12 | 168×192 | 13,218 | Q 版常态 |
| `q-blink` | C19 | 169×192 | 13,166 | 眨眼帧（与 C12 同构图，可交叉淡变） |
| `q-wave` | C23 | 169×192 | 13,260 | 入场挥手帧 |
| `q-proud` | C21 | 161×192 | 12,638 | 退场得意帧 |
| `q-sleepy` | C27 | 175×192 | 13,002 | 起步中，抱膝坐姿 |
| `q-laugh` | C10 | 192×192 | 13,344 | Q 版心情帧（大笑） |
| `q-pout` | C15 | 192×192 | 13,604 | Q 版心情帧（鼓脸） |
| `q-surprise` | C17 | 169×192 | 13,458 | Q 版心情帧（惊讶） |
| `m-base` | C13 | 192×192 | 13,474 | Lead 常态（头肩近景） |
| `m-blink` | C20 | 192×192 | 14,464 | Lead 眨眼帧 |
| `m-laugh` | C11 | 192×192 | 12,942 | Lead 心情帧（大笑） |
| `m-pout` | C16 | 184×192 | 13,482 | Lead 心情帧（不满） |
| `m-surprise` | C18 | 192×192 | 12,942 | Lead 心情帧（惊讶） |
| `m-proud` | C83 | 189×192 | 13,888 | Lead 退场得意帧 |
| `c-idle` | Martty liang-idle | 177×192 | 7,448 | 经典皮肤·待命（像素小人「嘘」） |
| `c-work` | Martty liang-working | 177×192 | 7,166 | 经典皮肤·干活（抱着终端键盘） |

合计 201,742 B（≈197KB），base64 内联后 `client.js` 约 **343KB**——一次性加载，无额外请求，离线可用。

**为什么内联**：浏览器半边是单文件 bundle（`clientModules` 只托管一个入口），既不能 `require` 兄弟文件，
也没有静态资源目录。要换成宿主 `webServer` 路由托管图片，见 PRD 的 v2 方案。

**降级**：任何一张图加载失败（例如页面安全策略不允许 `data:`）会自动把整层切到经典皮肤，
设置页会给出提示，不会留一排空位。

## 状态映射

| 智能体状态 | 视觉表现 | 素材 |
|---|---|---|
| 新开工 entry | 下方升起 + overshoot，先亮挥手帧再淡出 | `q-wave` |
| running 常驻 | 上下 ±4px 浮动 + 脚下呼吸光晕 + 气泡 + 眨眼 | `q-smile` / `q-blink` |
| provisioning（还在起） | 抱膝坐姿 + 半透明呼吸 + 头顶三点 | `q-sleepy` |
| 已收工的子级 | 灰显 + 缩小 + 不冒泡不眨眼，留在父级下方 | 当前帧 |
| 退出 | 下沉 + 淡出 + 气泡上升 | `q-proud` |
| Lead 全程 | 成熟版头肩，与成员区分 | `m-bust` |
| 经典皮肤 | **Martty 的像素小人**：待命「嘘」/ 干活抱键盘；素材被拦时退回手绘矢量鲸鱼 | `c-idle` / `c-work`（退回时用内联 SVG） |
| failed | 不渲染（沉底） | — |

## 设置

设置 → 智能体鲸鱼 · Agent Whales（也显示当前在干活的实时数量）。共 19 项参数 + 一个「恢复默认」按钮。

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| 启用 | 开 | — | 关闭后整层移除 |
| 计数方式 | 按成员 | 按成员 / 按团队 | 按成员：每个在干活的智能体一只；按团队：每个「至少一名成员在干活」的团队一只 |
| 水平位置 | 中 | 左 / 中 / 右 | 队形贴着页面顶端左/中/右 |
| 形象风格 | **Q 版** | Q 版 / 混合 / 成熟版 / 经典皮肤 | 混合 = Lead 成熟版头肩 + 成员 Q 版 |
| 动画强度 | 标准 | 关 / 轻微 / 标准 / 活泼 | 影响浮动幅度（`--daw-amp`）与气泡数量；关掉时用 CSS 停掉全部循环动画 |
| 尺寸预设 | 标准 | 紧凑 / 标准 / 宽松 | 写 `scale` 为 67 / 100 / 133，与实际不符时显示为「自定义」 |
| 垂直偏移 | 40 px | -60 ~ 120 | 相对内容顶端上下挪；默认 40 是为了给头顶气泡留空间 |
| 角色大小 | 100 % | 40 ~ 200 | 基准高度 96 px；滑杆与预设联动 |
| 不透明度 | 100 % | 20 ~ 100 | 想更低调就调低 |
| 游动速度 | 100 % | 25 ~ 250 | 统一缩放浮动、光晕、眨眼、气泡四类动画的周期 |
| 气泡粒子 | 开 | — | 角色周围上浮的小水泡 |
| 对话气泡 | 开 | — | 头顶那句「当前在做的事」 |
| 显示任务 | 开 | — | 角色脚下的任务行 |
| 已收工子级 | 开 | — | 关掉后只画正在跑的子 agent，收工的立刻消失 |
| 可拖拽 | 开 | — | 允许鼠标把角色拖到任意位置，双击复位；关掉会顺带清空已拖的坐标 |
| 显示名字 | 关 | — | 每个角色下面显示名字（Lead 显示会话标题） |

参数立即生效，持久化在 `localStorage["dsh-agent-whales.settings"]`；拖拽坐标另外存在
`localStorage["dsh-agent-whales.positions"]`（按会话 id 记，形状是 `{ [id]: {x, y} }`，相对队形左上角）；
「恢复默认」会把这两处一起清掉。

## 串门（自建，不依赖外部插件）

宿主半边自己注册了三个工具，机理与 [`dsh-session-bridge`](https://github.com/heartmove/dsh-session-bridge) 一致（`agent.followup/steer` + 折叠 `session.events`），但只做「去看、去说、去听」这一层：

| 工具 | 作用 |
| --- | --- |
| `whales_visit_list` | 列出可串门的会话：id / 标题 / 是否在跑 / 所属工作区。只读。 |
| `whales_visit_send` | 给另一个会话说话：`queue` 追加一轮、`steer` 打断当前步并注入；`waitForReply=true` 会阻塞等它回话。 |
| `whales_visit_read` | 读某个会话最近的对话文本（默认 20 行，上限 100）。 |

**明确不做**：会话创建、离线日志读取、按段落读、看门狗监控、思维链循环检测与任务转移、归档/取消归档——要这些请单独安装 `dsh-session-bridge`（它的工具名是 `session_bridge_*`，与我们不冲突，可以共存）。

装了它之后界面上的表现（气泡会这么说话）：

| 它在干什么 | 气泡 |
| --- | --- |
| 给别的会话发消息 | 去串门 |
| 读 / 按段落读 | 看邻居 |
| 等回复 | 等回话 |
| 建新会话 | 开新房 |
| 找会话 | 找邻居 |
| 唤醒离线会话 | 叫醒他 |
| 归档 / 取回 | 送客 / 请回来 |

对方以后新增工具也不会让气泡报错，只会回落到「在干活」。

## 素材重建

```powershell
# 1) 下载源图 → 抠白底 → 去溢色 → 清脚下投影 → 导出 WebP + assets/art.json
python tools/build-assets.py

# 2) 把 art.json 内联进 lib/client.js（幂等，只改 <art:begin>/<art:end> 之间）
node tools/embed-art.mjs
```

- 源图下载自 `https://raw.githubusercontent.com/AATINF/deepseek-whale-girl-assets/main/share-1600/`，
  缓存在 `.assets-cache/`，已下载过就不再联网，可离线复现。
- `assets/_contact.png` 是质检图：七张图分别叠在白底 / 深底 / 品牌蓝底上，人眼核对白边与灰影。
- 抠图用「边界洪水填充」而不是按亮度抠——后者会把白色围裙和蕾丝抠穿。

## 安装 / 更新

这是一个标准 DSH 双面插件（宿主半边注册提示策略 + 浏览器半边注册 `shell.overlay` 与 `settings.section` 槽位）。

仓库：<https://github.com/mutouwood-hue/dsh-agent-whales>

**桌面版（Electron，profile = `desktop`）**：`desktop` profile 由 App 独占管理，`dsh plugin` / `dsh --dump-config`
都会拒绝执行，只能走 App 自己的入口：

1. Web 侧边栏 →「插件」（Plugins）→ 安装 bundle；
2. 填安装说明符（三种都行）：
   - `github:mutouwood-hue/dsh-agent-whales`（推荐，直接从仓库装）
   - `.tgz` 安装包的绝对路径
   - 本目录的绝对路径（本地开发时）
3. 浏览器半边改动只需 `Ctrl+R` 刷新页面；**宿主半边（提示策略、团队行）必须重启 App**。

**命令行管理的 profile（如 `web`）**：

```powershell
dsh plugin --profile web add github:mutouwood-hue/dsh-agent-whales
# 或本地目录： dsh plugin --profile web add D:/干活/dsh-agent-whales
```

### 本 bundle 同时开启智能体团队

`cordis.patch.yml` 里除了插入 `agent-whales` 这一行，还带上了官方组合包
`@deepseek-ai/dsh-experimental-agent-team-profile` 等价的一层：

- 关掉会被团队工具取代的旧 subagent 工具（`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork` 四行）；
- 插入团队服务 `agent-team`、九个团队工具 `tool-agent-team`、Web roster 面板 `ui-agent-team`。

也就是说：**装上这个插件，每个会话就默认带着智能体团队能力**（团队服务 + 团队工具 + 任务板面板）。

**但这只是「能力可用」，不等于「已经在组队」。** 为了让会话真的用起来，宿主半边会注册
`agent-whales/team-policy`（order 87）这一节系统提示，大意是：

> 除纯寒暄、单一事实问答、**一次只读操作**之外，默认先 `spawn_teammate` 起 1–3 个职责单一的成员，
> 用任务板拆活并写清验收标准与写入范围，Lead 只做整合、评审与最终答复；确实无法拆分时可以不建团队，
> 但要在回复里说明原因。

所以重启 App 之后，**新会话默认就是团队模式**。这是提示层面的约定，不是硬编码调度：模型仍可能判断某任务
确实不可拆分而跳过，统计上不会 100% 每次都组队。

注意：

- 想回到「能力有、但不默认组队」：删掉 `lib/index.js` 里那段 `systemPrompt.section(...)` 注册，重启 App。
- 不要同时再安装官方 `agent-team-profile` bundle —— 那会让 `agent-team` / `tool-agent-team` / `ui-agent-team`
  三个 id 重复注册，行为变成「后应用的补丁覆盖前一个」。
- **回滚要两步**：① 删掉 `cordis.patch.yml` 里那 4 条 `disabled: true` 与 3 条团队 `insert`；
  ② 删掉 `lib/index.js` 里的策略注册（否则提示仍会要求使用已被关掉的团队工具）。改完重启 App。
  更省事的做法是在插件页直接禁用本 bundle。

## 分享给同事

**方式一 · 直接从 GitHub 装（推荐）**

让对方在插件页填 `github:mutouwood-hue/dsh-agent-whales`，或命令行：

```powershell
dsh plugin --profile web add github:mutouwood-hue/dsh-agent-whales
```

**方式二 · 离线给安装包**

在插件目录里打包（产物在 `dist/`），把 `.tgz` 发给对方，对方在插件页填它的绝对路径。

⚠️ 装之前请让同事知道三件事：

- 它会**给整个 profile 装上智能体团队**（团队服务 + 9 个团队工具 + roster 面板），并**禁用旧 `tool-subagent*` 工具**；
- 它会注册一段系统提示，**让每个新会话默认先起 1–3 个 teammate**——这会增加 token 消耗；
- 不想要任一项，删掉 `cordis.patch.yml` 里对应段落或直接禁用本 bundle 即可。

素材署名见 `NOTICE.md`，转发时请一起带上。

## 许可

- 代码：**未附开源许可证**，保留所有权利；要复用请先联系作者。
- 素材：见 [NOTICE.md](NOTICE.md)（Martty 的 MIT 像素小人、AATINF 鲸鱼娘二创素材 + 角色参考 MIT、AI 生成说明）。

## 自测

```powershell
node --test test/client.test.mjs
```

43 项断言，覆盖：信封/清单契约（注册 id === 包名、只 `require("react")`、注册到 `shell.overlay` +
`settings.section`、中英文键集合一致）、计数口径（状态表优先、provisioning/failed、挂 Lead 团队、无团队退化、
teams 模式、选择器引用稳定性）、素材表（每个精灵是 WebP data URI 且尺寸合理）、排布（超过 3 只缩小、
超过 8 只截断成 +N）、皮肤家族（混合模式 Lead 取成熟版、经典皮肤不取位图）、家族树（默认只露两层、
点开才出孙级、孤儿降级为根、成环不死循环、行里保留父会话 key）、任务与气泡（进行中优先、无主任务归 Lead、
气泡三层回退）、子 agent 折叠渲染与「收工灰显 / 开关关闭即隐藏」、拖拽（自己的坐标优先、子级跟随祖先、
坐标取整与清空）、设置夹值、组件渲染（渲染出几只、关闭开关、缺宿主钩子不抛、设置页控件齐全），
以及宿主半边（注册恰好一个策略段落、无 `systemPrompt` 服务时静默跳过、`section()` 抛错被兜住）。

视觉核对：`node _scratch/preview.mjs` 生成页面，再用 headless Chrome 截图：

```powershell
node _scratch/preview.mjs
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=1440,1400 --screenshot=_scratch/shot-final.png _scratch/preview.still.html
```

`preview.still.html` / `art.still.html` 是「动画冻结」版：停掉所有动画并隐藏入场帧，
否则截图会刚好抢在 `daw-in` 的 `scale(.62)` 那一帧上（量出来的尺寸会小一半，不是 bug）。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：注册「团队协作（默认开启）」策略段落；监听 `tools/execute` / `tools/result` 记「当前工具」，用 `GET /agent-whales/api/activity` 提供给浏览器半边。服务缺失一律静默降级 |
| `lib/client.js` | 浏览器半边：设置 store、计数逻辑（纯函数）、家族树、图层与设置页；**含内联的精灵图数据** |
| `cordis.patch.yml` | 插入 `agent-whales` 行 + 团队三行，禁用旧 subagent 四行 |
| `assets/*.webp` | 7 张精灵图（源，便于人工核对） |
| `assets/art.json` | 精灵图产物清单（data URI + 尺寸 + 来源变体号） |
| `tools/build-assets.py` | 素材管线：下载 → 抠图 → 压缩 → 产出 webp 与 art.json |
| `tools/embed-art.mjs` | 把 art.json 内联进 `lib/client.js` |
| `locale/*.json` | 插件管理页卡片文案 |
| `icon.svg` | 插件管理页图标 |
| `test/harness.mjs` | 离线测试用的最小 React 垫片与插件加载器 |
| `test/client.test.mjs` | 离线冒烟测试（含宿主半边的一节） |
| `_scratch/` | 开发期侦察、预览与截图脚本（可整目录删掉） |

## 已验证 / 未验证

- 已验证 · 契约：注册 id === 包名、只 `require("react")`、`apply` 注册到 `shell.overlay` + `settings.section`、
  中英文键集合一致、`exports` 暴露 `./client` 与 `./locale/*.json`、`icon` 为 manifest 相对路径。
- 已验证 · 逻辑：`node --test test/client.test.mjs` 43 项全绿。
- 已验证 · 观感：`preview.still.html` 按 DSH 框架几何（40px 标题栏 + 240px 侧边栏 + 会话头 + `inset:0`
  的 overlay 层）截图核对——96px 下 Lead 头肩能看清脸、四个成员 Q 版尺度一致、`provisioning` 的三点与
  抱膝帧正确、名字带描边在浅底可读；`art.still.html` 在 220% 下核对边缘无白边。
- 已验证 · 真机出现：用户截图确认角色、头顶气泡、计数徽章都正常渲染，`data:` 图片未被 CSP 拦截。
- 已验证 · 经典皮肤：素材未内联时（`ART` 为空）整层自动退回矢量鲸鱼，摆尾与喷水动画在 CSS 里。
- 已验证 · 团队挂载：`agent-team` / `tool-agent-team` / `ui-agent-team` 三行已在 profile 组合里，旧 `tool-subagent*` 已 inactive。
- 已验证 · 拖拽健壮性：`pointercancel`（滚动/切窗口）不会把角色甩到队形原点；`(0,0)`、`NaN`、离谱坐标读取侧一律忽略。
- 已验证 · 拖拽渲染：把某只的坐标写进 store 后，它在离屏页面里以 `position:absolute` 落点，
  它的子 agent 自动跟到右下 30/12px；没拖过的仍在队形里。
- 未验证 · 拖拽手感：`pointerdown/move/up` 的真实拖动手感（包括拖出层边界、触屏）没法离线验证，
  只验证了坐标换算与落点渲染。
- 未验证 · 真机对位：`96px` 比旧版 `46px` 高，加上任务行与头顶气泡，整个簇会压到会话头与第一行内容；
  用「尺寸预设·紧凑」或「垂直偏移」调。
- 未验证 · 团队策略的实际效果：`agent-whales/team-policy` 只在单元测试里验证了注册与兜底，
  尚未在重启后的新会话里观察「默认起团队」是否稳定生效。
- 未验证 · 重复安装：如果 profile 里同时装了官方 `agent-team-profile`，两套补丁会注册同一批 id。
