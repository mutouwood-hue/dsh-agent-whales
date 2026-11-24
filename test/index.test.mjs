/**
 * 宿主半边（lib/index.js）的对抗性回归测试。
 *   node --test test/            # 通过 test/index.js 汇总执行
 *   node --test "test/*.test.mjs"
 *
 * lib/index.js 顶层只有常量与函数定义（randomUUID import + TEAM_POLICY 等），
 * 没有在模块加载时碰 ctx / 网络 / 文件系统，所以可以直接静态 import 真实导出。
 *
 * 这一组用例针对历史事故与「默认插件」级别的不变量：
 *   - 工具 schema 必须是 { type: "object" }（曾经 type:null 让全网请求 400）
 *   - 工具返回值必须是 lossless JSON（曾经 { reply: { text: undefined } } 被判非法）
 *   - 会话日志兼容层遇到脏事件必须回空数组而不是抛错
 *   - apply() 在宿主服务缺失 / 全部抛错 / 注册失败时都必须安静降级
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 串门工具的身份只取执行上下文（P2 修法），测试里统一用这个假身份。 */
const VISIT_EXEC = { agent: { id: "caller-visit" } };
import { pathToFileURL, fileURLToPath } from "node:url";

import * as host from "../lib/index.js";

// 汇总执行时（test/index.js 把所有文件 import 进同一进程）会与其它测试文件共享模块状态：
// 这里把 store 指到本文件专属的临时目录，避免被别的用例的项目数据影响。
const ISOLATED_STORE_DIR = mkdtempSync(join(tmpdir(), "aw-index-"));
host.setProjectStorePathForTests(join(ISOLATED_STORE_DIR, "projects.json"));
host.setProposalStorePathForTests(join(ISOLATED_STORE_DIR, "proposals.json"));
host.setHandoffsStorePathForTests(join(ISOLATED_STORE_DIR, "handoffs.json"));
// ultra 模式（2026-11-16）：状态文件同样指到临时目录——否则本文件的用例会读写真实的
// ~/.dsh/agent-whales/ultra.json，把用户机器上的开关状态当成测试副作用翻掉。
host.setUltraModePathForTests(join(ISOLATED_STORE_DIR, "ultra.json"));
// W1：preset 安装器的目标根也指向临时目录——否则本文件每次 host.apply 都会往真实
// ~/.dsh/.agent-presets 写文件（那是生产行为，不该由单元测试触发）。
process.env.DSH_AGENT_WHALES_PRESET_DIR = join(ISOLATED_STORE_DIR, "presets");

// 串门工具 5 → 3（重新规划 R1）：resume 并入 send（离线自动唤醒），trace 并入 read（trace:true）。
const KNOWN_TOOLS = [
  "whales_visit_list",
  "whales_visit_send",
  "whales_visit_read"
];

/** 宿主按「序列化 → 解析」校验工具输出；undefined/NaN/Infinity 都会在这里失真。 */
function assertLossless(value, label = "value") {
  let text;
  assert.doesNotThrow(() => { text = JSON.stringify(value); }, label + " 必须可 JSON 序列化");
  assert.deepEqual(JSON.parse(text), value, label + " 经过 JSON.stringify 往返后必须深等价");
}

/** 注册一个只提供 tools 服务的假宿主，收集注册到的工具定义。 */
function captureTools() {
  const registered = {};
  host.apply({
    get(name) {
      if (name === "tools") {
        return {
          register(definition) {
            registered[definition.name] = definition;
            return () => {};
          }
        };
      }
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  });
  return registered;
}

/** 注册工具，同时给假宿主提供 agents / workspaceRegistry 等服务。 */
function captureToolsWithServices(services = {}) {
  const registered = {};
  host.apply({
    get(name) {
      if (name === "tools") {
        return {
          register(definition) {
            registered[definition.name] = definition;
            return () => {};
          }
        };
      }
      return services[name];
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  });
  return registered;
}

/** 注册只提供 webServer 的假宿主，返回唯一的路由定义。 */
function mountRoute() {
  const routes = [];
  host.apply({
    get(name) {
      if (name === "webServer") {
        return { register(route) { routes.push(route); return () => {}; } };
      }
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  });
  assert.equal(routes.length, 1, "webServer.register 必须被调用一次");
  return routes[0];
}

/** 调用路由 handler，记录 status / headers / body。 */
function callRoute(route, request) {
  const headers = {};
  let body;
  const response = {
    statusCode: 0,
    setHeader(key, value) { headers[String(key).toLowerCase()] = value; },
    end(text) { body = text; }
  };
  assert.doesNotThrow(() => route.handler(request, response), "路由 handler 不允许把异常抛回宿主");
  return { status: response.statusCode, headers, body };
}

/**
 * 挂一个同时带 tools 注册表与 webServer 路由的假宿主，用于「串门工具开关」。
 * registry 真实模拟 tools.register/注销，stats 记录注册/注销次数以验证幂等。
 */
function mountControlHost(config) {
  const registry = new Map();
  const stats = { registerCalls: 0, disposeCalls: 0, registerNames: [], disposeNames: [] };
  const routes = [];
  host.apply({
    get(name) {
      if (name === "tools") {
        return {
          register(definition) {
            stats.registerCalls += 1;
            stats.registerNames.push(definition.name);
            registry.set(definition.name, definition);
            return () => {
              stats.disposeCalls += 1;
              stats.disposeNames.push(definition.name);
              if (registry.get(definition.name) === definition) registry.delete(definition.name);
            };
          }
        };
      }
      if (name === "webServer") {
        return { register(route) { routes.push(route); return () => {}; } };
      }
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  }, config);
  assert.equal(routes.length, 1, "活动路由必须挂载一次");
  return { registry, stats, route: routes[0] };
}

/** GET 活动快照并解析 JSON。 */
function getActivity(route) {
  const result = callRoute(route, { method: "GET", url: "/agent-whales/api/activity" });
  assert.equal(result.status, 200, "GET 活动快照必须 200");
  return JSON.parse(result.body);
}

/**
 * POST /agent-whales/api/visit-tools 的异步请求。
 * 请求体按真实 IncomingMessage 的 EventEmitter 语义投递（handler 先在 req 上挂 data/end）。
 */
function postVisitTools(route, options = {}) {
  const { token, body, method = "POST" } = options;
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = "/agent-whales/api/visit-tools";
    req.headers = token === undefined ? {} : { "x-whales-token": token };
    const headers = {};
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("POST /visit-tools 1s 内没有响应（handler 可能挂起）"));
    }, 1_000);
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader(key, value) { headers[String(key).toLowerCase()] = value; },
      end(text) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.headersSent = true;
        resolve({ status: this.statusCode, headers, body: text });
      }
    };
    try {
      route.handler(req, res);
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
      return;
    }
    setImmediate(() => {
      if (settled) return;
      try {
        if (body !== undefined) req.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(body));
        req.emit("end");
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function visitToolNames(registry) {
  return [...registry.keys()].filter((name) => name.startsWith("whales_visit_")).sort();
}

/** 只统计串门工具的注册/注销次数（提案工具不归串门开关管）。 */
function visitOnly(names) {
  return names.filter((name) => name.startsWith("whales_visit_"));
}

// ── 1. activityPayload：工具活动快照 ───────────────────────────────────────

test("activityPayload：空表 / 正常条目 / TTL 边界", () => {
  assert.deepEqual(host.activityPayload(new Map(), 1000, 500), { at: 1000, active: {} });

  const table = new Map([
    ["s1", { tool: "read", startedAt: 750 }],
    ["s2", { tool: "bash", startedAt: 500 }],
    ["s3", { tool: "pwsh", startedAt: 499 }]
  ]);
  const snapshot = host.activityPayload(table, 1000, 500);
  assert.deepEqual(snapshot.active.s1, { tool: "read", ageMs: 250 });
  assert.deepEqual(snapshot.active.s2, { tool: "bash", ageMs: 500 }, "age === ttl 仍算活跃");
  assert.equal("s3" in snapshot.active, false, "age > ttl 必须丢弃");
  assertLossless(snapshot, "activityPayload");
});

test("activityPayload：NaN/undefined/Infinity 的 startedAt、脏 tool 与时钟回拨都不得进入快照", () => {
  const table = new Map([
    ["bad-nan", { tool: "read", startedAt: NaN }],
    ["bad-missing", { tool: "read" }],
    ["bad-undefined", { tool: "read", startedAt: undefined }],
    ["bad-infinity", { tool: "read", startedAt: Infinity }],
    ["bad-future", { tool: "read", startedAt: 1001 }],
    ["bad-tool-null", { tool: null, startedAt: 900 }],
    ["bad-tool-number", { tool: 42, startedAt: 900 }],
    ["bad-tool-object", { tool: {}, startedAt: 900 }],
    ["bad-entry-null", null],
    ["ok", { tool: "read", startedAt: 900 }]
  ]);
  const snapshot = host.activityPayload(table, 1000, 1000);
  assert.deepEqual(Object.keys(snapshot.active), ["ok"]);
  assert.deepEqual(snapshot.active.ok, { tool: "read", ageMs: 100 });
  assertLossless(snapshot, "activityPayload");
});

test("activityPayload：非 number 的 startedAt 一律丢弃，不得被减法强转成新鲜条目", () => {
  const table = new Map([
    ["string-number", { tool: "read", startedAt: "1000" }],
    ["string-other", { tool: "read", startedAt: "刚刚" }],
    ["date-string", { tool: "read", startedAt: new Date(1000).toISOString() }],
    ["boolean", { tool: "read", startedAt: true }],
    ["ok", { tool: "read", startedAt: 900 }]
  ]);
  const snapshot = host.activityPayload(table, 1000, 1000);
  assert.deepEqual(Object.keys(snapshot.active), ["ok"], "startedAt 必须是 number，否则丢弃（否则 \"1000\" 会被当成 1000）");
  assertLossless(snapshot, "activityPayload");
});

test("activityPayload：非有限 now 也必须产出 lossless JSON（at 是有限数字）", () => {
  const table = new Map([["s1", { tool: "read", startedAt: 900 }]]);
  for (const now of [NaN, Infinity, -Infinity]) {
    let snapshot;
    assert.doesNotThrow(() => { snapshot = host.activityPayload(table, now, 1000); }, "now=" + String(now));
    assert.equal(typeof snapshot.at, "number", "now=" + String(now) + " 时 at 必须是 number");
    assert.ok(Number.isFinite(snapshot.at), "now=" + String(now) + " 时 at 必须有限，实际 " + snapshot.at);
    assertLossless(snapshot, "now=" + String(now) + " 的活动快照");
    assert.equal(typeof snapshot.active, "object");
  }
});

// ── 2. sessionEvents：日志读取兼容层 ──────────────────────────────────────

test("sessionEvents：null/非对象/无日志都回空数组，events 数组与 snapshotEvents 都能读", () => {
  for (const input of [null, undefined, 42, "session", true, {}]) {
    assert.deepEqual(host.sessionEvents(input), [], "输入 " + String(input));
  }

  const events = [{ seq: 1, type: "user/message" }];
  assert.equal(host.sessionEvents({ events }), events, "events 是数组时必须原样返回（下面的折叠依赖同一引用）");
  assert.deepEqual(host.sessionEvents({ snapshotEvents: () => events }), events, "数组不可用时才走 snapshotEvents");

  // events 数组优先于抛错的 snapshotEvents：能读到一个就够了。
  assert.equal(
    host.sessionEvents({ events, snapshotEvents() { throw new Error("boom"); } }),
    events
  );

  assert.deepEqual(host.sessionEvents({ snapshotEvents() { throw new Error("boom"); } }), []);

  // 两个字段都不像日志的会话必须安静回空，而不是把会话搞崩。
  const empty = {};
  Object.defineProperty(empty, "events", { get() { throw new Error("getter boom"); } });
  assert.doesNotThrow(() => host.sessionEvents(empty));
  assert.ok(Array.isArray(host.sessionEvents(empty)), "读不到日志时必须是数组");
});

test("sessionEvents：events 抛错 getter 与 snapshotEvents 返回非数组都要回落到安全值", () => {
  const throwing = { snapshotEvents: () => [{ seq: 1 }] };
  Object.defineProperty(throwing, "events", { get() { throw new Error("getter boom"); } });
  let result;
  assert.doesNotThrow(() => { result = host.sessionEvents(throwing); }, "getter 抛错不能被传播出去");
  assert.ok(Array.isArray(result), "getter 抛错时必须返回数组，实际：" + typeof result);

  for (const bad of ["not-an-array", 42, null, { length: 1 }, undefined]) {
    const session = { snapshotEvents: () => bad };
    const value = host.sessionEvents(session);
    assert.ok(Array.isArray(value), "snapshotEvents 返回 " + String(bad) + " 时必须回空数组");
    assert.deepEqual(value, []);
  }
});

// ── 3. foldMessages：把日志折叠成对话行 ──────────────────────────────────

test("foldMessages：content 为 null/非数组、元素为 null、空文本都不产出行", () => {
  const events = [
    { seq: 0, type: "user/message", data: { content: null } },
    { seq: 1, type: "user/message", data: { content: "not-an-array" } },
    { seq: 2, type: "user/message", data: { content: [null, 42, "text", { type: "text", text: "" }, { type: "text", text: 7 }, { type: "image" }] } },
    { seq: 3, type: "user/message" },
    { seq: 4, type: "assistant/message", data: {} },
    { seq: 5, type: "assistant/message", data: { message: null } },
    { seq: 6, type: "assistant/message", data: { message: { content: [{ type: "text", text: "" }] } } },
    { seq: 7, type: "session/title", data: { title: "不是对话" } },
    null,
    42
  ];
  assert.deepEqual(host.foldMessages(events), []);
  assert.deepEqual(host.foldMessages(null), []);
  assert.deepEqual(host.foldMessages({}), []);
});

test("foldMessages：只收 source.kind=user 的用户消息与 assistant 文本，多段用换行拼接", () => {
  const events = [
    { seq: 1, type: "user/message", data: { source: { kind: "subagent" }, content: [{ type: "text", text: "子代理的话" }] } },
    { seq: 2, type: "user/message", data: { source: { kind: "system" }, content: [{ type: "text", text: "系统注入" }] } },
    { seq: 3, type: "user/message", data: { content: [{ type: "thinking", text: "思维链不算" }, { type: "text", text: "第一段" }, { type: "text", text: "第二段" }] } },
    { seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "回第一段" }, { type: "text", text: "回第二段" }] } } }
  ];
  const rows = host.foldMessages(events);
  assert.deepEqual(rows, [
    { seq: 3, role: "user", text: "第一段\n第二段" },
    { seq: 4, role: "assistant", text: "回第一段\n回第二段" }
  ]);
  assertLossless(rows, "foldMessages 行");
});

test("foldMessages：source 为 null 等畸形来源时不得抛错", () => {
  const events = [
    { seq: 1, type: "user/message", data: { source: null, content: [{ type: "text", text: "没有合法来源" }] } },
    { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "正常用户" }] } }
  ];
  let rows;
  assert.doesNotThrow(() => { rows = host.foldMessages(events); }, "source:null 不能让整个折叠抛错");
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map((row) => row.seq), [2], "畸形来源按非用户消息处理");
});

test("foldMessages：缺 seq 的行里不得留下 undefined（lossless JSON 事故同路径）", () => {
  const rows = host.foldMessages([
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "没有序号" }] } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "回话" }] } } }
  ]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      assert.notEqual(value, undefined, "行内的 " + key + " 不能是 undefined");
    }
    assertLossless(row, "foldMessages 行");
  }
});

// ── 4. titleOf / maxSeq / userMessage ─────────────────────────────────────

test("titleOf：session/title 后写胜；没有标题时回落首条用户消息并压平空白", () => {
  assert.equal(host.titleOf([]), undefined);
  assert.equal(
    host.titleOf([
      { seq: 1, type: "session/title", data: { title: "旧标题" } },
      { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "用户第一句" }] } },
      { seq: 3, type: "session/title", data: { title: "新标题" } }
    ]),
    "新标题",
    "后写的标题胜出"
  );
  assert.equal(
    host.titleOf([
      { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "助手先说话" }] } } },
      { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "  第一句\n  用户消息  " }] } }
    ]),
    "第一句 用户消息",
    "没有标题时取第一条用户消息，并压平空白"
  );
  assert.equal(host.titleOf([{ seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "只有助手" }] } } }]), undefined);
});

test("titleOf：超长截断到 40 字 + 省略号；全空白标题不得胜出", () => {
  const long = "这是一条非常长的用户消息" + "内容".repeat(40);
  const title = host.titleOf([
    { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: long }] } }
  ]);
  assert.ok(title.endsWith("…"), "超长标题必须带省略号");
  assert.equal(title.length, 41, "40 个字符 + 1 个省略号");
  assert.ok(long.startsWith(title.slice(0, 40)));

  const blank = host.titleOf([
    { seq: 1, type: "session/title", data: { title: "   " } },
    { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "真正的标题" }] } }
  ]);
  assert.equal(blank, "真正的标题", "全空白标题必须被忽略，回落到用户消息");

  assert.equal(
    host.titleOf([{ seq: 1, type: "session/title", data: { title: "\n\t " } }]),
    undefined,
    "全空白标题且没有用户消息时宁可不给标题"
  );
});

test("maxSeq：空数组给 -1；字符串/NaN/Infinity 等非法 seq 一律忽略", () => {
  assert.equal(host.maxSeq([]), -1);
  assert.equal(host.maxSeq(null), -1);
  assert.equal(host.maxSeq({}), -1);
  assert.equal(host.maxSeq([null, 42, {}, { seq: "9" }, { seq: NaN }, { seq: Infinity }, { seq: -Infinity }]), -1);
  const mixed = host.maxSeq([{ seq: 3 }, { seq: Infinity }, { seq: 7 }, { seq: NaN }, { seq: "9" }, { seq: -2 }]);
  assert.equal(Number.isFinite(mixed), true, "maxSeq 必须是有限数字，实际 " + mixed);
  assert.equal(mixed, 7, "只比较有限的数字 seq");
});

test("确定性畸变输入：foldMessages/titleOf/maxSeq/activityPayload 不抛且输出仍是 lossless JSON", () => {
  const values = [
    null, undefined, true, false, 0, -1, NaN, Infinity, "", "x", "12",
    [], [null], {}, { kind: "user" }, { nested: 1 }
  ];
  const types = ["user/message", "assistant/message", "session/title", "tool/result", "", null, 42];
  let seed = 20261030;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];

  const events = [];
  for (let index = 0; index < 400; index += 1) {
    const event = { type: pick(types) };
    if (random() < 0.9) event.seq = random() < 0.6 ? index : pick(values);
    event.data = { content: pick(values), message: pick(values), source: pick(values), title: pick(values) };
    events.push(event);
  }

  let rows;
  assert.doesNotThrow(() => { rows = host.foldMessages(events); }, "畸变日志不能把折叠打崩");
  for (const row of rows) assertLossless(row, "畸变日志行");
  assert.doesNotThrow(() => host.titleOf(events));
  assert.doesNotThrow(() => host.maxSeq(events));

  const table = new Map();
  for (let index = 0; index < 200; index += 1) {
    table.set("s" + index, { tool: pick(values), startedAt: pick(values) });
  }
  let snapshot;
  assert.doesNotThrow(() => { snapshot = host.activityPayload(table, 10_000, 5_000); }, "畸变活动表不能把快照打崩");
  assertLossless(snapshot, "畸变活动表快照");
});

test("userMessage：形状符合 followup/steer 契约，id 唯一且可 lossless 往返", () => {
  const first = host.userMessage("你好");
  const second = host.userMessage("你好");
  assert.equal(first.role, "user");
  assert.equal(first.source.kind, "user");
  assert.deepEqual(first.content, [{ type: "text", text: "你好" }]);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.id, second.id, "每条消息都要有独立 id");
  assertLossless(first, "userMessage");
});

// ── 5. waitForReply：确定性假 session ────────────────────────────────────

test("waitForReply：基线之后的新 assistant 文本立即返回", async () => {
  const session = {
    events: [
      { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "旧回复" }] } } },
      { seq: 5, type: "assistant/message", data: { message: { content: [{ type: "text", text: "新回复" }] } } }
    ]
  };
  const result = await host.waitForReply(session, 3, 1000, undefined);
  assert.equal(result.text, "新回复");
  assert.equal(result.seq, 5);
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.waitedMs, "number");
  assert.ok(Number.isFinite(result.waitedMs) && result.waitedMs >= 0);
});

test("waitForReply：没有超过基线的回复就超时返回 timedOut，而不是抛错", async () => {
  const session = {
    events: [{ seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "基线自身" }] } } }]
  };
  const result = await host.waitForReply(session, 3, 1, undefined);
  assert.equal(result.timedOut, true);
  assert.equal(result.seq, 3, "超时返回基线序号");
  assert.equal(typeof result.waitedMs, "number");
});

test("waitForReply：signal 已 abort 时立即返回而不是继续轮询", async () => {
  const session = {
    events: [{ seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "hi" }] } }]
  };
  const result = await host.waitForReply(session, 1, 60_000, { aborted: true });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.seq, 1);
});

test("waitForReply：超时/abort 的返回值也必须是 lossless JSON（不能带 undefined 键）", async () => {
  const session = { events: [] };
  const timedOut = await host.waitForReply(session, 0, 1, undefined);
  assertLossless(timedOut, "waitForReply 超时结果");
  const aborted = await host.waitForReply(session, 0, 60_000, { aborted: true });
  assertLossless(aborted, "waitForReply abort 结果");
});

test("waitForReply：timeoutMs=0 表示立即超时（工具层才把 ≤0 归一到默认 60s 预算）", async () => {
  const started = Date.now();
  const result = await host.waitForReply({ events: [] }, 0, 0, undefined);
  assert.equal(result.timedOut, true, "预算 0 必须立即超时，而不是等默认 60s");
  assert.equal(result.seq, 0);
  assertLossless(result, "waitForReply 预算 0 结果");
  assert.ok(Date.now() - started < 1_000, "预算 0 不允许真的睡 60 秒");
});

test("waitForReply：假 session 在第二次读取才产出回复，预算内可以等到", async () => {
  let reads = 0;
  const session = {
    snapshotEvents() {
      reads += 1;
      const baseline = { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "在吗" }] } };
      if (reads === 1) return [baseline];
      return [baseline, { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "在的" }] } } }];
    }
  };
  const result = await host.waitForReply(session, 1, 2000, undefined);
  assert.ok(reads >= 2, "必须重新读取日志才能看到新回复");
  assert.equal(result.text, "在的");
  assert.equal(result.seq, 2);
  assert.equal(result.timedOut, false);
});

// ── 6. apply()：降级与工具注册 ───────────────────────────────────────────

test("宿主 apply：没有任何服务、或服务全不存在时安静降级，不抛异常", () => {
  assert.doesNotThrow(() => host.apply({}));
  assert.doesNotThrow(() => host.apply({ get: () => undefined }));
  assert.doesNotThrow(() => host.apply({ get: () => undefined, effect: (run) => run(), on: () => () => {} }));
  assert.doesNotThrow(() => host.apply({ get: () => undefined, effect: (run) => run() }));
});

test("宿主 apply：ctx.get 本身抛错时当作所有服务缺失，不把异常抛给宿主", () => {
  assert.doesNotThrow(() => host.apply({
    get() { throw new Error("ctx disposed"); },
    effect(run) { return run(); },
    on() { return () => {}; }
  }));
});

test("宿主 apply：所有服务方法都抛错时也只丢能力，不把异常抛给宿主", () => {
  const boom = () => { throw new Error("boom"); };
  const ctx = {
    get(name) {
      if (name === "systemPrompt") return { section: boom };
      if (name === "webServer") return { register: boom };
      if (name === "tools") return { register: boom };
      if (name === "agents") return { get: boom, list: boom, resume: boom };
      if (name === "workspaceRegistry") return { list: boom };
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  };
  assert.doesNotThrow(() => host.apply(ctx), "任一宿主服务抛错都不能让整行装配失败");
});

test("宿主工具：每个 parameters 与 output.schema 都是 type=object 的完整 JSON Schema", () => {
  const registered = captureTools();
  const names = Object.keys(registered);
  for (const expected of KNOWN_TOOLS) assert.ok(names.includes(expected), "必须注册 " + expected);
  assert.equal(new Set(names).size, names.length, "工具名不能重复");

  for (const [name, tool] of Object.entries(registered)) {
    assert.equal(typeof tool.description, "string", name + ".description");
    assert.ok(tool.description.length > 0, name + " 必须有非空 description");
    assert.equal(typeof tool.execute, "function", name + " 必须可执行");

    const parameters = tool.parameters;
    assert.ok(parameters && typeof parameters === "object", name + " 缺少 parameters");
    assert.equal(parameters.type, "object", name + " 的 parameters.type 必须是 object（历史事故：type:null → 全网 400）");
    assert.ok(parameters.properties && typeof parameters.properties === "object", name + " 必须声明 properties");
    if (parameters.required !== undefined) {
      assert.ok(Array.isArray(parameters.required), name + ".required 必须是数组");
      for (const key of parameters.required) {
        assert.ok(Object.hasOwn(parameters.properties, key), name + ".required 引用了未声明的属性：" + key);
      }
    }
    for (const [property, definition] of Object.entries(parameters.properties)) {
      assert.ok(definition && typeof definition === "object", name + "." + property + " 必须是 schema 对象");
      assert.equal(typeof definition.type, "string", name + "." + property + " 必须有 type");
    }

    assert.ok(tool.output && typeof tool.output === "object", name + " 缺少 output");
    assert.equal(tool.output.schema.type, "object", name + " 的 output.schema.type 必须是 object");
    assert.equal(typeof tool.output.render, "function", name + " 必须带 output.render");
    assertLossless(parameters, name + ".parameters");
  }
});

test("宿主工具：output.render 只产出 text block，且不吐 undefined", () => {
  const registered = captureTools();
  const samples = {
    whales_visit_list: [
      { sessions: [] },
      { sessions: [{ sessionId: "s1", title: "隔壁", running: true, workspaceId: "w1" }] }
    ],
    whales_visit_send: [
      { sessionId: "s1", mode: "queue", accepted: true, timedOut: false },
      { sessionId: "s1", mode: "steer", accepted: true, timedOut: false, reply: { waitedMs: 12 } }
    ],
    // read 的两种形状：文字行 / trace=true 的回合轨迹（原 whales_visit_trace）
    whales_visit_read: [
      { sessionId: "s1", total: 0, messages: [] },
      { sessionId: "s1", total: 1, messages: [{ seq: 1, role: "user", text: "你好" }] },
      { sessionId: "s1", name: "隔壁", totalTurns: 0, running: false, text: "会话 s1（隔壁）：共 0 个回合，日志里还没有任何回合。" },
      {
        sessionId: "s1",
        name: "隔壁",
        totalTurns: 2,
        running: true,
        text: "会话 s1（隔壁）：共 2 个回合，以下是最新的 2 个（最后一轮仍在执行中，内容可能不完整）：\n\n## 回合 1 · completed\n用户：去读 tool-probe.json\n助手：（无）\n工具：read（失败：FS_NOT_FOUND）"
      }
    ]
  };
  for (const [name, values] of Object.entries(samples)) {
    const tool = registered[name];
    assert.ok(tool, "缺少 " + name);
    for (const value of values) {
      const blocks = tool.output.render({}, value);
      assert.ok(Array.isArray(blocks) && blocks.length > 0, name + " 必须返回非空 content blocks");
      for (const block of blocks) {
        assert.equal(block.type, "text");
        assert.equal(typeof block.text, "string");
      }
      assertLossless(blocks, name + ".output.render");
    }
  }
});

// 真机 2026-11-18：flow / brief / propose 直接把 render(value) → string 交给宿主，
// 宿主调 render(args, value) 拿到字符串当 content，post-execute 链上 content.some 炸掉。
test("宿主工具：所有注册的工具 render(args, value) 都返回 text block 数组，且模型能看到结构化结果", () => {
  const registered = captureTools();
  const samples = {
    whales_flow_read: { projectId: null, flows: [], messages: [{ ref: "m108", role: "user", text: "绘制一个页面原型" }] },
    whales_flow_draw: { drawn: false, reason: "暂不足以生成流程图", dropped: [{ key: "a", reason: "no evidence" }] },
    whales_prototype_draw: { drawn: true, title: "表单导入弹窗", components: 3, projectNote: "已为本对话建项目" },
    whales_brief_read: { brief: { version: 2, goal: "导入导出" } },
    whales_brief_write: { brief: { version: 3 } },
    whales_propose_tasks: { proposalId: "prop-1", version: 1, count: 2 }
  };
  for (const [name, value] of Object.entries(samples)) {
    const tool = registered[name];
    if (tool === undefined) continue; // 按设置可能没注册；注册了就必须守契约
    const args = { limit: 30, title: "不该被当成 value" };
    const blocks = tool.output.render(args, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, name + " 必须返回 content block 数组");
    assert.equal(blocks[0].type, "text", name);
    assert.ok(blocks[0].text.indexOf(JSON.stringify(value)) >= 0, name + " 的结构化结果要进模型可见的 content：" + blocks[0].text);
    assertLossless(blocks, name + ".output.render");
  }
  const flowRead = registered.whales_flow_read;
  assert.ok(flowRead, "whales_flow_read 必须注册");
  assert.ok(flowRead.output.render({}, samples.whales_flow_read)[0].text.indexOf("m108") >= 0, "消息编号必须让模型看得到");
  // 兜底：任何工具的 render 都不能返回字符串
  for (const [name, tool] of Object.entries(registered)) {
    let blocks;
    try { blocks = tool.output.render({}, {}); } catch (error) { continue; } // 空 value 不合形状可以抛，但不能回字符串
    assert.ok(Array.isArray(blocks), name + " 的 render 返回了 " + typeof blocks);
  }
});

test("宿主工具：whales_visit_send 真的等到回话时，reply.text 是字符串且 lossless", async () => {
  let reads = 0;
  const baseline = [
    { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "在吗" }] } }
  ];
  const session = {
    snapshotEvents() {
      reads += 1;
      if (reads === 1) return baseline;
      return baseline.concat([
        { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "在的" }] } } }
      ]);
    }
  };
  const followups = [];
  const agent = { id: "s-reply", status: "idle", session, followup: (message) => followups.push(message), steer() {} };
  const tools = captureToolsWithServices({
    agents: { get: (id) => (id === "s-reply" ? agent : undefined), list: () => [agent] }
  });

  const sent = await tools.whales_visit_send.execute(
    // 默认已是插话；这条用例要验的是「等回话」，显式走 queue 保持原语义
    { sessionId: "s-reply", message: "来串门", mode: "queue", waitForReply: true, timeoutMs: 2000 },
    VISIT_EXEC
  );
  assert.equal(followups.length, 1, "送信走 followup");
  assert.equal(sent.timedOut, false);
  assert.equal(sent.reply.text, "在的", "等到回话必须把文本带回来");
  assert.ok(Number.isFinite(sent.reply.waitedMs) && sent.reply.waitedMs >= 0);
  assertLossless(sent, "whales_visit_send 等到回话");
});

test("宿主工具：whales_visit_read 的 limit 夹到 1..100，默认 20，total 是全部行数", async () => {
  const events = [];
  for (let index = 1; index <= 150; index += 1) {
    const odd = index % 2 === 1;
    events.push({
      seq: index,
      type: odd ? "user/message" : "assistant/message",
      data: odd
        ? { source: { kind: "user" }, content: [{ type: "text", text: "u" + index }] }
        : { message: { content: [{ type: "text", text: "a" + index }] } }
    });
  }
  const agent = { id: "s-read", status: "idle", session: { events } };
  const tools = captureToolsWithServices({
    agents: { get: (id) => (id === "s-read" ? agent : undefined), list: () => [agent] }
  });

  const byDefault = await tools.whales_visit_read.execute({ sessionId: "s-read" }, VISIT_EXEC);
  assert.equal(byDefault.total, 150);
  assert.equal(byDefault.messages.length, 20, "默认最近 20 行");
  assert.equal(byDefault.messages.at(-1).seq, 150, "取的是最近的行");
  assertLossless(byDefault, "whales_visit_read");

  const capped = await tools.whales_visit_read.execute({ sessionId: "s-read", limit: 1000 }, VISIT_EXEC);
  assert.equal(capped.messages.length, 100, "上限 100");
  assert.equal(capped.messages[0].seq, 51);

  const floored = await tools.whales_visit_read.execute({ sessionId: "s-read", limit: 1.9 }, VISIT_EXEC);
  assert.equal(floored.messages.length, 1, "limit 向下取整");

  const negative = await tools.whales_visit_read.execute({ sessionId: "s-read", limit: -5 }, VISIT_EXEC);
  assert.equal(negative.messages.length, 20, "非正数按默认 20 处理");
  assert.equal(negative.messages.at(-1).seq, 150);
});

