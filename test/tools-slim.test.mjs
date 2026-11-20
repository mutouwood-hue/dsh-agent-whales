// 重新规划 R1：agent 工具 17 → 12。
//   · 画布 5 → 1：只留只读 whales_canvas_inspect（projectId 缺省 = 调用者所在项目，替代被删的 list）
//   · 串门 5 → 3：resume 并入 send（对方离线自动唤醒），trace 并入 read（trace: true）
//   · 新增 whales_requirement（读 / 建 / 改需求；不能确认设计、设负责人、标可接受）
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = await import("../lib/index.js");
const here = dirname(fileURLToPath(import.meta.url));
process.env.DSH_AGENT_WHALES_PRESET_DIR = mkdtempSync(join(tmpdir(), "aw-slim-presets-"));

const WHALES_12 = ["whales_brief_read", "whales_brief_write", "whales_canvas_inspect", "whales_e2e_report", "whales_flow_draw", "whales_flow_read", "whales_propose_tasks", "whales_prototype_draw", "whales_requirement", "whales_visit_list", "whales_visit_read", "whales_visit_send"];
const REMOVED = ["whales_canvas_list", "whales_canvas_layout", "whales_canvas_link", "whales_canvas_unlink", "whales_visit_resume", "whales_visit_trace"];

function assertLossless(value, label) {
  let text;
  assert.doesNotThrow(() => { text = JSON.stringify(value); }, label + " 必须可 JSON 序列化");
  assert.deepEqual(JSON.parse(text), value, label + " 往返后必须深等价");
}

/** 完整假宿主：路由 + 工具 + agents（可 resume）+ sessions。返回 call（HTTP）、tools、resumed 记录。 */
async function boot(options = {}) {
  const routes = [];
  const tools = {};
  const resumed = [];
  const live = new Set(options.live || ["session-a", "session-b", "session-c"]);
  const known = options.known || ["session-a", "session-b", "session-c", "session-offline"];
  const followups = [];
  const agentOf = (id) => ({ id, status: "idle", session: { id, events: [] }, followup: (m) => { followups.push({ to: id, via: "followup", text: m && m.content && m.content[0] ? m.content[0].text : "" }); }, steer: (m) => { followups.push({ to: id, via: "steer", text: m && m.content && m.content[0] ? m.content[0].text : "" }); } });
  const ctx = {
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return { list: () => [], get: (id) => (known.includes(id) ? { id, title: id, running: true, session: { id } } : undefined) };
      if (name === "agents") return {
        get: (id) => (live.has(id) ? agentOf(id) : undefined),
        list: () => [...live].map(agentOf),
        resume: async (opts) => {
          resumed.push(opts.resumeSessionId);
          if (options.resumeThrows) throw new Error(options.resumeThrows);
          if (options.resumeReturnsNothing) return { agent: undefined };
          live.add(opts.resumeSessionId);
          return { agent: agentOf(opts.resumeSessionId), dispose: async () => {} };
        }
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
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
    return { status: res.status, body: parsed };
  }
  const close = () => new Promise((resolve) => { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); server.close(() => resolve()); });
  return { call, close, tools, resumed, live, followups };
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "aw-slim-"));
  plugin.setProjectStorePathForTests(join(dir, "projects.json"));
  plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
  plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  plugin.setEventsStorePathForTests(join(dir, "events.json"));
  return dir;
}

