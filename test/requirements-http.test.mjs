// 需求主线 P0：宿主路由（真 HTTP）——建 / 列 / 取 / 改需求、CAS、越权、旧数据并入「未归类」、重启持久化。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");

async function boot() {
  const routes = [];
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return {
        list: () => [],
        get: (id) => (["session-a", "session-b", "session-out"].includes(id) ? { id, title: id, running: true, session: { id } } : undefined)
      };
      if (name === "agents") return { get: (id) => ({ id, status: "running", session: { id } }), list: () => [] };
      if (name === "sessionPersistence") return { stat: () => undefined };
      if (name === "tools") return { register: () => () => {}, schemas: () => [] };
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
  return { call, close };
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
