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
import { readFileSync } from "node:fs";

import { createMount, createReactShim, findByClass, installDocumentStub, loadPlugin, render, walk } from "./harness.mjs";
import { flowLoadPlugin, flowMount } from "./flow-harness.mjs";
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

/** 在渲染树里找「文案等于 text 且带 onClick」的按钮，返回它的 props。 */
function buttonByText(tree, text) {
  let found = null;
  walk(tree, (node) => {
    if (found !== null) return;
    const children = node.props ? node.props.children : undefined;
    const flat = Array.isArray(children) ? children : [children];
    if (typeof node.props.onClick === "function" && flat.indexOf(text) >= 0) found = node.props;
  });
  return found;
}

test("旅程：外壳进新建项目弹窗，填了名称后确认按钮必须可用", async () => {
  // 回归守门：WhaleWorkbench 曾没把 useSessions 传给 WbProjectList（props 不会自动
  // 流向孙组件）→ 列表页 useWbSessions 取不到钩子 → sessionRows 恒为 [] →
  // 「新建项目」的主会话下拉为空、确认按钮永久禁用。用户侧症状：画布建不了项目，
  // 于是一个项目都没有，也就打不开任何项目。测试只渲染页面本身一直查不到，
  // 因为测试直接把 useSessions 递给页面，绕过了外壳这一层。
  // 垫片必须先建再加载：loadPlugin 不传 react 就用默认垫片，那个的 useState
  // setter 是 no-op，「点一下 → 状态变 → 树变」整条链都模拟不出来。
  const { mount, shim } = createMount();
  const { plugin } = loadPlugin({
    react: shim,
    // 必须给 fetch：忠实垫片会真的订阅 → 真的发请求。没有它，路由走错误分支，
    // 空态（「加入已有对话」只在空态出现）就被错误态取代——这条用例 2026-11-16
    // 就这么红过，当时还以为是产品回归。
    fetch: (url) => {
      const target = String(url).replace("/agent-whales/api", "");
      if (target === "/projects") return { code: 200, msg: "success", data: { projects: [] } };
      if (target === "/sessions") return { code: 200, msg: "success", data: { sessions: [] } };
      if (target === "/activity") return { code: 200, msg: "success", data: { at: 0, active: {} } };
      return { code: 200, msg: "success", data: {} };
    }
  });
  installDocumentStub();
  const api = plugin.__test;
  api.wbRoute.set({ kind: "list" });
  // 先预热缓存再挂载：忠实垫片会真的订阅，而数据是 promise 回来的——
  // 不预热，mount() 拿到的树还停在 loading 态，空态（「加入已有对话」只在空态出现）
  // 根本还没渲染。这个文件里的画布用例都是这么写的。
  for (const url of ["/projects", "/sessions", "/activity"]) {
    await api.wbCache.read(url).catch(() => {});
  }
  const state = {
    ids: ["sess-main"],
    byId: { "sess-main": { sessionId: "sess-main", title: "主对话", running: false, origin: "live" } },
    phase: "ready",
    projectionsBySession: {}
  };
  const view = mount(api.WhaleWorkbench, {
    useSessions: (selector) => selector(state),
    leadIdOf: (id) => id,
    focusSession: () => true
  });
  // 等一个宏任务：垫片在 store 通知时自动重画（真 React 的行为），
  // 而通知是 promise 回调里发出来的——不让事件循环转一圈，树还停在 loading 态。
  await new Promise((resolve) => setImmediate(resolve));

  const openCreate = buttonByText(view.tree, "＋ 新建项目");
  assert.ok(openCreate, "列表页要有「＋ 新建项目」按钮");
  openCreate.onClick();
  view.rerender();

  const nameInput = findByClass(view.tree, "daw-wb-input")[0];
  assert.ok(nameInput, "弹窗要有名称输入框");
  nameInput.props.onChange({ target: { value: "鲸鱼协作" } });
  view.rerender();

  const confirm = buttonByText(view.tree, "确认");
  assert.ok(confirm, "弹窗要有确认按钮");
  assert.notEqual(confirm.disabled, true,
    "名称填了就还得能确认；仍 disabled 说明主会话下拉是空的——useSessions 没传到列表页");

  // join 弹窗是被同一个括号 bug 吃掉的另一个：两个 modal 三元都掉进了
  // h(WbState) 的实参里，空态时一起被丢。只测 create 会漏掉它。
  const cancel = buttonByText(view.tree, "取消");
  assert.ok(cancel, "create 弹窗要有取消按钮");
  cancel.onClick();
  view.rerender();
  assert.equal(findByClass(view.tree, "daw-wb-modal").length, 0, "取消要能关掉弹窗");

  const openJoin = buttonByText(view.tree, "加入已有对话");
  assert.ok(openJoin, "空态要有「加入已有对话」入口");
  openJoin.onClick();
  view.rerender();
  assert.equal(findByClass(view.tree, "daw-wb-modal").length, 1, "join 弹窗也要能打开");
  assert.ok(findByClass(view.tree, "daw-wb-select").length >= 1, "join 弹窗要有会话下拉");
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

test("布局契约：daw-wb-body 必须是 positioned，否则画布盖住侧栏并吃掉点击", () => {
  // 2026-11-16 真机实测：进项目画布后**侧栏整个消失**，点「需要我处理」报
  // 「.daw-wb-stage ... intercepts pointer events」。
  // 根因：`.daw-wb-canvaswrap` 是 position:absolute;inset:0，而 .daw-wb-body /
  // .daw-wb-main / .daw-wb 都不是 positioned → 包含块落到初始包含块（视口），
  // 画布铺满视口盖住侧栏，且 .daw-wb-body 的 overflow 也裁不了它
  // （overflow 只裁包含块链经过自己的后代）。
  // 离线看不见：jsdom 式垫片不算布局，只有真浏览器的盒子模型会暴露。
  const { plugin } = loadPlugin();
  const css = plugin.__test.WB_CSS;
  // WB_CSS 可能是字符串数组，也可能是拼好的整串（防重构）：两条路都认。
  const rules = Array.isArray(css) ? css : [String(css)];
  const joined = rules.join("\n");
  assert.ok(/\.daw-wb-body\{[^}]*position:relative/.test(joined), "daw-wb-body 必须自己是 positioned，给画布的 inset:0 一个正确的包含块");
  // 反证：少了这条时画布的包含块会逃出主区
  assert.ok(!/\.daw-wb-main\{[^}]*position:/.test(joined), "这条规则只需挂在最靠近画布的那层，不必上移到 main");
  // 顺带钉住画布那两条 absolute 规则还在（它们是被修的一方）
  assert.match(joined, /\.daw-wb-canvaswrap\{position:absolute;inset:0\}/, "canvaswrap 仍是 inset:0——修的是它的包含块，不是它自己");
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

// ── 12. 画布位置：宿主权威 + 本地兜底（R1 返工）────────────────────────────
//
// 节点是派生的，位置是唯一「人摆过」的状态。R1 之前它只活在 localStorage：刷新不丢，
// 但换设备/换浏览器就丢，且 agent 完全看不到。现在宿主 canvas.json 是权威。

test("画布位置：hydrate 灌宿主快照，get 先读缓存", () => {
  const { wbNodePositions } = testApi();
  wbNodePositions.hydrate("proj-1", { rev: 3, nodes: { "session-a": { x: 340, y: 168, w: 300, h: 224 } } });
  assert.deepEqual(wbNodePositions.get("proj-1", "session-a"), { x: 340, y: 168, w: 300, h: 224 });
  assert.equal(wbNodePositions.get("proj-1", "nope"), undefined, "没摆过的节点不瞎编位置");
});

test("画布位置：set 立刻改本地（拖拽不等网络），坏宿主不炸", () => {
  const { wbNodePositions } = testApi();
  wbNodePositions.hydrate("proj-2", { rev: 0, nodes: {} });
  assert.doesNotThrow(() => wbNodePositions.set("proj-2", "session-b", 700, 40), "没有 fetch 也不能抛");
  assert.deepEqual(wbNodePositions.get("proj-2", "session-b"), { x: 700, y: 40, w: 0, h: 0 }, "UI 必须立刻跟着动");
  assert.doesNotThrow(() => wbNodePositions.flushNow("proj-2"), "立即 flush 也不能抛");
});

test("画布位置：hydrate 容忍坏数据（宿主 5xx / 空响应）", () => {
  const { wbNodePositions } = testApi();
  assert.doesNotThrow(() => wbNodePositions.hydrate("proj-3", undefined));
  assert.doesNotThrow(() => wbNodePositions.hydrate("proj-3", { rev: "x", nodes: null }));
  assert.equal(wbNodePositions.get("proj-3", "session-a"), undefined);
});

test("画布路由：记住上次选择，无记录时仍是列表（D10 两条都要）", () => {
  const seeded = loadPlugin({ storedExtra: { "dsh-agent-whales.last-view": JSON.stringify({ kind: "workbench", projectId: "proj-9", tab: "exec" }) } });
  const route = seeded.plugin.__test.wbRoute;
  assert.deepEqual(route.get(), { kind: "workbench", projectId: "proj-9", tab: "exec" }, "必须 recall 上次的项目与 tab");
  const dirty = loadPlugin({ storedExtra: { "dsh-agent-whales.last-view": JSON.stringify({ kind: "nope", projectId: 5 }) } });
  assert.deepEqual(dirty.plugin.__test.wbRoute.get(), { kind: "list" }, "非法 kind 回落 list");
  const broken = loadPlugin({ storedExtra: { "dsh-agent-whales.last-view": "{不是 JSON" } });
  assert.deepEqual(broken.plugin.__test.wbRoute.get(), { kind: "list" }, "坏 JSON 回落 list");
});

test("画布路由：每次 set 都落盘，首次无记录不进画布", () => {
  const loaded = loadPlugin();
  const api = loaded.plugin.__test;
  assert.deepEqual(api.wbRoute.get(), { kind: "list" }, "首次必须是列表——不默认进画布（D10）");
  api.wbRoute.project("proj-1", "tasks");
  assert.deepEqual(api.wbRoute.get(), { kind: "workbench", projectId: "proj-1", tab: "tasks" });
  const raw = loaded.storage.get("dsh-agent-whales.last-view");
  assert.ok(raw !== undefined, "切换视图必须写盘，否则刷新回不去");
  assert.equal(JSON.parse(raw).tab, "tasks");
});

// ── 13. 画布件契约：小地图 + 网格开关（R2 返工）────────────────────────────
// 这两条原审核结论是「没做」。小地图是只读镜像（不接交互），网格原来常开且没有开关。

test("画布件：空项目下画布页仍能渲染（小地图不能把它带崩）", () => {
  installDocumentStub();
  const { WbCanvasPage } = testApi();
  assert.doesNotThrow(() => render(h(WbCanvasPage, { t: (key) => key, projectId: "p1" })), "没有项目数据也要能渲染");
});

// ── 14. 空 URL 不发请求（避免明知失败的请求每 5s 打一次）────────────────────

test("只读缓存：URL 为 null 时不建 entry、不发请求、返回常量空快照", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: {} }) });
  };
  try {
    const off = api.wbCache.subscribe(null, () => {});
    assert.equal(typeof off, "function", "退订函数照样要返回");
    assert.deepEqual(api.wbCache.getSnapshot(null), { data: undefined, error: null, loading: false, at: 0 });
    assert.equal(await api.wbCache.read(null), undefined, "read(null) 直接给 undefined，不发请求");
    off();
    assert.equal(calls.length, 0, "一次请求都不该发（/proposals 缺 leadSessionId 必然 40000）");
    // 空快照必须是同一个对象：useSyncExternalStore 靠 Object.is 判等，换对象会无限重渲染
    assert.equal(api.wbCache.getSnapshot(null), api.wbCache.getSnapshot(null), "空快照必须缓存，不能每次新建");
    assert.equal(api.wbCache.getSnapshot(""), api.wbCache.getSnapshot(null), "空串与 null 同等对待");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test("目标条 / 提案卡：拿不到 lead 会话时不再请求 /proposals", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 40000, msg: "leadSessionId is required" }) });
  };
  try {
    // 没有 leadId：整条不渲染，也不该留下一次请求
    render(h(api.WhaleGoalBar, { t: (key) => key, sessionId: undefined, useSessions: () => undefined }));
    render(h(api.WbProposalCard, { t: (key) => key }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 0, "拿不到 lead 会话时一次都不该请求，实际发了：" + JSON.stringify(calls));
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test("只读缓存：useSyncExternalStore 契约——发布才通知、快照在发布间必须稳定", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();

  // 1) 稳定：两次 getSnapshot 必须是同一个对象。
  //    否则 React 18 会判定「快照没缓存」并报 The result of getSnapshot should be cached，
  //    表现就是组件反复重渲染、界面卡在某个状态——这类 bug 在假垫片下看不出来。
  const first = api.wbCache.getSnapshot("/projects");
  assert.equal(api.wbCache.getSnapshot("/projects"), first, "发布之间快照必须同一个对象");

  // 2) 订阅后发布要通知到 listener
  let notified = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: { projects: [] } }) });
  try {
    const off = api.wbCache.subscribe("/projects", () => { notified += 1; });
    assert.ok(notified >= 1, "订阅后首次 load 会同步发布一次（loading:false→true）");
    const loadingSnapshot = api.wbCache.getSnapshot("/projects");
    assert.equal(loadingSnapshot.loading, true, "请求在飞时应是 loading");
    await api.wbCache.read("/projects");
    assert.ok(notified > 1, "请求 resolve 后必须再发布一次，否则界面永远停在 loading");
    const done = api.wbCache.getSnapshot("/projects");
    assert.equal(done.loading, false, "resolve 后 loading 必须清零");
    assert.deepEqual(done.data, { projects: [] }, "数据要进快照");
    // 3) 发布之间再次稳定
    assert.equal(api.wbCache.getSnapshot("/projects"), done, "发布之间仍然要稳定");
    off();
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

// ── 15. 画布节点检视（A/C 方向：开发协作定位）────────────────────────────────
//
// 画布原来只能「摆位置、连关联线、删节点」，是个拓扑图不是开发工具。开发者盯着一个
// 节点时真正想问的是「这个 Agent 在干什么、卡在哪儿、活儿派到哪了」——这些信息此前
// 散在任务板和待办两个页签里。wbNodeInspector 把纯推导部分抽出来可离线测。

const INSPECTOR_TASKS = [
  { taskId: "t-1", subject: "修登录态", ownerSessionId: "s-agent", status: "in_progress", worktree: "/repo/a", revision: 3 },
  { taskId: "t-2", subject: "补测试", ownerSessionId: "s-agent", status: "pending", execRoot: "/repo/b", blockedBy: ["t-9"], revision: 1 },
  { taskId: "t-3", subject: "写文档", ownerSessionId: "s-agent", status: "completed", revision: 2, report: { status: "done", summary: "ok", rev: 1 } },
  { taskId: "t-4", subject: "别人的活", ownerSessionId: "s-other", status: "in_progress", worktree: "/repo/a" },
  { taskId: "t-9", subject: "前置活儿", ownerSessionId: "s-other", status: "in_progress" },
  { taskId: "t-dead", subject: "已作废", ownerSessionId: "s-other", status: "deleted" },
  { taskId: "t-5", subject: "依赖已作废", ownerSessionId: "s-agent", status: "pending", blockedBy: ["t-dead"] }
];
const INSPECTOR_SESSIONS = [
  { sessionId: "s-agent", title: "小张", running: true },
  { sessionId: "s-other", title: "小李", running: false }
];

test("节点检视：Agent 节点给出在线状态、它的任务与已完工计数", () => {
  const { wbNodeInspector } = testApi();
  const data = wbNodeInspector(
    { kind: "agent", sessionId: "s-agent", title: "小张" },
    { tasks: INSPECTOR_TASKS, sessions: INSPECTOR_SESSIONS }
  );
  assert.equal(data.kind, "agent");
  assert.equal(data.statusLabel, "在线", "running=true 必须说在线");
  assert.equal(data.statusTone, "ok");
  assert.equal(data.tasks.length, 3, "已完成/已删的不算「在干什么」");
  assert.equal(data.doneCount, 1, "已完工只计数不进列表");
  assert.equal(data.tasks[0].subject, "修登录态");
  assert.equal(data.tasks[0].where, "/repo/a", "落点取 worktree");
  assert.equal(data.tasks[1].where, "/repo/b", "没有 worktree 时取 execRoot");
  assert.equal(data.tasks[1].blockedReason, "wait", "等一个未完成的依赖");
  assert.equal(data.tasks[2].blockedReason, "deleted", "依赖已作废是另一种阻塞，不能混为一谈");
  assert.equal(data.tasks[2].subject, "依赖已作废");
  assert.equal(data.tasks[0].blockedReason, null, "没阻塞就不能编一个");
});

test("节点检视：Agent 离线且没任务时明说，不留空", () => {
  const { wbNodeInspector } = testApi();
  const data = wbNodeInspector(
    { kind: "agent", sessionId: "s-ghost", title: "幽灵" },
    { tasks: INSPECTOR_TASKS, sessions: INSPECTOR_SESSIONS }
  );
  assert.equal(data.statusLabel, "空闲");
  assert.equal(data.statusTone, "neutral");
  assert.equal(data.tasks.length, 0);
  assert.deepEqual(data.notes, ["没有进行中的任务"], "空态必须有一句说明");
});

test("节点检视：落点节点列出指向它的任务与牵扯到的人（去重）", () => {
  const { wbNodeInspector } = testApi();
  const data = wbNodeInspector(
    { kind: "folder", title: "/repo/a", tasks: [INSPECTOR_TASKS[0], INSPECTOR_TASKS[3]] },
    { tasks: INSPECTOR_TASKS, sessions: INSPECTOR_SESSIONS }
  );
  assert.equal(data.kind, "folder");
  assert.equal(data.statusLabel, "2 个任务指向这里");
  assert.equal(data.tasks.length, 2);
  assert.deepEqual(data.people, ["小张", "小李"], "人要去重，且用会话标题不用 id");
});

test("节点检视：Composer 节点报提案待确认与简报在不在", () => {
  const { wbNodeInspector } = testApi();
  const withPending = wbNodeInspector(
    { kind: "composer", title: "Composer" },
    { tasks: [], sessions: [], inbox: { groups: [{ key: "proposals", label: "提案待确认", items: [{ proposalId: "p1" }, { proposalId: "p2" }] }] } }
  );
  assert.equal(withPending.statusLabel, "2 条提案待确认");
  assert.equal(withPending.statusTone, "warn");
  assert.equal(withPending.notes[0], "项目简报还没写");

  const withBrief = wbNodeInspector(
    { kind: "composer", title: "Composer" },
    { project: { brief: { version: 4 } }, inbox: { groups: [] } }
  );
  assert.equal(withBrief.statusLabel, "没有待确认提案");
  assert.equal(withBrief.notes[0], "项目简报已写（v4）");
});

test("节点检视：坏数据不炸，且不猜事件归属", () => {
  const { wbNodeInspector } = testApi();
  assert.equal(wbNodeInspector(null, {}), null, "没有节点就没有检视");
  assert.equal(wbNodeInspector(undefined, undefined), null);
  assert.equal(wbNodeInspector({ kind: "unknown" }, {}), null, "不认识的 kind 不硬渲染");
  assert.doesNotThrow(() => wbNodeInspector({ kind: "agent" }, undefined), "ctx 整个缺也要能活");
  // 事件台账不带 sessionId（宿主 eventView 已核实），所以检视器不算事件——这里锁住「不猜」
  const data = wbNodeInspector({ kind: "agent", sessionId: "s-agent" }, { tasks: [], sessions: [] });
  assert.ok(!("events" in data), "没有 session 关联字段就不该凭空给事件列表");
});

test("节点检视组件：坏数据渲染降级而不是把画布带崩", () => {
  installDocumentStub();
  const { WbNodeInspector } = testApi();
  const t = (key) => key;
  assert.doesNotThrow(() => render(h(WbNodeInspector, { t, data: null })), "data 为 null 返回 null");
  assert.doesNotThrow(() => render(h(WbNodeInspector, { t })), "data 整个缺也要活");
  // 曾经这里会抛 data.tasks.map is not a function——一个节点检视把整块画布带崩
  const tree = render(h(WbNodeInspector, { t, data: { kind: "weird", tasks: "not-array", people: null, notes: null, doneCount: "x", title: 5, statusLabel: {} } }));
  assert.ok(findByClass(tree, "daw-wb-inspect").length === 1, "坏数据也要渲染出一个面板，不是白屏");
  assert.equal(findByClass(tree, "daw-wb-inspect-task").length, 0, "tasks 不是数组就当没有任务");
});

test("节点检视组件：正常数据渲染出状态、任务、落点与阻塞原因", () => {
  installDocumentStub();
  const { WbNodeInspector, wbNodeInspector } = testApi();
  const data = wbNodeInspector(
    { kind: "agent", sessionId: "s-1", title: "小张" },
    { tasks: [{ taskId: "t-1", subject: "修登录态", ownerSessionId: "s-1", status: "in_progress", worktree: "/repo/a" }, { taskId: "t-2", subject: "补测试", ownerSessionId: "s-1", status: "pending", blockedBy: ["t-9"] }], sessions: [{ sessionId: "s-1", title: "小张", running: true }] }
  );
  const tree = render(h(WbNodeInspector, { t: (key) => key, data, onClose: () => {} }));
  assert.equal(findByClass(tree, "daw-wb-inspect-task").length, 2, "两个在跑任务都要列出来");
  assert.equal(findByClass(tree, "daw-wb-inspect-task-blocked").length, 1, "t-9 不在表里 → 「依赖没了」要显示");
  assert.ok(findByClass(tree, "daw-wb-inspect-task-where").length >= 1, "落点要有一席之地");
});

// ── 16. 观测层：Agent 节点的「最近调用」────────────────────────────────────
//
// 数据来自宿主 /sessions 的 recentTools（= 会话事件里的 tool/call，已在真实落盘
// 会话里核实形状）。这一层只展示，不做允许/禁止判断——那是约束层的事。

test("观测层：Agent 检视列出最近调用的工具，去重且保持最近优先", () => {
  const { wbNodeInspector } = testApi();
  const data = wbNodeInspector(
    { kind: "agent", sessionId: "s-1", title: "小张" },
    {
      tasks: [],
      sessions: [{
        sessionId: "s-1", title: "小张", running: true,
        recentTools: [
          { name: "pwsh", at: 300, seq: 5 },
          { name: "read", at: 100, seq: 2 },
          { name: "pwsh", at: 200, seq: 4 },
          { name: "pwsh", at: 400, seq: 6 }
        ]
      }]
    }
  );
  assert.deepEqual(data.toolNames, ["pwsh", "read"], "同一工具调多次只出现一次，且保持最近优先的顺序");
  assert.equal(data.toolCallCount, 4, "总调用次数要如实报，不能因为去重就少算");
});

test("观测层：会话没调过工具时不编造，字段给空", () => {
  const { wbNodeInspector } = testApi();
  const none = wbNodeInspector({ kind: "agent", sessionId: "s-1" }, { sessions: [{ sessionId: "s-1", title: "小张" }] });
  assert.deepEqual(none.toolNames, [], "没调过就是空数组");
  assert.equal(none.toolCallCount, 0);
  const dirty = wbNodeInspector({ kind: "agent", sessionId: "s-1" }, { sessions: [{ sessionId: "s-1", recentTools: "not-array" }] });
  assert.deepEqual(dirty.toolNames, [], "recentTools 形状不对时当没有，不抛");
  const nameless = wbNodeInspector({ kind: "agent", sessionId: "s-1" }, { sessions: [{ sessionId: "s-1", recentTools: [{ at: 1 }, { name: "" }, null] }] });
  assert.deepEqual(nameless.toolNames, [], "缺 name / 空 name 的条目不能进去");
});

test("观测层：只有 Agent 节点有工具调用，落点与 Composer 不给", () => {
  const { wbNodeInspector } = testApi();
  const sessions = [{ sessionId: "s-1", title: "小张", recentTools: [{ name: "pwsh", at: 1, seq: 1 }] }];
  const folder = wbNodeInspector({ kind: "folder", title: "/r", tasks: [] }, { sessions });
  const composer = wbNodeInspector({ kind: "composer", title: "C" }, { sessions });
  assert.ok(!("toolNames" in folder), "落点节点是「哪些任务指向这」，不是工具调用");
  assert.ok(!("toolNames" in composer), "Composer 管提案与派发，给它列工具调用是答非所问");
});

test("观测层：检视组件渲染「最近调用」代码块", () => {
  installDocumentStub();
  const { WbNodeInspector, wbNodeInspector } = testApi();
  const data = wbNodeInspector(
    { kind: "agent", sessionId: "s-1", title: "小张" },
    { tasks: [], sessions: [{ sessionId: "s-1", title: "小张", running: true, recentTools: [{ name: "pwsh", at: 1, seq: 1 }, { name: "read", at: 2, seq: 2 }] }] }
  );
  const tree = render(h(WbNodeInspector, { t: (key) => key, data }));
  assert.equal(findByClass(tree, "daw-wb-inspect-tool").length, 2, "两个工具名都要渲染成 code 块");
  assert.ok(findByClass(tree, "daw-wb-inspect-tools").length === 1, "要有一个「最近调用」行");
});

// ── 17. A1：画布上增派 Agent ─────────────────────────────────────────────
//
// 此前的bug：空态文案写着「或先加一个 Agent」，但 onAddAgent 出现 0 次——
// 用户照做时无路可走。宿主路由 POST /projects/:id/members 一直都有，
// 差的只是画布侧的一个落点。这里测的是「哪些会话可加入」的过滤口径。

test("A1：可加入会话排除主对话与现有成员，坏数据当不能加", () => {
  const { wbAddableSessions } = testApi();
  const sessions = [
    { sessionId: "s-main", title: "主线" },
    { sessionId: "s-a", title: "小张" },
    { sessionId: "s-b", title: "小李" },
    { sessionId: "s-c", title: "新人" }
  ];
  const project = { mainSessionId: "s-main", members: [{ sessionId: "s-a", role: "member" }] };
  const rows = wbAddableSessions(sessions, project);
  assert.deepEqual(rows.map((r) => r.sessionId), ["s-b", "s-c"], "主对话和现有成员都不能再出现");
  // 坏数据不能抛，也不能把脏会话放进去
  assert.deepEqual(wbAddableSessions(undefined, project), []);
  assert.deepEqual(wbAddableSessions("x", project), []);
  assert.deepEqual(wbAddableSessions([{ title: "没 id" }, null, { sessionId: "" }], project), [], "缺 id 的会话不能加入");
  // 没有 members 字段时只用主对话排除
  assert.deepEqual(wbAddableSessions(sessions, { mainSessionId: "s-main" }).map((r) => r.sessionId), ["s-a", "s-b", "s-c"]);
  // 没有 mainSessionId 时不误伤任何人
  assert.equal(wbAddableSessions(sessions, {}).length, 4);
});

test("A1：画布上真的有「添加 Agent」落点，点得开也关得掉", async () => {
  // 这条曾经是源码 grep（断言 "setAddState(true)" 字面量）。改名就红，而且抓不到真 bug：
  // 2026-11-14 真机三连——addState 元组当值用（弹窗条件永不成立）、setAddState 未声明
  // （点击即抛 ReferenceError）、busyState 从没声明（点「加入」就抛）。
  // 现在用 createMount 真点一遍：挂画布 → 点添加节点 → 弹窗出现 → 取消 → 弹窗消失。
  const { shim, mount } = createMount({ effects: true });
  const loaded = flowLoadPlugin(shim);
  installDocumentStub();
  const api = loaded.plugin.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    if (target === "/projects") return ok([{ projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1", role: "member" }], links: [], brief: { goal: "g" } }]);
    if (target === "/projects/p1") return ok({ project: { projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1", role: "member" }], links: [], brief: { goal: "g" } } });
    if (target === "/projects/p1/brief") return ok({ brief: { version: 1, goal: "g", decisions: [], constraints: [] } });
    if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [{ sessionId: "s1" }], mainSessionId: "main" });
    if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [] });
    if (target === "/sessions") return ok({ source: "host", sessions: [{ sessionId: "s1", title: "Agent 甲", running: true }, { sessionId: "s2", title: "新人乙", running: false }] });
    if (target === "/activity") return ok({ at: Date.now(), active: {} });
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: [] });
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: [] });
    return ok({});
  };
  const collect = (node, out, match) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (Array.isArray(node)) { node.forEach((item) => collect(item, out, match)); return; }
    if (typeof node !== "object") return;
    if (typeof node.type === "string" && node.props && match(node)) out.push(node);
    collect(node.props ? node.props.children : undefined, out, match);
  };
  const texts = (node) => {
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
  };
  // 精确匹配类名 token：daw-wb-modal-title / -foot 也含 "daw-wb-modal" 子串，
  // 用 indexOf 会把标题和页脚一起算进来（3 !== 1 就是这么来的）。
  const isModal = (n) => typeof n.props.className === "string" && n.props.className.split(" ").indexOf("daw-wb-modal") >= 0;
  const modalsIn = (tree) => { const out = []; collect(tree, out, isModal); return out; };
  try {
    const urls = ["/projects", "/projects/p1", "/projects/p1/brief", "/projects/p1/mcp-links", "/tasks?projectId=p1", "/sessions", "/activity", "/canvas?projectId=p1", "/inbox?projectId=p1", "/handoffs?projectId=p1"];
    for (const url of urls) await api.wbCache.read(url).catch(() => {});
    const t = (key, vars) => {
      const raw = api.WB_TEXT.zh[key];
      if (raw === undefined) return "«" + key + "»";
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
    };
    const view = await flowMount(mount, api, { t: t, projectId: "p1" }, loaded);
    const addNodes = [];
    collect(view.tree, addNodes, (n) => n.props["data-kind"] === "add");
    assert.equal(addNodes.length, 1, "画布上必须有一个「添加 Agent」占位节点");
    assert.doesNotThrow(() => { addNodes[0].props.onClick({ stopPropagation() {} }); view.rerender(); }, "点添加节点不能抛");
    assert.equal(modalsIn(view.tree).length, 1, "点完必须弹出加入弹窗");
    const allButtons = [];
    collect(view.tree, allButtons, (n) => n.type === "button");
    const cancel = allButtons.filter((b) => texts(b) === "取消")[0];
    assert.ok(cancel, "弹窗里必须有取消按钮");
    cancel.props.onClick({ stopPropagation() {} });
    view.rerender();
    assert.equal(modalsIn(view.tree).length, 0, "取消之后弹窗必须消失");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    api.wbCache.reset();
  }
});
// ── 18. A2：连线检视 ─────────────────────────────────────────────────────
//
// 此前的bug：点连线只有「删除」一个动作，而节点有检视卡——严重不对称。
// 用户想看看这两个 Agent 之间发生过什么，只能去「发送记录」页签。
// 而连线承载的正是这层关系，数据也一直在（/handoffs 账本）。
// fixture 是真实 handoffs.json（94 条），不是我编的。

