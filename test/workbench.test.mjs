/**
 * M6 项目工作台（浏览器半边）纯逻辑用例。
 *
 * 这一组不碰 DOM：只测「可离线推导的视图模型」——路由、token 估算、简报预算、
 * 任务行派生、report 人机边界、待办聚合、画布图。组件渲染另有一组冒烟。
 *
 * 背景：PRD §45.3 P2（独立主面板）/ §53（项目任务表）/ §54（简报按需读取）/
 * §55.3（落点字段、report 四态）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createReactShim, findByClass, installDocumentStub, loadPlugin, render, walk } from "./harness.mjs";
function testApi() {
  return loadPlugin().plugin.__test;
}

/** 与 client.js 同一个 React 垫片：只支持 createElement + 4 个 hook。 */
const h = createReactShim().createElement;

// ── 1. 文案与 token ────────────────────────────────────────────────────────

test("工作台文案：zh/en 键集合一致且都非空", () => {
  const { WB_TEXT } = testApi();
  const zh = Object.keys(WB_TEXT.zh).sort();
  const en = Object.keys(WB_TEXT.en).sort();
  assert.ok(zh.length > 100, "工作台文案不能太少，实际 " + zh.length);
  assert.deepEqual(zh, en, "中英文键集合必须一致");
  for (const key of zh) {
    assert.ok(WB_TEXT.zh[key].length > 0, "zh." + key + " 不得为空");
    assert.ok(WB_TEXT.en[key].length > 0, "en." + key + " 不得为空");
  }
});

