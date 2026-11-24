/**
 * 组件工坊：宿主侧设计服务（设计方案 §5 / §8 / §11）。
 *
 * 把「读写落盘 + 编译 + 元素同步 + 渲染回报」收在一处，工具与 HTTP 路由共用同一套规则，
 * 避免两边各写一份校验（评审时最容易漂移的地方）。
 *
 * 不直接持有宿主服务：调用方把 `deps` 传进来（`applyCanvasElements` / `readCanvasPage` / 在线画布表）。
 */
import { existsSync } from "node:fs";
import { compileDesignSource, PACK_SPECIFIER, PROJECT_PREFIX, collectImports, locateByWsrc, sourceSnippet, buildJsxTable, readModuleExports } from "./compile.js";
import {
	designEntityDir, designProjectDir, designSummary, listEntities, readEntity, removeEntity, writeEntity,
	buildUsageMap, DESIGN_LIMITS, COMPONENT_NAME_RE, ARTBOARD_ID_RE
} from "./store.js";

/** 工具/路由错误的统一形状：`{ code, message, data? }`（code 是 HTTP 风格数字，供宿主 envelope 用）。 */
export function designError(code, message, data) {
	const error = new Error("[" + code + "] " + message);
	error.designCode = code;
	if (data !== undefined) error.designData = data;
	return error;
}

/** propsSchema 允许的字段类型（沿用词表口径，可直接进 Puck 积木栏）。 */
const FIELD_TYPES = new Set(["text", "textarea", "number", "select", "radio", "slot"]);

/** 规范化 propsSchema：只留允许的类型，select / radio 必须有非空 options。 */
export function normalizePropsSchema(raw) {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) throw designError(40001, "propsSchema 必须是对象");
	const out = {};
	let count = 0;
	for (const key of Object.keys(raw)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key)) throw designError(40001, "propsSchema 的键必须是合法标识符：" + key);
		const field = raw[key];
		if (!field || typeof field !== "object" || Array.isArray(field)) throw designError(40001, "propsSchema." + key + " 必须是对象");
		const type = typeof field.type === "string" ? field.type : "";
		if (!FIELD_TYPES.has(type)) throw designError(40001, "propsSchema." + key + ".type 只能是 " + [...FIELD_TYPES].join(" / "));
		const row = { type: type };
		if (typeof field.label === "string" && field.label !== "") row.label = field.label.slice(0, 60);
		if (type === "select" || type === "radio") {
			const options = Array.isArray(field.options) ? field.options.filter((value) => typeof value === "string" && value !== "") : [];
			if (options.length === 0) throw designError(40001, "propsSchema." + key + " 是 " + type + "，必须给非空 options（字符串数组）");
			if (options.length > 40) throw designError(40001, "propsSchema." + key + ".options 最多 40 个");
			row.options = options.slice(0, 40).map((value) => value.slice(0, 60));
		}
		out[key] = row;
		count += 1;
		if (count > 40) throw designError(40001, "propsSchema 最多 40 个字段");
	}
	return out;
}

/** 规范化 examples：每项是 props 对象，最多 DESIGN_LIMITS.examples 组。 */
export function normalizeExamples(raw) {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw)) throw designError(40001, "examples 必须是数组");
	if (raw.length > DESIGN_LIMITS.examples) throw designError(40001, "examples 最多 " + DESIGN_LIMITS.examples + " 组");
	return raw.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw designError(40001, "examples[" + index + "] 必须是对象");
		let text;
		try { text = JSON.stringify(item); } catch (error) { throw designError(40001, "examples[" + index + "] 不能序列化"); }
		if (text.length > 8 * 1024) throw designError(40001, "examples[" + index + "] 太大（上限 8KB）");
		return item;
	});
}

/** 从编译结果里抽出 `@project/*` 依赖（写进 meta.imports，用于「被谁用」与快照）。 */
function projectImportsOf(source) {
	const { specs } = collectImports(source);
	return specs.filter((spec) => spec.startsWith(PROJECT_PREFIX)).map((spec) => spec.slice(PROJECT_PREFIX.length));
}

