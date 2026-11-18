/**
 * 波次 D 浏览器半边（PRD 增量 §4.6）：画布 Agent 卡「唤醒」。
 *
 * 宿主半边（POST /projects/:id/resume 的范围闸 / 幂等 / 并发 / 失败）在 index.test.mjs；
 * 这里只测浏览器侧：
 *   - 「离线」只认宿主 /sessions 的 live === false（空闲但活着的会话 online 也是 false，不能当离线）；
 *   - 按钮只出现在离线成员的卡头上，在线成员没有；
 *   - 点击发对的请求（POST /projects/:id/resume，body 只有 sessionId）；
 *   - 成功 / 已在线 / 失败三种提示，失败不吞原因，且按钮复位可重试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

function collect(node, out, match) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) { node.forEach((item) => collect(item, out, match)); return; }
  if (typeof node !== "object") return;
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
function byTag(tree, tag) { const out = []; collect(tree, out, (n) => n.type === tag); return out; }
function buttonsByText(tree, key) { return byTag(tree, "button").filter((b) => texts(b) === "[" + key + "]"); }
const KEY = (key) => "[" + key + "]";

function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    calls.push({ target, init });
    const data = handler(target, init);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  return Promise.resolve().then(() => run(calls)).finally(() => {
    if (original === undefined) delete globalThis.fetch;
    else globalThis.fetch = original;
  });
}
const ok = (data) => ({ code: 200, msg: "success", data });

/** 主对话 + 三个成员：在线在跑 / 空闲但活着 / 已下线（live:false）。 */
const MEMBERS = [
  { sessionId: "s-main", role: "main" },
  { sessionId: "s-busy", role: "member" },
  { sessionId: "s-idle", role: "member" },
  { sessionId: "s-off", role: "member" }
];
const SESSION_ROWS = [
  { sessionId: "s-main", title: "主", running: false, live: true, archived: false },
  { sessionId: "s-busy", title: "在跑", running: true, live: true, archived: false },
  { sessionId: "s-idle", title: "空闲", running: false, live: true, archived: false },
  { sessionId: "s-off", title: "下线的", running: false, live: false, archived: true }
];

function fetchMap(resume) {
  return (target, init) => {
    if (target === "/projects/p1") return ok({ project: { projectId: "p1", name: "画布", mainSessionId: "s-main", members: MEMBERS, links: [], brief: { goal: "g" } } });
    if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [], mainSessionId: "s-main" });
    if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [] });
    if (target === "/sessions") return ok({ source: "host", sessions: SESSION_ROWS });
    if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: [] });
    if (target.startsWith("/inbox")) return ok({ groups: [] });
    if (target.startsWith("/handoffs")) return ok({ entries: [] });
    if (target.startsWith("/events")) return ok({ events: [] });
    if (target === "/projects/p1/resume" && init && init.method === "POST") return resume(JSON.parse(init.body));
    return ok({});
  };
}

async function mountCanvas(t, mount) {
  for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions"]) await t.wbCache.read(url).catch(() => {});
  const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
  await view.settle();
  return view;
}

test("「唤醒」只出现在宿主说已下线（live:false）的成员上；在跑的、空闲但活着的都没有", async () => {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  await withFetch(fetchMap(() => ok({})), async () => {
    const view = await mountCanvas(t, mount);
    assert.equal(buttonsByText(view.tree, "canvas.agent.wake").length, 1, "四个成员里只有 s-off 下线，只能有一个唤醒按钮");
    // 空闲但活着：online:false，但 live:true —— 绝不能被当成离线
    const idleNodes = t.wbCanvasNodes(
      { projectId: "p1", mainSessionId: "s-main", members: MEMBERS },
      [],
      [{ sessionId: "s-idle", title: "空闲", running: false, live: false, offline: false }]
    ).filter((n) => n.kind === "agent");
    assert.equal(idleNodes.find((n) => n.sessionId === "s-idle").offline, false, "空闲 ≠ 离线");
    assert.equal(idleNodes.find((n) => n.sessionId === "s-idle").online, false);
    t.wbCache.reset();
  });
});

