/**
 * 需求主线 P4：E2E 验收的协议与状态机（纯函数，不碰文件 / 宿主 / 时钟）。
 *
 * 插件**不内置浏览器驱动**，只定义「一次运行 = 一组用例 + 每条用例的结果 + 证据文件」这份协议，
 * 谁来跑由 driver 决定：tabbit-cli / computer-use（由执行器会话调 whales_e2e_report 上报），
 * 或 manual（人自己上传截图、标通过 / 不符）。三种驱动产出同一种结果，之后的批注、回流、返工计数完全一样。
 *
 * 运行状态：queued → running → passed | failed | error（finish 时按结果折算；运行中只有 queued / running）。
 * 用例状态：pending → running → passed | failed | error；人可以把 failed 标成 accepted（「可接受」，算通过）。
 */

export const E2E_DRIVERS = ["manual", "tabbit-cli", "computer-use"];
export const E2E_RESULT_STATUSES = ["pending", "running", "passed", "failed", "error", "accepted"];
/** 上报方（执行器 / 人）能写的用例状态；pending 只由系统初始化，accepted 只由人在回流环节标。 */
export const E2E_REPORTABLE = ["running", "passed", "failed", "error"];
export const E2E_DIAGNOSIS_KINDS = ["code", "design", "requirement", "env"];

export const E2E_LIMITS = {
	cases: 50,
	caseTitle: 120,
	note: 2000,
	reason: 500,
	shotsPerResult: 10,
	shotBytes: 5 * 1024 * 1024,
	videoBytes: 25 * 1024 * 1024,
	runsPerProject: 200
};

const SHOT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.(png|jpe?g|webp|webm)$/i;
const CASE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", webm: "video/webm" };

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 证据文件名：只允许安全的 ASCII 文件名 + 白名单扩展名。拒绝路径分隔符、`..`、隐藏文件。 */
export function isSafeShotName(name) {
	return typeof name === "string" && SHOT_NAME.test(name) && name.indexOf("..") < 0;
}

export function shotExtension(name) {
	const match = typeof name === "string" ? /\.([a-z0-9]+)$/i.exec(name) : null;
	return match ? match[1].toLowerCase() : "";
}

export function shotMime(name) {
	return MIME_BY_EXT[shotExtension(name)] || "application/octet-stream";
}

export function shotByteLimit(name) {
	return shotExtension(name) === "webm" ? E2E_LIMITS.videoBytes : E2E_LIMITS.shotBytes;
}

/**
 * 内容与扩展名是否相符（看文件头魔数）。防止把任意内容改个 .png 就塞进来再被当图片下发。
 * 只认 png / jpeg / webp / webm；其它一律不相符。
 */
export function shotContentMatches(name, buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
	const ext = shotExtension(name);
	if (ext === "png") return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
	if (ext === "jpg" || ext === "jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
	if (ext === "webp") return buffer.slice(0, 4).toString("latin1") === "RIFF" && buffer.slice(8, 12).toString("latin1") === "WEBP";
	if (ext === "webm") return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
	return false;
}
/** 把任意文件名收敛成安全名（执行器给的是磁盘路径，取 basename 再收敛）。收敛后仍不合法返回 ""。 */
export function sanitizeShotName(raw) {
	const base = String(raw === undefined || raw === null ? "" : raw).split(/[\\/]/).pop() || "";
	const cleaned = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/\.{2,}/g, ".");
	const trimmed = cleaned.length > 64 ? cleaned.slice(cleaned.length - 64).replace(/^[^a-z0-9]+/, "") : cleaned;
	return isSafeShotName(trimmed) ? trimmed : "";
}

/** 在已有名字里挑一个不冲突的（重名加 -2、-3…）。 */
export function uniqueShotName(name, taken) {
	const used = new Set(Array.isArray(taken) ? taken : []);
	if (!used.has(name)) return name;
	const dot = name.lastIndexOf(".");
	const stem = name.slice(0, dot);
	const ext = name.slice(dot);
	for (let i = 2; i < 1000; i += 1) {
		const candidate = stem.slice(0, 60 - String(i).length) + "-" + i + ext;
		if (!used.has(candidate)) return candidate;
	}
	return "";
}

// ── 建运行 ─────────────────────────────────────────────────────────────────────

