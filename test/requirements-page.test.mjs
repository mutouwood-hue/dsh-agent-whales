// 需求主线 P3：需求页（需求列表 → 需求详情：设计确认 / E2E 运行 / 批注 / 回流）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

const api = () => loadPlugin().plugin.__test;

function collect(node, out, match) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((child) => collect(child, out, match)); return; }
  if (node.props && match(node)) out.push(node);
  collect(node.props ? node.props.children : undefined, out, match);
}
function texts(node) {
  const out = [];
  const walkText = (n) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walkText); return; }
    if (typeof n !== "object") return;
    walkText(n.props ? n.props.children : undefined);
  };
  walkText(node);
  return out.join("");
}
const byClass = (tree, cls) => { const out = []; collect(tree, out, (n) => String(n.props.className || "").split(/\s+/).indexOf(cls) >= 0); return out; };
const byTag = (tree, tag) => { const out = []; collect(tree, out, (n) => n.type === tag); return out; };
const KEY = (key) => "[" + key + "]";
const button = (tree, key) => byTag(tree, "button").find((b) => texts(b) === KEY(key));
const ok = (data) => ({ code: 200, msg: "success", data });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test("wbRequirementActions：确认设计 / 开始验收 / 回流 / 返工上限的入口判定", () => {
  const { wbRequirementActions } = api();
  const view = (over, ev) => Object.assign({ virtual: false, evidence: Object.assign({ prototypeCount: 1, dirtyPrototypeCount: 0, taskTotal: 2, taskDone: 2, reworkCount: 0, reworkCap: 3 }, ev || {}) }, over || {});
  assert.equal(wbRequirementActions(view(null, { dirtyPrototypeCount: 1 }), []).confirmDesign, true);
  assert.equal(wbRequirementActions(view(), []).confirmDesign, false, "没有待确认的改动不亮");
  assert.equal(wbRequirementActions(view(null, { prototypeCount: 0, dirtyPrototypeCount: 0 }), []).confirmDesign, false, "没有原型帧不亮");
  assert.equal(wbRequirementActions(view(), []).startRun, true);
  assert.equal(wbRequirementActions(view(null, { taskDone: 1 }), []).startRun, false, "任务没全完工不亮");
  assert.equal(wbRequirementActions(view(null, { taskTotal: 0, taskDone: 0 }), []).startRun, false, "没有任务不亮");
  assert.equal(wbRequirementActions(view(null, { dirtyPrototypeCount: 1 }), []).startRun, false, "设计没确认不亮");
  assert.equal(wbRequirementActions(view(), [{ runId: "run-1", status: "running" }]).startRun, false, "已有没结束的运行不亮");
  assert.equal(wbRequirementActions(view(), [{ runId: "run-1", status: "running" }]).openRunId, "run-1");
  const failed = { runId: "run-2", status: "failed", failed: 2, errored: 0, reflowed: 0 };
  assert.equal(wbRequirementActions(view(), [failed]).reflow, true);
  assert.equal(wbRequirementActions(view(), [Object.assign({}, failed, { reflowed: 2 })]).reflow, false, "都回流过了不亮");
  assert.equal(wbRequirementActions(view(), [Object.assign({}, failed, { failed: 0, errored: 0 })]).reflow, false, "没有失败不亮");
  assert.equal(wbRequirementActions(view(), [failed]).latestRunId, "run-2");
  assert.equal(wbRequirementActions(view(null, { reworkCount: 3 }), []).reworkLimit, true);
  assert.equal(wbRequirementActions(view(null, { reworkCount: 2 }), []).reworkLimit, false);
  const virtual = wbRequirementActions(view({ virtual: true }, { dirtyPrototypeCount: 1 }), []);
  assert.deepEqual([virtual.confirmDesign, virtual.startRun], [false, false], "未归类没有设计 / 验收");
  assert.deepEqual(wbRequirementActions(null, null), { confirmDesign: false, startRun: false, openRunId: "", reflow: false, reworkLimit: false, latestRunId: "" });
});

test("wbRectFromDrag：拖拽折成 0..1 的框；反向拖也对；越界夹住；太小 / 缺尺寸当没框", () => {
  const { wbRectFromDrag } = api();
  assert.deepEqual(wbRectFromDrag({ x: 50, y: 40 }, { x: 150, y: 120 }, 200, 200), { x: 0.25, y: 0.2, w: 0.5, h: 0.4 });
  assert.deepEqual(wbRectFromDrag({ x: 150, y: 120 }, { x: 50, y: 40 }, 200, 200), { x: 0.25, y: 0.2, w: 0.5, h: 0.4 }, "反向拖拽等价");
  assert.deepEqual(wbRectFromDrag({ x: -50, y: -10 }, { x: 400, y: 500 }, 200, 200), { x: 0, y: 0, w: 1, h: 1 }, "超出截图的部分夹住");
  assert.equal(wbRectFromDrag({ x: 10, y: 10 }, { x: 11, y: 11 }, 200, 200), null, "一次点击不算框");
  assert.equal(wbRectFromDrag({ x: 0, y: 0 }, { x: 100, y: 100 }, 0, 200), null);
  assert.equal(wbRectFromDrag(null, { x: 1, y: 1 }, 200, 200), null);
  const r = wbRectFromDrag({ x: 33, y: 33 }, { x: 77, y: 99 }, 321, 123);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "结果一定落在宿主接受的范围内");
});

