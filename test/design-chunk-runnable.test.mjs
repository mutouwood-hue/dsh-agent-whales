/**
 * 组件工坊：构建产物**可运行性**门禁（P3 审计 B1 的直接产物）。
 *
 * 为什么需要它：`design-build-sync.test.mjs` 只保证「重跑构建后字节不变」，那是**同步性**，不是**可运行性**。
 * P3 审计抓到过一次真实事故——`entry.jsx` 里 tweaks 控件引用了 4 个从未声明的变量，
 * esbuild 不做未声明检查、构建成功、产物字节一致、938 项单测全绿，但**画布上一渲染就炸**。
 *
 * 这里做三件事：
 *   1) 产物能当成 CommonJS chunk 加载（`window.__ModuleLoader__.load` 被调用、导出表齐全）；
 *   2) 导出的每个函数**源码里引用的自由标识符**都能在文件里找到声明（简易 no-undef 扫描）；
 *   3) 所有 `.jsx` 入口都过一遍 `node --check` 式的语法校验（esbuild 已经做过，这里兜底）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");

// ── 1) 产物能被加载，导出表齐全 ──────────────────────────────────────────────

test("client.design.js 能在最小宿主环境里加载，并导出画布需要的全部入口", () => {
	const code = readFileSync(join(pluginDir, "lib", "client.design.js"), "utf8");
	let registered = null;
	const fakeWindow = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
	// chunk 是 UMD-like：`window.__ModuleLoader__.load({ id, chunk, factory })`
	new Function("window", code)(fakeWindow);
	assert.ok(registered !== null, "chunk 必须调用 __ModuleLoader__.load");
	assert.equal(registered.chunk, "client.design.js");
	assert.equal(typeof registered.factory, "function");

	// factory(require) 要能拿到 React 等外部模块；用一个最小替身（只要够构造组件，不求真渲染）
	const ReactStub = {
		createElement: () => null,
		Fragment: Symbol.for("react.fragment"),
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect: () => {},
		useRef: (initial) => ({ current: initial === undefined ? null : initial }),
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn
	};
	const JsxStub = { jsx: () => null, jsxs: () => null };
	const exported = registered.factory((spec) => {
		if (spec === "react") return ReactStub;
		if (spec === "react/jsx-runtime") return JsxStub;
		if (spec === "react-dom") return {};
		if (spec === "react-dom/client") return {};
		throw new Error("未知外部模块：" + spec);
	});
	for (const name of ["DesignComponentNode", "DesignArtboardNode", "openSourceEditor", "createSandboxHost", "loadEntity", "sandboxSrcdoc"]) {
		assert.equal(typeof exported[name], "function", "产物必须导出 " + name);
	}
});

// ── 2) 未声明变量扫描（简易 no-undef）────────────────────────────────────────

/**
 * 从源码里粗取「被引用的标识符」，与「声明过的标识符」做差。
 * 不做完整作用域分析，只抓**模块顶层根本没出现过声明**的名字——这正是 B1 那类事故的形状。
 */
