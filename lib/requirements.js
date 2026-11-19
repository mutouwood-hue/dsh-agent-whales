/**
 * 需求主线（设计稿：docs/plans/需求主线-业务流设计.md）的纯逻辑层：数据模型清洗 + 阶段推导。
 *
 * 全部是纯函数，不碰文件、不碰宿主、不取当前时间（时间由调用方传入），方便离线单测。
 * 宿主路由与存储在 lib/index.js，这里只回答两件事：
 *   1) 一份需求记录应该长什么样（清洗输入 / 补默认值）；
 *   2) 一个需求现在处于哪个阶段（只看事实，不靠手填）。
 *
 * 阶段是「推出来」的——和 wbAgentSteps 同一思路，界面说的永远等于事实：
 *   澄清 clarify   没有原型帧，也没有任务
 *   设计 design    有原型帧，但没确认过，或确认之后又被改过
 *   开发 develop   已确认设计（或根本不需要设计）；任务还没全部「已完工」
 *   验收 accept    任务全部已完工；E2E 还没对当前设计版本给出结论
 *   不符 mismatch  最近一次 E2E 有失败，还没处理
 *   通过 passed    最近一次 E2E 对当前设计版本全部通过
 */

export const REQ_STAGES = ["clarify", "design", "develop", "accept", "mismatch", "passed"];
export const REQ_STAGE_LABEL = { clarify: "澄清", design: "设计", develop: "开发", accept: "验收", mismatch: "不符", passed: "通过" };
export const REQ_STAGE_TONE = { clarify: "neutral", design: "info", develop: "info", accept: "warn", mismatch: "bad", passed: "ok" };

/** 老数据（没有 requirementId 的任务 / 原型帧）归入的虚拟需求。不落库，读时派生。 */
export const UNASSIGNED_REQ_ID = "unassigned";

export const REQ_LIMITS = {
	title: 80,
	goal: 2000,
	acceptanceItems: 20,
	acceptanceLength: 200,
	reworkCapMin: 1,
	reworkCapMax: 10,
	reworkCapDefault: 3
};

/** E2E 单条用例的「算通过」状态：accepted = 用户标了「可接受」。 */
const RESULT_PASS = ["passed", "accepted"];

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toMs(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value !== "") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : NaN;
	}
	return NaN;
}

function finiteOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ── 输入清洗 ───────────────────────────────────────────────────────────────────

/**
 * 清洗「建 / 改需求」的请求体。partial=true（PATCH）时缺省的字段不报错、也不出现在结果里。
 * 返回 { value } 或 { error }。过长的标题 / 目标直接拒绝（用户看得见的文字不悄悄截断）。
 */
export function cleanRequirementInput(payload, options) {
	const partial = Boolean(options && options.partial);
	if (!isPlainObject(payload)) return { error: "body must be an object" };
	const value = {};
	if (payload.title !== undefined || !partial) {
		const title = typeof payload.title === "string" ? payload.title.trim() : "";
		if (title === "") return { error: "title is required" };
		if (title.length > REQ_LIMITS.title) return { error: "title exceeds " + REQ_LIMITS.title + " chars" };
		value.title = title;
	}
	if (payload.goal !== undefined) {
		if (typeof payload.goal !== "string") return { error: "goal must be a string" };
		const goal = payload.goal.trim();
		if (goal.length > REQ_LIMITS.goal) return { error: "goal exceeds " + REQ_LIMITS.goal + " chars" };
		value.goal = goal;
	}
	if (payload.acceptance !== undefined) {
		if (!Array.isArray(payload.acceptance)) return { error: "acceptance must be an array of strings" };
		const items = [];
		for (const raw of payload.acceptance) {
			if (typeof raw !== "string") return { error: "acceptance must be an array of strings" };
			const text = raw.trim();
			if (text !== "") items.push(text.slice(0, REQ_LIMITS.acceptanceLength));
		}
		if (items.length > REQ_LIMITS.acceptanceItems) return { error: "acceptance has more than " + REQ_LIMITS.acceptanceItems + " items" };
		value.acceptance = items;
	}
	if (payload.reworkCap !== undefined) {
		const cap = payload.reworkCap;
		if (!Number.isInteger(cap) || cap < REQ_LIMITS.reworkCapMin || cap > REQ_LIMITS.reworkCapMax) {
			return { error: "reworkCap must be an integer in " + REQ_LIMITS.reworkCapMin + ".." + REQ_LIMITS.reworkCapMax };
		}
		value.reworkCap = cap;
	}
	if (payload.composerSessionId !== undefined) {
		if (typeof payload.composerSessionId !== "string") return { error: "composerSessionId must be a string" };
		const composer = payload.composerSessionId.trim();
		if (composer !== "") value.composerSessionId = composer;
	}
	return { value };
}