test("设计 token：浅色/暗色键集合一致，且暗色不是简单照抄浅色", () => {
  const { WB_TOKENS } = testApi();
  const light = Object.keys(WB_TOKENS.light).sort();
  const dark = Object.keys(WB_TOKENS.dark).sort();
  assert.deepEqual(light, dark, "两套主题必须同一批 token");
  assert.ok(light.length >= 16, "T-6 的 token 表有 16 项，实际 " + light.length);
  for (const key of ["bg", "surface", "surface-muted", "border", "text", "text-secondary", "text-muted", "brand", "ok", "warn", "danger", "accent"]) {
    assert.match(WB_TOKENS.light[key], /^#[0-9A-Fa-f]{6}$/, "light." + key + " 必须是六位 hex");
    assert.match(WB_TOKENS.dark[key], /^#[0-9A-Fa-f]{6}$/, "dark." + key + " 必须是六位 hex");
  }
  assert.notEqual(WB_TOKENS.dark.bg, WB_TOKENS.light.bg, "暗色底色必须换值");
  assert.notEqual(WB_TOKENS.dark.brand, WB_TOKENS.light.brand, "品牌蓝在暗底要提亮（T-6）");
});

// ── 2. 路由 ────────────────────────────────────────────────────────────────

test("工作台路由：解析 / 生成互为逆运算，非法片段回落列表", () => {
  const { wbRouteOf, wbPathOf } = testApi();
  assert.deepEqual(wbRouteOf("/"), { kind: "list" });
  assert.deepEqual(wbRouteOf("/inbox"), { kind: "inbox" });
  assert.deepEqual(wbRouteOf("/handoffs"), { kind: "handoffs" });
  assert.deepEqual(wbRouteOf("/events"), { kind: "events" });
  assert.deepEqual(wbRouteOf("/p/proj-1/tasks"), { kind: "workbench", projectId: "proj-1", tab: "tasks" });
  assert.deepEqual(wbRouteOf("/p/proj-1"), { kind: "workbench", projectId: "proj-1", tab: "canvas" });
  assert.deepEqual(wbRouteOf("/p/proj-1/nope"), { kind: "workbench", projectId: "proj-1", tab: "canvas" }, "未知 tab 回落 canvas");
  assert.deepEqual(wbRouteOf("/p"), { kind: "list" }, "缺项目 id 不能进工作台");
  assert.deepEqual(wbRouteOf("/nope"), { kind: "list" });
  assert.deepEqual(wbRouteOf(""), { kind: "list" });
  assert.equal(wbPathOf({ kind: "list" }), "/");
  assert.equal(wbPathOf({ kind: "workbench", projectId: "proj-1", tab: "brief" }), "/p/proj-1/brief");
  assert.equal(wbPathOf({ kind: "inbox" }), "/inbox");
  assert.equal(wbPathOf(wbRouteOf("/p/proj-1/exec")), "/p/proj-1/exec", "round-trip 必须稳定");
});

// ── 3. token 估算与简报预算 ────────────────────────────────────────────────

test("token 估算：中日韩 1 字 1 token，其他 4 字符 1 token", () => {
  const { wbEstimateTokens } = testApi();
  assert.equal(wbEstimateTokens(""), 0);
  assert.equal(wbEstimateTokens("目标"), 2);
  assert.equal(wbEstimateTokens("abcd"), 1);
  assert.equal(wbEstimateTokens("abcde"), 2);
  assert.equal(wbEstimateTokens("目标abc"), 2 + 1);
  assert.equal(wbEstimateTokens(undefined), 0, "非字符串不能炸");
});

test("简报预算：按 goal→constraints→decisions→duty→conclusions→artifacts 顺序填充，超限丢弃并计数", () => {
  const { wbBriefFill } = testApi();
  const fill = wbBriefFill({
    goal: "把上线前体检做完",
    constraints: ["不改写历史"],
    decisions: ["先体检宿主", "简报按需读取"],
    duty: "负责浏览器半边",
    conclusions: ["P0 已注册"],
    artifacts: [{ kind: "file", ref: "lib/client.js" }]
  }, 2000);
  // 8 + 5 + 11 + 7 + 4 + 4 = 39（CJK 1 字 1 token，其余 4 字符 1 token）
  assert.equal(fill.used, 39);
  assert.equal(fill.truncated, false);
  assert.equal(fill.omitted, 0);

  // 预算 8：goal（10）就超 → 后续全部丢弃
  const tight = wbBriefFill({ goal: "把上线前体检做完", constraints: ["a", "b"], duty: "x" }, 8);
  assert.equal(tight.truncated, true);
  assert.equal(tight.omitted, 3, "constraints 两条 + duty 一条都被丢");
  assert.equal(tight.constraints.length, 0);

  // 预算 12：goal（8）之后只剩 4，constraints「不改写历史」成本 5 放不下 → 丢；
  // duty「x」成本 1 仍放得下，继续填（预算没耗尽就不停）。
  const partial = wbBriefFill({ goal: "把上线前体检做完", constraints: ["不改写历史"], duty: "x" }, 12);
  assert.equal(partial.omitted, 1);
  assert.equal(partial.constraints.length, 0);
  assert.equal(partial.duty, "x", "预算还有剩就继续填后面的条目");

  const empty = wbBriefFill(undefined, 2000);
  assert.equal(empty.used, 0);
  assert.equal(empty.truncated, false);
});

// ── 4. 任务行派生与 report 边界 ────────────────────────────────────────────

function taskTable(overrides = {}) {
  return Object.assign(
    {
      "t1": { taskId: "t1", projectId: "p1", subject: "体检宿主", status: "pending", blockedBy: [], revision: 1, ownerSessionId: null },
      "t2": { taskId: "t2", projectId: "p1", subject: "体检浏览器", status: "pending", blockedBy: ["t1"], revision: 2, ownerSessionId: "s2", worktree: "work/t2" },
      "t3": { taskId: "t3", projectId: "p1", subject: "前置已删", status: "pending", blockedBy: ["t0"], revision: 1, ownerSessionId: null },
      "t4": { taskId: "t4", projectId: "p1", subject: "已删除的前置", status: "deleted", blockedBy: [], revision: 1, ownerSessionId: null },
      "t5": { taskId: "t5", projectId: "p1", subject: "等删除的前置", status: "pending", blockedBy: ["t4"], revision: 1, ownerSessionId: null },
      "t6": { taskId: "t6", projectId: "p1", subject: "已返工", status: "in_progress", blockedBy: [], revision: 7, ownerSessionId: "s1", report: { status: "handed_back", summary: "超范围", rev: 6, at: 1, bySessionId: "s1" } }
    },
    overrides
  );
}

test("任务行：ready / 阻塞原因 / 落点 / report 全部派生", () => {
  const { wbTaskRowView } = testApi();
  const table = taskTable();
  assert.equal(wbTaskRowView(table.t1, table).ready, true, "无依赖的待处理 = 可认领");
  assert.equal(wbTaskRowView(table.t2, table).ready, false, "前置未完成不能认领");
  assert.equal(wbTaskRowView(table.t2, table).blockedReason, "wait");
  assert.equal(wbTaskRowView(table.t2, table).worktree, "work/t2", "落点字段必须带出");
  assert.equal(wbTaskRowView(table.t3, table).blockedReason, "deleted", "前置缺失 = 前置已删除");
  assert.equal(wbTaskRowView(table.t5, table).blockedReason, "deleted", "前置被删 = 前置已删除");
  const reopened = wbTaskRowView(table.t6, table);
  assert.equal(reopened.report.status, "handed_back");
  assert.equal(reopened.report.rev, 6);
  assert.equal(reopened.report.summary, "超范围");
  assert.equal(wbTaskRowView({ taskId: "x" }, {}).status, "pending", "空任务不能炸");
  assert.equal(wbTaskRowView({ taskId: "x", report: null }, {}).report, null);
});

test("report 人机边界：worker 只能写 done/draft 或发起退回；关闭只能人做", () => {
  const { wbReportRules } = testApi();
  const human = wbReportRules(undefined);
  assert.equal(human.worker, false);
  assert.deepEqual(human.writable, ["done", "draft", "handed_back", "human_action"]);
  assert.deepEqual(human.closable, ["done", "draft"]);
  const user = wbReportRules("user");
  assert.equal(user.worker, false, "bySessionId=user 仍算人");
  const worker = wbReportRules("session-worker");
  assert.equal(worker.worker, true);
  assert.deepEqual(worker.writable, ["done", "draft"]);
  assert.deepEqual(worker.initiatable, ["handed_back", "human_action"]);
  assert.deepEqual(worker.closable, [], "worker 不能把退回类关掉");
});

// ── 5. 待办聚合与画布图 ────────────────────────────────────────────────────

test("待办视图：四组计数 + 总数；空组保留、坏组跳过", () => {
  const { wbInboxView } = testApi();
  const view = wbInboxView({
    groups: [
      { key: "proposals", label: "提案待确认", items: [{ proposalId: "p" }, { proposalId: "q" }] },
      { key: "worker", label: "worker 求人", items: [{ taskId: "t1" }] },
      { key: "handed_back", label: "退回", items: [] },
      { key: "system", label: "系统提醒", items: [{ taskId: "t9" }, { taskId: "t8" }] },
      { key: "junk" }
    ]
  });
  assert.equal(view.total, 5);
  assert.equal(view.groups.proposals.items.length, 2);
  assert.equal(view.groups.handed_back.items.length, 0, "空组也要在（前端按 key 渲染）");
  assert.deepEqual(view.groups.junk, { items: [], label: "junk" }, "有 key 没 items 的组按空组保留");
  assert.deepEqual(wbInboxView({ groups: [{ items: [] }, null] }), { groups: {}, total: 0 }, "没有 key 的组直接跳过");
  assert.deepEqual(wbInboxView(undefined), { groups: {}, total: 0 });
  assert.deepEqual(wbInboxView({}), { groups: {}, total: 0 });
});

test("画布连线：只连两端都在的节点，自连被跳过", () => {
  const { wbCanvasEdges } = testApi();
  const nodes = [
    { id: "a", x: 0, y: 0, w: 100, h: 50 },
    { id: "b", x: 200, y: 0, w: 100, h: 50 }
  ];
  const edges = wbCanvasEdges(nodes, [
    { a: "a", b: "b" },
    { a: "a", b: "ghost" },
    { a: "a", b: "a" },
    null
  ]);
  assert.equal(edges.length, 1, "只有 a-b 这条成得了");
  assert.equal(edges[0].x1, 50);
  assert.equal(edges[0].y1, 25);
  assert.equal(edges[0].x2, 250);
  assert.deepEqual(wbCanvasEdges([], []), []);
  assert.deepEqual(wbCanvasEdges(nodes, undefined), []);
});

test("画布节点：主对话=Composer、其余成员=Agent、落点去重成上下文节点", () => {
  const { wbCanvasNodes } = testApi();
  const project = {
    projectId: "p1",
    name: "鲸鱼插件上线",
    mainSessionId: "s-main",
    members: [
      { sessionId: "s-main", role: "main" },
      { sessionId: "s-ui", role: "member" },
      { sessionId: "s-host", role: "member" }
    ]
  };
  const tasks = [
    { taskId: "t1", subject: "体检宿主", status: "in_progress", ownerSessionId: "s-host", worktree: "work/t1" },
    { taskId: "t2", subject: "体检浏览器", status: "pending", ownerSessionId: "s-ui", worktree: "work/t2" },
    { taskId: "t3", subject: "同落点", status: "pending", ownerSessionId: "s-host", execRoot: "work/t1" },
    { taskId: "t4", subject: "没落点", status: "pending", ownerSessionId: null }
  ];
  const sessions = [
    { sessionId: "s-main", title: "主对话", running: true },
    { sessionId: "s-ui", title: "前端半边", running: true },
    { sessionId: "s-host", title: "宿主半边", running: false }
  ];
  const nodes = wbCanvasNodes(project, tasks, sessions);
  const composer = nodes.filter((node) => node.kind === "composer");
  const agents = nodes.filter((node) => node.kind === "agent");
  const contexts = nodes.filter((node) => node.kind === "folder");
  assert.equal(composer.length, 1, "主对话只能有一个 Composer 节点");
  assert.equal(composer[0].sessionId, "s-main");
  assert.equal(agents.length, 2, "两个成员 = 两个 Agent 节点");
  assert.equal(contexts.length, 2, "work/t1 与 work/t2 两个落点");
  const shared = contexts.filter((node) => node.title === "work/t1")[0];
  assert.ok(shared, "work/t1 必须成为上下文节点");
  assert.equal(shared.tasks.length, 2, "worktree=work/t1 与 execRoot=work/t1 是同一个落点，去重后两条任务都挂上去");
  assert.equal(contexts.filter((node) => node.title === "work/t2").length, 1, "另一个落点单独成节点");
  const ui = agents.filter((node) => node.sessionId === "s-ui")[0];
  assert.equal(ui.title, "前端半边", "节点标题取会话标题");
  assert.equal(ui.online, true);
  const host = agents.filter((node) => node.sessionId === "s-host")[0];
  assert.equal(host.online, false, "没在跑的成员显示空闲");
  assert.equal(host.sub, "体检宿主", "Agent 节点副标题 = 它负责的在跑任务");
  assert.equal(wbCanvasNodes(null, [], []).filter((node) => node.kind === "composer").length, 1, "没有项目也要有 Composer 占位");
});

// ── 6. 时钟与耗时 ──────────────────────────────────────────────────────────

test("时钟：今天 HH:MM、昨天带前缀、更早 MM-DD；空值不炸", () => {
  const { wbFormatClock } = testApi();
  const now = new Date(2026, 10, 9, 12, 0, 0).getTime();
  assert.equal(wbFormatClock(new Date(2026, 10, 9, 9, 5, 0).getTime(), now), "09:05");
  assert.equal(wbFormatClock(new Date(2026, 10, 8, 23, 30, 0).getTime(), now), "昨天 23:30");
  assert.equal(wbFormatClock(new Date(2026, 9, 30, 8, 0, 0).getTime(), now), "10-30");
  assert.equal(wbFormatClock(0, now), "");
  assert.equal(wbFormatClock(undefined, now), "");
});

test("耗时：秒/分/时/天四档", () => {
  const { wbElapsed } = testApi();
  assert.equal(wbElapsed(0), "0s");
  assert.equal(wbElapsed(4200), "4s");
  assert.equal(wbElapsed(63000), "1m03s");
  assert.equal(wbElapsed(3661000), "1h01m");
  assert.equal(wbElapsed(90000000), "1d01h");
  assert.equal(wbElapsed(undefined), "0s");
});

// ── 7. 组件渲染冒烟（React 垫片）───────────────────────────────────────────

test("工作台外壳：默认渲染项目列表侧栏与顶栏，主题跟着设置走", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const { WhaleWorkbench } = plugin.__test;
  const tree = render(h(WhaleWorkbench, {}));
  assert.ok(findByClass(tree, "daw-wb").length >= 1, "外壳必须挂 daw-wb（token 根）");
  assert.ok(findByClass(tree, "daw-wb-side").length >= 1, "侧栏必须渲染");
  assert.ok(findByClass(tree, "daw-wb-main").length >= 1, "主列必须渲染");
  assert.ok(findByClass(tree, "daw-wb-top").length >= 1, "顶栏必须渲染");
  // 默认落点是项目列表（D10：首次不默认进画布）
  assert.ok(findByClass(tree, "daw-wb-stats").length >= 1, "默认应该是项目列表页（统计条）");
  const root = findByClass(tree, "daw-wb")[0];
  assert.equal(root.props["data-wb-theme"], "light", "默认浅色");
});

test("工作台主题：设置切到 dark 时根节点换主题标记", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  plugin.__test.settings.set({ theme: "dark" });
  const tree = render(h(plugin.__test.WhaleWorkbench, {}));
  const root = findByClass(tree, "daw-wb")[0];
  assert.equal(root.props["data-wb-theme"], "dark");
  plugin.__test.settings.set({ theme: "light" });
});

