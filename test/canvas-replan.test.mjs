// 重新规划 R2：删除经典画布 / 引擎切换 / Thread 节点 / MCP 节点。新画布（React Flow）是唯一的画布。
// 画布加载不了（旧宿主不支持按需分包 / 加载中 / 加载失败）时，给一块明确的说明，其余页签照常，不再退回第二套画布。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";
import { fakeFlowLib } from "./flow-harness.mjs";

const KEY = (key, vars) => "[" + key + "]" + (vars ? JSON.stringify(vars) : "");
const ok = (data) => ({ code: 200, msg: "success", data });
const api = () => loadPlugin().plugin.__test;

function collect(node, out, match) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) { node.forEach((item) => collect(item, out, match)); return; }
  if (typeof node !== "object") return;
  if (node.props && match(node)) out.push(node);
  collect(node.props ? node.props.children : undefined, out, match);
}
function texts(node) {
  const out = [];
  const walk = (n) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== "object") return;
    walk(n.props ? n.props.children : undefined);
  };
  walk(node);
  return out.join("");
}
const hasClass = (n, cls) => String(n.props.className || "").split(/\s+/).indexOf(cls) >= 0;

const project = { projectId: "p1", name: "画布", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }, { sessionId: "a" }], links: [], brief: { goal: "g" } };
function fetcher(target) {
  if (target === "/projects/p1") return ok({ project });
  if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [], mainSessionId: "m" });
  if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [] });
  if (target === "/sessions") return ok({ source: "host", sessions: [] });
  if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: {}, elements: [] });
  if (target === "/projects/p1/requirements") return ok({ requirements: [] });
  return ok({});
}

/** requireAsync 由调用方决定：不传 = 旧宿主没有 require.async；传函数 = 按需分包。 */
async function mountCanvas({ requireAsync, storedExtra } = {}) {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  const capture = { props: null };
  const options = { react: shim };
  if (requireAsync) options.requireAsync = () => requireAsync(capture);
  if (storedExtra) options.storedExtra = storedExtra;
  const loaded = loadPlugin(options);
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const body = fetcher(String(url).replace("/agent-whales/api", ""));
    return Promise.resolve({ ok: body.code === 200, status: 200, json: () => Promise.resolve(body) });
  };
  for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements"]) await t.wbCache.read(url).catch(() => {});
  const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
  await view.settle(10);
  view.rerender();
  return { t, view, capture, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}
const fallbackOf = (view) => { const out = []; collect(view.tree, out, (n) => hasClass(n, "daw-wb-canvas-fallback")); return out[0]; };

test("画布降级的四种状态：加载中 / 旧宿主不支持 / 加载失败（带原因与重试）/ 就绪（没有降级块，渲染 ReactFlow）", async () => {
  // 加载中：分包永远不返回
  const loading = await mountCanvas({ requireAsync: () => new Promise(() => {}) });
  try {
    const f = fallbackOf(loading.view);
    assert.ok(f, "加载中要有说明");
    assert.equal(f.props["data-state"], "loading");
    assert.match(texts(f), /\[canvas\.fallback\.loading\]/);
    assert.equal(loading.capture.props, null, "还没有 ReactFlow");
  } finally { loading.restore(); }
  // 旧宿主：没有 require.async
  const unavailable = await mountCanvas({});
  try {
    const f = fallbackOf(unavailable.view);
    assert.equal(f.props["data-state"], "unavailable");
    assert.match(texts(f), /\[canvas\.fallback\.unavailable\]/);
    const retry = []; collect(f, retry, (n) => n.type === "button" || (typeof n.type === "function" && /retry/.test(texts(n))));
    assert.equal(retry.length, 0, "「不支持」不是临时故障，不给重试按钮");
  } finally { unavailable.restore(); }
  // 失败 → 重试 → 就绪
  let attempts = 0;
  const failing = await mountCanvas({ requireAsync: (capture) => { attempts += 1; return attempts === 1 ? Promise.reject(new Error("chunk 404")) : Promise.resolve(fakeFlowLib(capture)); } });
  try {
    const f = fallbackOf(failing.view);
    assert.equal(f.props["data-state"], "failed");
    assert.match(texts(f), /\[canvas\.fallback\.failed\]\{"reason":"chunk 404"\}/, "失败原因如实显示");
    const buttons = []; collect(f, buttons, (n) => typeof n.type === "function" || n.type === "button");
    const retry = buttons.find((n) => /canvas\.fallback\.retry/.test(texts(n)));
    assert.ok(retry, "失败给重试");
    retry.props.onClick();
    await failing.view.settle(10);
    failing.view.rerender();
    assert.equal(fallbackOf(failing.view), undefined, "重试成功后降级块消失");
    assert.ok(failing.capture.props, "ReactFlow 渲染出来了");
    assert.equal(attempts, 2);
  } finally { failing.restore(); }
  // 就绪
  const ready = await mountCanvas({ requireAsync: (capture) => Promise.resolve(fakeFlowLib(capture)) });
  try {
    assert.equal(fallbackOf(ready.view), undefined);
    assert.ok(ready.capture.props && Array.isArray(ready.capture.props.nodes));
  } finally { ready.restore(); }
});

