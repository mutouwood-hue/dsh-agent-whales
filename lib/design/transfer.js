/**
 * 组件工坊：导出 / 导入自包含 HTML（设计方案 §12）。
 *
 * 导出产物是**一个** .html：能双击打开看、能点（带运行时），源码在 `#whales-design` 的 JSON 段里，
 * 换台机器 / 换个项目还能导回来——这是跨项目复用的唯一通道（§2 决策 2）。
 *
 * 两条硬约束：
 *   1. **受控组件包（如 CDS，UNLICENSED）默认不内嵌**。导出时由人显式选择「含组件包代码」（只在公司内部传）；
 *      默认只带源码，打开时缺失的组件显示占位。内置 shadcn 包（MIT）总能带。
 *   2. **导入只解析 JSON 段，绝不执行文件里的脚本**（§13 安全清单）。导入的源码要重新过白名单 + 重新编译。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const EXPORT_FORMAT = "whales-design";
export const EXPORT_FORMAT_VERSION = 1;
/** 单个导出文件的体积上限（自包含 = 运行时 + 组件包 + 源码，给到 16MB）。 */
export const EXPORT_MAX_BYTES = 16 * 1024 * 1024;
/** 导入时不认识的 formatVersion 直接拒（不做「尽力而为」的兼容）。 */
export function isKnownFormatVersion(version) {
	return Number(version) === EXPORT_FORMAT_VERSION;
}

// ── 导出 ────────────────────────────────────────────────────────────────────

/**
 * 组装一个自包含 HTML。
 *
 * @param {object} input
 *   · components   [{ name, title, description, source, propsSchema, examples, tweaks, imports }]
 *   · artboards    [{ artboardId, title, width, source, links }]
 *   · entry        { kind: "component"|"artboard", id, title }  打开时先渲染谁
 *   · pack         { id, version, license, controlled, bundle, styles, includeCode }
 *   · runtime      string  沙箱运行时文本（`lib/client.sandbox-runtime.js`）
 *   · srcdoc       string  沙箱 iframe 的 srcdoc（含 CSP 与 bootstrap）
 *   · compiled     { [name]: code } 编译产物（组件 + 画板）
 *   · exportedAt   ISO 字符串
 * @returns {string} 完整 HTML
 */
export function buildExportHtml(input) {
	const opts = input || {};
	const components = Array.isArray(opts.components) ? opts.components : [];
	const artboards = Array.isArray(opts.artboards) ? opts.artboards : [];
	const pack = opts.pack || {};
	const compiled = opts.compiled && typeof opts.compiled === "object" ? opts.compiled : {};
	// 受控包默认不内嵌：这是 §12.1 的硬约束，不能靠调用方记得传
	const controlled = pack.controlled === true;
	const includePack = controlled ? pack.includeCode === true : true;
	const payload = {
		format: EXPORT_FORMAT,
		formatVersion: EXPORT_FORMAT_VERSION,
		exportedAt: typeof opts.exportedAt === "string" ? opts.exportedAt : new Date().toISOString(),
		from: { plugin: "dsh-agent-whales", version: typeof opts.pluginVersion === "string" ? opts.pluginVersion : "" },
		pack: {
			id: typeof pack.id === "string" ? pack.id : "shadcn",
			version: typeof pack.version === "string" ? pack.version : "",
			license: typeof pack.license === "string" ? pack.license : "",
			controlled: controlled,
			// 这一项是给接收方看的：没有组件包代码时，用到的 @cds 组件会显示占位
			embedded: includePack && typeof pack.bundle === "string" && pack.bundle !== ""
		},
		entry: opts.entry && typeof opts.entry.id === "string" ? { kind: opts.entry.kind === "artboard" ? "artboard" : "component", id: opts.entry.id, title: String(opts.entry.title || opts.entry.id) } : null,
		components: components.map((row) => compact({
			name: row.name,
			title: row.title,
			description: row.description,
			source: row.source,
			propsSchema: row.propsSchema,
			examples: row.examples,
			tweaks: row.tweaks,
			imports: row.imports
		})),
		artboards: artboards.map((row) => compact({
			artboardId: row.artboardId,
			title: row.title,
			width: row.width === "mobile" ? "mobile" : "desktop",
			source: row.source,
			links: row.links
		}))
	};

	// 打开即可交互：运行时 + 编译产物 +（可选）组件包 bundle
	const boot = {
		runtime: typeof opts.runtime === "string" ? opts.runtime : "",
		srcdoc: typeof opts.srcdoc === "string" ? opts.srcdoc : "",
		compiled: compiled,
		pack: includePack ? { bundle: String(pack.bundle || ""), styles: String(pack.styles || "") } : { bundle: "", styles: "" }
	};
	const title = payload.entry !== null ? payload.entry.title + " · whales design" : "whales design";
	return [
		"<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
		"<meta name=\"generator\" content=\"dsh-agent-whales 组件工坊\">",
		"<title>" + escapeHtml(title) + "</title>",
		"<style>html,body{margin:0;padding:0;background:#f6f8fb}iframe{display:block;width:100%;border:0;background:#fff}"
			+ ".wds-missing{border:1px dashed #c4c4c4;border-radius:6px;padding:8px 10px;margin:8px;font:12px system-ui;color:#888;background:#fafafa}</style>",
		"</head><body>",
		// 静态部分：没有脚本也能看到「这是哪一版的什么设计」
		"<noscript><div class=\"wds-missing\">这个文件需要启用脚本才能交互预览；源码在页面底部 #whales-design 段里，可直接查看。</div></noscript>",
		"<script type=\"application/vnd.whales.design+json\" id=\"whales-design\">" + safeJsonForScript(payload) + "</script>",
		"<script type=\"application/json\" id=\"whales-design-boot\">" + safeJsonForScript(boot) + "</script>",
		"<script>" + EXPORT_BOOT_SCRIPT + "</script>",
		"</body></html>"
	].join("");
}