/**
 * 清洗「建运行」请求体。cases 缺省时用需求的验收点（没有验收点就给一条总用例，保证运行至少有一条可报的东西）。
 * 返回 { value: { driver, cases:[{caseId,title}], note? } } 或 { error }。
 */
export function cleanRunInput(payload, requirement) {
	const body = isPlainObject(payload) ? payload : {};
	const driver = body.driver === undefined ? "manual" : body.driver;
	if (E2E_DRIVERS.indexOf(driver) < 0) return { error: "driver must be one of " + E2E_DRIVERS.join(", ") };
	let titles;
	if (body.cases !== undefined) {
		if (!Array.isArray(body.cases)) return { error: "cases must be an array" };
		titles = [];
		for (const raw of body.cases) {
			const title = typeof raw === "string" ? raw : (isPlainObject(raw) && typeof raw.title === "string" ? raw.title : undefined);
			if (title === undefined) return { error: "each case must be a string or { title }" };
			const trimmed = title.trim();
			if (trimmed === "") return { error: "case title must not be empty" };
			if (trimmed.length > E2E_LIMITS.caseTitle) return { error: "case title exceeds " + E2E_LIMITS.caseTitle + " chars" };
			titles.push(trimmed);
		}
	} else {
		const acceptance = requirement && Array.isArray(requirement.acceptance) ? requirement.acceptance.filter((item) => typeof item === "string" && item.trim() !== "") : [];
		titles = acceptance.map((item) => item.trim().slice(0, E2E_LIMITS.caseTitle));
		if (titles.length === 0) titles = [((requirement && requirement.title) || "验收") + " · 整体验收"];
	}
	if (titles.length === 0) return { error: "at least one case is required" };
	if (titles.length > E2E_LIMITS.cases) return { error: "cases exceeds " + E2E_LIMITS.cases };
	const value = {
		driver: driver,
		cases: titles.map((title, index) => ({ caseId: "c" + (index + 1), title: title }))
	};
	if (body.note !== undefined) {
		if (typeof body.note !== "string") return { error: "note must be a string" };
		const note = body.note.trim();
		if (note.length > E2E_LIMITS.note) return { error: "note exceeds " + E2E_LIMITS.note + " chars" };
		if (note !== "") value.note = note;
	}
	return { value };
}

/** 新建一次运行（queued）。id / 时间 / 任务清单由调用方给。 */
export function newRunRecord(args) {
	return {
		runId: args.runId,
		projectId: args.projectId,
		requirementId: args.requirementId,
		designVersion: Number.isInteger(args.designVersion) ? args.designVersion : 0,
		taskIds: Array.isArray(args.taskIds) ? args.taskIds.slice(0, 100) : [],
		driver: args.driver,
		status: "queued",
		cases: args.cases.map((item) => ({ caseId: item.caseId, title: item.title })),
		results: args.cases.map((item) => ({ caseId: item.caseId, title: item.title, status: "pending", note: "", shots: [], at: 0 })),
		annotations: [],
		...(args.note ? { note: args.note } : {}),
		createdBy: typeof args.createdBy === "string" ? args.createdBy : "user",
		createdAt: args.now,
		startedAt: args.now,
		finishedAt: null
	};
}

// ── 上报结果 ───────────────────────────────────────────────────────────────────

/**
 * 清洗一条用例结果上报。返回 { value:{status,note,diagnosis?} } 或 { error }。
 * 失败 / 出错时可以带 diagnosis {kind, reason}（执行器的初判）；kind 不在词表里直接拒绝。
 */
export function cleanResultInput(payload) {
	if (!isPlainObject(payload)) return { error: "body must be an object" };
	if (E2E_REPORTABLE.indexOf(payload.status) < 0) return { error: "status must be one of " + E2E_REPORTABLE.join(", ") };
	const value = { status: payload.status, note: "" };
	if (payload.note !== undefined) {
		if (typeof payload.note !== "string") return { error: "note must be a string" };
		const note = payload.note.trim();
		if (note.length > E2E_LIMITS.note) return { error: "note exceeds " + E2E_LIMITS.note + " chars" };
		value.note = note;
	}
	if (payload.diagnosis !== undefined && payload.diagnosis !== null) {
		const diagnosis = payload.diagnosis;
		if (!isPlainObject(diagnosis)) return { error: "diagnosis must be an object" };
		if (E2E_DIAGNOSIS_KINDS.indexOf(diagnosis.kind) < 0) return { error: "diagnosis.kind must be one of " + E2E_DIAGNOSIS_KINDS.join(", ") };
		const reason = typeof diagnosis.reason === "string" ? diagnosis.reason.trim() : "";
		if (reason.length > E2E_LIMITS.reason) return { error: "diagnosis.reason exceeds " + E2E_LIMITS.reason + " chars" };
		if (payload.status === "passed") return { error: "a passed case cannot carry a diagnosis" };
		value.diagnosis = { kind: diagnosis.kind, reason: reason };
	}
	return { value };
}

