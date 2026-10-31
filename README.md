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

当前插件版本：**0.22.0**。

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
`meta.test.mjs`（发布门禁：清单契约、`files` 覆盖 `exports` 目标、patch 无 BOM/可解析、
默认 patch 只增量插入自己、`npm test` 覆盖全部用例）。

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
| `lib/index.js` | 宿主半边：注册「团队协作」策略段落（官方 `team:policy` 在时让位；`spawn_teammate` 不可见时不输出）、四个 `whales_visit_*` 串门工具（可运行时开关）；监听 `tools/execute` / `tools/result` 记「当前工具」，用 `GET /agent-whales/api/activity` 提供给浏览器半边，`POST /agent-whales/api/visit-tools` 接受开关。服务缺失一律静默降级 |
| `lib/client.js` | 浏览器半边：设置 store、计数逻辑（纯函数）、家族树、图层、设置页、状态表情状态机、素材 loader（**不含图片数据**，运行期从宿主路由按皮肤拉） |
| `cordis.patch.yml` | 默认层（**唯一真相**）：插入 `agent-whales` + 团队服务/工具/面板三行，并 `disabled` 掉旧 subagent 四行 |
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
| `test/index.test.mjs` | 宿主半边用例（策略段落注册与兜底、串门工具、活动接口） |
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
