/**
 * 把本机已安装的 @company/cds-react 打成画布原型用的「本地组件包」。
 *
 *   node tools/component-packs/cds/build.mjs --cds <装了 @company/cds-react 的 node_modules 目录> [--out <目录>]
 *
 * --out 缺省 = <DSH_HOME 或 ~/.dsh>/agent-whales/component-packs/cds。产物：manifest.json + bundle.js + styles.css。
 * React / react-dom / jsx-runtime 外置（画布运行时用 DSH 同一份 React）；CDS 本体与它的依赖打进 bundle.js。
 * 受控包只落在你自己的机器上，插件仓库与发布包里都没有它。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// esbuild 用 tools/flow-chunk 里装的那份（cd tools/flow-chunk && npm install），这里不另装一套
const { build } = await import(pathToFileURL(join(here, "..", "..", "flow-chunk", "node_modules", "esbuild", "lib", "main.js")).href);
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const cdsModules = arg("--cds");
if (!cdsModules) { console.error("缺 --cds <node_modules 目录>"); process.exit(2); }
const home = process.env.DSH_HOME && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
const out = resolve(arg("--out") || join(home, "agent-whales", "component-packs", "cds"));
const cdsDir = join(cdsModules, "@company", "cds-react");
const cdsPkg = JSON.parse(readFileSync(join(cdsDir, "package.json"), "utf8"));

const result = await build({
	entryPoints: [join(here, "adapter.jsx")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "browser",
	target: "es2019",
	minify: true,
	jsx: "automatic",
	external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@xyflow/react", "@dagrejs/dagre", "recharts", "@tiptap/*", "@ai-sdk/*"],
	loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty" },
	define: { "process.env.NODE_ENV": "\"production\"" },
	nodePaths: [cdsModules, join(here, "..", "..", "flow-chunk", "node_modules")],
	logLevel: "warning"
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "bundle.js"), result.outputFiles[0].text, "utf8");
copyFileSync(join(cdsDir, "dist", "styles.css"), join(out, "styles.css"));
writeFileSync(join(out, "manifest.json"), JSON.stringify({
	name: "CDS " + cdsPkg.version + "（本地）",
	version: cdsPkg.version,
	license: cdsPkg.license || "",
	source: "@company/cds-react",
	builtAt: new Date().toISOString()
}, null, 2), "utf8");
console.log("CDS pack →", out, (Buffer.byteLength(result.outputFiles[0].text) / 1024).toFixed(1) + " KB");