/** 新建一条需求记录。id 与时间由调用方给（保持纯函数）。 */
export function newRequirementRecord(args) {
	const input = args.input || {};
	return {
		reqId: args.reqId,
		projectId: args.projectId,
		title: input.title,
		goal: typeof input.goal === "string" ? input.goal : "",
		acceptance: Array.isArray(input.acceptance) ? input.acceptance : [],
		composerSessionId: typeof args.composerSessionId === "string" ? args.composerSessionId : "",
		revision: 1,
		// 设计版本：0 = 没确认过。快照在 P2（确认设计）才会写入。
		designVersion: 0,
		designConfirmedAt: null,
		designVersions: [],
		reworkCount: 0,
		reworkCap: Number.isInteger(input.reworkCap) ? input.reworkCap : REQ_LIMITS.reworkCapDefault,
		createdAt: args.now,
		updatedAt: args.now
	};
}

/** 读 store 时的防御：补默认值、丢掉类型不对的字段，坏数据不炸。 */
export function normalizeRequirement(raw) {
	if (!isPlainObject(raw) || typeof raw.reqId !== "string" || raw.reqId === "") return undefined;
	const cap = Number.isInteger(raw.reworkCap) && raw.reworkCap >= REQ_LIMITS.reworkCapMin && raw.reworkCap <= REQ_LIMITS.reworkCapMax
		? raw.reworkCap : REQ_LIMITS.reworkCapDefault;
	return {
		reqId: raw.reqId,
		projectId: typeof raw.projectId === "string" ? raw.projectId : "",
		title: typeof raw.title === "string" ? raw.title : "",
		goal: typeof raw.goal === "string" ? raw.goal : "",
		acceptance: Array.isArray(raw.acceptance) ? raw.acceptance.filter((item) => typeof item === "string") : [],
		composerSessionId: typeof raw.composerSessionId === "string" ? raw.composerSessionId : "",
		revision: Number.isInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1,
		designVersion: Number.isInteger(raw.designVersion) && raw.designVersion >= 0 ? raw.designVersion : 0,
		designConfirmedAt: raw.designConfirmedAt === null || raw.designConfirmedAt === undefined ? null : raw.designConfirmedAt,
		designVersions: Array.isArray(raw.designVersions) ? raw.designVersions : [],
		reworkCount: Number.isInteger(raw.reworkCount) && raw.reworkCount >= 0 ? raw.reworkCount : 0,
		reworkCap: cap,
		createdAt: finiteOr(raw.createdAt, 0),
		updatedAt: finiteOr(raw.updatedAt, 0)
	};
}

// ── 事实读取 ───────────────────────────────────────────────────────────────────

/** 任务是否「已完工」：已报完工（report.status === "done"）或状态已是 completed。已删除不算任务。 */
export function isTaskDone(task) {
	if (!isPlainObject(task) || task.status === "deleted") return false;
	if (task.status === "completed") return true;
	return isPlainObject(task.report) && task.report.status === "done";
}