test("工作台各页：空数据下都要能渲染（不炸）", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  const pages = [
    h(api.WbTasksPage, { t: (key) => key, projectId: "p1" }),
    h(api.WbBriefPage, { t: (key) => key, projectId: "p1" }),
    h(api.WbExecPage, { t: (key) => key, projectId: "p1" }),
    h(api.WbInboxPage, { t: (key) => key }),
    h(api.WbHandoffsPage, { t: (key) => key }),
    h(api.WbEventsPage, { t: (key) => key }),
    h(api.WbFirstPage, { t: (key) => key }),
    h(api.WbSettingsPage, { t: (key) => key }),
    h(api.WbTeamPage, { t: (key) => key })
  ];
  for (const page of pages) {
    assert.doesNotThrow(() => render(page), "页面渲染不能抛错");
  }
});

test("侧栏入口：点了才切面板，不默认抢占", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  const entry = render(h(api.WhalePanelEntry, { t: (key) => key }));
  const buttons = findByClass(entry, "daw-wb-entry");
  assert.equal(buttons.length, 0, "入口不该挂工作台内部类（它跑在宿主侧栏里，用的是行内样式）");
  let node = null;
  walk(entry, (item) => {
    if (item.type === "button" && node === null) node = item;
  });
  assert.ok(node, "入口必须渲染成一个按钮");
  assert.equal(typeof node.props.onClick, "function");
  // 没有 layout 服务时点击必须静默（不抛、不崩）
  assert.equal(api.wbSelectPanel("whales-canvas"), false);
  assert.doesNotThrow(() => node.props.onClick());
});

