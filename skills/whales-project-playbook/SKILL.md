---
name: whales-project-playbook
description: dsh-agent-whales 的项目协作协议手册——在一个鲸鱼项目里怎么派活、盯进度、留记忆、串门协作。当你要给这个项目建任务/提案、读或写项目简报、在画布上摆节点或连关联线、给别的会话发消息或回放它的执行轨迹，或拿不准「已报完工」与「已核对」的边界时使用。只描述本插件提供的工具与边界，不授予任何额外权限。
---

# 鲸鱼项目协作协议（playbook）

这个环境装了 `dsh-agent-whales`：项目 = 显式注册实体（一个对话只能属于一个项目，`40701`），
任务板、画布、简报、提案都挂在项目上。**你不是在通用聊天，你在一套有账本的协作协议里**——
按下面的顺序做事，能少踩九成的坑。

## 0. 先读简报，再动手

`whales_brief_read`（**无参**）一次拿到两份：**项目简报**（目标 / 决定 / 约束）+ **你自己的对话简报**
（职责 / 结论 / 产物）。它按需读取、不占每轮上下文；读不到就明说，不要猜项目要什么。

写回去用 `whales_brief_write`：项目简报**只有项目主对话能写**，对话简报**只能写自己的**；
带 `expectedVersion` 做 CAS（陈旧版本回 `40902`，重读再写，不覆盖）。
两层**共用 2000 token 总预算**（CJK 1 字 = 1 token，其他 4 字符 = 1 token），超了按序丢弃并返回
`truncated` / `omitted`——所以简报记**决定与理由**，不记流水账。

## 1. 派活：提案，不是 Markdown 清单

`whales_propose_tasks` 提交**结构化提案**（object，lossless JSON）：

- `items[]`：`key`（提案内唯一）、`title`、`description?`、`blockedByKeys?`（引用同提案内的 key）、
  `suggestedOwner?`（只是建议——确认时不写归属）、`expectedOutput?`、`writeScopes?`（写入范围声明）。
- `leadSessionId` 可省略：身份以执行上下文为准，冒充会被拒。
- 宿主校验：key 重复、`blockedByKeys` 不存在、成环——整份拒收，不是部分接受。
- **新版本覆盖旧版本**：旧提案的确认入口随之失效；改需求就交新版，别追加。

提案是**请求**，不是事实：任务要等人在画布上确认才落项目表。确认后按拓扑序逐项创建，
`key → 真实 taskId`。

## 2. 盯进度：证据分级，别把中间态填成绿

- `report.status === "done"` 只说「**已报完工**」，不等于有人核过——「已核对」是独立字段
  （`action:"verify"`，只有项目主对话能核，且只能核已报完工的任务）。
- report 四态：`done` / `draft` 执行器可写；`handed_back`（超 scope 退回）/ `human_action`
  **只能人关**，你只能发起。
- 「已产出 ≠ 已送达」：做完了不等于对方知道了；要通报就走串门（§4），别假设。
- 任务板与画布是**派生视图**：真相在 `projects.json` 的任务表里。

收到「已确认的前端设计」后，用 `whales_requirement` 的 `handoff_get` 加任务 ID 读取确认稿、源码目录和当前版本。看到 `reviewPending`，或 `currentVersion` 已高于交接的 `version` 时，先在回复里说明版本变动，按用户新确认的交接继续。用 `handoff_report` 提交 `taskId`、`expectedRevision` 和 `report`。进度用 `draft`，完工用 `done`，在 `artifacts` 附文件路径或预览链接。

## 3. 画布：只读

`whales_canvas_inspect` 看位置 / 关联线 / 成员（省略 `projectId` = 你所在的项目）。**你不能改画布**：
节点位置由人在画布上拖，**会话关联线由系统建**——成员加入项目时自动与主对话连一条线；
两个普通成员之间要通话，得**让用户在画布上把它们连起来**（或通过主对话转达）。
需求（标题 / 目标 / 验收点 / PRD）用 `whales_requirement` 读写。改同一个需求时保留 `reqId`，用 `expectedRevision` 防止覆盖。PRD 可写 Markdown 正文，也可引用工作区 Markdown 文件或已有 Notion / 网页链接。画板与流程图使用同一 `requirementId`。
负责人、返工上限、确认设计、标可接受**只有人能做**。

- **没有 `node_add` / `node_delete`**：节点是派生的——上下文节点来自任务落点
  （`worktree` / `execRoot`，入库前已做路径归一，同一目录只出一个节点）、Agent 节点来自项目成员、
  Composer 来自主会话。允许增删节点等于让你伪造这三种事实。
- **关联线 = 「允许互发消息 / 互读」**，没有线就发不了（`40707`）。自连被拒；重复连接幂等。
- 落点写任务时给**规范路径**：宿主会做词法归一 + 已存在时 realpath，但别指望它修大小写漂移之外的随意写法。

## 3.1 组件工坊：拼不出来的形状才写 TSX

轻量线框可用 `whales_prototype_draw`。完整设计、高保真页面和可交互原型用 `whales_design_write` 写 TSX 画板；同一轮回复里会附上写入成功的画板。