/** 元素（原型帧 / 流程图）归属哪个需求：顶层 requirementId 优先，其次 data.requirementId。 */
export function elementRequirementId(element) {
	if (!isPlainObject(element)) return "";
	if (typeof element.requirementId === "string" && element.requirementId !== "") return element.requirementId;
	if (isPlainObject(element.data) && typeof element.data.requirementId === "string") return element.data.requirementId;
	return "";
}

/** 一次 E2E 运行的结论：none / pending / passed / failed / error。 */
export function runOutcome(run) {
	if (!isPlainObject(run)) return "none";
	if (run.status === "queued" || run.status === "running") return "pending";
	if (run.status === "error") return "error";
	const results = Array.isArray(run.results) ? run.results.filter(isPlainObject) : [];
	if (results.some((item) => item.status === "failed")) return "failed";
	if (results.length > 0) return results.every((item) => RESULT_PASS.indexOf(item.status) >= 0) ? "passed" : "pending";
	if (run.status === "passed") return "passed";
	if (run.status === "failed") return "failed";
	return "pending";
}

function runStartedAt(run) {
	const at = toMs(run && (run.startedAt !== undefined ? run.startedAt : run.createdAt));
	return Number.isFinite(at) ? at : 0;
}

/** 对某个设计版本最近一次运行（没有则 undefined）。 */
export function latestRunForVersion(runs, designVersion) {
	let best;
	for (const run of Array.isArray(runs) ? runs : []) {
		if (!isPlainObject(run) || run.designVersion !== designVersion) continue;
		if (best === undefined || runStartedAt(run) >= runStartedAt(best)) best = run;
	}
	return best;
}

function failedResultCount(run) {
	return (Array.isArray(run && run.results) ? run.results : []).filter((item) => isPlainObject(item) && item.status === "failed").length;
}

// ── 阶段推导 ───────────────────────────────────────────────────────────────────

/**
 * 推导一个需求的阶段。输入全是事实：
 *   requirement   需求记录（designVersion / designConfirmedAt / reworkCount / reworkCap）
 *   prototypes    [{ id, updatedAt }]  归属本需求的原型帧
 *   tasks         归属本需求的任务（含 status / report）
 *   runs          归属本需求的 E2E 运行
 *   virtual       true = 「未归类」虚拟需求：没有设计版本和 E2E，只按任务判断
 * 返回 { stage, next, attention, evidence }。attention 是「需要你处理」的类型（给待办用）。
 */
