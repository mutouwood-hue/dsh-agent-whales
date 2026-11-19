// 需求主线 P5b：E2E 配置、任务全部完工后自动建运行、交给执行器、返工后自动重跑（真 HTTP）。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body-1234567890")]);

async function boot() {
  const routes = [];
  const followups = [];
  const tools = {};
  const offline = new Set();
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return { list: () => [], get: (id) => (["session-a", "session-b", "session-exec"].includes(id) ? { id, title: id, running: true, session: { id } } : undefined) };
      if (name === "agents") return {
        get: (id) => (offline.has(id) ? undefined : { id, status: "running", session: { id }, followup: (message) => { followups.push({ to: id, text: message && message.content && message.content[0] ? message.content[0].text : "" }); } }),
        list: () => []
      };
      if (name === "sessionPersistence") return { stat: () => undefined };
      if (name === "tools") return { register: (tool) => { tools[tool.name] = tool; return () => {}; }, schemas: () => [] };
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
  return { call, close, followups, tools, offline };
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "aw-autorun-"));
  plugin.setProjectStorePathForTests(join(dir, "projects.json"));
  plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
  plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  plugin.setEventsStorePathForTests(join(dir, "events.json"));
  return dir;
}

async function base() {
  const dir = freshStore();
  const app = await boot();
  const token = (await app.call("GET", "/activity")).body.controlToken;
  const projectId = (await app.call("POST", "/projects", { name: "自动验收项目", mainSessionId: "session-a" }, token)).body.data.project.projectId;
  await app.call("POST", `/projects/${projectId}/members`, { sessionId: "session-b" }, token);
  await app.call("POST", `/projects/${projectId}/members`, { sessionId: "session-exec" }, token);
  return { dir, app, token, projectId, b: `/projects/${projectId}` };
}

/** 需求 + 已确认设计 v1 + 两个任务（负责人 session-b），都还没报完工。 */
async function withRequirement(c, tasks) {
  const req = (await c.app.call("POST", `${c.b}/requirements`, { title: "表单导入", acceptance: ["上传并识别表头", "未匹配字段给建议"] }, c.token)).body.data.requirement;
  const canvas = await c.app.call("GET", `/canvas?projectId=${c.projectId}`);
  await c.app.call("POST", "/canvas/elements", { projectId: c.projectId, expectedRevision: canvas.body.data.rev, upsert: [{ id: "proto:main", kind: "prototype", data: { requirementId: req.reqId, title: "导入页", puck: { content: [{ type: "Heading", props: { text: "x" } }] } } }] }, c.token);
  assert.equal((await c.app.call("POST", `${c.b}/requirements/${req.reqId}/confirm-design`, { expectedRevision: req.revision }, c.token)).body.code, 200);
  const ids = [];
  for (let i = 0; i < (tasks || 2); i += 1) {
    const task = (await c.app.call("POST", "/tasks", { projectId: c.projectId, subject: "T" + (i + 1), requirementId: req.reqId }, c.token)).body.data.task;
    assert.equal((await c.app.call("POST", `/tasks/${task.taskId}/commands`, { projectId: c.projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "as-" + i }, c.token)).body.code, 200);
    ids.push(task.taskId);
  }
  return { req, ids, runs: `${c.b}/requirements/${req.reqId}/e2e` };
}
async function done(c, taskId) {
  const task = (await c.app.call("GET", `/tasks?projectId=${c.projectId}`)).body.data.tasks.find((row) => row.taskId === taskId);
  const res = await c.app.call("PUT", `/tasks/${taskId}/report`, { projectId: c.projectId, expectedRevision: task.revision, report: { status: "done", summary: "ok" } }, c.token);
  assert.equal(res.body.code, 200, JSON.stringify(res.body));
  return res.body.data;
}
const runsOf = async (c, w) => (await c.app.call("GET", w.runs)).body.data.runs;
const reqView = async (c, w) => (await c.app.call("GET", `${c.b}/requirements/${w.req.reqId}`)).body.data.requirement;