/**
 * 创建设计服务。
 *
 * @param {object} deps
 *   · designRoot  () => string            设计产物根目录
 *   · canvas      { readPage(projectId), apply(projectId, change) }
 *   · live        { request(projectId, payload, timeoutMs) }  可选：在线画布渲染回报
 *   · now         () => ISO 字符串       可选，测试注入
 *   · warn        (label, error) => void 可选
 */
export function createDesignService(deps) {
	const designRoot = typeof deps.designRoot === "function" ? deps.designRoot : () => String(deps.designRoot || "");
	const canvas = deps.canvas;
	const live = deps.live;
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};

	function root() {
		const value = designRoot();
		if (typeof value !== "string" || value === "") throw designError(50001, "设计根目录未配置");
		return value;
	}

	/** 当前项目组件名集合（@project 校验 + pack-api 合并用）。 */
	function componentNames(projectId) {
		return listEntities(root(), projectId, "component").map((row) => row.id);
	}

	/** 画布上某项目用到的组件包 id（没摆组件库节点时是内置 shadcn）。 */
	function packIdOf(projectId) {
		if (!canvas || typeof canvas.readPage !== "function") return "";
		const page = canvas.readPage(projectId);
		const elements = page && page.elements ? Object.values(page.elements) : [];
		for (const element of elements) {
			if (element && element.kind === "library" && element.data && typeof element.data.packId === "string" && element.data.packId !== "") return element.data.packId;
		}
		return "";
	}

	/** 能否用 `@cds`：需要调用方告诉（组件包有没有 raw），这里只做默认 false 的保守判断。 */
	function packSupportsRaw(projectId, hasPack) {
		if (typeof hasPack === "boolean") return hasPack;
		// 默认：摆了组件库节点且不是内置包 → 认为支持（内置 shadcn 包在 P1 也补 raw）
		const id = packIdOf(projectId);
		return id !== "";
	}

	// ── 写组件 / 画板 ────────────────────────────────────────────────────

	/**
	 * 写一个组件或画板。**编译失败不落盘**；锁定时不落盘（先判锁再写文件）。
	 * 异步只因为画布元素写入要走宿主的 CAS 锁（`applyCanvasElements` 是 async）。
	 * @returns {Promise<{ written, kind, id, compile, render, locked?, uses?, meta? }>}
	 */
	async function writeDesign(projectId, input) {
		const kind = input && input.kind === "artboard" ? "artboard" : "component";
		const id = kind === "component" ? String(input.name || "") : String(input.artboardId || "");
		if (kind === "component" && !COMPONENT_NAME_RE.test(id)) throw designError(40001, "组件名必须是 PascalCase（如 ApprovalTimeline），2–40 字符");
		if (kind === "artboard" && !ARTBOARD_ID_RE.test(id)) throw designError(40001, "画板 id 只能是 1–32 位小写字母 / 数字 / 连字符");
		if (String(input.source || "").trim() === "") throw designError(40001, "source 必填（整份 TSX 源码）");

		// 1) 判锁（在写文件之前）
		const elementId = kind === "component" ? "comp:" + id : "board:" + id;
		const page = canvas && typeof canvas.readPage === "function" ? canvas.readPage(projectId) : { rev: 0, elements: {} };
		const existing = page && page.elements ? page.elements[elementId] : undefined;
		if (existing && existing.userEdited === true && input.by !== "user") {
			return {
				written: false,
				locked: true,
				kind: kind,
				id: id,
				reason: "用户改过这个" + (kind === "component" ? "组件" : "画板") + "，已锁定；换一个名字另起一版，或请用户在画布上「解锁让 AI 继续改」"
			};
		}

		// 2) 附加上下文校验
		const names = componentNames(projectId);
		if (kind === "component" && names.indexOf(id) < 0 && names.length >= DESIGN_LIMITS.componentsPerProject) {
			throw designError(40001, "每个项目最多 " + DESIGN_LIMITS.componentsPerProject + " 个组件，已经满了");
		}
		const propsSchema = normalizePropsSchema(input.propsSchema);
		// examples：优先用源码里的 `export const examples = [...]`（方案 §6.2 的约定），参数里的 examples 作为覆盖
		const declared = readModuleExports(input.source);
		let examples = normalizeExamples(input.examples);
		if (examples === undefined && declared.examples.ok && Array.isArray(declared.examples.values)) {
			examples = normalizeExamples(declared.examples.values);
		}
		const previous = readEntity(root(), projectId, kind, id);

		// 3) 编译（失败直接返回，不写盘）
		const compiled = compileDesignSource(input.source, {
			fileName: id + ".tsx",
			hasPack: packSupportsRaw(projectId, input.hasPack),
			projectNames: names.filter((name) => name !== id)
		});
		if (!compiled.ok) {
			return { written: false, kind: kind, id: id, compile: { ok: false, errors: compiled.errors }, locked: false };
		}

		// 4) 落盘
		const imports = projectImportsOf(input.source);
		const meta = Object.assign({}, previous ? previous.meta : {}, {
			title: typeof input.title === "string" && input.title !== "" ? input.title.slice(0, 60) : (previous && previous.meta.title) || id,
			description: typeof input.description === "string" ? input.description.slice(0, 200) : (previous && previous.meta.description) || "",
			updatedBy: input.by === "user" ? "user" : "agent",
			sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
			imports: imports,
			jsxTable: compiled.jsxTable,
			compiledHash: hashOf(compiled.code),
			sourceHash: hashOf(input.source),
			...(propsSchema !== undefined ? { propsSchema: propsSchema } : (previous && previous.meta.propsSchema ? { propsSchema: previous.meta.propsSchema } : {})),
			...(examples !== undefined ? { examples: examples } : (previous && previous.meta.examples ? { examples: previous.meta.examples } : {})),
			...(declared.tweaks.ok ? { tweaks: declared.tweaks.keys } : {}),
			...(kind === "artboard" ? { width: input.width === "mobile" ? "mobile" : "desktop" } : {}),
			...(kind === "artboard" && typeof input.requirementId === "string" && input.requirementId !== "" ? { requirementId: input.requirementId } : {})
		});
		const saved = writeEntity(root(), projectId, kind, id, { source: input.source, compiled: compiled.code, meta: meta });

		// 5) 画布元素（只存引用，不存源码）
		const element = kind === "component"
			? {
				id: elementId,
				kind: "component",
				data: {
					name: id,
					title: meta.title,
					sourceHash: meta.sourceHash,
					// 元素 data 只放**引用与展示用字段**（设计方案 §5.2）：schema 全文在 meta.json 里，
					// 前端要它就走 GET /design/source。这里只留键名，保证元素不会撞穿画布 16KB 上限。
					propsKeys: meta.propsSchema && typeof meta.propsSchema === "object" ? Object.keys(meta.propsSchema).slice(0, 40) : [],
					examplesCount: Array.isArray(meta.examples) ? meta.examples.length : 0,
					packId: packIdOf(projectId),
					uses: meta.imports
				},
				provenance: { by: input.by === "user" ? "user" : "agent", sessionId: input.sessionId, sourceMessageIds: input.sourceMessageIds }
			}
			: {
				id: elementId,
				kind: "artboard",
				data: {
					artboardId: id,
					title: meta.title,
					width: meta.width,
					sourceHash: meta.sourceHash,
					uses: meta.imports,
					links: Array.isArray(input.links) ? input.links.filter((value) => typeof value === "string").slice(0, 40) : [],
					...(meta.requirementId ? { requirementId: meta.requirementId } : {})
				},
				provenance: { by: input.by === "user" ? "user" : "agent", sessionId: input.sessionId, sourceMessageIds: input.sourceMessageIds }
			};
		// 落盘之后写画布元素：**失败要回滚磁盘**。不回滚的话会留下「盘上有源码、画布上没节点」的孤儿
		//（下次判锁也看不到它），比直接失败更难排查。
		let applied;
		try {
			applied = await applyWithRetry(projectId, { upsert: [element], by: input.by === "user" ? "user" : "agent" });
		} catch (error) {
			try {
				if (previous === undefined) removeEntity(root(), projectId, kind, id);
				else writeEntity(root(), projectId, kind, id, { source: previous.source, compiled: previous.compiled, meta: previous.meta });
			} catch (rollbackError) { /* 回滚失败也不能盖住原始错误 */ }
			throw error;
		}
		const usage = buildUsageMap(root(), projectId);
		return {
			written: true,
			kind: kind,
			id: id,
			elementId: elementId,
			rev: applied.rev,
			compile: { ok: true, errors: [], jsxCount: compiled.jsxTable.length },
			...(declared.examples.ok ? {} : { examplesNote: "源码里没有解析到 `export const examples = [...]`（" + declared.examples.reason + "）；画布预览会用 propsSchema 的默认值" }),
			meta: safeMeta(saved.meta),
			// uses = 这个实体 import 了谁（组件名列表）；usedBy = 谁引用了它（删除保护用）
			uses: usage.of[id] || [],
			usedBy: usage.uses[id] || []
		};
	}

	/** 画布元素写入：CAS 冲突重试 3 次（同 whales_prototype_draw）。 */
	async function applyWithRetry(projectId, change) {
		let lastError;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const page = canvas.readPage(projectId);
			try {
				const applied = await canvas.apply(projectId, Object.assign({ expectedRevision: page.rev }, change));
				// 宿主可能把元素放进 rejected（超限 / 字段非法）或 locked（人改过）。
				// 这两种都意味着「元素没进画布」——绝不能当成功继续往下走，否则就是静默失败。
				const rejected = applied && Array.isArray(applied.rejected) ? applied.rejected : [];
				if (rejected.length > 0) {
					const first = rejected[0] || {};
					const error = new Error("画布元素写入被拒：" + String(first.reason || "未知原因") + "（" + String(first.id || "") + "）");
					error.designCode = 40001;
					throw error;
				}
				const locked = applied && Array.isArray(applied.locked) ? applied.locked : [];
				if (locked.length > 0) {
					const error = new Error("元素被锁定（人改过）：" + locked.join("、"));
					error.designCode = 40902;
					throw error;
				}
				return applied;
			} catch (error) {
				lastError = error;
				const conflict = error && (error.canvasCode === 40902 || /revision conflict/i.test(String(error.message || "")));
				if (!conflict) throw error;
			}
		}
		throw lastError;
	}

	// ── 读 ──────────────────────────────────────────────────────────────

	/** 列表：本项目组件 + 本需求画板。 */
	function listDesign(projectId, requirementId) {
		const usage = buildUsageMap(root(), projectId);
		const components = listEntities(root(), projectId, "component").map((row) => ({
			name: row.id,
			title: row.title || row.id,
			description: row.description || "",
			props: row.propsSchema ? Object.keys(row.propsSchema) : [],
			examples: Array.isArray(row.examples) ? row.examples.length : 0,
			imports: row.imports || [],
			usedBy: usage.uses[row.id] || [],
			updatedAt: row.updatedAt,
			updatedBy: row.updatedBy || ""
		}));
		const artboards = listEntities(root(), projectId, "artboard")
			.filter((row) => requirementId === undefined || requirementId === "" || row.requirementId === requirementId)
			.map((row) => ({
				artboardId: row.id,
				title: row.title || row.id,
				width: row.width || "desktop",
				requirementId: row.requirementId || "",
				imports: row.imports || [],
				updatedAt: row.updatedAt,
				updatedBy: row.updatedBy || ""
			}));
		return { summary: designSummary(root(), projectId), components: components, artboards: artboards };
	}

	/**
	 * 列出本项目**全部组件的编译产物**（给 Puck 积木栏的沙箱岛用）。
	 *
	 * 与 getDesign 的区别：这里一次返回所有组件的 compiled + 传递依赖闭包 + examples，
	 * 前端拿到就能直接开沙箱渲染，不用逐个再请求（一个原型帧里可能有十几个项目组件）。
	 * 上限：单个组件编译产物 ≤ 256KB（store 层的常量），总量按组件数 × 上限兜住。
	 */
	function listCompiledEntities(projectId) {
		const names = listEntities(root(), projectId, "component");
		const compiledByName = new Map();
		for (const row of names) {
			const entity = readEntity(root(), projectId, "component", row.id);
			if (entity === undefined) continue;
			compiledByName.set(row.id, { name: row.id, compiled: entity.compiled, imports: Array.isArray(entity.meta.imports) ? entity.meta.imports : [] });
		}
		// 依赖闭包：A 用到 B，就把 B 的编译产物一起带上（沙箱里 @project/B 才能 require 到）
		function closureOf(name, seen) {
			if (seen.has(name)) return [];
			seen.add(name);
			const out = [];
			const row = compiledByName.get(name);
			if (row === undefined) return out;
			for (const dep of row.imports) out.push(...closureOf(dep, seen));
			const depRow = compiledByName.get(name);
			if (depRow !== undefined) out.push({ name: depRow.name, compiled: depRow.compiled });
			return out;
		}
		return names.map((row) => {
			const entity = readEntity(root(), projectId, "component", row.id);
			const seen = new Set([row.id]);
			const dependencies = [];
			for (const dep of (entity && Array.isArray(entity.meta.imports) ? entity.meta.imports : [])) {
				for (const item of closureOf(dep, seen)) {
					if (dependencies.findIndex((existing) => existing.name === item.name) < 0) dependencies.push({ name: item.name, compiled: item.compiled });
				}
			}
			return {
				name: row.id,
				title: row.title || row.id,
				compiled: entity === undefined ? "" : entity.compiled,
				dependencies: dependencies,
				examples: Array.isArray(row.examples) ? row.examples : [],
				propsSchema: row.propsSchema || {}
			};
		});
	}

	/** 读一个实体的源码 + meta。 */
	function getDesign(projectId, kind, id) {
		const entity = readEntity(root(), projectId, kind, id);
		if (entity === undefined) throw designError(40401, (kind === "component" ? "组件" : "画板") + " " + id + " 不存在");
		return {
			kind: kind,
			id: id,
			source: entity.source,
			// 编译产物随源码一起下发：画布上的沙箱要直接执行它（不在浏览器里再编译一遍）
			compiledCode: entity.compiled,
			meta: safeMeta(entity.meta),
			compiledBytes: entity.compiled.length,
			jsxTable: Array.isArray(entity.meta.jsxTable) ? entity.meta.jsxTable : []
		};
	}

	/** 删除实体（连带删画布元素）。被别的组件 / 画板 import 时，agent 不能强删。 */
	async function removeDesign(projectId, kind, id, options) {
		const opts = options || {};
		const usage = buildUsageMap(root(), projectId);
		const usedBy = usage.uses[id] || [];
		if (usedBy.length > 0 && opts.force !== true) {
			throw designError(40902, "被 " + usedBy.join("、") + " 用到，不能直接删；要强制删除请让用户在画布上操作", { usedBy: usedBy });
		}
		const removed = removeEntity(root(), projectId, kind, id);
		if (!removed) throw designError(40401, id + " 不存在");
		await applyWithRetry(projectId, { remove: [kind === "component" ? "comp:" + id : "board:" + id] });
		return { removed: true, kind: kind, id: id, usedBy: usedBy };
	}

	// ── 评论钉 ─────────────────────────────────────────────────────────

	/** 点选位置 → 源码上下文（评论钉 / P3 写回都要）。 */
	function contextOf(projectId, kind, id, wsrc) {
		const entity = readEntity(root(), projectId, kind, id);
		if (entity === undefined) throw designError(40401, id + " 不存在");
		const table = Array.isArray(entity.meta.jsxTable) ? entity.meta.jsxTable : [];
		const row = locateByWsrc(table, wsrc);
		if (row === undefined) throw designError(40401, "这个元素在源码里找不到了（源码可能已改过），刷新预览再点");
		return {
			wsrc: wsrc,
			line: row.line,
			column: row.column,
			tag: row.tag,
			dynamic: Boolean(row.dynamic),
			snippet: sourceSnippet(entity.source, row.line, row.column)
		};
	}

	// ── 渲染回报（§8.3）──────────────────────────────────────────────────

	/**
	 * 写完以后请在线画布渲染并等回报。没有在线画布 / 超时 → `unverified`（如实说，不假装渲染过）。
	 */
	async function renderReport(projectId, kind, id, options) {
		const opts = options || {};
		const entity = readEntity(root(), projectId, kind, id);
		if (entity === undefined) return { status: "unverified", reason: "no-entity" };
		if (!live || typeof live.request !== "function") {
			return { status: "unverified", reason: "no-live-canvas", note: "未在浏览器里渲染验证（此刻没有打开这个项目的画布）", visual: "unavailable" };
		}
		const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
		try {
			const result = await live.request(projectId, {
				kind: "render",
				target: kind === "component" ? { type: "component", name: id } : { type: "artboard", artboardId: id },
				exampleIndex: Number.isFinite(opts.exampleIndex) ? opts.exampleIndex : 0
			}, timeoutMs);
			if (!result || result.timeout) {
				return { status: "unverified", reason: "timeout", note: "画布在 " + Math.round(timeoutMs / 1000) + " 秒内没有回报渲染结果（可能卡住或页面不可见）", visual: "unavailable" };
			}
			if (result.ok === false) {
				return { status: "error", reason: "render-failed", error: result.error || "渲染失败", consoleErrors: result.consoleErrors || [], visual: "unavailable" };
			}
			return {
				status: "ok",
				ms: result.ms,
				size: { width: result.width, height: result.height },
				dom: {
					nodeCount: result.nodeCount,
					textLength: result.textLength,
					textSample: result.textSample,
					empty: Boolean(result.empty),
					buttons: result.buttons,
					inputs: result.inputs,
					tables: result.tables
				},
				visual: "unavailable",
				visualNote: "工具结果不能带图片，视觉效果需要人自己看画布"
			};
		} catch (error) {
			warn("design live render", error);
			return { status: "unverified", reason: "live-error", note: "向画布请求渲染时出错：" + String(error && error.message || error), visual: "unavailable" };
		}
	}

	// ── 组件包 API ───────────────────────────────────────────────────────

	/** 当前组件包的 api.json（读不了就给 null，不抛）。 */
	function packApi(packId, readApi) {
		if (typeof readApi !== "function") return null;
		try { return readApi(packId); } catch (error) { return null; }
	}

	return {
		root: root,
		projectDir: (projectId) => designProjectDir(root(), projectId),
		entityDir: (projectId, kind, id) => designEntityDir(root(), projectId, kind, id),
		packSupportsRaw,
		packIdOf,
		componentNames,
		writeDesign,
		listDesign,
		getDesign,
		listCompiledEntities,
		removeDesign,
		contextOf,
		renderReport,
		packApi,
		buildUsageMap: (projectId) => buildUsageMap(root(), projectId),
		designExists: (projectId) => existsSync(designProjectDir(root(), projectId))
	};
}

