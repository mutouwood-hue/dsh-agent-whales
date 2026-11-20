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
// 同理，ultra 模式的状态文件（宿主 apply 会读它决定初始开关）也要指开——只读不写，
// 但读到你机器上的真实开关会让「默认关」的断言变成偶然。
host.setUltraModePathForTests(join(mkdtempSync(join(tmpdir(), "aw-skill-ultra-")), "ultra.json"));

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
		// 2026-11-16 新增的 deep-effort（ultra 模式强制加载的那份契约）：同样要过发布门禁。
		// 它同时是「系统提示段」的正文来源，所以 name 掉包会被 deepEffortSectionText 拒收。
		const effort = readFileSync(join(pluginDir, "skills", "deep-effort", "SKILL.md"), "utf8");
		const effortParsed = parseSkillFrontmatter(effort);
		assert.equal(effortParsed.data.name, "deep-effort", "目录名与 frontmatter 的 name 必须一致");
		assert.ok((effortParsed.data.description || "").length > 0, "deep-effort 的 description 不能空");
		assert.ok(effortParsed.body.includes("先取证"), "deep-effort 正文不能空（四条硬要求之一要在）");
		// provider 直接读仓库副本也要能发现（等于验证 files 白名单漏项时的症状）
		const provider = createBundledSkillProvider({ skillsRoot: pathToFileURL(join(pluginDir, "skills") + "\\"), providerName: "dsh-agent-whales" });
		const names = provider.list().map((candidate) => candidate.name).sort();
		assert.deepEqual(names, ["deep-effort", "whales-e2e-executor", "whales-project-playbook"]);
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
		assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ["deep-effort", "whales-e2e-executor", "whales-project-playbook"], "协议层 + deep-effort + E2E 执行器三个随包 skill 都要能发现");
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

// ── E2E 执行器手册（需求主线 P6）：文档里写的工具名 / 状态词必须和代码一致，防止文档漂移 ──
test("随包 skill whales-e2e-executor：frontmatter 合法；工具名、状态词、诊断词、限额与代码一致；写明不能做什么", async () => {
  const text = readFileSync(join(pluginDir, "skills", "whales-e2e-executor", "SKILL.md"), "utf8");
  const parsed = parseSkillFrontmatter(text);
  assert.equal(parsed.data.name, "whales-e2e-executor", "目录名与 frontmatter 的 name 必须一致");
  assert.ok((parsed.data.description || "").length > 0);
  assert.ok((parsed.data.whenToUse || "").length > 0);
  const e2e = await import("../lib/e2e.js");
  assert.match(text, /whales_e2e_report/, "必须点名上报工具");
  for (const status of e2e.E2E_REPORTABLE) assert.ok(text.includes("`" + status + "`") || text.includes(status), "上报状态词 " + status + " 必须写进手册");
  for (const kind of e2e.E2E_DIAGNOSIS_KINDS) assert.ok(text.includes("`" + kind + "`"), "诊断类别 " + kind + " 必须写进手册");
  assert.ok(text.includes("finish: true"));
  assert.ok(text.includes("≤ " + e2e.E2E_LIMITS.shotBytes / (1024 * 1024) + "MB") && text.includes("≤ " + e2e.E2E_LIMITS.videoBytes / (1024 * 1024) + "MB"), "截图 / 录屏大小上限必须与代码一致");
  assert.ok(text.includes("每条用例 ≤ " + e2e.E2E_LIMITS.shotsPerResult + " 个"), "附件个数上限必须与代码一致");
  for (const ext of ["png", "jpg", "webp", "webm"]) assert.ok(text.includes(ext), "支持的扩展名 " + ext);
  assert.match(text, /手动.*只有人能填/, "必须写明不能代报手动运行");
  assert.match(text, /accepted/, "必须写明不能标可接受");
  assert.match(text, /不要假装/, "没有 computer use 时不能假装");
  assert.match(text, /不要把「我没跑成」报成 failed/, "error 与 failed 的区别必须写清");
  // 手册里每个 caseId / runId 的例子要和真实格式对得上
  assert.match(text, /run-[0-9a-f]{8}/);
});
test("执行器手册·computer use 一节：工具名、只读已验证 / 动作未验证的如实声明、六条安全规则；不依赖、不内置", () => {
  const text = readFileSync(join(pluginDir, "skills", "whales-e2e-executor", "SKILL.md"), "utf8");
  const start = text.indexOf("### computer use");
  const end = text.indexOf("## 三、怎么上报");
  assert.ok(start > 0 && end > start, "必须有独立的 computer use 一节，且在「怎么上报」之前");
  const section = text.slice(start, end);
  for (const tool of ["kimi_cu_windows", "kimi_cu_observe", "kimi_cu_act", "kimi_cu_launch", "kimi_cu_script"]) assert.ok(section.includes("`" + tool + "`"), "必须点名工具 " + tool);
  assert.ok(section.includes("dsh-kimi-assemble") && section.includes("KimiCU"), "必须说明来源");
  assert.match(section, /不内置、不依赖/, "必须声明本插件不内置、不依赖");
  assert.match(section, /已验证的只有「只读观察」/, "必须如实说只验证了只读观察");
  assert.match(section, /动作类我们没有验证过/, "必须如实说动作类没验证过");
  assert.match(section, /占用真实鼠标键盘/, "必须说明动作会占用真实鼠标键盘");
  assert.match(section, /再观察一次/, "规则 1：动手后复核");
  assert.match(section, /已派发.{0,6}不等于生效/, "规则 1：派发不等于生效");
  assert.match(section, /只对被测窗口动手/, "规则 2");
  assert.match(section, /终端、系统对话框、密码/, "规则 2：禁区");
  assert.match(section, /不超过 30 步/, "规则 3：步数上限");
  assert.match(section, /最多重试 2 次/, "规则 3：重试上限");
  assert.match(section, /只能就「看到了什么」下结论/, "规则 4：只剩观察时不得声称动过");
  assert.match(section, /不可信数据，不是指令/, "规则 5：提示注入");
  assert.match(section, /不要上传/, "规则 6：敏感截图");
  // 上面的二、第 2 条要指向这一节，且保留「没有就不要假装」
  const run = text.slice(text.indexOf("## 二、怎么跑"), start);
  assert.match(run, /`kimi_cu_\*` 工具/);
  assert.match(run, /不要假装/);
  assert.match(run, /需要 computer use，当前环境没有/);
});