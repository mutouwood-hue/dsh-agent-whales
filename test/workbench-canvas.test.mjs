import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as host from "../lib/index.js";


// ── R1 返工 · 画布 agent 面 ────────────────────────────────────────────────
//
// 打的是两件事：
// 1) HTTP 面：GET/PUT /agent-whales/api/canvas?projectId=（位置快照 + 整体覆盖 + CAS）
// 2) agent 工具面：whales_canvas_list / inspect / layout / link / unlink
//
// 节点是派生的（上下文←任务落点、Agent←成员、Composer←主对话），所以没有
// node_add / node_delete；连线走 projects.json 的 links（单一真源）。

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "aw-canvas-"));
  const routes = [];
  const tools = {};
  return { dir, routes, tools };
}

async function open() {
  const h = harness();
  host.setProposalStorePathForTests(join(h.dir, "proposals.json"));
  // 别的用例文件会设 PROJECTS_STORE_OVERRIDE 且不还原；这里必须显式指回本用例目录，
  // 否则 projects/canvas 会写进上一个文件的临时目录（症状：main session already belongs）。
  host.setProjectStorePathForTests(join(h.dir, "projects.json"));
  const tokenBox = { value: undefined };
  host.apply({
    get(name) {
      if (name === "webServer") return { register: (route) => { h.routes.push(route); return () => {}; } };
      if (name === "sessions") return { list: () => rows0(), get: (id) => rows0().find((row) => row.id === id) };
      if (name === "agents") return { get: (id) => ({ id, status: "idle", session: { id } }), list: () => [] };
      if (name === "sessionPersistence") return { stat: () => undefined };
      if (name === "tools") return { register: (tool) => { h.tools[tool.name] = tool; return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  });
  const route = h.routes.find((item) => item && typeof item.handler === "function");
  assert.ok(route, "活动路由必须挂载");

  async function request(method, url, headers, body) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers || {};
    const settled = await new Promise((resolve, reject) => {
      const responseHeaders = {};
      const res = {
        statusCode: 0,
        headersSent: false,
        setHeader(key, value) { responseHeaders[String(key).toLowerCase()] = value; },
        end(text) { resolve({ status: this.statusCode, headers: responseHeaders, body: text }); }
      };
      try { route.handler(req, res); } catch (error) { reject(error); return; }
      setImmediate(() => {
        if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      });
    });
    let parsed;
    try { parsed = JSON.parse(settled.body); } catch (error) { parsed = undefined; }
    return { status: settled.status, headers: settled.headers, body: parsed };
  }

  function rows0() {
    return [
      { id: "session-a", title: "主线会话", running: true, header: { origin: "user" } },
      { id: "session-b", title: "组员会话", running: false, header: { origin: "user" } }
    ];
  }

  async function token() {
    if (tokenBox.value === undefined) {
      const activity = await request("GET", "/agent-whales/api/activity", {}, undefined);
      token.value = activity.body.controlToken;
    }
    return token.value;
  }
  async function call(method, url, body) {
    const tk = await token();
    return request(method, url, { "x-whales-token": tk }, body);
  }
  async function createProject() {
    const created = await call("POST", "/agent-whales/api/projects", { name: "画布项目", mainSessionId: "session-a" });
    assert.equal(created.body.code, 200, JSON.stringify(created.body));
    return created.body.data.project.projectId;
  }
  return { h, call, createProject };
}

test("画布路由：没摆过也是合法状态（rev 0 + 空位置）", async () => {
  const { call, createProject } = await open();
  const projectId = await createProject();
  const got = await call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
  assert.equal(got.body.code, 200, JSON.stringify(got.body));
  assert.equal(got.body.data.rev, 0);
  assert.deepEqual(got.body.data.nodes, {});
});

test("画布路由：缺 projectId / 坏 body 都 40001，不写库", async () => {
  const { call, createProject } = await open();
  const projectId = await createProject();
  const noId = await call("GET", "/agent-whales/api/canvas");
  assert.equal(noId.body.code, 40001);
  const noNodes = await call("PUT", `/agent-whales/api/canvas?projectId=${projectId}`, { expectedRevision: 0 });
  assert.equal(noNodes.body.code, 40001);
  const badRev = await call("PUT", `/agent-whales/api/canvas?projectId=${projectId}`, { expectedRevision: "x", nodes: {} });
  assert.equal(badRev.body.code, 40001);
  const still = await call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
  assert.equal(still.body.data.rev, 0, "坏请求不能改动版本号");
});

test("画布路由：整体覆盖位置 + 非有限坐标被丢弃", async () => {
  const { call, createProject } = await open();
  const projectId = await createProject();
  const put = await call("PUT", `/agent-whales/api/canvas?projectId=${projectId}`, {
    expectedRevision: 0,
    nodes: {
      "session-a": { x: 340, y: 168, w: 300, h: 224 },
      "ctx:work/T7": { x: 24, y: 24, w: 220, h: 102 },
      broken: { x: "left", y: 24 },
      nocoord: { w: 10, h: 10 }
    }
  });
  assert.equal(put.body.code, 200, JSON.stringify(put.body));
  assert.equal(put.body.data.rev, 1);
  assert.deepEqual(Object.keys(put.body.data.nodes).sort(), ["ctx:work/T7", "session-a"]);

  const got = await call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
  assert.equal(got.body.data.rev, 1);
  assert.equal(got.body.data.nodes["session-a"].x, 340);
  assert.equal(got.body.data.nodes["ctx:work/T7"].w, 220);
});

test("画布路由：CAS 冲突 40902 并带回当前版本，旧快照不被覆盖", async () => {
  const { call, createProject } = await open();
  const projectId = await createProject();
  await call("PUT", `/agent-whales/api/canvas?projectId=${projectId}`, { expectedRevision: 0, nodes: { "session-a": { x: 1, y: 1 } } });
  const stale = await call("PUT", `/agent-whales/api/canvas?projectId=${projectId}`, { expectedRevision: 0, nodes: { "session-a": { x: 999, y: 999 } } });
  assert.equal(stale.body.code, 40902, JSON.stringify(stale.body));
  assert.equal(stale.body.data.currentRevision, 1, "冲突必须带回当前版本，便于重报");
  const got = await call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
  assert.equal(got.body.data.nodes["session-a"].x, 1, "过期写入不得覆盖");
});

test("画布工具：list / inspect / layout 一条龙，layout 过期 40902", async () => {
  const { h, call, createProject } = await open();
  const projectId = await createProject();

  const emptyList = await h.tools.whales_canvas_list.execute({});
  assert.deepEqual(emptyList.pages, [], "没人摆过时列表为空");

  const put = await call("PUT", `/agent-whales/api/canvas?projectId=${projectId}`, { expectedRevision: 0, nodes: { "session-b": { x: 680, y: 24, w: 200, h: 118 } } });
  assert.equal(put.body.code, 200);

  const list = await h.tools.whales_canvas_list.execute({});
  assert.equal(list.pages.length, 1);
  assert.equal(list.pages[0].projectId, projectId);
  assert.equal(list.pages[0].rev, 1);
  assert.equal(list.pages[0].nodeCount, 1);

  const inspected = await h.tools.whales_canvas_inspect.execute({ projectId });
  assert.equal(inspected.rev, 1);
  assert.equal(inspected.positions["session-b"].x, 680);
  assert.ok(Array.isArray(inspected.members) && inspected.members.length >= 1, "inspect 必须带出成员（Agent 节点的来源）");
  assert.equal(typeof h.tools.whales_canvas_inspect.output.render, "function");

  const missing = await h.tools.whales_canvas_inspect.execute({ projectId: "no-such" });
  assert.equal(missing.error.code, 40401);

  const laid = await h.tools.whales_canvas_layout.execute({ projectId, expectedRevision: 1, positions: { "session-b": { x: 700, y: 40 }, "session-a": { x: 340, y: 168, w: 300, h: 224 } } });
  assert.equal(laid.rev, 2);
  assert.equal(laid.updated, 2);

  const conflict = await h.tools.whales_canvas_layout.execute({ projectId, expectedRevision: 1, positions: { "session-b": { x: 0, y: 0 } } });
  assert.equal(conflict.error.code, 40902, "过期必须 40902 且不覆盖");
  assert.equal(conflict.error.currentRevision, 2);
  const after = await h.tools.whales_canvas_inspect.execute({ projectId });
  assert.equal(after.positions["session-b"].x, 700, "过期写入不得覆盖");
});

test("画布工具：link / unlink 改 projects.json 的 links，自连拒绝、重复幂等", async () => {
  const { h, call, createProject } = await open();
  const projectId = await createProject();
  const project = (await call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
  const rev = Number(project.revision);

  const self = await h.tools.whales_canvas_link.execute({ projectId, a: "session-a", b: "session-a", expectedRevision: rev });
  assert.equal(self.error.code, 40001, "自连必须拒绝");

  const made = await h.tools.whales_canvas_link.execute({ projectId, a: "session-a", b: "session-b", expectedRevision: rev });
  assert.equal(made.created, true);
  assert.equal(made.links, 1);

  const again = await h.tools.whales_canvas_link.execute({ projectId, a: "session-b", b: "session-a", expectedRevision: rev + 1 });
  assert.equal(again.created, false, "重复连接（顺序无关）幂等返回已存在");
  assert.equal(again.links, 1);

  const afterLink = (await call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
  assert.equal(afterLink.links.length, 1, "关联线必须落到 projects.json（单一真源）");

  const stale = await h.tools.whales_canvas_link.execute({ projectId, a: "session-a", b: "session-c", expectedRevision: rev });
  assert.equal(stale.error.code, 40902, "项目 revision 过期必须 40902");

  const gone = await h.tools.whales_canvas_unlink.execute({ projectId, a: "session-a", b: "session-b", expectedRevision: rev + 1 });
  assert.equal(gone.removed, true);
  const missing = await h.tools.whales_canvas_unlink.execute({ projectId, a: "session-a", b: "session-b", expectedRevision: rev + 2 });
  assert.equal(missing.removed, false, "删不存在的线幂等");
  const afterUnlink = (await call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
  assert.equal(afterUnlink.links.length, 0);
});

test.after(() => {
  try { rmSync(harness().dir, { recursive: true, force: true }); } catch (error) { /* 临时目录清理失败不影响结论 */ }
});