import { readFileSync as readFixture } from "node:fs";
const REAL_HANDOFFS = JSON.parse(readFixture(new URL("./fixtures/real-handoffs.json", import.meta.url), "utf8"));

test("A2：连线检视按会话对过滤，无向且倒序", () => {
  const { wbLinkHandoffs } = testApi();
  // 真实数据里 s9 ↔ visit 有 32 条，是最常往来的一对
  const rows = wbLinkHandoffs(REAL_HANDOFFS, "s9", "visit");
  assert.equal(rows.length, 32, "s9↔visit 有 32 条，一条都不能少");
  assert.equal(rows.length, wbLinkHandoffs(REAL_HANDOFFS, "visit", "s9").length, "无向：换顺序结果必须一样");
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].at <= rows[i - 1].at, "必须倒序（新的在前）");
  }
  // 每一行都确实是这两者之间的
  for (const row of rows) {
    assert.ok((row.from === "s9" && row.to === "visit") || (row.from === "visit" && row.to === "s9"), "不能漏进第三方的记录");
  }
});

test("A2：没往来就是空，不编造；坏数据不抛", () => {
  const { wbLinkHandoffs } = testApi();
  assert.deepEqual(wbLinkHandoffs(REAL_HANDOFFS, "s9", "不存在的会话"), []);
  assert.deepEqual(wbLinkHandoffs(undefined, "a", "b"), []);
  assert.deepEqual(wbLinkHandoffs("not-array", "a", "b"), []);
  assert.deepEqual(wbLinkHandoffs(REAL_HANDOFFS, "", "b"), [], "空 id 不过滤");
  assert.deepEqual(wbLinkHandoffs(REAL_HANDOFFS, "a", ""), []);
  assert.deepEqual(wbLinkHandoffs([null, { from: "a" }, { to: "b" }], "a", "b"), [], "缺字段的条目不能算往来");
  // from 可能是 "user"（人直接说），不能假设两端都是会话 id
  assert.equal(wbLinkHandoffs(REAL_HANDOFFS, "user", "s-live").length, 12, "user↔s-live 有 12 条");
});

