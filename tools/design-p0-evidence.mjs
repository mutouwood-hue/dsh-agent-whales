/**
 * 组件工坊 P0 证据复跑脚本（设计方案 §15 的每一条结论都能在这里重新量出来）。
 *
 *   node tools/design-p0-evidence.mjs            → 跑一遍，写 docs/plans/组件工坊-P0证据.json
 *   node tools/design-p0-evidence.mjs --print    → 只打印，不写文件
 *
 * 为什么要这个脚本（P0 审计 B2/B3）：原先 §15 的渲染与性能结论只在对话里，`.dev/` 又被 gitignore，
 * 交付物上没有可复现的证据。这里把**不依赖浏览器**的部分固化下来；需要浏览器的那两条（沙箱渲染、
 * 沙箱岛性能）在脚本末尾明确标 `browser: "not-run-here"` 并指向浏览器探针，不冒充已验证。
 *
 * 依赖：tools/flow-chunk 的 node_modules（esbuild / react / sucrase / @babel/parser / magic-string）
 * 与插件自己的 dependencies；类型抽取另需 typescript（找不到就跳过并标注）。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const flowDir = join(pluginDir, "tools", "flow-chunk");
const flowRequire = createRequire(join(flowDir, "package.json"));
const pluginRequire = createRequire(join(pluginDir, "package.json"));
const printOnly = process.argv.includes("--print");

const evidence = { generatedAt: new Date().toISOString(), plugin: readPluginVersion(), findings: {} };

function readPluginVersion() {
	try { return JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).version; } catch (error) { return ""; }
}
const bytes = (text) => Buffer.byteLength(text, "utf8");
const kb = (n) => Number((n / 1024).toFixed(1));

// ── #4 运行时体积（React 18 + ReactDOM production + 小 runtime）──────────────
async function runtimeSize() {
	const esbuild = flowRequire("esbuild").default;
	const entry = `
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as Client from "react-dom/client";
import * as Jsx from "react/jsx-runtime";
const jsxFn = typeof Jsx.jsx === "function" ? Jsx.jsx : Jsx.default.jsx;
const jsxsFn = typeof Jsx.jsxs === "function" ? Jsx.jsxs : Jsx.default.jsxs;
const registry = { react: React, "react-dom": ReactDOM, "react-dom/client": Client, "react/jsx-runtime": { jsx: jsxFn, jsxs: jsxsFn, Fragment: React.Fragment, __esModule: true } };
globalThis.__whalesRequire = (spec) => { if (registry[spec]) return registry[spec]; throw new Error("sandbox: 不允许 require(" + spec + ")"); };
globalThis.__whalesRuntime = { React, ReactDOM, createRoot: Client.createRoot };
`;
	const result = await esbuild.build({
		stdin: { contents: entry, resolveDir: join(flowDir, "node_modules"), loader: "js" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2019", minify: true,
		define: { "process.env.NODE_ENV": "\"production\"" }, legalComments: "none"
	});
	const text = result.outputFiles[0].text;
	const reactVersion = flowRequire("react/package.json").version;
	return {
		version: "react " + reactVersion + " + react-dom " + flowRequire("react-dom/package.json").version,
		rawBytes: bytes(text),
		rawKB: kb(bytes(text)),
		gzipKB: kb(gzipSync(Buffer.from(text)).length),
		note: "esbuild IIFE + minify + NODE_ENV=production；沙箱以文本传进 iframe"
	};
}

// ── #5 sucrase 的 __source：两条事实（结论是不用它）──────────────────────────
function sucraseSource() {
	const sucrase = pluginRequire("sucrase");
	const src = 'export default function B() {\n  return <div className="x"><span>a</span></div>;\n}\n';
	const dev = sucrase.transform(src, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: false, filePath: "x.tsx" });
	const prod = sucrase.transform(src, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true, filePath: "x.tsx" });
	// React 生产版 jsx-dev-runtime 的实际内容
	let jsxDevRuntime = "";
	let jsxDevIsStub = null;
	try {
		jsxDevRuntime = readFileSync(join(flowDir, "node_modules", "react", "cjs", "react-jsx-dev-runtime.production.min.js"), "utf8");
		jsxDevIsStub = /exports\.jsxDEV\s*=\s*void 0/.test(jsxDevRuntime);
	} catch (error) { jsxDevIsStub = null; }
	return {
		productionFalse_hasLineNumber: /lineNumber:/.test(dev.code),
		productionFalse_hasColumnNumber: /columnNumber:/.test(dev.code),
		productionFalse_usesJsxDevRuntime: /jsx-dev-runtime/.test(dev.code),
		productionTrue_hasSourceInfo: /fileName:|lineNumber:/.test(prod.code),
		productionTrue_usesJsxRuntime: /jsx-runtime/.test(prod.code),
		reactProductionJsxDevIsStub: jsxDevIsStub,
		reactProductionJsxDevExcerpt: jsxDevRuntime.replace(/\s+/g, " ").trim().slice(0, 160),
		conclusion: "sucrase 的 __source 只有 lineNumber 没有 columnNumber，且 React 生产版 jsxDEV 是空桩 → 改用 babel 静态表 + magic-string 插 data-wsrc"
	};
}

// ── #3 .d.ts → api.json（用 TypeScript compiler API 抽）──────────────────────
function apiJsonEvidence(cdsDtsPath) {
	if (!cdsDtsPath || !existsSync(cdsDtsPath)) return { skipped: true, reason: "没有找到 index.d.ts（用 --cds-dts 指定）" };
	let ts = null;
	// typescript 不是本插件的依赖（只用于可选地生成 api.json）：按「flow-chunk → 本仓 → 环境」依次找
	for (const candidate of [
		() => flowRequire("typescript"),
		() => pluginRequire("typescript"),
		() => createRequire(import.meta.url)("typescript")
	]) {
		try { ts = candidate(); if (ts && ts.createSourceFile) break; } catch (error) { ts = null; }
	}
	if (!ts) return { skipped: true, reason: "没有 typescript（可选依赖，只用来生成 api.json）" };
	const source = readFileSync(cdsDtsPath, "utf8");
	const sf = ts.createSourceFile("index.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const ifaces = new Map();
	const funcs = new Map();
	const consts = new Map();
	for (const s of sf.statements) {
		if (ts.isInterfaceDeclaration(s)) ifaces.set(s.name.text, s);
		else if (ts.isFunctionDeclaration(s) && s.name) funcs.set(s.name.text, s);
		else if (ts.isVariableStatement(s)) {
			for (const d of s.declarationList.declarations) if (d.name && ts.isIdentifier(d.name)) consts.set(d.name.text, d);
		}
	}
	const exported = new Set();
	for (const s of sf.statements) {
		if (!ts.isExportDeclaration(s) || !s.exportClause || !ts.isNamedExports(s.exportClause)) continue;
		for (const e of s.exportClause.elements) {
			const name = e.name.text;
			if (/^[A-Z]/.test(name) && (funcs.has(name) || consts.has(name))) exported.add(name);
		}
	}
	const components = [...exported].sort();
	// 只认 declare function 会漏掉哪些：这就是「必须同时认 declare const」的证据
	const missingIfOnlyFunctions = components.filter((name) => !funcs.has(name) && consts.has(name));
	const withProps = components.filter((name) => {
		const decl = funcs.get(name) ? (funcs.get(name).parameters[0] ? funcs.get(name).parameters[0].type : null) : null;
		if (!decl) return false;
		if (ts.isTypeReferenceNode(decl)) return ifaces.has(decl.typeName.getText(sf).replace(/<.*$/, ""));
		return ts.isTypeLiteralNode(decl);
	});
	return {
		dtsBytes: bytes(source),
		tsVersion: ts.version,
		componentCount: components.length,
		constOnly: missingIfOnlyFunctions.length,
		constOnlySample: missingIfOnlyFunctions.slice(0, 8),
		resolvableProps: withProps.length,
		conclusion: "组件 = export 列表里首字母大写的 function / const（只认 function 会漏 " + missingIfOnlyFunctions.length + " 个 forwardRef 形态）"
	};
}

// ── #1 CDS styles.css 覆盖（只做静态选择器判定；getComputedStyle 见浏览器探针）──
function cssEvidence(cssPath) {
	if (!cssPath || !existsSync(cssPath)) return { skipped: true, reason: "没有找到 styles.css（用 --cds-css 指定）" };
	const css = readFileSync(cssPath, "utf8");
	const probes = ["gap-4", "gap-7", "gap-8", "p-5", "flex", "flex-col", "grid", "grid-cols-2", "grid-cols-[1fr_2fr]", "col-span-2", "max-w-lg", "mt-4", "mt-7", "text-2xl", "text-sm", "font-semibold", "bg-muted", "text-muted-foreground", "rounded-lg", "shadow-lg", "border-t", "w-full", "items-center", "justify-end"];
	const present = [];
	const missing = [];
	for (const name of probes) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\[/g, "\\\\\\[").replace(/\\\]/g, "\\\\\\]");
		const hit = new RegExp("\\." + escaped.replace(/\\/g, "\\\\") + "(?![A-Za-z0-9_-])").test(css) || css.indexOf("." + name.replace(/\[/g, "\\[").replace(/\]/g, "\\]")) >= 0;
		(hit ? present : missing).push(name);
	}
	return {
		cssBytes: bytes(css),
		looksLikeTailwindV4: /@layer theme/.test(css) && /@layer utilities/.test(css),
		tokenVars: (css.match(/--(cds-)?[a-z][a-z0-9-]*(?=\s*:)/g) || []).length,
		present: present,
		missing: missing,
		conclusion: "常用类基本齐全，但 " + missing.length + " 个探针类无样式 → 缺口用宿主侧 Tailwind 3 补"
	};
}

// ── #2 / #7 需要浏览器的两条：这里只如实标注没跑 ────────────────────────────
function browserFindings() {
	return {
		"#2 沙箱渲染 CDS": {
			browser: "not-run-here",
			how: "跑 tools 里的浏览器探针（见 README「组件工坊验证」），它会把 rendered 回报写进 render-log.json",
			note: "本脚本在 Node 里，不能验证异源 iframe 里的渲染"
		},
		"#7 沙箱岛性能": {
			browser: "not-run-here",
			how: "浏览器探针里的 islandBenchmark(N)，要记「创建前基线与结束后 gc 再读」两个点，不能跨轮相减",
			note: "P0 当时的数字是 30 个岛 1.6 s / +34 MB，但那次的测量没有留基线（审计 B3），本条按「未验证」对待"
		}
	};
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const argValue = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
// 默认去找本机已安装的 CDS（没有就跳过，不报错）
function findCds() {
	const explicit = argValue("--cds");
	if (explicit && existsSync(explicit)) return resolve(explicit);
	const candidates = [
		"D:/干活/dsh-flow-studio/node_modules/@company/cds-react/dist",
		join(pluginDir, ".dev", "home-e2e", "agent-whales", "component-packs")
	];
	for (const dir of candidates) { if (existsSync(dir)) return dir; }
	return undefined;
}
const cdsDir = findCds();

evidence.findings["#4 运行时体积"] = await runtimeSize();
evidence.findings["#5 sucrase __source"] = sucraseSource();
evidence.findings["#3 api.json 抽取"] = apiJsonEvidence(cdsDir ? join(cdsDir, "index.d.ts") : undefined);
evidence.findings["#1 CDS 样式覆盖"] = cssEvidence(cdsDir ? join(cdsDir, "styles.css") : undefined);
Object.assign(evidence.findings, browserFindings());
// 组件包 raw 的体积：本机有已构建的包就量一下
const packDir = cdsDir && cdsDir.endsWith("dist") ? join(pluginDir, ".dev", "p0", "pack-cds") : undefined;
if (packDir && existsSync(join(packDir, "bundle.js"))) {
	const bundle = readFileSync(join(packDir, "bundle.js"));
	const api = existsSync(join(packDir, "api.json")) ? readFileSync(join(packDir, "api.json")) : undefined;
	const manifest = existsSync(join(packDir, "manifest.json")) ? JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8")) : {};
	evidence.findings["#2 组件包 raw 体积"] = {
		bundleBytes: bundle.length,
		bundleKB: kb(bundle.length),
		apiBytes: api ? api.length : 0,
		apiKB: api ? kb(api.length) : 0,
		manifestRaw: manifest.raw === true,
		note: "export * as raw 把 CDS 全部导出带进来，112KB → 646.7KB（5.8×）；渲染是否跑通见浏览器探针"
	};
}

const text = JSON.stringify(evidence, null, 2);
if (printOnly) {
	console.log(text);
} else {
	const outFile = join(pluginDir, "docs", "plans", "组件工坊-P0证据.json");
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, text, "utf8");
	console.log("写好了：" + outFile);
	console.log(text);
}
