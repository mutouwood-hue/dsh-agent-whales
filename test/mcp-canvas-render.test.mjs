// 约束层 · 画布渲染回归（客户端半边）。
//
// 纯函数对了不等于页面对了。这里用假 fetch 把 MCP 数据喂进 wbCache，
// 真渲染一次 WbCanvasPage，断言 MCP 节点、约束徽标、占位与一键全清真的出现在 DOM 里。
// 最后一条「约束数据整个挂掉也不崩」比 happy path 更重要——宿主抽风不该带崩整块画布。
import test from "node:test";
import assert from "node:assert/strict";
import { installDocumentStub, loadPlugin, render, walk, findByClass, createMount } from "./harness.mjs";

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

/** 喂数据：shim 的 useSyncExternalStore 不调 subscribe，请求不会自己发起，
 *  所以显式 wbCache.read 把每个 URL 预热一遍，再渲染才看得到数据。 */
async function ready(fetchMap) {
  installDocumentStub();
  const calls = [];
  const loaded = loadPlugin({
    fetch: (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
      return router(fetchMap)(String(url));
    }
  });
  const api = loaded.plugin.__test;
  api.wbCache.reset();
  await Promise.all(Object.keys(fetchMap).map((url) => api.wbCache.read(url).catch(() => {})));
  loaded.calls = calls;
  return loaded;
}

/** 真正可用的入口：先造 shim，再带 shim 加载，再预热，再挂载。 */
async function mountCanvasWith(fetchMap) {
  installDocumentStub();
  const calls = [];
  const { shim, mount } = createMount();
  const loaded = loadPlugin({
    react: shim,
    fetch: (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
      return router(fetchMap)(String(url));
    }
  });
  const api = loaded.plugin.__test;
  api.wbCache.reset();
  await Promise.all(Object.keys(fetchMap).map((url) => api.wbCache.read(url).catch(() => {})));
  const view = mount(api.WbCanvasPage, { t: MARK, projectId: "p1" });
  return { api, view, calls, WbCanvasPage: api.WbCanvasPage };
}

/** 收集某一类节点的盒子，连同它渲染出来的文字一起返回。
 *  坐标取 style.left/top/width/minHeight，与 nodeAt() 判命中用的 node.x/y/w/h 同源。
 *  带文字是必须的：MCP 节点按服务名排序，光拿「第一个」会拿到已经连过的那个，
 *  于是该发的请求被本地判重挡下，测试还以为实现坏了。 */
function boxesOf(tree, kind) {
  const out = [];
  let current = null;
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const isNode = node.props && node.props["data-kind"] === kind && node.props.style;
    if (isNode) {
      const st = node.props.style;
      current = {
        x: parseFloat(st.left) || 0,
        y: parseFloat(st.top) || 0,
        w: parseFloat(st.width) || 0,
        h: parseFloat(st.minHeight) || 0,
        text: ""
      };
      out.push(current);
    }
    const children = node.props ? node.props.children : undefined;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" && current !== null) current.text += child + " ";
      else visit(child);
    }
    if (isNode) current = null;
  };
  visit(tree);
  return out;
}

/** 按服务名精确取 MCP 节点盒子。 */
function mcpBoxOf(tree, server) {
  const hit = boxesOf(tree, "mcp").filter((item) => item.text.indexOf(server) >= 0)[0];
  return hit === undefined ? null : hit;
}

/** 收集每个节点右侧那颗「＋」锚点，带上它属于哪个 kind。 */
function anchorsOf(tree) {
  const out = [];
  // 必须像 harness 的 walk 一样先接住数组：children 常是数组，而数组没有 .props，
  // 少了这个分支整棵子树都会被跳过（症状：一个锚点都收集不到）。
  const visit = (node, kind) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((child) => visit(child, kind)); return; }
    const k = node.props && node.props["data-kind"] ? node.props["data-kind"] : kind;
    if (node.props && node.props.title === "«canvas.link.new»") out.push({ kind: kind, props: node.props });
    visit(node.props ? node.props.children : undefined, k);
  };
  visit(tree, null);
  return out;
}

/** 画布舞台（挂 onCanvasUp 的那个 div）。 */
function stageOf(tree) {
  const found = findByClass(tree, "daw-wb-canvas");
  return found.length > 0 ? found[0] : null;
}

/** 按按钮文字找按钮，拿它的 onClick。 */
function buttonByText(tree, text) {
  let found = null;
  walk(tree, (node) => {
    if (found !== null) return;
    const children = node.props ? node.props.children : undefined;
    const flat = Array.isArray(children) ? children : [children];
    if (typeof node.props.onClick === "function" && flat.indexOf(text) >= 0) found = node.props;
  });
  return found;
}

