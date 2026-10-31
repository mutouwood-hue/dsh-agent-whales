# 运行时状态信号采集设计（v0.23 前置）

> 状态：**设计稿，待评审后实施**
> 日期：2026-10-30 · 作者：DSH agent（Lead）· 归属：`dsh-agent-whales`
> 关联：PRD §35.14.4（6 张待接线素材）、§35.15.3（解锁方案）
>
> 本文回答一个问题：**要让人物表情真的对应「它在干什么」，每个信号从哪来、怎么取、取不到怎么办。**
> 素材那边已经就绪（6 张已验收/基本通过），缺的只是信号与状态机。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 信号够不够 | **够**。DSH 宿主已经发了思考、失败、回合结束三类事件，不需要改宿主内核 |
| 要不要改宿主 | **要，但只改本插件自己的宿主半边**（`lib/index.js`）：订阅事件、聚合成一个只读快照，挂在已有的 `/agent-whales/api/activity` 上 |
| 客户端 | 复用现有 2s 轮询 + `useSessions` / `sessionStatus`；状态推导放客户端，宿主只做事实采集 |
| 能点亮几帧 | **9 张**：`q-think`、`q-oops`、`q-cry`、`q-heart`、`m-think`、`m-oops`、`c-think`、`c-oops`、`c-done` |
| 主要风险 | 状态抖动（需去抖）、旧宿主无新字段（需降级）、庆祝帧与退场帧抢同一个时机 |

---

## 1. 插件今天知道什么、不知道什么

| 已经知道 | 来源 |
|---|---|
| 每个会话在不在跑 | 客户端 `useSessions` / `sessionStatus`；宿主 `agent.status` |
| 当前正在跑哪个工具 | 宿主监听 `tools/execute` / `tools/result` → `GET /agent-whales/api/activity` 的 `active[sessionId].tool` |
| 团队 roster / 任务 | `agentTeam` 投影（客户端已有的 `useProjection`） |
| 皮肤、心情轮换、入场/退场 | 插件自己的设置与 tick |

| 不知道（本设计要补） | 缺什么 |
|---|---|
| 思考态（在等模型、还没出工具） | 没有「模型正在生成」的信号 |
| 失败态（工具失败 / 模型报错） | 只上报工具名，不上报结果是否失败 |
| 完成态（这一轮干完了） | 没有「回合结束」的信号 |

---

## 2. 信号总表