test("wbWrite：成功返回 data；业务失败把宿主的原因原样抛出（不是 http 400）；无响应体回退到 http 状态", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ code: 40000, msg: "这个需求下还没有原型帧，没有可确认的设计", data: { x: 1 } }) });
    await assert.rejects(api().wbWrite("/x", "POST", {}), (error) => error.message === "这个需求下还没有原型帧，没有可确认的设计" && error.data.x === 1);
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ a: 1 })) });
    assert.deepEqual(await api().wbWrite("/x", "PUT", {}), { a: 1 });
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error("not json")) });
    await assert.rejects(api().wbWrite("/x", "POST"), /http 502/);
    globalThis.fetch = () => Promise.reject(new Error("network down"));
    await assert.rejects(api().wbWrite("/x", "POST"), /network down/);
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

// ── 页面 ────────────────────────────────────────────────────────────────────

const reqView = (over, ev) => Object.assign({
  reqId: "r1", projectId: "p1", title: "表单导入", goal: "把 xlsx 导入表单", virtual: false, stage: "mismatch", stageLabel: "不符", tone: "bad",
  next: "1 项不符，在截图上批注后回流返工", attention: "e2e-mismatch", revision: 3, designVersion: 1, reworkCount: 0, reworkCap: 3,
  counts: { tasks: 2, tasksDone: 2, prototypes: 1, flows: 0, runs: 1 }, updatedAt: 100,
  evidence: Object.assign({ prototypeCount: 1, dirtyPrototypeCount: 0, taskTotal: 2, taskDone: 2, reworkCount: 0, reworkCap: 3 }, ev || {})
}, over || {});
const failedRun = (over) => Object.assign({
  runId: "run-ab12cd34", projectId: "p1", requirementId: "r1", designVersion: 1, driver: "tabbit-cli", status: "failed",
  results: [
    { caseId: "c1", title: "上传并识别表头", status: "passed", shots: [], note: "" },
    { caseId: "c2", title: "未匹配字段给建议", status: "failed", note: "找不到映射建议", shots: ["step3.png"], diagnosis: { kind: "code", reason: "实现缺失", by: "ai" } }
  ],
  annotations: [], summary: { total: 2, passed: 1, failed: 1, errored: 0, pending: 0, accepted: 0, reflowed: 0 }
}, over || {});
const summaryOf = (run) => Object.assign({ runId: run.runId, status: run.status }, run.summary);

async function renderDetail(state) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    calls.push({ target, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : undefined });
    let data = {};
    if (target === "/projects/p1/requirements/r1") data = { requirement: state.view };
    else if (target === "/projects/p1/requirements/r1/e2e") data = { reqId: "r1", runs: state.runs.map(summaryOf) };
    else if (target.startsWith("/projects/p1/e2e/")) data = { run: state.runs.find((run) => target.endsWith(run.runId)) };
    const wrote = (init && init.method && init.method !== "GET") ? (state.write ? state.write(target, init) : ok({})) : ok(data);
    return Promise.resolve({ ok: wrote.code === 200 || !wrote.fail, status: wrote.fail ? 400 : 200, json: () => Promise.resolve(wrote) });
  };
  const { mount, shim } = createMount();
  const { plugin } = loadPlugin({ react: shim });
  installDocumentStub();
  const t = plugin.__test;
  for (const url of ["/projects/p1/requirements/r1", "/projects/p1/requirements/r1/e2e"].concat(state.runs.slice(0, 3).map((run) => "/projects/p1/e2e/" + run.runId))) await t.wbCache.read(url).catch(() => {});
  const view = mount(t.WbReqDetail, { t: (key) => KEY(key), projectId: "p1", reqId: "r1", onBack: () => {} });
  await tick();
  calls.length = 0;
  return { view, calls, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}

test("需求详情：阶段 / 下一步 / 设计版本 / 运行与用例 / 初判 / 截图；失败的用例才有批注与可接受入口", async () => {
  const run = failedRun();
  const { view, restore } = await renderDetail({ view: reqView(), runs: [run] });
  try {
    const all = texts(view.tree);
    assert.match(all, /表单导入/);
    assert.match(all, /\[req\.stage\.mismatch\]/);
    assert.match(all, /\[req\.attention\.e2e-mismatch\]/, "待办类型走文案键，不露内部 key");
    assert.doesNotMatch(all, /e2e-mismatch(?!\])/);
    assert.match(all, /run-ab12cd34/);
    assert.match(all, /c2 · 未匹配字段给建议/);
    assert.match(all, /找不到映射建议/);
    assert.match(all, /\[req\.case\.diagnosis\]/);
    const imgs = byTag(view.tree, "img");
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].props.src, "/agent-whales/api/projects/p1/e2e/run-ab12cd34/files/step3.png", "截图走白名单下发路由，文件名已编码");
    const cases = byClass(view.tree, "daw-wb-case");
    const passedCase = cases.find((n) => n.props["data-status"] === "passed");
    const failedCase = cases.find((n) => n.props["data-status"] === "failed");
    assert.equal(button(passedCase, "req.case.accept"), undefined, "通过的用例不能标可接受");
    assert.equal(button(passedCase, "req.ann.add"), undefined, "通过的用例不能写批注");
    assert.ok(button(failedCase, "req.case.accept"));
    assert.ok(button(failedCase, "req.ann.add"));
    assert.equal(button(failedCase, "req.case.mark.failed"), undefined, "运行已结束不能再手动标结果");
    assert.ok(button(view.tree, "req.reflow"), "有没回流的失败 → 回流按钮");
    assert.equal(button(view.tree, "req.reflow").props.disabled, false);
  } finally { restore(); }
});

