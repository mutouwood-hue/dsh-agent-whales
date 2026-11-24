/**
 * lib/client.design.js 的入口 —— 组件工坊的画布半边（设计方案 §9.1 / §9.2 / §6.4）。
 *
 * 只在画布上出现 `component` / `artboard` 节点时才按需加载（同 wbProtoLoader 的四态加载器），主包门禁不动。
 *
 * 这里做四件事：
 *   1) **沙箱宿主**：为每个组件/画板开一个 `sandbox="allow-scripts"` 的 iframe，注入运行时 + 组件包 + 编译产物。
 *      协议按 P0 结论：`origin === "null"` + 一次性 nonce（不用 `event.source`）。
 *   2) **节点渲染**：卡头（名称 / AI 标记 / 例子切换 / 编辑 / 导出）+ 主体沙箱预览。
 *   3) **在线画布登记**：页面打开时轮询 `GET /design/live`，领到「请渲染 X」就渲染并 `POST /design/live/result`，
 *      这样 agent 的 `whales_design_write` 才能拿到真实 render 结果（否则它只能如实说 unverified）。
 *   4) **Chunk 内共享的请求缓存**：同一组件包 / 运行时文本只拉一次（方案 §6.5 的建议）。
 */
import * as React from "react";
import { sandboxSrcdoc, SANDBOX_CSP } from "../../../lib/design/sandbox.js";

const { useCallback, useEffect, useMemo, useRef, useState } = React;
const API = "/agent-whales/api";

// ── 运行时与组件包文本（Chunk 级缓存，避免每个沙箱岛重复拉取）─────────────────
const runtimeCache = new Map(); // "" -> Promise<string>
const packCache = new Map(); // packId -> Promise<{ bundle, styles, raw, api, manifest }>

/** 沙箱运行时：从 host 下发的 `client.sandbox-runtime.js` 文本取（预构建，见 build-design.mjs）。 */
function loadRuntimeText() {
	const key = "runtime";
	if (runtimeCache.has(key)) return runtimeCache.get(key);
	const pending = fetch(API + "/design/runtime.js")
		.then((response) => {
			if (!response.ok) throw new Error("运行时下载失败 " + response.status);
			return response.text();
		});
	runtimeCache.set(key, pending);
	pending.catch(() => runtimeCache.delete(key));
	return pending;
}

/** 组件包三件套（bundle / styles / api）。内置 shadcn 包没有 bundle.js，返回空。 */
function loadPackText(packId) {
	const id = typeof packId === "string" && packId !== "" ? packId : "shadcn";
	if (packCache.has(id)) return packCache.get(id);
	const base = API + "/component-packs/" + encodeURIComponent(id);
	const pending = (async () => {
		if (id === "shadcn") {
			// 内置包：bundle/raw 已经打进 client.proto.js，沙箱里用内置包要另走一条路（见 sandboxHost 的 injectedPack）
			let api = null;
			try { const r = await fetch(API + "/design/pack-api?projectId="); api = await r.json(); } catch (error) { api = null; }
			return { bundle: "", styles: "", api: api, builtin: true };
		}
		const [bundle, styles] = await Promise.all([
			fetch(base + "/bundle.js").then((r) => (r.ok ? r.text() : "")),
			fetch(base + "/styles.css").then((r) => (r.ok ? r.text() : ""), () => "")
		]);
		let api = null;
		try { const r = await fetch(API + "/design/pack-api?packId=" + encodeURIComponent(id)); api = await r.json(); } catch (error) { api = null; }
		return { bundle: bundle, styles: styles, api: api, builtin: false };
	})();
	packCache.set(id, pending);
	pending.catch(() => packCache.delete(id));
	return pending;
}

// ── 沙箱宿主控制器（每个 iframe 一个）────────────────────────────────────────

let nonceSeq = 0;
function nextNonce() {
	nonceSeq += 1;
	const bytes = new Uint8Array(16);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") + "-" + nonceSeq;
}

/**
 * 把一个 iframe 变成「沙箱宿主」。
 * @returns {{ render: Function, destroy: Function, setPickMode: Function, onPick: Function|null }}
 */
