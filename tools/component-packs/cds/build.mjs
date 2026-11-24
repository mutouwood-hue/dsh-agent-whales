/**
 * 把本机已安装的 @company/cds-react 打成画布原型 / 组件工坊用的「本地组件包」。
 *
 *   node tools/component-packs/cds/build.mjs --cds <装了 @company/cds-react 的 node_modules 目录> [--out <目录>]
 *
 * --out 缺省 = <DSH_HOME 或 ~/.dsh>/agent-whales/component-packs/cds。产物：
 *   · bundle.js    词表适配（components）+ 原始导出（raw），CommonJS，外置 React
 *   · styles.css   CDS 预编译样式（Tailwind 4 产物，含 token 变量）
 *   · api.json     各导出组件的 props 说明（组件工坊：agent 造新组件时读它）
 *   · manifest.json { name, version, license, raw: true, api: true, ... }
 * React / react-dom / jsx-runtime 外置（画布运行时用沙箱自带的那一份 React）；CDS 本体与它的依赖打进 bundle.js。
 * 受控包只落在你自己的机器上，插件仓库与发布包里都没有它。
 *
 * api.json 抽取（设计方案 §7 🔍3）：用 TypeScript compiler API 读 dist/index.d.ts。
 *   实测（CDS 3.0.8，index.d.ts 464KB，扁平 rollup 声明）：
 *     · 组件 = 末尾 `export {…}` 里首字母大写的 function / const（403 个；`declare const Upload`
 *       这种 forwardRef 形态必须一起认，否则 Upload / Checkbox / DatePicker 等会漏）；
 *     · props = 声明的第一个参数类型 → 同名 interface 字段；`react.ForwardRefExoticComponent<A & B>`
 *       取 A；内联对象类型直接读；
 *     · 泛型组件（DataTable<T>）保留 generic 名字，字段类型原样（T 由 agent 自己替换）；
 *     · 精简到 [名, 类型, 必填, 说明] 数组并截断 → 403 个组件 162KB（全展开是 200.8KB，超 200KB 上限）。
 * 没有 typescript 依赖时降级：只写 `raw: true`，不写 api.json，并在 stdout 明确说（不悄悄缺文件）。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// esbuild 用 tools/flow-chunk 里装的那份（cd tools/flow-chunk && npm install），这里不另装一套
const { build } = await import(pathToFileURL(join(here, "..", "..", "flow-chunk", "node_modules", "esbuild", "lib", "main.js")).href);
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (!arg("--cds")) { console.error("缺 --cds <node_modules 目录>"); process.exit(2); }
// 必须绝对化：createRequire 只认绝对路径 / ./ ../ 开头的相对路径，`.dev\\p0\\x` 这种会被当裸包名解析失败
const cdsModules = resolve(arg("--cds"));
const home = process.env.DSH_HOME && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
const out = resolve(arg("--out") || join(home, "agent-whales", "component-packs", "cds"));
const cdsDir = join(cdsModules, "@company", "cds-react");
const cdsPkg = JSON.parse(readFileSync(join(cdsDir, "package.json"), "utf8"));

// ── 1) bundle.js ───────────────────────────────────────────────────────────
const result = await build({
	entryPoints: [join(here, "adapter.jsx")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "browser",
	target: "es2019",
	minify: true,
	jsx: "automatic",
	external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@xyflow/react", "@dagrejs/dagre", "recharts", "@tiptap/*", "@ai-sdk/*"],
	loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty" },
	define: { "process.env.NODE_ENV": "\"production\"" },
	nodePaths: [cdsModules, join(here, "..", "..", "flow-chunk", "node_modules")],
	logLevel: "warning"
});
mkdirSync(out, { recursive: true });
const bundleText = result.outputFiles[0].text;
writeFileSync(join(out, "bundle.js"), bundleText, "utf8");
copyFileSync(join(cdsDir, "dist", "styles.css"), join(out, "styles.css"));

// ── 2) api.json（可选：要 typescript）──────────────────────────────────────
const API_SCHEMA_VERSION = 1;
const BUDGET = 1000 * 1024; // 1MB 上限：本插件的发布包里不含它，只在用户机器上生成
let apiState = "skipped";

function resolveTypeScript() {
	const candidates = [
		join(cdsModules, "typescript"),
		join(here, "..", "..", "flow-chunk", "node_modules", "typescript")
	];
	for (const dir of candidates) {
		try {
			const mod = require_(join(dir, "package.json"));
			const entry = typeof mod.main === "string" && mod.main !== "" ? join(dir, mod.main) : dir;
			const service = requireService(entry);
			if (service) return { ts: service, dir };
		} catch (error) { /* 下一个 */ }
	}
	// 最后再试一次裸 require（用户全局装了也能用）
	try { return { ts: require_("typescript"), dir: "(node_modules 解析)" }; } catch (error) { return null; }
}
// 这个脚本是 ESM：用 createRequire 才能在 CommonJS 的 npm 包里 require 东西
const { createRequire } = await import("node:module");
const nodeRequire = createRequire(import.meta.url);
const require_ = (target) => { try { return nodeRequire(target); } catch (error) { return undefined; } };
const requireService = (file) => nodeRequire(file);

