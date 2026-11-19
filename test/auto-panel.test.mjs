/**
 * 第二期 X3 浏览器半边：「执行」页里的自动派发面板（WbAutoPanel）。
 *
 * 宿主半边（档位校验 / 速率 / 审批 / 撤销窗口 / 审计）在 index.test.mjs 与 auto-dispatch.test.mjs；
 * 这里只测浏览器侧：
 *   - 三档按钮与当前档位的标记；
 *   - 放宽（升 L3 / 开「全部同意」）必须先停在确认条上，点「确认开启」才带 confirm:true 发 PUT；
 *     收紧（降到 L1 / 改回「停在等你」）直接发，不拦；
 *   - 速率与深度三个数字：改了才能保存，保存发对的 body；
 *   - 撤销窗口内的任务显示剩余秒数，点「撤销」发对的 POST；
 *   - 宿主拒绝时不吞原因。
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
function find(tree, match) { const out = []; collect(tree, out, match); return out; }
function byAttr(tree, attr, value) { const node = find(tree, (n) => n.props[attr] === value)[0]; return node ? node.props : null; }
function buttonByKey(tree, key) { const node = find(tree, (n) => n.type === "button" && texts(n) === "[" + key + "]")[0]; return node ? node.props : null; }
const KEY = (key, vars) => "[" + key + (vars ? " " + JSON.stringify(vars) : "") + "]";
const ok = (data) => ({ code: 200, msg: "success", data });

const DEFAULT_AUTO = {
  tier: "L2",
  approval: "wait",
  undoWindowMs: 5000,
  perMemberPerMinute: 3,
  projectConcurrent: 5,
  maxChainDepth: 10
};

/**
 * 可变的假宿主：GET /auto 返回当前状态，PUT 合并补丁，POST /auto-undo 记账。
 * `reject` 非空时 PUT 回业务错误，用来验证失败原因不被吞。
 */
function fakeHost(initial = {}) {
  const state = {
    auto: Object.assign({}, DEFAULT_AUTO, initial.auto || {}),
    pending: initial.pending || [],
    audit: initial.audit || []
  };
  const calls = [];
  const original = globalThis.fetch;
  let reject = null;
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    const method = init && init.method ? init.method : "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ target, method, body });
    let data = ok({});
    if (target === "/projects/p1/auto" && method === "GET") data = ok({ projectId: "p1", auto: state.auto, pending: state.pending, audit: state.audit });
    else if (target === "/projects/p1/auto" && method === "PUT") {
      if (reject !== null) data = { code: 40001, msg: reject, data: null };
      else {
        const patch = Object.assign({}, body);
        delete patch.confirm;
        Object.assign(state.auto, patch);
        data = ok({ auto: state.auto });
      }
    } else if (target === "/projects/p1/auto-undo" && method === "POST") {
      state.pending = state.pending.filter((row) => row.taskId !== body.taskId);
      data = ok({ undone: body.taskId });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  return {
    state,
    calls,
    puts: () => calls.filter((c) => c.method === "PUT"),
    rejectWith(message) { reject = message; },
    restore() { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
  };
}

async function mountPanel(host, taskNames = {}) {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  await t.wbCache.read("/projects/p1/auto").catch(() => {});
  const view = mount(t.WbAutoPanel, { t: KEY, projectId: "p1", taskNames });
  await view.settle();
  return { t, view };
}

test("面板：默认 L2 / 停在等你；三档按钮各一个，只有当前档标记为 on", async () => {
  const host = fakeHost();
  try {
    const { view } = await mountPanel(host);
    assert.equal(byAttr(view.tree, "data-wb-auto", "ready") !== null, true, "数据回来后要渲染成 ready 态");
    for (const tier of ["L1", "L2", "L3"]) {
      const button = byAttr(view.tree, "data-tier", tier);
      assert.ok(button, tier + " 按钮必须在");
      assert.equal(button["data-on"], String(tier === "L2"), tier + " 的当前档标记");
    }
    assert.equal(byAttr(view.tree, "data-approval", "wait")["data-on"], "true");
    assert.equal(byAttr(view.tree, "data-approval", "approve-all")["data-on"], "false");
  } finally { host.restore(); }
});

test("放宽：升 L3 先出确认条、不发请求；点「确认开启」才带 confirm:true 发 PUT", async () => {
  const host = fakeHost();
  try {
    const { view } = await mountPanel(host);
    byAttr(view.tree, "data-tier", "L3").onClick();
    await view.settle();
    assert.equal(host.puts().length, 0, "点 L3 本身不能直接发");
    assert.ok(byAttr(view.tree, "data-wb-auto-confirm", "L3"), "要出现 L3 的确认条");

    buttonByKey(view.tree, "auto.confirm.ok").onClick();
    await view.settle();
    assert.equal(host.puts().length, 1);
    assert.deepEqual(host.puts()[0].body, { tier: "L3", confirm: true });
    assert.equal(byAttr(view.tree, "data-tier", "L3")["data-on"], "true", "保存后重读，L3 成为当前档");
    assert.equal(byAttr(view.tree, "data-wb-auto-confirm", "L3"), null, "确认条随之收起");
  } finally { host.restore(); }
});

test("放宽：「全部同意」同样要确认；取消确认条后什么都没发", async () => {
  const host = fakeHost();
  try {
    const { view } = await mountPanel(host);
    byAttr(view.tree, "data-approval", "approve-all").onClick();
    await view.settle();
    assert.ok(byAttr(view.tree, "data-wb-auto-confirm", "approve-all"));
    buttonByKey(view.tree, "common.cancel").onClick();
    await view.settle();
    assert.equal(byAttr(view.tree, "data-wb-auto-confirm", "approve-all"), null);
    assert.equal(host.puts().length, 0, "取消不发请求");

    byAttr(view.tree, "data-approval", "approve-all").onClick();
    await view.settle();
    buttonByKey(view.tree, "auto.confirm.ok").onClick();
    await view.settle();
    assert.deepEqual(host.puts()[0].body, { approval: "approve-all", confirm: true });
  } finally { host.restore(); }
});

test("收紧不拦：降到 L1、从「全部同意」改回「停在等你」都直接发，body 不带 confirm", async () => {
  const host = fakeHost({ auto: { tier: "L3", approval: "approve-all" } });
  try {
    const { view } = await mountPanel(host);
    byAttr(view.tree, "data-tier", "L1").onClick();
    await view.settle();
    byAttr(view.tree, "data-approval", "wait").onClick();
    await view.settle();
    assert.deepEqual(host.puts().map((c) => c.body), [{ tier: "L1" }, { approval: "wait" }]);
    assert.equal(byAttr(view.tree, "data-wb-auto-confirm", "L3"), null);
  } finally { host.restore(); }
});

test("点已经是当前值的按钮不重复发请求", async () => {
  const host = fakeHost();
  try {
    const { view } = await mountPanel(host);
    byAttr(view.tree, "data-tier", "L2").onClick();
    byAttr(view.tree, "data-approval", "wait").onClick();
    await view.settle();
    assert.equal(host.puts().length, 0);
  } finally { host.restore(); }
});

test("速率与深度：没改时保存按钮禁用；改后发数字（不是字符串），且不带 confirm", async () => {
  const host = fakeHost();
  try {
    const { view } = await mountPanel(host);
    assert.equal(buttonByKey(view.tree, "auto.limit.save").disabled, true, "没改就不能保存");

    byAttr(view.tree, "data-limit", "perMemberPerMinute").onChange({ target: { value: "6" } });
    await view.settle();
    const save = buttonByKey(view.tree, "auto.limit.save");
    assert.equal(save.disabled, false);
    save.onClick();
    await view.settle();
    assert.deepEqual(host.puts()[0].body, { perMemberPerMinute: 6, projectConcurrent: 5, maxChainDepth: 10 });
    assert.equal(host.state.auto.perMemberPerMinute, 6);
  } finally { host.restore(); }
});

test("撤销窗口：挂起项显示任务名与剩余秒数，点「撤销」发 POST 并带 taskId", async () => {
  const host = fakeHost({ pending: [{ taskId: "t-1", dueAt: Date.now() + 4200 }] });
  try {
    const { view } = await mountPanel(host, { "t-1": "写周报" });
    assert.ok(byAttr(view.tree, "data-wb-auto-pending", "true"), "有挂起项要出现挂起标题");
    const rowText = texts(view.tree);
    assert.match(rowText, /写周报/, "要显示任务名而不是 id");
    assert.match(rowText, /"seconds":[1-5]\b/, "剩余秒数在 1 到 5 之间");

    buttonByKey(view.tree, "auto.pending.undo").onClick();
    await view.settle();
    const posts = host.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].target, "/projects/p1/auto-undo");
    assert.deepEqual(posts[0].body, { taskId: "t-1" });
    assert.equal(byAttr(view.tree, "data-wb-auto-pending", "true"), null, "撤销后重读，挂起项消失");
  } finally { host.restore(); }
});