test("宿主工具：whales_visit_list 在 agents.list 抛错时回落到工作区清单，不炸", async () => {
  const live = {
    id: "live-1",
    status: "idle",
    session: { events: [{ seq: 1, type: "session/title", data: { title: "活着的会话" } }] }
  };
  const tools = captureToolsWithServices({
    agents: {
      list() { throw new Error("list boom"); },
      get: (id) => (id === "live-1" ? live : undefined)
    },
    workspaceRegistry: { list: () => [{ id: "w1", sessionIds: ["off-1", "live-1"] }] }
  });

  const result = await tools.whales_visit_list.execute({}, VISIT_EXEC);
  assert.equal(result.count, 2, "工作区里的两个会话都要列出来");
  assert.deepEqual(result.sessions.map((row) => row.sessionId).sort(), ["live-1", "off-1"]);
  const row = result.sessions.find((entry) => entry.sessionId === "live-1");
  assert.equal(row.title, "活着的会话");
  assert.equal(row.workspaceId, "w1");
  assertLossless(result, "whales_visit_list");

  const fallback = captureToolsWithServices({
    agents: { list: () => [live], get: (id) => (id === "live-1" ? live : undefined) },
    workspaceRegistry: { list() { throw new Error("registry boom"); } }
  });
  const second = await fallback.whales_visit_list.execute({}, VISIT_EXEC);
  assert.equal(second.count, 1, "工作区表抛错时至少还能列活会话");
});

test("宿主工具：send 唤醒离线会话——唤醒后仍拿不到 agent 时如实报错、不谎称已送达（原 whales_visit_resume 的 live:false 语义）；resume 拒绝时工具调用失败而不是挂起", async () => {
  const tools = captureToolsWithServices({
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async () => ({ agent: undefined })
    }
  });
  assert.equal(tools.whales_visit_resume, undefined, "resume 已并入 send");
  await assert.rejects(
    () => tools.whales_visit_send.execute({ sessionId: "off-1", message: "起来" }, VISIT_EXEC),
    /唤醒后仍不在线/,
    "拿不到 agent 不能谎报已送达"
  );

  const failing = captureToolsWithServices({
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async () => { throw new Error("resume boom"); }
    }
  });
  await assert.rejects(
    () => failing.whales_visit_send.execute({ sessionId: "off-2", message: "起来" }, VISIT_EXEC),
    /resume boom/,
    "resume 拒绝必须以工具错误收场，不能静默成功"
  );
});
test("宿主工具：followup/steer 同步抛错时转成工具错误，不能变成未捕获异常", async () => {
  const session = {
    events: [{ seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "hi" }] } }]
  };
  const agent = {
    id: "s-boom",
    status: "idle",
    session,
    followup() { throw new Error("inbox disposed"); },
    steer() { throw new Error("steer disposed"); }
  };
  const tools = captureToolsWithServices({
    agents: { get: (id) => (id === "s-boom" ? agent : undefined), list: () => [agent] }
  });
  await assert.rejects(
    () => tools.whales_visit_send.execute({ sessionId: "s-boom", message: "hi" }, VISIT_EXEC),
    /送信失败|inbox disposed/
  );
  await assert.rejects(
    () => tools.whales_visit_send.execute({ sessionId: "s-boom", message: "hi", mode: "steer" }, VISIT_EXEC),
    /送信失败|steer disposed/
  );
});

test("宿主 apply：tools.register 抛错只丢工具能力，不影响策略与路由注册", () => {
  const sections = [];
  const routes = [];
  host.apply({
    get(name) {
      if (name === "tools") return { register() { throw new Error("register boom"); } };
      if (name === "systemPrompt") return { section(section) { sections.push(section); return () => {}; } };
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  });
  assert.equal(sections.length, 3, "团队策略、ultra 段与流程图段（v2.2 波次 5）都注册");
  assert.deepEqual(sections.map((section) => section.name).sort(), ["agent-whales/team-policy", "agent-whales/ultra", "agent-whales:flow"].sort());
  assert.equal(routes.length, 1, "活动路由仍然注册");
});

// ── 7. 只读路由：GET 可用，写方法不得读快照 ──────────────────────────────

test("宿主路由：GET 返回 200 + JSON + no-store，未知子路径与空请求回 404", () => {
  const route = mountRoute();
  assert.equal(route.kind, "prefix");
  assert.equal(route.path, "/agent-whales/api");

  const ok = callRoute(route, { method: "GET", url: "/agent-whales/api/activity" });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers["content-type"]), /application\/json/);
  assert.equal(ok.headers["cache-control"], "no-store");
  const body = JSON.parse(ok.body);
  assert.equal(typeof body.at, "number");
  assert.equal(typeof body.active, "object");

  assert.equal(callRoute(route, { method: "GET", url: "/agent-whales/api/nope" }).status, 404);
  assert.equal(callRoute(route, {}).status, 404, "空 req 不能把 handler 打崩");
  assert.equal(callRoute(route, { method: "GET", url: "/agent-whales/other" }).status, 404);
});

test("宿主路由：响应对象抛错时 handler 不把异常抛回宿主", () => {
  const route = mountRoute();
  assert.doesNotThrow(() => route.handler(
    { method: "GET", url: "/agent-whales/api/activity" },
    {
      statusCode: 0,
      headersSent: false,
      setHeader() { throw new Error("headers gone"); },
      end() { throw new Error("socket gone"); }
    }
  ), "setHeader/end 抛错不能穿透 handler");
  assert.doesNotThrow(() => route.handler(
    { method: "GET", url: "/agent-whales/api/activity" },
    { statusCode: 0, setHeader() {}, end() { throw new Error("gone"); } }
  ), "没有 headersSent 字段的老宿主也不能二次抛");
});

test("宿主路由：POST/PUT/PATCH/DELETE 不得读到活动快照（写方法必须 404/405）", () => {
  const route = mountRoute();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const result = callRoute(route, { method, url: "/agent-whales/api/activity" });
    assert.ok(result.status === 404 || result.status === 405, method + " 返回了 " + result.status + "，必须拒绝写方法");
  }
});

// ── 8. 串门工具开关：GET 暴露状态 + POST 受 token 保护 ───────────────────

test("串门工具开关：GET 返回 visitTools=true 与非空 controlToken，同一实例内 token 稳定", () => {
  const first = mountControlHost();
  const body = getActivity(first.route);
  assert.equal(body.visitTools, true, "默认必须开启串门工具");
  assert.equal(typeof body.controlToken, "string");
  assert.ok(body.controlToken.length >= 16, "controlToken 必须足够长（16 字节 hex）");
  assert.equal(getActivity(first.route).controlToken, body.controlToken, "同一实例内 token 不得变化");

  const second = mountControlHost();
  assert.notEqual(
    getActivity(second.route).controlToken,
    body.controlToken,
    "不同实例（热重载）必须换 token，旧页面拿到的 token 应失效"
  );
});

test("串门工具开关：无 token / 错 token 一律 403，且失败调用不得改变工具状态", async () => {
  const { registry, stats, route } = mountControlHost();
  const token = getActivity(route).controlToken;
  assert.equal(visitToolNames(registry).length, 3, "初始 3 个工具都注册");

  const noToken = await postVisitTools(route, { body: JSON.stringify({ enabled: false }) });
  assert.equal(noToken.status, 403, "无 token 必须 403");
  const wrongToken = await postVisitTools(route, { token: "deadbeef", body: JSON.stringify({ enabled: false }) });
  assert.equal(wrongToken.status, 403, "错 token 必须 403");
  const emptyToken = await postVisitTools(route, { token: "", body: JSON.stringify({ enabled: false }) });
  assert.equal(emptyToken.status, 403, "空 token 必须 403");

  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort(), "403 之后 3 个工具必须原样在册");
  assert.equal(visitOnly(stats.registerNames).length, 3, "403 不得触发串门工具注册");
  assert.equal(visitOnly(stats.disposeNames).length, 0, "403 不得触发串门工具注销");
  assert.equal(getActivity(route).visitTools, true, "403 不得改变开关真相");

  const wrongMethod = await postVisitTools(route, { token, method: "GET" });
  assert.equal(wrongMethod.status, 405, "开关路由只接受 POST");
});

test("串门工具开关：坏 body 一律 400（非 JSON / enabled 非布尔 / 空 / 超大），状态不变", async () => {
  const { registry, route } = mountControlHost();
  const token = getActivity(route).controlToken;
  const bodies = ["", "not-json", "null", "[]", '"enabled"', '{"enabled":"false"}', '{"enabled":1}', '{"enabled":null}', "{}"];
  for (const body of bodies) {
    const result = await postVisitTools(route, { token, body });
    assert.equal(result.status, 400, "body=" + JSON.stringify(body) + " 必须 400");
  }
  const oversized = JSON.stringify({ enabled: true, pad: "x".repeat(5000) });
  assert.equal((await postVisitTools(route, { token, body: oversized })).status, 400, "超过 4KB 的 body 必须 400");

  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort(), "坏 body 不能改变工具注册表");
  assert.equal(getActivity(route).visitTools, true, "坏 body 不能改变开关真相");
});

test("串门工具开关：{enabled:false} → 204 且 3 个工具全部注销；{enabled:true} 开回且 schema 仍合法", async () => {
  const { registry, stats, route } = mountControlHost();
  const token = getActivity(route).controlToken;

  const turnedOff = await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  assert.equal(turnedOff.status, 204);
  assert.deepEqual(visitToolNames(registry), [], "关闭后串门工具必须从注册表消失");
  assert.ok(registry.has("whales_propose_tasks"), "提案工具不受串门开关控制，关闭后必须仍在");
  assert.equal(visitOnly(stats.registerNames).length, 3, "关闭不应重复注册");
  assert.equal(visitOnly(stats.disposeNames).length, 3, "关闭必须逐个注销");
  assert.equal(getActivity(route).visitTools, false, "GET 必须立刻反映关闭状态");

  const turnedOn = await postVisitTools(route, { token, body: JSON.stringify({ enabled: true }) });
  assert.equal(turnedOn.status, 204);
  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort(), "开启后 3 个工具必须回来");
  assert.equal(visitOnly(stats.registerNames).length, 6, "重开只注册一次（3 个工具 × 2 轮）");
  assert.equal(visitOnly(stats.disposeNames).length, 3, "重开不应额外注销");
  for (const [name, tool] of registry) {
    assert.equal(tool.parameters.type, "object", name + " 重注册后 parameters 仍是 object schema");
    assert.equal(tool.parameters.properties !== undefined, true, name + " 必须带 properties");
    assert.equal(tool.output.schema.type, "object", name + " 重注册后 output.schema 仍是 object schema");
    assertLossless(tool.parameters, name + " 重注册后的 parameters");
  }
  assert.equal(getActivity(route).visitTools, true);
});

test("串门工具开关：连续 toggle 幂等，不产生重复注册/重复注销", async () => {
  const { registry, stats, route } = mountControlHost();
  const token = getActivity(route).controlToken;
  assert.equal(visitOnly(stats.registerNames).length, 3);
  assert.equal(visitOnly(stats.disposeNames).length, 0);

  await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  assert.equal(visitOnly(stats.disposeNames).length, 3, "重复关闭不得重复注销");
  assert.deepEqual(visitToolNames(registry), []);

  await postVisitTools(route, { token, body: JSON.stringify({ enabled: true }) });
  await postVisitTools(route, { token, body: JSON.stringify({ enabled: true }) });
  assert.equal(visitOnly(stats.registerNames).length, 6, "重复开启不得重复注册（3 个工具 × 2 轮）");
  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort());

  await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  assert.equal(visitOnly(stats.disposeNames).length, 6, "再关一次恰好再注销一轮（3 个工具 × 2 轮）");
});

test("串门工具开关：config.visitTools=false 时初始不注册，POST 仍可开启", async () => {
  const { registry, stats, route } = mountControlHost({ visitTools: false });
  assert.deepEqual(visitToolNames(registry), [], "初始化关闭时一个工具都不该注册");
  assert.equal(visitOnly(stats.registerNames).length, 0);
  let snapshot = getActivity(route);
  assert.equal(snapshot.visitTools, false);
  assert.equal(typeof snapshot.controlToken, "string");

  const turnedOn = await postVisitTools(route, { token: snapshot.controlToken, body: JSON.stringify({ enabled: true }) });
  assert.equal(turnedOn.status, 204);
  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort());
  assert.equal(getActivity(route).visitTools, true);
});

// ── 8b) ultra 模式：强制加载 deep-effort 执行契约 ──────────────────────────
//
// 2026-11-16：用户用四臂对照实验蒸馏出 deep-effort（49 行执行契约），随插件分发；
// ultra 模式打开时把正文注册成系统提示段，关掉时交空段。开关走设置页 → POST /api/ultra，
// 状态落盘 ultra.json，重启后仍保持（用户明确要求「记住」）。

const ULTRA_FILE = join(ISOLATED_STORE_DIR, "ultra.json");

/**
 * 挂一个带 systemPrompt + webServer 的假宿主；ultraFile 可换状态文件路径（隔离用）。
 *
 * 每次都显式 setUltraModePathForTests：汇总执行（test/index.js）时多个测试文件共享模块状态，
 * bundled-skill.test.mjs 在 import 阶段就把路径指到它自己的临时目录了——不显式指回，
 * 本文件的用例会读写到别人的文件上去。
 */
function mountUltraHost(config, ultraFile) {
	host.setUltraModePathForTests(ultraFile === undefined ? ULTRA_FILE : ultraFile);
	const sections = [];
	const routes = [];
	host.apply({
		get(name) {
			if (name === "systemPrompt") return { section(section) { sections.push(section); return () => {}; } };
			if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
			return undefined;
		},
		effect(run) { return run(); },
		on() { return () => {}; }
	}, config);
	assert.equal(routes.length, 1, "活动路由必须挂载一次");
	return { sections, route: routes[0] };
}

/** 取 ultra 段（按名字找，避免依赖注册顺序）。 */
function ultraSection(sections) {
	const section = sections.find((item) => item.name === "agent-whales/ultra");
	assert.ok(section, "ultra 段必须注册");
	return section;
}

/** POST /agent-whales/api/ultra（请求体语义与 postVisitTools 相同）。 */
function postUltra(route, options = {}) {
	const { token, body, method = "POST" } = options;
	return new Promise((resolve, reject) => {
		const req = new EventEmitter();
		req.method = method;
		req.url = "/agent-whales/api/ultra";
		req.headers = token === undefined ? {} : { "x-whales-token": token };
		const headers = {};
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("POST /ultra 1s 内没有响应（handler 可能挂起）"));
		}, 1_000);
		const res = {
			statusCode: 0,
			headersSent: false,
			setHeader(key, value) { headers[String(key).toLowerCase()] = value; },
			end(text) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.headersSent = true;
				resolve({ status: this.statusCode, headers, body: text });
			}
		};
		try {
			route.handler(req, res);
		} catch (error) {
			settled = true;
			clearTimeout(timer);
			reject(error);
			return;
		}
		setImmediate(() => {
			if (settled) return;
			try {
				if (body !== undefined) req.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(body));
				req.emit("end");
			} catch (error) {
				if (!settled) { settled = true; clearTimeout(timer); reject(error); }
			}
		});
	});
}

test("ultra 模式：默认关闭——GET 回 ultra=false，提示段交空串（不占 token）", () => {
	rmSync(ULTRA_FILE, { force: true });
	const { sections, route } = mountUltraHost();
	const snapshot = getActivity(route);
	assert.equal(snapshot.ultra, false, "无持久化文件、无 config 时默认关");
	assert.equal(ultraSection(sections).text(), "", "关闭时整段消失（renderPrompt 过滤空段）");
});

test("ultra 模式：config.ultra=true 时默认打开，段里是 deep-effort 正文", () => {
	rmSync(ULTRA_FILE, { force: true });
	const { sections, route } = mountUltraHost({ ultra: true });
	assert.equal(getActivity(route).ultra, true, "config 可以一劳永逸改默认");
	const text = ultraSection(sections).text();
	assert.ok(text.includes("先取证"), "契约四条硬要求要在段里");
	assert.ok(text.includes("必须自验"), "契约四条硬要求要在段里");
	assert.ok(text.includes("不要再调用 skill 工具加载 deep-effort"), "要有防重复加载的表头");
	assert.ok(text.includes("效果优先"), "成本立场要在段里");
});

test("ultra 模式：无 token / 错 token 403，坏 body 400，都不改状态与文件", async () => {
	rmSync(ULTRA_FILE, { force: true });
	const { route } = mountUltraHost();
	const token = getActivity(route).controlToken;

	assert.equal((await postUltra(route, { body: JSON.stringify({ enabled: true }) })).status, 403, "无 token 必须 403");
	assert.equal((await postUltra(route, { token: "deadbeef", body: JSON.stringify({ enabled: true }) })).status, 403, "错 token 必须 403");
	assert.equal((await postUltra(route, { token, method: "GET" })).status, 405, "开关路由只接受 POST");
	for (const body of ["", "not-json", "null", "[]", '{"enabled":"false"}', '{"enabled":1}', "{}"]) {
		assert.equal((await postUltra(route, { token, body })).status, 400, "body=" + JSON.stringify(body) + " 必须 400");
	}
	assert.equal(getActivity(route).ultra, false, "失败的请求不得改变开关真相");
	assert.equal(existsSync(ULTRA_FILE), false, "失败的请求不得落盘");
});

test("ultra 模式：{enabled:true} → 204，GET 与段文本即时翻转，状态落盘", async () => {
	rmSync(ULTRA_FILE, { force: true });
	const { sections, route } = mountUltraHost();
	const token = getActivity(route).controlToken;

	const turnedOn = await postUltra(route, { token, body: JSON.stringify({ enabled: true }) });
	assert.equal(turnedOn.status, 204);
	assert.equal(getActivity(route).ultra, true, "GET 必须立刻反映打开状态");
	assert.ok(ultraSection(sections).text().includes("先取证"), "打开后段里要有契约正文");

	const persisted = JSON.parse(readFileSync(ULTRA_FILE, "utf8"));
	assert.equal(persisted.enabled, true, "状态必须落盘（用户要求重启后仍生效）");
	assert.equal(typeof persisted.updatedAt, "number", "带时间戳便于排查");

	const turnedOff = await postUltra(route, { token, body: JSON.stringify({ enabled: false }) });
	assert.equal(turnedOff.status, 204);
	assert.equal(getActivity(route).ultra, false);
	assert.equal(ultraSection(sections).text(), "", "关掉后段回到空串");
	assert.equal(JSON.parse(readFileSync(ULTRA_FILE, "utf8")).enabled, false, "关闭也要落盘");
});

test("ultra 模式：重启（重新 apply）后读持久化文件，开关保持", () => {
	rmSync(ULTRA_FILE, { force: true });
	const first = mountUltraHost();
	const token = getActivity(first.route).controlToken;
	// 同步等落盘：POST 的 setEnabled 先写盘再翻内存，204 回来时文件已经写好了。
	return postUltra(first.route, { token, body: JSON.stringify({ enabled: true }) }).then((result) => {
		assert.equal(result.status, 204);
		// 模拟 DSH 重启：同一个状态文件、全新的插件实例。
		const second = mountUltraHost();
		assert.equal(getActivity(second.route).ultra, true, "重启后必须还是打开的");
		assert.ok(ultraSection(second.sections).text().includes("先取证"), "重启后契约照样强制加载");
	});
});

test("ultra 模式：持久化优先于 config（文件说关，config 说开也没用）", () => {
	writeFileSync(ULTRA_FILE, JSON.stringify({ enabled: false, updatedAt: 1 }), "utf8");
	const { sections, route } = mountUltraHost({ ultra: true });
	assert.equal(getActivity(route).ultra, false, "用户翻过的开关不能被 config 默认值盖掉");
	assert.equal(ultraSection(sections).text(), "");
});

test("ultra 模式：状态文件损坏时不抛，退回 config 默认并进入只读", () => {
	const broken = join(ISOLATED_STORE_DIR, "ultra-broken.json");
	writeFileSync(broken, "{ not json", "utf8");
	try {
		const { sections, route } = mountUltraHost(undefined, broken);
		assert.equal(getActivity(route).ultra, false, "坏文件按「没有持久化」处理");
		assert.equal(ultraSection(sections).text(), "");
		const backups = readdirSync(ISOLATED_STORE_DIR).filter((name) => name.startsWith("ultra-broken.json.corrupt-"));
		assert.ok(backups.length >= 1, "坏文件必须被备份而不是静默丢弃");
	} finally {
		for (const name of readdirSync(ISOLATED_STORE_DIR)) {
			if (name.startsWith("ultra-broken.json")) rmSync(join(ISOLATED_STORE_DIR, name), { force: true });
		}
		host.setUltraModePathForTests(ULTRA_FILE);
	}
});

test("ultra 模式：落盘失败（只读降级）时 POST 回 500，内存状态不翻", async () => {
	// 把状态文件路径占成一个目录：读抛 EISDIR → 只读降级；写也必然失败。
	const asDirectory = join(ISOLATED_STORE_DIR, "ultra-as-dir");
	rmSync(asDirectory, { recursive: true, force: true });
	mkdirSync(asDirectory, { recursive: true });
	try {
		const { route } = mountUltraHost(undefined, asDirectory);
		const token = getActivity(route).controlToken;
		const result = await postUltra(route, { token, body: JSON.stringify({ enabled: true }) });
		assert.equal(result.status, 500, "持久化是这个开关的硬承诺：写不进去必须明说失败");
		assert.equal(getActivity(route).ultra, false, "内存状态不得翻——否则界面显示开着、重启后却关了");
	} finally {
		rmSync(asDirectory, { recursive: true, force: true });
		host.setUltraModePathForTests(ULTRA_FILE);
	}
});

// ── 9. tools/execute 采集：脏事件不污染活动表、不中断 waterfall ──────────

