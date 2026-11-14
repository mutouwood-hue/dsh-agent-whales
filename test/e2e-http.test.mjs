// 真 HTTP E2E：把宿主半边真的跑在一个 http server 上，用真 socket 走完整闭环。
//
// 为什么值得单开一个文件：既有 370 个用例走的是「假 fetch + 直接调 handler」，
// 从来没验证过「真实 TCP 上的一次请求/响应」——header 大小写、token 头、JSON 编解码、
// 路由前缀、405/OPTIONS、以及**进程重启后 store 是否还在**（Q7 真机清单第 2 项）。
//
// 覆盖：activity→token→项目→成员→关联→任务→指派(带 Q4 提示)→report→核对(Q3)→
//       简报→提案→事件台→待办→交接→画布存取→MCP 约束→CAS/越权三连拒→重启持久化。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const plugin = await import("../lib/index.js");

/** 起一个真 http server，把插件的路由 handler 挂上去。返回 baseUrl 与关闭函数。 */
async function boot(dir) {
  const routes = [];
  const captured = [];
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return {
        list: () => [
          { id: "session-a", title: "主线会话", running: true, header: { origin: "user" } },
          { id: "session-b", title: "组员会话", running: true, header: { origin: "user" } },
          { id: "session-worker", title: "执行器会话", running: true, header: { origin: "subagent", parentSession: "session-a" } },
          { id: "session-c", title: "别的主对话", running: true, header: { origin: "user" } }
        ],
        get: (id) => (["session-a", "session-b", "session-worker", "session-c"].includes(id) ? { id, title: id, running: true, session: { id } } : undefined)
      };
      if (name === "agents") return { get: (id) => ({ id, status: "running", session: { id } }), list: () => [] };
      if (name === "sessionPersistence") return { stat: () => undefined };
      if (name === "agentTeams") return {
        // 派发：没有 followup 通道 → sendMessage 立刻失败（与真实宿主「发不出去」同形），
        // 不会挂住路由（真实宿主这里是 15s 超时，e2e 里立刻失败更快也更确定）。
        sendMessage: () => Promise.reject(new Error("e2e: no followup channel")),
        tryMembership: (lead) => ({ lead, ok: true }),
        listMembers: () => [],
        listTasks: () => [],
        getTask: () => undefined,
        createTask: () => { throw new Error("e2e: host task board not used"); },
        updateTask: () => { throw new Error("e2e: host task board not used"); }
      };
      if (name === "tools") return {
        register: (tool) => { captured.push(tool); return () => {}; },
        // availableMcpServers 从这里枚举「真实连着的 MCP 服务」——建链前的前置校验用它。
        // 没有它，任何建链都会以 40709「mcp server not available」被拒（真机上服务是真的连着）。
        schemas: () => [
          { name: "mcp__pencil__get" },
          { name: "mcp__pencil__export" },
          { name: "mcp__notion__search" }
        ]
      };
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  };
  plugin.apply(ctx);
  const route = routes.find((item) => item && typeof item.handler === "function");
  assert.ok(route, "活动路由必须挂载");

  const server = createServer((req, res) => {
    // **不要自己读 body**：宿主 readRequestBody 自己监听 req 的 data/end，
    // 我们先读掉会把事件吃光，它就只能干等 5s 超时（e2e 表现为请求挂住）。
    // handler 是 async：拒绝要接住并回 500，否则 http 上这个请求永远挂着。
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((error) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ code: 500, msg: "handler threw: " + String(error && error.message) }));
        }
      });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/agent-whales/api`;

  async function call(method, path, body, token) {
    const headers = {};
    if (token) headers["x-whales-token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    // 5s 超时：挂住就明确失败，不无限等（真机排错时最省时间的就是这条）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    if (timer && typeof timer.unref === "function") timer.unref();
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      throw new Error("E2E 请求挂住或被中止: " + method + " " + path + " → " + String(error && error.message));
    }
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
    if (process.env.E2E_TRACE) console.log("  " + method + " " + path + " → " + res.status + " " + String(parsed && parsed.msg));
    return { status: res.status, body: parsed, text };
  }
  // close() 必须先断连接：Node 的 server.close() 会等 keep-alive 连接自然结束，
  // 而 fetch（undici）默认保活——不主动断就会一直等下去，e2e 假挂死。
  const close = () => new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
  return { base, call, close, tools: captured };
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "aw-e2e-"));
  plugin.setProjectStorePathForTests(join(dir, "projects.json"));
  plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
  plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  plugin.setEventsStorePathForTests(join(dir, "events.json"));
  return dir;
}

test("真 HTTP E2E：完整闭环 + CAS/越权 + 重启持久化", async () => {
  const dir = freshStore();
  const closers = [];
  try {
    const first = await boot(dir);
    closers.push(first.close);

    // 1) activity：同源令牌从这里拿。注意它返回的是**裸对象**（没有 {code,msg,data} 信封）
    const activity = await first.call("GET", "/activity");
    assert.equal(activity.status, 200);
    const token = activity.body.controlToken;
    assert.ok(typeof token === "string" && token.length > 0, "controlToken 必须可拿");

    // 2) 没有 token 的写 → 403
    const noToken = await first.call("POST", "/projects", { name: "无令牌", mainSessionId: "session-a" });
    assert.equal(noToken.body.code, 40301, JSON.stringify(noToken.body));

    // 3) 建项目 + 成员 + 关联
    const created = await first.call("POST", "/projects", { name: "E2E 项目", mainSessionId: "session-a" }, token);
    assert.equal(created.body.code, 200, JSON.stringify(created.body));
    const projectId = created.body.data.project.projectId;
    await first.call("POST", `/projects/${projectId}/members`, { sessionId: "session-b" }, token);
    await first.call("POST", `/projects/${projectId}/members`, { sessionId: "session-worker" }, token);
    const linked = await first.call("POST", `/projects/${projectId}/links`, { a: "session-a", b: "session-worker" }, token);
    assert.equal(linked.body.code, 200, JSON.stringify(linked.body));

    // 4) 建任务（带落点与写入范围）+ 指派（Q4 提示在这里出现）
    const taskA = await first.call("POST", "/tasks", { projectId, subject: "A 改 lib", writeScopes: ["lib/"], worktree: ".dsh-agent-whales/work/A" }, token);
    const taskB = await first.call("POST", "/tasks", { projectId, subject: "B 也改 lib", writeScopes: ["lib/index.js"] }, token);
    const idA = taskA.body.data.task.taskId;
    const idB = taskB.body.data.task.taskId;
    const assignA = await first.call("POST", `/tasks/${idA}/commands`, { projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "e2e-a" }, token);
    assert.equal(assignA.body.code, 200, JSON.stringify(assignA.body));
    assert.equal(assignA.body.data.scopeOrderHint, undefined, "第一个有主的不该有提示");
    const assignB = await first.call("POST", `/tasks/${idB}/commands`, { projectId, action: "assign", owner: "session-worker", expectedRevision: 1, requestId: "e2e-b" }, token);
    assert.ok(typeof assignB.body.data.scopeOrderHint === "string" && assignB.body.data.scopeOrderHint.indexOf("建议补一条依赖") >= 0, "重叠且无顺序必须提示");

    // 5) 派发（worker 没有 followup → dispatch-rejected，但命令本身成功）
    const dispatch = await first.call("POST", `/tasks/${idB}/commands`, { projectId, action: "dispatch", requestId: "e2e-dispatch" }, token);
    assert.equal(dispatch.body.code, 200, JSON.stringify(dispatch.body));
    assert.equal(dispatch.body.data.dispatch.status, "failed", "没有 followup 通道 → dispatch-rejected");

    // 6) report 四态 + CAS 冲突
    const report = await first.call("PUT", `/tasks/${idB}/report`, { projectId, expectedRevision: 2, report: { status: "done", summary: "干完了", artifacts: [{ kind: "file", ref: "lib/index.js" }] }, bySessionId: "session-worker" }, token);
    assert.equal(report.body.code, 200, JSON.stringify(report.body));
    const stale = await first.call("PUT", `/tasks/${idB}/report`, { projectId, expectedRevision: 2, report: { status: "done" }, bySessionId: "session-worker" }, token);
    assert.equal(stale.body.code, 40902, "过期 revision 必须 40902：" + JSON.stringify(stale.body));

    // 7) Q3 核对：只有主对话能核（宿主把 caller 置为主对话）
    const verify = await first.call("POST", `/tasks/${idB}/commands`, { projectId, action: "verify", expectedRevision: 3, requestId: "e2e-verify", note: "e2e 看过" }, token);
    assert.equal(verify.body.code, 200, JSON.stringify(verify.body));
    assert.equal(verify.body.data.verified.by, "session-a");
    assert.equal(verify.body.data.verified.note, "e2e 看过");

    // 8) 简报 CAS + 提案 + 事件台 + 待办 + 交接
    const brief = await first.call("PUT", `/projects/${projectId}/brief`, { expectedVersion: 1, goal: "把 E2E 跑通", decisions: ["先真 HTTP"], constraints: [] }, token);
    assert.equal(brief.body.code, 200, JSON.stringify(brief.body));
    const briefStale = await first.call("PUT", `/projects/${projectId}/brief`, { expectedVersion: 1, goal: "旧版本", decisions: [], constraints: [] }, token);
    assert.equal(briefStale.body.code, 40902, "简报旧版本必须 40902");

    // 提案创建只有 MCP 工具面（HTTP 只有 GET /proposals 与 POST /:id/confirm），
    // 所以这里调真工具——它和 HTTP 路由共用同一把 store 写锁，正是要验的并发面。
    const proposeTool = first.tools.find((tool) => tool.name === "whales_propose_tasks");
    assert.ok(proposeTool, "提案工具必须注册");
    const proposed = await proposeTool.execute({
      leadSessionId: "session-a", projectId, sourceMessageId: "msg-e2e",
      items: [{ key: "T1", title: "E2E 提案", description: "逐字描述", blockedBy: [], suggestedOwner: "session-worker" }]
    }, { agent: { id: "session-a" } });
    const proposalId = proposed && proposed.proposalId ? proposed.proposalId : (proposed && proposed.data ? proposed.data.proposalId : undefined);
    assert.ok(typeof proposalId === "string" && proposalId !== "", "提案必须建出来：" + JSON.stringify(proposed));
    const confirm = await first.call("POST", `/proposals/${proposalId}/confirm`, { leadSessionId: "session-a", version: 1, requestId: "e2e-confirm" }, token);
    assert.equal(confirm.body.code, 200, JSON.stringify(confirm.body));

    const events = await first.call("GET", `/events?projectId=${projectId}`, undefined, token);
    assert.equal(events.body.code, 200, JSON.stringify(events.body));
    assert.ok(Array.isArray(events.body.data.events) && events.body.data.events.length >= 3, "事件台至少记了：任务命令 ×3 + 提案确认");

    const inbox = await first.call("GET", `/inbox?projectId=${projectId}`, undefined, token);
    assert.equal(inbox.body.code, 200, JSON.stringify(inbox.body));

    const handoffs = await first.call("GET", `/handoffs?projectId=${projectId}`, undefined, token);
    assert.equal(handoffs.body.code, 200, JSON.stringify(handoffs.body));

    // 9) 画布存取（GET → PUT → GET）
    const canvasGet = await first.call("GET", `/canvas?projectId=${projectId}`, undefined, token);
    assert.equal(canvasGet.body.code, 200, JSON.stringify(canvasGet.body));
    const canvasPut = await first.call("PUT", `/canvas?projectId=${projectId}`, { expectedRevision: canvasGet.body.data.rev, nodes: { "session-a": { x: 24, y: 24, w: 200, h: 100 } } }, token);
    assert.equal(canvasPut.body.code, 200, JSON.stringify(canvasPut.body));
    const canvasBack = await first.call("GET", `/canvas?projectId=${projectId}`, undefined, token);
    assert.equal(Object.keys(canvasBack.body.data.nodes).length, 1, "节点必须落库");
    assert.equal(canvasBack.body.data.nodes["session-a"].x, 24, "坐标必须原样落库");

    // 10) MCP 约束：建链 → 幂等 → 不存在的服务被前置校验拒
    //     40709 在这里的含义是「服务不存在」（tools.schemas 里没有），不是「会话没连」——
    //     后者由 tools.guard 在会话真去用 mcp__ 工具时才拦（见 mcp-constraint 用例）。
    const mcp = await first.call("POST", `/projects/${projectId}/mcp-links`, { server: "pencil", sessionId: "session-worker" }, token);
    assert.equal(mcp.body.code, 200, JSON.stringify(mcp.body));
    const again = await first.call("POST", `/projects/${projectId}/mcp-links`, { server: "pencil", sessionId: "session-worker" }, token);
    assert.equal(again.body.code, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.already, true, "重复建链必须幂等（already=true），不能建出两条");
    const ghost = await first.call("POST", `/projects/${projectId}/mcp-links`, { server: "slack", sessionId: "session-worker" }, token);
    assert.equal(ghost.body.code, 40709, "不存在的 MCP 服务必须 40709：" + JSON.stringify(ghost.body));

    // 11) 跨项目阻塞 40704
    const other = await first.call("POST", "/projects", { name: "别的项目", mainSessionId: "session-c" }, token);
    const otherId = other.body.data.project.projectId;
    const cross = await first.call("POST", "/tasks", { projectId: otherId, subject: "跨项目阻塞", blockedBy: [idA] }, token);
    assert.equal(cross.body.code, 40704, "跨项目阻塞必须 40704：" + JSON.stringify(cross.body));


    // ── 重启持久化（Q7 真机清单第 2 项）────────────────────────────────
    const second = await boot(dir);
    closers.push(second.close);
    const after = await second.call("GET", `/projects/${projectId}`, undefined, token);
    assert.equal(after.body.code, 200, "重启后项目必须还在");
    assert.equal(after.body.data.project.name, "E2E 项目");
    const tasksAfter = await second.call("GET", `/tasks?projectId=${projectId}`, undefined, token);
    const found = tasksAfter.body.data.tasks.find((row) => row.taskId === idB);
    assert.ok(found, "重启后任务必须还在");
    assert.equal(found.report.status, "done", "重启后 report 必须还在");
    assert.equal(found.verified.by, "session-a", "重启后核对字段必须还在");
    const canvasAfter = await second.call("GET", `/canvas?projectId=${projectId}`, undefined, token);
    assert.equal(Object.keys(canvasAfter.body.data.nodes).length, 1, "重启后画布节点必须还在（Q7 第 2 项）");
    const eventsAfter = await second.call("GET", `/events?projectId=${projectId}`, undefined, token);
    assert.ok(eventsAfter.body.data.events.length >= 3, "重启后事件台账必须还在");
  } finally {
    // 先关 server 再删目录：Node 的 server 不关，node --test 会一直等着不退
    for (const close of closers) {
      try { await close(); } catch (error) { /* 已经关了也无所谓 */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
