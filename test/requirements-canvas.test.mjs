// 需求主线 P3：画布里的需求卡（新画布，React Flow）——布局、接线、拖动持久化、入口、旧宿主降级。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

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

const row = (over) => Object.assign({ reqId: "r1", title: "表单导入", virtual: false, stage: "mismatch", tone: "danger", attention: "e2e-mismatch", next: "1 项不符，在截图上批注后回流返工", tasks: 2, tasksDone: 2, prototypes: 1, designVersion: 1, revision: 1, updatedAt: 100 }, over || {});

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test("wbRequirementCanvasItems：每个需求一张卡、排在最左列（负 x）、纵向依次排；虚拟「未归类」不上画布；拖过的以位置表为准；超过 12 张折叠", () => {
  const { wbRequirementCanvasItems } = api();
  const rows = [row({ reqId: "a" }), row({ reqId: "b" }), row({ reqId: "unassigned", virtual: true })];
  const out = wbRequirementCanvasItems(rows, () => undefined);
  assert.deepEqual(out.items.map((i) => i.id), ["req:a", "req:b"], "未归类不上画布");
  assert.ok(out.items.every((i) => i.x < 0), "排在 Agent / 上下文列左边，不挤占它们");
  assert.ok(out.items[1].y - out.items[0].y >= 132, "纵向不重叠（卡高 132）");
  assert.equal(out.hidden, 0);
  const moved = wbRequirementCanvasItems(rows, (id) => (id === "req:b" ? { x: 500, y: 700 } : undefined));
  assert.deepEqual([moved.items[1].x, moved.items[1].y], [500, 700], "用户拖过的位置优先");
  assert.deepEqual([moved.items[0].x, moved.items[0].y], [out.items[0].x, out.items[0].y], "没拖过的仍按默认");
  const many = Array.from({ length: 15 }, (_, i) => row({ reqId: "r" + i }));
  const folded = wbRequirementCanvasItems(many, () => undefined);
  assert.equal(folded.items.length, 12);
  assert.equal(folded.hidden, 3);
  const bad = wbRequirementCanvasItems([null, {}, { reqId: 5 }, undefined, "x"], () => undefined);
  assert.deepEqual([bad.items.length, bad.hidden], [0, 0], "坏数据不抛");
  assert.deepEqual(wbRequirementCanvasItems(undefined, undefined), { hidden: 0, items: [] });
  const zeroSaved = wbRequirementCanvasItems([row({ reqId: "z" })], () => ({ x: 0, y: 0 }));
  assert.deepEqual([zeroSaved.items[0].x, zeroSaved.items[0].y], [0, 0], "拖到 (0,0) 是合法位置，不能被当成「没存过」");
});

test("wbRequirementCard：标题 / 阶段 / 计数 / 下一步 / 待办标记；点卡触发回调；需要你处理的带属性供样式使用", () => {
  const { wbRequirementCard } = api();
  let opened = 0;
  const card = wbRequirementCard(row(), (k, v) => KEY(k, v), () => { opened += 1; });
  const all = texts(card);
  assert.match(all, /表单导入/);
  assert.match(all, /\[req\.stage\.mismatch\]/);
  assert.match(all, /\[req\.attention\.e2e-mismatch\]/, "待办类型走文案键，不露内部 key");
  assert.doesNotMatch(all, /e2e-mismatch(?!\])/);
  assert.match(all, /1 项不符/);
  assert.equal(card.props["data-attention"], "e2e-mismatch");
  assert.ok(String(card.props.className).includes("daw-wb-node"), "复用节点壳，进新画布后由 flowcell 重置定位");
  card.props.onClick();
  assert.equal(opened, 1);
  const heads = [];
  collect(card, heads, (n) => String(n.props.className || "").includes("daw-wb-node-head"));
  assert.equal(heads.length, 1, "只有卡头可拖（卡里有可点击内容）");
  const calm = wbRequirementCard(row({ attention: "", stage: "develop", tone: "brand", next: "" }), (k) => KEY(k), () => {});
  assert.equal(calm.props["data-attention"], "");
  assert.doesNotMatch(texts(calm), /req\.attention/, "没有待办不显示待办标记");
});

// ── 接进画布页 ──────────────────────────────────────────────────────────────

