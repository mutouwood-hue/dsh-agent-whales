/**
 * 视图 chunk 行为测试（真 React 18 + react-dom/server）：
 *   - ViewNode：各状态的外壳标签、纯展示 / 等作答 / 已作答 / 已作废；图表、表格、公式按真实数据渲染；
 *   - SideNode：背景来源标签、问答气泡、思考中 / 失败 / 取消三种状态、没连线时的引导；
 *   - MiniMarkdown：不渲染 raw HTML（XSS 面），只认列表 / 围栏 / 行内标记；
 *   - 主题：节点带 data-theme，画布 token 覆盖 --dv-*。
 * React 取自 tools/flow-chunk/node_modules（构建依赖）；没装就跳过并说明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pluginDir } from "./harness.mjs";

const toolDir = join(pluginDir, "tools", "flow-chunk");
const have = existsSync(join(toolDir, "node_modules", "react-dom", "server.js")) && existsSync(join(pluginDir, "lib", "client.view.js"));
const req = createRequire(join(toolDir, "package.json"));
const skip = have ? false : "tools/flow-chunk 没装依赖，或 lib/client.view.js 还没构建（node tools/flow-chunk/build-view.mjs）";

function loadView() {
	const React = req("react");
	const ReactDOM = req("react-dom");
	const jsx = req("react/jsx-runtime");
	let registration = null;
	new Function("window", readFileSync(join(pluginDir, "lib", "client.view.js"), "utf8"))({ __ModuleLoader__: { load(reg) { registration = reg; } } });
	assert.equal(registration.chunk, "client.view.js");
	assert.equal(registration.id, "dsh-agent-whales");
	const lib = registration.factory((spec) => (spec === "react" ? React : spec === "react-dom" ? ReactDOM : jsx));
	const server = req("react-dom/server");
	const render = (Component, data) => server.renderToStaticMarkup(React.createElement(Component, { data }));
	return { lib, render };
}

const CHART = { type: "stack", children: [
	{ type: "text", text: "各端耗时" },
	{ type: "chart", kind: "bar", categories: ["前端", "后端"], series: [{ name: "天", values: [3, 5] }], caption: "工期对比" },
	{ type: "metric", label: "合计", value: { "=": "3 + 5" } }
] };
const PICK = { type: "options", id: "pick", options: [{ label: "方案甲", description: "快" }, { label: "方案乙" }] };

test("视图 chunk：导出节点与样式；样式跟画布 token 走", { skip }, () => {
	const { lib } = loadView();
	assert.equal(typeof lib.ViewNode, "function");
	assert.equal(typeof lib.SideNode, "function");
	assert.equal(typeof lib.MiniMarkdown, "function");
	assert.ok(lib.VIEW_CSS.indexOf(".daw-view-node,.daw-side-node{--dv-ink:var(--daw-text") >= 0, "--dv-* 要被画布 --daw-* 覆盖");
	assert.ok(lib.VIEW_CSS.indexOf(".dv-q{") >= 0, "带 deep-view 自己的卡片样式");
});

test("ViewNode：纯展示卡渲染图表 / 文本 / 公式算出的指标，带「展示」标签与来源", { skip }, () => {
	const { lib, render } = loadView();
	const html = render(lib.ViewNode, { id: "v1", title: "工期", view: CHART, status: "shown", source: "主对话" });
	for (const text of ["工期", "展示", "← 主对话", "各端耗时", "工期对比", "合计"]) assert.ok(html.indexOf(text) >= 0, "缺：" + text);
	assert.ok(/>8</.test(html), "公式 3 + 5 要在页面里算成 8");
	assert.ok(html.indexOf("<svg") >= 0, "图表是 svg");
	assert.ok(html.indexOf("dv-q-submit") < 0, "纯展示卡没有提交按钮");
});

test("ViewNode：等作答的卡显示选项、提交与关闭；已作答的卡只读且不再有提交", { skip }, () => {
	const { lib, render } = loadView();
	const pending = render(lib.ViewNode, { id: "v2", title: "选方案", view: PICK, status: "pending", onAnswer() {}, onDismiss() {} });
	for (const text of ["等你作答", "方案甲", "方案乙", "关闭卡片"]) assert.ok(pending.indexOf(text) >= 0, "缺：" + text);
	const done = render(lib.ViewNode, { id: "v2", title: "选方案", view: PICK, status: "answered", answer: { action: "pick", values: { selected: ["方案乙"] } } });
	assert.ok(done.indexOf("已作答") >= 0 && done.indexOf("方案乙") >= 0);
	assert.ok(done.indexOf("关闭卡片") < 0, "已作答不再能关闭");
	assert.ok(!/<button[^>]*dv-q-opt[^>]*>/.test(done.replace(/disabled/g, "")) || done.indexOf("disabled") >= 0, "已作答的选项是只读的");
});

test("ViewNode：已作废 / 已关闭灰显且没有任何作答入口；内容丢失时给提示不崩", { skip }, () => {
	const { lib, render } = loadView();
	for (const status of ["expired", "dismissed"]) {
		const html = render(lib.ViewNode, { id: "v3", title: "旧卡", view: PICK, status, onAnswer() {} });
		assert.ok(html.indexOf("daw-view-closed") >= 0, status + " 要灰显");
		assert.ok(html.indexOf(status === "expired" ? "已作废" : "已关闭") >= 0);
		assert.ok(html.indexOf("关闭卡片") < 0);
	}
	assert.ok(render(lib.ViewNode, { id: "v4", status: "shown" }).indexOf("卡片内容丢失") >= 0);
});

test("ViewNode：暗色主题带 data-theme=dark；错误信息显示在卡底", { skip }, () => {
	const { lib, render } = loadView();
	const html = render(lib.ViewNode, { id: "v5", view: CHART, status: "shown", theme: "dark", error: "投递失败：会话不在线" });
	assert.ok(html.indexOf('data-theme="dark"') >= 0);
	assert.ok(html.indexOf("投递失败：会话不在线") >= 0);
});

test("SideNode：显示背景来源标签、问答；没连线时给引导且发送被禁用", { skip }, () => {
	const { lib, render } = loadView();
	const empty = render(lib.SideNode, { title: "问问", sources: [], entries: [] });
	assert.ok(empty.indexOf("还没连到对话") >= 0);
	assert.ok(/<button[^>]*disabled[^>]*>发送</.test(empty), "没连线不能发");
	const html = render(lib.SideNode, {
		title: "问问", sources: [{ id: "s1", title: "后端" }, { id: "s2", title: "前端" }],
		entries: [{ id: "e1", question: "后端做完了吗", answer: "**做完了**，剩 `lint`。", status: "done" }]
	});
	for (const text of ["后端", "前端", "后端做完了吗", "只读 · 不动原对话"]) assert.ok(html.indexOf(text) >= 0, "缺：" + text);
	assert.ok(html.indexOf("<strong>做完了</strong>") >= 0 && html.indexOf("<code>lint</code>") >= 0, "答案里的 Markdown 要渲染");
});

test("SideNode：答题中显示「思考中」与取消；答题中不能再发；失败写明原因；已取消有标记", { skip }, () => {
	const { lib, render } = loadView();
	const base = { title: "侧", sources: [{ id: "s1", title: "后端" }] };
	const thinking = render(lib.SideNode, { ...base, entries: [{ id: "e1", question: "慢问题", status: "answering" }], onCancel() {} });
	assert.ok(thinking.indexOf("思考中") >= 0 && thinking.indexOf("取消") >= 0);
	assert.ok(/<button[^>]*disabled[^>]*>发送</.test(thinking), "答题中不能再发");
	const failed = render(lib.SideNode, { ...base, entries: [{ id: "e2", question: "问", status: "failed", error: "上游 429" }] });
	assert.ok(failed.indexOf("没答成：上游 429") >= 0);
	const cancelled = render(lib.SideNode, { ...base, entries: [{ id: "e3", question: "问", status: "cancelled" }] });
	assert.ok(cancelled.indexOf("已取消") >= 0);
});

test("sideCanSend：没连线 / 空草稿 / 正在发 / 上一问还在答，都不能发；其余能发", { skip }, () => {
	const { lib } = loadView();
	const ok = { sending: false, entries: [{ status: "done" }], sources: [{ id: "a" }], draft: "问" };
	assert.equal(lib.sideCanSend(ok), true);
	assert.equal(lib.sideCanSend({ ...ok, sources: [] }), false, "没连线");
	assert.equal(lib.sideCanSend({ ...ok, draft: "  \n" }), false, "空草稿");
	assert.equal(lib.sideCanSend({ ...ok, sending: true }), false, "正在发");
	assert.equal(lib.sideCanSend({ ...ok, entries: [{ status: "done" }, { status: "answering" }] }), false, "上一问还在答");
	assert.equal(lib.sideCanSend({ ...ok, entries: [{ status: "failed" }, { status: "cancelled" }] }), true, "失败 / 取消后可以再问");
});

test("MiniMarkdown：不渲染 raw HTML / 链接 / 图片；列表、围栏代码、行内标记正常", { skip }, () => {
	const { lib } = loadView();
	const React = req("react");
	const server = req("react-dom/server");
	const md = (text) => server.renderToStaticMarkup(React.createElement(lib.MiniMarkdown, { text }));
	const evil = md("<img src=x onerror=alert(1)> <script>alert(1)</script> [点我](javascript:alert(1)) ![图](http://x/y.png)");
	assert.ok(evil.indexOf("<img") < 0 && evil.indexOf("<script") < 0 && evil.indexOf("<a ") < 0, "raw HTML / 链接 / 图片都不能变成元素");
	// 恶意内容藏在行内标记里：粗体 / 斜体 / 行内代码 / 列表项 / 围栏都不能把它当 HTML 吐出去
	const nested = md("**<img src=x onerror=alert(1)>** *<b>x</b>* `<i>y</i>`\n\n- <u>z</u>");
	assert.ok(nested.indexOf("<img") < 0 && nested.indexOf("<b>") < 0 && nested.indexOf("<i>") < 0 && nested.indexOf("<u>") < 0, "标记内部的 HTML 也要转义");
	assert.ok(nested.indexOf("&lt;img") >= 0, "转义后仍可见");
	assert.ok(evil.indexOf("&lt;script&gt;") >= 0, "原样当文本转义显示");
	const rich = md("- 甲\n- 乙\n\n1. 一\n2. 二\n\n```\nconst a = 1 < 2\n```");
	assert.ok(rich.indexOf("<ul") >= 0 && rich.indexOf("<ol") >= 0 && rich.indexOf("<pre") >= 0);
	assert.ok(rich.indexOf("1 &lt; 2") >= 0, "代码块里的 < 也被转义");
	assert.equal(md(""), '<div class="daw-md" style="word-break:break-word"></div>');
});