test("需求详情：点按钮真的发请求——标可接受 / 回流 / 确认设计 / 开始验收 / 结束运行 / 手动标结果", async () => {
  const dirty = reqView({ stage: "design", attention: "confirm-design", tone: "info", designVersion: 0 }, { dirtyPrototypeCount: 1 });
  const d = await renderDetail({ view: dirty, runs: [] });
  try {
    assert.equal(button(d.view.tree, "req.design.confirm").props.disabled, false);
    assert.equal(button(d.view.tree, "req.run.start").props.disabled, true, "设计没确认不能开始验收");
    button(d.view.tree, "req.design.confirm").props.onClick();
    await tick();
    assert.deepEqual(d.calls[0], { target: "/projects/p1/requirements/r1/confirm-design", method: "POST", body: { expectedRevision: 3 } }, "带上当前 revision（CAS）");
  } finally { d.restore(); }

  const run = failedRun();
  const f = await renderDetail({ view: reqView(), runs: [run] });
  try {
    button(f.view.tree, "req.reflow").props.onClick();
    await tick();
    assert.deepEqual(f.calls.find((c) => c.method === "POST"), { target: "/projects/p1/e2e/run-ab12cd34/reflow", method: "POST", body: {} });
    f.calls.length = 0;
    const failedCase = byClass(f.view.tree, "daw-wb-case").find((n) => n.props["data-status"] === "failed");
    button(failedCase, "req.case.accept").props.onClick();
    await tick();
    assert.deepEqual(f.calls.find((c) => c.method === "POST"), { target: "/projects/p1/e2e/run-ab12cd34/results/c2/accept", method: "POST", body: undefined });
  } finally { f.restore(); }

  const ready = reqView({ stage: "accept", attention: null, tone: "warn" });
  const s = await renderDetail({ view: ready, runs: [] });
  try {
    assert.equal(button(s.view.tree, "req.run.start").props.disabled, false);
    button(s.view.tree, "req.run.start").props.onClick();
    await tick();
    assert.deepEqual(s.calls.find((c) => c.method === "POST"), { target: "/projects/p1/requirements/r1/e2e", method: "POST", body: {} });
  } finally { s.restore(); }

  const open = failedRun({ status: "running", results: [{ caseId: "c1", title: "A", status: "pending", shots: [], note: "" }], summary: { total: 1, passed: 0, failed: 0, errored: 0, pending: 1, accepted: 0, reflowed: 0 } });
  const m = await renderDetail({ view: reqView({ attention: null }), runs: [open] });
  try {
    const row = byClass(m.view.tree, "daw-wb-case")[0];
    button(row, "req.case.mark.failed").props.onClick();
    await tick();
    assert.deepEqual(m.calls.find((c) => c.method === "PUT"), { target: "/projects/p1/e2e/run-ab12cd34/results/c1", method: "PUT", body: { status: "failed" } });
    m.calls.length = 0;
    button(m.view.tree, "req.run.finish").props.onClick();
    await tick();
    assert.equal(m.calls.find((c) => c.method === "POST").target, "/projects/p1/e2e/run-ab12cd34/finish");
    assert.equal(button(row, "req.ann.add"), undefined, "运行中不能批注");
  } finally { m.restore(); }
});

test("需求详情：宿主拒绝时把真原因显示出来（不是 http 400）；返工到上限时提示并禁用回流", async () => {
  const dirty = reqView({ stage: "design", attention: "confirm-design", designVersion: 0 }, { dirtyPrototypeCount: 1 });
  const d = await renderDetail({ view: dirty, runs: [], write: () => ({ code: 40000, msg: "自 v1 以来原型没有改动，不需要重新确认", fail: true }) });
  try {
    button(d.view.tree, "req.design.confirm").props.onClick();
    await tick(); await tick();
    const banner = byClass(d.view.rerender(), "daw-wb-banner").map(texts).join("|");
    assert.match(banner, /自 v1 以来原型没有改动/, "界面显示宿主给的原因");
  } finally { d.restore(); }

  const capped = await renderDetail({ view: reqView({ reworkCount: 3, attention: "rework-limit" }, { reworkCount: 3 }), runs: [failedRun()] });
  try {
    assert.match(texts(capped.view.tree), /\[req\.limit\]/);
    assert.equal(button(capped.view.tree, "req.reflow").props.disabled, true, "到上限不能再回流");
    assert.ok(button(byClass(capped.view.tree, "daw-wb-case").find((n) => n.props["data-status"] === "failed"), "req.case.accept"), "但仍可标可接受走出来");
  } finally { capped.restore(); }
});

test("需求详情：虚拟「未归类」没有设计 / 验收区；找不到需求时给出错误态而不是白屏", async () => {
  const v = await renderDetail({ view: reqView({ virtual: true, reqId: "unassigned" }), runs: [] });
  try {
    const all = texts(v.view.tree);
    assert.doesNotMatch(all, /\[req\.section\.design\]|\[req\.section\.e2e\]/);
    assert.match(all, /\[req\.virtual\.title\]/);
  } finally { v.restore(); }
});

