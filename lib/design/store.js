/**
 * 组件工坊：设计产物的落盘与锁（设计方案 §5.1 / §5.2）。
 *
 * 布局（沿用插件数据根 `PROPOSAL_STORE_DIR` = `<DSH_HOME>/agent-whales/`）：
 *
 *   <root>/design/<projectId>/
 *     components/<Name>/  source.tsx · compiled.js · meta.json
 *     artboards/<id>/     source.tsx · compiled.js · meta.json
 *     comments.json       评论钉
 *     versions/<reqId>/v<N>/  确认设计时的源码快照（P3）
 *
 * 三条纪律（都是方案里点名的实现陷阱）：
 *   1. **先判锁，再写文件**。人被锁住的元素，agent 写入必须整次失败，不能「文件先写了、元素没改」。
 *   2. **路径必须经正则校验后再拼**，拼完还要确认仍在 `design/<projectId>/` 下（防路径穿越）。
 *   3. 写文件用「临时文件 + rename」原子写（与插件其它 store 同口径），避免半截文件。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

// ── 上限（可调常量）─────────────────────────────────────────────────────────

export const DESIGN_LIMITS = {
	componentsPerProject: 100,
	artboardsPerProject: 100,
	sourceBytes: 64 * 1024,
	compiledBytes: 256 * 1024,
	commentsPerTarget: 200,
	examples: 8
};

/** 组件名：PascalCase，2–40 字符。 */
export const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]{1,39}$/;
/** 画板 id：与原型帧的 `prototypeId` 同规则。 */
export const ARTBOARD_ID_RE = /^[a-z0-9-]{1,32}$/;

const KINDS = { component: "components", artboard: "artboards" };

/** 项目根目录（内部用；调用方拿不到超出 root 的路径）。 */
function projectRoot(designRoot, projectId) {
	return join(designRoot, "design", projectId);
}

/**
 * 校验并拼接一个设计实体的目录。**任何一步不合法都抛错**（不静默回退到默认路径）。
 * @returns {string} 绝对路径
 */
export function designEntityDir(designRoot, projectId, kind, id) {
	if (typeof designRoot !== "string" || designRoot === "") throw new Error("design root 未配置");
	if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw new Error("非法 projectId: " + String(projectId));
	const folder = KINDS[kind];
	if (!folder) throw new Error("kind 只能是 component / artboard");
	const ok = kind === "component" ? COMPONENT_NAME_RE.test(String(id)) : ARTBOARD_ID_RE.test(String(id));
	if (!ok) throw new Error(kind === "component"
		? "组件名必须是 PascalCase（如 ApprovalTimeline），2–40 字符"
		: "画板 id 只能是 1–32 位小写字母 / 数字 / 连字符");
	const target = resolve(projectRoot(designRoot, projectId), folder, String(id));
	const base = resolve(projectRoot(designRoot, projectId)) + sep;
	if (!target.startsWith(base)) throw new Error("路径越界：" + target);
	return target;
}

/** 项目设计根（给列表 / 统计用）。 */
export function designProjectDir(designRoot, projectId) {
	// 与 designEntityDir 用同一条 projectId 规则：不校验的话 "." 会解析成 design/ 根本身
	//（resolve("design/.") === "design"），comments.json 之类的文件就会写进 design/ 根。
	if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw new Error("非法 projectId: " + String(projectId));
	const root = resolve(projectRoot(designRoot, projectId));
	const base = resolve(designRoot) + sep;
	if (!root.startsWith(base) || root === resolve(designRoot)) throw new Error("路径越界：" + root);
	return root;
}

// ── 原子写 ─────────────────────────────────────────────────────────────────

function atomicWrite(file, content) {
	mkdirSync(join(file, ".."), { recursive: true });
	const temp = file + ".tmp-" + process.pid + "-" + randomUUID();
	writeFileSync(temp, content, "utf8");
	renameSync(temp, file);
}

/** 读 JSON，坏文件当不存在（不抛，调用方按「没有」处理）。 */
function readJson(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch (error) {
		return undefined;
	}
}

// ── 设计实体：读 / 写 / 删 ──────────────────────────────────────────────────

/**
 * 列出一个项目里某类设计实体（只读 meta.json；目录名不合法的一律忽略）。
 * @returns {Array<object>} 每项是 meta.json 的内容 + `{ id }`
 */