test("宿主采集：脏 exec 不写入活动表，next() 始终被放行", () => {
  const listeners = {};
  const routes = [];
  host.apply({
    get(name) {
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on(name, listener) { listeners[name] = listener; return () => {}; }
  });
  assert.equal(typeof listeners["tools/execute"], "function");
  assert.equal(typeof listeners["tools/result"], "function");

  const dirty = [null, undefined, {}, { agent: null, name: "read" }, { agent: { id: 42 }, name: "read" }, { agent: { id: "s1" }, name: 42 }];
  let released = 0;
  for (const exec of dirty) {
    assert.doesNotThrow(() => {
      const result = listeners["tools/execute"](exec, () => { released += 1; return Promise.resolve("ok"); });
      assert.equal(typeof result?.then, "function", "tools/execute 是 waterfall，必须返回 next() 的结果");
    });
  }
  assert.equal(released, dirty.length, "waterfall 必须始终放行原始调用");

  for (const exec of [null, {}, { agent: { id: 42 } }]) {
    assert.doesNotThrow(() => listeners["tools/result"](exec));
  }

  const snapshot = JSON.parse(callRoute(routes[0], { method: "GET", url: "/agent-whales/api/activity" }).body);
  assert.deepEqual(snapshot.active, {}, "脏 exec 不得进入活动表");
});

test("宿主采集：多个会话并发时各自独立，结束一个不会误删另一个", () => {
  const listeners = {};
  const routes = [];
  host.apply({
    get(name) {
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on(name, listener) { listeners[name] = listener; return () => {}; }
  });

  const release = (id, name) => listeners["tools/execute"]({ agent: { id }, name }, () => Promise.resolve("ok"));
  release("s1", "read");
  release("s2", "bash");

  const readActive = () => JSON.parse(callRoute(routes[0], { method: "GET", url: "/agent-whales/api/activity" }).body).active;
  assert.deepEqual(Object.keys(readActive()).sort(), ["s1", "s2"]);
  assert.equal(readActive().s1.tool, "read");
  assert.equal(readActive().s2.tool, "bash");

  listeners["tools/result"]({ agent: { id: "s1" }, name: "read" });
  assert.deepEqual(Object.keys(readActive()), ["s2"], "结束 s1 不能把 s2 一起清掉");
  assert.equal(readActive().s2.tool, "bash");

  listeners["tools/result"]({ agent: { id: "s2" }, name: "bash" });
  assert.deepEqual(readActive(), {});
});


// ── 运行时状态采集（v0.23 状态信号接线，2026-10-30）──────────────────────────
function stateSnapshot(routes) {
  return JSON.parse(callRoute(routes[0], { method: "GET", url: "/agent-whales/api/activity" }).body).state;
}

test("宿主状态：status / streaming / 失败 / 回合结束 都落到 state 快照，且序列化无损", () => {
  const listeners = {};
  const routes = [];
  host.apply({
    get(name) {
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on(name, listener) { listeners[name] = listener; return () => {}; }
  });

  listeners["agent/status"]({ agent: { id: "s1" }, status: "running" });
  let s = stateSnapshot(routes);
  assert.equal(s.s1.running, true);
  assert.equal(typeof s.s1.runStartedAt, "number");

  listeners["agent/assistant-stream"]({ agent: { id: "s1" }, frame: { type: "start" } });
  assert.equal(stateSnapshot(routes).s1.streaming, true, "模型开始输出 → streaming");
  listeners["agent/assistant-stream"]({ agent: { id: "s1" }, frame: { type: "chunk" } });
  assert.equal(stateSnapshot(routes).s1.streaming, true, "chunk 期间仍然在输出");
  listeners["agent/assistant-stream"]({ agent: { id: "s1" }, frame: { type: "end" } });
  assert.equal("streaming" in stateSnapshot(routes).s1, false, "输出结束 → 不再 streaming");

  listeners["tools/result"]({ agent: { id: "s1" }, name: "bash" }, { isError: true, error: { message: "boom" } });
  s = stateSnapshot(routes);
  assert.equal(s.s1.lastErrorKind, "tool", "工具失败要记下来");
  assert.equal(typeof s.s1.lastErrorAt, "number");

  listeners["agent/error"]({ agent: { id: "s1" }, turn: 1, step: 1, error: new Error("x") });
  assert.equal(stateSnapshot(routes).s1.lastErrorKind, "agent");

  listeners["agent/turn-stopping"]({ agent: { id: "s1" }, turn: 1 });
  assert.equal(typeof stateSnapshot(routes).s1.lastTurnEndAt, "number", "回合结束要记下来");

  listeners["agent/status"]({ agent: { id: "s1" }, status: "idle" });
  s = stateSnapshot(routes);
  assert.equal("running" in s.s1, false, "idle 之后不再报 running");
  assert.equal(typeof s.s1.lastRunMs, "number", "收工时记下这一轮跑了多久");
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, "state 必须是 lossless JSON（不能有 undefined 键）");
});

test("宿主状态：脏事件不抛、不凭空造会话", () => {
  const listeners = {};
  const routes = [];
  host.apply({
    get(name) {
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on(name, listener) { listeners[name] = listener; return () => {}; }
  });

  assert.doesNotThrow(() => listeners["agent/status"](null));
  assert.doesNotThrow(() => listeners["agent/status"]({ agent: {} }));
  assert.doesNotThrow(() => listeners["agent/status"]({ agent: { id: "s9" }, status: "weird" }));
  assert.doesNotThrow(() => listeners["agent/assistant-stream"]({ agent: { id: "s9" } }));
  assert.doesNotThrow(() => listeners["agent/turn-stopping"]({}));
  assert.doesNotThrow(() => listeners["tools/result"]({ agent: { id: "s9" } }, null));
  assert.deepEqual(stateSnapshot(routes), {}, "没有有效事件时不该凭空造会话");
});


// ── P2：模型请求失败 + 团队全完成（2026-10-30）──────────────────────────────
test("宿主状态：agent/request-error 是 waterfall，必须放行并记成 request 失败", () => {
  const listeners = {};
  const routes = [];
  host.apply({
    get(name) {
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on(name, listener) { listeners[name] = listener; return () => {}; }
  });

  let released = 0;
  const outcome = listeners["agent/request-error"](
    { agent: { id: "s1" }, turn: 1, step: 1, provider: "p", failure: {}, retryPolicy: undefined, signal: {} },
    () => { released += 1; return Promise.resolve({ kind: "next" }); }
  );
  assert.equal(released, 1, "waterfall 必须调用 next()，否则会吞掉宿主的重试策略");
  assert.equal(typeof outcome.then, "function");
  const state = JSON.parse(callRoute(routes[0], { method: "GET", url: "/agent-whales/api/activity" }).body).state;
  assert.equal(state.s1.lastErrorKind, "request");
  assert.equal(typeof state.s1.lastErrorAt, "number");
});

// ── 9. 素材路由（D1：素材出 bundle，宿主按 key 供图）──────────────────────
//
// 契约（Lead 定死，勿改）：
//   GET /agent-whales/api/art/manifest → {version:1, keys:{key:{w,h,bytes,skin}}}
//   GET /agent-whales/api/art/<key>.webp → image/webp + immutable 缓存 + etag，HEAD 同头无体
//   错误面：未知 key/穿越 404、非 GET/HEAD/OPTIONS 405+allow、OPTIONS 204、绝不外抛

const ART_MANIFEST = "/agent-whales/api/art/manifest";
const ART_MANIFEST_FILE = new URL("../assets/manifest.json", import.meta.url);
const ART_SKINS = ["q", "mature", "classic"];

function readArtManifestFile() {
  return JSON.parse(readFileSync(ART_MANIFEST_FILE, "utf8"));
}

test("素材路由：manifest 200 + 结构 + 键集合与 assets/manifest.json 一致", () => {
  const route = mountRoute();
  const result = callRoute(route, { method: "GET", url: ART_MANIFEST });
  assert.equal(result.status, 200);
  assert.match(String(result.headers["content-type"]), /application\/json/);
  assert.equal(result.headers["cache-control"], "no-store");

  const body = JSON.parse(result.body);
  assert.equal(body.version, 1, "清单协议版本必须是 1");
  const fileManifest = readArtManifestFile();
  assert.deepEqual(
    Object.keys(body.keys).sort(),
    Object.keys(fileManifest.keys).sort(),
    "响应里的 key 集合必须与构建产物 assets/manifest.json 完全一致"
  );
  assert.ok(Object.keys(body.keys).length >= 26, "素材数量不对：" + Object.keys(body.keys).length);

  for (const [key, entry] of Object.entries(body.keys)) {
    assert.deepEqual(Object.keys(entry).sort(), ["bytes", "h", "skin", "w"], key + " 只应输出 w/h/bytes/skin 四个字段");
    assert.ok(Number.isInteger(entry.w) && entry.w > 0, key + ".w 必须是正整数");
    assert.ok(Number.isInteger(entry.h) && entry.h > 0, key + ".h 必须是正整数");
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, key + ".bytes 必须是正整数");
    assert.ok(ART_SKINS.includes(entry.skin), key + ".skin 必须是 q/mature/classic");
    const expectedSkin = key.startsWith("q-") ? "q" : key.startsWith("m-") ? "mature" : "classic";
    assert.equal(entry.skin, expectedSkin, key + " 的 skin 必须由 key 前缀决定");
    assert.deepEqual(entry, fileManifest.keys[key], key + " 的字段必须与 manifest.json 一致");
  }
  assertLossless(body);
});

test("素材路由：每个合法 key 都 200 + image/webp + 字节数与清单一致 + RIFF/WEBP 头", () => {
  const route = mountRoute();
  const manifest = JSON.parse(callRoute(route, { method: "GET", url: ART_MANIFEST }).body);
  for (const key of Object.keys(manifest.keys)) {
    const result = callRoute(route, { method: "GET", url: "/agent-whales/api/art/" + key + ".webp" });
    assert.equal(result.status, 200, key + " 必须 200");
    assert.equal(result.headers["content-type"], "image/webp", key + " 的 content-type");
    assert.match(String(result.headers["cache-control"]), /public, max-age=86400, immutable/, key + " 的缓存头");
    assert.equal(typeof result.headers["etag"], "string", key + " 必须带 etag");
    assert.equal(
      String(result.headers["content-length"]),
      String(manifest.keys[key].bytes),
      key + " 的 content-length 必须等于清单 bytes"
    );
    assert.ok(Buffer.isBuffer(result.body), key + " 的响应体必须是 Buffer");
    assert.equal(result.body.length, manifest.keys[key].bytes, key + " 的字节数必须等于清单 bytes");
    assert.equal(result.body.subarray(0, 4).toString("latin1"), "RIFF", key + " 必须以 RIFF 开头");
    assert.equal(result.body.subarray(8, 12).toString("latin1"), "WEBP", key + " 必须是 WebP");
  }
});

test("素材路由：HEAD 同头无体（manifest 与图片都支持）", () => {
  const route = mountRoute();
  const getImage = callRoute(route, { method: "GET", url: "/agent-whales/api/art/q-smile.webp" });
  const headImage = callRoute(route, { method: "HEAD", url: "/agent-whales/api/art/q-smile.webp" });
  assert.equal(headImage.status, 200);
  assert.equal(headImage.body, undefined, "HEAD 不得带 body");
  assert.equal(headImage.headers["content-type"], "image/webp");
  assert.equal(headImage.headers["etag"], getImage.headers["etag"]);
  assert.equal(headImage.headers["content-length"], getImage.headers["content-length"]);

  const headManifest = callRoute(route, { method: "HEAD", url: ART_MANIFEST });
  assert.equal(headManifest.status, 200);
  assert.equal(headManifest.body, undefined, "HEAD 不得带 body");
  assert.match(String(headManifest.headers["content-type"]), /application\/json/);
});

test("素材路由：未知 key / 路径穿越 / 形状不对一律 404", () => {
  const route = mountRoute();
  const bad = [
    "/agent-whales/api/art/nope.webp",
    "/agent-whales/api/art/q-smile",
    "/agent-whales/api/art/q-smile.webp/extra",
    "/agent-whales/api/art/..%2Fsecret.webp",
    "/agent-whales/api/art/%2e%2e%2fmanifest.json",
    "/agent-whales/api/art/..%5Csecret.webp",
    "/agent-whales/api/art/",
    "/agent-whales/api/art"
  ];
  for (const url of bad) {
    const result = callRoute(route, { method: "GET", url });
    assert.equal(result.status, 404, url + " 必须 404，实际 " + result.status);
  }
});

test("素材路由：OPTIONS 204，非 GET/HEAD/OPTIONS 405 + allow", () => {
  const route = mountRoute();
  for (const url of [ART_MANIFEST, "/agent-whales/api/art/q-smile.webp"]) {
    const options = callRoute(route, { method: "OPTIONS", url });
    assert.equal(options.status, 204, url + " OPTIONS 必须 204");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = callRoute(route, { method, url });
      assert.equal(result.status, 405, url + " " + method + " 必须 405");
      assert.equal(result.headers["allow"], "GET, HEAD, OPTIONS", url + " 405 必须带 allow");
    }
  }
});

// X4 办公室素材：/agent-whales/api/office/，与 /art/ 分开，只放行 o-sit-<姿势>（鲸鱼娘坐姿横条，AI 生成）
const OFFICE_BASE = "/agent-whales/api/office/";

test("办公室素材：清单键与 assets/office/manifest.json 一致，每张 200 + image/webp + 字节数对得上", () => {
  const route = mountRoute();
  const fileManifest = JSON.parse(readFileSync(new URL("../assets/office/manifest.json", import.meta.url), "utf8"));
  const manifest = callRoute(route, { method: "GET", url: OFFICE_BASE + "manifest" });
  assert.equal(manifest.status, 200);
  const body = JSON.parse(manifest.body);
  assert.deepEqual(Object.keys(body.keys).sort(), Object.keys(fileManifest.keys).sort());
  assert.equal(Object.keys(body.keys).length, 16, "9 个坐姿 + 1 条侧面行走 + 椅子 / 桌子两层 + 盆栽 / 书架 + 地砖 / 墙");
  assert.equal("layout" in body, false, "layout 只是构建记录，宿主清单协议里没有它，不能漏给浏览器");
  for (const [key, entry] of Object.entries(body.keys)) {
    assert.match(key, /^o-(sit-(idle|type|wait|sleep|read|run|think|done|oops)|station-(back|front)|walk-side|plant|shelf|floor|wall)$/);
    const result = callRoute(route, { method: "GET", url: OFFICE_BASE + key + ".webp" });
    assert.equal(result.status, 200, key);
    assert.equal(result.headers["content-type"], "image/webp", key);
    assert.equal(result.body.length, entry.bytes, key + " 字节数必须等于清单");
    assert.equal(result.body.subarray(8, 12).toString("latin1"), "WEBP", key);
  }
});

test("办公室素材：非 o- 前缀的 key、路径穿越、形状不对一律 404；/art/ 的 q- 键不能从办公室路径取", () => {
  const route = mountRoute();
  for (const tail of ["q-smile.webp", "nope.webp", "o-sit-idle", "o-sit-idle.webp/extra", "..%2Fsecret.webp", "%2e%2e%2fmanifest.json", "..%5Csecret.webp", ""]) {
    const result = callRoute(route, { method: "GET", url: OFFICE_BASE + tail });
    assert.equal(result.status, 404, tail + " 必须 404，实际 " + result.status);
  }
  const artKeyStillThere = callRoute(route, { method: "GET", url: "/agent-whales/api/art/q-smile.webp" });
  assert.equal(artKeyStillThere.status, 200, "既有 /art/ 路由不得被办公室路由影响");
});

test("办公室素材：client.js 请求的前缀必须等于宿主路由前缀（两边各写一遍的 URL 曾经对不上）", () => {
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.equal(host.OFFICE_PROFILE.prefix, OFFICE_BASE);
  assert.ok(client.includes('WB_OFFICE_URL = "' + host.OFFICE_PROFILE.prefix + '"'), "client.js 的 WB_OFFICE_URL 必须等于 OFFICE_PROFILE.prefix");
});

test("办公室素材：HEAD 同头无体，POST 405", () => {
  const route = mountRoute();
  const get = callRoute(route, { method: "GET", url: OFFICE_BASE + "o-sit-idle.webp" });
  const head = callRoute(route, { method: "HEAD", url: OFFICE_BASE + "o-sit-idle.webp" });
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert.equal(head.headers["etag"], get.headers["etag"]);
  assert.equal(callRoute(route, { method: "POST", url: OFFICE_BASE + "o-sit-idle.webp" }).status, 405);
});

test("素材路由：素材目录不存在（asar/缺文件）时 manifest 仍 200 空表、图片 404、不抛", () => {
  const missingRoot = new URL("../assets/__definitely_missing__/", import.meta.url);
  let store;
  assert.doesNotThrow(() => { store = host.createArtStore(missingRoot); }, "读不到素材目录不得抛");

  const manifest = host.artResponse(store, ART_MANIFEST, "GET");
  assert.equal(manifest.status, 200, "没有素材时 manifest 仍必须 200（客户端据此降级）");
  assert.deepEqual(JSON.parse(manifest.body), { version: 1, keys: {} }, "没有素材时 keys 必须是空表");
  const head = host.artResponse(store, ART_MANIFEST, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert.equal(head.contentLength, manifest.contentLength);

  assert.equal(host.artResponse(store, "/agent-whales/api/art/q-smile.webp", "GET").status, 404);
  assert.equal(host.artResponse(store, "/agent-whales/api/art/q-smile.webp", "HEAD").status, 404);
  assert.doesNotThrow(() => store.read("q-smile"));
});

test("素材路由：清单里的脏 key / 脏尺寸被丢弃，穿越 key 进不了白名单", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-agent-whales-art-"));
  try {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        keys: {
          "q-good": { w: 10, h: 20, bytes: 3, skin: "q" },
          "../evil": { w: 1, h: 1, bytes: 1, skin: "q" },
          "q-bad-w": { w: "10", h: 20, bytes: 3, skin: "q" },
          "q-bad-bytes": { w: 10, h: 20, bytes: 0, skin: "q" },
          "x-unknown": { w: 1, h: 1, bytes: 1, skin: "q" },
          "q-bad-skin": { w: 10, h: 20, bytes: 3, skin: "weird" }
        }
      })
    );
    const store = host.createArtStore(pathToFileURL(dir + "/"));
    const body = JSON.parse(store.manifestBody);
    assert.deepEqual(
      Object.keys(body.keys).sort(),
      ["q-bad-skin", "q-good"],
      "只保留 key 前缀合法且 w/h/bytes 为正整数的条目；脏 skin 按前缀回退"
    );
    assert.equal(body.keys["q-bad-skin"].skin, "q", "脏 skin 必须按 key 前缀回退");
    assert.equal(store.read("../evil"), undefined, "穿越 key 不得命中");
    assert.equal(store.read("q-good"), undefined, "文件不存在时 read 回 undefined（不抛）");
    // 字面 ".." 在解析阶段就被拒（artResponse 返回 undefined → dispatcher 404）；
    // 百分号编码的穿越会先被 decode，但白名单里没有它，所以同样 404。
    assert.equal(host.artResponse(store, "/agent-whales/api/art/..%2Fevil.webp", "GET"), undefined);
    assert.equal(host.artResponse(store, "/agent-whales/api/art/%2e%2e%2Fevil.webp", "GET").status, 404);
    assert.equal(host.artResponse(store, "/agent-whales/api/art/q-good.webp", "GET").status, 404);
    assert.equal(host.artResponse(store, ART_MANIFEST, "GET").status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("素材路由：图片命中后走内存缓存，clear() 后重新读盘", () => {
  const store = host.createArtStore();
  const first = store.read("q-smile");
  assert.ok(first && Buffer.isBuffer(first.buffer), "q-smile 必须能读到");
  assert.equal(store.read("q-smile"), first, "第二次必须命中缓存（同一对象）");
  assert.match(String(first.etag), /^".+"$/, "etag 必须是带引号的字符串");
  store.clear();
  const again = store.read("q-smile");
  assert.ok(again, "clear 后仍能重新读盘");
  assert.notEqual(again, first, "clear 后必须是重新读出来的对象");
});

test("素材路由：非素材路径 artResponse 返回 undefined（交给 404）", () => {
  const store = host.createArtStore();
  assert.equal(host.artResponse(store, "/agent-whales/api/other", "GET"), undefined);
  assert.equal(host.artResponse(store, "/agent-whales/api/art/manifest.json", "GET"), undefined);
  assert.equal(host.artResponse(store, "/agent-whales/api/art", "GET"), undefined);
});

// ── 10. 宿主服务晚到：cordis 并行加载下的注册时序（真实事故 2026-10-31）──────
//
// 事故：宿主把 profile 里的插件并行加载（cordis-plugin-loader 的 EntryGroup.update
// 用 Promise.allSettled），我们的 apply 曾经早于 webServer/tools/systemPrompt 注册，
// 只用 ctx.get() 探测 → 四条能力被静默跳过：鲸鱼娘（浏览器半边）还在，
// 但 /agent-whales/api/* 全 404、串门工具没注册、团队策略段消失。
// 修复：依赖服务的注册走 ctx.inject()，服务就绪/重载时执行。

/** 模拟 cordis：inject 记录回调，等测试手动「服务就绪」；作用域 effect 可释放。 */
function makeInjectHost() {
  const state = { tools: {}, routes: [], sections: [], disposers: [], injected: [] };
  const services = {
    tools: {
      register(definition) {
        state.tools[definition.name] = definition;
        return () => {
          delete state.tools[definition.name];
        };
      },
    },
    webServer: {
      register(route) {
        state.routes.push(route);
        return () => {
          const at = state.routes.indexOf(route);
          if (at >= 0) state.routes.splice(at, 1);
        };
      },
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section);
        return () => {
          const at = state.sections.indexOf(section);
          if (at >= 0) state.sections.splice(at, 1);
        };
      },
    },
  };
  const makeScope = () => ({
    get(name) {
      return services[name];
    },
    effect(run) {
      const dispose = run();
      state.disposers.push(dispose);
      return dispose;
    },
    on() {
      return () => {};
    },
  });
  const ctx = makeScope();
  ctx.inject = (names, callback) => {
    const entry = { names, callback, scope: makeScope(), disposers: [] };
    state.injected.push(entry);
    return { dispose() {} };
  };
  return { ctx, state };
}

/** 模拟依赖就绪：按 inject 顺序回放回调，并记录各自作用域新增的 disposer。 */
function flushInjected(injectHost) {
  for (const entry of injectHost.state.injected) {
    const before = injectHost.state.disposers.length;
    entry.callback(entry.scope);
    entry.disposers = injectHost.state.disposers.slice(before);
  }
}

function disposeInjected(injectHost) {
  for (const entry of injectHost.state.injected) {
    for (const dispose of [...(entry.disposers ?? [])].reverse()) {
      if (typeof dispose === "function") dispose();
    }
    entry.disposers = [];
  }
}

test("宿主 apply：服务晚到时用 ctx.inject 等就绪再注册，而不是静默跳过", () => {
  const injectHost = makeInjectHost();
  host.apply(injectHost.ctx);

  assert.deepEqual(
    injectHost.state.injected.map((entry) => entry.names.join("+")).sort(),
    // systemPrompt 出现三次：团队策略段、ultra 段与流程图段（v2.2 波次 5）各自一条（各自兜底，互不拖累）。
    ["skills", "systemPrompt", "systemPrompt", "systemPrompt", "tools", "webServer"],
    "skills / systemPrompt×2 / tools / webServer 这些依赖都必须走 ctx.inject"
  );
  assert.deepEqual(Object.keys(injectHost.state.tools), [], "服务没就绪前不得注册工具（旧实现的 bug）");
  assert.equal(injectHost.state.routes.length, 0, "服务没就绪前不得注册路由");
  assert.equal(injectHost.state.sections.length, 0, "服务没就绪前不得注册提示段");

  flushInjected(injectHost);
  const injectedToolNames = Object.keys(injectHost.state.tools);
  assert.equal(injectedToolNames.filter((name) => name.startsWith("whales_visit_")).length, 3, "tools 就绪后三个串门工具必须全部注册");
  assert.ok(injectedToolNames.includes("whales_propose_tasks"), "tools 就绪后提案工具也必须注册");
  assert.equal(injectHost.state.routes.length, 1, "webServer 就绪后路由必须注册");
  assert.equal(injectHost.state.sections.length, 3, "systemPrompt 就绪后团队策略段、ultra 段与流程图段都必须注册");
  assert.deepEqual(
    injectHost.state.sections.map((section) => section.name).sort(),
    ["agent-whales/team-policy", "agent-whales/ultra", "agent-whales:flow"].sort(),
    "段的名字与顺序无关，按名字比对"
  );

  // 路由真的能服务请求（素材路由是 D1 的产物，最容易被这个 bug 打掉）。
  const manifest = callRoute(injectHost.state.routes[0], { method: "GET", url: "/agent-whales/api/art/manifest" });
  assert.equal(manifest.status, 200);
  assert.ok(Object.keys(JSON.parse(manifest.body).keys).length >= 26);
  const activity = JSON.parse(callRoute(injectHost.state.routes[0], { method: "GET", url: "/agent-whales/api/activity" }).body);
  assert.equal(activity.visitTools, true, "tools 就绪后 GET 必须回显 visitTools=true");
});

test("宿主 apply：ctx.inject 抛错时退回立即注册，不把异常抛给宿主", () => {
  const registered = {};
  const routes = [];
  const ctx = {
    get(name) {
      if (name === "tools") {
        return {
          register(definition) {
            registered[definition.name] = definition;
            return () => {};
          },
        };
      }
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) {
      return run();
    },
    on() {
      return () => {};
    },
    inject() {
      throw new Error("inject unavailable in this host");
    },
  };
  assert.doesNotThrow(() => host.apply(ctx));
  const fallbackNames = Object.keys(registered);
  assert.equal(fallbackNames.filter((name) => name.startsWith("whales_visit_")).length, 3, "inject 不可用时三个串门工具必须退化为立即注册");
  assert.ok(fallbackNames.includes("whales_propose_tasks"), "inject 不可用时提案工具也要注册");
  assert.equal(routes.length, 1, "inject 不可用时路由也要立即注册");
});

test("宿主 apply：服务重载（作用域释放 + 重新注入）不重复注册、不泄漏", () => {
  const injectHost = makeInjectHost();
  host.apply(injectHost.ctx);
  flushInjected(injectHost);
  const toolCount = Object.keys(injectHost.state.tools).length;
  assert.equal(toolCount, 15, "14 个 whales_* 工具（3 串门 + 提案 + 2 简报 + 2 流程图 + 原型 + 1 画布只读 + E2E 上报 + 需求 + 2 设计）+ show_view");
  assert.equal(injectHost.state.routes.length, 1);

  disposeInjected(injectHost);
  assert.deepEqual(Object.keys(injectHost.state.tools), [], "旧作用域释放后工具必须注销");
  assert.equal(injectHost.state.routes.length, 0, "旧作用域释放后路由必须撤销");

  flushInjected(injectHost);
  assert.equal(Object.keys(injectHost.state.tools).length, toolCount, "重新注入后工具数量不变（无重复注册残留）");
  assert.equal(injectHost.state.routes.length, 1, "重新注入后路由只有一条");
});


test("M5 系统提示：团队策略段含「项目简报（按需读取）」提示且只出现一次", () => {
  const text = String(host.TEAM_POLICY_TEXT);
  const hits = (text.match(/项目简报（按需读取）/g) || []).length;
  assert.equal(hits, 1, "静态提示必须恰好出现一次");
  assert.match(text, /whales_brief_read/, "提示里必须点名按需读取工具");
  assert.match(text, /whales_brief_read` 读取项目简报/, "提示措辞必须完整");
});

// ── 11. M6 工作台：report / 落点字段 / handoffs / inbox / sessions / 新建任务 ──
//
// 这一组打的是宿主半边的 HTTP 面（同源 token + 信封 + 业务码），fake 宿主同时提供
// webServer 路由与 sessions/agents/sessionPersistence，store 每个用例一份临时目录。

/** M6 专用假宿主：路由 + 三个只读会话服务 + tools；store 指向本用例专属临时目录。 */
function m6Harness(extraServices = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aw-m6-"));
  host.setProjectStorePathForTests(join(dir, "projects.json"));
  host.setProposalStorePathForTests(join(dir, "proposals.json"));
  host.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
  const routes = [];
  const tools = {};
  const followups = [];
  // W2 观测用例专用（只加不改）：给指定会话喂一份会话日志（tool/call 事件）。
  // 没有注入的会话保持原来的 { session: { id } }，既有用例行为不变。
  const sessionLogs = new Map();
  // W2 观测用例专用（只加不改）：捕获宿主事件监听器（tools/execute 等），
  // 用来喂「当前工具」。既有用例从不触发这些事件，行为不变。
  const listeners = {};
  // list() 里四个会话；live 由 get() 决定（session-old 只存在于持久化里）。
  const rows = [
    { id: "session-a", title: "主线会话", running: true, header: { origin: "user" } },
    { id: "session-b", title: "组员会话", running: false, header: { origin: "user" } },
    { id: "session-worker", title: "执行器会话", running: false, header: { origin: "subagent", parentSession: "session-a" } },
    { id: "session-old", header: {} }
  ];
  const live = new Set(["session-a", "session-b", "session-worker"]);
  const archived = new Set(["session-old"]);
  host.apply({
    get(name) {
      // v2.2 波次 2（只加不改）：用例可额外注入服务（sessionController / workspaceRegistry）。
      if (Object.prototype.hasOwnProperty.call(extraServices, name)) return extraServices[name];
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return {
        list: () => rows.map((row) => Object.assign({}, row)),
        get: (id) => (live.has(id) ? rows.find((row) => row.id === id) : undefined)
      };
      if (name === "agents") return {
        get: (id) => {
          if (!live.has(id)) return undefined;
          const agent = { id, status: id === "session-a" ? "running" : "idle", session: { id } };
          const events = sessionLogs.get(id);
          // 注入了日志才挂 events：没注入时与旧 fixture 完全一致。
          if (events !== undefined) agent.session = { id, events };
          return agent;
        },
        list: () => []
      };
      if (name === "sessionPersistence") return { stat: (id) => (archived.has(id) ? { id } : undefined) };
      if (name === "tools") return { register: (tool) => { tools[tool.name] = tool; return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on(name, listener) { listeners[name] = listener; return () => {}; }
  });
  const route = routes.find((item) => item && typeof item.handler === "function");
  assert.ok(route, "活动路由必须挂载");
  let token;
  async function request(method, url, headers, body) {
    const requestHeaders = headers || {};
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = requestHeaders;
    const settled = await new Promise((resolve, reject) => {
      const responseHeaders = {};
      const res = {
        statusCode: 0,
        headersSent: false,
        setHeader(key, value) { responseHeaders[String(key).toLowerCase()] = value; },
        end(text) { resolve({ status: this.statusCode, headers: responseHeaders, body: text }); }
      };
      try {
        route.handler(req, res);
      } catch (error) {
        reject(error);
        return;
      }
      setImmediate(() => {
        if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      });
    });
    let parsed;
    try { parsed = JSON.parse(settled.body); } catch (error) { parsed = undefined; }
    return { status: settled.status, headers: settled.headers, body: parsed, text: settled.body === undefined ? "" : String(settled.body) };
  }
  return {
    dir,
    tools,
    followups,
    route,
    sessionLogs,
    listeners,
    /** v2.2 波次 6（只加不改）：拿原始响应正文（组件包 bundle.js / styles.css 不是 JSON）。 */
    rawText(method, url) {
      return request(method, url, {}, undefined);
    },
    /** 带同源 token 的常规调用。 */
    call(method, url, body) {
      const headers = token === undefined ? {} : { "x-whales-token": token };
      return request(method, url, headers, body);
    },
    /** 裸调用（自带 headers）：用于「缺 token 必须 403」这类负例。 */
    raw(method, url, headers, body) {
      return request(method, url, headers, body);
    },
    async token() {
      if (token === undefined) {
        const activity = await request("GET", "/agent-whales/api/activity", {}, undefined);
        token = activity.body.controlToken;
      }
      return token;
    }
  };
}

/** 建一个项目（主对话 session-a）+ 返回 projectId。 */
async function createProject(h) {
  const tk = await h.token();
  const created = await h.call("POST", "/agent-whales/api/projects", { name: "M6 项目", mainSessionId: "session-a" });
  assert.equal(created.body.code, 200, JSON.stringify(created.body));
  return created.body.data.project.projectId;
}

describe("M6 report：四态 + CAS + 人机边界", () => {
  test("report：人写 done 全字段落库，视图带出 rev/at/bySessionId", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "体检宿主" });
    const taskId = created.body.data.task.taskId;
    assert.equal(created.body.data.task.report, null, "新任务没有 report 时视图必须给 null");

    const reported = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, {
      projectId,
      expectedRevision: 1,
      report: { status: "done", summary: "干完了", artifacts: [{ kind: "file", ref: "lib/index.js", note: "改动" }, { kind: "url", ref: "https://example.com" }] }
    });
    assert.equal(reported.body.code, 200, JSON.stringify(reported.body));
    const task = reported.body.data.task;
    assert.equal(task.revision, 2, "写 report 必须把任务 revision +1");
    assert.equal(task.report.status, "done");
    assert.equal(task.report.summary, "干完了");
    assert.equal(task.report.rev, 2, "report.rev 必须等于新 revision");
    assert.equal(task.report.bySessionId, "user", "缺省 bySessionId = 人");
    assert.ok(typeof task.report.at === "number" && task.report.at > 0);
    assert.deepEqual(task.report.artifacts, [{ kind: "file", ref: "lib/index.js", note: "改动" }, { kind: "url", ref: "https://example.com" }]);

    // 落库（不只是视图）：重新读任务表，report 仍在
    const listed = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
    const stored = listed.body.data.tasks.find((item) => item.taskId === taskId);
    assert.equal(stored.report.status, "done");
    assert.equal(stored.report.rev, 2);
  });

  test("report：CAS 冲突 40902 + latestVersion；worker 越权 40708；worker 可发起退回；人可关", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "改派发" });
    const taskId = created.body.data.task.taskId;

    // 过期 expectedRevision → 40902 + 最新版本号（两种键都给，UI 按哪套读都行）
    const stale = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 99, report: { status: "done" } });
    assert.equal(stale.body.code, 40902, JSON.stringify(stale.body));
    assert.equal(stale.body.data.latestVersion, 1);
    assert.equal(stale.body.data.latestRevision, 1);

    // worker 先写 done
    const workerDone = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 1, report: { status: "done" }, bySessionId: "session-worker" });
    assert.equal(workerDone.body.code, 200, JSON.stringify(workerDone.body));
    assert.equal(workerDone.body.data.task.report.bySessionId, "session-worker");

    // worker 发起 human_action（允许）
    const workerAsk = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 2, report: { status: "human_action", summary: "需要人给个线上账号" }, bySessionId: "session-worker" });
    assert.equal(workerAsk.body.code, 200, JSON.stringify(workerAsk.body));
    assert.equal(workerAsk.body.data.task.report.status, "human_action");

    // worker 想自己关回 done → 40708（退回结论只能人改）
    const workerClose = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 3, report: { status: "done" }, bySessionId: "session-worker" });
    assert.equal(workerClose.body.code, 40708, JSON.stringify(workerClose.body));
    assert.equal(workerClose.status, 200, "业务失败仍走 200 信封");

    // worker 从 done 发起 handed_back（允许：任何状态都能发起退回）
    const workerBack = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 3, report: { status: "handed_back", summary: "超出 scope，需要人决策" }, bySessionId: "session-worker" });
    assert.equal(workerBack.body.code, 200, JSON.stringify(workerBack.body));

    // 人可以把 handed_back 关回 done
    const humanClose = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 4, report: { status: "done" }, bySessionId: "user" });
    assert.equal(humanClose.body.code, 200, JSON.stringify(humanClose.body));
    assert.equal(humanClose.body.data.task.report.status, "done");
  });

  test("report：非法 status 40000、缺 token 403、项目/任务不存在 40401、已删除 40906、OPTIONS/方法", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "边界" });
    const taskId = created.body.data.task.taskId;
    const url = `/agent-whales/api/tasks/${taskId}/report`;

    const badStatus = await h.call("PUT", url, { projectId, expectedRevision: 1, report: { status: "weird" } });
    assert.equal(badStatus.body.code, 40000, JSON.stringify(badStatus.body));

    const noProject = await h.call("PUT", url, { expectedRevision: 1, report: { status: "done" } });
    assert.equal(noProject.body.code, 40000);

    const noToken = await h.raw("PUT", url, {}, { projectId, expectedRevision: 1, report: { status: "done" } });
    assert.equal(noToken.status, 403, "缺同源 token 必须 403");
    assert.equal(noToken.body.code, 40301);

    const ghostProject = await h.call("PUT", url, { projectId: "proj-ghost", expectedRevision: 1, report: { status: "done" } });
    assert.equal(ghostProject.body.code, 40401, JSON.stringify(ghostProject.body));

    const ghostTask = await h.call("PUT", "/agent-whales/api/tasks/ptask-ghost/report", { projectId, expectedRevision: 1, report: { status: "done" } });
    assert.equal(ghostTask.body.code, 40401);

    // 直接把任务标成 deleted → 40906
    const storeFile = join(h.dir, "projects.json");
    const store = JSON.parse(readFileSync(storeFile, "utf8"));
    store.tasks[taskId].status = "deleted";
    writeFileSync(storeFile, JSON.stringify(store), "utf8");
    const deleted = await h.call("PUT", url, { projectId, expectedRevision: 1, report: { status: "done" } });
    assert.equal(deleted.body.code, 40906, JSON.stringify(deleted.body));

    const options = await h.call("OPTIONS", url, undefined);
    assert.equal(options.status, 204, "OPTIONS 必须 204");
    assert.equal(options.headers["allow"], "PUT, OPTIONS");
    const post = await h.call("POST", url, { projectId, expectedRevision: 1, report: { status: "done" } });
    assert.equal(post.status, 405, "只接受 PUT");
    assert.equal(post.headers["allow"], "PUT, OPTIONS");
  });

  test("report：summary 截断到 4000、artifacts 限 50 条、脏值丢弃不抛", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "截断" });
    const taskId = created.body.data.task.taskId;
    const artifacts = [];
    for (let index = 0; index < 49; index += 1) artifacts.push({ kind: "file", ref: "ref-" + index });
    // 第 50 条放一条超长 ref（必须在 50 条上限内才会被截断保留）
    artifacts.push({ kind: "file", ref: "x".repeat(600) });
    // 超上限的与脏值一律丢弃
    for (let index = 0; index < 20; index += 1) artifacts.push({ kind: "url", ref: "https://example.com/" + index });
    artifacts.push({ kind: "weird", ref: "脏 kind" });
    artifacts.push({ kind: "file" });
    artifacts.push(null);
    const long = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, {
      projectId,
      expectedRevision: 1,
      report: { status: "draft", summary: "摘".repeat(4001), artifacts: artifacts }
    });
    assert.equal(long.body.code, 200, JSON.stringify(long.body));
    assert.equal(long.body.data.task.report.summary.length, 4000, "summary 必须截断到 4000 字");
    assert.equal(long.body.data.task.report.artifacts.length, 50, "artifacts 必须限 50 条");
    assert.equal(long.body.data.task.report.artifacts[0].ref, "ref-0");
    assert.equal(long.body.data.task.report.artifacts[49].ref, "x".repeat(500), "ref 超长必须截断到 500 字");
    for (const item of long.body.data.task.report.artifacts) {
      assert.ok(item.kind === "file" || item.kind === "url", "脏 kind 必须被丢弃");
      assert.ok(typeof item.ref === "string" && item.ref !== "", "缺 ref 必须被丢弃");
    }
  });
});

describe("M6 任务落点字段 worktree / execRoot", () => {
  test("新建时落库、视图原样带出；缺省为 null；assign 不改这两个字段", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    const withSpots = await h.call("POST", "/agent-whales/api/tasks", {
      projectId,
      subject: "带落点",
      worktree: ".dsh-agent-whales/work/ptask-x",
      execRoot: "D:/repo"
    });
    const task = withSpots.body.data.task;
    assert.equal(task.worktree, ".dsh-agent-whales/work/ptask-x");
    assert.equal(task.execRoot, "D:/repo");

    const plain = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "无落点" });
    assert.equal(plain.body.data.task.worktree, null, "缺省必须是 null（前端显示 —）");
    assert.equal(plain.body.data.task.execRoot, null);

    // 先把 session-b 加进项目，再 assign 给它：落点字段不得被命令改动
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    const assigned = await h.call("POST", `/agent-whales/api/tasks/${task.taskId}/commands`, { projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "assign-1" });
    assert.equal(assigned.body.code, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.task.worktree, ".dsh-agent-whales/work/ptask-x", "assign 不得改落点字段");
    assert.equal(assigned.body.data.task.execRoot, "D:/repo");
  });
});

describe("M6 GET /agent-whales/api/handoffs（发送记录）", () => {
  test("倒序 + 项目过滤 + limit + 项目不存在 40401 + 非 GET 405", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    // 三条发送记录：两条至少一方是项目成员，一条两边都是外人
    writeFileSync(join(h.dir, "handoffs.json"), JSON.stringify({
      entries: [
        { kind: "relay", from: "session-a", to: "session-b", messageId: "m1", at: 1000 },
        { kind: "dispatch", from: "user", to: "session-b", messageId: "m2", at: 3000, taskId: "ptask-1", revision: 1 },
        { kind: "relay", from: "session-ghost", to: "session-outsider", messageId: "m3", at: 2000 }
      ]
    }), "utf8");

    const all = await h.call("GET", "/agent-whales/api/handoffs");
    assert.equal(all.body.code, 200, JSON.stringify(all.body));
    assert.equal(all.body.data.projectId, null);
    assert.deepEqual(all.body.data.entries.map((entry) => entry.messageId), ["m2", "m3", "m1"], "必须按 at 倒序");
    assert.deepEqual(all.body.data.entries[0], { kind: "dispatch", from: "user", to: "session-b", messageId: "m2", at: 3000, taskId: "ptask-1", revision: 1 }, "已存字段原样带出");

    const scoped = await h.call("GET", `/agent-whales/api/handoffs?projectId=${projectId}`);
    assert.deepEqual(scoped.body.data.entries.map((entry) => entry.messageId), ["m2", "m1"], "只保留 from/to 至少一方是成员的记录");
    assert.equal(scoped.body.data.projectId, projectId);

    const limited = await h.call("GET", "/agent-whales/api/handoffs?limit=1");
    assert.equal(limited.body.data.entries.length, 1);
    assert.equal(limited.body.data.entries[0].messageId, "m2");

    const ghost = await h.call("GET", "/agent-whales/api/handoffs?projectId=proj-ghost");
    assert.equal(ghost.body.code, 40401, JSON.stringify(ghost.body));

    const post = await h.call("POST", "/agent-whales/api/handoffs", {});
    assert.equal(post.status, 405);
    assert.equal(post.headers["allow"], "GET, HEAD");
  });

  test("handoffs：账本损坏时降级为空表，不抛错", async () => {
    const h = await m6Harness();
    await createProject(h);
    writeFileSync(join(h.dir, "handoffs.json"), "{ 不是 json", "utf8");
    const read = await h.call("GET", "/agent-whales/api/handoffs");
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.data.entries, [], "损坏账本必须回空表");
    assert.ok(existsSync(join(h.dir, "handoffs.json")) === false, "原文件必须被备份改名");
  });
});

describe("M6 GET /agent-whales/api/inbox（需要我处理）", () => {
  test("四组聚合：提案 / human_action / handed_back / 前置删除；空组保留；项目过滤", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();

    // 提案台账按 leadSessionId 存一条：先提交 v1 并确认（锁定），再提交才会开新提案。
    // 于是现场是「一个已确认（不进待办）+ 一个未确认（进待办）」。
    const locked = await h.tools.whales_propose_tasks.execute({
      leadSessionId: "session-a", projectId, items: [{ key: "T1", title: "提案一" }]
    }, { agent: { id: "session-a" } });
    const confirmLocked = await h.call("POST", `/agent-whales/api/proposals/${locked.proposalId}/confirm`, { leadSessionId: "session-a", version: locked.version, requestId: "inbox-confirm" });
    assert.equal(confirmLocked.body.code, 200, JSON.stringify(confirmLocked.body));
    const pending = await h.tools.whales_propose_tasks.execute({
      leadSessionId: "session-a", projectId, items: [{ key: "T2", title: "提案二" }]
    }, { agent: { id: "session-a" } });
    assert.notEqual(pending.proposalId, locked.proposalId, "已确认后必须开新提案");

    // 三个任务：human_action / handed_back / 前置已删除
    const asked = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "求人任务" });
    const askedId = asked.body.data.task.taskId;
    const backed = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "退回任务" });
    const backedId = backed.body.data.task.taskId;
    const blocked = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "卡住任务" });
    const blockedId = blocked.body.data.task.taskId;
    const done = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "正常任务" });
    const doneId = done.body.data.task.taskId;

    await h.call("PUT", `/agent-whales/api/tasks/${askedId}/report`, { projectId, expectedRevision: 1, report: { status: "human_action", summary: "要账号" }, bySessionId: "session-worker" });
    await h.call("PUT", `/agent-whales/api/tasks/${backedId}/report`, { projectId, expectedRevision: 1, report: { status: "handed_back", summary: "超 scope" }, bySessionId: "session-worker" });
    await h.call("PUT", `/agent-whales/api/tasks/${doneId}/report`, { projectId, expectedRevision: 1, report: { status: "done", summary: "完成" }, bySessionId: "session-worker" });
    // 直接把「卡住任务」的前置指向一个不存在的任务 → 前置已删除
    const storeFile = join(h.dir, "projects.json");
    const store = JSON.parse(readFileSync(storeFile, "utf8"));
    store.tasks[blockedId].blockedBy = ["ptask-missing"];
    writeFileSync(storeFile, JSON.stringify(store), "utf8");

    const inbox = await h.call("GET", "/agent-whales/api/inbox");
    assert.equal(inbox.body.code, 200, JSON.stringify(inbox.body));
    const groups = {};
    for (const group of inbox.body.data.groups) groups[group.key] = group;
    assert.deepEqual(inbox.body.data.groups.map((group) => group.key), ["requirements", "proposals", "worker", "handed_back", "system"], "五组必须固定且顺序稳定（需求待办在最前）");
    assert.deepEqual(groups.requirements.items, [], "没有需求待办时该组为空但保留");
    assert.equal(groups.proposals.label, "提案待确认");
    assert.equal(groups.proposals.items.length, 1, "已确认提案不得再进待办");
    assert.equal(groups.proposals.items[0].kind, "proposal");
    assert.equal(groups.proposals.items[0].proposalId, pending.proposalId);
    assert.equal(groups.proposals.items[0].subject, "提案二", "subject 取首个 item 的 title");
    assert.equal(groups.worker.items.length, 1);
    assert.equal(groups.worker.items[0].taskId, askedId);
    assert.equal(groups.worker.items[0].report.status, "human_action");
    assert.equal(groups.handed_back.items.length, 1);
    assert.equal(groups.handed_back.items[0].taskId, backedId);
    assert.equal(groups.system.items.length, 1, "只有前置删除一条系统提醒");
    assert.equal(groups.system.items[0].kind, "task");
    assert.equal(groups.system.items[0].reason, "前置已删除");
    assert.equal(groups.system.items[0].taskId, blockedId);

    const scoped = await h.call("GET", `/agent-whales/api/inbox?projectId=proj-ghost`);
    assert.equal(scoped.body.code, 200, "项目过滤不该把接口打挂");
    for (const group of scoped.body.data.groups) assert.equal(group.items.length, 0, "空组也必须保留");

    const method = await h.call("POST", "/agent-whales/api/inbox", {});
    assert.equal(method.status, 405);
  });

  test("inbox：store 只读降级时 system 组出现 store-readonly 提醒", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "任务" });
    // 弄坏 handoffs.json：读时备份 + 只读降级
    writeFileSync(join(h.dir, "handoffs.json"), "{ 坏", "utf8");
    const inbox = await h.call("GET", "/agent-whales/api/inbox");
    assert.equal(inbox.body.code, 200);
    const system = inbox.body.data.groups.find((group) => group.key === "system");
    const store = system.items.find((item) => item.kind === "store");
    assert.ok(store, "只读降级必须提醒");
    assert.equal(store.reason, "store-readonly");
  });
});

describe("M6 GET /agent-whales/api/sessions（会话目录）", () => {
  test("live/running/archived/parentSessionId、live 优先排序、上限、服务缺失给空数组", async () => {
    const h = await m6Harness();
    const sessions = await h.call("GET", "/agent-whales/api/sessions");
    assert.equal(sessions.status, 200, JSON.stringify(sessions.body));
    assert.equal(sessions.body.data.source, "host");
    const order = sessions.body.data.sessions.map((item) => item.sessionId);
    assert.equal(order[order.length - 1], "session-old", "非 live 的必须排在最后");
    const liveTitles = sessions.body.data.sessions.filter((item) => item.live).map((item) => item.title);
    assert.deepEqual(liveTitles, liveTitles.slice().sort((a, b) => a.localeCompare(b)), "live 组内按标题升序");
    const byId = {};
    for (const item of sessions.body.data.sessions) byId[item.sessionId] = item;
    assert.equal(byId["session-a"].live, true);
    assert.equal(byId["session-a"].running, true);
    assert.equal(byId["session-a"].title, "主线会话");
    assert.equal(byId["session-b"].running, false, "idle 不是 running");
    assert.equal(byId["session-b"].live, true);
    assert.equal(byId["session-old"].live, false);
    assert.equal(byId["session-old"].archived, true, "有持久化记录且非 live = 归档");
    assert.equal(byId["session-old"].title, "", "没有标题给空串");
    assert.equal(byId["session-worker"].parentSessionId, "session-a", "header.parentSession 要映射成 parentSessionId");
    assert.equal(byId["session-a"].parentSessionId, undefined, "没有父会话不带这个键");

    const method = await h.call("POST", "/agent-whales/api/sessions", undefined, {});
    assert.equal(method.status, 405);
    assert.equal(method.headers["allow"], "GET, HEAD");

    // 服务整体缺失：给空数组而不是抛错
    const emptyHost = m6HarnessWithoutSessions();
    const empty = await emptyHost.call("GET", "/agent-whales/api/sessions");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.sessions, [], "取不到会话服务必须给空数组");
  });
});

/** 只提供 webServer 的假宿主（没有任何会话服务）。 */
function m6HarnessWithoutSessions() {
  const routes = [];
  host.apply({
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect(run) { return run(); },
    on() { return () => {}; }
  });
  const route = routes[0];
  return {
    async call(method, url, body) {
      const req = new EventEmitter();
      req.method = method;
      req.url = url;
      req.headers = {};
      const settled = await new Promise((resolve) => {
        const res = { statusCode: 0, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: text }); } };
        route.handler(req, res);
        setImmediate(() => {
          if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
          req.emit("end");
        });
      });
      let parsed;
      try { parsed = JSON.parse(settled.body); } catch (error) { parsed = undefined; }
      return { status: settled.status, body: parsed };
    }
  };
}

describe("M6 POST /agent-whales/api/tasks（新建任务）", () => {
  test("新建成功 + requestId 回放 + 项目不存在 40401 + 跨项目/已删除 blocker", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    const created = await h.call("POST", "/agent-whales/api/tasks", {
      projectId, subject: "新任务", description: "描述", writeScopes: ["lib/"], requestId: "create-1"
    });
    assert.equal(created.body.code, 200, JSON.stringify(created.body));
    assert.equal(created.body.data.source, "project");
    assert.equal(created.body.data.task.subject, "新任务");
    assert.equal(created.body.data.task.status, "pending");
    assert.equal(created.body.data.task.revision, 1);
    assert.deepEqual(created.body.data.task.writeScopes, ["lib/"]);

    // 同 requestId 再发 → 回放同一个任务，不重复建
    const replayed = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "另一个", requestId: "create-1" });
    assert.equal(replayed.body.data.task.taskId, created.body.data.task.taskId, "同 requestId 必须回放");
    assert.equal(replayed.body.data.replayed, true);
    const listed = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
    assert.equal(listed.body.data.tasks.filter((task) => task.subject === "另一个").length, 0, "回放不得真的再建一个");

    const ghost = await h.call("POST", "/agent-whales/api/tasks", { projectId: "proj-ghost", subject: "x" });
    assert.equal(ghost.body.code, 40401, JSON.stringify(ghost.body));

    const noSubject = await h.call("POST", "/agent-whales/api/tasks", { projectId });
    assert.equal(noSubject.body.code, 40000);

    const noToken = await h.raw("POST", "/agent-whales/api/tasks", {}, { projectId, subject: "x" });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.code, 40301);

    const missingBlocker = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "坏前置", blockedBy: ["ptask-elsewhere"] });
    assert.equal(missingBlocker.body.code, 40704, JSON.stringify(missingBlocker.body));

    // 已删除的前置 → 40906
    const first = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "前置" });
    const firstId = first.body.data.task.taskId;
    const storeFile = join(h.dir, "projects.json");
    const store = JSON.parse(readFileSync(storeFile, "utf8"));
    store.tasks[firstId].status = "deleted";
    writeFileSync(storeFile, JSON.stringify(store), "utf8");
    const deletedBlocker = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "跟已删除前置", blockedBy: [firstId] });
    assert.equal(deletedBlocker.body.code, 40906, JSON.stringify(deletedBlocker.body));

    const options = await h.call("OPTIONS", "/agent-whales/api/tasks", undefined);
    assert.equal(options.status, 204, "OPTIONS 必须 204");
    assert.equal(options.headers["allow"], "GET, HEAD, POST, OPTIONS", "allow 必须同时报出快照与新建");
    const put = await h.raw("PUT", "/agent-whales/api/tasks", {}, { projectId, subject: "x" });
    assert.equal(put.status, 405);
    assert.equal(put.headers["allow"], "GET, HEAD, POST, OPTIONS");
  });
});

// ── 12. W1.5 事件台：ingest / 规则 / 自激保护 / 噪声闸 / 三个动作 / 过滤 / 健康码 ──
//
// 这一组打的是宿主半边的 W1.5 事件面（T-11 事件台 + T-14 Source 健康面板）：
// events.json 与 handoffs.json 同目录、同 store 层；三个 ingest 接线点都只 warn 不抛。

/** W1.5 专用假宿主：m6Harness + 事件台账隔离到同一临时目录。 */
async function eventsHarness() {
  const h = await m6Harness();
  host.setEventsStorePathForTests(join(h.dir, "events.json"));
  return h;
}

/** 事件 ingest 用的假 ctx：收集 warn，便于断言「失败只 warn 不抛」。 */
function ingestCtx() {
  const warnings = [];
  return { warnings, logger: { warn(message) { warnings.push(String(message)); } } };
}

/** 直接读事件台账（测试断言用）。 */
function readEventsFile(dir) {
  return JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
}

/** 把规则数组按 name 索引，方便逐条断言。 */
function rulesByName(event) {
  const rules = {};
  for (const rule of event.rules) rules[rule.name] = rule;
  return rules;
}

/** 等 fire-and-forget 的事件记账落盘（store 降级接线点在同步读路径里，只能异步）。 */
async function waitForEventKind(dir, kind, count) {
  for (let i = 0; i < 60; i += 1) {
    let store;
    try { store = JSON.parse(readFileSync(join(dir, "events.json"), "utf8")); } catch (error) { store = undefined; }
    const found = store === undefined ? 0 : Object.values(store.events || {}).filter((event) => event.kind === kind).length;
    if (found >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("事件记账没有落盘: " + kind);
}

describe("W1.5 事件台：ingest 四类 kind 与三条规则", () => {
  test("四类 kind 各自落库；有项目时三条规则全命中", async () => {
    const h = await eventsHarness();
    const projectId = await createProject(h);
    // session-b 进项目，并占上一个 in_progress 任务；main（session-a）空闲 → assignable 命中
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    const busy = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "占着" });
    const busyId = busy.body.data.task.taskId;
    const busyStore = JSON.parse(readFileSync(join(h.dir, "projects.json"), "utf8"));
    busyStore.tasks[busyId].status = "in_progress";
    busyStore.tasks[busyId].ownerSessionId = "session-b";
    writeFileSync(join(h.dir, "projects.json"), JSON.stringify(busyStore), "utf8");

    const ctx = ingestCtx();
    const submitted = await host.ingestEvent(ctx, { source: "plugin", kind: "proposal.submit", text: "T1 · 修 F-002\n逐字描述内容", evidence: "prop-1", projectId });
    assert.equal(submitted.state, "pending");
    const command = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "M6 项目：开工 session-a 修 F-002", evidence: "req-1", projectId });
    const handoff = await host.ingestEvent(ctx, { source: "plugin", kind: "handoff.result", text: "dispatch msg-1", evidence: "msg-1", projectId });
    const degraded = await host.ingestEvent(ctx, { source: "plugin", kind: "store.degraded", text: "projects.json 只读降级", evidence: "" });
    assert.equal(degraded.projectId, null, "没有项目归属时 projectId 落 null");

    const store = readEventsFile(h.dir);
    assert.equal(store.version, 1);
    assert.equal(Object.keys(store.events).length, 4, "四类 kind 各落一条");
    assert.deepEqual(store.noise, {}, "没有屏蔽时 noise 是空表");
    const rules = rulesByName(command);
    assert.equal(rules["rule: scope.match"].hit, true, "原文出现项目名 → 命中");
    assert.match(rules["rule: scope.match"].detail, /M6 项目/);
    assert.equal(rules["rule: assignable"].hit, true, "session-a 没有 in_progress 任务 → 可分配");
    assert.match(rules["rule: assignable"].detail, /1\/2 个成员/);
    assert.equal(rules["rule: dedupe"].hit, true, "没有同 kind 的 pending → 命中");
    assert.match(rules["rule: dedupe"].detail, /无同类/);
    assert.equal(ctx.warnings.length, 0, "正常 ingest 不 warn");
    // handoff/store.degraded 也是 pending（dedupe 各自独立计数）
    assert.equal(handoff.state, "pending");
    assert.equal(degraded.state, "pending");
    assert.equal(store.events[submitted.eventId].text, "T1 · 修 F-002\n逐字描述内容", "原文逐字落库");
    assert.match(store.events[submitted.eventId].fingerprint, /^proposal\.submit\|/);
  });

  test("无项目/项目不存在/全员忙 → scope 与 assignable 未命中；dedupe 照算", async () => {
    const h = await eventsHarness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    // 两个任务分别占住 main 与 member → 全员忙
    const first = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "占 A" });
    const second = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "占 B" });
    const store = JSON.parse(readFileSync(join(h.dir, "projects.json"), "utf8"));
    store.tasks[first.body.data.task.taskId].status = "in_progress";
    store.tasks[first.body.data.task.taskId].ownerSessionId = "session-a";
    store.tasks[second.body.data.task.taskId].status = "in_progress";
    store.tasks[second.body.data.task.taskId].ownerSessionId = "session-b";
    writeFileSync(join(h.dir, "projects.json"), JSON.stringify(store), "utf8");

    const ctx = ingestCtx();
    const noProject = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-a", evidence: "ra" });
    const noProjectRules = rulesByName(noProject);
    assert.equal(noProjectRules["rule: scope.match"].hit, false);
    assert.match(noProjectRules["rule: scope.match"].detail, /无项目上下文/);
    assert.equal(noProjectRules["rule: assignable"].hit, false);
    assert.match(noProjectRules["rule: assignable"].detail, /无项目上下文/);
    assert.equal(noProjectRules["rule: dedupe"].hit, true);

    // 同 kind 同口径（都无项目）的第二条 → dedupe 未命中
    const secondSameKind = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-b", evidence: "rb" });
    const dedupeRules = rulesByName(secondSameKind);
    assert.equal(dedupeRules["rule: dedupe"].hit, false, "已有同 kind 待评估 → 未命中");
    assert.match(dedupeRules["rule: dedupe"].detail, /已有 1 条/);

    // 项目不存在
    const ghost = await host.ingestEvent(ctx, { source: "plugin", kind: "proposal.submit", text: "x", evidence: "e", projectId: "proj-ghost" });
    const ghostRules = rulesByName(ghost);
    assert.equal(ghostRules["rule: scope.match"].hit, false);
    assert.match(ghostRules["rule: scope.match"].detail, /项目不存在/);
    assert.equal(ghostRules["rule: assignable"].hit, false);
    assert.match(ghostRules["rule: assignable"].detail, /项目不存在/);

    // 全员忙 + 原文不出现项目名/成员 id
    const allBusy = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-c", evidence: "rc", projectId });
    const busyRules = rulesByName(allBusy);
    assert.equal(busyRules["rule: scope.match"].hit, false);
    assert.match(busyRules["rule: scope.match"].detail, /原文未出现/);
    assert.equal(busyRules["rule: assignable"].hit, false, "两个成员都有 in_progress 任务");
    assert.match(busyRules["rule: assignable"].detail, /2 个成员全部有 in_progress 任务/);
    assert.equal(busyRules["rule: dedupe"].hit, true, "项目口径不同，前面两条不算同类");
  });
});

describe("W1.5 事件台：自激保护与噪声闸", () => {
  test("同 fingerprint 10 分钟内第二条 suppressed（不算 pending）；过期后恢复", async () => {
    const h = await eventsHarness();
    const ctx = ingestCtx();
    const first = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-x", evidence: "r1" });
    assert.equal(first.state, "pending");
    // 空白归一化后同指纹（多个空格压成一格）→ 仍被抑制
    const second = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign   ptask-x", evidence: "r2" });
    assert.equal(second.state, "suppressed", "同类 10 分钟内只评估一次");

    const list = await h.call("GET", "/agent-whales/api/events");
    assert.equal(list.body.code, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.stats.pending, 1, "suppressed 不算 pending");
    assert.equal(list.body.data.events.filter((row) => row.state === "suppressed").length, 1);
    assert.equal(readEventsFile(h.dir).events[second.eventId].state, "suppressed");

    // 把两条的 at 都改到 11 分钟前 → 窗口过期，同指纹恢复 pending
    const store = readEventsFile(h.dir);
    store.events[first.eventId].at = Date.now() - 11 * 60 * 1000;
    store.events[second.eventId].at = Date.now() - 11 * 60 * 1000;
    writeFileSync(join(h.dir, "events.json"), JSON.stringify(store), "utf8");
    const third = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-x", evidence: "r3" });
    assert.equal(third.state, "pending", "超过 10 分钟必须恢复评估");
  });

  test("噪声闸：noise 未过期时同 source 新事件直接 noise、不进 pending；过期后恢复", async () => {
    const h = await eventsHarness();
    const ctx = ingestCtx();
    writeFileSync(join(h.dir, "events.json"), JSON.stringify({ version: 1, events: {}, noise: { plugin: Date.now() + 60 * 1000 } }), "utf8");
    const muted = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-m", evidence: "rm" });
    assert.equal(muted.state, "noise", "屏蔽中的 Source 直接记 noise");
    assert.deepEqual(muted.rules, [], "噪声事件不评估规则");
    const list = await h.call("GET", "/agent-whales/api/events");
    assert.equal(list.body.data.stats.pending, 0, "噪声事件不进待评估");

    writeFileSync(join(h.dir, "events.json"), JSON.stringify({ version: 1, events: {}, noise: { plugin: Date.now() - 1000 } }), "utf8");
    const revived = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-m2", evidence: "rm2" });
    assert.equal(revived.state, "pending", "屏蔽过期后恢复待评估");
  });
});

describe("W1.5 事件台：三个处置动作", () => {
  test("open：真建任务 + 事件 opened + ticketId；重复 open → 40904；requestId 回放", async () => {
    const h = await eventsHarness();
    const projectId = await createProject(h);
    const ctx = ingestCtx();
    const text = "M6 项目：把 F-002 修一下";
    const event = await host.ingestEvent(ctx, { source: "plugin", kind: "proposal.submit", text: text, evidence: "prop-open", projectId });

    const opened = await h.call("POST", `/agent-whales/api/events/${event.eventId}/actions`, { action: "open", projectId, requestId: "open-1" });
    assert.equal(opened.body.code, 200, JSON.stringify(opened.body));
    const ticketId = opened.body.data.ticket.taskId;
    assert.equal(opened.body.data.event.state, "opened");
    assert.equal(opened.body.data.event.ticketId, ticketId);
    assert.equal(opened.body.data.event.decidedBy, "user");
    assert.ok(typeof opened.body.data.event.decidedAt === "number" && opened.body.data.event.decidedAt > 0);

    // 任务真在任务表里（subject = 原文前 60 字，description 带原文与证据，无 owner）
    const listed = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
    const ticket = listed.body.data.tasks.find((task) => task.taskId === ticketId);
    assert.ok(ticket, "开工单必须真建任务");
    assert.equal(ticket.subject, text.slice(0, 60));
    assert.match(ticket.description, /把 F-002 修一下/);
    assert.match(ticket.description, /prop-open/);
    assert.equal(ticket.status, "pending");
    assert.equal(ticket.ownerSessionId, null, "开工单不传 owner");

    const store = readEventsFile(h.dir);
    assert.equal(store.events[event.eventId].state, "opened");
    assert.equal(store.events[event.eventId].ticketId, ticketId);

    // 重复 open（新 requestId）→ 40904 已处置
    const again = await h.call("POST", `/agent-whales/api/events/${event.eventId}/actions`, { action: "open", projectId, requestId: "open-2" });
    assert.equal(again.body.code, 40904, JSON.stringify(again.body));

    // 同 requestId → 进程内回放，不重复建单
    const replayed = await h.call("POST", `/agent-whales/api/events/${event.eventId}/actions`, { action: "open", projectId, requestId: "open-1" });
    assert.equal(replayed.body.code, 200);
    assert.equal(replayed.body.data.replayed, true);
    assert.equal(replayed.body.data.ticket.taskId, ticketId);
    assert.equal(replayed.body.data.event.state, "opened");
    const listedAgain = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
    assert.equal(listedAgain.body.data.tasks.filter((task) => task.taskId === ticketId).length, 1, "回放不得再建一个");
  });

  test("ignore 留痕不建单；open 的 projectId 回退；noise 写 24h 屏蔽且 health 变 noise；边界码齐全", async () => {
    const h = await eventsHarness();
    const projectId = await createProject(h);
    const ctx = ingestCtx();
    const ignored = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assign ptask-i", evidence: "ri", projectId });
    const fallback = await host.ingestEvent(ctx, { source: "plugin", kind: "proposal.submit", text: "回退项目口径", evidence: "pf", projectId });
    const noised = await host.ingestEvent(ctx, { source: "plugin", kind: "handoff.result", text: "dispatch msg-n", evidence: "msg-n", projectId });
    // 没有项目归属的事件：open 时两边都拿不到项目 → 40000
    const orphan = await host.ingestEvent(ctx, { source: "plugin", kind: "store.degraded", text: "projects.json 只读降级", evidence: "" });

    const ignoreResult = await h.call("POST", `/agent-whales/api/events/${ignored.eventId}/actions`, { action: "ignore" });
    assert.equal(ignoreResult.body.code, 200, JSON.stringify(ignoreResult.body));
    assert.equal(ignoreResult.body.data.event.state, "ignored");
    assert.equal(ignoreResult.body.data.event.decidedBy, "user");
    assert.ok(typeof ignoreResult.body.data.event.decidedAt === "number");
    assert.equal(ignoreResult.body.data.event.ticketId, undefined, "忽略不建单");
    const listed = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
    assert.equal(listed.body.data.tasks.length, 0, "ignore 不建单");

    // open 的边界：事件与 body 都没有项目 → 40000；项目不存在 → 40401
    const noProject = await h.call("POST", `/agent-whales/api/events/${orphan.eventId}/actions`, { action: "open" });
    assert.equal(noProject.body.code, 40000, JSON.stringify(noProject.body));
    const ghostProject = await h.call("POST", `/agent-whales/api/events/${orphan.eventId}/actions`, { action: "open", projectId: "proj-ghost" });
    assert.equal(ghostProject.body.code, 40401, JSON.stringify(ghostProject.body));

    // projectId 回退：body 不给，用事件自己的 projectId 建单
    const fallbackResult = await h.call("POST", `/agent-whales/api/events/${fallback.eventId}/actions`, { action: "open", requestId: "fallback-open" });
    assert.equal(fallbackResult.body.code, 200, JSON.stringify(fallbackResult.body));
    assert.equal(fallbackResult.body.data.event.state, "opened");
    const fallbackTicketId = fallbackResult.body.data.ticket.taskId;
    const afterFallback = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
    assert.ok(afterFallback.body.data.tasks.some((task) => task.taskId === fallbackTicketId), "回退口径必须建在事件自己的项目里");

    // 动作非法 / 事件不存在 / 缺 token / 方法
    const bad = await h.call("POST", `/agent-whales/api/events/${noised.eventId}/actions`, { action: "weird" });
    assert.equal(bad.body.code, 40000);
    const ghostEvent = await h.call("POST", "/agent-whales/api/events/evt-ghost/actions", { action: "ignore" });
    assert.equal(ghostEvent.body.code, 40401);
    const noToken = await h.raw("POST", `/agent-whales/api/events/${noised.eventId}/actions`, {}, { action: "ignore" });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.code, 40301);
    const options = await h.call("OPTIONS", `/agent-whales/api/events/${noised.eventId}/actions`, undefined);
    assert.equal(options.status, 204);
    assert.equal(options.headers["allow"], "POST, OPTIONS");

    // noise：事件置 noise + 该 Source 屏蔽 24 小时
    const noiseResult = await h.call("POST", `/agent-whales/api/events/${noised.eventId}/actions`, { action: "noise" });
    assert.equal(noiseResult.body.code, 200, JSON.stringify(noiseResult.body));
    assert.equal(noiseResult.body.data.event.state, "noise");
    const store = readEventsFile(h.dir);
    assert.ok(store.noise.plugin > Date.now(), "noise 动作必须写屏蔽截止");
    assert.ok(store.noise.plugin <= Date.now() + 24 * 60 * 60 * 1000, "屏蔽时长是 24 小时");

    const health = await h.call("GET", "/agent-whales/api/events/health");
    assert.equal(health.body.code, 200, JSON.stringify(health.body));
    const plugin = health.body.data.health.find((row) => row.source === "plugin");
    assert.equal(plugin.state, "noise", "被屏蔽的 Source 健康码必须是 noise");
    assert.ok(typeof plugin.mutedUntil === "number" && plugin.mutedUntil > Date.now());

    // 已处置事件再处置 → 40904
    const reIgnore = await h.call("POST", `/agent-whales/api/events/${ignored.eventId}/actions`, { action: "ignore" });
    assert.equal(reIgnore.body.code, 40904, JSON.stringify(reIgnore.body));
  });
});

describe("W1.5 事件台：GET /api/events 过滤与统计", () => {
  test("source/state/limit 过滤、stats、倒序、跨项目口径、非 GET 405", async () => {
    const h = await eventsHarness();
    const projectA = await createProject(h);
    const projectB = await h.call("POST", "/agent-whales/api/projects", { name: "项目 B", mainSessionId: "session-b" });
    const bId = projectB.body.data.project.projectId;
    const now = Date.now();
    writeFileSync(join(h.dir, "events.json"), JSON.stringify({
      version: 1,
      noise: {},
      events: {
        "evt-1": { eventId: "evt-1", projectId: projectA, source: "plugin", kind: "task.command", text: "t1", evidence: "e1", fingerprint: "task.command|t1", at: now - 3000, state: "pending", rules: [] },
        "evt-2": { eventId: "evt-2", projectId: projectA, source: "plugin", kind: "proposal.submit", text: "t2", evidence: "e2", fingerprint: "proposal.submit|t2", at: now - 2000, state: "opened", ticketId: "ptask-1", decidedAt: now - 1000, decidedBy: "user", rules: [] },
        "evt-3": { eventId: "evt-3", projectId: projectA, source: "plugin", kind: "handoff.result", text: "t3", evidence: "e3", fingerprint: "handoff.result|t3", at: now - 1000, state: "ignored", decidedAt: now - 500, decidedBy: "user", rules: [] },
        "evt-4": { eventId: "evt-4", projectId: bId, source: "main-session", kind: "task.command", text: "t4", evidence: "e4", fingerprint: "task.command|t4", at: now - 500, state: "pending", rules: [] },
        "evt-5": { eventId: "evt-5", projectId: null, source: "plugin", kind: "store.degraded", text: "t5", evidence: "", fingerprint: "store.degraded|t5", at: now - 26 * 60 * 60 * 1000, state: "pending", rules: [] }
      }
    }), "utf8");

    const all = await h.call("GET", "/agent-whales/api/events");
    assert.equal(all.body.code, 200, JSON.stringify(all.body));
    assert.equal(all.body.data.source, "plugin");
    assert.equal(all.body.data.projectId, null, "不带 projectId = 跨全部项目");
    assert.deepEqual(all.body.data.events.map((row) => row.eventId), ["evt-4", "evt-3", "evt-2", "evt-1", "evt-5"], "必须按 at 倒序");
    assert.deepEqual(all.body.data.stats, { pending: 3, today: 4, opened: 1, ignored: 1 }, "evt-5 是 26 小时前，不算今天");
    assert.equal(all.body.data.events[2].ticketId, "ptask-1", "ticketId 原样带出");
    assert.equal(all.body.data.events[2].decidedBy, "user");

    const scoped = await h.call("GET", `/agent-whales/api/events?projectId=${projectA}`);
    assert.deepEqual(scoped.body.data.events.map((row) => row.eventId), ["evt-3", "evt-2", "evt-1"]);
    assert.deepEqual(scoped.body.data.stats, { pending: 1, today: 3, opened: 1, ignored: 1 });

    // main-session 是词表值：本期不产事件，但筛选器必须能用
    const bySource = await h.call("GET", "/agent-whales/api/events?source=main-session");
    assert.deepEqual(bySource.body.data.events.map((row) => row.eventId), ["evt-4"]);
    const byState = await h.call("GET", "/agent-whales/api/events?state=opened");
    assert.deepEqual(byState.body.data.events.map((row) => row.eventId), ["evt-2"]);
    const limited = await h.call("GET", "/agent-whales/api/events?limit=2");
    assert.deepEqual(limited.body.data.events.map((row) => row.eventId), ["evt-4", "evt-3"]);
    const capped = await h.call("GET", "/agent-whales/api/events?limit=9999");
    assert.equal(capped.body.data.events.length, 5, "limit 最大 500");
    // fingerprint 按契约下发（自激保护的内部依据，客户端可展示）
    assert.equal(all.body.data.events[0].fingerprint, "task.command|t4");

    const post = await h.call("POST", "/agent-whales/api/events", {});
    assert.equal(post.status, 405);
    assert.equal(post.headers["allow"], "GET, HEAD");
  });
});

describe("W1.5 事件台：Source 健康面板固定词表", () => {
  test("idle → ready → assessing → suppressed → noise 的递进与优先级", async () => {
    const h = await eventsHarness();
    await h.token();
    // 空台账：四个词表 Source 全是 idle
    const empty = await h.call("GET", "/agent-whales/api/events/health");
    assert.equal(empty.body.code, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.data.health.map((row) => row.source), ["plugin", "main-session", "workspace", "schedule"]);
    for (const row of empty.body.data.health) {
      assert.equal(row.state, "idle", "今天没有事件 → idle");
      assert.equal(row.today, 0);
      assert.equal(row.pending, 0);
      assert.equal(row.lastAt, 0);
      assert.equal(row.mutedUntil, undefined);
    }

    const ctx = ingestCtx();
    // ready：今天有事件但都已处置
    const done = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "ready-one", evidence: "r" });
    await h.call("POST", `/agent-whales/api/events/${done.eventId}/actions`, { action: "ignore" });
    const ready = await h.call("GET", "/agent-whales/api/events/health");
    const readyRow = ready.body.data.health.find((row) => row.source === "plugin");
    assert.equal(readyRow.state, "ready", "有今天的事件、无 pending、无抑制 → ready");
    assert.equal(readyRow.today, 1);

    // assessing：有 pending（同指纹第二条被 suppressed，但不抢 assessing）
    const pendingOne = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assessing-one", evidence: "a" });
    await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "assessing-one", evidence: "a2" });
    const assessing = await h.call("GET", "/agent-whales/api/events/health");
    const assessingRow = assessing.body.data.health.find((row) => row.source === "plugin");
    assert.equal(assessingRow.state, "assessing", "有 pending → assessing");
    assert.equal(assessingRow.pending, 1);
    assert.equal(assessingRow.suppressed, 1, "近 10 分钟的 suppressed 计数");
    assert.equal(assessingRow.today, 3);

    // suppressed：pending 也处置掉，只剩近 10 分钟的 suppressed
    await h.call("POST", `/agent-whales/api/events/${pendingOne.eventId}/actions`, { action: "ignore" });
    const suppressed = await h.call("GET", "/agent-whales/api/events/health");
    const suppressedRow = suppressed.body.data.health.find((row) => row.source === "plugin");
    assert.equal(suppressedRow.state, "suppressed", "近 10 分钟有 suppressed → suppressed");

    // noise：被标记噪声且未过期
    const mutedOne = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "noise-one", evidence: "n" });
    await h.call("POST", `/agent-whales/api/events/${mutedOne.eventId}/actions`, { action: "noise" });
    const noised = await h.call("GET", "/agent-whales/api/events/health");
    const noisedRow = noised.body.data.health.find((row) => row.source === "plugin");
    assert.equal(noisedRow.state, "noise", "被标记噪声且未过期 → noise");
    assert.ok(noisedRow.mutedUntil > Date.now());
    // 其余三个词表 Source 始终 idle
    for (const row of noised.body.data.health) {
      if (row.source === "plugin") continue;
      assert.equal(row.state, "idle");
    }
  });
});

describe("W1.5 事件台：接线点与失败兜底", () => {
  test("三个 ingest 接线点各自落库；store 降级落一条且只落一条", async () => {
    const h = await eventsHarness();
    const projectId = await createProject(h);

    // 1) 提案工具提交成功 → proposal.submit（原文逐字）
    const proposal = await h.tools.whales_propose_tasks.execute({
      leadSessionId: "session-a", projectId, items: [{ key: "T1", title: "修 F-002", description: "逐字描述内容" }]
    }, { agent: { id: "session-a" } });

    // 2) 任务命令写成功 → task.command
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "接线" });
    const taskId = created.body.data.task.taskId;
    await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "wire-assign" });

    // 3) 交接失败（session-worker 是 live 但没有 followup → dispatch-rejected）→ handoff.result
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });
    const dispatched = await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign-and-dispatch", owner: "session-worker", expectedRevision: 2, requestId: "wire-dispatch" });
    assert.equal(dispatched.body.code, 200, JSON.stringify(dispatched.body));
    assert.equal(dispatched.body.data.dispatch.status, "failed", "假宿主没有 followup，交接必须失败");

    let store = readEventsFile(h.dir);
    let events = Object.values(store.events);
    const submitted = events.find((event) => event.kind === "proposal.submit");
    assert.ok(submitted, "提案提交必须落事件");
    assert.equal(submitted.evidence, proposal.proposalId);
    assert.equal(submitted.projectId, projectId);
    assert.match(submitted.text, /T1 · 修 F-002/);
    assert.match(submitted.text, /逐字描述内容/);
    const command = events.find((event) => event.kind === "task.command");
    assert.ok(command, "任务命令必须落事件");
    assert.equal(command.text, "assign " + taskId);
    assert.equal(command.evidence, "wire-assign");
    assert.equal(command.projectId, projectId);
    const handoff = events.find((event) => event.kind === "handoff.result");
    assert.ok(handoff, "交接失败必须落事件");
    assert.match(handoff.text, /^dispatch /);
    assert.equal(handoff.projectId, projectId);

    // 4) projects.json 损坏 → 读一次落一条 store.degraded，再读不重复
    writeFileSync(join(h.dir, "projects.json"), "{ 坏", "utf8");
    await h.call("GET", "/agent-whales/api/projects");
    await waitForEventKind(h.dir, "store.degraded", 1);
    store = readEventsFile(h.dir);
    const degraded = Object.values(store.events).filter((event) => event.kind === "store.degraded");
    assert.equal(degraded.length, 1, "一次降级 episode 只落一条");
    assert.equal(degraded[0].text, "projects.json 只读降级");
    assert.equal(degraded[0].projectId, null);
    assert.ok(typeof degraded[0].evidence === "string" && degraded[0].evidence !== "", "evidence 是备份路径");
    assert.ok(existsSync(degraded[0].evidence), "备份文件必须真实存在");
    await h.call("GET", "/agent-whales/api/projects");
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Object.values(readEventsFile(h.dir).events).filter((event) => event.kind === "store.degraded").length, 1, "恢复前不重复登记");
  });

  test("ingest 失败不抛：events.json 损坏时 ingest 静默、主流程不受影响", async () => {
    const h = await eventsHarness();
    const projectId = await createProject(h);
    writeFileSync(join(h.dir, "events.json"), "{ 不是 json", "utf8");
    const ctx = ingestCtx();
    const result = await host.ingestEvent(ctx, { source: "plugin", kind: "task.command", text: "x", evidence: "y", projectId });
    assert.equal(result, undefined, "台账损坏时 ingest 必须静默收场");
    assert.equal(ctx.warnings.length, 1, "失败要 warn 一次");
    assert.match(ctx.warnings[0], /event ingest/);

    // 主流程不受影响：建任务、读事件台都正常
    const task = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "照常" });
    assert.equal(task.body.code, 200, JSON.stringify(task.body));
    const list = await h.call("GET", "/agent-whales/api/events");
    assert.equal(list.body.code, 200);
    assert.deepEqual(list.body.data.events, [], "损坏的事件台账回空表");
    assert.equal(list.body.data.health.length, 4, "健康面板仍给四个词表 Source");
    assert.deepEqual(list.body.data.stats, { pending: 0, today: 0, opened: 0, ignored: 0 });
  });
});

describe("W1 worker preset 安装器", () => {
  test("首次安装两个文件、二次 apply 不覆盖、目标已存在时不动", () => {
    const presetRoot = mkdtempSync(join(tmpdir(), "aw-preset-"));
    const target = join(presetRoot, "dsh-agent-whales-worker");
    const repoPreset = join(dirname(fileURLToPath(import.meta.url)), "..", "presets", "dsh-agent-whales-worker");
    const previous = process.env.DSH_AGENT_WHALES_PRESET_DIR;
    process.env.DSH_AGENT_WHALES_PRESET_DIR = presetRoot;
    const bareHost = () => ({
      get: () => undefined,
      effect(run) { return run(); },
      on() { return () => {}; }
    });
    try {
      // 1) 首次安装：两个文件都在，且与仓库里的完全一致
      host.apply(bareHost());
      assert.ok(existsSync(join(target, "preset.yml")), "preset.yml 必须被安装");
      assert.ok(existsSync(join(target, "agent.cordis.yml")), "agent.cordis.yml 必须被安装");
      assert.equal(
        readFileSync(join(target, "preset.yml"), "utf8"),
        readFileSync(join(repoPreset, "preset.yml"), "utf8"),
        "安装内容必须与插件自带文件一致"
      );
      assert.equal(
        readFileSync(join(target, "agent.cordis.yml"), "utf8"),
        readFileSync(join(repoPreset, "agent.cordis.yml"), "utf8")
      );
      const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
      assert.ok(manifest.files.includes("presets/dsh-agent-whales-worker/preset.yml"), "preset.yml 必须进 files");
      assert.ok(manifest.files.includes("presets/dsh-agent-whales-worker/agent.cordis.yml"), "agent.cordis.yml 必须进 files");

      // 2) 用户改过自己的版本：再次 apply 不得覆盖
      writeFileSync(join(target, "preset.yml"), "name: 我改过的版本\n", "utf8");
      writeFileSync(join(target, "extra.txt"), "别动我", "utf8");
      host.apply(bareHost());
      assert.equal(readFileSync(join(target, "preset.yml"), "utf8"), "name: 我改过的版本\n", "已存在的 preset 绝不被覆盖");
      assert.equal(readFileSync(join(target, "extra.txt"), "utf8"), "别动我", "用户目录里的其它文件不受影响");

      // 3) 目标目录事先存在（哪怕是空目录）：同样整目录跳过
      const other = mkdtempSync(join(tmpdir(), "aw-preset-"));
      process.env.DSH_AGENT_WHALES_PRESET_DIR = other;
      mkdirSync(join(other, "dsh-agent-whales-worker"), { recursive: true });
      host.apply(bareHost());
      assert.equal(existsSync(join(other, "dsh-agent-whales-worker", "preset.yml")), false, "目标已存在不得补文件");
    } finally {
      if (previous === undefined) delete process.env.DSH_AGENT_WHALES_PRESET_DIR;
      else process.env.DSH_AGENT_WHALES_PRESET_DIR = previous;
      rmSync(presetRoot, { recursive: true, force: true });
    }
  });
});

// ── 13. W2 观测：timeline 六步 / observations / 路由接线 ────────────────────
//
// 这一组打的是宿主半边的 W2 观测面（设计图 T-13 event_replay，帧 e6QPoS）：
// 时间线六步 = Source → Trigger → Policy → Ticket → Worker → Report，一步一证据；
// observations 给 Worker 侧最小可见性（当前工具 + 日志尾部）。两个路由都只读、
// 无 token；projectId 宽松口径（项目不存在 → 回空 + note，不刷错误）。

/** W2 专用假宿主：m6Harness + 事件台账隔离到同一临时目录（与 W1.5 同一规矩）。 */
async function w2Harness() {
  const h = await m6Harness();
  host.setEventsStorePathForTests(join(h.dir, "events.json"));
  return h;
}

/** 按 key 取时间线里的那一步（顺序错了也要能抓到，不断言具体下标）。 */
function stepOf(body, key) {
  const step = body.data.steps.find((item) => item.key === key);
  assert.ok(step, "六步里必须存在 " + key + " 步：" + JSON.stringify(body.data.steps.map((s) => s.key)));
  return step;
}

/** 读项目 store（测试断言/造事实用）。 */
function readProjectsFile(h) {
  return JSON.parse(readFileSync(join(h.dir, "projects.json"), "utf8"));
}

/** 改项目 store 后写回（测试里造 dispatch 事实 / completed 状态的唯一入口）。 */
function writeProjectsFile(h, store) {
  writeFileSync(join(h.dir, "projects.json"), JSON.stringify(store), "utf8");
}

/** 直接写发送账本（造 handoffs 事实；recordSend 只在派发成功时写，测试要能造任意态）。 */
function writeHandoffsFile(h, entries) {
  writeFileSync(join(h.dir, "handoffs.json"), JSON.stringify({ entries }), "utf8");
}

/** 提案提交 + 确认，返回 { proposalId, taskId }（sourceProposal 任务的唯一正规来路）。 */
async function proposeAndConfirm(h, projectId, requestId) {
  const proposal = await h.tools.whales_propose_tasks.execute({
    leadSessionId: "session-a", projectId, items: [{ key: "T1", title: "修 F-002", description: "逐字描述内容" }]
  }, { agent: { id: "session-a" } });
  const confirmed = await h.call("POST", `/agent-whales/api/proposals/${proposal.proposalId}/confirm`, {
    leadSessionId: "session-a", version: proposal.version, requestId: requestId || "w2-confirm"
  });
  assert.equal(confirmed.body.code, 200, JSON.stringify(confirmed.body));
  return { proposalId: proposal.proposalId, taskId: confirmed.body.data.created[0].taskId };
}

describe("W2 观测：timeline 六步派生（T-13）", () => {
  test("有来源提案：source/trigger 有据、policy 用确认时刻、未指派前 worker/report 待定", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const { proposalId, taskId } = await proposeAndConfirm(h, projectId);

    const timeline = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}`);
    assert.equal(timeline.body.code, 200, JSON.stringify(timeline.body));
    const data = timeline.body.data;
    assert.equal(data.source, "project");
    assert.equal(data.projectId, projectId);
    assert.equal(data.taskId, taskId);
    assert.deepEqual(data.steps.map((step) => step.key), ["source", "trigger", "policy", "ticket", "worker", "report"], "六步固定且按序");
    for (const step of data.steps) {
      assert.equal(typeof step.phase, "string", "每步都要有阶段词");
      assert.equal(typeof step.title, "string", "每步都要有标题");
      assert.ok(["done", "active", "pending", "skipped"].includes(step.state), "state 必须在词表内");
    }

    // 事实来源：events.json 里的 proposal.submit（evidence === proposalId）
    const events = Object.values(readEventsFile(h.dir).events);
    const submit = events.find((event) => event.kind === "proposal.submit" && event.evidence === proposalId);
    assert.ok(submit, "提案提交必须落事件");
    const proposals = JSON.parse(readFileSync(join(h.dir, "proposals.json"), "utf8"));
    const lockedAt = proposals["session-a"].confirmed.lockedAt;
    const store = readProjectsFile(h);
    const task = store.tasks[taskId];

    const source = stepOf(timeline.body, "source");
    assert.equal(source.state, "done");
    assert.equal(source.at, submit.at, "source 的时间就是事件落库时间");
    assert.match(source.detail, /逐字原文，未摘要、未改写/);
    assert.match(source.detail, /修 F-002/);
    assert.equal(source.evidence, submit.eventId);

    const trigger = stepOf(timeline.body, "trigger");
    assert.equal(trigger.state, "done");
    assert.equal(trigger.at, submit.at);
    assert.match(trigger.detail, new RegExp(submit.eventId + " · source=plugin"));

    const policy = stepOf(timeline.body, "policy");
    assert.equal(policy.state, "done");
    assert.equal(policy.at, lockedAt, "policy 的时间是提案确认那一刻");
    assert.match(policy.detail, /提案 v1 确认 · 1 项建单/);
    assert.equal(policy.evidence, proposalId);

    const ticket = stepOf(timeline.body, "ticket");
    assert.equal(ticket.state, "done");
    assert.equal(ticket.at, task.createdAt, "ticket 的时间是任务创建时间");
    assert.match(ticket.detail, /修 F-002/);
    assert.match(ticket.detail, /未指派 owner/);
    assert.equal(ticket.evidence, taskId);

    assert.equal(stepOf(timeline.body, "worker").state, "pending", "没指派 owner → 执行步待定");
    assert.equal(stepOf(timeline.body, "worker").detail, "未指派 owner");
    assert.equal(stepOf(timeline.body, "report").state, "pending");
    assert.equal(stepOf(timeline.body, "report").detail, "尚未回流");

    // entries：来源提案的 proposal.submit 必须进来
    const submitEntry = data.entries.find((entry) => entry.kind === "proposal.submit");
    assert.ok(submitEntry, "明细里要能看到来源事件");
    assert.equal(submitEntry.evidence, proposalId);
  });

  test("无来源提案：source/trigger skipped，policy=创建即通过", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "手动开的工单" });
    const taskId = created.body.data.task.taskId;
    const store = readProjectsFile(h);

    const timeline = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}`);
    assert.equal(timeline.body.code, 200, JSON.stringify(timeline.body));
    const source = stepOf(timeline.body, "source");
    assert.equal(source.state, "skipped");
    assert.equal(source.detail, "手动创建，无来源提案");
    assert.equal(source.evidence, undefined, "没有来源就不编证据");
    const trigger = stepOf(timeline.body, "trigger");
    assert.equal(trigger.state, "skipped");
    assert.equal(trigger.detail, "手动创建，无 Trigger");
    const policy = stepOf(timeline.body, "policy");
    assert.equal(policy.state, "done");
    assert.equal(policy.at, store.tasks[taskId].createdAt, "手动创建 = 创建即通过");
    assert.equal(policy.detail, "手动创建，创建即通过");
    assert.equal(policy.evidence, taskId, "没有提案时证据落任务自身");
  });

  test("被 blockedBy 挡过：policy detail 写前置 id 与解锁时间；仍在等待就明说", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const first = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "前置任务" });
    const second = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "后置任务", blockedBy: [first.body.data.task.taskId] });
    const blockerId = first.body.data.task.taskId;
    const taskId = second.body.data.task.taskId;

    // 前置没完成：明说仍在等待，不猜解锁时间
    const waiting = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}`);
    const waitingPolicy = stepOf(waiting.body, "policy");
    assert.match(waitingPolicy.detail, new RegExp("曾被 " + blockerId + " 挡住 · 仍在等待 " + blockerId));

    // 前置完成了（store 直写 completed + completedAt）：解锁时间取最后一个前置的完成时间
    const store = readProjectsFile(h);
    const completedAt = Date.now() - 5000;
    store.tasks[blockerId].status = "completed";
    store.tasks[blockerId].completedAt = completedAt;
    writeProjectsFile(h, store);

    const unlocked = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}`);
    const unlockedPolicy = stepOf(unlocked.body, "policy");
    assert.match(unlockedPolicy.detail, new RegExp("曾被 " + blockerId + " 挡住 · 解锁于 " + completedAt));
  });

  test("dispatch 三态：failed（真实派发失败）/ sent / unknown 都进 worker 步 detail", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });

    // ① failed：真派发（假宿主没有 followup → dispatch-rejected）
    const failedTask = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "派发失败" });
    const failedId = failedTask.body.data.task.taskId;
    const dispatched = await h.call("POST", `/agent-whales/api/tasks/${failedId}/commands`, {
      projectId, action: "assign-and-dispatch", owner: "session-worker", expectedRevision: 1, requestId: "w2-dispatch-failed"
    });
    assert.equal(dispatched.body.code, 200, JSON.stringify(dispatched.body));
    assert.equal(dispatched.body.data.dispatch.status, "failed");
    const failedTimeline = await h.call("GET", `/agent-whales/api/tasks/${failedId}/timeline?projectId=${projectId}`);
    const failedWorker = stepOf(failedTimeline.body, "worker");
    assert.equal(failedWorker.state, "active", "指派了还没回流 → 执行中");
    assert.match(failedWorker.detail, /派发 failed（dispatch-rejected）/);
    assert.match(failedWorker.detail, /owner session-worker（无单独指派时间戳，以任务 updatedAt 近似）/);
    assert.equal(failedWorker.at, readProjectsFile(h).tasks[failedId].updatedAt);

    // ② sent：任务上的最近一次 dispatch（store 直写，理由同上——成功派发需要 followup）
    const sentTask = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "派发成功" });
    const sentId = sentTask.body.data.task.taskId;
    let store = readProjectsFile(h);
    store.tasks[sentId].ownerSessionId = "session-worker";
    store.tasks[sentId].status = "in_progress";
    store.tasks[sentId].dispatch = { status: "sent", messageId: "msg-sent-1" };
    writeProjectsFile(h, store);
    const sentTimeline = await h.call("GET", `/agent-whales/api/tasks/${sentId}/timeline?projectId=${projectId}`);
    assert.match(stepOf(sentTimeline.body, "worker").detail, /派发 sent/);

    // ③ unknown：任务上没挂 dispatch，从 dispatchFacts 里取该 taskId 的最新一条
    const unknownTask = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "派发超时" });
    const unknownId = unknownTask.body.data.task.taskId;
    const factAt = Date.now() - 1000;
    store = readProjectsFile(h);
    store.tasks[unknownId].ownerSessionId = "session-worker";
    store.tasks[unknownId].status = "in_progress";
    store.dispatchFacts = [{ taskId: unknownId, revision: 1, dispatch: { status: "unknown", reason: "dispatch-timeout" }, at: factAt, currentRevision: 2 }];
    writeProjectsFile(h, store);
    const unknownTimeline = await h.call("GET", `/agent-whales/api/tasks/${unknownId}/timeline?projectId=${projectId}`);
    const unknownWorker = stepOf(unknownTimeline.body, "worker");
    assert.match(unknownWorker.detail, new RegExp("派发 unknown · " + factAt + "（dispatch-timeout）"));
  });

  test("report 四态：done=回流关闭，draft/handed_back/human_action=active 且带 summary", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const statuses = ["done", "draft", "handed_back", "human_action"];
    const taskIds = [];
    for (const status of statuses) {
      const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "回流 " + status });
      const taskId = created.body.data.task.taskId;
      taskIds.push(taskId);
      const reported = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, {
        projectId, expectedRevision: 1, report: { status, summary: "这是 " + status + " 的说明", artifacts: [{ kind: "file", ref: "lib/index.js" }] }
      });
      assert.equal(reported.body.code, 200, JSON.stringify(reported.body));
    }
    for (let index = 0; index < statuses.length; index += 1) {
      const status = statuses[index];
      const timeline = await h.call("GET", `/agent-whales/api/tasks/${taskIds[index]}/timeline?projectId=${projectId}`);
      const report = stepOf(timeline.body, "report");
      assert.equal(report.state, status === "done" ? "done" : "active", status + " 的回流步状态");
      assert.match(report.detail, new RegExp("^" + status + " · rev 2 · bySessionId user · artifacts 1"));
      assert.ok(report.detail.includes("这是 " + status + " 的说明"), "summary 要进 detail");
      assert.equal(report.evidence, "rev 2");
      assert.equal(typeof report.at, "number", "回流有时间");
      // 明细里也要有一条 report
      const reportEntry = timeline.body.data.entries.find((entry) => entry.kind === "report");
      assert.ok(reportEntry, "report 必须进明细");
      assert.equal(reportEntry.by, "user");
      assert.match(reportEntry.text, /这是/);
    }
  });

  test("已完成：worker until=completedAt（无 report 也算执行结束）；worker 步计数来自会话日志", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "已关闭" });
    const taskId = created.body.data.task.taskId;
    await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-worker", expectedRevision: 1, requestId: "w2-assign-close" });
    const completedAt = Date.now() - 2000;
    const store = readProjectsFile(h);
    store.tasks[taskId].status = "completed";
    store.tasks[taskId].completedAt = completedAt;
    writeProjectsFile(h, store);
    // owner 会话活着且有工具调用：worker 步 detail 要带「跑命令 N 次 · 写文件 N 个」
    h.sessionLogs.set("session-worker", [
      { seq: 1, type: "tool/call", data: { id: "k1", name: "bash", arguments: "{}" } },
      { seq: 2, type: "tool/call", data: { id: "k2", name: "pwsh", arguments: "{}" } },
      { seq: 3, type: "tool/call", data: { id: "k3", name: "str-replace-editor", arguments: "{}" } }
    ]);

    const timeline = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}`);
    const worker = stepOf(timeline.body, "worker");
    assert.equal(worker.state, "done", "任务已关闭 → 执行结束");
    assert.equal(worker.until, completedAt, "until 是执行结束时间");
    assert.match(worker.detail, /跑命令 2 次 · 写文件 1 个 · 其它 0 次/);
    assert.equal(stepOf(timeline.body, "report").state, "pending", "没有 report 就是没回流");
  });
});