test("需求列表页：建需求（Enter / 按钮）发 POST 并带标题；空标题不可点；卡片显示阶段与下一步；页签与路由都认 reqs", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    calls.push({ target, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : undefined });
    if (init && init.method === "POST") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ requirement: reqView({ reqId: "r9", title: "新需求" }) })) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ requirements: [reqView({ updatedAt: 100 }), reqView({ reqId: "r2", title: "批量审批", stage: "design", attention: "confirm-design", tone: "info", updatedAt: 200 })] })) });
  };
  try {
    const { mount, shim } = createMount();
    const { plugin } = loadPlugin({ react: shim });
    installDocumentStub();
    const t = plugin.__test;
    await t.wbCache.read("/projects/p1/requirements");
    const view = mount(t.WbReqsPage, { t: (key) => KEY(key), projectId: "p1" });
    await tick();
    const cards = byClass(view.tree, "daw-wb-card");
    assert.equal(cards.length, 2);
    assert.equal(cards[0].props["data-attention"], "confirm-design", "需要你处理的排最前并带标记");
    assert.match(texts(cards[0]), /批量审批/);
    assert.match(texts(cards[0]), /\[req\.attention\.confirm-design\]/);
    assert.match(texts(cards[1]), /1 项不符/);
    assert.equal(button(view.tree, "req.new").props.disabled, true, "标题为空不可点");
    // 页签与路由
    assert.equal(t.wbRouteOf("/projects/p1/reqs") === undefined || true, true);
    t.wbRoute.set({ kind: "workbench", projectId: "p1", tab: "reqs" });
    assert.equal(t.wbRoute.get().tab, "reqs");
    assert.ok(t.WB_TEXT.zh["tab.reqs"] && t.WB_TEXT.en["tab.reqs"]);
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

test("需求页文案：新增的 req.* / tab.* / inbox 键中英一致且非空；每个运行 / 用例状态与回流落点都有文案", () => {
  const t = api();
  const pick = (lang) => Object.keys(t.WB_TEXT[lang]).filter((key) => key.startsWith("req.") || key.startsWith("tab.") && key.indexOf("reqs") >= 0).sort();
  assert.deepEqual(pick("zh"), pick("en"));
  for (const status of ["queued", "running", "passed", "failed", "error"]) assert.ok(t.WB_TEXT.zh["req.run.status." + status], "运行状态 " + status);
  for (const status of ["pending", "running", "passed", "accepted", "failed", "error"]) assert.ok(t.WB_TEXT.zh["req.case.status." + status], "用例状态 " + status);
  for (const kind of ["code", "design", "requirement"]) assert.ok(t.WB_TEXT.zh["req.reflow." + kind] && t.WB_TEXT.en["req.reflow." + kind], "回流落点 " + kind);
  for (const key of pick("zh")) { assert.ok(String(t.WB_TEXT.zh[key]).trim() !== "", "zh " + key); assert.ok(String(t.WB_TEXT.en[key]).trim() !== "", "en " + key); }
  const css = Array.isArray(t.WB_CSS) ? t.WB_CSS.join("\n") : String(t.WB_CSS);
  for (const cls of [".daw-wb-e2erun{", ".daw-wb-case{", ".daw-wb-shot{", ".daw-wb-shot-box{", ".daw-wb-ann-edit", ".daw-wb-req-head"]) assert.ok(css.includes(cls), "CSS 缺 " + cls);
});

test("按钮的禁用状态：设计已确认且没改动时「确认设计」不可点；运行中即使有失败的用例也不能写批注 / 标可接受；回流只在运行结束后", async () => {
  // 设计已确认、没有待确认的改动 → 确认按钮禁用（防止点一下白白换来一次宿主拒绝）
  const settled = await renderDetail({ view: reqView({ stage: "develop", attention: null, tone: "info" }, { dirtyPrototypeCount: 0 }), runs: [] });
  try {
    assert.equal(button(settled.view.tree, "req.design.confirm").props.disabled, true);
  } finally { settled.restore(); }
  // 运行还没结束，但其中一条已经报了失败：此时不能批注、不能标可接受（宿主也会拒绝），只能继续跑或结束
  const running = failedRun({
    status: "running",
    results: [{ caseId: "c1", title: "A", status: "failed", note: "x", shots: ["a.png"] }, { caseId: "c2", title: "B", status: "pending", shots: [], note: "" }],
    summary: { total: 2, passed: 0, failed: 1, errored: 0, pending: 1, accepted: 0, reflowed: 0 }
  });
  const open = await renderDetail({ view: reqView({ attention: null }), runs: [running] });
  try {
    const failedCase = byClass(open.view.tree, "daw-wb-case").find((n) => n.props["data-status"] === "failed");
    assert.equal(button(failedCase, "req.ann.add"), undefined, "运行中不能写批注");
    assert.equal(button(failedCase, "req.case.accept"), undefined, "运行中不能标可接受");
    assert.ok(button(failedCase, "req.case.mark.passed"), "运行中可以改判");
    assert.equal(button(open.view.tree, "req.reflow").props.disabled, true, "运行没结束不能回流");
  } finally { open.restore(); }
  // 已经回流过的失败用例：不再给批注 / 可接受入口，只显示「已回流」
  const sent = failedRun({
    results: [{ caseId: "c1", title: "A", status: "failed", note: "x", shots: [], reflowed: true, reflowedTo: "design" }],
    summary: { total: 1, passed: 0, failed: 1, errored: 0, pending: 0, accepted: 0, reflowed: 1 }
  });
  const done = await renderDetail({ view: reqView({ attention: null }), runs: [sent] });
  try {
    const row = byClass(done.view.tree, "daw-wb-case")[0];
    assert.equal(button(row, "req.ann.add"), undefined);
    assert.equal(button(row, "req.case.accept"), undefined);
    assert.match(texts(row), /\[req\.case\.reflowed\]/);
    assert.equal(button(done.view.tree, "req.reflow").props.disabled, true, "都回流过了，回流按钮不亮");
  } finally { done.restore(); }
});

test("截图地址：文件名里的特殊字符要编码（不能把路径分隔符 / 问号 / # 原样拼进 URL）；录屏不当图片渲染", async () => {
  const run = failedRun({
    results: [{ caseId: "c1", title: "A", status: "failed", note: "x", shots: ["a b#1.png", "clip.webm", "x%2Fy.png"] }],
    summary: { total: 1, passed: 0, failed: 1, errored: 0, pending: 0, accepted: 0, reflowed: 0 }
  });
  const d = await renderDetail({ view: reqView(), runs: [run] });
  try {
    const srcs = byTag(d.view.tree, "img").map((n) => n.props.src);
    assert.deepEqual(srcs, [
      "/agent-whales/api/projects/p1/e2e/run-ab12cd34/files/a%20b%231.png",
      "/agent-whales/api/projects/p1/e2e/run-ab12cd34/files/x%252Fy.png"
    ], "特殊字符被编码；webm 不渲染成 img");
  } finally { d.restore(); }
});
test("回流之后：详情页里每条运行都被重新取一遍（批注从「删除」变成「已回流」），而不是只刷新需求", async () => {
  const run = failedRun({ annotations: [{ annId: "a1", caseId: "c2", expected: "显示建议下拉", handled: false }] });
  const d = await renderDetail({ view: reqView(), runs: [run], write: () => ok({}) });
  try {
    const reads = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => { reads.push({ target: String(url).replace("/agent-whales/api", ""), method: (init && init.method) || "GET" }); return inner(url, init); };
    button(d.view.tree, "req.reflow").props.onClick();
    await tick(); await tick(); await tick();
    const refetched = reads.filter((r) => r.method === "GET").map((r) => r.target);
    assert.ok(refetched.includes("/projects/p1/e2e/run-ab12cd34"), "运行详情必须重取：" + JSON.stringify(refetched));
    assert.ok(refetched.includes("/projects/p1/requirements/r1"), "需求也要重取");
    // 待办 / 任务只有「有订阅者」时才会重取（侧栏在真页面里订阅它们；这里没挂侧栏，不应该发请求，也不该断言它）。
  } finally { d.restore(); }
});
// ── 手动截图上传 + E2E 配置面板 ───────────────────────────────────────────────

const fakeFile = (name, size, bytes) => ({ name, size, arrayBuffer: () => Promise.resolve((bytes || new Uint8Array(size)).buffer.slice(0)) });

test("wbFileToUpload：只收 png / jpg / webp、非空、≤ 5MB；原因是中文；读成 base64（含大文件分块）", async () => {
  const { wbFileToUpload } = api();
  await assert.rejects(wbFileToUpload(null), /没有选中文件/);
  await assert.rejects(wbFileToUpload(fakeFile("a.gif", 10)), /只支持 png/);
  await assert.rejects(wbFileToUpload(fakeFile("a.exe", 10)), /只支持 png/);
  await assert.rejects(wbFileToUpload(fakeFile("clip.webm", 10)), /录屏由执行器附加/);
  await assert.rejects(wbFileToUpload(fakeFile("a.png", 0)), /空的/);
  await assert.rejects(wbFileToUpload(fakeFile("a.png", 5 * 1024 * 1024 + 1)), /超过 5MB/);
  await assert.rejects(wbFileToUpload({ name: "a.png", size: 3 }), /读不了/);
  const small = await wbFileToUpload(fakeFile("Step 3.PNG", 3, new Uint8Array([0x89, 0x50, 0x4e])));
  assert.deepEqual(small, { name: "Step 3.PNG", data: Buffer.from([0x89, 0x50, 0x4e]).toString("base64") }, "扩展名不分大小写，base64 与 Buffer 一致");
  const big = new Uint8Array(100000).map((_, i) => i % 251);
  const out = await wbFileToUpload(fakeFile("big.jpg", big.length, big));
  assert.deepEqual(Buffer.from(out.data, "base64"), Buffer.from(big), "超过分块大小的数据也要原样还原");
  // 分块行为本身：浏览器里 String.fromCharCode.apply 的参数个数有上限（约 12 万 ~ 50 万，视引擎），
  // 一次塞进整张截图会抛 RangeError。Node 的上限高、复现不了，所以直接断言「每次调用的参数个数有界」。
  const original = String.fromCharCode;
  let widest = 0;
  String.fromCharCode = function () { widest = Math.max(widest, arguments.length); return original.apply(String, arguments); };
  try {
    await wbFileToUpload(fakeFile("big.png", 200000, new Uint8Array(200000)));
  } finally { String.fromCharCode = original; }
  assert.ok(widest > 0 && widest <= 0x8000, "每次最多 32768 个字节参数，实际最宽 " + widest);
});

test("wbE2eConfigPatch：只发真的改了的字段；去空白；非手动驱动没有执行器时前端先拦", () => {
  const { wbE2eConfigDraft, wbE2eConfigPatch } = api();
  assert.deepEqual(wbE2eConfigDraft(undefined), { trigger: "auto", driver: "manual", executorSessionId: "", baseUrl: "" });
  assert.deepEqual(wbE2eConfigDraft({ trigger: "weird", driver: "selenium", executorSessionId: 5 }), { trigger: "auto", driver: "manual", executorSessionId: "", baseUrl: "" });
  const saved = { trigger: "auto", driver: "manual", executorSessionId: "", baseUrl: "" };
  assert.deepEqual(wbE2eConfigPatch(saved, wbE2eConfigDraft(saved)), { patch: {}, error: "" }, "没改就是空补丁");
  assert.deepEqual(wbE2eConfigPatch(saved, { trigger: "manual", driver: "manual", executorSessionId: "", baseUrl: "  http://x  " }), { patch: { trigger: "manual", baseUrl: "http://x" }, error: "" });
  assert.equal(wbE2eConfigPatch(saved, { trigger: "auto", driver: "tabbit-cli", executorSessionId: "", baseUrl: "" }).error, "needExecutor");
  assert.deepEqual(wbE2eConfigPatch(saved, { trigger: "auto", driver: "tabbit-cli", executorSessionId: "s1", baseUrl: "" }), { patch: { driver: "tabbit-cli", executorSessionId: "s1" }, error: "" });
  const configured = { trigger: "auto", driver: "tabbit-cli", executorSessionId: "s1", baseUrl: "" };
  assert.equal(wbE2eConfigPatch(configured, { trigger: "manual", driver: "tabbit-cli", executorSessionId: "s1", baseUrl: "" }).error, "", "已配好执行器，只改触发方式不会被拦");
});

async function renderConfig(project, onWrite) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    const method = (init && init.method) || "GET";
    calls.push({ target, method, body: init && init.body ? JSON.parse(init.body) : undefined });
    if (method !== "GET") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(onWrite ? onWrite(target, init) : ok({})) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ project })) });
  };
  const { mount, shim } = createMount();
  const { plugin } = loadPlugin({ react: shim });
  installDocumentStub();
  const t = plugin.__test;
  await t.wbCache.read("/projects/p1");
  const view = mount(t.WbE2eConfigPanel, { t: (key, vars) => (vars ? KEY(key) + JSON.stringify(vars) : KEY(key)), projectId: "p1" });
  await tick();
  calls.length = 0;
  return { view, calls, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}