// ── 19. B1/B2：画布上派发与改目标 ─────────────────────────────────────────
//
// B1：此前建/派/指派全在任务板，画布上一点都做不了。
// B2：Composer 检视卡此前只说「项目简报已写 v4」，读内容/改内容都要去简报页签。

test("B1：检视数据带 revision 与 owner，派发按钮只给有主且未完工的任务", () => {
  const { wbNodeInspector } = testApi();
  const tasks = [
    { taskId: "t-1", subject: "在跑", ownerSessionId: "s-1", status: "in_progress", revision: 7 },
    { taskId: "t-2", subject: "待办", ownerSessionId: "s-1", status: "pending", revision: 3 },
    { taskId: "t-3", subject: "没人领", ownerSessionId: null, status: "pending", revision: 1 },
    { taskId: "t-4", subject: "已完工", ownerSessionId: "s-1", status: "completed", revision: 9 }
  ];
  const data = wbNodeInspector({ kind: "agent", sessionId: "s-1" }, { tasks, sessions: [] });
  const byId = {};
  data.tasks.forEach((r) => { byId[r.taskId] = r; });
  assert.equal(byId["t-1"].revision, 7, "派发要带 CAS，revision 必须下发");
  assert.equal(byId["t-1"].ownerSessionId, "s-1");
  // 组件侧的 dispatchable 判据靠这两个字段，缺一个就点不了
  assert.ok(byId["t-1"].status === "in_progress" && typeof byId["t-1"].ownerSessionId === "string", "在跑 + 有主 → 可派发");
  // t-3 没主，根本不该出现在这个 Agent 的列表里（见下一条：无主任务只在落点卡出现）
  assert.equal(byId["t-3"], undefined, "没主的任务不进 Agent 卡");
  assert.equal(data.tasks.length, 2, "Agent 卡只列它自己负责的任务，没主人的不进");
});

