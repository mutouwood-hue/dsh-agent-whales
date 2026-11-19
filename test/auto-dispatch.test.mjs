/**
 * 第二期 X1–X3 策略层：档位 / 配置校验 / 速率并发深度闸门 / 审批决定 / 审计。
 * 纯函数，不依赖宿主。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_AUTO_CONFIG,
	AUDIT_MAX_ENTRIES,
	appendAudit,
	approvalDecision,
	approvalGrantTask,
	AUTO_APPROVAL_RUN_WINDOW_MS,
	buildAuditEntry,
	createAutoGate,
	normalizeAutoConfig,
	planDispatch,
	validateAutoConfigPatch
} from "../lib/auto-dispatch.js";

test("默认配置：L2、5 秒撤销、审批停等、3/5/10", () => {
	assert.deepEqual(normalizeAutoConfig(undefined), DEFAULT_AUTO_CONFIG);
	assert.equal(DEFAULT_AUTO_CONFIG.tier, "L2");
	assert.equal(DEFAULT_AUTO_CONFIG.undoWindowMs, 5000);
	assert.equal(DEFAULT_AUTO_CONFIG.approval, "wait");
	assert.equal(DEFAULT_AUTO_CONFIG.perMemberPerMinute, 3);
	assert.equal(DEFAULT_AUTO_CONFIG.projectConcurrent, 5);
	assert.equal(DEFAULT_AUTO_CONFIG.maxChainDepth, 10);
});

test("normalize：非法值回落默认，L3 只在明确写了才出现", () => {
	assert.equal(normalizeAutoConfig({ tier: "L9" }).tier, "L2");
	assert.equal(normalizeAutoConfig({ tier: "l3" }).tier, "L2");
	assert.equal(normalizeAutoConfig({ tier: "L3" }).tier, "L3");
	assert.equal(normalizeAutoConfig({ approval: "yes" }).approval, "wait");
	assert.equal(normalizeAutoConfig({ perMemberPerMinute: -4 }).perMemberPerMinute, 1);
	assert.equal(normalizeAutoConfig({ projectConcurrent: 1e9 }).projectConcurrent, 200);
	assert.equal(normalizeAutoConfig({ maxChainDepth: "x" }).maxChainDepth, 10);
	assert.equal(normalizeAutoConfig(null).tier, "L2");
});

test("validate：非法输入明确拒绝并指出字段，不悄悄改值", () => {
	const bad = validateAutoConfigPatch({}, { tier: "L4" });
	assert.equal(bad.ok, false);
	assert.equal(bad.field, "tier");
	assert.equal(validateAutoConfigPatch({}, { approval: "maybe" }).field, "approval");
	assert.equal(validateAutoConfigPatch({}, { perMemberPerMinute: 0 }).field, "perMemberPerMinute");
	assert.equal(validateAutoConfigPatch({}, { maxChainDepth: 2.5 }).field, "maxChainDepth");
	assert.equal(validateAutoConfigPatch({}, { undoWindowMs: "5000" }).field, "undoWindowMs");
	assert.equal(validateAutoConfigPatch({}, null).ok, false);
});

test("validate：合法 patch 与现有配置合并，未提及字段保持不变", () => {
	const r = validateAutoConfigPatch({ tier: "L3", approval: "approve-all" }, { perMemberPerMinute: 6 });
	assert.equal(r.ok, true);
	assert.equal(r.config.tier, "L3");
	assert.equal(r.config.approval, "approve-all");
	assert.equal(r.config.perMemberPerMinute, 6);
	assert.equal(r.config.projectConcurrent, 5);
});

test("planDispatch：L1 手动、L2 延迟撤销窗口、L3 立即", () => {
	assert.deepEqual(planDispatch({ tier: "L1", undoWindowMs: 5000 }), { mode: "manual", delayMs: 0 });
	assert.deepEqual(planDispatch({ tier: "L2", undoWindowMs: 8000 }), { mode: "delayed", delayMs: 8000 });
	assert.deepEqual(planDispatch({ tier: "L3", undoWindowMs: 5000 }), { mode: "immediate", delayMs: 0 });
});

test("approvalDecision：默认停等不批准；全部同意才放行且要审计", () => {
	assert.deepEqual(approvalDecision({ approval: "wait" }), { action: "wait", audit: false });
	assert.deepEqual(approvalDecision({ approval: "approve-all" }), { action: "approve", audit: true });
});

test("闸门：每成员每分钟 3 条，第 4 条被拒并给出重试时间，一分钟后恢复", () => {
	let t = 1_000_000;
	const gate = createAutoGate(() => t);
	const cfg = { ...DEFAULT_AUTO_CONFIG, projectConcurrent: 100 };
	for (let i = 0; i < 3; i += 1) {
		assert.equal(gate.acquire("p", "a", cfg).ok, true);
		gate.release("p");
		t += 1000;
	}
	const denied = gate.acquire("p", "a", cfg);
	assert.equal(denied.ok, false);
	assert.equal(denied.reason, "rate");
	assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60000);
	// 另一个成员不受影响
	assert.equal(gate.acquire("p", "b", cfg).ok, true);
	t += 60000;
	assert.equal(gate.acquire("p", "a", cfg).ok, true);
});

test("闸门：项目同时 5 条，第 6 条被拒，release 后可再进", () => {
	const gate = createAutoGate(() => 0);
	const cfg = { ...DEFAULT_AUTO_CONFIG, perMemberPerMinute: 100 };
	for (let i = 0; i < 5; i += 1) assert.equal(gate.acquire("p", "m" + i, cfg).ok, true);
	const denied = gate.acquire("p", "m9", cfg);
	assert.deepEqual(denied, { ok: false, reason: "concurrent" });
	gate.release("p");
	assert.equal(gate.acquire("p", "m9", cfg).ok, true);
	// 另一个项目独立计数
	assert.equal(gate.acquire("q", "m1", cfg).ok, true);
});

test("闸门：连锁深度到上限即拒，非法深度当作拒绝", () => {
	const gate = createAutoGate(() => 0);
	const cfg = DEFAULT_AUTO_CONFIG;
	assert.equal(gate.acquire("p", "a", cfg, 9).ok, true);
	assert.deepEqual(gate.acquire("p", "b", cfg, 10), { ok: false, reason: "depth" });
	assert.equal(gate.acquire("p", "c", cfg, -1).ok, false);
	assert.equal(gate.acquire("p", "d", cfg, 1.5).ok, false);
});

test("闸门：cancel 归还并发名额和速率额度；release 多调用不出现负数", () => {
	const gate = createAutoGate(() => 0);
	const cfg = { ...DEFAULT_AUTO_CONFIG, perMemberPerMinute: 1 };
	assert.equal(gate.acquire("p", "a", cfg).ok, true);
	assert.equal(gate.acquire("p", "a", cfg).reason, "rate");
	gate.cancel("p", "a");
	assert.equal(gate.inflightOf("p"), 0);
	assert.equal(gate.acquire("p", "a", cfg).ok, true);
	gate.release("p");
	gate.release("p");
	gate.release("p");
	assert.equal(gate.inflightOf("p"), 0);
});

test("审计条目：只含元数据，字段截断，非法档位清空", () => {
	const e = buildAuditEntry(
		{ kind: "auto-dispatch", projectId: "p", sessionId: "s", taskId: "t", tier: "L9", approval: "approve-all", outcome: "sent", reason: "x".repeat(500), depth: 3, secret: "sk-123" },
		() => Date.UTC(2026, 10, 18)
	);
	assert.equal(e.at, "2026-11-18T00:00:00.000Z");
	assert.equal(e.tier, "");
	assert.equal(e.approval, "approve-all");
	assert.equal(e.reason.length, 120);
	assert.equal(e.depth, 3);
	assert.equal("secret" in e, false);
});

test("审计列表：超过上限丢最旧", () => {
	let list = [];
	for (let i = 0; i < AUDIT_MAX_ENTRIES + 5; i += 1) list = appendAudit(list, { n: i });
	assert.equal(list.length, AUDIT_MAX_ENTRIES);
	assert.equal(list[0].n, 5);
	assert.equal(list[list.length - 1].n, AUDIT_MAX_ENTRIES + 4);
	assert.deepEqual(appendAudit(undefined, { n: 1 }), [{ n: 1 }]);
});

const grantProject = (auto, extra = {}) => Object.assign({ mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-w" }], auto }, extra);
const SENT_AT = 1_000_000;
const autoTask = (over = {}) => Object.assign({ taskId: "t1", ownerSessionId: "s-w", status: "in_progress", dispatch: { auto: true, at: SENT_AT } }, over);
/** 成员此刻这一轮的开始时间：followup 一到空闲成员就开跑，所以与送出时刻只差几毫秒。 */
const RUN_NOW = { runStartedAt: SENT_AT + 40 };

