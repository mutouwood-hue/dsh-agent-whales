import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 宿主函数是 lib/index.js 的具名导出，不在插件的 __test 里——那是浏览器半边的入口。
import * as host from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "tool-probe-concurrency.json"), "utf8"));

const { sessionIdOfAgent, mcpServerOfTool } = host;

// 这一份 fixture 来自 DSH 真机探针（4 个 agent 并发跑了 16 分钟）。
// 它存在的意义：把「exec.agent 给的 identity 长什么样」从一次性观察变成回归。
// 谁要是改了 sessionIdOfAgent 的剥前缀逻辑，这里立刻红。

test("实测契约：每条 agentId 都能剥成会话 id，主会话剥完就是 mainSessionId 形状", () => {
  assert.ok(fx.agents.length >= 4, "fixture 至少 4 个 agent，实际 " + fx.agents.length);
  for (const agent of fx.agents) {
    const bare = sessionIdOfAgent({ id: agent.agentId });
    assert.equal(bare, agent.agentId.replace(/^session-/, ""), agent.agentId + " 剥前缀结果不对");
    assert.ok(bare.length > 0, "剥完不能是空串：" + agent.agentId);
    // 会话 id 是 uuid；剥完之后不该再留下 session- 前缀
    assert.equal(bare.indexOf("session-"), -1, "剥完还带前缀：" + bare);
  }
});

test("实测契约：agent.session.id 与 agent.id 不一致时以 agent.id 为准", () => {
  // 探针 300/300 条两者相等，所以这条是防御性的：万一哪天 DSH 只填其中一个
  const main = fx.agents.filter((a) => a.isMain)[0];
  assert.equal(sessionIdOfAgent({ id: main.agentId, session: { id: "someone-else" } }), main.agentId.replace(/^session-/, ""));
  assert.equal(sessionIdOfAgent({ session: { id: main.agentId } }), main.agentId.replace(/^session-/, ""));
  assert.equal(sessionIdOfAgent({}), "");
  assert.equal(sessionIdOfAgent(null), "");
  assert.equal(sessionIdOfAgent("not-an-object"), "");
});

test("实测契约：并发确实发生过，且身份不串", () => {
  // 6/6 对时间窗重叠 + 同一个 5 秒窗口 4 个 agent + 相邻 199 次换人
  assert.ok(fx.maxAgentsInFiveSeconds >= 2, "同一个 5 秒窗口至少要 2 个 agent 才算并发");
  assert.ok(fx.adjacentAgentSwitches > 0, "相邻调用换过 agent 才说明调用是交错到来的");
  assert.equal(fx.totalCalls, fx.agents.reduce((sum, a) => sum + a.calls, 0), "各 agent 条数要能对上总数");
});

test("实测契约：被放行的工具里没有一个是 MCP 工具", () => {
  // 这是「guard 只拦 mcp__、其余一律放行」的实证：12 种工具 300 次调用全部通过
  assert.equal(fx.mcpToolCalls, 0, "fixture 记录里不该有 mcp__ 调用");
  assert.ok(fx.nonMcpToolKinds.length >= 10, "放行过的工具种类至少 10，实际 " + fx.nonMcpToolKinds.length);
  for (const name of fx.nonMcpToolKinds) {
    assert.equal(mcpServerOfTool(name), "", name + " 不该被当成 MCP 工具");
  }
  // 反面对照：真的是 MCP 工具时要能取出服务名
  assert.equal(mcpServerOfTool("mcp__pencil__batch_get"), "pencil");
  assert.equal(mcpServerOfTool("mcp__github__create_issue"), "github");
  assert.equal(mcpServerOfTool("mcp__"), "");
  assert.equal(mcpServerOfTool("pwsh"), "");
  assert.equal(mcpServerOfTool(""), "");
});

test("实测契约：主会话不会被误当成 worker", () => {
  const main = fx.agents.filter((a) => a.isMain)[0];
  const workers = fx.agents.filter((a) => !a.isMain);
  assert.equal(workers.length, 3, "3 个 worker");
  assert.notEqual(sessionIdOfAgent({ id: main.agentId }), sessionIdOfAgent({ id: workers[0].agentId }));
  // 画布不给主会话连线，所以它永远不进 mcpLinks → 默认全放行。
  // 这里只钉住「身份能区分」，放行逻辑由 mcp-constraint.test.mjs 覆盖。
});
