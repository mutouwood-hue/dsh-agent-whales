/**
 * lib/client.view.js 的入口：show_view 卡片节点 + 侧聊节点（2026-11-18）。
 *
 * 渲染层来自 deep-view 0.1.2（Apache-2.0，已拷入 tools/flow-chunk/view/react/，之后在这边迭代），
 * 校验 / 公式 / 回答协议来自 lib/view/（宿主半边共用同一份，所以两边对「什么算合法视图」口径一致）。
 * React / ReactDOM / jsx-runtime 外置（宿主共享模块表同一份）。
 *
 * 两个 React Flow 节点只管「画」：数据与动作全由 props.data 传入（与 PrototypeNode 同一套路），
 * 所以 chunk 里没有任何网络请求，也不认识 index.js 的内部状态。
 */
import * as React from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { ViewUi, WidgetCard, DEEP_VIEW_CSS } from "./react/index.js";

const { useState, useRef, useEffect } = React;

// ── 文案：deep-view 的界面 key 是英文，这里给中文；t 支持 {n} 占位符 ──────────────
const ZH = {
	"This view tried to open a page and was stopped.": "这个视图想打开一个页面，已被拦下。",
	"Value": "数值", "Series": "系列", "Chart": "图表", "Copied": "已复制", "Copy": "复制", "Footnotes": "脚注",
	"Selected": "已选", "Submit": "提交", "Your answer": "你的回答", "Cancel": "取消", "Confirm": "确认", "Send": "发送",
	"Progress": "进度", "Sources": "来源", "Chart {n}": "图表 {n}", "View as chart": "看图表", "View as table": "看表格",
	"Copy data": "复制数据", "Download image": "下载图片", "Chart options": "图表选项",
	"Dismiss view": "关闭卡片", "Dismiss": "关闭", "View": "视图"
};
function t(key, vars) {
	let text = Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key;
	if (vars) for (const name of Object.keys(vars)) text = text.split("{" + name + "}").join(String(vars[name]));
	return text;
}

// ── 最小 Markdown（刻意只做这些，且不渲染任何 raw HTML——文本都走 React 节点，天然转义）──
// 支持标题、段落、列表、代码与强调，PRD 额外支持表格和 HTTP(S) 链接。
function inline(text, keyPrefix, allowLinks) {
	const out = [];
	const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
	let last = 0;
	let match;
	let i = 0;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > last) out.push(text.slice(last, match.index));
		const token = match[0];
		const key = keyPrefix + "-" + (i += 1);
		if (token[0] === "`") out.push(jsx("code", { children: token.slice(1, -1) }, key));
		else if (token.startsWith("**")) out.push(jsx("strong", { children: token.slice(2, -2) }, key));
		else if (token[0] === "*") out.push(jsx("em", { children: token.slice(1, -1) }, key));
		else if (allowLinks && text[match.index - 1] !== "!") {
			const boundary = token.lastIndexOf("](");
			out.push(jsx("a", { href: token.slice(boundary + 2, -1), target: "_blank", rel: "noopener noreferrer", children: token.slice(1, boundary) }, key));
		} else out.push(token);
		last = match.index + token.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