function createSandboxHost(frame, options) {
	const opts = options || {};
	let nonce = "";
	let ready = false;
	let readyWaiters = [];
	let renderWaiter = null;
	let booted = false;
	const onMessage = (event) => {
		// P0 结论：origin 必须是不透明源，再核对 nonce（不依赖 event.source）
		if (event.origin !== "null") return;
		const data = event.data || {};
		if (data.type === "booted") { booted = true; return; }
		if (data.nonce !== nonce) return;
		if (data.type === "ready") {
			ready = true;
			const waiters = readyWaiters.splice(0);
			for (const resolve of waiters) resolve(data.info || {});
			return;
		}
		if (data.type === "rendered") {
			if (renderWaiter !== null) { const w = renderWaiter; renderWaiter = null; w(data); }
			return;
		}
		if (data.type === "pick") {
			if (typeof opts.onPick === "function") opts.onPick(data.pick);
			return;
		}
		if (data.type === "navigate") {
			// 画板跳转（设计方案 §6.4）：**父页面切换预览**，不在 iframe 里导航
			if (typeof opts.onNavigate === "function") opts.onNavigate(data.to);
			return;
		}
		if (data.type === "error") {
			if (typeof opts.onError === "function") opts.onError(data);
		}
	};
	window.addEventListener("message", onMessage);

	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("srcdoc", sandboxSrcdoc({ csp: SANDBOX_CSP, title: opts.title || "whales-design" }));

	/** init：把运行时 / 组件包 / 样式推进去，返回 ready 信息。 */
	function init(payload) {
		nonce = nextNonce();
		if (!booted) {
			// srcdoc 的文档还没建好时 postMessage 会丢：轮询到 booted 再发
			const startedAt = Date.now();
			return new Promise((resolve) => {
				const tick = () => {
					if (booted || Date.now() - startedAt > 6000) { resolve(); return; }
					setTimeout(tick, 60);
				};
				tick();
			}).then(() => sendInit(payload));
		}
		return sendInit(payload);
	}
	function sendInit(payload) {
		return new Promise((resolve) => {
			readyWaiters.push(resolve);
			frame.contentWindow.postMessage({
				type: "init",
				nonce: nonce,
				runtime: payload.runtime,
				styles: payload.styles,
				packCode: payload.bundle
			}, "*");
			setTimeout(() => { if (!ready) resolve({ timeout: true }); }, 8000);
		});
	}

	/** render：渲染一个已编译好的组件；返回沙箱回报（或 {ok:false}）。 */
	function render(spec) {
		if (!ready) return Promise.resolve({ ok: false, error: "沙箱还没就绪" });
		const runNonce = nextNonce();
		nonce = runNonce;
		return new Promise((resolve) => {
			renderWaiter = resolve;
			frame.contentWindow.postMessage({
				type: "render",
				nonce: runNonce,
				runId: spec.runId || "run-" + Date.now(),
				mountId: spec.mountId || "main",
				name: spec.name,
				code: spec.code,
				props: spec.props || {},
				dependencies: spec.dependencies || []
			}, "*");
			setTimeout(() => {
				if (renderWaiter === resolve) { renderWaiter = null; resolve({ ok: false, error: "渲染超时（8 秒）" }); }
			}, 8000);
		});
	}

	function setPickMode(enabled) {
		if (!ready) return;
		const runNonce = nextNonce();
		nonce = runNonce;
		frame.contentWindow.postMessage({ type: "pick-mode", nonce: runNonce, enabled: Boolean(enabled) }, "*");
	}

	return {
		init: init,
		render: render,
		setPickMode: setPickMode,
		destroy: function () { window.removeEventListener("message", onMessage); },
		isReady: function () { return ready; }
	};
}

// ── 拉一个设计实体的源码 / 编译产物 ─────────────────────────────────────────

const entityCache = new Map();
/**
 * 拉一个设计实体（带短 TTL 缓存）。
 *
 * 为什么要 TTL：agent 改完组件后，画布预览与编辑浮层必须能拿到新源码——
 * 没有过期机制的缓存会让它们一直显示旧内容，必须整页刷新（P1 审计指出的真实问题）。
 * 20 秒是折中：够挡住一轮渲染里的重复请求，又不至于让人等太久。
 */
const ENTITY_TTL_MS = 20 * 1000;
function loadEntity(projectId, kind, id) {
	const key = projectId + "|" + kind + "|" + id;
	const cached = entityCache.get(key);
	if (cached !== undefined && Date.now() - cached.at < ENTITY_TTL_MS) return cached.pending;
	const query = "?projectId=" + encodeURIComponent(projectId) + "&kind=" + kind + "&id=" + encodeURIComponent(id);
	const pending = fetch(API + "/design/source" + query).then((response) => (response.ok ? response.json() : null)).then((body) => {
		if (!body || body.code !== 200) return null;
		return body.data;
	});
	entityCache.set(key, { at: Date.now(), pending: pending });
	pending.catch(() => { const row = entityCache.get(key); if (row !== undefined && row.pending === pending) entityCache.delete(key); });
	return pending;
}

/** 让某个实体的缓存立即失效（人保存源码 / agent 写完之后调用）。 */
export function invalidateEntity(projectId, kind, id) {
	entityCache.delete(projectId + "|" + kind + "|" + id);
}

/** 取编译产物：依赖（@project/*）要先各自编译好一起传进沙箱。 */
async function loadCompiled(projectId, kind, id, depth) {
	const entity = await loadEntity(projectId, kind, id);
	if (entity === null) return null;
	const deps = [];
	const imports = entity.meta && Array.isArray(entity.meta.imports) ? entity.meta.imports : [];
	if (depth < 4) {
		for (const name of imports) {
			const dep = await loadCompiled(projectId, "component", name, depth + 1);
			if (dep !== null) deps.push(dep);
		}
	}
	// compiled 源码不在 meta 里，要单独从磁盘取：/design/source 只回 source + meta。
	// 所以这里用宿主下发的 compiled（compiled.js 内容）；没有就走「让沙箱编译」的退化路径（不支持）。
	return { name: id, code: entity.compiledCode || "", deps: deps, meta: entity.meta, source: entity.source };
}