export function deriveStage(input) {
	const requirement = input.requirement || {};
	const prototypes = Array.isArray(input.prototypes) ? input.prototypes : [];
	const tasks = (Array.isArray(input.tasks) ? input.tasks : []).filter((task) => isPlainObject(task) && task.status !== "deleted");
	const runs = Array.isArray(input.runs) ? input.runs : [];
	const virtual = Boolean(input.virtual);
	const designVersion = Number.isInteger(requirement.designVersion) ? requirement.designVersion : 0;
	const confirmedAt = toMs(requirement.designConfirmedAt);
	const taskTotal = tasks.length;
	const taskDone = tasks.filter(isTaskDone).length;

	// 已确认之后又被改（或新增）的原型帧；从没确认过，则所有原型帧都算「待确认」。
	const dirtyPrototypes = prototypes.filter((proto) => {
		if (designVersion === 0 || !Number.isFinite(confirmedAt)) return true;
		const updated = toMs(proto && proto.updatedAt);
		return Number.isFinite(updated) && updated > confirmedAt;
	}).length;

	const reworkCount = Number.isInteger(requirement.reworkCount) ? requirement.reworkCount : 0;
	const reworkCap = Number.isInteger(requirement.reworkCap) ? requirement.reworkCap : REQ_LIMITS.reworkCapDefault;
	const evidence = {
		prototypeCount: prototypes.length,
		dirtyPrototypeCount: dirtyPrototypes,
		designVersion: designVersion,
		taskTotal: taskTotal,
		taskDone: taskDone,
		runCount: runs.length,
		latestRun: null,
		reworkCount: reworkCount,
		reworkCap: reworkCap,
		needsHuman: false,
		staleRun: false
	};
	const result = (stage, next, attention) => ({ stage: stage, next: next, attention: attention === undefined ? null : attention, evidence: evidence });

	if (virtual) {
		if (taskTotal === 0) return result("clarify", "还没有归到需求的任务；新任务会按需求归组");
		if (taskDone < taskTotal) return result("develop", "任务 " + taskDone + "/" + taskTotal + " 已完工");
		return result("passed", "旧任务都已完工，无需处理");
	}

	// 1) 设计：有原型帧，但没确认过 / 确认后又被改过。优先级最高——设计没定，后面都不作数。
	if (prototypes.length > 0 && dirtyPrototypes > 0) {
		return result("design", designVersion === 0 ? "确认原型，再推进开发" : "原型在 v" + designVersion + " 之后有改动，确认新版本再继续", "confirm-design");
	}
	// 2) 澄清：什么都还没有。
	if (prototypes.length === 0 && taskTotal === 0 && designVersion === 0) {
		return result("clarify", "继续和 Composer 聊清需求，再画原型或提交提案");
	}
	// 3) 开发：还没建任务，或任务没全部完工。
	if (taskTotal === 0) return result("develop", "确认提案，建任务");
	if (taskDone < taskTotal) return result("develop", "任务 " + taskDone + "/" + taskTotal + " 已完工，等待其余任务");

	// 4) 任务全部完工 → 看 E2E 对「当前设计版本」的结论。
	const run = latestRunForVersion(runs, designVersion);
	if (run === undefined) {
		evidence.staleRun = runs.length > 0;
		return result("accept", evidence.staleRun ? "设计版本已更新，需要重新运行 E2E" : "任务全部完工，待运行 E2E");
	}
	const outcome = runOutcome(run);
	evidence.latestRun = { runId: typeof run.runId === "string" ? run.runId : "", status: typeof run.status === "string" ? run.status : "", outcome: outcome, designVersion: designVersion };
	if (outcome === "passed") return result("passed", "无需处理");
	if (outcome === "failed") {
		const failed = failedResultCount(run);
		evidence.needsHuman = reworkCount >= reworkCap;
		return result(
			"mismatch",
			evidence.needsHuman
				? "已返工 " + reworkCount + " 次仍不符，建议回到需求重新评审"
				: (failed > 0 ? failed + " 项不符，" : "") + "在截图上批注后回流返工",
			evidence.needsHuman ? "rework-limit" : "e2e-mismatch"
		);
	}
	if (outcome === "error") return result("accept", "E2E 运行出错，检查环境后重跑");
	return result("accept", "E2E 运行中");
}

// ── 视图（读路由用）────────────────────────────────────────────────────────────

function maxMs(values) {
	let best = 0;
	for (const value of values) {
		const ms = toMs(value);
		if (Number.isFinite(ms) && ms > best) best = ms;
	}
	return best;
}