function jsdocLine(node, sf) {
	const tags = safeCall(() => ts.getJSDocCommentsAndTags(node));
	const list = Array.isArray(tags) ? tags : [];
	for (const tag of list) {
		const text = String(tag && tag.comment !== undefined ? tag.comment : "").trim();
		if (text !== "") return text.split("\n")[0].replace(/\*\/\s*$/, "").trim();
	}
	return "";
}
const safeCall = (fn, fallback) => { try { return fn(); } catch (error) { return fallback; } };

let ts = null;
let tsDir = "";
const found = safeCall(() => resolveTypeScript(), null);
if (found && found.ts) { ts = found.ts; tsDir = found.dir; apiState = "typescript " + ts.version + " @ " + tsDir; }

if (!ts) {
	console.log("api.json: 没找到 typescript，跳过（agent 只能用 raw 导出、拿不到 props 说明）。");
} else {
	const dtsPath = join(cdsDir, "dist", "index.d.ts");
	if (!existsSync(dtsPath)) {
		console.log("api.json: 没找到 dist/index.d.ts，跳过。");
		apiState = "skipped (no index.d.ts)";
	} else {
		const source = readFileSync(dtsPath, "utf8");
		const sf = ts.createSourceFile("index.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const ifaces = new Map();
		const funcs = new Map();
		const consts = new Map();
		const aliases = new Map();
		for (const s of sf.statements) {
			if (ts.isInterfaceDeclaration(s)) ifaces.set(s.name.text, s);
			else if (ts.isFunctionDeclaration(s) && s.name) funcs.set(s.name.text, s);
			else if (ts.isTypeAliasDeclaration(s)) aliases.set(s.name.text, s);
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

		function propsTypeOf(name) {
			if (funcs.has(name)) {
				const decl = funcs.get(name);
				return decl.parameters.length > 0 ? decl.parameters[0].type : null;
			}
			const decl = consts.get(name);
			if (!decl || !decl.type) return null;
			const t = decl.type;
			// react.ForwardRefExoticComponent<UploadProps & react.RefAttributes<UploadHandle>> → 取交集第一项
			if (ts.isTypeReferenceNode(t) && t.typeArguments && t.typeArguments.length > 0) {
				const inner = t.typeArguments[0];
				return ts.isIntersectionTypeNode(inner) ? inner.types[0] : inner;
			}
			return t;
		}
		function fieldsOf(node) {
			if (!node) return { fields: [] };
			let members = null;
			let propsName = "";
			let generic = [];
			if (ts.isTypeLiteralNode(node)) {
				members = node.members;
			} else if (ts.isTypeReferenceNode(node)) {
				propsName = node.typeName.getText(sf).replace(/<.*$/, "");
				const iface = ifaces.get(propsName) || aliases.get(propsName);
				if (!iface) return { fields: [], unresolved: propsName };
				if (ts.isTypeAliasDeclaration(iface)) {
					return fieldsOf(iface.type);
				}
				members = iface.members;
				generic = (iface.typeParameters || []).map((p) => p.name.text);
			} else {
				return { fields: [], unresolved: node.getText(sf).slice(0, 40) };
			}
			const fields = [];
			for (const m of members) {
				if (!ts.isPropertySignature(m) || !m.name) continue;
				const key = m.name.getText(sf).replace(/^["']|["']$/g, "");
				if (key === "" || key === "ref" || key === "key") continue;
				fields.push([
					key,
					(m.type ? m.type.getText(sf).replace(/\s+/g, " ") : "any").slice(0, 80),
					m.questionToken ? 0 : 1,
					jsdocLine(m, sf).slice(0, 80)
				]);
			}
			return { fields, propsName, generic };
		}

		const api = {
			format: "whales-pack-api",
			formatVersion: API_SCHEMA_VERSION,
			package: "@company/cds-react",
			version: typeof cdsPkg.version === "string" ? cdsPkg.version : "",
			license: typeof cdsPkg.license === "string" ? cdsPkg.license : "",
			generatedAt: new Date().toISOString(),
			// 字段说明：[名, 类型, 是否必填(1/0), JSDoc 一句话]
			note: "components[name].fields 是 [名, 类型, 必填, 说明] 四元组；类型里的 T 是组件泛型参数。",
			components: {}
		};
		let unresolved = 0;
		for (const name of components) {
			const doc = funcs.has(name) ? jsdocLine(funcs.get(name), sf) : consts.has(name) ? jsdocLine(consts.get(name), sf) : "";
			const resolved = fieldsOf(propsTypeOf(name));
			if (resolved.unresolved) unresolved += 1;
			api.components[name] = Object.assign(
				{ doc: doc.slice(0, 120) },
				resolved.propsName ? { props: resolved.propsName } : {},
				resolved.generic && resolved.generic.length > 0 ? { generic: resolved.generic } : {},
				resolved.unresolved ? { unresolved: resolved.unresolved } : {},
				{ fields: resolved.fields }
			);
		}
		const text = JSON.stringify(api);
		if (Buffer.byteLength(text, "utf8") > BUDGET) {
			console.log("api.json: " + (Buffer.byteLength(text) / 1024).toFixed(1) + " KB 超过 " + (BUDGET / 1024) + "KB 上限，不写（这个包太大）。");
			apiState = "skipped (over budget)";
		} else {
			writeFileSync(join(out, "api.json"), text, "utf8");
			console.log("api.json: " + components.length + " 个组件，" + (Buffer.byteLength(text) / 1024).toFixed(1) + " KB"
				+ (unresolved > 0 ? "（" + unresolved + " 个 props 解不出，标了 unresolved）" : ""));
			apiState = "ok: " + components.length + " components";
		}
	}
}

// ── 3) manifest.json ──────────────────────────────────────────────────────
writeFileSync(join(out, "manifest.json"), JSON.stringify({
	name: "CDS " + cdsPkg.version + "（本地）",
	version: cdsPkg.version,
	license: typeof cdsPkg.license === "string" ? cdsPkg.license : "",
	source: "@company/cds-react",
	builtAt: new Date().toISOString(),
	// 组件工坊（设计方案 §7）：raw = bundle.js 里有 export * as raw（agent 的 import { X } from "@cds" 靠它）
	raw: true,
	api: existsSync(join(out, "api.json"))
}, null, 2), "utf8");

console.log("CDS pack →", out, (Buffer.byteLength(bundleText) / 1024).toFixed(1) + " KB（bundle.js，含 raw）");
console.log("api 状态:", apiState);
