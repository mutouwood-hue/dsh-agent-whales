// 组件工坊 P1：宿主编译与定位表（设计方案 §6.2 / §9.3 / §16）。
//
// P0 结论（文档 §15 第 5 条）：不能用 sucrase 的 `__source`（React 生产版 jsx-dev-runtime 是空桩、
// sucrase 又不给 columnNumber），改用 babel 静态表 + magic-string 插 `data-wsrc`。这组用例守的就是它。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileDesignSource, buildJsxTable, collectImports, checkImports, readModuleExports, replaceAttribute, replaceJsxText, sourceSnippet, designDepsReady } from "../lib/design/compile.js";

const SAMPLE = `import { useState } from "react";
import { Button, DataTable } from "@cds";
import StatCard from "@project/StatCard";

export const examples = [{ label: "同意" }, { label: "退回" }];
export const tweaks = { gap: { type: "number" }, accent: { type: "select" } };

export default function ApprovalTimeline({ label }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-4 p-5">
      <h2 className="text-2xl">{label || "审批时间线"}</h2>
      <Button variant="primary" onClick={() => setOpen(true)}>确定</Button>
      <StatCard title="指标" />
    </div>
  );
}
`;

test("依赖齐全（sucrase / @babel/parser / magic-string），缺任何一个都要能被显式发现", () => {
	assert.equal(designDepsReady(), true, "插件 dependencies 里应自带三个编译依赖");
});

test("编译：TSX → CommonJS，成功时给 code + jsxTable；JSX 上带 data-wsrc（评论钉/改写的锚点）", () => {
	const out = compileDesignSource(SAMPLE, { fileName: "ApprovalTimeline.tsx", hasPack: true, projectNames: ["StatCard"] });
	assert.equal(out.ok, true, JSON.stringify(out.errors));
	assert.match(out.code, /exports\.default/, "应该是 CommonJS 形态（沙箱靠 module/exports/require 执行）");
	assert.equal(out.jsxTable.length, 4, "div / h2 / Button / StatCard 四个元素");
	// data-wsrc 只注入原生 DOM 元素（div / h2）；Button / StatCard 是大写组件，注了会被组件吞掉
	assert.equal((out.code.match(/data-wsrc/g) || []).length, 2, "只有原生元素被注入 data-wsrc");
	assert.deepEqual(out.errors, []);
});

test("编译：production:true（走 jsx-runtime，不是 jsxDEV）——P0 结论，React 生产版 jsxDEV 是空桩", () => {
	const out = compileDesignSource(SAMPLE, { hasPack: true, projectNames: ["StatCard"] });
	assert.match(out.code, /react\/jsx-runtime/, "要 require react/jsx-runtime");
	assert.doesNotMatch(out.code, /jsx-dev-runtime/, "不能依赖 jsx-dev-runtime（生产版里 jsxDEV = void 0）");
	assert.doesNotMatch(out.code, /fileName:/, "不要 __source（只有行号没有列号，且生产 runtime 用不到）");
});

test("导入白名单：只允许 react / @cds / @project/*；相对路径、fs、http、动态 import 一律拒", () => {
	const ok = checkImports('import { useState } from "react";\nimport { Button } from "@cds";\nimport Card from "@project/StatCard";', { hasPack: true, projectNames: ["StatCard"] });
	assert.equal(ok.ok, true, JSON.stringify(ok.errors));

	for (const [source, expectMatch] of [
		['import fs from "fs";', /只能 import/],
		['import x from "./local.tsx";', /只能 import/],
		['import x from "https://cdn.example.com/x.js";', /只能 import/],
		['const m = await import("@cds");', /动态 import/],
		['import x from "lodash";', /只能 import/]
	]) {
		const bad = checkImports(source, { hasPack: true, projectNames: [] });
		assert.equal(bad.ok, false, "应当拒绝：" + source);
		assert.match(bad.errors.map((e) => e.message).join(" | "), expectMatch, source);
	}

	// @cds 在没有 raw 的组件包上要拒（设计方案 §7）
	const noPack = checkImports('import { Button } from "@cds";', { hasPack: false });
	assert.equal(noPack.ok, false);
	assert.match(noPack.errors[0].message, /不支持直接引用组件/);

	// @project 不存在 / 名字不合规
	const missing = checkImports('import Card from "@project/Nope";', { hasPack: true, projectNames: [] });
	assert.equal(missing.ok, false);
	assert.match(missing.errors[0].message, /没有组件 Nope/);
	const badName = checkImports('import Card from "@project/stat_card";', { hasPack: true, projectNames: ["stat_card"] });
	assert.equal(badName.ok, false);
	assert.match(badName.errors[0].message, /PascalCase/);
});