/** 导出页自己的引导脚本：把 runtime 塞进沙箱、渲染 entry。只用 postMessage，不 eval 组件包之外的任何东西。 */
const EXPORT_BOOT_SCRIPT = String.raw`
(function () {
	"use strict";
	var dataEl = document.getElementById("whales-design");
	var bootEl = document.getElementById("whales-design-boot");
	if (!dataEl || !bootEl) return;
	var payload, boot;
	try { payload = JSON.parse(dataEl.textContent || "{}"); boot = JSON.parse(bootEl.textContent || "{}"); } catch (error) { return; }
	if (!payload || payload.format !== "whales-design") return;
	var title = payload.entry && payload.entry.title ? payload.entry.title : "whales design";
	document.title = title + " · whales design";
	var frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("srcdoc", boot.srcdoc || "<!doctype html><html><body></body></html>");
	frame.style.height = "640px";
	document.body.appendChild(frame);
	var nonce = Math.random().toString(16).slice(2) + Date.now().toString(16);
	window.addEventListener("message", function (event) {
		if (event.origin !== "null") return;
		var data = event.data || {};
		if (data.type === "ready") {
			var entry = payload.entry || { kind: "component", id: payload.components && payload.components[0] ? payload.components[0].name : "" };
			var code = boot.compiled && boot.compiled[entry.id] ? boot.compiled[entry.id] : "";
			if (code === "") { showMissing("这个入口没有编译产物（可能导出时实体不存在）"); return; }
			frame.contentWindow.postMessage({ type: "render", nonce: nonce, runId: "export", name: entry.id, code: code, props: {}, isBoard: entry.kind === "artboard" }, "*");
			return;
		}
		if (data.type === "rendered" && data.nonce === nonce) {
			if (data.ok !== false) frame.style.height = Math.max(160, Math.min(4000, (data.height || 480) + 16)) + "px";
			if (data.error) showMissing("渲染出错：" + String(data.error).slice(0, 240));
		}
		if (data.type === "error" && data.nonce === nonce) showMissing(String(data.message || "").slice(0, 240));
	});
	function showMissing(text) {
		var box = document.createElement("div");
		box.className = "wds-missing";
		box.textContent = text;
		document.body.appendChild(box);
	}
	frame.contentWindow.addEventListener("load", function () {
		frame.contentWindow.postMessage({ type: "init", nonce: nonce, runtime: boot.runtime || "", packCode: (boot.pack && boot.pack.bundle) || "", styles: (boot.pack && boot.pack.styles) || "" }, "*");
	});
})();
`;

// ── 导入 ────────────────────────────────────────────────────────────────────

/**
 * 从一段 HTML 里取出 `#whales-design` 的 JSON 段。**绝不执行文件里的任何脚本**（§13）。
 * @returns {{ ok: true, payload } | { ok: false, reason }}
 */