// ── 节点：组件 / 画板 ────────────────────────────────────────────────────────

const chrome = {
	card: { background: "var(--daw-surface, #fff)", border: "1px solid var(--daw-border, #dce2ee)", borderRadius: 12, boxShadow: "0 6px 18px rgba(0,0,0,.06)", overflow: "hidden" },
	head: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--daw-border, #dce2ee)", fontSize: 12, cursor: "grab", whiteSpace: "nowrap" },
	tag: { fontSize: 10, padding: "2px 6px", borderRadius: 999, background: "var(--daw-accent-bg, #f9effa)", color: "var(--daw-accent, #c05bd0)", fontWeight: 600 },
	btn: { fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--daw-border, #dce2ee)", background: "var(--daw-surface, #fff)", cursor: "pointer" },
	muted: { color: "var(--daw-text-muted, #8a93a6)" }
};

const PAGE_WIDTH = { mobile: 390, desktop: 1024 };

/**
 * 一个「沙箱预览」主体：负责 iframe + init + render 的整条链路。
 * 组件节点和画板节点共用它，区别只在 spec（组件 vs 画板入口）。
 */
function SandboxPreview(props) {
	const { projectId, kind, id, title, packId, entry, width, scale, maxHeight, exampleIndex, onReport, onNavigate, sourceHash, token } = props;
	const frameRef = useRef(null);
	const hostRef = useRef(null);
	const [state, setState] = useState({ status: "loading", error: "", info: null });
	// 评论模式（设计方案 §9.3）：开着时 iframe 接鼠标，点中元素弹输入框，POST /design/comments
	const [pickMode, setPickMode] = useState(false);
	const [pendingPick, setPendingPick] = useState(null);
	const [commentText, setCommentText] = useState("");
	const [commentNote, setCommentNote] = useState("");
	const pageWidth = PAGE_WIDTH[width === "mobile" ? "mobile" : "desktop"];

	useEffect(() => {
		const host = hostRef.current;
		if (host !== null && typeof host.setPickMode === "function") host.setPickMode(pickMode);
	}, [pickMode, state.status]);

	const submitComment = useCallback(async () => {
		if (pendingPick === null) return;
		const body = String(commentText || "").trim();
		if (body === "") return;
		setCommentNote("提交中…");
		try {
			const response = await fetch(API + "/design/comments?projectId=" + encodeURIComponent(projectId), {
				method: "POST",
				headers: { "content-type": "application/json", "x-whales-token": token || "" },
				body: JSON.stringify({
					target: (kind === "artboard" ? "board:" : "comp:") + id,
					wsrc: pendingPick.wsrc,
					line: pendingPick.line,
					column: pendingPick.column,
					tag: pendingPick.tag,
					nth: pendingPick.nth,
					count: pendingPick.count,
					body: body,
					sourceSnippet: pendingPick.sourceSnippet
				})
			});
			const payload = await response.json();
			if (payload && payload.code === 200) {
				setCommentNote(payload.data && payload.data.delivered === "sent" ? "已提交，已发给 agent" : "已提交（agent 未在线，它下次读 comments 能看到）");
				setPendingPick(null);
				setCommentText("");
			} else {
				setCommentNote("失败：" + String((payload && payload.msg) || "未知错误"));
			}
		} catch (error) {
			setCommentNote("失败：" + String(error && error.message || error));
		}
	}, [pendingPick, commentText, projectId, kind, id, token]);

	useEffect(() => {
		let live = true;
		const frame = frameRef.current;
		if (!frame) return undefined;
		const host = createSandboxHost(frame, {
			title: title,
			onError: () => {},
			onNavigate: onNavigate,
			// 点选（设计方案 §9.3）：沙箱只回 wsrc + 标签 + nth，行列由宿主用静态表换（前端不重复存一份表）
			onPick: (pick) => {
				if (!live || !pick || !pick.wsrc) return;
				// wsrc → 行列：拿实体的 jsxTable 换
				loadEntity(projectId, kind, id).then((row) => {
					if (!live) return;
					const table = row && Array.isArray(row.jsxTable) ? row.jsxTable : [];
					const hit = table.filter((item) => item && item.wsrc === pick.wsrc)[0];
					setPendingPick({
						wsrc: pick.wsrc,
						line: hit ? hit.line : 0,
						column: hit ? hit.column : 0,
						tag: pick.tag || (hit && hit.tag) || "",
						nth: pick.nth || 0,
						count: pick.count || 1,
						text: pick.text || "",
						sourceSnippet: hit ? hit.snippet || "" : ""
					});
					setCommentNote("");
				}, () => {});
			}
		});
		hostRef.current = host;
		(async () => {
			try {
				const [runtime, pack] = await Promise.all([loadRuntimeText(), loadPackText(packId)]);
				const info = await host.init({ runtime: runtime, styles: pack.styles, bundle: pack.bundle });
				if (!live) return;
				if (info && info.timeout) { setState({ status: "error", error: "沙箱初始化超时", info: null }); return; }
				const compiled = await loadCompiled(projectId, kind, id, 0);
				if (!live) return;
				if (compiled === null || compiled.code === "") {
					setState({ status: "error", error: "拿不到编译产物（源码可能还没保存）", info: info });
					return;
				}
				const result = await host.render({
					name: id,
					code: compiled.code,
					props: (entry && entry.props) || {},
					dependencies: (compiled.deps || []).map((dep) => ({ name: dep.name, code: dep.code })),
					// 画板约定 Board({ navigate })：沙箱里 navigate 会发消息回来，由这里切预览
					isBoard: kind === "artboard"
				});
				if (!live) return;
				setState({ status: result.ok ? "ok" : "error", error: result.error || "", info: result });
				if (typeof onReport === "function") onReport(result);
			} catch (error) {
				if (live) setState({ status: "error", error: String(error && error.message || error), info: null });
			}
		})();
		return () => { live = false; if (hostRef.current) hostRef.current.destroy(); };
		// entry 变化（切 examples）要重渲染：用 entryKey 而不是对象（对象每次都是新的）
	}, [projectId, kind, id, packId, sourceHash, entry && entry.key, exampleIndex]);

	const height = Math.min(maxHeight || 640, Math.max(120, (state.info && state.info.height) || 260));
	const api = (typeof API === "string" ? API : "/agent-whales/api");
	return React.createElement("div", { style: { position: "relative", width: Math.ceil(pageWidth * (scale || 1)), height: height, overflow: "hidden", background: "#fff" } },
		React.createElement("iframe", {
			ref: frameRef,
			title: title || id,
			// 评论模式时 iframe 要吃鼠标（否则点不到里面的元素）；平时 pointerEvents:none 让节点能被拖动
			style: { border: 0, width: pageWidth, height: Math.max(120, (state.info && state.info.height) || 480), transform: "scale(" + (scale || 1) + ")", transformOrigin: "0 0", pointerEvents: pickMode ? "auto" : "none", display: "block" }
		}),
		state.status === "loading" ? React.createElement("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#8a93a6", background: "rgba(255,255,255,.6)" } }, "沙箱渲染中…") : null,
		state.status === "error" ? React.createElement("div", { style: { position: "absolute", left: 8, right: 8, bottom: 8, border: "1px solid #dc2626", background: "#fef2f2", color: "#991b1b", borderRadius: 8, padding: "6px 8px", fontSize: 11, fontFamily: "ui-monospace, Consolas, monospace", maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" } }, "渲染出错：" + String(state.error).slice(0, 400)) : null,
		React.createElement("button", {
			type: "button",
			title: pickMode ? "退出评论模式" : "评论：点页面上的元素留意见",
			onClick: (event) => { event.stopPropagation(); setPickMode(!pickMode); if (pickMode) { setPendingPick(null); setCommentNote(""); } },
			style: { position: "absolute", right: 6, top: 6, zIndex: 2, font: "11px system-ui", padding: "2px 7px", borderRadius: 999, border: "1px solid " + (pickMode ? "#2563eb" : "#dce2ee"), background: pickMode ? "#2563eb" : "rgba(255,255,255,.92)", color: pickMode ? "#fff" : "#5b6577", cursor: "pointer" }
		}, pickMode ? "评论中…" : "💬 评论"),
		pendingPick !== null ? React.createElement("div", {
			style: { position: "absolute", left: 8, right: 8, bottom: 8, zIndex: 3, background: "#fff", border: "1px solid #2563eb", borderRadius: 8, padding: "8px 10px", boxShadow: "0 8px 24px rgba(15,23,42,.18)", font: "12px system-ui" }
		},
			React.createElement("div", { style: { color: "#5b6577", marginBottom: 4 } },
				(String(pendingPick.tag || "元素")) + (pendingPick.line ? " · 第 " + pendingPick.line + " 行" : "") +
				(Number(pendingPick.count) > 1 ? " · 同款第 " + (Number(pendingPick.nth) + 1) + " 个" : "")
			),
			React.createElement("textarea", {
				autoFocus: true,
				value: commentText,
				placeholder: "这里要怎么改？（例如：标题太大 / 换个颜色）",
				onChange: (event) => setCommentText(event.target.value),
				style: { width: "100%", boxSizing: "border-box", height: 56, resize: "vertical", font: "12px system-ui", padding: 6, borderRadius: 6, border: "1px solid #dce2ee" }
			}),
			React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 6, alignItems: "center" } },
				React.createElement("button", { type: "button", onClick: submitComment, disabled: String(commentText || "").trim() === "", style: { font: "12px system-ui", padding: "3px 12px", borderRadius: 6, border: "1px solid #2563eb", background: String(commentText || "").trim() === "" ? "#c7d2fe" : "#2563eb", color: "#fff", cursor: String(commentText || "").trim() === "" ? "default" : "pointer" } }, "提交"),
				React.createElement("button", { type: "button", onClick: () => { setPendingPick(null); setCommentText(""); setCommentNote(""); }, style: { font: "12px system-ui", padding: "3px 10px", borderRadius: 6, border: "1px solid #dce2ee", background: "#fff", cursor: "pointer" } }, "取消"),
				React.createElement("span", { style: { color: "#5b6577", marginLeft: "auto" } }, commentNote)
			)
		) : null
	);
}

