/**
 * 原型 chunk 行为测试（真 React 18 + react-dom/server）：
 *   - 内置 shadcn 包覆盖整套通用词表；
 *   - PuckData 渲染 Puck 数据（含插槽嵌套）、缺组件画占位而不是崩；
 *   - 本地组件包（CommonJS bundle）只能 require 共享 React，导出组件表 / 工厂函数都认。
 * React 从 tools/flow-chunk/node_modules 取（构建依赖，不随插件发布）；没装就跳过并说明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pluginDir } from "./harness.mjs";

const toolDir = join(pluginDir, "tools", "flow-chunk");
const have = existsSync(join(toolDir, "node_modules", "react-dom", "server.js"));
const req = createRequire(join(toolDir, "package.json"));

function loadProto() {
	const React = req("react");
	const ReactDOM = req("react-dom");
	const jsx = req("react/jsx-runtime");
	let registration = null;
	new Function("window", readFileSync(join(pluginDir, "lib", "client.proto.js"), "utf8"))({ __ModuleLoader__: { load(reg) { registration = reg; } } });
	assert.equal(registration.chunk, "client.proto.js");
	const lib = registration.factory((spec) => (spec === "react" ? React : spec === "react-dom" ? ReactDOM : jsx));
	return { React, lib, server: req("react-dom/server") };
}

test("原型 chunk：内置 shadcn 包覆盖全部通用词表；PuckData 渲染插槽嵌套；缺组件画占位", { skip: have ? false : "tools/flow-chunk 没装依赖（npm install）" }, async () => {
	const { React, lib, server } = loadProto();
	const builtin = await lib.loadPack({ id: "shadcn" });
	const cov = lib.packCoverage(builtin);
	assert.equal(cov.covered, cov.total, "内置包要覆盖整套词表：缺 " + cov.missing.join(","));
	assert.equal(cov.total, lib.VOCAB_NAMES.length);
	assert.ok(builtin.css.indexOf("--primary") >= 0 && builtin.css.indexOf(".bg-primary") >= 0, "内置包带 Tailwind 生成的样式");
	const config = lib.buildPuckConfig(builtin);
	const data = { content: [
		{ type: "Heading", props: { id: "h", text: "表单导入", level: "2" } },
		{ type: "Dialog", props: { id: "d", title: "导入数据", content: [{ type: "Upload", props: { id: "u", label: "上传文件", hint: "xlsx" } }, { type: "Columns", props: { id: "c", left: [{ type: "Input", props: { id: "i", label: "源字段" } }], right: [{ type: "Badge", props: { id: "b", text: "已匹配" } }] } }] } },
		{ type: "Ghost", props: { id: "g" } }
	], root: { props: {} } };
	const html = server.renderToStaticMarkup(React.createElement(lib.PuckData, { config, data }));
	for (const text of ["表单导入", "导入数据", "上传文件", "源字段", "已匹配", "确定", "取消"]) assert.ok(html.indexOf(text) >= 0, "缺：" + text);
	assert.ok(html.indexOf("（当前组件包没有「Ghost」）") >= 0, "不认识的组件画占位而不是崩");
	assert.ok(html.indexOf("rounded-lg border bg-background") >= 0, "用的是 shadcn 的类名");
});

test("原型 chunk：本地组件包只能 require 共享 React；组件表 / 工厂函数两种导出都认；缺的组件计入覆盖率", { skip: have ? false : "tools/flow-chunk 没装依赖" }, async () => {
	const { React, lib, server } = loadProto();
	const files = {
		"/agent-whales/api/component-packs/mini/bundle.js": "var jsx = require('react/jsx-runtime').jsx; module.exports = function (React) { return { components: { Button: function (p) { return jsx('button', { className: 'mini-btn', children: p.label }); } }, rootClass: 'mini-root' }; };",
		"/agent-whales/api/component-packs/mini/styles.css": ".mini-btn{color:red}",
		"/agent-whales/api/component-packs/evil/bundle.js": "require('fs'); module.exports = {};"
	};
	const original = globalThis.fetch;
	globalThis.fetch = (url) => Promise.resolve(files[url] !== undefined ? { ok: true, status: 200, text: () => Promise.resolve(files[url]) } : { ok: false, status: 404, text: () => Promise.resolve("") });
	try {
		const mini = await lib.loadPack({ id: "mini", name: "Mini" });
		assert.equal(mini.css, ".mini-btn{color:red}");
		assert.equal(mini.rootClass, "mini-root");
		const cov = lib.packCoverage(mini);
		assert.equal(cov.covered, 1);
		assert.ok(cov.missing.indexOf("Table") >= 0);
		const html = server.renderToStaticMarkup(React.createElement(lib.PuckData, { config: lib.buildPuckConfig(mini), data: { content: [{ type: "Button", props: { label: "提交" } }, { type: "Table", props: {} }] } }));
		assert.ok(html.indexOf("mini-btn") >= 0 && html.indexOf("提交") >= 0 && html.indexOf("mini-root") >= 0);
		assert.ok(html.indexOf("（当前组件包没有「Table」）") >= 0, "本地包缺的组件不偷偷换成别家实现");
		await assert.rejects(lib.loadPack({ id: "evil" }), /只能 require react/);
		await assert.rejects(lib.loadPack({ id: "missing-pack" }), /bundle\.js 404/);
	} finally {
		globalThis.fetch = original;
	}
});
