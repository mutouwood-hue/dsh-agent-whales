// 重新规划 R3：一级菜单 6 → 3（项目 · 需要我处理 · 设置）。
// 「发送记录」与「事件台」并入「需要我处理」页的「活动」分区；「团队」「首次体验」页删除。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

const KEY = (key, vars) => "[" + key + "]" + (vars ? JSON.stringify(vars) : "");
const ok = (data) => ({ code: 200, msg: "success", data });
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
const byClass = (tree, cls) => { const out = []; collect(tree, out, (n) => hasClass(n, cls)); return out; };

const HANDOFFS = [
  { at: 1000, from: "s1", to: "s2", messageId: "msg-1", result: "sent", evidence: "ok" },
  { at: 2000, from: "s2", to: "s1", messageId: "msg-2", result: "failed", evidence: "boom" }
];
const EVENTS = [
  { eventId: "e1", projectId: "p1", source: "plugin", kind: "task.command", text: "dispatch t-1", at: 3000, state: "pending", rules: [{ name: "rule: x", hit: true, detail: "d" }] },
  { eventId: "e2", projectId: "p1", source: "plugin", kind: "proposal.submit", text: "提案 v2", at: 4000, state: "opened", ticketId: "ptask-9", decidedBy: "user", decidedAt: 5000, rules: [] }
];
const SESSIONS = [{ sessionId: "s1", title: "后端" }, { sessionId: "s2", title: "前端" }];

function fetchFor(overrides) {
  return (target) => {
    if (overrides && overrides[target] !== undefined) return overrides[target];
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: HANDOFFS });
    if (target.startsWith("/events")) return ok({ events: EVENTS, stats: {}, health: [] });
    if (target === "/projects") return ok({ projects: [] });
    return ok({});
  };
}

async function mountWith(Component, props, overrides) {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  const loaded = loadPlugin({ react: shim });
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  const calls = [];
  const fetcher = fetchFor(overrides);
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    calls.push({ target, method: (init && init.method) || "GET" });
    const body = fetcher(target);
    return Promise.resolve({ ok: body.code === 200, status: body.code === 200 ? 200 : 404, json: () => Promise.resolve(body) });
  };
  for (const url of ["/inbox", "/handoffs", "/events", "/inbox?projectId=p1", "/handoffs?projectId=p1", "/events?projectId=p1", "/projects"]) await t.wbCache.read(url).catch(() => {});
  calls.length = 0; // 预热只是为了让数据就绪；清掉，才能区分「组件自己订阅了什么」
  const view = mount(t[Component], Object.assign({ t: KEY }, props));
  await view.settle(10);
  view.rerender();
  return { t, view, calls, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}

// ── 侧栏：只剩三项 ──────────────────────────────────────────────────────────

test("侧栏只剩三项：项目 · 需要我处理 · 设置；没有发送记录 / 事件台 / 团队，也没有底部的「宿主团队」卡", async () => {
  const c = await mountWith("WbSidebar", { route: { kind: "list" }, running: 2 });
  try {
    const navs = byClass(c.view.tree, "daw-wb-nav");
    assert.deepEqual(navs.map((n) => texts(n)), [KEY("nav.projects"), KEY("nav.inbox"), KEY("nav.settings")]);
    assert.equal(byClass(c.view.tree, "daw-wb-user").length, 0, "底部「宿主团队（只读）」小卡已删除（宿主自带，重复）");
    assert.doesNotMatch(texts(c.view.tree), /nav\.(handoffs|events|team)|team\.host/);
    assert.ok(c.calls.some((x) => x.target === "/inbox"), "前提：侧栏确实订阅了 /inbox（否则下面这条没有意义）");
    assert.ok(!c.calls.some((x) => x.target === "/events" || x.target.startsWith("/events?")), "侧栏不再订阅 /events（事件数徽标随事件台一起删了）");
  } finally { c.restore(); }
});