// ── 8. W1.5 事件台（Trigger 收件箱 + Source 健康面板）─────────────────────

const EVENTS_FIXTURE = [
  {
    eventId: "evt-1", projectId: "proj-whales", source: "plugin", kind: "proposal.submit",
    text: "把上线前体检做完：T1 宿主 / T2 浏览器 / T3 打包", evidence: "prop-9f3c",
    fingerprint: "proposal.submit|把上线前体检做完", at: Date.now() - 600000, state: "pending",
    rules: [
      { name: "rule: scope.match", hit: true, detail: "鲸鱼插件上线 在本项目范围" },
      { name: "rule: assignable", hit: true, detail: "2 个成员空闲" },
      { name: "rule: dedupe", hit: false, detail: "无同类待评估" }
    ]
  },
  {
    eventId: "evt-2", projectId: "proj-whales", source: "plugin", kind: "handoff.result",
    text: "notification msg_8d41", evidence: "msg_8d41", at: Date.now() - 900000, state: "opened",
    rules: [], ticketId: "ptask-t9", decidedAt: Date.now() - 800000, decidedBy: "user"
  },
  {
    eventId: "evt-3", projectId: null, source: "plugin", kind: "store.degraded",
    text: "projects.json 只读降级", evidence: "projects.json.corrupt-1", at: Date.now() - 1200000,
    state: "suppressed", rules: [{ name: "rule: dedupe", hit: false, detail: "10 分钟内已评估过同类" }]
  }
];