/** 组件节点：卡头 + 沙箱预览（可切 examples）。 */
export function DesignComponentNode(props) {
	const data = (props.data && props.data.original) || {};
	const name = typeof data.name === "string" ? data.name : "";
	const title = typeof data.title === "string" ? data.title : name;
	// 这些字段是 client.js 放进**节点 data** 的（React Flow 只把 data 放进 props.data）
	const projectId = (props.data && props.data.projectId) || props.projectId || "";
	const exampleCount = Number.isFinite(data.examplesCount) ? data.examplesCount : 0;
	const [activeExample, setActiveExample] = useState(0);
	const [entity, setEntity] = useState(null);
	useEffect(() => {
		let live = true;
		loadEntity(projectId, "component", name).then((row) => { if (live) setEntity(row); }, () => {});
		return () => { live = false; };
	}, [projectId, name]);
	const examples = entity && entity.meta && Array.isArray(entity.meta.examples) ? entity.meta.examples : [];
	const entry = { key: name + "-" + activeExample, props: examples[activeExample] || {} };
	return React.createElement("div", { style: chrome.card },
		React.createElement("div", { style: chrome.head },
			React.createElement("span", { style: { fontWeight: 600 } }, title || name),
			React.createElement("span", { style: chrome.tag }, "AI · 组件"),
			React.createElement("span", { style: chrome.muted }, name),
			exampleCount > 1 ? React.createElement("span", { style: { display: "flex", gap: 4, marginLeft: "auto" } },
				Array.from({ length: Math.min(exampleCount, 6) }, (_, index) => React.createElement("button", {
					key: index,
					onClick: (event) => { event.stopPropagation(); setActiveExample(index); },
					style: Object.assign({}, chrome.btn, { borderColor: index === activeExample ? "var(--daw-accent, #c05bd0)" : undefined, fontWeight: index === activeExample ? 600 : 400 })
				}, "例子 " + (index + 1)))
			) : null
		),
		// tweaks 控件（§9.5）：number 出滑杆、select 出下拉；值即 __tweaks 传给组件
		tweakNames.length > 0 ? React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--daw-border, #dce2ee)", fontSize: 11 } },
			tweakNames.slice(0, 8).map((key) => {
				const spec = tweakSpec[key] || {};
				const value = effectiveTweaks[key];
				if (spec.type === "select") {
					const options = Array.isArray(spec.options) ? spec.options : [];
					return React.createElement("label", { key: key, style: { display: "flex", alignItems: "center", gap: 4 } },
						React.createElement("span", { style: chrome.muted }, key),
						React.createElement("select", {
							value: String(value),
							onChange: (event) => setTweakValues((prev) => Object.assign({}, prev, { [key]: event.target.value })),
							style: Object.assign({}, chrome.btn, { padding: "1px 4px" })
						}, options.map((option) => React.createElement("option", { key: String(option), value: String(option) }, String(option))))
					);
				}
				const min = Number.isFinite(spec.min) ? spec.min : 0;
				const max = Number.isFinite(spec.max) ? spec.max : 64;
				const step = Number.isFinite(spec.step) ? spec.step : 1;
				return React.createElement("label", { key: key, style: { display: "flex", alignItems: "center", gap: 4 } },
					React.createElement("span", { style: chrome.muted }, key),
					React.createElement("input", {
						type: "range", min: min, max: max, step: step, value: Number(value) || min,
						onChange: (event) => setTweakValues((prev) => Object.assign({}, prev, { [key]: Number(event.target.value) })),
						style: { width: 80 }
					}),
					React.createElement("span", null, String(value))
				);
			})
		) : null,
		React.createElement(SandboxPreview, {
			projectId: projectId, kind: "component", id: name, title: title, packId: data.packId, token: (props.data && props.data.token) || props.token,
			entry: entry, exampleIndex: activeExample, sourceHash: data.sourceHash, width: "desktop", scale: props.scale || 0.42, maxHeight: props.maxHeight || 360
		})
	);
}

