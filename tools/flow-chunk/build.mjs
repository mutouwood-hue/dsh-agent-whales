/**
 * 构建 lib/client.flow.js：React Flow 12.12 + dagre 打成插件的「包内按需 chunk」。
 *
 * 宿主契约（dsh-client-modules src/client/system.ts，2026-11-17 逐字核实）：
 *   - 主包里 `require.async("./client.flow.js")` → 宿主按 `/plugins/<包名>/client.flow.js?rev=` 拉同目录文件；
 *   - chunk 文件必须自己调用 `window.__ModuleLoader__.load({ id: <包名>, chunk: "client.flow.js", factory })`；
 *   - 文件名必须匹配 /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/。
 * React / ReactDOM 不打包：factory 拿到的 require 能解析宿主共享模块表里的 react、react-dom、
 * react/jsx-runtime（页面实测 react 18.3.1），与主包同一份 React——否则 hooks 会因两份 React 而崩。
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "..");
const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
const versions = {
  xyflow: JSON.parse(readFileSync(join(here, "node_modules", "@xyflow", "react", "package.json"), "utf8")).version,
  dagre: JSON.parse(readFileSync(join(here, "node_modules", "@dagrejs", "dagre", "package.json"), "utf8")).version
};

const result = await build({
  entryPoints: [join(here, "entry.mjs")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2019",
  minify: true,
  legalComments: "none",
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
  loader: { ".css": "text" },
  define: { "process.env.NODE_ENV": "\"production\"" }
});
const body = result.outputFiles[0].text;
const banner = "/* dsh-agent-whales · client.flow.js —— 由 tools/flow-chunk/build.mjs 生成，勿手改。\n"
  + " * 内含 @xyflow/react " + versions.xyflow + "（MIT，© webkid GmbH）与 @dagrejs/dagre " + versions.dagre + "（MIT）。 */\n";
const wrapped = banner
  + "window.__ModuleLoader__.load({ id: " + JSON.stringify(pkg.name) + ", chunk: \"client.flow.js\", factory: function (require) {\n"
  + "var module = { exports: {} }; var exports = module.exports;\n"
  + body
  + "\nreturn module.exports;\n} });\n";
writeFileSync(join(pluginDir, "lib", "client.flow.js"), wrapped, "utf8");
console.log("lib/client.flow.js", (Buffer.byteLength(wrapped) / 1024).toFixed(1) + " KB", versions);
