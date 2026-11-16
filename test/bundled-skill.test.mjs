/**
 * 随包协议 skill：`parseSkillFrontmatter` 纯函数 + `createBundledSkillProvider` 提供者，
 * 以及「SKILL.md 真的随包分发、frontmatter 合法」的发布门禁。
 *
 * 借形 fengshenx/dsh-leader-agent 的 src/host/skills.js + shared/frontmatter.js（MIT）——
 * 只搬「协议层随 bundle 分发、模型按需加载」这个形状；上游那套缩进嵌套 map（槽位元数据）
 * 鲸鱼没有对应物，不搬。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseSkillFrontmatter, createBundledSkillProvider } from "../lib/index.js";
import * as host from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");

// host.apply 会顺手装 worker preset：不把目标根指到临时目录就会往真实 ~/.dsh 写文件。
process.env.DSH_AGENT_WHALES_PRESET_DIR = mkdtempSync(join(tmpdir(), "aw-skill-presets-"));

describe("parseSkillFrontmatter", () => {
	test("三个顶层标量 + 正文分开", () => {
		const { data, body } = parseSkillFrontmatter(
			"---\nname: whales-project-playbook\ndescription: 项目协作协议手册——派活/盯进度/留记忆/串门。\n---\n\n# 标题\n\n正文第一段。\n"
		);
		assert.deepEqual(data, {
			name: "whales-project-playbook",
			description: "项目协作协议手册——派活/盯进度/留记忆/串门。"
		});
		assert.equal(body, "# 标题\n\n正文第一段。\n");
	});

	test("成对引号剥掉；引号外的行内注释剥掉（与 YAML 一致），引号内的 # 保留", () => {
		const { data } = parseSkillFrontmatter(
			'---\nname: "quoted-name"\ndescription: \'单引号描述\'\nwhenToUse: 带 # 号的说明 # 这里是注释\n---\n正文\n'
		);
		assert.equal(data.name, "quoted-name");
		assert.equal(data.description, "单引号描述");
		// 与 YAML 同一条规则：引号外的「空格 + #」之后是注释。描述里要出现 # 必须加引号，
		// 否则会被截断——截断的 description 会让 skill 在目录里发现不了。
		assert.equal(data.whenToUse, "带", "未加引号的 # 之后按注释剥掉");
		const kept = parseSkillFrontmatter('---\ndescription: "描述里有 # 井号"\n---\n');
		assert.equal(kept.data.description, "描述里有 # 井号", "引号内的 # 属于内容");
	});

	test("没有 frontmatter / 只有开头 ---：全文当正文，data 为空", () => {
		const plain = parseSkillFrontmatter("# 没有 frontmatter\n\n正文。\n");
		assert.deepEqual(plain.data, {});
		assert.equal(plain.body, "# 没有 frontmatter\n\n正文。\n");
		const broken = parseSkillFrontmatter("---\nname: x\n没有结尾\n");
		assert.deepEqual(broken.data, {});
		assert.equal(broken.body, "---\nname: x\n没有结尾\n");
	});

	test("CRLF 归一；空值与注释行跳过；非字符串输入不抛", () => {
		const { data, body } = parseSkillFrontmatter("---\r\nname: crlf-skill\r\ndescription: 描述\r\n# 注释行\r\nempty:\r\n---\r\n\r\n正文\r\n");
		assert.equal(data.name, "crlf-skill");
		assert.equal(data.description, "描述");
		assert.equal(data.empty, undefined, "空值不当字段");
		assert.equal(body, "正文\n", "CRLF 统一归一成 LF（Windows 上手写 SKILL.md 是常态）");
		assert.deepEqual(parseSkillFrontmatter(undefined), { data: {}, body: "" });
		assert.deepEqual(parseSkillFrontmatter(42).data, {});
	});
});

describe("createBundledSkillProvider", () => {
	/** 造一个临时 skills 根，写若干个 <name>/SKILL.md。 */
	function withSkillsRoot(files) {
		const dir = mkdtempSync(join(tmpdir(), "aw-skill-root-"));
		const root = pathToFileURL(join(dir, "skills") + "\\");
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(join(dir, "skills", name), { recursive: true });
			writeFileSync(join(dir, "skills", name, "SKILL.md"), text, "utf8");
		}
		return { dir, root };
	}

	const GOOD = "---\nname: good-skill\ndescription: 好 skill 的描述。\n---\n\n# 正文\n\n第一段。\n";
	const BAD_NAME = "---\nname: Bad_Name\ndescription: 名字不合法。\n---\n\n正文\n";
	const NO_DESC = "---\nname: no-desc\n---\n\n正文\n";

	test("list 只收合法候选：kebab-case 名 + 非空 description", () => {
		const { dir, root } = withSkillsRoot({ "good-skill": GOOD, "bad-name": BAD_NAME, "no-desc": NO_DESC });
		try {
			const provider = createBundledSkillProvider({ skillsRoot: root, providerName: "dsh-agent-whales" });
			const candidates = provider.list();
			assert.equal(candidates.length, 1, "只有一个合法候选");
			const candidate = candidates[0];
			assert.equal(candidate.name, "good-skill");
			assert.equal(candidate.provider, "dsh-agent-whales");
			assert.equal(candidate.source, "bundled");
			assert.equal(candidate.rank, 600, "bundle 副本 rank 600：项目副本（200）能覆盖它");
			assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
			assert.ok(candidate.path.endsWith("SKILL.md"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("get 返回正文与最新 description；locator 坏了给 undefined 而不抛", () => {
		const { dir, root } = withSkillsRoot({ "good-skill": GOOD });
		try {
			const provider = createBundledSkillProvider({ skillsRoot: root, providerName: "p" });
			const candidate = provider.list()[0];
			const loaded = provider.get(candidate);
			assert.equal(loaded.content, "# 正文\n\n第一段。");
			assert.equal(loaded.description, "好 skill 的描述。");
			assert.equal(provider.get({}), undefined, "没有 locator 的候选读不了");
			assert.equal(provider.get({ locator: { directory: join(dir, "gone") } }), undefined, "目录没了也安静返回");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("skills 根读不到：告警并返回空列表（不抛，不连累别的 provider）", () => {
		const warnings = [];
		const provider = createBundledSkillProvider({
			skillsRoot: pathToFileURL(join(tmpdir(), "aw-skill-missing-" + Math.random().toString(36).slice(2)) + "\\"),
			providerName: "p",
			logger: (message) => warnings.push(message)
		});
		assert.deepEqual(provider.list(), []);
		assert.equal(warnings.length, 1, "缺件必须告警——否则协议层凭空消失没有任何信号");
		assert.match(warnings[0], /读不到随包 skill 目录/);
	});

	test("仓库里的 SKILL.md 自身合法（发布门禁：包内副本必须能被宿主发现）", () => {
		const text = readFileSync(join(pluginDir, "skills", "whales-project-playbook", "SKILL.md"), "utf8");
		const { data, body } = parseSkillFrontmatter(text);
		assert.match(data.name || "", /^[a-z0-9]+(-[a-z0-9]+)*$/, "skill 名必须 kebab-case");
		assert.ok((data.description || "").length > 0, "description 不能空");
		assert.equal(data.name, "whales-project-playbook", "目录名与 frontmatter 的 name 必须一致");
		assert.ok(body.includes("# 鲸鱼项目协作协议"), "正文不能空");
		// provider 直接读仓库副本也要能发现（等于验证 files 白名单漏项时的症状）
		const provider = createBundledSkillProvider({ skillsRoot: pathToFileURL(join(pluginDir, "skills") + "\\"), providerName: "dsh-agent-whales" });
		const names = provider.list().map((candidate) => candidate.name);
		assert.deepEqual(names, ["whales-project-playbook"]);
	});
});

describe("随包 skill 注册进宿主", () => {
	test("skills 服务就绪：provider 注册进去，卸载 disposer 挂进 ctx.effect", () => {
		// 假宿主不给 ctx.inject：whenService 退化成立即执行，注册同步发生（与「服务晚到」
		// 的差别只在时序，注册内容一致）。
		const registered = [];
		const disposed = [];
		const cleanups = [];
		host.apply({
			get: (name) => {
				if (name === "skills") {
					return {
						registerProvider: (provider) => {
							registered.push(provider);
							return () => disposed.push(provider.name);
						}
					};
				}
				return undefined;
			},
			// cordis 语义：effect 体立即跑一次，返回值是卸载时的清理函数。
			effect: (run) => { const cleanup = run(); if (typeof cleanup === "function") cleanups.push(cleanup); return cleanup; },
			on: () => () => {}
		});
		assert.equal(registered.length, 1, "apply 后 provider 必须注册");
		const provider = registered[0];
		assert.equal(provider.name, "dsh-agent-whales", "provider 名 = 包名（用户对得上来源）");
		const candidates = provider.list();
		assert.deepEqual(candidates.map((candidate) => candidate.name), ["whales-project-playbook"]);
		// 卸载真的会发生：清理函数倒序跑（后注册的先清理）
		assert.ok(cleanups.length > 0, "必须把 disposer 挂到 ctx.effect，否则热重载会重复注册");
		for (const cleanup of cleanups.slice().reverse()) cleanup();
		assert.deepEqual(disposed, ["dsh-agent-whales"], "插件卸载时 provider 必须被摘掉");
	});

	test("宿主没有 skills 服务 / registerProvider 不是函数 / 它抛错：都不抛", () => {
		assert.doesNotThrow(() => host.apply({ get: () => undefined, effect: (run) => run(), on: () => () => {} }));
		assert.doesNotThrow(() => host.apply({
			get: (name) => (name === "skills" ? {} : undefined),
			effect: (run) => run(),
			on: () => () => {}
		}));
		assert.doesNotThrow(() => host.apply({
			get: (name) => (name === "skills" ? { registerProvider: () => { throw new Error("boom"); } } : undefined),
			effect: (run) => run(),
			on: () => () => {}
		}));
	});
});