export function listEntities(designRoot, projectId, kind) {
	const folder = KINDS[kind];
	if (!folder) return [];
	const dir = join(designProjectDir(designRoot, projectId), folder);
	let names = [];
	try { names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch (error) { return []; }
	const re = kind === "component" ? COMPONENT_NAME_RE : ARTBOARD_ID_RE;
	const out = [];
	for (const name of names) {
		if (!re.test(name)) continue;
		const meta = readJson(join(dir, name, "meta.json"));
		if (meta === undefined) continue;
		out.push(Object.assign({ id: name }, meta, { kind: kind }));
	}
	out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	return out;
}

/** 读一个实体的源码 + meta；不存在返回 undefined。 */
export function readEntity(designRoot, projectId, kind, id) {
	let dir;
	try { dir = designEntityDir(designRoot, projectId, kind, id); } catch (error) { return undefined; }
	const meta = readJson(join(dir, "meta.json"));
	if (meta === undefined) return undefined;
	let source = "";
	try { source = readFileSync(join(dir, "source.tsx"), "utf8"); } catch (error) { source = ""; }
	let compiled = "";
	try { compiled = readFileSync(join(dir, "compiled.js"), "utf8"); } catch (error) { compiled = ""; }
	return { id: String(id), kind: kind, source: source, compiled: compiled, meta: meta, dir: dir };
}

/**
 * 写一个实体（源码 + 编译产物 + meta）。**用到了 `options.locked` 时必须先放最后**——
 * 调用方（宿主）在进门之前已经判过锁；这里再判一次，防止「判完锁又被人改了」的窗口。
 *
 * @param {object} options
 *   · locked   true = 元素被人改过、agent 不能写（直接抛错，不落盘）
 *   · meta     要合并进 meta.json 的字段
 *   · source   源码
 *   · compiled 编译产物
 */
export function writeEntity(designRoot, projectId, kind, id, options) {
	const opts = options || {};
	if (opts.locked === true) {
		const error = new Error("被锁：这个" + (kind === "component" ? "组件" : "画板") + "人改过，agent 不能再写；换个名字另起一版");
		error.code = "DESIGN_LOCKED";
		throw error;
	}
	const dir = designEntityDir(designRoot, projectId, kind, id);
	const source = String(opts.source === undefined ? "" : opts.source);
	const compiled = String(opts.compiled === undefined ? "" : opts.compiled);
	const sourceBytes = Buffer.byteLength(source, "utf8");
	const compiledBytes = Buffer.byteLength(compiled, "utf8");
	if (sourceBytes > DESIGN_LIMITS.sourceBytes) throw new Error("源码超过 " + (DESIGN_LIMITS.sourceBytes / 1024) + "KB（当前 " + (sourceBytes / 1024).toFixed(1) + "KB）");
	if (compiledBytes > DESIGN_LIMITS.compiledBytes) throw new Error("编译产物超过 " + (DESIGN_LIMITS.compiledBytes / 1024) + "KB");

	// 数量上限：新建时才算（改已有实体不受限）
	const existing = readEntity(designRoot, projectId, kind, id);
	if (existing === undefined) {
		const count = listEntities(designRoot, projectId, kind).length;
		const cap = kind === "component" ? DESIGN_LIMITS.componentsPerProject : DESIGN_LIMITS.artboardsPerProject;
		if (count >= cap) throw new Error("每个项目最多 " + cap + " 个" + (kind === "component" ? "组件" : "画板") + "，已经满了");
	}

	const previous = existing && existing.meta ? existing.meta : {};
	const now = new Date().toISOString();
	const meta = Object.assign({}, previous, opts.meta || {}, {
		name: kind === "component" ? id : previous.name,
		artboardId: kind === "artboard" ? id : previous.artboardId,
		updatedAt: now,
		createdAt: typeof previous.createdAt === "string" ? previous.createdAt : now,
		sourceBytes: sourceBytes
	});
	// meta 里不放 undefined（无损 JSON 纪律）
	for (const key of Object.keys(meta)) if (meta[key] === undefined) delete meta[key];

	mkdirSync(dir, { recursive: true });
	atomicWrite(join(dir, "source.tsx"), source);
	atomicWrite(join(dir, "compiled.js"), compiled);
	atomicWrite(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
	return { id: String(id), kind: kind, meta: meta, dir: dir };
}

/** 删除一个实体目录。不存在不报错。 */
export function removeEntity(designRoot, projectId, kind, id) {
	const dir = designEntityDir(designRoot, projectId, kind, id);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

// ── 引用关系（谁 import 了谁）───────────────────────────────────────────────

/**
 * 扫一个项目的所有组件 + 画板，算出「某组件被谁用」。
 * @returns {{ uses: Object<string, string[]>, of: Object<string, string[]> }}
 *   uses[Name]   = 用到 Name 的实体 id 列表（含其它组件与画板）
 *   of[entityId] = 这个实体 import 的组件名列表
 */
export function buildUsageMap(designRoot, projectId) {
	const uses = {};
	const of = {};
	for (const kind of ["component", "artboard"]) {
		for (const entity of listEntities(designRoot, projectId, kind)) {
			const imported = Array.isArray(entity.imports) ? entity.imports.filter((name) => typeof name === "string") : [];
			of[entity.id] = imported;
			for (const name of imported) {
				const bucket = uses[name] || (uses[name] = []);
				if (bucket.indexOf(entity.id) < 0) bucket.push(entity.id);
			}
		}
	}
	return { uses: uses, of: of };
}

// ── 评论钉（P2 用，结构先定下来）────────────────────────────────────────────

function commentsFile(designRoot, projectId) {
	return join(designProjectDir(designRoot, projectId), "comments.json");
}

/** 读评论钉（全部）。坏文件返回空表。 */
export function readComments(designRoot, projectId) {
	const data = readJson(commentsFile(designRoot, projectId));
	const list = data && Array.isArray(data.comments) ? data.comments.filter((row) => row && typeof row === "object") : [];
	return list;
}

/** 写评论钉（整表替换）。 */
export function writeComments(designRoot, projectId, comments) {
	const list = (Array.isArray(comments) ? comments : []).slice(-DESIGN_LIMITS.commentsPerTarget * 4);
	atomicWrite(commentsFile(designRoot, projectId), JSON.stringify({ comments: list }, null, 1));
	return list;
}

// ── 统计（画布 / 工具列表用）───────────────────────────────────────────────

/** 一个项目的设计资产摘要：组件数、画板数、最近更新时间。 */
export function designSummary(designRoot, projectId) {
	const components = listEntities(designRoot, projectId, "component");
	const artboards = listEntities(designRoot, projectId, "artboard");
	const times = components.concat(artboards).map((row) => (typeof row.updatedAt === "string" ? row.updatedAt : "")).filter(Boolean).sort();
	return {
		components: components.length,
		artboards: artboards.length,
		latestUpdatedAt: times.length > 0 ? times[times.length - 1] : ""
	};
}

/** 目录是否已经存在（给「首次建目录」判断用）。 */
export function designProjectExists(designRoot, projectId) {
	try { return statSync(designProjectDir(designRoot, projectId)).isDirectory(); } catch (error) { return false; }
}