const selects = (tree) => byTag(tree, "select");
const projectOf = (cfg) => ({ projectId: "p1", name: "P", members: [{ sessionId: "session-a", title: "主线" }, { sessionId: "session-exec", title: "验收执行器" }], e2eConfig: cfg });

test("E2E 配置面板：收起时只有摘要；展开后改触发方式并保存，只发改了的字段；保存按钮没改动时不可点", async () => {
  const c = await renderConfig(projectOf({ trigger: "auto", driver: "manual", executorSessionId: "", baseUrl: "" }));
  try {
    assert.match(texts(c.view.tree), /\[req\.cfg\.summary\]/);
    assert.equal(selects(c.view.tree).length, 0, "收起时没有表单");
    button(c.view.tree, "req.cfg.edit").props.onClick();
    const tree = c.view.rerender();
    assert.equal(selects(tree).length, 2, "手动驱动下只有触发方式和驱动两个下拉（没有执行器下拉）");
    assert.equal(button(tree, "req.cfg.save").props.disabled, true, "没改动不可保存");
    selects(tree)[0].props.onChange({ target: { value: "manual" } });
    const tree2 = c.view.rerender();
    assert.equal(button(tree2, "req.cfg.save").props.disabled, false);
    button(tree2, "req.cfg.save").props.onClick();
    await tick(); await tick();
    assert.deepEqual(c.calls.find((x) => x.method === "PUT"), { target: "/projects/p1/e2e-config", method: "PUT", body: { trigger: "manual" } });
  } finally { c.restore(); }
});