test("B1：落点节点的任务可能没主，这种不给派发按钮", () => {
  const { wbNodeInspector } = testApi();
  const tasks = [
    { taskId: "t-1", subject: "有主", ownerSessionId: "s-1", status: "pending", revision: 2 },
    { taskId: "t-2", subject: "没主", ownerSessionId: null, status: "pending", revision: 1 }
  ];
  const data = wbNodeInspector({ kind: "folder", title: "/repo", tasks: tasks }, { tasks, sessions: [] });
  const byId = {};
  data.tasks.forEach((r) => { byId[r.taskId] = r; });
  assert.equal(data.tasks.length, 2, "落点卡按落点列任务，不管有没有主");
  assert.equal(byId["t-1"].ownerSessionId, "s-1");
  assert.equal(byId["t-2"].ownerSessionId, null, "没主的也要显示（不然用户不知道有这个任务），但不该有派发按钮");
});

test("B2：Composer 检视带目标文本与版本号（供卡内编辑与 CAS）", () => {
  const { wbNodeInspector } = testApi();
  const withGoal = wbNodeInspector({ kind: "composer", title: "C" }, { project: { brief: { version: 4, goal: "把节点图画布做出来" } } });
  assert.equal(withGoal.goal, "把节点图画布做出来", "目标文本要下发，否则卡内编辑器是空的");
  assert.equal(withGoal.briefVersion, 4, "PUT 要带 expectedVersion，版本号必须下发");
  const noBrief = wbNodeInspector({ kind: "composer", title: "C" }, {});
  assert.equal(noBrief.goal, "", "没写目标就是空串，不编造");
  assert.equal(noBrief.briefVersion, 1);
});

