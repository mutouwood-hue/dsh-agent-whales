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
