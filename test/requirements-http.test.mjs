// 需求主线 P0：宿主路由（真 HTTP）——建 / 列 / 取 / 改需求、CAS、越权、旧数据并入「未归类」、重启持久化。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");

async function boot(onDispatch) {
  const routes = [];
  const tools = new Map();
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return {
        list: () => [],
        get: (id) => (["session-a", "session-b", "session-out"].includes(id) ? { id, title: id, running: true, session: { id } } : undefined)
      };
      if (name === "agents") return { get: (id) => ({ id, status: "running", session: { id }, followup: (message) => onDispatch?.(id, message) }), list: () => [] };
      if (name === "sessionPersistence") return { stat: () => undefined };
      if (name === "tools") return { register: (tool) => { tools.set(tool.name, tool); return () => {}; }, schemas: () => [] };
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  };
  plugin.apply(ctx);
  const route = routes.find((item) => item && typeof item.handler === "function");
  assert.ok(route, "活动路由必须挂载");
  const server = createServer((req, res) => {
    Promise.resolve().then(() => route.handler(req, res)).catch((error) => {
      if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ code: 500, msg: String(error && error.message) })); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/agent-whales/api`;
  async function call(method, path, body, token) {
    const headers = {};
    if (token) headers["x-whales-token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    if (timer && typeof timer.unref === "function") timer.unref();
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
    return { status: res.status, body: parsed };
  }
  const close = () => new Promise((resolve) => { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); server.close(() => resolve()); });
  return { call, close, tools };
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "aw-req-"));
  plugin.setProjectStorePathForTests(join(dir, "projects.json"));
  plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
  plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  plugin.setEventsStorePathForTests(join(dir, "events.json"));
  return dir;
}

test("需求路由：建 / 列 / 取 / 改 + CAS + 越权 + 未归类并入 + 重启持久化", async () => {
  const dir = freshStore();
  const closers = [];
  try {
    const first = await boot();
    closers.push(first.close);
    const token = (await first.call("GET", "/activity")).body.controlToken;
    assert.ok(token);

    const created = await first.call("POST", "/projects", { name: "需求项目", mainSessionId: "session-a" }, token);
    const projectId = created.body.data.project.projectId;
    await first.call("POST", `/projects/${projectId}/members`, { sessionId: "session-b" }, token);
    const base = `/projects/${projectId}/requirements`;

    // 空项目：没有需求、也没有孤儿数据 → 列表为空（不凭空冒出「未归类」）
    const empty = await first.call("GET", base);
    assert.equal(empty.body.code, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.data.requirements, []);

    // 没有 token 不能写
    const noToken = await first.call("POST", base, { title: "表单导入" });
    assert.equal(noToken.body.code, 40301);

    // 建需求：标题必填、过长拒绝、composer 必须是项目成员
    assert.equal((await first.call("POST", base, { title: "  " }, token)).status, 400);
    assert.equal((await first.call("POST", base, { title: "x".repeat(81) }, token)).status, 400);
    const stranger = await first.call("POST", base, { title: "t", composerSessionId: "session-out" }, token);
    assert.equal(stranger.body.code, 40703, "composer 不是项目成员必须拒绝：" + JSON.stringify(stranger.body));

    const r1 = await first.call("POST", base, { title: "表单导入", goal: "把 xlsx 导入表单", acceptance: ["上传 xlsx 并识别表头", "未匹配字段给出建议"] }, token);
    assert.equal(r1.body.code, 200, JSON.stringify(r1.body));
    const view = r1.body.data.requirement;
    assert.match(view.reqId, /^req-/);
    assert.equal(view.stage, "clarify");
    assert.equal(view.stageLabel, "澄清");
    assert.equal(view.composerSessionId, "session-a", "缺省 composer = 项目主对话");
    assert.deepEqual(view.acceptance, ["上传 xlsx 并识别表头", "未匹配字段给出建议"]);
    assert.equal(view.revision, 1);
    assert.equal(view.reworkCap, 3);

    // 第二个需求，指定 composer
    const r2 = await first.call("POST", base, { title: "批量审批", composerSessionId: "session-b", reworkCap: 5 }, token);
    assert.equal(r2.body.data.requirement.composerSessionId, "session-b");
    assert.equal(r2.body.data.requirement.reworkCap, 5);

    // 取单个 / 列表
    const one = await first.call("GET", `${base}/${view.reqId}`);
    assert.equal(one.body.data.requirement.title, "表单导入");
    const list = await first.call("GET", base);
    assert.equal(list.body.data.requirements.length, 2);
    assert.equal((await first.call("GET", `${base}/req-不存在`)).body.code, 40401);

    // 改需求：CAS（带过期 revision → 40902，不覆盖）
    const patched = await first.call("PATCH", `${base}/${view.reqId}`, { expectedRevision: 1, goal: "新目标" }, token);
    assert.equal(patched.body.code, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.requirement.goal, "新目标");
    assert.equal(patched.body.data.requirement.revision, 2);
    assert.equal(patched.body.data.requirement.title, "表单导入", "partial 改动不动其它字段");
    const stale = await first.call("PATCH", `${base}/${view.reqId}`, { expectedRevision: 1, goal: "旧版本想覆盖" }, token);
    assert.equal(stale.body.code, 40902);
    assert.equal(stale.body.data.latestRevision, 2);
    assert.equal((await first.call("GET", `${base}/${view.reqId}`)).body.data.requirement.goal, "新目标");
    assert.equal((await first.call("PATCH", `${base}/${view.reqId}`, { goal: "没带 revision" }, token)).status, 400);
    assert.equal((await first.call("PATCH", `${base}/${view.reqId}`, { expectedRevision: 2, title: "" }, token)).status, 400);
    assert.equal((await first.call("PATCH", `${base}/${view.reqId}`, { expectedRevision: 2, goal: "x" })).body.code, 40301);

    // 方法不对 → 405
    assert.equal((await first.call("DELETE", `${base}/${view.reqId}`, undefined, token)).status, 405);
    assert.equal((await first.call("PUT", base, {}, token)).status, 405);

    // 老数据：没有 requirementId 的任务 → 并入虚拟「未归类」，且不能被改
    const oldTask = await first.call("POST", "/tasks", { projectId, subject: "老任务" }, token);
    assert.equal(oldTask.body.code, 200, JSON.stringify(oldTask.body));
    const withOld = await first.call("GET", base);
    const rows = withOld.body.data.requirements;
    assert.equal(rows.length, 3);
    const virtual = rows[rows.length - 1];
    assert.equal(virtual.reqId, "unassigned");
    assert.equal(virtual.virtual, true);
    assert.equal(virtual.counts.tasks, 1);
    assert.equal(virtual.stage, "develop");
    const patchVirtual = await first.call("PATCH", `${base}/unassigned`, { expectedRevision: 1, title: "改名" }, token);
    assert.equal(patchVirtual.body.code, 40000);
    const getVirtual = await first.call("GET", `${base}/unassigned`);
    assert.equal(getVirtual.body.data.requirement.virtual, true);

    // 画布上的原型帧（带 requirementId）→ 该需求进入「设计」阶段（从没确认过）
    const canvas = await first.call("GET", `/canvas?projectId=${projectId}`);
    const putEl = await first.call("POST", "/canvas/elements", {
      projectId, expectedRevision: canvas.body.data.rev,
      upsert: [{ id: "proto-1", kind: "prototype", data: { requirementId: view.reqId, title: "导入页", puck: { content: [] } } }]
    }, token);
    assert.equal(putEl.body.code, 200, JSON.stringify(putEl.body));
    const designing = await first.call("GET", `${base}/${view.reqId}`);
    assert.equal(designing.body.data.requirement.stage, "design");
    assert.equal(designing.body.data.requirement.attention, "confirm-design");
    assert.deepEqual(designing.body.data.requirement.prototypeIds, ["proto-1"]);
    // 同一张原型帧不会同时算进「未归类」
    const afterEl = (await first.call("GET", base)).body.data.requirements.find((row) => row.reqId === "unassigned");
    assert.equal(afterEl.counts.prototypes, 0);

    // 不存在的项目
    assert.equal((await first.call("GET", "/projects/proj-nope/requirements")).body.code, 40401);

    // 重启后还在
    const second = await boot();
    closers.push(second.close);
    const again = await second.call("GET", base);
    assert.equal(again.body.data.requirements.length, 3, "重启后需求必须还在");
    const persisted = again.body.data.requirements.find((row) => row.reqId === view.reqId);
    assert.equal(persisted.goal, "新目标");
    assert.equal(persisted.revision, 2);
    assert.equal(persisted.stage, "design");
  } finally {
    for (const close of closers) { try { await close(); } catch (error) { /* 已关 */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("确认设计版本：只有人能确认；固化快照、版本递增；确认后改原型回到设计；任务继承版本号；重启还在", async () => {
  const dir = freshStore();
  const closers = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const first = await boot();
    closers.push(first.close);
    const token = (await first.call("GET", "/activity")).body.controlToken;
    const projectId = (await first.call("POST", "/projects", { name: "设计项目", mainSessionId: "session-a" }, token)).body.data.project.projectId;
    const base = `/projects/${projectId}/requirements`;
    const r = (await first.call("POST", base, { title: "表单导入" }, token)).body.data.requirement;
    const confirm = (reqId, body, tk) => first.call("POST", `${base}/${reqId}/confirm-design`, body, tk === undefined ? token : tk);
    const putProto = async (id, text) => {
      const canvas = await first.call("GET", `/canvas?projectId=${projectId}`);
      const res = await first.call("POST", "/canvas/elements", {
        projectId, expectedRevision: canvas.body.data.rev,
        upsert: [{ id, kind: "prototype", data: { requirementId: r.reqId, title: "导入页", width: "desktop", puck: { content: [{ type: "Heading", props: { text } }] } } }]
      }, token);
      assert.equal(res.body.code, 200, JSON.stringify(res.body));
    };

    // 没有原型帧：没东西可确认
    const none = await confirm(r.reqId, { expectedRevision: 1 });
    assert.equal(none.body.code, 40000);
    assert.match(none.body.msg, /还没有原型帧或画板/);

    await putProto("proto:main", "第一版");
    // 越权 / 参数
    assert.equal((await confirm(r.reqId, { expectedRevision: 1 }, null)).body.code, 40301, "没有 token 不能确认");
    assert.equal((await confirm(r.reqId, {})).status, 400, "必须带 expectedRevision");
    assert.equal((await confirm("unassigned", { expectedRevision: 1 })).body.code, 40000, "未归类没有设计可确认");
    assert.equal((await confirm("req-不存在", { expectedRevision: 1 })).body.code, 40401);
    assert.equal((await first.call("GET", `${base}/${r.reqId}/confirm-design`)).status, 405);

    // 确认 v1
    const v1 = await confirm(r.reqId, { expectedRevision: 1, note: "产品看过了" });
    assert.equal(v1.body.code, 200, JSON.stringify(v1.body));
    const view1 = v1.body.data.requirement;
    assert.equal(view1.designVersion, 1);
    assert.equal(view1.revision, 2);
    assert.equal(view1.stage, "develop", "确认后设计阶段结束、还没任务 → 开发");
    assert.equal(view1.attention, null);
    assert.equal(view1.designVersions.length, 1);
    assert.deepEqual(view1.designVersions[0], { v: 1, at: view1.designVersions[0].at, by: "user", hash: view1.designVersions[0].hash, prototypeCount: 1, flowCount: 0, note: "产品看过了", hasSnapshot: true, hasHandoff: true, prdRevision: 0, commentCount: 0 });

    // 过期 revision 不覆盖；没有改动不必重确认
    const stale = await confirm(r.reqId, { expectedRevision: 1 });
    assert.equal(stale.body.code, 40902);
    assert.equal(stale.body.data.latestRevision, 2);
    const noChange = await confirm(r.reqId, { expectedRevision: 2 });
    assert.equal(noChange.body.code, 40000);
    assert.match(noChange.body.msg, /v1 以来设计没有改动/);

    // 确认后建的任务带版本号；确认前（没有版本）建的不带
    const t1 = await first.call("POST", "/tasks", { projectId, subject: "T1 导入接口", requirementId: r.reqId }, token);
    assert.equal(t1.body.data.task.designVersion, 1);

    // 确认后原型被改 → 回到设计，要求确认新版本
    await sleep(15);
    await putProto("proto:main", "第二版");
    const dirty = (await first.call("GET", `${base}/${r.reqId}`)).body.data.requirement;
    assert.equal(dirty.stage, "design");
    assert.equal(dirty.attention, "confirm-design");
    assert.match(dirty.next, /v1/);
    const v2 = await confirm(r.reqId, { expectedRevision: 2 });
    assert.equal(v2.body.code, 200, JSON.stringify(v2.body));
    assert.equal(v2.body.data.requirement.designVersion, 2);
    assert.equal(v2.body.data.requirement.stage, "develop");
    const t2 = await first.call("POST", "/tasks", { projectId, subject: "T2 导入弹窗", requirementId: r.reqId }, token);
    assert.equal(t2.body.data.task.designVersion, 2);
    assert.equal((await first.call("GET", `/tasks?projectId=${projectId}`)).body.data.tasks.find((t) => t.taskId === t1.body.data.task.taskId).designVersion, 1, "旧任务仍记着它是按 v1 建的");

    // 读版本快照：v1 是第一版内容，v2 是第二版；不存在的版本 40401
    const snap1 = await first.call("GET", `${base}/${r.reqId}/design/1`);
    assert.equal(snap1.body.code, 200, JSON.stringify(snap1.body));
    assert.equal(snap1.body.data.snapshot.prototypes["proto:main"].puck.content[0].props.text, "第一版");
    assert.equal(snap1.body.data.version.v, 1);
    const snap2 = await first.call("GET", `${base}/${r.reqId}/design/2`);
    assert.equal(snap2.body.data.snapshot.prototypes["proto:main"].puck.content[0].props.text, "第二版");
    assert.notEqual(snap1.body.data.version.hash, snap2.body.data.version.hash, "内容不同哈希不同");
    assert.equal((await first.call("GET", `${base}/${r.reqId}/design/9`)).body.code, 40401);
    assert.equal((await first.call("GET", `${base}/${r.reqId}/design/abc`)).body.code, 40401);
    assert.equal((await first.call("POST", `${base}/${r.reqId}/design/1`, {}, token)).status, 405);

    // 重启后：版本、快照、任务版本号都还在
    const second = await boot();
    closers.push(second.close);
    const after = (await second.call("GET", `${base}/${r.reqId}`)).body.data.requirement;
    assert.equal(after.designVersion, 2);
    assert.equal(after.designVersions.length, 2);
    assert.equal(after.stage, "develop");
    assert.equal((await second.call("GET", `${base}/${r.reqId}/design/1`)).body.data.snapshot.prototypes["proto:main"].puck.content[0].props.text, "第一版");
  } finally {
    for (const close of closers) { try { await close(); } catch (error) { /* 已关 */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("前端交接固定版本，重复请求只派一次，接手方可查看更新并回报", async () => {
  const dir = freshStore();
  const delivered = [];
  const host = await boot((id, message) => { if (id === "session-b") delivered.push({ id, message }); });
  try {
    const token = (await host.call("GET", "/activity")).body.controlToken;
    const write = async (path, body, method = "POST") => (await host.call(method, path, body, token)).body;
    const project = (await write("/projects", { name: "足迹热力图", mainSessionId: "session-a" })).data.project;
    const projectPath = `/projects/${project.projectId}`;
    assert.equal((await write(projectPath + "/members", { sessionId: "session-b" })).code, 200);
    const requirement = (await write(projectPath + "/requirements", {
      title: "足迹热力图", acceptance: ["点榜单定位"], prd: { markdown: "# 范围\n排除家和公司" }
    })).data.requirement;
    const path = projectPath + "/requirements/" + requirement.reqId;
    const canvas = (await host.call("GET", "/canvas?projectId=" + project.projectId)).body.data;
    assert.equal((await write("/canvas/elements", { projectId: project.projectId, expectedRevision: canvas.rev, upsert: [
      { id: "proto:map", kind: "prototype", data: { title: "热力图", requirementId: requirement.reqId, puck: { content: [] } } }
    ] })).code, 200);
    assert.equal((await write("/design/comments?projectId=" + project.projectId, { target: "proto:proto:map", body: "保留图例" })).code, 200);
    const confirmed = (await write(path + "/confirm-design", { expectedRevision: requirement.revision })).data.requirement;
    assert.equal(confirmed.designVersion, 1);
    assert.equal((await host.call("GET", path + "/handoff/1")).status, 403);
    const readFrozen = async () => (await host.call("GET", path + "/handoff/1", undefined, token)).body.data.bundle;
    const frozen = await readFrozen();
    assert.equal(frozen.prdRevision, 1);
    assert.equal(frozen.comments[0].body, "保留图例");
    assert.deepEqual(frozen.acceptance, ["点榜单定位"]);
    assert.equal((await write(path + "/handoff", { sessionId: "session-out", version: 1 })).code, 40711);

    const payload = { sessionId: "session-b", version: 1 };
    const [first, second] = await Promise.all([write(path + "/handoff", payload), write(path + "/handoff", payload)]);
    assert.equal(first.code, 200);
    assert.equal(second.code, 200);
    const taskId = first.data.task.taskId;
    assert.equal(second.data.task.taskId, taskId);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].id, "session-b");
    assert.match(delivered[0].message.content[0].text, /PRD v1/);

    const workerTool = host.tools.get("whales_requirement");
    const read = { action: "handoff_get", taskId };
    await assert.rejects(workerTool.execute(read, { agent: { id: "session-a" } }), /40301/);
    const worker = { agent: { id: "session-b" } };
    const task = await workerTool.execute(read, worker);
    const updated = (await write(path, { expectedRevision: confirmed.revision, prd: { markdown: "# 范围\n加入外地榜单" } }, "PATCH")).data.requirement;
    assert.equal(updated.evidence.reviewPending, true);
    assert.equal((await workerTool.execute(read, worker)).reviewPending, true);
    assert.equal((await readFrozen()).prd.markdown, "# 范围\n排除家和公司");

    const reported = await workerTool.execute({ action: "handoff_report", taskId, expectedRevision: task.revision,
      report: { status: "done", summary: "已实现热力图", artifacts: [{ kind: "file", ref: "src/Map.tsx" }] } }, worker);
    assert.equal(reported.report.bySessionId, "session-b");
    const view = (await host.call("GET", path)).body.data.requirement;
    assert.equal(view.designHandoffs[0].report.artifacts[0].ref, "src/Map.tsx");
    assert.deepEqual((await host.call("GET", path + "/e2e")).body.data.runs, []);
    const next = (await write(path + "/confirm-design", { expectedRevision: updated.revision })).data.requirement;
    assert.equal(next.designVersion, 2);
    assert.equal(next.evidence.taskTotal, 0, "上一版的完工记录不计入新版本");
    assert.equal((await workerTool.execute(read, worker)).currentVersion, 2);
    assert.equal(delivered.length, 1);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
