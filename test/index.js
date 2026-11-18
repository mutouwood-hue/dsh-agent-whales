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
