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
import { createPortal } from "react-dom";
import { sandboxSrcdoc, SANDBOX_CSP } from "../../../lib/design/sandbox.js";

const { useCallback, useEffect, useMemo, useRef, useState } = React;
const API = "/agent-whales/api";
const BUILTIN_BUNDLE = typeof __WHALES_SHADCN_BUNDLE__ === "string" ? __WHALES_SHADCN_BUNDLE__ : "";
const BUILTIN_CSS = typeof __WHALES_SHADCN_CSS__ === "string" ? __WHALES_SHADCN_CSS__ : "";

// ── 运行时与组件包文本（Chunk 级缓存，避免每个沙箱岛重复拉取）─────────────────
const runtimeCache = new Map(); // "" -> Promise<string>
const packCache = new Map(); // packId -> Promise<{ bundle, styles, raw, api, manifest }>

function fetchDesign(url, options) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 12000);
	return fetch(url, { ...options, signal: controller.signal }).then(async (response) => {
		if (!response.ok) throw new Error("设计资源加载失败（" + response.status + "）");
		// 读完响应体才解除超时，防止头已到达但内容一直挂起。
		return url.includes("/design/source?") ? response.json() : response.text();
	}).catch((error) => { throw controller.signal.aborted ? new Error("设计资源加载超时，请重新渲染") : error; }).finally(() => clearTimeout(timer));
}

/** 沙箱运行时：从 host 下发的 `client.sandbox-runtime.js` 文本取（预构建，见 build-design.mjs）。 */
function loadRuntimeText() {
	const key = "runtime";
	if (runtimeCache.has(key)) return runtimeCache.get(key);
	const pending = fetchDesign(API + "/design/runtime.js");
	runtimeCache.set(key, pending);
	pending.catch(() => runtimeCache.delete(key));
	return pending;
}

