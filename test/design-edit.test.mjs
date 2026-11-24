// 组件工坊 P3：「直接改」（设计方案 §9.4）。
//
// 验收口径：「改个颜色 / 间距 / 一个字」要在画布上直接完成，**不改代码就做不到的不硬改**——
// 动态拼出来的 className、文本来自变量时如实拒绝，让用户改用评论。
import test from "node:test";
import assert from "node:assert/strict";
import { editableClasses, replaceClassName, classFamilyOf, swapOptionsFor } from "../lib/design/edit.js";
import { replaceJsxText } from "../lib/design/compile.js";

const SRC = 'export default function B() { return (<div className="flex flex-col gap-4 p-4 text-sm bg-primary">标题</div>); }';

test("classFamilyOf：把类名归到 token 族（面板按族分组）", () => {
	const cases = { "gap-4": "spacing", "p-4": "spacing", "mt-2": "spacing", "text-sm": "font-size", "bg-primary": "color", "text-muted-foreground": "color", "rounded-lg": "radius", "font-semibold": "font-weight", "max-w-lg": "size", "flex": "layout", "hover:bg-accent": "other" };
	for (const [name, family] of Object.entries(cases)) assert.equal(classFamilyOf(name), family, name);
});

test("editableClasses：列出该元素实际有的类（属性面板数据源）", () => {
	const got = editableClasses(SRC, "e0");
	assert.equal(got.error, undefined, got.error);
	assert.deepEqual(got.byFamily.spacing, ["gap-4", "p-4"]);
	assert.deepEqual(got.byFamily["font-size"], ["text-sm"]);
	assert.deepEqual(got.byFamily.color, ["bg-primary"]);
	assert.deepEqual(got.byFamily.layout, ["flex", "flex-col"]);
});

test("replaceClassName：只换那一个类，不误伤同族的其它类", () => {
	const out = replaceClassName(SRC, "e0", "gap-4", "gap-6");
	assert.equal(out.ok, true, out.reason);
	assert.match(out.source, /className="flex flex-col gap-6 p-4 text-sm bg-primary"/, "p-4 不能被连带改掉");
});

test("replaceClassName：换成已存在的类时去重，不产生两个一样的", () => {
	const src = 'export default function B() { return <div className="gap-4 gap-6">x</div>; }';
	const out = replaceClassName(src, "e0", "gap-4", "gap-6");
	assert.equal(out.ok, true);
	assert.match(out.source, /className="gap-6"/, "去重后只留一个");
});

test("replaceClassName：拒绝的情况都说清原因（不硬改）", () => {
	// className 是表达式
	const expr = 'export default function B(){ const c = "flex"; return <div className={c}>x</div>; }';
	const exprClasses = editableClasses(expr, "e0");
	assert.match(exprClasses.error, /代码算出来的/);
	assert.match(replaceClassName(expr, "e0", "flex", "grid").reason, /代码算出来的/);
	// 类不存在
	assert.match(replaceClassName(SRC, "e0", "gap-99", "gap-6").reason, /没有 gap-99/);
	// 元素不存在
	assert.match(replaceClassName(SRC, "e99", "gap-4", "gap-6").reason, /没找到/);
	// 目标带空格
	assert.match(replaceClassName(SRC, "e0", "gap-4", "gap-6 p-2").reason, /单个类名/);
	// 空参数
	assert.match(replaceClassName(SRC, "e0", "", "gap-6").reason, /都要给/);
});

test("replaceJsxText：纯文本元素能改；表达式文字拒绝", () => {
	const out = replaceJsxText(SRC, "e0", "改过的标题");
	assert.equal(out.ok, true, out.reason);
	assert.match(out.source, />改过的标题</);
	const exprText = replaceJsxText('export default function B(){ const t = 1; return <div>{t}</div>; }', "e0", "x");
	assert.equal(exprText.ok, false);
	assert.match(exprText.reason, /代码算出来的/);
});

test("swapOptionsFor：只给同族的其它已知类（来自组件包 CSS）", () => {
	const cssNames = ["gap-2", "gap-4", "gap-8", "p-4", "mt-2", "text-sm", "bg-primary"];
	// p-4 / mt-2 与 gap-4 同属 spacing 族（都能换），gap-2 / gap-8 也是\n	assert.deepEqual(swapOptionsFor(cssNames, "gap-4"), ["gap-2", "gap-8", "p-4", "mt-2"]);
	assert.deepEqual(swapOptionsFor(cssNames, "text-sm"), []);
	assert.equal(swapOptionsFor(cssNames, "gap-4", 1).length, 1, "limit 生效");
});
