// 约束层 · 纯函数单测（客户端半边）。
//
// 重新规划 R2 之后画布上没有 MCP 节点了（wbMcpNodes / wbIsMcpNodeId 已删），剩下两件：约束表怎么适配成 {a,b} 对（设置页的矩阵也用它）、
// 会话被允许哪些服务（Agent 卡徽标用）。全部纯函数，不发请求、不碰 DOM。
import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "./harness.mjs";

const api = () => loadPlugin().plugin.__test;

const SAMPLE = {
  projectId: "p-1",
  available: [
    { server: "github", toolCount: 4 },
    { server: "pencil", toolCount: 12 }
  ],
  links: [
    { server: "pencil", sessionId: "s1", createdAt: 1 },
    { server: "pencil", sessionId: "s1", createdAt: 2 }
  ],
  members: [{ sessionId: "s1" }],
  mainSessionId: "main"
};

test("wbMcpLinkPairs：存储形状 {server, sessionId} 适配成连线 {a, b}", () => {
  const { wbMcpLinkPairs } = api();
  const pairs = wbMcpLinkPairs(SAMPLE);
  assert.equal(pairs.length, 2, "两条 link 两条线");
  assert.deepEqual(pairs[0], { a: "mcp:pencil", b: "s1", server: "pencil" });
  assert.deepEqual(wbMcpLinkPairs(undefined), []);
  assert.deepEqual(wbMcpLinkPairs({ links: [null, { server: "x" }, { sessionId: "y" }, { server: "", sessionId: "" }] }), []);
});

test("wbMcpAllowedBySession：会话 → 允许的服务列表，去重且无约束的不出现", () => {
  const { wbMcpAllowedBySession } = api();
  const map = wbMcpAllowedBySession({
    links: [
      { server: "pencil", sessionId: "s1" },
      { server: "github", sessionId: "s1" },
      { server: "pencil", sessionId: "s1" },
      { server: "slack", sessionId: "s2" }
    ]
  });
  assert.deepEqual(map.s1, ["pencil", "github"], "同一会话多个服务，去重");
  assert.deepEqual(map.s2, ["slack"]);
  assert.equal(map.s3, undefined, "没有约束的会话不进表——「不在表里」≠「允许一切」");
  assert.equal(map.main, undefined);
  assert.deepEqual(wbMcpAllowedBySession(undefined), {});
});

test("i18n：约束层在画布上只剩一个 key（Agent 卡徽标），其余已随节点 / 拖线 / 全清一起删除；中英占位符同名", () => {
  const messages = api().WB_TEXT;
  assert.ok(messages, "客户端要暴露 messages 供测试核对");
  for (const lang of ["zh", "en"]) {
    const dict = messages[lang];
    assert.ok(typeof dict["canvas.mcp.allowed"] === "string" && dict["canvas.mcp.allowed"].indexOf("{servers}") >= 0, lang + " 缺 canvas.mcp.allowed 或占位符不对");
    for (const gone of ["canvas.node.mcp", "canvas.mcp.linked", "canvas.mcp.unlinked", "canvas.mcp.deny", "canvas.mcp.dup", "canvas.mcp.cleared", "canvas.mcp.clearAll", "canvas.mcp.empty", "canvas.mcp.unlink", "canvas.mcp.linkfail", "canvas.legend.mcp", "canvas.link.reason.mcp"]) {
      assert.equal(dict[gone], undefined, lang + " 的 " + gone + " 应已删除（MCP 约束在 设置 › 高级，文案键是 set.mcp.*）");
    }
  }
  // 设置页这一份必须齐（settings-advanced.test.mjs 逐条测；这里只防「删画布键时误删了设置键」）
  for (const key of ["set.mcp.title", "set.mcp.rule", "set.mcp.fail"]) for (const lang of ["zh", "en"]) assert.ok(messages[lang][key], lang + " 缺 " + key);
});