/** 画板节点：整页预览（宽度按 desktop / mobile）。 */
export function DesignArtboardNode(props) {
	const data = (props.data && props.data.original) || {};
	const artboardId = typeof data.artboardId === "string" ? data.artboardId : "";
	const title = typeof data.title === "string" ? data.title : artboardId;
	// 这些字段是 client.js 放进**节点 data** 的（React Flow 只把 data 放进 props.data）
	const projectId = (props.data && props.data.projectId) || props.projectId || "";
	const width = data.width === "mobile" ? "mobile" : "desktop";
	// 画板跳转（设计方案 §9.1 / §6.4）：navigate 到同需求的另一个画板 → 这个节点就地切换预览，
	// 并在卡头给一个「返回」把栈退回去。跳转不做页面导航（沙箱里也导航不了）。
	const [trail, setTrail] = useState([artboardId]);
	// 跳转失败时给一句提示（不打断预览）
	const [navNote, setNavNote] = useState("");
	const current = trail[trail.length - 1] || artboardId;
	const goTo = useCallback((target) => {
		if (typeof target !== "string" || target === "") return;
		// 只在 links 里声明过、且真的存在时才跳（P2 审计 I7：跳到不存在的画板会红框 + 标题变成 id）
		const links = Array.isArray(data.links) ? data.links : [];
		if (links.indexOf(target) < 0) { setNavNote("这个画板没有连到「" + target + "」"); return; }
		loadEntity(projectId, "artboard", target).then((row) => {
			if (row === null) { setNavNote("画板「" + target + "」不存在"); return; }
			setTrail((prev) => (prev[prev.length - 1] === target ? prev : prev.concat([target])));
		}, () => {});
	}, [data.links, projectId]);
	const back = useCallback(() => setTrail((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)), []);
	const [currentTitle, setCurrentTitle] = useState(title);
	useEffect(() => {
		let alive = true;
		if (current === artboardId) { setCurrentTitle(title); return undefined; }
		loadEntity(projectId, "artboard", current).then((row) => {
			if (!alive) return;
			setCurrentTitle(row && row.meta && row.meta.title ? row.meta.title : current);
		}, () => {});
		return () => { alive = false; };
	}, [projectId, artboardId, current, title]);
	return React.createElement("div", { style: chrome.card },
		React.createElement("div", { style: chrome.head },
			React.createElement("span", { style: { fontWeight: 600 } }, currentTitle || current),
			React.createElement("span", { style: chrome.tag }, "AI · 画板"),
			React.createElement("span", { style: chrome.muted }, width === "mobile" ? "手机" : "桌面"),
			data.requirementId ? React.createElement("span", { style: chrome.muted }, "· 需求 " + String(data.requirementId).slice(0, 12)) : null,
			navNote !== "" ? React.createElement("span", { style: { color: "#b45309", fontSize: 11 } }, navNote) : null,
			trail.length > 1 ? React.createElement("button", { onClick: (event) => { event.stopPropagation(); back(); }, style: Object.assign({}, chrome.btn, { marginLeft: "auto" }), title: "回到上一个画板" }, "← 返回 (" + (trail.length - 1) + ")") : null
		),
		React.createElement(SandboxPreview, {
			projectId: projectId, kind: "artboard", id: current, title: currentTitle, packId: data.packId, token: (props.data && props.data.token) || props.token,
			entry: { key: current + "-0", props: {} }, sourceHash: current === artboardId ? data.sourceHash : undefined, width: width, scale: props.scale || 0.42, maxHeight: props.maxHeight || 420,
			onNavigate: goTo
		})
	);
}