async function withApp(options, run) {
  const dir = freshStore();
  const app = await boot(options);
  try {
    const token = (await app.call("GET", "/activity")).body.controlToken;
    const projectId = (await app.call("POST", "/projects", { name: "瘦身项目", mainSessionId: "session-a" }, token)).body.data.project.projectId;
    await app.call("POST", `/projects/${projectId}/members`, { sessionId: "session-b" }, token);
    await app.call("POST", `/projects/${projectId}/members`, { sessionId: "session-offline" }, token);
    return await run({ app, token, projectId, dir, as: (id) => ({ agent: { id } }) });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ── 清单 ─────────────────────────────────────────────────────────────────────

test("工具清单：恰好 12 个 whales_* 工具；被合并 / 删除的 6 个不再注册；每个工具都有 render 并返回 text block", async () => {
  await withApp({}, async ({ app }) => {
    const names = Object.keys(app.tools).filter((n) => n.startsWith("whales_")).sort();
    assert.deepEqual(names, WHALES_12);
    for (const gone of REMOVED) assert.equal(app.tools[gone], undefined, gone + " 不应再注册");
    for (const name of names) {
      const blocks = app.tools[name].output.render({}, {});
      assert.ok(Array.isArray(blocks) && blocks[0].type === "text", name + " 的 render 必须给 text block 数组");
    }
  });
});

test("文档防漂移：随包 skill、README 里点名的 whales_* 工具必须都是真实注册的；源码里不再提到被删的工具名", async () => {
  await withApp({}, async ({ app }) => {
    const registered = new Set(Object.keys(app.tools));
    const skillFiles = [];
    const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".md")) skillFiles.push(full); } };
    walk(join(here, "..", "skills"));
    assert.ok(skillFiles.length >= 3, "skills 下的 md 文件要被扫到");
    for (const file of skillFiles) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bwhales_[a-z0-9_]+\b/g)) {
        if (m[0].endsWith("_")) continue;
        assert.ok(registered.has(m[0]), `${file.replace(join(here, ".."), "")} 提到了不存在的工具 ${m[0]}`);
      }
    }
    const source = readFileSync(join(here, "..", "lib", "index.js"), "utf8");
    for (const gone of REMOVED) assert.equal(source.includes('"' + gone + '"'), false, "lib/index.js 里还注册 / 引用着 " + gone);
  });
});

// ── whales_requirement ──────────────────────────────────────────────────────

test("whales_requirement：list / get / create / update 的正常路径；create 的 Composer 是调用者；输出 lossless", async () => {
  await withApp({}, async ({ app, projectId, as }) => {
    const tool = app.tools.whales_requirement;
    const empty = await tool.execute({ action: "list" }, as("session-a"));
    assert.deepEqual([empty.projectId, empty.requirements], [projectId, []]);
    const created = await tool.execute({ action: "create", title: "表单导入", goal: "把 xlsx 导进表单", acceptance: ["上传并识别表头", "未匹配字段给建议"] }, as("session-b"));
    assert.equal(created.requirement.title, "表单导入");
    assert.equal(created.requirement.composerSessionId, "session-b", "Composer = 调用者（它是成员）");
    assert.equal(created.requirement.ownerSessionId, "", "agent 建的需求没有负责人：负责人只有人能指定");
    assert.equal(created.requirement.stage, "clarify");
    assert.deepEqual(created.requirement.acceptance, ["上传并识别表头", "未匹配字段给建议"]);
    assertLossless(created, "create");
    const listed = await tool.execute({ action: "list" }, as("session-a"));
    assert.deepEqual(listed.requirements.map((r) => [r.reqId, r.title, r.stage, r.ownerSessionId]), [[created.requirement.reqId, "表单导入", "clarify", ""]]);
    assert.equal(listed.requirements[0].acceptance, undefined, "list 只给摘要，不带验收点全文（要看用 get）");
    const got = await tool.execute({ action: "get", reqId: created.requirement.reqId }, as("session-a"));
    assert.deepEqual(got.requirement.acceptance, ["上传并识别表头", "未匹配字段给建议"]);
    const updated = await tool.execute({ action: "update", reqId: created.requirement.reqId, title: "表单导入 v2", acceptance: ["只留一条"] }, as("session-a"));
    assert.equal(updated.requirement.title, "表单导入 v2");
    assert.deepEqual(updated.requirement.acceptance, ["只留一条"]);
    assert.equal(updated.requirement.goal, "把 xlsx 导进表单", "没给的字段不动");
    assert.equal(updated.requirement.revision, created.requirement.revision + 1);
    for (const out of [listed, got, updated]) assertLossless(out, "output");
    const render = tool.output.render({}, updated);
    assert.equal(render[0].type, "text");
    assert.match(render[0].text, /表单导入 v2/);
  });
});