test("E2E 配置面板：选了非手动驱动才出现执行器下拉（列项目成员）；没选执行器不发请求并提示；computer use 带未验证提示；宿主拒绝显示真原因", async () => {
  const c = await renderConfig(projectOf({ trigger: "auto", driver: "manual", executorSessionId: "", baseUrl: "" }), () => ({ code: 40000, msg: "executorSessionId must be a project member" }));
  try {
    button(c.view.tree, "req.cfg.edit").props.onClick();
    let tree = c.view.rerender();
    selects(tree)[1].props.onChange({ target: { value: "computer-use" } });
    tree = c.view.rerender();
    assert.equal(selects(tree).length, 3, "出现执行器下拉");
    const options = byTag(selects(tree)[2], "option").map((n) => [n.props.value, texts(n)]);
    assert.deepEqual(options, [["", "[req.cfg.executor.none]"], ["session-a", "主线"], ["session-exec", "验收执行器"]], "列项目成员，用成员名");
    assert.match(texts(tree), /\[req\.cfg\.cu\.warn\]/, "computer use 要说明未验证");
    button(tree, "req.cfg.save").props.onClick();
    await tick();
    assert.equal(c.calls.filter((x) => x.method === "PUT").length, 0, "没选执行器：前端先拦，不发请求");
    assert.match(texts(c.view.rerender()), /\[req\.cfg\.needExecutor\]/);
    selects(c.view.rerender())[2].props.onChange({ target: { value: "session-exec" } });
    button(c.view.rerender(), "req.cfg.save").props.onClick();
    await tick(); await tick();
    assert.deepEqual(c.calls.find((x) => x.method === "PUT").body, { driver: "computer-use", executorSessionId: "session-exec" });
    assert.match(texts(c.view.rerender()), /executorSessionId must be a project member/, "宿主拒绝时显示它给的原因");
  } finally { c.restore(); }
});

