/**
 * lib/client.proto.js 的入口：原型帧（Puck，MIT）+ 组件库节点 + 编辑浮层 + 内置 shadcn 风格组件包。
 *
 * 结构（PRD v2.2 九（续）/ 九（续二））：React Flow 是底座，Puck 只活在「原型帧」节点里——
 *   · 预览：iframe + createPortal 渲染 Puck <Render>，组件包 CSS 只注进 iframe，不污染 DSH 页面；
 *   · 编辑：点「编辑」开全屏浮层跑 <Puck>（它自己的画布也是 iframe，组件包 CSS 经 overrides.iframe 注入）；
 *   · 换组件：原型 JSON 只写通用词表（lib/prototype-vocab.js），组件库节点换包 = 所有原型换一套实现。
 * React / ReactDOM / jsx-runtime 由宿主共享模块表提供（与主包同一份 React）。
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as JSXRuntime from "react/jsx-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
import { PROTOTYPE_VOCAB, PROTOTYPE_VOCAB_NAMES } from "../../../lib/prototype-vocab.js";
import { shadcnComponents, shadcnRootClass, shadcnRaw } from "./shadcn-pack.jsx";
import SHADCN_CSS from "./shadcn.generated.css";

export const VOCAB_NAMES = PROTOTYPE_VOCAB_NAMES;
const API = "/agent-whales/api";
const { useEffect, useMemo, useRef, useState } = React;

// ── 组件包 ────────────────────────────────────────────────────────────────

// 组件工坊（设计方案 §7）：内置包也带 `raw`，保证没有本地组件包的机器上 `import { X } from "@cds"` 依然可用。
const BUILTIN = { id: "shadcn", name: "shadcn/ui（内置）", builtin: true, components: shadcnComponents, raw: shadcnRaw, css: SHADCN_CSS, rootClass: shadcnRootClass };
const packCache = new Map([["shadcn", Promise.resolve(BUILTIN)]]);
const SHARED = { react: React, "react-dom": ReactDOM, "react/jsx-runtime": JSXRuntime };

/** 本地包：bundle.js 是 CommonJS，只能 require 共享的 React；导出组件表，或 (React) => 组件表。 */
function evalPack(meta, code, css) {
	const module = { exports: {} };
	const req = (spec) => {
		if (SHARED[spec]) return SHARED[spec];
		throw new Error("组件包 " + meta.id + " 只能 require react / react-dom / react/jsx-runtime，出现了 " + spec);
	};
	// 用户自己放进 ~/.dsh/agent-whales/component-packs 的代码，与插件同权限运行（README 有说明）
	new Function("module", "exports", "require", code)(module, module.exports, req);
	let out = module.exports && module.exports.default ? module.exports.default : module.exports;
	if (typeof out === "function") out = out(React);
	const components = out && out.components ? out.components : out;
	if (!components || typeof components !== "object") throw new Error("组件包 " + meta.id + " 没有导出组件表");
	return { id: meta.id, name: meta.name || meta.id, builtin: false, components, raw: (out && out.raw) || null, css: css || "", rootClass: (out && out.rootClass) || meta.rootClass || "" };
}

export function loadPack(meta) {
	const id = meta && typeof meta.id === "string" ? meta.id : "shadcn";
	if (packCache.has(id)) return packCache.get(id);
	const base = API + "/component-packs/" + encodeURIComponent(id);
	const pending = Promise.all([
		fetch(base + "/bundle.js").then((r) => { if (!r.ok) throw new Error("bundle.js " + r.status); return r.text(); }),
		fetch(base + "/styles.css").then((r) => (r.ok ? r.text() : ""), () => "")
	]).then(([code, css]) => evalPack(meta, code, css));
	pending.catch(() => packCache.delete(id));
	packCache.set(id, pending);
	return pending;
}

function usePack(meta) {
	const id = meta && meta.id ? meta.id : "shadcn";
	const [state, setState] = useState(() => (id === "shadcn" ? { pack: BUILTIN, error: "" } : { pack: null, error: "" }));
	useEffect(() => {
		let live = true;
		loadPack(meta || { id }).then((pack) => { if (live) setState({ pack, error: "" }); }, (error) => { if (live) setState({ pack: null, error: String(error && error.message || error) }); });
		return () => { live = false; };
	}, [id]);
	return state;
}