export function isRunOpen(run) {
	return isPlainObject(run) && (run.status === "queued" || run.status === "running");
}

/**
 * 把一条结果写进运行（纯函数，返回新的运行记录或 { error }）。
 * 规则：运行已结束不能再写；用例必须在运行的清单里；shots 由调用方先落盘再把文件名交进来（replaceShots=false 时追加）；
 * 附件总数不超限；第一次上报把 queued 推进到 running；diagnosis.by 记 "ai"（执行器初判）或 "user"。
 */
export function applyResult(run, caseId, input, options) {
	if (!isRunOpen(run)) return { error: "run is already finished" };
	const results = Array.isArray(run.results) ? run.results : [];
	const index = results.findIndex((row) => row && row.caseId === caseId);
	if (index < 0) return { error: "case not found in this run" };
	const opts = options || {};
	const previous = results[index];
	const shots = (Array.isArray(previous.shots) ? previous.shots : []).concat(Array.isArray(opts.addShots) ? opts.addShots : []);
	if (shots.length > E2E_LIMITS.shotsPerResult) return { error: "a case can carry at most " + E2E_LIMITS.shotsPerResult + " attachments" };
	const next = {
		caseId: previous.caseId,
		title: previous.title,
		status: input.status,
		note: input.note,
		shots: shots,
		at: opts.now,
		by: typeof opts.by === "string" ? opts.by : "user",
		...(input.diagnosis ? { diagnosis: { kind: input.diagnosis.kind, reason: input.diagnosis.reason, by: opts.by === "user" ? "user" : "ai" } } : {})
	};
	const nextResults = results.slice();
	nextResults[index] = next;
	return { run: Object.assign({}, run, { status: "running", results: nextResults }) };
}

/** 只追加证据文件（上传截图时用），不改状态。 */
export function appendShots(run, caseId, names) {
	if (!isRunOpen(run)) return { error: "run is already finished" };
	const results = Array.isArray(run.results) ? run.results : [];
	const index = results.findIndex((row) => row && row.caseId === caseId);
	if (index < 0) return { error: "case not found in this run" };
	const shots = (Array.isArray(results[index].shots) ? results[index].shots : []).concat(names);
	if (shots.length > E2E_LIMITS.shotsPerResult) return { error: "a case can carry at most " + E2E_LIMITS.shotsPerResult + " attachments" };
	const nextResults = results.slice();
	nextResults[index] = Object.assign({}, results[index], { shots: shots });
	return { run: Object.assign({}, run, { results: nextResults, status: run.status === "queued" ? "running" : run.status }) };
}

// ── 结束一次运行 ────────────────────────────────────────────────────────────────

/** 还没出结论的用例（pending / running）。 */
export function unfinishedCases(run) {
	return (Array.isArray(run && run.results) ? run.results : []).filter((row) => isPlainObject(row) && (row.status === "pending" || row.status === "running")).map((row) => row.caseId);
}

/**
 * 结束运行：所有用例都有结论才能结束（除非 force：没报的按 error 记，原因写明「未上报」）。
 * 折算：有 error → error；有 failed → failed；全部 passed / accepted → passed。
 */
export function finishRun(run, options) {
	if (!isRunOpen(run)) return { error: "run is already finished" };
	const opts = options || {};
	const missing = unfinishedCases(run);
	if (missing.length > 0 && opts.force !== true) return { error: "cases without a result: " + missing.join(", "), missing: missing };
	const results = (Array.isArray(run.results) ? run.results : []).map((row) => (
		row.status === "pending" || row.status === "running"
			? Object.assign({}, row, { status: "error", note: row.note || "未上报结果（强制结束）", at: opts.now })
			: row
	));
	let status = "passed";
	if (results.some((row) => row.status === "error")) status = "error";
	else if (results.some((row) => row.status === "failed")) status = "failed";
	return { run: Object.assign({}, run, { status: status, results: results, finishedAt: opts.now }) };
}