// ── 在线画布登记（让 agent 的写操作能拿到渲染回报）────────────────────────────

/**
 * 画布页挂上它之后：每 4 秒 `GET /design/live?projectId=` 登记在线并领请求；
 * 领到「请渲染 X」→ 用一个隐藏沙箱渲染 → `POST /design/live/result` 回报。
 * 没有它，`whales_design_write` 只能如实回 unverified（不假装渲染过）。
 */
export function useDesignLive(projectId, token, options) {
	const opts = options || {};
	useEffect(() => {
		if (typeof projectId !== "string" || projectId === "" || typeof token !== "string" || token === "") return undefined;
		let live = true;
		let timer = null;
		const hidden = document.createElement("div");
		hidden.style.cssText = "position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden";
		document.body.appendChild(hidden);
		const frame = document.createElement("iframe");
		frame.style.cssText = "width:1024px;height:800px;border:0";
		hidden.appendChild(frame);
		let host = null;
		let initializing = null;
		async function ensureHost() {
			if (host !== null) return host;
			if (initializing !== null) return initializing;
			host = createSandboxHost(frame, { title: "whales-design-live" });
			initializing = (async () => {
				const [runtime, pack] = await Promise.all([loadRuntimeText(), loadPackText(opts.packId)]);
				return host.init({ runtime: runtime, styles: pack.styles, bundle: pack.bundle });
			})();
			return initializing;
		}
		async function handleRequest(request) {
			const target = request.target || {};
			const kind = target.type === "artboard" ? "artboard" : "component";
			const id = kind === "artboard" ? target.artboardId : target.name;
			try {
				await ensureHost();
				const compiled = await loadCompiled(projectId, kind, id, 0);
				if (compiled === null || compiled.code === "") {
					await postResult({ requestId: request.requestId, ok: false, error: "拿不到编译产物" });
					return;
				}
				const entity = await loadEntity(projectId, kind, id);
				const examples = entity && entity.meta && Array.isArray(entity.meta.examples) ? entity.meta.examples : [];
				const result = await host.render({
					name: id,
					code: compiled.code,
					props: examples[Number(request.exampleIndex) || 0] || {},
					dependencies: (compiled.deps || []).map((dep) => ({ name: dep.name, code: dep.code }))
				});
				await postResult({
					requestId: request.requestId,
					ok: result.ok !== false,
					error: result.error || "",
					consoleErrors: result.consoleErrors || [],
					ms: result.ms,
					width: result.width,
					height: result.height,
					nodeCount: result.nodeCount,
					textLength: result.textLength,
					textSample: result.textSample,
					empty: result.empty,
					buttons: result.buttons,
					inputs: result.inputs,
					tables: result.tables
				});
			} catch (error) {
				await postResult({ requestId: request.requestId, ok: false, error: String(error && error.message || error) });
			}
		}
		async function postResult(body) {
			try {
				await fetch(API + "/design/live/result", {
					method: "POST",
					headers: { "content-type": "application/json", "x-whales-token": token },
					body: JSON.stringify(body)
				});
			} catch (error) { /* 画布回报失败只影响 agent 的 render 状态，不影响人看画布 */ }
		}
		async function poll() {
			if (!live) return;
			try {
				const response = await fetch(API + "/design/live?projectId=" + encodeURIComponent(projectId), { headers: { "x-whales-token": token } });
				if (response.ok) {
					const body = await response.json();
					const requests = body && body.data && Array.isArray(body.data.requests) ? body.data.requests : [];
					for (const request of requests) await handleRequest(request);
				}
			} catch (error) { /* 下一轮再试 */ }
			if (live) timer = setTimeout(poll, 4000);
		}
		poll();
		return () => {
			live = false;
			if (timer) clearTimeout(timer);
			if (host) host.destroy();
			hidden.remove();
		};
	}, [projectId, token, opts.packId]);
}