test("B1/B2：源码契约——派发走宿主命令路由，目标走 brief CAS", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(source.indexOf('wbTaskCommand(projectId, taskId, "dispatch", { expectedRevision: revision })') >= 0, "派发必须走宿主既有命令路由并带 CAS");
  assert.ok(source.indexOf('body: { expectedVersion: briefVersionOf(data), goal: goalDraft }') >= 0, "改目标必须带 expectedVersion");
  for (const key of ["inspect.dispatch", "inspect.goal.edit", "inspect.goal.placeholder"]) {
    assert.ok(source.indexOf(key) >= 0, key + " 文案键必须存在");
  }
  const { WB_TEXT } = testApi();
  for (const key of ["inspect.dispatch", "inspect.goal.edit", "inspect.goal.placeholder"]) {
    assert.ok(WB_TEXT.zh[key].length > 0 && WB_TEXT.en[key].length > 0, key + " 中英都要有");
  }
});


// ── 19. Agent 分段生长进度（参考图 V2 + CDS ApprovalFlow 等宽分段口径）──────

test("wbAgentSteps：六步派生——提案来源全 done、手动创建前三步 skipped", () => {
  const { wbAgentSteps } = testApi();
  const keys = wbAgentSteps({}).map((s) => s.key);
  assert.deepEqual(keys, ["source", "trigger", "policy", "ticket", "worker", "report"], "六步固定（T-13 同款）");

  // 提案来的任务：前三步 done，ticket done，worker 有主且在跑 = active，没有 report = pending
  const proposed = wbAgentSteps({
    sourceProposal: { proposalId: "prop-1", version: 2, key: "T1" },
    ownerSessionId: "s1",
    status: "in_progress",
    report: null
  });
  assert.deepEqual(proposed.map((s) => s.state), ["done", "done", "done", "done", "active", "pending"]);

  // 手动创建：前三步 skipped（不是 pending——「不适用」与「还没到」是两件事）
  const manual = wbAgentSteps({ ownerSessionId: null, status: "pending", report: null });
  assert.deepEqual(manual.map((s) => s.state), ["skipped", "skipped", "skipped", "done", "pending", "pending"]);

  // report 四态：done = 回流关闭；draft/handed_back/human_action 都算 active（还在回流里）
  for (const status of ["done"]) {
    assert.equal(wbAgentSteps({ ownerSessionId: "s1", report: { status } })[5].state, "done");
  }
  for (const status of ["draft", "handed_back", "human_action"]) {
    assert.equal(wbAgentSteps({ ownerSessionId: "s1", report: { status } })[5].state, "active", status + " 也算 active");
  }
  // 有主但没在跑（已派完待命）→ worker = done
  assert.equal(wbAgentSteps({ ownerSessionId: "s1", status: "pending" })[4].state, "done");
  // 坏数据不炸
  assert.equal(wbAgentSteps(undefined).length, 6);
  assert.equal(wbAgentSteps({ report: "脏" }).length, 6);
});

test("wbGrowthLabel：可读名报 done/total（纯图形必须有文字复述）", () => {
  const { wbAgentSteps, wbGrowthLabel, WB_TEXT } = testApi();
  const steps = wbAgentSteps({ sourceProposal: { proposalId: "p" }, ownerSessionId: "s1", status: "in_progress", report: { status: "done" } });
  const t = (key, vars) => {
    const raw = WB_TEXT.zh[key];
    if (raw === undefined) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
  assert.equal(wbGrowthLabel(steps, t), "任务进度：共 6 步，已完成 5 步", "worker 步在跑 = active，不算 done");
  // 手动创建且没报告：前三步 skipped，ticket + worker 两步 done，report pending → done = 2
  assert.equal(wbGrowthLabel(wbAgentSteps({ ownerSessionId: "s1", status: "completed" }), t), "任务进度：共 6 步，已完成 2 步");
  // 完全空的任务：manual 前三步 skipped + ticket done，其余 pending → done = 1
  assert.equal(wbGrowthLabel(wbAgentSteps({}), t), "任务进度：共 6 步，已完成 1 步", "只有 ticket 一步恒 done");
  // 没有 t 时退回内置中文句式（不返回 undefined）
  assert.ok(wbGrowthLabel(steps).indexOf("共 6 步") >= 0);
  assert.equal(wbGrowthLabel(undefined), "共 0 步，已完成 0 步", "空 steps 也不能炸");
  assert.equal(wbGrowthLabel(null), "共 0 步，已完成 0 步");
});

test("渲染：Agent 卡上真出现 6 个等宽分段，aria-label 与数据一致", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = flowLoadPlugin(shim);
  installDocumentStub();
  const api = loaded.plugin.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    if (target === "/projects") return ok([{ projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1", role: "member" }], links: [], brief: { goal: "g" } }]);
    if (target === "/projects/p1") return ok({ project: { projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1", role: "member" }], links: [], brief: { goal: "g" } } });
    if (target === "/projects/p1/brief") return ok({ brief: { version: 1, goal: "g", decisions: [], constraints: [] } });
    if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [{ sessionId: "s1" }], mainSessionId: "main" });
    if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [
      { taskId: "t-1", subject: "接画布", status: "in_progress", ownerSessionId: "s1", worktree: "/d/repo", revision: 3, sourceProposal: { proposalId: "prop-1", version: 1, key: "T1" }, report: { status: "draft", summary: "s", rev: 2, at: 1 } }
    ] });
    if (target === "/sessions") return ok({ source: "host", sessions: [{ sessionId: "s1", title: "Agent 甲", running: true }] });
    if (target === "/activity") return ok({ at: Date.now(), active: {} });
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: [] });
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: [] });
    return ok({});
  };
  try {
    const urls = ["/projects", "/projects/p1", "/projects/p1/brief", "/projects/p1/mcp-links", "/tasks?projectId=p1", "/sessions", "/activity", "/canvas?projectId=p1", "/inbox?projectId=p1", "/handoffs?projectId=p1"];
    for (const url of urls) await api.wbCache.read(url).catch(() => {});
    const t = (key, vars) => {
      const raw = api.WB_TEXT.zh[key];
      if (raw === undefined) return "«" + key + "»";
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
    };
    const view = await flowMount(mount, api, { t: t, projectId: "p1" }, loaded);
    const segs = [];
    const collect = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "string" && node.props && typeof node.props.className === "string" && node.props.className.split(" ").indexOf("daw-wb-growth-seg") >= 0) segs.push(node);
      collect(node.props ? node.props.children : undefined);
    };
    collect(view.tree);
    assert.equal(segs.length, 6, "Agent 卡必须渲染 6 个等宽分段");
    const states = segs.map((s) => s.props["data-state"]);
    assert.deepEqual(states, ["done", "done", "done", "done", "active", "active"], "提案来源 + 在跑 + draft");
    const bars = [];
    const collectBars = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collectBars); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "string" && node.props && node.props.role === "img" && typeof node.props.className === "string" && node.props.className.indexOf("daw-wb-growth") >= 0) bars.push(node);
      collectBars(node.props ? node.props.children : undefined);
    };
    collectBars(view.tree);
    assert.equal(bars.length, 1, "分段条必须 role=img（纯图形的文字复述）");
    assert.ok(bars[0].props["aria-label"].indexOf("共 6 步") >= 0, "aria-label 要说清 done/total");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    api.wbCache.reset();
  }
});


// ── 20. Thread 回合记录节点（参考图 V2 顶部；全部来自已有事实） ─────────────

// ── 21. 借鉴 troupe：证据优先的 Agent 态 + 产物越界（outside） ──────────────

test("wbAgentChip：有 report 就按 report 显示，没有才看在线（证据压过观感）", () => {
  const { wbAgentChip } = testApi();
  // troupe roleState 的第一条：写过 done 的就是 done，哪怕它还挂在提示符上
  assert.deepEqual(wbAgentChip({ report: { status: "done" } }, true), { tone: "ok", key: "done" });
  assert.deepEqual(wbAgentChip({ report: { status: "done" } }, false), { tone: "ok", key: "done" }, "不在线也是 done——证据说话");
  assert.deepEqual(wbAgentChip({ report: { status: "handed_back" } }, true), { tone: "warn", key: "handed_back" });
  assert.deepEqual(wbAgentChip({ report: { status: "human_action" } }, true), { tone: "danger", key: "human_action" });
  assert.deepEqual(wbAgentChip({ report: { status: "draft" } }, true), { tone: "brand", key: "draft" });
  // 没有 report 才看观感
  assert.deepEqual(wbAgentChip({}, true), { tone: "ok", key: "online" });
  assert.deepEqual(wbAgentChip({}, false), { tone: "neutral", key: "idle" });
  assert.deepEqual(wbAgentChip(undefined, false), { tone: "neutral", key: "idle" });
  assert.deepEqual(wbAgentChip({ report: "脏" }, true), { tone: "ok", key: "online" }, "坏 report 当没有");
});

