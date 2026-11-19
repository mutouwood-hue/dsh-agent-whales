// 需求主线 P5a：批注 / 可接受 / 回流（真 HTTP）——重开任务、拉回设计、记到需求、返工计数与上限、消息真的发给负责人 / Composer。
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
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return { list: () => [], get: (id) => (["session-a", "session-b"].includes(id) ? { id, title: id, running: true, session: { id } } : undefined) };
      if (name === "agents") return {
        get: (id) => (offline.has(id) ? undefined : { id, status: "running", session: { id }, followup: (message) => { followups.push({ to: id, text: message && message.content && message.content[0] ? message.content[0].text : "", source: message && message.source }); } }),
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
  const dir = mkdtempSync(join(tmpdir(), "aw-reflow-"));
  plugin.setProjectStorePathForTests(join(dir, "projects.json"));
  plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
  plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  plugin.setEventsStorePathForTests(join(dir, "events.json"));
  return dir;
}

/** 项目 + 已确认设计 v1 + 一个已报完工的任务（负责人 session-b）+ 一个需求。 */
async function setup() {
  const dir = freshStore();
  const app = await boot();
  const token = (await app.call("GET", "/activity")).body.controlToken;
  const projectId = (await app.call("POST", "/projects", { name: "回流项目", mainSessionId: "session-a" }, token)).body.data.project.projectId;
  await app.call("POST", `/projects/${projectId}/members`, { sessionId: "session-b" }, token);
  const b = `/projects/${projectId}`;
  const req = (await app.call("POST", `${b}/requirements`, { title: "表单导入", acceptance: ["上传并识别表头", "未匹配字段给建议"] }, token)).body.data.requirement;
  const canvas = await app.call("GET", `/canvas?projectId=${projectId}`);
  await app.call("POST", "/canvas/elements", { projectId, expectedRevision: canvas.body.data.rev, upsert: [{ id: "proto:main", kind: "prototype", data: { requirementId: req.reqId, title: "导入页", puck: { content: [{ type: "Heading", props: { text: "x" } }] } } }] }, token);
  const confirmed = await app.call("POST", `${b}/requirements/${req.reqId}/confirm-design`, { expectedRevision: req.revision }, token);
  assert.equal(confirmed.body.code, 200, JSON.stringify(confirmed.body));
  const task = (await app.call("POST", "/tasks", { projectId, subject: "T1 导入接口", requirementId: req.reqId }, token)).body.data.task;
  const assigned = await app.call("POST", `/tasks/${task.taskId}/commands`, { projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "assign-1" }, token);
  assert.equal(assigned.body.code, 200, JSON.stringify(assigned.body));
  const ctxo = { dir, app, token, projectId, b, req, taskId: task.taskId, runs: `${b}/requirements/${req.reqId}/e2e` };
  await markDone(ctxo);
  return ctxo;
}

async function taskOf(c) {
  return (await c.app.call("GET", `/tasks?projectId=${c.projectId}`)).body.data.tasks.find((row) => row.taskId === c.taskId);
}
async function markDone(c) {
  const task = await taskOf(c);
  const reported = await c.app.call("PUT", `/tasks/${c.taskId}/report`, { projectId: c.projectId, expectedRevision: task.revision, report: { status: "done", summary: "ok" } }, c.token);
  assert.equal(reported.body.code, 200, JSON.stringify(reported.body));
}
const reqView = async (c) => (await c.app.call("GET", `${c.b}/requirements/${c.req.reqId}`)).body.data.requirement;

/** 建一轮运行：c1 通过，c2 失败（带诊断 + 一张截图）→ 结束。返回运行视图。 */
async function failedRun(c, diagnosis, extra) {
  const run = (await c.app.call("POST", c.runs, {}, c.token)).body.data.run;
  const rb = `${c.b}/e2e/${run.runId}`;
  await c.app.call("POST", `${rb}/shots/c2`, { name: "step3.png", data: PNG.toString("base64") }, c.token);
  await c.app.call("PUT", `${rb}/results/c1`, { status: "passed" }, c.token);
  await c.app.call("PUT", `${rb}/results/c2`, { status: "failed", note: "找不到映射建议", ...(diagnosis ? { diagnosis } : {}) }, c.token);
  const done = await c.app.call("POST", `${rb}/finish`, {}, c.token);
  assert.equal(done.body.code, 200, JSON.stringify(done.body));
  return Object.assign({ runId: run.runId, rb }, extra || {});
}

