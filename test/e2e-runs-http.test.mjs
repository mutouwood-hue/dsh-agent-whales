// 需求主线 P4：E2E 运行的宿主路由与 whales_e2e_report 工具（真 HTTP + 真文件落盘）。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body-1234567890")]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("fake-webm-body-1234567890")]);

async function boot() {
  const routes = [];
  const tools = {};
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return { list: () => [], get: (id) => (["session-a", "session-b", "session-out"].includes(id) ? { id, title: id, running: true, session: { id } } : undefined) };
      if (name === "agents") return { get: (id) => ({ id, status: "running", session: { id } }), list: () => [] };
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
  async function call(method, path, body, token, raw) {
    const headers = {};
    if (token) headers["x-whales-token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    if (timer && typeof timer.unref === "function") timer.unref();
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
    return { status: res.status, body: parsed };
  }
  const close = () => new Promise((resolve) => { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); server.close(() => resolve()); });
  return { call, close, tools };
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "aw-e2e-run-"));
  plugin.setProjectStorePathForTests(join(dir, "projects.json"));
  plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
  plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  plugin.setEventsStorePathForTests(join(dir, "events.json"));
  return dir;
}

async function setup() {
  const dir = freshStore();
  const app = await boot();
  const token = (await app.call("GET", "/activity")).body.controlToken;
  const projectId = (await app.call("POST", "/projects", { name: "E2E 项目", mainSessionId: "session-a" }, token)).body.data.project.projectId;
  await app.call("POST", `/projects/${projectId}/members`, { sessionId: "session-b" }, token);
  const req = (await app.call("POST", `/projects/${projectId}/requirements`, { title: "表单导入", acceptance: ["上传并识别表头", "未匹配字段给建议"] }, token)).body.data.requirement;
  const b = `/projects/${projectId}`;
  return { dir, app, token, projectId, req, b, runs: `${b}/requirements/${req.reqId}/e2e` };
}

const filesIn = (dir, runId) => { try { return readdirSync(join(dir, "e2e", runId)).sort(); } catch (error) { return []; } };

