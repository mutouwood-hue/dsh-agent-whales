# 波次 0 核实记录：等待输入 / 上下文占用的数据源（2026-11-17）

> 对应 PRD 增量「鲸鱼娘状态表现力增强」§八。结论全部来自宿主**解包源码**（`D:\干活\harness-asar-extract\agent\*`，
> 即 DSH 桌面版 runtime 的 `dsh-*` 包），不是凭记忆。引用格式：`包名/文件:行`。
> 这些行号是 2026-11-17 解包版本的位置，宿主升级后可能漂移，以符号名为准。

## 结论一览

| # | 问题 | 结论 | 宿主侧要不要新增监听 |
|---|---|---|---|
| 1 | 审批挂起的信号 | 客户端 `sessionStatus` 行的 `pendingInteraction.kind === "approval"` | **不要** |
| 2 | agent 提问的信号 | 同一个字段，`kind === "question"`（含 `"plan-review"`） | **不要** |
| 3 | 上下文占用量来源与口径 | `projectionsBySession[id].values.contextPressure`（`dsh-token-meter`），口径抄官方 `contextOccupancy` | **不要** |
| 4 | `agent/request-error` waterfall | 已有监听器 `return next()`，且 B/C 不加宿主监听，**本项不再相关** | — |

**波次 B（等待举旗）和波次 C（上下文血条）都是纯客户端读取，不碰宿主半边。**

## 1+2 等待输入：`pendingInteraction`

### 事实链

1. 审批：`dsh-user-approval` 的 `ApprovalService.request()` 经 `ctx.waterfall(..., "approval/request", ...)`
   （`dsh-user-approval/lib/index.js:177`）把请求交给 answerer；该事件被 `dsh-api-remotes` 转发给浏览器
   （`dsh-api-remotes/lib/index.js:27`，`mode: "waterfall"`）。
2. 浏览器终端 answerer 是 `dsh-client-ui-approval`：`answerApproval()` 构造 `PendingApproval`（`kind = "approval"`），
   并 `registerPendingInteraction(pending, ...)`（`dsh-client-ui-approval/lib/client.js:285-311`）。
   用户回答 / 请求被中止 / 委派时 `remove()`，信号随之消失。
3. 提问：`dsh-client-ui-user-questions` 同样注册（`lib/client.js:1906`），`kind` 为
   `"question"` 或 `"plan-review"`（`:186`）。
4. `dsh-client-ui-session` 把各域的待处理交互合并成**每会话一条**（`publishPendingInteractions`，
   `lib/client.js:934`，同会话多域并存按 precedence 取大），挂在 `uiSession.sessionStatus` 的行上：
   `{ running, pendingInteraction, completionUnread }`（`publishStatus`，`:977-993`）。
5. 官方侧栏 `dsh-client-ui-workspace` 用同一个字段给会话行画 `warning` 态徽标
   （i18n key `status.waitingApproval` / `status.planReview` / `status.waitingAnswer`，`lib/client.js:2076-2097`），
   只认三个 kind（`visiblePendingKind`，`:1049-1053`）：`approval` / `plan-review` / `question`。
   鲸鱼的「等你」与它是同一事实，不会出现侧栏说在等、鲸鱼说没在等。

### 鲸鱼怎么用

鲸鱼插件**已经**在读这张状态表的 `running`（`useSessionStatus`，README「计数口径」）。`pendingInteraction`
就在同一行，零新增订阅、零新增 RPC：

```js
var pend = status && status.pendingInteraction;
var waiting = pend && (pend.kind === "approval" || pend.kind === "question" || pend.kind === "plan-review");
```

### 已知限制（要在设置页 / 文档里如实说）

- **只在有浏览器连着时才有信号。** 信号是浏览器里的 answerer 产生的；没有浏览器连接时审批会 `unavailable`
  失败关闭（`dsh-user-approval` README「No built-in answerer」），也就没有「等你」可显示。这和「等你」本身的语义一致——
  它要告诉的就是浏览器前的人。
- 信号按**客户端会话作用域**产生：`answerApproval` 里 `ctx.sessions.scopeOf(owner)` 取不到会话就直接 `next()`
  （`:287`），此时不会出现 pending。teammate / 子 agent 只要在客户端有作用域就和 Lead 一视同仁。
