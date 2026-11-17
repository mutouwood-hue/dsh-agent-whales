/**
 * 画布优先（PRD v2.2 九（续二），2026-11-17）浏览器半边用例。
 *
 * 用户不先开 DSH 对话，直接在画布里说话：
 *   - 「从画布开始」页：sessions.create 建主对话 → POST /projects 自动建项目 → 进画布；
 *   - 画布 Composer 卡：SessionProvider 显式绑定主对话，发送 = setDraft + submit；
 *   - 首条消息只补交一次（取走即删），回复从 /sessions/:id/messages 读。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

const api = () => loadPlugin().plugin.__test;

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
function buttonByText(tree, key) { return byTag(tree, "button").find((b) => texts(b) === "[" + key + "]"); }
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

// ── 纯函数 ──────────────────────────────────────────────────────────────

test("项目名取第一句首行：压空白、最多 24 字、全空给兜底名", () => {
  const { wbProjectNameFrom } = api();
  assert.equal(wbProjectNameFrom("  给审批流   做导入导出 \n第二行"), "给审批流 做导入导出");
  assert.equal(wbProjectNameFrom("\n\n  第三行才有字"), "第三行才有字");
  assert.equal(wbProjectNameFrom("一".repeat(30)), "一".repeat(24) + "…");
  assert.equal(wbProjectNameFrom("   "), "未命名项目");
  assert.equal(wbProjectNameFrom(undefined), "未命名项目");
});

test("最近一轮：最后一条用户消息 + 它之后的最后一条回复；还没回就 null", () => {
  const { wbLastExchange } = api();
  assert.deepEqual(wbLastExchange([]), { user: null, reply: null });
  assert.deepEqual(wbLastExchange(undefined), { user: null, reply: null });
  const rows = [
    { role: "user", text: "一" }, { role: "assistant", text: "旧回复" },
    { role: "user", text: "二" }, { role: "assistant", text: "中间" }, { role: "assistant", text: "最终" }
  ];
  assert.deepEqual(wbLastExchange(rows), { user: "二", reply: "最终" });
  assert.deepEqual(wbLastExchange(rows.concat([{ role: "user", text: "三" }])), { user: "三", reply: null }, "新问题还没回复时不能拿旧回复充数");
  assert.deepEqual(wbLastExchange([null, { role: "assistant", text: "只有回复" }]), { user: null, reply: "只有回复" });
});

test("工作区快照 → 下拉项：认 name/label/path/roots，缺 id 跳过，坏数据给空", () => {
  const { wbWorkspaceItems } = api();
  assert.deepEqual(wbWorkspaceItems(undefined), []);
  assert.deepEqual(wbWorkspaceItems({ items: "x" }), []);
  assert.deepEqual(wbWorkspaceItems({ items: [
    { id: "w1", name: "审批流" }, { id: "w2", path: "D:/x" }, { id: "w3", roots: ["D:/y"] }, { id: "w4" }, { name: "无 id" }, null
  ] }), [
    { id: "w1", name: "审批流" }, { id: "w2", name: "D:/x" }, { id: "w3", name: "D:/y" }, { id: "w4", name: "w4" }
  ]);
  // 宿主真实形状 WorkspaceView = {workspaceId, path, title}（2026-11-17 真机发现此前认错导致下拉为空）
  assert.deepEqual(wbWorkspaceItems({ items: [{ workspaceId: "ws-1", path: "C:/work", title: "默认工作区", sessionIds: [] }] }), [{ id: "ws-1", name: "默认工作区" }]);
});

test("首条消息暂存：取走即删，同一句话只会提交一次", () => {
  const { wbSetPending, wbTakePending } = api();
  wbSetPending("session-x", "开工");
  assert.equal(wbTakePending("session-x"), "开工");
  assert.equal(wbTakePending("session-x"), "", "第二次取不到");
  assert.equal(wbTakePending(""), "");
  assert.equal(wbTakePending(undefined), "");
});

// ── 画布 Composer 卡（session 子槽占用者）──────────────────────────────

function fakeActions() {
  const log = [];
  return {
    log,
    actions: {
      setDraft(text) { log.push(["setDraft", text]); },
      submit() { log.push(["submit"]); },
      insertText() { return true; },
      captureInsertion() { return {}; }
    }
  };
}

test("Composer 卡：首条消息在挂上后补交一次（setDraft + submit），回复显示在卡上", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  t.wbSetPending("session-new", "给审批流做导入导出");
  const { log, actions } = fakeActions();
  await withFetch((target) => {
    if (target.startsWith("/sessions/session-new/messages")) {
      return ok({ sessionId: "session-new", total: 2, rows: [{ role: "user", text: "给审批流做导入导出" }, { role: "assistant", text: "好的，先看表单模型" }] });
    }
    return ok({});
  }, async (calls) => {
    const props = { t: KEY, sessionId: "session-new", inputActions: actions, useSession: (sel) => sel({ running: false }), useInput: (sel) => sel({ phase: "plain" }) };
    const view = mount(t.WbSessionComposer, props);
    assert.deepEqual(log, [["setDraft", "给审批流做导入导出"], ["submit"]], "挂上即补交首条，且只交一次");
    await view.settle();
    view.rerender();
    assert.deepEqual(log.length, 2, "重画不能再交一次");
    const text = texts(view.tree);
    assert.ok(text.indexOf("好的，先看表单模型") >= 0, "回复要显示在画布卡上：" + text);
    assert.ok(calls.some((c) => c.target === "/sessions/session-new/messages?limit=8"), "回复走 /sessions/:id/messages");
  });
});

test("Composer 卡：用户点「发送」才提交；空草稿 / 发送中按钮不可点；拿不到 inputActions 明说", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  const { log, actions } = fakeActions();
  await withFetch(() => ok({ sessionId: "s1", total: 0, rows: [] }), async () => {
    let phase = "plain";
    const props = { t: KEY, sessionId: "s1", inputActions: actions, useSession: (sel) => sel({ running: false }), useInput: (sel) => sel({ phase }) };
    const view = mount(t.WbSessionComposer, props);
    await view.settle();
    assert.equal(log.length, 0, "没有暂存的首条消息就不能自动提交");
    assert.equal(buttonByText(view.tree, "chat.send").props.disabled, true, "空草稿不能发");
    byTag(view.tree, "textarea")[0].props.onChange({ target: { value: "  导入要支持 Excel  " } });
    view.rerender();
    assert.equal(buttonByText(view.tree, "chat.send").props.disabled, false);
    buttonByText(view.tree, "chat.send").props.onClick();
    view.rerender();
    assert.deepEqual(log, [["setDraft", "导入要支持 Excel"], ["submit"]]);
    assert.equal(byTag(view.tree, "textarea")[0].props.value, "", "发出后清空卡内草稿");
    // Enter 发送、Shift+Enter 换行、输入法组合中不发
    byTag(view.tree, "textarea")[0].props.onChange({ target: { value: "第二句" } });
    view.rerender();
    let prevented = 0;
    byTag(view.tree, "textarea")[0].props.onKeyDown({ key: "Enter", shiftKey: true, preventDefault() { prevented += 1; } });
    byTag(view.tree, "textarea")[0].props.onKeyDown({ key: "Enter", isComposing: true, preventDefault() { prevented += 1; } });
    assert.equal(log.length, 2, "Shift+Enter / 组合输入不能发");
    byTag(view.tree, "textarea")[0].props.onKeyDown({ key: "Enter", preventDefault() { prevented += 1; } });
    assert.equal(prevented, 1);
    assert.deepEqual(log.slice(2), [["setDraft", "第二句"], ["submit"]]);
  });

  // 发送中：按钮与输入框都锁住
  const sending = createMount({ effects: true });
  const loaded2 = loadPlugin({ react: sending.shim });
  await withFetch(() => ok({ rows: [] }), async () => {
    const view = sending.mount(loaded2.plugin.__test.WbSessionComposer, { t: KEY, sessionId: "s1", inputActions: fakeActions().actions, useSession: (sel) => sel({ running: false }), useInput: (sel) => sel({ phase: "sending" }) });
    assert.equal(byTag(view.tree, "textarea")[0].props.disabled, true);
    assert.ok(texts(view.tree).indexOf("[chat.sending]") >= 0);
  });

  // 拿不到 inputActions：明说，不假装能发
  const none = createMount({ effects: true });
  const loaded3 = loadPlugin({ react: none.shim });
  await withFetch(() => ok({ rows: [] }), async () => {
    const view = none.mount(loaded3.plugin.__test.WbSessionComposer, { t: KEY, sessionId: "s1" });
    assert.ok(texts(view.tree).indexOf("[chat.unavailable]") >= 0);
    assert.equal(buttonByText(view.tree, "chat.send").props.disabled, true);
  });
});

// ── 「从画布开始」页 ─────────────────────────────────────────────────────

test("从画布开始：建会话 → 建项目（名取首句、目标=原话）→ 暂存首条 → 进项目画布", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  const created = [];
  await withFetch((target, init) => {
    if (target === "/projects" && init && init.method === "POST") {
      const body = JSON.parse(init.body);
      return ok({ project: { projectId: "proj-9", name: body.name, mainSessionId: body.mainSessionId } });
    }
    return ok({});
  }, async (calls) => {
    const view = mount(t.WbStartPage, {
      t: KEY,
      createSession: (opts) => { created.push(opts); return Promise.resolve("session-new"); },
      useWorkspaces: (sel) => sel({ items: [{ workspaceId: "w0", title: "默认工作区" }, { workspaceId: "w1", title: "审批流" }] })
    });
    assert.equal(byTag(view.tree, "select")[0].props.value, "w0", "默认选第一个工作区，免得新会话落进「未分组」");
    assert.equal(buttonByText(view.tree, "start.send").props.disabled, true, "没写目标不能开始");
    byTag(view.tree, "select")[0].props.onChange({ target: { value: "w1" } });
    byTag(view.tree, "textarea")[0].props.onChange({ target: { value: "给审批流引擎做表单导入导出\n支持 Excel 和 JSON" } });
    view.rerender();
    buttonByText(view.tree, "start.send").props.onClick();
    await view.settle(10);
    assert.deepEqual(created, [{ workspaceId: "w1" }], "选的工作区要带给 sessions.create");
    const post = calls.find((c) => c.target === "/projects" && c.init && c.init.method === "POST");
    assert.ok(post, "必须 POST /projects 建项目");
    assert.deepEqual(JSON.parse(post.init.body), { name: "给审批流引擎做表单导入导出", mainSessionId: "session-new", goal: "给审批流引擎做表单导入导出\n支持 Excel 和 JSON" });
    assert.deepEqual(t.wbRoute.get(), { kind: "workbench", projectId: "proj-9", tab: "canvas" }, "建完直接进项目画布");
    assert.equal(t.wbTakePending("session-new"), "给审批流引擎做表单导入导出\n支持 Excel 和 JSON", "首条消息暂存待 Composer 补交");
  });
});

test("从画布开始：宿主不支持新建会话 / 建项目失败都明说，不跳页", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  t.wbRoute.set({ kind: "start" });
  await withFetch(() => ({ code: 40401, msg: "session not found" }), async () => {
    const noCreate = mount(t.WbStartPage, { t: KEY });
    assert.equal(buttonByText(noCreate.tree, "start.send").props.disabled, true);
    assert.ok(texts(noCreate.tree).indexOf("[start.no.create]") >= 0);

    const view = mount(t.WbStartPage, { t: KEY, createSession: () => Promise.resolve("session-x") });
    byTag(view.tree, "textarea")[0].props.onChange({ target: { value: "开工" } });
    view.rerender();
    buttonByText(view.tree, "start.send").props.onClick();
    await view.settle(10);
    assert.ok(texts(view.tree).indexOf("[start.failed]") >= 0, "失败要可见");
    assert.deepEqual(t.wbRoute.get(), { kind: "start" }, "失败不跳页");
    assert.equal(t.wbTakePending("session-x"), "", "失败不留暂存，免得以后误交");
  });
});

test("路由：start 可以被记住与恢复", () => {
  const loaded = loadPlugin({ storedExtra: { "dsh-agent-whales.last-view": JSON.stringify({ kind: "start" }) } });
  assert.deepEqual(loaded.plugin.__test.wbRoute.get(), { kind: "start" });
});

// ── 画布：Composer 节点挂真对话面 ────────────────────────────────────────

function canvasFetch(target) {
  const project = { projectId: "p1", name: "画布", mainSessionId: "session-main", members: [{ sessionId: "session-main", role: "main" }], links: [], brief: { goal: "g" } };
  if (target === "/projects/p1") return ok({ project });
  if (target === "/projects/p1/mcp-links") return ok({ projectId: "p1", available: [], links: [], members: [], mainSessionId: "session-main" });
  if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [] });
  if (target === "/sessions") return ok({ source: "host", sessions: [] });
  if (target.startsWith("/canvas")) return ok({ rev: 1, nodes: [] });
  if (target.startsWith("/inbox")) return ok({ groups: [] });
  if (target.startsWith("/handoffs")) return ok({ entries: [] });
  if (target.startsWith("/events")) return ok({ events: [] });
  return ok({});
}

test("画布 Composer：有 SessionProvider + 会话引用时挂 session 子槽，并在卸载时释放引用", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  const retained = [];
  const released = [];
  const slotCalls = [];
  function SessionProvider(props) { return { type: "session-provider", props: { "data-session": props.session.sessionId, children: props.children } }; }
  await withFetch(canvasFetch, async () => {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions"]) await t.wbCache.read(url).catch(() => {});
    const view = mount(t.WbCanvasPage, {
      t: KEY,
      projectId: "p1",
      SessionProvider,
      renderSlot: (name, owner) => { slotCalls.push({ name, owner }); return { type: "div", props: { className: "slot-" + name } }; },
      retainSession: (id) => { retained.push(id); return { sessionId: id, release() { released.push(id); } }; }
    });
    await view.settle();
    assert.deepEqual(retained, ["session-main"], "只 retain 主对话一次");
    const providers = [];
    collect(view.tree, providers, (n) => n.type === "session-provider");
    assert.equal(providers.length, 1, "Composer 卡里必须挂 SessionProvider");
    assert.equal(providers[0].props["data-session"], "session-main");
    assert.ok(slotCalls.some((c) => c.name === "whales.canvas.session"), "渲染 session 子槽");
    assert.equal(buttonByText(view.tree, "composer.put"), undefined, "真对话面挂上后不再显示「放入输入框」降级 UI");
    // 卸载：换一个挂载会跑 effect cleanup → release
    mount(() => null, {});
    assert.deepEqual(released, ["session-main"], "卸载必须 release，否则会话一直被画布占着");
    t.wbCache.reset();
  });
});

test("画布 Composer：拿不到 SessionProvider（旧宿主 / 测试垫片）就退回 Q1 轻量版", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  await withFetch(canvasFetch, async () => {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions"]) await t.wbCache.read(url).catch(() => {});
    const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
    await view.settle();
    assert.ok(buttonByText(view.tree, "composer.put"), "降级 UI 仍在");
    t.wbCache.reset();
  });
});

test("项目列表：主按钮是「从画布开始」，关联已有对话降为次按钮", async () => {
  const { shim, mount } = createMount();
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  await withFetch((target) => (target === "/projects" ? ok([]) : ok({ groups: [] })), async () => {
    await t.wbCache.read("/projects").catch(() => {});
    const view = mount(t.WbProjectList, { t: KEY });
    const start = buttonByText(view.tree, "start.entry");
    assert.ok(start, "必须有「从画布开始」");
    assert.equal(start.props["data-variant"], "primary");
    assert.equal(buttonByText(view.tree, "list.new").props["data-variant"], "ghost");
    start.props.onClick();
    assert.deepEqual(t.wbRoute.get(), { kind: "start" });
    t.wbCache.reset();
  });
});

test("布局：Composer 卡加高后，空态引导仍在它正下方不重叠", () => {
  const { wbCanvasNodes } = api();
  const nodes = wbCanvasNodes({ projectId: "p1", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }] }, [], []);
  const composer = nodes.find((n) => n.kind === "composer");
  assert.deepEqual({ x: composer.x, y: composer.y, w: composer.w, h: composer.h }, { x: 430, y: 220, w: 320, h: 330 });
  assert.ok(composer.y + composer.h <= 576, "空态引导 top 576 必须在 Composer 下沿之下");
});

// ── v2.2 波次 2：子会话自动入项目 / 组建方案（浏览器侧）──────────────────────

test("收编候选：父会话在项目里、自己不在、没被移出过的才算；排序稳定", () => {
  const { wbAdoptCandidates } = api();
  const project = { mainSessionId: "m", members: [{ sessionId: "m" }, { sessionId: "a" }], dismissed: ["gone"] };
  const sessions = [
    { sessionId: "z-child", parentSessionId: "a" },
    { sessionId: "b-child", parentSessionId: "m" },
    { sessionId: "a", parentSessionId: "m" },
    { sessionId: "gone", parentSessionId: "m" },
    { sessionId: "stranger", parentSessionId: "elsewhere" },
    { sessionId: "root" },
    null
  ];
  assert.deepEqual(wbAdoptCandidates(project, sessions), ["b-child", "z-child"]);
  assert.deepEqual(wbAdoptCandidates(null, sessions), []);
  assert.deepEqual(wbAdoptCandidates(project, undefined), []);
});

test("Agent 卡标题：新会话还没标题时用登记时的角色名兜底，并带出 addedBy", () => {
  const { wbCanvasNodes } = api();
  const nodes = wbCanvasNodes({ projectId: "p", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }, { sessionId: "s-new", title: "后端", addedBy: "proposal" }, { sessionId: "s-auto", addedBy: "auto" }] }, [], [{ sessionId: "s-auto", title: "子 agent 甲" }]);
  const byId = Object.fromEntries(nodes.filter((n) => n.kind === "agent").map((n) => [n.id, n]));
  assert.equal(byId["s-new"].title, "后端");
  assert.equal(byId["s-new"].addedBy, "proposal");
  assert.equal(byId["s-auto"].title, "子 agent 甲", "有会话标题时以会话标题为准");
  assert.equal(byId["s-auto"].addedBy, "auto");
  // wbSessionRows 会把空标题填成 sessionId：这种「标题 = id」也要退回角色名（真机 2026-11-17）
  const filled = wbCanvasNodes({ projectId: "p", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }, { sessionId: "s-new", title: "后端" }] }, [], [{ sessionId: "s-new", title: "s-new" }]);
  assert.equal(filled.find((n) => n.id === "s-new").title, "后端");
});

test("画布：有收编候选时调 POST /projects/:id/adopt（列表不变不重复请求）", async () => {
  const { shim, mount } = createMount({ effects: true });
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  const fetcher = (target, init) => {
    if (target === "/sessions") return ok({ source: "host", sessions: [{ sessionId: "session-child", parentSessionId: "session-main", title: "子" }] });
    if (target === "/projects/p1/adopt") return ok({ projectId: "p1", adopted: [{ projectId: "p1", sessionId: "session-child", parentSessionId: "session-main" }] });
    return canvasFetch(target, init);
  };
  await withFetch(fetcher, async (calls) => {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions"]) await t.wbCache.read(url).catch(() => {});
    const view = mount(t.WbCanvasPage, { t: KEY, projectId: "p1" });
    await view.settle();
    view.rerender();
    const adoptCalls = calls.filter((c) => c.target === "/projects/p1/adopt");
    assert.equal(adoptCalls.length, 1, "候选不变只请求一次");
    assert.equal(adoptCalls[0].init.method, "POST");
    t.wbCache.reset();
  });
});

test("提案卡：组建方案在确认前就列出将新建的对话与 preset；已建的打勾", async () => {
  const { shim, mount } = createMount();
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  const proposal = {
    proposalId: "prop-1", version: 1, leadSessionId: "m", items: [{ key: "T1", title: "导入接口" }],
    conversations: [{ key: "be", title: "后端", duty: "写接口", agentPreset: "dsh-agent-whales-worker" }, { key: "fe", title: "前端", duty: "" }],
    locked: true, confirmed: { version: 1, created: [], conversations: [{ key: "be", sessionId: "s-1" }] }
  };
  await withFetch(() => ok({ proposal }), async () => {
    await t.wbCache.read("/proposals?leadSessionId=m").catch(() => {});
    const view = mount(t.WbProposalCard, { t: KEY, leadSessionId: "m", projectId: "p1" });
    const banners = [];
    collect(view.tree, banners, (n) => n.props["data-proposal-conversations"] !== undefined);
    assert.equal(banners.length, 1);
    assert.equal(banners[0].props["data-proposal-conversations"], "2");
    const text = texts(banners[0]);
    assert.ok(text.indexOf("✓ 后端（dsh-agent-whales-worker） · 写接口") >= 0, text);
    assert.ok(text.indexOf("· 前端[proposal.conversation.defaultPreset]") >= 0, text);
    t.wbCache.reset();
  });
});

test("布局契约：画布上的提案卡浮在 stage 之上（真机曾被盖住、确认点不到）", async () => {
  const t = api();
  assert.match(t.WB_CSS, /\.daw-wb-canvaswrap>\.daw-wb-toolbar\{position:absolute;[^}]*z-index:21/, "工具条（删除 / 全清 / 引擎切换）必须浮在舞台之上");
  assert.match(t.WB_CSS, /\.daw-wb-canvaswrap>\.daw-wb-banner\{position:absolute;[^}]*z-index:22/, "提示条也不能被舞台盖住");
  assert.match(t.WB_CSS, /\.daw-wb-floatpanel\{position:absolute;[^}]*z-index:20/, "浮层必须绝对定位且压在画布之上");
  assert.match(t.WB_CSS, /\.daw-wb-floatpanel>\*\{pointer-events:auto/, "浮层容器不吃点击，卡片本身可点");
  const { shim, mount } = createMount();
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const live = loaded.plugin.__test;
  await withFetch(canvasFetch, async () => {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions"]) await live.wbCache.read(url).catch(() => {});
    const view = mount(live.WbCanvasPage, { t: KEY, projectId: "p1" });
    const floats = [];
    collect(view.tree, floats, (n) => n.props.className === "daw-wb-floatpanel");
    assert.equal(floats.length, 1, "提案卡必须装在浮层里");
    live.wbCache.reset();
  });
});

test("提案卡（画布浮层）：已确认默认收起不挡 Agent 列，点展开 / 收起来回切", async () => {
  const { shim, mount } = createMount();
  const loaded = loadPlugin({ react: shim });
  installDocumentStub();
  const t = loaded.plugin.__test;
  const proposal = { proposalId: "prop-2", version: 1, leadSessionId: "m", items: [{ key: "T1", title: "x" }], conversations: [{ key: "be", title: "后端" }], locked: true, confirmed: { version: 1, created: [] } };
  await withFetch(() => ok({ proposal }), async () => {
    await t.wbCache.read("/proposals?leadSessionId=m").catch(() => {});
    const view = mount(t.WbProposalCard, { t: KEY, leadSessionId: "m", projectId: "p1", collapsible: true });
    const plans = () => { const out = []; collect(view.tree, out, (n) => n.props["data-proposal-conversations"] !== undefined); return out; };
    assert.equal(plans().length, 0, "已确认默认收起");
    buttonByText(view.tree, "proposal.expand").props.onClick();
    view.rerender();
    assert.equal(plans().length, 1, "展开后看得到组建方案");
    buttonByText(view.tree, "proposal.collapse").props.onClick();
    view.rerender();
    assert.equal(plans().length, 0);
    // 非画布处（不传 collapsible）照旧全展开
    const plain = mount(t.WbProposalCard, { t: KEY, leadSessionId: "m", projectId: "p1" });
    const out = []; collect(plain.tree, out, (n) => n.props["data-proposal-conversations"] !== undefined);
    assert.equal(out.length, 1);
    t.wbCache.reset();
  });
});

test("布局：Agent 列行距不小于卡高（真机曾两两叠 10px），且与「添加 Agent」占位同口径", () => {
  const { wbCanvasNodes } = api();
  const nodes = wbCanvasNodes({ projectId: "p", mainSessionId: "m", members: [{ sessionId: "m" }, { sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }] }, [], []);
  const agents = nodes.filter((n) => n.kind === "agent");
  assert.equal(agents.length, 3);
  for (let i = 1; i < agents.length; i += 1) {
    assert.ok(agents[i].y >= agents[i - 1].y + agents[i - 1].h, `第 ${i} 张 Agent 卡不能压到上一张`);
    assert.equal(agents[i].y - agents[i - 1].y, 168, "与占位节点 / MCP 列的 168 行距一致");
  }
});