test("E2E 配置：默认自动触发 + 手动驱动；改配置要 token；校验执行器必须是成员 / 被测地址必须是 http(s) / 非手动驱动要有执行器", async () => {
  const c = await base();
  try {
    const def = await c.app.call("GET", `${c.b}/e2e-config`);
    assert.deepEqual(def.body.data.config, { trigger: "auto", driver: "manual", executorSessionId: "", baseUrl: "" });
    assert.deepEqual((await c.app.call("GET", c.b)).body.data.project.e2eConfig, def.body.data.config, "项目视图也带配置");
    assert.equal((await c.app.call("PUT", `${c.b}/e2e-config`, { trigger: "manual" })).body.code, 40301);
    assert.equal((await c.app.call("PUT", `${c.b}/e2e-config`, "bad", c.token)).status, 400);
    assert.equal((await c.app.call("PUT", `${c.b}/e2e-config`, { trigger: "sometimes" }, c.token)).body.code, 40000);
    assert.match((await c.app.call("PUT", `${c.b}/e2e-config`, { executorSessionId: "stranger" }, c.token)).body.msg, /project member/);
    assert.match((await c.app.call("PUT", `${c.b}/e2e-config`, { baseUrl: "javascript:alert(1)" }, c.token)).body.msg, /baseUrl/);
    assert.match((await c.app.call("PUT", `${c.b}/e2e-config`, { driver: "tabbit-cli" }, c.token)).body.msg, /needs an executorSessionId/);
    const ok = await c.app.call("PUT", `${c.b}/e2e-config`, { driver: "tabbit-cli", executorSessionId: "session-exec", baseUrl: "http://127.0.0.1:3250" }, c.token);
    assert.equal(ok.body.code, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.config, { trigger: "auto", driver: "tabbit-cli", executorSessionId: "session-exec", baseUrl: "http://127.0.0.1:3250" });
    assert.equal((await c.app.call("PUT", `${c.b}/e2e-config`, { trigger: "manual" }, c.token)).body.data.config.driver, "tabbit-cli", "只改触发方式不动别的");
    assert.equal((await c.app.call("GET", "/projects/proj-nope/e2e-config")).body.code, 40401);
    assert.equal((await c.app.call("DELETE", `${c.b}/e2e-config`, undefined, c.token)).status, 405);
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("自动触发：最后一个任务报完工才建运行；先报的不建；已确认设计的版本记在运行上；手动驱动不通知任何人", async () => {
  const c = await base();
  try {
    const w = await withRequirement(c);
    const first = await done(c, w.ids[0]);
    assert.equal(first.e2eRun, undefined, "还有任务没完工，不建");
    assert.deepEqual(await runsOf(c, w), []);
    const last = await done(c, w.ids[1]);
    assert.ok(last.e2eRun, "最后一个任务完工 → 自动建运行");
    assert.equal(last.e2eRun.driver, "manual");
    assert.equal(last.e2eRun.delivered, undefined, "手动驱动没有执行器，不通知");
    const runs = await runsOf(c, w);
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].status, runs[0].total, runs[0].designVersion], ["queued", 2, 1]);
    assert.equal(c.app.followups.length, 0);
    assert.equal((await reqView(c, w)).stage, "accept", "任务全完工、运行没结论 → 验收");
    // 再有 report（改写 summary）不会重复建：已有没结束的运行
    await done(c, w.ids[1]);
    assert.equal((await runsOf(c, w)).length, 1);
    // 完工后又写一条 draft（不是完工）：任务不再算完工，不会触发，也不会因此多建
    const t1 = (await c.app.call("GET", `/tasks?projectId=${c.projectId}`)).body.data.tasks.find((row) => row.taskId === w.ids[0]);
    const redraft = await c.app.call("PUT", `/tasks/${w.ids[0]}/report`, { projectId: c.projectId, expectedRevision: t1.revision, report: { status: "draft", summary: "又改了" } }, c.token);
    assert.equal(redraft.body.data.e2eRun, undefined);
    assert.equal((await runsOf(c, w)).length, 1);
    // 运行记录来源标 auto
    const detail = (await c.app.call("GET", `${c.b}/e2e/${runs[0].runId}`)).body.data.run;
    assert.equal(detail.createdBy, "auto");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("自动触发的不该触发情形：手动触发 / 设计有待确认的改动 / 非完工的 report / 没归需求的任务 / 已跑过且没回流", async () => {
  const c = await base();
  try {
    // 手动触发
    await c.app.call("PUT", `${c.b}/e2e-config`, { trigger: "manual" }, c.token);
    const w = await withRequirement(c, 1);
    assert.equal((await done(c, w.ids[0])).e2eRun, undefined);
    assert.deepEqual(await runsOf(c, w), []);
    await c.app.call("PUT", `${c.b}/e2e-config`, { trigger: "auto" }, c.token);

    // 非完工状态的 report 不触发（draft）
    const t2 = (await c.app.call("POST", "/tasks", { projectId: c.projectId, subject: "T2", requirementId: w.req.reqId }, c.token)).body.data.task;
    const draft = await c.app.call("PUT", `/tasks/${t2.taskId}/report`, { projectId: c.projectId, expectedRevision: 1, report: { status: "draft", summary: "写了一半" } }, c.token);
    assert.equal(draft.body.data.e2eRun, undefined);
    // 设计有待确认的改动：任务全完工也不跑
    const canvas = await c.app.call("GET", `/canvas?projectId=${c.projectId}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await c.app.call("POST", "/canvas/elements", { projectId: c.projectId, expectedRevision: canvas.body.data.rev, upsert: [{ id: "proto:main", kind: "prototype", data: { requirementId: w.req.reqId, title: "导入页（改）", puck: { content: [{ type: "Heading", props: { text: "改了" } }] } } }] }, c.token);
    await c.app.call("POST", `/tasks/${t2.taskId}/commands`, { projectId: c.projectId, action: "assign", owner: "session-b", expectedRevision: 2, requestId: "as-t2" }, c.token);
    const t2Now = (await c.app.call("GET", `/tasks?projectId=${c.projectId}`)).body.data.tasks.find((row) => row.taskId === t2.taskId);
    const blocked = await c.app.call("PUT", `/tasks/${t2.taskId}/report`, { projectId: c.projectId, expectedRevision: t2Now.revision, report: { status: "done", summary: "ok" } }, c.token);
    assert.equal(blocked.body.data.e2eRun, undefined, "设计没确认，不自动跑");
    assert.equal((await reqView(c, w)).stage, "design");

    // 没归需求的任务完工：不触发
    const orphan = (await c.app.call("POST", "/tasks", { projectId: c.projectId, subject: "老任务" }, c.token)).body.data.task;
    const o = await c.app.call("PUT", `/tasks/${orphan.taskId}/report`, { projectId: c.projectId, expectedRevision: 1, report: { status: "done", summary: "ok" } }, c.token);
    assert.equal(o.body.data.e2eRun, undefined);
    assert.deepEqual(await runsOf(c, w), []);

    // 重新确认设计后，手动触发的方式下依然不会自己跑；切回自动，再报一次完工才跑；跑过且没回流不重复
    const confirmed = await c.app.call("POST", `${c.b}/requirements/${w.req.reqId}/confirm-design`, { expectedRevision: (await reqView(c, w)).revision }, c.token);
    assert.equal(confirmed.body.code, 200, JSON.stringify(confirmed.body));
    const again = await done(c, t2.taskId);
    assert.ok(again.e2eRun, "设计确认后、任务全完工、自动触发 → 建运行");
    const runId = (await runsOf(c, w))[0].runId;
    for (const caseId of ["c1", "c2"]) await c.app.call("PUT", `${c.b}/e2e/${runId}/results/${caseId}`, { status: "passed" }, c.token);
    await c.app.call("POST", `${c.b}/e2e/${runId}/finish`, {}, c.token);
    assert.equal((await done(c, t2.taskId)).e2eRun, undefined, "已经跑过且通过，再报完工不重复跑");
    assert.equal((await runsOf(c, w)).length, 1);
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("交给执行器：非手动驱动 + 配了执行器 → 运行建出后消息真发给执行器（带运行 / 用例 / 被测地址 / 上报方式）；不在线如实说", async () => {
  const c = await base();
  try {
    assert.equal((await c.app.call("PUT", `${c.b}/e2e-config`, { driver: "tabbit-cli", executorSessionId: "session-exec", baseUrl: "http://127.0.0.1:3250" }, c.token)).body.code, 200);
    const w = await withRequirement(c, 1);
    const res = await done(c, w.ids[0]);
    assert.equal(res.e2eRun.driver, "tabbit-cli");
    assert.deepEqual([res.e2eRun.delivered.sessionId, res.e2eRun.delivered.status], ["session-exec", "sent"]);
    assert.equal(c.app.followups.length, 1);
    const text = c.app.followups[0].text;
    assert.equal(c.app.followups[0].to, "session-exec");
    assert.match(text, new RegExp("运行 " + res.e2eRun.runId));
    assert.match(text, /需求「表单导入」 · 设计版本 v1 · 驱动 tabbit-cli/);
    assert.match(text, /被测地址：http:\/\/127\.0\.0\.1:3250/);
    assert.match(text, /c1\s+上传并识别表头/);
    assert.match(text, /whales_e2e_report/);
    const handoffs = (await c.app.call("GET", `/handoffs?projectId=${c.projectId}`)).body.data.entries;
    assert.ok(handoffs.some((h) => h.kind === "e2e-run" && h.to === "session-exec" && h.runId === res.e2eRun.runId), "进发送记录");
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }

  const c2 = await base();
  try {
    await c2.app.call("PUT", `${c2.b}/e2e-config`, { driver: "computer-use", executorSessionId: "session-exec" }, c2.token);
    const w = await withRequirement(c2, 1);
    c2.app.offline.add("session-exec");
    const res = await done(c2, w.ids[0]);
    assert.deepEqual([res.e2eRun.delivered.status, res.e2eRun.delivered.reason], ["failed", "not-running"], "执行器不在线如实说没送到");
    assert.equal((await runsOf(c2, w)).length, 1, "运行已建出，可以手动唤醒执行器");
    assert.equal(c2.app.followups.length, 0);
  } finally { await c2.app.close(); rmSync(c2.dir, { recursive: true, force: true }); }
});

test("闭环：自动建运行 → 执行器上报失败 → 人回流 → 返工任务再完工 → 自动重跑 → 通过；每一步需求阶段都对", async () => {
  const c = await base();
  const scratch = mkdtempSync(join(tmpdir(), "aw-shots-"));
  try {
    assert.equal((await c.app.call("PUT", `${c.b}/e2e-config`, { driver: "tabbit-cli", executorSessionId: "session-exec" }, c.token)).body.code, 200);
    const w = await withRequirement(c, 1);
    const tool = c.app.tools.whales_e2e_report;
    const asExec = { agent: { id: "session-exec" } };
    const shot = join(scratch, "step3.png");
    writeFileSync(shot, PNG);

    // 1) 任务完工 → 自动建运行 → 通知执行器
    const first = await done(c, w.ids[0]);
    const run1 = first.e2eRun.runId;
    assert.equal((await reqView(c, w)).stage, "accept");
    // 2) 执行器上报：c1 通过，c2 失败（初判 code）并结束
    await tool.execute({ runId: run1, caseId: "c1", status: "passed" }, asExec);
    const reported = await tool.execute({ runId: run1, caseId: "c2", status: "failed", note: "找不到映射建议", diagnosis: { kind: "code", reason: "实现缺失" }, shots: [shot], finish: true }, asExec);
    assert.equal(reported.runStatus, "failed");
    let view = await reqView(c, w);
    assert.equal(view.stage, "mismatch");
    assert.equal(view.attention, "e2e-mismatch");
    // 3) 人批注 + 回流：任务重开、需求回到开发、等重跑
    await c.app.call("POST", `${c.b}/e2e/${run1}/annotations`, { caseId: "c2", shot: "step3.png", rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, expected: "显示建议下拉" }, c.token);
    const reflow = await c.app.call("POST", `${c.b}/e2e/${run1}/reflow`, {}, c.token);
    assert.equal(reflow.body.code, 200, JSON.stringify(reflow.body));
    view = await reqView(c, w);
    assert.equal(view.stage, "develop");
    assert.equal(view.rerunPending, true);
    assert.equal(view.reworkCount, 1);
    // 回流只重开了任务，不会立刻建运行（任务还没重新完工）
    assert.equal((await runsOf(c, w)).length, 1);
    // 4) 返工任务再完工 → 自动重跑（因为 rerunPending，即使对当前版本已有失败的运行）
    const again = await done(c, w.ids[0]);
    assert.ok(again.e2eRun, "返工完成 → 自动重跑");
    assert.notEqual(again.e2eRun.runId, run1);
    assert.equal(again.e2eRun.delivered.status, "sent", "重跑也通知执行器");
    view = await reqView(c, w);
    assert.equal(view.rerunPending, false, "新建运行清掉待重跑标记");
    assert.equal(view.stage, "accept");
    // 5) 这一轮全部通过 → 需求通过、待办消失；之后再报完工不会重复跑
    const run2 = again.e2eRun.runId;
    await tool.execute({ runId: run2, caseId: "c1", status: "passed" }, asExec);
    await tool.execute({ runId: run2, caseId: "c2", status: "passed", finish: true }, asExec);
    view = await reqView(c, w);
    assert.equal(view.stage, "passed");
    assert.deepEqual((await c.app.call("GET", `/inbox?projectId=${c.projectId}`)).body.data.groups.find((g) => g.key === "requirements").items, []);
    assert.equal((await done(c, w.ids[0])).e2eRun, undefined);
    assert.equal((await runsOf(c, w)).length, 2);
  } finally {
    await c.app.close();
    rmSync(c.dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("手动建运行也会清掉「待重跑」标记：回流后人手动开一轮，之后任务完工不再多开一轮", async () => {
  const c = await base();
  try {
    await c.app.call("PUT", `${c.b}/e2e-config`, { trigger: "manual" }, c.token);
    const w = await withRequirement(c, 1);
    await done(c, w.ids[0]);
    const run = (await c.app.call("POST", w.runs, {}, c.token)).body.data.run;
    await c.app.call("PUT", `${c.b}/e2e/${run.runId}/results/c1`, { status: "failed", note: "x", diagnosis: { kind: "code", reason: "x" } }, c.token);
    await c.app.call("PUT", `${c.b}/e2e/${run.runId}/results/c2`, { status: "passed" }, c.token);
    await c.app.call("POST", `${c.b}/e2e/${run.runId}/finish`, {}, c.token);
    assert.equal((await c.app.call("POST", `${c.b}/e2e/${run.runId}/reflow`, {}, c.token)).body.code, 200);
    assert.equal((await reqView(c, w)).rerunPending, true);
    await done(c, w.ids[0]);
    const manual = await c.app.call("POST", w.runs, {}, c.token);
    assert.equal(manual.body.code, 200, JSON.stringify(manual.body));
    assert.equal((await reqView(c, w)).rerunPending, false);
  } finally { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }); }
});