const project = { projectId: "p1", name: "画布", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }, { sessionId: "a" }], links: [], brief: { goal: "g" } };
function makeFetch(state) {
  return (target, init) => {
    const method = (init && init.method) || "GET";
    if (target === "/projects/p1") return ok({ project });
    if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [], mainSessionId: "m" });
    if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [] });
    if (target === "/sessions") return ok({ source: "host", sessions: [] });
    if (target.startsWith("/canvas") && method === "PUT") { state.puts.push(JSON.parse(init.body)); return ok({ rev: 2 }); }
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: state.savedNodes || {}, elements: [] });
    if (target === "/projects/p1/requirements") return state.noRequirementsRoute ? { code: 404, msg: "not found" } : ok({ requirements: state.rows });
    return ok({});
  };
}

async function renderCanvas(state) {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  let flowProps = null;
  const lib = {
    ReactFlow: function ReactFlow(props) { flowProps = props; return { type: "div", props: { className: "rf", children: props.children } }; },
    Background: function () { return null; }, Controls: function () { return null; }, MiniMap: function () { return null; },
    Handle: function () { return null; }, Position: { Left: "left", Right: "right" },
    applyNodeChanges: (changes, nodes) => nodes, FLOW_CSS: ""
  };
  const loaded = loadPlugin({ react: shim, requireAsync: () => Promise.resolve(lib) });
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  const fetcher = makeFetch(state);
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    const body = fetcher(target, init);
    return Promise.resolve({ ok: body.code === 200, status: body.code === 200 ? 200 : 404, json: () => Promise.resolve(body) });
  };
  for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements"]) await t.wbCache.read(url).catch(() => {});
  const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
  await view.settle(10);
  view.rerender();
  return { t, view, flow: () => flowProps, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}

test("画布接线：需求卡作为节点出现（未归类除外），按需求排序，卡片内容是真的；工具条有需求入口并带「需要你处理」数", async () => {
  const state = { puts: [], rows: [
    row({ reqId: "r1", title: "表单导入" }),
    row({ reqId: "r2", title: "批量审批", stage: "design", attention: "confirm-design", tone: "brand", updatedAt: 200 }),
    row({ reqId: "r3", title: "导入历史", stage: "clarify", attention: "", tone: "neutral", updatedAt: 50 }),
    row({ reqId: "unassigned", title: "未归类", virtual: true, stage: "develop", attention: "" })
  ] };
  const c = await renderCanvas(state);
  try {
    const ids = c.flow().nodes.map((n) => n.id);
    assert.ok(ids.includes("req:r1") && ids.includes("req:r2") && ids.includes("req:r3"), ids.join(","));
    assert.ok(!ids.includes("req:unassigned"), "未归类不上画布");
    assert.ok(ids.includes("m") && ids.includes("a") && ids.includes("__thread"), "原有节点一个不少");
    const node = c.flow().nodes.find((n) => n.id === "req:r2");
    assert.equal(node.data.kind, "requirement");
    assert.match(texts(node.data.el), /批量审批/);
    assert.match(texts(node.data.el), /\[req\.attention\.confirm-design\]/);
    assert.ok(node.position.x < 0, "在最左列");
    // 卡之间不重叠
    const ys = ["req:r1", "req:r2", "req:r3"].map((id) => c.flow().nodes.find((n) => n.id === id).position.y).sort((x, y) => x - y);
    assert.ok(ys[1] - ys[0] >= 132 && ys[2] - ys[1] >= 132);
    // 工具条入口：带待办数（r1 + r2 = 2；r3 没有）
    const buttons = [];
    collect(c.view.tree, buttons, (n) => n.type === "button" && n.props.title === "[canvas.req.title]");
    assert.equal(buttons.length, 1);
    assert.equal(texts(buttons[0]), '[canvas.req.open]{"n":2}');
  } finally { c.restore(); }
});

