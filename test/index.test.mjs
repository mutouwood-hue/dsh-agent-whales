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
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as host from "../lib/index.js";

const KNOWN_TOOLS = [
  "whales_visit_list",
  "whales_visit_send",
  "whales_visit_resume",
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
  const stats = { registerCalls: 0, disposeCalls: 0 };
  const routes = [];
  host.apply({
    get(name) {
      if (name === "tools") {
        return {
          register(definition) {
            stats.registerCalls += 1;
            registry.set(definition.name, definition);
            return () => {
              stats.disposeCalls += 1;
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
    whales_visit_resume: [
      { sessionId: "s1", live: true, resumed: false },
      { sessionId: "s1", live: true, resumed: true }
    ],
    whales_visit_read: [
      { sessionId: "s1", total: 0, messages: [] },
      { sessionId: "s1", total: 1, messages: [{ seq: 1, role: "user", text: "你好" }] }
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
    {}
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

  const byDefault = await tools.whales_visit_read.execute({ sessionId: "s-read" }, {});
  assert.equal(byDefault.total, 150);
  assert.equal(byDefault.messages.length, 20, "默认最近 20 行");
  assert.equal(byDefault.messages.at(-1).seq, 150, "取的是最近的行");
  assertLossless(byDefault, "whales_visit_read");

  const capped = await tools.whales_visit_read.execute({ sessionId: "s-read", limit: 1000 }, {});
  assert.equal(capped.messages.length, 100, "上限 100");
  assert.equal(capped.messages[0].seq, 51);

  const floored = await tools.whales_visit_read.execute({ sessionId: "s-read", limit: 1.9 }, {});
  assert.equal(floored.messages.length, 1, "limit 向下取整");

  const negative = await tools.whales_visit_read.execute({ sessionId: "s-read", limit: -5 }, {});
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

  const result = await tools.whales_visit_list.execute({}, {});
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
  const second = await fallback.whales_visit_list.execute({}, {});
  assert.equal(second.count, 1, "工作区表抛错时至少还能列活会话");
});

test("宿主工具：whales_visit_resume 拿不到 agent 时如实回 live:false，resume 拒绝时工具调用失败而不是挂起", async () => {
  const tools = captureToolsWithServices({
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async () => ({ agent: undefined })
    }
  });
  const offline = await tools.whales_visit_resume.execute({ sessionId: "off-1" }, {});
  assert.deepEqual(offline, { sessionId: "off-1", live: false, resumed: true }, "拿不到 agent 不能谎报 live:true");
  assertLossless(offline, "whales_visit_resume");

  const failing = captureToolsWithServices({
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async () => { throw new Error("resume boom"); }
    }
  });
  await assert.rejects(
    () => failing.whales_visit_resume.execute({ sessionId: "off-2" }, {}),
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
    () => tools.whales_visit_send.execute({ sessionId: "s-boom", message: "hi" }, {}),
    /送信失败|inbox disposed/
  );
  await assert.rejects(
    () => tools.whales_visit_send.execute({ sessionId: "s-boom", message: "hi", mode: "steer" }, {}),
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
  assert.equal(sections.length, 1, "团队策略仍然注册");
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
  assert.equal(visitToolNames(registry).length, 4, "初始 4 个工具都注册");

  const noToken = await postVisitTools(route, { body: JSON.stringify({ enabled: false }) });
  assert.equal(noToken.status, 403, "无 token 必须 403");
  const wrongToken = await postVisitTools(route, { token: "deadbeef", body: JSON.stringify({ enabled: false }) });
  assert.equal(wrongToken.status, 403, "错 token 必须 403");
  const emptyToken = await postVisitTools(route, { token: "", body: JSON.stringify({ enabled: false }) });
  assert.equal(emptyToken.status, 403, "空 token 必须 403");

  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort(), "403 之后 4 个工具必须原样在册");
  assert.equal(stats.registerCalls, 4, "403 不得触发注册");
  assert.equal(stats.disposeCalls, 0, "403 不得触发注销");
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

test("串门工具开关：{enabled:false} → 204 且 4 个工具全部注销；{enabled:true} 开回且 schema 仍合法", async () => {
  const { registry, stats, route } = mountControlHost();
  const token = getActivity(route).controlToken;

  const turnedOff = await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  assert.equal(turnedOff.status, 204);
  assert.deepEqual(visitToolNames(registry), [], "关闭后串门工具必须从注册表消失");
  assert.equal(stats.registerCalls, 4, "关闭不应重复注册");
  assert.equal(stats.disposeCalls, 4, "关闭必须逐个注销");
  assert.equal(getActivity(route).visitTools, false, "GET 必须立刻反映关闭状态");

  const turnedOn = await postVisitTools(route, { token, body: JSON.stringify({ enabled: true }) });
  assert.equal(turnedOn.status, 204);
  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort(), "开启后 4 个工具必须回来");
  assert.equal(stats.registerCalls, 8, "重开只注册一次");
  assert.equal(stats.disposeCalls, 4, "重开不应额外注销");
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
  assert.equal(stats.registerCalls, 4);
  assert.equal(stats.disposeCalls, 0);

  await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  assert.equal(stats.disposeCalls, 4, "重复关闭不得重复注销");
  assert.deepEqual(visitToolNames(registry), []);

  await postVisitTools(route, { token, body: JSON.stringify({ enabled: true }) });
  await postVisitTools(route, { token, body: JSON.stringify({ enabled: true }) });
  assert.equal(stats.registerCalls, 8, "重复开启不得重复注册");
  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort());

  await postVisitTools(route, { token, body: JSON.stringify({ enabled: false }) });
  assert.equal(stats.disposeCalls, 8, "再关一次恰好再注销一轮");
});

test("串门工具开关：config.visitTools=false 时初始不注册，POST 仍可开启", async () => {
  const { registry, stats, route } = mountControlHost({ visitTools: false });
  assert.deepEqual(visitToolNames(registry), [], "初始化关闭时一个工具都不该注册");
  assert.equal(stats.registerCalls, 0);
  let snapshot = getActivity(route);
  assert.equal(snapshot.visitTools, false);
  assert.equal(typeof snapshot.controlToken, "string");

  const turnedOn = await postVisitTools(route, { token: snapshot.controlToken, body: JSON.stringify({ enabled: true }) });
  assert.equal(turnedOn.status, 204);
  assert.deepEqual(visitToolNames(registry), KNOWN_TOOLS.slice().sort());
  assert.equal(getActivity(route).visitTools, true);
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
    ["systemPrompt", "tools", "webServer"],
    "systemPrompt / tools / webServer 三个依赖都必须走 ctx.inject"
  );
  assert.deepEqual(Object.keys(injectHost.state.tools), [], "服务没就绪前不得注册工具（旧实现的 bug）");
  assert.equal(injectHost.state.routes.length, 0, "服务没就绪前不得注册路由");
  assert.equal(injectHost.state.sections.length, 0, "服务没就绪前不得注册提示段");

  flushInjected(injectHost);
  assert.equal(Object.keys(injectHost.state.tools).length, 4, "tools 就绪后四个工具必须全部注册");
  assert.equal(injectHost.state.routes.length, 1, "webServer 就绪后路由必须注册");
  assert.equal(injectHost.state.sections.length, 1, "systemPrompt 就绪后策略段必须注册");
  assert.equal(injectHost.state.sections[0].name, "agent-whales/team-policy");

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
  assert.equal(Object.keys(registered).length, 4, "inject 不可用时必须退化为立即注册");
  assert.equal(routes.length, 1, "inject 不可用时路由也要立即注册");
});

test("宿主 apply：服务重载（作用域释放 + 重新注入）不重复注册、不泄漏", () => {
  const injectHost = makeInjectHost();
  host.apply(injectHost.ctx);
  flushInjected(injectHost);
  const toolCount = Object.keys(injectHost.state.tools).length;
  assert.equal(toolCount, 4);
  assert.equal(injectHost.state.routes.length, 1);

  disposeInjected(injectHost);
  assert.deepEqual(Object.keys(injectHost.state.tools), [], "旧作用域释放后工具必须注销");
  assert.equal(injectHost.state.routes.length, 0, "旧作用域释放后路由必须撤销");

  flushInjected(injectHost);
  assert.equal(Object.keys(injectHost.state.tools).length, toolCount, "重新注入后工具数量不变（无重复注册残留）");
  assert.equal(injectHost.state.routes.length, 1, "重新注入后路由只有一条");
});