/** 短哈希（改动判定用，不要求密码学强度）。 */
function hashOf(text) {
	let hash = 0x811c9dc5;
	const value = String(text || "");
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return ("00000000" + hash.toString(16)).slice(-8);
}

/** meta 去掉不想暴露给 agent 的字段（jsxTable 太大，按需取）。 */
function safeMeta(meta) {
	if (!meta || typeof meta !== "object") return {};
	// 为什么要过滤到白名单：工具返回值要走宿主的 lossless JSON 校验。一旦夹带不可序列化的东西
	// （循环引用 / 函数 / undefined），整次调用会退化成空对象 {}，agent 就什么也拿不到。
	const keep = ["name", "artboardId", "title", "description", "updatedBy", "sessionId", "sourceHash", "compiledHash", "updatedAt", "createdAt", "sourceBytes", "width", "requirementId", "packId"];
	const out = {};
	for (const key of keep) {
		const value = meta[key];
		if (typeof value === "string" || typeof value === "boolean") out[key] = value;
		else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
		else if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key] = value.slice(0, 40);
	}
	if (meta.propsSchema && typeof meta.propsSchema === "object" && !Array.isArray(meta.propsSchema)) {
		try { out.propsSchema = JSON.parse(JSON.stringify(meta.propsSchema)); } catch (error) { /* 丢了也比整次失败好 */ }
	}
	if (Array.isArray(meta.examples)) {
		try { out.examples = JSON.parse(JSON.stringify(meta.examples)); } catch (error) { /* 同上 */ }
	}
	if (Array.isArray(meta.tweaks)) out.tweaks = meta.tweaks.filter((item) => typeof item === "string");
	return out;
}

export { buildJsxTable, collectImports, readModuleExports, PACK_SPECIFIER, PROJECT_PREFIX };