test("侧栏高亮：在项目工作台 / 从画布开始里高亮「项目」；在需要我处理里高亮它；设置同理", async () => {
  for (const [route, want] of [[{ kind: "workbench", projectId: "p1", tab: "canvas" }, "nav.projects"], [{ kind: "start" }, "nav.projects"], [{ kind: "inbox" }, "nav.inbox"], [{ kind: "settings" }, "nav.settings"], [{ kind: "list" }, "nav.projects"]]) {
    const c = await mountWith("WbSidebar", { route });
    try {
      const on = byClass(c.view.tree, "daw-wb-nav").filter((n) => n.props["data-on"] === "true");
      assert.equal(on.length, 1, JSON.stringify(route));
      assert.equal(texts(on[0]), KEY(want), JSON.stringify(route));
    } finally { c.restore(); }
  }
});

// ── 旧路由不留死链接 ────────────────────────────────────────────────────────

test("旧版本记在 localStorage 里的路由：发送记录 / 事件台 → 需要我处理；团队 / 首次体验 → 项目列表；认识的路由原样恢复；乱七八糟的回项目列表", () => {
  const recall = (stored) => loadPlugin({ storedExtra: { "dsh-agent-whales.last-view": JSON.stringify(stored) } }).plugin.__test.wbRoute.get();
  assert.deepEqual(recall({ kind: "handoffs" }), { kind: "inbox" });
  assert.deepEqual(recall({ kind: "events" }), { kind: "inbox" });
  assert.deepEqual(recall({ kind: "team" }), { kind: "list" });
  assert.deepEqual(recall({ kind: "first" }), { kind: "list" });
  assert.deepEqual(recall({ kind: "inbox" }), { kind: "inbox" });
  assert.deepEqual(recall({ kind: "settings" }), { kind: "settings" });
  assert.deepEqual(recall({ kind: "start" }), { kind: "start" });
  assert.deepEqual(recall({ kind: "workbench", projectId: "p1", tab: "reqs" }), { kind: "workbench", projectId: "p1", tab: "reqs" });
  assert.deepEqual(recall({ kind: "does-not-exist" }), { kind: "list" });
  assert.deepEqual(recall({ kind: "__proto__" }), { kind: "list" }, "原型链上的名字不能当成「已搬走」的路由");
  assert.deepEqual(recall({ kind: "constructor" }), { kind: "list" });
});

// ── 需要我处理：活动分区 ────────────────────────────────────────────────────

test("「需要我处理」页下方有「活动」：交接账本（沿用原表，名字用会话标题）+ 事件时间线（只读）；没有任何写动作", async () => {
  const c = await mountWith("WbInboxPage", { projectId: "p1", sessions: { byId: { s1: SESSIONS[0], s2: SESSIONS[1] } } });
  try {
    const all = texts(c.view.tree);
    assert.match(all, /\[handoff\.title\]/, "交接账本分区在");
    assert.match(all, /\[activity\.events\]/, "事件时间线分区在");
    // 账本：两行，路由用会话标题
    assert.match(all, /后端 → 前端/);
    assert.match(all, /前端 → 后端/);
    assert.match(all, /\[handoff\.result\.failed\]/, "失败的送达如实显示");
    // 时间线：两行，原文逐字（不夹带规则 / 动作）
    const rows = byClass(c.view.tree, "daw-wb-tr").filter((n) => n.props["data-event"] !== undefined);
    assert.deepEqual(rows.map((r) => r.props["data-event"]).sort(), ["e1", "e2"]);
    assert.match(texts(rows[0]) + texts(rows[1]), /dispatch t-1/);
    assert.match(texts(rows[0]) + texts(rows[1]), /提案 v2/);
    // 事件台以前的三个动作按钮、规则、健康面板：一个都没有
    assert.doesNotMatch(all, /event\.action\.|event\.rule|event\.health|rule: x/);
    const buttons = []; collect(c.view.tree, buttons, (n) => n.type === "button" || (typeof n.type === "function" && n.type.name === "WbBtn"));
    assert.ok(!buttons.some((b) => /event\.action/.test(texts(b))), "时间线上没有「开工单 / 忽略 / 标噪声」");
    // 没有写请求
    assert.equal(c.calls.filter((x) => x.method !== "GET").length, 0, "挂载本身不发任何写请求");
  } finally { c.restore(); }
});