describe("W2 观测：entries 三处聚合（events / handoffs / report）", () => {
  test("三处聚合 + at 倒序 + 不相关事实被排除", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "明细任务" });
    const taskId = created.body.data.task.taskId;
    const now = Date.now();

    // ① events.json：一条相关（text 含 taskId）、一条不相关（别的任务）
    writeFileSync(join(h.dir, "events.json"), JSON.stringify({
      version: 1,
      noise: {},
      events: {
        "evt-mine": { eventId: "evt-mine", projectId, source: "plugin", kind: "task.command", text: "assign " + taskId, evidence: "req-mine", fingerprint: "task.command|mine", at: now - 3000, state: "pending", rules: [] },
        "evt-other": { eventId: "evt-other", projectId, source: "plugin", kind: "task.command", text: "assign ptask-other", evidence: "req-other", fingerprint: "task.command|other", at: now - 2500, state: "pending", rules: [] }
      }
    }), "utf8");
    // ② handoffs.json：一条 taskId 匹配、一条别的任务
    writeHandoffsFile(h, [
      { kind: "dispatch", from: "user", to: "session-worker", messageId: "msg-1", at: now - 2000, taskId, revision: 1, projectId },
      { kind: "dispatch", from: "user", to: "session-worker", messageId: "msg-2", at: now - 1500, taskId: "ptask-other", revision: 1, projectId }
    ]);
    // ③ report（at ≈ now，最新）
    const reported = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 1, report: { status: "done", summary: "干完了" } });
    assert.equal(reported.body.code, 200, JSON.stringify(reported.body));

    const timeline = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}`);
    const entries = timeline.body.data.entries;
    assert.deepEqual(entries.map((entry) => entry.kind), ["report", "dispatch", "task.command"], "三处聚合 + at 倒序");
    assert.equal(entries[1].by, "user", "handoff 明细带 from");
    assert.match(entries[1].text, /派发到 session-worker · msg-1 · revision 1/);
    assert.equal(entries[1].evidence, "msg-1");
    assert.equal(entries[2].evidence, "req-mine");
    assert.ok(entries.every((entry) => !String(entry.text).includes("ptask-other")), "别的任务的事实不能混进来");
  });

  test("limit：默认 50、硬上限 200、同一条记录记两遍只留一条", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "条数任务" });
    const taskId = created.body.data.task.taskId;
    const now = Date.now();
    // 210 条互不相同的发送记录 + 一对完全相同的重复记录
    const entries = [];
    for (let index = 0; index < 210; index += 1) {
      entries.push({ kind: "dispatch", from: "user", to: "session-worker", messageId: "msg-" + index, at: now - 100000 + index, taskId, revision: 1, projectId });
    }
    entries.push({ kind: "dispatch", from: "user", to: "session-worker", messageId: "msg-dup", at: now - 50000, taskId, revision: 1, projectId });
    entries.push({ kind: "dispatch", from: "user", to: "session-worker", messageId: "msg-dup", at: now - 50000, taskId, revision: 1, projectId });
    writeHandoffsFile(h, entries);

    const byDefault = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}`);
    assert.equal(byDefault.body.data.entries.length, 50, "默认 50 条");
    const capped = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}&limit=9999`);
    assert.equal(capped.body.data.entries.length, 200, "硬上限 200");
    const dupes = capped.body.data.entries.filter((entry) => entry.evidence === "msg-dup");
    assert.equal(dupes.length, 1, "完全相同的两条记录去重后只留一条");
    const single = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${projectId}&limit=1`);
    assert.equal(single.body.data.entries.length, 1, "limit=1 只给最新一条");
  });
});