test("客户端 store 的行没有 live 布尔 → 缺省不离线（旧宿主 / 老数据不会冒出一排唤醒按钮）", () => {
  const t = loadPlugin().plugin.__test;
  const nodes = t.wbCanvasNodes(
    { projectId: "p1", mainSessionId: "s-main", members: MEMBERS },
    [],
    [{ sessionId: "s-off", title: "x", running: false, live: false }]
  ).filter((n) => n.kind === "agent");
  assert.ok(nodes.every((n) => n.offline === false), "没有 offline 字段（只有 live 推断）时一律不离线");
});

test("点击「唤醒」：POST /projects/p1/resume，body 只有 sessionId；成功提示出现，按钮复位", async () => {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  await withFetch(fetchMap((body) => ok({ sessionId: body.sessionId, live: true, resumed: true })), async (calls) => {
    const view = await mountCanvas(t, mount);
    const [wake] = buttonsByText(view.tree, "canvas.agent.wake");
    wake.props.onClick({ stopPropagation() {} });
    await view.settle(10);
    const posts = calls.filter((c) => c.target === "/projects/p1/resume");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].init.method, "POST");
    assert.deepEqual(JSON.parse(posts[0].init.body), { sessionId: "s-off" }, "只发 sessionId，不夹带任何派任务的字段");
    assert.ok(calls.every((c) => !/\/tasks\/.+\/commands/.test(c.target)), "唤醒不等于开工：不能顺带派任务");
    assert.ok(texts(view.tree).includes("[canvas.agent.wake.ok]"), "成功提示必须可见");
    assert.equal(buttonsByText(view.tree, "canvas.agent.wake")[0].props.disabled, false, "完成后按钮复位");
    t.wbCache.reset();
  });
});

test("宿主说本来就在线 → 提示「本来就在线」，不报成功也不报错", async () => {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  await withFetch(fetchMap((body) => ok({ sessionId: body.sessionId, live: true, resumed: false })), async () => {
    const view = await mountCanvas(t, mount);
    buttonsByText(view.tree, "canvas.agent.wake")[0].props.onClick();
    await view.settle(10);
    assert.ok(texts(view.tree).includes("[canvas.agent.wake.already]"));
    t.wbCache.reset();
  });
});

test("宿主 resume 失败（50201）：原因如实显示、不吞；按钮复位可重试", async () => {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  await withFetch(fetchMap(() => ({ code: 50201, msg: "resume boom: 日志损坏" })), async (calls) => {
    const view = await mountCanvas(t, mount);
    buttonsByText(view.tree, "canvas.agent.wake")[0].props.onClick();
    await view.settle(10);
    assert.ok(texts(view.tree).includes("[canvas.agent.wake.fail]"), "失败必须可见，不能静默");
    assert.equal(buttonsByText(view.tree, "canvas.agent.wake")[0].props.disabled, false, "失败后按钮复位，用户能重试");
    buttonsByText(view.tree, "canvas.agent.wake")[0].props.onClick();
    await view.settle(10);
    assert.equal(calls.filter((c) => c.target === "/projects/p1/resume").length, 2, "失败后可再次发起");
    t.wbCache.reset();
  });
});

test("宿主说已恢复但会话仍没上线（live:false）→ 按失败提示，不谎报成功", async () => {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  await withFetch(fetchMap((body) => ok({ sessionId: body.sessionId, live: false, resumed: true })), async () => {
    const view = await mountCanvas(t, mount);
    buttonsByText(view.tree, "canvas.agent.wake")[0].props.onClick();
    await view.settle(10);
    const text = texts(view.tree);
    assert.ok(text.includes("[canvas.agent.wake.fail]"));
    assert.ok(!text.includes("[canvas.agent.wake.ok]"), "没上线不能报成功");
    t.wbCache.reset();
  });
});

test("文案：中英两份都有全部 wake 键，且说明「只上线、不派任务」", () => {
  const { WB_TEXT } = loadPlugin().plugin.__test;
  for (const key of ["canvas.agent.wake", "canvas.agent.wake.title", "canvas.agent.wake.ok", "canvas.agent.wake.already", "canvas.agent.wake.notlive", "canvas.agent.wake.fail"]) {
    assert.ok(WB_TEXT.zh[key], "zh 缺 " + key);
    assert.ok(WB_TEXT.en[key], "en 缺 " + key);
  }
  assert.match(WB_TEXT.zh["canvas.agent.wake.title"], /不会自动派任务/);
  assert.match(WB_TEXT.en["canvas.agent.wake.title"], /no task is dispatched/);
});