test("批注：框 / 文字 / 校验 / 删除；运行结束后也能批注；已回流的不能删", async () => {
  const c = await setup();
  try {
    const run = await failedRun(c, { kind: "code", reason: "实现缺失" });
    const url = `${run.rb}/annotations`;
    const rect = { x: 0.1, y: 0.25, w: 0.5, h: 0.1 };
    assert.equal((await c.app.call("POST", url, { caseId: "c2", shot: "step3.png", rect, expected: "显示建议" })).body.code, 40301);
    const one = await c.app.call("POST", url, { caseId: "c2", shot: "step3.png", rect, expected: "显示建议下拉" }, c.token);
    assert.equal(one.body.code, 200, JSON.stringify(one.body));
    assert.match(one.body.data.annotation.annId, /^a[0-9a-f]{8}$/);
    assert.equal(one.body.data.annotation.handled, false);
    assert.deepEqual(one.body.data.run.annotations.map((a) => a.expected), ["显示建议下拉"]);
    const text = await c.app.call("POST", url, { caseId: "c2", expected: "开关和按钮同一行" }, c.token);
    assert.equal(text.body.code, 200);
    // 校验
    assert.equal((await c.app.call("POST", url, { caseId: "c1", expected: "x" }, c.token)).status, 400, "通过的用例不能批注");
    assert.equal((await c.app.call("POST", url, { caseId: "c2", expected: "" }, c.token)).status, 400);
    assert.equal((await c.app.call("POST", url, { caseId: "c2", shot: "nope.png", expected: "x" }, c.token)).status, 400);
    assert.equal((await c.app.call("POST", url, { caseId: "c2", shot: "step3.png", rect: { x: 0.9, y: 0, w: 0.5, h: 0.5 }, expected: "x" }, c.token)).status, 400);
    assert.equal((await c.app.call("POST", url, "bad", c.token)).status, 400);
    assert.equal((await c.app.call("POST", `${c.b}/e2e/run-nope1234/annotations`, { caseId: "c2", expected: "x" }, c.token)).body.code, 40401);
    // 删除：没 token 不行；删得掉；回流之后删不掉
    const annId = text.body.data.annotation.annId;
    assert.equal((await c.app.call("DELETE", `${url}/${annId}`)).body.code, 40301);
    assert.equal((await c.app.call("DELETE", `${url}/${annId}`, undefined, c.token)).body.data.run.annotations.length, 1);
    assert.equal((await c.app.call("DELETE", `${url}/${annId}`, undefined, c.token)).body.code, 40000, "已经删了");
    assert.equal((await c.app.call("POST", `${run.rb}/reflow`, {}, c.token)).body.code, 200);
    const kept = one.body.data.annotation.annId;
    assert.match((await c.app.call("DELETE", `${url}/${kept}`, undefined, c.token)).body.msg, /already sent back/);
    assert.equal((await c.app.call("GET", url)).status, 405);
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("可接受：只能人在运行结束后标；全部可接受 → 整轮通过、需求通过、待办消失", async () => {
  const c = await setup();
  try {
    const run = (await c.app.call("POST", c.runs, {}, c.token)).body.data.run;
    const rb = `${c.b}/e2e/${run.runId}`;
    await c.app.call("PUT", `${rb}/results/c1`, { status: "passed" }, c.token);
    await c.app.call("PUT", `${rb}/results/c2`, { status: "failed", note: "x" }, c.token);
    assert.match((await c.app.call("POST", `${rb}/results/c2/accept`, undefined, c.token)).body.msg, /finish the run/, "没结束不能标");
    await c.app.call("POST", `${rb}/finish`, {}, c.token);
    assert.equal((await reqView(c)).stage, "mismatch");
    assert.equal((await c.app.call("POST", `${rb}/results/c2/accept`)).body.code, 40301);
    assert.match((await c.app.call("POST", `${rb}/results/c1/accept`, undefined, c.token)).body.msg, /only a failed/);
    assert.equal((await c.app.call("POST", `${rb}/results/c9/accept`, undefined, c.token)).body.code, 40000);
    const accepted = await c.app.call("POST", `${rb}/results/c2/accept`, undefined, c.token);
    assert.equal(accepted.body.code, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.run.status, "passed");
    assert.equal(accepted.body.data.run.results[1].status, "accepted");
    assert.equal(accepted.body.data.run.summary.accepted, 1);
    const view = await reqView(c);
    assert.equal(view.stage, "passed");
    assert.equal(view.attention, null);
    assert.deepEqual((await c.app.call("GET", `/inbox?projectId=${c.projectId}`)).body.data.groups.find((g) => g.key === "requirements").items, []);
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("回流·实现问题：重开已完工任务（保留负责人）、写 feedback、消息真发给负责人、需求回到开发、返工 +1、标已回流", async () => {
  const c = await setup();
  try {
    const run = await failedRun(c, { kind: "code", reason: "映射建议没出现" });
    await c.app.call("POST", `${run.rb}/annotations`, { caseId: "c2", shot: "step3.png", rect: { x: 0.1, y: 0.25, w: 0.5, h: 0.1 }, expected: "显示建议下拉" }, c.token);
    assert.equal((await reqView(c)).stage, "mismatch");
    assert.equal((await c.app.call("POST", `${run.rb}/reflow`, {})).body.code, 40301, "没 token 不能回流");

    const res = await c.app.call("POST", `${run.rb}/reflow`, {}, c.token);
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.reopenedTaskIds, [c.taskId]);
    assert.deepEqual(res.body.data.delivered.map((d) => [d.sessionId, d.role, d.status]), [["session-b", "owner", "sent"]]);
    // 消息内容：事实、版本、框位置、证据文件；来源是人
    assert.equal(c.app.followups.length, 1);
    const sent = c.app.followups[0];
    assert.equal(sent.to, "session-b");
    assert.match(sent.text, /需求「表单导入」/);
    assert.match(sent.text, /设计版本 v1/);
    assert.match(sent.text, /预期：显示建议下拉（step3\.png 上 x10% y25% 宽50% 高10%）/);
    assert.match(sent.text, /证据文件：step3\.png/);
    assert.equal(sent.source && sent.source.kind, "user");
    // 任务：重开、保留负责人、report 改回 draft、带 feedback
    const task = await taskOf(c);
    assert.equal(task.status, "in_progress");
    assert.equal(task.ownerSessionId, "session-b");
    assert.equal(task.report.status, "draft");
    assert.equal(task.feedback.runId, run.runId);
    assert.equal(task.feedback.designVersion, 1);
    assert.match(task.feedback.text, /映射建议没出现/);
    // 需求：回到开发、返工 +1、记录回流、等重跑
    const view = await reqView(c);
    assert.equal(view.stage, "develop");
    assert.equal(view.reworkCount, 1);
    assert.equal(view.rerunPending, true);
    assert.deepEqual(view.feedback.map((f) => [f.runId, f.to, f.caseIds]), [[run.runId, "code", ["c2"]]]);
    // 运行：用例与批注标已回流，不能重复回流
    const detail = (await c.app.call("GET", run.rb)).body.data.run;
    assert.equal(detail.results[1].reflowed, true);
    assert.equal(detail.results[1].reflowedTo, "code");
    assert.equal(detail.annotations[0].handled, true);
    assert.equal(detail.reflows.length, 1);
    assert.deepEqual(detail.reflows[0].taskIds, [c.taskId]);
    assert.match((await c.app.call("POST", `${run.rb}/reflow`, {}, c.token)).body.msg, /no failed case left/);
    // 交接账本里有这次回流
    const handoffs = (await c.app.call("GET", `/handoffs?projectId=${c.projectId}`)).body.data.entries;
    assert.ok(handoffs.some((h) => h.kind === "reflow" && h.to === "session-b" && h.runId === run.runId), "回流消息要进发送记录");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("回流·设计问题 / 需求问题：作废设计确认回到设计、发给 Composer；owner 不在线时如实说没送到但状态已落", async () => {
  const c = await setup();
  try {
    // 设计问题
    const r1 = await failedRun(c, { kind: "design", reason: "设计稿缺了空态" });
    const d = await c.app.call("POST", `${r1.rb}/reflow`, {}, c.token);
    assert.equal(d.body.code, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.data.reopenedTaskIds, [], "设计问题不重开任务");
    assert.deepEqual(d.body.data.delivered.map((x) => [x.sessionId, x.role, x.status]), [["session-a", "composer", "sent"]], "发给该需求的 Composer（缺省主对话）");
    let view = await reqView(c);
    assert.equal(view.stage, "design", "设计确认被作废，回到设计");
    assert.equal(view.attention, "confirm-design");
    assert.equal(view.reworkCount, 1);
    assert.equal(view.designVersion, 1, "版本号不回退，只是要重新确认");
    // 重新确认后继续；需求问题；Composer 不在线
    const again = await c.app.call("POST", `${c.b}/requirements/${c.req.reqId}/confirm-design`, { expectedRevision: view.revision }, c.token);
    assert.equal(again.body.code, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.requirement.designVersion, 2);
    const r2 = await failedRun(c, { kind: "requirement", reason: "验收点本身有歧义" });
    c.app.offline.add("session-a");
    const q = await c.app.call("POST", `${r2.rb}/reflow`, {}, c.token);
    assert.equal(q.body.code, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.data.delivered.map((x) => [x.role, x.status, x.reason]), [["composer", "failed", "not-running"]], "没送到就如实说");
    view = await reqView(c);
    assert.equal(view.reworkCount, 2, "消息没送到，回流状态也已落库");
    assert.deepEqual(view.feedback.map((f) => f.to), ["design", "requirement"]);
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("回流：env 诊断不回流；显式 targets 覆盖诊断；taskIds 必须属于这次运行；没有完工任务可重开时拒绝且不改任何状态", async () => {
  const c = await setup();
  try {
    const env = await failedRun(c, { kind: "env", reason: "浏览器没起来" });
    assert.match((await c.app.call("POST", `${env.rb}/reflow`, {}, c.token)).body.msg, /environment problems/);
    assert.equal((await reqView(c)).reworkCount, 0, "被拒的回流不计返工");
    assert.match((await c.app.call("POST", `${env.rb}/reflow`, { targets: [{ caseId: "c9", to: "code" }] }, c.token)).body.msg, /not a failed case/);
    assert.match((await c.app.call("POST", `${env.rb}/reflow`, { targets: [{ caseId: "c2", to: "moon" }] }, c.token)).body.msg, /each target needs/);
    assert.match((await c.app.call("POST", `${env.rb}/reflow`, { targets: [{ caseId: "c2", to: "code" }], taskIds: ["ptask-xxxx"] }, c.token)).body.msg, /taskIds must belong/);
    // 显式把 env 改判成 code
    const forced = await c.app.call("POST", `${env.rb}/reflow`, { targets: [{ caseId: "c2", to: "code" }] }, c.token);
    assert.equal(forced.body.code, 200, JSON.stringify(forced.body));
    assert.equal((await taskOf(c)).status, "in_progress");
    // 任务又被打回 draft（还没重新完工），这时再对新一轮回流 code：没有完工任务可重开 → 拒绝，且不计返工、不改状态
    const before = await reqView(c);
    const r2 = await failedRun(c, { kind: "code", reason: "x" });
    const refused = await c.app.call("POST", `${r2.rb}/reflow`, {}, c.token);
    assert.match(refused.body.msg, /no completed task to reopen/);
    const after = await reqView(c);
    assert.equal(after.reworkCount, before.reworkCount);
    assert.equal(after.revision, before.revision, "拒绝时需求记录一个字都没动");
    assert.equal((await c.app.call("GET", r2.rb)).body.data.run.results[1].reflowed, undefined);
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("返工上限：到了上限不再自动回流，转人工（待办变成「返工超限」）；上限按需求自己的设置", async () => {
  const c = await setup();
  try {
    await c.app.call("PATCH", `${c.b}/requirements/${c.req.reqId}`, { expectedRevision: (await reqView(c)).revision, reworkCap: 2 }, c.token);
    for (let i = 1; i <= 2; i += 1) {
      const run = await failedRun(c, { kind: "code", reason: "第 " + i + " 次" });
      const ok = await c.app.call("POST", `${run.rb}/reflow`, {}, c.token);
      assert.equal(ok.body.code, 200, "第 " + i + " 次回流 " + JSON.stringify(ok.body));
      await markDone(c);
    }
    assert.equal((await reqView(c)).reworkCount, 2);
    const third = await failedRun(c, { kind: "code", reason: "第 3 次" });
    const blocked = await c.app.call("POST", `${third.rb}/reflow`, {}, c.token);
    assert.equal(blocked.body.code, 40000);
    assert.match(blocked.body.msg, /已返工 2 次（上限 2）/);
    assert.match(blocked.body.msg, /重新评审/);
    assert.deepEqual([blocked.body.data.reworkLimit, blocked.body.data.reworkCount, blocked.body.data.reworkCap], [true, 2, 2]);
    assert.equal((await taskOf(c)).report.status, "done", "被拒时任务不动");
    const view = await reqView(c);
    assert.equal(view.stage, "mismatch");
    assert.equal(view.attention, "rework-limit");
    const todo = (await c.app.call("GET", `/inbox?projectId=${c.projectId}`)).body.data.groups.find((g) => g.key === "requirements").items;
    assert.deepEqual(todo.map((i) => i.attention), ["rework-limit"]);
    // 人仍可以把它标成可接受，走出这个状态
    assert.equal((await c.app.call("POST", `${third.rb}/results/c2/accept`, undefined, c.token)).body.data.run.status, "passed");
    assert.equal((await reqView(c)).stage, "passed");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});