test("导入扫描会把注释里的 import 忽略、把副作用 import 与 export ... from 也算进来", () => {
	const source = [
		'// import evil from "fs";',
		'/* import http from "https://x"; */',
		'import "@font/x";',
		'export { a } from "@project/A";'
	].join("\n");
	const collected = collectImports(source);
	assert.deepEqual(collected.specs.sort(), ["@font/x", "@project/A"], "注释里的不算，副作用 / 再导出要算");
	assert.equal(collectImports('const f = () => import("@cds");').dynamic, true);
});

test("定位表：行号 1-based、列号 0-based；.map() 里的元素标 dynamic（同行多实例要额外带 nth）", () => {
	const source = [
		'export default function B({ items }: { items: string[] }) {',
		"  return (",
		'    <ul className="flex">',
		"      {items.map((item) => (<li key={item}>{item}</li>))}",
		"      {items.length > 0 && <p>有内容</p>}",
		"    </ul>",
		"  );",
		"}"
	].join("\n");
	const table = buildJsxTable(source);
	assert.deepEqual(table.map((row) => [row.wsrc, row.tag, row.line, row.column]), [
		["e0", "ul", 3, 4],
		["e1", "li", 4, 28],
		["e2", "p", 5, 27]
	]);
	assert.deepEqual(table.map((row) => row.dynamic), [false, true, true], ".map() 与条件表达式里的元素要标 dynamic");
	// 第 3 行第 5 列（1-based）确实是以 < 开头的
	assert.equal(source.split("\n")[table[0].line - 1][table[0].column], "<");
});

test("定位表与改写用**同一套编号**（P0 审计发现的错位风险）：replaceAttribute / replaceJsxText 按 wsrc 精确命中", () => {
	const source = [
		'export default function B() {',
		"  return (",
		'    <div className="a">',
		'      <h2>标题</h2>',
		'      <span>x</span>',
		'      <Button variant="primary">确定</Button>',
		"    </div>",
		"  );",
		"}"
	].join("\n");
	const table = buildJsxTable(source);
	const span = table.find((row) => row.tag === "span");
	const button = table.find((row) => row.tag === "Button");
	const changed = replaceAttribute(source, button.wsrc, "variant", "default");
	assert.equal(changed.ok, true, changed.reason);
	assert.match(changed.source, /<Button variant="default">/);
	assert.match(changed.source, /<span>x<\/span>/, "别处的 span 不能被动到");
	const text = replaceJsxText(source, span.wsrc, "改过的字");
	assert.equal(text.ok, true, text.reason);
	assert.match(text.source, /<span>改过的字<\/span>/);
	// 表达式文字不许硬改
	const h2 = table.find((row) => row.tag === "h2");
	const expr = replaceJsxText(source, h2.wsrc, "y");
	assert.equal(expr.ok, true, "h2 是纯文本，能改");
	const dynamicText = replaceJsxText('export default function B(){ const a=1; return <div>{a}</div>; }', "e1", "z");
	assert.equal(dynamicText.ok, false, "表达式文字不能直接改");
});

test("改写：属性值是表达式时拒绝（不硬改 className={cls}）", () => {
	const source = 'export default function B() { const cls = "a"; return <div className={cls}>x</div>; }';
	const table = buildJsxTable(source);
	const div = table.find((row) => row.tag === "div");
	const out = replaceAttribute(source, div.wsrc, "className", "b");
	assert.equal(out.ok, false);
	assert.match(out.reason, /代码算出来的/);
});

