/**
 * 构建组件工坊的两个浏览器产物（设计方案 §6.1 / §9.1）：
 *
 *   1) `lib/client.sandbox-runtime.js` —— **沙箱 iframe 里**跑的 React 运行时（纯文本，父页面 fetch 进来再塞进 iframe）。
 *      自成一体：自带 React 18 + ReactDOM production，挂 `__whalesRequire` / `__whalesRuntime`，
 *      模块映射按 P0 结论（jsx-runtime 必须暴露**原始函数**；react 也要 `__esModule` + default 指回自身）。
 *   2) `lib/client.design.js` —— 画布半边 chunk（组件节点 / 画板节点 / 在线画布登记），React 外置走宿主共享表，
 *      与 client.flow.js / client.proto.js 同一套 `__ModuleLoader__` 契约，按需加载。
 *
 * 约定：沙箱运行时用 `NODE_ENV=production`（React 生产版）；不要用 jsx-dev-runtime（生产版里 jsxDEV 是空桩）。
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "..");
const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
const nodeModules = join(here, "node_modules");

// ── 1) 沙箱运行时（IIFE 文本，无 import/export，直接 new Function 执行）────────
const RUNTIME_ENTRY = `
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as Client from "react-dom/client";
import * as Jsx from "react/jsx-runtime";

// P0 结论（见设计文档 §6.2）：这两个必须是**原始函数**。
// sucrase 产物调 .jsx.call(void 0, ...) 用裸函数；组件包（esbuild 产物）用命名导入，箭头包装会取不到。
const jsxFn = typeof Jsx.jsx === "function" ? Jsx.jsx : Jsx.default.jsx;
const jsxsFn = typeof Jsx.jsxs === "function" ? Jsx.jsxs : Jsx.default.jsxs;
const Fragment = React.Fragment;

// react 也要 __esModule + default 指回自身：import React from "react" 经 _interopRequireDefault 会取 .default
const reactModule = Object.assign({}, React, { __esModule: true });
reactModule.default = reactModule;

const registry = {
  react: reactModule,
  "react-dom": ReactDOM,
  "react-dom/client": Client,
  "react/jsx-runtime": { jsx: jsxFn, jsxs: jsxsFn, Fragment: Fragment, __esModule: true }
};
globalThis.__whalesRequire = (spec) => {
  if (registry[spec]) return registry[spec];
  throw new Error("sandbox: 不允许 require(" + spec + ")");
};
globalThis.__whalesRuntime = { React: reactModule, ReactDOM: ReactDOM, createRoot: Client.createRoot };
globalThis.__whalesSandboxReady = true;
`;

const runtimeResult = await build({
	stdin: { contents: RUNTIME_ENTRY, resolveDir: nodeModules, loader: "js" },
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "es2019",
	minify: true,
	legalComments: "none",
	define: { "process.env.NODE_ENV": "\"production\"" },
	nodePaths: [nodeModules]
});
const runtimeText = "/* dsh-agent-whales · client.sandbox-runtime.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。\n"
	+ " * 沙箱 iframe 里跑的 React 18 + ReactDOM production（MIT）+ 模块映射。以文本下发，父页面 new Function 执行。 */\n"
	+ runtimeResult.outputFiles[0].text;
writeFileSync(join(pluginDir, "lib", "client.sandbox-runtime.js"), runtimeText, "utf8");
console.log("lib/client.sandbox-runtime.js", (Buffer.byteLength(runtimeText) / 1024).toFixed(1) + " KB");

// ── 2) client.design.js（画布半边，React 外置）────────────────────────────────
const designResult = await build({
	entryPoints: [join(here, "design", "entry.jsx")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "browser",
	target: "es2019",
	minify: true,
	jsx: "automatic",
	legalComments: "none",
	external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
	loader: { ".css": "text", ".jsx": "jsx" },
	define: { "process.env.NODE_ENV": "\"production\"" },
	nodePaths: [nodeModules]
});
const designText = "/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。\n"
	+ " * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */\n";
const wrapped = designText
	+ "window.__ModuleLoader__.load({ id: " + JSON.stringify(pkg.name) + ", chunk: \"client.design.js\", factory: function (require) {\n"
	+ "var module = { exports: {} }; var exports = module.exports;\n"
	+ designResult.outputFiles[0].text
	+ "\nreturn module.exports;\n} });\n";
writeFileSync(join(pluginDir, "lib", "client.design.js"), wrapped, "utf8");
console.log("lib/client.design.js", (Buffer.byteLength(wrapped) / 1024).toFixed(1) + " KB");