test("全部同意授权：只命中项目成员名下、自动派发出去、且这一轮就是那条消息引出的在办任务", () => {
	const project = grantProject({ tier: "L2", approval: "approve-all" });
	assert.equal(approvalGrantTask(project, [autoTask()], "s-w", RUN_NOW).taskId, "t1");
	assert.equal(approvalGrantTask(project, [autoTask({ ownerSessionId: "s-main" })], "s-main", RUN_NOW).taskId, "t1", "主对话也算成员");
});

test("全部同意授权：未配置、L1、手动派的任务、已完成、非成员、坏入参一律不授权", () => {
	const on = grantProject({ tier: "L2", approval: "approve-all" });
	assert.equal(approvalGrantTask(grantProject({ tier: "L2" }), [autoTask()], "s-w", RUN_NOW), undefined, "默认停在等你");
	assert.equal(approvalGrantTask(grantProject({ tier: "L1", approval: "approve-all" }), [autoTask()], "s-w", RUN_NOW), undefined, "L1 不批");
	assert.equal(approvalGrantTask(on, [autoTask({ dispatch: {} })], "s-w", RUN_NOW), undefined, "用户手动派的不在授权内");
	assert.equal(approvalGrantTask(on, [autoTask({ dispatch: undefined })], "s-w", RUN_NOW), undefined);
	assert.equal(approvalGrantTask(on, [autoTask({ status: "completed" })], "s-w", RUN_NOW), undefined, "已完成的不再授权");
	assert.equal(approvalGrantTask(on, [autoTask({ ownerSessionId: "s-other" })], "s-w", RUN_NOW), undefined, "别人的任务不算");
	assert.equal(approvalGrantTask(on, [autoTask({ ownerSessionId: "s-x" })], "s-x", RUN_NOW), undefined, "非项目成员");
	for (const bad of [undefined, null, "", 7]) assert.equal(approvalGrantTask(on, [autoTask()], bad, RUN_NOW), undefined);
	assert.equal(approvalGrantTask(undefined, [autoTask()], "s-w", RUN_NOW), undefined);
	assert.equal(approvalGrantTask(on, undefined, "s-w", RUN_NOW), undefined);
	assert.equal(approvalGrantTask(on, [null, undefined], "s-w", RUN_NOW), undefined);
});

