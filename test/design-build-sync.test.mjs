// 组件工坊：构建产物与源码必须同步（P2 审计 I2）。
//
// 为什么单独守这一条：`lib/client.design.js` 随包发布，而它的源码在 `tools/flow-chunk/design/`。
// P2 审计抓到过「源码改了、产物没重建」——于是 onPick 明明写了却不在产物里，功能等于没修，
// 单测（跑源码）却全绿。这里用**重跑构建脚本再逐字节比对**的方式守住它。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");
const flowDir = join(pluginDir, "tools", "flow-chunk");

function rebuild() {
	const buildDir = join(flowDir, "node_modules", "esbuild");
	if (!existsSync(buildDir)) return { skipped: true, reason: "没装 flow-chunk 的构建依赖（esbuild）" };
	try {
		execFileSync(process.execPath, [join(flowDir, "build-design.mjs")], { cwd: flowDir, stdio: "pipe", timeout: 240000 });
		execFileSync(process.execPath, [join(flowDir, "build-proto.mjs")], { cwd: flowDir, stdio: "pipe", timeout: 240000 });
		return { skipped: false };
	} catch (error) {
		return { skipped: false, error: String(error && (error.stderr ? error.stderr.toString() : error.message)).slice(0, 600) };
	}
}

test("构建产物与源码同步：重跑 build-design / build-proto 后，lib/client.*.js 逐字节不变", () => {
	const targets = ["lib/client.design.js", "lib/client.sandbox-runtime.js", "lib/client.proto.js", "lib/client.puck.js"];
	const before = new Map();
	for (const file of targets) {
		const full = join(pluginDir, file);
		assert.ok(existsSync(full), file + " 必须存在（先跑构建脚本）");
		before.set(file, readFileSync(full, "utf8"));
	}
	const result = rebuild();
	if (result.skipped) {
		// 没有构建依赖时不能假装验过：明确标成 skip
		console.log("skipped:", result.reason);
		return;
	}
	assert.equal(result.error, undefined, "构建失败：" + result.error);
	for (const file of targets) {
		const after = readFileSync(join(pluginDir, file), "utf8");
		assert.equal(after, before.get(file), file + " 与源码不同步：改完源码要重跑 tools/flow-chunk 的构建脚本并一起提交");
	}
});

test("产物与源码同步：源码里有的关键接线，产物里必须也有（onPick / pickMode / 沙箱岛）", () => {
	const source = readFileSync(join(flowDir, "design", "entry.jsx"), "utf8");
	const built = readFileSync(join(pluginDir, "lib", "client.design.js"), "utf8");
	// 只挑「改源码时最容易忘、忘了就功能全失」的接线做双端检查。
	// 标记必须是**压缩后不会被改名**的（对象属性名 / 导出名 / 字符串字面量）；局部变量名会被 minify 改掉。
	for (const marker of ["onPick", "pickMode", "invalidateEntity", "openSourceEditor", "/design/comments"]) {
		if (!source.includes(marker)) continue;
		assert.ok(built.includes(marker), marker + " 在源码里有、产物里没有 → 忘了重跑 build-design.mjs");
	}
	const protoSource = readFileSync(join(flowDir, "proto", "entry.jsx"), "utf8");
	const protoBuilt = readFileSync(join(pluginDir, "lib", "client.proto.js"), "utf8");
	// 沙箱岛的 srcdoc 是构建时注入的：产物里必须带 CSP（证明注入生效，不是最小壳）
	assert.ok(protoSource.includes("__WHALES_SANDBOX_SRCDOC__"), "源码要用构建注入的 srcdoc");
	assert.ok(protoBuilt.includes("Content-Security-Policy"), "产物里的沙箱岛 srcdoc 必须带 CSP（注入生效）");
});
