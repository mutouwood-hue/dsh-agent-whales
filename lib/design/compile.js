/**
 * 组件工坊：宿主编译与「源码定位表」（设计方案 §6.2 / §9.3，P0 结论见文档 §15）。
 *
 * 两件事：
 *   1) **编译**：TSX → CommonJS（sucrase，`production: true`）。
 *      ⚠️ P0 实测：不能用 `production: false` 拿 `jsxDEV` 的 `__source` ——
 *      ① React 生产版 `react/jsx-dev-runtime` 里 `jsxDEV = void 0`（空桩）；
 *      ② sucrase 的 `__source` 只有 lineNumber，**没有 columnNumber**，同行多元素分不开。
 *   2) **定位表**：用 `@babel/parser` 收集每个 JSX 开标签的 `{ wsrc, line, column, tag, dynamic }`，
 *      再用 `magic-string` 把 `data-wsrc="e<i>"` 插进开标签名之后，一起交给 sucrase 编译。
 *      运行时的 DOM 上就有 `data-wsrc`，人点中元素 → 查表得行列 → 评论钉 / P3 写回都靠它。
 *
 * 这个模块**不碰磁盘**、不依赖插件宿主：给定源码就返回编译结果，宿主负责落盘与锁。
 */
import { createRequire } from "node:module";

const requireHere = createRequire(import.meta.url);

/**
 * 取依赖。插件发布包不带 node_modules，`sucrase` / `@babel/parser` / `magic-string`
 * 按「插件自己的依赖 → 构建工具目录」两处找；都找不到时给出可读的报错，不静默降级
 *（降级成「能编译但没有定位表」会让评论钉悄悄失效）。
 */
function loadDeps() {
	const specs = [
		["sucrase", () => requireHere("sucrase")],
		["@babel/parser", () => requireHere("@babel/parser")],
		["magic-string", () => requireHere("magic-string")]
	];
	const out = {};
	for (const [name, fn] of specs) {
		try { out[name] = fn(); } catch (error) { out[name] = undefined; }
	}
	return out;
}
const DEPS = loadDeps();

/** 依赖是否齐全；宿主启动时据此决定要不要注册设计工具（缺依赖就明说，不半残）。 */
export function designDepsReady() {
	return Boolean(DEPS.sucrase && DEPS["@babel/parser"] && DEPS["magic-string"]);
}

/** 缺哪些依赖（给日志 / 工具报错用）。 */
export function designDepsMissing() {
	return ["sucrase", "@babel/parser", "magic-string"].filter((name) => !DEPS[name]);
}

// ── 导入白名单 ──────────────────────────────────────────────────────────────

/** 组件包虚拟模块：`import { Button } from "@cds"` → 当前组件包的 raw 导出。 */
export const PACK_SPECIFIER = "@cds";
/** 项目内组件：`import Card from "@project/StatCard"`。 */
export const PROJECT_PREFIX = "@project/";

/** 允许 `import` 的运行时模块（沙箱里都映射到自带的那份 React）。 */
const ALLOWED_RUNTIME = new Set(["react"]);

