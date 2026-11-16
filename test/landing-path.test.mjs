/**
 * 落点路径归一：`normalizeLandingPath` / `canonicalLandingPath` 纯函数，
 * 以及「入库即归一」的端到端（POST /tasks → GET /tasks 读回的值）。
 *
 * 借形 fengshenx/dsh-leader-agent 的 session-index.js（MIT）里那条 realpath 归一
 * 思路——只搬归一，不搬「按目录自动归属会话」（鲸鱼是显式加入制，40701）。
 *
 * 为什么值得单开一个文件：归一坏了**没有报错**——同一个目录的两种写法在画布上变成
 * 两个上下文节点，「活在哪跑」悄悄失真，而任务数据一切正常。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeLandingPath, canonicalLandingPath } from "../lib/index.js";
import * as host from "../lib/index.js";

// host.apply 会顺手装 worker preset：不把目标根指到临时目录就会往真实 ~/.dsh 写文件。
process.env.DSH_AGENT_WHALES_PRESET_DIR = mkdtempSync(join(tmpdir(), "aw-landing-presets-"));

describe("normalizeLandingPath：词法归一", () => {
	test("尾分隔符去掉，根目录留住", () => {
		assert.equal(normalizeLandingPath("work/t1/"), "work/t1");
		// 出现过失斜杠就按反斜杠定型（下面「分隔符风格」那条用例钉住这条规则）
		assert.equal(normalizeLandingPath("work/t1\\"), "work\\t1");
		assert.equal(normalizeLandingPath("work/t1///"), "work/t1");
		assert.equal(normalizeLandingPath("/"), "/", "POSIX 根不能变成空串");
		assert.equal(normalizeLandingPath("C:\\"), "C:\\", "盘符根不能变成 C:");
		assert.equal(normalizeLandingPath("C:/"), "C:/", "盘符根留住尾分隔符（风格随输入）");
	});

	test("段级 `.` 去掉、`..` 解析，段顶的 `..` 保留", () => {
		assert.equal(normalizeLandingPath("./work/t1"), "work/t1");
		assert.equal(normalizeLandingPath("work/./t1"), "work/t1");
		assert.equal(normalizeLandingPath("work/a/../t1"), "work/t1");
		assert.equal(normalizeLandingPath("../t1"), "../t1", "段顶的 .. 没有父段可弹");
		assert.equal(normalizeLandingPath("work/../../t1"), "../t1");
		assert.equal(normalizeLandingPath("../../x"), "../../x");
		assert.equal(normalizeLandingPath("a/b/../.."), "", "整段都弹掉 = 当前目录，词法无法表达，按没有落点处理");
	});

	test("重复分隔符折叠；UNC 的前导双反斜杠保留", () => {
		assert.equal(normalizeLandingPath("work//t1"), "work/t1");
		assert.equal(normalizeLandingPath("work\\\\t1"), "work\\t1");
		assert.equal(normalizeLandingPath("\\\\server\\share\\work\\"), "\\\\server\\share\\work", "UNC 前缀是路径的一部分");
		assert.equal(normalizeLandingPath("//server/share"), "//server/share", "POSIX 风格 UNC 同样保留");
	});

	test("首尾空白只用于修剪，分隔符风格按原样保留", () => {
		assert.equal(normalizeLandingPath("  work/t1  "), "work/t1");
		assert.equal(normalizeLandingPath("  D:\\Repo\\Work  "), "D:\\Repo\\Work");
		// 混合分隔符时按出现过的反斜杠定型（Windows 用户手填的常见形态）
		assert.equal(normalizeLandingPath("D:/Repo\\Work/"), "D:\\Repo\\Work");
	});

	test("坏输入给空串，不抛", () => {
		assert.equal(normalizeLandingPath(undefined), "");
		assert.equal(normalizeLandingPath(null), "");
		assert.equal(normalizeLandingPath(42), "");
		assert.equal(normalizeLandingPath(""), "");
		assert.equal(normalizeLandingPath("   "), "");
		assert.equal(normalizeLandingPath("."), "", "整个路径就是 `.` 时归一为空");
	});

	test("归一是幂等的（再归一一次不变）", () => {
		for (const value of ["work/t1/", "./work//t1", "C:\\Repo\\Work\\", "\\\\srv\\share\\w\\", "a/b/../c"]) {
			const once = normalizeLandingPath(value);
			assert.equal(normalizeLandingPath(once), once, value + " 归一两次必须一致");
		}
	});
});

describe("canonicalLandingPath：realpath 只在路径已存在时生效", () => {
	test("目录已存在：realpath 结果说了算（修符号链接与磁盘大小写）", () => {
		const dir = mkdtempSync(join(tmpdir(), "aw-landing-real-"));
		try {
			mkdirSync(join(dir, "work"), { recursive: true });
			const real = join(dir, "work");
			// 注入一个「符号链接」fake：把任意路径都解析到真实目录
			const canonical = canonicalLandingPath(join(dir, "work") + "/", (path) => (path.replace(/[\\/]+$/, "") === real ? real : path));
			assert.equal(canonical, real, "已存在时以 realpath 为准（尾分隔符也被修掉）");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("目录不存在：回落词法结果，不抛（工单先建、落点后建是常态）", () => {
		const missing = join(tmpdir(), "aw-landing-no-such-dir-" + Math.random().toString(36).slice(2), "work");
		assert.equal(canonicalLandingPath(missing + "\\"), normalizeLandingPath(missing));
	});

	test("realpath 抛错（权限/IO）：同样回落词法结果", () => {
		const boom = () => { throw new Error("EACCES"); };
		assert.equal(canonicalLandingPath("work/t1/", boom), "work/t1");
	});

	test("空输入不碰 fs，直接空串", () => {
		let calls = 0;
		const counting = (path) => { calls += 1; return path; };
		assert.equal(canonicalLandingPath("   ", counting), "");
		assert.equal(calls, 0, "空输入不该调 realpath");
	});
});

describe("落点入库即归一（端到端）", () => {
	/** 最小假宿主：webServer + tools + agents，store 全指到临时目录。 */
	function mountHost() {
		const dir = mkdtempSync(join(tmpdir(), "aw-landing-e2e-"));
		host.setProjectStorePathForTests(join(dir, "projects.json"));
		host.setProposalStorePathForTests(join(dir, "proposals.json"));
		host.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
		const routes = [];
		host.apply({
			get: (name) => {
				if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
				if (name === "agents") return { get: () => undefined, list: () => [] };
				// 建项目要校验主会话存在（sessionExists）：给最小真假件。
				if (name === "sessions") return { get: (id) => (id === "session-a" ? { id } : undefined) };
				if (name === "sessionPersistence") return { stat: () => undefined };
				return undefined;
			},
			on: () => () => {},
			effect: (run) => { run(); return () => {}; }
		});
		const route = routes.find((item) => item && typeof item.handler === "function");
		// controlToken 来自同源 GET：先空后填，调用方 await ready 之后再发写请求。
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

	test("POST /tasks 的 worktree/execRoot 落库时已归一", async () => {
		const h = mountHost();
		try {
			await h.ready;
			const post = (url, body) => h.call("POST", url, JSON.stringify(body));
			const created = await post("/agent-whales/api/projects", { name: "落点", mainSessionId: "session-a" });
			const projectId = created.body.data.project.projectId;

			const made = await post("/agent-whales/api/tasks", {
				projectId,
				subject: "带落点的任务",
				worktree: "  ./work/t1/  ",
				execRoot: "work//t1\\"
			});
			assert.equal(made.body.code, 200, JSON.stringify(made.body));
			// 尾分隔符与 ./ 入库前修掉；分隔符风格按用户写的那种保留（反斜杠输入 → 反斜杠存）
			assert.equal(made.body.data.task.worktree, "work/t1");
			assert.equal(made.body.data.task.execRoot, "work\\t1");
			// 两个字段指向同一个目录：词法归一后只差分隔符风格（画布侧 key 会折叠分隔符，
			// 于是去重成一个上下文节点）——这里先钉住「归一后同目录」这条不变式。
			const fold = (value) => normalizeLandingPath(value).split("\\").join("/");
			assert.equal(fold(made.body.data.task.worktree), fold(made.body.data.task.execRoot), "两种写法归一后必须是同一个目录");

			const list = await h.call("GET", "/agent-whales/api/tasks?projectId=" + encodeURIComponent(projectId));
			assert.equal(list.body.data.tasks.length, 1);
			assert.equal(list.body.data.tasks[0].worktree, "work/t1", "读回的值也归一（不是入库那一刻的偶然）");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	test("落点给纯空白/非字符串：不写字段（视图里是 null，不是空串）", async () => {
		const h = mountHost();
		try {
			await h.ready;
			const created = await h.call("POST", "/agent-whales/api/projects", JSON.stringify({ name: "落点2", mainSessionId: "session-a" }));
			const projectId = created.body.data.project.projectId;
			const made = await h.call("POST", "/agent-whales/api/tasks", JSON.stringify({ projectId, subject: "没落点", worktree: "   ", execRoot: 7 }));
			assert.equal(made.body.code, 200, JSON.stringify(made.body));
			assert.equal(made.body.data.task.worktree, null, "空白落点按没有处理");
			assert.equal(made.body.data.task.execRoot, null, "非字符串落点按没有处理");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
});
