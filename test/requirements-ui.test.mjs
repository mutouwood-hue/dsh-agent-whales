// 需求主线 P3：项目卡里的需求总览（浏览器半边）——展示折算纯函数 + 项目卡真渲染。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, findByClass, installDocumentStub, loadPlugin, walk } from "./harness.mjs";

const api = () => loadPlugin().plugin.__test;
const view = (overrides) => Object.assign({
  reqId: "r1", title: "表单导入", virtual: false, stage: "develop", tone: "info", next: "任务 1/2 已完工，等待其余任务",
  attention: null, designVersion: 1, revision: 2, counts: { tasks: 2, tasksDone: 1, prototypes: 1, flows: 0, runs: 0 }, updatedAt: 100
}, overrides || {});

test("wbRequirementRows：阶段落在词表内、色调映射到工作台芯片、坏数据不抛", () => {
  const { wbRequirementRows } = api();
  const rows = wbRequirementRows({ requirements: [
    view({ reqId: "a", stage: "mismatch", tone: "bad", attention: "e2e-mismatch" }),
    view({ reqId: "b", stage: "design", tone: "info" }),
    view({ reqId: "c", stage: "未知阶段", tone: "未知色" }),
    null, "x", { noReqId: true }
  ] });
  assert.equal(rows.length, 3, "没有 reqId 的坏数据被丢掉");
  const byId = Object.fromEntries(rows.map((row) => [row.reqId, row]));
  assert.equal(byId.a.tone, "danger", "宿主 bad → 工作台 danger");
  assert.equal(byId.b.tone, "brand", "宿主 info → 工作台 brand");
  assert.equal(byId.c.stage, "clarify", "未知阶段回落到澄清");
  assert.equal(byId.c.tone, "neutral");
  assert.equal(byId.a.attention, "e2e-mismatch");
  assert.equal(byId.b.attention, "", "没有 attention 给空串而不是 null");
  assert.deepEqual(wbRequirementRows(undefined), []);
  assert.deepEqual(wbRequirementRows({ requirements: "x" }), []);
});

test("wbRequirementRows：需要你处理的排最前，进行中其次，澄清再次，已通过靠后，「未归类」永远垫底", () => {
  const { wbRequirementRows } = api();
  const rows = wbRequirementRows({ requirements: [
    view({ reqId: "virtual", virtual: true, stage: "develop", updatedAt: 999 }),
    view({ reqId: "passed", stage: "passed", tone: "ok", updatedAt: 500 }),
    view({ reqId: "clarify", stage: "clarify", tone: "neutral", updatedAt: 400 }),
    view({ reqId: "develop-old", stage: "develop", updatedAt: 100 }),
    view({ reqId: "develop-new", stage: "develop", updatedAt: 300 }),
    view({ reqId: "attn", stage: "design", attention: "confirm-design", updatedAt: 1 })
  ] });
  assert.deepEqual(rows.map((row) => row.reqId), ["attn", "develop-new", "develop-old", "clarify", "passed", "virtual"]);
});

test("wbRequirementSummary：统计各阶段与「需要你处理」；虚拟「未归类」不计入", () => {
  const { wbRequirementRows, wbRequirementSummary } = api();
  const rows = wbRequirementRows({ requirements: [
    view({ reqId: "a", stage: "design", attention: "confirm-design" }),
    view({ reqId: "b", stage: "mismatch", tone: "bad", attention: "rework-limit" }),
    view({ reqId: "c", stage: "passed", tone: "ok" }),
    view({ reqId: "v", virtual: true, stage: "develop", attention: "confirm-design" })
  ] });
  const summary = wbRequirementSummary(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.attention, 2);
  assert.equal(summary.byStage.design, 1);
  assert.equal(summary.byStage.mismatch, 1);
  assert.equal(summary.byStage.passed, 1);
  assert.equal(summary.byStage.develop, 0, "虚拟需求不进统计");
  assert.deepEqual(wbRequirementSummary(undefined), { total: 0, attention: 0, byStage: { clarify: 0, design: 0, develop: 0, accept: 0, mismatch: 0, passed: 0 } });
});

function textsOf(tree) {
  const out = [];
  walk(tree, (node) => {
    const children = node && node.props ? node.props.children : undefined;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) if (typeof child === "string") out.push(child);
  });
  return out;
}