test("活动分区：按项目收窄时请求带 projectId；没有数据给「无」占位；读失败显示错误与重试，不白屏；时间线最多 30 行且长文本截断", async () => {
  const c = await mountWith("WbInboxPage", { projectId: "p1" });
  try {
    assert.ok(c.calls.some((x) => x.target === "/events?projectId=p1" || x.target.startsWith("/events?projectId=p1")), "事件按项目收窄");
    assert.ok(c.calls.some((x) => x.target.startsWith("/handoffs?projectId=p1")), "账本按项目收窄");
  } finally { c.restore(); }
  const empty = await mountWith("WbInboxPage", {}, { "/events": ok({ events: [], stats: {}, health: [] }), "/handoffs": ok({ entries: [] }) });
  try {
    assert.equal(byClass(empty.view.tree, "daw-wb-note").filter((n) => n.props["data-events-empty"] !== undefined).length, 1, "事件为空有占位");
  } finally { empty.restore(); }
  const many = Array.from({ length: 45 }, (_, i) => ({ eventId: "x" + i, source: "plugin", kind: "task.command", text: i === 0 ? "长".repeat(300) : "t" + i, at: 10000 - i, state: "pending", rules: [] }));
  const big = await mountWith("WbInboxPage", {}, { "/events": ok({ events: many, stats: {}, health: [] }) });
  try {
    const rows = byClass(big.view.tree, "daw-wb-tr").filter((n) => n.props["data-event"] !== undefined);
    assert.equal(rows.length, 30, "最多 30 行");
    assert.ok(texts(rows[0]).length < 200, "长文本被截断");
    assert.match(texts(rows[0]), /…/);
  } finally { big.restore(); }
  const broken = await mountWith("WbInboxPage", {}, { "/events": { code: 500, msg: "boom" } });
  try {
    assert.doesNotThrow(() => broken.view.rerender());
    assert.ok(texts(broken.view.tree).length > 0, "页面还在");
  } finally { broken.restore(); }
});

// ── 已删除的东西确实不在了 ──────────────────────────────────────────────────

test("已删除的页面 / 符号 / 文案键确实不在了；仍被使用的没有被误删", () => {
  const t = loadPlugin().plugin.__test;
  for (const name of ["WbEventsPage", "WbEventDetail", "WbSourceHealth", "WbTeamPage", "WbFirstPage", "WbHandoffsPage", "WB_EVENT_SOURCES", "WB_HEALTH_WORDS", "wbEventActionProject"]) assert.equal(t[name], undefined, name + " 已删除");
  for (const name of ["WbHandoffsPanel", "WbEventsTimeline", "WbSection", "WbInboxPage", "WbSidebar"]) assert.equal(typeof t[name], "function", name + " 仍在");
  for (const lang of ["zh", "en"]) {
    for (const key of ["nav.handoffs", "nav.events", "nav.team", "team.host", "team.desc", "first.welcome", "event.health.title", "event.action.open", "event.title", "list.stat.events"]) assert.equal(t.WB_TEXT[lang][key], undefined, lang + " " + key + " 已删除");
    for (const key of ["nav.projects", "nav.inbox", "nav.settings", "handoff.title", "handoff.export", "activity.events", "activity.events.desc", "inbox.foot", "common.none"]) assert.ok(t.WB_TEXT[lang][key], lang + " 缺 " + key);
  }
  assert.deepEqual(Object.keys(t.WB_TEXT.zh).sort(), Object.keys(t.WB_TEXT.en).sort(), "中英文案键完全一致");
});

test("项目列表页：不再有恒为 0 的「事件」统计块", async () => {
  const c = await mountWith("WbProjectList", {});
  try {
    const stats = byClass(c.view.tree, "daw-wb-stat");
    assert.equal(stats.length, 3, "只剩 项目数 / 待办 / 工单 三块");
    assert.doesNotMatch(texts(c.view.tree), /list\.stat\.events/);
  } finally { c.restore(); }
});