test("wbArtifactsOutside：产物里越界的那几个（troupe outside 的声明面版本）", () => {
  const { wbArtifactsOutside } = testApi();
  // 声明 lib/，产物全在里面 → 没有越界
  assert.deepEqual(wbArtifactsOutside({ writeScopes: ["lib/"], report: { artifacts: [{ ref: "lib/a.js" }, { ref: "lib/x/b.js" }] } }), { total: 2, outside: [] });
  // 一个在声明外
  const one = wbArtifactsOutside({ writeScopes: ["lib/"], report: { artifacts: [{ ref: "lib/a.js" }, { ref: "docs/readme.md" }] } });
  assert.equal(one.total, 2);
  assert.deepEqual(one.outside, ["docs/readme.md"]);
  // 没有声明范围 → 不判断（「没声明」不是越界证据）
  assert.deepEqual(wbArtifactsOutside({ writeScopes: [], report: { artifacts: [{ ref: "anywhere" }] } }), { total: 1, outside: [] });
  assert.deepEqual(wbArtifactsOutside({ report: null }), { total: 0, outside: [] });
  // 坏数据不抛
  assert.deepEqual(wbArtifactsOutside(undefined), { total: 0, outside: [] });
  assert.deepEqual(wbArtifactsOutside({ writeScopes: "x", report: { artifacts: "y" } }), { total: 0, outside: [] });
  // 字符串产物也认（旧数据）
  assert.deepEqual(wbArtifactsOutside({ writeScopes: ["lib/"], report: { artifacts: ["docs/x.md"] } }).outside, ["docs/x.md"]);
});

test("wbScopeOverlaps：与宿主 writeScopeWarnings 同口径（含前缀）", () => {
  const { wbScopeOverlaps } = testApi();
  assert.equal(wbScopeOverlaps("lib/", "lib/"), true, "完全相同");
  assert.equal(wbScopeOverlaps("lib/index.js", "lib/"), true, "文件在目录范围里");
  assert.equal(wbScopeOverlaps("lib/", "lib/index.js"), true, "反向也算");
  assert.equal(wbScopeOverlaps("lib/", "docs/"), false, "不相干");
  assert.equal(wbScopeOverlaps("", "lib/"), false, "空范围不命中任何东西");
  assert.equal(wbScopeOverlaps(undefined, undefined), false);
});


test("渲染：report 弹窗在产物越界时给出提示（troupe outside 的落地）", async () => {
  const { shim, mount } = createMount();
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const api = loaded.plugin.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    return ok({});
  };
  const t = (key, vars) => {
    const raw = api.WB_TEXT.zh[key];
    if (raw === undefined) return "«" + key + "»";
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
  try {
    // 有声明范围 + 产物越界 → 必须出现提示，并列出越界产物
    const outside = api.wbArtifactsOutside({ writeScopes: ["lib/"], report: { artifacts: [{ ref: "lib/a.js" }, { ref: "docs/readme.md" }] } });
    assert.equal(outside.outside.length, 1, "前置：越界产物 1 个");
    const banner = t("tasks.report.outside", { count: 1, total: 2, refs: "docs/readme.md" });
    assert.ok(banner.indexOf("docs/readme.md") >= 0, "提示必须点名越界产物：" + banner);
    // 全部在范围内 → 不提示（不制造噪音）
    assert.equal(api.wbArtifactsOutside({ writeScopes: ["lib/"], report: { artifacts: [{ ref: "lib/a.js" }] } }).outside.length, 0);
    // 没有声明范围 → 不提示
    assert.equal(api.wbArtifactsOutside({ writeScopes: [], report: { artifacts: [{ ref: "x" }] } }).outside.length, 0);
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});


// ── 22. 借鉴 oh-my-hermes：依赖连线带理由 + 证据分级措辞 ───────────────────

test("wbDepLinks：blockedBy 派生依赖线，两端有 owner 才画，同对去重", () => {
  const { wbDepLinks } = testApi();
  const tasks = [
    { taskId: "t1", ownerSessionId: "s1", blockedBy: [] },
    { taskId: "t2", ownerSessionId: "s2", blockedBy: ["t1"] },
    { taskId: "t3", ownerSessionId: "s3", blockedBy: ["t1", "t2"] },
    { taskId: "t4", blockedBy: ["t1"] } // 没 owner：等待方不在画布上，不画
  ];
  const edges = wbDepLinks(tasks);
  assert.deepEqual(edges.map((e) => e.a + ">" + e.b), ["s1>s2", "s1>s3", "s2>s3"], "只画两端都有 owner 的");
  assert.equal(edges[0].reason, "blocked");
  assert.equal(edges[0].waitTaskId, "t1", "带着阻塞方的 taskId（边上要写「等待 t1」）");
  // 同一对会话只留一条
  const dup = wbDepLinks([
    { taskId: "a1", ownerSessionId: "s1", blockedBy: [] },
    { taskId: "a2", ownerSessionId: "s2", blockedBy: ["a1"] },
    { taskId: "b1", ownerSessionId: "s1", blockedBy: [] },
    { taskId: "b2", ownerSessionId: "s2", blockedBy: ["b1"] }
  ]);
  assert.equal(dup.length, 1, "s1→s2 一对只画一根线");
  // 自己等自己（同一 owner 的两条任务）不画
  assert.deepEqual(wbDepLinks([{ taskId: "x1", ownerSessionId: "s1" }, { taskId: "x2", ownerSessionId: "s1", blockedBy: ["x1"] }]), []);
  // 阻塞方不存在 / 阻塞方没 owner → 不画
  assert.deepEqual(wbDepLinks([{ taskId: "y", ownerSessionId: "s1", blockedBy: ["不存在"] }]), []);
  assert.deepEqual(wbDepLinks([{ taskId: "z1", blockedBy: [] }, { taskId: "z2", ownerSessionId: "s1", blockedBy: ["z1"] }]), []);
  // 坏数据不炸
  assert.deepEqual(wbDepLinks(undefined), []);
  assert.deepEqual(wbDepLinks("x"), []);
  assert.deepEqual(wbDepLinks([null, { taskId: "q", blockedBy: "不是数组" }]), []);
});

test("渲染：画布上的依赖连线带「等待 <task>」文字，且 Agent 卡说「已报完工」", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = flowLoadPlugin(shim);
  installDocumentStub();
  const api = loaded.plugin.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    if (target === "/projects") return ok([{ projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1" }, { sessionId: "s2" }], links: [], brief: { goal: "g" } }]);
    if (target === "/projects/p1") return ok({ project: { projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1" }, { sessionId: "s2" }], links: [], brief: { goal: "g" } } });
    if (target === "/projects/p1/brief") return ok({ brief: { version: 1, goal: "g", decisions: [], constraints: [] } });
    if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [{ sessionId: "s1" }, { sessionId: "s2" }], mainSessionId: "main" });
    if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [
      { taskId: "t1", subject: "先做这个", status: "in_progress", ownerSessionId: "s1", revision: 1, createdAt: 1 },
      { taskId: "t2", subject: "等 t1", status: "pending", ownerSessionId: "s2", revision: 1, createdAt: 2, blockedBy: ["t1"] }
    ] });
    if (target === "/sessions") return ok({ source: "host", sessions: [{ sessionId: "s1", title: "甲", running: true }, { sessionId: "s2", title: "乙", running: true }] });
    if (target === "/activity") return ok({ at: Date.now(), active: {} });
    if (target.startsWith("/events")) return ok({ events: [], stats: {}, health: [] });
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: [] });
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: [] });
    return ok({});
  };
  try {
    const urls = ["/projects", "/projects/p1", "/projects/p1/brief", "/projects/p1/mcp-links", "/tasks?projectId=p1", "/sessions", "/activity", "/canvas?projectId=p1", "/events?projectId=p1", "/inbox?projectId=p1", "/handoffs?projectId=p1"];
    for (const url of urls) await api.wbCache.read(url).catch(() => {});
    const t = (key, vars) => {
      const raw = api.WB_TEXT.zh[key];
      if (raw === undefined) return "«" + key + "»";
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
    };
    const view = await flowMount(mount, api, { t: t, projectId: "p1" }, loaded);
    // 1) 依赖连线的边上有「等待 t1」文字（新画布：边规格的 label）
    const depEdges = view.flow().edges.filter((edge) => String(edge.className || "").indexOf("daw-wb-edge-dependency") >= 0);
    assert.equal(depEdges.length, 1, "只有一条依赖边（t2 等 t1）");
    assert.equal(depEdges[0].label, "等待 t1", "依赖边上必须标注「等待 t1」，实际：" + depEdges[0].label);
    // 2) 有 report 的 Agent 卡说「已报完工」而不是「已完工」（证据分级）
    assert.equal(api.WB_TEXT.zh["canvas.agent.chip.done"], "已报完工", "done 只能说「已报」，不能说「已」");
    const chip = api.wbAgentChip({ report: { status: "done" } }, true);
    assert.equal(chip.key, "done");
    assert.ok(api.WB_TEXT.zh["canvas.agent.chip.done.title"].indexOf("没有人核对") >= 0 || api.WB_TEXT.zh["canvas.agent.chip.done.title"].length > 0, "必须有 title 说明没人核");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    api.wbCache.reset();
  }
});