// 2026-11-18 真机验证：成员做完任务没人标完成，任务一直「在办」。原先之后这个会话里发生的任何事都被放行，
// 包括人手动发的话。下面这几条就是那个洞：本轮不是那条自动派发的消息引出的，就不批。
test("全部同意授权：这一轮不是那条消息引出的（之后人手动发的话、别的轮次）→ 不批", () => {
	const on = grantProject({ tier: "L3", approval: "approve-all" });
	assert.equal(approvalGrantTask(on, [autoTask()], "s-w", { runStartedAt: SENT_AT + 60_000 }), undefined, "一分钟后开始的轮次");
	assert.equal(approvalGrantTask(on, [autoTask()], "s-w", { runStartedAt: SENT_AT + 31_000 }), undefined, "超过窗口一点点也不批");
	assert.equal(approvalGrantTask(on, [autoTask()], "s-w", { runStartedAt: SENT_AT + 30_000 }).taskId, "t1", "窗口边界内批");
	assert.equal(approvalGrantTask(on, [autoTask()], "s-w", { runStartedAt: SENT_AT - 5_000 }), undefined, "早于送出的轮次（那是别的话引出的）");
	assert.equal(approvalGrantTask(on, [autoTask()], "s-w", { runStartedAt: SENT_AT - 1_000 }).taskId, "t1", "时钟抖动容差 1 秒");
});

test("全部同意授权：拿不到本轮开始时间（没在跑 / 没记录 / 脏值）一律不批——宁可多问一次", () => {
	const on = grantProject({ tier: "L3", approval: "approve-all" });
	for (const run of [undefined, null, {}, { runStartedAt: undefined }, { runStartedAt: "1000040" }, { runStartedAt: NaN }, { runStartedAt: Infinity }]) {
		assert.equal(approvalGrantTask(on, [autoTask()], "s-w", run), undefined, JSON.stringify(run));
	}
	assert.equal(approvalGrantTask(on, [autoTask()], "s-w"), undefined, "不传第四个参数 = 没有本轮信息 = 不批");
});

test("全部同意授权：派发记录没有送出时刻（老数据 / 脏值）不批；多条候选取送出最晚且这一轮对得上的那条", () => {
	const on = grantProject({ tier: "L3", approval: "approve-all" });
	assert.equal(approvalGrantTask(on, [autoTask({ dispatch: { auto: true } })], "s-w", RUN_NOW), undefined, "没有 at");
	assert.equal(approvalGrantTask(on, [autoTask({ dispatch: { auto: true, at: "x" } })], "s-w", RUN_NOW), undefined, "at 不是数字");
	const old = autoTask({ taskId: "old", dispatch: { auto: true, at: SENT_AT - 600_000 } });
	const fresh = autoTask({ taskId: "fresh", dispatch: { auto: true, at: SENT_AT } });
	assert.equal(approvalGrantTask(on, [old, fresh], "s-w", RUN_NOW).taskId, "fresh", "旧任务的送出时刻对不上，只认新的");
	const a = autoTask({ taskId: "a", dispatch: { auto: true, at: SENT_AT } });
	const b = autoTask({ taskId: "b", dispatch: { auto: true, at: SENT_AT + 500 } });
	assert.equal(approvalGrantTask(on, [a, b], "s-w", RUN_NOW).taskId, "b", "两条都对得上时取送出最晚的，审计写它");
});

test("全部同意授权：窗口常量是 30 秒（改它要同时想清楚代价）", () => {
	assert.equal(AUTO_APPROVAL_RUN_WINDOW_MS, 30000);
});