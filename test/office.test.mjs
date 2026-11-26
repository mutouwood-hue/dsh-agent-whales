/** 办公室工位、任务状态和场景的渲染契约。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

function collect(node, out, match) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) { node.forEach((item) => collect(item, out, match)); return; }
  if (typeof node !== "object") return;
  if (node.props && match(node)) out.push(node);
  collect(node.props ? node.props.children : undefined, out, match);
}
function find(tree, match) { const out = []; collect(tree, out, match); return out; }
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
const KEY = (key, vars) => "[" + key + (vars ? " " + JSON.stringify(vars) : "") + "]";
const ok = (data) => ({ code: 200, msg: "success", data });
const manifest = () => JSON.parse(readFileSync(new URL("../assets/office/manifest.json", import.meta.url), "utf8"));

function load() {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  return { t, mount };
}

function fakeHost({ project, sessions, active, state, tasks = [] }) {
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    let data = ok({});
    if (target === "/projects/p1") data = ok({ project });
    else if (target === "/sessions") data = ok({ sessions });
    else if (target === "/tasks?projectId=p1") data = ok({ tasks });
    // 真机的 /activity 是裸 JSON、没有 {code,msg,data} 信封；假宿主必须一样，否则测不出解包的 bug。
    else if (target === "/activity") data = { at: Date.now(), active: active || {}, state: state || {}, visitTools: true, ultra: false, controlToken: "t" };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  return { restore() { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}

const statusOf = (rows) => new Map(Object.entries(rows));

test("姿势优先级：离线 > 出错 > 等你 > 刚收工 > 思考 > 读 / 改 / 命令 > 在跑 > 空闲", () => {
  const { t } = load();
  const now = 1_000_000;
  const waiting = { kind: "approval" };
  const fresh = (extra) => Object.assign({ running: true }, extra);

  assert.equal(t.wbOfficePose({ offline: true, row: fresh({ lastErrorAt: now - 1000 }), pending: waiting, now }), "sleep", "离线压过一切");
  assert.equal(t.wbOfficePose({ row: fresh({ lastErrorAt: now - 1000 }), pending: waiting, now }), "oops", "刚出错压过等你");
  assert.equal(t.wbOfficePose({ row: fresh({ lastErrorAt: now - 9000 }), now }), "type", "错误过了 8 秒不再显示出错，回到在跑");
  assert.equal(t.wbOfficePose({ row: fresh(), pending: waiting, tool: "bash", now }), "wait", "卡在审批上的会话是在等人，不是在忙");
  assert.equal(t.wbOfficePose({ row: { lastTurnEndAt: now - 1000, lastRunMs: 20000 }, now }), "done", "刚跑完一轮：收工");
  assert.equal(t.wbOfficePose({ row: { lastTurnEndAt: now - 1000, lastRunMs: 1000 }, now }), "idle", "太短的一轮不庆祝");
  assert.equal(t.wbOfficePose({ row: fresh({ streaming: true }), tool: "edit", now }), "think", "模型在输出时是思考");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "read", now }), "read");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "grep", now }), "read");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "edit", now }), "type");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "pwsh", now }), "run");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "mcp__x__y", now }), "type", "MCP 工具名不猜，用最通用的打字");
  assert.equal(t.wbOfficePose({ row: fresh(), now }), "type", "在跑但没有工具信息");
  assert.equal(t.wbOfficePose({ row: { running: false }, tool: "read", now }), "idle", "没在跑就不看工具");
  assert.equal(t.wbOfficePose({ row: {}, pending: { kind: "something-new" }, now }), "idle", "未知 kind 不举手");
  assert.equal(t.wbOfficePose(undefined), "idle");
  assert.equal(t.wbOfficePose({}), "idle");
});

test("名牌取值：/sessions → 宿主会话表 → 登记的角色名；空串、纯空白、等于 id 的都不算", () => {
  const { t } = load();
  const id = "session-99f56a30-16f1-4237-b613-e52576912061";
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: "第二轮验证", storeTitle: "别的", memberTitle: "后端" }), { text: "第二轮验证", named: true });
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: "", storeTitle: "宿主侧栏里的名字", memberTitle: "后端" }), { text: "宿主侧栏里的名字", named: true });
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: id, storeTitle: id, memberTitle: "后端" }), { text: "后端", named: true }, "wbSessionRows 会把空标题填成 id，要当作没有");
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: "   ", memberTitle: "  前端  " }), { text: "前端", named: true }, "去首尾空白");
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: id }), { text: "", named: false });
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: 42, storeTitle: null, memberTitle: {} }), { text: "", named: false }, "脏值不当名字");
  assert.deepEqual(t.wbOfficeTitle(undefined), { text: "", named: false });
  assert.equal(t.wbOfficeShortId(id), "99f56a", "没名字时只给 6 位短后缀");
  assert.equal(t.wbOfficeShortId(undefined), "");
});

test("办公室日夜切换：自动使用本地时段，手动设置优先", () => {
  const { t } = load();
  assert.deepEqual([0, 6, 7, 12, 18, 19, 23].map((hour) => t.wbOfficeSceneAt("auto", hour)), ["night", "night", "day", "day", "day", "night", "night"]);
  assert.equal(t.wbOfficeSceneAt("day", 23), "day");
  assert.equal(t.wbOfficeSceneAt("night", 7), "night");
});

test("工作室场景和角色动作均被写入素材白名单", () => {
  const { keys } = manifest();
  const characters = ["cat", "goldfish", "liang"];
  const actions = ["walk", "type", "game", "coffee"];
  for (const name of ["day", "night", ...characters, ...characters.flatMap((character) => actions.map((action) => character + "-" + action))]) {
    const key = "o-studio-" + name;
    const file = readFileSync(new URL("../assets/office/" + key + ".webp", import.meta.url));
    assert.equal(file.length, keys[key].bytes);
    assert.equal(file.toString("ascii", 8, 12), "WEBP");
  }
});

const MEMBERS = [{ sessionId: "s-main" }, { sessionId: "s-a", title: "前端" }, { sessionId: "s-b", title: "后端" }, { sessionId: "s-c" }, { sessionId: "s-d" }];

test("办公室区分会话状态、分配任务、任务依赖和等你审批", async () => {
  const now = Date.now();
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: "s-main", members: MEMBERS },
    sessions: [
      { sessionId: "s-main", title: "项目主线", live: true },
      { sessionId: "s-a", title: "", live: true },
      { sessionId: "s-b", title: "", live: true },
      { sessionId: "s-c", title: "旧对话", live: false },
      { sessionId: "s-d", title: "测试", live: true },
    ],
    active: { "s-a": { tool: "edit" } },
    state: { "s-d": { lastErrorAt: now - 1000, lastErrorKind: "tool" } },
    tasks: [
      { taskId: "review", ownerSessionId: "s-main", subject: "确认设计", status: "in_progress" },
      { taskId: "build", ownerSessionId: "s-a", subject: "实现页面", status: "pending", blockedBy: ["review"] },
      { taskId: "draft", ownerSessionId: "s-b", subject: "整理接口", status: "in_progress" },
      { taskId: "report", ownerSessionId: "s-d", subject: "验收", status: "in_progress", report: { status: "human_action" } },
    ],
  });
  try {
    const { t, mount } = load();
    const view = mount(t.WbOfficePage, {
      t: KEY, projectId: "p1",
      useSessionStatus: (selector) => selector(statusOf({ "s-b": { running: true, pendingInteraction: { kind: "approval" } } })),
    });
    await view.settle();
    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    const deskOf = (id) => desks.find((n) => n.props["data-session"] === id);
    assert.deepEqual(desks.map((n) => n.props["data-session"]), ["s-main", "s-a", "s-b", "s-c", "s-d"]);
    assert.ok(desks.every((n) => n.type === "button"));
    assert.deepEqual(desks.map((n) => n.props["data-pose"]), ["idle", "type", "wait", "sleep", "oops"]);
    assert.match(texts(deskOf("s-main")), /office\.main.*确认设计/);
    assert.match(texts(deskOf("s-a")), /前端.*office\.tool.*实现页面.*office\.wait\.member.*项目主线.*确认设计/);
    assert.match(deskOf("s-b").props["aria-label"], /后端.*整理接口.*office\.wait\.approval/);
    assert.match(texts(deskOf("s-c")), /旧对话.*office\.task\.none/);
    assert.match(texts(deskOf("s-d")), /验收.*office\.wait\.report/);
    assert.equal(deskOf("s-d").props["data-attention"], "true");
    assert.match(texts(view.tree), /office\.attention \{"count":2\}/);
    const portraits = find(view.tree, (n) => typeof n.props["data-character"] === "string");
    assert.deepEqual(portraits.map((n) => n.props["data-character"]), ["cat", "goldfish", "liang", "cat", "goldfish"]);
    const actionsOf = (id) => find(deskOf(id), (n) => typeof n.props["data-action"] === "string").map((n) => n.props["data-action"]);
    assert.deepEqual(actionsOf("s-main"), ["walk", "game", "coffee"]);
    assert.deepEqual(actionsOf("s-a"), ["type"]);
    assert.deepEqual(actionsOf("s-b"), []);
    assert.deepEqual(actionsOf("s-c"), []);
  } finally { host.restore(); }
});

test("切换办公室场景后更换背景，手动选项与工位保留", async () => {
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s-main", members: [] }, sessions: [] });
  const { t, mount } = load();
  try {
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    const sceneButton = (name) => find(view.tree, (n) => n.type === "button" && texts(n) === KEY("office.scene." + name))[0];
    for (const scene of ["day", "night"]) {
      sceneButton(scene).props.onClick();
      view.rerender();
      assert.equal(sceneButton(scene).props["aria-pressed"], true);
      assert.equal(t.settings.getSnapshot().officeScene, scene);
      const room = find(view.tree, (n) => n.props.className === "daw-office-room")[0];
      assert.equal(room.props["data-scene"], scene);
      assert.ok(find(room, (n) => n.type === "img").some((n) => n.props.src.endsWith("o-studio-" + scene + ".webp")));
      assert.equal(find(room, (n) => n.props["data-session"] === "s-main").length, 1);
    }
  } finally { t.settings.set({ officeScene: "auto" }); host.restore(); }
});

test("离线：成员不在已加载的 /sessions 里 → 睡觉（真实宿主的形状，不是 live:false）", async () => {
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-gone" }] },
    sessions: [{ sessionId: "s-main", title: "主", live: true }],
    active: {}
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    const deskOf = (id) => desks.find((n) => n.props["data-session"] === id);
    assert.equal(deskOf("s-main").props["data-pose"], "idle", "在列表里、没事干 → 空闲");
    assert.equal(deskOf("s-gone").props["data-pose"], "sleep", "不在列表里 = 没挂载 = 离线");
    assert.match(deskOf("s-gone").props["aria-label"], /office\.pose\.sleep/);
  } finally { host.restore(); }
});

test("离线：/sessions 没加载出来（读不到）时不判离线——网络抖一下不能让全屋子的人集体睡着", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    if (target === "/sessions") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const data = target === "/projects/p1"
      ? ok({ project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-a" }] } })
      : { at: Date.now(), active: {}, state: {}, controlToken: "t" };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    await t.wbCache.read("/activity").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    const poses = find(view.tree, (n) => typeof n.props["data-session"] === "string").map((n) => n.props["data-pose"]);
    assert.deepEqual(poses, ["idle", "idle"], "拿不到名单就不知道谁离线，保守按没事干显示");
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

test("离线：不在列表里但有在跑的迹象（工具 / running）→ 不判离线（列表被截断或有短暂空窗时的保险）", async () => {
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-busy" }, { sessionId: "s-run" }] },
    sessions: [{ sessionId: "s-main", title: "主", live: true }],
    active: { "s-busy": { tool: "edit" } },
    state: { "s-run": { running: true } }
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    await t.wbCache.read("/activity").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    const poseOf = (id) => find(view.tree, (n) => n.props["data-session"] === id)[0].props["data-pose"];
    assert.equal(poseOf("s-busy"), "type", "有工具在跑");
    assert.equal(poseOf("s-run"), "type", "宿主说它在跑");
  } finally { host.restore(); }
});

test("名字：宿主会话表（useSessions）里的标题能补上；都没有时写「主对话 / 未命名对话」，页面上不出现整串 id", async () => {
  const mainId = "session-5e8fdc4b-cacb-47e2-b7eb-e238323af1bf";
  const aId = "session-99f56a30-16f1-4237-b613-e52576912061";
  const bId = "session-5474a70b-6c5c-4b2d-9455-cdfc151e0482";
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: mainId, members: [{ sessionId: mainId }, { sessionId: aId }, { sessionId: bId }] },
    sessions: [{ sessionId: mainId, title: "" }, { sessionId: aId, title: "" }, { sessionId: bId, title: "" }],
    active: {}
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const view = mount(t.WbOfficePage, {
      t: KEY,
      projectId: "p1",
      useSessions: (selector) => selector({ byId: { [aId]: { title: "宿主侧栏里的中文名" } } })
    });
    await view.settle();
    const plates = find(view.tree, (n) => n.props.className === "daw-office-plate").map((n) => texts(n));
    assert.deepEqual(plates, [KEY("office.main"), "宿主侧栏里的中文名", KEY("office.untitled", { id: "5474a7" })]);
    const everything = texts(view.tree);
    for (const id of [mainId, aId, bId]) assert.equal(everything.includes(id), false, "页面上不能出现整串会话 id");
    assert.equal(find(view.tree, (n) => n.props["aria-label"] && String(n.props["aria-label"]).includes("session-")).length, 0, "无障碍名称里也不能有整串 id");
    // 主对话没有名字时名牌本身就是「主对话」，不再重复贴一枚标签
    const mainDesk = find(view.tree, (n) => n.props["data-session"] === mainId)[0];
    assert.equal((texts(mainDesk).match(/office\.main/g) || []).length, 1);
  } finally { host.restore(); }
});

test("页面：没有成员时给空态，不渲染房间与工位", async () => {
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "", members: [] }, sessions: [], active: {} });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    assert.equal(find(view.tree, (n) => typeof n.props["data-session"] === "string").length, 0);
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-room").length, 0);
    assert.match(texts(view.tree), /office\.empty/);
  } finally { host.restore(); }
});

test("点工位把对应会话 id 交给 onOpenSession；按钮带「打开对话」提示", async () => {
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-a" }] }, sessions: [{ sessionId: "s-main", title: "主", live: true }, { sessionId: "s-a", title: "甲", live: true }], active: {} });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const opened = [];
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1", onOpenSession: (id) => opened.push(id) });
    await view.settle();
    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    assert.equal(desks[1].props.title, KEY("office.open"));
    desks[1].props.onClick();
    desks[0].props.onClick();
    assert.deepEqual(opened, ["s-a", "s-main"]);
  } finally { host.restore(); }
});

test("素材加载失败时隐藏图片，工位文字仍可打开对话", async () => {
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s-main", members: [] }, sessions: [] });
  try {
    const { t, mount } = load();
    const opened = [];
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1", onOpenSession: (id) => opened.push(id) });
    await view.settle();
    const images = find(view.tree, (n) => n.type === "img" && n.props.className !== "daw-office-action-img");
    assert.equal(images.length, 2);
    for (const img of images) {
      const element = {};
      img.props.onError({ currentTarget: element });
      assert.equal(element.hidden, true);
      assert.equal(img.props.alt, "");
    }
    const desk = find(view.tree, (n) => n.props["data-session"] === "s-main")[0];
    desk.props.onClick();
    assert.deepEqual(opened, ["s-main"]);
  } finally { host.restore(); }
});

test("路由：office 是合法 tab；坏 tab 仍回落 canvas", () => {
  const { t } = load();
  assert.deepEqual(t.wbRouteOf("/p/p1/office"), { kind: "workbench", projectId: "p1", tab: "office" });
  assert.deepEqual(t.wbRouteOf("/p/p1/nope"), { kind: "workbench", projectId: "p1", tab: "canvas" });
  assert.equal(t.wbPathOf({ kind: "workbench", projectId: "p1", tab: "office" }), "/p/p1/office");
});

test("文案：中英两份都有全部 office 键，且不再提 MetroCity", async () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const poses = ["idle", "type", "read", "run", "think", "wait", "done", "oops", "sleep"].map((pose) => "office.pose." + pose);
  const keys = ["tab.office", "office.empty", "office.tool", "office.open", "office.main", "office.untitled", "office.scene.auto", "office.scene.day", "office.scene.night", "office.wait.member"].concat(poses);
  for (const key of keys) {
    const hits = source.split('"' + key + '":').length - 1;
    assert.equal(hits, 2, key + " 必须在中文与英文各出现一次");
  }
  assert.equal(/"office\.state\./.test(source), false, "旧的 office.state.* 键必须清掉");
  assert.equal(/MetroCity/.test(source), false, "客户端不再提 MetroCity");
});

test("回归：/activity 是宿主的裸 JSON（没有信封），wbCache 必须原样读到，不能报 code 0", async () => {
  const { t } = load();
  assert.equal(t.wbIsRawPath("/activity"), true);
  assert.equal(t.wbIsRawPath("/activity?x=1"), true);
  assert.equal(t.wbIsRawPath("/sessions"), false, "只有白名单里的路径放行裸 JSON");
  assert.equal(t.wbIsRawPath("/activity-foo"), false);
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s", members: [] }, sessions: [], active: { s1: { tool: "edit" } }, state: { s1: { running: true } } });
  try {
    t.wbCache.reset();
    const data = await t.wbCache.read("/activity");
    assert.deepEqual(data.active, { s1: { tool: "edit" } });
    assert.deepEqual(data.state, { s1: { running: true } });
    // 反证：其它路径照旧要求信封，缺 code 就是失败
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
    try {
      t.wbCache.reset();
      await assert.rejects(() => t.wbCache.read("/sessions"), /code 0/);
    } finally { globalThis.fetch = original; }
  } finally { host.restore(); }
});