const HEALTH_FIXTURE = [
  { source: "plugin", state: "assessing", pending: 1, today: 12, suppressed: 4 },
  { source: "main-session", state: "ready", pending: 0, today: 0, suppressed: 0 },
  { source: "workspace", state: "suppressed", pending: 0, today: 3, suppressed: 3 },
  { source: "schedule", state: "noise", pending: 0, today: 1, suppressed: 0, mutedUntil: Date.now() + 3600000 }
];

function wbZhT(api) {
  return (key, vars) => {
    const raw = api.WB_TEXT.zh[key];
    if (raw === undefined) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
}

function collectText(node, out) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return; }
  if (Array.isArray(node)) { node.forEach((item) => collectText(item, out)); return; }
  if (typeof node !== "object") return;
  if (typeof node.type === "string") {
    for (const key of Object.keys(node.props || {})) {
      if (key === "children") continue;
      if (typeof node.props[key] === "string") out.push(node.props[key]);
    }
  }
  collectText(node.props ? node.props.children : undefined, out);
}

/** 给只读缓存灌一份事件台数据（垫片的 useSyncExternalStore 不订阅，必须手动读）。 */
async function primeEvents(api, data) {
  api.wbCache.reset();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    if (target.startsWith("/events")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: {} }) });
  };
  try {
    await api.wbCache.read("/events?projectId=proj-whales");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
}

