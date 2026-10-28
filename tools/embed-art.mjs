/**
 * tools/embed-art.mjs — 把 assets/art.json 里的精灵图内联进 lib/client.js。
 *
 * 为什么内联：浏览器半边是单文件 bundle（clientModules 只托管一个入口），
 * 不能 require 兄弟文件，也没有静态资源目录。实测 7 张 WebP 合计 ~60KB，
 * base64 之后仍在一次性加载可接受范围内。
 *
 * 用法：
 *   node tools/embed-art.mjs                  # 用 assets/art.json
 *   node tools/embed-art.mjs path/to/art.json # 用别的产物（调试/预览）
 *
 * 幂等：重复运行只会替换 <art:begin> 与 <art:end> 之间的内容。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const clientPath = join(root, "lib", "client.js");

const requested = process.argv[2];
const artPath = requested ? resolve(process.cwd(), requested) : join(root, "assets", "art.json");

/** 页面在运行时真正会被读取的 key；缺了会导致对应状态没有图。 */
const REQUIRED = ["q-smile", "q-blink", "q-wave", "q-proud", "q-sleepy", "q-laugh", "q-pout", "q-surprise", "m-base", "m-blink", "m-laugh", "m-pout", "m-surprise", "m-proud"];

if (!existsSync(artPath)) {
  console.error("art.json 不存在：" + artPath);
  console.error("先跑 tools/build-assets.py 生成素材。");
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(artPath, "utf8"));
const sprites = parsed.sprites ?? {};
const keys = Object.keys(sprites);
if (keys.length === 0) {
  console.error("art.json 里没有任何精灵：" + artPath);
  process.exit(1);
}

const problems = [];
for (const key of REQUIRED) {
  if (!sprites[key]) problems.push("缺少必需精灵 " + key);
}
let totalBytes = 0;
for (const [key, value] of Object.entries(sprites)) {
  if (typeof value?.uri !== "string" || !value.uri.startsWith("data:image/webp;base64,")) {
    problems.push(key + " 的 uri 不是 WebP data URI");
  }
  if (!Number.isFinite(value?.w) || !Number.isFinite(value?.h)) problems.push(key + " 缺少 w/h");
  totalBytes += value?.bytes ?? 0;
}
if (problems.length > 0) {
  console.error("art.json 校验失败：\n  - " + problems.join("\n  - "));
  process.exit(1);
}

const lines = keys.map((key) => {
  const value = sprites[key];
  const entry = { source: value.source, w: value.w, h: value.h, bytes: value.bytes, uri: value.uri };
  return '\t\t\t"' + key + '": ' + JSON.stringify(entry);
});

const block = [
  "\t\t// <art:begin> —— 以下由 tools/embed-art.mjs 用 assets/art.json 覆写，勿手改",
  "\t\tvar ART = {",
  lines.join(",\n"),
  "\t\t};",
  "\t\t// <art:end>"
].join("\n");

const source = readFileSync(clientPath, "utf8");
const begin = source.indexOf("// <art:begin>");
const end = source.indexOf("// <art:end>");
if (begin < 0 || end < 0 || end < begin) {
  console.error("client.js 里找不到 <art:begin> / <art:end> 标记，放弃改写。");
  process.exit(1);
}

// 从行首的缩进开始替换，保留标记前后结构。
const lineStart = source.lastIndexOf("\n", begin) + 1;
const endMarkerStop = end + "// <art:end>".length;
const next = source.slice(0, lineStart) + block + source.slice(endMarkerStop);
writeFileSync(clientPath, next, "utf8");

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log("art.json      :", artPath);
console.log("sprites       :", keys.length, "(" + keys.join(", ") + ")");
console.log("payload total :", kb(totalBytes), "→ base64 ≈", kb(Math.round(totalBytes * 4 / 3)));
console.log("client.js     :", kb(source.length), "→", kb(next.length));