test("编译错误：给行列 + 源码摘录，且**不返回 code**（宿主据此不落盘）", () => {
	const out = compileDesignSource('export default function B() {\n  return <div><span></div>;\n}', {});
	assert.equal(out.ok, false);
	assert.equal(out.code, "", "编译失败不能有产物（否则宿主会写半个文件）");
	assert.equal(out.errors.length, 1);
	assert.equal(out.errors[0].kind, "parse");
	assert.ok(Number.isFinite(out.errors[0].line), "要有行号");
	assert.match(out.errors[0].message, /第 \d+ 行/);
});

test("编译错误：sucrase 阶段的语法错也要带行列（kind=compile）", () => {
	// babel 能接受、sucrase 拒绝的写法很少；这里用明显不合法的 TS 语法触发其中一条路径
	const out = compileDesignSource("export default function B() { return <div />; }\nconst x: = 1;", {});
	assert.equal(out.ok, false);
	assert.ok(["parse", "compile"].includes(out.errors[0].kind), "两类错误都要被转成可读信息，实际 " + out.errors[0].kind);
	assert.match(out.errors[0].message, /第 \d+ 行/);
});

test("空源码 / 缺 import 目标 / 缺依赖都给明确错误", () => {
	assert.match(compileDesignSource("", {}).errors[0].message, /源码是空的/);
	const missing = compileDesignSource('import Card from "@project/Nope";\nexport default function B(){ return <Card/>; }', { hasPack: true, projectNames: [] });
	assert.equal(missing.ok, false);
	assert.match(missing.errors[0].message, /没有组件 Nope/);
});

test("readModuleExports：抽 export const examples / tweaks 的字面量；表达式写法要如实说解不出", () => {
	const got = readModuleExports(SAMPLE);
	assert.equal(got.examples.ok, true);
	assert.equal(got.examples.count, 2);
	assert.deepEqual(got.examples.values, [{ label: "同意" }, { label: "退回" }]);
	assert.equal(got.tweaks.ok, true);
	assert.deepEqual(got.tweaks.keys, ["gap", "accent"]);

	const notLiteral = readModuleExports('const preset = [{ a: 1 }];\nexport const examples = preset;');
	assert.equal(notLiteral.examples.ok, false);
	assert.match(notLiteral.examples.reason, /字面量/);
	assert.equal(notLiteral.tweaks.ok, false, "没写 tweaks 时 ok=false，调用方按「没有」处理");
});

test("sourceSnippet：按行列取源码片段（评论钉发给 agent 的「这里是哪段代码」）", () => {
	const table = buildJsxTable(SAMPLE);
	const div = table.find((row) => row.tag === "div");
	const snippet = sourceSnippet(SAMPLE, div.line, div.column);
	assert.match(snippet, /^<div className="flex flex-col gap-4 p-5">/);
	assert.equal(sourceSnippet(SAMPLE, 999, 0), "", "行号越界返回空串，不抛");
	assert.ok(sourceSnippet("a".repeat(500), 1, 0).length <= 201, "片段要有上限");
});


