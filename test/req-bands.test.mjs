// 设计稿 §7 ② 需求分组框：每个需求一带——需求卡 + 它名下的原型帧 / 流程图分组框排成一行，外面一圈虚线框。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

const KEY = (key, vars) => "[" + key + "]" + (vars ? JSON.stringify(vars) : "");
const ok = (data) => ({ code: 200, msg: "success", data });
const api = () => loadPlugin().plugin.__test;

const card = (reqId, over) => Object.assign({ id: "req:" + reqId, row: { reqId, title: "T" + reqId }, reqId, fixed: false, defaultY: 24, x: -300, y: 24, w: 230 }, over || {});
const member = (id, reqId, over) => Object.assign({ id, reqId, w: 440, h: 440, fixed: false, x: 0, y: 0 }, over || {});
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("wbElementRequirementId：元素自己或 data 里写过才算；坏数据 / 没写过都是空串，不凭空猜", () => {
  const { wbElementRequirementId } = api();
  assert.equal(wbElementRequirementId({ data: { requirementId: "r1" } }), "r1");
  assert.equal(wbElementRequirementId({ requirementId: "r2", data: { requirementId: "r1" } }), "r2", "元素自己的优先");
  for (const bad of [undefined, null, 5, "x", [], {}, { data: null }, { data: { requirementId: 5 } }, { requirementId: "" }]) assert.equal(wbElementRequirementId(bad), "", JSON.stringify(bad));
});

test("wbRequirementBands：没拖过的成员排在自己需求卡左边、顶对齐、一个挨一个向左；一带高度 = 最高的成员；下一带在它下面；每带有成员才画框", () => {
  const { wbRequirementBands, WB_REQ_BAND } = api();
  const cards = [card("a"), card("b", { defaultY: 172, y: 172 }), card("c", { defaultY: 320, y: 320 })];
  const members = [member("p1", "a"), member("p2", "a", { h: 560 }), member("g1", "b", { w: 300, h: 200 })];
  const out = wbRequirementBands(cards, members);
  // a 带：卡在 y=24；p1 紧贴卡左（x = -300 - gap - 440），p2 再向左
  assert.deepEqual(out.cards["req:a"], { x: -300, y: 24 });
  assert.deepEqual(out.members.p1, { x: -300 - WB_REQ_BAND.memberGap - 440, y: 24 });
  assert.deepEqual(out.members.p2, { x: out.members.p1.x - WB_REQ_BAND.memberGap - 440, y: 24 });
  // a 带高 = max(卡 132, 560) = 560；b 带有框 → 间距 framedGap
  assert.equal(out.cards["req:b"].y, 24 + 560 + WB_REQ_BAND.framedGap);
  assert.deepEqual(out.members.g1, { x: -300 - WB_REQ_BAND.memberGap - 300, y: out.cards["req:b"].y });
  // c 没有成员：不画框；它前面的 b 有框 → 仍用 framedGap（框的底边要让出内边距）
  assert.equal(out.cards["req:c"].y, out.cards["req:b"].y + 200 + WB_REQ_BAND.framedGap, "b 带高 = max(132, 200)");
  assert.deepEqual(out.frames.map((f) => f.reqId), ["a", "b"], "c 只有一张卡，不画框");
  // 框 = 当前真实位置的包围盒 + 内边距 + 标题条
  const fa = out.frames[0];
  assert.equal(fa.x, out.members.p2.x - WB_REQ_BAND.pad);
  assert.equal(fa.y, 24 - WB_REQ_BAND.head);
  assert.equal(fa.w, (-300 + 230) - out.members.p2.x + 2 * WB_REQ_BAND.pad);
  assert.equal(fa.h, 560 + WB_REQ_BAND.head + WB_REQ_BAND.pad);
  assert.equal(fa.memberCount, 2);
  assert.equal(fa.id, "reqframe:a");
  // 框与框之间、框与别的需求卡之间都不重叠
  const boxOfCard = (id) => ({ x: out.cards[id].x, y: out.cards[id].y, w: 230, h: 132 });
  assert.ok(!overlap(out.frames[0], out.frames[1]), "两个框不叠");
  assert.ok(!overlap(out.frames[0], boxOfCard("req:b")) && !overlap(out.frames[0], boxOfCard("req:c")), "a 的框不盖住 b / c 的卡");
  assert.ok(!overlap(out.frames[1], boxOfCard("req:c")), "b 的框不盖住 c 的卡");
});