- 同一会话同时有审批和提问时只显示 precedence 高的那一条（`plan-review` 2 > 其余 1）；对「举旗」这个二值表现没有影响。

### 不采用宿主侧 `ctx.on("approval/request")` 的理由

waterfall 的监听顺序决定我方监听器能不能看到整个挂起期（终端 answerer 若不调 `next()`，排在它后面的监听器根本不会触发），
README 明说「sibling listener order is not a policy-priority mechanism」。客户端字段是官方自己消费的公共契约，
比赌监听顺序可靠，也省掉一个会碰 waterfall 的宿主监听器。

## 3 上下文占用：`contextPressure`

### 事实链

- `dsh-token-meter` 注册三个投影 unit：`tokenUsage` / `contextPressure` / `contextBreakdown`
  （`dsh-token-meter/lib/index.js:696`，README「When session projections are available…」）。
- `contextPressure` 视图（`lib/index.js:490-493`）：

  | 字段 | 含义 | 何时缺 |
  |---|---|---|
  | `pressureTokens` | 最新一次 provider 上报的 prompt 大小（只含 prompt 侧，流式期间不动） | provider 还没上报用量 |
  | `projectedTokens` | 下一次请求 prompt 的预估 = `pressureTokens` + 面的增减（压缩后立刻反映） | 同上 |
  | `contextWindow` | 最新 `request/context` 记录里的路由窗口 | 路由没声明容量 |

  **三者全是可选**。
- 客户端：`session.projections` 一次返回该会话**全部**投影值，进每会话的 `ProjectionValueStore`，之后随推送更新
  （`dsh-api-session-controller/lib/client.js:3178-3212` `refreshProjections`，`:3613-3618` 汇入
  `projectionsBySession`）。所以它和插件今天读的 `projectionsBySession[lead].values.agentTeam`
  是**同一条通路**。官方 `dsh-experimental-client-ui-agent-team` 也在读 `projectionsBySession[member.id]` 的
  `modelSelection`，说明 teammate 的投影在客户端是有的。

### 占用率口径（抄官方，不自创）

官方对话页的 ContextMeter（`dsh-client-ui-conversation/lib/client.js:18627-18635` `contextOccupancy`）：

```js
function contextOccupancy(pressure) {
  var used = pressure && (pressure.projectedTokens != null ? pressure.projectedTokens : pressure.pressureTokens);
  if (used == null || !pressure || pressure.contextWindow == null) return null;   // 缺分子或分母：不画
  return Math.min(100, Math.round(used / pressure.contextWindow * 100));
}
```

鲸鱼的血条必须**一致**：同一个会话在官方对话页和鲸鱼头顶不能说两个数。「缺数据就不画」是硬规则，
不显示 0%，也不拿估计值凑。

### 已知限制

- **投影已载入才有数据。** Lead 与团队成员有；纯子 agent 会话在客户端没载入投影时没有，血条就不显示（不是 0%）。
- `contextBreakdown` 是启发式估计且不与 `projectedTokens` 相加，**不用**它做血条。
- `dsh-session-stats` **不是**来源：它只有轮次 / 步数 / 耗时（`dsh-session-stats/README.md`），与上下文无关。
  PRD 候选里的这一项作废。

## 4 `agent/request-error`

宿主半边已有的监听器（`lib/index.js` 的 `trackRuntimeState`）对 `agent/request-error` 无条件 `return next()`，
测试里有对应护栏。B / C 不新增宿主事件监听，所以这条约束对本批改动没有新增义务；以后若有人给它加监听，
仍须照抄「必须 `return next()`」。

## 对 PRD 的修正建议（待需求负责人确认后再改 Notion）

1. §三「审批挂起 / agent 提问」两行：「事件名待核实」→ 已核实，信号为客户端 `pendingInteraction.kind`，无需宿主监听。
2. §三「上下文余量」：候选 `dsh-session-stats` 作废；数据源为 `contextPressure` 投影，口径同官方。
3. §四 4.2「降级」一节（用 `whales_visit_send(waitForReply)` 的「等回话」充当等待态）**不再需要**，可删。
4. §四 4.1 / §十「最小驻留 600ms」：活动快照是客户端 2 秒轮询，去抖是死代码，已在代码里删除（见 `client.js` 注释）。