test("P0 审计 B1：Fragment（<>…</>）**不注入** data-wsrc —— 注进文本子节点会渲染出可见垃圾", () => {
	const source = 'export default function B() { return <div><> <i>a</i><b>b</b> </></div>; }';
	const out = compileDesignSource(source, { hasPack: true, projectNames: [] });
	assert.equal(out.ok, true, JSON.stringify(out.errors));
	// 编译产物里绝不能出现「把 data-wsrc 当文本」的形状
	assert.doesNotMatch(out.code, /children:\s*\[\s*"\s*data-wsrc/, "data-wsrc 不能落进 children 文本");
	assert.equal((out.code.match(/data-wsrc/g) || []).length, 3, "div / i / b 三个原生元素注入，Fragment 不注入");
	assert.doesNotMatch(out.code, /" data-wsrc/, "产物里不能出现带前导空格的字符串（那正是注错的形态）");
	const fragment = out.jsxTable.find((row) => row.tag === "Fragment");
	assert.ok(fragment, "Fragment 仍要在表里（编号空间与改写一致）");
	// 用真 React 渲染一次：页面上不能出现 data-wsrc 文本
	// （React 在 tools/flow-chunk 里，插件本身不依赖 React；与 proto-chunk.test.mjs 同口径）
	const flowRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "flow-chunk", "package.json"));
	const React = flowRequire("react");
	const { renderToStaticMarkup } = flowRequire("react-dom/server");
	const mod = { exports: {} };
	const registry = { react: React, "react/jsx-runtime": flowRequire("react/jsx-runtime") };
	new Function("module", "exports", "require", out.code)(mod, mod.exports, (spec) => registry[spec]);
	const html = renderToStaticMarkup(React.createElement(mod.exports.default));
	// data-wsrc 应该是**属性**（出现在元素的属性位），而不是可见文本
	assert.match(html, /<div data-wsrc="e0">/, "data-wsrc 要作为属性出现");
	assert.doesNotMatch(html, />\s*data-wsrc=/, "data-wsrc 不能变成可见文本");
	assert.doesNotMatch(html, /&quot;e\d/, "引号被转义就说明它进了文本节点");
});
test("P0 审计：自闭合原生元素要注入，自闭合组件不注入", () => {
	const source = 'import { IconButton } from "@cds";\nexport default function B() { return <div><img alt="x" /><IconButton label="y" /><br /></div>; }';
	const out = compileDesignSource(source, { hasPack: true, projectNames: [] });
	assert.equal(out.ok, true, JSON.stringify(out.errors));
	assert.match(out.code, /'img'/, "img 在产物里");
	assert.equal((out.code.match(/data-wsrc/g) || []).length, 3, "div / img / br 三个原生元素都注入");
});

test("P0 审计 I1：大写组件不注入 data-wsrc（CDS 里 274/282 个组件不透传 props，注入会静默丢失）", () => {
	const source = 'import { Button, Tag } from "@cds";\nexport default function B() { return (<div><Button variant="primary">x</Button><Tag tone="brand">y</Tag></div>); }';
	const out = compileDesignSource(source, { hasPack: true, projectNames: [] });
	assert.equal(out.ok, true, JSON.stringify(out.errors));
	assert.doesNotMatch(out.code, /Button[^)]*data-wsrc|Tag[^)]*data-wsrc/, "组件上不能出现 data-wsrc");
	assert.match(out.code, /'div', \{ 'data-wsrc': "e0"/, "但外层原生 div 要注入");
	assert.equal(out.jsxTable.filter((row) => /^[A-Z]/.test(row.tag)).length, 2, "组件仍在表里（编号一致）");
});

test("P0 审计 I2：可选链 rows?.map() 也要标 dynamic（babel 里是 OptionalCallExpression）", () => {
	const source = [
		"export default function B({ rows }: { rows?: { id: string }[] }) {",
		"  return (<ul>{rows?.map((row) => (<li key={row.id}>{row.id}</li>))}</ul>);",
		"}"
	].join("\n");
	const table = buildJsxTable(source);
	const li = table.find((row) => row.tag === "li");
	assert.equal(li.dynamic, true, "可选链的 map 也要算动态（同行多实例）");
	const many = 'export default function B({ rows }: { rows: string[] }) { return (<ul>{rows.flatMap((r) => (<li>{r}</li>))}</ul>); }';
	assert.equal(buildJsxTable(many).find((row) => row.tag === "li").dynamic, true, "flatMap 同样算动态");
});

test("P0 审计 B5：react/jsx-dev-runtime 不放行（production:true 用不到，沙箱也不提供）", () => {
	const out = checkImports('import { jsxDEV } from "react/jsx-dev-runtime";', { hasPack: true });
	assert.equal(out.ok, false, "jsx-dev-runtime 不能进白名单");
	assert.match(out.errors[0].message, /只能 import/);
});

test("P1 审计 B3 回归：projectId 校验——'.' / '..' / 含斜杠一律拒（designProjectDir 与 designEntityDir 同口径）", async () => {
	const { designProjectDir } = await import("../lib/design/store.js");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "aw-design-projdir-"));
	try {
		for (const bad of [".", "..", "../etc", "a/b", "", "..\\x", "x".repeat(70)]) {
			assert.throws(() => designProjectDir(root, bad), /非法 projectId|路径越界/, "projectId " + JSON.stringify(bad));
		}
		assert.ok(designProjectDir(root, "proj-1").includes("proj-1"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});