test("wbRequirementBands：没有框的相邻带用小间距（不浪费空间）；一个框都没有时与旧布局一致", () => {
  const { wbRequirementBands } = api();
  const cards = [card("a"), card("b", { defaultY: 172, y: 172 }), card("c", { defaultY: 320, y: 320 })];
  const out = wbRequirementBands(cards, []);
  assert.deepEqual(out.frames, []);
  assert.deepEqual(out.members, {});
  assert.deepEqual([out.cards["req:a"].y, out.cards["req:b"].y, out.cards["req:c"].y], [24, 24 + 132 + 16, 24 + 2 * (132 + 16)], "和 wbRequirementCanvasItems 的默认纵向排布完全一致");
});

test("wbRequirementBands：用户拖过的成员 / 需求卡保持原位且不参与排队；框按真实位置取包围盒（拖动后框跟着走）", () => {
  const { wbRequirementBands, WB_REQ_BAND } = api();
  // 成员被拖到很远的地方：框把它也框进去
  const farMember = member("p1", "a", { fixed: true, x: 900, y: 700 });
  const out = wbRequirementBands([card("a")], [farMember]);
  assert.equal(out.members.p1, undefined, "拖过的成员不给新位置（保持它存下来的）");
  const f = out.frames[0];
  assert.equal(f.x, -300 - WB_REQ_BAND.pad);
  assert.equal(f.x + f.w, 900 + 440 + WB_REQ_BAND.pad, "框右边界跟着成员走");
  assert.equal(f.y + f.h, 700 + 440 + WB_REQ_BAND.pad, "框下边界跟着成员走");
  // 需求卡被拖过：成员默认位置跟着卡，不占用别的带的游标
  const dragged = card("a", { fixed: true, x: 100, y: 800 });
  const out2 = wbRequirementBands([dragged, card("b", { defaultY: 172, y: 172 })], [member("p1", "a"), member("p2", "b")]);
  assert.deepEqual(out2.cards["req:a"], { x: 100, y: 800 }, "拖过的卡原位");
  assert.deepEqual(out2.members.p1, { x: 100 - WB_REQ_BAND.memberGap - 440, y: 800 }, "它的成员跟着卡走");
  assert.equal(out2.cards["req:b"].y, 24, "拖走的卡不占游标：下一个需求从起点开始排");
  assert.equal(out2.members.p2.y, 24);
});

test("wbRequirementBands：没有归属的成员 / 归属到画布上没有的需求（超过 12 个被折叠、已删除）/ 坏数据：一律不碰，不抛", () => {
  const { wbRequirementBands } = api();
  const out = wbRequirementBands([card("a")], [member("orphan", ""), member("ghost", "zzz"), null, undefined, { id: 5 }, { id: "x", reqId: "a", w: "wide", h: 1 }, member("ok", "a")]);
  assert.deepEqual(Object.keys(out.members), ["ok"], "只有归属到画布上的需求的成员被排");
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0].memberCount, 1, "坏成员不计入");
  assert.deepEqual(wbRequirementBands(undefined, undefined), { cards: {}, members: {}, frames: [] });
  assert.deepEqual(wbRequirementBands([null, {}, { id: "x" }], [member("p", "a")]), { cards: {}, members: {}, frames: [] }, "没有可用的卡就什么都不排");
  const dupFixed = wbRequirementBands([card("a")], [member("p", "a", { fixed: true })]);
  assert.equal(dupFixed.frames.length, 1, "fixed 但坐标是 0,0 也是合法位置");
});

test("wbRequirementCanvasItems 的 items 多出 reqId / fixed / defaultY（拖到 (0,0) 也算拖过）", () => {
  const { wbRequirementCanvasItems } = api();
  const rows = [{ reqId: "r1", virtual: false }, { reqId: "r2", virtual: false }];
  const out = wbRequirementCanvasItems(rows, (id) => (id === "req:r2" ? { x: 0, y: 0 } : undefined));
  assert.deepEqual(out.items.map((i) => [i.reqId, i.fixed, i.defaultY]), [["r1", false, 24], ["r2", true, 24 + 132 + 16]]);
  assert.deepEqual([out.items[1].x, out.items[1].y], [0, 0]);
});