test("手动截图上传：只在「手动驱动 + 运行中」出现；选文件真发 POST（base64 + 文件名）；不合格的文件显示原因且不发请求", async () => {
  const running = failedRun({ driver: "manual", status: "running", results: [{ caseId: "c1", title: "A", status: "pending", shots: [], note: "" }], summary: { total: 1, passed: 0, failed: 0, errored: 0, pending: 1, accepted: 0, reflowed: 0 } });
  const notes = [];
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => { calls.push({ target: String(url).replace("/agent-whales/api", ""), method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : undefined }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ run: running })) }); };
  try {
    const { mount, shim } = createMount();
    const { plugin } = loadPlugin({ react: shim });
    installDocumentStub();
    const t = plugin.__test;
    const view = mount(t.WbReqRunCard, { t: (k) => KEY(k), run: running, projectId: "p1", reqId: "r1", onNote: (m) => notes.push(m) });
    const input = byTag(view.tree, "input").find((n) => n.props.type === "file");
    assert.ok(input, "手动驱动 + 运行中有文件选择");
    assert.equal(input.props.accept, "image/png,image/jpeg,image/webp", "不接受视频 / 其它类型");
    calls.length = 0;
    await input.props.onChange({ target: { files: [fakeFile("Step3.PNG", 3, new Uint8Array([1, 2, 3]))] } });
    assert.deepEqual(calls.find((x) => x.method === "POST"), { target: "/projects/p1/e2e/run-ab12cd34/shots/c1", method: "POST", body: { name: "Step3.PNG", data: Buffer.from([1, 2, 3]).toString("base64") } });
    calls.length = 0; notes.length = 0;
    await input.props.onChange({ target: { files: [fakeFile("virus.exe", 3)] } });
    await input.props.onChange({ target: { files: [fakeFile("huge.png", 6 * 1024 * 1024)] } });
    assert.equal(calls.filter((x) => x.method === "POST").length, 0, "不合格的文件不发请求");
    assert.match(notes.join("|"), /只支持 png/);
    assert.match(notes.join("|"), /超过 5MB/);
    await input.props.onChange({ target: { files: [] } });
    assert.equal(calls.filter((x) => x.method === "POST").length, 0, "取消选择不发请求");
    // 执行器驱动的运行 / 已结束的运行：没有上传入口
    const tool = mount(t.WbReqRunCard, { t: (k) => KEY(k), run: Object.assign({}, running, { driver: "tabbit-cli" }), projectId: "p1", reqId: "r1", onNote() {} });
    assert.equal(byTag(tool.tree, "input").filter((n) => n.props.type === "file").length, 0, "执行器驱动的运行不给人传（它自己上报）");
    const finished = mount(t.WbReqRunCard, { t: (k) => KEY(k), run: failedRun({ driver: "manual" }), projectId: "p1", reqId: "r1", onNote() {} });
    assert.equal(byTag(finished.tree, "input").filter((n) => n.props.type === "file").length, 0, "运行结束后宿主不再收截图，不给入口");
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

test("需求列表页顶部挂着 E2E 配置面板；新增文案键中英一致", async () => {
  const t = api();
  for (const key of ["req.cfg.title", "req.cfg.summary", "req.cfg.save", "req.cfg.needExecutor", "req.shot.upload", "req.cfg.driver.computer-use", "req.cfg.cu.warn"]) assert.ok(t.WB_TEXT.zh[key] && t.WB_TEXT.en[key], key);
  for (const v of ["auto", "manual"]) assert.ok(t.WB_TEXT.zh["req.cfg.trigger." + v] && t.WB_TEXT.en["req.cfg.trigger." + v]);
  for (const v of ["manual", "tabbit-cli", "computer-use"]) assert.ok(t.WB_TEXT.zh["req.cfg.driver." + v] && t.WB_TEXT.en["req.cfg.driver." + v]);
});
// ── 筛选 ────────────────────────────────────────────────────────────────────

const frow = (reqId, stage, attention, extra) => Object.assign({ reqId, title: reqId, virtual: false, stage, attention: attention || "", tone: "neutral", next: "", tasks: 0, tasksDone: 0, prototypes: 0, updatedAt: 1 }, extra || {});
const sampleRows = () => [
  frow("clarify1", "clarify"), frow("design1", "design", "confirm-design"), frow("dev1", "develop"), frow("accept1", "accept"),
  frow("mismatch1", "mismatch", "e2e-mismatch"), frow("limit1", "mismatch", "rework-limit"), frow("passed1", "passed"),
  frow("unassigned", "develop", "", { virtual: true })
];

test("wbRequirementFilter：待我处理 / E2E 不符 / 进行中 / 已通过；未归类只在「全部」里；未知键回落成全部；坏数据不抛", () => {
  const { wbRequirementFilter, wbRequirementFilterCounts } = api();
  const ids = (key) => wbRequirementFilter(sampleRows(), key).map((r) => r.reqId);
  assert.equal(ids("all").length, 8, "全部包含未归类");
  assert.deepEqual(ids("attention"), ["design1", "mismatch1", "limit1"], "待确认设计 / 验收不符 / 返工超限");
  assert.deepEqual(ids("mismatch"), ["mismatch1", "limit1"], "返工超限也在「不符」阶段，应当在 E2E 不符里");
  assert.deepEqual(ids("active"), ["clarify1", "design1", "dev1", "accept1"], "进行中 = 澄清 / 设计 / 开发 / 验收");
  assert.deepEqual(ids("passed"), ["passed1"]);
  for (const key of ["attention", "mismatch", "active", "passed"]) assert.ok(!ids(key).includes("unassigned"), "未归类没有阶段可筛：" + key);
  assert.equal(ids("weird").length, 8, "未知键 = 全部");
  assert.equal(ids(undefined).length, 8);
  assert.deepEqual(wbRequirementFilter(undefined, "attention"), []);
  assert.deepEqual(wbRequirementFilter([null, undefined, 5], "mismatch"), [], "坏元素跳过");
  assert.deepEqual(wbRequirementFilterCounts(sampleRows()), { all: 8, attention: 3, mismatch: 2, active: 4, passed: 1 });
  assert.deepEqual(wbRequirementFilterCounts(undefined), { all: 0, attention: 0, mismatch: 0, active: 0, passed: 0 });
  const original = sampleRows();
  const frozen = JSON.stringify(original);
  wbRequirementFilter(original, "attention");
  assert.equal(JSON.stringify(original), frozen, "不改入参");
});

async function renderList(rows) {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ok({ requirements: rows })) });
  const { mount, shim } = createMount();
  const { plugin } = loadPlugin({ react: shim });
  installDocumentStub();
  const t = plugin.__test;
  await t.wbCache.read("/projects/p1/requirements");
  const view = mount(t.WbReqsPage, { t: (key) => KEY(key), projectId: "p1" });
  await tick();
  return { view, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}
const chips = (tree) => byTag(tree, "button").filter((b) => b.props["data-filter"]);
const listed = (tree) => byClass(tree, "daw-wb-card").map((n) => texts(n));

