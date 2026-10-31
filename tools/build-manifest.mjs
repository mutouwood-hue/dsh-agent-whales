/**
 * tools/build-manifest.mjs — 生成素材清单 assets/manifest.json，并把 assets/<key>.webp
 * 对齐到 assets/art.json（D1：素材不再内联进 client.js，改由宿主路由提供：
 *   GET /agent-whales/api/art/manifest
 *   GET /agent-whales/api/art/<key>.webp
 * ）。
 *
 * 为什么以 art.json 为唯一事实来源：历史上 client.js 内联的就是 art.json 里的 data URI
 * （tools/embed-art.mjs 用它的 base64 覆写 client.js），所以「用户现在看到的图」= art.json。
 * D1 之后浏览器改为按 key 向宿主取 .webp，两边必须逐字节一致，否则视觉会变。
 * 因此本脚本：
 *   - 缺的 webp 从 art.json 解出来补齐（例如只有 data URI、没有源文件的 c-idle / c-work）；
 *   - 与 art.json 不一致的 webp 用 art.json 覆盖（当前 q-cry 就是这种情况，差 8 字节）；
 *   - 多出来的顶层 .webp（不在 art.json 里）报错，避免打进包却永远取不到；
 *   - assets/manifest.json 按 key 排序、只有 {version, keys}，逐字节可复现。
 *
 * 用法：
 *   node tools/build-manifest.mjs            # 生成/更新（幂等，第二次运行不产生变化）
 *   node tools/build-manifest.mjs --check    # 只校验不写盘；有任何不一致就退出 1
 *
 * 校验红线：key 前缀必须是 q-/m-/c-（决定 skin）、w/h/bytes 必须是正整数、
 * uri 必须是可解码的 WebP data URI（RIFF....WEBP），任何一条不过就退出 1。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const assetsDir = join(root, "assets");
const artPath = join(assetsDir, "art.json");
const manifestPath = join(assetsDir, "manifest.json");

/** 清单协议版本：与宿主路由 / 浏览器半边约定一致。 */
export const MANIFEST_VERSION = 1;
/** key 前缀 → skin，和宿主路由的解析规则必须完全一致。 */
const SKIN_BY_PREFIX = { q: "q", m: "mature", c: "classic" };
const KEY_PATTERN = /^[qmc]-[a-z0-9][a-z0-9-]*$/;
const WEBP_URI_PREFIX = "data:image/webp;base64,";
const WEBP_SUFFIX = ".webp";

/** key 前缀决定 skin；不认识的前缀返回 undefined（构建期按错误处理）。 */
export function skinOfKey(key) {
	if (typeof key !== "string" || key.length === 0) return undefined;
	return SKIN_BY_PREFIX[key.slice(0, 1)];
}

/** 构建期错误：CLI 捕获后打印、退出 1。 */
class BuildManifestError extends Error {}

/**
 * 校验一条 art.json 里的精灵记录，解出 WebP 字节。
 * @returns {{ buffer: Buffer, w: number, h: number, bytes: number }}
 */
function decodeSprite(key, sprite) {
	const problems = [];
	if (!KEY_PATTERN.test(key)) problems.push(`key ${JSON.stringify(key)} 不符合 q-/m-/c- 前缀规范（路由按前缀定 skin）`);
	if (!sprite || typeof sprite !== "object") problems.push(`${key}: 记录不是对象`);
	else {
		for (const field of ["w", "h", "bytes"]) {
			const value = sprite[field];
			if (!Number.isInteger(value) || value <= 0) problems.push(`${key}.${field} 必须是正整数，实际 ${JSON.stringify(value)}`);
		}
		if (typeof sprite.uri !== "string" || !sprite.uri.startsWith(WEBP_URI_PREFIX)) {
			problems.push(`${key}.uri 不是 ${WEBP_URI_PREFIX}… 的 WebP data URI`);
		}
	}
	if (problems.length > 0) throw new BuildManifestError(problems.join("\n  - "));

	let buffer;
	try {
		buffer = Buffer.from(sprite.uri.slice(WEBP_URI_PREFIX.length), "base64");
	} catch (error) {
		throw new BuildManifestError(`${key}.uri base64 解码失败：${error instanceof Error ? error.message : String(error)}`);
	}
	const riff = buffer.subarray(0, 4).toString("latin1");
	const webp = buffer.subarray(8, 12).toString("latin1");
	if (riff !== "RIFF" || webp !== "WEBP") {
		throw new BuildManifestError(`${key}.uri 解出来的字节不是 WebP（头部 ${JSON.stringify(riff)}/${JSON.stringify(webp)}）`);
	}
	if (buffer.length !== sprite.bytes) {
		throw new BuildManifestError(`${key}.bytes=${sprite.bytes} 与 data URI 实际解码长度 ${buffer.length} 不一致`);
	}
	return { buffer, w: sprite.w, h: sprite.h, bytes: sprite.bytes };
}

/**
 * 生成清单（并默认把 assets/<key>.webp 对齐到 art.json）。
 * @param {{ check?: boolean, artPath?: string, assetsDir?: string }} [options]
 * @returns {{ keys: string[], totalBytes: number, addedFiles: string[], rewroteFiles: string[], manifestChanged: boolean }}
 */
