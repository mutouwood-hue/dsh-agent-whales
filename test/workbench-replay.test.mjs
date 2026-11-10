/**
 * W2 event_replay UI 用例（设计稿 T-13：六步时间线挂在任务卡详情，不占导航）。
 *
 * 数据面契约由宿主半边实现（GET /tasks/:taskId/timeline 与 /observations）；
 * 这里只测浏览器半边：六步补齐、倒序、色调、弹层渲染与坏数据兜底。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createReactShim, findByClass, installDocumentStub, loadPlugin, render } from "./harness.mjs";

const h = createReactShim().createElement;

function testApi() {
  return loadPlugin().plugin.__test;
}

const TIMELINE_FIXTURE = {
  source: "project",
  projectId: "proj-whales",
  taskId: "ptask-t7",
  steps: [
    { key: "source", state: "done", phase: "主会话", at: Date.now() - 3600000, title: "「把 F-002 修一下」→ msg_8f3a", evidence: "逐字原文 218 字" },
    { key: "trigger", state: "done", phase: "落库", at: Date.now() - 3599000, title: "event_2c19 · source=plugin", detail: "未摘要、未改写" },
    { key: "policy", state: "done", phase: "评估", at: Date.now() - 3596000, title: "rule_assessments 3 条：scope 命中 / assignable 命中 / dedupe 未命中" },
    { key: "ticket", state: "done", phase: "开工单", at: Date.now() - 3500000, title: "T7 · owner 宿主半边 · 落点 work/T7" },
    { key: "worker", state: "active", phase: "执行", at: Date.now() - 3490000, until: Date.now() - 600000, title: "跑命令 14 次 · 写文件 3 个" },
    { key: "report", state: "pending", phase: "回流", title: "" }
  ],
  entries: [
    { at: Date.now() - 600000, kind: "task.command", text: "dispatch ptask-t7", evidence: "req-7c21", by: "session-main" },
    { at: Date.now() - 3600000, kind: "proposal.submit", text: "把上线前体检做完", evidence: "prop-9f3c" }
  ]
};

const OBS_FIXTURE = {
  source: "project",
  taskId: "ptask-t7",
  sessionId: "session-host",
  current: { tool: "pnpm test", ageMs: 42000 },
  counts: { commands: 14, files: 3, other: 2 },
  tail: []
};

function zhT(api) {
  return (key, vars) => {
    const raw = api.WB_TEXT.zh[key];
    if (raw === undefined) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
}

/** 给只读缓存灌一份时间线 + observations（垫片的 useSyncExternalStore 不订阅，必须手动读）。 */
async function primeReplay(api, timeline, observations) {
  api.wbCache.reset();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    if (target.indexOf("/timeline") >= 0) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: timeline }) });
    }
    if (target.indexOf("/observations") >= 0) {
      if (observations === null) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: observations }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: {} }) });
  };
  try {
    await api.wbCache.read("/tasks/ptask-t7/timeline?projectId=proj-whales").catch(() => {});
    await api.wbCache.read("/tasks/ptask-t7/observations?projectId=proj-whales").catch(() => {});
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
}

test("六步 key 固定：Source → Trigger → Policy → Ticket → Worker → Report", () => {
  const { WB_TIMELINE_STEPS } = testApi();
  assert.deepEqual(WB_TIMELINE_STEPS.map((step) => step.key), ["source", "trigger", "policy", "ticket", "worker", "report"]);
  for (const step of WB_TIMELINE_STEPS) {
    assert.ok(step.name.startsWith("replay.step."), step.key + " 必须指向文案键");
  }
});

test("时间线视图：固定六步、缺步补 pending、未知 key 追加尾部", () => {
  const { wbTimelineView } = testApi();
  const view = wbTimelineView(TIMELINE_FIXTURE);
  assert.equal(view.steps.length, 6, "六步一步不少");
  assert.equal(view.steps[5].state, "pending", "宿主没给 report 就补 pending");
  assert.equal(view.steps[4].state, "active");
  assert.ok(view.steps[4].until > view.steps[4].at, "worker 步有 until");
  const extra = wbTimelineView({ steps: [{ key: "mystery", state: "done", title: "新步" }] });
  assert.equal(extra.steps.length, 7, "未知 key 追加在尾部，不丢事实");
  assert.equal(extra.steps[6].key, "mystery");
  assert.equal(extra.steps[0].state, "pending", "缺的步全部补 pending");
  const empty = wbTimelineView(undefined);
  assert.equal(empty.steps.length, 6);
  assert.deepEqual(empty.entries, []);
});

test("时间线视图：明细流水按 at 倒序", () => {
  const { wbTimelineView } = testApi();
  const view = wbTimelineView(TIMELINE_FIXTURE);
  assert.equal(view.entries.length, 2);
  assert.ok(view.entries[0].at >= view.entries[1].at, "倒序");
  assert.equal(view.entries[0].kind, "task.command");
});

test("时间线色调：done=ok、active=brand、其余 neutral", () => {
  const { wbTimelineStateTone } = testApi();
  assert.equal(wbTimelineStateTone("done"), "ok");
  assert.equal(wbTimelineStateTone("active"), "brand");
  assert.equal(wbTimelineStateTone("pending"), "neutral");
  assert.equal(wbTimelineStateTone("skipped"), "neutral");
  assert.equal(wbTimelineStateTone(undefined), "neutral");
});

test("过程弹层：六步 + observations + 明细都在，脚注写明与账本的分工", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  await primeReplay(api, TIMELINE_FIXTURE, OBS_FIXTURE);
  const tree = render(h(api.WbTaskReplayModal, { t: zhT(api), task: { taskId: "ptask-t7", subject: "T7 设置页风格切换" }, projectId: "proj-whales", onClose: () => {} }));
  assert.equal(findByClass(tree, "daw-wb-tl-step").length, 6, "六步都要渲染");
  assert.equal(findByClass(tree, "daw-wb-tl-entry").length, 2, "明细两条");
  assert.equal(findByClass(tree, "daw-wb-modal").length, 1);
  const texts = [];
  const collect = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") { texts.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (typeof node !== "object") return;
    if (typeof node.type === "string") {
      for (const key of Object.keys(node.props || {})) {
        if (key === "children") continue;
        if (typeof node.props[key] === "string") texts.push(node.props[key]);
      }
    }
    collect(node.props ? node.props.children : undefined);
  };
  collect(tree);
  const joined = texts.join("|");
  for (const word of ["Source", "Trigger", "Policy", "Ticket", "Worker", "Report", "当前工具：pnpm test", "跑命令 14 次", "写文件 3 个", "「已回复」不等于 report 为 done", "计数是执行会话口径"]) {
    assert.ok(joined.includes(word), "过程弹层必须出现「" + word + "」");
  }
  api.wbCache.reset();
});

test("过程弹层：坏数据不炸（空 steps / observations 5xx）", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  await primeReplay(api, { steps: [], entries: [] }, null);
  assert.doesNotThrow(() => render(h(api.WbTaskReplayModal, { t: (key) => key, task: { taskId: "ptask-t7", subject: "T7" }, projectId: "proj-whales", onClose: () => {} })));
  api.wbCache.reset();
});