// ── 23. Q1 Composer 轻量版 / Q3 已核对 / Q4 规划时提示 ───────────────────

test("wbComposerPrefix：只引用身份，不带指令；两者都没有就空前缀", () => {
  const { wbComposerPrefix } = testApi();
  // 有提案 → 引提案身份
  assert.equal(wbComposerPrefix({ sourceProposal: { proposalId: "prop-1", version: 3 } }), "[提案 v3 prop-1] ");
  // 版本脏数据取整到 1
  assert.equal(wbComposerPrefix({ sourceProposal: { proposalId: "p", version: -5 } }), "[提案 v1 p] ");
  assert.equal(wbComposerPrefix({ sourceProposal: { proposalId: "p", version: 2.7 } }), "[提案 v2 p] ");
  // 没有提案 → 引任务身份
  assert.equal(wbComposerPrefix({ taskId: "ptask-1", subject: "体检宿主" }), "[任务 ptask-1 · 体检宿主] ");
  assert.equal(wbComposerPrefix({ taskId: "ptask-1", subject: "" }), "[任务 ptask-1] ", "没有主题就不补分隔符");
  // 两者都没有 → 空前缀（用户自己起头，不替他写）
  assert.equal(wbComposerPrefix({}), "");
  assert.equal(wbComposerPrefix(null), "");
  assert.equal(wbComposerPrefix({ sourceProposal: {} }), "");
  // 不注入 t 时退回内置句式
  assert.ok(wbComposerPrefix({ taskId: "t" }).indexOf("[任务 t") === 0);
});

test("wbVerifiedView / wbReviewSignal：人工核对与评审次信号分开", () => {
  const { wbVerifiedView, wbReviewSignal } = testApi();
  // 没有核对字段 → false，不编
  assert.deepEqual(wbVerifiedView({}), { verified: false, by: "", at: 0, note: "" });
  assert.deepEqual(wbVerifiedView(null), { verified: false, by: "", at: 0, note: "" });
  assert.deepEqual(wbVerifiedView({ verified: "脏" }), { verified: false, by: "", at: 0, note: "" });
  // 有 → 原样带出
  assert.deepEqual(wbVerifiedView({ verified: { by: "session-main", at: 123, note: "看过" } }), { verified: true, by: "session-main", at: 123, note: "看过" });

  // 评审次信号：以本任务为前置、且 report=done 的评审任务
  const tasks = [
    { taskId: "t1", report: { status: "done", at: 100 } },
    { taskId: "t2", blockedBy: ["t1"], report: { status: "done", at: 200 } },
    { taskId: "t3", blockedBy: ["t1"], report: { status: "draft", at: 300 } },
    { taskId: "t4", blockedBy: ["t9"] }
  ];
  assert.deepEqual(wbReviewSignal(tasks[0], tasks), { reviewed: true, byTaskId: "t2", at: 200 }, "只认已报完工的评审任务，取最新");
  assert.deepEqual(wbReviewSignal(tasks[3], tasks), { reviewed: false, byTaskId: "", at: 0 }, "没人评审 → false");
  assert.deepEqual(wbReviewSignal(undefined, tasks), { reviewed: false, byTaskId: "", at: 0 });
  assert.deepEqual(wbReviewSignal(tasks[0], undefined), { reviewed: false, byTaskId: "", at: 0 });
});

test("wbAgentChip：已核对压过已报完工（证据优先）", () => {
  const { wbAgentChip } = testApi();
  assert.deepEqual(wbAgentChip({ verified: { by: "session-main", at: 1 } }, false), { tone: "ok", key: "verified" }, "不在线也是已核对");
  assert.deepEqual(wbAgentChip({ report: { status: "done" }, verified: null }, true), { tone: "ok", key: "done" });
  // 没有核对才看 report
  assert.deepEqual(wbAgentChip({ report: { status: "handed_back" } }, true), { tone: "warn", key: "handed_back" });
});


// ── 24. useWb 的 subscribe 稳定性（真浏览器死循环回归） ───────────────────

test("useWb：subscribe 按 url 稳定，store 通知后自动重画", async () => {
  // 2026-11-16 真浏览器实测：页面 load 永不触发、主线程被占满、且没有任何报错。
  // 成因是 useWb 每次渲染都传新的 inline subscribe → React「退订→重订阅」→
  // wbCache 重订阅再触发一次 load → 同步 publish → 重渲染 → 又换新 subscribe……
  // 只有一个订阅者的 URL（如 /canvas）上永停。旧垫片忽略 subscribe，结构上抓不到，
  // 所以这条同时守产品代码与垫片忠实度。
  const { shim, mount } = createMount();
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const api = loaded.plugin.__test;
  loaded.win.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    if (target === "/projects") return ok([{ projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1" }], links: [], brief: { goal: "g" } }]);
    if (target === "/projects/p1") return ok({ project: { projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "s1" }], links: [], brief: { goal: "g" } } });
    if (target === "/projects/p1/brief") return ok({ brief: { version: 1, goal: "g", decisions: [], constraints: [] } });
    if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [{ sessionId: "s1" }], mainSessionId: "main" });
    if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [
      { taskId: "t-1", subject: "接画布", status: "in_progress", ownerSessionId: "s1", worktree: "/d/repo", revision: 3, createdAt: 1 }
    ] });
    if (target === "/sessions") return ok({ source: "host", sessions: [{ sessionId: "s1", title: "甲", running: true }] });
    if (target === "/activity") return ok({ at: Date.now(), active: {} });
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: {} });
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: [] });
    if (target.startsWith("/events")) return ok({ events: [], stats: {}, health: [] });
    return ok({});
  };
  const t = (key, vars) => {
    const raw = api.WB_TEXT.zh[key];
    if (raw === undefined) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
  try {
    // 订阅计数：subscribe 被调多少次，直接反映「有没有在重订阅」
    let subscribes = 0;
    const realSubscribe = api.wbCache.subscribe;
    api.wbCache.subscribe = function (url, listener) {
      subscribes += 1;
      return realSubscribe.call(api.wbCache, url, listener);
    };
    // 用任务页：它的 /tasks?projectId= 只有一个订阅者，正是真浏览器里转不动的那个 URL。
    // （画布页在垫片里复现不出这个环——实测过，别换回去。）
    const view = mount(api.WbTasksPage, { t: t, projectId: "p1" });
    const afterMount = subscribes;
    // 让事件循环转一圈：store 通知（promise 回调）→ 垫片自动重画
    await new Promise((resolve) => setImmediate(resolve));
    view.rerender();
    await new Promise((resolve) => setImmediate(resolve));
    // 收敛判据：两个相邻 tick 之间订阅次数不再涨。
    // （树形变化会让路径移位 → 旧格子孤儿化并重新订阅，这是垫片按路径定位的已知代价；
    //   真 React 按 fiber 位置协调不会这样。要守的是「不停下来」——那才是真浏览器里的死循环。）
    const settled = subscribes;
    await new Promise((resolve) => setImmediate(resolve));
    view.rerender();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subscribes, settled,
      "稳定后订阅次数必须收敛（" + afterMount + " → " + settled + " → " + subscribes + "）；一直涨就是真浏览器里那种重订阅成环");
    assert.ok(subscribes < 40, "订阅次数必须有界（" + subscribes + "），死循环会是几百上千");

    // 关键判据：**单纯重渲染不该引起重订阅**。inline subscribe 每次渲染都是新引用，
    // React 于是「退订→重订阅」，而 wbCache 的重订阅会再 load 一次（同步 publish）——
    // 真浏览器里这条链会自己喂自己，直到主线程被占满（页面 load 永不触发、且无任何报错）。
    // 垫片的渲染环是同步的、microtask 进不来，所以复现不了那个环；但「重渲染 → 重订阅」
    // 这一步是同步的、测得到，正是环的第一环。
    const beforeRerender = subscribes;
    for (let i = 0; i < 4; i += 1) {
      view.rerender();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(subscribes, beforeRerender,
      "rerender 不该引起重订阅（" + beforeRerender + " → " + subscribes + "）；inline subscribe 就是这样把环转起来的");
    // 自动重画真的发生了：任务表把数据渲染出来了（loading 态下它是空的）
    const rows = [];
    const collect = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "string" && node.props && typeof node.props.className === "string" && node.props.className.split(" ").indexOf("daw-wb-tr") >= 0) rows.push(node);
      collect(node.props ? node.props.children : undefined);
    };
    collect(view.tree);
    assert.ok(rows.length >= 1, "数据回来后要能自动重画出任务行（现在 " + rows.length + " 行）");
  } finally {
    api.wbCache.reset();
  }
});


// ── 25. 空态引导：新建任务在画布内开弹窗，不崩、不跳走 ───────────────────