// ── 接进画布页 ──────────────────────────────────────────────────────────────

const project = { projectId: "p1", name: "画布", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }, { sessionId: "a" }], links: [], brief: { goal: "g" } };
const reqRow = (reqId, title, over) => Object.assign({ reqId, title, virtual: false, stage: "design", tone: "brand", attention: "", next: "", tasks: 0, tasksDone: 0, prototypes: 0, designVersion: 1, revision: 1, updatedAt: 100, ownerSessionId: "" }, over || {});
const proto = (id, reqId, over) => Object.assign({ id, kind: "prototype", x: null, y: null, data: { title: id, width: "desktop", requirementId: reqId, puck: { content: [] } }, provenance: { by: "agent" } }, over || {});
const flowGroup = (flowId, reqId, over) => Object.assign({ id: "flow:" + flowId, kind: "group", x: null, y: null, data: Object.assign({ flowId, title: flowId, kind: "flow" }, reqId ? { requirementId: reqId } : {}), provenance: { by: "agent" } }, over || {});
const flowNode = (flowId, key) => ({ id: "flow:" + flowId + ":" + key, kind: "flow", parentId: "flow:" + flowId, data: { flowId, key, shape: "step", text: key }, provenance: { by: "agent", sourceMessageIds: ["m1"] } });

async function renderCanvas({ rows, elements, savedNodes }) {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  let flowProps = null;
  const lib = {
    ReactFlow: function ReactFlow(props) { flowProps = props; return { type: "div", props: { className: "rf", children: props.children } }; },
    Background: () => null, Controls: () => null, MiniMap: () => null, Handle: () => null, Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    // 真的应用 dimensions / position 变更（真 React Flow 的行为）：测量后的尺寸与拖动中的位置才能进到舞台状态里
    applyNodeChanges: (changes, nodes) => nodes.map((node) => {
      let next = node;
      for (const change of changes || []) {
        if (change.id !== node.id) continue;
        if (change.type === "dimensions" && change.dimensions) next = Object.assign({}, next, { measured: { width: change.dimensions.width, height: change.dimensions.height } });
        if (change.type === "position" && change.position) next = Object.assign({}, next, { position: change.position, dragging: change.dragging === true });
      }
      return next;
    }),
    layoutWithDagre: () => ({}), FLOW_CSS: "",
    // 原型 chunk（同一个假库兼任）：就绪条件是这两个函数存在；PROTO_CSS / 预览渲染这里用不上
    PrototypeNode: () => null, LibraryNode: () => null
  };
  const loaded = loadPlugin({ react: shim, requireAsync: () => Promise.resolve(lib) });
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    let body = ok({});
    if (target === "/projects/p1") body = ok({ project });
    else if (target === "/projects/p1/mcp-links") body = ok({ projectId: "p1", available: [], links: [], members: [], mainSessionId: "m" });
    else if (target.startsWith("/tasks?projectId=")) body = ok({ source: "project", projectId: "p1", tasks: [] });
    else if (target === "/sessions") body = ok({ source: "host", sessions: [] });
    else if (target.startsWith("/canvas")) body = ok({ rev: 1, nodes: savedNodes || {}, elements });
    else if (target === "/projects/p1/requirements") body = ok({ requirements: rows });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements"]) await t.wbCache.read(url).catch(() => {});
  const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
  await view.settle(10);
  view.rerender();
  return { t, view, flow: () => flowProps, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; t.wbCache.reset(); } };
}

