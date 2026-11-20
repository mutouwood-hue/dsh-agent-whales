/**
 * 回合级轨迹：foldTurns / renderTranscript 纯函数 + 工具面。
 *
 * 重新规划 R1：原 whales_visit_trace 已并入 whales_visit_read（trace:true）。下面「工具面」的全部用例
 * 通过一个适配器（traceOf）改走 read+trace:true，断言一条没少。
 *
 * 两条纪律照旧：
 *   · fixture 用**真实落盘会话**解出来的事件（test/fixtures/real-session-events.json），
 *     不手编「看起来对」的形状——turn/start、turn/end.reason、tool/call 与 tool/result
 *     的配对方式都是这里验证过的；
 *   · 借形上游（fengshenx/dsh-leader-agent 的 worker-transcript.js，MIT）后，
 *     分桶口径按本宿主的 source.kind 落地，偏离处在本文件里有对应用用例钉死。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { foldTurns, renderTranscript, TRACE_MAX_TURNS, TRACE_DEFAULT_TURNS } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const REAL_EVENTS = JSON.parse(readFileSync(join(here, "fixtures", "real-session-events.json"), "utf8"));

/** 宿主按「序列化 → 解析」校验工具输出；undefined/NaN/Infinity 都会失真。 */
function assertLossless(value, label = "value") {
	let text;
	assert.doesNotThrow(() => { text = JSON.stringify(value); }, label + " 必须可 JSON 序列化");
	assert.deepEqual(JSON.parse(text), value, label + " 经过 JSON.stringify 往返后必须深等价");
}

function userEvent(seq, text, kind = "user") {
	return { seq, type: "user/message", data: { source: { kind }, content: [{ type: "text", text }] } };
}

function assistantEvent(seq, text) {
	return { seq, type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } };
}

function toolCall(seq, callId, name) {
	return { seq, type: "tool/call", data: { callId, name } };
}

function toolResult(seq, callId, failed, extra = {}) {
	return {
		seq,
		type: "tool/result",
		data: { message: { toolCallId: callId, isError: failed, content: [{ type: "text", text: failed ? "Error: boom" : "ok" }] }, ...extra }
	};
}

describe("foldTurns：真实会话事件", () => {
	test("真实日志折出一个回合：用户一句、注入五条、五个工具、终态 aborted", () => {
		const { turns, running } = foldTurns(REAL_EVENTS);
		assert.equal(running, false, "有 turn/end 就不是在跑");
		assert.equal(turns.length, 1, "这个真实会话只有一个回合");
		const turn = turns[0];
		assert.equal(turn.turn, 1, "回合号取自 turn/start 的 data.turn");
		assert.deepEqual(turn.user, ["去读 tool-probe.json"], "真人输入只有这一句");
		assert.deepEqual(turn.task, [], "没有 agent-message 来源就没有任务");
		assert.equal(turn.injected, 5, "approval/instructions/runtime-context/skill-catalog/time-context 五条注入只计数");
		assert.equal(turn.assistant.length, 0, "这个会话的 assistant 只有 reasoning 与 tool-call 块，没有正文");
		assert.deepEqual(turn.end, { kind: "aborted", error: undefined }, "终态取自 turn/end 的 reason.kind");
	});

	test("工具逐个配对失败原因：FS_NOT_FOUND / TOOL_TIMEOUT / ABORTED", () => {
		const { turns } = foldTurns(REAL_EVENTS);
		const tools = turns[0].tools;
		assert.deepEqual(tools.map((tool) => tool.name), ["read", "glob", "pwsh", "pwsh", "pwsh"]);
		assert.deepEqual(tools.map((tool) => tool.failed), [true, true, false, false, true], "五次里三次失败");
		assert.deepEqual(tools.map((tool) => tool.reason), ["FS_NOT_FOUND", "TOOL_TIMEOUT", undefined, undefined, "ABORTED"]);
		// 失败原因优先取宿主 error.code（机器可读），而不是类名 FsError/ToolTimeoutError
		for (const tool of tools) {
			if (tool.failed === true) assert.ok(tool.reason !== undefined && tool.reason !== "", "失败必须带原因");
		}
	});
});