test("空态引导：点「新建任务」弹画布内模态，取消关得掉，页面不崩", async () => {
  // 2026-11-16 真机实测：点「+ 新建任务」→ ReferenceError: views is not defined
  // → 「slot entry crashed in 'main'」→ 整个工作台白屏（页签全没、节点全没）。
  // 离线没抓到是因为空 tasks 时那个分支根本不渲染，变量错误要到点下去才暴露。
  const { shim, mount } = createMount({ effects: true });
  const loaded = flowLoadPlugin(shim);
  installDocumentStub();
  const api = loaded.plugin.__test;
  loaded.win.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    if (target === "/projects") return ok([{ projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "main" }], links: [], brief: { goal: "g" } }]);
    if (target === "/projects/p1") return ok({ project: { projectId: "p1", name: "画布", mainSessionId: "main", members: [{ sessionId: "main" }], links: [], brief: { goal: "g" } } });
    if (target === "/projects/p1/brief") return ok({ brief: { version: 1, goal: "g", decisions: [], constraints: [] } });
    if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [{ sessionId: "main" }], mainSessionId: "main" });
    if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [] });
    if (target === "/sessions") return ok({ source: "host", sessions: [{ sessionId: "main", title: "主对话", running: true }] });
    if (target === "/activity") return ok({ at: Date.now(), active: {} });
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: {} });
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: [] });
    if (target.startsWith("/events")) return ok({ events: [], stats: {}, health: [] });
    if (target === "/tasks") return ok({ source: "project", tasks: [] });
    return ok({});
  };
  const t = (key, vars) => {
    const raw = api.WB_TEXT.zh[key];
    if (raw === undefined) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
  try {
    const urls = ["/projects", "/projects/p1", "/projects/p1/brief", "/projects/p1/mcp-links", "/tasks?projectId=p1", "/sessions", "/activity", "/canvas?projectId=p1", "/inbox?projectId=p1", "/handoffs?projectId=p1", "/events?projectId=p1"];
    for (const url of urls) await api.wbCache.read(url).catch(() => {});
    const view = await flowMount(mount, api, { t: t, projectId: "p1" }, loaded);
    await new Promise((resolve) => setImmediate(resolve));
    view.rerender();

    const buttons = [];
    const collect = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (typeof node !== "object") return;
      if (node.type === "button") buttons.push(node);
      collect(node.props ? node.props.children : undefined);
    };
    const textsOf = (node) => {
      const out = [];
      const walk = (n) => {
        if (n === null || n === undefined || typeof n === "boolean") return;
        if (typeof n === "string") { out.push(n); return; }
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (typeof n !== "object") return;
        walk(n.props ? n.props.children : undefined);
      };
      walk(node);
      return out.join("");
    };
    collect(view.tree);
    // 引导节点 = data-kind="guide" 的 .daw-wb-node。（以前这里靠「没有 data-kind」来认，是因为旧代码把 data-kind 误写进了 style 对象里；
    // 现在引导卡的 data-kind 是真属性，MCP 引导卡已随 MCP 节点一起删除，所以全画布只剩这一张。）
    const guides = [];
    const collectGuides = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collectGuides); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "string" && node.props && typeof node.props.className === "string"
        && node.props.className.split(" ").indexOf("daw-wb-node") >= 0 && node.props["data-kind"] === "guide") guides.push(node);
      collectGuides(node.props ? node.props.children : undefined);
    };
    collectGuides(view.tree);
    assert.equal(guides.length, 1, "空画布要有引导节点");

    const newTask = buttons.filter((b) => textsOf(b).indexOf("新建任务") >= 0)[0];
    assert.ok(newTask, "引导节点要有「新建任务」按钮");
    // 关键：点了不能抛（抛了就是整个 main 槽位崩掉）
    assert.doesNotThrow(() => { newTask.props.onClick({ stopPropagation() {} }); view.rerender(); }, "点新建任务不能抛");
    const modals = [];
    const collectModals = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collectModals); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "string" && node.props && typeof node.props.className === "string"
        && node.props.className.split(" ").indexOf("daw-wb-modal") >= 0) modals.push(node);
      collectModals(node.props ? node.props.children : undefined);
    };
    collectModals(view.tree);
    assert.equal(modals.length, 1, "必须弹出画布内的新建任务模态（不是切页签）");
    // 页面没崩：节点还在
    const nodes = [];
    const collectNodes = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collectNodes); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "string" && node.props && typeof node.props.className === "string"
        && node.props.className.split(" ").indexOf("daw-wb-node") >= 0) nodes.push(node);
      collectNodes(node.props ? node.props.children : undefined);
    };
    collectNodes(view.tree);
    assert.ok(nodes.length >= 3, "弹窗开着的时候画布节点也还在（" + nodes.length + " 个）——崩了就会全没");
    // 取消关得掉（按钮要重新收集：上面的 buttons 是点之前的快照，弹窗里的不在里面）
    const modalButtons = [];
    const collectInto = (node, sink) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach((n) => collectInto(n, sink)); return; }
      if (typeof node !== "object") return;
      if (node.type === "button") sink.push(node);
      collectInto(node.props ? node.props.children : undefined, sink);
    };
    collectInto(modals[0], modalButtons);
    const cancel = modalButtons.filter((b) => textsOf(b) === "取消")[0];
    assert.ok(cancel, "模态里要有取消");
    cancel.props.onClick({ stopPropagation() {} });
    view.rerender();
    modals.length = 0;
    collectModals(view.tree);
    assert.equal(modals.length, 0, "取消要能关掉");
  } finally {
    api.wbCache.reset();
  }
});


// ── 26. 项目没了别只剩死路：面包屑 + 错误态都能回项目列表 ─────────────────

test("项目 404：顶栏面包屑可点回列表，错误态也有「回项目列表」出口", async () => {
  // 真机 2026-11-16：localStorage 里记的上次视图指向一个已不存在的项目时，
  // 画布/任务/简报/执行全部显示「读不到数据 · project not found + 重试」，
  // 而所有页签都是项目作用域——用户只剩「一键回退」去官方 Chat 一条路。
  const { shim, mount } = createMount();
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const api = loaded.plugin.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const ok = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    if (target === "/projects") return ok({ projects: [] });
    // 项目详情 404：正是死路场景
    if (target === "/projects/ghost") return Promise.resolve({ ok: false, status: 200, json: () => Promise.resolve({ code: 40401, msg: "project not found" }) });
    if (target === "/projects/ghost/brief") return Promise.resolve({ code: 40401, msg: "project not found" });
    if (target === "/projects/ghost/mcp-links") return Promise.resolve({ code: 40401, msg: "project not found" });
    if (target.startsWith("/tasks?projectId=")) return Promise.resolve({ code: 40401, msg: "project not found" });
    if (target === "/sessions") return ok({ sessions: [] });
    if (target === "/activity") return ok({ at: Date.now(), active: {} });
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: {} });
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: [] });
    if (target.startsWith("/events")) return ok({ events: [], stats: {}, health: [] });
    return ok({});
  };
  const t = (key, vars) => {
    const raw = api.WB_TEXT.zh[key];
    if (raw === undefined) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
  try {
    for (const url of ["/projects", "/projects/ghost", "/sessions", "/activity"]) await api.wbCache.read(url).catch(() => {});
    api.wbRoute.set({ kind: "workbench", projectId: "ghost", tab: "canvas" });
    const view = mount(api.WhaleWorkbench, {
      t: t,
      useSessions: (selector) => selector({ byId: {} }),
      focusSession: () => true
    });
    await new Promise((resolve) => setImmediate(resolve));
    view.rerender();
    await new Promise((resolve) => setImmediate(resolve));
    view.rerender();

    const buttons = [];
    const walkText = (n, out) => {
      if (n === null || n === undefined || typeof n === "boolean") return;
      if (typeof n === "string") { out.push(n); return; }
      if (Array.isArray(n)) { n.forEach((x) => walkText(x, out)); return; }
      if (typeof n !== "object") return;
      walkText(n.props ? n.props.children : undefined, out);
    };
    const collectButtons = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collectButtons); return; }
      if (typeof node !== "object") return;
      if (node.type === "button") {
        const out = [];
        walkText(node, out);
        buttons.push({ text: out.join("").trim(), node: node });
      }
      collectButtons(node.props ? node.props.children : undefined);
    };
    collectButtons(view.tree);

    // 1) 顶栏面包屑的「项目」必须是可点的（class 标记），且点了回列表
    const crumb = buttons.filter((b) => b.node.props && b.node.props.className === "daw-wb-crumb-link");
    assert.equal(crumb.length, 1, "顶栏要有可点的面包屑「项目」");
    assert.equal(api.wbRoute.get().kind, "workbench", "前置：当前在工作台里");
    crumb[0].node.props.onClick({ stopPropagation() {} });
    assert.equal(api.wbRoute.get().kind, "list", "点面包屑必须回到项目列表");

    // 2) 错误态也要有出口（回到工作台再找）
    api.wbRoute.set({ kind: "workbench", projectId: "ghost", tab: "canvas" });
    view.rerender();
    await new Promise((resolve) => setImmediate(resolve));
    view.rerender();
    const exits = [];
    const collectExits = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collectExits); return; }
      if (typeof node !== "object") return;
      if (node.type === "button") {
        const out = [];
        walkText(node, out);
        if (out.join("").trim() === "回项目列表") exits.push(node);
      }
      collectExits(node.props ? node.props.children : undefined);
    };
    collectExits(view.tree);
    assert.ok(exits.length >= 1, "项目级失败的错误态要有「回项目列表」按钮");
    exits[0].props.onClick({ stopPropagation() {} });
    assert.equal(api.wbRoute.get().kind, "list", "点错误态出口也要回到项目列表");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    api.wbCache.reset();
  }
});