test("画布接线：有原型 / 流程图的需求画出分组框（排在节点数组最前、不可拖不可选不挡鼠标）；成员默认排到卡左边；没有成员的需求不画框", async () => {
  const c = await renderCanvas({
    rows: [reqRow("r1", "表单导入", { attention: "confirm-design" }), reqRow("r2", "批量审批"), reqRow("r3", "只有一张卡")],
    elements: [proto("proto:a", "r1"), proto("proto:b", "r1", { data: { title: "b", width: "mobile", requirementId: "r1", puck: { content: [] } } }), flowGroup("main", "r2"), flowNode("main", "start"), proto("proto:orphan", "")]
  });
  try {
    const nodes = c.flow().nodes;
    const frames = nodes.filter((n) => n.type === "whaleReqFrame");
    assert.deepEqual(frames.map((n) => n.id).sort(), ["reqframe:r1", "reqframe:r2"], "r3 没有成员，不画框");
    assert.deepEqual(nodes.slice(0, frames.length).map((n) => n.type), frames.map(() => "whaleReqFrame"), "框排在最前，画在所有卡的下面");
    for (const f of frames) {
      assert.equal(f.draggable, false); assert.equal(f.selectable, false); assert.equal(f.focusable, false);
      assert.equal(f.zIndex, -1); assert.equal(f.style.pointerEvents, "none", "不挡鼠标：框里的卡照常点、照常拖");
      assert.equal(f.style.width, f.data.w); assert.equal(f.style.height, f.data.h);
    }
    const f1 = frames.find((n) => n.id === "reqframe:r1");
    assert.equal(f1.data.title, "表单导入");
    assert.equal(f1.data.stageLabel, "[req.stage.design]");
    assert.equal(f1.data.attentionLabel, "[req.attention.confirm-design]");
    // 成员默认位置：在自己需求卡的左边，顶对齐
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const card1 = byId["req:r1"];
    assert.ok(byId["proto:a"].position.x < card1.position.x && byId["proto:b"].position.x < byId["proto:a"].position.x, "原型向左依次排开");
    assert.equal(byId["proto:a"].position.y, card1.position.y, "和卡顶对齐");
    assert.ok(byId["flow:main"].position.x < byId["req:r2"].position.x, "流程图分组框在 r2 的卡左边");
    assert.equal(byId["flow:main"].position.y, byId["req:r2"].position.y);
    // 一带的高度 = 最高的成员：r1 带里有一个手机宽的原型（560 高），所以 r2 的卡在它下面 560 + 框间距
    assert.equal(byId["req:r2"].position.y, card1.position.y + 560 + 80, "手机宽原型按 560 高算");
    // 框把卡和成员都框住
    const inside = (n, w) => n.position.x >= f1.position.x && n.position.x + w <= f1.position.x + f1.data.w && n.position.y >= f1.position.y && n.position.y + 100 <= f1.position.y + f1.data.h;
    assert.ok(inside(card1, 230) && inside(byId["proto:a"], 440) && inside(byId["proto:b"], 440), "r1 的卡与两个原型都在框里");
    // 没有归属的原型：仍在原来的右侧默认位置，不进任何框
    assert.ok(byId["proto:orphan"].position.x >= 1500, "没归属的原型不被拉进需求带");
    // 需求卡之间不被框盖住
    const box = (n, w, h) => ({ x: n.position.x, y: n.position.y, w, h });
    const f2 = frames.find((n) => n.id === "reqframe:r2");
    const boxOf = (f) => ({ x: f.position.x, y: f.position.y, w: f.data.w, h: f.data.h });
    assert.ok(!overlap(boxOf(f1), box(byId["req:r2"], 230, 132)), "r1 的框不盖住 r2 的卡");
    assert.ok(!overlap(boxOf(f1), boxOf(f2)), "两个框不叠");
  } finally { c.restore(); }
});

test("画布接线：用户拖过的原型保持原位、框把它包进去；没有任何带归属的元素时一个框都没有，需求卡位置与旧布局一致", async () => {
  const dragged = await renderCanvas({
    rows: [reqRow("r1", "表单导入")],
    elements: [proto("proto:a", "r1", { x: 1200, y: 900 })]
  });
  try {
    const byId = Object.fromEntries(dragged.flow().nodes.map((n) => [n.id, n]));
    assert.deepEqual(byId["proto:a"].position, { x: 1200, y: 900 }, "拖过的位置不变");
    const f = byId["reqframe:r1"];
    assert.ok(f.position.x + f.data.w >= 1200 + 440 && f.position.y + f.data.h >= 900 + 440, "框跟着真实位置走");
  } finally { dragged.restore(); }
  const none = await renderCanvas({ rows: [reqRow("r1", "A"), reqRow("r2", "B")], elements: [proto("proto:x", ""), flowGroup("g", "")] });
  try {
    const nodes = none.flow().nodes;
    assert.equal(nodes.filter((n) => n.type === "whaleReqFrame").length, 0, "没有归属就没有框");
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    assert.deepEqual([byId["req:r1"].position.y, byId["req:r2"].position.y], [24, 24 + 132 + 16], "与旧布局一致");
    assert.ok(byId["proto:x"].position.x >= 1500 && byId["flow:g"].position.x >= 1000, "没归属的元素仍在原来的默认位置");
  } finally { none.restore(); }
});