/** 包里没有的词表组件：画一个虚线占位，写明「这个包缺 X」——不偷偷换成别家组件。 */
function missing(name) {
	return function Missing() {
		return jsx("div", { style: { border: "1px dashed #c4c4c4", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#888", background: "#fafafa" }, children: "（当前组件包没有「" + name + "」）" });
	};
}

/** 覆盖率：包实现了词表里的哪些组件。 */
export function packCoverage(pack) {
	const has = PROTOTYPE_VOCAB_NAMES.filter((name) => pack && pack.components && typeof pack.components[name] === "function");
	return { covered: has.length, total: PROTOTYPE_VOCAB_NAMES.length, missing: PROTOTYPE_VOCAB_NAMES.filter((name) => has.indexOf(name) < 0) };
}

/**
 * 沙箱岛（设计方案 §10）：项目组件在 Puck 里**不直接执行**。
 *
 * 为什么：Puck 画布本身就是同源 iframe，在里面执行 AI 写的代码等于把代码带进可信上下文——
 * 一次提示注入就能拿到同源的 x-whales-token。所以项目组件在这里渲染成一个**自动撑高的小沙箱 iframe**，
 * props 经 postMessage 传进去，与画布上的组件节点走同一套协议（P0 结论：origin=null + 一次性 nonce）。
 *
 * 单帧实例上限 30（方案 §6.5 的实测阈值）；超出的给占位提示，不静默丢。
 */
export const PROJECT_ISLAND_MAX = 30;

function projectIslandPlaceholder(name, reason) {
	return function ProjectIslandPlaceholder() {
		return jsx("div", {
			style: { border: "1px dashed #c4c4c4", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#888", background: "#fafafa" },
			children: "（项目组件「" + name + "」" + (reason || "当前环境不支持沙箱渲染") + "）"
		});
	};
}

// 沙箱 iframe 的 srcdoc：由 build-proto.mjs 在构建时从 lib/design/sandbox.js 注入（虚拟模块 @whales/sandbox-srcdoc），
// 保证 Puck 里的沙箱岛与画布节点用**同一份**协议实现。
// 构建时由 esbuild 的 define 注入（__WHALES_SANDBOX_SRCDOC__）；单测环境没有这个值，退回最小壳。
let sandboxSrcdocFn = function () {
	const injected = typeof __WHALES_SANDBOX_SRCDOC__ === "string" ? __WHALES_SANDBOX_SRCDOC__ : "";
	return injected !== "" ? injected : "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><div id=\"root\"></div></body></html>";
};
export function __setSandboxSrcdoc(fn) { if (typeof fn === "function") sandboxSrcdocFn = fn; }

/**
 * 一个项目组件的沙箱岛：iframe + 运行时 + 编译产物。
 * @param {{ name: string, title?: string, code?: string, dependencies?: Array<{name:string,code:string}>, props?: object }} props
 */
export function ProjectIsland({ name, code, dependencies, props, title }) {
	const frameRef = useRef(null);
	const [state, setState] = useState({ status: "loading", error: "", height: 160 });
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return undefined;
		let live = true;
		const nonce = "island-" + Math.random().toString(16).slice(2) + "-" + Date.now();
		const onMessage = (event) => {
			// 沙箱是不透明源：只认 origin === "null" + nonce（P0 结论：不用 event.source）
			if (event.origin !== "null") return;
			const data = event.data || {};
			if (data.type === "ready") {
				if (data.nonce !== nonce) return;
				frame.contentWindow.postMessage({ type: "render", nonce: nonce, runId: "island", name: name, code: code || "", props: props || {}, dependencies: dependencies || [] }, "*");
				return;
			}
			if (data.nonce !== nonce) return;
			if (data.type === "rendered") {
				if (!live) return;
				setState({ status: data.ok ? "ok" : "error", error: data.error || "", height: Math.max(80, Math.min(1200, (data.height || 0) + 8)) });
				return;
			}
			if (data.type === "error" && live) setState({ status: "error", error: String(data.message || "") });
		};
		window.addEventListener("message", onMessage);
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch("/agent-whales/api/design/runtime.js");
				const runtime = response.ok ? await response.text() : "";
				if (cancelled || !live) return;
				frame.contentWindow.postMessage({ type: "init", nonce: nonce, runtime: runtime, packCode: "", styles: "" }, "*");
			} catch (error) {
				if (live) setState({ status: "error", error: String(error && error.message || error) });
			}
		})();
		return () => { cancelled = true; live = false; window.removeEventListener("message", onMessage); };
	}, [name, code, props]);
	return jsxs("div", { style: { position: "relative", width: "100%", minHeight: 120 }, children: [
		jsx("iframe", {
			ref: frameRef,
			title: title || name,
			sandbox: "allow-scripts",
			srcDoc: sandboxSrcdocFn({ title: title || name }),
			style: { width: "100%", height: state.height, border: "0", display: "block" }
		}),
		state.status === "error" ? jsx("div", { style: { position: "absolute", inset: "auto 0 0 0", background: "#fef2f2", color: "#991b1b", border: "1px solid #dc2626", borderRadius: 6, padding: "4px 6px", fontSize: 11 } }, "项目组件渲染出错：" + String(state.error).slice(0, 200)) : null
	] });
}

