/**
 * 内置组件包：shadcn/ui 风格（new-york · zinc）。
 *
 * 说明（如实）：shadcn/ui 本身是「把源码拷进项目」的组件集（MIT），交互部分依赖 Radix。原型帧只要「长得对、
 * 字段可改」，不要真交互，所以这里按 shadcn/ui 的 Tailwind 类名与 CSS 变量复刻外观，不带 Radix。
 * 组件只用 props 里的通用词表字段（见 lib/prototype-vocab.js）；slot 字段拿到的是组件，渲染成 <props.content />。
 */
import { jsx, jsxs } from "react/jsx-runtime";

const cn = (...parts) => parts.filter(Boolean).join(" ");
const list = (value) => String(value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
const Slot = (S) => (typeof S === "function" ? jsx(S, {}) : null);

const BUTTON = {
	primary: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
	secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
	outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
	ghost: "hover:bg-accent hover:text-accent-foreground",
	destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
};
const BADGE = {
	default: "border-transparent bg-primary text-primary-foreground shadow",
	secondary: "border-transparent bg-secondary text-secondary-foreground",
	outline: "text-foreground",
	destructive: "border-transparent bg-destructive text-destructive-foreground shadow"
};
const ALERT = {
	info: "bg-background text-foreground",
	success: "border-emerald-500/50 text-emerald-700 bg-emerald-50",
	warning: "border-amber-500/50 text-amber-800 bg-amber-50",
	error: "border-destructive/50 text-destructive bg-red-50"
};
const field = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const label = "text-sm font-medium leading-none";

export const shadcnComponents = {
	Heading: ({ text, level }) => {
		const size = level === "1" ? "text-3xl" : level === "3" ? "text-lg" : "text-2xl";
		return jsx("h" + (level || "2"), { className: cn("font-semibold tracking-tight text-foreground", size), children: text });
	},
	Text: ({ text, tone }) => jsx("p", { className: cn("text-sm leading-7", tone === "muted" ? "text-muted-foreground" : "text-foreground"), children: text }),
	Button: ({ label: text, variant }) => jsx("button", { type: "button", className: cn("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors", BUTTON[variant] || BUTTON.primary), children: text }),
	Input: ({ label: text, placeholder }) => jsxs("div", { className: "grid w-full gap-1.5", children: [text ? jsx("label", { className: label, children: text }) : null, jsx("input", { className: field, placeholder })] }),
	Textarea: ({ label: text, placeholder }) => jsxs("div", { className: "grid w-full gap-1.5", children: [text ? jsx("label", { className: label, children: text }) : null, jsx("textarea", { className: cn(field, "min-h-[72px] h-auto py-2"), placeholder })] }),
	Select: ({ label: text, options }) => jsxs("div", { className: "grid w-full gap-1.5", children: [
		text ? jsx("label", { className: label, children: text }) : null,
		jsxs("div", { className: "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm", children: [jsx("span", { children: list(options)[0] || "请选择" }), jsx("span", { className: "text-muted-foreground", children: "▾" })] })
	] }),
	Checkbox: ({ label: text, checked }) => jsxs("label", { className: "flex items-center gap-2 text-sm", children: [jsx("span", { className: cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary text-[10px] shadow", checked === "true" ? "bg-primary text-primary-foreground" : ""), children: checked === "true" ? "✓" : "" }), text] }),
	Switch: ({ label: text, checked }) => jsxs("label", { className: "flex items-center gap-2 text-sm", children: [
		jsx("span", { className: cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm", checked === "true" ? "bg-primary" : "bg-input"), children: jsx("span", { className: cn("block h-4 w-4 rounded-full bg-background shadow-lg transition-transform", checked === "true" ? "translate-x-4" : "translate-x-0") }) }),
		text
	] }),
	Badge: ({ text, variant }) => jsx("span", { className: cn("inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold", BADGE[variant] || BADGE.default), children: text }),
	Alert: ({ title, description, variant }) => jsxs("div", { role: "alert", className: cn("relative w-full rounded-lg border px-4 py-3 text-sm", ALERT[variant] || ALERT.info), children: [jsx("h5", { className: "mb-1 font-medium leading-none tracking-tight", children: title }), description ? jsx("div", { className: "text-sm opacity-90", children: description }) : null] }),
	Upload: ({ label: text, hint }) => jsxs("div", { className: "flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-muted/40 px-4 py-6 text-center", children: [jsx("div", { className: "text-sm font-medium", children: text }), jsx("div", { className: "text-xs text-muted-foreground", children: hint })] }),
	Table: ({ columns, rows }) => {
		const cols = list(columns);
		const count = Math.max(0, Math.min(20, Number(rows) || 0));
		return jsx("div", { className: "w-full overflow-auto rounded-md border", children: jsxs("table", { className: "w-full caption-bottom text-sm", children: [
			jsx("thead", { children: jsx("tr", { className: "border-b", children: cols.map((c) => jsx("th", { className: "h-10 px-3 text-left align-middle font-medium text-muted-foreground", children: c }, c)) }) }),
			jsx("tbody", { children: Array.from({ length: count }, (_, r) => jsx("tr", { className: "border-b last:border-0", children: cols.map((c, i) => jsx("td", { className: "p-3 align-middle", children: i === 0 ? c + " " + (r + 1) : jsx("span", { className: "inline-block h-2.5 w-16 rounded bg-muted" }) }, c)) }, r)) })
		] }) });
	},
	Tabs: ({ tabs, active }) => jsx("div", { className: "inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground", children: list(tabs).map((tab, i) => jsx("span", { className: cn("inline-flex items-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium", i === (Number(active) || 0) ? "bg-background text-foreground shadow" : ""), children: tab }, tab)) }),
	Stat: ({ label: text, value }) => jsxs("div", { className: "rounded-xl border bg-card p-4 text-card-foreground shadow", children: [jsx("div", { className: "text-sm text-muted-foreground", children: text }), jsx("div", { className: "mt-1 text-2xl font-bold", children: value })] }),
	Navbar: ({ brand, links }) => jsxs("div", { className: "flex h-12 w-full items-center gap-6 border-b px-4", children: [jsx("span", { className: "font-semibold", children: brand }), jsx("nav", { className: "flex gap-4 text-sm text-muted-foreground", children: list(links).map((l, i) => jsx("span", { className: i === 0 ? "text-foreground" : "", children: l }, l)) })] }),
	Sidebar: ({ items, active }) => jsx("div", { className: "flex w-48 flex-col gap-1 border-r p-2", children: list(items).map((item, i) => jsx("span", { className: cn("rounded-md px-3 py-2 text-sm", i === (Number(active) || 0) ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"), children: item }, item)) }),
	Divider: () => jsx("div", { className: "my-2 h-px w-full shrink-0 bg-border" }),
	Image: ({ alt, height }) => jsx("div", { className: "flex w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground", style: { height: Math.max(40, Math.min(600, Number(height) || 120)) }, children: alt || "图片" }),
	Card: ({ title, description, content }) => jsxs("div", { className: "rounded-xl border bg-card text-card-foreground shadow", children: [
		jsxs("div", { className: "flex flex-col space-y-1.5 p-5", children: [jsx("h3", { className: "font-semibold leading-none tracking-tight", children: title }), description ? jsx("p", { className: "text-sm text-muted-foreground", children: description }) : null] }),
		jsx("div", { className: "flex flex-col gap-3 p-5 pt-0", children: Slot(content) })
	] }),
	Section: ({ title, content }) => jsxs("section", { className: "flex w-full flex-col gap-3", children: [title ? jsx("h3", { className: "text-base font-semibold", children: title }) : null, jsx("div", { className: "flex flex-col gap-3", children: Slot(content) })] }),
	Columns: ({ left, right }) => jsxs("div", { className: "grid w-full grid-cols-2 gap-4", children: [jsx("div", { className: "flex flex-col gap-3", children: Slot(left) }), jsx("div", { className: "flex flex-col gap-3", children: Slot(right) })] }),
	Dialog: ({ title, description, content, confirmLabel, cancelLabel }) => jsxs("div", { className: "mx-auto grid w-full max-w-lg gap-4 rounded-lg border bg-background p-6 shadow-lg", children: [
		jsxs("div", { className: "flex flex-col space-y-1.5", children: [jsx("h2", { className: "text-lg font-semibold leading-none tracking-tight", children: title }), description ? jsx("p", { className: "text-sm text-muted-foreground", children: description }) : null] }),
		jsx("div", { className: "flex flex-col gap-3", children: Slot(content) }),
		jsxs("div", { className: "flex justify-end gap-2", children: [jsx("button", { type: "button", className: cn("inline-flex h-9 items-center rounded-md px-4 text-sm font-medium", BUTTON.outline), children: cancelLabel }), jsx("button", { type: "button", className: cn("inline-flex h-9 items-center rounded-md px-4 text-sm font-medium", BUTTON.primary), children: confirmLabel })] })
	] })
};

/** 页面根：内边距 + 纵向间距（所有组件包共用；本地包可以在 manifest 里给 rootClass 覆盖）。 */
export const shadcnRootClass = "flex min-h-full flex-col gap-4 bg-background p-5 text-foreground antialiased";

/**
 * 组件工坊（设计方案 §7）：内置包的**原始组件**（`import { Button } from "@cds"` 解析到这里）。
 *
 * 为什么要单独一份：词表里那 22 个是「按 Puck 字段渲染」的适配层（`shadcnComponents`），字段被词表钉死；
 * agent 写 TSX 时需要能像用真组件库那样传 children / className / onClick / variant。
 * 这里按 shadcn/ui（MIT）的类名与 CSS 变量给出**带 children 与常用 props** 的版本，保证没有 CDS 的机器也能用。
 * 刻意保持轻量：不带 Radix（不做真弹层 / 键盘焦点管理），只是个够用的默认组件包。
 */
const buttonVariants = {
	default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
	primary: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
	secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
	outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
	ghost: "hover:bg-accent hover:text-accent-foreground",
	destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
};
const cardCls = "rounded-lg border bg-background text-foreground shadow-sm";
const Card = ({ className, children, header, footer, ...rest }) => jsxs("div", { className: cn(cardCls, className), ...rest, children: [
	header ? jsx("div", { className: "flex flex-col gap-1 p-5 pb-2", children: header }) : null,
	jsx("div", { className: "p-5", children }),
	footer ? jsx("div", { className: "flex items-center p-5 pt-0", children: footer }) : null
] });

export const shadcnRaw = {
	Button: ({ variant = "default", className, children, ...rest }) => jsx("button", { type: "button", className: cn("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors", buttonVariants[variant] || buttonVariants.default, className), ...rest, children }),
	Input: ({ className, ...rest }) => jsx("input", { className: cn(field, className), ...rest }),
	Textarea: ({ className, rows = 3, ...rest }) => jsx("textarea", { rows, className: cn(field, "min-h-[72px] h-auto py-2", className), ...rest }),
	Select: ({ options, className, ...rest }) => {
		const items = (Array.isArray(options) ? options : []).map((option) => {
			const value = option && option.value !== undefined ? option.value : option;
			const text = option && option.label !== undefined ? option.label : String(value);
			return { value: String(value), text: String(text) };
		});
		return jsx("select", { className: cn(field, className), ...rest, children: items.map((item) => jsx("option", { value: item.value, children: item.text }, item.value)) });
	},
	Label: ({ className, children, ...rest }) => jsx("label", { className: cn(label, className), ...rest, children }),
	Badge: ({ variant = "default", className, children, ...rest }) => jsx("span", { className: cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", BADGE[variant] || BADGE.default, className), ...rest, children }),
	Card: Card,
	CardHeader: ({ className, children }) => jsx("div", { className: cn("flex flex-col gap-1 p-5 pb-2", className), children }),
	CardTitle: ({ className, children }) => jsx("div", { className: cn("text-lg font-semibold leading-none tracking-tight", className), children }),
	CardDescription: ({ className, children }) => jsx("div", { className: cn("text-sm text-muted-foreground", className), children }),
	CardContent: ({ className, children }) => jsx("div", { className: cn("p-5", className), children }),
	Separator: ({ className }) => jsx("hr", { className: cn("my-2 border-border", className) }),
	Alert: ({ tone = "info", title, children, className }) => jsxs("div", { role: "alert", className: cn("relative w-full rounded-lg border p-4 text-sm", ALERT[tone] || ALERT.info, className), children: [
		title ? jsx("div", { className: "mb-1 font-medium", children: title }) : null,
		children ? jsx("div", { children }) : null
	] }),
	Table: ({ columns, rows, rowKey }) => jsx("div", { className: "w-full overflow-auto rounded-lg border", children: jsxs("table", { className: "w-full caption-bottom text-sm", children: [
		jsx("thead", { children: jsx("tr", { className: "border-b bg-muted/50", children: (columns || []).map((col) => jsx("th", { className: "h-10 px-3 text-left align-middle font-medium text-muted-foreground", children: col.header }, col.key)) }) }),
		jsx("tbody", { children: (rows || []).map((row, index) => jsx("tr", { className: "border-b transition-colors hover:bg-muted/50", children: (columns || []).map((col) => jsx("td", { className: "p-3 align-middle", children: typeof col.render === "function" ? col.render(row) : String(row[col.key] === undefined ? "" : row[col.key]) }, col.key)) }, typeof rowKey === "function" ? rowKey(row, index) : index)) })
	] }) }),
	Tabs: ({ items, value, onChange }) => jsxs("div", { className: "flex flex-col gap-3", children: [
		jsx("div", { className: "flex gap-1 border-b", children: (items || []).map((item) => jsx("button", { type: "button", onClick: () => { if (typeof onChange === "function") onChange(item.key); }, className: cn("px-3 py-2 text-sm font-medium", item.key === value ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"), children: item.label }, item.key)) }),
		jsx("div", { children: (items || []).filter((item) => item.key === value).map((item) => jsx("div", { children: item.content }, item.key)) })
	] }),
	Switch: ({ checked, onChange, className }) => jsx("button", { type: "button", role: "switch", "aria-checked": Boolean(checked), onClick: () => { if (typeof onChange === "function") onChange(!checked); }, className: cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors", checked ? "bg-primary" : "bg-input", className), children: jsx("span", { className: cn("block size-4 rounded-full bg-background shadow transition-transform", checked ? "translate-x-4" : "translate-x-0.5") }) }),
	Checkbox: ({ checked, onChange, className, ...rest }) => jsx("input", { type: "checkbox", checked: Boolean(checked), onChange: (event) => { if (typeof onChange === "function") onChange(event.target.checked); }, className: cn("size-4 rounded border-input accent-primary", className), ...rest }),
	EmptyState: ({ title = "还没有数据", hint, className }) => jsxs("div", { className: cn("flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8 text-center", className), children: [
		jsx("div", { className: "text-sm font-medium text-foreground", children: title }),
		hint ? jsx("div", { className: "text-xs text-muted-foreground", children: hint }) : null
	] }),
	Progress: ({ value = 0, className }) => jsx("div", { className: cn("h-2 w-full overflow-hidden rounded-full bg-muted", className), children: jsx("div", { className: "h-full bg-primary transition-all", style: { width: Math.max(0, Math.min(100, Number(value) || 0)) + "%" } }) }),
	Avatar: ({ name = "", className }) => jsx("span", { className: cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground", className), children: String(name).trim().slice(0, 1) || "?" }),
	Title: ({ level = 2, className, children }) => jsx("h" + (Number(level) >= 1 && Number(level) <= 6 ? level : 2), { className: cn("font-semibold tracking-tight", className), children }),
	Text: ({ tone = "default", className, children }) => jsx("p", { className: cn("text-sm leading-7", tone === "muted" ? "text-muted-foreground" : "text-foreground", className), children }),
	Stack: ({ gap = 3, className, children }) => jsx("div", { className: cn("flex flex-col", gap === 1 ? "gap-1" : gap === 2 ? "gap-2" : gap === 4 ? "gap-4" : "gap-3", className), children }),
	Row: ({ gap = 2, className, children }) => jsx("div", { className: cn("flex flex-row items-center", gap === 1 ? "gap-1" : gap === 3 ? "gap-3" : gap === 4 ? "gap-4" : "gap-2", className), children })
};

