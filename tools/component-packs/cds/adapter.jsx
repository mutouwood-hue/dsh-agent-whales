/**
 * 「通用原型词表 → CDS」适配（本地组件包模板）。
 *
 * 这份适配是本插件的代码（MIT）；@company/cds-react 是受控包（UNLICENSED），**不随插件分发**。
 * 用法：在装了 @company/cds-react 的机器上跑 build.mjs，产物写到 ~/.dsh/agent-whales/component-packs/cds/，
 * 画布上的组件库节点就能切到 CDS。词表口径见 lib/prototype-vocab.js。
 */
import { jsx, jsxs } from "react/jsx-runtime";
import {
	Button, Card, Checkbox, DataTable, FormField, InlineAlert, Input, Overlay, Section, Select, Sidebar, Switch, Tabs, Tag, Textarea, Topbar, Upload
} from "@company/cds-react";
// 组件工坊（设计方案 §7）：把 CDS 的**原始导出**整包交给沙箱，agent 的 TSX 里 `import { X } from "@cds"`
// 就解析到这里。词表适配（components）与原始导出（raw）互不影响：旧画布仍走词表。
// 注意：这里是 `export * as raw`，导出面等于 @company/cds-react 的全部导出（238 个组件 + 若干工具函数）。
import * as raw from "@company/cds-react";

const list = (value) => String(value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
const Slot = (S) => (typeof S === "function" ? jsx(S, {}) : null);
const BUTTON = { primary: "primary", secondary: "default", outline: "default", ghost: "ghost", destructive: "danger-ghost" };
const TAG = { default: "brand", secondary: "neutral", outline: "neutral", destructive: "danger" };
const ALERT = { info: "warning", success: "warning", warning: "warning", error: "danger" };

export const components = {
	Heading: ({ text, level }) => jsx("h" + (level || "2"), { className: level === "1" ? "text-2xl font-semibold" : level === "3" ? "text-base font-semibold" : "text-xl font-semibold", children: text }),
	Text: ({ text, tone }) => jsx("p", { className: tone === "muted" ? "text-sm text-muted-foreground" : "text-sm text-foreground", children: text }),
	Button: ({ label, variant }) => jsx(Button, { variant: BUTTON[variant] || "primary", children: label }),
	Input: ({ label, placeholder }) => jsx(FormField, { label: label || " ", children: jsx(Input, { placeholder }) }),
	Textarea: ({ label, placeholder }) => jsx(FormField, { label: label || " ", children: jsx(Textarea, { placeholder, rows: 3 }) }),
	Select: ({ label, options }) => jsx(FormField, { label: label || " ", children: jsx(Select, { options: list(options).map((o) => ({ value: o, label: o })), value: list(options)[0], placeholder: "请选择" }) }),
	Checkbox: ({ label, checked }) => jsxs("label", { className: "inline-flex items-center gap-2 text-sm", children: [jsx(Checkbox, { defaultChecked: checked === "true", readOnly: true }), label] }),
	Switch: ({ label, checked }) => jsxs("span", { className: "inline-flex items-center gap-2 text-sm", children: [jsx(Switch, { defaultChecked: checked === "true", ariaLabel: label }), label] }),
	Badge: ({ text, variant }) => jsx(Tag, { tone: TAG[variant] || "brand", children: text }),
	Alert: ({ title, description, variant }) => jsx(InlineAlert, { tone: ALERT[variant] || "warning", fill: true, children: description ? title + "：" + description : title }),
	Upload: ({ hint }) => jsx(Upload, { hint }),
	Table: ({ columns, rows }) => {
		const cols = list(columns).map((c, i) => ({ key: "c" + i, header: c }));
		const count = Math.max(0, Math.min(20, Number(rows) || 0));
		const data = Array.from({ length: count }, (_, r) => Object.fromEntries(cols.map((c, i) => [c.key, i === 0 ? c.header + " " + (r + 1) : "—"]).concat([["id", "r" + r]])));
		return jsx(DataTable, { rows: data, columns: cols, rowKey: (row) => row.id });
	},
	Tabs: ({ tabs, active }) => {
		const items = list(tabs).map((t, i) => ({ key: "t" + i, label: t, content: null }));
		return jsx(Tabs, { items, value: "t" + (Number(active) || 0), tabsOnly: true });
	},
	Stat: ({ label, value }) => jsx(Card, { header: jsx("span", { className: "text-sm text-muted-foreground", children: label }), children: jsx("div", { className: "text-2xl font-semibold", children: value }) }),
	Navbar: ({ brand, links }) => jsx(Topbar, { crumb: [brand].concat(list(links).slice(0, 1)), showUser: false }),
	Sidebar: ({ items, active }) => {
		const nav = [{ group: null, items: list(items).map((label, i) => ({ id: "n" + i, label, icon: null })) }];
		return jsx("div", { style: { height: 320, display: "flex" }, children: jsx(Sidebar, { nav, activeId: "n" + (Number(active) || 0), showUser: false }) });
	},
	Divider: () => jsx("hr", { className: "border-border" }),
	Image: ({ alt, height }) => jsx("div", { className: "flex items-center justify-center rounded bg-muted text-xs text-muted-foreground", style: { height: Math.max(40, Math.min(600, Number(height) || 120)) }, children: alt || "图片" }),
	Card: ({ title, description, content }) => jsx(Card, { header: jsxs("div", { children: [jsx("div", { className: "font-semibold", children: title }), description ? jsx("div", { className: "text-sm text-muted-foreground", children: description }) : null] }), children: jsx("div", { className: "flex flex-col gap-3", children: Slot(content) }) }),
	Section: ({ title, content }) => jsx(Section, { title: title || undefined, children: jsx("div", { className: "flex flex-col gap-3", children: Slot(content) }) }),
	Columns: ({ left, right }) => jsxs("div", { className: "grid grid-cols-2 gap-4", children: [jsx("div", { className: "flex flex-col gap-3", children: Slot(left) }), jsx("div", { className: "flex flex-col gap-3", children: Slot(right) })] }),
	// 原型里的弹窗要「摊开画在页面上」：Overlay 是 portal + 焦点陷阱，不适合放进缩略预览，这里用 Section 外观画静态弹窗
	Dialog: ({ title, description, content, confirmLabel, cancelLabel }) => jsx("div", { className: "mx-auto w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-lg", children: jsxs("div", { className: "flex flex-col gap-4", children: [
		jsxs("div", { children: [jsx("div", { className: "text-lg font-semibold", children: title }), description ? jsx("div", { className: "text-sm text-muted-foreground", children: description }) : null] }),
		jsx("div", { className: "flex flex-col gap-3", children: Slot(content) }),
		jsxs("div", { className: "flex justify-end gap-2", children: [jsx(Button, { variant: "default", children: cancelLabel }), jsx(Button, { variant: "primary", children: confirmLabel })] })
	] }) })
};

export const rootClass = "flex min-h-full flex-col gap-4 bg-background p-5 text-foreground";
void Overlay;
export { raw };