test("宿主拒绝时把原因显示出来，且确认条保留可重试", async () => {
  const host = fakeHost();
  try {
    const { view } = await mountPanel(host);
    byAttr(view.tree, "data-tier", "L3").onClick();
    await view.settle();
    host.rejectWith("需要确认");
    buttonByKey(view.tree, "auto.confirm.ok").onClick();
    await view.settle();
    assert.match(texts(view.tree), /auto\.fail/);
    assert.match(texts(view.tree), /需要确认/, "失败原因不能吞");
    assert.equal(byAttr(view.tree, "data-tier", "L3")["data-on"], "false", "没存成，档位不变");
  } finally { host.restore(); }
});

test("审计：最近的在前，只取最后 8 条；空时显示空态", async () => {
  const entries = [];
  for (let i = 0; i < 10; i += 1) {
    entries.push({ at: new Date(2026, 10, 18, 9, i).toISOString(), kind: "dispatch", outcome: "ok", reason: "r" + i, taskId: "t" + i });
  }
  const host = fakeHost({ audit: entries });
  try {
    const { view } = await mountPanel(host);
    const rows = find(view.tree, (n) => n.props.className === "daw-wb-kv");
    assert.equal(rows.length, 8);
    assert.match(texts(rows[0]), /r9/, "第一行是最新的");
    assert.match(texts(rows[7]), /r2/);
  } finally { host.restore(); }
  const empty = fakeHost();
  try {
    const { view } = await mountPanel(empty);
    assert.match(texts(view.tree), /auto\.audit\.empty/);
  } finally { empty.restore(); }
});

test("wbAutoSecondsLeft：向上取整，过期与非数字都按 0，不出现负数", () => {
  const { wbAutoSecondsLeft } = loadPlugin().plugin.__test;
  assert.equal(wbAutoSecondsLeft(10_000, 5_100), 5);
  assert.equal(wbAutoSecondsLeft(10_000, 9_999), 1);
  assert.equal(wbAutoSecondsLeft(10_000, 10_000), 0);
  assert.equal(wbAutoSecondsLeft(10_000, 20_000), 0);
  assert.equal(wbAutoSecondsLeft(undefined, 1), 0);
});
