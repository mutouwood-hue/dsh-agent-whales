// 需求主线·负责人：宿主路由（真 HTTP）——设置 / 更换 / 清除 / 成员校验 / 成员被移出时自动清除 / 回流收件人优先级 / 待办带负责人。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body-1234567890")]);

async function boot() {
  const routes = [];
  const followups = [];
  const offline = new Set();
  const known = ["session-a", "session-b", "session-c", "session-d"];
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return { list: () => [], get: (id) => (known.includes(id) ? { id, title: id, running: true, session: { id } } : undefined) };
      if (name === "agents") return {
        get: (id) => (offline.has(id) ? undefined : { id, status: "running", session: { id }, followup: (message) => { followups.push({ to: id, text: message && message.content && message.content[0] ? message.content[0].text : "" }); } }),
        list: () => []
      };
      if (name === "sessionPersistence") return { stat: () => undefined };
      if (name === "tools") return { register: () => () => {}, schemas: () => [] };
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  };
  plugin.apply(ctx);
  const route = routes.find((item) => item && typeof item.handler === "function");
  const server = createServer((req, res) => {
    Promise.resolve().then(() => route.handler(req, res)).catch((error) => { if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ code: 500, msg: String(error && error.message) })); } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/agent-whales/api`;
  async function call(method, path, body, token) {
    const headers = {};
    if (token) headers["x-whales-token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    if (timer && typeof timer.unref === "function") timer.unref();
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
    return { status: res.status, body: parsed };
  }
  const close = () => new Promise((resolve) => { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); server.close(() => resolve()); });
  return { call, close, followups, offline };
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "aw-owner-"));
  plugin.setProjectStorePathForTests(join(dir, "projects.json"));
  plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
  plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  plugin.setEventsStorePathForTests(join(dir, "events.json"));
  return dir;
}

/** 项目：main=session-a；成员 session-b、session-c；session-d 不在项目里。手动触发 E2E，避免自动建运行干扰。 */
async function setup() {
  const dir = freshStore();
  const app = await boot();
  const token = (await app.call("GET", "/activity")).body.controlToken;
  const projectId = (await app.call("POST", "/projects", { name: "负责人项目", mainSessionId: "session-a" }, token)).body.data.project.projectId;
  for (const id of ["session-b", "session-c"]) await app.call("POST", `/projects/${projectId}/members`, { sessionId: id }, token);
  const b = `/projects/${projectId}`;
  assert.equal((await app.call("PUT", `${b}/e2e-config`, { trigger: "manual" }, token)).body.code, 200);
  return { dir, app, token, projectId, b };
}
const mk = async (c, body) => (await c.app.call("POST", `${c.b}/requirements`, body, c.token));
const get = async (c, reqId) => (await c.app.call("GET", `${c.b}/requirements/${reqId}`)).body.data.requirement;
const patch = (c, reqId, body) => c.app.call("PATCH", `${c.b}/requirements/${reqId}`, body, c.token);

test("设置负责人：建需求时带 / 事后 PATCH；必须是项目成员（40703）；没 token 不行；视图和列表都带 ownerSessionId", async () => {
  const c = await setup();
  try {
    const withOwner = await mk(c, { title: "表单导入", ownerSessionId: "session-b" });
    assert.equal(withOwner.body.code, 200, JSON.stringify(withOwner.body));
    assert.equal(withOwner.body.data.requirement.ownerSessionId, "session-b");
    const none = await mk(c, { title: "没人负责" });
    assert.equal(none.body.data.requirement.ownerSessionId, "", "不给就是没有负责人（不会默认成主对话）");
    assert.equal((await mk(c, { title: "x", ownerSessionId: "session-d" })).body.code, 40703, "session-d 不在项目里");
    assert.equal((await mk(c, { title: "x", ownerSessionId: "ghost" })).body.code, 40703);
    assert.equal((await mk(c, { title: "x", ownerSessionId: 5 })).status, 400);

    const reqId = none.body.data.requirement.reqId;
    const rev = none.body.data.requirement.revision;
    assert.equal((await c.app.call("PATCH", `${c.b}/requirements/${reqId}`, { expectedRevision: rev, ownerSessionId: "session-c" })).body.code, 40301, "没 token");
    const set = await patch(c, reqId, { expectedRevision: rev, ownerSessionId: "session-c" });
    assert.equal(set.body.code, 200, JSON.stringify(set.body));
    assert.equal(set.body.data.requirement.ownerSessionId, "session-c");
    assert.equal(set.body.data.requirement.revision, rev + 1, "改负责人也走 CAS，revision +1");
    assert.equal((await get(c, reqId)).ownerSessionId, "session-c");
    const list = (await c.app.call("GET", `${c.b}/requirements`)).body.data.requirements;
    assert.deepEqual(list.filter((r) => !r.virtual).map((r) => [r.title, r.ownerSessionId]).sort(), [["没人负责", "session-c"], ["表单导入", "session-b"]]);
    // 非成员不能被设成负责人；失败不改任何东西
    const before = await get(c, reqId);
    assert.equal((await patch(c, reqId, { expectedRevision: before.revision, ownerSessionId: "session-d" })).body.code, 40703);
    const after = await get(c, reqId);
    assert.deepEqual([after.ownerSessionId, after.revision], [before.ownerSessionId, before.revision], "被拒时一个字都没动");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("更换 / 清除负责人：旧 revision 冲突；空串清除；null 与没给都不清除；改标题不会动负责人；虚拟「未归类」不可设", async () => {
  const c = await setup();
  try {
    const created = (await mk(c, { title: "A", ownerSessionId: "session-b" })).body.data.requirement;
    const stale = await patch(c, created.reqId, { expectedRevision: created.revision + 5, ownerSessionId: "session-c" });
    assert.equal(stale.body.code, 40902);
    assert.equal(stale.body.data.latestRevision, created.revision);
    const swapped = (await patch(c, created.reqId, { expectedRevision: created.revision, ownerSessionId: "session-c" })).body.data.requirement;
    assert.equal(swapped.ownerSessionId, "session-c");
    const titled = (await patch(c, created.reqId, { expectedRevision: swapped.revision, title: "A 改名" })).body.data.requirement;
    assert.equal(titled.ownerSessionId, "session-c", "没给 ownerSessionId：不清除");
    assert.equal((await patch(c, created.reqId, { expectedRevision: titled.revision, ownerSessionId: null })).status, 400, "null 不是清除");
    assert.equal((await get(c, created.reqId)).ownerSessionId, "session-c");
    const cleared = (await patch(c, created.reqId, { expectedRevision: titled.revision, ownerSessionId: "" })).body.data.requirement;
    assert.equal(cleared.ownerSessionId, "", "空串清除");
    assert.equal((await patch(c, "unassigned", { expectedRevision: 1, ownerSessionId: "session-b" })).body.code, 40000, "虚拟需求不可编辑");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("成员被移出项目：他负责的需求自动清除负责人（revision +1），别人的不动；主对话移不掉；移出后不能再被设成负责人", async () => {
  const c = await setup();
  try {
    const a = (await mk(c, { title: "A", ownerSessionId: "session-b" })).body.data.requirement;
    const bq = (await mk(c, { title: "B", ownerSessionId: "session-c" })).body.data.requirement;
    const free = (await mk(c, { title: "C" })).body.data.requirement;
    const mainRemoval = await c.app.call("DELETE", `${c.b}/members/session-a`, undefined, c.token);
    assert.notEqual(mainRemoval.body.code, 200, "主对话不能移出项目");
    assert.match(mainRemoval.body.msg, /main session cannot be removed/);
    assert.equal((await get(c, a.reqId)).ownerSessionId, "session-b", "移出被拒时，负责人也不能被改");
    const removed = await c.app.call("DELETE", `${c.b}/members/session-b`, undefined, c.token);
    assert.equal(removed.body.code, 200, JSON.stringify(removed.body));
    const a2 = await get(c, a.reqId);
    assert.equal(a2.ownerSessionId, "", "负责人被移出 → 清除，不留悬空");
    assert.equal(a2.revision, a.revision + 1);
    const b2 = await get(c, bq.reqId);
    assert.deepEqual([b2.ownerSessionId, b2.revision], ["session-c", bq.revision], "别人负责的不动");
    const f2 = await get(c, free.reqId);
    assert.equal(f2.revision, free.revision, "没有负责人的需求不动");
    assert.equal((await patch(c, a.reqId, { expectedRevision: a2.revision, ownerSessionId: "session-b" })).body.code, 40703, "已不是成员");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

/** 一个已确认设计的需求 + 一个已完工的任务（任务负责人可选）+ 一次失败的运行（诊断由参数给）。 */
async function failedSetup(c, { ownerSessionId, taskOwner, diagnosis }) {
  const req = (await mk(c, { title: "表单导入", acceptance: ["上传并识别表头", "未匹配字段给建议"], ...(ownerSessionId ? { ownerSessionId } : {}) })).body.data.requirement;
  const canvas = await c.app.call("GET", `/canvas?projectId=${c.projectId}`);
  await c.app.call("POST", "/canvas/elements", { projectId: c.projectId, expectedRevision: canvas.body.data.rev, upsert: [{ id: "proto:main", kind: "prototype", data: { requirementId: req.reqId, title: "页", puck: { content: [{ type: "Heading", props: { text: "x" } }] } } }] }, c.token);
  const fresh = await get(c, req.reqId);
  assert.equal((await c.app.call("POST", `${c.b}/requirements/${req.reqId}/confirm-design`, { expectedRevision: fresh.revision }, c.token)).body.code, 200);
  const task = (await c.app.call("POST", "/tasks", { projectId: c.projectId, subject: "T1", requirementId: req.reqId }, c.token)).body.data.task;
  if (taskOwner) assert.equal((await c.app.call("POST", `/tasks/${task.taskId}/commands`, { projectId: c.projectId, action: "assign", owner: taskOwner, expectedRevision: 1, requestId: "as-1" }, c.token)).body.code, 200);
  const cur = (await c.app.call("GET", `/tasks?projectId=${c.projectId}`)).body.data.tasks.find((row) => row.taskId === task.taskId);
  assert.equal((await c.app.call("PUT", `/tasks/${task.taskId}/report`, { projectId: c.projectId, expectedRevision: cur.revision, report: { status: "done", summary: "ok" } }, c.token)).body.code, 200);
  const run = (await c.app.call("POST", `${c.b}/requirements/${req.reqId}/e2e`, {}, c.token)).body.data.run;
  const rb = `${c.b}/e2e/${run.runId}`;
  await c.app.call("POST", `${rb}/shots/c2`, { name: "s.png", data: PNG.toString("base64") }, c.token);
  await c.app.call("PUT", `${rb}/results/c1`, { status: "passed" }, c.token);
  await c.app.call("PUT", `${rb}/results/c2`, { status: "failed", note: "找不到映射建议", diagnosis: { kind: diagnosis, reason: "x" } }, c.token);
  assert.equal((await c.app.call("POST", `${rb}/finish`, {}, c.token)).body.code, 200);
  return { req, rb, taskId: task.taskId };
}

test("回流收件人：设计 / 需求问题 → 负责人（优先于 Composer）；没有负责人 → Composer（原行为不变）；负责人不在线如实说没送到、不悄悄改发别人", async () => {
  for (const kind of ["design", "requirement"]) {
    const c = await setup();
    try {
      const withOwner = await failedSetup(c, { ownerSessionId: "session-c", diagnosis: kind });
      const res = await c.app.call("POST", `${withOwner.rb}/reflow`, {}, c.token);
      assert.equal(res.body.code, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data.delivered.map((d) => [d.sessionId, d.role, d.status]), [["session-c", "owner", "sent"]], kind + "：发给需求负责人而不是 Composer（主对话）");
      assert.equal(c.app.followups.length, 1);
      assert.equal(c.app.followups[0].to, "session-c");
      assert.match(c.app.followups[0].text, /需求「表单导入」/);
    } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
  }
  const c2 = await setup();
  try {
    const noOwner = await failedSetup(c2, { diagnosis: "design" });
    const res = await c2.app.call("POST", `${noOwner.rb}/reflow`, {}, c2.token);
    assert.deepEqual(res.body.data.delivered.map((d) => [d.sessionId, d.role, d.status]), [["session-a", "composer", "sent"]], "没有负责人：和以前一样发给 Composer（缺省主对话）");
  } finally { await c2.app.close(); rmSync(c2.dir, { recursive: true, force: true }); }
  const c3 = await setup();
  try {
    const off = await failedSetup(c3, { ownerSessionId: "session-c", diagnosis: "requirement" });
    c3.app.offline.add("session-c");
    const res = await c3.app.call("POST", `${off.rb}/reflow`, {}, c3.token);
    assert.equal(res.body.code, 200);
    assert.deepEqual(res.body.data.delivered.map((d) => [d.sessionId, d.role, d.status, d.reason]), [["session-c", "owner", "failed", "not-running"]], "负责人不在线：如实说没送到");
    assert.equal(c3.app.followups.length, 0, "不会悄悄改发给 Composer，否则「负责人」就成了摆设");
  } finally { await c3.app.close(); rmSync(c3.dir, { recursive: true, force: true }); }
});

test("回流收件人（实现问题）：有任务负责人 → 只发任务负责人；一个任务负责人都没有 → 发需求负责人；都没有 → 保持原行为（不发）", async () => {
  const c = await setup();
  try {
    const both = await failedSetup(c, { ownerSessionId: "session-c", taskOwner: "session-b", diagnosis: "code" });
    const res = await c.app.call("POST", `${both.rb}/reflow`, {}, c.token);
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.delivered.map((d) => [d.sessionId, d.role]), [["session-b", "owner"]], "任务负责人收到；需求负责人不重复打扰");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
  const c2 = await setup();
  try {
    const onlyReqOwner = await failedSetup(c2, { ownerSessionId: "session-c", diagnosis: "code" });
    const res = await c2.app.call("POST", `${onlyReqOwner.rb}/reflow`, {}, c2.token);
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.delivered.map((d) => [d.sessionId, d.role, d.status]), [["session-c", "requirement-owner", "sent"]], "没有任务负责人时，需求负责人兜底");
    assert.deepEqual(res.body.data.reopenedTaskIds, [onlyReqOwner.taskId], "任务照样重开");
  } finally { await c2.app.close(); rmSync(c2.dir, { recursive: true, force: true }); }
  const c3 = await setup();
  try {
    const nobody = await failedSetup(c3, { diagnosis: "code" });
    const res = await c3.app.call("POST", `${nobody.rb}/reflow`, {}, c3.token);
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.delivered, [], "没有任何负责人：和以前一样不发消息（状态已落库，可手动派发）");
  } finally { await c3.app.close(); rmSync(c3.dir, { recursive: true, force: true }); }
});

test("需要我处理的需求待办带负责人，便于界面显示与筛选；重启后负责人还在", async () => {
  const c = await setup();
  let second;
  try {
    const pending = await failedSetup(c, { ownerSessionId: "session-b", diagnosis: "code" });
    const items = (await c.app.call("GET", `/inbox?projectId=${c.projectId}`)).body.data.groups.find((g) => g.key === "requirements").items;
    assert.deepEqual(items.map((i) => [i.reqId, i.ownerSessionId]), [[pending.req.reqId, "session-b"]]);
    second = await boot();
    assert.equal((await second.call("GET", `${c.b}/requirements/${pending.req.reqId}`)).body.data.requirement.ownerSessionId, "session-b", "落盘了");
  } finally { await c.app.close(); if (second) await second.close(); rmSync(c.dir, { recursive: true, force: true }); }
});