describe("W2 观测：observations（Worker 侧最小可见性）", () => {
  test("owner 有当前工具：与 /activity 同一张表；结果事件后消失", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "观测任务" });
    const taskId = created.body.data.task.taskId;
    await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-worker", expectedRevision: 1, requestId: "w2-obs-assign" });

    // 执行台同源：/activity 与 observations 看到的是同一个当前工具
    h.listeners["tools/execute"]({ agent: { id: "session-worker" }, name: "bash", callId: "call-1" }, () => Promise.resolve("ok"));
    const activity = await h.call("GET", "/agent-whales/api/activity");
    assert.equal(activity.body.active["session-worker"].tool, "bash");
    const observed = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}`);
    assert.equal(observed.body.code, 200, JSON.stringify(observed.body));
    assert.equal(observed.body.data.sessionId, "session-worker");
    assert.equal(observed.body.data.current.tool, "bash");
    assert.ok(typeof observed.body.data.current.ageMs === "number" && observed.body.data.current.ageMs >= 0);

    // 工具结束：当前工具消失（与 /activity 一致）
    h.listeners["tools/result"]({ agent: { id: "session-worker" }, name: "bash", callId: "call-1" });
    const after = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}`);
    assert.equal(after.body.data.current, null);
  });

  test("无 owner：sessionId null + note；会话不在跑：tail 空 + note（绝不抛）", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);

    // 没指派
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "没人管" });
    const noOwner = await h.call("GET", `/agent-whales/api/tasks/${created.body.data.task.taskId}/observations?projectId=${projectId}`);
    assert.equal(noOwner.body.code, 200, JSON.stringify(noOwner.body));
    assert.equal(noOwner.body.data.sessionId, null);
    assert.equal(noOwner.body.data.current, null);
    assert.deepEqual(noOwner.body.data.tail, []);
    assert.match(noOwner.body.data.note, /未指派 owner/);
    assert.equal(noOwner.body.data.counts, undefined, "没有会话就没有 counts");

    // 指派给一个已归档会话（不在跑）：读不到日志 → 空 + note
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    const archived = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "归档执行器" });
    const archivedId = archived.body.data.task.taskId;
    const assigned = await h.call("POST", `/agent-whales/api/tasks/${archivedId}/commands`, { projectId, action: "assign", owner: "session-old", expectedRevision: 1, requestId: "w2-obs-archived" });
    assert.equal(assigned.body.code, 200, JSON.stringify(assigned.body));
    const offline = await h.call("GET", `/agent-whales/api/tasks/${archivedId}/observations?projectId=${projectId}`);
    assert.equal(offline.body.code, 200, JSON.stringify(offline.body));
    assert.equal(offline.body.data.sessionId, "session-old");
    assert.equal(offline.body.data.current, null);
    assert.deepEqual(offline.body.data.tail, []);
    assert.match(offline.body.data.note, /不在运行/);
  });

  test("tail：倒序 / 默认 20 / limit 封顶 100 / 两种日志形状 / counts 归类", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "日志任务" });
    const taskId = created.body.data.task.taskId;
    await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-worker", expectedRevision: 1, requestId: "w2-obs-log" });

    // 30 条 tool/call（seq 1..30，名字轮换）+ 1 条 assistant/message 内容块形状
    const names = ["bash", "pwsh", "str-replace-editor", "fs_write", "read"];
    const events = [];
    for (let index = 1; index <= 30; index += 1) {
      events.push({ seq: index, type: "tool/call", data: { id: "c" + index, name: names[index % names.length], arguments: JSON.stringify({ n: index }) } });
    }
    events.push({ seq: 31, type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "blk-1", name: "read", arguments: '{"path":"x"}' }] } } });
    // 同 id 的第二种形状：同一 callId 只留一条
    events.push({ seq: 32, type: "tool/call", data: { id: "blk-1", name: "read", arguments: "{}" } });
    h.sessionLogs.set("session-worker", events);

    const observed = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}`);
    const data = observed.body.data;
    assert.equal(data.tail.length, 20, "默认最近 20 条");
    assert.equal(data.tail[0].seq, 31, "倒序：最新在前");
    assert.equal(data.tail[0].tool, "read", "内容块形状也要能抽到");
    assert.equal(data.tail.at(-1).seq, 12, "取的是最近的一段");
    assert.equal(data.tail.filter((row) => row.seq === 32).length, 0, "同 callId 去重");
    // counts 数的是整份日志（31 条去重后）：bash/pwsh=命令，str-replace-editor/fs_write=文件，read=其它
    assert.deepEqual(data.counts, { commands: 12, files: 12, other: 7 });
    // 日志没有 at：不编时间键
    assert.equal("at" in data.tail[0], false, "事件没带时间就不编 at");

    const one = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}&limit=1`);
    assert.equal(one.body.data.tail.length, 1);
    assert.equal(one.body.data.tail[0].seq, 31);
    const capped = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}&limit=1000`);
    assert.equal(capped.body.data.tail.length, 31, "limit 封顶 100，实际只有 31 条");

    // 事件带了时间就透传
    h.sessionLogs.set("session-worker", [{ seq: 1, type: "tool/call", at: 1750000000000, data: { id: "t1", name: "bash", arguments: "{}" } }]);
    const withAt = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}`);
    assert.equal(withAt.body.data.tail[0].at, 1750000000000);
  });

  test("护栏：单条 ≤ 500 字（超了截断 + …），总量 60KB 从老的一侧砍", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "护栏任务" });
    const taskId = created.body.data.task.taskId;
    await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-worker", expectedRevision: 1, requestId: "w2-obs-guard" });

    // ① 单条 10 万字符参数：截断到 500 + 「…」
    h.sessionLogs.set("session-worker", [{ seq: 1, type: "tool/call", data: { id: "g1", name: "bash", arguments: "x".repeat(100000) } }]);
    const huge = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}`);
    assert.equal(huge.body.data.tail.length, 1, "至少给一条");
    assert.equal(huge.body.data.tail[0].args.length, 501, "500 字 + 省略号");
    assert.ok(huge.body.data.tail[0].args.endsWith("…"));

    // ② 30 条 × 4000 字 = 120KB > 60KB：只给最近的一部分，且最新的一定在
    const many = [];
    for (let index = 1; index <= 30; index += 1) {
      many.push({ seq: index, type: "tool/call", data: { id: "m" + index, name: "bash", arguments: "y".repeat(4000) } });
    }
    h.sessionLogs.set("session-worker", many);
    const budgeted = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations?projectId=${projectId}`);
    assert.ok(budgeted.body.data.tail.length < 30, "总量超预算必须砍，实际 " + budgeted.body.data.tail.length);
    assert.equal(budgeted.body.data.tail[0].seq, 30, "从老的一侧砍，最新一条必须在");
  });
});

