/**
 * 第二期 X1–X3：唤醒后自动派任务的策略层（纯函数 + 小状态机，不碰宿主、不碰磁盘）。
 *
 * 决定来源（需求负责人，2026-11-18，记录在 Notion「第二期决策」）：
 *   - 软化「agent / 插件不得自动提交」：允许「用户逐条授权」的唤醒后自动派任务。
 *   - 档位：L1 不自动派；L2 默认，有撤销窗口；L3 立即执行，必须由项目主动选。
 *   - 自动派发遇到审批：默认停在「等你」；项目可选「全部同意」，并写审计。
 *   - 初始限额：每成员每分钟 3 条、项目同时 5 条、连锁 10 层；可配置，后续可放宽。
 *
 * 这里只回答「该不该派、还要等多久、为什么不派」，真正的 resume / followup 在 index.js。
 */

export const AUTO_TIERS = Object.freeze(["L1", "L2", "L3"]);
export const APPROVAL_MODES = Object.freeze(["wait", "approve-all"]);

export const DEFAULT_AUTO_CONFIG = Object.freeze({
	tier: "L2",
	undoWindowMs: 5000,
	approval: "wait",
	perMemberPerMinute: 3,
	projectConcurrent: 5,
	maxChainDepth: 10
});

/** 各项上下界：防止配置写成 0 / 负数 / 天文数字把闸门变成摆设或把系统卡死。 */
const LIMITS = Object.freeze({
	undoWindowMs: [1000, 60000],
	perMemberPerMinute: [1, 600],
	projectConcurrent: [1, 200],
	maxChainDepth: [1, 100]
});

function clampInt(value, [min, max], fallback) {
	const n = typeof value === "number" ? value : Number.NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 把项目里存的原始配置归一成完整配置。任何非法值回落到默认，而不是抛错：
 * 读盘时遇到旧项目（没有这个字段）或被手改坏的值，都必须得到一个安全的 L2 配置。
 * L3 只在原始值明确写了 "L3" 时才出现——不会因为别的字段缺失而被推断出来。
 */
export function normalizeAutoConfig(raw) {
	const src = raw !== null && typeof raw === "object" ? raw : {};
	const d = DEFAULT_AUTO_CONFIG;
	return {
		tier: AUTO_TIERS.includes(src.tier) ? src.tier : d.tier,
		undoWindowMs: clampInt(src.undoWindowMs, LIMITS.undoWindowMs, d.undoWindowMs),
		approval: APPROVAL_MODES.includes(src.approval) ? src.approval : d.approval,
		perMemberPerMinute: clampInt(src.perMemberPerMinute, LIMITS.perMemberPerMinute, d.perMemberPerMinute),
		projectConcurrent: clampInt(src.projectConcurrent, LIMITS.projectConcurrent, d.projectConcurrent),
		maxChainDepth: clampInt(src.maxChainDepth, LIMITS.maxChainDepth, d.maxChainDepth)
	};
}

/**
 * 一次配置更新请求 → 校验后的 patch。和 normalize 不同：用户明确传了非法值要告诉他，
 * 不能悄悄改成默认值（否则界面显示 L3、实际是 L2，是谎报）。
 * @returns {{ ok: true, config: object } | { ok: false, field: string, reason: string }}
 */
export function validateAutoConfigPatch(current, patch) {
	if (patch === null || typeof patch !== "object") return { ok: false, field: "", reason: "body must be an object" };
	const next = Object.assign({}, normalizeAutoConfig(current));
	if (patch.tier !== undefined) {
		if (!AUTO_TIERS.includes(patch.tier)) return { ok: false, field: "tier", reason: "tier must be L1, L2 or L3" };
		next.tier = patch.tier;
	}
	if (patch.approval !== undefined) {
		if (!APPROVAL_MODES.includes(patch.approval)) return { ok: false, field: "approval", reason: "approval must be wait or approve-all" };
		next.approval = patch.approval;
	}
	for (const key of Object.keys(LIMITS)) {
		if (patch[key] === undefined) continue;
		const [min, max] = LIMITS[key];
		const v = patch[key];
		if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
			return { ok: false, field: key, reason: key + " must be an integer in [" + min + ", " + max + "]" };
		}
		next[key] = v;
	}
	return { ok: true, config: next };
}

