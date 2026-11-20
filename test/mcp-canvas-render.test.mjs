// 约束层 · 画布渲染回归（客户端半边）。
//
// 重新规划 R2：MCP 服务节点、拖线即约束、画布上的「一键全清」与占位引导都已删除——MCP 约束迁到「设置 › 高级」
// （见 settings-advanced.test.mjs）。画布上只剩一件只读的事：Agent 卡上写出它被允许的 MCP 服务。
// 这里钉住：①那一行还在且内容对；②MCP 的节点 / 引导卡 / 一键全清 / 拖线路径**确实不在了**；
// ③约束数据整个挂掉也不崩——宿主抽风不该带崩整块画布。
import test from "node:test";
import assert from "node:assert/strict";
import { installDocumentStub, loadPlugin, walk, createMount } from "./harness.mjs";
import { flowLoadPlugin, flowMount } from "./flow-harness.mjs";

// t 必须返回「不是 key 本身」的串：wbT 看到注入的 t 原样返回 key，就认为没翻译、
// 会回落内置中文表，断言于是永远对不上。用 «key» 包一层才能稳定断言。
// 透传 vars：否则 t("canvas.mcp.allowed", {servers}) 只返回 key，
// 「pencil · github」这类插值结果根本不会出现在渲染里，断言就对不上。
const MARK = (key, vars) => {
  let out = "«" + key + "»";
  if (vars && typeof vars === "object") {
    for (const name of Object.keys(vars)) out += " " + name + "=" + String(vars[name]);
  }
  return out;
};

const PROJECT = {
  code: 200,
  msg: "success",
  data: {
    project: {
      projectId: "p1",
      name: "节点图画布",
      mainSessionId: "main",
      members: [{ sessionId: "s1", role: "member" }, { sessionId: "s2", role: "member" }],
      links: [{ a: "s1", b: "s2" }],
      brief: { goal: "把 MCP 约束落到画布" }
    }
  }
};

const TASKS = {
  code: 200,
  msg: "success",
  data: {
    tasks: [
      { taskId: "t-1", subject: "接画布", status: "in_progress", ownerSessionId: "s1", worktree: "/d/repo-a" },
      { taskId: "t-2", subject: "写测试", status: "pending", ownerSessionId: "s1", worktree: "/d/repo-a" }
    ]
  }
};

const SESSIONS = {
  code: 200,
  msg: "success",
  // indexById 认的是 sessionId，不是 id——写错标题就匹配不上，Agent 卡只会显示会话 id
  data: { sessions: [{ sessionId: "s1", title: "Agent 甲", running: true }, { sessionId: "s2", title: "Agent 乙" }] }
};

const CANVAS = { code: 200, msg: "success", data: { rev: 1, nodes: [] } };
const INBOX = { code: 200, msg: "success", data: { entries: [] } };
const HANDOFFS = { code: 200, msg: "success", data: { entries: [] } };

// slack 故意不连任何会话：要有一个「未连接」样本，否则「已连接/未连接」只测到一半。
const MCP_LINKS = {
  code: 200,
  msg: "success",
  data: {
    projectId: "p1",
    available: [{ server: "pencil", toolCount: 12 }, { server: "github", toolCount: 4 }, { server: "slack", toolCount: 2 }],
    links: [
      { server: "pencil", sessionId: "s1", createdAt: 1 },
      { server: "github", sessionId: "s1", createdAt: 2 },
      { server: "pencil", sessionId: "s2", createdAt: 3 }
    ],
    members: [{ sessionId: "s1" }, { sessionId: "s2" }],
    mainSessionId: "main"
  }
};

const FULL = {
  "/projects/p1": PROJECT,
  "/tasks?projectId=p1": TASKS,
  "/sessions": SESSIONS,
  "/canvas?projectId=p1": CANVAS,
  "/inbox?projectId=p1": INBOX,
  "/handoffs?projectId=p1": HANDOFFS,
  "/projects/p1/mcp-links": MCP_LINKS
};

/** 画布页会拉的 7 个相对 URL。
 *  wbCache 的 key 是 useWb 收到的相对路径，不是 fetch 用的全路径（wbApi 另加前缀）。
 *  用错 key 数据会落进另一个 entry，页面永远空——这个坑值得写在注释里。 */
const URLS = Object.keys(FULL);

/** 按 url 路由 canned 响应；拿不到的返回 404 信封，与宿主语义一致。
 *  必须用 endsWith 而不是 indexOf：fetch 的 url 是「/agent-whales/api」+ key，
 *  而 /projects/p1 是 /projects/p1/mcp-links 的前缀，子串匹配会把约束请求
n *  误分到项目响应上（症状：MCP 数据永远是项目数据，页面只显示空占位）。 */
function router(map) {
  return function (url) {
    for (const key of Object.keys(map)) {
      if (url.endsWith(key)) return map[key];
    }
    return { code: 404, msg: "not found" };
  };
}

