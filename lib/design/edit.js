/**
 * 组件工坊 P3：「直接改」（设计方案 §9.4）。
 *
 * 人点中元素后，能改两类东西——覆盖大部分「改个字、换个颜色 / 间距」：
 *   1. **文本**：点中纯文本元素直接改字（`replaceJsxText`，在 compile.js 里）；
 *   2. **token 类**：属性面板列出该元素 `className` 里已有的类，按族分组（间距 / 颜色 / 圆角 / 字号…），
 *      下拉换成同族的另一个 token 类（`replaceClassName`）。
 *
 * 写回源码靠 `@babel/parser` 定位 + `magic-string` 最小替换，**找不到就如实拒绝**——
 * 动态拼出来的 className、文本来自变量时，提示「这里是代码算出来的，请用评论让 AI 改」，不硬改。
 */
import { createRequire } from "node:module";

const requireHere = createRequire(import.meta.url);
let babelParser = null;
let MagicStringCtor = null;
try { babelParser = requireHere("@babel/parser"); } catch (error) { babelParser = null; }
try { const mod = requireHere("magic-string"); MagicStringCtor = mod && mod.default ? mod.default : mod; } catch (error) { MagicStringCtor = null; }

function parseSource(source) {
	if (!babelParser) throw new Error("缺 @babel/parser");
	return babelParser.parse(String(source || ""), { sourceType: "module", plugins: ["typescript", "jsx"], allowReturnOutsideFunction: true });
}

/** 按统一规则收集 JSX 元素（与 compile.js 的 buildJsxTable 同一套编号）。 */
function collectElements(ast) {
	const elements = [];
	function walk(node) {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) { for (const child of node) walk(child); return; }
		if (node.type === "JSXElement" && node.openingElement) elements.push({ wsrc: "e" + elements.length, opening: node.openingElement, element: node });
		else if (node.type === "JSXFragment") elements.push({ wsrc: "e" + elements.length, opening: node.openingFragment, element: node });
		for (const key of Object.keys(node)) {
			if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue;
			walk(node[key]);
		}
	}
	walk(ast.program);
	return elements;
}

/** 把 Tailwind 类名归到「族」：属性面板按族分组，换类时只在同族里选。 */
export function classFamilyOf(name) {
	const text = String(name || "");
	if (/^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-/.test(text)) return "spacing";
	if (/^rounded/.test(text)) return "radius";
	if (/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/.test(text) || /^text-\d/.test(text)) return "font-size";
	if (/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\d)/.test(text)) return "font-weight";
	if (/^(w|h|min-w|min-h|max-w|max-h|size)-/.test(text)) return "size";
	if (/^(bg|text|border|ring|fill|stroke|from|via|to|outline|divide|placeholder|caret|accent)-/.test(text)) return "color";
	if (/^(flex|grid|block|inline|hidden|items|justify|self|col-|row-|order-|table)/.test(text)) return "layout";
	return "other";
}

/**
 * 列出某个元素「可改的 token 类」（属性面板数据源）。
 * @returns {{ classes: Array<{name, family}>, byFamily: Record<string, string[]> } | { error: string }}
 */
export function editableClasses(source, wsrc) {
	if (!babelParser) return { error: "缺 @babel/parser" };
	let ast;
	try { ast = parseSource(source); } catch (error) { return { error: "源码解析失败：" + String(error && error.message || error) }; }
	const found = collectElements(ast).find((row) => row.wsrc === wsrc);
	if (!found || found.element.type !== "JSXElement") return { error: "没找到 " + wsrc + " 对应的元素" };
	const attr = (found.opening.attributes || []).find((a) => a && a.type === "JSXAttribute" && a.name && a.name.name === "className");
	if (!attr) return { classes: [], byFamily: {} };
	if (!attr.value || attr.value.type !== "StringLiteral") return { error: "className 是代码算出来的，改不了；用评论让 AI 改" };
	const names = String(attr.value.value || "").split(/\s+/).filter(Boolean);
	const classes = names.map((name) => ({ name: name, family: classFamilyOf(name) }));
	const byFamily = {};
	for (const row of classes) (byFamily[row.family] = byFamily[row.family] || []).push(row.name);
	return { classes: classes, byFamily: byFamily };
}

/**
 * 把一个元素的 className 里某个类换成另一个（P3 的「改颜色 / 间距 / 圆角」）。
 *
 * 为什么按「类」而不是按「字符串」改：面板只列该元素**实际有的**类，换的是同族的另一个 token 类，
 * 既写不出不存在的类，也不会误伤（`gap-4` 换 `gap-6` 时不会把 `p-4` 一起改掉）。
 */
export function replaceClassName(source, wsrc, fromClass, toClass) {
	if (!babelParser || !MagicStringCtor) return { ok: false, reason: "缺 @babel/parser 或 magic-string" };
	const text = String(source || "");
	const from = String(fromClass || "").trim();
	const to = String(toClass || "").trim();
	if (from === "" || to === "") return { ok: false, reason: "fromClass / toClass 都要给" };
	if (/\s/.test(to)) return { ok: false, reason: "目标只能是单个类名（不要带空格）" };
	let ast;
	try { ast = parseSource(text); } catch (error) { return { ok: false, reason: "源码解析失败：" + String(error && error.message || error) }; }
	const found = collectElements(ast).find((row) => row.wsrc === wsrc);
	if (!found || found.element.type !== "JSXElement") return { ok: false, reason: "没找到 " + wsrc + " 对应的元素（源码可能已经改过）" };
	const attr = (found.opening.attributes || []).find((a) => a && a.type === "JSXAttribute" && a.name && a.name.name === "className");
	if (!attr) return { ok: false, reason: "这个元素没有 className" };
	if (!attr.value || attr.value.type !== "StringLiteral") return { ok: false, reason: "className 是代码算出来的，没法直接改；用评论让 AI 改" };
	const tokens = String(attr.value.value || "").split(/\s+/).filter(Boolean);
	const index = tokens.indexOf(from);
	if (index < 0) return { ok: false, reason: "className 里没有 " + from };
	tokens[index] = to;
	// 换成已存在的类时去重（避免 `p-4 p-4`）
	const deduped = tokens.filter((token, i) => tokens.indexOf(token) === i);
	const ms = new MagicStringCtor(text);
	ms.overwrite(attr.value.start, attr.value.end, JSON.stringify(deduped.join(" ")));
	return { ok: true, source: ms.toString() };
}

/** 给属性面板的「可换选项」：某个类所在族的**其它**已知类（来自组件包 CSS），最多 40 个。 */
export function swapOptionsFor(cssClassNames, fromClass, limit) {
	const family = classFamilyOf(fromClass);
	const out = [];
	const max = Number.isFinite(limit) ? limit : 40;
	for (const name of cssClassNames || []) {
		if (name === fromClass) continue;
		if (classFamilyOf(name) !== family) continue;
		out.push(name);
		if (out.length >= max) break;
	}
	return out;
}
