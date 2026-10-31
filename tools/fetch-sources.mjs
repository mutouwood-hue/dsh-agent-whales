/**
 * 从上游重新拉一遍鲸鱼娘素材包，落到本地备用目录。
 *
 * 背景：这批素材有两个先天风险——(1) 仓库里 `.assets-cache/` 是 gitignore 的，
 * 只留了「用到的那 24 张」，一旦本机目录丢了就再也复现不出精灵图；(2) 上游是
 * 个人仓库，授权靠一条 MIT + AI 生成声明，随时可能下架。所以做一份**独立于仓库**
 * 的本地备用，并记录 sha256 与来源，证明「我们跑出来的图确实来自这批源」。
 *
 * 用法：node tools/fetch-sources.mjs [--out <dir>] [--only-used]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "AATINF/deepseek-whale-girl-assets";
const BRANCH = "main";
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const argv = process.argv.slice(2);
const outFlag = argv.indexOf("--out");
const OUT = outFlag >= 0 ? resolve(argv[outFlag + 1]) : join(ROOT, "..", "dsh-agent-whales-assets-backup");
const ONLY_USED = argv.includes("--only-used");
const CONCURRENCY = 6;

/** RFC4180 风格的最小 CSV 解析（manifest.csv 的 prompt 字段里有换行）。 */
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 1;
				} else quoted = false;
			} else field += ch;
			continue;
		}
		if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (ch !== "\r") field += ch;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** art.json 里被真正用到的变体号（source 字段形如 "C12" 或 "Martty:liang-idle.png"）。 */
function usedVariants() {
	const art = JSON.parse(readFileSync(join(ROOT, "assets", "art.json"), "utf8"));
	const used = new Set();
	for (const [key, value] of Object.entries(art.sprites || {})) {
		const source = String(value.source || "");
		if (/^[A-Z]\d+$/i.test(source)) used.add(source.toUpperCase());
		else if (source) console.log(`  (跳过非 AATINF 源：${key} ← ${source})`);
	}
	return used;
}

async function download(url, tries = 4) {
	for (let attempt = 1; attempt <= tries; attempt += 1) {
		try {
			const res = await fetch(url, { redirect: "follow" });
			if (res.status === 404) return { status: 404 };
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { status: 200, buf: Buffer.from(await res.arrayBuffer()) };
		} catch (error) {
			if (attempt === tries) return { status: 0, error: String(error) };
			await new Promise((r) => setTimeout(r, 300 * attempt));
		}
	}
	return { status: 0, error: "unreachable" };
}

async function main() {
	const manifestPath = join(OUT, "_meta", "manifest.csv");
	if (!existsSync(manifestPath)) {
		console.error(`缺少上游清单：${manifestPath}`);
		process.exit(1);
	}
	const rows = parseCsv(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
	const header = rows.shift().map((name) => name.replace(/^\uFEFF/, "").trim());
	const idxId = header.indexOf("变体号");
	const idxContent = header.indexOf("内容");
	const idxSize = header.indexOf("尺寸");
	const entries = rows
		.filter((r) => r.length > idxId && /^[A-Z]\d+$/i.test((r[idxId] || "").trim()))
		.map((r) => ({ id: r[idxId].trim().toUpperCase(), content: r[idxContent] || "", size: r[idxSize] || "" }));

	const used = usedVariants();
	const targets = ONLY_USED ? entries.filter((e) => used.has(e.id)) : entries;
	console.log(`上游清单 ${entries.length} 条；本次拉取 ${targets.length} 条（ONLY_USED=${ONLY_USED}）；输出 ${OUT}`);

	const dir = join(OUT, "share-1600");
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(OUT, "_meta"), { recursive: true });

	const results = [];
	let done = 0;
	const queue = [...targets];

	async function worker() {
		for (;;) {
			const entry = queue.shift();
			if (!entry) return;
			const url = `${BASE}/share-1600/${entry.id}.jpg`;
			const got = await download(url);
			done += 1;
			if (got.status === 200) {
				const path = join(dir, `${entry.id}.jpg`);
				writeFileSync(path, got.buf);
				const cached = join(ROOT, ".assets-cache", `${entry.id}.jpg`);
				const cacheMatch = existsSync(cached) ? sha256(readFileSync(cached)) === sha256(got.buf) : undefined;
				results.push({
					id: entry.id,
					content: entry.content,
					size: entry.size,
					bytes: got.buf.length,
					sha256: sha256(got.buf),
					used: used.has(entry.id),
					cacheMatch,
					url
				});
			} else {
				results.push({ id: entry.id, used: used.has(entry.id), error: got.error || `status ${got.status}`, url });
			}
			if (done % 10 === 0 || done === targets.length) process.stdout.write(`\r  进度 ${done}/${targets.length}`);
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	process.stdout.write("\n");

	results.sort((a, b) => a.id.localeCompare(b.id));
	const ok = results.filter((r) => !r.error);
	const failed = results.filter((r) => r.error);
	const missingUsed = [...used].filter((id) => !ok.some((r) => r.id === id));
	const cacheMismatch = ok.filter((r) => r.cacheMatch === false);

	const now = new Date().toISOString();
	const meta = {
		source: `${BASE}/share-1600/{variant}.jpg`,
		upstreamRepo: `https://github.com/${REPO}`,
		branch: BRANCH,
		fetchedAt: now,
		fetchedBy: "DSH agent（回上游重拉，做本地备用）",
		manifestBytes: readFileSync(manifestPath).length,
		totalFromManifest: entries.length,
		requested: targets.length,
		downloaded: ok.length,
		failed: failed.length,
		usedVariants: [...used].sort(),
		usedMissing: missingUsed,
		cacheMismatch: cacheMismatch.map((r) => r.id),
		files: results
	};
	writeFileSync(join(OUT, "_meta", "sources-manifest.json"), JSON.stringify(meta, null, "\t"), "utf8");

	const totalBytes = ok.reduce((s, r) => s + r.bytes, 0);
	console.log(`\n下载成功 ${ok.length}/${targets.length}，合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
	console.log(`缓存复验：${ok.filter((r) => r.cacheMatch === true).length} 张与 .assets-cache 逐字节一致；不一致 ${cacheMismatch.length} 张`);
	if (failed.length) {
		console.log(`失败 ${failed.length} 条：`);
		for (const row of failed.slice(0, 20)) console.log(`  - ${row.id} (${row.used ? "在用" : "备用"}): ${row.error}`);
	}
	if (missingUsed.length) console.log(`⚠ 在用的变体没拉到：${missingUsed.join(", ")}`);
	process.exit(failed.length && missingUsed.length ? 1 : 0);
}

await main();
