/**
 * tools/embed-art.mjs — 兼容入口（D1 起不再内联，等价于 `node tools/build-manifest.mjs`）。
 *
 * 历史：这个脚本以前把 assets/art.json 里的 base64 覆写进 lib/client.js 的
 * `<art:begin>` / `<art:end>` 块。D1（PRD §34.1）之后素材改由宿主路由提供：
 *   GET /agent-whales/api/art/manifest
 *   GET /agent-whales/api/art/<key>.webp
 * 浏览器半边只加载用户当前选择的皮肤，lib/client.js 里不再有任何 base64 素材。
 *
 * 之所以保留这个文件名而不是删掉：README 与 tools/ingest-generated.py 的提示仍然
 * 写着 `node tools/embed-art.mjs`，保留成兼容别名可以让照着旧文档操作的人得到
 * **正确的新行为**（生成 assets/manifest.json + 对齐 assets/<key>.webp），
 * 而不是「命令不存在」或者更糟的「以为内联了其实没有」。
 *
 * 用法与 build-manifest 完全一致：
 *   node tools/embed-art.mjs            # 生成/更新 assets/manifest.json 与 webp
 *   node tools/embed-art.mjs --check    # 只校验不写盘；不一致退出 1
 */
import { buildManifest, skinOfKey } from "./build-manifest.mjs";

console.warn(
	"[deprecated] tools/embed-art.mjs 已不再把素材内联进 lib/client.js。\n" +
	"             素材改由宿主路由 /agent-whales/api/art/* 提供；本次只执行：校验素材 + 生成 assets/manifest.json。\n" +
	"             等价命令：node tools/build-manifest.mjs"
);

const checkOnly = process.argv.slice(2).includes("--check");
try {
	const result = buildManifest({ check: checkOnly });
	const skinCount = { q: 0, mature: 0, classic: 0 };
	for (const key of result.keys) skinCount[skinOfKey(key)] += 1;
	console.log(`sprites      : ${result.keys.length}（q=${skinCount.q}, mature=${skinCount.mature}, classic=${skinCount.classic}）`);
	if (result.addedFiles.length > 0) console.log(`补齐 webp   : ${result.addedFiles.join(", ")}`);
	if (result.rewroteFiles.length > 0) console.log(`覆盖 webp   : ${result.rewroteFiles.join(", ")}（以 art.json 为准）`);
	console.log(`manifest.json: ${result.manifestChanged ? (checkOnly ? "与 art.json 不一致（--check）" : "已写入") : "未变化"}`);
	if (checkOnly && (result.manifestChanged || result.addedFiles.length > 0 || result.rewroteFiles.length > 0)) {
		console.error("--check 失败：素材与 art.json 不一致，先跑 node tools/build-manifest.mjs。");
		process.exitCode = 1;
	}
} catch (error) {
	console.error("embed-art（现为 build-manifest 兼容入口）失败：");
	console.error("  - " + (error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
}