所有宿主信号都是 cordis 事件，根 ctx 上的监听能收到**所有 agent** 的（事件声明里的 "Scope-filtered dispatch" 指 agent 作用域监听只看自己，根作用域不受限）。
契约证据取自本机解包的真实 DSH 安装：
`C:\Users\admin\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

| # | 信号 | 宿主事件 | payload 关键字段 | 语义 | 延迟 | 可靠性 | 用于 |
|---|---|---|---|---|---|---|---|
| S1 | 会话状态翻转 | `agent/status` | `{ agent, status }`，`status: 'idle' \| 'running'` | 驱动是否在跑 | 即时 | 高 | 全部状态的底噪判断 |
| S2 | 模型开始/结束输出 | `agent/assistant-stream` | `{ agent, frame }`，`frame.type: 'start' \| 'chunk' \| 'end'` | 正在等/收模型 | 即时 | 高 | 思考态（精确版） |
| S3 | 步骤开始 | `agent/pre-step` | `{ agent, messages, turn, step, signal }` | 新一轮步骤 | 即时 | 高（waterfall，必须 `next()`） | 思考态（粗粒度） |
| S4 | 回合即将关闭 | `agent/turn-stopping` | `{ agent, turn, signal }` | **这一轮干完了** | 即时 | 高 | 完成/庆祝态 |
| S5 | 工具结果 | `tools/result` | `(exec, result)`，`result.isError: boolean`；失败时 `result.error: ToolFailure` | 工具成功/失败 | 即时 | 高 | 失败态（工具侧） |
| S6 | Agent 报错 | `agent/error` | `{ agent, turn, step, error }` | 步骤/回合失败 | 即时 | 高 | 失败态 |
| S7 | 模型请求失败 | `agent/request-error` | `{ agent, turn, step, provider, failure, retryPolicy, signal }`（waterfall） | LLM 侧失败 | 即时 | 中（可能被重试政策吞掉） | 失败态（模型侧，弱信号） |
| S8 | 团队任务全完成 | 客户端 `agentTeam` 投影 | `{ members, tasks, failure }` | 整队收工 | 2s（轮询） | 中（依赖团队包） | `q-heart` 比心 |
| S9 | 会话在跑（客户端视角） | 客户端 `sessionStatus` | `running: boolean` | 与 S1 等价的视图 | 即时 | 高 | 旧宿主降级路径 |

**契约证据（逐条可核）**

| 事实 | 位置 |
|---|---|
| `agent/status` 的 payload 与「idle = 没有 driver 被调度」 | `dsh-agent/lib/types/runtime-types.d.ts:247`、`:240-244` |
| `AgentStatus = 'idle' \| 'running'`（**没有 failed**） | `dsh-agent/lib/types/index.d.ts` 导出处 |
| `agent/assistant-stream` 帧类型 `start/chunk/end` | `dsh-agent/lib/types/runtime-types.d.ts:375` + `AssistantStreamFrame` 定义 |
| `agent/turn-stopping` = 模型不再欠回应、回合即将提交 | `dsh-agent/lib/types/runtime-types.d.ts:396` 及注释 `:379-395` |
| `agent/error` payload | `dsh-agent/lib/types/runtime-types.d.ts:411` |
| `agent/request-error` 是 waterfall、忽略返回值会误吞 | `dsh-agent/lib/types/runtime-types.d.ts:357` |
| `tools/result` 的 result 带 `isError` / 失败时带 `error: ToolFailure` | `dsh-tools/lib/types/index.d.ts:250`、`:391-404` |
| `agent/pre-step` 是 waterfall | `dsh-agent/lib/types/runtime-types.d.ts:313` |
| 客户端会话列表快照形状 `{ ids, byId, current, phase, ... }` | `dsh-api-session-controller/lib/types/client/sessions/service.d.ts:61` |
| 客户端会话运行态 `handleSessionStatus(sessionId, running)` | `dsh-api-session-controller/lib/types/client/sessions/manager.d.ts:241` |

---

## 3. 推荐架构：宿主采集事实 + 客户端推导状态

```
              ┌──────────────── 宿主半边 lib/index.js ────────────────┐
 agent/status │                                                        │
 stream start │   ① 事件订阅（根 ctx，收全部 agent）                    │
 turn-stopping│        ↓ 聚合成「每会话最近事实」                       │
 tools/result │   ② 只读快照  state[sessionId] = {…}                   │
 agent/error  │        ↓                                               │
              │   ③ GET /agent-whales/api/activity 追加 state 字段       │
              └───────────────────────┬────────────────────────────────┘
                                      │ 2s 轮询（已有）
              ┌───────────────────────▼────────────────────────────────┐
              │ 客户端 lib/client.js                                    │
              │   ④ 状态机：把事实 + 本地 tick 推成「该画哪一帧」         │
              │   ⑤ 去抖 + 最短展示时长 + 优先级                         │
              └────────────────────────────────────────────────────────┘
```

**为什么不全放客户端**：失败信号（S5/S6/S7）客户端根本看不到；团队任务虽有投影但拿不到工具失败。
**为什么不全放宿主**：帧选择要跟已有的心情轮换、眨眼、入场/退场、拖拽、设置联动，宿主不该管表现层。

---

## 4. activity 路由扩展（向后兼容）

现有响应（客户端已在用，**不可破坏**）：

```json
{ "at": 1793326897556,
  "active": { "<sessionId>": { "tool": "pwsh", "ageMs": 1232 } },
  "visitTools": true,
  "controlToken": "…" }