const IMPORT_RE = /(?:^|[\s;])(?:import\s+(?:[^'"()]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * 抽出源码里所有的 import 说明符。**只做静态文本扫描**（不执行、不求值），
 * 扫不全也要尽量报清楚，所以同时返回源码里是否出现了动态 import()（一律拒绝）。
 */
export function collectImports(source) {
	const specs = [];
	const text = String(source || "");
	// 去掉注释与字符串误判：注释里的 import 不算（简单处理：整行注释 + 块注释）
	const stripped = text
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|\n)([ \t]*)\/\/[^\n]*/g, (m, lead, indent) => lead + indent + " ".repeat(m.length - lead.length - indent.length));
	for (const match of stripped.matchAll(IMPORT_RE)) specs.push(match[1]);
	const dynamic = /(?:^|[^.\w])import\s*\(/.test(stripped);
	return { specs: [...new Set(specs)], dynamic };
}

/**
 * 校验导入白名单。返回 `{ ok, errors: [{ message, specifier }] }`。
 * @param {string} source 源码
 * @param {{ hasPack?: boolean, projectNames?: Iterable<string> }} options
 *   hasPack：当前组件包是否支持 `@cds`（没有 raw 的旧包要拒）；projectNames：本项目已有组件名
 */
export function checkImports(source, options) {
	const opts = options || {};
	const known = new Set();
	for (const name of opts.projectNames || []) known.add(String(name));
	const { specs, dynamic } = collectImports(source);
	const errors = [];
	if (dynamic) {
		errors.push({ message: "不支持动态 import()：只能写顶层 import react / @cds / @project/*", specifier: "import()" });
	}
	for (const spec of specs) {
		if (ALLOWED_RUNTIME.has(spec)) continue;
		if (spec === "react/jsx-runtime") {
			// 自己写 JSX 不需要手动 import 运行时；显式 import 也放行（沙箱提供的是同一份）
			continue;
		}
		if (spec === PACK_SPECIFIER) {
			if (opts.hasPack === false) {
				errors.push({ message: "当前组件包不支持直接引用组件（缺少 raw 导出）：先换一个支持 raw 的组件包，或删掉 @cds 的 import", specifier: spec });
			}
			continue;
		}
		if (spec.startsWith(PROJECT_PREFIX) || spec.startsWith("@project")) {
			const name = spec.slice(PROJECT_PREFIX.length);
			if (!/^[A-Z][A-Za-z0-9]{1,39}$/.test(name)) {
				errors.push({ message: "@project/<名字> 里的名字必须是 PascalCase（如 @project/StatCard）", specifier: spec });
			} else if (!known.has(name)) {
				errors.push({ message: "本项目没有组件 " + name + "（用 whales_design_read 看已有组件名）", specifier: spec });
			}
			continue;
		}
		errors.push({ message: "只能 import react / " + PACK_SPECIFIER + " / @project/*，不允许 " + spec, specifier: spec });
	}
	return { ok: errors.length === 0, errors };
}

// ── 定位表：JSX 开标签 → { wsrc, line, column, tag, dynamic } ─────────────────

/**
 * 解析源码，收集 JSX 开标签的位置表。
 *
 * 行号 1-based、列号 0-based（与 @babel/parser 一致；对外展示时列号 +1）。
 * `dynamic` 表示这个元素落在 `.map()` / 条件表达式里——同一个 wsrc 会渲染出多个 DOM 节点，
 * 点选时要额外带「第几个命中」（见设计方案 §9.3）。
 */
export function buildJsxTable(source) {
	if (!DEPS["@babel/parser"]) throw new Error("缺 @babel/parser，无法生成定位表");
	const ast = parseSource(source);
	const table = [];
	// 「会重复渲染」的上下文：.map() / 条件 / 逻辑表达式 —— 只标到**直接子树**，不无限外溢
	function isRepeatableContext(node) {
		if (!node) return false;
		// 可选链（rows?.map()）在 babel 里是 OptionalCallExpression / OptionalMemberExpression，
		// 与普通 CallExpression / MemberExpression 是不同节点类型——不认它会漏标（P0 审计实测）。
		if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && node.callee) {
			const callee = node.callee;
			if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && callee.property) {
				const name = callee.property.name || callee.property.value;
				return name === "map" || name === "flatMap";
			}
		}
		return node.type === "ConditionalExpression" || node.type === "LogicalExpression";
	}
	// 先按统一规则编号（与点选 / 改写同一个顺序），再逐元素补 dynamic 与插入点
	const found = collectJsxElements(ast);
	for (const row of found) {
		const opening = row.opening;
		const nameNode = opening.name;
		let tag = "Fragment";
		// insertAt = null 表示「不注入」（Fragment：没有标签名，注入会掉进文本子节点）
		let insertAt = null;
		if (nameNode) {
			tag = nameNode.type === "JSXIdentifier" ? nameNode.name
				: nameNode.type === "JSXMemberExpression" ? (nameNode.object && nameNode.object.name ? nameNode.object.name + "." + (nameNode.property && nameNode.property.name) : "Member")
					: nameNode.type === "JSXNamespacedName" ? nameNode.namespace.name + ":" + nameNode.name.name
						: "Component";
			// 只给**原生 DOM 元素**（小写标签）注入。大写组件上 data-wsrc 会变成普通 prop，
			// CDS 里 274/282 个组件不 ...props 透传 → 静默丢失（P0 审计实测），所以组件级定位走
			// 「向上找最近的带 data-wsrc 的祖先 + DOM 层级」回退，而不是给组件塞陌生 prop。
			if (/^[a-z]/.test(tag)) insertAt = nameNode.end;
		}
		table.push({
			wsrc: row.wsrc,
			line: row.line,
			column: row.column,
			tag: tag,
			dynamic: false,
			_insertAt: insertAt
		});
	}
	// 再走一遍标 dynamic：进入 map/条件/逻辑的内部时，把它**直接包含**的 JSX 标成 dynamic
	const byElement = new Map();
	for (let i = 0; i < found.length; i += 1) byElement.set(found[i].element, table[i]);
	function markDynamic(node, inside) {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) { for (const child of node) markDynamic(child, inside); return; }
		const next = inside || isRepeatableContext(node);
		if (node.type === "JSXElement" || node.type === "JSXFragment") {
			const row = byElement.get(node);
			if (row !== undefined && next) row.dynamic = true;
		}
		for (const key of Object.keys(node)) {
			if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue;
			markDynamic(node[key], next);
		}
	}
	markDynamic(ast.program, false);
	return table;
}