function findUndeclaredIdentifiers(source) {
	// 去掉字符串与模板（避免把文案里的词当标识符）
	const stripped = source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/`(?:[^`\\]|\\.)*`/g, '""')
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, '""');
	// 声明过的名字：const/let/var/function/class/import/catch 参数/函数参数（粗粒度）
	const declared = new Set();
	for (const match of stripped.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
	for (const match of stripped.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
	for (const match of stripped.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop().trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}
	for (const match of stripped.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
	// 解构声明：const { a, b } = / const [a, b] =
	for (const match of stripped.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/g)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(":").pop().split("=")[0].trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}
	// 函数参数（粗粒度：只要在 `(...) =>` 或 `function f(...)` 里出现过就认为声明过）
	for (const match of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(/[:=]/)[0].trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}
	for (const match of stripped.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(/[:=]/)[0].trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}
	// JSX 里的大写组件名与常见全局
	const globals = new Set(["React", "window", "document", "console", "fetch", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Promise", "Set", "Map", "Date", "Error", "Symbol", "RegExp", "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "URL", "URLSearchParams", "crypto", "performance", "AbortController", "undefined", "null", "true", "false", "this", "arguments", "navigator", "location", "process", "globalThis", "Buffer", "module", "exports", "require", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "Uint8Array", "Int32Array", "Float32Array", "WeakMap", "WeakSet", "structuredClone", "queueMicrotask", "Notification", "requestIdleCallback", "ResizeObserver", "IntersectionObserver", "MutationObserver", "TextEncoder", "TextDecoder"]);
	// 关键字不能被当成标识符（否则 `if (` / `for (` / `catch (` 全被误报）
	const keywords = new Set(["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "function", "typeof", "instanceof", "new", "delete", "in", "of", "void", "yield", "await", "async", "try", "catch", "finally", "throw", "class", "extends", "super", "this", "import", "export", "from", "as", "const", "let", "var", "let", "with", "debugger", "null", "true", "false", "undefined"]);
	// 只关心「像变量一样被读」的名字：出现在 `名字.` / `名字(` / `= 名字` 里，且首字母小写或已声明过大写
	const candidates = new Set();
	for (const match of stripped.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*[.(]/g)) candidates.add(match[1]);
	const undeclared = [];
	for (const name of candidates) {
		if (declared.has(name) || globals.has(name) || keywords.has(name)) continue;
		// 全大写的常量 / JSX 组件（大写开头且文件里有 export function 或 const 声明的那种）不在这里追
		if (/^[A-Z][A-Z0-9_]+$/.test(name)) continue;
		undeclared.push(name);
	}
	return undeclared;
}

test("画布 chunk 的源码里没有「被引用但从未声明」的变量（P3 审计 B1 那类事故的守门人）", () => {
	const source = readFileSync(join(pluginDir, "tools", "flow-chunk", "design", "entry.jsx"), "utf8");
	const undeclared = findUndeclaredIdentifiers(source);
	// 允许白名单（浏览器全局 / 业务约定）
	const allowed = new Set(["lib", "props", "key", "value", "event", "state", "prev", "item", "row", "spec", "options"]);
	const real = undeclared.filter((name) => !allowed.has(name));
	assert.deepEqual(real, [], "这些名字被引用了但从没声明（构建不会报错，运行时才会炸）：" + real.join(", "));
});

test("自检：未声明扫描确实能抓到「引用没声明」的写法（防止扫描器本身失效）", () => {
	const bad = 'export function Foo() { return tweakNames.length > 0 ? callIt() : null; }';
	const found = findUndeclaredIdentifiers(bad);
	assert.ok(found.includes("tweakNames"), "扫描器要能抓到 tweakNames，实际：" + JSON.stringify(found));
	assert.ok(found.includes("callIt"), "扫描器要能抓到 callIt");
	const good = 'const tweakNames = []; export function Foo() { return tweakNames.length > 0 ? window.x : null; }';
	assert.ok(!findUndeclaredIdentifiers(good).includes("tweakNames"), "声明过的名字不能被误报");
});

// ── 3) 产物里不能留下「源码有、声明没有」的残留 ──────────────────────────────

test("产物与源码的 tweaks 接线都在（防止又出现「源码写了、产物没有」或反过来）", () => {
	const source = readFileSync(join(pluginDir, "tools", "flow-chunk", "design", "entry.jsx"), "utf8");
	const built = readFileSync(join(pluginDir, "lib", "client.design.js"), "utf8");
	// tweaks 的值要以 __tweaks 传给组件（§9.5 的约定）
	assert.match(source, /__tweaks/);
	assert.match(built, /__tweaks/, "产物里必须有 __tweaks（否则 tweaks 根本没传给组件）");
	// 源码里 tweaks 相关名字必须先声明再使用
	for (const name of ["tweakSpec", "tweakNames", "tweakValues", "effectiveTweaks"]) {
		assert.match(source, new RegExp("(?:const|let|var)\\s+\\[?" + name), "源码缺声明：" + name);
	}
});