export function buildManifest(options = {}) {
	const checkOnly = options.check === true;
	const artFile = options.artPath ?? artPath;
	const assets = options.assetsDir ?? assetsDir;
	const manifestFile = join(assets, "manifest.json");

	if (!existsSync(artFile)) {
		throw new BuildManifestError(`art.json 不存在：${artFile}\n先跑 tools/build-assets.py（或从仓库完整取得 assets/art.json）。`);
	}

	let parsed;
	try {
		parsed = JSON.parse(readFileSync(artFile, "utf8"));
	} catch (error) {
		throw new BuildManifestError(`art.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
	const sprites = parsed && typeof parsed === "object" ? parsed.sprites : undefined;
	if (!sprites || typeof sprites !== "object") throw new BuildManifestError("art.json 缺少 sprites 表");
	const keys = Object.keys(sprites);
	if (keys.length === 0) throw new BuildManifestError("art.json 的 sprites 为空");

	// 逐条校验并解出字节。先全部校验完再动盘：校验失败时不能留下半套素材。
	const spritesByKey = new Map();
	for (const key of keys) spritesByKey.set(key, decodeSprite(key, sprites[key]));

	// 目录里多出来的顶层 .webp（不在 art.json）会被 files 白名单打进包，但路由不认它。
	const existingFiles = readdirSync(assets).filter((name) => name.endsWith(WEBP_SUFFIX));
	const expectedFiles = new Set(keys.map((key) => key + WEBP_SUFFIX));
	const extraFiles = existingFiles.filter((name) => !expectedFiles.has(name));
	if (extraFiles.length > 0) {
		throw new BuildManifestError(
			`assets/ 里有 art.json 之外的 WebP：${extraFiles.join(", ")}\n` +
				"它们会进包但永远不会被路由返回；请删掉，或跑对应 ingest 脚本把 key 并进 art.json。"
		);
	}

	const addedFiles = [];
	const rewroteFiles = [];
	for (const key of [...keys].sort()) {
		const sprite = spritesByKey.get(key);
		const filePath = join(assets, key + WEBP_SUFFIX);
		if (!existsSync(filePath)) {
			if (!checkOnly) writeFileSync(filePath, sprite.buffer);
			addedFiles.push(key + WEBP_SUFFIX);
			continue;
		}
		const current = readFileSync(filePath);
		if (!current.equals(sprite.buffer)) {
			if (!checkOnly) writeFileSync(filePath, sprite.buffer);
			rewroteFiles.push(key + WEBP_SUFFIX);
		}
	}

	// 清单本身：按 key 排序、只写协议字段，保证可复现（不写时间戳）。
	const orderedKeys = [...keys].sort();
	const manifestKeys = {};
	let totalBytes = 0;
	for (const key of orderedKeys) {
		const sprite = spritesByKey.get(key);
		totalBytes += sprite.bytes;
		manifestKeys[key] = { w: sprite.w, h: sprite.h, bytes: sprite.bytes, skin: skinOfKey(key) };
	}
	const nextManifest = JSON.stringify({ version: MANIFEST_VERSION, keys: manifestKeys }, null, 2) + "\n";
	const currentManifest = existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : undefined;
	const manifestChanged = currentManifest !== nextManifest;
	if (manifestChanged && !checkOnly) writeFileSync(manifestFile, nextManifest, "utf8");

	return {
		keys: orderedKeys,
		totalBytes,
		addedFiles,
		rewroteFiles,
		manifestChanged
	};
}

// ── CLI ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
	return (bytes / 1024).toFixed(1) + " KB";
}

function cli() {
	const checkOnly = process.argv.slice(2).includes("--check");
	try {
		const result = buildManifest({ check: checkOnly });
		const skinCount = { q: 0, mature: 0, classic: 0 };
		for (const key of result.keys) skinCount[skinOfKey(key)] += 1;

		console.log(`art.json     : ${artPath}`);
		console.log(`sprites      : ${result.keys.length}（q=${skinCount.q}, mature=${skinCount.mature}, classic=${skinCount.classic}）`);
		console.log(`payload total: ${formatBytes(result.totalBytes)}`);
		if (result.addedFiles.length > 0) console.log(`补齐 webp   : ${result.addedFiles.join(", ")}`);
		if (result.rewroteFiles.length > 0) console.log(`覆盖 webp   : ${result.rewroteFiles.join(", ")}（以 art.json 为准）`);
		if (result.addedFiles.length === 0 && result.rewroteFiles.length === 0) console.log("webp        : 全部与 art.json 一致，无需改动");
		console.log(`manifest.json: ${result.manifestChanged ? (checkOnly ? "与 art.json 不一致（--check）" : "已写入") : "未变化"}`);

		if (checkOnly && (result.manifestChanged || result.addedFiles.length > 0 || result.rewroteFiles.length > 0)) {
			console.error("\n--check 失败：素材与 art.json 不一致，先跑 node tools/build-manifest.mjs。");
			process.exitCode = 1;
			return;
		}
	} catch (error) {
		console.error("build-manifest 失败：");
		console.error("  - " + (error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== undefined && invokedPath === import.meta.url) cli();