describe("foldTurns：分桶与回合边界", () => {
	test("agent-message 是任务、user 是真人、其余是注入", () => {
		const events = [
			{ seq: 1, type: "turn/start", data: { turn: 1 } },
			userEvent(2, "派活：去修 bug", "agent-message"),
			userEvent(3, "（真人）看看进度"),
			userEvent(4, "宿主注入的上下文", "agent-instructions"),
			userEvent(5, "另一条注入", "runtime-context"),
			assistantEvent(6, "修完了"),
			toolCall(7, "c1", "pwsh"),
			toolResult(8, "c1", false),
			{ seq: 9, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
		];
		const { turns, running } = foldTurns(events);
		assert.equal(running, false);
		assert.equal(turns.length, 1);
		assert.deepEqual(turns[0].task, ["派活：去修 bug"], "别的智能体派来的话进任务桶");
		assert.deepEqual(turns[0].user, ["（真人）看看进度"], "source.kind=user 才是真人");
		assert.equal(turns[0].injected, 2, "其余来源只计数，不展开");
		assert.deepEqual(turns[0].assistant, ["修完了"]);
		assert.deepEqual(turns[0].end, { kind: "completed", error: undefined });
	});

	test("最后一轮只有 turn/start：running=true 且 end 保持 undefined", () => {
		const events = [
			{ seq: 1, type: "turn/start", data: { turn: 1 } },
			assistantEvent(2, "干到一半"),
			{ seq: 3, type: "turn/start", data: { turn: 2 } },
			assistantEvent(4, "第二轮还在跑")
		];
		const { turns, running } = foldTurns(events);
		assert.equal(turns.length, 2);
		assert.equal(running, true, "最后一轮没收尾就是在跑");
		assert.equal(turns[1].end, undefined);
		assert.equal(turns[0].end, undefined, "第一轮也没收尾（进程被杀就是这样）");
	});

	test("只有 turn/end 没有 turn/start：补一段而不是丢掉", () => {
		const events = [
			assistantEvent(1, "先说了句"),
			{ seq: 2, type: "turn/end", data: { turn: 7, reason: { kind: "failed", error: { message: "模型超时" } } } }
		];
		const { turns } = foldTurns(events);
		assert.equal(turns.length, 1, "收尾事件自己也要有归属段");
		assert.equal(turns[0].turn, 7, "回合号从 end 事件补");
		assert.deepEqual(turns[0].end, { kind: "failed", error: "模型超时" }, "失败原因带 error.message");
	});

	test("没有配对的 tool/result 不丢：按 unknown 保留并带失败原因", () => {
		const events = [
			{ seq: 1, type: "turn/start", data: { turn: 1 } },
			toolResult(2, "孤儿调用", true, { error: { code: "TOOL_TIMEOUT" } }),
			{ seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
		];
		const { turns } = foldTurns(events);
		assert.equal(turns[0].tools.length, 1, "恢复路径上宿主会补写结果事件，不能丢");
		assert.equal(turns[0].tools[0].name, "unknown");
		assert.equal(turns[0].tools[0].callId, "孤儿调用");
		assert.equal(turns[0].tools[0].failed, true);
		assert.equal(turns[0].tools[0].reason, "TOOL_TIMEOUT");
	});

	test("turn/end 缺 reason 时按 unknown，不抛", () => {
		const { turns } = foldTurns([{ seq: 1, type: "turn/end", data: {} }]);
		assert.deepEqual(turns[0].end, { kind: "unknown", error: undefined });
	});

	test("坏数据不炸：空日志给空回合", () => {
		assert.deepEqual(foldTurns(undefined).turns, []);
		assert.deepEqual(foldTurns(null).turns, []);
		assert.deepEqual(foldTurns("not-array").turns, []);
		assert.deepEqual(foldTurns([null, 42, "x", {}]).turns, []);
		assert.equal(foldTurns([]).running, false);
		// 只有注入的会话也合法：一个回合、零正文
		const only = foldTurns([userEvent(1, "注入", "runtime-context")]);
		assert.equal(only.turns.length, 1);
		assert.equal(only.turns[0].injected, 1);
	});

	test("纯空白正文不进桶（注入里大量这种）", () => {
		const { turns } = foldTurns([
			{ seq: 1, type: "turn/start", data: { turn: 1 } },
			userEvent(2, "   ", "user"),
			assistantEvent(3, "\n\t"),
			userEvent(4, "真的内容"),
			{ seq: 5, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
		]);
		assert.equal(turns.length, 1);
		assert.deepEqual(turns[0].user, ["真的内容"], "纯空白既不算用户也不算任务");
		assert.deepEqual(turns[0].assistant, []);
	});
});

describe("renderTranscript：体积护栏", () => {
	test("空日志说清楚，不返回空串", () => {
		const text = renderTranscript({ turns: [], sessionId: "s1", name: "隔壁", limit: 2 });
		assert.match(text, /共 0 个回合/);
		assert.match(text, /还没有任何回合/);
	});

	test("默认 turns 与上限导出值对得上（工具入参校验用同一组常量）", () => {
		assert.equal(TRACE_DEFAULT_TURNS, 2);
		assert.equal(TRACE_MAX_TURNS, 20);
	});

	test("超出 turns 窗口的更早回合标注「调大 turns 可以多看」", () => {
		const turns = [];
		for (let index = 1; index <= 5; index += 1) {
			turns.push({ turn: index, task: [], user: ["第 " + index + " 轮"], injected: 0, assistant: [], tools: [], end: { kind: "completed", error: undefined } });
		}
		const text = renderTranscript({ turns, sessionId: "s1", name: undefined, limit: 2, running: false });
		assert.match(text, /以下是最新的 2 个/, "只渲染窗口内");
		assert.match(text, /更早的 3 个回合超出 turns=2 的范围/);
		assert.match(text, /调大 turns 可以多看更早的回合/);
		assert.ok(!text.includes("第 1 轮"), "窗口外的不出现");
		assert.ok(text.includes("第 5 轮"), "最新的要出现");
	});

	test("总量上限丢弃更早的选中回合，并说明调 turns 取不回来", () => {
		// 造 6 个回合，每个约 3000 字符：总量上限 12000 只装得下最近的几个
		const turns = [];
		for (let index = 1; index <= 6; index += 1) {
			turns.push({
				turn: index,
				task: [],
				user: ["第 " + index + " 轮 " + "x".repeat(3000)],
				injected: 0,
				assistant: [],
				tools: [],
				end: { kind: "completed", error: undefined }
			});
		}
		const text = renderTranscript({ turns, sessionId: "s1", name: "s1", limit: 20, running: false });
		assert.match(text, /以下是最新的 \d+ 个/, "装下几个就展示几个");
		assert.match(text, /因正文超出单次读取上限被丢弃/);
		assert.match(text, /总量上限固定，调 turns 取不到这些回合/);
		assert.ok(text.length < 12000 + 400, "整段不许超总量太多（含标注），实际 " + text.length);
	});

	test("最新一回合自己就超限：截断它而不是整次读取空手而归", () => {
		const turns = [{
			turn: 1,
			task: [],
			user: ["y".repeat(30000)],
			injected: 0,
			assistant: [],
			tools: [],
			end: { kind: "completed", error: undefined }
		}];
		const text = renderTranscript({ turns, sessionId: "s1", name: "s1", limit: 2, running: false });
		assert.match(text, /已截断，原长 30000 字符/);
		assert.ok(text.includes("## 回合 1"), "仍然看得到这一轮的结构");
	});

	test("截断不留下孤立代理对（切在 emoji 中间也不出 U+FFFD）", () => {
		// 1999 个 a + 一个 emoji（2 个码元）= 2001 码元；上限 2000 的切点正落在高代理
		const turns = [{
			turn: 1,
			task: [],
			user: ["a".repeat(1999) + "😀"],
			injected: 0,
			assistant: [],
			tools: [],
			end: { kind: "completed", error: undefined }
		}];
		const text = renderTranscript({ turns, sessionId: "s1", name: "s1", limit: 1, running: false });
		assert.ok(!text.includes("\uFFFD"), "不能出现替换字符");
		assert.ok(text.includes("a".repeat(1999)), "码点边界之前的内容完整保留");
		assert.ok(!text.includes("😀"), "被切掉的半个 emoji 不出现");
	});

	test("running 时在头部标注「最后一轮仍在执行中」", () => {
		const turns = [{ turn: 1, task: [], user: ["在跑"], injected: 0, assistant: [], tools: [], end: undefined }];
		const text = renderTranscript({ turns, sessionId: "s1", name: "s1", limit: 2, running: true });
		assert.match(text, /最后一轮仍在执行中，内容可能不完整/);
		assert.match(text, /## 回合 1 · 进行中/);
	});
});

// ── 工具面：whales_visit_read(trace:true) ────────────────────────────────────────────
//
// 与 whales_visit_read 的分工：read 给「谁说了什么」的文本行（只读活会话），
// trace 给回合结构（走 sessionQuery，活会话读内存、离线会话读盘，都不唤醒）。

import * as host from "../lib/index.js";

// host.apply 会顺手装 worker preset：不把目标根指到临时目录就会往真实 ~/.dsh 写文件
// （生产行为，不该由单元测试触发）。
process.env.DSH_AGENT_WHALES_PRESET_DIR = mkdtempSync(join(tmpdir(), "aw-trace-presets-"));

/** 每个用例一条临时目录：store 是进程级单例，别把脏数据带给同进程的其它文件。 */
function isolatedStore(tag) {
	const dir = mkdtempSync(join(tmpdir(), "aw-trace-" + tag + "-"));
	host.setProjectStorePathForTests(join(dir, "projects.json"));
	host.setProposalStorePathForTests(join(dir, "proposals.json"));
	return dir;
}

/** 造一个只提供 tools / agents / sessionQuery 的假宿主，收集注册到的工具。 */
function mountTraceHost({ live = new Map(), query } = {}) {
	const registered = {};
	host.apply({
		get: (name) => {
			if (name === "tools") return { register: (tool) => { registered[tool.name] = tool; return () => {}; } };
			if (name === "agents") return { get: (id) => live.get(id), list: () => [] };
			if (name === "sessionQuery") return query;
			return undefined;
		},
		on: () => () => {},
		effect: (run) => { run(); return () => {}; }
	});
	return registered;
}

/**
 * 原 whales_visit_trace 的调用形状 → 合并后的 whales_visit_read(trace:true)。
 * execute 补上 trace:true；output 直接用 read 的（read 的 render 能渲染轨迹形状）。
 */
function traceOf(registered) {
	const read = registered.whales_visit_read;
	assert.ok(read, "read 工具必须注册（trace 已并入它）");
	assert.equal(registered.whales_visit_trace, undefined, "trace 工具已不再单独注册");
	return { execute: (args, exec) => read.execute(Object.assign({}, args, { trace: true }), exec), output: read.output, parameters: read.parameters };
}

/** 一个跑完的会话：一轮、两句用户、一次失败工具。 */
function finishedEvents() {
	return [
		{ seq: 1, type: "turn/start", data: { turn: 1 } },
		userEvent(2, "去修 bug"),
		assistantEvent(3, "在看了"),
		toolCall(4, "c1", "pwsh"),
		toolResult(5, "c1", true, { error: { code: "TOOL_TIMEOUT" } }),
		assistantEvent(6, "超时了，换条路"),
		{ seq: 7, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
	];
}

describe("whales_visit_read(trace:true)：读取路径", () => {
	test("走 sessionQuery.readSession：活会话读内存、离线会话也能读，且不唤醒", async () => {
		const dir = isolatedStore("query");
		try {
			const calls = [];
			const query = {
				readSession: async (sessionId) => {
					calls.push(sessionId);
					return { session: { id: sessionId }, inheritedEventCount: 0, events: finishedEvents() };
				}
			};
			const registered = mountTraceHost({ query });
			const tool = traceOf(registered);
			assert.ok(tool, "trace（read 的 trace 模式）必须可用");

			// 目标会话根本不在 agents 里（离线）：只有 sessionQuery 能读到
			const result = await tool.execute({ sessionId: "s-offline" }, { agent: { id: "caller" } });
			assert.deepEqual(calls, ["s-offline"], "读取走 sessionQuery");
			assert.equal(result.totalTurns, 1);
			assert.equal(result.running, false);
			assert.equal(result.name, "去修 bug", "没有 session/title 时名字回落首条用户消息（与列表工具同一口径）");
			assert.match(result.text, /## 回合 1 · completed/);
			assert.match(result.text, /pwsh（失败：TOOL_TIMEOUT）/);
			assert.match(result.text, /超时了，换条路/);
			assertLossless(result, "whales_visit_read(trace)");
			assert.equal(tool.output.render({}, result).length, 1, "render 给一个 text block");
			assert.equal(tool.output.render({}, result)[0].type, "text");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("标题来自 session/title 事件，name 进输出", async () => {
		const dir = isolatedStore("title");
		try {
			const events = [{ seq: 1, type: "session/title", data: { title: "修 bug 的会话" } }, ...finishedEvents()];
			const registered = mountTraceHost({ query: { readSession: async () => ({ events }) } });
			const result = await traceOf(registered).execute({ sessionId: "s1" }, { agent: { id: "caller" } });
			assert.equal(result.name, "修 bug 的会话");
			assert.match(result.text, /会话 s1（修 bug 的会话）/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("没有 sessionQuery 服务时退到活会话的内存快照（与 read 同一条路）", async () => {
		const dir = isolatedStore("memory");
		try {
			const live = new Map([["s-live", { id: "s-live", session: { events: finishedEvents() } }]]);
			const registered = mountTraceHost({ live, query: undefined });
			const result = await traceOf(registered).execute({ sessionId: "s-live" }, { agent: { id: "caller" } });
			assert.equal(result.totalTurns, 1);
			assert.match(result.text, /pwsh（失败：TOOL_TIMEOUT）/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("活会话也没有、又没有 sessionQuery：说清该先 resume", async () => {
		const dir = isolatedStore("neither");
		try {
			const registered = mountTraceHost({ live: new Map(), query: undefined });
			await assert.rejects(
				() => traceOf(registered).execute({ sessionId: "s-gone" }, { agent: { id: "caller" } }),
				/whales_visit_resume/,
				"必须指出补救动作"
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readSession 抛错原样上抛：会话不存在不能说成「什么都没做」", async () => {
		const dir = isolatedStore("throw");
		try {
			const registered = mountTraceHost({
				query: { readSession: async () => { throw new Error("no such session"); } }
			});
			await assert.rejects(
				() => traceOf(registered).execute({ sessionId: "s-missing" }, { agent: { id: "caller" } }),
				/no such session/
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readSession 返回形状不对（缺 events）时大声报错，不静默当空日志", async () => {
		const dir = isolatedStore("shape");
		try {
			const registered = mountTraceHost({ query: { readSession: async () => ({ session: {} }) } });
			await assert.rejects(
				() => traceOf(registered).execute({ sessionId: "s-bad" }, { agent: { id: "caller" } }),
				/缺 events 数组/
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("whales_visit_read(trace:true)：入参与访问闸", () => {
	test("turns 默认 2、范围 1..20，字符串/小数/越界一律拒绝", async () => {
		const dir = isolatedStore("args");
		try {
			const registered = mountTraceHost({ query: { readSession: async () => ({ events: finishedEvents() }) } });
			const tool = traceOf(registered);
			await assert.rejects(() => tool.execute({ sessionId: "s1", turns: "3" }, { agent: { id: "caller" } }), /1 到 20 的整数/);
			await assert.rejects(() => tool.execute({ sessionId: "s1", turns: 1.5 }, { agent: { id: "caller" } }), /1 到 20 的整数/);
			await assert.rejects(() => tool.execute({ sessionId: "s1", turns: 0 }, { agent: { id: "caller" } }), /1 到 20 的整数/);
			await assert.rejects(() => tool.execute({ sessionId: "s1", turns: 21 }, { agent: { id: "caller" } }), /1 到 20 的整数/);
			await assert.rejects(() => tool.execute({ sessionId: "  " }, { agent: { id: "caller" } }), /不能为空/);
			await assert.rejects(() => tool.execute({}, { agent: { id: "caller" } }), /不能为空/);
			// 合法的边界值放行
			const ok = await tool.execute({ sessionId: "s1", turns: 20 }, { agent: { id: "caller" } });
			assert.equal(ok.totalTurns, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("拿不到执行上下文身份 → 40301（与 read/send 同权，不静默跳过闸）", async () => {
		const dir = isolatedStore("identity");
		try {
			const registered = mountTraceHost({ query: { readSession: async () => ({ events: finishedEvents() }) } });
			await assert.rejects(
				() => traceOf(registered).execute({ sessionId: "s1" }, {}),
				/40301/
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("访问闸：同项目无关联线 40707、跨项目 40704、双方都不在项目里放行", async () => {
		const dir = isolatedStore("gate");
		try {
			writeFileSync(join(dir, "projects.json"), JSON.stringify({
				projects: {
					p1: {
						projectId: "p1",
						name: "甲",
						mainSessionId: "session-a",
						members: [{ sessionId: "session-a" }, { sessionId: "session-b" }],
						links: [],
						revision: 1
					},
					p2: {
						projectId: "p2",
						name: "乙",
						mainSessionId: "session-c",
						members: [{ sessionId: "session-c" }],
						links: [],
						revision: 1
					}
				}
			}), "utf8");
			const registered = mountTraceHost({ query: { readSession: async () => ({ events: finishedEvents() }) } });
			const tool = traceOf(registered);

			// 同项目、都是成员、但没有关联线 → 40707
			await assert.rejects(
				() => tool.execute({ sessionId: "session-b" }, { agent: { id: "session-a" } }),
				/40707/,
				"读轨迹和读对话同权：没有关联线就不能读"
			);
			// 跨项目 → 40704
			await assert.rejects(
				() => tool.execute({ sessionId: "session-c" }, { agent: { id: "session-a" } }),
				/40704/
			);
			// 一方在项目里、一方不在 → 40703
			await assert.rejects(
				() => tool.execute({ sessionId: "session-x" }, { agent: { id: "session-a" } }),
				/40703/
			);
			// 双方都不在任何项目里 → 旧串门行为不变（放行）
			const legacy = await tool.execute({ sessionId: "session-y" }, { agent: { id: "session-x" } });
			assert.equal(legacy.totalTurns, 1, "非项目会话之间保持旧行为");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