test("事件台筛选项：design 四源 + 我们真实的 plugin 源 + 已抑制态", () => {
  const { WB_EVENT_SOURCES } = testApi();
  const keys = WB_EVENT_SOURCES.map((item) => item.key);
  assert.deepEqual(keys, ["all", "plugin", "main-session", "workspace", "schedule", "suppressed"]);
  for (const item of WB_EVENT_SOURCES) {
    assert.ok(typeof item.label === "string" && item.label.startsWith("event.filter."), item.key + " 必须指向文案键");
  }
});

test("健康码固定词表：只有五个词，不写自由文案", () => {
  const { WB_HEALTH_WORDS, WB_TEXT } = testApi();
  // 与设计稿 T-14 字面五个词的偏差：设计列了「已忽略」，但忽略是单条事件的处置、
  // 不是 Source 的状态；Source 级真实可达的是 idle（今天没有事件）。
  assert.deepEqual(Object.keys(WB_HEALTH_WORDS).sort(), ["assessing", "idle", "noise", "ready", "suppressed"]);
  for (const key of Object.keys(WB_HEALTH_WORDS)) {
    assert.ok(WB_TEXT.zh[WB_HEALTH_WORDS[key]], WB_HEALTH_WORDS[key] + " 必须有文案");
  }
  assert.equal(WB_TEXT.zh["event.health.ready"], "正常");
  assert.equal(WB_TEXT.zh["event.health.assessing"], "评估中");
  assert.equal(WB_TEXT.zh["event.health.suppressed"], "已抑制");
  assert.equal(WB_TEXT.zh["event.health.idle"], "今日无事件");
  assert.equal(WB_TEXT.zh["event.health.noise"], "已标记噪声");
});