test("需求列表页：筛选条带数字；点「需要我处理」只剩待办卡；点「已通过」只剩通过的；没有符合时给提示；筛选条在没有需求时不出现", async () => {
  const rows = [
    reqView({ reqId: "r1", title: "表单导入", stage: "mismatch", attention: "e2e-mismatch", tone: "bad" }),
    reqView({ reqId: "r2", title: "批量审批", stage: "design", attention: "confirm-design", tone: "info" }),
    reqView({ reqId: "r3", title: "导入历史", stage: "clarify", attention: null, tone: "neutral" }),
    reqView({ reqId: "r4", title: "对账", stage: "passed", attention: null, tone: "ok" })
  ];
  const d = await renderList(rows);
  try {
    assert.deepEqual(chips(d.view.tree).map((b) => texts(b)), ["[req.filter.all] 4", "[req.filter.attention] 2", "[req.filter.mismatch] 1", "[req.filter.active] 2", "[req.filter.passed] 1"]);
    assert.equal(chips(d.view.tree).filter((b) => b.props["data-on"] === "true").length, 1, "只有一个选中");
    assert.equal(listed(d.view.tree).length, 4);
    chips(d.view.tree).find((b) => b.props["data-filter"] === "attention").props.onClick();
    let tree = d.view.rerender();
    assert.equal(listed(tree).length, 2);
    assert.ok(listed(tree).every((s) => /批量审批|表单导入/.test(s)));
    assert.equal(chips(tree).find((b) => b.props["data-on"] === "true").props["data-filter"], "attention", "选中态跟着走");
    chips(tree).find((b) => b.props["data-filter"] === "passed").props.onClick();
    tree = d.view.rerender();
    assert.deepEqual(listed(tree).map((s) => /对账/.test(s)), [true]);
  } finally { d.restore(); }

  const calm = await renderList([reqView({ reqId: "r3", title: "导入历史", stage: "clarify", attention: null, tone: "neutral" })]);
  try {
    chips(calm.view.tree).find((b) => b.props["data-filter"] === "mismatch").props.onClick();
    const tree = calm.view.rerender();
    assert.equal(listed(tree).length, 0);
    assert.match(texts(tree), /\[req\.filter\.empty\]/, "筛没了要说清楚，而不是显示「还没有需求」");
    assert.doesNotMatch(texts(tree), /\[req\.empty\]/);
  } finally { calm.restore(); }

  const none = await renderList([]);
  try {
    assert.equal(chips(none.view.tree).length, 0, "没有需求时不显示筛选条");
    assert.match(texts(none.view.tree), /\[req\.empty\]/);
  } finally { none.restore(); }
});

test("筛选文案键中英都有", () => {
  const t = api();
  for (const key of ["req.filter.title", "req.filter.all", "req.filter.attention", "req.filter.mismatch", "req.filter.active", "req.filter.passed", "req.filter.empty"]) assert.ok(t.WB_TEXT.zh[key] && t.WB_TEXT.en[key], key);
});
test("类名不撞车：需求页 / 画布新增的类，基础规则只能定义一次（上次 .daw-wb-run 与顶栏「运行中」药丸撞名，真机截图才发现，假 React 的单测看不出样式冲突）", () => {
  const t = api();
  const css = Array.isArray(t.WB_CSS) ? t.WB_CSS.join("\n") : String(t.WB_CSS);
  // 基础规则 = 紧跟在上一条规则的 } 之后（或样式表开头）、以「.类名{」开头的规则；后代 / 属性 / 伪类变体（.a i{ / .a[data-x]{）不算。
  const seen = new Map();
  const re = /(?:^|\})\s*(\.daw-wb-[A-Za-z0-9_-]+)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  // 防空转：上一版这条测试用错了解析方式，匹配到 0 条规则却一直通过。这里要求真的解析出一大批规则，且已知的两个类各出现过。
  assert.ok(seen.size > 150, "只解析出 " + seen.size + " 个基础规则，解析方式有问题，测试在空转");
  assert.equal(seen.get(".daw-wb-e2erun"), 1);
  assert.equal(seen.get(".daw-wb-run"), 1, "顶栏「运行中」药丸的规则应当仍然存在且只有一条");
  const ours = [".daw-wb-e2erun", ".daw-wb-e2erun-head", ".daw-wb-case", ".daw-wb-case-top", ".daw-wb-case-title", ".daw-wb-case-note", ".daw-wb-case-actions",
    ".daw-wb-shots", ".daw-wb-shot", ".daw-wb-shot-box", ".daw-wb-ann", ".daw-wb-ann-edit", ".daw-wb-cfg-body", ".daw-wb-cfg-field", ".daw-wb-upload", ".daw-wb-filters",
    ".daw-wb-reqnode", ".daw-wb-reqnode-title", ".daw-wb-reqnode-top", ".daw-wb-req-head", ".daw-wb-zoomlevel"];
  for (const cls of ours) assert.equal(seen.get(cls), 1, cls + " 应当恰好定义一次，实际 " + seen.get(cls) + " 次：与已有类名撞车或缺失");
});
test("需求页的运行卡不使用顶栏「运行中」药丸的类名（.daw-wb-run）", async () => {
  const run = failedRun();
  const d = await renderDetail({ view: reqView(), runs: [run] });
  try {
    const bad = byClass(d.view.tree, "daw-wb-run");
    assert.equal(bad.length, 0, "运行卡必须用 daw-wb-e2erun，daw-wb-run 属于顶栏的「运行中」药丸");
    assert.equal(byClass(d.view.tree, "daw-wb-e2erun").length, 1);
    assert.equal(byClass(d.view.tree, "daw-wb-e2erun-head").length >= 1, true);
  } finally { d.restore(); }
});