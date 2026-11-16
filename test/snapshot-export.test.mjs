/**
 * 快照导出：宿主路由 GET /agent-whales/api/snapshot + 浏览器半边 ZIP 打包。
 *
 * 借 chat-demo 历史导出的形状（ZIP + 明确数据边界），落地时按本插件约束改了两处：
 * 不引压缩库（单文件 bundle 门禁 560KB，备份对象只有几个 JSON），内容走宿主新开的
 * 只读路由（各业务路由返回的是**视图**，备份要的是盘上真源）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as host from "../lib/index.js";
import { loadPlugin } from "./harness.mjs";

// host.apply 会顺手装 worker preset：不把目标根指到临时目录就会往真实 ~/.dsh 写文件。
process.env.DSH_AGENT_WHALES_PRESET_DIR = mkdtempSync(join(tmpdir(), "aw-snap-presets-"));

/** 最小假宿主：webServer + sessions，store 全指到临时目录；返回路由调用器。 */
function mountHost() {
	const dir = mkdtempSync(join(tmpdir(), "aw-snap-"));
	host.setProjectStorePathForTests(join(dir, "projects.json"));
	host.setProposalStorePathForTests(join(dir, "proposals.json"));
	host.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
	host.setEventsStorePathForTests(join(dir, "events.json"));
	const routes = [];
	host.apply({
		get: (name) => {
			if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
			if (name === "sessions") return { get: (id) => (id === "session-a" ? { id } : undefined) };
			if (name === "sessionPersistence") return { stat: () => undefined };
			return undefined;
		},
		on: () => () => {},
		effect: (run) => { run(); return () => {}; }
	});
	const route = routes.find((item) => item && typeof item.handler === "function");
	let token = "";
	async function call(method, url, body) {
		const listeners = {};
		const req = { method, url, headers: { "x-whales-token": token }, on(event, fn) { (listeners[event] || (listeners[event] = [])).push(fn); return req; } };
		const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(chunk) { if (chunk !== undefined) this.body += String(chunk); } };
		setTimeout(() => {
			if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
			(listeners.end || []).forEach((fn) => fn());
		}, 0);
		await route.handler(req, res);
		let json;
		try { json = JSON.parse(res.body); } catch { json = undefined; }
		return { status: res.statusCode, body: json };
	}
	const ready = call("GET", "/agent-whales/api/activity").then((res) => { token = res.body.controlToken; });
	return { dir, call, ready };
}