test("健康码色调：评估中告警、噪声危险、抑制与今日无事件中性、正常 ok", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  for (const [state, want] of [["ready", "ok"], ["assessing", "warn"], ["suppressed", "neutral"], ["idle", "neutral"], ["noise", "danger"]]) {
    const row = { source: state, state: state, today: 0, suppressed: 0 };
    const tree = render(h(api.WbSourceHealth, { t: (key) => key, health: [row], events: [] }));
    // 表头下面那一行里的芯片（ legends 的五个词在前面，不能取第一个）
    const rowChip = findByClass(findByClass(tree, "daw-wb-tr")[1], "daw-wb-chip")[0];
    assert.equal(rowChip.props["data-tone"], want, state + " 的色调必须是 " + want);
  }
});

test("事件展开态：pending 给三条规则与三个动作；已处置只读且露出工单", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  const t = wbZhT(api);
  const pending = render(h(api.WbEventDetail, { t, row: EVENTS_FIXTURE[0], busy: false, onAct: () => {} }));
  const pendingTexts = [];
  collectText(pending, pendingTexts);
  const pendingJoined = pendingTexts.join("|");
  for (const word of ["rule: scope.match", "rule: assignable", "rule: dedupe", "命中", "未命中", "开工单", "忽略", "标记为噪声", "Trigger 原文"]) {
    assert.ok(pendingJoined.includes(word), "pending 展开态必须出现「" + word + "」");
  }

  const decided = render(h(api.WbEventDetail, { t, row: EVENTS_FIXTURE[1], busy: false, onAct: () => {} }));
  const decidedTexts = [];
  collectText(decided, decidedTexts);
  const decidedJoined = decidedTexts.join("|");
  assert.ok(decidedJoined.includes("已由 user 于"), "已处置要写明谁何时处置");
  assert.ok(decidedJoined.includes("已建工单 ptask-t9"), "已开工单要露出工单号");
  assert.ok(!decidedJoined.includes("标记为噪声"), "已处置的行不再给动作");
});

test("事件台页面：三行事件 + 健康面板四源；收起来的行不露规则", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  const t = wbZhT(api);
  await primeEvents(api, { source: "plugin", projectId: "proj-whales", events: EVENTS_FIXTURE, stats: { pending: 1, today: 12, opened: 1, ignored: 0 }, health: HEALTH_FIXTURE });
  const tree = render(h(api.WbEventsPage, { t, projectId: "proj-whales" }));
  assert.equal(findByClass(tree, "daw-wb-eventrow").length, 3, "三条事件都要渲染");
  assert.equal(findByClass(tree, "daw-wb-tr").length, 5, "健康面板表头 + 四个源");
  const texts = [];
  collectText(tree, texts);
  const joined = texts.join("|");
  for (const word of ["待评估", "今日 12 · 已开工单 1 · 已忽略 0", "Source 健康面板", "只用这五个词", "已标记为噪声", "同类 10 分钟只评估一次", "提案提交", "交接结果", "存储降级", "插件内部"]) {
    assert.ok(joined.includes(word), "事件台必须出现「" + word + "」");
  }
  // T-14 五列：Source / 类型 / 健康码 / 今日评估 / 自激保护
  const healthTable = findByClass(tree, "daw-wb-table")[0];
  const headTexts = [];
  collectText(healthTable, headTexts);
  for (const column of ["Source", "类型", "健康码", "今日", "自激保护"]) {
    assert.ok(headTexts.join("|").includes(column), "健康面板必须有「" + column + "」列");
  }
  assert.ok(!joined.includes("rule: scope.match"), "收起来的行不渲染规则（符合 T-11 展开态设计）");
});

test("事件台页面：空数据不炸，健康面板空表有占位", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  await primeEvents(api, { source: "plugin", projectId: null, events: [], stats: { pending: 0, today: 0, opened: 0, ignored: 0 }, health: [] });
  const tree = render(h(api.WbEventsPage, { t: (key) => key }));
  assert.equal(findByClass(tree, "daw-wb-eventrow").length, 0);
  assert.equal(findByClass(tree, "daw-wb-state").length, 1, "空列表要给占位");
});

