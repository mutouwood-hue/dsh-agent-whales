// 约束层 · 画布纯函数单测（客户端半边）。
//
// 打的是四件事：MCP 节点从哪来、约束表怎么适配成连线、会话被允许哪些服务、
// 以及连线路由靠什么判断「这端是 MCP」。全部纯函数，不发请求、不碰 DOM。
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

test("wbMcpNodes：空数据与坏数据都回空数组，不炸", () => {
  const { wbMcpNodes } = api();
  assert.deepEqual(wbMcpNodes(undefined), []);
  assert.deepEqual(wbMcpNodes(null), []);
  assert.deepEqual(wbMcpNodes("nope"), []);
  assert.deepEqual(wbMcpNodes({}), []);
  assert.deepEqual(wbMcpNodes({ available: [] }), []);
});

test("wbMcpNodes：只认 available 里的服务，id 带 mcp: 前缀", () => {
  const { wbMcpNodes } = api();
  const nodes = wbMcpNodes(SAMPLE);
  assert.equal(nodes.length, 2, "两个服务两个节点");
  assert.deepEqual(nodes.map((n) => n.id), ["mcp:github", "mcp:pencil"], "按服务名排序，顺序稳定");
  assert.equal(nodes[0].kind, "mcp");
  assert.equal(nodes[0].server, "pencil" === nodes[0].server ? "pencil" : "github");
  assert.equal(nodes[1].toolCount, 12, "工具数从 available 带出来");
});

test("wbMcpNodes：已连接数量从 links 数，读不到就说未连接", () => {
  const { wbMcpNodes } = api();
  const nodes = wbMcpNodes(SAMPLE);
  const pencil = nodes.filter((n) => n.server === "pencil")[0];
  const github = nodes.filter((n) => n.server === "github")[0];
  assert.equal(pencil.linkedCount, 2, "两条同服务同会话的 link 都要数到");
  assert.equal(pencil.linked, true);
  assert.equal(github.linkedCount, 0, "没有 link 就是 0");
  assert.equal(github.linked, false);
});

test("wbMcpNodes：服务名去重，同份数据两次渲染位置一致", () => {
  const { wbMcpNodes } = api();
  const dup = { available: [{ server: "a", toolCount: 1 }, { server: "a", toolCount: 9 }, { server: "b" }], links: [] };
  const nodes = wbMcpNodes(dup);
  assert.equal(nodes.length, 2, "重复服务只出一个节点");
  assert.deepEqual(nodes.map((n) => n.server), ["a", "b"]);
  assert.equal(nodes[0].toolCount, 1, "去重保留第一条，不拿后来的覆盖");
  // 位置只由下标决定，与 Map 遍历顺序无关
  const again = wbMcpNodes(dup);
  assert.deepEqual(nodes.map((n) => [n.x, n.y]), again.map((n) => [n.x, n.y]), "两次渲染坐标必须一致");
});

test("wbMcpNodes：脏服务名与脏 link 被跳过", () => {
  const { wbMcpNodes } = api();
  const nodes = wbMcpNodes({
    available: [{ server: "ok" }, null, { server: "" }, "x", { server: 42 }, { toolCount: 3 }],
    links: [null, { server: "ok" }, { sessionId: "s1" }, { server: "", sessionId: "s1" }, { server: "ok", sessionId: "s1" }]
  });
  assert.equal(nodes.length, 1, "只剩一个完好的服务");
  assert.equal(nodes[0].linkedCount, 1, "只有完好的那条 link 计入");
  assert.equal(nodes[0].toolCount, 0, "toolCount 不是正数就按 0");
});

test("wbMcpNodes：布局参数可覆盖，间距按 gap 排", () => {
  const { wbMcpNodes } = api();
  const nodes = wbMcpNodes(SAMPLE, { x: 920, y: 40, w: 180, h: 90, gap: 100 });
  assert.equal(nodes[0].x, 920);
  assert.equal(nodes[0].y, 40);
  assert.equal(nodes[1].y, 140, "第二个节点按 gap 下移");
  assert.equal(nodes[0].w, 180);
  assert.equal(nodes[0].h, 90);
});

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

test("wbIsMcpNodeId：只认 mcp: 开头且非空", () => {
  const { wbIsMcpNodeId } = api();
  assert.equal(wbIsMcpNodeId("mcp:pencil"), true);
  assert.equal(wbIsMcpNodeId("mcp:"), false, "只有前缀不算");
  assert.equal(wbIsMcpNodeId("mcp"), false);
  assert.equal(wbIsMcpNodeId("s1"), false, "会话 id 不是 MCP 节点");
  assert.equal(wbIsMcpNodeId("ctx:/d/x"), false, "落点 id 不是 MCP 节点");
  assert.equal(wbIsMcpNodeId("main"), false);
  assert.equal(wbIsMcpNodeId(undefined), false);
  assert.equal(wbIsMcpNodeId(null), false);
  assert.equal(wbIsMcpNodeId(42), false);
});

test("i18n：约束层 key 中英文都齐，占位符同名", () => {
  const { plugin } = loadPlugin();
  const messages = api().WB_TEXT;
  assert.ok(messages, "客户端要暴露 messages 供测试核对");
  for (const key of ["canvas.node.mcp", "canvas.mcp.linked", "canvas.mcp.unlinked", "canvas.mcp.allowed", "canvas.mcp.deny", "canvas.mcp.dup", "canvas.mcp.cleared", "canvas.mcp.clearAll", "canvas.mcp.empty", "canvas.mcp.unlink", "canvas.mcp.linkfail"]) {
    for (const lang of ["zh", "en"]) {
      const dict = messages[lang];
      assert.ok(dict && typeof dict[key] === "string" && dict[key] !== "", lang + " 缺 " + key);
    }
  }
  assert.ok(messages.zh["canvas.mcp.allowed"].indexOf("{servers}") >= 0, "占位符要对上");
  assert.ok(messages.en["canvas.mcp.allowed"].indexOf("{servers}") >= 0, "占位符要对上");
  assert.ok(messages.zh["canvas.mcp.linkfail"].indexOf("{reason}") >= 0);
  assert.ok(messages.en["canvas.mcp.linkfail"].indexOf("{reason}") >= 0);
});