/**
 * 速率 / 并发 / 深度闸门。状态放内存：重启后清零是可接受的（限额的目的是挡失控的连锁，
 * 不是计费），而且比把计数写盘更不容易因崩溃留下「永远占着名额」的脏状态。
 *
 * @param {() => number} [now] 注入时钟，测试用
 */
export function createAutoGate(now = Date.now) {
	/** @type {Map<string, number[]>} key = projectId + "\u0000" + sessionId，值 = 最近一分钟内的派发时间戳 */
	const sent = new Map();
	/** @type {Map<string, number>} projectId → 正在进行（已受理、未结束）的条数 */
	const inflight = new Map();
	const WINDOW_MS = 60000;

	function recent(key) {
		const t = now();
		const list = (sent.get(key) || []).filter((ts) => t - ts < WINDOW_MS);
		if (list.length === 0) sent.delete(key);
		else sent.set(key, list);
		return list;
	}

	return {
		/**
		 * 申请一个名额。通过则立即占用（并发 +1、记一条时间戳），调用方必须在结束时 release。
		 * 拒绝时给出稳定的 reason 码，界面按码翻译，不拼接自然语言。
		 * @returns {{ ok: true } | { ok: false, reason: "depth" | "rate" | "concurrent", retryAfterMs?: number }}
		 */
		acquire(projectId, sessionId, cfg, depth = 0) {
			if (!Number.isInteger(depth) || depth < 0 || depth >= cfg.maxChainDepth) return { ok: false, reason: "depth" };
			if ((inflight.get(projectId) || 0) >= cfg.projectConcurrent) return { ok: false, reason: "concurrent" };
			const key = projectId + "\u0000" + sessionId;
			const list = recent(key);
			if (list.length >= cfg.perMemberPerMinute) {
				return { ok: false, reason: "rate", retryAfterMs: Math.max(0, WINDOW_MS - (now() - list[0])) };
			}
			list.push(now());
			sent.set(key, list);
			inflight.set(projectId, (inflight.get(projectId) || 0) + 1);
			return { ok: true };
		},
		/** 结束一个名额。多调用不会把计数减成负数。 */
		release(projectId) {
			const n = (inflight.get(projectId) || 0) - 1;
			if (n <= 0) inflight.delete(projectId);
			else inflight.set(projectId, n);
		},
		/**
		 * 撤销：名额的并发部分归还，同时把那条速率时间戳也退掉——被用户撤回的派发
		 * 实际没有发出，不该占用该成员的每分钟额度。
		 */
		cancel(projectId, sessionId) {
			this.release(projectId);
			const key = projectId + "\u0000" + sessionId;
			const list = sent.get(key);
			if (list && list.length > 0) {
				list.pop();
				if (list.length === 0) sent.delete(key);
			}
		},
		inflightOf(projectId) {
			return inflight.get(projectId) || 0;
		}
	};
}

/**
 * 按档位决定一条「唤醒后派发」怎么执行。
 *   L1 → 不自动：返回 manual，调用方只唤醒，不派。
 *   L2 → 先挂起 undoWindowMs，窗口内可撤销，到点再派。
 *   L3 → 立即派。
 */
export function planDispatch(cfg) {
	if (cfg.tier === "L1") return { mode: "manual", delayMs: 0 };
	if (cfg.tier === "L3") return { mode: "immediate", delayMs: 0 };
	return { mode: "delayed", delayMs: cfg.undoWindowMs };
}

/**
 * 自动派发遇到审批请求时怎么办。
 *   wait        → 不替用户批准，成员停在「等你」，由用户在界面决定。
 *   approve-all → 项目已明确选择「全部同意」：放行，但每次都必须写审计。
 */
export function approvalDecision(cfg) {
	return cfg.approval === "approve-all"
		? { action: "approve", audit: true }
		: { action: "wait", audit: false };
}

/**
 * 审计条目：一律只含元数据（谁、什么时候、什么档位、结果码），不含任务正文和密钥。
 * 字段值做长度截断，避免把一条超长错误信息原样落盘。
 */