describe("W2 观测：路由接线与边界", () => {
  test("方法校验：PUT/POST → 405 + allow: GET, HEAD（两个路由）", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "方法校验" });
    const taskId = created.body.data.task.taskId;
    for (const path of [`/agent-whales/api/tasks/${taskId}/timeline`, `/agent-whales/api/tasks/${taskId}/observations`]) {
      for (const method of ["PUT", "POST", "DELETE"]) {
        const rejected = await h.call(method, path, {});
        assert.equal(rejected.status, 405, method + " " + path + " 必须 405");
        assert.equal(rejected.headers.allow, "GET, HEAD", "allow 头必须只报读方法");
        assert.equal(rejected.body.code, 40000);
      }
      const head = await h.call("HEAD", path);
      assert.equal(head.status, 200, "HEAD 与 GET 同权（只读路由口径）");
    }
  });

  test("项目不存在 → 宽松回空 + note；坏 taskId → 40401；不带 projectId 跨项目找", async () => {
    const h = await w2Harness();
    const projectId = await createProject(h);
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "边界任务" });
    const taskId = created.body.data.task.taskId;

    // 项目不存在（页面轮询时项目被删）：不刷错误，回空 + note
    for (const path of ["timeline", "observations"]) {
      const lenient = await h.call("GET", `/agent-whales/api/tasks/${taskId}/${path}?projectId=proj-ghost`);
      assert.equal(lenient.body.code, 200, path + " 项目不存在必须宽松回空");
      assert.match(lenient.body.data.note, /项目不存在/);
      if (path === "timeline") {
        assert.deepEqual(lenient.body.data.steps, []);
        assert.deepEqual(lenient.body.data.entries, []);
      } else {
        assert.equal(lenient.body.data.sessionId, null);
        assert.equal(lenient.body.data.current, null);
        assert.deepEqual(lenient.body.data.tail, []);
      }
    }

    // 坏 taskId：项目存在 → 40401；不带 projectId 也 40401
    const ghostInProject = await h.call("GET", `/agent-whales/api/tasks/ptask-ghost/timeline?projectId=${projectId}`);
    assert.equal(ghostInProject.body.code, 40401);
    const ghostNoProject = await h.call("GET", "/agent-whales/api/tasks/ptask-ghost/timeline");
    assert.equal(ghostNoProject.body.code, 40401);
    const ghostObs = await h.call("GET", `/agent-whales/api/tasks/ptask-ghost/observations?projectId=${projectId}`);
    assert.equal(ghostObs.body.code, 40401);

    // 任务在 A 项目、查询带 B 项目 → 40401（taskId 全局唯一，带错项目就是找不到）
    const other = await h.call("POST", "/agent-whales/api/projects", { name: "别的项目", mainSessionId: "session-b" });
    const wrongProject = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline?projectId=${other.body.data.project.projectId}`);
    assert.equal(wrongProject.body.code, 40401);

    // 不带 projectId：跨全部项目按 id 找（taskId 全局唯一）
    const crossProject = await h.call("GET", `/agent-whales/api/tasks/${taskId}/timeline`);
    assert.equal(crossProject.body.code, 200, JSON.stringify(crossProject.body));
    assert.equal(crossProject.body.data.taskId, taskId);
    assert.equal(crossProject.body.data.projectId, projectId);
    const crossObs = await h.call("GET", `/agent-whales/api/tasks/${taskId}/observations`);
    assert.equal(crossObs.body.code, 200);
    assert.equal(crossObs.body.data.taskId, taskId);
  });

  test("纯函数：畸变输入不抛、输出仍是 lossless JSON", () => {
    const dirtyTask = {
      taskId: 42, projectId: null, subject: null, description: undefined,
      blockedBy: "not-an-array", ownerSessionId: 5, status: null,
      createdAt: "x", updatedAt: NaN, completedAt: Infinity,
      report: "bad", dispatch: 7, sourceProposal: { proposalId: "prop-1" }, worktree: {}, execRoot: []
    };
    const dirtySteps = host.timelineStepsOf({
      task: dirtyTask,
      tasks: { "ptask-x": { status: "completed", completedAt: "y", updatedAt: null } },
      submitEvent: { at: "x", text: null, eventId: null, source: 5 },
      proposalRecord: { confirmed: "bad", version: null },
      dispatchFact: { status: 5, at: "x", reason: null },
      toolCounts: { commands: "a", files: null, other: undefined }
    });
    assert.equal(dirtySteps.length, 6, "再脏也要给六步");
    for (const step of dirtySteps) assertLossless(step, "timelineStepsOf 畸变步");
    assert.equal(host.timelineStepsOf({ task: dirtyTask, tasks: {} }).length, 6, "缺字段也要给六步");

    const circular = { self: null };
    circular.self = circular;
    const dirtyEvents = [null, undefined, 42, "x", {}, { type: "tool/call" }, { type: "tool/call", data: { name: 5, arguments: circular } },
      { type: "tool/call", data: { tool: { name: "bash" }, arguments: { a: 1 } } },
      { type: "assistant/message", data: { message: { content: [null, 42, { type: "tool-call" }, { type: "tool-call", name: "read", arguments: 7 }] } } },
      { type: "assistant/message", data: null }];
    const rows = host.toolCallsOf(dirtyEvents);
    for (const row of rows) assertLossless(row, "toolCallsOf 畸变行");
    assert.equal(rows.length, 5, "三条 tool/call（含两条脏名）+ 内容块里两条 tool-call");
    assert.deepEqual(rows.map((row) => row.name), ["", "", "bash", "", "read"], "工具名逐个对上");
    for (const limit of [undefined, 0, -5, 1.9, NaN, "x", 1000]) {
      const tail = host.observationTailOf(rows, limit);
      assert.ok(Array.isArray(tail));
      for (const row of tail) assertLossless(row, "observationTailOf 畸变行");
    }
  });
});

describe("Q3 已核对（verify 命令）与 Q4 规划时提示", () => {
  test("只有主对话能核、只能核已报完工；核完写独立字段且不改状态", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "待核" });
    const taskId = created.body.data.task.taskId;

    // 没报完工就核 → 拒（40904 taskClosed：谈不上核）
    const tooEarly = await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "verify", expectedRevision: 1, requestId: "v-early" });
    assert.equal(tooEarly.body.code, 40904, JSON.stringify(tooEarly.body));

    // 报完工
    await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 1, report: { status: "done", summary: "干完了" }, bySessionId: "session-worker" });
    // 核（宿主把 caller 置成主对话）
    const verified = await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "verify", expectedRevision: 2, requestId: "v-1", note: "我看过" });
    assert.equal(verified.body.code, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.data.verified.by, "session-a", "核对人 = 项目主对话（harness 里主对话是 session-a）");
    assert.equal(verified.body.data.verified.note, "我看过");
    assert.ok(verified.body.data.verified.at > 0, "核对时间");
    // 状态没被并入：report 仍是 done（verify 只写独立字段，不动任务状态与 report）
    assert.equal(verified.body.data.task.report.status, "done");
    assert.equal(verified.body.data.task.report.summary, "干完了");

    // 过期 revision → 40902（与其它写命令同一套 CAS）
    const stale = await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "verify", expectedRevision: 1, requestId: "v-stale" });
    assert.equal(stale.body.code, 40902, JSON.stringify(stale.body));

    // action 白名单里有 verify
    const bad = await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "核一下", expectedRevision: 3, requestId: "v-bad" });
    assert.equal(bad.body.code, 40000, JSON.stringify(bad.body));
  });

  test("Q4：写入范围重叠且无先后顺序 → 提示补依赖；有顺序就不提示", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const tk = await h.token();
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });
    const make = async (subject, writeScopes, blockedBy) => {
      const created = await h.call("POST", "/agent-whales/api/tasks", Object.assign({ projectId, subject, writeScopes }, blockedBy === undefined ? {} : { blockedBy }));
      return created.body.data.task.taskId;
    };
    const assign = async (taskId, owner, requestId) => {
      const out = await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner, expectedRevision: 1, requestId });
      assert.equal(out.body.code, 200, JSON.stringify(out.body));
      return out.body.data.scopeOrderHint;
    };

    const docs = await make("A 改文档", ["docs/"]);
    const lib = await make("B 改 lib", ["lib/"]);

    // 1) 第一个有主的：没有对手，不该提示
    assert.equal(await assign(docs, "session-b", "q4-1"), undefined, "没有可重叠的对手，不该提示");
    // 2) 范围不重叠：不该提示
    assert.equal(await assign(lib, "session-worker", "q4-2"), undefined, "docs/ 与 lib/ 不重叠，不该提示");

    // 3) 重叠且有先后顺序（lib 阻塞 libIndex）→ 不是并发冲突，不提示
    const libIndex = await make("C 改 lib/index.js", ["lib/index.js"], [lib]);
    assert.equal(await assign(libIndex, "session-a", "q4-3"), undefined, "有依赖顺序的不是并发冲突（同步页 Q4 结论）");

    // 4) 重叠且无先后顺序 → 必须提示，并且指认对手
    const libOther = await make("D 改 lib/other.js", ["lib/other.js"]);
    const hint = await assign(libOther, "session-b", "q4-4");
    assert.ok(typeof hint === "string" && hint.indexOf("建议补一条依赖") >= 0, "重叠且无顺序必须提示");
    assert.ok(hint.indexOf(lib) >= 0, "提示要指认对手任务：" + hint);
  });
});

// ── 画布优先（PRD v2.2 九（续二））：画布 Composer 读主对话回复 ───────────────────
describe("画布优先 GET /agent-whales/api/sessions/:id/messages", () => {
  const userEvent = (seq, text) => ({ type: "user/message", seq, data: { content: [{ type: "text", text }], source: { kind: "user" } } });
  const assistantEvent = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });

  test("折叠成 user/assistant 行、按 limit 取尾部、正文封顶、seq 透出", async () => {
    const h = await m6Harness();
    const long = "长".repeat(4100);
    h.sessionLogs.set("session-a", [
      userEvent(1, "第一句"),
      assistantEvent(2, "收到"),
      { type: "tool/call", seq: 3, data: { name: "pwsh" } },
      userEvent(4, "给审批流做导入导出"),
      assistantEvent(5, long)
    ]);
    const res = await h.call("GET", "/agent-whales/api/sessions/session-a/messages?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.sessionId, "session-a");
    assert.equal(res.body.data.total, 4, "工具调用不算消息行");
    assert.equal(res.body.data.rows.length, 2);
    assert.deepEqual(res.body.data.rows[0], { role: "user", text: "给审批流做导入导出", seq: 4 });
    assert.equal(res.body.data.rows[1].role, "assistant");
    assert.equal(res.body.data.rows[1].text.length, 4001, "单条正文封顶 4000 字 + 省略号");
    assert.ok(res.body.data.rows[1].text.endsWith("…"));

    const all = await h.call("GET", "/agent-whales/api/sessions/session-a/messages");
    assert.equal(all.body.data.rows.length, 4, "默认 8 条以内全给");
    const capped = await h.call("GET", "/agent-whales/api/sessions/session-a/messages?limit=9999");
    assert.equal(capped.body.data.rows.length, 4, "limit 上限 40，不会越界");
  });

  test("读不到的会话回 200 + 404 业务码，不刷 500；非 GET 405；编码的 id 能解", async () => {
    const h = await m6Harness();
    const missing = await h.call("GET", "/agent-whales/api/sessions/session-nope/messages");
    assert.equal(missing.status, 200);
    assert.notEqual(missing.body.code, 200, "读不到就不能假装成功");
    const post = await h.call("POST", "/agent-whales/api/sessions/session-a/messages", {});
    assert.equal(post.status, 405);
    assert.equal(post.headers["allow"], "GET, HEAD");
    h.sessionLogs.set("session-b", [userEvent(1, "hi")]);
    const encoded = await h.call("GET", "/agent-whales/api/sessions/" + encodeURIComponent("session-b") + "/messages");
    assert.equal(encoded.body.data.rows.length, 1);
  });

  test("目录路由不被子路径吞掉：/sessions 仍回目录", async () => {
    const h = await m6Harness();
    const list = await h.call("GET", "/agent-whales/api/sessions");
    assert.equal(list.body.data.source, "host");
  });

  // 真机反馈 2026-11-18：主对话用 ask_user_question 提问，画布 Composer 上看不到问题
  test("还没答的 ask_user_question 随回复一起下发；答完 / 迟到回复后消失；超时 pending 仍算没答", async () => {
    const h = await m6Harness();
    const ask = (seq, callId, questions) => ({ type: "tool/call", seq, data: { name: "ask_user_question", callId, arguments: JSON.stringify({ questions }) } });
    const result = (seq, callId, text) => ({ type: "tool/result", seq, data: { message: { toolCallId: callId, content: [{ type: "text", text }] } } });
    const questions = [{ id: "page", header: "确认", question: "画哪个页面？", options: [{ label: "表单导入弹窗", description: "推荐" }, { label: "列表页" }, { label: "" }], multi_select: true }, { id: "bad" }];
    h.sessionLogs.set("session-b", [userEvent(1, "绘制一个页面原型"), assistantEvent(2, "需要你确认一下"), ask(3, "call-1", questions)]);
    const open = await h.call("GET", "/agent-whales/api/sessions/session-b/messages");
    assert.equal(open.body.code, 200, JSON.stringify(open.body));
    assert.deepEqual(open.body.data.question, {
      callId: "call-1",
      questions: [{ id: "page", header: "确认", question: "画哪个页面？", options: [{ label: "表单导入弹窗", description: "推荐" }, { label: "列表页" }], multiSelect: true }]
    }, "坏选项 / 没有 question 的项要丢掉");
    assert.equal(open.body.data.total, 2, "提问不算消息行");

    h.sessionLogs.set("session-b", [ask(3, "call-1", questions), result(4, "call-1", "{\"answers\":[]}")]);
    const answered = await h.call("GET", "/agent-whales/api/sessions/session-b/messages");
    assert.equal(answered.body.data.question, undefined, "答完就不再显示");

    const timedOut = [ask(3, "call-2", questions), result(4, "call-2", "No answer batch arrived before the timeout. This is pending, not a skipped answer.")];
    h.sessionLogs.set("session-b", timedOut);
    assert.equal((await h.call("GET", "/agent-whales/api/sessions/session-b/messages")).body.data.question.callId, "call-2", "计时超时后问题仍可回答");
    h.sessionLogs.set("session-b", timedOut.concat([{ type: "user/message", seq: 5, data: { content: [{ type: "text", text: "answer_to_pending_question call-2 …" }] } }]));
    assert.equal((await h.call("GET", "/agent-whales/api/sessions/session-b/messages")).body.data.question, undefined, "迟到回复引用了 callId 就算答了");
  });
});

// ── v2.2 波次 2：子会话自动入项目 + §51.4 组建方案 ─────────────────────────────
describe("v2.2 波次 2：组建方案（提案带对话与关联）", () => {
  test("校验：main 保留、与任务 key 撞名、未知关联端、超过 6 个都拒；合法的原样带出", () => {
    const base = { leadSessionId: "s", items: [{ key: "T1", title: "任务" }] };
    assert.match(host.validateProposal({ ...base, conversations: [{ key: "main", title: "x" }] }).error, /reserved/);
    assert.match(host.validateProposal({ ...base, conversations: [{ key: "T1", title: "x" }] }).error, /duplicate key/);
    assert.match(host.validateProposal({ ...base, conversations: [{ key: "be", title: "后端" }], links: [{ a: "be", b: "fe" }] }).error, /unknown link end/);
    assert.match(host.validateProposal({ ...base, conversations: Array.from({ length: 7 }, (_, i) => ({ key: "c" + i, title: "c" })) }).error, /exceeds 6/);
    assert.match(host.validateProposal({ ...base, links: [{ a: "main", b: "main" }] }).error, /two different ends/);
    const ok = host.validateProposal({ ...base, conversations: [{ key: "be", title: "后端", duty: "写接口", agentPreset: "dsh-agent-whales-worker" }, { key: "fe", title: "前端" }], links: [{ a: "be", b: "fe" }] });
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.conversations, [{ key: "be", title: "后端", duty: "写接口", agentPreset: "dsh-agent-whales-worker" }, { key: "fe", title: "前端", duty: "" }]);
    assert.deepEqual(ok.links, [{ a: "be", b: "fe" }]);
    assert.deepEqual(host.validateProposal(base).conversations, [], "老提案不带这两类条目照常通过");
  });

  test("确认：逐个建对话（主对话所在工作区 + preset）→ 入项目、连主对话、写职责简报 → 建任务并按对话 key 指派，不派发", async () => {
    const createdRequests = [];
    let seq = 0;
    const h = await m6Harness({
      sessionController: { create: async (request) => { createdRequests.push(request); seq += 1; return { sessionId: "session-new-" + seq }; } },
      workspaceRegistry: { list: () => [{ id: "ws-main", sessionIds: ["session-a"] }] }
    });
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const projectId = await createProject(h);
    const proposal = await h.tools.whales_propose_tasks.execute({
      projectId,
      conversations: [{ key: "be", title: "后端", duty: "写导入导出接口", agentPreset: "dsh-agent-whales-worker" }, { key: "fe", title: "前端" }],
      links: [{ a: "be", b: "fe" }],
      items: [{ key: "T1", title: "导入接口", suggestedOwner: "be" }, { key: "T2", title: "导入弹窗", suggestedOwner: "fe", blockedByKeys: ["T1"] }, { key: "T3", title: "验收" }]
    }, { agent: { id: "session-a" } });
    const stored = JSON.parse(readFileSync(join(h.dir, "proposals.json"), "utf8"))["session-a"];
    assert.equal(host.proposalView(stored).conversations.length, 2, "确认前就能看到将新建几个对话");
    const viaRoute = await h.call("GET", "/agent-whales/api/proposals?leadSessionId=session-a");
    assert.equal(viaRoute.body.code, 200, "项目提案不依赖宿主团队服务：" + JSON.stringify(viaRoute.body));
    assert.equal(viaRoute.body.data.proposal.conversations.length, 2);

    const confirmed = await h.call("POST", `/agent-whales/api/proposals/${proposal.proposalId}/confirm`, { leadSessionId: "session-a", version: proposal.version, requestId: "team-1" });
    assert.equal(confirmed.body.code, 200, JSON.stringify(confirmed.body));
    assert.deepEqual(createdRequests, [{ workspaceId: "ws-main", agentPreset: "dsh-agent-whales-worker" }, { workspaceId: "ws-main" }]);
    assert.deepEqual(confirmed.body.data.conversations.map((row) => row.sessionId), ["session-new-1", "session-new-2"]);
    assert.equal(confirmed.body.data.failed, undefined, JSON.stringify(confirmed.body.data.failed));
    const owners = Object.fromEntries(confirmed.body.data.created.map((row) => [row.key, row.ownerSessionId]));
    assert.deepEqual(owners, { T1: "session-new-1", T2: "session-new-2", T3: undefined });

    const project = (await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
    const added = project.members.filter((member) => member.addedBy === "proposal").map((member) => [member.sessionId, member.title]);
    assert.deepEqual(added, [["session-new-1", "后端"], ["session-new-2", "前端"]]);
    const pairs = project.links.map((link) => [link.a, link.b].sort().join("~")).sort();
    assert.deepEqual(pairs, ["session-a~session-new-1", "session-a~session-new-2", "session-new-1~session-new-2"], "新对话自动连主对话 + 提案里的额外互发线");
    const brief = await h.call("GET", "/agent-whales/api/briefs/session-new-1");
    assert.equal(brief.body.data.brief.duty, "写导入导出接口", "职责写进对话简报（人代写）");
    const tasks = (await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`)).body.data.tasks;
    const t1 = tasks.find((task) => task.subject === "导入接口");
    assert.equal(t1.ownerSessionId, "session-new-1");
    assert.equal(t1.status, "pending", "确认不等于开工：只指派不派发");

    const again = await h.call("POST", `/agent-whales/api/proposals/${proposal.proposalId}/confirm`, { leadSessionId: "session-a", version: proposal.version, requestId: "team-2" });
    assert.equal(again.body.data.already, true);
    assert.equal(createdRequests.length, 2, "同版本再确认不会重复建对话");
  });

  test("建对话失败逐项记录，可同版本重试补建（已建的不重复）", async () => {
    let fail = true;
    let seq = 0;
    const h = await m6Harness({
      sessionController: { create: async () => { if (fail) throw new Error("model not configured"); seq += 1; return { sessionId: "session-late-" + seq }; } }
    });
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const projectId = await createProject(h);
    const proposal = await h.tools.whales_propose_tasks.execute({
      projectId, conversations: [{ key: "qa", title: "测试" }], items: [{ key: "T1", title: "回归", suggestedOwner: "qa" }]
    }, { agent: { id: "session-a" } });
    const first = await h.call("POST", `/agent-whales/api/proposals/${proposal.proposalId}/confirm`, { leadSessionId: "session-a", version: proposal.version, requestId: "f-1" });
    assert.equal(first.body.code, 200);
    assert.deepEqual(first.body.data.failed.map((row) => [row.key, row.status]), [["conversation:qa", "failed"]]);
    assert.equal(first.body.data.created[0].ownerSessionId, undefined, "对话没建成，任务照建但不指派");
    fail = false;
    const retry = await h.call("POST", `/agent-whales/api/proposals/${proposal.proposalId}/confirm`, { leadSessionId: "session-a", version: proposal.version, requestId: "f-2" });
    assert.equal(retry.body.data.retried, true);
    assert.deepEqual(retry.body.data.conversations.map((row) => row.sessionId), ["session-late-1"]);
    assert.equal(retry.body.data.created.length, 1, "任务不重复建");
  });

  test("不带 projectId 的提案不能带对话 / 关联", async () => {
    const h = await m6Harness();
    await assert.rejects(
      h.tools.whales_propose_tasks.execute({ conversations: [{ key: "x", title: "x" }], items: [{ key: "T1", title: "t" }] }, { agent: { id: "session-a" } }),
      /need a projectId/
    );
  });
});

describe("v2.2 波次 2：子会话自动入项目", () => {
  test("父会话在项目里 → 子会话自动入项目、连父会话、标 auto；手动移出后不再拉回；手动加回则解除", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const adopted = await h.call("POST", `/agent-whales/api/projects/${projectId}/adopt`, {});
    assert.equal(adopted.body.code, 200, JSON.stringify(adopted.body));
    assert.deepEqual(adopted.body.data.adopted, [{ projectId, sessionId: "session-worker", parentSessionId: "session-a" }]);
    let project = (await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
    const worker = project.members.find((member) => member.sessionId === "session-worker");
    assert.equal(worker.addedBy, "auto");
    assert.equal(worker.parentSessionId, "session-a");
    assert.ok(project.links.some((link) => [link.a, link.b].sort().join("~") === "session-a~session-worker"), "自动连父会话");

    const again = await h.call("POST", `/agent-whales/api/projects/${projectId}/adopt`, {});
    assert.deepEqual(again.body.data.adopted, [], "幂等");

    await h.call("DELETE", `/agent-whales/api/projects/${projectId}/members/session-worker`);
    project = (await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
    assert.deepEqual(project.dismissed, ["session-worker"]);
    const after = await h.call("POST", `/agent-whales/api/projects/${projectId}/adopt`, {});
    assert.deepEqual(after.body.data.adopted, [], "用户移出过的不再拉回");

    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-worker" });
    project = (await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
    assert.deepEqual(project.dismissed, [], "手动加回即解除");
  });

  test("adopt：缺 token 403、非 POST 405、项目不存在回业务码", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const noToken = await h.raw("POST", `/agent-whales/api/projects/${projectId}/adopt`, {}, {});
    assert.equal(noToken.status, 403);
    const get = await h.call("GET", `/agent-whales/api/projects/${projectId}/adopt`);
    assert.equal(get.status, 405);
    const missing = await h.call("POST", "/agent-whales/api/projects/nope/adopt", {});
    assert.notEqual(missing.body.code, 200);
  });

  test("tools/result：spawn_teammate 结束后自动收编；无关工具不触发", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const listener = h.listeners["tools/result"];
    assert.equal(typeof listener, "function");
    listener({ name: "pwsh", agent: { id: "session-a" } }, {});
    await new Promise((resolve) => setTimeout(resolve, 450));
    let project = (await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
    assert.equal(project.members.some((member) => member.sessionId === "session-worker"), false, "无关工具不碰 store");
    listener({ name: "spawn_teammate", agent: { id: "session-a" } }, {});
    await new Promise((resolve) => setTimeout(resolve, 450));
    project = (await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
    assert.equal(project.members.some((member) => member.sessionId === "session-worker" && member.addedBy === "auto"), true);
  });
});

// ── v2.2 波次 3：画布元素表 + 依赖线落库 ───────────────────────────────────────
describe("v2.2 波次 3：画布元素表", () => {
  test("元素增删改走同一个 rev（CAS）；PUT 位置表不清空元素；人改过的 agent 元素锁定", async () => {
    const h = await m6Harness();
    await h.token();
    const projectId = await createProject(h);
    const empty = await h.call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
    assert.deepEqual(empty.body.data.elements, []);
    const rev0 = empty.body.data.rev;

    const added = await h.call("POST", "/agent-whales/api/canvas/elements", {
      projectId, expectedRevision: rev0,
      upsert: [
        { id: "n1", kind: "note", x: 10, y: 20, data: { text: "便签" } },
        { id: "f1", kind: "flow", data: { shape: "step", text: "校验表头" } },
        { id: "e1", kind: "edge", data: { source: "n1", target: "f1" } },
        { id: "bad", kind: "spaceship" }
      ]
    });
    assert.equal(added.body.code, 200, JSON.stringify(added.body));
    assert.equal(added.body.data.rev, rev0 + 1);
    assert.deepEqual(added.body.data.rejected.map((row) => row.id), ["bad"]);
    const f1 = added.body.data.elements.find((el) => el.id === "f1");
    assert.equal(f1.x, null, "省略坐标 = null，交给客户端自动布局");
    assert.equal(f1.userEdited, true, "人建的元素就是人的");

    const stale = await h.call("POST", "/agent-whales/api/canvas/elements", { projectId, expectedRevision: rev0, upsert: [{ id: "n2", kind: "note" }] });
    assert.equal(stale.body.code, 40902, "过期 rev 不覆盖");

    const moved = await h.call("PUT", `/agent-whales/api/canvas?projectId=${projectId}`, { expectedRevision: rev0 + 1, nodes: { "session-a": { x: 1, y: 2 } } });
    assert.equal(moved.body.code, 200);
    const after = await h.call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
    assert.equal(after.body.data.elements.length, 3, "拖派生节点不能清空元素表");

    // agent 写：人改过的跳过并点名；agent 自己的可改
    const agentWrite = await host.applyCanvasElements(projectId, { expectedRevision: after.body.data.rev, by: "agent", sessionId: "session-a", upsert: [
      { id: "f1", kind: "flow", data: { text: "被 agent 覆盖" } },
      { id: "f2", kind: "flow", data: { text: "agent 新画的" }, provenance: { sourceMessageIds: ["msg-1"] } }
    ] });
    assert.deepEqual(agentWrite.locked, ["f1"]);
    const f2 = agentWrite.elements.find((el) => el.id === "f2");
    assert.equal(f2.provenance.by, "agent");
    assert.equal(f2.provenance.sessionId, "session-a");
    assert.deepEqual(f2.provenance.sourceMessageIds, ["msg-1"]);
    assert.equal(f2.userEdited, false);

    // 删除元素顺带删挂在上面的创作连线
    const removed = await h.call("POST", "/agent-whales/api/canvas/elements", { projectId, expectedRevision: agentWrite.rev, remove: ["n1"] });
    assert.deepEqual(removed.body.data.elements.map((el) => el.id).sort(), ["f1", "f2"]);
  });

  test("元素写入：缺 token 403、非 POST 405、缺 rev 拒绝、edge 缺端点拒绝", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    const noToken = await h.raw("POST", "/agent-whales/api/canvas/elements", {}, { projectId, expectedRevision: 0, upsert: [] });
    assert.equal(noToken.status, 403);
    const get = await h.call("GET", "/agent-whales/api/canvas/elements");
    assert.equal(get.status, 405);
    const noRev = await h.call("POST", "/agent-whales/api/canvas/elements", { projectId });
    assert.equal(noRev.body.code, 40001);
    assert.match(host.cleanCanvasElement({ id: "e", kind: "edge", data: { source: "a" } }).error, /data.target/);
    assert.match(host.cleanCanvasElement({ id: "big", kind: "note", data: { text: "x".repeat(17000) } }).error, /16KB/);
  });
});

describe("v2.2 波次 3：依赖线（实线）落库为 blockedBy", () => {
  async function setup() {
    const h = await m6Harness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    const make = async (subject, owner) => {
      const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject });
      const taskId = created.body.data.task.taskId;
      await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner, expectedRevision: 1, requestId: "a-" + taskId });
      return taskId;
    };
    return { h, projectId, make };
  }

  test("A→B：B 的未完成任务都等 A 的未完成任务；再画一次幂等；删线去掉；反向画成环整次拒绝", async () => {
    const { h, projectId, make } = await setup();
    const a1 = await make("后端接口", "session-a");
    const b1 = await make("前端弹窗", "session-b");
    const b2 = await make("前端校验", "session-b");
    const add = await h.call("POST", `/agent-whales/api/projects/${projectId}/dependencies`, { from: "session-a", to: "session-b", action: "add" });
    assert.equal(add.body.code, 200, JSON.stringify(add.body));
    assert.deepEqual(add.body.data.changed.map((row) => [row.taskId, row.blockedBy]).sort(), [[b1, [a1]], [b2, [a1]]].sort());
    const again = await h.call("POST", `/agent-whales/api/projects/${projectId}/dependencies`, { from: "session-a", to: "session-b" });
    assert.deepEqual(again.body.data.changed, [], "幂等");
    const cycle = await h.call("POST", `/agent-whales/api/projects/${projectId}/dependencies`, { from: "session-b", to: "session-a" });
    assert.equal(cycle.body.code, 40705, "反向会成环，整次拒绝");
    const tasks = (await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`)).body.data.tasks;
    assert.deepEqual(tasks.find((task) => task.taskId === a1).blockedBy, [], "成环被拒时不能半写");
    const remove = await h.call("POST", `/agent-whales/api/projects/${projectId}/dependencies`, { from: "session-a", to: "session-b", action: "remove" });
    assert.equal(remove.body.data.changed.length, 2);
    const cleared = (await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`)).body.data.tasks;
    assert.deepEqual(cleared.find((task) => task.taskId === b1).blockedBy, []);
  });

  test("没有未完成任务的一端：拒绝并说明要先派任务；非成员 / 自连 / 缺 token 都拒", async () => {
    const { h, projectId, make } = await setup();
    await make("前端弹窗", "session-b");
    const none = await h.call("POST", `/agent-whales/api/projects/${projectId}/dependencies`, { from: "session-a", to: "session-b" });
    assert.notEqual(none.body.code, 200);
    assert.match(none.body.msg, /先给它们派任务/);
    const stranger = await h.call("POST", `/agent-whales/api/projects/${projectId}/dependencies`, { from: "session-a", to: "session-old" });
    assert.equal(stranger.body.code, 40703);
    const self = await h.call("POST", `/agent-whales/api/projects/${projectId}/dependencies`, { from: "session-a", to: "session-a" });
    assert.equal(self.status, 400);
    const noToken = await h.raw("POST", `/agent-whales/api/projects/${projectId}/dependencies`, {}, { from: "session-a", to: "session-b" });
    assert.equal(noToken.status, 403);
  });
});