- **先读再写**：`whales_design_read` 的 `what:"list"` 看本项目已有哪些组件（能复用就复用，不重复造），
  `what:"pack-api"` 看当前组件库有哪些组件与 props——别凭记忆写 props 名。
- **用当前项目的风格**：先看工作区已有界面、组件与 token。用 `styleFiles` 加载工作区的标准 CSS（相对路径，按顺序应用），需要自由布局时直接写 TSX、内联 `style` 或 `export const css`。`@cds` 和 `@project/<组件名>` 都是可选的复用入口。
- **用户有参考图时按图设计**：保留图里的布局、字体、颜色和操作方式，在 `sourceMessageIds` 里引用提供图片的消息。
- **交付到对话**：`chatPreview: true` 表示画板已为本轮回复保存。正文说清这次改了什么，让用户直接试。
- **编译失败不写盘**：按返回的 `compile.errors`（行列 + 摘录）自己修，修完再写。
- **`render.status` 是 `unverified` 表示还没在浏览器里验过**——照实说还没验，**不要说「已验证效果」**。
- **新组件只属于当前项目**：不要对用户说「已加入 CDS」，也不要建议自动提交到 CDS；进不进设计系统由业务定。
- 人保存过 / 直接改过的元素会被**锁住**，你再写会返回 `locked`——这不是 bug，是「人先看过」的边界；
  只有人能解锁，如实告诉用户去点什么，别想办法绕过。
- 评论（`what:"comments"`）是用户点的具体位置（带行列）。改完在 `whales_design_write` 里带
  `resolvesComments: [评论 id]` 把它标为已处理；不存在的 id 会如实回在 `resolvedMissing` 里。
- 评论 / 导出（`/design/export`）/ 导入（`/design/import`）都**要同源 token**，agent 没有这些路径——
  这些是给人的操作，别承诺「我帮你导出了」。

## 4. 串门：先 list，再 send；回放用 trace

| 工具 | 什么时候用 |
| --- | --- |
| `whales_visit_list` | 发消息前先确认目标（id / 标题 / 在不在跑 / 哪个工作区） |
| `whales_visit_send` | 说话。**默认插话（steer）**：对方在跑的那一轮在下一个步边界注入，不用等整轮；要排队显式 `mode:"queue"`；`waitForReply:true` 阻塞等回话。**对方离线会自动唤醒**再发（输出 `resumed:true`）；唤醒失败就报错、一条消息也不发 |
| `whales_visit_read` | 读对方最近的对话文本行（默认 20 行，上限 100）——**只读活会话**。`trace:true` 改看**回合轨迹**：任务 / 正文 / 调过哪些工具 / 哪一步失败与原因 / 每轮终态；`turns` 默认 2、上限 20；活会话读内存、离线会话也读得到；不唤醒、不产生模型调用。`turns` 只配 `trace`，`limit` 只配文字行，混用会报错 |

**访问闸**（与发送同权）：只要一方在项目里，就必须**同项目 + 双方是成员 + 有关联线**
（`40703` / `40704` / `40707`）；双方都不在任何项目里才保持旧的自由串门。
拿不到执行上下文身份直接 `40301`，不静默跳过。

排查「它怎么把自己搞失败的」用 `whales_visit_read` 加 `trace:true`，别去 `message_worker` 式地追问——
那会多开一轮，还可能把对方带偏。

## 5. 事件台账与只读降级

`~/.dsh/agent-whales/` 下：`projects.json`（项目 / 成员 / 关联线 / 任务 / MCP 约束）、
`canvas.json`（位置，按项目分页 + revision）、`handoffs.json`（交接账本）、`events.json`（事件台账）、
`proposals.json`（提案）、`.agent-presets/`（执行器 preset）。

- store 损坏时插件**备份原文件 + 只读降级**：读仍可用（最后一次成功快照），写被拒。
  这时别反复重试写，先告诉人。
- 简报的 `readonly` 降级同理：按快照判定项目边界，不因为存储坏了就全放开。

## 6. 明确不做（别做，也别承诺）

- **不创建 / 不归档项目**，不删画布节点，不改别人的对话简报。
- **不代替用户确认提案**：提案的价值就在于人看过。
- **不自动发消息代替用户行事**：串门是你以 agent 身份说话，来源会如实标 `agent-message`。
- 执行器 preset（`dsh-agent-whales-worker`）是**执行 Session 专用**，不供手动选择；
  用户自己的会话仍用官方 `standard`。

## 7. 一页流程

```
读简报(whales_brief_read) → 弄清目标与约束
   ↓
派活：whales_propose_tasks（结构化、带依赖与写入范围）→ 等人在画布确认
   ↓
执行中：需要协作用 whales_visit_send（默认插话；对方离线会自动唤醒；没有关联线就让用户在画布上连）
   ↓
复盘：whales_visit_read 加 trace:true 回放轨迹（失败在哪一步、为什么）
   ↓
留记忆：whales_brief_write 写决定与理由（CAS，不记流水账）
```