export function buildAuditEntry(input, now = Date.now) {
	const cut = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
	return {
		at: new Date(now()).toISOString(),
		kind: cut(input.kind, 40),
		projectId: cut(input.projectId, 80),
		sessionId: cut(input.sessionId, 80),
		taskId: cut(input.taskId, 80),
		tier: AUTO_TIERS.includes(input.tier) ? input.tier : "",
		approval: APPROVAL_MODES.includes(input.approval) ? input.approval : "",
		outcome: cut(input.outcome, 40),
		reason: cut(input.reason, 120),
		depth: Number.isInteger(input.depth) && input.depth >= 0 ? input.depth : 0
	};
}

/**
 * 自动派发的消息送出后，成员那一轮最晚多久内开始才算「就是这条消息引出的那一轮」。
 * 空闲成员收到 followup 是立刻开跑的（真机实测同一秒）；30 秒留给宿主调度的抖动。
 * 超过这个窗口开始的轮次（用户之后手动发的话、排在别的轮次后面的 followup、后台任务回流）一律不算。
 */
export const AUTO_APPROVAL_RUN_WINDOW_MS = 30000;

/**
 * 「全部同意」到底批准谁：只批准同时满足下面所有条件的请求，其余一律返回 undefined（交回原回答者，停在「等你」）。
 *   - 项目配置了 approval = approve-all 且档位不是 L1；
 *   - 请求来自项目成员会话；
 *   - 该会话名下有一条「在办」任务，它的派发记录带 auto: true（自动派发送出）和 at（送出时刻）；
 *   - **成员此刻这一轮就是那条消息引出的**：本轮开始时间落在 [at − 1s, at + 30s] 内。
 * 最后一条是真机验证（2026-11-18）补上的。原先只看「有一条自动派发的在办任务」：
 * 成员做完了任务却没人标完成，这条任务就一直在办，之后这个会话里发生的任何事——
 * 包括别的任务、包括人手动发的话——都被「全部同意」放行。现在没有本轮开始时间（拿不到、或没有在跑）就不批。
 * 用户手动派的任务、已完成的任务、不在项目里的会话，都不在授权范围内。
 * 多条候选时取送出最晚的一条，审计据此写对任务。返回命中的任务；没命中返回 undefined。
 *
 * @param {object} project
 * @param {object[]} tasks
 * @param {string} sessionId
 * @param {{ runStartedAt?: number }} run 成员此刻这一轮的开始时间（宿主 agent/status 事件记的）
 */
export function approvalGrantTask(project, tasks, sessionId, run) {
	if (project === undefined || project === null || typeof sessionId !== "string" || sessionId === "") return undefined;
	const startedAt = run && typeof run.runStartedAt === "number" && Number.isFinite(run.runStartedAt) ? run.runStartedAt : undefined;
	if (startedAt === undefined) return undefined;
	const cfg = normalizeAutoConfig(project.auto);
	if (cfg.approval !== "approve-all" || cfg.tier === "L1") return undefined;
	const isMember = sessionId === project.mainSessionId
		|| (Array.isArray(project.members) && project.members.some((member) => member && member.sessionId === sessionId));
	if (!isMember) return undefined;
	const list = Array.isArray(tasks) ? tasks : [];
	let best;
	for (const task of list) {
		if (!task || task.ownerSessionId !== sessionId || task.status !== "in_progress") continue;
		const dispatch = task.dispatch;
		if (!dispatch || dispatch.auto !== true || typeof dispatch.at !== "number" || !Number.isFinite(dispatch.at)) continue;
		if (startedAt < dispatch.at - 1000 || startedAt > dispatch.at + AUTO_APPROVAL_RUN_WINDOW_MS) continue;
		if (best === undefined || dispatch.at > best.dispatch.at) best = task;
	}
	return best;
}

/** 审计列表上限：超出时丢最旧的，防止 projects.json 无限增长。 */
export const AUDIT_MAX_ENTRIES = 200;
export function appendAudit(list, entry) {
	const base = Array.isArray(list) ? list : [];
	const next = base.concat([entry]);
	return next.length > AUDIT_MAX_ENTRIES ? next.slice(next.length - AUDIT_MAX_ENTRIES) : next;
}
