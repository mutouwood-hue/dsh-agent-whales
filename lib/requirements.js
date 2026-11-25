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

import { createHash } from "node:crypto";

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
	reworkCapDefault: 3,
	sessionId: 128
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
	// 需求负责人：用户指定的某一个对话。空串 = 清除（PATCH 时有意义），所以「给了空串」和「没给」是两回事；
	// null 不当成清除——要清除就显式给空串，免得客户端 bug 悄悄清掉负责人。是否项目成员由宿主路由校验。
	if (payload.ownerSessionId !== undefined) {
		if (typeof payload.ownerSessionId !== "string") return { error: "ownerSessionId must be a string" };
		const owner = payload.ownerSessionId.trim();
		if (owner.length > REQ_LIMITS.sessionId) return { error: "ownerSessionId exceeds " + REQ_LIMITS.sessionId + " chars" };
		value.ownerSessionId = owner;
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
		ownerSessionId: typeof input.ownerSessionId === "string" ? input.ownerSessionId : "",
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
		ownerSessionId: typeof raw.ownerSessionId === "string" ? raw.ownerSessionId : "",
		revision: Number.isInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1,
		designVersion: Number.isInteger(raw.designVersion) && raw.designVersion >= 0 ? raw.designVersion : 0,
		designConfirmedAt: raw.designConfirmedAt === null || raw.designConfirmedAt === undefined ? null : raw.designConfirmedAt,
		designVersions: Array.isArray(raw.designVersions) ? raw.designVersions : [],
		// 确认设计时记下的组件内容哈希（P3 审计 B2）：漏了它，脏判定就只能按时间比，
		// 人点一下保存（内容没变）也会让用到它的需求回「设计」。
		...(isPlainObject(raw.designComponentHashes) ? { designComponentHashes: raw.designComponentHashes } : {}),
		reworkCount: Number.isInteger(raw.reworkCount) && raw.reworkCount >= 0 ? raw.reworkCount : 0,
		reworkCap: cap,
		// 回流记录（E2E 不符时人发起的反馈）与「返工完成后要重跑」标记（P5）。
		feedback: Array.isArray(raw.feedback) ? raw.feedback.filter(isPlainObject) : [],
		rerunPending: raw.rerunPending === true,
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
	const taskTotal = tasks.length;
	const taskDone = tasks.filter(isTaskDone).length;

	// 已确认之后又被改（或新增）的原型帧；从没确认过，则所有原型帧都算「待确认」。
	// 脏判定：传了 designItems（原型帧 + 画板 + 组件传导）就用统一口径，否则退回只看原型帧（老调用方不变）
	const designItems = Array.isArray(input.designItems) ? input.designItems : undefined;
	const dirtyList = designItems === undefined
		? dirtyPrototypeIds(requirement, prototypes).map((id) => ({ id: id, reason: "self" }))
		: dirtyDesignItems(requirement, designItems);
	const dirtyPrototypes = dirtyList.length;
	const dirtyReason = dirtyDesignReasonText(dirtyList);


	const reworkCount = Number.isInteger(requirement.reworkCount) ? requirement.reworkCount : 0;
	const reworkCap = Number.isInteger(requirement.reworkCap) ? requirement.reworkCap : REQ_LIMITS.reworkCapDefault;
	const evidence = {
		prototypeCount: prototypes.length,
		designCount: designItems === undefined ? prototypes.length : designItems.length,
		dirtyPrototypeCount: dirtyPrototypes,
		...(dirtyReason !== "" ? { dirtyReason: dirtyReason } : {}),
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

	// 1) 设计：有设计产物（原型帧**或画板**），但没确认过 / 确认后又被改过。优先级最高——设计没定，后面都不作数。
	// P3 审计 B3：原来只看 prototypes.length > 0，导致「只有画板」的需求永远推进不到「设计」
	//（脏了也不提示、直接落到 clarify / develop）。这里与 checkDesignConfirmable 用同一份口径。
	const designTotal = designItems === undefined ? prototypes.length : designItems.length;
	if (designTotal > 0 && dirtyPrototypes > 0) {
		return result(
		"design",
		designVersion === 0
			? "确认原型，再推进开发"
			: (dirtyReason !== "" && /因组件/.test(dirtyReason) ? dirtyReason + "：确认新版本再继续" : "原型在 v" + designVersion + " 之后有改动，确认新版本再继续"),
		"confirm-design"
	);
	}
	// 2) 澄清：什么都还没有（设计产物也没有）。
	if (designTotal === 0 && taskTotal === 0 && designVersion === 0) {
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

// ── 确认设计版本（P2）──────────────────────────────────────────────────────────
//
// 「确认并推进」= 把这个需求名下的原型帧 / 流程图当前内容固化成一个新版本（快照），之后：
//   · 任务按确认时的版本号建出来（任务.designVersion），E2E 用例也对着版本号；
//   · 确认后原型帧再被改动 → 阶段回到「设计」，必须确认新版本（deriveStage 靠 updatedAt 比较，不需要额外标记）。
// 只有人能确认（路由要同源 token，agent 没有对应工具）——和提案同口径：人看过才算。

/** 保留快照内容的版本数；更早的版本只留元数据（时间 / 哈希 / 计数），避免 store 无限膨胀。 */
export const DESIGN_KEEP_SNAPSHOTS = 5;
export const DESIGN_MAX_VERSIONS = 200;

function stableStringify(value) {
	if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
	if (isPlainObject(value)) {
		return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
	}
	return JSON.stringify(value === undefined ? null : value);
}

/** 快照哈希：内容一样哈希一样（键序无关），用来在界面上说「这个版本和上一个有没有区别」。 */
export function designSnapshotHash(snapshot) {
	return createHash("sha256").update(stableStringify(snapshot)).digest("hex").slice(0, 16);
}

/** 该需求名下的原型帧（kind=prototype）。 */
export function prototypesOfRequirement(elements, reqId) {
	return (Array.isArray(elements) ? elements : []).filter((el) => isPlainObject(el) && el.kind === "prototype" && elementRequirementId(el) === reqId);
}

/**
 * 该需求名下的**画板**（kind=artboard，设计方案 §11）。
 * 画板和原型帧在「确认设计」这件事上是同一类东西：都是需求的设计产物，确认后改动要回到「设计」阶段。
 * 额外带 `uses`（这个画板 import 的项目组件名），用来把「组件改了」传导成「画板脏了」。
 */
export function artboardsOfRequirement(elements, reqId) {
	return (Array.isArray(elements) ? elements : []).filter((el) => isPlainObject(el) && el.kind === "artboard" && elementRequirementId(el) === reqId);
}

/**
 * 一个需求名下**全部设计产物**（原型帧 + 画板），统一成 `{ id, kind, updatedAt, uses }`。
 * 确认设计、脏判定都走它，这样两条产物的口径永远一致（不会出现「画板忘了算」）。
 */
export function designItemsOfRequirement(elements, reqId) {
	const list = Array.isArray(elements) ? elements.filter(isPlainObject) : [];
	const out = [];
	for (const el of prototypesOfRequirement(list, reqId)) out.push({ id: el.id, kind: "prototype", updatedAt: el.updatedAt, uses: [] });
	for (const el of artboardsOfRequirement(list, reqId)) {
		const data = isPlainObject(el.data) ? el.data : {};
		const uses = Array.isArray(data.uses) ? data.uses.filter((name) => typeof name === "string") : [];
		out.push({ id: el.id, kind: "artboard", updatedAt: el.updatedAt, uses: uses });
	}
	return out;
}

/**
 * 固化用的快照：该需求名下全部原型帧（标题 / 宽度 / Puck 数据）+ 流程图（节点与连线的文字、形状）。
 * 只取内容，不取坐标 / 时间戳 / 来源——同样的设计换个位置不该算新版本。
 */
export function buildDesignSnapshot(elements, reqId, options) {
	const list = Array.isArray(elements) ? elements.filter(isPlainObject) : [];
	// 组件内容哈希（可选，设计方案 §11 要求 components[name] 带 sourceHash 供脏判定用）
	const hashes = isPlainObject(options && options.componentHashes) ? options.componentHashes : {};
	const prototypes = {};
	for (const el of prototypesOfRequirement(list, reqId)) {
		const data = isPlainObject(el.data) ? el.data : {};
		prototypes[el.id] = { title: typeof data.title === "string" ? data.title : "", width: data.width === "mobile" ? "mobile" : "desktop", puck: data.puck === undefined ? null : data.puck };
	}
	const flows = {};
	for (const group of list.filter((el) => isFlowGroup(el) && elementRequirementId(el) === reqId)) {
		const flowId = typeof group.data.flowId === "string" ? group.data.flowId : group.id;
		const inFlow = (el) => isPlainObject(el.data) && el.data.flowId === flowId;
		flows[group.id] = {
			title: typeof group.data.title === "string" ? group.data.title : "",
			nodes: list.filter((el) => el.kind === "flow" && inFlow(el)).map((el) => ({ key: el.data.key, shape: el.data.shape, text: el.data.text })).sort((a, b) => String(a.key).localeCompare(String(b.key))),
			edges: list.filter((el) => el.kind === "edge" && inFlow(el)).map((el) => ({ from: el.data.fromKey, to: el.data.toKey, label: el.data.label || "" })).sort((a, b) => (a.from + ">" + a.to).localeCompare(b.from + ">" + b.to))
		};
	}
	// 画板（设计方案 §11）：标题 / 宽度 / 跳转关系 / 源码哈希 / 用到的组件。
	// 不收源码全文（源码在磁盘上，快照只记「是哪个版本」），否则 store 会被源码撑爆。
	const artboards = {};
	for (const el of artboardsOfRequirement(list, reqId)) {
		const data = isPlainObject(el.data) ? el.data : {};
		artboards[el.id] = {
			title: typeof data.title === "string" ? data.title : "",
			width: data.width === "mobile" ? "mobile" : "desktop",
			sourceHash: typeof data.sourceHash === "string" ? data.sourceHash : "",
			links: Array.isArray(data.links) ? data.links.filter((value) => typeof value === "string").sort() : [],
			uses: Array.isArray(data.uses) ? data.uses.filter((value) => typeof value === "string").sort() : []
		};
	}
	// 被本需求画板 / 原型帧**用到**的项目组件（设计方案 §11：只收用到的，不收全项目）。
	const components = {};
	for (const name of Object.keys(artboards)) {
		// §11 原文要求 `components[name] = { sourceHash }`：脏判定要按**内容哈希**而不是 updatedAt，
		// 否则人点一下保存（内容没变）就会让用到它的需求永久回「设计」（P3 审计 B2）。
		for (const used of artboards[name].uses) components[used] = components[used] || (typeof hashes[used] === "string" ? { sourceHash: hashes[used] } : {});
	}
	// 原型帧也可能通过 Puck 的 project:* 用到组件（P1 的 §10），一并收进来
	for (const el of prototypesOfRequirement(list, reqId)) {
		const puck = isPlainObject(el.data) ? el.data.puck : undefined;
		if (puck === undefined || puck === null) continue;
		(function walk(node) {
			if (!node || typeof node !== "object") return;
			if (Array.isArray(node)) { for (const child of node) walk(child); return; }
			// Puck 节点里项目组件写的是 type: "project:<Name>"（设计方案 §10）
			if (typeof node.type === "string" && node.type.indexOf("project:") === 0) {
				const name = node.type.slice("project:".length);
				if (name !== "") components[name] = components[name] || (typeof hashes[name] === "string" ? { sourceHash: hashes[name] } : {});
			}
			for (const key of Object.keys(node)) {
				if (key === "type") continue;
				walk(node[key]);
			}
		})(puck);
	}
	return { prototypes: prototypes, flows: flows, artboards: artboards, components: components };
}

/** 自上次确认以来有改动（或从没确认过）的原型帧 id。 */
export function dirtyPrototypeIds(requirement, prototypes) {
	const designVersion = Number.isInteger(requirement && requirement.designVersion) ? requirement.designVersion : 0;
	const confirmedAt = toMs(requirement && requirement.designConfirmedAt);
	return (Array.isArray(prototypes) ? prototypes : []).filter((proto) => {
		if (designVersion === 0 || !Number.isFinite(confirmedAt)) return true;
		const updated = toMs(proto && proto.updatedAt);
		return Number.isFinite(updated) && updated > confirmedAt;
	}).map((proto) => (isPlainObject(proto) ? proto.id : undefined));
}

/**
 * 脏判定的统一入口（设计方案 §11）：入参是 `designItemsOfRequirement()` 的输出，
 * 每项 `{ id, kind, updatedAt, uses, componentUpdatedAt? }`。
 *
 * 一个画板的「有效 updatedAt」= max(它自己, 它用到的组件)——**改了共享组件，用到它的需求要回到「设计」**。
 * 这是有意的（组件改了，用它的页面就该重新看一眼），界面上要能说清「因组件 X 改动」。
 *
 * @returns {{ id, kind, updatedAt, reason, cause? }[]} reason = "self" | "component"；cause = 组件名
 */
export function dirtyDesignItems(requirement, items) {
	const designVersion = Number.isInteger(requirement && requirement.designVersion) ? requirement.designVersion : 0;
	const confirmedAt = toMs(requirement && requirement.designConfirmedAt);
	const out = [];
	for (const item of Array.isArray(items) ? items : []) {
		if (!isPlainObject(item)) continue;
		if (designVersion === 0 || !Number.isFinite(confirmedAt)) {
			out.push({ id: item.id, kind: item.kind, updatedAt: item.updatedAt, reason: "self" });
			continue;
		}
		const own = toMs(item.updatedAt);
		if (Number.isFinite(own) && own > confirmedAt) {
			out.push({ id: item.id, kind: item.kind, updatedAt: item.updatedAt, reason: "self" });
			continue;
		}
		// 组件改动传导：用到它的画板 / 原型帧也算脏。
		// 判据优先用**内容哈希**（P3 审计 B2）：`updatedAt` 每次写盘都刷新，人点一下保存（内容一个字没变）
		// 就会让全部用到它的需求回「设计」——那不是「组件改了」，是「组件被碰过」。
		//   · byComponent 里给了 `{ name: { sourceHash } }` 且快照也记了 hash → 只在 hash 变了时算脏；
		//   · 只有时间戳（老数据 / 没记快照 hash）→ 退回按时间比。
		const byComponent = isPlainObject(item.byComponent) ? item.byComponent : {};
		const snapshotHashes = isPlainObject(requirement && requirement.designComponentHashes) ? requirement.designComponentHashes : {};
		let cause = "";
		let latest = 0;
		for (const name of Object.keys(byComponent)) {
			const info = byComponent[name];
			const infoIsObject = isPlainObject(info);
			const currentHash = infoIsObject && typeof info.sourceHash === "string" ? info.sourceHash : "";
			const confirmedHash = typeof snapshotHashes[name] === "string" ? snapshotHashes[name] : "";
			if (currentHash !== "" && confirmedHash !== "") {
				// 两边都有哈希：以内容为准（内容没变就不算脏，哪怕文件被重写过）
				if (currentHash !== confirmedHash) { cause = name; break; }
				continue;
			}
			const at = toMs(infoIsObject ? info.updatedAt : info);
			if (Number.isFinite(at) && at > confirmedAt && at >= latest) { latest = at; cause = name; }
		}
		if (cause !== "") out.push({ id: item.id, kind: item.kind, updatedAt: item.updatedAt, reason: "component", cause: cause });
	}
	return out;
}

/**
 * 能不能确认：没有任何设计产物（原型帧 + 画板）不能确认；已确认过且之后没有改动，也没必要重新确认。
 * 第三个参数可选：传了就用 `dirtyDesignItems` 的统一口径（能认组件改动传导）。
 */
export function checkDesignConfirmable(requirement, prototypes, designItems) {
	const list = Array.isArray(prototypes) ? prototypes : [];
	const items = Array.isArray(designItems) ? designItems : undefined;
	if (list.length === 0 && (items === undefined || items.length === 0)) return "这个需求下还没有原型帧或画板，没有可确认的设计";
	const dirty = items === undefined ? dirtyPrototypeIds(requirement, list) : dirtyDesignItems(requirement, items);
	const designVersion = Number.isInteger(requirement && requirement.designVersion) ? requirement.designVersion : 0;
	if (designVersion > 0 && dirty.length === 0) return "自 v" + designVersion + " 以来设计没有改动，不需要重新确认";
	return undefined;
}

/** 给界面用的一句话：为什么脏（设计方案 §11「界面上要写清『因组件 X 改动』」）。 */
export function dirtyDesignReasonText(dirty) {
	const list = Array.isArray(dirty) ? dirty : [];
	if (list.length === 0) return "";
	const byComponent = list.filter((row) => row && row.reason === "component");
	if (byComponent.length === 0) return list.length + " 处设计有改动";
	const causes = [...new Set(byComponent.map((row) => String(row.cause || "")))].filter(Boolean);
	return "因组件 " + causes.slice(0, 3).join("、") + (causes.length > 3 ? " 等" : "") + " 改动，用到它的 " + byComponent.length + " 处设计需要重新确认";
}

/**
 * 确认：返回一份新的需求记录（纯函数，不改入参）。版本号 +1，写入快照与元数据，
 * 只保留最近 DESIGN_KEEP_SNAPSHOTS 个版本的快照内容，revision +1。
 */
export function applyDesignConfirmation(requirement, snapshot, options) {
	const now = options.now;
	const previous = Array.isArray(requirement.designVersions) ? requirement.designVersions.filter(isPlainObject) : [];
	const version = (Number.isInteger(requirement.designVersion) ? requirement.designVersion : 0) + 1;
	const entry = {
		v: version,
		at: now,
		by: typeof options.by === "string" && options.by !== "" ? options.by : "user",
		hash: designSnapshotHash(snapshot),
		prototypeCount: Object.keys(snapshot.prototypes).length,
		flowCount: Object.keys(snapshot.flows).length,
		...(typeof options.note === "string" && options.note.trim() !== "" ? { note: options.note.trim().slice(0, 200) } : {}),
		snapshot: snapshot
	};
	const keep = Number.isInteger(options.keepSnapshots) ? options.keepSnapshots : DESIGN_KEEP_SNAPSHOTS;
	const all = previous.concat([entry]).slice(-DESIGN_MAX_VERSIONS);
	const designVersions = all.map((row, index) => (index >= all.length - keep ? row : Object.assign({}, row, { snapshot: null })));
	// 确认时的组件内容哈希（P3 审计 B2）：脏判定要按「内容变没变」算，不能按「文件被写过没」算。
	// 只留本次快照里出现过的组件（换掉的旧名字自然失效）。
	const confirmedHashes = {};
	for (const name of Object.keys(snapshot && snapshot.components ? snapshot.components : {})) {
		const row = snapshot.components[name];
		if (isPlainObject(row) && typeof row.sourceHash === "string" && row.sourceHash !== "") confirmedHashes[name] = row.sourceHash;
	}
	return Object.assign({}, requirement, {
		designVersion: version,
		designConfirmedAt: now,
		designVersions: designVersions,
		...(Object.keys(confirmedHashes).length > 0 ? { designComponentHashes: confirmedHashes } : {}),
		revision: (Number.isInteger(requirement.revision) ? requirement.revision : 1) + 1,
		updatedAt: now
	});
}

/** 对外的版本摘要（不带快照内容，列表用）。 */
export function designVersionSummary(requirement) {
	return (Array.isArray(requirement && requirement.designVersions) ? requirement.designVersions : []).filter(isPlainObject).map((row) => ({
		v: row.v,
		at: row.at,
		by: row.by,
		hash: row.hash,
		prototypeCount: finiteOr(row.prototypeCount, 0),
		flowCount: finiteOr(row.flowCount, 0),
		...(typeof row.note === "string" ? { note: row.note } : {}),
		hasSnapshot: isPlainObject(row.snapshot)
	}));
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

/**
 * 回流 / 提醒这类「要找一个人说话」的消息该发给谁：
 *   需求负责人（仍是项目成员）> 需求的 Composer > 项目主对话。
 * 负责人已经不在项目里就跳过（成员被移出时宿主会清掉负责人，这里再兜一层，旧数据 / 并发都不会发给悬空的人）。
 * 没有项目 → 没有收件人（role "none"）。纯函数，不查会话是否在线。
 */
export function pickRequirementRecipient(requirement, project) {
	if (!isPlainObject(project)) return { sessionId: "", role: "none" };
	const members = Array.isArray(project.members) ? project.members : [];
	const isMember = (id) => typeof id === "string" && id !== "" && (id === project.mainSessionId || members.some((member) => isPlainObject(member) && member.sessionId === id));
	const req = isPlainObject(requirement) ? requirement : {};
	if (isMember(req.ownerSessionId)) return { sessionId: req.ownerSessionId, role: "owner" };
	if (typeof req.composerSessionId === "string" && req.composerSessionId !== "") return { sessionId: req.composerSessionId, role: "composer" };
	return { sessionId: typeof project.mainSessionId === "string" ? project.mainSessionId : "", role: "main" };
}

/** 一个需求（或虚拟需求）→ 对外视图：记录字段 + 推导出的阶段与证据 + 计数。 */
export function requirementView(requirement, facts, options) {
	const virtual = Boolean(options && options.virtual);
	const prototypes = facts.prototypes || [];
	const flows = facts.flows || [];
	const tasks = facts.tasks || [];
	const runs = facts.runs || [];
	const derived = deriveStage({ requirement: requirement, prototypes: prototypes, tasks: tasks, runs: runs, virtual: virtual, ...(Array.isArray(facts.designItems) ? { designItems: facts.designItems } : {}) });
	return {
		reqId: requirement.reqId,
		projectId: requirement.projectId,
		title: requirement.title,
		goal: requirement.goal,
		acceptance: requirement.acceptance,
		composerSessionId: requirement.composerSessionId,
		ownerSessionId: requirement.ownerSessionId,
		virtual: virtual,
		revision: requirement.revision,
		designVersion: requirement.designVersion,
		designConfirmedAt: requirement.designConfirmedAt,
		designVersions: designVersionSummary(requirement),
		reworkCount: requirement.reworkCount,
		reworkCap: requirement.reworkCap,
		feedback: (Array.isArray(requirement.feedback) ? requirement.feedback : []).slice(-5).map((row) => ({ at: row.at, runId: row.runId, to: row.to, caseIds: row.caseIds })),
		rerunPending: requirement.rerunPending === true,
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

/** 画布上一张流程图 = 一个 kind=group、data.kind="flow" 的分组框（节点与连线挂在它下面），按分组框算一张。 */
function isFlowGroup(element) {
	return isPlainObject(element) && element.kind === "group" && isPlainObject(element.data) && element.data.kind === "flow";
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
	// 组件内容哈希（名字 → sourceHash），由调用方一次读好传进来
	const hashes = isPlainObject(args.componentHashes) ? args.componentHashes : {};

	const belongs = (reqId) => (id) => id === reqId;
	const taskReq = (task) => (typeof task.requirementId === "string" ? task.requirementId : "");
	const views = records.map((record) => requirementView(record, {
		tasks: tasks.filter((task) => belongs(record.reqId)(taskReq(task))),
		prototypes: elements.filter((el) => isPlainObject(el) && el.kind === "prototype" && elementRequirementId(el) === record.reqId).map(protoFact),
		flows: elements.filter((el) => isFlowGroup(el) && elementRequirementId(el) === record.reqId).map(protoFact),
		runs: runs.filter((run) => isPlainObject(run) && run.requirementId === record.reqId),
		// 组件工坊（设计方案 §11）：画板也参与阶段推导（改动 → 回「设计」）。
		// 每个画板带上「它用到的组件当前的内容哈希」，脏判定才能按内容比（P3 审计 B2）。
		designItems: designItemsOfRequirement(elements, record.reqId).map((item) => {
			const byComponent = {};
			for (const name of Array.isArray(item.uses) ? item.uses : []) {
				const hash = hashes[name];
				if (typeof hash === "string" && hash !== "") byComponent[name] = { sourceHash: hash };
			}
			return Object.keys(byComponent).length > 0 ? Object.assign({}, item, { byComponent: byComponent }) : item;
		})
	}));
	views.sort((a, b) => b.updatedAt - a.updatedAt);

	const orphanTasks = tasks.filter((task) => !known.has(taskReq(task)));
	const orphanElements = elements.filter((el) => isPlainObject(el) && (el.kind === "prototype" || isFlowGroup(el)) && !known.has(elementRequirementId(el)));
	if (orphanTasks.length > 0 || orphanElements.length > 0) {
		const virtualRecord = normalizeRequirement({ reqId: UNASSIGNED_REQ_ID, projectId: projectId, title: "未归类", revision: 1 });
		views.push(requirementView(virtualRecord, {
			tasks: orphanTasks,
			prototypes: orphanElements.filter((el) => el.kind === "prototype").map(protoFact),
			flows: orphanElements.filter(isFlowGroup).map(protoFact),
			runs: []
		}, { virtual: true }));
	}
	return views;
}