test("whales_requirement：agent 不能碰只有人能做的事——负责人 / 返工上限 / Composer / 设计版本等字段一律拒绝；未知 action 与未知字段拒绝", async () => {
  await withApp({}, async ({ app, as }) => {
    const tool = app.tools.whales_requirement;
    const made = (await tool.execute({ action: "create", title: "A" }, as("session-a"))).requirement;
    for (const field of ["ownerSessionId", "reworkCap", "composerSessionId", "designVersion", "designConfirmedAt", "stage", "reworkCount"]) {
      // 必须是「只有人能」这句话：agent 看到它才知道该让用户去改，而不是只看到一句不明所以的「不允许的字段」。
      await assert.rejects(() => tool.execute({ action: "update", reqId: made.reqId, title: "B", [field]: field === "reworkCap" ? 5 : "x" }, as("session-a")), new RegExp("\\[40301\\] " + field + " 只有人能设置"), field + " 必须被拒，且告诉 agent 这是只有人能做的事");
      await assert.rejects(() => tool.execute({ action: "create", title: "C", [field]: "x" }, as("session-a")), new RegExp("\\[40301\\] " + field + " 只有人能设置"), "create 也一样：" + field);
    }
    await assert.rejects(() => tool.execute({ action: "confirm-design", reqId: made.reqId }, as("session-a")), /action must be one of/);
    await assert.rejects(() => tool.execute({ action: "update", reqId: made.reqId, banana: 1 }, as("session-a")), /不允许的字段|not allowed/);
    await assert.rejects(() => tool.execute({}, as("session-a")), /action must be one of/);
    assert.equal((await tool.execute({ action: "get", reqId: made.reqId }, as("session-a"))).requirement.ownerSessionId, "", "被拒之后什么都没变");
  });
});

test("whales_requirement：校验与边界——标题必填 / 长度；update 至少改一个字段；虚拟「未归类」与别的项目的需求都读不到、改不了；CAS 冲突带最新 revision；身份取自执行上下文", async () => {
  await withApp({}, async ({ app, token, as }) => {
    const tool = app.tools.whales_requirement;
    await assert.rejects(() => tool.execute({ action: "create" }, as("session-a")), /title is required/);
    await assert.rejects(() => tool.execute({ action: "create", title: "x".repeat(81) }, as("session-a")), /title exceeds 80/);
    await assert.rejects(() => tool.execute({ action: "create", title: "A", acceptance: "x" }, as("session-a")), /acceptance must be an array/);
    const made = (await tool.execute({ action: "create", title: "A" }, as("session-a"))).requirement;
    await assert.rejects(() => tool.execute({ action: "update", reqId: made.reqId }, as("session-a")), /nothing to update/);
    await assert.rejects(() => tool.execute({ action: "update", title: "B" }, as("session-a")), /reqId is required/);
    await assert.rejects(() => tool.execute({ action: "get", reqId: "req-nope" }, as("session-a")), /\[40401\]/);
    await assert.rejects(() => tool.execute({ action: "update", reqId: "unassigned", title: "B" }, as("session-a")), /virtual|未归类/);
    // 先让「未归类」真的存在：有两个需求、又来一个说不清归谁的任务 → 落到虚拟需求。否则这条断言空转（视图根本不存在，当然 40401）。
    await tool.execute({ action: "create", title: "第二个需求" }, as("session-b"));
    const projectId = (await app.call("GET", "/projects")).body.data.projects[0].projectId;
    assert.equal((await app.call("POST", "/tasks", { projectId, subject: "说不清归谁的任务" }, token)).body.code, 200);
    const viaHttp = (await app.call("GET", `/projects/${projectId}/requirements`)).body.data.requirements;
    assert.ok(viaHttp.some((r) => r.reqId === "unassigned" && r.virtual), "前提：虚拟的未归类确实存在");
    assert.equal((await tool.execute({ action: "list" }, as("session-a"))).requirements.some((r) => r.reqId === "unassigned"), false, "list 不列虚拟需求");
    await assert.rejects(() => tool.execute({ action: "get", reqId: "unassigned" }, as("session-a")), /\[40401\]/, "虚拟的「未归类」不是需求，get 也读不到");
    // 别的项目的需求
    const other = (await app.call("POST", "/projects", { name: "别的", mainSessionId: "session-c" }, token)).body.data.project.projectId;
    const theirs = (await app.call("POST", `/projects/${other}/requirements`, { title: "别人的" }, token)).body.data.requirement;
    await assert.rejects(() => tool.execute({ action: "get", reqId: theirs.reqId }, as("session-a")), /\[40401\]/, "读不到别的项目的需求");
    await assert.rejects(() => tool.execute({ action: "update", reqId: theirs.reqId, title: "改了" }, as("session-a")), /\[40401\]/, "也改不了");
    // CAS
    await tool.execute({ action: "update", reqId: made.reqId, title: "B", expectedRevision: made.revision }, as("session-a"));
    await assert.rejects(() => tool.execute({ action: "update", reqId: made.reqId, title: "C", expectedRevision: made.revision }, as("session-a")), /\[40902\].*latestRevision/s);
    // 身份：拿不到执行上下文就拒绝；不在任何项目里
    await assert.rejects(() => tool.execute({ action: "list" }, {}), /\[40301\]/);
    const outsider = await tool.execute({ action: "list" }, as("session-c-not-in-project"));
    assert.equal(outsider.projectId, null, "不在项目里：只读调用给空结果而不是报错，也不自动建项目");
    assert.deepEqual(outsider.requirements, []);
    assert.match(outsider.note, /不属于任何项目/);
    await assert.rejects(() => tool.execute({ action: "create", title: "X" }, as("session-c-not-in-project")), /\[40703\]/, "写需求要求本对话在项目里");
  });
});