/** 把定位表里的内部字段去掉（落盘 / 发给前端用）。 */
export function publicJsxTable(table) {
	return (Array.isArray(table) ? table : []).map((row) => ({ wsrc: row.wsrc, line: row.line, column: row.column, tag: row.tag, dynamic: row.dynamic }));
}

/**
 * 按**元素顺序**给每个 JSX 元素编号（`<div>` 与它的开标签算同一个元素）。
 *
 * 统一规则的原因（P0 审计发现的坑）：定位表、点选、改写三处必须用**同一套编号**，
 * 否则 `e3` 在表里是 `<span>`、在点选时却对到 `<Button>`，评论钉会钉错地方。
 * 之前 `buildJsxTable` 数的是 JSXOpeningElement、`replaceJsxText` 数的是 JSXElement，
 * 两者数目一样但**顺序不同**（`<div><span/></div>` 里 JSXElement 先遇到 div 再 span，
 * JSXOpeningElement 也是 div 再 span——看起来一致，但自闭合元素与 Fragment 会让两者错位）。
 * 所以这里只认一种：`**遍历时遇到的第一个「开标签」**——JSXElement / JSXFragment 的 openingElement 各算一个，
 * 裸 JSXOpeningElement（Fragment 简写不会出现）不单独计数。
 */
export function collectJsxElements(ast) {
	const elements = [];
	function walk(node) {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) { for (const child of node) walk(child); return; }
		let opening = null;
		if (node.type === "JSXElement" && node.openingElement) opening = node.openingElement;
		else if (node.type === "JSXFragment" && node.openingFragment) opening = node.openingFragment;
		if (opening !== null) {
			elements.push({
				wsrc: "e" + elements.length,
				opening: opening,
				element: node,
				// Fragment（<>…</>）没有标签名、不接受属性：**不参与 data-wsrc 注入**。
				// P0 审计实测：给它注入会把 `data-wsrc="e0"` 写进 JSX 文本子节点，页面渲染出一段可见垃圾，
				// 而且编译不报错、宿主照常落盘，只有浏览器里才看得出。Fragment 也不是可点选的 DOM 元素。
				...(node.type === "JSXFragment" ? { injectable: false } : {}),
				line: opening.loc ? opening.loc.start.line : undefined,
				column: opening.loc ? opening.loc.start.column : undefined
			});
		}
		for (const key of Object.keys(node)) {
			if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue;
			walk(node[key]);
		}
	}
	walk(ast.program);
	return elements;
}

/** 源码 → AST（babel，带 TSX）。解析失败抛错，由调用方转成可读信息。 */
function parseSource(source) {
	const babel = DEPS["@babel/parser"];
	if (!babel) throw new Error("缺 @babel/parser");
	return babel.parse(String(source || ""), {
		sourceType: "module",
		plugins: ["typescript", "jsx"],
		errorRecovery: false,
		allowReturnOutsideFunction: true
	});
}

