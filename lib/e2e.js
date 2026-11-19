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
		note: typeof raw.note === "string" ? raw.note : "",
		createdBy: typeof raw.createdBy === "string" ? raw.createdBy : "user",
		createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
		startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
		finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null
	};
}
