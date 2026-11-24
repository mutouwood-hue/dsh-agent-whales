/**
 * 构建 lib/client.proto.js（原型帧 / 组件库节点 / Puck 编辑器 / 内置 shadcn 风格组件包）。
 *   1) Tailwind 3 只扫 proto/shadcn-pack.jsx，生成内置包的 CSS（只注入原型 iframe，不进 DSH 页面）；
 *   2) esbuild 打包 proto/entry.jsx；React / ReactDOM / jsx-runtime 外置（宿主共享模块表同一份）。
 * 宿主 chunk 契约与 client.flow.js 相同（见 build.mjs 顶部注释）。
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 组件工坊（设计方案 §10）：Puck 里的项目组件要渲染成沙箱岛，srcdoc 必须与画布节点共用同一份实现。
// 构建时把 lib/design/sandbox.js 的 sandboxSrcdoc 编译成文本注入（不把它整个打包进 chunk，避免把 Node 的 import 带进来）。
const { sandboxSrcdoc } = await import(pathToFileURL(join(here, "..", "..", "lib", "design", "sandbox.js")).href);
const pluginDir = join(here, "..", "..");
const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
const version = (name) => JSON.parse(readFileSync(join(here, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;

const twConfig = {
	content: [join(here, "proto", "shadcn-pack.jsx")],
	theme: {
		extend: {
			colors: {
				border: "hsl(var(--border))",
				input: "hsl(var(--input))",
				ring: "hsl(var(--ring))",
				background: "hsl(var(--background))",
				foreground: "hsl(var(--foreground))",
				primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
				secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
				destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
				muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
				accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
				card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" }
			},
			borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" }
		}
	}
};
const css = await postcss([tailwindcss(twConfig)]).process(readFileSync(join(here, "proto", "shadcn.css"), "utf8"), { from: undefined });
writeFileSync(join(here, "proto", "shadcn.generated.css"), css.css, "utf8");

/** 打一个包内 chunk：自注册 id + chunk 名，React 外置。 */
async function chunk(entry, fileName, banner) {
	const result = await build({
		entryPoints: [join(here, "proto", entry)],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "browser",
		target: "es2019",
		minify: true,
		legalComments: "none",
		jsx: "automatic",
		external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
		loader: { ".css": "text", ".jsx": "jsx" },
		nodePaths: [join(here, "node_modules")],
		// 组件工坊（设计方案 §10）：沙箱岛的 srcdoc 与画布节点共用同一份实现，构建时注入。
		define: { "process.env.NODE_ENV": "\"production\"", "__WHALES_SANDBOX_SRCDOC__": JSON.stringify(sandboxSrcdoc({ title: "puck-island" })) }
	});
	const wrapped = banner
		+ "window.__ModuleLoader__.load({ id: " + JSON.stringify(pkg.name) + ", chunk: " + JSON.stringify(fileName) + ", factory: function (require) {\n"
		+ "var module = { exports: {} }; var exports = module.exports;\n"
		+ result.outputFiles[0].text
		+ "\nreturn module.exports;\n} });\n";
	writeFileSync(join(pluginDir, "lib", fileName), wrapped, "utf8");
	console.log("lib/" + fileName, (Buffer.byteLength(wrapped) / 1024).toFixed(1) + " KB");
}

await chunk("entry.jsx", "client.proto.js",
	"/* dsh-agent-whales · client.proto.js —— 由 tools/flow-chunk/build-proto.mjs 生成，勿手改。\n"
	+ " * 原型帧预览 / 组件库节点 / 内置组件包。内置包按 shadcn/ui（MIT）的类名与 CSS 变量复刻外观，\n"
	+ " * 样式由 Tailwind CSS " + version("tailwindcss") + "（MIT）生成。 */\n");
await chunk("editor-entry.jsx", "client.puck.js",
	"/* dsh-agent-whales · client.puck.js —— 由 tools/flow-chunk/build-proto.mjs 生成，勿手改。\n"
	+ " * 内含 @puckeditor/core " + version("@puckeditor/core") + "（MIT，© Measured Co.）及其依赖（tiptap / prosemirror / dnd-kit 等，均 MIT）。\n"
	+ " * 只在点「编辑」时按需加载。 */\n");
console.log("shadcn css", (Buffer.byteLength(css.css) / 1024).toFixed(1) + " KB");