```

**只追加一个字段**，旧客户端忽略即可：

```json
"state": {
  "<sessionId>": {
    "since": 1793326890123,        // 进入当前状态的时间戳（ms）
    "thinking": true,              // 正在等/收模型（S2 start→end 之间，或 S3 之后无工具）
    "streaming": true,             // 精确：assistant-stream 处于 start..end 之间
    "lastErrorAt": 1793326880000,  // 最近一次失败（S5 isError / S6 / S7）
    "lastErrorKind": "tool",       // "tool" | "agent" | "request"
    "lastTurnEndAt": 1793326890000,// 最近一次回合关闭（S4）
    "runStartedAt": 1793326850000  // 本轮 running 的起点（S1 running 时记录）
  }
}
```

约束：
- **只保留最近 N=256 个会话**（与 `active` 表同口径），`pruneActivity` 一起清。
- 字段全部是基本类型，**不允许 undefined 键**（宿主按 lossless JSON 校验返回值；这是历史事故点）。
- 时间戳一律 `Date.now()`；如果 S4 落在 S1 idle 之前/之后有 1 帧抖动，以 S4 为准。
- 失败记录只在 60 秒内有效（`lastErrorAt` 老于 60s 视为过期），避免一次失败让角色一直哭。

---

## 5. 状态机（客户端）

### 5.1 状态与优先级

```
failed > thinking > working > celebrating > idle
```

| 状态 | 判定 | 展示帧（Q 版 / 成熟版 / 经典） | 退出条件 |
|---|---|---|---|
| `failed` | `now - lastErrorAt < 8s` | `q-oops` / `m-oops` / `c-oops` | 8s 到期，或进入 celebrating |
| `thinking` | `running && !activeTool && (streaming \|\| since < 3s)` | `q-think` / `m-think` / `c-think` | 工具开始、或本轮结束 |
| `working` | `running && activeTool` | 心情池（现状） | 工具结束 |
| `celebrating` | 刚发生 `turn-stopping` 且本轮运行 ≥ 5s | `q-cry` / `m-proud` / `c-done` | **固定 6s** |
| `teamDone` | 团队全员 idle 且任务全 completed | `q-heart`（仅 Q 版） | 6s |
| `idle` | `!running` | `q-sleepy` / `m-base` / `c-idle` | 重新 running |

### 5.2 去抖与节流（必须有，否则角色会抽风）

- **状态稳定 1.5s 才切换**：任何状态持续 < 1.5s 的抖动直接忽略（思考↔工作之间最容易抖）。
- **庆祝帧最短 6s、最长 6s**：固定时长，不放任信号决定；同一会话两次庆祝间隔 ≥ 30s。
- **失败帧最短 4s**：连续失败不重复触发，只重置计时。
- **优先级抢占**：`failed` 可立即打断 `working`/`thinking`；`celebrating` 不可被 `thinking` 打断（否则刚收工又开始思考）。
- 所有计时器**基于现有 8s tick**，不新增定时器（避免又来一次「关掉插件还在轮询」的 bug）。

### 5.3 与现有帧的关系（不要打架）

| 现有机制 | 冲突点 | 处理 |
|---|---|---|
| `exit` 变体（`q-proud`/`m-proud`） | 与 celebrating 抢同一时机 | **celebrating 优先**；`exit` 只在 celebrating 已过期后用于淡出 |
| `sleepy`（收工抱膝） | 与 idle 抢 | celebrating 结束后回去 `sleepy`；celebrating 期间不睡 |
| 心情池轮换（每 3 tick） | 与 thinking 抢 | thinking 期间**暂停轮换**（否则思考态一闪而过） |
| 眨眼帧 | 无冲突 | 保持，thinking 也眨 |

---

## 6. 帧映射总表（素材现状 × 目标状态）

| 状态 | Q 版 | 成熟版 | 经典 | 素材状态 |
|---|---|---|---|---|
| base | `q-smile` ✅ | `m-base` ✅ | `c-idle` ✅ | 已接入 |
| blink | `q-blink` ✅ | `m-blink` ✅ | — | 已接入 |
| entry | `q-wave` ✅ | **`m-wave` ✅** | `c-idle` | 已接入 |
| working | 心情池 ✅ | 心情池 ✅ | `c-work` ✅ | 已接入 |
| sleepy/exit | `q-sleepy`/`q-proud` ✅ | `m-base`/`m-proud` ✅ | `c-idle` | 已接入 |
| **thinking** | `q-think` 🟡 | `m-think` 🟡 | `c-think` 🟡 | 候选已验收，**待接入** |
| **failed** | `q-oops` 🟡 | `m-oops` 🟡 | `c-oops` 🟡 | 候选已验收，**待接入** |
| **celebrating** | `q-cry` 🟡 | `m-proud` ✅（无 m-done） | `c-done` 🟡 | **待接入** |
| **teamDone** | `q-heart` 🟡 | — | — | **待接入** |

图例：✅ 已在运行时 · 🟡 已验收待接入 · 空格/— 无此素材

素材来源：§35.14.4（6 张）、§35.12.3（q-think/q-oops/q-heart）、§35.15.3（q-cry）。

---

## 7. 降级与兜底

| 场景 | 行为 |
|---|---|
| 宿主还没升级（响应里没有 `state` 字段） | 客户端退回纯本地推断：只用 `sessionStatus` 与 `active`；能出 thinking（running 且无工具）与 celebrating（running→idle），**失败态不显示** |
| `agent/request-error` 被重试政策吞掉 | 只认 `tools/result.isError` 与 `agent/error`，不依赖 S7 |
| 团队包没装 | `teamDone` 永不触发；其余状态不受影响 |
| 会话被 kill / `agent/disposed` | 立即清掉该会话的 state 与计时器（与 `pruneActivity` 同路径） |
| 状态字段脏（非数字时间戳等） | 逐字段类型守卫，脏值当「没有该事实」，**不允许抛错、不允许产出 undefined 键** |
| 页面隐藏 | 现有 `visibilitychange` 逻辑保持：隐藏时不轮询；回前台立刻补拉一次，**庆祝态不补播**（错过的就用过） |

---

## 8. 测试计划

| 层 | 用例 |
|---|---|
| 宿主纯函数 | `state` 聚合器：空表、并发工具（一个成功一个失败）、错误过期（60s）、时间戳脏值、256 上限裁剪、序列化往返等价（无 undefined） |
| 宿主事件 | 伪 ctx：发 `agent/status` / `tools/result(isError)` / `agent/turn-stopping` / `agent/assistant-stream` 后快照变化正确；waterfall 监听必须 `next()` 放行 |
| 客户端状态机 | 优先级（failed 抢占 thinking）、去抖（1.4s 抖动忽略）、celebrating 固定 6s、30s 节流、心情池暂停、无 `state` 字段时的降级 |
| 回归 | 现有 122 用例必须全绿；新增用例覆盖每个状态至少 1 条正向 + 1 条边界 |
| 真机 | 跑一次真实任务，观察：思考→干活→收工 三段是否按预期换帧；故意让工具失败一次看 oops；团队任务全完成看比心 |

**不接受**：把「信号可能缺失」用假数据补上；把没验证的状态标成已支持。

---

## 9. 分阶段实施

| 阶段 | 内容 | 产出 | 估时 |
|---|---|---|---|
| P0 | 宿主：订阅 S1/S4/S5/S6 + `state` 字段 + 降级；客户端：celebrating + thinking（不含失败） | 点亮 `q-cry`、`c-done`、`q-think`、`m-think`、`c-think`、`m-wave` 已就位 | ~半天 |
| P1 | 客户端：failed 态 + 去抖节流完整化；点亮 `q-oops`、`m-oops`、`c-oops` | 9 张全部上屏 | ~半天 |
| P2 | `teamDone` + `q-heart`；宿主补 S7（模型失败） | 团队级庆祝 | ~2h |
| P3 | 真机验收 + PRD/README 同步 | 收口 | ~2h |

---

## 10. 待决问题（需要拍板）

1. **庆祝帧时长**：6s 够不够？还是 4s / 8s？
2. **失败帧是否只在「我这台机器」可见**：`m-oops`/`c-oops` 表达的是「出错」，如果用户不希望把错误显性化（观感），可以只在设置里默认关。
3. **`m-oops` 与 `m-shy` 在 96px 下仍偏像**（见 §35.14.4）：是接受（两者语义不同、出现时机不重叠），还是让画师再拉开一档（比如出错改成扶额 + 简洁的「!」气泡线）？
4. **思考态是否需要**：如果用户觉得「角色老是托腮」反而奇怪，可以只在 `streaming` 时短暂显示，其余仍走心情池。
5. **经典皮肤要不要同步**：`c-*` 三帧已通过画布对齐，但它依赖同一套信号；若经典皮肤默认关闭，可以先不接。

---

## 11. 附：本轮不做什么

- 不引入新的数据源（不读 session 日志、不扫文件系统）。
- 不改 DSH 内核、不依赖未发布的 API。
- 不做「按工具名猜状态」（`bash` 成功/失败不能靠名字判断）。
- 不在宿主里做表现决策（帧选择、去抖都在客户端）。
