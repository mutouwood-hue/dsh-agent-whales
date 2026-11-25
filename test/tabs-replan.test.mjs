// 重新规划 R4：项目内页签 6 → 4（画布 · 需求 · 表格 · 办公室）。
// 任务 + 执行 并入「表格」；简报并入「需求」页底部。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, createReactShim, installDocumentStub, loadPlugin } from "./harness.mjs";

const KEY = (key, vars) => "[" + key + "]" + (vars ? JSON.stringify(vars) : "");
const ok = (data) => ({ code: 200, msg: "success", data });

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

const project = { projectId: "p1", name: "项目", mainSessionId: "m", members: [{ sessionId: "m", role: "main" }], links: [], brief: { goal: "把需求做完", version: 1 } };
function body(target) {
  if (target === "/projects/p1") return ok({ project });
  if (target.startsWith("/tasks?projectId=")) return ok({ source: "project", projectId: "p1", tasks: [{ taskId: "t1", subject: "实现导入", status: "pending", ownerSessionId: "m", revision: 1, createdAt: 1, requirementId: "r1" }] });
  if (target === "/sessions") return ok({ source: "host", sessions: [] });
  if (target === "/projects/p1/brief" || target.startsWith("/projects/p1/brief")) return ok({ brief: { version: 1, goal: "把需求做完", constraints: [], decisions: [], conclusions: [], artifacts: [] } });
  if (target === "/projects/p1/requirements") return ok({ requirements: [] });
  if (target.startsWith("/projects/p1/e2e-config")) return ok({ config: {} });
  return ok({});
}
async function mountPage(name, props) {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  const loaded = loadPlugin({ react: shim });
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  globalThis.fetch = (url) => { const b = body(String(url).replace("/agent-whales/api", "")); return Promise.resolve({ ok: b.code === 200, status: 200, json: () => Promise.resolve(b) }); };
  for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements", "/projects/p1/brief"]) await t.wbCache.read(url).catch(() => {});
  const view = mount(t[name], Object.assign({ t: KEY, projectId: "p1" }, props || {}));
  await view.settle(10); view.rerender();
  return { t, view, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}

test("项目内页签条只剩三个：画布 · 表格 · 办公室；需求与待办收进画布，不再有独立需求页", async () => {
  const c = await mountPage("WbTabs", { route: { kind: "workbench", projectId: "p1", tab: "canvas" }, reqAttention: 2, openTasks: 3, runningTasks: 4 });
  try {
    const tabs = byClass(c.view.tree, "daw-wb-tab");
    assert.deepEqual(tabs.map((n) => texts(n).replace(/\d+$/, "")), [KEY("tab.canvas"), KEY("tab.table"), KEY("tab.office")]);
    assert.equal(texts(tabs[1]), KEY("tab.table") + "7", "表格页签角标 = 待办任务 + 在跑任务");
    assert.doesNotMatch(texts(c.view.tree), /tab\.(tasks|brief|exec)\b/);
  } finally { c.restore(); }
});

test("表格页 = 任务表 + 执行：两块都在、都用面板外壳（只有一个页面标题）；任务表里的任务照常出现；不再嵌套整页外壳", async () => {
  const c = await mountPage("WbTablePage", {});
  try {
    assert.equal(byClass(c.view.tree, "daw-wb-h1").length, 0, "嵌入的两块不能各自再带一个整页标题（h1 只应由外层页面给）");
    const titles = byClass(c.view.tree, "daw-wb-panel-title").map((n) => texts(n));
    assert.ok(titles.includes(KEY("tab.tasks")), "有「任务」分区：" + titles.join("|"));
    assert.ok(titles.includes(KEY("tab.exec")), "有「执行」分区：" + titles.join("|"));
    assert.match(texts(c.view.tree), /实现导入/, "任务表里有任务");
    assert.equal(byClass(c.view.tree, "daw-wb-page").length, 0, "没有嵌套的整页外壳");
  } finally { c.restore(); }
});

test("独立使用时三个页面仍是整页外壳（embedded 只在被并入时才生效）", async () => {
  for (const name of ["WbTasksPage", "WbExecPage", "WbBriefPage"]) {
    const c = await mountPage(name, {});
    try { assert.equal(byClass(c.view.tree, "daw-wb-page").length, 1, name + " 独立挂载时是整页"); } finally { c.restore(); }
  }
});

test("需求列表页底部有「项目简报」（原简报页并入）", async () => {
  const c = await mountPage("WbReqsPage", {});
  try {
    const titles = byClass(c.view.tree, "daw-wb-panel-title").map((n) => texts(n));
    assert.ok(titles.includes(KEY("tab.brief")), "需求列表页里有项目简报：" + titles.join("|"));
    assert.equal(byClass(c.view.tree, "daw-wb-page").length, 1, "仍然只有一个整页外壳（需求页自己的）");
  } finally { c.restore(); }
});

test("页签文案：新增 table 键中英都有；tab.tasks / tab.brief / tab.exec 仍在（作为表格与需求页里的分区标题）", () => {
  const t = loadPlugin().plugin.__test;
  for (const lang of ["zh", "en"]) for (const key of ["tab.table", "tab.note.table", "tab.tasks", "tab.brief", "tab.exec"]) assert.ok(t.WB_TEXT[lang][key], lang + " 缺 " + key);
  assert.equal(typeof t.wbTabOf, "function");
  assert.equal(t.wbTabOf("tasks"), "table");
  assert.equal(t.wbTabOf("exec"), "table");
  assert.equal(t.wbTabOf("brief"), "canvas");
  assert.equal(t.wbTabOf("reqs"), "canvas");
  assert.equal(t.wbTabOf(undefined), "canvas");
  assert.equal(t.wbTabOf("toString"), "canvas", "Object.prototype 上的名字不是页签");
});

test("「需要我处理」里点任务类待办 → 去「表格」页签（不是已删除的 tasks）", async () => {
  const { shim, mount } = createMount({ effects: true });
  installDocumentStub();
  const loaded = loadPlugin({ react: shim });
  const t = loaded.plugin.__test;
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    const b = target.startsWith("/inbox") ? ok({ groups: [{ key: "system", label: "系统", items: [{ kind: "task", projectId: "p1", subject: "等你", reason: "r", at: 1 }] }] }) : ok({ entries: [], events: [] });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
  };
  try {
    await t.wbCache.read("/inbox").catch(() => {});
    const view = mount(t.WbInboxPage, { t: KEY });
    await view.settle(10); view.rerender();
    const buttons = []; collect(view.tree, buttons, (n) => typeof n.props.onClick === "function" && /inbox\.action/.test(texts(n)));
    assert.ok(buttons.length >= 1, "有「去处理」按钮");
    buttons[0].props.onClick();
    assert.deepEqual(t.wbRoute.get(), { kind: "workbench", projectId: "p1", tab: "table" });
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

test("外壳按页签选页面：table → 表格页、office → 办公室页、canvas → 画布页；旧 reqs/brief 回画布", async () => {
  installDocumentStub();
  const loaded = loadPlugin({ react: createReactShim() });
  const api = loaded.plugin.__test;
  const original = globalThis.fetch;
  globalThis.fetch = (url) => { const b = body(String(url).replace("/agent-whales/api", "")); return Promise.resolve({ ok: b.code === 200, status: 200, json: () => Promise.resolve(b) }); };
  try {
    for (const url of ["/projects/p1", "/tasks?projectId=p1", "/sessions", "/projects/p1/requirements", "/inbox", "/projects"]) await api.wbCache.read(url).catch(() => {});
    const find = (tree, type) => { const out = []; collect(tree, out, (n) => n.type === type); return out; };
    const expected = { table: "WbTablePage", office: "WbOfficePage", canvas: "WbCanvasPage" };
    const wanted = (tab) => ({ WbTablePage: api.WbTablePage, WbOfficePage: api.WbOfficePage, WbCanvasPage: api.WbCanvasPage }[expected[tab]]);
    for (const tab of ["table", "canvas"]) {
      api.wbRoute.set({ kind: "workbench", projectId: "p1", tab });
      const tree = api.WhaleWorkbench({});
      assert.equal(find(tree, wanted(tab)).length, 1, tab + " 页签要渲染 " + expected[tab]);
      for (const other of ["table", "canvas"].filter((x) => x !== tab)) assert.equal(find(tree, wanted(other)).length, 0, tab + " 页签不该同时渲染 " + expected[other]);
    }
    assert.equal(find(api.WhaleWorkbench({}), api.WbReqsPage).length, 0, "不再渲染独立需求页");
    // 旧页签经路由归一后各落到新页面
    for (const [oldTab, name] of [["tasks", "WbTablePage"], ["exec", "WbTablePage"], ["brief", "WbCanvasPage"], ["reqs", "WbCanvasPage"]]) {
      api.wbRoute.set({ kind: "workbench", projectId: "p1", tab: api.wbTabOf(oldTab) });
      assert.equal(find(api.WhaleWorkbench({}), api[name]).length, 1, "旧页签 " + oldTab + " → " + name);
    }
    // 外壳的页签条也只有 3 个
    api.wbRoute.set({ kind: "workbench", projectId: "p1", tab: "canvas" });
    const tabsEl = find(api.WhaleWorkbench({}), api.WbTabs);
    assert.equal(tabsEl.length, 1);
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; api.wbCache.reset(); }
});