/**
 * 从源码里找出顶层 `export const examples = [...]` / `export const tweaks = {...}`。
 *
 * 为什么不在运行时取：运行时取要真的执行组件；而宿主要在**写盘前**就知道有几组 examples、
 * 有没有 tweaks（给工具返回和 Puck 字段用）。所以用 babel 只看字面量结构：
 *   · `examples` 必须是数组字面量 → 返回 `{ ok: true, count, values }`（值走 JSON.parse，拿不到就只给 count）
 *   · `tweaks` 必须是对象字面量 → 返回 `{ ok: true, keys }`
 * 解构 / 变量引用 / 条件表达式一律视为「不是字面量」，给 `{ ok: false, reason }`，让调用方按「没写」处理并提示。
 */
export function readModuleExports(source) {
	const babel = DEPS["@babel/parser"];
	const out = { examples: { ok: false, reason: "未声明" }, tweaks: { ok: false, reason: "未声明" } };
	if (!babel) return out;
	let ast;
	try {
		ast = babel.parse(String(source || ""), { sourceType: "module", plugins: ["typescript", "jsx"], allowReturnOutsideFunction: true });
	} catch (error) {
		return out;
	}
	for (const statement of ast.program.body) {
		if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) continue;
		const decl = statement.declaration;
		if (decl.type !== "VariableDeclaration") continue;
		for (const declarator of decl.declarations) {
			if (!declarator.id || declarator.id.type !== "Identifier") continue;
			const name = declarator.id.name;
			if (name !== "examples" && name !== "tweaks") continue;
			const init = declarator.init;
			if (!init) { out[name] = { ok: false, reason: "声明了但没赋值" }; continue; }
			if (name === "examples") {
				if (init.type !== "ArrayExpression") { out.examples = { ok: false, reason: "examples 必须是数组字面量" }; continue; }
				let values;
				try { values = literalValue(init); } catch (error) { values = undefined; }
				out.examples = { ok: true, count: init.elements.length, values: values };
			} else {
				if (init.type !== "ObjectExpression") { out.tweaks = { ok: false, reason: "tweaks 必须是对象字面量" }; continue; }
				const keys = [];
				for (const prop of init.properties) {
					if (prop.type !== "ObjectProperty" || !prop.key) continue;
					keys.push(prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value));
				}
				out.tweaks = { ok: true, keys: keys.slice(0, 20) };
			}
		}
	}
	return out;
}

/** 把字面量 AST 转成 JSON 值；遇到表达式（变量 / 调用）就抛，交给调用方降级。 */
function literalValue(node) {
	switch (node.type) {
		case "StringLiteral": return node.value;
		case "NumericLiteral": return node.value;
		case "BooleanLiteral": return node.value;
		case "NullLiteral": return null;
		case "ArrayExpression": return node.elements.map((element) => (element === null ? null : literalValue(element)));
		case "ObjectExpression": {
			const out = {};
			for (const prop of node.properties) {
				if (prop.type !== "ObjectProperty" || !prop.key) continue;
				const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
				out[key] = literalValue(prop.value);
			}
			return out;
		}
		default: throw new Error("非字面量：" + node.type);
	}
}

/** 按 wsrc 找一行定位表。 */
export function locateByWsrc(table, wsrc) {
	const list = Array.isArray(table) ? table : [];
	for (const row of list) if (row.wsrc === wsrc) return row;
	return undefined;
}

/** 行列 → 源码片段（评论钉发给 agent 的「这里是哪段代码」）。 */
export function sourceSnippet(source, line, column, options) {
	const opts = options || {};
	const maxLen = Number.isFinite(opts.maxLength) ? opts.maxLength : 200;
	const lines = String(source || "").split("\n");
	const idx = Number(line) - 1;
	if (!(idx >= 0 && idx < lines.length)) return "";
	const text = lines[idx];
	const start = Math.max(0, Number(column) || 0);
	const slice = text.slice(start).trim();
	return slice.length > maxLen ? slice.slice(0, maxLen) + "…" : slice;
}

// ── 编译 ────────────────────────────────────────────────────────────────────