test("开工单的项目上下文：优先工作台项目，回落事件自己的项目", () => {
  const { wbEventActionProject } = testApi();
  const withProject = { projectId: "proj-whales" };
  const noProject = { projectId: null };
  assert.equal(wbEventActionProject("proj-cds", withProject), "proj-cds", "在工作台里就用当前项目");
  assert.equal(wbEventActionProject(undefined, withProject), "proj-whales", "侧栏进来时用事件归属项目");
  assert.equal(wbEventActionProject("", noProject), "", "两边都没有就返回空串（前端据此提示）");
  assert.equal(wbEventActionProject(undefined, undefined), "");
});

test("只读缓存：同一 URL 共用一份快照， unsubscribe 后停止轮询", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: { projects: [] } }) });
  };
  try {
    const first = api.wbCache.subscribe("/projects", () => {});
    const second = api.wbCache.subscribe("/projects", () => {});
    await api.wbCache.read("/projects");
    assert.equal(calls.filter((url) => url === "/agent-whales/api/projects").length, 1, "两个订阅只发一次请求（共用去重）");
    const snapshot = api.wbCache.getSnapshot("/projects");
    assert.deepEqual(snapshot.data, { projects: [] });
    assert.equal(snapshot.error, null);
    first();
    second();
    // 退订后不再有订阅者：invalidate 不该再发请求
    const before = calls.length;
    api.wbCache.invalidate("/projects");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, before, "没有订阅者时不空转");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    api.wbCache.reset();
  }
});

test("只读缓存：信封业务码非 200 记为错误，不把坏数据当快照", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 40401, msg: "project not found" }) });
  try {
    await assert.rejects(() => api.wbCache.read("/projects/nope"), /project not found/);
    const snapshot = api.wbCache.getSnapshot("/projects/nope");
    assert.equal(snapshot.data, undefined, "失败不能留下半个 data");
    assert.equal(snapshot.error, "project not found");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    api.wbCache.reset();
  }
});

test("hook 顺序：在列表页与工作台之间来回切，外壳自身的 hook 次数必须一致", () => {
  // 回归守门：WhaleWorkbench 里的 useWb 曾经按 route 条件调用，真实 React 下
  // 一从工作台退回列表就会 "Rendered fewer hooks than expected" 白屏。
  // 只数外壳这一层（子组件各有自己的 hook 顺序，不该混进来算）。
  const counts = [];
  const countingReact = createReactShim();
  const realUseState = countingReact.useState;
  const realUseRef = countingReact.useRef;
  const realUseSync = countingReact.useSyncExternalStore;
  countingReact.useState = (...args) => { counts[counts.length - 1] += 1; return realUseState(...args); };
  countingReact.useRef = (...args) => { counts[counts.length - 1] += 1; return realUseRef(...args); };
  countingReact.useSyncExternalStore = (...args) => { counts[counts.length - 1] += 1; return realUseSync(...args); };

  const loaded = loadPlugin({ react: countingReact });
  installDocumentStub();
  const api = loaded.plugin.__test;
  const routes = [
    { kind: "list" },
    { kind: "workbench", projectId: "proj-whales", tab: "canvas" },
    { kind: "workbench", projectId: "proj-whales", tab: "tasks" },
    { kind: "inbox" },
    { kind: "settings" },
    { kind: "workbench", projectId: "proj-whales", tab: "brief" },
    { kind: "list" }
  ];
  for (const route of routes) {
    counts.push(0);
    api.wbRoute.set(route);
    api.WhaleWorkbench({});
  }
  assert.equal(new Set(counts).size, 1, "每条路由的 hook 次数必须一样，实际 " + counts.join(","));
  assert.ok(counts[0] >= 4, "外壳至少该有 settings/route/projects/tasks 四个 hook，实际 " + counts[0]);
});
