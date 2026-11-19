/**
 * 测试入口汇总。
 *
 * 为什么要这个文件：Node 24 的 `node --test <目录>` 不再把目录展开成用例文件，
 * 而是把目录当模块入口解析；没有 index.js 时会报 MODULE_NOT_FOUND（实测
 * Node v24.21/v24.22）。`test/index.js` 作为目录入口被加载，再把四个用例文件
 * 全部 import 进来，`cd dsh-agent-whales && node --test test/` 因而可用。
 *
 * 等价的显式写法（不做目录解析、不会重复执行）：
 *   node --test "test/*.test.mjs"
 */
import "./client.test.mjs";
import "./index.test.mjs";
import "./home-paths.test.mjs";
import "./visit-trace.test.mjs";
import "./landing-path.test.mjs";
import "./bundled-skill.test.mjs";
import "./snapshot-export.test.mjs";
import "./client-robustness.test.mjs";
import "./meta.test.mjs";
import "./workbench.test.mjs";
import "./workbench-draft.test.mjs";
import "./workbench-replay.test.mjs";
import "./workbench-canvas.test.mjs";
import "./observe-tool-calls.test.mjs";
import "./mcp-constraint.test.mjs";
import "./mcp-canvas.test.mjs";
import "./mcp-canvas-render.test.mjs";
import "./mcp-concurrency-contract.test.mjs";
// 画布优先（PRD v2.2 九（续二））：从画布开始 / Composer 卡真对话面。
import "./canvas-first.test.mjs";
// 波次 3：新画布（React Flow 按需 chunk）与两种线。
import "./flow-canvas.test.mjs";
// 状态表现力增强·波次 D：画布 Agent 卡「唤醒」（浏览器半边；宿主半边在 index.test.mjs）。
import "./wake-agent.test.mjs";
// 波次 6：原型 chunk 行为（真 React 18；tools/flow-chunk 没装依赖时自动跳过并说明）。
import "./proto-chunk.test.mjs";
// 真 HTTP E2E：宿主半边跑在真 http server 上，真 socket 走完整闭环 + 重启持久化。
// 既有用例都是「假 fetch + 直接调 handler」，从没验过真实 TCP 上的一次请求/响应。
import "./e2e-http.test.mjs";
// 第二期 X1–X3：自动派任务的策略层（档位 / 闸门 / 审计的纯函数）。
import "./auto-dispatch.test.mjs";
// 第二期 X3：「执行」页自动派发面板（档位 / 放宽确认 / 速率 / 撤销窗口）。
import "./auto-panel.test.mjs";
import "./office.test.mjs";
// show_view 卡片 + 侧聊（2026-11-18）：宿主逻辑 / 视图 chunk（真 React）/ 真 HTTP 端到端。
import "./view-host.test.mjs";
import "./view-chunk.test.mjs";
import "./view-e2e.test.mjs";
// 需求主线 P0（2026-11-19）：需求实体的纯逻辑层——清洗 / 阶段推导 / 「未归类」迁移。
import "./requirements.test.mjs";
import "./requirements-http.test.mjs";
import "./requirements-ui.test.mjs";