export function parseExportHtml(html) {
	const text = String(html || "");
	if (text.length > EXPORT_MAX_BYTES) return { ok: false, reason: "文件太大（上限 " + Math.round(EXPORT_MAX_BYTES / 1024 / 1024) + "MB）" };
	const marker = /<script[^>]*id=["']whales-design["'][^>]*>([\s\S]*?)<\/script>/i;
	const match = text.match(marker);
	if (match === null) return { ok: false, reason: "这不是组件工坊导出的文件（没有 #whales-design 段）" };
	let payload;
	try { payload = JSON.parse(match[1]); } catch (error) { return { ok: false, reason: "导出段不是合法 JSON：" + String(error && error.message || error).slice(0, 120) }; }
	if (!payload || typeof payload !== "object") return { ok: false, reason: "导出段不是对象" };
	if (payload.format !== EXPORT_FORMAT) return { ok: false, reason: "不是 whales-design 格式（format=" + String(payload.format) + "）" };
	if (!isKnownFormatVersion(payload.formatVersion)) return { ok: false, reason: "不认识的格式版本 " + String(payload.formatVersion) + "（本插件只认 " + EXPORT_FORMAT_VERSION + "）" };
	const components = Array.isArray(payload.components) ? payload.components : [];
	const artboards = Array.isArray(payload.artboards) ? payload.artboards : [];
	if (components.length === 0 && artboards.length === 0) return { ok: false, reason: "这份导出里没有组件也没有画板" };
	return { ok: true, payload: payload };
}

/**
 * 导入前的冲突与缺口检查（纯函数，不做写入）。
 *
 * @param {object} payload  parseExportHtml 的结果
 * @param {{ existingNames?: string[], packId?: string, packVersion?: string }} [context]
 * @returns {{ conflicts: Array<{ kind, id, action }>, gaps: string[], warnings: string[] }}
 *   conflicts 每项给出默认处置建议（rename / skip / overwrite），由人来定
 *   gaps 是「源码 import 了 @cds 但当前项目的组件包不是 CDS（或版本更低）」这类缺口
 */
export function planImport(payload, context) {
	const opts = context || {};
	const existing = new Set(Array.isArray(opts.existingNames) ? opts.existingNames : []);
	const conflicts = [];
	const warnings = [];
	const gaps = [];
	const exportedPack = payload && payload.pack && typeof payload.pack === "object" ? payload.pack : {};
	for (const component of Array.isArray(payload && payload.components) ? payload.components : []) {
		const name = typeof component.name === "string" ? component.name : "";
		if (name === "") { warnings.push("有一个组件没有名字，导入时会跳过"); continue; }
		if (existing.has(name)) conflicts.push({ kind: "component", id: name, action: "rename" });
	}
	for (const board of Array.isArray(payload && payload.artboards) ? payload.artboards : []) {
		const id = typeof board.artboardId === "string" ? board.artboardId : "";
		if (id === "") { warnings.push("有一个画板没有 id，导入时会跳过"); continue; }
		if (existing.has(id)) conflicts.push({ kind: "artboard", id: id, action: "rename" });
	}
	// 组件包缺口：源码里用了 @cds，但导出时带的包和当前项目的包不一致
	const usesCds = (Array.isArray(payload && payload.components) ? payload.components : []).some((row) => /from\s+["']@cds["']/.test(String(row.source || "")))
		|| (Array.isArray(payload && payload.artboards) ? payload.artboards : []).some((row) => /from\s+["']@cds["']/.test(String(row.source || "")));
	const currentPack = typeof opts.packId === "string" ? opts.packId : "";
	if (usesCds) {
		const exportedId = typeof exportedPack.id === "string" ? exportedPack.id : "";
		if (exportedId !== "" && currentPack !== "" && exportedId !== currentPack) {
			gaps.push("这份设计用的是组件包「" + exportedId + "」，当前项目是「" + currentPack + "」：渲染时缺的组件会显示占位");
		}
		if (exportedPack.embedded !== true) {
			gaps.push("导出文件里**不含组件包代码**（受控包默认不带）：打开时需要本机装有同名组件包，否则 @cds 部分显示占位");
		}
	}
	return { conflicts: conflicts, gaps: gaps, warnings: warnings };
}

/** 重名时给一个不冲突的新名字（Name / Name-2 / Name-3…，并保证仍是 PascalCase）。 */
export function uniqueImportName(base, existing) {
	const taken = new Set(Array.isArray(existing) ? existing : []);
	const clean = String(base || "Component").replace(/[^A-Za-z0-9]/g, "").trim() || "Component";
	const pascal = clean[0].toUpperCase() + clean.slice(1);
	if (!taken.has(pascal)) return pascal;
	for (let i = 2; i < 500; i += 1) {
		const candidate = pascal + i;
		if (!taken.has(candidate)) return candidate;
	}
	return pascal + Date.now().toString(36);
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** JSON → 可安全放进 `<script>` 的文本（把 `</script` 打断，防提前闭合）。 */
function safeJsonForScript(value) {
	return JSON.stringify(value).replace(/<\/script/gi, "<\\/script").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function compact(object) {
	const out = {};
	for (const key of Object.keys(object)) if (object[key] !== undefined) out[key] = object[key];
	return out;
}

/** 读一个组件包文件（导出时把 bundle / styles 内嵌用）。读不到给空串。 */
export function readPackFile(packDir, file) {
	try {
		const full = join(packDir, file);
		if (!existsSync(full)) return "";
		return readFileSync(full, "utf8");
	} catch (error) { return ""; }
}