async function renderCard(requirements, tasks) {
  const { mount, shim } = createMount();
  const { plugin } = loadPlugin({
    react: shim,
    fetch: (url) => {
      const target = String(url).replace("/agent-whales/api", "");
      if (target.startsWith("/tasks")) return { code: 200, msg: "success", data: { tasks: tasks || [] } };
      if (target.endsWith("/requirements")) return { code: 200, msg: "success", data: { requirements: requirements } };
      return { code: 200, msg: "success", data: {} };
    }
  });
  installDocumentStub();
  const t = plugin.__test;
  const project = { projectId: "p1", name: "演示项目", members: [{ sessionId: "s" }], brief: { goal: "把导入做完" } };
  for (const url of ["/tasks?projectId=p1", "/projects/p1/requirements"]) await t.wbCache.read(url).catch(() => {});
  const mounted = mount(t.WbProjectCard, { project, t: (key, vars) => t.WB_TEXT.zh[key] ? String(t.WB_TEXT.zh[key]).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m)) : key });
  await new Promise((resolve) => setImmediate(resolve));
  return mounted.tree;
}

test("项目卡：按阶段显示需求行（名称 / 阶段 / 计数 / 下一步），需要你处理的有角标和高亮", async () => {
  const tree = await renderCard([
    view({ reqId: "a", title: "表单导入", stage: "mismatch", tone: "bad", attention: "e2e-mismatch", next: "1 项不符，在截图上批注后回流返工" }),
    view({ reqId: "b", title: "批量审批", stage: "design", tone: "info", attention: "confirm-design", designVersion: 0, next: "确认原型，再推进开发", counts: { tasks: 0, tasksDone: 0, prototypes: 1 } })
  ]);
  const rows = findByClass(tree, "daw-wb-req");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].props["data-attention"], "e2e-mismatch");
  assert.equal(findByClass(tree, "daw-wb-reqs").length, 1);
  const texts = textsOf(tree).join("|");
  assert.match(texts, /表单导入/);
  assert.match(texts, /批量审批/);
  assert.match(texts, /不符/, "阶段芯片显示中文阶段名");
  assert.match(texts, /待确认设计/, "attention 显示成人话，不露内部 key");
  assert.match(texts, /验收不符/);
  assert.match(texts, /设计未确认/, "有原型但没确认过要说出来");
  assert.match(texts, /下一步：确认原型，再推进开发/);
  assert.match(texts, /需要你处理 2/, "项目卡头部汇总「需要你处理」的个数");
  assert.doesNotMatch(texts, /e2e-mismatch|confirm-design|rework-limit/, "内部 key 不能漏到界面上");
});

test("项目卡：没有需求时给引导文案；「未归类」显示为未归类并垫底；超过 4 个折叠", async () => {
  const empty = await renderCard([]);
  assert.equal(findByClass(empty, "daw-wb-req-empty").length, 1);
  assert.match(textsOf(empty).join("|"), /还没有需求/);

  const many = await renderCard([
    view({ reqId: "virtual", virtual: true, title: "未归类", stage: "develop" }),
    ...["a", "b", "c", "d", "e"].map((id, index) => view({ reqId: id, title: "需求" + id, updatedAt: 100 - index }))
  ]);
  const rows = findByClass(many, "daw-wb-req");
  assert.equal(rows.length, 4, "最多显示 4 行");
  assert.equal(rows.some((row) => row.props["data-virtual"] === "true"), false, "未归类垫底，被折叠掉了");
  assert.match(textsOf(many).join("|"), /还有 2 个需求/);

  const onlyVirtual = await renderCard([view({ reqId: "virtual", virtual: true, title: "未归类", stage: "develop", counts: { tasks: 3, tasksDone: 1, prototypes: 0 } })]);
  const vrows = findByClass(onlyVirtual, "daw-wb-req");
  assert.equal(vrows.length, 1);
  assert.equal(vrows[0].props["data-virtual"], "true");
  assert.doesNotMatch(textsOf(onlyVirtual).join("|"), /需要你处理/, "未归类不计入「需要你处理」");
  const vtexts = textsOf(onlyVirtual);
  assert.equal(vtexts.filter((text) => text === "未归类").length, 1, "「未归类」只出现一次（芯片），标题用「旧任务与原型」，不重复");
  assert.ok(vtexts.includes("旧任务与原型"));
});

