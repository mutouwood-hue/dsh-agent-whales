/**
 * D1 后的素材测试工具：客户端不再内联 base64，素材由 artLoader 从宿主路由拉。
 * 这里用一个假宿主 fetch（不碰 Node 全局、不碰真宿主），把 manifest + 每张 webp 喂进去。
 *
 * **manifest 直接从 assets/art.json 推导**，不写死 key 列表与尺寸——
 * 否则「加一张图 / 某帧宽度变了」就要改测试常量，是典型的假门禁。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPlugin, pluginDir } from "./harness.mjs";

export const ART_ROUTE = "/agent-whales/api/art/";

const SOURCE = JSON.parse(readFileSync(join(pluginDir, "assets", "art.json"), "utf8"));
const SPRITES = SOURCE.sprites || {};

function familyOf(key) {
	if (key.startsWith("q-")) return "q";
	if (key.startsWith("m-")) return "mature";
	return "classic";
}

/** 真实素材的 key 分组（与 assets/manifest.json 的 skin 口径一致）。 */
export const ART_KEYS = { q: [], mature: [], classic: [] };
for (const key of Object.keys(SPRITES)) ART_KEYS[familyOf(key)].push(key);
export const ALL_ART_KEYS = Object.keys(SPRITES);

/** 假 manifest：字段与宿主 `/art/manifest` 契约一致（version + keys{w,h,bytes,skin}）。 */
export function artManifestBody(extraKeys = {}) {
	const keys = {};
	for (const [key, entry] of Object.entries(SPRITES)) {
		keys[key] = { w: entry.w, h: entry.h, bytes: entry.bytes, skin: familyOf(key) };
	}
	return { version: 1, keys: Object.assign(keys, extraKeys) };
}

/** 假宿主 fetch：记录请求顺序，可指定哪些 key 404、manifest 返回什么。 */
export function createArtFetch(options = {}) {
	const log = [];
	const failKeys = new Set(options.failKeys || []);
	const manifestStatus = options.manifestStatus ?? 200;
	const manifestBody = Object.prototype.hasOwnProperty.call(options, "manifestBody") ? options.manifestBody : artManifestBody();
	const fetchImpl = (url) => {
		const target = String(url);
		log.push(target);
		if (target === ART_ROUTE + "manifest") {
			if (manifestStatus !== 200) return Promise.resolve({ ok: false, status: manifestStatus });
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(manifestBody) });
		}
		const match = new RegExp("^" + ART_ROUTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(.+)\\.webp$").exec(target);
		if (match === null) return Promise.resolve({ ok: false, status: 404 });
		const key = decodeURIComponent(match[1]);
		if (!Object.prototype.hasOwnProperty.call(manifestBody.keys || {}, key)) return Promise.resolve({ ok: false, status: 404 });
		if (failKeys.has(key)) return Promise.resolve({ ok: false, status: 404 });
		return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) });
	};
	fetchImpl.log = log;
	return fetchImpl;
}

export function loadPluginWithArt(options = {}) {
	const loaded = loadPlugin();
	loaded.win.fetch = createArtFetch(options);
	return loaded;
}

/** 触发若干皮肤的素材加载并等到全部落定（成功或失败）。 */
export async function loadArt(loaded, families) {
	const { artLoader } = loaded.plugin.__test;
	for (const family of families) artLoader.ensureSkin(family);
	await artLoader.whenIdle();
}

export async function testApiWithArt(families = ["q", "mature"]) {
	const loaded = loadPluginWithArt();
	await loadArt(loaded, families);
	return loaded.plugin.__test;
}