// ── whales_canvas_inspect ───────────────────────────────────────────────────

test("whales_canvas_inspect：projectId 可省略（= 调用者所在项目，替代被删的 list）；给了就读指定项目；两者都没有给明确错误", async () => {
  await withApp({}, async ({ app, token, projectId, as }) => {
    const tool = app.tools.whales_canvas_inspect;
    assert.ok(!tool.parameters.required || !tool.parameters.required.includes("projectId"), "projectId 不再是必填");
    const own = await tool.execute({}, as("session-a"));
    assert.equal(own.projectId, projectId);
    assert.deepEqual(own.members.map((m) => m.sessionId).sort(), ["session-a", "session-b", "session-offline"]);
    const other = (await app.call("POST", "/projects", { name: "别的", mainSessionId: "session-c" }, token)).body.data.project.projectId;
    assert.equal((await tool.execute({ projectId: other }, as("session-a"))).projectId, other, "显式 projectId 优先");
    const none = await tool.execute({}, as("session-nobody"));
    assert.equal(none.error.code, 40401);
    assert.match(none.error.message, /not in any project/);
    assert.equal((await tool.execute({}, {})).error.code, 40001, "拿不到调用者身份又没给 projectId");
    assertLossless(own, "inspect");
  });
});

// ── whales_visit_read：trace 选项 ───────────────────────────────────────────

test("whales_visit_read：trace=true 走回合轨迹（原 trace 工具）；turns 只配 trace、limit 只配文字行，混用明确报错；默认形状不变", async () => {
  await withApp({}, async ({ app, as }) => {
    const tool = app.tools.whales_visit_read;
    assert.equal(tool.parameters.properties.trace.type, "boolean");
    assert.equal(tool.parameters.properties.turns.type, "number");
    await assert.rejects(() => tool.execute({ sessionId: "session-b", turns: 3 }, as("session-a")), /turns 只在 trace=true 时有效/);
    await assert.rejects(() => tool.execute({ sessionId: "session-b", trace: true, limit: 5 }, as("session-a")), /limit 只用于文字行/);
    await assert.rejects(() => tool.execute({ sessionId: "session-b", trace: "yes" }, as("session-a")), /trace 必须是布尔值/);
    const plain = await tool.execute({ sessionId: "session-b" }, as("session-a"));
    assert.deepEqual(Object.keys(plain).sort(), ["messages", "sessionId", "total"], "不带 trace：和以前完全一样");
    await assert.rejects(() => tool.execute({ sessionId: "session-b", trace: true, turns: 0 }, as("session-a")), /1 到 20 的整数/);
  });
});

// ── whales_visit_send：对方离线自动唤醒 ─────────────────────────────────────