test("项目卡：旧宿主没有 /requirements 路由（返回空数据）时不报错、不显示需求区", async () => {
  const { mount, shim } = createMount();
  const { plugin } = loadPlugin({ react: shim, fetch: () => ({ code: 200, msg: "success", data: {} }) });
  installDocumentStub();
  const t = plugin.__test;
  const mounted = mount(t.WbProjectCard, { project: { projectId: "p9", name: "老宿主", members: [] }, t: (key) => key });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(findByClass(mounted.tree, "daw-wb-card").length >= 1, "项目卡本身照常渲染");
});

test("需求相关文案：中英键集合一致且都非空；CSS 里有对应样式", () => {
  const t = api();
  const zh = Object.keys(t.WB_TEXT.zh).filter((key) => key.startsWith("req."));
  const en = Object.keys(t.WB_TEXT.en).filter((key) => key.startsWith("req."));
  assert.deepEqual(zh.sort(), en.sort());
  assert.ok(zh.length >= 20);
  for (const key of zh) {
    assert.ok(String(t.WB_TEXT.zh[key]).trim() !== "", "zh " + key);
    assert.ok(String(t.WB_TEXT.en[key]).trim() !== "", "en " + key);
  }
  for (const stage of ["clarify", "design", "develop", "accept", "mismatch", "passed"]) assert.ok(t.WB_TEXT.zh["req.stage." + stage], "阶段文案 " + stage);
  for (const attention of ["confirm-design", "e2e-mismatch", "rework-limit"]) assert.ok(t.WB_TEXT.zh["req.attention." + attention], "待办文案 " + attention);
  const css = Array.isArray(t.WB_CSS) ? t.WB_CSS.join("\n") : String(t.WB_CSS);
  for (const cls of [".daw-wb-reqs", ".daw-wb-req{", ".daw-wb-req-title", ".daw-wb-req-attn", ".daw-wb-req-next"]) assert.ok(css.includes(cls), "CSS 缺 " + cls);
});

// ── 需求待办进「需要我处理」页 ────────────────────────────────────────────────

test("待办页：需求待办排第一，attention 翻成人话（不露内部 key），统计把它算进「待我处理」", async () => {
  const { mount, shim } = createMount();
  const inbox = { source: "project", projectId: null, groups: [
    { key: "requirements", label: "需求待办", items: [
      { kind: "requirement", reqId: "r1", projectId: "p1", subject: "表单导入", attention: "e2e-mismatch", reason: "1 项不符，在截图上批注后回流返工", stage: "mismatch", at: 1000 },
      { kind: "requirement", reqId: "r2", projectId: "p1", subject: "批量审批", attention: "confirm-design", reason: "确认原型，再推进开发", stage: "design", at: 900 }
    ] },
    { key: "proposals", label: "提案待确认", items: [{ kind: "proposal", proposalId: "prop-1", subject: "导入接口", projectId: "p1", at: 800 }] },
    { key: "worker", label: "worker 求人", items: [] }, { key: "handed_back", label: "超 scope 退回", items: [] }, { key: "system", label: "系统提醒", items: [] }
  ] };
  const { plugin } = loadPlugin({ react: shim, fetch: (url) => (String(url).includes("/inbox") ? { code: 200, msg: "success", data: inbox } : { code: 200, msg: "success", data: {} }) });
  installDocumentStub();
  const t = plugin.__test;
  assert.equal(t.wbInboxView(inbox).total, 3, "统计包含需求待办");
  await t.wbCache.read("/inbox").catch(() => {});
  const mounted = mount(t.WbInboxPage, { t: (key, vars) => (t.WB_TEXT.zh[key] ? String(t.WB_TEXT.zh[key]).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m)) : key) });
  await new Promise((resolve) => setImmediate(resolve));
  const texts = textsOf(mounted.tree).join("|");
  assert.ok(texts.indexOf("需求待办") >= 0 && texts.indexOf("需求待办") < texts.indexOf("提案待确认"), "需求待办排在提案待确认之前");
  assert.match(texts, /表单导入 · 验收不符/);
  assert.match(texts, /批量审批 · 待确认设计/);
  assert.match(texts, /1 项不符，在截图上批注后回流返工/, "下一步说明作为副标题");
  assert.match(texts, /去处理（打开画布）/);
  assert.doesNotMatch(texts, /e2e-mismatch|confirm-design|rework-limit/, "内部 key 不能露出来");
  assert.match(texts, /需要我处理（3）/);
});

test("待办文案：inbox.action.requirement 中英都有", () => {
  const t = api();
  assert.ok(t.WB_TEXT.zh["inbox.action.requirement"] && t.WB_TEXT.en["inbox.action.requirement"]);
});