async function canvasOf(fetchMap) {
  const { WbCanvasPage } = (await ready(fetchMap)).plugin.__test;
  return texts(render(WbCanvasPage({ t: MARK, projectId: "p1" }))).join(" | ");
}

test("画布渲染：MCP 服务节点出现在画布上，连过的标已连接、没连的标未连接", async () => {
  const body = await canvasOf(FULL);
  assert.ok(body.indexOf("pencil") >= 0, "pencil 节点要渲染出来");
  assert.ok(body.indexOf("github") >= 0, "github 节点要渲染出来");
  assert.ok(body.indexOf("slack") >= 0, "slack 节点要渲染出来");
  assert.ok(body.indexOf("«canvas.node.mcp»") >= 0, "节点类型标签要显示 MCP 服务");
  assert.ok(body.indexOf("«canvas.mcp.linked»") >= 0, "有约束的服务要标已连接");
  assert.ok(body.indexOf("«canvas.mcp.unlinked»") >= 0, "没约束的服务要标未连接");
  assert.ok(body.indexOf("12 个工具") >= 0, "工具数要显示");
});

test("画布渲染：Agent 卡上写出被允许的 MCP，各会话内容不同", async () => {
  const body = await canvasOf(FULL);
  assert.ok(body.indexOf("«canvas.mcp.allowed»") >= 0, "Agent 卡要有 MCP 徽标");
  assert.ok(body.indexOf("pencil · github") >= 0, "s1 连的两个服务都要列出来");
  // s2 只连了 pencil；主会话没有约束，不该出现徽标
  assert.equal(body.split("«canvas.mcp.allowed»").length - 1, 2, "只有 s1 与 s2 两个 Agent 有徽标，Composer 没有");
  assert.ok(body.indexOf("servers=pencil · github") >= 0, "s1 的两个服务按序列出");
  assert.ok(body.indexOf("servers=pencil") >= 0, "s2 只列它连的那一个");
});

test("画布渲染：有约束才出现一键全清；一个服务都没连时出占位", async () => {
  const body = await canvasOf(FULL);
  assert.ok(body.indexOf("«canvas.mcp.clearAll»") >= 0, "有约束要能给一键全清");

  const unlinked = Object.assign({}, FULL, {
    "/projects/p1/mcp-links": { code: 200, msg: "success", data: { projectId: "p1", available: [{ server: "pencil", toolCount: 3 }], links: [], members: [], mainSessionId: "main" } }
  });
  const unlinkedBody = await canvasOf(unlinked);
  assert.equal(unlinkedBody.indexOf("«canvas.mcp.clearAll»"), -1, "没有约束不该摆一个全清按钮");
  // 服务在、约束不在：节点照画，只是标未连接——「没有约束」和「没有服务」是两回事
  assert.ok(unlinkedBody.indexOf("«canvas.mcp.unlinked»") >= 0, "有服务没约束要标未连接，不是把节点藏了");

  const none = Object.assign({}, FULL, {
    "/projects/p1/mcp-links": { code: 200, msg: "success", data: { projectId: "p1", available: [], links: [], members: [], mainSessionId: "main" } }
  });
  const noneTree = render((await ready(none)).plugin.__test.WbCanvasPage({ t: MARK, projectId: "p1" }));
  assert.ok(kinds(noneTree).indexOf("guide") >= 0, "一个 MCP 服务都没有时要出占位说明");
  assert.ok(texts(noneTree).join(" | ").indexOf("«canvas.mcp.empty»") >= 0, "占位要说清先去 DSH 连 MCP");
});

test("画布渲染：mcp-links 整个挂掉也不崩，画布照常出节点", async () => {
  const broken = Object.assign({}, FULL);
  delete broken["/projects/p1/mcp-links"]; // 路由不到 → 404 信封 → wbUnwrap 抛错 → entry.error
  const { WbCanvasPage } = (await ready(broken)).plugin.__test;
  assert.doesNotThrow(() => render(WbCanvasPage({ t: MARK, projectId: "p1" })), "约束数据挂了不能带崩画布");
  const body = texts(render(WbCanvasPage({ t: MARK, projectId: "p1" }))).join(" | ");
  assert.ok(body.indexOf("Agent 甲") >= 0, "Agent 节点照常渲染");
  assert.equal(body.indexOf("«canvas.mcp.linked»"), -1, "没有数据就不该显示已连接");
  assert.ok(body.indexOf("«canvas.mcp.empty»") >= 0, "读不到约束数据要给占位说明");
});

