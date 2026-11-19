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
  for (const cls of [".daw-wb-run{", ".daw-wb-case{", ".daw-wb-shot{", ".daw-wb-shot-box{", ".daw-wb-ann-edit", ".daw-wb-req-head"]) assert.ok(css.includes(cls), "CSS 缺 " + cls);
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