/** 一个需求（或虚拟需求）→ 对外视图：记录字段 + 推导出的阶段与证据 + 计数。 */
export function requirementView(requirement, facts, options) {
	const virtual = Boolean(options && options.virtual);
	const prototypes = facts.prototypes || [];
	const flows = facts.flows || [];
	const tasks = facts.tasks || [];
	const runs = facts.runs || [];
	const derived = deriveStage({ requirement: requirement, prototypes: prototypes, tasks: tasks, runs: runs, virtual: virtual });
	return {
		reqId: requirement.reqId,
		projectId: requirement.projectId,
		title: requirement.title,
		goal: requirement.goal,
		acceptance: requirement.acceptance,
		composerSessionId: requirement.composerSessionId,
		virtual: virtual,
		revision: requirement.revision,
		designVersion: requirement.designVersion,
		designConfirmedAt: requirement.designConfirmedAt,
		reworkCount: requirement.reworkCount,
		reworkCap: requirement.reworkCap,
		stage: derived.stage,
		stageLabel: REQ_STAGE_LABEL[derived.stage],
		tone: REQ_STAGE_TONE[derived.stage],
		next: derived.next,
		attention: derived.attention,
		evidence: derived.evidence,
		counts: {
			prototypes: prototypes.length,
			flows: flows.length,
			tasks: derived.evidence.taskTotal,
			tasksDone: derived.evidence.taskDone,
			runs: runs.length
		},
		taskIds: tasks.filter((task) => task && task.status !== "deleted").map((task) => task.taskId),
		prototypeIds: prototypes.map((item) => item.id),
		flowIds: flows.map((item) => item.id),
		createdAt: requirement.createdAt,
		updatedAt: Math.max(
			finiteOr(requirement.updatedAt, 0),
			maxMs(tasks.map((task) => task && task.updatedAt)),
			maxMs(prototypes.map((item) => item.updatedAt)),
			maxMs(flows.map((item) => item.updatedAt))
		)
	};
}

function protoFact(element) {
	return { id: element.id, updatedAt: element.updatedAt };
}

/**
 * 一个项目下全部需求的视图列表。
 *   requirements  该项目已存的需求记录
 *   tasks         该项目的任务（含已删除，这里过滤）
 *   elements      该项目画布页的元素（取 kind=prototype / flow）
 *   runs          该项目的 E2E 运行
 * 没有归到任何需求的任务 / 原型帧（老数据，或 requirementId 指向已不存在的需求）并入虚拟「未归类」；
 * 一个都没有就不出现。排序：虚拟需求垫底，其余按最近更新倒序。
 */
export function buildRequirementViews(args) {
	const projectId = args.projectId;
	const records = (Array.isArray(args.requirements) ? args.requirements : [])
		.map(normalizeRequirement)
		.filter((item) => item !== undefined && item.projectId === projectId);
	const known = new Set(records.map((item) => item.reqId));
	const tasks = (Array.isArray(args.tasks) ? args.tasks : []).filter((task) => isPlainObject(task) && task.status !== "deleted");
	const elements = Array.isArray(args.elements) ? args.elements : [];
	const runs = Array.isArray(args.runs) ? args.runs : [];

	const belongs = (reqId) => (id) => id === reqId;
	const taskReq = (task) => (typeof task.requirementId === "string" ? task.requirementId : "");
	const views = records.map((record) => requirementView(record, {
		tasks: tasks.filter((task) => belongs(record.reqId)(taskReq(task))),
		prototypes: elements.filter((el) => isPlainObject(el) && el.kind === "prototype" && elementRequirementId(el) === record.reqId).map(protoFact),
		flows: elements.filter((el) => isPlainObject(el) && el.kind === "flow" && elementRequirementId(el) === record.reqId).map(protoFact),
		runs: runs.filter((run) => isPlainObject(run) && run.requirementId === record.reqId)
	}));
	views.sort((a, b) => b.updatedAt - a.updatedAt);

	const orphanTasks = tasks.filter((task) => !known.has(taskReq(task)));
	const orphanElements = elements.filter((el) => isPlainObject(el) && (el.kind === "prototype" || el.kind === "flow") && !known.has(elementRequirementId(el)));
	if (orphanTasks.length > 0 || orphanElements.length > 0) {
		const virtualRecord = normalizeRequirement({ reqId: UNASSIGNED_REQ_ID, projectId: projectId, title: "未归类", revision: 1 });
		views.push(requirementView(virtualRecord, {
			tasks: orphanTasks,
			prototypes: orphanElements.filter((el) => el.kind === "prototype").map(protoFact),
			flows: orphanElements.filter((el) => el.kind === "flow").map(protoFact),
			runs: []
		}, { virtual: true }));
	}
	return views;
}