test("画布接线：点需求卡 / 点工具条入口都会跳到需求页；拖动需求卡后位置真的存到宿主（PUT /canvas，带 req: 前缀的 id）", async () => {
  const state = { puts: [], rows: [row({ reqId: "r1" })] };
  const c = await renderCanvas(state);
  try {
    c.t.wbRoute.set({ kind: "workbench", projectId: "p1", tab: "canvas" });
    const node = c.flow().nodes.find((n) => n.id === "req:r1");
    node.data.el.props.onClick();
    assert.deepEqual(c.t.wbRoute.get(), { kind: "workbench", projectId: "p1", tab: "reqs" }, "点卡进需求页");
    c.t.wbRoute.set({ kind: "workbench", projectId: "p1", tab: "canvas" });
    const buttons = [];
    collect(c.view.tree, buttons, (n) => n.type === "button" && n.props.title === "[canvas.req.title]");
    buttons[0].props.onClick();
    assert.equal(c.t.wbRoute.get().tab, "reqs", "工具条入口进需求页");
    // 拖动
    c.flow().onNodeDragStop({}, { id: "req:r1", position: { x: -120.4, y: 333.6 } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await view_settle(c);
    const put = state.puts[state.puts.length - 1];
    assert.ok(put, "拖动后要把位置写回宿主");
    assert.deepEqual([put.nodes["req:r1"].x, put.nodes["req:r1"].y], [-120, 334], "坐标取整、id 带 req: 前缀");
  } finally { c.restore(); }
});
async function view_settle(c) { await c.view.settle(5); }

test("画布接线：存过位置的需求卡刷新后回到原处；没有需求时不画卡、工具条给「＋ 新需求」；旧宿主没有该路由时同样不炸", async () => {
  const saved = await renderCanvas({ puts: [], rows: [row({ reqId: "r1" })], savedNodes: { "req:r1": { x: 40, y: 900, w: 0, h: 0 } } });
  try {
    const node = saved.flow().nodes.find((n) => n.id === "req:r1");
    assert.deepEqual([node.position.x, node.position.y], [40, 900], "宿主里存的位置优先于默认");
  } finally { saved.restore(); }

  const none = await renderCanvas({ puts: [], rows: [] });
  try {
    assert.equal(none.flow().nodes.filter((n) => n.id.startsWith("req:")).length, 0);
    const buttons = [];
    collect(none.view.tree, buttons, (n) => n.type === "button" && n.props.title === "[canvas.req.title]");
    assert.equal(texts(buttons[0]), "[canvas.req.new]", "没有需求时入口是「＋ 新需求」，不是「需要你处理 0」");
    assert.ok(none.flow().nodes.some((n) => n.id === "m"), "画布本身照常");
  } finally { none.restore(); }

  const old = await renderCanvas({ puts: [], rows: [], noRequirementsRoute: true });
  try {
    assert.equal(old.flow().nodes.filter((n) => n.id.startsWith("req:")).length, 0, "旧宿主没有 /requirements：不画卡");
    assert.ok(old.flow().nodes.some((n) => n.id === "m"), "画布照常");
  } finally { old.restore(); }
});

test("画布需求卡的文案键中英都有，样式存在", () => {
  const t = api();
  for (const key of ["canvas.req.new", "canvas.req.open", "canvas.req.title", "canvas.req.more"]) assert.ok(t.WB_TEXT.zh[key] && t.WB_TEXT.en[key], key);
  const css = Array.isArray(t.WB_CSS) ? t.WB_CSS.join("\n") : String(t.WB_CSS);
  for (const cls of [".daw-wb-reqnode{", ".daw-wb-reqnode-title{", ".daw-wb-reqnode-top{"]) assert.ok(css.includes(cls), "CSS 缺 " + cls);
});

test("画布接线：超过 12 个需求时只画前 12 张，工具条入口的提示说明还有几个、去需求页看全部", async () => {
  const many = Array.from({ length: 14 }, (_, i) => row({ reqId: "r" + i, title: "需求" + i, updatedAt: 1000 - i }));
  const c = await renderCanvas({ puts: [], rows: many });
  try {
    assert.equal(c.flow().nodes.filter((n) => n.id.startsWith("req:")).length, 12);
    const buttons = [];
    collect(c.view.tree, buttons, (n) => n.type === "button" && typeof n.props.title === "string" && n.props.title.startsWith("[canvas.req."));
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props.title, '[canvas.req.more]{"n":2}', "不能悄悄少画：要告诉用户还有 2 个");
  } finally { c.restore(); }
});
// ── 经典画布（宿主不支持按需分包时的回退）──────────────────────────────────────

async function renderClassic(state) {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  const loaded = loadPlugin({ react: shim });
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  const fetcher = makeFetch(state);
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    const body = fetcher(target, init);
    return Promise.resolve({ ok: body.code === 200, status: body.code === 200 ? 200 : 404, json: () => Promise.resolve(body) });
  };
  for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements"]) await t.wbCache.read(url).catch(() => {});
  const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
  await view.settle(10);
  view.rerender();
  return { t, view, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}
const reqCards = (tree) => { const out = []; collect(tree, out, (n) => n.props["data-kind"] === "requirement"); return out; };

test("经典画布：需求卡画在最右一列（固定位置、纵向不重叠、可点击进需求页）；未归类不画；没有需求 / 旧宿主不画", async () => {
  const c = await renderClassic({ puts: [], rows: [
    row({ reqId: "r1", title: "表单导入" }),
    row({ reqId: "r2", title: "批量审批", stage: "design", attention: "confirm-design", tone: "brand" }),
    row({ reqId: "unassigned", title: "未归类", virtual: true })
  ] });
  try {
    const cards = reqCards(c.view.tree);
    assert.equal(cards.length, 2, "未归类不画");
    assert.deepEqual(cards.map((n) => texts(n).includes("表单导入") || texts(n).includes("批量审批")), [true, true]);
    assert.ok(cards.every((n) => n.props.style.left >= 1000), "在 Agent / 添加卡右边的那一列（x ≥ 1000），不压住它们");
    assert.ok(cards[1].props.style.top - cards[0].props.style.top >= 132, "纵向不重叠");
    assert.ok(cards.every((n) => typeof n.props.style.left === "number" && typeof n.props.style.top === "number"), "经典舞台是绝对定位，必须带 left / top");
    assert.ok(cards.every((n) => String(n.props.className).includes("daw-wb-node")));
    c.t.wbRoute.set({ kind: "workbench", projectId: "p1", tab: "canvas" });
    cards[0].props.onClick();
    assert.equal(c.t.wbRoute.get().tab, "reqs", "点卡进需求页");
    const keys = cards.map((n) => n.props.key);
    assert.equal(new Set(keys).size, keys.length, "每张卡有唯一 key（React 列表要求）");
  } finally { c.restore(); }

  for (const state of [{ puts: [], rows: [] }, { puts: [], rows: [], noRequirementsRoute: true }]) {
    const none = await renderClassic(state);
    try { assert.equal(reqCards(none.view.tree).length, 0); } finally { none.restore(); }
  }
});

test("经典画布：存过的位置不影响需求卡（经典画布里它们不可拖，位置固定）；工具条入口两种画布都有", async () => {
  const c = await renderClassic({ puts: [], rows: [row({ reqId: "r1" })], savedNodes: { "req:r1": { x: -500, y: -500, w: 0, h: 0 } } });
  try {
    const card = reqCards(c.view.tree)[0];
    assert.equal(card.props.style.left, 1030, "新画布里拖到别处存下的位置，不能把经典画布里的卡带到屏幕外");
    const buttons = [];
    collect(c.view.tree, buttons, (n) => n.type === "button" && n.props.title === "[canvas.req.title]");
    assert.equal(buttons.length, 1, "经典画布也有需求入口");
  } finally { c.restore(); }
});
// ── 缩放三档 ────────────────────────────────────────────────────────────────

test("wbZoomLevel：< 0.5 远景、≥ 1 近景、其余中景；边界值；非数字不乱切", () => {
  const { wbZoomLevel } = api();
  assert.equal(wbZoomLevel(0.3), "far");
  assert.equal(wbZoomLevel(0.49), "far");
  assert.equal(wbZoomLevel(0.5), "mid", "0.5 属于中景");
  assert.equal(wbZoomLevel(0.99), "mid");
  assert.equal(wbZoomLevel(1), "near", "1 属于近景");
  assert.equal(wbZoomLevel(2), "near");
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, "1", {}]) assert.equal(wbZoomLevel(bad), "mid", "非有限数字回落中景：" + String(bad));
});