test("E2E 运行：建 → 手动上报 → 传截图 → 结束 → 阶段联动；文件下发走白名单且带安全头", async () => {
  const { dir, app, token, projectId, req, b, runs } = await setup();
  try {
    // 没 token 不能建；缺省用验收点当用例
    assert.equal((await app.call("POST", runs, {})).body.code, 40301);
    const created = await app.call("POST", runs, {}, token);
    assert.equal(created.body.code, 200, JSON.stringify(created.body));
    const run = created.body.data.run;
    assert.match(run.runId, /^run-[a-z0-9]{8}$/);
    assert.equal(run.driver, "manual");
    assert.equal(run.status, "queued");
    assert.deepEqual(run.cases.map((c) => c.title), ["上传并识别表头", "未匹配字段给建议"]);
    assert.equal(run.designVersion, 0, "没确认过设计 = 版本 0");
    const rb = `${b}/e2e/${run.runId}`;

    // 同一需求已有没结束的运行 → 冲突并告诉是哪一个
    const dup = await app.call("POST", runs, {}, token);
    assert.equal(dup.body.code, 40701);
    assert.equal(dup.body.data.runId, run.runId);

    // 运行中：阶段推导看到的是「进行中」，不会误判通过
    const listed = await app.call("GET", runs);
    assert.deepEqual(listed.body.data.runs.map((r) => [r.runId, r.status, r.total, r.pending]), [[run.runId, "queued", 2, 2]]);

    // 上传截图（base64）：先传图，不出结论
    const shot = await app.call("POST", `${rb}/shots/c2`, { name: "Step 3 Actual.PNG", data: PNG.toString("base64") }, token);
    assert.equal(shot.body.code, 200, JSON.stringify(shot.body));
    assert.equal(shot.body.data.name, "step-3-actual.png", "文件名被收敛成安全名");
    assert.equal(shot.body.data.run.status, "running");
    assert.deepEqual(filesIn(dir, run.runId), ["step-3-actual.png"]);
    assert.equal(shot.body.data.run.results[1].status, "pending", "传图不等于出结论");

    // 手动标结果：c1 通过；c2 不符并带诊断
    const r1 = await app.call("PUT", `${rb}/results/c1`, { status: "passed" }, token);
    assert.equal(r1.body.code, 200, JSON.stringify(r1.body));
    const r2 = await app.call("PUT", `${rb}/results/c2`, { status: "failed", note: "源字段 3 没有映射建议", diagnosis: { kind: "code", reason: "实现缺失" } }, token);
    assert.equal(r2.body.data.run.results[1].diagnosis.by, "user");
    assert.equal(r2.body.data.run.results[1].shots[0], "step-3-actual.png");
    assert.equal((await app.call("PUT", `${rb}/results/c1`, { status: "accepted" }, token)).status, 400, "accepted 不能直接上报（回流环节才有）");
    assert.equal((await app.call("PUT", `${rb}/results/c9`, { status: "passed" }, token)).body.code, 40000);
    assert.equal((await app.call("PUT", `${rb}/results/c1`, { status: "passed" })).body.code, 40301);

    // 结束前还有用例没结论不行；这里都有了 → failed，需求进入「不符」
    const done = await app.call("POST", `${rb}/finish`, {}, token);
    assert.equal(done.body.code, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.run.status, "failed");
    assert.equal(done.body.data.run.summary.failed, 1);
    assert.ok(done.body.data.run.finishedAt > 0);
    assert.match((await app.call("POST", `${rb}/finish`, {}, token)).body.msg, /already finished/);
    assert.match((await app.call("PUT", `${rb}/results/c1`, { status: "failed" }, token)).body.msg, /already finished/);
    // 失败的运行结束后可以再开一轮
    assert.equal((await app.call("POST", runs, {}, token)).body.code, 200);

    // 文件下发：登记过的才给；安全头齐全；没登记 / 不安全的名字一律 404
    const served = await app.call("GET", `${rb}/files/step-3-actual.png`, undefined, undefined, true);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("content-security-policy"), /default-src 'none'/);
    assert.deepEqual(served.buffer, PNG);
    writeFileSync(join(dir, "e2e", run.runId, "secret.png"), PNG);
    for (const name of ["secret.png", "..%2Fprojects.json", "nope.png", ".hidden.png", "a%2Fb.png"]) {
      assert.equal((await app.call("GET", `${rb}/files/${name}`, undefined, undefined, true)).status, 404, name);
    }
    assert.equal((await app.call("GET", `/projects/${projectId}/e2e/run-zzzzzzzz/files/step-3-actual.png`, undefined, undefined, true)).status, 404, "别的运行取不到");

    // 阶段联动：需求还没有任务时，E2E 结果不影响阶段（没任务就到不了验收）；有任务且全部完工后，失败的运行 → 不符
    const before = (await app.call("GET", `/projects/${projectId}/requirements/${req.reqId}`)).body.data.requirement;
    assert.equal(before.counts.runs, 2);
    assert.equal(before.stage, "clarify", "没有任务、没有原型：E2E 结果改变不了阶段");
    const task = await app.call("POST", "/tasks", { projectId, subject: "T1", requirementId: req.reqId }, token);
    await app.call("PUT", `/tasks/${task.body.data.task.taskId}/report`, { projectId, expectedRevision: 1, report: { status: "done", summary: "ok" } }, token);
    const asBefore = (await app.call("GET", `/projects/${projectId}/requirements/${req.reqId}`)).body.data.requirement;
    assert.equal(asBefore.stage, "accept", "任务全部完工，最近一次运行还没出结论 → 验收");
    // 把新开的那一轮也跑完并判失败 → 不符，且进「需要我处理」
    const open = (await app.call("GET", runs)).body.data.runs.find((r) => r.status === "queued");
    await app.call("PUT", `${b}/e2e/${open.runId}/results/c1`, { status: "failed", note: "x" }, token);
    await app.call("PUT", `${b}/e2e/${open.runId}/results/c2`, { status: "passed" }, token);
    await app.call("POST", `${b}/e2e/${open.runId}/finish`, {}, token);
    const mismatch = (await app.call("GET", `/projects/${projectId}/requirements/${req.reqId}`)).body.data.requirement;
    assert.equal(mismatch.stage, "mismatch");
    assert.equal(mismatch.attention, "e2e-mismatch");
    const inbox = (await app.call("GET", `/inbox?projectId=${projectId}`)).body.data.groups.find((g) => g.key === "requirements");
    assert.deepEqual(inbox.items.map((i) => i.attention), ["e2e-mismatch"]);
    // 再开一轮全部通过 → 通过，待办消失
    const next = (await app.call("POST", runs, { cases: ["全流程"] }, token)).body.data.run;
    await app.call("PUT", `${b}/e2e/${next.runId}/results/c1`, { status: "passed" }, token);
    await app.call("POST", `${b}/e2e/${next.runId}/finish`, {}, token);
    assert.equal((await app.call("GET", `/projects/${projectId}/requirements/${req.reqId}`)).body.data.requirement.stage, "passed");
    assert.deepEqual((await app.call("GET", `/inbox?projectId=${projectId}`)).body.data.groups.find((g) => g.key === "requirements").items, []);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2E 截图上传的安全边界：内容与扩展名不符 / 视频 / 超大 / 空 / 非法名 都拒绝，且不留文件", async () => {
  const { dir, app, token, b, runs } = await setup();
  try {
    const run = (await app.call("POST", runs, {}, token)).body.data.run;
    const url = `${b}/e2e/${run.runId}/shots/c1`;
    const up = (name, buf) => app.call("POST", url, { name, data: buf.toString("base64") }, token);
    assert.match((await up("a.png", Buffer.from("<script>alert(1)</script>"))).body.msg, /does not match/);
    assert.match((await up("a.png", WEBM)).body.msg, /does not match/);
    assert.match((await up("clip.webm", WEBM)).body.msg, /videos can only be attached/);
    assert.match((await up("a.exe", PNG)).body.msg, /unsupported file name/);
    assert.match((await up("中文.png", PNG)).body.msg, /unsupported file name/);
    assert.match((await up("big.png", Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))).body.msg, /exceeds 5MB/);
    assert.equal((await app.call("POST", url, { name: "a.png" }, token)).status, 400, "缺 data");
    assert.equal((await app.call("POST", url, { name: "a.png", data: "" }, token)).status, 400);
    assert.equal((await app.call("POST", `${b}/e2e/${run.runId}/shots/c9`, { name: "a.png", data: PNG.toString("base64") }, token)).body.code, 40000, "用例不存在");
    assert.deepEqual(filesIn(dir, run.runId), [], "所有失败的上传都不能留下文件");
    // 同名第二张自动加后缀；单条用例附件数有上限
    assert.equal((await up("a.png", PNG)).body.data.name, "a.png");
    assert.equal((await up("a.png", PNG)).body.data.name, "a-2.png");
    for (let i = 0; i < 8; i += 1) await up("x" + i + ".png", PNG);
    const over = await up("over.png", PNG);
    assert.match(over.body.msg, /at most 10/);
    assert.equal(filesIn(dir, run.runId).includes("over.png"), false, "超限被拒后文件也要清掉");
    assert.equal((await app.call("POST", `${b}/e2e/run-nope1234/shots/c1`, { name: "a.png", data: PNG.toString("base64") }, token)).body.code, 40401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2E 运行：建运行的校验、跨项目隔离、强制结束、方法与路径", async () => {
  const { dir, app, token, projectId, req, b, runs } = await setup();
  try {
    assert.equal((await app.call("POST", runs, { driver: "selenium" }, token)).body.code, 40000);
    assert.equal((await app.call("POST", runs, { cases: [] }, token)).body.code, 40000);
    assert.equal((await app.call("POST", `${b}/requirements/req-nope/e2e`, {}, token)).body.code, 40401);
    assert.equal((await app.call("GET", `${b}/requirements/req-nope/e2e`)).body.code, 40401);
    const run = (await app.call("POST", runs, { driver: "tabbit-cli", cases: ["首页能打开", "导入能完成"], note: "回归" }, token)).body.data.run;
    assert.equal(run.driver, "tabbit-cli");
    assert.equal(run.note, "回归");
    const rb = `${b}/e2e/${run.runId}`;
    // 还有用例没结论 → 不能结束，并告诉缺哪些；强制结束把没报的记 error
    const blocked = await app.call("POST", `${rb}/finish`, {}, token);
    assert.equal(blocked.body.code, 40000);
    assert.deepEqual(blocked.body.data.missing, ["c1", "c2"]);
    const forced = await app.call("POST", `${rb}/finish`, { force: true }, token);
    assert.equal(forced.body.data.run.status, "error");
    assert.match(forced.body.data.run.results[0].note, /强制结束/);
    // 别的项目看不到这个运行
    const other = (await app.call("POST", "/projects", { name: "别的", mainSessionId: "session-out" }, token)).body.data.project.projectId;
    assert.equal((await app.call("GET", `/projects/${other}/e2e/${run.runId}`)).body.code, 40401);
    assert.equal((await app.call("POST", `/projects/${other}/e2e/${run.runId}/finish`, {}, token)).body.code, 40401);
    // 方法 / 坏 id
    assert.equal((await app.call("DELETE", rb, undefined, token)).status, 405);
    assert.equal((await app.call("PUT", runs, {}, token)).status, 405);
    assert.equal((await app.call("GET", `${rb}/finish`)).status, 405);
    assert.equal((await app.call("GET", `${b}/e2e/not-a-run-id`)).body.code, 40401);
    assert.equal((await app.call("GET", `${b}/e2e/${run.runId}`)).body.data.run.summary.errored, 2);
    // 确认设计后建的运行带当前设计版本
    const canvas = await app.call("GET", `/canvas?projectId=${projectId}`);
    await app.call("POST", "/canvas/elements", { projectId, expectedRevision: canvas.body.data.rev, upsert: [{ id: "proto:main", kind: "prototype", data: { requirementId: req.reqId, title: "页", puck: { content: [{ type: "Heading", props: { text: "x" } }] } } }] }, token);
    assert.equal((await app.call("POST", `${b}/requirements/${req.reqId}/confirm-design`, { expectedRevision: 1 }, token)).body.code, 200);
    const v1 = (await app.call("POST", runs, {}, token)).body.data.run;
    assert.equal(v1.designVersion, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whales_e2e_report 工具：执行器上报结果 + 复制截图 + 结束；手动运行 agent 不能代报；非项目成员 / 坏路径 / 坏文件整次不记", async () => {
  const { dir, app, token, projectId, b, runs } = await setup();
  const scratch = mkdtempSync(join(tmpdir(), "aw-shots-"));
  try {
    const tool = app.tools.whales_e2e_report;
    assert.ok(tool, "工具必须注册");
    const asB = { agent: { id: "session-b" } };
    const run = (await app.call("POST", runs, { driver: "tabbit-cli", cases: ["首页能打开", "导入能完成"] }, token)).body.data.run;
    const shot1 = join(scratch, "Home Page.png");
    const clip = join(scratch, "run.webm");
    writeFileSync(shot1, PNG);
    writeFileSync(clip, WEBM);

    // 第一条：通过 + 一张截图
    const ok1 = await tool.execute({ runId: run.runId, caseId: "c1", status: "passed", shots: [shot1] }, asB);
    assert.equal(ok1.runStatus, "running");
    assert.deepEqual(ok1.shots, ["home-page.png"]);
    assert.deepEqual(filesIn(dir, run.runId), ["home-page.png"]);
    // 第二条：失败 + 诊断 + 录屏 + 结束
    const ok2 = await tool.execute({ runId: run.runId, caseId: "c2", status: "failed", note: "断言失败：找不到映射建议", diagnosis: { kind: "code", reason: "实现问题" }, shots: [shot1, clip], finish: true }, asB);
    assert.equal(ok2.runStatus, "failed");
    assert.deepEqual(ok2.shots, ["home-page-2.png", "run.webm"], "同名自动加后缀；录屏可附");
    const detail = (await app.call("GET", `${b}/e2e/${run.runId}`)).body.data.run;
    assert.equal(detail.results[1].diagnosis.by, "ai", "执行器的诊断标 ai（初判）");
    assert.equal(detail.results[1].by, "session-b");
    assert.equal(detail.summary.failed, 1);
    // 录屏能被取回，类型对
    const served = await app.call("GET", `${b}/e2e/${run.runId}/files/run.webm`, undefined, undefined, true);
    assert.equal(served.headers.get("content-type"), "video/webm");
    // 运行结束后不能再报
    await assert.rejects(tool.execute({ runId: run.runId, caseId: "c1", status: "passed" }, asB), /already finished/);

    // 边界：手动运行 agent 不能代报；不在项目里的会话不能报；runId 坏 / 不存在
    await app.call("POST", `${b}/e2e/${run.runId}/finish`, {}, token).catch(() => {});
    const manual = (await app.call("POST", runs, {}, token)).body.data.run;
    await assert.rejects(tool.execute({ runId: manual.runId, caseId: "c1", status: "passed" }, asB), /manual/);
    await assert.rejects(tool.execute({ runId: manual.runId, caseId: "c1", status: "passed" }, { agent: { id: "session-out" } }), /not in any project/);
    await assert.rejects(tool.execute({ runId: "../x", caseId: "c1", status: "passed" }, asB), /run not found/);
    await assert.rejects(tool.execute({ runId: "run-nope1234", caseId: "c1", status: "passed" }, asB), /run not found/);
    await assert.rejects(tool.execute({ runId: manual.runId, caseId: "c1", status: "passed" }, {}), /cannot determine/);
    await assert.rejects(tool.execute({ runId: manual.runId, caseId: "c1", status: "accepted" }, asB), /status must be/, "agent 不能写 accepted");

    // 整次不记：第二个文件是伪装成 png 的文本 → 第一个文件也要回滚，结论不写
    const second = (await app.call("POST", `${b}/requirements/${(await app.call("GET", `${b}/requirements`)).body.data.requirements[0].reqId}/e2e`, { driver: "computer-use", cases: ["x"] }, token));
    assert.equal(second.body.code, 40701, "同一需求已有没结束的手动运行，先结束它");
    await app.call("POST", `${b}/e2e/${manual.runId}/finish`, { force: true }, token);
    const cu = (await app.call("POST", `${b}/requirements/${(await app.call("GET", `${b}/requirements`)).body.data.requirements[0].reqId}/e2e`, { driver: "computer-use", cases: ["x"] }, token)).body.data.run;
    const evil = join(scratch, "evil.png");
    writeFileSync(evil, "<html>not a png</html>");
    await assert.rejects(tool.execute({ runId: cu.runId, caseId: "c1", status: "passed", shots: [shot1, evil] }, asB), /does not match/);
    assert.deepEqual(filesIn(dir, cu.runId), [], "失败的上报不留半截文件");
    assert.equal((await app.call("GET", `${b}/e2e/${cu.runId}`)).body.data.run.results[0].status, "pending", "也没有写结论");
    await assert.rejects(tool.execute({ runId: cu.runId, caseId: "c1", status: "passed", shots: [join(scratch, "missing.png")] }, asB), /cannot read shot/);
    await assert.rejects(tool.execute({ runId: cu.runId, caseId: "c9", status: "passed" }, asB), /case not found/);
    // 没报完就 finish → 拒绝，且这次上报也不记
    await assert.rejects(tool.execute({ runId: cu.runId, caseId: "c1", status: "running", finish: true }, asB), /without a result/);
    assert.equal((await app.call("GET", `${b}/e2e/${cu.runId}`)).body.data.run.results[0].status, "pending");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("E2E 运行：重启后运行与证据文件都还在", async () => {
  const { dir, app, token, projectId, b, runs } = await setup();
  let second;
  try {
    const run = (await app.call("POST", runs, {}, token)).body.data.run;
    await app.call("POST", `${b}/e2e/${run.runId}/shots/c1`, { name: "a.png", data: PNG.toString("base64") }, token);
    await app.call("PUT", `${b}/e2e/${run.runId}/results/c1`, { status: "failed", note: "x" }, token);
    second = await boot();
    const again = (await second.call("GET", `${b}/e2e/${run.runId}`)).body.data.run;
    assert.equal(again.results[0].status, "failed");
    assert.deepEqual(again.results[0].shots, ["a.png"]);
    assert.deepEqual((await second.call("GET", `${b}/e2e/${run.runId}/files/a.png`, undefined, undefined, true)).buffer, PNG);
  } finally {
    await app.close();
    if (second) await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