// ── 交互：连线即约束 ────────────────────────────────────────────────────────
//
// 渲染测试证明「节点画对了」，这里证明「点对了真的发了对的请求」。
// 用户要的那件事是：把 MCP 拖到某个对话上 = 约束它只能用这些。这条链断了，
// 前面所有绿测试都只是装饰。

test("交互：从 Agent 节点拖线到 MCP 节点，发出 POST /mcp-links 带上服务名与会话", async () => {
  const { view, calls } = await mountCanvasWith(FULL);

  // 1) 按下 Agent 节点右侧的「＋」锚点：进入连线态
  const anchor = anchorsOf(view.tree).filter((item) => item.kind === "agent")[0];
  assert.ok(anchor, "Agent 节点右侧要有连线锚点");
  anchor.props.onPointerDown({ stopPropagation() {}, clientX: 0, clientY: 0 });
  view.rerender();

  // 2) 在 MCP 节点上松手：onCanvasUp 的约束分支
  // slack 在 fixture 里还没连过；按名字定位，不能拿「第一个」——那是 github，已经连过
  const mcp = mcpBoxOf(view.tree, "slack");
  assert.ok(mcp, "要有 slack 的 MCP 节点盒子，实际：" + JSON.stringify(boxesOf(view.tree, "mcp").map((b) => b.text)));
  const stage = stageOf(view.tree);
  assert.ok(stage && typeof stage.props.onPointerUp === "function", "舞台上要挂 onPointerUp");
  stage.props.onPointerUp({
    clientX: mcp.x + mcp.w / 2,
    clientY: mcp.y + mcp.h / 2,
    preventDefault() {}
  });

  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.filter((call) => call.method === "POST" && call.url.indexOf("/mcp-links") >= 0);
  assert.equal(post.length, 1, "应该正好发一次 POST /mcp-links，实际：" + JSON.stringify(calls.filter((c) => c.method !== "GET")));
  const body = JSON.parse(post[0].body);
  assert.equal(body.server, "slack", "slack 还没连过，这条线该连它");
  assert.equal(body.sessionId, "s1", "要带上被约束的会话 id");
  // 关键：不能走 /links——那条路由要求两端都是项目成员，MCP 服务不是成员，只会拿到 40701
  assert.equal(calls.filter((call) => call.url.indexOf("/links") >= 0 && call.method === "POST").length, 0, "约束不能误走 /links");
});

test("交互：往已经连上的组合再拖一次，被本地判重挡下，不发请求", async () => {
  const { view, calls } = await mountCanvasWith(FULL);
  const anchor = anchorsOf(view.tree).filter((item) => item.kind === "agent")[0];
  anchor.props.onPointerDown({ stopPropagation() {}, clientX: 0, clientY: 0 });
  view.rerender();

  const stage = stageOf(view.tree);
  // pencil 已经连到 s1（fixture 第一条 links）——这条线该被本地判重挡下
  const target = mcpBoxOf(view.tree, "pencil");
  assert.ok(target, "要拿到 pencil 的 MCP 节点盒子");
  stage.props.onPointerUp({ clientX: target.x + target.w / 2, clientY: target.y + target.h / 2, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.filter((call) => call.method === "POST");
  assert.equal(post.length, 0, "重复约束不该再发请求，实际：" + JSON.stringify(post));
});

test("交互：一键全清发出 DELETE /mcp-links?all=1", async () => {
  const { view, calls } = await mountCanvasWith(FULL);
  const btn = buttonByText(view.tree, "«canvas.mcp.clearAll»");
  assert.ok(btn, "有约束时要有一键全清按钮");
  btn.onClick();
  await new Promise((resolve) => setImmediate(resolve));

  const del = calls.filter((call) => call.method === "DELETE" && call.url.indexOf("mcp-links") >= 0);
  assert.equal(del.length, 1, "应该正好发一次 DELETE，实际：" + JSON.stringify(calls.filter((c) => c.method !== "GET")));
  assert.ok(del[0].url.indexOf("all=1") >= 0, "要带 all=1 才是全清：" + del[0].url);
});

test("交互：没有约束时工具条不出现一键全清", async () => {
  const bare = Object.assign({}, FULL, {
    "/projects/p1/mcp-links": { code: 200, msg: "success", data: { projectId: "p1", available: [{ server: "pencil", toolCount: 3 }], links: [], members: [{ sessionId: "s1" }], mainSessionId: "main" } }
  });
  const { view, calls } = await mountCanvasWith(bare);
  assert.equal(buttonByText(view.tree, "«canvas.mcp.clearAll»"), null, "没有约束不该摆全清按钮");
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0, "没有约束时也不该有删除请求");
});