test("whales_visit_send：对方在线不唤醒；离线则自动唤醒再发（输出 resumed:true）；唤醒失败 / 唤醒后仍不在线都如实报错，不谎称已送达", async () => {
  await withApp({}, async ({ app, as }) => {
    const send = app.tools.whales_visit_send;
    assert.match(send.description, /离线.*自动/s, "描述要说明离线会自动唤醒");
    const online = await send.execute({ sessionId: "session-b", message: "在吗" }, as("session-a"));
    assert.deepEqual([online.accepted, online.resumed], [true, undefined], "在线：不唤醒，输出里没有 resumed");
    assert.deepEqual(app.resumed, []);
    const woke = await send.execute({ sessionId: "session-offline", message: "起来干活" }, as("session-a"));
    assert.deepEqual(app.resumed, ["session-offline"]);
    assert.deepEqual([woke.accepted, woke.resumed], [true, true]);
    assert.equal(app.followups.filter((f) => f.to === "session-offline").length, 1, "唤醒后消息真的送到了");
    assertLossless(woke, "send");
    assert.match(send.output.render({}, woke)[0].text, /已唤醒/);
  });
  await withApp({ resumeThrows: "resume boom" }, async ({ app, as }) => {
    await assert.rejects(() => app.tools.whales_visit_send.execute({ sessionId: "session-offline", message: "x" }, as("session-a")), /resume boom/);
    assert.equal(app.followups.length, 0, "唤醒失败：一条消息都没发");
  });
  await withApp({ resumeReturnsNothing: true }, async ({ app, as }) => {
    await assert.rejects(() => app.tools.whales_visit_send.execute({ sessionId: "session-offline", message: "x" }, as("session-a")), /仍不在线|没有拿到/);
    assert.equal(app.followups.length, 0);
  });
});

test("whales_visit_send：访问闸仍在唤醒之前——两个普通成员之间没有关联线时被拒，且不会唤醒对方；报错告诉 agent 该让用户在画布上连线（因为 agent 已不能自己建线）", async () => {
  await withApp({}, async ({ app, as }) => {
    // 成员入项目只自动连主对话（session-a）。session-b → session-offline 没有线。
    const send = app.tools.whales_visit_send;
    await assert.rejects(() => send.execute({ sessionId: "session-offline", message: "x" }, as("session-b")), /\[40707\].*关联线.*用户在画布上/s);
    assert.deepEqual(app.resumed, [], "被闸拦下的发送不会触发唤醒");
    assert.equal(app.followups.length, 0);
    // 主对话 → 成员：有自动建的线，离线成员被唤醒
    const ok = await send.execute({ sessionId: "session-offline", message: "起来" }, as("session-a"));
    assert.equal(ok.resumed, true);
    assert.deepEqual(app.resumed, ["session-offline"]);
  });
});

test("whales_visit_send：跨项目被拒（40704）且不唤醒", async () => {
  await withApp({}, async ({ app, token, as }) => {
    await app.call("POST", "/projects", { name: "别的", mainSessionId: "session-c" }, token);
    await assert.rejects(() => app.tools.whales_visit_send.execute({ sessionId: "session-offline", message: "x" }, as("session-c")), /\[40704\]/);
    assert.deepEqual(app.resumed, []);
  });
});

test("所有 whales_* 工具的成功返回值都是无损 JSON（真宿主会拒收含 undefined 的输出：INVALID_TOOL_OUTPUT「value is not lossless JSON」）", async () => {
  // 真机（2026-11-20，0.2.2 宿主 + 真模型）：whales_brief_read 不带参数 → 没有对话简报时 conversationBrief / truncated / omitted 是 undefined →
  // 宿主报 value is not lossless JSON，模型拿不到简报。单测里的假宿主不校验输出，所以一直没发现。
  await withApp({}, async ({ app, projectId, as }) => {
    const calls = [
      ["whales_brief_read", {}, "session-a"],
      ["whales_brief_read", {}, "session-b"],
      ["whales_brief_read", { projectId }, "session-a"],
      ["whales_brief_read", { sessionId: "session-a" }, "session-a"],
      ["whales_brief_write", { projectId, goal: "目标" }, "session-a"],
      ["whales_brief_write", { duty: "负责后端" }, "session-b"],
      ["whales_brief_read", {}, "session-b"],
      ["whales_canvas_inspect", {}, "session-a"],
      ["whales_canvas_inspect", { projectId }, "session-a"],
      ["whales_visit_list", {}, "session-a"],
      ["whales_visit_read", { sessionId: "session-b" }, "session-a"],
      ["whales_flow_read", {}, "session-a"],
      ["whales_requirement", { action: "list" }, "session-a"],
      ["whales_requirement", { action: "create", title: "A" }, "session-b"]
    ];
    let resolved = 0;
    const seen = new Set();
    for (const [name, args, as_] of calls) {
      assert.ok(app.tools[name], name + " 已注册");
      let out;
      try { out = await app.tools[name].execute(args, as(as_)); } catch (error) { continue; } // 拒绝不是本测试关心的：只管「成功返回的值」
      resolved += 1; seen.add(name);
      assertLossless(out, name + " " + JSON.stringify(args));
      assert.doesNotMatch(JSON.stringify(out, (k, v) => (v === undefined ? "__UNDEF__" : v)), /__UNDEF__/, name + " 的返回里不能有 undefined 值");
    }
    assert.ok(resolved >= 10, "至少 10 次调用真的成功返回（否则这条测试是空转），实际 " + resolved);
    for (const must of ["whales_brief_read", "whales_brief_write", "whales_canvas_inspect", "whales_requirement"]) assert.ok(seen.has(must), must + " 至少成功返回过一次");
  });
});

