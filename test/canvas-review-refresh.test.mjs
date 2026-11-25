/** 画布内需求审查 + 无干扰刷新（2026-11-25 用户反馈）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMount, createReactShim, findByClass, installDocumentStub, loadPlugin, render, walk } from "./harness.mjs";

const h = createReactShim().createElement;
const ok = (data) => ({ code: 200, msg: "success", data });

function textOf(tree) {
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && tree.props ? textOf(tree.props.children) : "";
}

function buttonByText(tree, text) {
  let found = null;
  walk(tree, (node) => {
    if (found || !node || !node.props || node.props.className !== "daw-wb-btn") return;
    const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
    if (children.includes(text)) found = node;
  });
  return found;
}

test("工作台缓存不定时轮询项目/画布，只有显式刷新才重拉", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  let calls = 0;
  let intervals = 0;
  globalThis.fetch = () => { calls += 1; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ projects: [] })) }); };
  globalThis.setInterval = () => { intervals += 1; return 1; };
  try {
    const unsubscribe = api.wbCache.subscribe("/projects", () => {});
    await api.wbCache.read("/projects");
    assert.equal(calls, 1);
    assert.equal(intervals, 0, "项目资源不得再起 5s 定时器");
    const snapshot = api.wbCache.getSnapshot("/projects");
    await api.wbCache.read("/projects");
    assert.equal(api.wbCache.getSnapshot("/projects"), snapshot, "内容相同不发布新快照");
    unsubscribe();
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch; else globalThis.fetch = originalFetch;
    if (originalInterval === undefined) delete globalThis.setInterval; else globalThis.setInterval = originalInterval;
    api.wbCache.reset();
  }
});

test("缓存：后台失败后相同数据恢复会清错；invalidate 在旧 GET 期间会补拉", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let fail = false;
  globalThis.fetch = () => {
    calls += 1;
    const payload = fail ? { code: 500, msg: "boom" } : ok({ value: 1 });
    return Promise.resolve({ ok: !fail, status: fail ? 500 : 200, json: () => Promise.resolve(payload) });
  };
  try {
    await api.wbCache.read("/cache-case");
    fail = true;
    await assert.rejects(() => api.wbCache.read("/cache-case"), /http 500/);
    fail = false;
    await api.wbCache.read("/cache-case");
    assert.equal(api.wbCache.getSnapshot("/cache-case").error, null);

    let release;
    calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ value: calls })) });
      return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ value: calls })) }); });
    };
    const unsubscribe = api.wbCache.subscribe("/cache-inflight", () => {});
    const pending = api.wbCache.read("/cache-inflight");
    api.wbCache.invalidate("/cache-inflight");
    release();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, "写后失效不能旧快照吞掉");
    unsubscribe();
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch; else globalThis.fetch = originalFetch;
    api.wbCache.reset();
  }
});

test("右侧栏窄模式：没有内部侧栏，顶栏只保留刷新与齿轮，不再出现编排/搜索/回退", async () => {
  const { plugin } = loadPlugin({
    fetch: (url) => {
      const path = String(url).replace("/agent-whales/api", "");
      if (path === "/projects/p1") return ok({ project: { projectId: "p1", name: "项目甲", mainSessionId: "m", members: [] } });
      return ok({ sessions: [], tasks: {}, requirements: [], packs: [], elements: [], rev: 1, nodes: {}, groups: [] });
    }
  });
  installDocumentStub();
  const api = plugin.__test;
  api.wbRoute.set({ kind: "workbench", projectId: "p1", tab: "canvas" });
  for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements"]) await api.wbCache.read(url);
  const tree = render(h(api.WhaleWorkbench, { narrow: true, route: { kind: "workbench", projectId: "p1", tab: "canvas" } }));
  assert.equal(findByClass(tree, "daw-wb-side").length, 0, "右侧栏不再渲染内部侧栏");
  assert.equal(findByClass(tree, "daw-wb")[0].props["data-narrow"], "true");
  assert.equal(findByClass(tree, "daw-wb-tab").length, 3, "画布/表格/办公室，无独立需求页");
  assert.doesNotMatch(textOf(tree), /编排|搜索项目|一键回退/);
  assert.match(textOf(tree), /⚙/);
  api.wbCache.reset();
});

test("设计审查列表只取本需求的原型帧和画板", () => {
  const api = loadPlugin().plugin.__test;
  const items = api.wbRequirementDesignItems([
    { id: "board:a", kind: "artboard", data: { requirementId: "r1" } },
    { id: "proto:b", kind: "prototype", requirementId: "r1", data: {} },
    { id: "board:c", kind: "artboard", data: { requirementId: "r2" } },
    { id: "comp:d", kind: "component", data: { requirementId: "r1" } }
  ], "r1");
  assert.deepEqual(items.map((item) => item.id), ["board:a", "proto:b"]);
});

test("只有画板、没有原型帧的需求也能确认设计", () => {
  const api = loadPlugin().plugin.__test;
  const actions = api.wbRequirementActions({ virtual: false, evidence: { prototypeCount: 0, designCount: 1, dirtyPrototypeCount: 1, taskTotal: 0, taskDone: 0, reworkCap: 3, reworkCount: 0 } }, []);
  assert.equal(actions.confirmDesign, true);
});

test("画布内需求面板的确认按钮真的调用 confirm-design 并带 revision", async () => {
  const { shim, mount } = createMount({ effects: true });
  const writes = [];
  const requirement = { reqId: "r1", projectId: "p1", title: "导入设计", stage: "design", stageLabel: "设计", tone: "info", attention: "confirm-design", next: "确认设计", revision: 7, designVersion: 0, evidence: { prototypeCount: 0, designCount: 1, dirtyPrototypeCount: 1, taskTotal: 0, taskDone: 0, reworkCap: 3, reworkCount: 0 } };
  const { plugin } = loadPlugin({ react: shim, fetch: (url, init) => {
    const path = String(url).replace("/agent-whales/api", "");
    if (init && init.method === "POST") { writes.push({ path, body: JSON.parse(init.body) }); return ok({ requirement }); }
    if (path === "/projects/p1/requirements/r1") return ok({ requirement });
    if (path === "/projects/p1/requirements/r1/e2e") return ok({ runs: [] });
    if (path.startsWith("/canvas")) return ok({ rev: 1, nodes: {}, elements: [] });
    return ok({ comments: [], packs: [], requirements: [] });
  } });
  installDocumentStub();
  const api = plugin.__test;
  for (const url of ["/projects/p1/requirements/r1", "/projects/p1/requirements/r1/e2e", "/canvas?projectId=p1", "/design/comments?projectId=p1", "/component-packs"]) await api.wbCache.read(url);
  const view = mount(api.WbRequirementCanvasPanel, { projectId: "p1", reqId: "r1" });
  await view.settle(10);
  const button = buttonByText(view.tree, "确认设计并推进");
  assert.ok(button, "画布审查面板里有确认按钮");
  button.props.onClick();
  await view.settle(10);
  assert.deepEqual(writes[0], { path: "/projects/p1/requirements/r1/confirm-design", body: { expectedRevision: 7 } });
  api.wbCache.reset();
});

test("设计预览请求带同源 token，避免 403 后只显示拿不到编译产物", () => {
  const source = readFileSync(new URL("../tools/flow-chunk/design/entry.jsx", import.meta.url), "utf8");
  const built = readFileSync(new URL("../lib/client.design.js", import.meta.url), "utf8");
  assert.match(source, /fetch\(API \+ "\/design\/source" \+ query, \{ headers \}\)/);
  assert.match(built, /x-whales-token/);
});

test("画布通过文件变更流定向刷新，弹窗锚定画布而不是浏览器窗口", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /new EventSource\(WB_API \+ "\/store-stream/);
  assert.match(source, /event: store-changed|store-changed/);
  assert.match(source, /daw-wb-mask-canvas\{position:absolute/);
  assert.match(source, /canvasAnchored: true/);
});

test("画布底部工具条只放按钮，窄侧栏隐藏小地图以减少遮挡", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /daw-wb-canvaswrap>\.daw-wb-toolbar>\.daw-wb-btn\{flex:0 0 auto\}/);
  assert.match(source, /data-narrow='true'\] \.react-flow__minimap\{display:none\}/);
  assert.doesNotMatch(source, /h\("span", \{ className: "daw-wb-note" \}, t\("tab\.note\.canvas"\)\)/);
});

test("编排入口离开顶部队形，避免遮挡 DSH 原生侧栏按钮", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /daw-graph-launcher\{position:fixed;left:16px;bottom:16px/);
  assert.match(source, /编排入口不再放顶部队形尾部/);
  assert.doesNotMatch(source, /图形编排面板的开关：常驻在队形尾部/);
});

test("画布与设计节点按钮统一使用 shadcn 风格按钮类", () => {
  const source = readFileSync(new URL("../tools/flow-chunk/design/entry.jsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /className: "daw-wb-btn"/);
  assert.doesNotMatch(source, /chrome\.btn/);
  assert.match(client, /daw-wb-zoombtn\{display:inline-flex/);
  assert.match(client, /daw-wb-btn\[data-on=true\]/);
});

test("设计节点在画布内提供标注与直接改，并接已有编辑/评论接口", () => {
  const source = readFileSync(new URL("../tools/flow-chunk/design/entry.jsx", import.meta.url), "utf8");
  assert.match(source, /mode === "annotate"/);
  assert.match(source, /mode === "edit"/);
  assert.match(source, /\/design\/comments\?projectId=/);
  assert.match(source, /\/design\/edit\?projectId=/);
  assert.match(source, /\/design\/classes\?projectId=/);
  assert.match(source, /setMode\(mode === "annotate"/);
  assert.match(source, /setMode\(mode === "edit"/);
});