test("新画布缩放档：视口变化回调改变容器 data-zoom 与档位提示；初始按实例 getZoom；平移（zoom 不变）不改档", async () => {
  const state = { puts: [], rows: [row({ reqId: "r1" })] };
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  let flowProps = null;
  const lib = {
    ReactFlow: function ReactFlow(props) { flowProps = props; return { type: "div", props: { className: "rf", children: props.children } }; },
    Background: function () { return null; }, Controls: function () { return null; }, MiniMap: function () { return null; },
    Handle: function () { return null; }, Position: { Left: "left", Right: "right" },
    applyNodeChanges: (changes, nodes) => nodes, FLOW_CSS: ""
  };
  const loaded = loadPlugin({ react: shim, requireAsync: () => Promise.resolve(lib) });
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  const fetcher = makeFetch(state);
  globalThis.fetch = (url, init) => { const body = fetcher(String(url).replace("/agent-whales/api", ""), init); return Promise.resolve({ ok: body.code === 200, status: 200, json: () => Promise.resolve(body) }); };
  try {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements"]) await t.wbCache.read(url).catch(() => {});
    const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
    await view.settle(10);
    let tree = view.rerender();
    const zoomOf = (tr) => { const out = []; collect(tr, out, (n) => String(n.props.className || "").split(/\s+/).indexOf("daw-wb-flow") >= 0); return out[0] && out[0].props["data-zoom"]; };
    const labelOf = (tr) => { const out = []; collect(tr, out, (n) => n.props["data-zoom-label"] !== undefined); return out[0] ? [out[0].props["data-zoom-label"], texts(out[0])] : null; };
    assert.equal(zoomOf(tree), "mid", "默认中景");
    assert.deepEqual(labelOf(tree), ["mid", "[canvas.zoom.mid]"]);
    flowProps.onViewportChange({ x: 10, y: 10, zoom: 0.3 });
    tree = view.rerender();
    assert.equal(zoomOf(tree), "far");
    assert.deepEqual(labelOf(tree), ["far", "[canvas.zoom.far]"], "档位提示跟着变");
    flowProps.onViewportChange({ x: 500, y: 500, zoom: 0.3 });
    assert.equal(zoomOf(view.rerender()), "far", "只平移、缩放没变：档位不变");
    flowProps.onViewportChange({ x: 0, y: 0, zoom: 1.4 });
    assert.equal(zoomOf(view.rerender()), "near");
    flowProps.onViewportChange(null);
    flowProps.onViewportChange({ zoom: "x" });
    assert.equal(zoomOf(view.rerender()), "near", "坏回调参数被忽略，不会把档位打回去");
    flowProps.onInit({ getZoom: () => 0.2 });
    assert.equal(zoomOf(view.rerender()), "far", "初始化时按实例当前缩放定档");
    flowProps.onInit({ getZoom() { throw new Error("boom"); } });
    assert.equal(zoomOf(view.rerender()), "far", "读不到缩放不抛、保持原档");
    flowProps.onInit({});
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

test("缩放三档的 CSS：每一档都有规则；远景隐藏需求卡的下一步 / 计数与节点副标题并放大标题；中景把「下一步」限两行；近景不截断", () => {
  const t = api();
  const css = Array.isArray(t.WB_CSS) ? t.WB_CSS.join("\n") : String(t.WB_CSS);
  const rule = (needle) => { const i = css.indexOf(needle); return i < 0 ? "" : css.slice(i, css.indexOf("}", i) + 1); };
  assert.match(rule('.daw-wb-flow[data-zoom=far] .daw-wb-reqnode .daw-wb-req-next'), /display:none/, "远景隐藏下一步");
  assert.ok(rule('.daw-wb-flow[data-zoom=far] .daw-wb-reqnode .daw-wb-req-next').includes(".daw-wb-node-sub"), "远景也隐藏节点副标题");
  assert.match(rule('.daw-wb-flow[data-zoom=far] .daw-wb-reqnode-title'), /font-size:18px/, "远景放大标题，缩小后仍可读");
  assert.match(rule('.daw-wb-flow[data-zoom=mid] .daw-wb-reqnode .daw-wb-req-next'), /line-clamp:2/);
  assert.equal(css.includes('data-zoom=near] .daw-wb-reqnode .daw-wb-req-next'), false, "近景不对「下一步」加任何截断 / 隐藏");
  assert.ok(css.includes(".daw-wb-zoomlevel{"));
  for (const level of ["far", "mid", "near"]) assert.ok(t.WB_TEXT.zh["canvas.zoom." + level] && t.WB_TEXT.en["canvas.zoom." + level], level);
  assert.ok(t.WB_TEXT.zh["canvas.zoom.hint"] && t.WB_TEXT.en["canvas.zoom.hint"]);
});