test("losslessResult / losslessTools：undefined 键被去掉、整体 undefined 变 null、嵌套与数组里的 undefined 也处理；只包 whales_ 前缀的工具；其余成员原样透传", async () => {
  assert.equal(plugin.losslessResult(undefined), null);
  assert.deepEqual(plugin.losslessResult({ a: 1, b: undefined, c: { d: undefined, e: [1, undefined, { f: undefined }] } }), { a: 1, c: { e: [1, null, {}] } }, "嵌套里的 undefined 键去掉；数组里的 undefined 变 null（JSON 语义）");
  assertLossless(plugin.losslessResult({ x: undefined, y: [undefined] }), "result");
  const registered = [];
  const base = { register: (tool, extra) => { registered.push({ tool, extra }); return () => "disposed"; }, schemas: () => ["S"], marker: 7 };
  const wrapped = plugin.losslessTools(base);
  const mine = { name: "whales_demo", execute: async () => ({ ok: true, hidden: undefined }) };
  const theirs = { name: "other_plugin_tool", execute: async () => ({ ok: true, hidden: undefined }) };
  assert.equal(typeof wrapped.register(mine, "x"), "function", "register 的返回值（注销器）原样透传");
  wrapped.register(theirs);
  assert.notEqual(registered[0].tool, mine, "whales_ 工具被包了一层");
  assert.equal(registered[0].extra, "x", "多余参数原样透传");
  assert.deepEqual(await registered[0].tool.execute(), { ok: true }, "包过的 execute 返回无损值");
  assert.equal(registered[1].tool, theirs, "别的插件的工具不动：传给宿主的就是同一个对象");
  assert.deepEqual(wrapped.schemas(), ["S"], "非 register 的函数成员透传且可调用");
  assert.equal(wrapped.marker, 7, "非函数成员透传");
  // 宿主的 tools 服务是带私有字段的类实例：方法不 bind 到真实对象，经 Proxy 转发时 this 是代理，读 #私有字段 会抛 TypeError
  class HostToolsService { #secret = 42; register(tool) { return () => tool.name; } peek() { return this.#secret; } }
  const hostLike = plugin.losslessTools(new HostToolsService());
  assert.equal(hostLike.peek(), 42, "私有字段方法经包装后仍可调用");
  assert.equal(hostLike.register({ name: "whales_x", execute: async () => 1 })(), "whales_x");
  assert.equal(plugin.losslessTools(undefined), undefined, "没有 tools 服务：原样返回");
  const noRegister = { schemas: () => [] };
  assert.equal(plugin.losslessTools(noRegister), noRegister, "没有 register：不包");
  const noExec = { name: "whales_noexec" };
  assert.equal(plugin.losslessTool(noExec), noExec, "没有 execute：不动");
  const rejecting = plugin.losslessTool({ name: "whales_boom", execute: async () => { throw new Error("[40301] nope"); } });
  await assert.rejects(() => rejecting.execute(), /\[40301\] nope/, "execute 抛错原样抛出（不吞、不改写）");
});