// ── v2.2 波次 4：文件 / 外部引用节点 ───────────────────────────────────────────
describe("v2.2 波次 4：文件 / 外部引用", () => {
  const call = (seq, name, args) => ({ type: "tool/call", seq, time: 1000 + seq, data: { name, arguments: JSON.stringify(args) } });
  const user = (seq, text) => ({ type: "user/message", seq, time: 1000 + seq, data: { content: [{ type: "text", text }], source: { kind: "user" } } });

  test("referencesFromEvents：读写分类、路径归一去重、@路径、链接分 notion/feishu/web", () => {
    const refs = host.referencesFromEvents([
      call(1, "read", { file_path: "D:\\work\\a.go" }),
      call(2, "edit", { file_path: "d:/work/a.go" }),
      call(3, "write", { file_path: "D:/work/b.tsx" }),
      call(4, "grep", { pattern: "x", path: "D:/work/src/" }),
      call(5, "web_fetch", { url: "https://example.com/doc" }),
      call(6, "mcp__pencil__execute", { uri: "file:///D:/design/a.pen" }),
      call(7, "pwsh", { command: "Get-Content x" }),
      user(8, "看下 @\"D:\\需求\\导入 导出.md\" 和 https://app.notion.com/p/abc ，还有 https://xxx.feishu.cn/docx/123。"),
      { type: "user/message", seq: 9, data: { content: [{ type: "text", text: "https://agent.example/relay" }], source: { kind: "agent-message" } } },
      { type: "tool/call", seq: 10, data: { name: "read", arguments: "{坏 json" } }
    ]);
    const files = refs.files;
    assert.deepEqual(Object.keys(files).sort(), ["d:/design/a.pen", "d:/work/a.go", "d:/work/b.tsx", "d:/work/src", "d:/需求/导入 导出.md"]);
    assert.equal(files["d:/work/a.go"].read, 1);
    assert.equal(files["d:/work/a.go"].write, 1, "大小写 / 分隔符不同的同一文件合并");
    assert.equal(files["d:/work/b.tsx"].write, 1);
    assert.equal(files["d:/需求/导入 导出.md"].ref, 1, "@\"带空格的路径\" 记为引用");
    assert.deepEqual(Object.values(refs.links).map((row) => [row.url, row.kind]).sort(), [
      ["https://app.notion.com/p/abc", "notion"],
      ["https://example.com/doc", "web"],
      ["https://xxx.feishu.cn/docx/123", "feishu"]
    ], "中文标点不吞进链接；agent 中继消息里的链接不算用户引用");
    assert.deepEqual(host.referencesFromEvents(undefined), { files: {}, links: {} });
  });

  test("GET /projects/:id/references：成员会话合并 + report 产物记为改过；只读不要 token", async () => {
    const h = await m6Harness();
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
    h.sessionLogs.set("session-a", [call(1, "read", { file_path: "D:/repo/spec.md" }), user(2, "参考 https://app.notion.com/p/prd")]);
    h.sessionLogs.set("session-b", [call(1, "write", { file_path: "D:/repo/spec.md" }), call(2, "edit", { file_path: "D:/repo/ui.tsx" })]);
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "交付" });
    const taskId = created.body.data.task.taskId;
    await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "r-assign" });
    const reported = await h.call("PUT", `/agent-whales/api/tasks/${taskId}/report`, { projectId, expectedRevision: 2, report: { status: "done", summary: "ok", artifacts: [{ kind: "file", ref: "D:/repo/out.zip" }] } });
    assert.equal(reported.body.code, 200, JSON.stringify(reported.body));
    const res = await h.raw("GET", `/agent-whales/api/projects/${projectId}/references`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
    const byKey = Object.fromEntries(res.body.data.files.map((file) => [file.key, file]));
    assert.deepEqual(Object.keys(byKey["d:/repo/spec.md"].sessions).sort(), ["session-a", "session-b"]);
    assert.equal(byKey["d:/repo/spec.md"].sessions["session-a"].read, 1);
    assert.equal(byKey["d:/repo/spec.md"].sessions["session-b"].write, 1);
    assert.equal(byKey["d:/repo/ui.tsx"].sessions["session-b"].write, 1);
    assert.ok(byKey["d:/repo/out.zip"], "report 产物要成为文件节点：" + Object.keys(byKey).join(","));
    assert.equal(byKey["d:/repo/out.zip"].sessions["session-b"].write, 1, "report 产物记为 owner 改过");
    assert.deepEqual(res.body.data.links.map((link) => [link.url, link.kind, link.sessions]), [["https://app.notion.com/p/prd", "notion", ["session-a"]]]);
    const post = await h.call("POST", `/agent-whales/api/projects/${projectId}/references`, {});
    assert.equal(post.status, 405);
  });
});

// ── v2.2 波次 5：流程图工具 ───────────────────────────────────────────────────
describe("v2.2 波次 5：whales_flow_read / whales_flow_draw", () => {
  const user = (seq, text) => ({ type: "user/message", seq, data: { content: [{ type: "text", text }], source: { kind: "user" } } });
  const assistant = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
  const as = { agent: { id: "session-a" } };
  async function setup() {
    const h = await m6Harness();
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const projectId = await createProject(h);
    h.sessionLogs.set("session-a", [
      user(1, "导入要先校验表头"),
      assistant(2, "好，表头不对就给映射建议"),
      user(3, "重复单据跳过")
    ]);
    return { h, projectId };
  }
  const draw = (h, args) => h.tools.whales_flow_draw.execute(args, as);
  const flow = {
    title: "表单导入",
    nodes: [
      { key: "s", shape: "start", text: "上传文件", sourceMessageIds: ["m1"] },
      { key: "chk", shape: "decision", text: "表头匹配？", sourceMessageIds: ["m1", "m2"] },
      { key: "map", shape: "step", text: "给映射建议", sourceMessageIds: ["m2"] },
      { key: "ghost", shape: "step", text: "编造的步骤", sourceMessageIds: ["m99"] },
      { key: "dup", shape: "step", text: "跳过重复", sourceMessageIds: [] }
    ],
    edges: [{ from: "s", to: "chk" }, { from: "chk", to: "map", label: "否" }, { from: "chk", to: "ghost", label: "是" }]
  };

  test("flow_read：列出可引用消息编号；非项目会话只读不建项目（flows 空 + 提示）", async () => {
    const { h } = await setup();
    const read = await h.tools.whales_flow_read.execute({}, as);
    assert.deepEqual(read.messages.map((row) => row.ref), ["m1", "m2", "m3"]);
    assert.deepEqual(read.flows, []);
    const before = (await h.call("GET", "/agent-whales/api/projects")).body.data.projects.length;
    const outside = await h.tools.whales_flow_read.execute({}, { agent: { id: "session-old" } });
    assert.equal(outside.projectId, null);
    assert.deepEqual(outside.flows, []);
    assert.match(outside.note, /自动/);
    assert.equal((await h.call("GET", "/agent-whales/api/projects")).body.data.projects.length, before, "read 不能建项目");
  });

  test("对话内直接激活：不在项目里的对话首次画图就地建项目（主对话 = 自己，名字取会话标题）", async () => {
    const h = await m6Harness();
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const asB = { agent: { id: "session-b" } };
    h.sessionLogs.set("session-b", [user(1, "导入要先校验表头"), assistant(2, "好，表头不对就给映射建议")]);
    const thin = await h.tools.whales_flow_draw.execute({ title: "x", nodes: [{ key: "a", shape: "step", text: "一步", sourceMessageIds: ["m1"] }] }, asB);
    assert.equal(thin.drawn, false);
    assert.deepEqual((await h.call("GET", "/agent-whales/api/projects")).body.data.projects, [], "画不出来的调用不建项目");
    const result = await h.tools.whales_flow_draw.execute(flow, asB);
    assert.equal(result.drawn, true, JSON.stringify(result));
    assert.equal(result.projectCreated, true);
    assert.equal(result.projectName, "组员会话");
    assert.match(result.projectNote, /自动建了项目「组员会话」/);
    const projects = (await h.call("GET", "/agent-whales/api/projects")).body.data.projects;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].mainSessionId, "session-b");
    assert.equal(projects[0].origin, "conversation");
    const canvas = await h.call("GET", `/agent-whales/api/canvas?projectId=${projects[0].projectId}`);
    assert.ok(canvas.body.data.elements.find((el) => el.id === "flow:main"), "图落在新项目的画布上");
    // 第二次：已经在项目里，不再新建
    const proto = await h.tools.whales_prototype_draw.execute({ title: "导入弹窗", sourceMessageIds: ["m1"], puck: { content: [{ type: "Heading", props: { text: "导入" } }] } }, asB);
    assert.equal(proto.drawn, true, JSON.stringify(proto));
    assert.equal(proto.projectCreated, false);
    assert.equal(proto.projectId, projects[0].projectId);
    assert.equal((await h.call("GET", "/agent-whales/api/projects")).body.data.projects.length, 1);
  });

  test("对话内直接激活：子会话画图时以根会话建项目并把父链登记进去；父已在项目 → 并入；被移出过 → 不拉回", async () => {
    const h = await m6Harness();
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const asWorker = { agent: { id: "session-worker" } };
    h.sessionLogs.set("session-worker", [user(1, "导入要先校验表头"), assistant(2, "好，表头不对就给映射建议")]);
    const created = await h.tools.whales_flow_draw.execute(flow, asWorker);
    assert.equal(created.projectCreated, true, JSON.stringify(created));
    let project = (await h.call("GET", "/agent-whales/api/projects")).body.data.projects[0];
    assert.equal(project.mainSessionId, "session-a", "根会话当主对话，不让子代理当主");
    assert.equal(project.name, "主线会话");
    assert.ok(project.members.some((m) => m.sessionId === "session-worker" && m.parentSessionId === "session-a"));
    assert.ok(project.links.some((link) => [link.a, link.b].sort().join("~") === "session-a~session-worker"));

    const h2 = await m6Harness();
    host.setEventsStorePathForTests(join(h2.dir, "events.json"));
    const projectId = await createProject(h2);
    h2.sessionLogs.set("session-worker", [user(1, "导入要先校验表头"), assistant(2, "好，表头不对就给映射建议")]);
    const joined = await h2.tools.whales_flow_draw.execute(flow, asWorker);
    assert.equal(joined.projectCreated, false);
    assert.equal(joined.projectJoined, true);
    assert.equal(joined.projectId, projectId);
    // 用户把子会话移出 → 再画不拉回、也不另建
    await h2.call("DELETE", `/agent-whales/api/projects/${projectId}/members/session-worker`);
    project = (await h2.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project;
    assert.deepEqual(project.dismissed, ["session-worker"]);
    h2.sessionLogs.set("session-worker", h2.sessionLogs.get("session-worker").concat([user(3, "a"), user(4, "b")]));
    await assert.rejects(h2.tools.whales_flow_draw.execute(flow, asWorker), /移出过/);
    assert.equal((await h2.call("GET", "/agent-whales/api/projects")).body.data.projects.length, 1);
  });

  test("flow_draw：没证据的节点丢掉（含编造的 m99），边跟着丢；直接落画布、带 agent 来源与消息证据", async () => {
    const { h, projectId } = await setup();
    const result = await draw(h, flow);
    assert.equal(result.drawn, true, JSON.stringify(result));
    assert.equal(result.nodes, 3);
    assert.equal(result.edges, 2, "指向被丢节点的边不画");
    assert.deepEqual(result.dropped.map((row) => row.key).sort(), ["dup", "ghost"]);
    const canvas = await h.call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
    const elements = canvas.body.data.elements;
    const group = elements.find((el) => el.id === "flow:main");
    assert.equal(group.kind, "group");
    assert.equal(group.data.title, "表单导入");
    const chk = elements.find((el) => el.id === "flow:main:chk");
    assert.equal(chk.data.shape, "decision");
    assert.equal(chk.provenance.by, "agent");
    assert.deepEqual(chk.provenance.sourceMessageIds, ["m1", "m2"]);
    assert.equal(chk.userEdited, false, "AI 生成、未被人改过");
    assert.equal(chk.x, null, "坐标留给画布自动布局");
    const edge = elements.find((el) => el.id === "flow:main:e:chk>map");
    assert.equal(edge.data.label, "否");
    assert.equal(edge.data.source, "flow:main:chk");
  });

  test("证据不足回「暂不足以生成流程图」；节流：用户没再说 2 句不重画；人改过的节点重画不覆盖", async () => {
    const { h, projectId } = await setup();
    const thin = await draw(h, { title: "x", nodes: [{ key: "a", shape: "step", text: "只有一步", sourceMessageIds: ["m1"] }] });
    assert.equal(thin.drawn, false);
    assert.equal(thin.reason, "暂不足以生成流程图");

    await draw(h, flow);
    // 同一份内容重画 → 不重画（这才是「太吵」该拦的情况）
    const throttled = await draw(h, flow);
    assert.equal(throttled.drawn, false);
    assert.match(throttled.reason, /完全一样|没有重画的必要/);

    // 用户反馈修：**内容变了就该画**，不再按「说了几句」卡住。
    // （真机场景：agent 一轮里先画主流程、再补一条分支，第二次曾被节流拦掉）
    const withBranch = await draw(h, {
      title: "表单导入",
      nodes: flow.nodes.concat([{ key: "manual", shape: "step", text: "人工复核", sourceMessageIds: ["m1"] }]),
      edges: flow.edges.concat([{ from: "map", to: "manual", label: "例外" }])
    });
    assert.equal(withBranch.drawn, true, "内容变了就必须画，不能被「用户没说两句」拦住：" + JSON.stringify(withBranch));
    // flow.nodes 里有 5 个，但 ghost（m99 假证据）和 dup（空证据）会被丢掉 → 实际画出 3 个
    assert.equal(withBranch.nodes, 3 + 1, "画出的节点数 = 有效节点 + 新增的人工复核，实际 " + withBranch.nodes);

    // 人改了「映射建议」节点的文字 → 锁定
    const canvas = await h.call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
    const edited = await h.call("POST", "/agent-whales/api/canvas/elements", { projectId, expectedRevision: canvas.body.data.rev, upsert: [Object.assign({}, canvas.body.data.elements.find((el) => el.id === "flow:main:map"), { data: { flowId: "main", key: "map", shape: "step", text: "人改过的文字" } })] });
    assert.equal(edited.body.code, 200, JSON.stringify(edited.body));

    // 用户又说了两句 → 可以重画；新版本去掉了 map、加了 end
    h.sessionLogs.set("session-a", h.sessionLogs.get("session-a").concat([user(4, "导入完给个报告"), user(5, "失败的行单独导出")]));
    const redraw = await draw(h, {
      title: "表单导入 v2",
      nodes: [
        { key: "s", shape: "start", text: "上传文件", sourceMessageIds: ["m1"] },
        { key: "chk", shape: "decision", text: "表头匹配？", sourceMessageIds: ["m1"] },
        { key: "end", shape: "end", text: "出导入报告", sourceMessageIds: ["m4"] }
      ],
      edges: [{ from: "s", to: "chk" }, { from: "chk", to: "end", label: "是" }]
    });
    assert.equal(redraw.drawn, true, JSON.stringify(redraw));
    const after = (await h.call("GET", `/agent-whales/api/canvas?projectId=${projectId}`)).body.data.elements;
    const map = after.find((el) => el.id === "flow:main:map");
    assert.ok(map, "人改过的节点不会被重画删掉");
    assert.equal(map.data.text, "人改过的文字");
    assert.ok(after.find((el) => el.id === "flow:main:end"), "新增的节点补上");
    assert.equal(after.find((el) => el.id === "flow:main").data.title, "表单导入 v2");
  });

  test("flowId / title 校验", async () => {
    const { h } = await setup();
    await assert.rejects(draw(h, Object.assign({}, flow, { flowId: "Bad Id!" })), /flowId/);
    await assert.rejects(draw(h, Object.assign({}, flow, { title: "" })), /title/);
  });
});

// ── v2.2 波次 6：原型帧 + 组件库 ───────────────────────────────────────────────
describe("v2.2 波次 6：组件包 / 原型", () => {
  test("组件包列表：内置 shadcn 永远在；本地包要 manifest + bundle.js，坏的进 invalid 并说原因", () => {
    const dir = mkdtempSync(join(tmpdir(), "whales-packs-"));
    try {
      mkdirSync(join(dir, "cds"));
      writeFileSync(join(dir, "cds", "manifest.json"), JSON.stringify({ name: "CDS（本地）", license: "UNLICENSED", version: "3.0.8" }));
      writeFileSync(join(dir, "cds", "bundle.js"), "module.exports = {};");
      writeFileSync(join(dir, "cds", "styles.css"), ".x{}");
      mkdirSync(join(dir, "nobundle"));
      writeFileSync(join(dir, "nobundle", "manifest.json"), "{}");
      mkdirSync(join(dir, "badjson"));
      writeFileSync(join(dir, "badjson", "manifest.json"), "{坏");
      mkdirSync(join(dir, "Bad Name"));
      mkdirSync(join(dir, "shadcn"));
      const result = host.listComponentPacks(dir);
      assert.deepEqual(result.packs.map((p) => p.id), ["shadcn", "cds"]);
      assert.equal(result.packs[0].builtin, true);
      const cds = result.packs[1];
      assert.deepEqual([cds.name, cds.license, cds.version, cds.hasStyles, cds.builtin], ["CDS（本地）", "UNLICENSED", "3.0.8", true, false]);
      assert.deepEqual(result.invalid.map((row) => row.id).sort(), ["Bad Name", "badjson", "nobundle", "shadcn"].sort());
      assert.deepEqual(host.listComponentPacks(join(dir, "nope")).packs.map((p) => p.id), ["shadcn"], "目录不存在只给内置包");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GET /component-packs 与文件下发：只读、只允许 bundle.js / styles.css、拒绝路径穿越", async () => {
    const h = await m6Harness();
    const packs = join(h.dir, "component-packs", "cds");
    mkdirSync(packs, { recursive: true });
    writeFileSync(join(packs, "manifest.json"), JSON.stringify({ name: "CDS" }));
    writeFileSync(join(packs, "bundle.js"), "module.exports = { Button: function () {} };");
    const list = await h.raw("GET", "/agent-whales/api/component-packs", {});
    assert.equal(list.body.code, 200);
    assert.deepEqual(list.body.data.packs.map((p) => p.id), ["shadcn", "cds"]);
    const bundle = await h.rawText("GET", "/agent-whales/api/component-packs/cds/bundle.js");
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers["content-type"], /javascript/);
    assert.match(bundle.text, /Button/);
    assert.equal((await h.rawText("GET", "/agent-whales/api/component-packs/cds/manifest.json")).status, 404, "只下发 bundle.js / styles.css");
    assert.equal((await h.rawText("GET", "/agent-whales/api/component-packs/..%2F..%2Fsecret/bundle.js")).status, 404);
    assert.equal((await h.rawText("GET", "/agent-whales/api/component-packs/cds/styles.css")).status, 404, "没有 styles.css 就 404，不编");
    assert.equal((await h.call("POST", "/agent-whales/api/component-packs", {})).status, 405);
  });

  test("原型数据校验：只认通用词表、插槽必须是数组、补齐 id、层级与数量有上限", () => {
    const ok = host.validatePrototypeData({ content: [
      { type: "Heading", props: { text: "导入" } },
      { type: "Card", props: { title: "上传", content: [{ type: "Upload", props: {} }, { type: "Columns", props: { left: [{ type: "Input", props: {} }] } }] } }
    ] });
    assert.equal(ok.error, undefined, ok.error);
    assert.equal(ok.count, 5);
    assert.equal(ok.data.content[0].props.id, "Heading-1");
    assert.deepEqual(ok.data.content[1].props.content[1].props.right, [], "没写的插槽补成空数组");
    assert.match(host.validatePrototypeData({ content: [{ type: "AntdTable", props: {} }] }).error, /不认识的组件 AntdTable/);
    assert.match(host.validatePrototypeData({ content: [{ type: "Card", props: { content: "x" } }] }).error, /插槽/);
    assert.match(host.validatePrototypeData({}).error, /content/);
    let deep = [{ type: "Text", props: {} }];
    for (let i = 0; i < 7; i++) deep = [{ type: "Section", props: { content: deep } }];
    assert.match(host.validatePrototypeData({ content: deep }).error, /6 层/);
  });

  test("whales_prototype_draw：要消息证据；落成 AI 原型元素；人改过就锁定、不覆盖", async () => {
    const h = await m6Harness();
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const projectId = await createProject(h);
    h.sessionLogs.set("session-a", [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "导入弹窗要有上传区和映射表" }], source: { kind: "user" } } }]);
    const as = { agent: { id: "session-a" } };
    const puck = { content: [{ type: "Dialog", props: { title: "导入", content: [{ type: "Upload", props: {} }, { type: "Table", props: { columns: "源字段,目标字段", rows: 2 } }] } }] };
    const noRef = await h.tools.whales_prototype_draw.execute({ title: "导入弹窗", puck, sourceMessageIds: ["m9"] }, as);
    assert.equal(noRef.drawn, false);
    const drawn = await h.tools.whales_prototype_draw.execute({ title: "导入弹窗", puck, sourceMessageIds: ["m1"] }, as);
    assert.equal(drawn.drawn, true, JSON.stringify(drawn));
    assert.equal(drawn.components, 3);
    const canvas = await h.call("GET", `/agent-whales/api/canvas?projectId=${projectId}`);
    const el = canvas.body.data.elements.find((row) => row.id === "proto:main");
    assert.equal(el.kind, "prototype");
    assert.equal(el.provenance.by, "agent");
    assert.equal(el.data.puck.content[0].type, "Dialog");
    // 人在画布上改过（经元素路由）→ 锁定
    await h.call("POST", "/agent-whales/api/canvas/elements", { projectId, expectedRevision: canvas.body.data.rev, upsert: [Object.assign({}, el, { data: Object.assign({}, el.data, { title: "人改的标题" }) })] });
    const again = await h.tools.whales_prototype_draw.execute({ title: "导入弹窗 v2", puck, sourceMessageIds: ["m1"] }, as);
    assert.equal(again.drawn, false);
    assert.match(again.reason, /锁定/);
    await assert.rejects(h.tools.whales_prototype_draw.execute({ title: "x", puck: { content: [{ type: "Nope" }] }, sourceMessageIds: ["m1"] }, as), /不认识的组件/);
  });

  test("原型元素单独放宽到 64KB，其他元素仍 16KB", () => {
    const big = "x".repeat(20000);
    assert.equal(host.cleanCanvasElement({ id: "p", kind: "prototype", data: { puck: { content: [], note: big } } }).error, undefined);
    assert.match(host.cleanCanvasElement({ id: "n", kind: "note", data: { text: big } }).error, /16KB/);
    assert.match(host.cleanCanvasElement({ id: "p", kind: "prototype", data: { note: "x".repeat(70000) } }).error, /64KB/);
  });
});

// ── 2026-11-17：DSH v0.2.1-rc.2 Agent Teams 迁移（成员 = subagent，无 tryMembership / listMembers）──
describe("新宿主团队 API：GET /tasks?leadSessionId", () => {
  function modernTeams(enabledFor) {
    return {
      isEnabled: (agent) => enabledFor.has(agent.id),
      listTasks: () => [{ id: "1", subject: "拆分", revision: 1 }]
    };
  }
  const subagents = {
    rootOf: (agent) => (agent.id === "session-worker" ? { id: "session-a" } : agent),
    listDescendants: async (root) => (root === "session-a" ? [{ sessionId: "session-worker", description: "执行器", status: "idle", parentSessionId: "session-a" }] : [])
  };

  test("根会话 + Team 模式开 → 任务快照 + 子代理树补成员；没开 / 不是根 → 403", async () => {
    const enabled = new Set(["session-a", "session-worker"]);
    const h = await m6Harness({ agentTeams: modernTeams(enabled), subagents });
    const ok = await h.raw("GET", "/agent-whales/api/tasks?leadSessionId=session-a", {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.tasks.map((task) => task.subject), ["拆分"]);
    assert.deepEqual(ok.body.data.members, [{ id: "session-worker", name: "执行器", role: "member", status: "idle", parentId: "session-a" }]);
    const child = await h.raw("GET", "/agent-whales/api/tasks?leadSessionId=session-worker", {});
    assert.equal(child.status, 403, "子代理不是 Lead");
    enabled.delete("session-a");
    const off = await h.raw("GET", "/agent-whales/api/tasks?leadSessionId=session-a", {});
    assert.equal(off.status, 403, "Team 模式没开");
  });

  test("两代 API 都没有 → unavailable（不崩）", async () => {
    const h = await m6Harness({ agentTeams: { listTasks: () => [] }, subagents: undefined });
    const res = await h.raw("GET", "/agent-whales/api/tasks?leadSessionId=session-a", {});
    assert.equal(res.status, 200);
    assert.notEqual(res.body.code, 200);
    assert.match(res.body.msg, /unavailable/);
  });
});

// ── 波次 D：画布 Agent 卡「唤醒」（PRD 增量 §4.6）────────────────────────────
//
// POST /agent-whales/api/projects/:id/resume {sessionId}
// 约束：同源 token；只放本项目成员；幂等（已在线不重复 resume）；并发同 id 共用一次加载；
// 失败回 200 + 50201 且不留脏状态（可重试）；不批量、不派任务。

describe("波次 D · POST /projects/:id/resume（唤醒离线成员）", () => {
  /** 可控的 agents：只有 session-a 在线；resume 把目标放进在线集合，并记下被调用的 id。 */
  function resumable(impl) {
    const live = new Set(["session-a"]);
    const calls = [];
    const agents = {
      get: (id) => (live.has(id) ? { id, status: "idle", session: { id } } : undefined),
      list: () => [],
      resume: async (options) => {
        calls.push(options.resumeSessionId);
        if (impl) return impl(options, live);
        live.add(options.resumeSessionId);
        return { agent: { id: options.resumeSessionId } };
      }
    };
    return { agents, live, calls };
  }

  /** 建项目并把离线的 session-old（只存在于持久化里）登记为成员。 */
  async function withOfflineMember(fake) {
    const h = await m6Harness({ agents: fake.agents });
    const projectId = await createProject(h);
    const added = await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    assert.equal(added.body.code, 200, JSON.stringify(added.body));
    return { h, projectId, url: `/agent-whales/api/projects/${projectId}/resume` };
  }

  test("离线成员：首次唤醒真 resume 并回 live:true；再点一次幂等，不重复 resume", async () => {
    const fake = resumable();
    const { h, url } = await withOfflineMember(fake);
    const first = await h.call("POST", url, { sessionId: "session-old" });
    assert.equal(first.status, 200);
    assert.equal(first.body.code, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data, { sessionId: "session-old", live: true, resumed: true });
    assert.deepEqual(fake.calls, ["session-old"]);

    const second = await h.call("POST", url, { sessionId: "session-old" });
    assert.deepEqual(second.body.data, { sessionId: "session-old", live: true, resumed: false }, "已在线直接返回，不重复拉起");
    assert.equal(fake.calls.length, 1, "幂等：第二次不得再调 agents.resume");
  });

  test("拿不到 agent 不谎报：resume 返回但会话没上线 → live:false", async () => {
    const fake = resumable(() => ({ agent: undefined }));
    const { h, url } = await withOfflineMember(fake);
    const res = await h.call("POST", url, { sessionId: "session-old" });
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { sessionId: "session-old", live: false, resumed: true });
  });

  test("范围闸：非本项目成员 → 40711，且绝不触发 resume", async () => {
    const fake = resumable();
    const { h, url } = await withOfflineMember(fake);
    const outsider = await h.call("POST", url, { sessionId: "session-ghost" });
    assert.equal(outsider.status, 200);
    assert.equal(outsider.body.code, 40711, JSON.stringify(outsider.body));
    assert.deepEqual(fake.calls, [], "范围闸必须在 resume 之前");
  });

  test("主对话也算成员（可唤醒）；项目不存在 → 40401；会话不存在 → 40401", async () => {
    const fake = resumable();
    const { h, url } = await withOfflineMember(fake);
    const main = await h.call("POST", url, { sessionId: "session-a" });
    assert.equal(main.body.code, 200, "主对话是成员");
    assert.equal(main.body.data.resumed, false, "session-a 本来在线");

    const noProject = await h.call("POST", "/agent-whales/api/projects/ghost-project/resume", { sessionId: "session-old" });
    assert.equal(noProject.body.code, 40401);
    assert.equal(fake.calls.length, 0);
  });

  test("鉴权与入参：缺 token 403、非 POST 405、缺 sessionId 400", async () => {
    const fake = resumable();
    const { h, url } = await withOfflineMember(fake);
    const noToken = await h.raw("POST", url, {}, { sessionId: "session-old" });
    assert.equal(noToken.status, 403, "缺同源 token 必须 403");
    assert.equal(noToken.body.code, 40301);
    const wrongToken = await h.raw("POST", url, { "x-whales-token": "deadbeef" }, { sessionId: "session-old" });
    assert.equal(wrongToken.status, 403);
    const get = await h.call("GET", url);
    assert.equal(get.status, 405);
    const empty = await h.call("POST", url, {});
    assert.equal(empty.status, 400);
    assert.deepEqual(fake.calls, [], "所有负例都不能走到 resume");
  });

  test("并发幂等：同一会话两次同时点只 resume 一次，两边都拿到结果", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fake = resumable(async (options, live) => {
      await gate;
      live.add(options.resumeSessionId);
      return { agent: { id: options.resumeSessionId } };
    });
    const { h, url } = await withOfflineMember(fake);
    const a = h.call("POST", url, { sessionId: "session-old" });
    const b = h.call("POST", url, { sessionId: "session-old" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.body.code, 200, JSON.stringify(ra.body));
    assert.equal(rb.body.code, 200, JSON.stringify(rb.body));
    assert.equal(fake.calls.length, 1, "并发同 id 必须共用一次加载");
  });

  // 2026-11-18 第二期真机验证：唤醒后的成员没有 pwsh / read / edit（preset 没挂），会话里没记过模型时还报 no provider/model。
  // 根因：直接调 agents.resume({resumeSessionId}) 没带宿主自己恢复会话时带的 setup（preset）与 agentOptions（模型）。
  // 宿主有 sessionController.resolveAgent（UI 点开会话走的就是它），优先走它。
  test("唤醒优先走宿主 sessionController.resolveAgent（带 preset 与模型），不碰裸 agents.resume", async () => {
    const live = new Set(["session-a"]);
    const resolved = [];
    const agents = {
      get: (id) => (live.has(id) ? { id, status: "idle", session: { id } } : undefined),
      list: () => [],
      resume: async () => { throw new Error("裸 agents.resume 不应被调用：它不带 preset 和模型"); }
    };
    const sessionController = {
      resolveAgent: async (sessionId) => { resolved.push(sessionId); live.add(sessionId); return { agent: { id: sessionId } }; }
    };
    const h = await m6Harness({ agents, sessionController });
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    const url = `/agent-whales/api/projects/${projectId}/resume`;
    const first = await h.call("POST", url, { sessionId: "session-old" });
    assert.equal(first.body.code, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data, { sessionId: "session-old", live: true, resumed: true });
    assert.deepEqual(resolved, ["session-old"]);
    const again = await h.call("POST", url, { sessionId: "session-old" });
    assert.equal(again.body.data.resumed, false, "已在线幂等");
    assert.deepEqual(resolved, ["session-old"], "在线时不再恢复");
  });

  test("sessionController.resolveAgent 返回 {error}（如会话属于子代理）→ 50201 并带原因，不当成功", async () => {
    const agents = { get: () => undefined, list: () => [], resume: async () => { throw new Error("不应走到这里"); } };
    const sessionController = { resolveAgent: async () => ({ error: Object.assign(new Error("会话归属某个子代理，不能当普通会话恢复"), { code: "SUBAGENT_OWNED" }) }) };
    const h = await m6Harness({ agents, sessionController });
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    const bad = await h.call("POST", `/agent-whales/api/projects/${projectId}/resume`, { sessionId: "session-old" });
    assert.equal(bad.body.code, 50201, JSON.stringify(bad.body));
    assert.match(bad.body.msg, /子代理/);
  });

  test("sessionController.resolveAgent 并发同 id 只恢复一次；宿主没有该服务时退回裸 agents.resume（老宿主 / 假宿主行为不变）", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const live = new Set(["session-a"]);
    let resolves = 0;
    const agents = { get: (id) => (live.has(id) ? { id, status: "idle", session: { id } } : undefined), list: () => [], resume: async () => { throw new Error("不应走到这里"); } };
    const sessionController = { resolveAgent: async (id) => { resolves += 1; await gate; live.add(id); return { agent: { id } }; } };
    const h = await m6Harness({ agents, sessionController });
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    const url = `/agent-whales/api/projects/${projectId}/resume`;
    const a = h.call("POST", url, { sessionId: "session-old" });
    const b = h.call("POST", url, { sessionId: "session-old" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.body.code, 200, JSON.stringify(ra.body));
    assert.equal(rb.body.code, 200, JSON.stringify(rb.body));
    assert.equal(resolves, 1, "并发同 id 共用一次恢复");
    // 没有 sessionController：既有的 resumable 假宿主走裸 agents.resume，结果与之前一致
    const fake = resumable();
    const legacy = await withOfflineMember(fake);
    const r = await legacy.h.call("POST", legacy.url, { sessionId: "session-old" });
    assert.deepEqual(r.body.data, { sessionId: "session-old", live: true, resumed: true });
    assert.deepEqual(fake.calls, ["session-old"]);
  });

  test("resume 抛错：200 + 50201 且带原因；不留脏状态，修好后可重试", async () => {
    let fail = true;
    const fake = resumable((options, live) => {
      if (fail) throw new Error("resume boom: 日志损坏");
      live.add(options.resumeSessionId);
      return { agent: { id: options.resumeSessionId } };
    });
    const { h, url } = await withOfflineMember(fake);
    const bad = await h.call("POST", url, { sessionId: "session-old" });
    assert.equal(bad.status, 200, "业务失败走 200 + 业务码，不是 500");
    assert.equal(bad.body.code, 50201, JSON.stringify(bad.body));
    assert.match(bad.body.msg, /resume boom/, "原因必须如实带出，不静默");

    fail = false;
    const retry = await h.call("POST", url, { sessionId: "session-old" });
    assert.equal(retry.body.code, 200, "失败后 RESUMING 必须已清，能重试: " + JSON.stringify(retry.body));
    assert.equal(retry.body.data.live, true);
    assert.equal(fake.calls.length, 2);
  });

  test("宿主没有 agents.resume → 50201 且说明原因（不崩）", async () => {
    const h = await m6Harness({ agents: { get: () => undefined, list: () => [] } });
    const projectId = await createProject(h);
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    const res = await h.call("POST", `/agent-whales/api/projects/${projectId}/resume`, { sessionId: "session-old" });
    assert.equal(res.body.code, 50201);
    assert.match(res.body.msg, /agents\.resume/);
  });
});