test("画布接线：用户拖过的需求卡位置照旧存取（框不影响位置表语义：req: 前缀的 id 仍是需求卡，框的 id 不会被存进位置表）", async () => {
  const c = await renderCanvas({ rows: [reqRow("r1", "A")], elements: [proto("proto:a", "r1")], savedNodes: { "req:r1": { x: 500, y: 600, w: 0, h: 0 } } });
  try {
    const byId = Object.fromEntries(c.flow().nodes.map((n) => [n.id, n]));
    assert.deepEqual(byId["req:r1"].position, { x: 500, y: 600 }, "存过的需求卡位置优先");
    assert.deepEqual(byId["proto:a"].position, { x: 500 - 24 - 440, y: 600 }, "它的原型默认跟着这张卡走");
    // 拖动停止回调对框不触发（框不可拖）；对卡写位置表
    const calls = [];
    const original = c.t.wbNodePositions.set;
    c.t.wbNodePositions.set = (...args) => { calls.push(args); };
    try { c.flow().onNodeDragStop({}, { id: "reqframe:r1", position: { x: 1, y: 2 } }); } finally { c.t.wbNodePositions.set = original; }
    assert.deepEqual(calls, [], "框的拖动停止回调不写位置表（框是纯装饰，位置由成员推出来）");
    // 对照：同一个回调对真正的需求卡会写位置表（否则上面的断言是空转）
    const calls2 = [];
    c.t.wbNodePositions.set = (...args) => { calls2.push(args); };
    try { c.flow().onNodeDragStop({}, { id: "req:r1", position: { x: 11, y: 22 } }); } finally { c.t.wbNodePositions.set = original; }
    assert.deepEqual(calls2.map((a) => [a[0], a[1], a[2], a[3]]), [["p1", "req:r1", 11, 22]]);
  } finally { c.restore(); }
});

test("分组框的样式存在且不拦截鼠标；远景档放大标题；节点类型表里有 whaleReqFrame", () => {
  const t = api();
  const css = Array.isArray(t.WB_CSS) ? t.WB_CSS.join("\n") : String(t.WB_CSS);
  const rule = css.split("\n").map((line) => line.trim()).find((line) => line.indexOf(".daw-wb-reqframe{") >= 0);
  assert.ok(rule, "有分组框规则");
  assert.match(rule, /pointer-events:none/);
  assert.match(rule, /border:1\.5px dashed/);
  assert.ok(css.indexOf(".daw-wb-flow[data-zoom=far] .daw-wb-reqframe-title{") >= 0, "远景档标题放大");
  assert.ok(css.indexOf(".daw-wb-reqframe[data-attention]:not([data-attention=\"\"]){") >= 0, "有待办的需求框用警示色");
  const types = t.wbFlowNodeTypes({ Handle: () => null, Position: {} }, null, null);
  assert.equal(typeof types.whaleReqFrame, "function");
  const rendered = types.whaleReqFrame({ data: { title: "标题", stage: "design", attention: "x", stageLabel: "设计", attentionLabel: "待确认", w: 300, h: 200 } });
  assert.equal(rendered.props.className, "daw-wb-reqframe");
  assert.equal(rendered.props["data-attention"], "x");
});

test("wbFrameBox：四周留内边距、上面多留标题条；空 / 坏输入给 null；坏盒子被忽略", () => {
  const { wbFrameBox, WB_REQ_BAND } = api();
  assert.deepEqual(wbFrameBox([{ x: 10, y: 20, w: 100, h: 50 }, { x: 200, y: 0, w: 30, h: 400 }]), { x: 10 - WB_REQ_BAND.pad, y: 0 - WB_REQ_BAND.head, w: 230 - 10 + 2 * WB_REQ_BAND.pad, h: 400 - 0 + WB_REQ_BAND.head + WB_REQ_BAND.pad });
  for (const bad of [undefined, null, [], [null], [{ x: "a", y: 0, w: 1, h: 1 }], [{ x: NaN, y: 0, w: 1, h: 1 }]]) assert.equal(wbFrameBox(bad), null, JSON.stringify(bad));
  assert.deepEqual(wbFrameBox([null, { x: 0, y: 0, w: 10, h: 10 }]), { x: -WB_REQ_BAND.pad, y: -WB_REQ_BAND.head, w: 10 + 2 * WB_REQ_BAND.pad, h: 10 + WB_REQ_BAND.head + WB_REQ_BAND.pad }, "坏盒子被忽略，好盒子照算");
});

