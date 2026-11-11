import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sessionToolCalls, sessionEvents } from "../lib/index.js";

/**
 * 观测层：从会话事件抽「最近调过哪些工具」。
 *
 * fixture 用的是**真实落盘会话**解出来的事件（~/.dsh/sessions 下的
 * session.v4.jsonl.zstd，Node 24 的 zlib.zstdDecompress 能解），不是我编的——
 * 这条数据的形状此前没人验证过，编一个「看起来对」的 fixture 等于自己骗自己。
 */
const here = dirname(fileURLToPath(import.meta.url));
const REAL_EVENTS = JSON.parse(readFileSync(join(here, "fixtures", "real-session-events.json"), "utf8"));

test("观测层：真实会话事件里能抽出工具调用，且顺序为正序", () => {
  const calls = sessionToolCalls(REAL_EVENTS, 8);
  assert.equal(calls.length, 5, "这个真实会话有 5 次 tool/call，一条都不能少");
  assert.deepEqual(calls.map((c) => c.name), ["read", "glob", "pwsh", "pwsh", "pwsh"]);
  // 正序：时间戳与 seq 都必须递增（UI 按这个顺序渲染「最近调用」）
  for (let i = 1; i < calls.length; i += 1) {
    assert.ok(calls[i].at >= calls[i - 1].at, "时间必须正序");
    assert.ok(calls[i].seq > calls[i - 1].seq, "seq 必须递增");
  }
});

test("观测层：limit 生效，且只从尾部往回取", () => {
  const two = sessionToolCalls(REAL_EVENTS, 2);
  assert.deepEqual(two.map((c) => c.name), ["pwsh", "pwsh"], "只给最后两条");
  const one = sessionToolCalls(REAL_EVENTS, 1);
  assert.deepEqual(one.map((c) => c.name), ["pwsh"], "最后一条是最近调的");
});

test("观测层：坏数据不炸，空事件给空数组", () => {
  assert.deepEqual(sessionToolCalls(undefined), []);
  assert.deepEqual(sessionToolCalls(null), []);
  assert.deepEqual(sessionToolCalls("not-array"), []);
  assert.deepEqual(sessionToolCalls([{ type: "user/message" }, { type: "step/start" }]), [], "没有 tool/call 就是空");
  // 缺 name 的 tool/call 不能进去：UI 会渲染出一个空标签
  assert.deepEqual(sessionToolCalls([{ type: "tool/call", time: 1, data: {} }]), []);
  assert.deepEqual(sessionToolCalls([{ type: "tool/call", time: 1, data: { name: "" } }]), []);
});

test("观测层：扫描有上限——大会话不能把路由拖慢", () => {
  // 造 5000 条事件，只有最早一条是 tool/call：maxScan=200 时不该找到它
  const many = [];
  for (let i = 0; i < 5000; i += 1) many.push({ type: "step/start", seq: i, time: i });
  many[0] = { type: "tool/call", seq: 0, time: 0, data: { name: "ancient" } };
  assert.deepEqual(sessionToolCalls(many, 8, 200), [], "超出扫描窗口的不找（/sessions 每 5s 轮询，不能全量扫）");
  // 窗口内要能找到
  many[4990] = { type: "tool/call", seq: 4990, time: 4990, data: { name: "recent" } };
  assert.deepEqual(sessionToolCalls(many, 8, 200).map((c) => c.name), ["recent"]);
});

test("观测层：sessionEvents 与 sessionToolCalls 能对着真实形状配合", () => {
  // sessionEvents 兼容 getter 与 snapshotEvents() 两种宿主形状
  const viaGetter = { events: REAL_EVENTS };
  const viaMethod = { snapshotEvents: () => REAL_EVENTS };
  assert.equal(sessionToolCalls(sessionEvents(viaGetter)).length, 5);
  assert.equal(sessionToolCalls(sessionEvents(viaMethod)).length, 5);
  assert.deepEqual(sessionToolCalls(sessionEvents({})), [], "读不到事件就是空，不抛");
});