export function MiniMarkdown({ text, allowLinks }) {
	const source = String(text == null ? "" : text).replace(/\r\n/g, "\n");
	const blocks = [];
	const lines = source.split("\n");
	let index = 0;
	let key = 0;
	const heading = /^(#{1,6})[ \t]+(.+)$/;
	const cells = (line) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
	function tableHeader(at) {
		if (!allowLinks || !lines[at]?.includes("|") || !lines[at + 1]?.includes("|")) return null;
		const header = cells(lines[at]);
		const divider = cells(lines[at + 1]);
		return divider.length === header.length && divider.every((cell) => /^:?-{3,}:?$/.test(cell)) ? header : null;
	}
	while (index < lines.length) {
		const line = lines[index];
		const title = heading.exec(line);
		if (title) {
			blocks.push(jsx("h" + Math.min(title[1].length + 1, 6), { children: inline(title[2], "h" + key, allowLinks) }, "b" + (key += 1)));
			index += 1;
			continue;
		}
		const headers = tableHeader(index);
		if (headers) {
			index += 2;
			const rows = [];
			while (lines[index]?.includes("|")) {
				const row = cells(lines[index]);
				if (row.length !== headers.length) break;
				rows.push(row);
				index += 1;
			}
			const renderRow = (row, tag, rowKey) => jsx("tr", {
				children: row.map((cell, column) => jsx(tag, { children: inline(cell, "t" + column, allowLinks) }, column))
			}, rowKey);
			blocks.push(jsx("table", { children: [
				jsx("thead", { children: renderRow(headers, "th", "header") }, "head"),
				jsx("tbody", { children: rows.map((row, n) => renderRow(row, "td", n)) }, "body")
			] }, "b" + (key += 1)));
			continue;
		}
		if (/^```/.test(line)) {
			const code = [];
			index += 1;
			while (index < lines.length && !/^```/.test(lines[index])) { code.push(lines[index]); index += 1; }
			index += 1;
			blocks.push(jsx("pre", { style: { margin: "4px 0", padding: "6px 8px", overflow: "auto", borderRadius: 6, background: "var(--daw-surface-muted, #FAFBFD)", fontSize: 12 }, children: jsx("code", { children: code.join("\n") }) }, "b" + (key += 1)));
			continue;
		}
		if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
			const ordered = /^\s*\d+\./.test(line);
			const items = [];
			while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*([-*]|\d+\.)\s+/, "")); index += 1; }
			const children = items.map((item, n) => jsx("li", { children: inline(item, "li" + n, allowLinks) }, n));
			blocks.push(jsx(ordered ? "ol" : "ul", { style: { margin: "4px 0", paddingLeft: 20 }, children }, "b" + (key += 1)));
			continue;
		}
		if (line.trim() === "") { index += 1; continue; }
		const para = [];
		while (index < lines.length && lines[index].trim() !== "" && !/^```/.test(lines[index]) && !heading.test(lines[index]) && !tableHeader(index) && !/^\s*([-*]|\d+\.)\s+/.test(lines[index])) { para.push(lines[index]); index += 1; }
		const children = [];
		para.forEach((row, n) => { if (n > 0) children.push(jsx("br", {}, "br" + n)); children.push(...inline(row, "p" + n, allowLinks)); });
		blocks.push(jsx("p", { style: { margin: "4px 0", lineHeight: 1.55 }, children }, "b" + (key += 1)));
	}
	return jsx("div", { className: "daw-md", style: { wordBreak: "break-word" }, children: blocks });
}

const UI = { t, Markdown: MiniMarkdown };

export const VIEW_CSS = DEEP_VIEW_CSS + `
.daw-view-node,.daw-side-node{--dv-ink:var(--daw-text,#1B2333);--dv-ink-2:var(--daw-text-secondary,#4A5468);--dv-ink-3:var(--daw-text-muted,#8A93A6);
--dv-card:var(--daw-surface,#fff);--dv-main:var(--daw-bg,#EEF1F6);--dv-accent:var(--daw-brand,#3B55F0);--dv-green:var(--daw-ok,#22A06B);--dv-star:var(--daw-warn,#E0A018);--dv-danger:var(--daw-danger,#D64545);
--dv-hover:color-mix(in srgb,var(--daw-text,#1B2333) 6%,transparent);--dv-active:color-mix(in srgb,var(--daw-text,#1B2333) 12%,transparent);--dv-accent-ink:#fff;
--dv-line:var(--daw-border,#DCE2EE);--dv-line-2:var(--daw-border,#DCE2EE);color:var(--daw-text,#1B2333)}
[data-wb-theme=dark] .daw-view-node .dv-q,[data-wb-theme=dark] .daw-side-node .dv-q,.daw-view-node[data-theme=dark] .dv-q,.daw-side-node[data-theme=dark] .dv-q{--dv-q-edge:rgba(255,255,255,.16);--dv-q-rule:rgba(255,255,255,.12);--dv-q-rule-2:rgba(255,255,255,.08)}
.daw-view-node .dv-q{margin:0;max-width:none;box-shadow:none;border-radius:0;padding:10px 12px;background:transparent;animation:none}
.daw-view-node .dv-view-bare{padding:10px 12px}
.daw-view-node.daw-view-closed .dv-view{opacity:.6}
`;

// ── 节点外壳（与 PrototypeNode 同款，卡片风格跟画布 token 走）──────────────────
const chrome = {
	card: { background: "var(--daw-surface, #fff)", border: "1px solid var(--daw-border, #dce2ee)", borderRadius: 12, boxShadow: "0 6px 18px rgba(0,0,0,.06)", overflow: "hidden", fontSize: 12 },
	head: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--daw-border, #dce2ee)", cursor: "grab", whiteSpace: "nowrap" },
	tag: { fontSize: 10, padding: "2px 6px", borderRadius: 999, fontWeight: 600 },
	btn: { fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--daw-border, #dce2ee)", background: "var(--daw-surface, #fff)", color: "var(--daw-text, #1b2333)", cursor: "pointer" },
	muted: { color: "var(--daw-text-muted, #8a93a6)" }
};

const STATUS = {
	shown: { label: "展示", bg: "var(--daw-ok-bg, #EAF7F0)", fg: "var(--daw-ok, #22A06B)" },
	pending: { label: "等你作答", bg: "var(--daw-warn-bg, #FDF6E7)", fg: "var(--daw-warn, #E0A018)" },
	answered: { label: "已作答", bg: "var(--daw-ok-bg, #EAF7F0)", fg: "var(--daw-ok, #22A06B)" },
	dismissed: { label: "已关闭", bg: "var(--daw-surface-muted, #FAFBFD)", fg: "var(--daw-text-muted, #8a93a6)" },
	expired: { label: "已作废", bg: "var(--daw-surface-muted, #FAFBFD)", fg: "var(--daw-text-muted, #8a93a6)" }
};

/**
 * React Flow 节点：show_view 卡片。
 * data: { title, view, status, answer?, source?, busy?, error?, theme?, labels?, onAnswer(action, values), onDismiss() }
 * 关联线由画布画（产出它的对话 → 本卡片），节点本身不管线。
 */
export function ViewNode(props) {
	const d = (props && props.data) || {};
	const status = STATUS[d.status] || STATUS.shown;
	const waiting = d.status === "pending";
	const settled = d.status === "answered" || d.status === "dismissed" || d.status === "expired";
	const answer = d.status === "answered" && d.answer ? { id: d.id, action: d.answer.action, values: d.answer.values } : null;
	return jsxs("div", {
		className: "daw-view-node" + (d.status === "dismissed" || d.status === "expired" ? " daw-view-closed" : ""),
		"data-theme": d.theme === "dark" ? "dark" : "light",
		style: Object.assign({ width: 360 }, chrome.card),
		children: [
			jsxs("div", { className: "daw-view-head", style: chrome.head, children: [
				jsx("span", { children: "▤" }),
				jsx("b", { style: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }, children: d.title || (d.labels && d.labels.untitled) || "视图" }),
				jsx("span", { style: Object.assign({ flex: 1 }, chrome.muted), children: d.source ? "← " + d.source : "" }),
				jsx("span", { style: Object.assign({}, chrome.tag, { background: status.bg, color: status.fg }), children: status.label })
			] }),
			jsx("div", { className: "nodrag nowheel", style: { maxHeight: 520, overflow: "auto" }, children:
				d.view
					? jsx(ViewUi.Provider, { value: UI, children: jsx(WidgetCard, {
						title: "", view: d.view, settled, answer, busy: !!d.busy,
						onSubmit: waiting ? (action, values) => d.onAnswer && d.onAnswer(action, values) : undefined,
						onDismiss: waiting ? () => d.onDismiss && d.onDismiss() : undefined
					}) })
					: jsx("div", { style: Object.assign({ padding: 12 }, chrome.muted), children: "（卡片内容丢失）" })
			}),
			d.error ? jsx("div", { style: { padding: "6px 10px", color: "var(--daw-danger, #d64545)", borderTop: "1px solid var(--daw-border, #dce2ee)" }, children: d.error }) : null
		]
	});
}

/** 侧聊能不能发送（纯函数，单测直接测）：没连线 / 空草稿 / 正在发 / 上一问还在答，都不能。 */
export function sideCanSend({ sending, entries, sources, draft }) {
	if (sending) return false;
	if ((Array.isArray(entries) ? entries : []).some((entry) => entry && entry.status === "answering")) return false;
	if ((Array.isArray(sources) ? sources : []).length === 0) return false;
	return String(draft == null ? "" : draft).trim() !== "";
}

/**
 * React Flow 节点：侧聊。
 * data: { title, sources: [{id, title}], entries: [{id, question, answer, status, error}], theme?, labels?, busy?,
 *         onAsk(text) => Promise, onCancel(entryId), onRemove() }
 * 背景来自连到它的对话（画布上的「上下文」线）；侧聊自己不写回任何对话。
 */
export function SideNode(props) {
	const d = (props && props.data) || {};
	const labels = d.labels || {};
	const entries = Array.isArray(d.entries) ? d.entries : [];
	const sources = Array.isArray(d.sources) ? d.sources : [];
	const answering = entries.find((entry) => entry.status === "answering");
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const composing = useRef(false);
	const tail = useRef(null);
	useEffect(() => { if (tail.current && tail.current.scrollIntoView) tail.current.scrollIntoView({ block: "nearest" }); }, [entries.length, answering && answering.id, entries.length > 0 && entries[entries.length - 1].status]);
	const disabled = !sideCanSend({ sending, entries, sources, draft });
	const send = () => {
		if (disabled || !d.onAsk) return;
		const text = draft.trim();
		setSending(true);
		Promise.resolve(d.onAsk(text)).then(() => setDraft(""), () => {}).then(() => setSending(false));
	};
	return jsxs("div", {
		className: "daw-side-node", "data-theme": d.theme === "dark" ? "dark" : "light",
		style: Object.assign({ width: 340, display: "flex", flexDirection: "column" }, chrome.card),
		children: [
			jsxs("div", { className: "daw-side-head", style: chrome.head, children: [
				jsx("span", { children: "✦" }),
				jsx("b", { style: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 170 }, children: d.title || labels.title || "侧聊" }),
				jsx("span", { style: Object.assign({ flex: 1 }, chrome.muted), children: labels.readonly || "只读 · 不动原对话" }),
				d.onRemove ? jsx("button", { type: "button", className: "nodrag", style: chrome.btn, title: labels.remove || "删除侧聊", onClick: () => d.onRemove(), children: "✕" }) : null
			] }),
			jsx("div", { style: { padding: "6px 10px", display: "flex", flexWrap: "wrap", gap: 4, borderBottom: "1px solid var(--daw-border, #dce2ee)" }, children:
				sources.length === 0
					? jsx("span", { style: chrome.muted, children: labels.noSource || "还没连到对话：从对话卡拖一条线到这里" })
					: sources.map((source) => jsx("span", { title: source.id, style: Object.assign({}, chrome.tag, { background: "var(--daw-accent-bg, #f9effa)", color: "var(--daw-accent, #c05bd0)", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }), children: source.title || String(source.id).slice(0, 8) }, source.id))
			}),
			jsxs("div", { className: "nodrag nowheel", style: { maxHeight: 360, minHeight: 80, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }, children: [
				entries.length === 0 ? jsx("div", { style: chrome.muted, children: labels.empty || "连好线后在下面提问，它会先读完连着的对话再回答。" }) : null,
				...entries.map((entry) => jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
					jsx("div", { style: { alignSelf: "flex-end", maxWidth: "88%", padding: "6px 10px", borderRadius: 10, background: "var(--daw-brand, #3b55f0)", color: "#fff", whiteSpace: "pre-wrap", wordBreak: "break-word" }, children: entry.question }),
					entry.status === "answering"
						? jsxs("div", { style: chrome.muted, children: [labels.thinking || "思考中…", " ", d.onCancel ? jsx("button", { type: "button", className: "nodrag", style: chrome.btn, onClick: () => d.onCancel(entry.id), children: labels.cancel || "取消" }) : null] })
						: entry.status === "cancelled"
							? jsx("div", { style: chrome.muted, children: labels.cancelled || "已取消" })
							: entry.status === "failed"
								? jsxs("div", { style: { color: "var(--daw-danger, #d64545)" }, children: [(labels.failed || "没答成：") + (entry.error || ""), entry.answer ? jsx(MiniMarkdown, { text: entry.answer }) : null] })
								: jsx("div", { style: { padding: "6px 10px", borderRadius: 10, background: "var(--daw-surface-muted, #FAFBFD)", border: "1px solid var(--daw-border, #dce2ee)" }, children: jsx(MiniMarkdown, { text: entry.answer }) })
				] }, entry.id)),
				jsx("div", { ref: tail })
			] }),
			jsxs("div", { style: { display: "flex", gap: 6, padding: 8, borderTop: "1px solid var(--daw-border, #dce2ee)" }, children: [
				jsx("textarea", {
					className: "nodrag nowheel", rows: 2, value: draft, placeholder: labels.placeholder || "问点什么（Enter 发送，Shift+Enter 换行）",
					style: { flex: 1, resize: "none", padding: "6px 8px", borderRadius: 8, border: "1px solid var(--daw-border, #dce2ee)", background: "var(--daw-surface, #fff)", color: "var(--daw-text, #1b2333)", font: "inherit" },
					onChange: (event) => setDraft(event.target.value),
					onCompositionStart: () => { composing.current = true; },
					onCompositionEnd: () => { composing.current = false; },
					onKeyDown: (event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !(event.nativeEvent && event.nativeEvent.isComposing)) { event.preventDefault(); send(); } }
				}),
				jsx("button", { type: "button", className: "nodrag", disabled, onClick: send, style: Object.assign({}, chrome.btn, { alignSelf: "flex-end", opacity: disabled ? 0.5 : 1 }), children: labels.send || "发送" })
			] })
		]
	});
}