/** 预览只拉组件包代码和样式；内置包直接复用构建产物。 */
function loadPackText(packId) {
	const id = typeof packId === "string" && packId !== "" ? packId : "shadcn";
	if (packCache.has(id)) return packCache.get(id);
	const base = API + "/component-packs/" + encodeURIComponent(id);
	const pending = (async () => {
		if (id === "shadcn") {
			// 内置包由构建期转成 CommonJS 文本送进沙箱；函数对象不能 postMessage。
			return { bundle: BUILTIN_BUNDLE, styles: BUILTIN_CSS, api: null, builtin: true };
		}
		const [bundle, styles] = await Promise.all([
			fetchDesign(base + "/bundle.js"),
			fetchDesign(base + "/styles.css")
		]);
		return { bundle: bundle, styles: styles, api: null, builtin: false };
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
	let destroyed = false;
	let booted = false;
	let bootResolve = null;
	let initResolve = null;
	let renderResolve = null;
	const timers = new Set();
	const bootId = nextNonce();
	const timeoutMs = opts.timeoutMs || 8000;
	function waitFor(register, error) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => done({ ok: false, timeout: true, error }), timeoutMs);
			timers.add(timer);
			function done(result) { clearTimeout(timer); timers.delete(timer); resolve(result); }
			register(done);
		});
	}
	const onMessage = (event) => {
		if (destroyed || event.origin !== "null") return;
		const data = event.data || {};
		if (data.type === "booted") {
			if (data.bootId === bootId) { booted = true; if (bootResolve) bootResolve({ ok: true }); }
			return;
		}
		if (data.nonce !== nonce) return;
		if (data.type === "ready") { ready = true; if (initResolve) initResolve(data.info || {}); return; }
		if (data.type === "rendered") { if (renderResolve) { const done = renderResolve; renderResolve = null; done(data); } return; }
		if (data.type === "resize") { opts.onResize?.(data.height); return; }
		if (data.type === "pick") { opts.onPick?.(data.pick); return; }
		if (data.type === "navigate") { opts.onNavigate?.(data.to); return; }
		if (data.type === "error") {
			const failure = { ok: false, error: data.message || "沙箱执行失败" };
			if (!ready && initResolve) initResolve(failure);
			if (renderResolve) { renderResolve(failure); renderResolve = null; }
			opts.onError?.(data);
		}
	};
	window.addEventListener("message", onMessage);
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("srcdoc", sandboxSrcdoc({ csp: SANDBOX_CSP, title: opts.title || "whales-design", bootId }));

	async function init(payload) {
		if (destroyed) return { ok: false, cancelled: true };
		if (!booted) {
			const boot = await waitFor((done) => { bootResolve = done; }, "沙箱启动超时");
			bootResolve = null;
			if (!boot.ok || destroyed) return boot;
		}
		nonce = nextNonce();
		return waitFor((done) => {
			initResolve = done;
			frame.contentWindow.postMessage({ type: "init", nonce, runtime: payload.runtime, styles: payload.styles, packCode: payload.bundle }, "*");
		}, "沙箱初始化超时");
	}
	function render(spec) {
		if (destroyed || !ready) return Promise.resolve({ ok: false, error: "沙箱还没就绪" });
		if (renderResolve) renderResolve({ ok: false, cancelled: true });
		nonce = nextNonce();
		return waitFor((done) => {
			renderResolve = done;
			frame.contentWindow.postMessage({
				type: "render", nonce, runId: spec.runId || "run-" + Date.now(), mountId: spec.mountId || "main",
				name: spec.name, code: spec.code, props: spec.props || {}, dependencies: spec.dependencies || [], isBoard: spec.isBoard === true
			}, "*");
		}, "渲染超时，请重新渲染");
	}
	return {
		init, render,
		setPickMode: function (enabled) { if (ready && !destroyed) frame.contentWindow.postMessage({ type: "pick-mode", nonce, enabled: Boolean(enabled) }, "*"); },
		destroy: function () {
			destroyed = true;
			window.removeEventListener("message", onMessage);
			for (const done of [bootResolve, initResolve, renderResolve]) if (done) done({ ok: false, cancelled: true });
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
		isReady: function () { return ready && !destroyed; }
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
function loadEntity(projectId, kind, id, token) {
	const key = projectId + "|" + kind + "|" + id + "|" + (typeof token === "string" ? token : "");
	const cached = entityCache.get(key);
	if (cached !== undefined && Date.now() - cached.at < ENTITY_TTL_MS) return cached.pending;
	const query = "?projectId=" + encodeURIComponent(projectId) + "&kind=" + kind + "&id=" + encodeURIComponent(id);
	const headers = typeof token === "string" && token !== "" ? { "x-whales-token": token } : {};
	const pending = fetchDesign(API + "/design/source" + query, { headers }).then((body) => {
		if (!body || body.code !== 200) return null;
		return body.data;
	});
	entityCache.set(key, { at: Date.now(), pending: pending });
	pending.catch(() => { const row = entityCache.get(key); if (row !== undefined && row.pending === pending) entityCache.delete(key); });
	return pending;
}

/** 让某个实体的缓存立即失效（人保存源码 / agent 写完之后调用）。 */
export function invalidateEntity(projectId, kind, id) {
	for (const key of Array.from(entityCache.keys())) {
		if (key.indexOf(projectId + "|" + kind + "|" + id + "|") === 0) entityCache.delete(key);
	}
}

/** 取编译产物：依赖（@project/*）要先各自编译好一起传进沙箱。 */
async function loadCompiled(projectId, kind, id, depth, token, ancestors = []) {
	const key = kind + ":" + id;
	if (ancestors.includes(key)) throw new Error("组件存在循环依赖：" + ancestors.concat(key).join(" → "));
	const entity = await loadEntity(projectId, kind, id, token);
	if (entity === null) return null;
	const imports = entity.meta && Array.isArray(entity.meta.imports) ? entity.meta.imports : [];
	const children = await Promise.all(imports.map((name) => loadCompiled(projectId, "component", name, depth + 1, token, ancestors.concat(key))));
	const deps = new Map();
	for (const child of children) {
		if (!child) throw new Error("拿不到依赖组件的编译产物");
		for (const dep of child.deps) deps.set(dep.name, dep);
		deps.set(child.name, { name: child.name, code: child.code });
	}
	return { name: id, code: entity.compiledCode || "", deps: Array.from(deps.values()), meta: entity.meta, source: entity.source };
}

// ── 节点：组件 / 画板 ────────────────────────────────────────────────────────

const chrome = {
	card: { background: "var(--daw-surface, #fff)", border: "1px solid var(--daw-border, #dce2ee)", borderRadius: 12, boxShadow: "0 6px 18px rgba(0,0,0,.06)", overflow: "hidden" },
	head: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--daw-border, #dce2ee)", fontSize: 12, cursor: "grab", whiteSpace: "nowrap" },
	tag: { fontSize: 10, padding: "2px 6px", borderRadius: 999, background: "var(--daw-accent-bg, #f9effa)", color: "var(--daw-accent, #c05bd0)", fontWeight: 600 },
	muted: { color: "var(--daw-text-muted, #8a93a6)" }
};

const PAGE_WIDTH = { mobile: 390, desktop: 1024 };

function usePreviewWidth(viewport, layoutKey) {
	const [width, setWidth] = useState(560);
	useEffect(() => {
		const box = viewport.current;
		if (!box) return undefined;
		function resize() { if (box.clientWidth > 0) setWidth(box.clientWidth); }
		resize();
		if (typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(resize);
		observer.observe(box);
		return () => observer.disconnect();
	}, [viewport, layoutKey]);
	return width;
}

/** 画布外框：指针捕获防止跨 iframe 丢失拖动，按画布缩放换算距离。 */
function useDesignFrame(props, defaultWidth) {
	const saved = props.data?.frameSize;
	const [size, setSize] = useState(() => ({ w: saved?.w > 0 ? saved.w : defaultWidth, h: saved?.h > 0 ? saved.h : 0 }));
	const frame = useRef(null);
	const drag = useRef(null);
	const latestSize = useRef(size);
	latestSize.current = size;
	const enabled = !props.review;
	function commit(next) { setSize(next); latestSize.current = next; props.data?.onFrameResize?.(next.w, next.h); }
	const handle = enabled ? React.createElement("button", {
		type: "button", className: "nodrag nopan", "aria-label": "调整设计图外框大小", title: "拖拽调整大小；方向键微调",
		style: { position: "absolute", right: 0, bottom: 0, width: 22, height: 22, padding: 0, border: 0, borderRadius: "6px 0 10px 0", background: "var(--daw-surface, #fff)", color: "#64748b", cursor: "nwse-resize", touchAction: "none", zIndex: 4 },
		onPointerDown: (event) => {
			if (event.button !== 0) return;
			event.preventDefault(); event.stopPropagation();
			const box = frame.current;
			const rect = box.getBoundingClientRect();
			drag.current = { x: event.clientX, y: event.clientY, w: box.offsetWidth, h: box.offsetHeight, zoom: rect.width / box.offsetWidth || 1 };
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		onPointerMove: (event) => {
			const start = drag.current;
			if (!start) return;
			event.stopPropagation();
			const next = { w: Math.round(Math.max(280, Math.min(2400, start.w + (event.clientX - start.x) / start.zoom))), h: Math.round(Math.max(180, Math.min(2400, start.h + (event.clientY - start.y) / start.zoom))) };
			latestSize.current = next; setSize(next);
		},
		onPointerUp: (event) => {
			if (!drag.current) return;
			event.stopPropagation(); drag.current = null;
			commit(latestSize.current);
			event.currentTarget.releasePointerCapture(event.pointerId);
		},
		onLostPointerCapture: () => { if (drag.current) { drag.current = null; commit(latestSize.current); } },
		onPointerCancel: () => { if (drag.current) { drag.current = null; commit(latestSize.current); } },
		onKeyDown: (event) => {
			if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
			event.preventDefault(); event.stopPropagation();
			const box = frame.current;
			const step = event.shiftKey ? 40 : 10;
			commit({ w: Math.max(280, Math.min(2400, box.offsetWidth + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))), h: Math.max(180, Math.min(2400, box.offsetHeight + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))) });
		}
	}, "◢") : null;
	return { frame, handle, width: size.w, style: enabled ? { ...chrome.card, position: "relative", display: "flex", flexDirection: "column", boxSizing: "border-box", width: size.w, height: size.h || undefined } : { background: "var(--daw-surface, #fff)" } };
}

function retryDesign(projectId, setRevision) {
	for (const key of Array.from(entityCache.keys())) if (key.startsWith(projectId + "|")) entityCache.delete(key);
	setRevision((value) => value + 1);
}

/**
 * 一个「沙箱预览」主体：负责 iframe + init + render 的整条链路。
 * 组件节点和画板节点共用它，区别只在 spec（组件 vs 画板入口）。
 */
function SandboxPreview(props) {
	const { projectId, kind, id, title, packId, entry, width, scale, maxHeight, exampleIndex, onReport, onNavigate, sourceHash, token, mode, onChanged, snapshot, interactive, renderRevision } = props;
	const frameRef = useRef(null);
	const hostRef = useRef(null);
	const [state, setState] = useState({ status: "loading", error: "", info: null });
	const [measuredHeight, setMeasuredHeight] = useState(0);
	// 画布内两种直接操作：标注（发对话）与直接改（文本 / token 类）。
	const interaction = mode === "edit" || mode === "annotate" ? mode : "view";
	const interactionRef = useRef(interaction);
	interactionRef.current = interaction;
	const navigateRef = useRef(onNavigate);
	navigateRef.current = onNavigate;
	const [pendingPick, setPendingPick] = useState(null);
	const [commentText, setCommentText] = useState("");
	const [commentNote, setCommentNote] = useState("");
	const [commentSending, setCommentSending] = useState(false);
	const [editInfo, setEditInfo] = useState(null);
	const [editText, setEditText] = useState("");
	const [editNote, setEditNote] = useState("");
	const [localRev, setLocalRev] = useState(0);
	const pageWidth = PAGE_WIDTH[width === "mobile" ? "mobile" : "desktop"];

	useEffect(() => {
		const host = hostRef.current;
		if (host !== null && typeof host.setPickMode === "function") host.setPickMode(interaction !== "view");
		setPendingPick(null);
		setEditInfo(null);
		setCommentNote("");
		setEditNote("");
	}, [interaction, id]);

	const submitComment = useCallback(async () => {
		if (pendingPick === null || commentSending) return;
		const body = String(commentText || "").trim();
		if (body === "") return;
		setCommentSending(true);
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
				setCommentNote(payload.data && payload.data.delivered === "sent" ? "标注已保存并发送" : "标注已保存，送达待确认");
				setPendingPick(null);
				setCommentText("");
			} else {
				setCommentNote("失败：" + String((payload && payload.msg) || "未知错误"));
			}
		} catch (error) {
			setCommentNote("失败：" + String(error && error.message || error));
		} finally { setCommentSending(false); }
	}, [pendingPick, commentText, commentSending, projectId, kind, id, token]);

	const saveEdit = useCallback(async (patch) => {
		if (pendingPick === null || !pendingPick.wsrc) { setEditNote("这个元素没有源码锚点，请用标注让 AI 改"); return; }
		setEditNote("保存中…");
		try {
			const response = await fetch(API + "/design/edit?projectId=" + encodeURIComponent(projectId), {
				method: "POST",
				headers: { "content-type": "application/json", "x-whales-token": token || "" },
				body: JSON.stringify(Object.assign({ kind: kind, name: kind === "component" ? id : undefined, artboardId: kind === "artboard" ? id : undefined, wsrc: pendingPick.wsrc }, patch))
			});
			const payload = await response.json();
			if (payload && payload.code === 200) {
				setEditNote("已保存并重新渲染");
				invalidateEntity(projectId, kind, id);
				setLocalRev((value) => value + 1);
				if (typeof onChanged === "function") onChanged();
			} else setEditNote("保存失败：" + String((payload && payload.msg) || "未知错误"));
		} catch (error) { setEditNote("保存失败：" + String(error && error.message || error)); }
	}, [pendingPick, projectId, kind, id, token, onChanged]);

	useEffect(() => {
		let live = true;
		const frame = frameRef.current;
		if (!frame) return undefined;
		setState({ status: "loading", error: "", info: null });
		setMeasuredHeight(0);
		const host = createSandboxHost(frame, {
			title: title,
			onResize: (height) => { if (live && Number.isFinite(height) && height > 0) setMeasuredHeight(Math.min(20000, height)); },
			onError: () => {},
			onNavigate: (target) => navigateRef.current?.(target),
			// 点选（设计方案 §9.3）：沙箱只回 wsrc + 标签 + nth，行列由宿主用静态表换（前端不重复存一份表）
			onPick: (pick) => {
				if (!live || !pick) return;
				// wsrc → 行列：拿实体的 jsxTable 换
				loadEntity(projectId, kind, id, token).then((row) => {
					if (!live || interactionRef.current === "view") return;
					const table = row && Array.isArray(row.jsxTable) ? row.jsxTable : [];
					const hit = table.filter((item) => item && item.wsrc === pick.wsrc)[0];
					const selected = {
						wsrc: pick.wsrc || "",
						line: hit ? hit.line : 0,
						column: hit ? hit.column : 0,
						tag: pick.tag || (hit && hit.tag) || "",
						nth: pick.nth || 0,
						count: pick.count || 1,
						text: pick.text || "",
						sourceSnippet: hit ? hit.snippet || "" : ""
					};
					setPendingPick(selected);
					setCommentNote("");
					setEditNote("");
					if (interactionRef.current === "edit") {
						setEditText(selected.text || "");
						setEditInfo(null);
						if (!selected.wsrc) { setEditNote("这个元素没有源码锚点，请用标注让 AI 改"); return; }
						fetch(API + "/design/classes?projectId=" + encodeURIComponent(projectId) + "&kind=" + kind + "&id=" + encodeURIComponent(id) + "&wsrc=" + encodeURIComponent(selected.wsrc), { headers: { "x-whales-token": token || "" } })
							.then((response) => response.json())
							.then((body) => { if (live) setEditInfo(body && body.code === 200 ? body.data : { error: body && body.msg || "读取元素失败" }); })
							.catch((error) => { if (live) setEditNote(String(error && error.message || error)); });
					}
				}, () => {});
			}
		});
		hostRef.current = host;
		(async () => {
			try {
				const [info, compiled] = await Promise.all([
					Promise.all([loadRuntimeText(), loadPackText(packId)]).then(([runtime, pack]) => live ? host.init({ runtime, styles: pack.styles, bundle: pack.bundle }) : { cancelled: true }),
					snapshot || loadCompiled(projectId, kind, id, 0, token)
				]);
				if (!live) return;
				if (info && (info.timeout || info.ok === false)) { setState({ status: "error", error: info.error || "沙箱初始化失败", info: null }); return; }
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
				if (result.ok) host.setPickMode(interactionRef.current !== "view");
				setState({ status: result.ok ? "ok" : "error", error: result.error || "", info: result });
				if (typeof onReport === "function") onReport(result);
			} catch (error) {
				if (live) setState({ status: "error", error: String(error && error.message || error), info: null });
			}
		})();
		return () => { live = false; host.destroy(); if (hostRef.current === host) hostRef.current = null; };
		// entry 变化（切 examples）要重渲染：用 entryKey 而不是对象（对象每次都是新的）
	}, [projectId, kind, id, packId, sourceHash, entry && entry.key, exampleIndex, localRev, snapshot, token, renderRevision]);

	function retry() {
		if (!snapshot) {
			for (const key of Array.from(entityCache.keys())) if (key.startsWith(projectId + "|")) entityCache.delete(key);
		}
		setLocalRev((value) => value + 1);
	}
	const shownScale = scale || 1;
	const contentHeight = Math.max(120, measuredHeight || (state.info && Math.max(state.info.height || 0, state.info.scrollHeight || 0)) || 480);
	const naturalHeight = Math.max(120, Math.ceil(contentHeight * shownScale));
	const height = maxHeight ? Math.min(maxHeight, naturalHeight) : naturalHeight;
	const viewportHeight = Math.ceil(height / shownScale);
	const api = (typeof API === "string" ? API : "/agent-whales/api");
	return React.createElement("div", { style: { position: "relative", width: Math.ceil(pageWidth * (scale || 1)), height: height, overflow: "hidden", background: "#fff" } },
		React.createElement("iframe", {
			ref: frameRef,
			title: title || id,
			style: { border: 0, width: pageWidth, height: viewportHeight, transform: "scale(" + shownScale + ")", transformOrigin: "0 0", pointerEvents: interactive || interaction !== "view" ? "auto" : "none", display: "block" }
		}),
		state.status === "loading" ? React.createElement("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#8a93a6", background: "rgba(255,255,255,.6)" } }, "沙箱渲染中…") : null,
		state.status === "error" ? React.createElement("div", { style: { position: "absolute", left: 8, right: 8, bottom: 8, border: "1px solid #dc2626", background: "#fef2f2", color: "#991b1b", borderRadius: 8, padding: "6px 8px", fontSize: 11, fontFamily: "ui-monospace, Consolas, monospace", maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" } }, React.createElement("span", { role: "alert" }, "渲染出错：" + String(state.error || "预览内容为空").slice(0, 400)),
			React.createElement("button", { type: "button", className: "daw-wb-btn nodrag nopan", style: { marginLeft: 8 }, onClick: retry }, "重新渲染")) : null,
		interaction !== "view" ? React.createElement("div", { style: { position: "absolute", left: 8, top: 6, zIndex: 2, font: "11px system-ui", padding: "3px 8px", borderRadius: 999, background: "#2563eb", color: "#fff" } }, interaction === "edit" ? "直接改：点选元素" : "标注：点选元素") : null,
		pendingPick !== null && interaction === "annotate" ? React.createElement("div", {
			style: { position: "absolute", left: 8, right: 8, bottom: 8, zIndex: 3, background: "#fff", border: "1px solid #2563eb", borderRadius: 8, padding: "8px 10px", boxShadow: "0 8px 24px rgba(15,23,42,.18)", font: "12px system-ui" }
		},
			React.createElement("div", { style: { color: "#5b6577", marginBottom: 4 } },
				(String(pendingPick.tag || "元素")) + (pendingPick.line ? " · 第 " + pendingPick.line + " 行" : "") +
				(Number(pendingPick.count) > 1 ? " · 同款第 " + (Number(pendingPick.nth) + 1) + " 个" : "")
			),
			React.createElement("textarea", {
				autoFocus: true,
				"aria-label": "修改意见",
				onKeyDown: (event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					if (!commentSending) { setPendingPick(null); setCommentText(""); setCommentNote(""); }
				},
				value: commentText,
				placeholder: "这里要怎么改？（例如：标题太大 / 换个颜色）",
				onChange: (event) => setCommentText(event.target.value),
				style: { width: "100%", boxSizing: "border-box", height: 56, resize: "vertical", font: "12px system-ui", padding: 6, borderRadius: 6, border: "1px solid #dce2ee" }
			}),
			React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 6, alignItems: "center" } },
				React.createElement("button", { type: "button", className: "daw-wb-btn", onClick: submitComment, disabled: commentSending || String(commentText || "").trim() === "" }, "提交"),
				React.createElement("button", { type: "button", className: "daw-wb-btn", "data-variant": "ghost", disabled: commentSending, onClick: () => { setPendingPick(null); setCommentText(""); setCommentNote(""); } }, "取消"),
				React.createElement("span", { role: "status", style: { color: "#5b6577", marginLeft: "auto" } }, commentNote)
			)
		) : null,
		pendingPick === null && interaction === "annotate" && commentNote !== "" ? React.createElement("div", {
			role: "status", style: { position: "absolute", left: 8, bottom: 8, maxWidth: "calc(100% - 16px)", padding: "5px 8px", borderRadius: 6, background: "var(--daw-surface, #fff)", color: "var(--daw-text, #172033)", fontSize: 12 }
		}, commentNote) : null,
		pendingPick !== null && interaction === "edit" ? React.createElement("div", {
			style: { position: "absolute", left: 8, right: 8, bottom: 8, zIndex: 3, background: "#fff", border: "1px solid #2563eb", borderRadius: 8, padding: "8px 10px", boxShadow: "0 8px 24px rgba(15,23,42,.18)", font: "12px system-ui", maxHeight: "80%", overflow: "auto" }
		},
			React.createElement("div", { style: { color: "#5b6577", marginBottom: 4 } }, "直接改 · " + (pendingPick.tag || "元素") + (pendingPick.line ? " · L" + pendingPick.line : "")),
			React.createElement("textarea", { value: editText, onChange: (event) => setEditText(event.target.value), placeholder: "修改这个元素的文字", style: { width: "100%", boxSizing: "border-box", height: 42, resize: "vertical", font: "12px system-ui", padding: 6, borderRadius: 6, border: "1px solid #dce2ee" } }),
			React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 6 } },
				React.createElement("button", { type: "button", className: "daw-wb-btn", onClick: () => saveEdit({ text: editText }) }, "保存文字"),
				React.createElement("button", { type: "button", className: "daw-wb-btn", "data-variant": "ghost", onClick: () => { setPendingPick(null); setEditInfo(null); setEditNote(""); } }, "取消")),
			editInfo && editInfo.error ? React.createElement("div", { style: { color: "#b45309", marginTop: 6 } }, editInfo.error) : null,
			editInfo && Array.isArray(editInfo.classes) ? editInfo.classes.map((row) => React.createElement("label", { key: row.name, style: { display: "flex", alignItems: "center", gap: 6, marginTop: 6 } },
				React.createElement("span", { style: { color: "#5b6577", minWidth: 70 } }, row.family),
				React.createElement("select", { value: row.name, onChange: (event) => saveEdit({ fromClass: row.name, toClass: event.target.value }), style: { font: "12px system-ui", padding: 4, borderRadius: 6, border: "1px solid #dce2ee", maxWidth: "100%" } },
					[row.name].concat((editInfo.options && editInfo.options[row.name]) || []).map((name) => React.createElement("option", { key: name, value: name }, name))))
			) : null,
			React.createElement("div", { style: { color: "#5b6577", marginTop: 6 } }, editNote)
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
	const frameBox = useDesignFrame(props, 440);
	const [renderRevision, setRenderRevision] = useState(0);
	const [activeExample, setActiveExample] = useState(0);
	const [mode, setMode] = useState("view");
	const [entity, setEntity] = useState(null);
	useEffect(() => {
		let live = true;
		loadEntity(projectId, "component", name, (props.data && props.data.token) || props.token).then((row) => { if (live) setEntity(row); }, () => {});
		return () => { live = false; };
	}, [projectId, name]);
	const examples = entity && entity.meta && Array.isArray(entity.meta.examples) ? entity.meta.examples : [];
	// tweaks（设计方案 §9.5）：组件声明 `export const tweaks = { gap: { type:"number", min, max, step, default },
	// accent: { type:"select", options } }`，预览旁出滑杆 / 下拉；值以 props.__tweaks 传给组件（约定组件读 __tweaks）。
	const tweakSpec = entity && entity.meta && entity.meta.tweaksSpec && typeof entity.meta.tweaksSpec === "object" ? entity.meta.tweaksSpec : {};
	const tweakNames = Object.keys(tweakSpec);
	const [tweakValues, setTweakValues] = useState({});
	const effectiveTweaks = {};
	for (const key of tweakNames) {
		const spec = tweakSpec[key] || {};
		if (tweakValues[key] !== undefined) { effectiveTweaks[key] = tweakValues[key]; continue; }
		if (spec.default !== undefined) { effectiveTweaks[key] = spec.default; continue; }
		effectiveTweaks[key] = spec.type === "number" ? (Number.isFinite(spec.min) ? spec.min : 0) : "";
	}
	const entry = {
		// key 里带上 tweaks 的值：值一变就重新渲染沙箱（SandboxPreview 按 entry.key 判断要不要重跑）
		key: name + "-" + activeExample + "-" + JSON.stringify(effectiveTweaks),
		props: Object.assign({}, examples[activeExample] || {}, tweakNames.length > 0 ? { __tweaks: effectiveTweaks } : {})
	};
	return React.createElement("div", { ref: frameBox.frame, style: frameBox.style },
		React.createElement("div", { style: { ...chrome.head, flexWrap: "wrap", whiteSpace: "normal", flexShrink: 0 }, "data-design-head": "1" },
			React.createElement("span", { style: { fontWeight: 600 } }, title || name),
			React.createElement("span", { style: chrome.tag }, "AI · 组件"),
			React.createElement("span", { style: chrome.muted }, name),
			React.createElement("button", { type: "button", className: "daw-wb-btn nodrag", onClick: (event) => { event.stopPropagation(); retryDesign(projectId, setRenderRevision); } }, "重新渲染"),
			typeof data.onEdit === "function" ? React.createElement("button", { type: "button", onClick: (event) => { event.stopPropagation(); data.onEdit(); }, className: "daw-wb-btn", "data-variant": "ghost" }, (data.labels && data.labels.edit) || "编辑") : null,
			React.createElement("button", { type: "button", onClick: (event) => { event.stopPropagation(); setMode(mode === "annotate" ? "view" : "annotate"); }, className: "daw-wb-btn", "data-variant": "ghost", "data-on": String(mode === "annotate") }, mode === "annotate" ? "退出标注" : ((data.labels && data.labels.annotate) || "标注")),
			React.createElement("button", { type: "button", onClick: (event) => { event.stopPropagation(); setMode(mode === "edit" ? "view" : "edit"); }, className: "daw-wb-btn", "data-variant": "ghost", "data-on": String(mode === "edit") }, mode === "edit" ? "退出直接改" : ((data.labels && data.labels.editDirect) || "直接改")),
			exampleCount > 1 ? React.createElement("span", { style: { display: "flex", gap: 4, marginLeft: "auto" } },
				Array.from({ length: Math.min(exampleCount, 6) }, (_, index) => React.createElement("button", {
					key: index,
					onClick: (event) => { event.stopPropagation(); setActiveExample(index); },
					className: "daw-wb-btn", "data-variant": "ghost", "data-on": String(index === activeExample)
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
							className: "daw-wb-btn", "data-variant": "ghost"
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
		React.createElement("div", { className: "nodrag nowheel", style: { minHeight: 0, flex: 1, overflow: "auto" } }, React.createElement(SandboxPreview, {
			renderRevision, projectId: projectId, kind: "component", id: name, title: title, packId: data.packId, token: (props.data && props.data.token) || props.token,
			entry: entry, exampleIndex: activeExample, sourceHash: data.sourceHash, width: "desktop", scale: (frameBox.width - 2) / PAGE_WIDTH.desktop, maxHeight: props.maxHeight || (frameBox.style.height ? undefined : 360),
			mode: mode, onChanged: data.onDesignChanged
		})), frameBox.handle
	);
}

/** 画板节点：整页预览（宽度按 desktop / mobile）。 */
export function DesignArtboardNode(props) {
	const data = (props.data && props.data.original) || {};
	const artboardId = typeof data.artboardId === "string" ? data.artboardId : "";
	const title = typeof data.title === "string" ? data.title : artboardId;
	// 这些字段是 client.js 放进**节点 data** 的（React Flow 只把 data 放进 props.data）
	const projectId = (props.data && props.data.projectId) || props.projectId || "";
	const token = (props.data && props.data.token) || props.token;
	const labels = props.data?.labels || data.labels || {};
	const frameBox = useDesignFrame(props, 460);
	const [renderRevision, setRenderRevision] = useState(0);
	const [trail, setTrail] = useState([]);
	const [mode, setMode] = useState("view");
	const [navNote, setNavNote] = useState("");
	const linked = trail[trail.length - 1];
	const current = linked ? linked.id : artboardId;
	const currentData = linked ? linked.meta : data;
	const currentTitle = currentData.title || (linked ? current : title);
	const width = currentData.width === "mobile" ? "mobile" : "desktop";
	const viewport = useRef(null);
	const availableWidth = usePreviewWidth(viewport);
	const scale = props.review ? Math.min(1, availableWidth / PAGE_WIDTH[width]) : (frameBox.width - 2) / PAGE_WIDTH[width];
	const goTo = useCallback((target) => {
		if (typeof target !== "string" || target === "" || target === current) return;
		if (!Array.isArray(currentData.links) || !currentData.links.includes(target)) {
			setNavNote("这个画板没有连到「" + target + "」");
			return;
		}
		loadEntity(projectId, "artboard", target, token).then((row) => {
			if (row === null) { setNavNote("画板「" + target + "」不存在"); return; }
			setNavNote("");
			setTrail((previous) => previous[previous.length - 1]?.id === target ? previous : [...previous, { id: target, meta: row.meta || {} }]);
		}, () => { setNavNote("画板加载失败"); });
	}, [current, currentData.links, projectId, token]);
	function toggleMode(event, next) {
		event.stopPropagation();
		setMode((previous) => previous === next ? "view" : next);
	}
	const button = (label, key) => React.createElement("button", {
		type: "button", className: "daw-wb-btn", "data-variant": "tool",
		"aria-pressed": mode === key, onClick: (event) => toggleMode(event, key)
	}, label);
	return React.createElement("div", { ref: frameBox.frame, style: frameBox.style },
		React.createElement("div", {
			style: { ...chrome.head, cursor: props.review ? "default" : "grab", flexWrap: "wrap", whiteSpace: "normal", flexShrink: 0 },
			"data-design-head": "1"
		},
			React.createElement("span", { style: { fontWeight: 650, flex: props.review ? "1 1 95px" : undefined, minWidth: 0, overflowWrap: "anywhere" } }, currentTitle),
			props.review ? null : React.createElement("span", { style: chrome.tag }, "AI · 画板"),
			React.createElement("span", { style: chrome.muted }, width === "mobile" ? "手机" : "桌面"),
			!props.review && data.requirementId ? React.createElement("span", { style: chrome.muted }, "· 需求 " + String(data.requirementId).slice(0, 12)) : null,
			!linked && typeof data.onEdit === "function" ? React.createElement("button", { type: "button", onClick: (event) => { event.stopPropagation(); data.onEdit(); }, className: "daw-wb-btn", "data-variant": "ghost" }, labels.edit || "编辑") : null,
			React.createElement("button", { type: "button", className: "daw-wb-btn nodrag", onClick: (event) => { event.stopPropagation(); retryDesign(projectId, setRenderRevision); } }, "重新渲染"),
			React.createElement("div", { className: "daw-wb-board-tools", role: "group", "aria-label": labels.toolGroup || "画板工具" },
				button(mode === "annotate" ? "退出标注" : (labels.annotate || "标注"), "annotate"),
				button(mode === "edit" ? "退出直接改" : (labels.editDirect || "直接改"), "edit")),
			trail.length > 0 ? React.createElement("button", { type: "button", onClick: (event) => {
				event.stopPropagation();
				setNavNote("");
				setTrail((previous) => previous.slice(0, -1));
			}, className: "daw-wb-btn", "data-variant": "ghost", title: "回到上一个画板" }, "← 返回 (" + trail.length + ")") : null
		),
		navNote ? React.createElement("div", { role: "status", style: { padding: "6px 10px", color: "var(--daw-warn, #b45309)", fontSize: 12 } }, navNote) : null,
		React.createElement("div", {
			ref: props.review ? viewport : undefined,
			className: "nodrag nowheel",
			style: props.review ? { display: "grid", justifyItems: "center", minWidth: 0, overflow: "hidden", background: "var(--daw-surface-muted, #f5f6f8)" } : { flex: 1, minHeight: 0, overflow: "auto" }
		}, React.createElement(SandboxPreview, {
			renderRevision, projectId, kind: "artboard", id: current, title: currentTitle, packId: currentData.packId || data.packId, token,
			entry: { key: current + "-0", props: {} }, sourceHash: currentData.sourceHash, width, scale,
			onNavigate: goTo, interactive: true, mode, onChanged: props.data?.onDesignChanged || data.onDesignChanged
		})), frameBox.handle
	);
}

/** 聊天回合引用交付时保存的代码与依赖，实时画布继续使用当前版本。 */
export function DesignChatPreview(props) {
	const delivery = props.delivery;
	const viewport = useRef(null);
	const dialog = useRef(null);
	const inlineStage = useRef(null);
	const fullStage = useRef(null);
	const [stage] = useState(() => document.createElement("div"));
	const availableWidth = usePreviewWidth(viewport, props.fullscreen);
	const [localRevision, setLocalRevision] = useState(0);
	const [trail, setTrail] = useState([delivery.entryId]);
	const board = delivery.boards.find((item) => item.id === trail[trail.length - 1]);
	const snapshot = useMemo(() => board && ({
		code: board.code,
		deps: board.dependencies.map((name) => ({ name, code: delivery.modules[name] }))
	}), [board, delivery]);
	useEffect(() => {
		if (board && typeof props.onBoardChange === "function") props.onBoardChange(board.id);
	}, [board, props.onBoardChange]);
	useEffect(() => {
		const box = dialog.current;
		const target = props.fullscreen ? fullStage.current : inlineStage.current;
		if (target && stage.parentNode !== target) {
			// moveBefore 保留 iframe 的文档与表单状态；旧 WebView 不支持时重新初始化沙箱。
			if (stage.isConnected && typeof target.moveBefore === "function") target.moveBefore(stage, null);
			else { const moving = stage.isConnected; target.appendChild(stage); if (moving) setLocalRevision((value) => value + 1); }
		}
		if (props.fullscreen && box && !box.open) box.showModal();
		else if (box?.open) box.close();
	}, [props.fullscreen, stage]);
	if (!board) return null;
	const scale = Math.min(1, availableWidth / PAGE_WIDTH[board.width === "mobile" ? "mobile" : "desktop"]);
	const content = React.createElement("div", { ref: viewport, style: { display: "grid", justifyItems: "center", minWidth: 0, overflow: "hidden" } },
		trail.length > 1 ? React.createElement("button", {
			type: "button", className: "daw-wb-btn", "data-variant": "ghost",
			onClick: () => setTrail((previous) => previous.slice(0, -1))
		}, props.backLabel || "返回上一屏") : null,
		React.createElement(SandboxPreview, {
			projectId: delivery.projectId, kind: "artboard", id: board.id, title: board.title,
			packId: delivery.packId, width: board.width, scale, interactive: true, snapshot, renderRevision: String(props.renderRevision || 0) + ":" + localRevision,
			onNavigate: (target) => {
				if (target !== board.id && board.links.includes(target) && delivery.boards.some((item) => item.id === target)) setTrail((previous) => [...previous, target]);
			}
		})
	);
	return React.createElement(React.Fragment, null,
		React.createElement("div", { ref: inlineStage }),
		createPortal(content, stage),
		React.createElement("dialog", {
			ref: dialog, "aria-label": board.title || board.id,
			onCancel: () => props.onCloseFullscreen?.(), onClose: () => { if (props.fullscreen) props.onCloseFullscreen?.(); },
			onClick: (event) => { if (event.target === event.currentTarget) props.onCloseFullscreen?.(); },
			style: { width: "calc(100vw - 32px)", maxWidth: "none", height: "calc(100dvh - 32px)", maxHeight: "none", padding: 0, border: "1px solid var(--daw-border, #dce2ee)", borderRadius: 12, background: "var(--daw-surface, #fff)", color: "var(--daw-text, #172033)" }
		}, React.createElement("div", { style: { height: "100%", display: "flex", flexDirection: "column" } },
			React.createElement("header", { style: { ...chrome.head, cursor: "default", flexShrink: 0 } },
				React.createElement("strong", { style: { flex: 1, minWidth: 0, whiteSpace: "normal" } }, board.title || board.id),
				React.createElement("button", { type: "button", className: "daw-wb-btn", onClick: () => setLocalRevision((value) => value + 1) }, "重新渲染"),
				React.createElement("button", { type: "button", className: "daw-wb-btn", onClick: () => props.onCloseFullscreen?.() }, props.closeLabel || "关闭")),
			React.createElement("div", { ref: fullStage, className: "nowheel", style: { flex: 1, minHeight: 0, overflow: "auto", background: "#f5f6f8" } })
		))
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
				const compiled = await loadCompiled(projectId, kind, id, 0, token);
				if (compiled === null || compiled.code === "") {
					await postResult({ requestId: request.requestId, ok: false, error: "拿不到编译产物" });
					return;
				}
				const entity = await loadEntity(projectId, kind, id, token);
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
		loadEntity(projectId, kind, id, token),
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