/**
 * 编译一份 TSX 源码。
 *
 * @param {string} source 整份源码
 * @param {object} options
 *   · fileName   编译日志里显示的文件名（默认 <name>.tsx）
 *   · hasPack    当前组件包是否支持 @cds（false → 用 @cds 直接报错）
 *   · projectNames 本项目已有组件名（@project/* 校验用）
 *
 * @returns {{ ok: boolean, code: string, jsxTable: Array, errors: Array<{message,line,column,excerpt,kind}> }}
 *   code 只在 ok 时可用；errors 每一行都有能直接给 agent 读的 message（含行列与源码摘录）。
 */
export function compileDesignSource(source, options) {
	const opts = options || {};
	const text = String(source || "");
	const fileName = typeof opts.fileName === "string" && opts.fileName !== "" ? opts.fileName : "component.tsx";
	const errors = [];
	if (!designDepsReady()) {
		return { ok: false, code: "", jsxTable: [], errors: [{ kind: "deps", message: "宿主编译依赖缺失：" + designDepsMissing().join(" / ") + "（装好插件依赖后重试）" }] };
	}
	if (text.trim() === "") {
		return { ok: false, code: "", jsxTable: [], errors: [{ kind: "source", message: "源码是空的" }] };
	}

	// 1) 导入白名单（先查，报错比编译器更可读）
	const imports = checkImports(text, { hasPack: opts.hasPack, projectNames: opts.projectNames });
	if (!imports.ok) return { ok: false, code: "", jsxTable: [], errors: imports.errors.map((e) => ({ kind: "import", message: e.message, specifier: e.specifier })) };

	// 2) 定位表（babel 解析失败 → 直接报语法错，含行列）
	let table;
	try {
		table = buildJsxTable(text);
	} catch (error) {
		return { ok: false, code: "", jsxTable: [], errors: [{ kind: "parse", ...parseErrorOf(error) }] };
	}

	// 3) 插 data-wsrc（magic-string，最小改动）
	let patched = text;
	if (table.length > 0) {
		try {
			const MagicString = DEPS["magic-string"];
			const ms = new MagicString(text);
			for (const row of table) if (row._insertAt !== null) ms.appendLeft(row._insertAt, " data-wsrc=\"" + row.wsrc + "\"");
			patched = ms.toString();
		} catch (error) {
			return { ok: false, code: "", jsxTable: [], errors: [{ kind: "annotate", message: "注入 data-wsrc 失败：" + String(error && error.message || error) }] };
		}
	}

	// 4) sucrase 编译（production: true —— 见文件头，P0 结论）
	try {
		const out = DEPS.sucrase.transform(patched, {
			transforms: ["typescript", "jsx", "imports"],
			jsxRuntime: "automatic",
			production: true,
			filePath: fileName
		});
		return { ok: true, code: String(out.code || ""), jsxTable: publicJsxTable(table), errors: [] };
	} catch (error) {
		return { ok: false, code: "", jsxTable: publicJsxTable(table), errors: [{ kind: "compile", ...compileErrorOf(error, patched) }] };
	}
}

/** sucrase 的报错是 `Error transforming X.tsx: Unexpected token (1:55)`：把行列与源码摘录取出来。 */
function compileErrorOf(error, source) {
	const raw = String(error && error.message || error);
	const match = raw.match(/\((\d+):(\d+)\)/);
	const line = match ? Number(match[1]) : undefined;
	const column = match ? Number(match[2]) + 1 : undefined; // sucrase 的列是 0-based，对外 +1
	const excerpt = Number.isFinite(line) ? String(source).split("\n")[line - 1] : undefined;
	const clean = raw.replace(/^Error transforming [^:]+:\s*/, "");
	return {
		message: clean + (Number.isFinite(line) ? "（第 " + line + " 行第 " + column + " 列）" : ""),
		...(Number.isFinite(line) ? { line: line } : {}),
		...(Number.isFinite(column) ? { column: column } : {}),
		...(typeof excerpt === "string" ? { excerpt: excerpt.trim().slice(0, 160) } : {})
	};
}