function texts(tree) {
  const out = [];
  walk(tree, (node) => {
    const children = node.props && node.props.children;
    if (typeof children === "string" && children !== "") out.push(children);
    else if (Array.isArray(children)) {
      for (const child of children) if (typeof child === "string" && child !== "") out.push(child);
    }
  });
  return out;
}

function kinds(tree) {
  const out = [];
  walk(tree, (node) => {
    if (node.props && node.props["data-kind"]) out.push(node.props["data-kind"]);
  });
  return out;
}

/** 挂载新画布（假 React Flow）并返回合并树。fetchMap 里没有的 URL 回 404 信封。 */
async function mountFlowWith(fetchMap) {
  installDocumentStub();
  const calls = [];
  const { shim, mount } = createMount({ effects: true });
  const loaded = flowLoadPlugin(shim, {
    fetch: (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
      return router(fetchMap)(String(url));
    }
  });
  const api = loaded.plugin.__test;
  api.wbCache.reset();
  await Promise.all(Object.keys(fetchMap).map((url) => api.wbCache.read(url).catch(() => {})));
  const view = await flowMount(mount, api, { t: MARK, projectId: "p1" }, loaded);
  return { api, view, calls };
}

async function canvasOf(fetchMap) {
  const { view } = await mountFlowWith(fetchMap);
  return { body: texts(view.tree).join(" | "), view };
}

test("画布渲染：Agent 卡上写出被允许的 MCP，各会话内容不同（只读；设置在 设置 › 高级）", async () => {
  const { body } = await canvasOf(FULL);
  assert.ok(body.indexOf("«canvas.mcp.allowed»") >= 0, "Agent 卡要有 MCP 徽标");
  assert.ok(body.indexOf("pencil · github") >= 0, "s1 连的两个服务都要列出来");
  // s2 只连了 pencil；主会话没有约束，不该出现徽标
  assert.equal(body.split("«canvas.mcp.allowed»").length - 1, 2, "只有 s1 与 s2 两个 Agent 有徽标，Composer 没有");
  assert.ok(body.indexOf("servers=pencil · github") >= 0, "s1 的两个服务按序列出");
  assert.ok(body.indexOf("servers=pencil") >= 0, "s2 只列它连的那一个");
});

test("画布上不再有 MCP：没有 MCP 服务节点、没有 MCP 引导卡、没有一键全清按钮、没有 MCP 连线种类；mcp-links 路由仍被读取（给 Agent 卡的徽标用）", async () => {
  const { view, calls } = await mountFlowWith(FULL);
  const flow = view.flow();
  const ids = flow.nodes.map((n) => n.id);
  assert.equal(ids.filter((id) => id.indexOf("mcp:") === 0).length, 0, "没有 mcp: 节点：" + ids.join(","));
  assert.ok(!ids.includes("__mcpguide"), "没有 MCP 引导卡");
  assert.equal(flow.nodes.filter((n) => n.data && n.data.kind === "mcp").length, 0);
  assert.equal(flow.edges.filter((e) => e.data && e.data.kind === "mcp").length, 0, "没有约束线");
  const body = texts(view.tree).join(" | ");
  for (const gone of ["«canvas.mcp.clearAll»", "«canvas.mcp.empty»", "«canvas.mcp.linked»", "«canvas.mcp.unlinked»", "«canvas.node.mcp»"]) assert.equal(body.indexOf(gone), -1, gone + " 已删除");
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "挂载本身不发任何写请求");
  assert.ok(calls.some((c) => c.url.endsWith("/projects/p1/mcp-links") && c.method === "GET"), "仍读 mcp-links：Agent 卡徽标要用");
});

test("画布上拖线到「MCP」不可能再发生：onConnect 只会走 /links 与 /dependencies，绝不会 POST /mcp-links", async () => {
  const { view, calls } = await mountFlowWith(FULL);
  const flow = view.flow();
  // 即使有人伪造一个 mcp: 开头的端点（旧数据 / 旧会话残留），也只会被当成普通的、不存在的节点：被本地挡下，不发约束请求
  flow.onConnect({ source: "mcp:pencil", target: "s1" });
  flow.onConnect({ source: "s1", target: "mcp:pencil" });
  await view.settle();
  assert.equal(calls.filter((c) => c.url.indexOf("/mcp-links") >= 0 && c.method !== "GET").length, 0, "不会再有 POST / DELETE /mcp-links");
});

test("画布渲染：mcp-links 整个挂掉也不崩，画布照常出节点；Agent 卡不显示徽标", async () => {
  const broken = Object.assign({}, FULL);
  delete broken["/projects/p1/mcp-links"]; // 路由不到 → 404 信封 → wbUnwrap 抛错 → entry.error
  const { body } = await canvasOf(broken);
  assert.ok(body.indexOf("Agent 甲") >= 0, "Agent 节点照常渲染");
  assert.equal(body.indexOf("«canvas.mcp.allowed»"), -1, "没有数据就不该显示徽标");
});