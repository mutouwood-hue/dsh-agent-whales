# dsh-agent-whales

DeepSeek Harness Web UI 的「智能体鲸鱼」插件：**每多一个正在干活的智能体（Lead、teammate 或子 agent），页面顶端就多一只游动的鲸鱼娘**。
角色会轻轻浮动、偶尔眨眼、冒气泡；智能体一收工，对应的角色摆个得意的姿势沉下去消失。

形象来自社区二创「鲸鱼娘」素材（来源仓库 AATINF/deepseek-whale-girl-assets，角色参考 TreapGoGo/deepseek-whale-girl，MIT License，图片由 AI 生成）；
早期的手绘矢量鲸鱼作为「经典皮肤」保留，可随时切回。

插件分两半：

- **浏览器半边**（`lib/client.js`）：角色图层、家族树、任务行、气泡与设置页。
- **宿主半边**（`lib/index.js`）：注册一段「团队协作」系统提示段落、四个串门工具与一个活动接口。

> ## ⚠️ 装之前必须知道的三件事
>
> 1. **它默认就开启「智能体团队」，并因此禁用 4 个官方 subagent 工具。**
>    默认 `cordis.patch.yml` 会 `disabled: true` 掉 `tool-subagent-control` /
>    `tool-subagent-list-agents` / `tool-subagent` / `tool-subagent-fork`，再插入团队服务
>    `agent-team`、团队工具 `tool-agent-team`、Web roster 面板 `ui-agent-team`
>    （与官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 的补丁逐字段等价）。
>    **这是团队工具取代旧 subagent 工具，不是 bug**；不想要的话见
>    §[关闭团队 / 回滚](#关闭团队--回滚)。
> 2. **它与官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 互斥——必须二选一。**
>    两者同装会给 `agent-team` / `tool-agent-team` / `ui-agent-team` 各插入两次，
>    `cordis-plugin-loader` 抛 `TypeError: duplicate loader entry id`，**DSH 直接启动失败**
>    （不是「后一个补丁覆盖前一个」）。检查方法见 §[常见问题](#常见问题)。
> 3. **它只在自带 experimental 包的宿主上可用。** 三个团队包只随桌面版 runtime 分发
>    （`@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.3` 的 app.asar 内有 24 个
>    `dsh-experimental-*`）；npm 全局 CLI 版 `dsh@0.1.5-rc.2` 的依赖树里是 **0 个**。
>    解析不到 → `assertEntriesLoaded` 抛 `plugin(s) failed to load` → **启动失败**。
>    在 `dsh web` / CLI profile 上请先按 §[关闭团队 / 回滚](#关闭团队--回滚) 关掉团队段。

**运行环境**：需要随包提供 `web` 客户端插件的 DSH（桌面版 runtime 0.2.1-rc.3 实测通过）；
版本号见 §[版本与兼容性](#版本与兼容性)。

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

28 张精灵图，全部 WebP + alpha，长边 192px（96px 显示的 2x 屏）：

| key | 来源变体 | 尺寸 | 字节 | 用在哪 |
|---|---|---|---|---|
| `q-smile` | C12 | 168×192 | 13,218 | Q 版常态 |
| `q-blink` | C19 | 169×192 | 13,166 | 眨眼帧（与 C12 同构图，可交叉淡变） |
| `q-wave` | C23 | 169×192 | 13,260 | 入场挥手帧 |
| `q-proud` | C21 | 161×192 | 12,638 | 退场得意帧 |
| `q-sleepy` | C27 | 175×192 | 13,002 | 起步中，抱膝坐姿 |
| `q-laugh` | C12 · AI 返工 2026-10-30 | 168×192 | 13,064 | Q 版心情帧（大笑）——原帧是半身构图，已按全身重画 |
| `q-pout` | C12 · AI 返工 2026-10-30 | 168×192 | 13,042 | Q 版心情帧（鼓脸）——同上 |
| `q-surprise` | C17 · 2026-10-30 重抠 | 169×192 | 13,114 | Q 版心情帧（惊讶）——构图未变，只清掉脚下灰影 |
| `q-shy` | C12 · AI 返工 2026-10-30 | 174×192 | 13,068 | Q 版心情帧（害羞）——连片红晕，96px 下与微笑可区分 |
| `q-think` | C12 · AI 新增 2026-10-30 | 168×192 | 12,546 | **状态帧**：思考（托腮） |
| `q-oops` | C12 · AI 新增 2026-10-30 | 168×192 | 12,654 | **状态帧**：出错（歉意） |
| `q-heart` | C12 · AI 新增 2026-10-30 | 168×192 | 12,606 | **状态帧**：团队全完成（比心） |
| `q-cry` | C12 · AI 返工 v3 2026-10-30 | 168×192 | 13,024 | **状态帧**：收工庆祝（感动哭，96px 可辨） |
| `m-base` | C13 | 192×192 | 13,474 | Lead 常态（头肩近景） |
| `m-blink` | C13 · AI 返工 2026-10-30 | 192×192 | 13,436 | Lead 眨眼帧——原帧脸更近，已按头肩取景重画 |
| `m-laugh` | C11 | 192×192 | 13,188 | Lead 心情帧（大笑） |
| `m-pout` | C13 · AI 返工 2026-10-30 | 192×192 | 13,790 | Lead 心情帧（不满）——原帧取景到腰，已改头肩 |
| `m-surprise` | C18 | 192×192 | 12,942 | Lead 心情帧（惊讶） |
| `m-proud` | C13 · AI 返工 2026-10-30 | 192×192 | 13,766 | Lead 退场得意帧——原帧取景到腰，已改头肩 |
| `m-wave` | C13 · AI 新增 2026-10-30 | 192×192 | 14,278 | Lead 入场招手帧——**接替原来的 `m-base` 入场回退** |
| `m-shy` | C13 · AI 新增 2026-10-30 | 192×192 | 13,826 | Lead 心情帧（害羞） |
| `m-think` | C13 · AI 新增 2026-10-30 | 192×192 | 13,258 | **状态帧**：思考 |
| `m-oops` | C13 · AI 新增 2026-10-30 | 192×192 | 13,574 | **状态帧**：出错 |
| `c-idle` | Martty liang-idle | 177×192 | 7,448 | 经典皮肤·待命（像素小人「嘘」） |
| `c-work` | Martty liang-working | 177×192 | 7,166 | 经典皮肤·干活（抱着终端键盘） |
| `c-think` | Martty/Liang AI 衍生 2026-10-30 | 177×192 | 8,864 | **状态帧**：经典·思考（已对齐 c-idle 画布） |
| `c-oops` | Martty/Liang AI 衍生 2026-10-30 | 177×192 | 9,174 | **状态帧**：经典·出错 |
| `c-done` | Martty/Liang AI 衍生 2026-10-30 | 177×192 | 9,174 | **状态帧**：经典·完成 |

合计 345,760 B（≈338KB）。**素材不再内联进 `client.js`**（v0.22 D1）：它们随包分发在 `assets/*.webp`，
由宿主只读路由 `/agent-whales/api/art/<key>.webp` 按需提供给浏览器；`client.js` 因此从 566KB 降到约 **127KB**。
客户端只拉**当前所选皮肤**的那一批，并按 L1 基础帧 → L2 常用帧 → L3 心情/状态帧的顺序分批。

> 为什么不再内联：浏览器半边是单文件 bundle，以前只能把图 base64 塞进代码里；28 张之后
> `client.js` 涨到 566KB，每次启动都要一次性下载全部皮肤。现在改成宿主路由 + 按皮肤懒加载，
> 素材总量也不再受限。

> 2026-10-30 这几批返工/新增帧的验收数据（96px 对照、轮廓 IoU、眨眼带外位移、软边占比、经典帧画布对齐）
> 见 PRD §35.12–§35.14；生成脚本 `tools/ingest-generated.py` / `tools/ingest-classic.py`（与
> `build-assets.py` 走同一条管线）、QA 脚本 `tools/qa-frames.py`。

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
| Lead 全程 | 成熟版头肩，与成员区分 | `m-base` |
| 经典皮肤 | **Martty 的像素小人**：待命「嘘」/ 干活抱键盘；素材被拦时退回手绘矢量鲸鱼 | `c-idle` / `c-work`（退回时用内联 SVG） |
| failed | 不渲染（沉底） | — |

## 设置

设置 → 智能体鲸鱼 · Agent Whales（也显示当前在干活的实时数量）。参数与 `lib/client.js` 的
`DEFAULTS` 一一对应，另有一个「恢复默认」按钮。

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
| 俏皮话 | 开 | — | 没正事可说时冒一句短句（`quips`），关掉只留正经气泡 |
| 状态表情 | 开 | — | 思考时托腮、收工轻哭、团队全完成比心（`stateFaces`）；关掉只走心情轮换 |
| 出错表情 | 开 | — | 工具或模型失败时画出错脸（`errorFaces`），8 秒后自动恢复；关掉不影响任何行为 |
| 团队汇总条 | 开 | — | 队形左侧「大伙在干什么」的汇总条（`teamBar`） |
| 空闲挂着 | 开 | — | 没人在干活时把最后一批角色灰显挂着（`alwaysShow`）；关掉即整层消失、不占位 |
| 显示任务 | 开 | — | 角色脚下的任务行 |
| 已收工子级 | 开 | — | 关掉后只画正在跑的子 agent，收工的立刻消失 |
| 可拖拽 | 开 | — | 允许鼠标把角色拖到任意位置，双击复位；关掉会顺带清空已拖的坐标 |
| 显示名字 | 关 | — | 每个角色下面显示名字（Lead 显示会话标题） |

面板里还有**一个不属于 `DEFAULTS` 的开关**：**串门工具**（默认开）。它控制的是**宿主侧四个
`whales_visit_*` 工具注册与否**，所以真相在宿主、不在 `localStorage`——面板显示值来自
`GET /agent-whales/api/activity` 的 `visitTools` 字段，点开关会 `POST /agent-whales/api/visit-tools`。
详见下面「串门」一节。

参数立即生效，持久化在 `localStorage["dsh-agent-whales.settings"]`；拖拽坐标另外存在
`localStorage["dsh-agent-whales.positions"]`（按会话 id 记，形状是 `{ [id]: {x, y} }`，相对队形左上角）；
「恢复默认」会把这两处一起清掉。

## 状态表情（角色知道自己在干什么）

人物表情不再只按「心情轮换」随机换，而是跟着**真实运行时状态**走。宿主半边订阅四个事件、聚合成
每会话一行的只读快照（`state` 字段，挂在同一个 `GET /agent-whales/api/activity` 里），客户端据此选帧：

| 状态 | 触发事实 | 展示 | 时长 |
|---|---|---|---|
| 失败 | `tools/result.isError` / `agent/error` / `agent/request-error` | `q-oops` · `m-oops` · `c-oops` | 8s，之后自动恢复 |
| 收工庆祝 | `agent/turn-stopping` 且这一轮跑了 ≥5s | `q-cry` · `m-proud` · `c-done` | 6s |
| 思考 | `agent/assistant-stream` 处于 `start..end` 之间 | `q-think` · `m-think` · `c-think` | 跟着 stream 走 |
| 团队全完成 | `agentTeam` 投影：任务全 `completed` 且无人在跑 | `q-heart`（成熟版沿用 `m-proud`） | 持续到有新工作 |
| 干活 / 空闲 | `agent/status` | 心情轮换 / 抱膝 | 现有逻辑 |

优先级 `失败 > 庆祝 > 团队完成 > 思考 > 干活 > 空闲`；「思考」只在模型真的在输出时出现（避免工具间隙一直托腮）。
`agent/request-error` 是 **waterfall**，插件监听后必须 `return next()` 放行，否则会吞掉宿主的重试策略。
两个开关可分别关掉（状态表情 / 出错表情）。设计细节与取舍见 [`docs/state-signals.md`](docs/state-signals.md)。

## 串门（自建，不依赖外部插件）

宿主半边自己注册了四个工具，机理与 [`dsh-session-bridge`](https://github.com/heartmove/dsh-session-bridge) 一致（`agent.followup/steer` + 折叠 `session.events`），但只做「去看、去说、去听、去叫醒」这一层：

| 工具 | 作用 |
| --- | --- |
| `whales_visit_list` | 列出可串门的会话：id / 标题 / 是否在跑 / 所属工作区。只读。 |
| `whales_visit_send` | 给另一个会话说话。**默认插话**（`mode: "steer"`）：它正在跑的那一轮会在**下一个步边界**注入你这句话，不用等整轮跑完；要排队等它跑完再处理就显式传 `mode: "queue"`。`waitForReply=true` 会阻塞等它回话。 |
| `whales_visit_read` | 读某个会话最近的对话文本（默认 20 行，上限 100）。 |
| `whales_visit_resume` | 把持久化的离线会话重新拉上线（`agents.resume`，幂等：已在线直接返回），之后才能给它发消息。 |

> **投递方式默认是「插话」（steer）**，2026-10-31 按用户决定改的：智能体之间互相说话不该排队等对方整轮跑完。
> 宿主契约里 `steer` 对 **running** 的 agent 在**下一个步边界**消费、对 **idle** 的直接开一轮——它不会打断
> 正在进行的单个步骤（做不到），但也不用等整轮结束。想全局改回排队：给插件 entry 写
> `config: { visitMode: "queue" }`（兼容 `config: { visitSteer: false }`）；单次调用仍可用 `mode: "queue"`。

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

### 串门工具是**可关的**（默认开）

四个工具的 schema 会出现在**每一轮模型请求**里，实测合计约 **1589 字符**（`name` + `description` +
`parameters`；PTC 模式下 `output.schema` 还会再多约 1430 字符）。同时它们给任何 agent 赋予了
「驱动别的会话」的能力——包括 `steer` 打断、`resume` 拉起离线会话。所以给了一个开关：

| 关掉的方式 | 适用 | 说明 |
|---|---|---|
| 设置面板 →「串门工具」 | 日常 | 立刻 `POST /agent-whales/api/visit-tools`，宿主**真的把四个工具从工具注册表注销**，不是只藏 UI |
| 插件 entry 的 `config` | 一次性默认关 | 在任意 patch 层写 `- id: agent-whales` + `config: { visitTools: false }`；`apply(ctx, config)` 严格 `=== false` 才关 |

关掉后：模型请求里不再有这四个工具定义；设置面板仍显示真实状态（真相来自宿主，不落 `localStorage`）。
重新打开即恢复注册。

**协议**（两个半边就靠它通信，都是本插件的私有路由）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/agent-whales/api/activity` | `GET` / `HEAD` | 只读快照 `{ at, active, visitTools, controlToken }` |
| `/agent-whales/api/visit-tools` | `POST` | 唯一写操作；必须带 `x-whales-token`（= 最近一次 GET 里的 `controlToken`），体 `{ enabled: boolean }` |

`controlToken` 只出现在同源 GET 的响应体里——跨源页面受 CORS 限制读不到响应体，因此拿不到 token，
伪造的 POST 会被 403。这是**同源证明（CSRF 防护）而不是身份认证**，别把它当鉴权用。

## 项目工作台（M6 · 节点图画布）

2026-11-09 上线的主形态：侧栏多一个「🐋 项目」入口，点进去是插件自己的**独立主面板**
（`main` 槽新增 key `whales-canvas`，**不覆盖** `conversation`，顶栏可一键切回官方 Chat）。
里面是十屏：项目列表、项目工作台（画布 / 任务 / 简报 / 执行四个 Tab）、需要我处理、发送记录、
事件台、首次体验、设置。

**画布**只承载三类节点：上下文（仓库 / 文件夹，来自任务落点）、Agent（项目成员对话）、
Composer（主对话）。Agent ↔ Agent 是**无向关联线**（项目 `links`，只表示允许互发 / 互读）；
上下文 → Agent 是**有向数据流**（虚线）。任务依赖 `blockedBy` **不上画布**，只在任务板。
支持拖拽挪位、Ctrl+滚轮缩放、小地图（只读镜像：节点在哪、当前视区在哪）、网格开关、
拖锚点建线、点选后确认删除；删除成员节点只解除画布引用，
进行中的工单标记 `handed_back` 且**不自动取消**（PRD §53.9.12）。

**任务板**走插件自建任务表（`~/.dsh/agent-whales/projects.json`，与宿主任务板共存不混），
列 = 任务 / owner / 依赖 / 落点 / report / 状态；`report` 四态 `done` / `draft` /
`handed_back` / `human_action`——前两个 worker 可写，后两个**只能人关**（worker 只能发起），
写入口径与任务同一条 CAS（冲突 = 重报，不覆盖、无强制写）。

**简报**两层：项目简报（人 / 主对话可写，版本 CAS）+ 对话简报（本人可写，人可代写并标「代写」），
两者**共用 2000 token 总预算**（CJK 1 字 = 1 token，其他 4 字符 = 1 token），超出按序丢弃并返回
`truncated` / `omitted`。每轮自动注入全量上下文已被否决，改为**按需读取** + 系统提示静态提示。

**位置存在宿主**（`~/.dsh/agent-whales/canvas.json`，按项目分页 + revision），浏览器
`localStorage` 只做拖拽即时反馈与离线兜底——换设备 / 换浏览器不再丢，agent 也能改。
刷新后落在上次的界面与项目内 Tab（`dsh-agent-whales.last-view`）；**首次仍然进项目列表**，
「记住」不等于「首次默认进画布」。

**主题**默认浅色，设置里可切暗色；两套 token 一一对应（`WB_TOKENS`），组件只引用
`var(--daw-*)`，切主题即换色，没有第二套组件。

### 真浏览器实跑 + useWb 重订阅环（2026-11-16）

- **新增 `_scratch/live-preview.*`**：把真 `client.js` 弄进真浏览器跑（CDN/本地 React + fetch 垫片 +
  最小 ctx + 真 ReactDOM 挂载）。存在的理由很直接：DSH GUI 要签名 cookie 才进得去，而这类
  「主线程被占满、页面 load 永不触发、且**没有任何报错**」的 bug，只有真 React 能暴露。
- **修 `useWb` 的重订阅环**：原来每次渲染都传新的 inline `subscribe` → React「退订→重订阅」→
  `wbCache` 重订阅再 `load` 一次 → 同步 `publish` → 重渲染 → 又换新 `subscribe`……在只有一个
  订阅者的 URL（如 `/canvas`、`/tasks`）上永停。真实宿主只因 fetch 比 effect 慢而被 `inflight`
  去重挡着，**响应一快就会中招**。改成 `react.useCallback(..., [url])` 按 url 稳定。
- **测试垫片升级为忠实**（`test/harness.mjs`）：`useSyncExternalStore` 现在真的会
  「引用变了就退订重订阅」、store 通知会自动重画、按**树路径**给每个组件实例分配 hook 格子
  （原来按组件函数，同一组件的多个实例会互相覆盖——简报页 3 个 `WbConversationBrief` 就是这么
  把环转起来的）、挂载前跑 cleanup、收编轮询 `setInterval`（否则测试进程永不退出）。
  升级后立刻抓到两个真问题：上面的 useWb 环，以及一条用例发现自己没配 fetch（走到错误分支）。
- **回归用例**（`test/workbench.test.mjs` §24）：`useWb：subscribe 按 url 稳定，store 通知后自动重画`。
  双向验证过——把 `useWb` 改回 inline，它立刻以「setState 循环超过 50 次」红掉。

### 画布 Composer 轻量版 / 已核对 / 规划时提示（2026-11-14 同步页结论落地）

> 调子来自同步页 Q1/Q3/Q4 的产品结论（Notion「dsh-agent-whales · PRD/实现/设计 三方同步」）。

- **Q1 Composer 轻量版**：画布 Composer 卡从「标题卡」变成「输入框 + 放入输入框」。四条约束全落地：
  **只绑主对话**（全项目一个 Composer，不给每个 Agent 配输入框）；按钮叫「**放入输入框**」不叫「发送」
  （禁止清单第 9 条：不把已产出当已送达）；**不做 /命令**、**模型档位只读**（无数据源就不显示，不编）；
  写入失败沿用「无法写入输入框，已复制」。前缀只引用身份（提案 / 任务），不带指令性措辞。
  主面板拿不到官方 `inputActions` 时**明说会降级成复制**，不静默。
- **Q3「已核对」**：新增命令 `action:"verify"`，写**独立字段** `{by, at, note}`，**不并入任务状态**。
  只有项目主对话能核（人通过主对话行事；worker 不能自核），且只能核已报完工的任务。
  界面分两档说清：**「已核对」**（人工）与 **「评审已报通过」**（次信号：以本任务为前置的评审任务
  已报完工——执行器自报，未经人工核对，措辞刻意区分）。
- **Q4 规划时提示**：`projectScopeOrderHint()` 在 assign / assign-and-dispatch 时算一次——
  写入范围重叠且彼此没有先后顺序 → 响应带 `scopeOrderHint`，任务板以 warn banner 显示。
  **只提示，不拦截、不改状态**；有依赖顺序的重叠**不提示**（同步页结论：那是真冲突，豁免会把它藏掉）。

### 借鉴 oh-my-hermes 的两处（调子同 troupe：只为接近的功能拿来用）

> 完整对照（含刻意没拿的 7 项及理由）见 Notion：
> [借鉴 oh-my-hermes · 证据分级与图上标连线理由](https://app.notion.com/p/oh-my-hermes-rlaope-oh-my-hermes-418c209ad67f81b2b6d1def23bd0df41)

- **证据分级：`report.status === "done"` 只说「已报完工」，不说「已完工」**。它 README 原话：
  「执行器说『做完了』不等于有人核过」，四档 `Plan·not run` / `Code·running` /
  `Code·reported done` / `Test·verified`。**这条本来就是我们自己的规矩**（「已回复 ≠ report done」），
  但代码里 done 就直接当 completed、Agent 卡显示「已完工」——等于把中间态填成了绿。
  现在 Agent 卡 chip 说「**已报完工**」+ tooltip「执行器已报完工，还没有人核对」。
  **没有冒充 verified**：我们没有测试/评审/CI 的数据源，不能把它画成绿。
- **依赖连线上线，并标出「为什么连」**。它截图里每条边都写着 `Waits on 2 lanes`；
  我们的画布此前只画 `project.links`（会话关联）与 MCP 约束，**`blockedBy` 依赖从不上线**——
  谁在等谁全靠用户自己记。现在 `wbDepLinks(tasks)` 按 blockedBy 派生依赖线
  （只画两端都有 owner 的、同对去重），边上渲染「**等待 ptask-t1**」。
- **刻意没拿**：lane 模型链与 effort（模型归会话/宿主管，插件没有可选的面）、115 个技能按需装载
  （没有技能注册表）、LSP 进循环（宿主已有）、记忆召回包（我们的 brief 是另一套，同一条边界）、
  TUI lane 树（没有终端所有权）、`ulw-*` 工作流（我们的提案协议是同层级的不同实现）、
  「并行节点不共享写入范围」的**强制**（我们只警告，升级强制属于改我们的判据——但记下了：
  OMH 与 troupe 两家都选了强制/显式顺序，这是第三个独立佐证）。

### 借鉴 troupe 的两处（只接我们已有功能，不为它改我们）

> 调子是用户定的：「不要为了他改我们的功能，只是如果和我们有接近的功能，可以直接拿来用」。
> 完整对照（含刻意没拿的 7 项及理由）见 Notion：
> [借鉴 troupe · 已拿的两处与刻意没拿的](https://app.notion.com/p/troupe-hitianqi-troupe-418c209ad67f81ec92ebca1ad4d1d974)

- **Agent 卡 chip「证据压过观感」**（借 `src/state.ts` 的 `roleState` 梯子）：它原话是
  「写过 `done` 的就是 done，哪怕它还挂在提示符上」。我们原来是看会话在不在线，现在是
  `wbAgentChip(task, online)`——**有 report 就按 report 显示**（done→已完工 / handed_back→待我决定 /
  human_action→求人处理 / draft→草稿中），没有 report 才看在线。这就是我们「已产出 ≠ 已送达」
  纪律在 Agent 卡上的同一句话。
- **产物越界提示**（借 `src/state.ts` 的 `workOf().outside`）：它用 `git diff` 算「改动文件里
  没有被 `touches` 覆盖的」；插件跑不了 git，但 **report 的 artifacts 与任务的 writeScopes 是同一件事的
  声明面与事实面**——`wbArtifactsOutside()` 算出越界产物，在 report 弹窗里 warn 点名列出。
  这给 `handed_back`（超 scope 退回）补上它一直缺的证据面。**没有声明 `writeScopes` 时不提示**
  ——「没声明」不是越界的证据。
- **刻意没拿**：`clashesOf` 的「有依赖顺序的重叠不算冲突」（我们的 `writeScopeWarnings` 是自己的判据，
  为它改我们的判据越界）；notices 的「往 orchestrator 输入一行」（PRD §38.1 禁宿主代发消息）；
  tmux/worktree/分支管理（我们没有终端所有权）；`stages.yaml` 八段流水线（我们的六段是 T-13 生命周期，
  语义不同）；`planHash`、`treeOf`、`done_when`（后两者缺数据源，登记为候选）。

### 画布上的 Agent 生长进度与 Thread 回合记录（M6 画布波次）

- **Agent 卡等宽分段进度**：六段 = T-13 的 source → trigger → policy → ticket → worker → report，
  **全部从任务行已有字段派生，不发额外请求**；`skipped` 表示「不适用」（手动创建没有提案链路），
  与 `pending`（还没到）是两回事。口径抄 CDS `ApprovalFlow`：等宽、不按耗时加权、
  `role="img"` + `aria-label` 文字复述。
- **卡高按 kind 固定**（Agent 148）：CDS 专家画布的同一决策——锚点由 `node.h` 算，
  内容增减不能让卡变高，否则连线锚点立刻算偏。
- **Thread 回合记录节点**（画布顶部中间，V2 起目标由它承载、不再有独立 goal 条）：
  目标（项目简报 goal）/ 成员数 / 任务完成数 / 最近动态（事件台账倒序前 3）/
  执行顺序（按任务创建序的去重 owner 链）/ 留痕条数（带 evidence 的事件数）。
  **没有 Research 节点**——我们没有「研究资料归档」这个数据源，不编。
- **未做（差数据源，不是差工期）**：参考图 V2 左侧四类上下文节点里的 **Skills** 与
  **References（外部只读）**、以及 **Research 证据归档**。这三类都需要插件目前没有的数据源
  （技能登记表 / 外部引用表 / 研究归档表）；按「画布上有个入口、用户照做发现无路可走」比
  「没有这个入口」更糟的判据（计划文档 §11 最高优先级问题类型），**先不做**，等数据源明确。

### 工作台新增的路由（都在 `/agent-whales/api` 前缀下，读操作不需要 token）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/projects` · `/projects/:id` | `GET` | 项目列表 / 单项目（成员、关联线、简报） |
| `/projects/:id/members` · `/members/:sid` | `POST` / `DELETE` | 加入 / 移除项目对话（一个对话只能属于一个项目，`40701`） |
| `/projects/:id/links` | `POST` / `DELETE` | 建 / 删无向关联线（同项目、无向、幂等） |
| `/projects/:id/brief` | `GET` / `PUT` | 项目简报读写（`expectedVersion` CAS） |
| `/briefs/:sessionId` | `GET` / `PUT` | 对话简报读写（人可代写，标 `proxy`） |
| `/tasks?projectId=` | `GET` | 项目任务表快照（`source:"project"`，不混宿主任务板） |
| `/tasks` | `POST` | 新建项目任务（落点字段一起给） |
| `/tasks/:taskId/report` | `PUT` | 写 report 四态（CAS + 人机边界） |
| `/tasks/:taskId/commands` | `POST` | 既有五动作：assign / assign-and-dispatch / dispatch / unassign / reopen |
| `/handoffs?projectId=` | `GET` | 发送记录（交接账本只读，`at` 倒序） |
| `/inbox?projectId=` | `GET` | 需要我处理四组：提案待确认 / worker 求人 / 超 scope 退回 / 系统提醒 |
| `/sessions` | `GET` | 会话目录（加入对话列表、owner 显示名、画布 Agent 节点用） |
| `/canvas?projectId=` | `GET` / `PUT` | 画布位置表。节点是派生的，**位置是唯一「人摆过」的状态**。`expectedRevision` CAS，过期 `40902` 并带回当前版本——不覆盖别人刚摆的位置 |
| `/proposals` · `/proposals/:id/confirm` | `GET` / `POST` | 提案只读展示 + 确认后逐条建任务 |

写操作一律带 `x-whales-token`（同源证明，与 `/visit-tools` 同一把 `controlToken`）；
信封统一 `{code,msg,data}`，业务码见 `lib/index.js` 里的 `TASK_CODE` / `PROJECT_CODE` /
`PROJECT_TASK_EXTRA`（report 冲突 = `40902`，worker 越权 = `40708`，跨项目 = `40701`，
主对话不可移除 = `40702`，提案须主对话提交 = `40706`，store 只读降级 = `50302`）。

### 画布 agent 面（W1 返工）

W2 审核发现的缺口：画布此前只有人能在浏览器里摆，**agent 完全看不到也改不了**。
现在补了一组工具（`presentCall` 分 read / edit，edit 才出现在可写面）：

| 工具 | 作用 |
|---|---|
| `whales_canvas_list` | 列有画布页的项目 + revision + 节点数（read） |
| `whales_canvas_inspect` | 看某个项目的画布：位置 + 关联线 + 成员（read，项目不存在 `40401`） |
| `whales_canvas_layout` | 整体覆盖位置；`expectedRevision` 过期回 `40902`，**不覆盖**（edit） |
| `whales_canvas_link` | 建无向关联线（同项目、自连 `40001`、重复幂等）（edit） |
| `whales_canvas_unlink` | 删关联线（删不存在的也当成功，幂等）（edit） |

**没有 `node_add` / `node_delete`**：画布节点是**派生**的——上下文节点来自任务落点
（`worktree` / `execRoot`，§55.3.1）、Agent 节点来自项目成员、Composer 来自主会话。
允许 agent「增删节点」等于让它伪造这三种事实，所以只开放「摆位置」和「连关联线」。
### worker preset（执行器专用）

`presets/dsh-agent-whales-worker/` 随包分发；插件 `apply` 时把它复制到
`~/.dsh/.agent-presets/dsh-agent-whales-worker/`（**已存在则整目录跳过，绝不覆盖用户改过的版本**；
源文件不齐时不建目标目录，避免半安装）。 composition 逐行与官方 `standard` 母本比对：
保留 13 行全等，删掉 `tool-ask-user` / `present` / plan-mode / goal ×2 / delegation 全组 / `tool-web`，
**无新增行**。`name` / `description` 写明「执行器专用，不供手动选择」；用户手动会话仍用 `standard`。

> 为什么不像 PRD 字面写的那样「落 `cordis.patch.yml`」：patch 是往**宿主组合**插行，
> 进程全局、对每个 agent 生效；而 preset 必须是可按名字选择、挂在 agent plane 独立 realm 的组合，
> 用户 preset 根才是它受支持的分发通道（落 patch 还会重犯 `cordis.patch.yml` 文件头已经警告过的
> duplicate loader entry id 类启动失败）。

### 事件台与 Source 健康面板（W1.5）

Trigger 收件箱：事件先进来评估，再决定开工单还是忽略；与发送记录（事后账本）是两个面。

- **顶栏**：待评估数 + 今日统计（今日 N · 已开工单 N · 已忽略 N）。
- **源筛选**：全部 / 插件 / 主会话 / 工作区 / 定时 / 已抑制（后四类是 PRD 的词表，本期只有「插件」有事件）。
- **事件行**：源 + 文本与时间 + 证据；点开是**展开态三要素**——Trigger 原文（逐字证据，不可摘要）、
  三条规则命中（`rule: scope.match` / `rule: assignable` / `rule: dedupe`）、动作行
  （开工单 / 忽略 / 标记为噪声）。已处置的行只读，并写明谁何时处置、建了哪个工单。
- **自激保护**：同类事件（kind + 归一化文本前 80 字）10 分钟内只评估一次，重复的记 `suppressed` 留痕；
  被标记噪声的 Source 24 小时内新事件直接记 `noise`，不进收件箱。
- **Source 健康面板**（事件台右侧栏，不占主导航）：健康码只用**固定词表**五个词——
  正常 / 评估中 / 已抑制 / 今日无事件 / 已标记噪声，不写自由文案。
  > 与设计稿 T-14 字面词表的偏差：设计列了「已忽略」，但「忽略」是**单条事件**的处置，
  > 不是 Source 的状态；Source 级真实可达的是「今天没有事件 → idle」。所以用 idle 占位，
  > 不留一个永远渲染不出来的词。

| 路由 | 方法 | 作用 |
|---|---|---|
| `/events?projectId=&source=&state=&limit=` | `GET` | 事件列表（`at` 倒序）+ `stats`（pending/today/opened/ignored）+ `health`；stats 只按项目口径算，不受 source/state 筛选影响 |
| `/events/:eventId/actions` | `POST` | `open`（进项目任务表；projectId 缺省用事件自己的）/ `ignore`（留痕不建单）/ `noise`（噪声 + 24h 屏蔽）；写操作带 `x-whales-token`，`requestId` 进程内回放 |
| `/events/health` | `GET` | Source 健康码（固定词表） |

事件状态机：`pending`（待评估）→ `opened`（已开工单）/ `ignored`（已忽略）/ `noise`（被屏蔽）；
`suppressed` 是自激保护的留痕态（同类 10 分钟内重复），不算待评估。落点：`~/.dsh/agent-whales/events.json`，
与 handoffs.json 同目录、独立串行队列，不抢项目 store 的锁；2000 条按文件滚动归档，不静默删。

### 观测 · event_replay（W2）

「这个任务发生过什么」——挂在**任务卡详情**（任务行上的「查看过程」），不进侧栏、不占导航。

- **六步时间线**（设计稿 T-13）：Source → Trigger → Policy → Ticket → Worker → Report。
  每步 = 阶段词 + 时间 + 事实 + 证据；缺的步补 `pending`，`skipped` 表示这一步不适用
  （如手动创建的任务没有 Trigger）。宿主少给/多给都不能让 UI 缺环或乱序（未知 key 追加尾部）。
- **明细流水**：事件台账 / 交接账本 / report 写入三处聚合，按时间倒序，默认 50 条、上限 200。
- **observations**：owner 会话的当前工具与耗时、跑命令 / 写文件计数、日志尾部——
  与执行台同源（`/activity` 快照 + 会话日志折叠），不建第二套采集。
  **计数是执行会话口径（跨任务累计），不是这个任务单独跑的量**——UI 上明确标注，别当任务口径用。
- **与账本的分工**（设计稿原话）：replay 记「任务怎么来的、怎么跑的」；发送记录记「消息送到没有」。
  两者不合并——「已回复」不等于 report 为 `done`。

| 路由 | 方法 | 作用 |
|---|---|---|
| `/tasks/:taskId/timeline?projectId=&limit=` | `GET` | 六步时间线 + 明细流水（只读、无 token） |
| `/tasks/:taskId/observations?projectId=&limit=` | `GET` | 当前工具 + 计数 + 日志尾部（只读、无 token） |

「找不到」分两种：项目不存在 → 200 宽松回空 + `note`（页面轮询时项目被删不刷错误，与 inbox 同口径）；
项目存在但任务不在 → `40401`。

### 目标条与提案带入（W2 · D2 递进第一步）

- **目标条**叠在 `conversation.input.dock`（**不影子**官方 composer——D2 硬约束：先叠加、
  采集升级依据，再决定是否影子；升级触发条件：观察窗口 2 周或 200 会话、目标条点击率 ≥15%）。
- 目标 = 最新提案 `sourceMessageId` 指向的那条用户消息，标题直接截取该消息首行；
  **客户端没有读单条消息的路由**，所以当前永远走「会话标题」兜底并**可见地注明来源**，
  不编造目标文本（参数位保留，将来有读消息能力即可优先）。
- **没有提案就整个不渲染**：目标条是「有提案才出现」的行动条，不是常驻装饰。传统对话里
  没有提案，就不该在官方输入框上方占位置（用户验收反馈 2026-11-10）；提案接口报错时同样
  不渲染——拿不到数据就不表态。（早先这里会退化成一句引导「在下方输入框写下目标」，
  已按该反馈移除，`goal.guide` 文案键一并删除。）
- **提案状态行**：`提案 v2 待确认 · 查看`；点「查看」切到工作台并定位到提案卡。
- **「带入」只服务一件事**：让 Lead 改提案——用官方草稿 API（`inputActions.captureInsertion()`
  + `insertText(text, span)`，契约逐字核实自 desktop runtime）插入一个**引用前缀**
  （如「关于提案 v2（prop-9f3c）：」）。**零 DOM 操作**、是一次可撤销的官方编辑事务；
  插入后**不自动提交**，成功态只说「已带入，请回车发送」——**绝不显示"已发送"**。
  被拒（revision 过期 / 编辑器不可编辑 / 面板拿不到 inputActions）→ 剪贴板降级
  「无法写入输入框，已复制」（`navigator.clipboard` → 隐藏 textarea + `execCommand` → 返回原文，
  全插件唯一一处 DOM 触碰，层层兜底）。

> **来源边界（写实，不假装）**：本期事件只来自**插件自己已经拥有的事实**——提案提交、任务命令、
> 交接发送结果、store 只读降级（`source: "plugin"`）。PRD 里的「主会话消息 / 工作区文件监听 /
> 定时」三类 Source **本期不接**：没有可靠的会话消息钩子；`fs` 监听要做自身状态目录排除与泄漏防护，
> 留后续波次。所以筛选项里那三个词表值当前不会有事件，不是 bug。投递前的校验失败
> （无 owner / 对方未运行）不登记——消息都没造出来，没有「已发生的事实」可记。

### MCP 约束层（画布连线即约束）

「这个会话能用哪些 MCP 工具」在画布上就是**一条线**：把 MCP 服务节点拖到某个 Agent 上，
这个会话就被限制成只能用连上的那些服务；删掉线，约束解除。

| 路由 | 方法 | 作用 |
|---|---|---|
| `/projects/:id/mcp-links` | `GET` / `HEAD` | 读约束表 + 可用 MCP 清单（只读、无 token） |
| `/projects/:id/mcp-links` | `POST` | 建约束：`{server, sessionId}`，带前置校验 |
| `/projects/:id/mcp-links?all=1` | `DELETE` | 一键全清；不带 `all=1` 按 `{server, sessionId}` 删一条 |

**存的是什么**：`mcpLinks[] = {server, sessionId, createdAt}`，`sessionId` 是**裸会话 id**
（与 `project.members[].sessionId` 同格式，不带 `session-` 前缀；`agent.id` 的前缀由
`sessionIdOfAgent()` 剥掉）。单独建表而不是塞进 `project.links`——那条路由要求两端都是
项目成员，MCP server 不是成员，硬塞只会拿到 `40701`。

**三个保险（缺一个都不敢上）**：

1. **默认全放行**。表里没有的会话，guard 直接 `return undefined`。插件关掉 = 层消失，
   不会把人锁在外面。
2. **一键全清**。`DELETE ?all=1` 一步退回「没有约束」，任何误连都能秒撤。
3. **前置校验**。服务没连上 DSH 时连线请求直接被拒（`40709` / `40710`），
   不会留下一条指向空气的线。

**为什么走 `guard()` 而不是 `ToolRestriction.allow`**：`allow` 的语义是「只保留这些，
其余全部移除」，按它实现会把 `bash` 和文件读写一起删掉。所以 guard 里先判是不是
MCP 工具（`mcp__` 前缀），不是就立刻放行；是且不在允许表里才返回拒绝理由。

```js
function mcpConstraintGuard(exec) {
  var index = mcpConstraintIndex();           // 带 2s TTL 缓存
  if (index === null) return undefined;       // 一条约束都没有 → 快路径
  var sessionId = sessionIdOfAgent(exec && exec.agent);
  if (sessionId === "") return undefined;    // 身份取不到 → 放行，不猜
  var entry = index[sessionId];
  if (!entry) return undefined;               // 这个会话没被约束 → 放行
  var server = mcpServerOfTool(exec && exec.name);
  if (server === "") return undefined;       // 不是 MCP 工具 → 放行
  if (entry.servers[server]) return undefined;
  return "该会话未连接 MCP 服务「" + server + "」";
}
```

**粒度是服务级，不是工具级。** 一条约束记的是「这个会话能连 `pencil` 这个服务」，
不是「能调 `pencil` 的哪几个工具」。理由：画布上画的和用户认的都是服务名，工具级粒度
要么在 UI 上多一层「选哪些工具」，要么就得替用户猜——两者都不如服务级诚实。
要收窄到工具级是下一步的事，需要 MCP 侧先能给「这个服务有哪些工具」的稳定清单。

**新建的约束最多 2 秒后生效。** 索引带 `MCP_CONSTRAINT_TTL = 2000` 缓存，
给「外部手改 `projects.json`」留一个陈旧上界。所以连上线立刻去试，可能还会被拒一次——
这不是 bug，等一个 TTL 就好。

**`mcpServerOfTool()` 同时承担「是不是 MCP 工具」的判别**：返回空串就不是，
不用再单独写一个 `isMcpTool`。`mcp__` 后面没有第二个 `__` 时也返回空串（拒识，不放行误判）。

**guard 契约**（逐字核实自 `@deepseek-ai/dsh-tools`）：`ToolGuard = (execution) => string | undefined`，
`execution.agent` 由 agent loop 填入；返回 `undefined` = 放行，返回字符串 = 拒绝且该字符串就是
拒绝理由；`guardReason` 取**第一个非 undefined**（先拒者赢）。

**`agent.id === agent.session.id === "session-<uuid>"`**（探针实测 300/300）：拿会话身份只需
去前缀，不需要额外映射表。探针数据已固化成 `test/fixtures/tool-probe-concurrency.json`，
由 `test/mcp-concurrency-contract.test.mjs` 5 例钉住这条契约。

**画布侧的呈现**（设计稿 U-13）：MCP 是第三类节点（⌘ 标签 + 工具数 + 已连接/未连接 chip）；
Agent 卡上直接列出被允许的服务，不用去连线上数；Composer 不显示徽标——它没有被约束，
显示反而误导。

**并发已实证**（探针 300 条 / 4 个 agent）：6/6 对时间窗重叠、同一个 5 秒窗口挤进 4 个 agent、
相邻 299 条里 199 次换 agent。附带实证：被放行的 12 种工具里 `pwsh` 出现 90 次——这正是不能用
`ToolRestriction.allow` 的原因。

**探针已删除**：它的使命（证明 `exec.agent` 能给可靠的会话级身份）已完成，100 行调试代码 + 一个
`/probe` HTTP 端点不该留在要发布的插件里。复读落盘数据时它还涨到过 375KB（有 `PROBE_CAP = 300`
上限，但每 3 秒重写一次）。

**已验证**：完整用户旅程有测试钉着——连上 `pencil` 后 `slack` 被拦、`pwsh` 照常放行、
另一个会话和主会话都不受影响；点「一键全清」后全部恢复；只删一条线时其余约束还在。

**还没做的**：画布上不能真的断开某个 MCP 服务（那要在 DSH 设置里做），占位按钮只负责引导。

## 素材重建

```powershell
# 1) 下载源图 → 抠白底 → 去溢色 → 清脚下投影 → 导出 WebP + assets/art.json
python tools/build-assets.py

# 2) 由 art.json 生成 assets/manifest.json，并把 assets/<key>.webp 对齐到 art.json
#    （v0.22 D1 起不再内联；这一步也会补齐缺失的 webp / 修正与 art.json 不一致的图）
node tools/build-manifest.mjs

# 只校验不写盘（CI / 发布前用）
node tools/build-manifest.mjs --check
```

- 源图下载自 `https://raw.githubusercontent.com/AATINF/deepseek-whale-girl-assets/main/share-1600/`，
  缓存在 `.assets-cache/`，已下载过就不再联网，可离线复现。
- `assets/_contact.png` 是质检图：七张图分别叠在白底 / 深底 / 品牌蓝底上，人眼核对白边与灰影。
- 抠图用「边界洪水填充」而不是按亮度抠——后者会把白色围裙和蕾丝抠穿。
- `assets/art.json` 是**构建产物**（465KB），**不进 npm 包**；运行时只用到 `assets/manifest.json`
  + `assets/*.webp`。`node tools/embed-art.mjs` 仍可用，但它现在只是 `build-manifest` 的兼容别名。

## 安装 / 更新

这是一个标准 DSH 双面插件（宿主半边注册提示策略 + 浏览器半边注册 `shell.overlay` 与 `settings.section` 槽位）。

仓库：<https://github.com/mutouwood-hue/dsh-agent-whales>

**桌面版（Electron，profile = `desktop`）**：`desktop` profile 由 App 独占管理，`dsh plugin` / `dsh --dump-config`
都会拒绝执行，只能走 App 自己的入口：

1. Web 侧边栏 →「插件」（Plugins）→ 安装 bundle；
2. 填安装说明符（三种都行）：
   - `github:mutouwood-hue/dsh-agent-whales`（推荐，直接从仓库装）
   - `.tgz` 安装包的绝对路径（自己打包：`npm run pack:dist`，产物落在 `dist/`）
   - 本目录的绝对路径（本地开发时）
3. 浏览器半边改动只需 `Ctrl+R` 刷新页面；**宿主半边（提示策略、活动接口）必须重启 App**。

**命令行管理的 profile（如 `web`）**：

```powershell
dsh plugin --profile web add github:mutouwood-hue/dsh-agent-whales
# 或本地目录： dsh plugin --profile web add D:/干活/dsh-agent-whales
```

> 没有 `scripts` 里的 `pack:dist` 之前，`dist/` 里的 `.tgz` 是手工 `npm pack` 出来的；
> 现在 `npm pack` 会先跑 `prepack`：重新生成 `assets/manifest.json`，并守两道门——`lib/client.js` **不得再内联 base64 素材**、体积 **不得超过 200KB**。

### 默认开启智能体团队（本 bundle 的一部分）

`cordis.patch.yml` 里除了插入 `agent-whales`，还带上了官方组合包
`@deepseek-ai/dsh-experimental-agent-team-profile` **逐字段等价**的一层：

- `disabled: true` 掉会被团队工具取代的旧 subagent 工具（`tool-subagent-control`、
  `tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork` 四行）；
- 插入团队服务 `agent-team`、团队工具 `tool-agent-team`、Web roster 面板 `ui-agent-team`
  （config 与官方层一致：`maxMembers: 8` / `maxTasks: 256` / `maxMessageBytes: 65536` /
  `disposalTimeoutMs: 5000`、`freshProvider: spawn` / `forkProvider: fork`）。

也就是说：**装上这个插件，每个会话就默认带着智能体团队能力**（团队服务 + 团队工具 + 任务板面板），
代价是本 profile 里不再有 `subagent` / `subagent_fork` / `list_agents` / `subagent_control`
这四件工具——delegate 改走团队工具。已用真实 `composeEntries` 复算：默认层叠加
`dsh-base` + `dsh-web-app` 后**恰好触碰 8 行**（4 行 disabled + 插件自己 + 3 行 insert），
**零 warning**。

**但这只是「能力可用」，不等于「已经在组队」。** 为了让会话真的用起来，宿主半边会注册
`agent-whales/team-policy`（order 87）这一节系统提示，大意是：

> 除纯寒暄、单一事实问答、**一次只读操作**之外，默认先 `spawn_teammate` 起 1–3 个职责单一的成员，
> 用任务板拆活并写清验收标准与写入范围，Lead 只做整合、评审与最终答复；确实无法拆分时可以不建团队，
> 但要在回复里说明原因。

所以重启 App 之后，**新会话默认就是团队模式**。这是提示层面的约定，不是硬编码调度：模型仍可能判断
某任务确实不可拆分而跳过，统计上不会 100% 每次都组队。

**宿主侧的兜底逻辑**：`agent-whales/team-policy` 是按服务判定的——组装提示时如果 `agentTeams`
服务存在，本段输出空字符串（让位给官方 `team:policy`，避免双份注入）；不存在时输出上面的兜底段落。
注意这条兜底在「你手工关掉团队」时**仍会输出**，所以关掉团队后如果不想让模型去找
`spawn_teammate`，最省事的做法是在插件页直接禁用整个 bundle（见下）。

### 关闭团队 / 回滚

有两条路径，**都不需要改本插件文件**。

**A. 只关团队、保留鲸鱼**：把下面 7 行追加到 `$DSH_HOME/cordis.patch.yml`
（家目录用户补丁层，叠在每个 profile 之上、优先级最高；`live` 热加载，通常不必重启）：

```yaml
- id: agent-team
  disabled: true
- id: tool-agent-team
  disabled: true
- id: ui-agent-team
  disabled: true
- id: tool-subagent-control
  disabled: false
- id: tool-subagent-list-agents
  disabled: false
- id: tool-subagent
  disabled: false
- id: tool-subagent-fork
  disabled: false
```

> ✅ **这 7 行经过真实复算验证**（`_scratch/verify-t3.mjs`「关闭步骤复算」一节，用
> `composeEntries` 叠加 `dsh-base` + `dsh-web-app` + 本 bundle + 上面这段）：三条团队行
> `disabled === true`、四条 `tool-subagent*` 回到 `disabled === false`、鲸鱼保持启用、
> 团队行仍然只有一份（不会又造出重复 id）、**零 warning**。原理是补丁按 `target[key] = value`
> 逐键覆盖（`dsh-app-boot/lib/index.js:102-105`），后应用的层能翻回前一层的 `disabled`。
>
> ⚠️ 已知副作用：`lib/index.js` 的提示段落会在团队服务缺失时输出兜底策略（要求用
> `spawn_teammate`），而那时工具已被关掉。要彻底干净走路径 B，或等 lib 侧把兜底改成
> 「无团队服务就不输出」（已作为跨范围项转派）。

**B. 整个插件停用**（鲸鱼和团队一起关，绝不出现提示/工具不一致）：

```yaml
- id: agent-whales
  disabled: true
```

或者更省事：在插件页直接禁用本 bundle。

### 两种会启动失败的组合（务必避开）

| 组合 | 结果 |
|---|---|
| profile 里同时有官方 `@deepseek-ai/dsh-experimental-agent-team-profile` bundle | ❌ **DSH 起不来**：两边插入同一批 id（`agent-team` / `tool-agent-team` / `ui-agent-team`），`cordis-plugin-loader/lib/index.js:91` 抛 `TypeError: duplicate loader entry id`。已用真实补丁复现出 3 个重复 id |
| 在没有 experimental 包的 DSH 上装（例如 npm 全局 CLI `dsh@0.1.5-rc.2` 的 profile） | ❌ **DSH 起不来**：三个 `name` 解析不到（该依赖树里 experimental 包数量为 0），`dsh-app-boot/lib/index.js:1434-1438` 的 `assertEntriesLoaded` 抛 `plugin(s) failed to load` |

**装之前先自检**（缺哪个会直接告诉你；全 OK 才装）：

```powershell
node -e "for (const p of ['@deepseek-ai/dsh-experimental-agent-team','@deepseek-ai/dsh-experimental-tool-agent-team','@deepseek-ai/dsh-experimental-client-ui-agent-team']) { try { require.resolve(p); console.log('OK', p) } catch { console.log('MISSING', p) } }"
```

### 常见问题

**Q：我怎么知道自己 profile 里有没有装官方 agent-team-profile？**
看 `<DSH_PROFILE_DIR>/package.json` 的 `dsh.profile.bundles`（桌面版 profile 目录是
`$DSH_HOME/profiles/desktop`）。里面**同时出现** `dsh-agent-whales` 和
`@deepseek-ai/dsh-experimental-agent-team-profile` 就是踩雷配置，必须删掉后者。

> 本仓库作者本机就是这种配置（`~/.dsh/profiles/desktop/package.json` 两个都列着）。
> 之所以还没炸，是因为那条 bundle 从 profile 目录解析不到（`MODULE_NOT_FOUND`），
> 也就是说它当前**并没有真正生效**——一旦补齐安装，就会命中 duplicate id。属于待修的踩雷配置。

**Q：装完重启，DSH 起不来怎么办？**
看启动报错里的关键词：
- `duplicate loader entry id` → 官方 profile 同装，删掉它；
- `plugin(s) failed to load` → 宿主没有 experimental 包，按 §关闭团队 / 回滚 A 关掉团队段，
  或换桌面版。


## 分享给同事

**方式一 · 直接从 GitHub 装（推荐）**

让对方在插件页填 `github:mutouwood-hue/dsh-agent-whales`，或命令行：

```powershell
dsh plugin --profile web add github:mutouwood-hue/dsh-agent-whales
```

**方式二 · 离线给安装包**

在插件目录里打包：`npm run pack:dist`（产物落在 `dist/`，`prepack` 会先跑 build-manifest 并校验：client.js 无内联素材、≤200KB、manifest 非空），
把 `.tgz` 发给对方，对方在插件页填它的绝对路径。

⚠️ 装之前请让同事知道三件事：

- 它会**给整个 profile 装上智能体团队**（团队服务 + 团队工具 + roster 面板），并因此
  **禁用 4 个官方 subagent 工具**（团队工具取代它们，不是 bug）；
- 它会注册一段系统提示，**让新会话默认先起 1–3 个 teammate**——这会增加 token 消耗；
- **必须先确认对方没装官方 `agent-team-profile`**（同装会让 DSH 起不来），且宿主是自带
  experimental 包的桌面版；否则按 §关闭团队 / 回滚 处理。

素材署名见 `NOTICE.md`，转发时请一起带上。

## 许可

- 代码：**MIT License**（见 [LICENSE](LICENSE)，Copyright (c) 2026 mutouwood-hue）——可自由使用、修改、分发，保留版权声明即可。
- 素材：见 [NOTICE.md](NOTICE.md)（Martty 的 MIT 像素小人、AATINF 鲸鱼娘二创素材 + 角色参考 MIT、AI 生成说明）。

## 版本与兼容性

当前插件版本：**0.24.0**（M6 项目工作台：节点画画布 + 任务表 report 四态 + 简报按需读取 + worker preset）。

| 宿主 | 团队段 | 说明 |
|---|---|---|
| 桌面版（Electron，runtime `0.2.1-rc.3`） | ✅ 可用 | app.asar 自带 24 个 `dsh-experimental-*` 包，实测通过 |
| npm 全局 CLI `dsh@0.1.5-rc.2` 的 profile（`dsh web` / headless） | ❌ 需先关闭 | 依赖树里 `dsh-experimental-*` 数量为 0，团队三条 insert 解析不到会拒绝启动 → 按 §关闭团队 / 回滚 A 处理 |

**为什么没有 `engines.dsh` / 宿主版本区间**：DSH 的插件清单契约（`@deepseek-ai/dsh-package-manifest`
的 `DshManifest` 类型）只认 `bundle` / `profile` / `client` / `configTrees` / `sessionFormatMigration` /
`moduleFallback`，**没有宿主版本字段**；239 个官方包里 238 个不声明 `engines`，唯一的版本旋钮是
`peerDependencies["@deepseek-ai/cordis"]`，而 cordis 4.x 同时覆盖上面两代 runtime，拦不住语义漂移。
所以兼容性靠两件事守：**README 这张表** + **每次升级 DSH 后跑一遍 `npm test` 并目视页面**。

**升级 DSH 后可能静默坏的三个面**（离线测试覆盖了前两个的仓库侧契约）：
`dsh.client` 的 `platform` / `immediately` / `inject` / `external` 字段语义、团队三包的
`id` 与 `config` 键名、以及 `systemPrompt.section()` 的签名。真坏了的表现通常是「页面没有鲸鱼」
或「启动报 plugin(s) failed to load」，前者刷新 + 看控制台，后者看启动日志关键词。

## 自测

```powershell
npm test          # = node --test test/，跑 test/ 下全部 *.test.mjs
```

四个文件分工：`client.test.mjs`（基线：契约/计数/素材/排布/家族树/气泡/拖拽/设置/渲染）、
`index.test.mjs`（宿主半边）、`client-robustness.test.mjs`（对抗性：畸形输入、缺服务、边界值）、
`workbench.test.mjs`（M6 工作台纯逻辑 + 十屏渲染冒烟 + W1.5 事件台）、
`workbench-draft.test.mjs`（W2 提案带入与目标条）、
`workbench-replay.test.mjs`（W2 event_replay UI）、
`meta.test.mjs`（发布门禁：清单契约、`files` 覆盖 `exports` 目标、patch 无 BOM/可解析、
默认 patch 只增量插入自己、`npm test` 覆盖全部用例）。

开发期预览（不进包、不进测试目录）：`node _scratch/wb-preview.mjs` 用假宿主数据把工作台十屏
渲染成静态 HTML（`_scratch/wb-preview/`），配 `_scratch/wb-preview-check.mjs`（逐屏数元素）与
`_scratch/wb-css-check.mjs`（CSS 括号配对 / token 两套主题齐全 / 无硬编码 hex）自检。

覆盖：信封/清单契约（注册 id === 包名、只 `require("react")`、注册到 `shell.overlay` +
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
| `lib/index.js` | 宿主半边：注册「团队协作」策略段落、MCP 约束层（`mcpLinks` 表 + 全局 `tools.guard()` 只拦 `mcp__` 工具）（官方 `team:policy` 在时让位；`spawn_teammate` 不可见时不输出）、四个 `whales_visit_*` 串门工具（可运行时开关）；监听 `tools/execute` / `tools/result` 记「当前工具」，用 `GET /agent-whales/api/activity` 提供给浏览器半边，`POST /agent-whales/api/visit-tools` 接受开关。服务缺失一律静默降级 |
| `lib/client.js` | 浏览器半边：设置 store、计数逻辑（纯函数）、家族树、图层、设置页、状态表情状态机、素材 loader（**不含图片数据**，运行期从宿主路由按皮肤拉）；**M6 项目工作台**（十屏 + 节点画布 + 设计 token，纯逻辑可离线测） |
| `cordis.patch.yml` | 默认层（**唯一真相**）：插入 `agent-whales` + 团队服务/工具/面板三行，并 `disabled` 掉旧 subagent 四行 |
| `presets/dsh-agent-whales-worker/` | 执行器 preset（随包分发，`apply` 时装到用户 preset 根；执行 Session 专用，不供手动选择） |
| `assets/*.webp` | 28 张精灵图（**随包分发**，运行期由宿主路由按皮肤提供；另 2 张 Martty 像素小人的 PNG 源在 `assets/pet/`） |
| `assets/manifest.json` | 运行期素材清单：`{version, keys:{key:{w,h,bytes,skin}}}`，宿主路由的白名单来源（2.8KB） |
| `assets/pet/` | 经典皮肤的两张上游 PNG（Martty，MIT）+ 复现说明；`c-idle` / `c-work` 的唯一源 |
| `assets/art.json` | 素材构建产物（data URI + 尺寸 + 来源变体号），**不进 npm 包** |
| `tools/build-assets.py` | 素材管线：下载 → 抠图 → 压缩 → 产出 webp 与 art.json |
| `tools/build-manifest.mjs` | art.json → `assets/manifest.json`，并把 `assets/<key>.webp` 对齐到 art.json（`--check` 只校验） |
| `tools/ingest-generated.py` | 把新画的插画接进 `art.json`（白底洪水填充 → 清投影 → 羽化 → 去溢色 → WebP） |
| `tools/ingest-classic.py` | 经典像素皮肤专用管线（哨兵色转透明 + 最近邻 + 按 `c-idle` 画布对齐） |
| `tools/qa-frames.py` | 帧验收：取景 IoU / 轮廓宽 / 眨眼带外位移 / 软边占比 |
| `tools/requirements.txt` | 上面几个 Python 脚本的依赖（numpy + Pillow） |
| `tools/embed-art.mjs` | **已弃用**：保留为 `build-manifest` 的兼容别名（旧命令不会再把图内联回去） |
| `docs/state-signals.md` | 状态表情的信号采集设计（思考 / 失败 / 完成三类信号从哪来） |
| `locale/*.json` | 插件管理页卡片文案 |
| `icon.svg` | 插件管理页图标 |
| `test/harness.mjs` | 离线测试用的最小 React 垫片与插件加载器 |
| `test/client.test.mjs` | 基线用例（契约 / 计数 / 素材 / 家族树 / 气泡 / 拖拽 / 设置 / 渲染） |
| `test/workbench.test.mjs` | M6 工作台纯逻辑用例（路由 / token 估算 / 简报预算 / 任务行派生 / report 人机边界 / 待办聚合 / 画布图 / hook 顺序 / 十屏渲染冒烟 / 只读缓存）+ W1.5 事件台用例（筛选项词表 / 健康码五词与色调 / 展开态 / 页面渲染 / 项目上下文回退） |
| `test/workbench-draft.test.mjs` | W2 提案带入与目标条（`wbDraftPrefix` 引用前缀无指令措责 / `wbInsertDraft` 三态降级链 / 目标条无提案时整个不渲染 / input.dock 不影子） |
| `test/workbench-replay.test.mjs` | W2 event_replay UI（六步固定 / 缺步补 pending / 未知 key 追加尾部 / 明细倒序 / 色调 / 弹层渲染与坏数据兜底） |
| `test/workbench-canvas.test.mjs` | R1 画布 store（`canvas.json` 读写 round-trip、CAS 冲突、位置收敛、坏 JSON 降级）+ `observe-tool-calls.test.mjs` 观测层（`sessionToolCalls` 从真实会话事件抽 `tool/call`、maxScan 上限、尾部优先） |
| `test/mcp-constraint.test.mjs` | MCP 约束层宿主侧（连线表读写、前置校验 40709/40710、`?all=1` 全清、guard 放行/拒绝、剥前缀、只读降级） |
| `test/mcp-canvas.test.mjs` | MCP 约束层浏览器侧纯函数（三类节点派生 / 连线对 / 按会话允许集合 / MCP id 判别 / i18n） |
| `test/mcp-concurrency-contract.test.mjs` | 探针实测契约的回归（`sessionIdOfAgent` 剥前缀含主会话 / `agent.session.id` 兜底 / 并发确实发生过 / 放行工具里没有 MCP 工具 / 主会话不被当成 worker），fixture 是真机数据 |
| `test/mcp-canvas-render.test.mjs` | MCP 约束层渲染 + 交互（已连接 chip、Agent 徽标、无服务占位、挂掉不崩、拖线发 POST、判重不发请求、全清发 DELETE） |
| `test/index.test.mjs` | 宿主半边用例（策略段落注册与兜底、串门工具、活动接口、项目任务表、简报、提案、report、handoffs、inbox、sessions、events 台账与三动作、preset 安装器） |
| `test/client-robustness.test.mjs` | 对抗性用例（畸形输入、缺服务、边界值） |
| `test/meta.test.mjs` | 发布门禁用例（清单契约、`files`/`exports`、patch BOM 与结构、`npm test` 覆盖面） |
| `test/index.js` | `node --test test/` 的目录入口，导入全部 `*.test.mjs` |
| `_scratch/` | 开发期侦察、预览与截图脚本（可整目录删掉） |

## 已验证 / 未验证

- 已验证 · 契约：注册 id === 包名、只 `require("react")`、`apply` 注册到 `shell.overlay` + `settings.section`、
  中英文键集合一致、`exports` 暴露 `./client` 与 `./locale/*.json`、`icon` 为 manifest 相对路径。
- 已验证 · 逻辑：`npm test`（= `node --test test/`）全绿（断言数以 `test/` 下的文件为准）。
- 已验证 · D1 素材出 bundle（2026-10-30）：`client.js` 由 566KB 降到 **127KB**（无 `data:image/*;base64`）；
  素材清单 28 键（q13 / mature10 / classic5）由 `assets/manifest.json` 提供；宿主
  `GET /agent-whales/api/art/manifest` + `GET|HEAD /agent-whales/api/art/<key>.webp` 按白名单供图
  （manifest `no-store`、图片 `immutable` + etag、未知 key / 路径穿越 → 404、非 GET → 405）；
  客户端按皮肤分波（L1 base → L2 常用 → L3 其余）、单帧失败只摘该帧、manifest 失败整层退矢量；
  `npm pack` = 39 文件 / 425KB，`art.json` 与 `_contact.png` 不进包。测试 150/150。
- 已验证 · 体积门禁随 M6 画布波次再次上调（2026-11-14）：`dsh.client` 只认一个 `./client` 导出，
  装饰层 + 十屏工作台 + 画布波次共用同一个单文件 bundle，`client.js` 到 **约 424KB**
  （素材依旧出包、不内联）。上限 200KB → **420KB**（M6 工作台，2026-11-09）→ **560KB**
  （M6 画布波次，2026-11-14；`prepack` + `test/meta.test.mjs` + `test/client.test.mjs` 三处同改），
  **560KB 起不再上调**（同步页结论）。上限的意义是「别无声膨胀」，不是「永远 127KB」。
- 已验证 · 画布波次（2026-11-14）：`wbAgentSteps` 六步派生（提案来源全 done / 手动创建前三步
  skipped / owner 三态 / report 四态）、`wbGrowthLabel` 可读名、Agent 卡真渲染 6 个等宽分段且
  aria-label 与数据一致；`wbThreadNode` 六行全来自已有事实（坏数据不炸）、画布上真出现 Thread 节点。
- 已验证 · 借鉴 troupe（2026-11-14）：`wbAgentChip` 证据优先（有 report 就不看在线，8 例）、
  `wbArtifactsOutside` 越界产物（声明内 / 声明外 / 无声明 / 坏数据 / 字符串产物 5 种输入）、
  `wbScopeOverlaps` 与宿主 `writeScopeWarnings` 同口径（含前缀，两边必须一致否则界面说的和宿主罚的不是一件事）。
- 已验证 · 借鉴 oh-my-hermes（2026-11-14）：`wbDepLinks` 依赖派生（两端有 owner 才画 / 同对去重 /
  自等不画 / 阻塞方不存在或没 owner 不画 / 坏数据不炸，11 断言）；画布上真出现「等待 ptask-t1」边标；
  `report done` 的措辞改成「已报完工」并带 tooltip「还没有人核对」。
- **已验证 · 真 HTTP E2E（2026-11-14，`test/e2e-http.test.mjs`）**：宿主半边跑在真 `http` server 上、
  真 socket 请求，覆盖 activity→token→403 拒无令牌→建项目/成员/关联→建任务（带落点与写入范围）→
  指派（带 Q4 提示）→派发（dispatch-rejected）→report 四态→**CAS 40902**→核对（Q3）→简报 CAS→
  提案工具 + confirm→事件台/待办/交接→画布 GET/PUT/GET→MCP 建链幂等 + 不存在服务 40709→
  **跨项目阻塞 40704**→**进程重启后**项目/任务/report/核对字段/画布节点/事件台账全部还在。
  这条补上了一直缺的一角：既有 370 个用例都是「假 fetch + 直接调 handler」，从没验过真实 TCP。
- **已验证 · 真浏览器（2026-11-16，Tabbit + `_scratch/live-preview`）**：真 React 挂载真 `client.js`，
  量每个 `.daw-wb-node` 的 `getBoundingClientRect` 并两两求交——**重叠 0 处**；空态引导节点在
  Composer 正下方（430,470,300），按钮是画布内的「+ 新建任务 / 把目标放入输入框」，不再切页签、
  不再把用户拽到官方会话面板。同一探针也量出按钮清单与节点种类，供后续回归比对。
- 未验证 · 真机（DSH GUI）联调：`inputActions` 在主面板是否真的拿得到（拿不到就走剪贴板降级，
  Composer 上会明说）；560KB bundle 首屏加载时间；D2 preset realm 启动。这些要重启 DSH 才能验——
  GUI 的 launch token 是进程内存里的随机值（`WeakMap` + `randomBytes(32)`），外部拿不到，
  所以 UI 交互验收需要用户提供带 token 的 URL。
- 未验证 · 借鉴 troupe 真机：越界提示在真实 report 数据下的观感（现在只有纯函数 + 弹窗接线测试）。
- 已验证 · 全页面交互冒烟（2026-11-14）：`.prd-tmp/smoke-all-pages.cjs` 用真实 useState 的迷你
  React 挂起 11 个页面，把每个按钮与画布节点点一遍、每个弹窗走一遍「开→取消→遮罩关」——本轮修掉的
  5 类 bug（useState 元组当值 ×2 / 未声明标识符 ×2 / 声明序错 / props 回调未保护）全部由它抓到。
- 已验证 · 真机出现：用户截图确认角色、头顶气泡、计数徽章都正常渲染（当时还是 `data:` 内联方案）；
  D1 改成宿主路由后，**真机渲染未复测**——见下面「未验证」。
- 已验证 · 观感：`preview.still.html` 按 DSH 框架几何（40px 标题栏 + 240px 侧边栏 + 会话头 + `inset:0`
  的 overlay 层）截图核对——96px 下 Lead 头肩能看清脸、四个成员 Q 版尺度一致、`provisioning` 的三点与
  抱膝帧正确、名字带描边在浅底可读；`art.still.html` 在 220% 下核对边缘无白边。
- 已验证 · 经典皮肤：素材未就绪或加载失败时（`ART` 为空 / manifest 失败）整层自动退回矢量鲸鱼，摆尾与喷水动画在 CSS 里。
- 已验证 · 默认层组合（2026-10-30，用真实 `composeEntries` + 真实 `dsh-base`/`dsh-web-app` 补丁复算）：
  叠加后**恰好触碰 8 行**（4 行 `disabled: true` + `agent-whales` + 团队三行 insert），**零 warning**，
  `agent-team` 的 config 与官方 profile 补丁逐字段一致。
- 已验证 · 互斥性：本插件补丁 + 官方 `agent-team-profile` 补丁同时应用 → `agent-team` /
  `tool-agent-team` / `ui-agent-team` 各重复 2 次 → `cordis-plugin-loader/lib/index.js:91`
  抛 `TypeError: duplicate loader entry id`，`Include._apply` 直接失败，**DSH 不启动**（不是「补丁覆盖」）。
- 已验证 · 关闭步骤：把 §关闭团队 / 回滚 A 的 7 行叠在 `$DSH_HOME/cordis.patch.yml` 上复算 →
  团队三行 `disabled: true`、四条 `tool-subagent*` 回到 `disabled: false`、鲸鱼保持启用、
  团队行仍只有一份、零 warning（原理：补丁逐键覆盖，`dsh-app-boot/lib/index.js:102-105`）。
- 已验证 · 拖拽健壮性：`pointercancel`（滚动/切窗口）不会把角色甩到队形原点；`(0,0)`、`NaN`、离谱坐标读取侧一律忽略。
- 已验证 · 拖拽渲染：把某只的坐标写进 store 后，它在离屏页面里以 `position:absolute` 落点，
  它的子 agent 自动跟到右下 30/12px；没拖过的仍在队形里。
- 未验证 · 拖拽手感：`pointerdown/move/up` 的真实拖动手感（包括拖出层边界、触屏）没法离线验证，
  只验证了坐标换算与落点渲染。
- 未验证 · 真机对位：`96px` 比旧版 `46px` 高，加上任务行与头顶气泡，整个簇会压到会话头与第一行内容；
  用「尺寸预设·紧凑」或「垂直偏移」调。
- 已验证 · 串门开关（宿主侧）：`GET /agent-whales/api/activity` 带 `visitTools` + `controlToken`；
  `POST /agent-whales/api/visit-tools` 无/错 token → 403 且状态不变，坏 body → 400，正确 token +
  `{enabled:false}` → 204 且四个工具**从注册表真的消失**，`{enabled:true}` → 204 恢复且
  `parameters.type === "object"`；GET/PUT/PATCH/DELETE 打到该路由 → 405；并发 toggle 不重复注册。
- 已验证 · 串门开关（客户端侧）：点击发出正确的 `x-whales-token` 与 `{enabled}`；403/500/网络失败
  一律把 UI 回滚到宿主真相；未拿到首次快照前开关 `disabled`；连点只发一个请求；老宿主（响应里没有
  `visitTools`）整行隐藏。设置面板显示值**只来自宿主快照，不落 `localStorage`**。
- 未验证 · 串门开关端到端：「关掉后 4 个工具定义确实不再进模型请求」这条只能由宿主侧注册表证明
  （已完成），真实模型请求 payload 未抓包；真实浏览器里点开关、真实 403 触发也未跑。
- 未验证 · HMR 时序：热重载时若新实例注册早于旧实例注销，可能短暂出现「新实例该工具未注册」，
  客户端下一次轮询会如实显示 `visitTools:false`，重新打开即可自愈；未在真机复现。
- 未验证 · 在缺少 `@deepseek-ai/dsh-experimental-*` 的 DSH 上安装：按代码推断会拒绝启动
  （`assertEntriesLoaded` 抛 `plugin(s) failed to load`），未在真机上复现。
- 已验证 · M6 工作台逻辑：`npm test` 全绿（其中 `test/workbench.test.mjs` 18 个用例专测工作台：
  路由 round-trip 与非法回落、CJK token 估算、简报预算按序填充/超限丢弃/`omitted`、
  任务行 `ready` 与「前置已删除 / 等待前置」、report 人机边界（worker 只能写 done/draft 或发起退回）、
  待办四组计数、画布节点三类派生与落点去重、画布连线跳过自连/缺失端、深浅主题 token 键集合一致）。
- 已验证 · M6 十屏都渲染得出东西：`_scratch/wb-preview.mjs` 用假宿主数据把十屏渲染成静态 HTML，
  `_scratch/wb-preview-check.mjs` 逐屏数关键元素（列表 4 统计 + 3 项目卡、画布 10 节点、
  任务表 7 行、简报 4 张对话简报卡、执行台 3 张工单卡、待办 4 条、发送记录 6 行），
  `_scratch/wb-css-check.mjs` 校验 CSS 花括号配对、16 个 token 两套主题都在、组件无硬编码 hex。
- 已验证 · M6 宿主路由：`test/index.test.mjs` 覆盖 report 四态 + CAS 40902 + worker 越权 40708 +
  人可关、落点字段落库、handoffs 项目过滤与倒序、inbox 四组聚合（含只读降级）、
  sessions 目录形状、POST /tasks 新建与 requestId 回放、preset 安装器（首装 / 幂等 / 不覆盖 / 源不齐不建目录）。
- 未验证 · M6 画布交互手感：拖拽挪位、Ctrl+滚轮缩放、拖锚点建线、点选删除——垫片里
  `useState` 的 setter 是空函数，只能验证几何换算（`wbCanvasEdges` / `wbCanvasNodes`）与渲染，
  真实指针事件的手感与「拖出边界」未跑。
- 未验证 · M6 真机对位：工作台跑在 `main` 槽里，与官方会话页的切换、侧栏 `panellist` 入口的
  实际图标位姿未跑。
- 已验证 · 「记住上次选择」：`wbRoute` 每次 set 都写 `dsh-agent-whales.last-view`，加载时 recall
  （脏 kind / 坏 JSON / 缺 projectId 一律回落 list）；**首次无记录仍是列表**，不默认进画布。
  仍未验证的是「真实 DSH 里的侧栏入口位姿」。
- 已验证 · W1.5 事件台（浏览器侧）：`test/workbench.test.mjs` 覆盖筛选项词表、健康码五个固定词
  （ready/assessing/suppressed/idle/noise，与设计字面的「已忽略」偏差见上）、展开态
  （pending 给三条规则 + 三个动作；已处置只读且露工单号）、页面渲染（事件行 + 健康面板五列 +
  收起来的行不露规则）、开工单的项目上下文回退（工作台项目 → 事件自己的项目）、空数据占位。
- 已验证 · W1.5 事件台（宿主侧）：`test/index.test.mjs` 81/81——四类 kind 落库、三条规则命中/未命中、
  自激保护（空白归一化同指纹 / 10 分钟窗口 / 过期恢复）、噪声闸（未过期不评估、过期恢复）、
  open 真建单 + 重复 40904 + requestId 回放 + projectId 回退 + 40000/40401/403、ignore 留痕、
  noise 写 24h 屏蔽、GET /events 的 source/state/limit/stats/倒序/跨项目、health 五词表递进、
  四个 ingest 接线点逐一落库、events.json 损坏时 ingest 静默不拖垮主流程。
- 未验证 · W1.5 真机 ingest 时机：四个接线点（提案提交 / 任务命令 / 交接结果 / 存储降级）在真实
  会话里的触发时序未跑；2000 条滚动归档与并发 open 只建一单用仓库外临时脚本验过（未落库）。
- 未验证 · 事件来源边界：主会话消息 / 工作区文件监听 / 定时三类 Source 本期不接（README 已记账），
  接入前需要可靠的会话消息钩子与带自激保护的 fs 监听方案。
- 已验证 · W2 event_replay（宿主侧）：`test/index.test.mjs` 96/96——六步各自派生（来源提案 /
  无来源 skipped / blockedBy 挡过 + 解锁时间 / dispatch 三态 / report 四态 / 已完成 until+计数）、
  entries 三处聚合 + 倒序 + 去重 + limit、observations 全边界（当前工具与 /activity 同源且结果事件后消失 /
  无 owner / 会话不在跑 / tail 倒序 + 两种日志形状 + counts + 封顶）、405+allow、宽松回空与 40401、
  纯函数畸变输入 lossless。
- 已验证 · W2 event_replay（浏览器侧）：`test/workbench-replay.test.mjs` 6 例——六步固定、
  缺步补 pending、未知 key 追加尾部、明细倒序、色调映射、弹层渲染（六步 + observations + 明细 +
  脚注）与坏数据兜底（空 steps / observations 5xx 不炸）；`_scratch/wb-preview.mjs` 出 replay.html 静态预览。
- 已验证 · W2 提案带入与目标条（浏览器侧）：`test/workbench-draft.test.mjs` 21 例——`wbDraftPrefix`
  只含版本+编号且逐词断言无指令措辞、`wbInsertDraft` 三态（inserted / copied / failed）与逐层降级、
  目标条无提案时只有引导语且**不带入按钮**、input.dock 座位无 priority（D2 硬约束）。
- 未验证 · W2 真机：`input.dock` 的 standard props 是否真按契约送到（inputActions / sessionId /
  useSessions）、目标条在官方 composer 里的观感与暗色适配、`insertText` 在真实编辑器里的可撤销性、
  六步时间线在真实任务上的完整度（fixture 只覆盖了常见形状）。
- 未验证 · W2 升级判定（D2 递进）：目标条点击率 ≥15% / 观察窗口 2 周或 200 会话——需要真实使用数据，
  达标后才考虑影子 `conversation.composer`；本期不影子。
- 已验证 · MCP 约束层（宿主侧）：`test/mcp-constraint.test.mjs` 16 例——连线表读写 round-trip、
  前置校验（MCP 未连接 40709 / 非项目成员 40710）、`?all=1` 全清、guard 对非 MCP 工具一律放行、
  guard 对表外会话放行、guard 拦下表内会话的未连接 MCP、`sessionIdOfAgent()` 剥前缀、
  存储损坏时降级为只读不拖垮启动。
- 已验证 · MCP 约束层（浏览器侧）：`test/mcp-canvas.test.mjs` 10 例 + `test/mcp-canvas-render.test.mjs`
  8 例。纯函数覆盖三类节点派生、连线对派生、按会话的允许集合、MCP 节点 id 判别；
  渲染覆盖已连接/未连接 chip、Agent 徽标（Composer 不显示）、无服务占位、mcp-links 挂掉不崩；
  **交互覆盖「连线即约束」主链路**——拖 Agent 锚点到 MCP 节点真的发出 `POST /mcp-links`
  且带 `{server, sessionId}`、重复约束被本地判重挡下不发请求、一键全清发 `DELETE ?all=1`、
  没有约束时不摆全清按钮。交互测试靠 `test/harness.mjs` 新增的 `createMount()`（带真实
  `useState` 的迷你 React，setter 真的改 hook cell 并触发重渲染）。
- 已验证 · 并发身份不串（探针实证）：落盘探针复读到 **300 条 / 4 个 agent**（1 主会话 + 3 worker），
  **6/6 对时间窗全重叠**、**同一个 5 秒窗口挤进 4 个 agent**、**相邻 299 条里 199 次换 agent**；
  **300/300 条 `agentId === sessionId`**。说明 `exec.agent` 给的是可靠的会话级身份，
  并发跑多个任务时约束表按 `sessionId` 查不会互相干扰。附带实证：被放行的 12 种工具里
  `pwsh` 出现 90 次——按 `ToolRestriction.allow` 实现会把 shell 和文件读写一起删掉。
- 未验证 · MCP 约束层真机：**DSH 未运行**（`127.0.0.1:56981` 无监听，`curl` 返 `HTTP 000`），
  实时 HTTP 未跑；探针里 **`mcp__` 调用 0 条**（当时没连 MCP），所以「guard 真的拦下未连接的
  MCP」只有单测覆盖，要连一个 MCP 再跑一轮才算闭环。
- 未验证 · 画布上断开 MCP 服务：占位按钮只负责引导，真正断开仍要在 DSH 设置里做。