test("舞台里的分组框按成员测得的真实尺寸与实时位置重算：测量前用回退尺寸，测量后贴着内容；拖动中也跟着走；成员没渲染出来时不抛", async () => {
  const c = await renderCanvas({ rows: [reqRow("r1", "表单导入")], elements: [proto("proto:a", "r1")] });
  try {
    const find = (id) => c.flow().nodes.find((n) => n.id === id);
    const before = find("reqframe:r1");
    const protoBefore = find("proto:a");
    // 回退尺寸：原型按 440 高算
    assert.equal(before.data.h, 440 + 36 + 20, "测量前：用布局的回退高度（原型槽位 440 + 标题条 + 内边距）");
    // 测量：原型真实只有 300×120，需求卡 230×140
    c.flow().onNodesChange([
      { type: "dimensions", id: "proto:a", dimensions: { width: 300, height: 120 } },
      { type: "dimensions", id: "req:r1", dimensions: { width: 230, height: 140 } }
    ]);
    c.view.rerender();
    const after = find("reqframe:r1");
    const cardNow = find("req:r1"); const protoNow = find("proto:a");
    const minX = Math.min(protoNow.position.x, cardNow.position.x);
    const maxX = Math.max(protoNow.position.x + 300, cardNow.position.x + 230);
    assert.equal(after.position.x, minX - 20);
    assert.equal(after.data.w, maxX - minX + 40, "宽度贴着测得的尺寸（不再用 440）");
    assert.equal(after.data.h, 140 - 0 + 36 + 20, "高度 = 最高的测得高度（卡 140）+ 标题条 + 内边距，不再是 440 槽位");
    assert.equal(after.style.height, after.data.h); assert.equal(after.style.width, after.data.w);
    assert.equal(after.position.y, protoNow.position.y - 36, "框顶 = 成员顶 - 标题条");
    assert.ok(after.data.h < before.data.h, "测量后框变小了——不再框着一大片空白");
    // 拖动中：成员位置变了，框跟着变（不用等松手）
    c.flow().onNodesChange([{ type: "position", id: "proto:a", position: { x: protoNow.position.x - 600, y: protoNow.position.y + 500 }, dragging: true }]);
    c.view.rerender();
    const during = find("reqframe:r1");
    assert.equal(during.position.x, protoNow.position.x - 600 - 20, "拖动中框的左边界跟着成员");
    assert.ok(during.position.y + during.data.h >= protoNow.position.y + 500 + 120, "拖动中框的下边界跟着成员");
    assert.equal(find("proto:a").position.x, protoNow.position.x - 600, "成员位置本身没被框改动");
    // 成员拖到需求卡右边：框的右边界 = 成员左边 + 测得的宽度 300（不是回退的 440），宽度才能验出「用的是实测值」
    const cardX = find("req:r1").position.x;
    c.flow().onNodesChange([{ type: "position", id: "proto:a", position: { x: cardX + 700, y: protoNow.position.y }, dragging: true }]);
    c.view.rerender();
    const right = find("reqframe:r1");
    assert.equal(right.position.x + right.data.w, cardX + 700 + 300 + 20, "右边界按测得的宽度 300 算，而不是回退的 440");
    // 框自己的位置变更（理论上不会发生，因为不可拖）不会把框钉住：下一次渲染仍由成员决定
    c.flow().onNodesChange([{ type: "position", id: "reqframe:r1", position: { x: 99999, y: 99999 }, dragging: true }]);
    c.view.rerender();
    assert.notEqual(find("reqframe:r1").position.x, 99999, "框的几何永远由成员推出来");
  } finally { c.restore(); }
});