describe("第二期 X1 · GET/PUT /projects/:id/auto（自动派任务配置）", () => {
  const autoUrl = (projectId) => `/agent-whales/api/projects/${projectId}/auto`;

  test("默认：L2 + 遇审批停在「等你」+ 3/5/10；旧项目没有 auto 字段也得到默认，projectView 同步暴露", async () => {
    const h = await m6Harness({});
    const projectId = await createProject(h);
    const got = await h.call("GET", autoUrl(projectId));
    assert.equal(got.body.code, 200, JSON.stringify(got.body));
    assert.deepEqual(got.body.data.auto, { tier: "L2", undoWindowMs: 5000, approval: "wait", perMemberPerMinute: 3, projectConcurrent: 5, maxChainDepth: 10 });
    assert.deepEqual(got.body.data.audit, []);
    assert.deepEqual(got.body.data.pending, []);
    const view = await h.call("GET", `/agent-whales/api/projects/${projectId}`);
    assert.equal(view.body.data.project.auto.tier, "L2");
    assert.deepEqual(view.body.data.project.autoAudit, []);
  });

  test("放宽闸门必须项目主动确认：L3 / 全部同意没带 confirm 被 400 拒绝且配置不变；带 confirm 才生效并写审计", async () => {
    const h = await m6Harness({});
    const projectId = await createProject(h);
    const noConfirm = await h.call("PUT", autoUrl(projectId), { tier: "L3" });
    assert.equal(noConfirm.body.code, 40000, JSON.stringify(noConfirm.body));
    assert.match(noConfirm.body.msg, /confirm/);
    const noConfirmApprove = await h.call("PUT", autoUrl(projectId), { approval: "approve-all" });
    assert.equal(noConfirmApprove.body.code, 40000, JSON.stringify(noConfirmApprove.body));
    assert.equal((await h.call("GET", autoUrl(projectId))).body.data.auto.tier, "L2", "被拒的请求不能改配置");

    const l3 = await h.call("PUT", autoUrl(projectId), { tier: "L3", approval: "approve-all", confirm: true });
    assert.equal(l3.body.code, 200, JSON.stringify(l3.body));
    assert.equal(l3.body.data.auto.tier, "L3");
    assert.equal(l3.body.data.auto.approval, "approve-all");
    assert.equal(l3.body.data.audit.length, 1);
    assert.equal(l3.body.data.audit[0].kind, "config");
    assert.match(l3.body.data.audit[0].reason, /tier/);
    assert.match(l3.body.data.audit[0].reason, /approval/);
  });

  test("收紧不需要确认；未变化的 PUT 不写审计；速率与深度可调（放宽也不要 confirm），越界被拒", async () => {
    const h = await m6Harness({});
    const projectId = await createProject(h);
    await h.call("PUT", autoUrl(projectId), { tier: "L3", confirm: true });
    const down = await h.call("PUT", autoUrl(projectId), { tier: "L1" });
    assert.equal(down.body.code, 200, JSON.stringify(down.body));
    assert.equal(down.body.data.auto.tier, "L1");
    const auditCount = down.body.data.audit.length;
    const same = await h.call("PUT", autoUrl(projectId), { tier: "L1" });
    assert.equal(same.body.data.audit.length, auditCount, "没变化不写审计");
    const tuned = await h.call("PUT", autoUrl(projectId), { perMemberPerMinute: 6, maxChainDepth: 20 });
    assert.equal(tuned.body.code, 200, JSON.stringify(tuned.body));
    assert.equal(tuned.body.data.auto.perMemberPerMinute, 6);
    assert.equal(tuned.body.data.auto.maxChainDepth, 20);
    const bad = await h.call("PUT", autoUrl(projectId), { perMemberPerMinute: 0 });
    assert.equal(bad.body.code, 40000, JSON.stringify(bad.body));
    const badTier = await h.call("PUT", autoUrl(projectId), { tier: "L9" });
    assert.equal(badTier.body.code, 40000, JSON.stringify(badTier.body));
  });

  test("鉴权与边界：无 token 403、方法 405、项目不存在 40401、body 非对象 400", async () => {
    const h = await m6Harness({});
    const projectId = await createProject(h);
    const noToken = await h.raw("PUT", autoUrl(projectId), {}, { tier: "L1" });
    assert.equal(noToken.status, 403);
    const post = await h.call("POST", autoUrl(projectId), {});
    assert.equal(post.status, 405);
    const ghost = await h.call("PUT", autoUrl("proj-ghost"), { tier: "L1" });
    assert.equal(ghost.body.code, 40401, JSON.stringify(ghost.body));
    const arr = await h.call("PUT", autoUrl(projectId), [1, 2]);
    assert.equal(arr.status, 400);
  });
});

describe("第二期 X2：唤醒后自动派任务", () => {
  /** session-old 起初离线；agents.resume 把它拉上线，之后 get() 返回带 followup 的 agent。 */
  function wakeHarness() {
    const online = new Set(["session-a"]);
    const sent = [];
    const resumes = [];
    const agents = {
      get: (id) => (online.has(id) ? { id, status: "idle", session: { id }, followup: (message) => { sent.push({ id, message }); } } : undefined),
      list: () => [],
      resume: async ({ resumeSessionId }) => { resumes.push(resumeSessionId); online.add(resumeSessionId); return { agent: {} }; }
    };
    return { agents, sent, resumes };
  }

  async function setup(config) {
    const w = wakeHarness();
    const h = await m6Harness({ agents: w.agents });
    const projectId = await createProject(h);
    await h.token();
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    if (config !== undefined) {
      const put = await h.call("PUT", `/agent-whales/api/projects/${projectId}/auto`, config);
      assert.equal(put.body.code, 200, JSON.stringify(put.body));
    }
    // 成员离线时指派：派发必然失败，原因 owner-not-running。
    const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "离线时派的活" });
    const taskId = created.body.data.task.taskId;
    const assigned = await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign-and-dispatch", owner: "session-old", expectedRevision: 1, requestId: "x2-assign" });
    assert.equal(assigned.body.code, 200, JSON.stringify(assigned.body));
    assert.equal((assigned.body.data.dispatch || {}).reason, "owner-not-running", JSON.stringify(assigned.body));
    return { h, w, projectId, taskId };
  }

  const wake = (ctx) => ctx.h.call("POST", `/agent-whales/api/projects/${ctx.projectId}/resume`, { sessionId: "session-old" });
  const auditOf = async (ctx) => (await ctx.h.call("GET", `/agent-whales/api/projects/${ctx.projectId}/auto`)).body.data.audit;

  test("L3：唤醒后立即派发，并写审计", async () => {
    const ctx = await setup({ tier: "L3", confirm: true });
    const out = await wake(ctx);
    assert.equal(out.body.code, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.auto.mode, "immediate");
    assert.equal(out.body.data.auto.dispatched[0].status, "sent", JSON.stringify(out.body.data.auto));
    assert.equal(ctx.w.sent.length, 1, "followup 必须真的发出一条");
    const audit = (await auditOf(ctx)).filter((row) => row.kind === "dispatch");
    assert.equal(audit[audit.length - 1].outcome, "sent");
    assert.equal(audit[audit.length - 1].tier, "L3");
  });

  test("L1：只唤醒不派，响应里标明 manual", async () => {
    const ctx = await setup({ tier: "L1" });
    const out = await wake(ctx);
    assert.equal(out.body.data.auto.mode, "manual");
    assert.equal(out.body.data.auto.skipped[0].reason, "manual");
    assert.equal(ctx.w.sent.length, 0, "L1 绝不能自动派");
  });

  test("L2：先挂起，窗口内撤销后到点也不发", async () => {
    const ctx = await setup({ tier: "L2" });
    const out = await wake(ctx);
    assert.equal(out.body.data.auto.mode, "delayed");
    assert.equal(out.body.data.auto.scheduled.length, 1);
    assert.equal(ctx.w.sent.length, 0, "窗口内不能已经发出");
    const state = await ctx.h.call("GET", `/agent-whales/api/projects/${ctx.projectId}/auto`);
    assert.equal(state.body.data.pending.length, 1, "挂起中的条目要在界面可见");
    const undo = await ctx.h.call("POST", `/agent-whales/api/projects/${ctx.projectId}/auto-undo`, { taskId: ctx.taskId });
    assert.equal(undo.body.code, 200, JSON.stringify(undo.body));
    const again = await ctx.h.call("POST", `/agent-whales/api/projects/${ctx.projectId}/auto-undo`, { taskId: ctx.taskId });
    assert.notEqual(again.body.code, 200, "同一条不能撤销两次");
    const audit = (await auditOf(ctx)).filter((row) => row.kind === "dispatch");
    assert.deepEqual(audit.map((row) => row.outcome), ["scheduled", "undone"]);
    assert.equal(ctx.w.sent.length, 0);
  });

  test("速率闸：每成员每分钟超限的那条被拦并写审计", async () => {
    const ctx = await setup({ tier: "L3", perMemberPerMinute: 1, confirm: true });
    const second = await ctx.h.call("POST", "/agent-whales/api/tasks", { projectId: ctx.projectId, subject: "第二件" });
    const id2 = second.body.data.task.taskId;
    await ctx.h.call("POST", `/agent-whales/api/tasks/${id2}/commands`, { projectId: ctx.projectId, action: "assign-and-dispatch", owner: "session-old", expectedRevision: 1, requestId: "x2-assign-2" });
    const out = await wake(ctx);
    const auto = out.body.data.auto;
    assert.equal(auto.dispatched.length, 1);
    assert.equal(auto.skipped.length, 1);
    assert.equal(auto.skipped[0].reason, "rate");
    assert.equal(ctx.w.sent.length, 1);
    const audit = await auditOf(ctx);
    assert.ok(audit.some((row) => row.outcome === "blocked" && row.reason === "rate"));
  });

  test("没有离线待派的任务时，唤醒响应保持第一期形状（无 auto 字段）", async () => {
    const w = wakeHarness();
    const h = await m6Harness({ agents: w.agents });
    const projectId = await createProject(h);
    await h.token();
    await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
    const out = await h.call("POST", `/agent-whales/api/projects/${projectId}/resume`, { sessionId: "session-old" });
    assert.equal(out.body.code, 200, JSON.stringify(out.body));
    assert.deepEqual(Object.keys(out.body.data).sort(), ["live", "resumed", "sessionId"]);
  });
});

describe("第二期 X3：自动派发遇审批", () => {
	function wakeHarness() {
		const online = new Set(["session-a"]);
		const agents = {
			get: (id) => (online.has(id) ? { id, status: "idle", session: { id }, followup: () => {} } : undefined),
			list: () => [],
			resume: async ({ resumeSessionId }) => { online.add(resumeSessionId); return { agent: {} }; }
		};
		return { agents };
	}

	/** 离线成员 session-old 名下有一条任务；按 config 配好项目，再唤醒（L3 即时派发，任务带 auto 标记）。 */
	async function setup(config, { wakeIt = true } = {}) {
		const w = wakeHarness();
		const h = await m6Harness({ agents: w.agents });
		const projectId = await createProject(h);
		await h.token();
		await h.call("POST", `/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
		const put = await h.call("PUT", `/agent-whales/api/projects/${projectId}/auto`, config);
		assert.equal(put.body.code, 200, JSON.stringify(put.body));
		const created = await h.call("POST", "/agent-whales/api/tasks", { projectId, subject: "要审批的活" });
		const taskId = created.body.data.task.taskId;
		await h.call("POST", `/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign-and-dispatch", owner: "session-old", expectedRevision: 1, requestId: "x3-assign" });
		if (wakeIt) {
			const out = await h.call("POST", `/agent-whales/api/projects/${projectId}/resume`, { sessionId: "session-old" });
			assert.equal(out.body.code, 200, JSON.stringify(out.body));
			assert.equal((out.body.data.auto.dispatched[0] || {}).status, "sent", JSON.stringify(out.body.data.auto));
		}
		return { h, projectId, taskId };
	}

	/** 成员开始新一轮：宿主发 agent/status running，插件记下本轮开始时间（「全部同意」靠它认这一轮）。 */
	const startRun = (ctx, sessionId) => ctx.h.listeners["agent/status"]({ agent: { id: sessionId }, status: "running" });
	const endRun = (ctx, sessionId) => ctx.h.listeners["agent/status"]({ agent: { id: sessionId }, status: "idle" });
	/** 默认：自动派发刚送出，followup 一到空闲成员就开跑——所以先开一轮再问。 */
	const ask = (ctx, sessionId, toolName = "bash", { running = true } = {}) => {
		if (running) startRun(ctx, sessionId);
		let delegated = 0;
		const result = ctx.h.listeners["approval/request"]({ agent: { id: sessionId }, toolName }, () => { delegated += 1; return Promise.resolve("unavailable"); });
		return Promise.resolve(result).then((outcome) => ({ outcome, delegated }));
	};
	const auditOf = async (ctx) => (await ctx.h.call("GET", `/agent-whales/api/projects/${ctx.projectId}/auto`)).body.data.audit;

	test("approve-all：自动派发出去的任务遇审批 → allowed-once，且先写审计（带工具名）", async () => {
		const ctx = await setup({ tier: "L3", approval: "approve-all", confirm: true });
		const { outcome, delegated } = await ask(ctx, "session-old", "bash");
		assert.equal(outcome, "allowed-once");
		assert.equal(delegated, 0, "命中授权就不再交给后面的回答者");
		const rows = (await auditOf(ctx)).filter((row) => row.kind === "approval");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, "approved");
		assert.equal(rows[0].reason, "tool:bash");
		assert.equal(rows[0].sessionId, "session-old");
	});

	test("默认配置（停在等你）：同样的请求不批，交给下一个回答者，不写审批审计", async () => {
		const ctx = await setup({ tier: "L3", confirm: true });
		const { outcome, delegated } = await ask(ctx, "session-old");
		assert.equal(outcome, "unavailable");
		assert.equal(delegated, 1);
		assert.equal((await auditOf(ctx)).filter((row) => row.kind === "approval").length, 0);
	});

	test("授权不外溢：非成员会话、没有自动派发任务的成员都不批", async () => {
		const ctx = await setup({ tier: "L3", approval: "approve-all", confirm: true });
		for (const id of ["session-stranger", "session-b"]) {
			const { outcome, delegated } = await ask(ctx, id);
			assert.equal(outcome, "unavailable", id);
			assert.equal(delegated, 1, id);
		}
	});

	test("用户手动派的任务不在授权内（没唤醒、没有 auto 标记）", async () => {
		const ctx = await setup({ tier: "L3", approval: "approve-all", confirm: true }, { wakeIt: false });
		const { outcome, delegated } = await ask(ctx, "session-old");
		assert.equal(outcome, "unavailable");
		assert.equal(delegated, 1);
	});

	// 2026-11-18 真机验证发现的洞：成员做完任务没人标完成，任务一直「在办」，之后这个会话里发生的任何事都被放行。
	test("不是自动派发那条消息引出的轮次不批：没在跑、或本轮开始得比送出晚太多（如人之后手动发的话）", async () => {
		const ctx = await setup({ tier: "L3", approval: "approve-all", confirm: true });
		// 没有在跑的轮次（宿主没发过 running / 已收工）：拿不到本轮开始时间 → 不批
		endRun(ctx, "session-old");
		const idle = await ask(ctx, "session-old", "bash", { running: false });
		assert.equal(idle.outcome, "unavailable", "没在跑不批");
		assert.equal(idle.delegated, 1);
		// 把任务的送出时刻改成 10 分钟前：此刻开的这一轮不可能是那条消息引出的
		const storeFile = join(ctx.h.dir, "projects.json");
		const store = JSON.parse(readFileSync(storeFile, "utf8"));
		const task = store.tasks[ctx.taskId];
		assert.equal(task.dispatch.auto, true, "前提：任务带自动派发标记");
		assert.equal(typeof task.dispatch.at, "number", "前提：自动派发记下了送出时刻");
		task.dispatch.at -= 10 * 60 * 1000;
		writeFileSync(storeFile, JSON.stringify(store));
		const late = await ask(ctx, "session-old", "bash");
		assert.equal(late.outcome, "unavailable", "本轮比送出晚 10 分钟，不是那条消息引出的");
		assert.equal(late.delegated, 1);
		assert.equal((await auditOf(ctx)).filter((row) => row.kind === "approval").length, 0, "没批就不写审批审计");
	});

	test("坏事件不抛错、不误批：没有 agent / 空对象 / null", async () => {
		const ctx = await setup({ tier: "L3", approval: "approve-all", confirm: true });
		for (const bad of [{}, { agent: {} }, { agent: { id: 7 } }, null, undefined]) {
			let delegated = 0;
			const outcome = await ctx.h.listeners["approval/request"](bad, () => { delegated += 1; return Promise.resolve("unavailable"); });
			assert.equal(outcome, "unavailable");
			assert.equal(delegated, 1);
		}
	});

	test("不改写项目其它状态：自动批准只多一条审计", async () => {
		const ctx = await setup({ tier: "L3", approval: "approve-all", confirm: true });
		const before = (await auditOf(ctx)).length;
		await ask(ctx, "session-old");
		assert.equal((await auditOf(ctx)).length, before + 1);
	});
});

// ── 需求主线 P1：requirementId 贯穿任务 / 提案 / 原型帧 / 流程图，univer_* 记为写类 ─────────────────
describe("需求主线 P1：requirementId 贯穿", () => {
  const user = (seq, text) => ({ type: "user/message", seq, data: { content: [{ type: "text", text }], source: { kind: "user" } } });
  const assistant = (seq, text) => ({ type: "assistant/message", seq, data: { message: { content: [{ type: "text", text }] } } });
  const asA = { agent: { id: "session-a" } };
  const base = "/agent-whales/api";
  const puck = { content: [{ type: "Heading", props: { text: "导入" } }] };
  const miniFlow = (flowId) => ({
    flowId,
    title: "导入流程",
    nodes: [
      { key: "s", shape: "start", text: "上传文件", sourceMessageIds: ["m1"] },
      { key: "m", shape: "step", text: "给映射建议", sourceMessageIds: ["m2"] }
    ],
    edges: [{ from: "s", to: "m" }]
  });
  async function setup() {
    const h = await m6Harness();
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const projectId = await createProject(h);
    h.sessionLogs.set("session-a", [user(1, "导入要先校验表头"), assistant(2, "好，表头不对就给映射建议")]);
    return { h, projectId };
  }
  const reqs = async (h, projectId) => (await h.call("GET", `${base}/projects/${projectId}/requirements`)).body.data.requirements;
  const newReq = async (h, projectId, body) => (await h.call("POST", `${base}/projects/${projectId}/requirements`, body)).body.data.requirement;

  test("POST /tasks 带 requirementId：落库、并入该需求；不存在 / 别的项目的需求被拒；不带则留在「未归类」", async () => {
    const { h, projectId } = await setup();
    const r1 = await newReq(h, projectId, { title: "表单导入" });
    const task = await h.call("POST", `${base}/tasks`, { projectId, subject: "T1", requirementId: r1.reqId });
    assert.equal(task.body.code, 200, JSON.stringify(task.body));
    assert.equal(task.body.data.task.requirementId, r1.reqId);
    const orphan = await h.call("POST", `${base}/tasks`, { projectId, subject: "老式任务" });
    assert.equal(orphan.body.data.task.requirementId, undefined, "没带就不写字段");
    const rows = await reqs(h, projectId);
    assert.deepEqual(rows.find((row) => row.reqId === r1.reqId).taskIds, [task.body.data.task.taskId]);
    assert.equal(rows[rows.length - 1].reqId, "unassigned");
    assert.equal(rows[rows.length - 1].counts.tasks, 1);

    assert.equal((await h.call("POST", `${base}/tasks`, { projectId, subject: "x", requirementId: "req-不存在" })).body.code, 40401);
    const other = await h.call("POST", `${base}/projects`, { name: "别的项目", mainSessionId: "session-b" });
    const otherReq = await newReq(h, other.body.data.project.projectId, { title: "别人的需求" });
    const cross = await h.call("POST", `${base}/tasks`, { projectId, subject: "x", requirementId: otherReq.reqId });
    assert.equal(cross.body.code, 40401, "别的项目的需求不能认领：" + JSON.stringify(cross.body));
  });

  test("首次画图：项目里还没有需求就建第一个（项目名 + 目标），流程图 / 原型都归在它名下", async () => {
    const { h, projectId } = await setup();
    assert.deepEqual(await reqs(h, projectId), []);
    const drawn = await h.tools.whales_flow_draw.execute(miniFlow("main"), asA);
    assert.equal(drawn.drawn, true, JSON.stringify(drawn));
    assert.ok(drawn.requirementId, "结果要告诉 agent 归到了哪个需求");
    assert.match(drawn.requirementNote, /第一个需求/);
    let rows = await reqs(h, projectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reqId, drawn.requirementId);
    assert.equal(rows[0].title, "M6 项目");
    assert.equal(rows[0].composerSessionId, "session-a");
    assert.deepEqual(rows[0].flowIds, ["flow:main"], "一张流程图按分组框算一张");
    assert.equal(rows[0].stage, "clarify", "只有流程图、没有原型帧还是澄清");

    const proto = await h.tools.whales_prototype_draw.execute({ title: "导入弹窗", puck, sourceMessageIds: ["m1"] }, asA);
    assert.equal(proto.drawn, true, JSON.stringify(proto));
    assert.equal(proto.requirementId, drawn.requirementId);
    assert.equal(proto.requirementNote, undefined, "第二次不再建需求");
    rows = await reqs(h, projectId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].prototypeIds, ["proto:main"]);
    assert.equal(rows[0].stage, "design", "有原型帧但没确认过 → 设计阶段");
    assert.equal(rows[0].attention, "confirm-design");
    assert.equal(rows.some((row) => row.virtual), false, "画出来的东西都有归属，不会冒出「未归类」");
  });

  test("多个需求：显式 requirementId 优先；按 Composer 匹配；有歧义时不乱猜、沿用原归属；显式写错直接拒绝", async () => {
    const { h, projectId } = await setup();
    const r1 = await newReq(h, projectId, { title: "需求一" });
    await h.call("POST", `${base}/projects/${projectId}/members`, { sessionId: "session-b" });
    const r2 = await newReq(h, projectId, { title: "需求二", composerSessionId: "session-b" });

    // 没带 requirementId：session-a 只是 r1 的 Composer → 归 r1
    const byComposer = await h.tools.whales_prototype_draw.execute({ prototypeId: "main", title: "页一", puck, sourceMessageIds: ["m1"] }, asA);
    assert.equal(byComposer.requirementId, r1.reqId);
    // 显式指定 r2
    const explicit = await h.tools.whales_prototype_draw.execute({ prototypeId: "p2", title: "页二", puck, sourceMessageIds: ["m1"], requirementId: r2.reqId }, asA);
    assert.equal(explicit.requirementId, r2.reqId);
    // 显式写错：拒绝，不悄悄落到别处
    await assert.rejects(h.tools.whales_prototype_draw.execute({ prototypeId: "p9", title: "x", puck, sourceMessageIds: ["m1"], requirementId: "req-nope" }, asA), /40401/);
    let rows = await reqs(h, projectId);
    assert.deepEqual(rows.find((row) => row.reqId === r1.reqId).prototypeIds, ["proto:main"]);
    assert.deepEqual(rows.find((row) => row.reqId === r2.reqId).prototypeIds, ["proto:p2"]);

    // 再给 session-a 一个需求 → 它名下有两个，没法判断
    await newReq(h, projectId, { title: "需求三", composerSessionId: "session-a" });
    const ambiguous = await h.tools.whales_prototype_draw.execute({ prototypeId: "p3", title: "页三", puck, sourceMessageIds: ["m1"] }, asA);
    assert.equal(ambiguous.drawn, true);
    assert.equal(ambiguous.requirementId, undefined, "有歧义不乱猜");
    assert.match(ambiguous.requirementNote, /请带上 requirementId/);
    rows = await reqs(h, projectId);
    assert.deepEqual(rows.find((row) => row.virtual).prototypeIds, ["proto:p3"], "落在「未归类」，没丢");
    // 已有归属的原型重画时遇到歧义：沿用原归属，不被甩回「未归类」
    const redraw = await h.tools.whales_prototype_draw.execute({ prototypeId: "main", title: "页一改", puck, sourceMessageIds: ["m1"] }, asA);
    assert.equal(redraw.drawn, true, JSON.stringify(redraw));
    rows = await reqs(h, projectId);
    assert.deepEqual(rows.find((row) => row.reqId === r1.reqId).prototypeIds, ["proto:main"]);
  });

  test("提案：带 requirementId（缺省按 Composer / 首个需求），确认后建出的任务继承；写错直接拒绝", async () => {
    const { h, projectId } = await setup();
    await assert.rejects(h.tools.whales_propose_tasks.execute({ projectId, requirementId: "req-nope", items: [{ key: "T1", title: "x" }] }, asA), /40401/);

    const proposal = await h.tools.whales_propose_tasks.execute({ projectId, items: [{ key: "T1", title: "导入接口" }, { key: "T2", title: "导入弹窗", blockedByKeys: ["T1"] }] }, asA);
    assert.ok(proposal.requirementId, "项目里没有需求时自动建第一个并归到它");
    assert.match(proposal.requirementNote, /第一个需求/);
    const view = await h.call("GET", `${base}/proposals?leadSessionId=session-a`);
    assert.equal(view.body.data.proposal.requirementId, proposal.requirementId, "提案视图带出归属");

    const confirmed = await h.call("POST", `${base}/proposals/${proposal.proposalId}/confirm`, { leadSessionId: "session-a", version: proposal.version, requestId: "p1-confirm" });
    assert.equal(confirmed.body.code, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.created.length, 2);
    const tasks = (await h.call("GET", `${base}/tasks?projectId=${projectId}`)).body.data.tasks;
    assert.equal(tasks.length, 2);
    for (const task of tasks) assert.equal(task.requirementId, proposal.requirementId, "确认后建出的任务继承提案的需求");
    const rows = await reqs(h, projectId);
    assert.equal(rows.length, 1, "任务都有归属，不出现「未归类」");
    assert.equal(rows[0].counts.tasks, 2);
    assert.equal(rows[0].stage, "develop", "没有原型帧、有任务 → 开发");
  });

  test("提案确认时需求已被改到别处不存在：任务建不出来并如实报失败，不悄悄落到未归类", async () => {
    const { h, projectId } = await setup();
    const proposal = await h.tools.whales_propose_tasks.execute({ projectId, items: [{ key: "T1", title: "x" }] }, asA);
    // 直接抹掉 projects.json 里的需求表，模拟需求在确认前被清掉
    const file = join(h.dir, "projects.json");
    const store = JSON.parse(readFileSync(file, "utf8"));
    store.requirements = {};
    writeFileSync(file, JSON.stringify(store), "utf8");
    const confirmed = await h.call("POST", `${base}/proposals/${proposal.proposalId}/confirm`, { leadSessionId: "session-a", version: proposal.version, requestId: "p2-confirm" });
    assert.equal(confirmed.body.code, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.created.length, 0);
    assert.equal(confirmed.body.data.failed[0].status, "failed");
    assert.match(confirmed.body.data.failed[0].message, /requirement not found/);
  });

  test("univer_* 工具记为写类：agent 用 univer_execute 改了 .univer 文件，节点标「改过」而不是「读过」", () => {
    const call = (seq, name, args) => ({ type: "tool/call", seq, time: 1000 + seq, data: { name, arguments: JSON.stringify(args) } });
    const refs = host.referencesFromEvents([
      call(1, "univer_new", { file: "D:/work/验收用例.univer" }),
      call(2, "univer_execute", { file: "D:/work/验收用例.univer", worktreeId: "w1", unitId: "u1", code: "return 1" }),
      call(3, "univer_inspect", { file: "D:/work/需求文档.univer" }),
      call(4, "univer_screenshot", { file: "D:/work/需求文档.univer" })
    ]);
    const cases = refs.files["d:/work/验收用例.univer"];
    assert.equal(cases.write, 2, "new + execute 都是写");
    assert.equal(cases.read, 0);
    const doc = refs.files["d:/work/需求文档.univer"];
    assert.equal(doc.write, 0);
    assert.equal(doc.read, 2, "inspect / screenshot 只是读");
  });
});
describe("需求主线 P3：需求待办进「需要我处理」", () => {
  const base = "/agent-whales/api";
  async function setup() {
    const h = await m6Harness();
    host.setEventsStorePathForTests(join(h.dir, "events.json"));
    const projectId = await createProject(h);
    return { h, projectId };
  }
  const newReq = async (h, projectId, body) => (await h.call("POST", `${base}/projects/${projectId}/requirements`, body)).body.data.requirement;
  const putProto = async (h, projectId, reqId, id) => {
    const canvas = await h.call("GET", `${base}/canvas?projectId=${projectId}`);
    const res = await h.call("POST", `${base}/canvas/elements`, { projectId, expectedRevision: canvas.body.data.rev, upsert: [{ id, kind: "prototype", data: { requirementId: reqId, title: "页", puck: { content: [{ type: "Heading", props: { text: "x" } }] } } }] });
    assert.equal(res.body.code, 200, JSON.stringify(res.body));
  };
  const group = async (h, query) => (await h.call("GET", `${base}/inbox${query || ""}`)).body.data.groups.find((row) => row.key === "requirements");

  test("待确认设计：有原型帧没确认 → 进待办；确认后移出；虚拟「未归类」不进；字段齐全", async () => {
    const { h, projectId } = await setup();
    const r1 = await newReq(h, projectId, { title: "表单导入" });
    await newReq(h, projectId, { title: "只聊了没画" });
    await h.call("POST", `${base}/tasks`, { projectId, subject: "老任务" });
    await putProto(h, projectId, r1.reqId, "proto:main");
    const todo = await group(h);
    assert.equal(todo.label, "需求待办");
    assert.equal(todo.items.length, 1, "澄清阶段的需求和未归类都不算待办");
    const item = todo.items[0];
    assert.equal(item.kind, "requirement");
    assert.equal(item.reqId, r1.reqId);
    assert.equal(item.projectId, projectId);
    assert.equal(item.subject, "表单导入");
    assert.equal(item.attention, "confirm-design");
    assert.match(item.reason, /确认原型/);
    assert.equal(item.stage, "design");

    const confirmed = await h.call("POST", `${base}/projects/${projectId}/requirements/${r1.reqId}/confirm-design`, { expectedRevision: r1.revision });
    assert.equal(confirmed.body.code, 200, JSON.stringify(confirmed.body));
    assert.deepEqual((await group(h)).items, [], "确认后待办消失");
  });

  test("项目过滤：只看某个项目的需求待办；别的项目的不混入", async () => {
    const { h, projectId } = await setup();
    const other = await h.call("POST", `${base}/projects`, { name: "别的项目", mainSessionId: "session-b" });
    const otherId = other.body.data.project.projectId;
    const mine = await newReq(h, projectId, { title: "我的" });
    const theirs = await newReq(h, otherId, { title: "别人的" });
    await putProto(h, projectId, mine.reqId, "proto:a");
    await putProto(h, otherId, theirs.reqId, "proto:b");
    assert.deepEqual((await group(h, `?projectId=${projectId}`)).items.map((i) => i.subject), ["我的"]);
    assert.deepEqual((await group(h, `?projectId=${otherId}`)).items.map((i) => i.subject), ["别人的"]);
    assert.equal((await group(h)).items.length, 2, "不带 projectId 是全部");
  });

  test("验收不符 / 返工超限：E2E 最近一次失败 → 待办；达到返工上限变成 rework-limit", async () => {
    const { h, projectId } = await setup();
    const r = await newReq(h, projectId, { title: "对账" });
    await putProto(h, projectId, r.reqId, "proto:main");
    const confirm = await h.call("POST", `${base}/projects/${projectId}/requirements/${r.reqId}/confirm-design`, { expectedRevision: r.revision });
    assert.equal(confirm.body.code, 200);
    const task = await h.call("POST", `${base}/tasks`, { projectId, subject: "T1", requirementId: r.reqId });
    const taskId = task.body.data.task.taskId;
    await h.call("PUT", `${base}/tasks/${taskId}/report`, { projectId, expectedRevision: 1, report: { status: "done", summary: "ok" } });
    // 没有 E2E 运行 → 验收阶段，没有待办（还没人该处理）
    assert.deepEqual((await group(h)).items, []);
    // 造一次失败的运行（运行表本期只读：直接写 store，P4 才有写路由）
    const file = join(h.dir, "projects.json");
    const store = JSON.parse(readFileSync(file, "utf8"));
    store.e2eRuns = { "run-1": { runId: "run-1", projectId, requirementId: r.reqId, designVersion: 1, status: "failed", startedAt: Date.now(), results: [{ status: "failed" }] } };
    writeFileSync(file, JSON.stringify(store), "utf8");
    const mismatch = (await group(h)).items;
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].attention, "e2e-mismatch");
    assert.equal(mismatch[0].stage, "mismatch");
    store.requirements[r.reqId].reworkCount = 3;
    writeFileSync(file, JSON.stringify(store), "utf8");
    assert.equal((await group(h)).items[0].attention, "rework-limit");
  });
});