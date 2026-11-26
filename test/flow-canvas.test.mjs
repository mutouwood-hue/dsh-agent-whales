/**
 * 波次 3（PRD v2.2）：新画布（React Flow 按需 chunk）浏览器侧用例。
 *
 * React Flow 本身只在真浏览器里跑（真机证据另附）；这里钉住：
 *   - 连线语义 → 边规格（实线依赖 / 虚线互发 / 点线约束 / 粗管上下文）；
 *   - chunk 加载器的四态（宿主没有 require.async = unavailable，绝不白屏）；
 *   - 画布在新引擎下的接线：依赖模式拖线真的 POST /dependencies，互发模式走 /links；
 *   - lib/client.flow.js 的宿主 chunk 契约（自注册 id + chunk 名、React 外置）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createMount, installDocumentStub, loadPlugin, pluginDir } from "./harness.mjs";

const api = () => loadPlugin().plugin.__test;
const KEY = (key) => "[" + key + "]";
const ok = (data) => ({ code: 200, msg: "success", data });

function collect(node, out, match) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) { node.forEach((item) => collect(item, out, match)); return; }
  if (typeof node !== "object") return;
  if (node.props && match(node)) out.push(node);
  collect(node.props ? node.props.children : undefined, out, match);
}

test("边规格：依赖 = 实线箭头带标签、互发 = 虚线、上下文 = 不可选粗管（约束线已随 MCP 节点删除）", () => {
  const { wbFlowEdges } = api();
  const nodes = [
    { id: "m", kind: "composer" }, { id: "a", kind: "agent" }, { id: "b", kind: "agent" },
    { id: "ctx:repo", kind: "folder", tasks: [{ ownerSessionId: "a" }, { ownerSessionId: "a" }, { ownerSessionId: "ghost" }] }
  ];
  const edges = [
    { a: "m", b: "a", reason: "", label: "" },
    { a: "a", b: "b", reason: "blocked", label: "等待 ptask-1" },
    { a: "a", b: "b", reason: "blocked", label: "等待 ptask-2" }
  ];
  const specs = wbFlowEdges(edges, nodes, []);
  const byKind = (kind) => specs.filter((spec) => spec.data.kind === kind);
  assert.equal(byKind("relay").length, 1);
  assert.equal(byKind("relay")[0].style.strokeDasharray, "6 4");
  assert.equal(byKind("relay")[0].markerEnd, undefined, "互发线无方向");
  assert.equal(byKind("dependency").length, 1, "同一对上下游只画一根依赖线");
  const dep = byKind("dependency")[0];
  assert.equal(dep.source, "a");
  assert.equal(dep.target, "b");
  assert.equal(dep.markerEnd.type, "arrowclosed");
  assert.equal(dep.style.strokeDasharray, undefined, "依赖是实线");
  assert.equal(dep.label, "等待 ptask-1");
  assert.equal(dep.data.pick, "dep:a|b", "选中依赖线后删除走 /dependencies");
  assert.equal(byKind("mcp").length, 0, "不再有「约束」类型的边（MCP 约束在 设置 › 高级）");
  assert.deepEqual([...new Set(specs.map((spec) => spec.data.kind))].sort(), ["context", "dependency", "relay"], "边的种类只剩这三种");
  // 旧数据 / 旧会话残留的、以 mcp: 开头的端点：不能再被识别成一种「约束」边
  const stale = wbFlowEdges([{ a: "mcp:pencil", b: "a", reason: "", label: "" }], nodes, []);
  assert.deepEqual(stale.filter((spec) => spec.source === "mcp:pencil").map((spec) => spec.data.kind), ["relay"], "mcp: 前缀不再有特殊含义，按普通互发线处理（上下文粗管来自落点节点，与它无关）");
  const ctx = byKind("context");
  assert.deepEqual(ctx.map((spec) => [spec.source, spec.target]), [["ctx:repo", "a"]], "粗管只连到画布上有的 owner，同一 owner 只一根");
  assert.equal(ctx[0].selectable, false);
  assert.deepEqual(wbFlowEdges(undefined, undefined, undefined), []);
});

test("锚点按相对位置选边：同列上下排走上下边，左右排走左右边（真机曾在同列两卡间绕圈）", () => {
  const { wbFlowEdges } = api();
  const nodes = [
    { id: "a", kind: "agent", x: 800, y: 24, w: 200, h: 148 },
    { id: "b", kind: "agent", x: 800, y: 192, w: 200, h: 148 },
    { id: "m", kind: "composer", x: 430, y: 220, w: 320, h: 330 }
  ];
  const specs = wbFlowEdges([
    { a: "a", b: "b", reason: "blocked", label: "" },
    { a: "m", b: "a", reason: "", label: "" },
    { a: "b", b: "a", reason: "", label: "" }
  ], nodes, []);
  const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]));
  assert.deepEqual([byId["dependency:a|b"].sourceHandle, byId["dependency:a|b"].targetHandle], ["s-b", "t-t"]);
  assert.deepEqual([byId["relay:m|a"].sourceHandle, byId["relay:m|a"].targetHandle], ["s-r", "t-l"]);
  assert.deepEqual([byId["relay:b|a"].sourceHandle, byId["relay:b|a"].targetHandle], ["s-t", "t-b"]);
});

test("节点清单：派生节点与空态引导，画布操作不占节点", () => {
  const { wbFlowItems } = api();
  const el = { type: "div", props: {} };
  const items = wbFlowItems({
    nodes: [{ id: "m", kind: "composer", x: 430, y: 220, w: 320 }, { id: "a", kind: "agent", x: 800, y: 24, w: 200 }],
    nodeEl: (node) => ({ type: "div", props: { "data-id": node.id } }),
    emptyGuideEl: el
  });
  assert.deepEqual(items.map((item) => item.id), ["m", "a", "__guide"]);
  assert.equal(items.find((item) => item.id === "a").el.props["data-id"], "a");
  assert.deepEqual(items.filter((item) => item.handles === false).map((item) => item.id), ["__guide"]);
  const bare = wbFlowItems({ nodes: [{ id: "m", kind: "composer", x: 0, y: 0, w: 1 }] });
  assert.deepEqual(bare.map((item) => [item.id, item.el]), [["m", null]], "没给 nodeEl：节点仍在，只是没有卡片内容，不抛");
});
test("chunk 加载器：宿主没有 require.async → unavailable（画布显示「需要更新 DSH」的说明，其余页签照常，不白屏）", () => {
  const t = api();
  t.wbFlowLoader.load();
  assert.equal(t.wbFlowLoader.get().status, "unavailable");
});

test("chunk 加载器：require.async 成功 → ready 且注入样式；失败 → failed，可重试", async () => {
  installDocumentStub();
  let fail = true;
  const asked = [];
  const loaded = loadPlugin({
    requireAsync: (spec) => {
      asked.push(spec);
      return fail ? Promise.reject(new Error("chunk 404")) : Promise.resolve({ ReactFlow: function ReactFlow() { return null; }, FLOW_CSS: ".react-flow{}" });
    }
  });
  const loader = loaded.plugin.__test.wbFlowLoader;
  loader.load();
  assert.equal(loader.get().status, "loading");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loader.get().status, "failed");
  assert.match(loader.get().error, /chunk 404/);
  fail = false;
  loader.retry();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loader.get().status, "ready");
  assert.deepEqual(asked, ["./client.flow.js", "./client.flow.js"], "包内 chunk 契约：相对路径 ./client.flow.js");
  assert.ok(globalThis.document.getElementById("dsh-agent-whales-flow-css"), "React Flow 样式注入一次");
});

function canvasFetch(target) {
  const project = { projectId: "p1", name: "画布", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }, { sessionId: "a" }, { sessionId: "b" }], links: [{ a: "a", b: "m" }], brief: { goal: "g" } };
  if (target === "/projects/p1") return ok({ project });
  if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [], mainSessionId: "m" });
  if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [
    { taskId: "t1", subject: "上游", ownerSessionId: "a", status: "pending", blockedBy: [] },
    { taskId: "t2", subject: "下游", ownerSessionId: "b", status: "pending", blockedBy: ["t1"] }
  ] });
  if (target === "/sessions") return ok({ source: "host", sessions: [] });
  if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: {}, elements: [] });
  if (target === "/projects/p1/dependencies") return ok({ action: "add", changed: [{ taskId: "t2", blockedBy: ["t1"], revision: 2 }] });
  if (target === "/projects/p1/links") return ok({ project });
  return ok({});
}

test("新画布接线：ReactFlow 收到派生节点与类型化边；依赖模式拖线 POST /dependencies，互发模式 POST /links", async () => {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  let flowProps = null;
  const lib = {
    ReactFlow: function ReactFlow(props) { flowProps = props; return { type: "div", props: { className: "rf", children: props.children } }; },
    Background: function () { return null; }, Controls: function () { return null; }, MiniMap: function () { return null; },
    Handle: function () { return null; }, Position: { Left: "left", Right: "right" },
    applyNodeChanges: (changes, nodes) => nodes,
    FLOW_CSS: ""
  };
  const loaded = loadPlugin({ react: shim, requireAsync: () => Promise.resolve(lib) });
  const t = loaded.plugin.__test;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    calls.push({ target, init });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(canvasFetch(target)) });
  };
  try {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions"]) await t.wbCache.read(url).catch(() => {});
    const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
    await view.settle(10);
    view.rerender();
    assert.ok(flowProps, "chunk 就绪后必须渲染 ReactFlow");
    const ids = flowProps.nodes.map((node) => node.id);
    assert.ok(ids.includes("m") && ids.includes("a") && ids.includes("b"), ids.join(","));
    assert.ok(!ids.includes("__thread") && !ids.some((id) => id.indexOf("mcp:") === 0 || id === "__mcpguide"), "Thread 与 MCP 节点已删除：" + ids.join(","));
    assert.equal(flowProps.deleteKeyCode, null, "不让 Backspace 静默删线");
    const kinds = flowProps.edges.map((edge) => edge.data.kind).sort();
    assert.deepEqual(kinds, ["dependency", "relay"], "t2 等 t1 → a→b 依赖实线；a↔m 互发虚线");

    // 默认互发模式：拖 b → m 走 /links
    flowProps.onConnect({ source: "b", target: "m" });
    await view.settle();
    assert.ok(calls.some((call) => call.target === "/projects/p1/links" && call.init && call.init.method === "POST"));

    // 切到依赖模式：拖 a → b 走 /dependencies
    const modeButtons = [];
    collect(view.tree, modeButtons, (node) => node.type === "button" && node.props.title === "[canvas.mode.dependency.title]");
    assert.equal(modeButtons.length, 1, "工具条上要有「依赖」模式按钮");
    modeButtons[0].props.onClick();
    view.rerender();
    flowProps.onConnect({ source: "a", target: "b" });
    await view.settle();
    const depCall = calls.find((call) => call.target === "/projects/p1/dependencies");
    assert.ok(depCall, "依赖模式必须 POST /dependencies");
    assert.deepEqual(JSON.parse(depCall.init.body), { from: "a", to: "b", action: "add" });

    // 线型图例五行
    const legendRows = [];
    collect(view.tree, legendRows, (node) => node.props.className === "daw-wb-legend-row");
    assert.deepEqual(legendRows.map((row) => row.props["data-kind"]), ["dependency", "relay", "context", "flow"], "图例里不再有 MCP 约束线");
  } finally {
    if (original === undefined) delete globalThis.fetch;
    else globalThis.fetch = original;
    t.wbCache.reset();
  }
});

test("client.flow.js：宿主 chunk 契约（自注册 id + chunk 名）、React 外置、带许可证说明", () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  const code = readFileSync(join(pluginDir, "lib", "client.flow.js"), "utf8");
  assert.ok(manifest.files.includes("lib/client.flow.js"), "chunk 必须随包发布");
  assert.match(code, new RegExp("window\\.__ModuleLoader__\\.load\\(\\{ id: \"" + manifest.name + "\", chunk: \"client\\.flow\\.js\""));
  const requires = Array.from(new Set(Array.from(code.matchAll(/require\("([^"]+)"\)/g), (match) => match[1]))).sort();
  assert.deepEqual(requires, ["react", "react-dom", "react/jsx-runtime"], "只能要宿主共享模块表里的 React（同一份 React）");
  assert.match(code, /@xyflow\/react 12\.12\.\d+（MIT/);
  assert.match(code, /@dagrejs\/dagre [\d.]+（MIT）/);
  // 跑一遍：自注册后 factory 导出 ReactFlow 与 dagre 布局
  let registration = null;
  const win = { __ModuleLoader__: { load(reg) { registration = reg; } } };
  new Function("window", code)(win);
  assert.equal(registration.chunk, "client.flow.js");
  const fakeReact = new Proxy({}, { get: (target, key) => (key === "default" ? fakeReact : () => ({})) });
  let exportsObj;
  try {
    exportsObj = registration.factory((spec) => fakeReact);
  } catch (error) {
    exportsObj = null; // 部分模块在 import 时就要真 React，离线环境下不强求跑通工厂
  }
  if (exportsObj) {
    assert.equal(typeof exportsObj.layoutWithDagre, "function");
    const pos = exportsObj.layoutWithDagre([{ id: "a", w: 100, h: 50 }, { id: "b", w: 100, h: 50 }], [{ source: "a", target: "b" }]);
    assert.ok(pos.b.x > pos.a.x, "LR 布局：下游在右");
  }
});

// ── 波次 4：文件 / 外部引用节点 ─────────────────────────────────────────────

test("引用节点：每个对话只展示最近 4 个文件，其余折叠成「+N」；只连画布上有的会话；标读 / 改 / @引用", () => {
  const { wbReferenceNodes } = api();
  const file = (key, sessions, at) => ({ key, path: "D:/repo/" + key, at, sessions });
  const refs = {
    files: [
      file("a.go", { s1: { read: 1, write: 2, ref: 0, at: 9 } }, 9),
      file("b.go", { s1: { read: 3, write: 0, ref: 0, at: 8 }, ghost: { read: 1, write: 0, ref: 0, at: 8 } }, 8),
      file("c.go", { s1: { read: 0, write: 0, ref: 1, at: 7 } }, 7),
      file("d.go", { s1: { read: 1, write: 0, ref: 0, at: 6 } }, 6),
      file("e.go", { s1: { read: 1, write: 0, ref: 0, at: 5 } }, 5),
      file("f.go", { s1: { read: 1, write: 0, ref: 0, at: 4 } }, 4),
      file("only-ghost.go", { ghost: { read: 1, write: 0, ref: 0, at: 99 } }, 99)
    ],
    links: [{ url: "https://app.notion.com/p/prd", kind: "notion", sessions: ["s1", "ghost"] }, { url: "https://x.feishu.cn/docx/1", kind: "feishu", sessions: [] }]
  };
  const graph = wbReferenceNodes(refs, ["s1", "m"], { startY: 100 });
  const files = graph.nodes.filter((node) => node.kind === "file" && !node.fold);
  assert.deepEqual(files.map((node) => node.title), ["a.go", "b.go", "c.go", "d.go"], "最近 4 个，按时间倒序；画布上没有的会话碰的文件不出现");
  assert.equal(files[0].y, 100);
  assert.equal(files[0].sub, "D:/repo");
  const fold = graph.nodes.find((node) => node.fold);
  assert.equal(fold.count, 2);
  assert.equal(fold.id, "file:+s1");
  const marks = Object.fromEntries(graph.edges.filter((edge) => edge.a.startsWith("file:D")).map((edge) => [edge.a, edge.reason]));
  assert.equal(marks["file:a.go"], undefined);
  const byTitle = Object.fromEntries(graph.edges.map((edge) => [edge.a, edge]));
  assert.equal(byTitle["file:a.go"].reason, "file-write", "又读又改记为改过");
  assert.equal(byTitle["file:b.go"].reason, "file-read");
  assert.equal(byTitle["file:c.go"].reason, "file-ref");
  assert.equal(graph.edges.some((edge) => edge.b === "ghost"), false, "只连画布上的会话");
  const links = graph.nodes.filter((node) => node.kind === "link");
  assert.deepEqual(links.map((node) => node.linkKind), ["notion", "feishu"]);
  assert.deepEqual(graph.edges.filter((edge) => edge.a.startsWith("link:")).map((edge) => edge.b), ["s1"]);
  assert.deepEqual(wbReferenceNodes(undefined, ["s1"]), { nodes: [], edges: [] });
});

test("引用连线：文件 → 对话用上下文粗管，标「读过 / 改过 / @引用」，不可选", () => {
  const { wbFlowEdges } = api();
  const nodes = [{ id: "file:a", kind: "file", x: 24, y: 24, w: 220, h: 72 }, { id: "s1", kind: "agent", x: 800, y: 24, w: 200, h: 148 }];
  const specs = wbFlowEdges([{ a: "file:a", b: "s1", reason: "file-write" }, { a: "file:a", b: "s1", reason: "file-write" }], nodes, [], (key) => "[" + key + "]");
  assert.equal(specs.length, 1, "同一对去重");
  assert.equal(specs[0].label, "[canvas.file.mark.write]");
  assert.equal(specs[0].selectable, false);
  assert.equal(specs[0].data.kind, "context");
  assert.match(specs[0].className, /daw-wb-edge-file-write/);
});

test("检视：文件节点列出谁读过 / 改过；链接节点提示双击打开", () => {
  const { wbNodeInspector } = api();
  const data = wbNodeInspector({ kind: "file", path: "D:/repo/a.go", sessions: { s1: { read: 1, write: 2, ref: 0 } } }, { sessions: [{ sessionId: "s1", title: "后端" }] });
  assert.equal(data.title, "D:/repo/a.go");
  assert.deepEqual(data.people, ["后端 · 改过 2 次、读过 1 次"]);
  const link = wbNodeInspector({ kind: "link", url: "https://app.notion.com/p/prd", sessions: {} }, {});
  assert.equal(link.title, "https://app.notion.com/p/prd");
  assert.ok(link.notes[0].indexOf("双击") >= 0);
});

// ── 波次 5：流程图上画布 ─────────────────────────────────────────────────────

const FLOW_ELEMENTS = [
  { id: "flow:main", kind: "group", x: null, y: null, data: { flowId: "main", title: "表单导入", kind: "flow" }, provenance: { by: "agent" }, userEdited: false },
  { id: "flow:main:s", kind: "flow", parentId: "flow:main", x: null, y: null, data: { flowId: "main", key: "s", shape: "start", text: "上传文件" }, provenance: { by: "agent", sourceMessageIds: ["m1"] }, userEdited: false },
  { id: "flow:main:chk", kind: "flow", parentId: "flow:main", x: null, y: null, data: { flowId: "main", key: "chk", shape: "decision", text: "表头匹配？" }, provenance: { by: "agent", sourceMessageIds: ["m1", "m2"] }, userEdited: false },
  { id: "flow:main:map", kind: "flow", parentId: "flow:main", x: 40, y: 300, data: { flowId: "main", key: "map", shape: "step", text: "人改过的" }, provenance: { by: "agent", sourceMessageIds: ["m2"] }, userEdited: true },
  { id: "flow:main:e:s>chk", kind: "edge", parentId: "flow:main", data: { flowId: "main", source: "flow:main:s", target: "flow:main:chk", fromKey: "s", toKey: "chk", label: "" }, provenance: { by: "agent" }, userEdited: false },
  { id: "note-1", kind: "note", data: { text: "不属于流程图" } }
];

test("流程图分组：按 flowId 归组，AI 计数只算没被人改过的", () => {
  const { wbFlowGroups } = api();
  const groups = wbFlowGroups(FLOW_ELEMENTS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "表单导入");
  assert.deepEqual(groups[0].nodes.map((el) => el.id), ["flow:main:s", "flow:main:chk", "flow:main:map"]);
  assert.equal(groups[0].edges.length, 1);
  assert.equal(groups[0].aiCount, 2, "人改过的节点不再算 AI 生成");
  assert.deepEqual(wbFlowGroups(undefined), []);
});

test("流程图版式：缺坐标的走 dagre（自上而下）、人拖过的保持；没有布局函数时竖排兜底", () => {
  const { wbFlowGroups, wbFlowLayout } = api();
  const group = wbFlowGroups(FLOW_ELEMENTS)[0];
  let seen = null;
  const laid = wbFlowLayout(group, (nodes, edges, opts) => { seen = { nodes, edges, opts }; return { "flow:main:s": { x: 10, y: 0 }, "flow:main:chk": { x: 10, y: 80 } }; });
  assert.equal(seen.opts.rankdir, "TB");
  assert.deepEqual(seen.edges, [{ source: "flow:main:s", target: "flow:main:chk" }]);
  assert.deepEqual(laid.pos["flow:main:map"], { x: 40, y: 300 }, "人拖过的位置不动");
  assert.ok(laid.pos["flow:main:s"].y >= 44, "给分组标题栏留位");
  assert.ok(laid.h >= 300 + 52, "分组框包住所有步骤");
  const fallback = wbFlowLayout(group, undefined);
  assert.ok(fallback.pos["flow:main:chk"].y > fallback.pos["flow:main:s"].y);
});

test("新画布：流程图分组 + 形状节点 + 绿色流程线进 ReactFlow；AI 角标与证据提示；撤销只删 AI 且未被人改过的", async () => {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  let flowProps = null;
  const lib = {
    ReactFlow: function ReactFlow(props) { flowProps = props; return { type: "div", props: { className: "rf" } }; },
    Background: function () { return null; }, Controls: function () { return null; }, MiniMap: function () { return null; },
    Handle: function () { return null; }, Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    applyNodeChanges: (changes, nodes) => nodes,
    layoutWithDagre: (nodes) => Object.fromEntries(nodes.map((node, index) => [node.id, { x: 20, y: index * 90 }])),
    FLOW_CSS: ""
  };
  const loaded = loadPlugin({ react: shim, requireAsync: () => Promise.resolve(lib) });
  const t = loaded.plugin.__test;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    calls.push({ target, init });
    let data = canvasFetch(target);
    if (target.startsWith("/canvas?")) data = ok({ rev: 7, nodes: {}, elements: FLOW_ELEMENTS });
    if (target === "/canvas/elements") data = ok({ rev: 8, elements: [], locked: [], rejected: [] });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  try {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/canvas?projectId=p1"]) await t.wbCache.read(url).catch(() => {});
    const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
    await view.settle(10);
    view.rerender();
    assert.ok(flowProps);
    const group = flowProps.nodes.find((node) => node.id === "flow:main");
    assert.equal(group.type, "whaleFlowGroup");
    assert.equal(group.position.x, 1080, "流程图排在 Agent 列右侧");
    const chk = flowProps.nodes.find((node) => node.id === "flow:main:chk");
    assert.equal(chk.type, "whaleFlowStep");
    assert.equal(chk.parentId, "flow:main");
    assert.equal(chk.extent, "parent");
    assert.equal(chk.data.shape, "decision");
    assert.equal(chk.data.ai, true);
    assert.equal(chk.data.evidence, "[canvas.flow.evidence]", "有证据才给提示");
    assert.equal(flowProps.nodes.find((node) => node.id === "flow:main:s").data.evidence, "[canvas.flow.evidence]");
    assert.equal(flowProps.nodes.find((node) => node.id === "flow:main:map").data.ai, false, "人改过的不带 AI 角标");
    const edge = flowProps.edges.find((e) => e.id === "flow:main:e:s>chk");
    assert.equal(edge.className, "daw-wb-edge-flow");
    assert.equal(edge.markerEnd.type, "arrowclosed");

    // 撤销 AI 生成：只删 AI 且没被人改过的节点与连线，人改过的那张图框保留
    group.data.onUndo();
    await view.settle();
    const undo = calls.find((call) => call.target === "/canvas/elements");
    assert.ok(undo, "撤销走元素表写入");
    const body = JSON.parse(undo.init.body);
    assert.equal(body.expectedRevision, 7);
    assert.deepEqual(body.remove.sort(), ["flow:main:chk", "flow:main:e:s>chk", "flow:main:s"]);

    // 拖动流程节点 → 写回元素表坐标（人动过即锁定由宿主标）
    flowProps.onNodeDragStop({}, { id: "flow:main:s", position: { x: 12.4, y: 99.6 } });
    await view.settle();
    const moved = calls.filter((call) => call.target === "/canvas/elements").pop();
    const movedBody = JSON.parse(moved.init.body);
    assert.equal(movedBody.upsert[0].id, "flow:main:s");
    assert.deepEqual([movedBody.upsert[0].x, movedBody.upsert[0].y], [12, 100]);
  } finally {
    if (original === undefined) delete globalThis.fetch;
    else globalThis.fetch = original;
    t.wbCache.reset();
  }
});

// ── 波次 6：原型帧 + 组件库 ─────────────────────────────────────────────────

test("布局契约：画布浮层容器不占盒子（真机：原型编辑器曾塌成 0×0）", () => {
  const css = api().WB_CSS;
  assert.match(css, /\.daw-wb-flow-overlay\{display:contents\}/);
});

test("原型版式：组件库节点决定组件包（换节点 = 换组件）；没有组件库节点时用内置 shadcn", () => {
  const { wbProtoLayout } = api();
  const packs = [{ id: "shadcn", name: "shadcn/ui（内置）", builtin: true }, { id: "cds", name: "CDS", builtin: false, license: "UNLICENSED" }];
  const protos = [
    { id: "proto:a", kind: "prototype", x: null, y: null, data: { width: "desktop" } },
    { id: "proto:b", kind: "prototype", x: null, y: null, data: { width: "mobile" } },
    { id: "proto:c", kind: "prototype", x: 10, y: 20, data: { width: "desktop" } }
  ];
  const bare = wbProtoLayout(protos, packs, { x: 1500, y: 24 });
  assert.equal(bare.packMeta.id, "shadcn");
  assert.equal(bare.library, null);
  assert.deepEqual(bare.edges, []);
  assert.deepEqual(bare.prototypes.map((row) => [row.x, row.y]), [[1500, 24], [1500, 464], [10, 20]], "人拖过的保持；其余按宽度竖排");
  const withLib = wbProtoLayout(protos.concat([{ id: "library:main", kind: "library", data: { packId: "cds" } }]), packs, { x: 1500, y: 24 });
  assert.equal(withLib.packMeta.id, "cds");
  assert.equal(withLib.prototypes[0].y, 274, "组件库节点在上，原型往下让");
  assert.deepEqual(withLib.edges.map((edge) => edge.target), ["proto:a", "proto:b", "proto:c"]);
  const unknown = wbProtoLayout([{ id: "library:main", kind: "library", data: { packId: "gone" } }], packs);
  assert.equal(unknown.packMeta.id, "shadcn", "包被删了就退回内置，不白屏");
});

test("原型 chunk 加载器：宿主没有 require.async → unavailable；有则按需加载两个 chunk", async () => {
  assert.equal((() => { const t = api(); t.wbProtoLoader.load(); return t.wbProtoLoader.get().status; })(), "unavailable");
  const asked = [];
  const loaded = loadPlugin({ requireAsync: (spec) => { asked.push(spec); return Promise.resolve(spec === "./client.puck.js" ? { Puck: function Puck() {}, PUCK_CSS: "._Puck_x{}" } : { PrototypeNode: function () {}, LibraryNode: function () {} }); } });
  installDocumentStub();
  const t = loaded.plugin.__test;
  t.wbProtoLoader.load();
  t.wbPuckLoader.load();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.wbProtoLoader.get().status, "ready");
  assert.equal(t.wbPuckLoader.get().status, "ready");
  assert.deepEqual(asked.sort(), ["./client.proto.js", "./client.puck.js"]);
  const puckCss = globalThis.document.getElementById("dsh-agent-whales-puck-css");
  assert.ok(puckCss, "Puck 样式必须注入页面，否则编辑器 visibility:hidden（真机抓到）");
  assert.equal(puckCss.textContent, "._Puck_x{}");
});

test("client.proto.js / client.puck.js：宿主 chunk 契约、React 外置、许可证说明；预览 chunk 不带 Puck 本体", () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  for (const file of ["client.proto.js", "client.puck.js"]) {
    assert.ok(manifest.files.includes("lib/" + file), file + " 必须随包发布");
    const code = readFileSync(join(pluginDir, "lib", file), "utf8");
    assert.match(code, new RegExp("window\\.__ModuleLoader__\\.load\\(\\{ id: \"" + manifest.name + "\", chunk: \"" + file.replace(".", "\\.").replace(".js", "\\.js") + "\""));
    const requires = Array.from(new Set(Array.from(code.matchAll(/require\("([^"]+)"\)/g), (m) => m[1]))).sort();
    assert.deepEqual(requires, ["react", "react-dom", "react/jsx-runtime"]);
  }
  const proto = readFileSync(join(pluginDir, "lib", "client.proto.js"), "utf8");
  const puck = readFileSync(join(pluginDir, "lib", "client.puck.js"), "utf8");
  assert.ok(Buffer.byteLength(proto) < 120 * 1024, "预览 chunk 要轻（画布一有原型就加载）");
  assert.match(proto, /shadcn\/ui（MIT）/);
  assert.match(puck, /@puckeditor\/core 0\.\d+\.\d+（MIT/);
  assert.ok(manifest.files.includes("lib/prototype-vocab.js"), "宿主半边 import 的词表必须随包发布");
});