/** 词表 + 组件包 → Puck config。字段口径 = Puck 字段。 */
export function buildPuckConfig(pack, projectComponents) {
	const components = {};
	for (const name of PROTOTYPE_VOCAB_NAMES) {
		const spec = PROTOTYPE_VOCAB[name];
		const fields = {};
		for (const key of Object.keys(spec.fields)) {
			const f = spec.fields[key];
			fields[key] = f.type === "select" || f.type === "radio"
				? { type: f.type, label: key, options: f.options.map((value) => ({ label: value, value })) }
				: { type: f.type, label: key };
		}
		const impl = pack && pack.components && typeof pack.components[name] === "function" ? pack.components[name] : missing(name);
		components[name] = { label: spec.label + " · " + name, fields, defaultProps: spec.defaults, render: (props) => jsx(impl, props) };
	}
	// 组件工坊（设计方案 §10）：本项目的组件并进积木栏，label 前缀「项目 · 」，**渲染成沙箱岛**（不直接执行）。
	if (projectComponents && typeof projectComponents === "object") {
		let islandCount = 0;
		for (const name of Object.keys(projectComponents)) {
			const entry = projectComponents[name] || {};
			const schema = entry.propsSchema && typeof entry.propsSchema === "object" ? entry.propsSchema : {};
			const fields = {};
			for (const key of Object.keys(schema)) {
				const field = schema[key] || {};
				if (field.type === "select" || field.type === "radio") {
					const options = Array.isArray(field.options) ? field.options : [];
					fields[key] = { type: field.type, label: field.label || key, options: options.map((value) => ({ label: value, value })) };
				} else {
					fields[key] = { type: field.type === "slot" ? "slot" : field.type || "text", label: field.label || key };
				}
			}
			const defaults = Array.isArray(entry.examples) && entry.examples.length > 0 && entry.examples[0] && typeof entry.examples[0] === "object" ? entry.examples[0] : {};
			const withinLimit = islandCount < PROJECT_ISLAND_MAX;
			if (withinLimit) islandCount += 1;
			components["project:" + name] = {
				label: "项目 · " + (entry.title || name),
				fields,
				defaultProps: defaults,
				render: withinLimit
					? (props) => jsx(ProjectIsland, { name: name, title: entry.title, code: entry.compiled, dependencies: entry.dependencies, props: props })
					: projectIslandPlaceholder(name, "超出单帧 " + PROJECT_ISLAND_MAX + " 个沙箱岛的上限")
			};
		}
	}
	return {
		components,
		root: { render: ({ children }) => jsx("div", { className: (pack && pack.rootClass) || "", style: pack && pack.rootClass ? undefined : { padding: 20, display: "flex", flexDirection: "column", gap: 16 }, children }) }
	};
}

function injectCss(doc, id, css) {
	if (!doc || !css) return;
	if (doc.getElementById(id)) return;
	const style = doc.createElement("style");
	style.id = id;
	style.textContent = css;
	(doc.head || doc.documentElement).appendChild(style);
}

// ── 渲染 Puck 数据（预览不需要 Puck 本体：数据就是 {type, props} 树，slot 是子数组）──────────────
//
// 为什么自己渲染：@puckeditor/core 的 Render（含 /rsc 入口）会把 tiptap / prosemirror 整套带进来，
// 预览 chunk 会从 ~40KB 涨到 ~1MB；完整 Puck 只在点「编辑」时才按需加载（client.puck.js）。