/** babel 的报错带 `(line:column)` 与 `loc`：统一成和 sucrase 一致的形状。 */
function parseErrorOf(error) {
	const raw = String(error && error.message || error);
	const loc = error && error.loc && Number.isFinite(error.loc.line) ? error.loc : undefined;
	const match = raw.match(/\((\d+):(\d+)\)/);
	const line = loc ? loc.line : (match ? Number(match[1]) : undefined);
	const column = loc && Number.isFinite(loc.column) ? loc.column + 1 : (match ? Number(match[2]) + 1 : undefined);
	return {
		message: raw.replace(/\s*\(\d+:\d+\)\s*$/, "").trim() + (Number.isFinite(line) ? "（第 " + line + " 行" + (Number.isFinite(column) ? "第 " + column + " 列" : "") + "）" : ""),
		...(Number.isFinite(line) ? { line: line } : {}),
		...(Number.isFinite(column) ? { column: column } : {})
	};
}

// ── JSX 元素级的文本 / 类名改写（P3「直接改」用同一份定位表）─────────────────

/**
 * 把某一行的 JSX 开标签里某个属性的值换掉（最小替换）。P3 的「改 token 类名」走这里。
 * 找不到 / 属性值是表达式（不是字符串字面量）时返回 `{ ok: false, reason }`，让调用方提示用户改用评论。
 */
export function replaceAttribute(source, wsrc, attrName, newValue) {
	const babel = DEPS["@babel/parser"];
	const MagicString = DEPS["magic-string"];
	if (!babel || !MagicString) return { ok: false, reason: "缺 @babel/parser 或 magic-string" };
	const text = String(source || "");
	let ast;
	try { ast = parseSource(text); } catch (error) {
		return { ok: false, reason: "源码解析失败：" + String(error && error.message || error) };
	}
	// 与 buildJsxTable 用同一套编号（见 collectJsxElements 的注释）
	const found = collectJsxElements(ast).find((row) => row.wsrc === wsrc);
	if (!found || found.element.type !== "JSXElement") return { ok: false, reason: "没找到 " + wsrc + " 对应的元素（源码可能已经改过；Fragment 不支持直接改属性）" };
	const target = found.opening;
	const attr = (target.attributes || []).find((a) => a && a.type === "JSXAttribute" && a.name && a.name.name === attrName);
	if (!attr) return { ok: false, reason: "这个元素没有 " + attrName + " 属性，要新加请用评论让 AI 改" };
	const value = attr.value;
	// 只有字符串字面量（className="a b"）能直接换；表达式（className={cls}）交给评论让 AI 改
	if (!value || value.type !== "StringLiteral") {
		return { ok: false, reason: attrName + " 是代码算出来的，没法直接改；用评论让 AI 改" };
	}
	const ms = new MagicString(text);
	ms.overwrite(value.start, value.end, JSON.stringify(String(newValue)));
	return { ok: true, source: ms.toString() };
}

/**
 * 把某个元素的纯文本子节点换成新文本（P3「改字」）。只有「元素 > 单个 StringLiteral 子节点」才敢改；
 * 是 `{变量}` / 多个子节点 / 子元素时拒绝，让用户改用评论。
 */
export function replaceJsxText(source, wsrc, newText) {
	const babel = DEPS["@babel/parser"];
	const MagicString = DEPS["magic-string"];
	if (!babel || !MagicString) return { ok: false, reason: "缺 @babel/parser 或 magic-string" };
	const text = String(source || "");
	let ast;
	try { ast = parseSource(text); } catch (error) {
		return { ok: false, reason: "源码解析失败：" + String(error && error.message || error) };
	}
	// 与 buildJsxTable 用同一套编号
	const found = collectJsxElements(ast).find((row) => row.wsrc === wsrc);
	if (!found || found.element.type !== "JSXElement") return { ok: false, reason: "没找到 " + wsrc + " 对应的元素（源码可能已经改过）" };
	const target = found.element;
	const children = (target.children || []).filter((child) => !(child.type === "JSXText" && child.value.trim() === ""));
	if (children.length !== 1 || children[0].type !== "JSXText") {
		return { ok: false, reason: "这段文字是代码算出来的（或含子元素），没法直接改；用评论让 AI 改" };
	}
	const ms = new MagicString(text);
	ms.overwrite(children[0].start, children[0].end, String(newText));
	return { ok: true, source: ms.toString() };
}