test("工具条：没有「新 / 经典画布」切换按钮，也没有 MCP 一键全清；旧版本记在 localStorage 里的「经典」偏好被忽略（仍是新画布）", async () => {
  const c = await mountCanvas({ requireAsync: (capture) => Promise.resolve(fakeFlowLib(capture)), storedExtra: { "dsh-agent-whales.canvas-engine": "classic" } });
  try {
    assert.ok(c.capture.props, "存着 classic 也走新画布");
    const body = texts(c.view.tree);
    assert.doesNotMatch(body, /canvas\.engine\./, "没有引擎切换");
    assert.doesNotMatch(body, /canvas\.mcp\.clearAll/, "没有 MCP 一键全清");
    const nodes = c.capture.props.nodes.map((n) => n.id);
    assert.ok(!nodes.includes("__thread"), "没有 Thread 回合记录节点");
    const stage = []; collect(c.view.tree, stage, (n) => ["daw-wb-stage", "daw-wb-canvas", "daw-wb-minimap", "daw-wb-zoombar"].some((cls) => hasClass(n, cls)));
    assert.equal(stage.length, 0, "没有经典舞台 / 小地图 / 缩放条");
  } finally { c.restore(); }
});

test("已删除的东西确实不在了：导出的纯函数、样式规则、文案键（防止下次有人「顺手恢复」一半）", () => {
  const t = api();
  for (const name of ["wbCanvasEngine", "wbThreadNode", "wbMcpNodes", "wbIsMcpNodeId"]) assert.equal(t[name], undefined, name + " 已删除");
  assert.equal(typeof t.wbMcpLinkPairs, "function", "wbMcpLinkPairs 仍在（设置页的 MCP 矩阵用它）");
  assert.equal(typeof t.wbMcpAllowedBySession, "function", "wbMcpAllowedBySession 仍在（Agent 卡徽标用它）");
  const css = String(t.WB_CSS);
  for (const dead of [".daw-wb-stage{", ".daw-wb-canvas{", ".daw-wb-canvas-grid{", ".daw-wb-minimap{", ".daw-wb-mininode{", ".daw-wb-miniview{", ".daw-wb-zoombar{", ".daw-wb-mini{", ".daw-wb-mini-block{", ".daw-wb-link{", ".daw-wb-edge-mcp", "data-kind=mcp"]) {
    assert.equal(css.indexOf(dead), -1, "样式规则 " + dead + " 应已删除");
  }
  assert.ok(css.indexOf(".daw-wb-canvas-fallback{") >= 0, "降级块的样式在");
  assert.ok(css.includes(".daw-wb-flowbar{") && css.includes(".daw-wb-zoombtn[data-on=true]"), "画布模式条与其共享的选中态样式均可用");
  assert.ok(css.indexOf(".daw-wb-canvaswrap{") >= 0, "画布容器样式在");
  for (const lang of ["zh", "en"]) {
    for (const key of ["canvas.thread", "canvas.thread.members", "canvas.engine.classic", "canvas.engine.flow", "canvas.legend.mcp"]) assert.equal(t.WB_TEXT[lang][key], undefined, lang + " " + key + " 应已删除");
    for (const key of ["canvas.fallback.loading", "canvas.fallback.failed", "canvas.fallback.unavailable", "canvas.fallback.retry"]) assert.ok(t.WB_TEXT[lang][key], lang + " 缺 " + key);
  }
  assert.match(t.WB_TEXT.zh["canvas.fallback.failed"], /\{reason\}/);
  assert.match(t.WB_TEXT.en["canvas.fallback.failed"], /\{reason\}/);
});