function renderItems(config, items, path) {
	return (Array.isArray(items) ? items : []).map((item, index) => {
		if (!item || typeof item.type !== "string") return null;
		const spec = config.components[item.type];
		const key = (item.props && item.props.id) || path + "-" + index;
		if (!spec) return jsx(missing(item.type), {}, key);
		const props = Object.assign({}, spec.defaultProps || {}, item.props || {});
		for (const name of Object.keys(spec.fields || {})) {
			if (spec.fields[name].type !== "slot") continue;
			const children = Array.isArray(props[name]) ? props[name] : [];
			props[name] = function SlotContent() { return jsx(React.Fragment, { children: renderItems(config, children, key + "-" + name) }); };
		}
		return jsx(React.Fragment, { children: spec.render(props) }, key);
	});
}

/** Puck 数据 → React 元素（与 Puck Render 同口径：root.render 包住 content）。 */
export function PuckData({ config, data }) {
	const content = renderItems(config, data && data.content, "c");
	const root = config.root && typeof config.root.render === "function" ? config.root.render : ({ children }) => jsx("div", { children });
	return root({ children: content });
}

// ── 预览：iframe 隔离 ────────────────────────────────────────────────────────

const PAGE_WIDTH = { mobile: 390, desktop: 1024 };

/** iframe 里用 createPortal 渲染 Puck <Render>；内容高度回报给外面（按缩放后的高度）。 */
export function PrototypeFrame({ pack, data, width, scale, maxHeight, projectComponents }) {
	const frameRef = useRef(null);
	const [body, setBody] = useState(null);
	const [height, setHeight] = useState(240);
	const config = useMemo(() => buildPuckConfig(pack, projectComponents), [pack, projectComponents]);
	const pageWidth = PAGE_WIDTH[width] || PAGE_WIDTH.desktop;
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return undefined;
		const doc = frame.contentDocument;
		if (!doc) return undefined;
		doc.open();
		doc.write("<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0\"></body></html>");
		doc.close();
		injectCss(doc, "whales-pack-css", pack && pack.css);
		setBody(doc.body);
		const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => setHeight(Math.max(120, doc.body.scrollHeight))) : null;
		if (ro) ro.observe(doc.body);
		return () => { if (ro) ro.disconnect(); };
	}, [pack && pack.id]);
	const shown = Math.min(maxHeight || 640, Math.ceil(height * scale));
	return jsxs("div", { className: "nodrag nowheel", style: { position: "relative", width: Math.ceil(pageWidth * scale), height: shown, overflow: "hidden", background: "#fff" }, children: [
		jsx("iframe", { ref: frameRef, title: "prototype", style: { border: 0, width: pageWidth, height: height, transform: "scale(" + scale + ")", transformOrigin: "0 0", pointerEvents: "none", display: "block" } }),
		body ? ReactDOM.createPortal(jsx(PuckData, { config, data }), body) : null
	] });
}

// ── 画布节点 ──────────────────────────────────────────────────────────────

const chrome = {
	card: { background: "var(--daw-surface, #fff)", border: "1px solid var(--daw-border, #dce2ee)", borderRadius: 12, boxShadow: "0 6px 18px rgba(0,0,0,.06)", overflow: "hidden" },
	head: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--daw-border, #dce2ee)", fontSize: 12, cursor: "grab", whiteSpace: "nowrap" },
	tag: { fontSize: 10, padding: "2px 6px", borderRadius: 999, background: "var(--daw-accent-bg, #f9effa)", color: "var(--daw-accent, #c05bd0)", fontWeight: 600 },
	btn: { fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--daw-border, #dce2ee)", background: "var(--daw-surface, #fff)", cursor: "pointer" },
	muted: { color: "var(--daw-text-muted, #8a93a6)" }
};

/** React Flow 节点：原型帧。data: { title, width, puck, packMeta, ai, labels, onEdit } */
export function PrototypeNode(props) {
	const d = (props && props.data) || {};
	const labels = d.labels || {};
	const { pack, error } = usePack(d.packMeta);
	const scale = d.width === "mobile" ? 0.62 : 0.42;
	return jsxs("div", { className: "daw-proto-node", style: chrome.card, children: [
		jsxs("div", { className: "daw-proto-head", style: chrome.head, children: [
			jsx("span", { children: "▣" }),
			jsx("b", { style: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }, children: d.title || "原型" }),
			d.ai ? jsx("span", { style: chrome.tag, children: "AI" }) : null,
			jsx("span", { style: Object.assign({ flex: 1 }, chrome.muted), children: (d.packMeta && d.packMeta.name) || "" }),
			props?.readOnly ? null : jsx("button", { type: "button", className: "nodrag", style: chrome.btn, onClick: () => d.onEdit && d.onEdit(), children: labels.edit || "编辑" })
		] }),
		pack
			? jsx(PrototypeFrame, { pack, data: d.puck, width: d.width, scale, projectComponents: d.projectComponents })
			: jsx("div", { style: Object.assign({ padding: 16, fontSize: 12 }, chrome.muted), children: error ? (labels.packFailed || "组件包加载失败：") + error : (labels.loading || "组件包加载中…") })
	] });
}

