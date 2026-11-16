// 数据根口径回归：DSH_HOME 解析必须与宿主 `@deepseek-ai/dsh-home-paths` 逐条一致。
//
// 为什么单开一个文件：这条契约坏了**没有报错**——数据悄悄写到另一个目录，用户看到的是
// 「项目/画布/简报全部消失」，而插件一切正常。2026-11-16 之前本插件写死 homedir()，
// 开发实例（DSH_HOME 指到工作树内的 .dev/home）会直接写用户真实的 ~/.dsh。
//
// 契约来源：fengshenx/dsh-leader-agent 的 src/host/home-paths.js（MIT，语义照抄，
// 不 import 宿主包）。规则：
//   · 空或纯空白 → 未设，回落 <homedir>/.dsh；
//   · `~`、`~/`、`~\` 前缀 → 家目录展开；`~user/x` 不展开；
//   · 其余一律 resolve（相对路径按进程 cwd、去尾分隔符、归一化 . 与 ..）；
//   · 只用 trim 判空、取值仍用原值（带首尾空白时宿主算的是另一条路径）。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import { resolveDshHome, expandHomePath, proposalStoreFileForTests, workerPresetRootForTests } from "../lib/index.js";

const HOME = "/home/tester";

describe("resolveDshHome：与宿主口径一致", () => {
	test("未设置 → 回落 <homedir>/.dsh", () => {
		assert.equal(resolveDshHome({}, () => HOME), resolve(join(HOME, ".dsh")));
	});

	test("空串与纯空白都按未设处理", () => {
		assert.equal(resolveDshHome({ DSH_HOME: "" }, () => HOME), resolve(join(HOME, ".dsh")));
		assert.equal(resolveDshHome({ DSH_HOME: "   " }, () => HOME), resolve(join(HOME, ".dsh")));
		assert.equal(resolveDshHome({ DSH_HOME: "\t\n" }, () => HOME), resolve(join(HOME, ".dsh")));
	});

	test("单独 ~ 与 ~/ 、~\\ 前缀按家目录展开", () => {
		assert.equal(resolveDshHome({ DSH_HOME: "~" }, () => HOME), resolve(HOME));
		assert.equal(resolveDshHome({ DSH_HOME: "~/dsh" }, () => HOME), resolve(join(HOME, "dsh")));
		assert.equal(resolveDshHome({ DSH_HOME: "~\\dsh" }, () => HOME), resolve(join(HOME, "dsh")));
	});

	test("~user/x 不展开，按普通相对路径解析（宿主同结果）", () => {
		assert.equal(expandHomePath("~user/x", HOME, "/cwd"), resolve("/cwd", "~user/x"));
	});

	test("绝对路径原样解析", () => {
		assert.equal(resolveDshHome({ DSH_HOME: "/abs/root" }, () => HOME), resolve("/abs/root"));
	});

	test("相对路径按进程 cwd 解析，并归一化 . 与 ..", () => {
		// expandHomePath 收 cwd 参数，适合钉死基准；resolveDshHome 用进程 cwd（宿主口径）。
		assert.equal(expandHomePath("rel/dir", HOME, "/cwd"), resolve("/cwd", "rel/dir"));
		assert.equal(expandHomePath("./a/../b", HOME, "/cwd"), resolve("/cwd", "b"));
		assert.equal(resolveDshHome({ DSH_HOME: "rel/dir" }, () => HOME), resolve(process.cwd(), "rel/dir"));
	});

	test("首尾空白只用于判空，取值仍用原值（照抄宿主，否则两边算的不是同一个目录）", () => {
		assert.equal(expandHomePath("  /data/root  ", HOME, "/cwd"), resolve("/cwd", "  /data/root  "));
		assert.notEqual(expandHomePath("  /data/root  ", HOME, "/cwd"), resolve("/cwd", "/data/root"));
		// 同一个值走 resolveDshHome：cwd 取进程 cwd，结论与 expandHomePath 一致。
		assert.equal(
			resolveDshHome({ DSH_HOME: "  /data/root  " }, () => HOME),
			resolve(process.cwd(), "  /data/root  ")
		);
	});
});

describe("默认落点跟随 DSH_HOME", () => {
	// 汇总执行（test/index.js）时与其它用例同进程：index.test.mjs 会设
	// DSH_AGENT_WHALES_PRESET_DIR，e2e-http 可能设 PROPOSAL_FILE——探针要的是「默认值」，
	// 所以两个覆盖变量都临时清掉，在**断言之前**把两个落点读出来，结束后原样还回去。
	// （preset 根是每次调用现算的，store 文件是模块加载时定死的：两者都得在清空窗口内读。）
	async function probeDefaults(env, tag) {
		const saved = {};
		for (const key of ["DSH_HOME", "DSH_AGENT_WHALES_PRESET_DIR", "DSH_AGENT_WHALES_PROPOSAL_FILE"]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		if (env.DSH_HOME !== undefined) process.env.DSH_HOME = env.DSH_HOME;
		try {
			const fresh = await import(`../lib/index.js?dsh-home-probe=${tag}`);
			return {
				proposalStoreFile: fresh.proposalStoreFileForTests(),
				presetRoot: fresh.workerPresetRootForTests()
			};
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	test("模块加载时读到的 DSH_HOME 决定默认存储文件与 preset 根", async () => {
		const custom = join(resolve(process.cwd()), ".tmp-home-paths");
		const probed = await probeDefaults({ DSH_HOME: custom }, encodeURIComponent(custom));
		const root = resolve(custom);
		assert.equal(probed.proposalStoreFile, join(root, "agent-whales", "proposals.json"));
		assert.equal(probed.presetRoot, join(root, ".agent-presets"));
	});

	test("DSH_HOME 未设时默认仍是 <homedir>/.dsh（不改变老用户的落点）", async () => {
		const probed = await probeDefaults({}, "default");
		const root = resolve(join(homedir(), ".dsh"));
		assert.equal(probed.proposalStoreFile, join(root, "agent-whales", "proposals.json"));
		assert.equal(probed.presetRoot, join(root, ".agent-presets"));
	});
});
