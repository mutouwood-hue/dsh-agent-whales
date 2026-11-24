// 组件工坊：样式提醒（设计方案 §6.3，P0 审计要求补齐的口径）。
//
// 为什么要有这组用例：组件包的 CSS 是预编译的，agent 用了不存在的类名**不会报错、只会静默失效**。
// P0 实测 CDS 3.0.8 确实缺 `gap-7` / `mt-7` / `col-span-2` / `max-w-lg` / `grid-cols-[1fr_2fr]`。
import test from "node:test";
import assert from "node:assert/strict";
import { classNamesInCss, classNamesInSource, styleWarnings } from "../lib/design/style.js";

const CSS = `
.flex{display:flex}
.flex-col{flex-direction:column}
.gap-4{gap:1rem}
.gap-8{gap:2rem}
.p-5{padding:1.25rem}
.text-sm{font-size:.875rem}
.hover\\:bg-accent:hover{background:var(--accent)}
.max-w-\\[10px\\]{max-width:10px}
`;

test("类名提取：从 CSS 里拿到类名（含转义形式的 Tailwind 变体 / 任意值）", () => {
	const names = classNamesInCss(CSS);
	assert.equal(names.has("flex"), true);
	assert.equal(names.has("gap-4"), true);
	assert.equal(names.has("hover:bg-accent"), true, "转义冒号要还原");
	assert.equal(names.has("max-w-[10px]"), true, "任意值里的转义方括号要还原");
	assert.equal(names.has("gap-7"), false);
});

test("类名提取：只认 className 的字符串字面量，表达式不判（判不准就别乱报）", () => {
	const source = [
		'<div className="flex gap-4">a</div>',
		"<div className='gap-8'>b</div>",
		'<div className={"p-5 text-sm"}>c</div>',
		'<div className={cls}>d</div>',
		'<div className={`x ${y}`}>e</div>'
	].join("\n");
	const names = classNamesInSource(source);
	assert.deepEqual([...names].sort(), ["flex", "gap-4", "gap-8", "p-5", "text-sm"]);
});

test("styleWarnings：命中「组件包 CSS 里没有的类」，并把上限控制在 20 个", () => {
	const source = '<div className="flex gap-4 gap-7 p-5 max-w-lg col-span-2 text-sm">x</div>';
	const warned = styleWarnings(source, CSS);
	assert.deepEqual(warned.missing, ["gap-7", "max-w-lg", "col-span-2"], "只报真的缺的");
	assert.equal(warned.checked, 7, "flex/gap-4/gap-7/p-5/max-w-lg/col-span-2/text-sm");

	const many = '<div className={' + JSON.stringify(Array.from({ length: 40 }, (_, i) => "nope-" + i).join(" ")) + "}>x</div>";
	assert.equal(styleWarnings(many, CSS).missing.length, 20, "最多报 20 个，别刷屏");
});

test("styleWarnings：全都命中时不报；没有 className 时不报；CSS 为空时全都算缺", () => {
	assert.deepEqual(styleWarnings('<div className="flex p-5 text-sm">x</div>', CSS).missing, []);
	assert.deepEqual(styleWarnings("<div>x</div>", CSS), { missing: [], checked: 0 });
	assert.deepEqual(styleWarnings('<div className="flex">x</div>', "").missing, ["flex"], "没有样式表时如实说全都缺");
});

test("styleWarnings：extraKnown 可以把宿主侧补充生成的类算作已知", () => {
	const source = '<div className="gap-7">x</div>';
	assert.deepEqual(styleWarnings(source, CSS).missing, ["gap-7"]);
	assert.deepEqual(styleWarnings(source, CSS, { extraKnown: ["gap-7"] }).missing, [], "宿主补过 CSS 的类不该再报");
});