/** React Flow 节点：组件库。data: { packMeta, packs, labels, onSwitch, dir, usedBy } */
export function LibraryNode(props) {
	const d = (props && props.data) || {};
	const labels = d.labels || {};
	const { pack, error } = usePack(d.packMeta);
	const cov = pack ? packCoverage(pack) : null;
	const packs = Array.isArray(d.packs) ? d.packs : [];
	return jsxs("div", { className: "daw-proto-node", style: Object.assign({ width: 260 }, chrome.card), children: [
		jsxs("div", { className: "daw-proto-head", style: chrome.head, children: [jsx("span", { children: "◫" }), jsx("b", { children: labels.title || "组件库" }), jsx("span", { style: Object.assign({ flex: 1, textAlign: "right" }, chrome.muted), children: d.usedBy ? (labels.usedBy || "") + d.usedBy : "" })] }),
		jsxs("div", { style: { padding: 10, display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }, children: [
			jsx("select", {
				className: "nodrag",
				value: (d.packMeta && d.packMeta.id) || "shadcn",
				onChange: (event) => d.onSwitch && d.onSwitch(event.target.value),
				style: { padding: "4px 6px", borderRadius: 6, border: "1px solid var(--daw-border, #dce2ee)" },
				children: packs.map((meta) => jsx("option", { value: meta.id, children: meta.name + (meta.builtin ? "" : " · " + (labels.local || "本地")) }, meta.id))
			}),
			cov ? jsx("div", { children: (labels.coverage || "覆盖词表") + " " + cov.covered + " / " + cov.total + (cov.missing.length > 0 ? "（" + (labels.missing || "缺") + "：" + cov.missing.join("、") + "）" : "") }) : null,
			error ? jsx("div", { style: { color: "var(--daw-danger, #d64545)" }, children: error }) : null,
			d.packMeta && d.packMeta.license ? jsx("div", { style: chrome.muted, children: "License: " + d.packMeta.license }) : null,
			jsx("div", { style: Object.assign({ wordBreak: "break-all" }, chrome.muted), children: (labels.importHint || "导入自己的组件包：") + (d.dir || "") })
		] })
	] });
}

/**
 * 全屏编辑浮层：Puck 编辑器（Puck 由 client.puck.js 按需加载后经 props.Puck 传进来）。
 * 组件包 CSS 经 overrides.iframe 只注入 Puck 自己的画布 iframe，不进 DSH 页面。
 */
export function PrototypeEditor({ Puck, title, packMeta, projectComponents, data, labels, onSave, onClose }) {
	const text = labels || {};
	const { pack, error } = usePack(packMeta);
	// 组件工坊（设计方案 §10）：本项目的组件并进积木栏（label 前缀「项目 · 」，渲染成沙箱岛）。
	// projectComponents 由调用方从 /design/components + /design/source 取好传进来；为空就是只有词表。
	const projectKey = projectComponents ? Object.keys(projectComponents).sort().join(",") : "";
	const config = useMemo(() => (pack ? buildPuckConfig(pack, projectComponents) : null), [pack, projectKey]);
	const overrides = useMemo(() => ({
		iframe: ({ children, document }) => { injectCss(document, "whales-pack-css", pack && pack.css); return children; },
		headerActions: ({ children }) => jsxs(React.Fragment, { children: [jsx("button", { type: "button", onClick: onClose, style: chrome.btn, children: text.close || "关闭" }), children] })
	}), [pack, onClose]);
	return jsx("div", { className: "daw-proto-editor", style: { position: "absolute", inset: 0, zIndex: 40, background: "#fff", display: "flex", flexDirection: "column" }, children:
		config && typeof Puck === "function"
			? jsx(Puck, { config, data: data || { content: [], root: { props: {} } }, headerTitle: title || "原型", onPublish: (next) => onSave && onSave(next), overrides, iframe: { enabled: true, syncHostStyles: false, waitForStyles: false }, height: "100%" })
			: jsx("div", { style: { padding: 24 }, children: error ? (text.packFailed || "组件包加载失败：") + error : (text.loading || "组件包加载中…") })
	});
}