/**
 * 源码编辑浮层（设计方案 §9.2）。
 *
 * P1 是只读视图；P2 起可编辑：左侧文本域（P2 先用原生 textarea，CodeMirror 6 作为后续增强——
 * 少一个依赖就少一次门禁风险，行号/高亮可以在拿到体积数据后再加），右侧实时预览（沙箱），下方错误条。
 *
 * 「保存」= POST /design/source（同源 token）。人保存 → 元素 userEdited → **之后 agent 写入被锁**，
 * 并在浮层里给一个「解锁让 AI 继续改」按钮（只有人点它才会解锁，agent 没有这条路径）。
 *
 * 渲染成 overlay 而不是 React 树：`client.design.js` 是独立 chunk，往 document.body 挂浮层最简单。
 */
export async function openSourceEditor(el) {
	const data = (el && el.data) || {};
	const projectId = el && el.projectId ? el.projectId : "";
	const kind = el.kind === "artboard" ? "artboard" : "component";
	const id = kind === "artboard" ? data.artboardId : data.name;
	const token = typeof el.token === "string" ? el.token : "";
	const [entity, runtime, pack] = await Promise.all([
		loadEntity(projectId, kind, id),
		loadRuntimeText().catch(() => ""),
		loadPackText(data.packId).catch(() => ({ styles: "", bundle: "" }))
	]);

	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px";
	const panel = document.createElement("div");
	panel.style.cssText = "width:min(1280px,97vw);height:min(860px,94vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";
	const head = document.createElement("div");
	head.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui";
	const titleEl = document.createElement("b");
	titleEl.textContent = (entity && entity.meta && entity.meta.title) || id;
	const metaEl = document.createElement("span");
	metaEl.style.color = "#8a93a6";
	metaEl.textContent = id + ".tsx";
	head.append(titleEl, metaEl);

	const statusEl = document.createElement("span");
	statusEl.style.cssText = "margin-left:12px;font:11px system-ui;color:#8a93a6";
	head.appendChild(statusEl);

	const unlockBtn = document.createElement("button");
	unlockBtn.textContent = "解锁让 AI 继续改";
	unlockBtn.style.cssText = "margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer;display:none";
	head.appendChild(unlockBtn);
	const saveBtn = document.createElement("button");
	saveBtn.textContent = "保存";
	saveBtn.style.cssText = "font:12px system-ui;padding:4px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer";
	head.appendChild(saveBtn);
	const close = document.createElement("button");
	close.textContent = "关闭";
	close.style.cssText = "font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer";
	close.onclick = () => overlay.remove();
	head.appendChild(close);

	const body = document.createElement("div");
	body.style.cssText = "flex:1;display:flex;min-height:0";
	const editorWrap = document.createElement("div");
	editorWrap.style.cssText = "flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #dce2ee";
	const textarea = document.createElement("textarea");
	textarea.spellcheck = false;
	textarea.value = entity ? entity.source : "";
	textarea.style.cssText = "flex:1;width:100%;border:0;outline:none;resize:none;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;tab-size:2";
	editorWrap.appendChild(textarea);
	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = "width:min(560px,46%);display:flex;flex-direction:column;min-width:0;background:#f6f8fb";
	const previewFrame = document.createElement("iframe");
	previewFrame.setAttribute("sandbox", "allow-scripts");
	previewFrame.setAttribute("srcdoc", sandboxSrcdoc({ title: "源码预览" }));
	previewFrame.style.cssText = "flex:1;width:100%;border:0;background:#fff";
	previewWrap.appendChild(previewFrame);
	body.append(editorWrap, previewWrap);
	const errBar = document.createElement("div");
	errBar.style.cssText = "display:none;padding:8px 12px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font:11px/1.6 ui-monospace,Consolas,monospace;max-height:120px;overflow:auto;white-space:pre-wrap";
	panel.append(head, body, errBar);
	overlay.appendChild(panel);
	document.body.appendChild(overlay);
	overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });

	// 预览：先 init 沙箱，之后每次改动（防抖）就 POST 给宿主编译并渲染
	let host = null;
	let compiledNow = entity ? entity.compiledCode || "" : "";
	try {
		host = createSandboxHost(previewFrame, { title: "源码预览" });
		await host.init({ runtime: runtime, styles: pack.styles || "", bundle: pack.bundle || "" });
	} catch (error) { statusEl.textContent = "沙箱初始化失败：" + String(error && error.message || error); }

	let timer = null;
	let seq = 0;
	async function recompileAndRender(source) {
		const mine = ++seq;
		saveBtn.disabled = true;
		statusEl.textContent = "编译中…";
		try {
			const response = await fetch(API + "/design/compile", {
				method: "POST",
				headers: { "content-type": "application/json", "x-whales-token": token },
				body: JSON.stringify({ projectId: projectId, kind: kind, name: kind === "component" ? id : undefined, artboardId: kind === "artboard" ? id : undefined, source: source })
			});
			const body = await response.json();
			if (mine !== seq) return;
			if (!body || body.code !== 200 || !body.data || body.data.compile && body.data.compile.ok === false) {
				const errors = body && body.data && body.data.compile && body.data.compile.errors ? body.data.compile.errors : [];
				errBar.style.display = "block";
				errBar.textContent = errors.length > 0 ? errors.map((e) => e.message).join("\n") : String((body && body.msg) || "编译失败");
				statusEl.textContent = "编译失败";
				saveBtn.disabled = false;
				return;
			}
			errBar.style.display = "none";
			compiledNow = body.data.compiled || compiledNow;
			statusEl.textContent = "编译通过";
			saveBtn.disabled = false;
			if (host !== null) await host.render({ name: id, code: compiledNow, props: (entity && entity.meta && entity.meta.examples && entity.meta.examples[0]) || {}, isBoard: kind === "artboard" });
		} catch (error) {
			if (mine !== seq) return;
			errBar.style.display = "block";
			errBar.textContent = "编译请求失败：" + String(error && error.message || error);
			saveBtn.disabled = false;
		}
	}
	textarea.addEventListener("input", () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => recompileAndRender(textarea.value), 500);
	});
	saveBtn.onclick = async () => {
		statusEl.textContent = "保存中…";
		try {
			const response = await fetch(API + "/design/source", {
				method: "POST",
				headers: { "content-type": "application/json", "x-whales-token": token },
				body: JSON.stringify({ projectId: projectId, kind: kind, name: kind === "component" ? id : undefined, artboardId: kind === "artboard" ? id : undefined, source: textarea.value })
			});
			const body = await response.json();
			if (body && body.code === 200 && body.data && body.data.written === true) {
				statusEl.textContent = "已保存（agent 之后不能改这个了）";
				// 人保存后立刻让缓存失效，画布上的预览才能拿到新内容（P2 审计 I4）
				invalidateEntity(projectId, kind, id);
				unlockBtn.style.display = "";
			} else {
				statusEl.textContent = "保存失败：" + String((body && body.msg) || "未知错误");
			}
		} catch (error) { statusEl.textContent = "保存失败：" + String(error && error.message || error); }
	};
	unlockBtn.onclick = async () => {
		// 只有人能点这个按钮（同源 token）；解锁后 agent 可以再次写入
		statusEl.textContent = "解锁中…";
		try {
			const response = await fetch(API + "/design/unlock", {
				method: "POST",
				headers: { "content-type": "application/json", "x-whales-token": token },
				body: JSON.stringify({ projectId: projectId, kind: kind, name: kind === "component" ? id : undefined, artboardId: kind === "artboard" ? id : undefined })
			});
			const body = await response.json();
			statusEl.textContent = body && body.code === 200 && body.data && body.data.unlocked ? "已解锁，AI 可以继续改" : "解锁失败：" + String((body && body.msg) || "");
			unlockBtn.style.display = "none";
		} catch (error) { statusEl.textContent = "解锁失败：" + String(error && error.message || error); }
	};
	if (entity && entity.userEdited === true) unlockBtn.style.display = "";
	if (compiledNow !== "" && host !== null) {
		try { await host.render({ name: id, code: compiledNow, props: (entity && entity.meta && entity.meta.examples && entity.meta.examples[0]) || {}, isBoard: kind === "artboard" }); } catch (error) { /* 首次预览失败不阻塞编辑 */ }
	}
	return { close: () => overlay.remove() };
}

/** 给画布用的节点定义（client.js 的 nodeTypes 里注册）。 */
export const designNodeTypes = { component: DesignComponentNode, artboard: DesignArtboardNode };

/** 样式（限定在 .daw-design-* 下，不碰 DSH 页面别的东西）。 */
export const DESIGN_CSS = "";

export { sandboxSrcdoc, SANDBOX_CSP, createSandboxHost, loadEntity, loadCompiled, loadPackText, loadRuntimeText };