// ── 批注 / 可接受 / 回流（P5a）─────────────────────────────────────────────────

export const E2E_REFLOW_TARGETS = ["code", "design", "requirement"];
export const E2E_ANNOTATION_LIMITS = { perRun: 40, expected: 500, reflowFeedback: 20 };

function inUnit(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * 清洗一条批注：在某条失败 / 出错用例的某张截图上框一块、写下预期。
 * rect 用 0..1 的归一化坐标（相对截图宽高），x+w、y+h 不能超出截图；没框（rect 省略）= 对整条用例的文字批注。
 */
export function cleanAnnotationInput(payload, run) {
	if (!isPlainObject(payload)) return { error: "body must be an object" };
	const caseId = typeof payload.caseId === "string" ? payload.caseId.trim() : "";
	const result = (Array.isArray(run && run.results) ? run.results : []).find((row) => row && row.caseId === caseId);
	if (result === undefined) return { error: "case not found in this run" };
	if (result.status !== "failed" && result.status !== "error") return { error: "only a failed or errored case can be annotated" };
	const expected = typeof payload.expected === "string" ? payload.expected.trim() : "";
	if (expected === "") return { error: "expected is required (write down what you expected)" };
	if (expected.length > E2E_ANNOTATION_LIMITS.expected) return { error: "expected exceeds " + E2E_ANNOTATION_LIMITS.expected + " chars" };
	const value = { caseId: caseId, expected: expected };
	if (payload.shot !== undefined && payload.shot !== null && payload.shot !== "") {
		if (typeof payload.shot !== "string" || (result.shots || []).indexOf(payload.shot) < 0) return { error: "shot is not attached to this case" };
		if (shotExtension(payload.shot) === "webm") return { error: "a video cannot be annotated with a box; pick a screenshot" };
		value.shot = payload.shot;
	}
	if (payload.rect !== undefined && payload.rect !== null) {
		const rect = payload.rect;
		if (!isPlainObject(rect) || !inUnit(rect.x) || !inUnit(rect.y) || !inUnit(rect.w) || !inUnit(rect.h)) return { error: "rect must be { x, y, w, h } with every value in 0..1" };
		if (rect.w <= 0 || rect.h <= 0) return { error: "rect must have a positive width and height" };
		if (rect.x + rect.w > 1.0001 || rect.y + rect.h > 1.0001) return { error: "rect must stay inside the screenshot" };
		if (value.shot === undefined) return { error: "a rect needs the screenshot it is drawn on (shot)" };
		value.rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
	}
	return { value };
}

/** 加一条批注（纯函数）。运行结束后也能批注——批注本来就是看完结果才写的。 */
export function addAnnotation(run, input, options) {
	const list = Array.isArray(run.annotations) ? run.annotations : [];
	if (list.length >= E2E_ANNOTATION_LIMITS.perRun) return { error: "too many annotations on this run (limit " + E2E_ANNOTATION_LIMITS.perRun + ")" };
	const annotation = Object.assign({ annId: options.annId, by: "user", at: options.now, handled: false }, input);
	return { run: Object.assign({}, run, { annotations: list.concat([annotation]) }), annotation: annotation };
}

/** 删一条还没处理的批注；已经回流过的留作记录，不能删。 */
export function removeAnnotation(run, annId) {
	const list = Array.isArray(run.annotations) ? run.annotations : [];
	const found = list.find((row) => row && row.annId === annId);
	if (found === undefined) return { error: "annotation not found" };
	if (found.handled === true) return { error: "this annotation was already sent back and is kept as a record" };
	return { run: Object.assign({}, run, { annotations: list.filter((row) => row !== found) }) };
}

/** 按结果重新折算已结束运行的状态（标「可接受」后可能整轮变成通过）。运行中的不动。 */
export function recomputeFinishedStatus(run) {
	if (isRunOpen(run)) return run;
	const results = Array.isArray(run.results) ? run.results : [];
	let status = "passed";
	if (results.some((row) => row.status === "error")) status = "error";
	else if (results.some((row) => row.status === "failed")) status = "failed";
	return Object.assign({}, run, { status: status });
}

/** 人把一条失败 / 出错的用例标成「可接受」（不算问题）。只能在运行结束后标，且只能人标。 */
export function acceptResult(run, caseId, options) {
	if (isRunOpen(run)) return { error: "finish the run before accepting a result" };
	const results = Array.isArray(run.results) ? run.results : [];
	const index = results.findIndex((row) => row && row.caseId === caseId);
	if (index < 0) return { error: "case not found in this run" };
	if (results[index].status !== "failed" && results[index].status !== "error") return { error: "only a failed or errored case can be accepted" };
	const nextResults = results.slice();
	nextResults[index] = Object.assign({}, results[index], { status: "accepted", acceptedAt: options.now, acceptedBy: "user" });
	return { run: recomputeFinishedStatus(Object.assign({}, run, { results: nextResults })) };
}

/**
 * 回流计划：每条还没处理的失败 / 出错用例回到哪里。
 * 默认按执行器 / 人给的诊断（code / design / requirement）；没有诊断按 code；env（环境问题）不回流——重跑就好，
 * 想改落点就在 targets 里显式写。返回 { items:[{caseId, to}] } 或 { error }。
 */
export function planReflow(run, targets) {
	if (isRunOpen(run)) return { error: "finish the run before sending feedback back" };
	const results = Array.isArray(run.results) ? run.results : [];
	const pending = results.filter((row) => row && (row.status === "failed" || row.status === "error") && row.reflowed !== true);
	if (pending.length === 0) return { error: "no failed case left to send back" };
	const explicit = {};
	if (targets !== undefined) {
		if (!Array.isArray(targets)) return { error: "targets must be an array of { caseId, to }" };
		for (const raw of targets) {
			if (!isPlainObject(raw) || typeof raw.caseId !== "string" || E2E_REFLOW_TARGETS.indexOf(raw.to) < 0) return { error: "each target needs caseId and to (" + E2E_REFLOW_TARGETS.join(" / ") + ")" };
			if (!pending.some((row) => row.caseId === raw.caseId)) return { error: "case " + raw.caseId + " is not a failed case waiting to be sent back" };
			explicit[raw.caseId] = raw.to;
		}
	}
	const items = [];
	for (const row of pending) {
		const to = explicit[row.caseId] !== undefined ? explicit[row.caseId] : (row.diagnosis && E2E_REFLOW_TARGETS.indexOf(row.diagnosis.kind) >= 0 ? row.diagnosis.kind : (row.diagnosis && row.diagnosis.kind === "env" ? "env" : "code"));
		if (to === "env") continue;
		items.push({ caseId: row.caseId, to: to });
	}
	if (items.length === 0) return { error: "the remaining failures are environment problems — fix the environment and re-run instead of sending them back" };
	return { items: items };
}

/**
 * 回流给负责人 / Composer 的那段话：哪条用例、预期什么、实际怎样、哪张截图（文件名 + 框的位置）、基于哪个设计版本。
 * 只写事实，不下指令式措辞（与 Composer 前缀同口径）。
 */
export function buildFeedbackText(run, items, requirement) {
	const results = Array.isArray(run.results) ? run.results : [];
	const lines = ["E2E 验收不符 · 需求「" + (requirement && requirement.title ? requirement.title : run.requirementId) + "」 · 设计版本 " + (run.designVersion > 0 ? "v" + run.designVersion : "（未确认）") + " · 运行 " + run.runId];
	for (const item of items) {
		const row = results.find((r) => r && r.caseId === item.caseId);
		if (!row) continue;
		lines.push("");
		lines.push("用例「" + row.title + "」：" + (row.status === "error" ? "运行出错" : "不符") + (row.note ? "；实际：" + row.note : ""));
		if (row.diagnosis && row.diagnosis.reason) lines.push("初判（" + (row.diagnosis.by === "user" ? "人" : "AI") + "，" + row.diagnosis.kind + "）：" + row.diagnosis.reason);
		const notes = (Array.isArray(run.annotations) ? run.annotations : []).filter((a) => a && a.caseId === item.caseId && a.handled !== true);
		notes.forEach((a, index) => {
			const where = a.rect ? "（" + (a.shot || "") + " 上 x" + Math.round(a.rect.x * 100) + "% y" + Math.round(a.rect.y * 100) + "% 宽" + Math.round(a.rect.w * 100) + "% 高" + Math.round(a.rect.h * 100) + "%）" : (a.shot ? "（" + a.shot + "）" : "");
			lines.push("  " + (index + 1) + ". 预期：" + a.expected + where);
		});
		if (Array.isArray(row.shots) && row.shots.length > 0) lines.push("证据文件：" + row.shots.join("、"));
	}
	return lines.join("\n");
}

/** 把已回流的用例与批注标记掉（纯函数）。 */
export function markReflowed(run, items, options) {
	const done = new Set(items.map((item) => item.caseId));
	const toOf = {};
	for (const item of items) toOf[item.caseId] = item.to;
	return Object.assign({}, run, {
		results: (Array.isArray(run.results) ? run.results : []).map((row) => (done.has(row.caseId) ? Object.assign({}, row, { reflowed: true, reflowedTo: toOf[row.caseId], reflowedAt: options.now }) : row)),
		annotations: (Array.isArray(run.annotations) ? run.annotations : []).map((a) => (done.has(a.caseId) ? Object.assign({}, a, { handled: true }) : a)),
		reflows: (Array.isArray(run.reflows) ? run.reflows : []).concat([{ at: options.now, items: items.map((item) => ({ caseId: item.caseId, to: item.to })), taskIds: Array.isArray(options.taskIds) ? options.taskIds : [] }])
	});
}
// ── E2E 配置与自动触发（P5b）──────────────────────────────────────────────────

export const E2E_TRIGGERS = ["auto", "manual"];
export const E2E_DEFAULT_CONFIG = { trigger: "auto", driver: "manual", executorSessionId: "", baseUrl: "" };

/** 读项目 E2E 配置：缺省 / 坏数据都回默认（自动触发 + 手动驱动：不会无声地去跑任何东西）。 */
export function normalizeE2eConfig(raw) {
	const body = isPlainObject(raw) ? raw : {};
	return {
		trigger: E2E_TRIGGERS.indexOf(body.trigger) >= 0 ? body.trigger : E2E_DEFAULT_CONFIG.trigger,
		driver: E2E_DRIVERS.indexOf(body.driver) >= 0 ? body.driver : E2E_DEFAULT_CONFIG.driver,
		executorSessionId: typeof body.executorSessionId === "string" ? body.executorSessionId.trim() : "",
		baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : ""
	};
}

/**
 * 清洗配置修改。isMember(sessionId) 由调用方给：执行器必须是项目成员（否则回流 / 交接的访问闸对不上）。
 * 返回 { value: 合并后的完整配置 } 或 { error }。只给了的字段才改。
 */
export function cleanE2eConfigPatch(payload, current, isMember) {
	if (!isPlainObject(payload)) return { error: "body must be an object" };
	const next = Object.assign({}, normalizeE2eConfig(current));
	if (payload.trigger !== undefined) {
		if (E2E_TRIGGERS.indexOf(payload.trigger) < 0) return { error: "trigger must be one of " + E2E_TRIGGERS.join(", ") };
		next.trigger = payload.trigger;
	}
	if (payload.driver !== undefined) {
		if (E2E_DRIVERS.indexOf(payload.driver) < 0) return { error: "driver must be one of " + E2E_DRIVERS.join(", ") };
		next.driver = payload.driver;
	}
	if (payload.executorSessionId !== undefined) {
		if (typeof payload.executorSessionId !== "string") return { error: "executorSessionId must be a string" };
		const id = payload.executorSessionId.trim();
		if (id !== "" && typeof isMember === "function" && !isMember(id)) return { error: "executorSessionId must be a project member" };
		next.executorSessionId = id;
	}
	if (payload.baseUrl !== undefined) {
		if (typeof payload.baseUrl !== "string") return { error: "baseUrl must be a string" };
		const url = payload.baseUrl.trim();
		if (url !== "") {
			if (url.length > 200) return { error: "baseUrl exceeds 200 chars" };
			let parsed;
			try { parsed = new URL(url); } catch (error) { parsed = undefined; }
			if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return { error: "baseUrl must be an http(s) URL" };
		}
		next.baseUrl = url;
	}
	if (next.driver !== "manual" && next.executorSessionId === "" && payload.driver !== undefined && payload.executorSessionId === undefined) {
		return { error: "a non-manual driver needs an executorSessionId (the session that will run the cases)" };
	}
	return { value: next };
}

/**
 * 该不该自动建一次 E2E 运行（任务全部完工时调用，纯判定）。
 * 必须同时满足：触发方式是自动；没有没结束的运行；该需求下任务都已完工（且至少一个）；设计没有待确认的改动；
 * 并且是「对当前设计版本还没跑过」或「刚回流返工完（rerunPending）」。
 * 出错的运行不自动重跑（人决定先修环境，避免无限循环）；已经跑过且没回流过的也不重跑。
 */
export function shouldAutoRun(view, config, hasOpenRun) {
	if (!isPlainObject(view) || view.virtual === true) return { run: false, reason: "no-requirement" };
	if (normalizeE2eConfig(config).trigger !== "auto") return { run: false, reason: "trigger-manual" };
	if (hasOpenRun) return { run: false, reason: "run-open" };
	const evidence = isPlainObject(view.evidence) ? view.evidence : {};
	if (!(evidence.taskTotal > 0) || evidence.taskDone < evidence.taskTotal) return { run: false, reason: "tasks-not-done" };
	if (evidence.dirtyPrototypeCount > 0 || evidence.reviewPending) return { run: false, reason: "design-unconfirmed" };
	if (view.rerunPending === true) return { run: true, reason: "rerun" };
	if (evidence.latestRun === null || evidence.latestRun === undefined) return { run: true, reason: "first-run" };
	return { run: false, reason: "already-run" };
}

/** 交给执行器的那段话（只写运行事实与上报方式）。 */
export function buildRunBrief(run, requirement, config) {
	const cfg = normalizeE2eConfig(config);
	const lines = [
		"E2E 验收运行 " + run.runId + " · 需求「" + (requirement && requirement.title ? requirement.title : run.requirementId) + "」 · 设计版本 " + (run.designVersion > 0 ? "v" + run.designVersion : "（未确认）") + " · 驱动 " + run.driver
	];
	if (cfg.baseUrl !== "") lines.push("被测地址：" + cfg.baseUrl);
	lines.push("用例：");
	for (const item of run.cases) lines.push("  " + item.caseId + "  " + item.title);
	lines.push("每条用例的结果用工具 whales_e2e_report 上报（runId / caseId / status，失败时附 note、diagnosis 与截图的磁盘路径）；全部报完后在最后一条里带 finish: true。");
	return lines.join("\n");
}
/** 一次运行的摘要（列表用，不带证据文件名以外的细节）。 */
export function runSummary(run) {
	const results = Array.isArray(run && run.results) ? run.results : [];
	const count = (statuses) => results.filter((row) => isPlainObject(row) && statuses.indexOf(row.status) >= 0).length;
	return {
		runId: run.runId,
		requirementId: run.requirementId,
		designVersion: run.designVersion,
		driver: run.driver,
		status: run.status,
		total: results.length,
		passed: count(["passed", "accepted"]),
		failed: count(["failed"]),
		errored: count(["error"]),
		pending: count(["pending", "running"]),
		accepted: count(["accepted"]),
		reflowed: results.filter((row) => isPlainObject(row) && row.reflowed === true).length,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt === undefined ? null : run.finishedAt
	};
}

/** 规整读到的运行记录（坏数据不炸）。 */
export function normalizeRun(raw) {
	if (!isPlainObject(raw) || typeof raw.runId !== "string" || raw.runId === "") return undefined;
	return {
		runId: raw.runId,
		projectId: typeof raw.projectId === "string" ? raw.projectId : "",
		requirementId: typeof raw.requirementId === "string" ? raw.requirementId : "",
		designVersion: Number.isInteger(raw.designVersion) && raw.designVersion >= 0 ? raw.designVersion : 0,
		taskIds: Array.isArray(raw.taskIds) ? raw.taskIds.filter((id) => typeof id === "string") : [],
		driver: E2E_DRIVERS.indexOf(raw.driver) >= 0 ? raw.driver : "manual",
		status: ["queued", "running", "passed", "failed", "error"].indexOf(raw.status) >= 0 ? raw.status : "error",
		cases: Array.isArray(raw.cases) ? raw.cases.filter(isPlainObject) : [],
		results: Array.isArray(raw.results) ? raw.results.filter(isPlainObject).map((row) => Object.assign({}, row, { shots: Array.isArray(row.shots) ? row.shots.filter(isSafeShotName) : [] })) : [],
		annotations: Array.isArray(raw.annotations) ? raw.annotations.filter(isPlainObject) : [],
		reflows: Array.isArray(raw.reflows) ? raw.reflows.filter(isPlainObject) : [],
		note: typeof raw.note === "string" ? raw.note : "",
		createdBy: typeof raw.createdBy === "string" ? raw.createdBy : "user",
		createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
		startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
		finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null
	};
}
