/**
 * 构建 lib/client.view.js（show_view 卡片节点 + 侧聊节点）。
 * 与 build-proto.mjs 同一套 chunk 契约：自注册 id + chunk 名，React 外置（宿主共享模块表同一份）。
 * 没有 Tailwind：卡片样式是 deep-view 自带的 CSS 字符串（DEEP_VIEW_CSS），随 chunk 导出为 VIEW_CSS，加载即注入。
 *
 * 用法：cd tools/flow-chunk && node build-view.mjs
 */
import { build } from "esbuild";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "..");
const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));

const result = await build({
	entryPoints: [join(here, "view", "entry.jsx")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "browser",
	target: "es2019",
	minify: true,
	legalComments: "none",
	jsx: "automatic",
	external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
	loader: { ".jsx": "jsx" },
	define: { "process.env.NODE_ENV": "\"production\"" },
	nodePaths: [join(here, "node_modules")]
});

const banner = "/* dsh-agent-whales · client.view.js —— 由 tools/flow-chunk/build-view.mjs 生成，勿手改。\n"
	+ " * show_view 卡片节点 + 侧聊节点。视图渲染层与校验 / 公式 / 回答协议来自 deep-view 0.1.2（Apache-2.0，\n"
	+ " * https://github.com/Fei2411/deep-view，移植自 DS Bot），已拷入本仓库，见 NOTICE.md。 */\n";
const wrapped = banner
	+ "window.__ModuleLoader__.load({ id: " + JSON.stringify(pkg.name) + ", chunk: \"client.view.js\", factory: function (require) {\n"
	+ "var module = { exports: {} }; var exports = module.exports;\n"
	+ result.outputFiles[0].text
	+ "\nreturn module.exports;\n} });\n";
writeFileSync(join(pluginDir, "lib", "client.view.js"), wrapped, "utf8");
console.log("lib/client.view.js", (Buffer.byteLength(wrapped) / 1024).toFixed(1) + " KB");