describe("宿主路由：GET /agent-whales/api/snapshot", () => {
	test("五个 store 的原始内容 + present/readonly 标注；缺文件给 null", async () => {
		const h = mountHost();
		try {
			await h.ready;
			// 只造两个 store：其余三个文件不存在，必须 present:false + data:null
			writeFileSync(join(h.dir, "projects.json"), JSON.stringify({ projects: { p1: { projectId: "p1", name: "甲", mainSessionId: "session-a", members: [{ sessionId: "session-a" }], links: [] } } }), "utf8");
			writeFileSync(join(h.dir, "handoffs.json"), JSON.stringify({ entries: [{ kind: "visit", from: "session-a", to: "session-b", at: 1 }] }), "utf8");
			const got = await h.call("GET", "/agent-whales/api/snapshot");
			assert.equal(got.status, 200);
			assert.equal(got.body.code, 200, JSON.stringify(got.body));
			const files = got.body.data.files;
			assert.deepEqual(files.map((file) => file.name), ["projects.json", "canvas.json", "handoffs.json", "events.json", "proposals.json"]);
			const byName = {};
			for (const file of files) byName[file.name] = file;
			assert.equal(byName["projects.json"].present, true);
			assert.deepEqual(byName["projects.json"].data.projects.p1.name, "甲", "给的是盘上真源，不是 projectView");
			assert.equal(byName["handoffs.json"].data.entries.length, 1);
			for (const missing of ["canvas.json", "events.json", "proposals.json"]) {
				assert.equal(byName[missing].present, false, missing + " 不存在必须标出来");
				assert.equal(byName[missing].data, null, missing + " 缺文件给 null——「不在」与「空的」是两件事");
				assert.equal(byName[missing].readonly, false);
			}
			assert.ok(Number.isFinite(got.body.data.generatedAt), "要带生成时间");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	test("只读：POST 405 + allow；不需要 token（与 activity/handoffs 同一定位）", async () => {
		const h = mountHost();
		try {
			await h.ready;
			const posted = await h.call("POST", "/agent-whales/api/snapshot", JSON.stringify({}));
			assert.equal(posted.status, 405, "快照是只读路由");
			// 不带 token 的 GET 也要能读（上面的用例就没带 token）
			const got = await h.call("GET", "/agent-whales/api/snapshot");
			assert.equal(got.body.code, 200);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	test("store 损坏进只读降级时：readonly 标出来，并指出备份去哪了", async () => {
		const h = mountHost();
		try {
			await h.ready;
			writeFileSync(join(h.dir, "events.json"), "{不是 JSON", "utf8");
			const got = await h.call("GET", "/agent-whales/api/snapshot");
			const events = got.body.data.files.find((file) => file.name === "events.json");
			// 原文件已被改名成 events.json.corrupt-*：present=false，但 backupPath 必须指到它，
			// 否则用户以为「这个文件从来没存在过」。
			assert.equal(events.readonly, true, "只读降级必须在快照里可见——否则备份 quietly 给你一份空表");
			assert.equal(events.present, false, "原路径已不在");
			assert.match(String(events.backupPath), /events\.json\.corrupt-/, "备份路径要指到被改名那份");
			assert.equal(events.data, null);
			// 导出物的 README 要把这件事写出来
			const { wbSnapshotReadme } = loadPlugin().plugin.__test;
			const readme = wbSnapshotReadme(got.body.data.files);
			assert.match(readme, /原路径已不在（损坏后被改名备份）.*events\.json/);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

describe("浏览器半边：CRC-32 / ZIP 打包", () => {
	const { wbCrc32, wbUtf8, wbBuildZip, wbSnapshotReadme } = loadPlugin().plugin.__test;

	test("CRC-32 对标准测试向量", () => {
		assert.equal(wbCrc32(wbUtf8("123456789")), 0xcbf43926, "ASCII 123456789 是 CRC-32 的标准向量");
		assert.equal(wbCrc32(wbUtf8("")), 0, "空输入 = 0");
		assert.equal(wbCrc32(wbUtf8("a")), 0xe8b7be43);
	});

	test("UTF-8 编码：与 Node 的编码器逐字节一致（ASCII / 中文 / emoji / 混合）", () => {
		// 手写编码器（TextEncoder 缺失时的兜底）必须和 Node 的逐字节一致，
		// 否则 ZIP 里的中文会在另一台机器上变成乱码。
		for (const text of ["", "ab", "鲸鱼", "🐋", "混合 mixed 123 鲸鱼 🐋", "边缘\uD800\uDC00对"]) {
			assert.deepEqual(Array.from(wbUtf8(text)), Array.from(Buffer.from(text, "utf8")), JSON.stringify(text) + " 必须逐字节一致");
		}
		// 两个不变量单独钉一下（Buffer 也满足，但写出来防回归）：
		assert.deepEqual(Array.from(wbUtf8("ab")), [0x61, 0x62], "ASCII 单字节");
		assert.deepEqual(Array.from(wbUtf8("🐋")), [0xf0, 0x9f, 0x90, 0x8b], "emoji 四字节");
		assert.deepEqual(Array.from(wbUtf8("鲸")), Array.from(Buffer.from("鲸", "utf8")), "中文三字节");
	});

	/** 从 ZIP 里按中央目录解回条目（store 模式，测试自己写个最小解包器）。 */
	function unzip(zip) {
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		let eocd = zip.length - 22;
		while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
		assert.ok(eocd >= 0, "找不到 EOCD");
		const count = view.getUint16(eocd + 10, true);
		let cursor = view.getUint32(eocd + 16, true);
		const out = [];
		for (let index = 0; index < count; index += 1) {
			assert.equal(view.getUint32(cursor, true), 0x02014b50, "中央目录头签名");
			const crc = view.getUint32(cursor + 16, true);
			const size = view.getUint32(cursor + 20, true);
			const nameLen = view.getUint16(cursor + 28, true);
			const local = view.getUint32(cursor + 42, true);
			const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLen));
			assert.equal(view.getUint32(local, true), 0x04034b50, "本地头签名");
			const localNameLen = view.getUint16(local + 26, true);
			const body = zip.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
			out.push({ name, text: new TextDecoder().decode(body), crc });
			cursor += 46 + nameLen;
		}
		return out;
	}

	test("ZIP 结构可解：签名 / 条目 / 内容 / CRC 全对", () => {
		const zip = wbBuildZip([
			{ name: "projects.json", text: JSON.stringify({ projects: {} }, null, 2) + "\n" },
			{ name: "README.txt", text: "说明\n鲸鱼 🐋\n" }
		]);
		assert.ok(zip instanceof Uint8Array, "返回字节数组");
		const entries = unzip(zip);
		assert.deepEqual(entries.map((entry) => entry.name), ["projects.json", "README.txt"]);
		assert.deepEqual(JSON.parse(entries[0].text), { projects: {} });
		assert.equal(entries[1].text, "说明\n鲸鱼 🐋\n", "中文与 emoji 原样解回");
		for (const entry of entries) {
			assert.equal(entry.crc, wbCrc32(wbUtf8(entry.text)), entry.name + " 的 CRC 必须与正文一致");
		}
	});

	test("空条目列表也给出合法 ZIP（只有 EOCD）", () => {
		const zip = wbBuildZip([]);
		assert.equal(zip.length, 22, "空 ZIP = 22 字节 EOCD");
		assert.deepEqual(unzip(zip), []);
	});

	test("坏条目不抛：缺 name/text 也能打出包", () => {
		const zip = wbBuildZip([{}, { name: "ok.txt", text: "x" }, null]);
		const entries = unzip(zip);
		assert.deepEqual(entries.map((entry) => entry.name), ["entry-0", "ok.txt", "entry-2"]);
	});

	test("README 自己解释自己：列出五个文件、缺哪些、哪些只读", () => {
		const text = wbSnapshotReadme([
			{ name: "projects.json", present: true, readonly: false },
			{ name: "canvas.json", present: true, readonly: true },
			{ name: "handoffs.json", present: true, readonly: false },
			{ name: "events.json", present: false, readonly: false },
			{ name: "proposals.json", present: false, readonly: false }
		]);
		assert.match(text, /projects\.json/);
		assert.match(text, /本次未包含（文件不存在）：events\.json、proposals\.json/);
		assert.match(text, /只读降级状态.*canvas\.json/);
		assert.match(text, /不含任何凭据或密钥/, "数据边界要写在导出物里");
		const allGood = wbSnapshotReadme([
			{ name: "projects.json", present: true, readonly: false },
			{ name: "canvas.json", present: true, readonly: false },
			{ name: "handoffs.json", present: true, readonly: false },
			{ name: "events.json", present: true, readonly: false },
			{ name: "proposals.json", present: true, readonly: false }
		]);
		assert.match(allGood, /本次包含全部五个文件/);
	});

	test("条目挑选：只收 present 的文件，README 恒在末尾", () => {
		const { wbSnapshotEntries } = loadPlugin().plugin.__test;
		const entries = wbSnapshotEntries({
			files: [
				{ name: "projects.json", present: true, data: { projects: { p1: { name: "甲" } } } },
				{ name: "canvas.json", present: false, data: null },
				{ name: "handoffs.json", present: true, data: { entries: [] } },
				{ name: "events.json", present: false, data: null },
				{ name: "proposals.json", present: false, data: null }
			]
		});
		assert.deepEqual(entries.map((entry) => entry.name), ["projects.json", "handoffs.json", "README.txt"]);
		assert.deepEqual(JSON.parse(entries[0].text), { projects: { p1: { name: "甲" } } }, "内容是盘上真源（2 空格缩进 + 末尾换行）");
		assert.match(entries[0].text, /\n$/, "JSON 文件末尾带换行");
		assert.match(entries[2].text, /本次未包含（文件不存在）：canvas\.json、events\.json、proposals\.json/);
		// 坏 payload 不抛：给空条目（只有 README）
		assert.deepEqual(wbSnapshotEntries(undefined).map((entry) => entry.name), ["README.txt"]);
		assert.deepEqual(wbSnapshotEntries({}).map((entry) => entry.name), ["README.txt"]);
		assert.deepEqual(wbSnapshotEntries({ files: "not-array" }).map((entry) => entry.name), ["README.txt"]);
	});

	test("导出流程：读快照 → 打 ZIP → 走到下载这一步（离线环境没有 Blob/URL，如实说清）", async () => {
		const loaded = loadPlugin();
		const api = loaded.plugin.__test;
		// 注入假 fetch（与其它工作台用例同一规矩）：wbExportSnapshot 走 wbApi("/snapshot")
		const payload = {
			generatedAt: Date.now(),
			files: [
				{ name: "projects.json", present: true, readonly: false, backupPath: null, data: { projects: { p1: { name: "甲" } } } },
				{ name: "canvas.json", present: false, readonly: false, backupPath: null, data: null }
			]
		};
		loaded.win.fetch = (url) => {
			assert.match(String(url), /\/agent-whales\/api\/snapshot$/, "请求打到快照路由");
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: payload }) });
		};
		const outcome = await api.wbExportSnapshot().then(() => ({ ok: true }), (error) => ({ ok: false, message: String(error && error.message) }));
		// 离线垫片没有 Blob/URL.createObjectURL：必须走到那一步才失败，且原因说清
		assert.equal(outcome.ok, false, "离线环境下载不了，但不该静默成功");
		assert.match(outcome.message, /下载|ZIP/, "失败原因必须指向真实的那一步，实际：" + outcome.message);
	});
});
