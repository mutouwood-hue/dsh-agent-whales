import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as host from "../lib/index.js";

const ISOLATED = mkdtempSync(join(tmpdir(), "aw-mcp-"));
host.setProjectStorePathForTests(join(ISOLATED, "projects.json"));

const { sessionIdOfAgent, mcpServerOfTool, mcpConstraintGuard, resetMcpConstraintForTests } = host;

/**
 * 写一份带 mcpLinks 的项目 store，然后清缓存让 guard 立刻看到。
 * 每次都重设 store 路径：test/index.js 把所有用例文件 import 进同一进程，
 * index.test.mjs 有用例会重指 projects store，模块级设一次会被它盖掉。
 */
function seedStore(projects) {
	host.setProjectStorePathForTests(join(ISOLATED, "projects.json"));
	writeFileSync(join(ISOLATED, "projects.json"), JSON.stringify({ projects }, null, 1), "utf8");
	resetMcpConstraintForTests();
}

const clean = () => {
	seedStore({});
};

const LINKED = {
	"p-1": {
		projectId: "p-1",
		mainSessionId: "session-main",
		members: [{ sessionId: "s1" }],
		mcpLinks: [{ server: "pencil", sessionId: "s1", createdAt: 1 }]
	}
};

// ── sessionIdOfAgent：探针实测 agent.id 与 agent.session.id 同值 ────────────

test("sessionIdOfAgent：两种取值路径都剥掉 session- 前缀", () => {
	assert.equal(sessionIdOfAgent({ id: "session-abc" }), "abc", "agent.id 路径");
	assert.equal(sessionIdOfAgent({ session: { id: "session-xyz" } }), "xyz", "agent.session.id 路径");
	assert.equal(sessionIdOfAgent({ id: "session-a", session: { id: "session-b" } }), "a", "两者都有时取 agent.id");
});

test("sessionIdOfAgent：脏数据一律回空串，不猜", () => {
	assert.equal(sessionIdOfAgent(undefined), "");
	assert.equal(sessionIdOfAgent(null), "");
	assert.equal(sessionIdOfAgent("session-abc"), "", "字符串不是 agent");
	assert.equal(sessionIdOfAgent({}), "");
	assert.equal(sessionIdOfAgent({ id: 42 }), "", "数字 id 不当字符串用");
	assert.equal(sessionIdOfAgent({ id: "" }), "");
	assert.equal(sessionIdOfAgent({ id: "plain-id" }), "plain-id", "没有前缀就原样返回");
});

// ── mcpServerOfTool：mcp__<server>__<raw> ─────────────────────────────────

test("mcpServerOfTool：只认 mcp__ 前缀", () => {
	assert.equal(mcpServerOfTool("mcp__pencil__screenshot"), "pencil");
	assert.equal(mcpServerOfTool("mcp__my-server__do_thing"), "my-server");
	assert.equal(mcpServerOfTool("pwsh"), "", "原生工具不是 MCP");
	assert.equal(mcpServerOfTool("read"), "");
	assert.equal(mcpServerOfTool("whales_canvas_list"), "");
	assert.equal(mcpServerOfTool("mcp_"), "", "只有前缀没有服务名");
	assert.equal(mcpServerOfTool("mcp__pencil"), "", "缺第二段下划线");
	assert.equal(mcpServerOfTool("mcp__pencil__a__b"), "pencil", "raw 里还有下划线不影响取服务名");
	assert.equal(mcpServerOfTool(""), "");
	assert.equal(mcpServerOfTool(undefined), "");
});

// ── mcpConstraintGuard：三个保险 ───────────────────────────────────────────

test("guard：默认全放行（没有任何 mcpLinks 时是 no-op）", () => {
	clean();
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__screenshot", agent: { id: "session-s1" } }), undefined);
	assert.equal(mcpConstraintGuard({ name: "pwsh", agent: { id: "session-s1" } }), undefined);
});

test("guard：没连过这个服务的会话，MCP 工具被拒且理由是给人看的", () => {
	seedStore(LINKED);
	const denied = mcpConstraintGuard({ name: "mcp__github__create_issue", agent: { id: "session-s1" } });
	assert.equal(typeof denied, "string", "必须返回拒绝理由");
	assert.match(denied, /github/, "理由里要点名是哪个服务，否则用户不知道连什么");
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__screenshot", agent: { id: "session-s1" } }), undefined, "连过的放行");
});

test("guard：只拦 MCP 工具，bash/文件读写永远放行", () => {
	seedStore(LINKED);
	for (const name of ["pwsh", "read", "edit", "skill", "whales_canvas_list", "whales_visit_send"]) {
		assert.equal(mcpConstraintGuard({ name, agent: { id: "session-s1" } }), undefined, name + " 必须放行");
	}
});

test("guard：取不到 agent 身份时不误伤（放行）", () => {
	seedStore(LINKED);
	assert.equal(mcpConstraintGuard({ name: "mcp__github__x", agent: undefined }), undefined, "没 agent 不拦");
	assert.equal(mcpConstraintGuard({ name: "mcp__github__x", agent: null }), undefined);
	assert.equal(mcpConstraintGuard({ name: "mcp__github__x" }), undefined, "整个 exec 没有 agent 字段");
	assert.equal(mcpConstraintGuard({ name: "mcp__github__x", agent: { id: "session-other" } }), undefined, "别的会话没约束");
});

test("guard：主对话也能被约束（不只是成员）", () => {
	seedStore({
		"p-1": { projectId: "p-1", mainSessionId: "session-main", members: [], mcpLinks: [{ server: "pencil", sessionId: "main", createdAt: 1 }] }
	});
	assert.equal(typeof mcpConstraintGuard({ name: "mcp__github__x", agent: { id: "session-main" } }), "string");
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__y", agent: { id: "session-main" } }), undefined);
});

test("guard：一个会话连多个服务，各自独立判定", () => {
	seedStore({
		"p-1": {
			projectId: "p-1", mainSessionId: "session-main", members: [],
			mcpLinks: [
				{ server: "pencil", sessionId: "s1", createdAt: 1 },
				{ server: "github", sessionId: "s1", createdAt: 2 }
			]
		}
	});
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__a", agent: { id: "session-s1" } }), undefined);
	assert.equal(mcpConstraintGuard({ name: "mcp__github__b", agent: { id: "session-s1" } }), undefined);
	assert.equal(typeof mcpConstraintGuard({ name: "mcp__slack__c", agent: { id: "session-s1" } }), "string", "没连的第三个服务仍被拒");
});

test("guard：不同项目的会话互不干扰", () => {
	seedStore({
		"p-1": { projectId: "p-1", mainSessionId: "m1", members: [], mcpLinks: [{ server: "pencil", sessionId: "s1", createdAt: 1 }] },
		"p-2": { projectId: "p-2", mainSessionId: "m2", members: [], mcpLinks: [{ server: "github", sessionId: "s2", createdAt: 1 }] }
	});
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__a", agent: { id: "session-s1" } }), undefined, "p-1 的 s1 能用 pencil");
	assert.equal(typeof mcpConstraintGuard({ name: "mcp__github__a", agent: { id: "session-s1" } }), "string", "p-1 的 s1 不能用 github");
	assert.equal(mcpConstraintGuard({ name: "mcp__github__a", agent: { id: "session-s2" } }), undefined, "p-2 的 s2 能用 github");
	assert.equal(typeof mcpConstraintGuard({ name: "mcp__pencil__a", agent: { id: "session-s2" } }), "string", "p-2 的 s2 不能用 pencil");
});

test("guard：mcpLinks 里的脏条目被跳过，不炸也不误放", () => {
	seedStore({
		"p-1": {
			projectId: "p-1", mainSessionId: "m1", members: [],
			mcpLinks: [
				null,
				{ server: "pencil", createdAt: 1 },
				{ sessionId: "s1", createdAt: 1 },
				{ server: "", sessionId: "s1", createdAt: 1 },
				{ server: "pencil", sessionId: "", createdAt: 1 },
				{ server: "pencil", sessionId: "s1", createdAt: 1 }
			]
		}
	});
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__a", agent: { id: "session-s1" } }), undefined, "唯一完好的那条要生效");
	assert.equal(typeof mcpConstraintGuard({ name: "mcp__github__a", agent: { id: "session-s1" } }), "string");
});

test("guard：projects.json 读不到时回空索引（放行，不因为存储坏了就拦掉所有工具）", () => {
	// 必须用独立路径：readStoreFile 遇到坏 JSON 会把文件改名成 .corrupt-<ts> 并把这个路径
	// 永久标记 readonly，共用路径会毒化后面的用例。
	const own = mkdtempSync(join(tmpdir(), "aw-mcp-corrupt-"));
	host.setProjectStorePathForTests(join(own, "projects.json"));
	writeFileSync(join(own, "projects.json"), "{ 这不是 JSON", "utf8");
	resetMcpConstraintForTests();
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__a", agent: { id: "session-s1" } }), undefined, "存储坏了也不能误伤");
	// 还原回主路径，别影响后面的用例
	host.setProjectStorePathForTests(join(ISOLATED, "projects.json"));
	resetMcpConstraintForTests();
});

test("guard：空 store 与空 projects 都走快路径", () => {
	seedStore({});
	writeFileSync(join(ISOLATED, "projects.json"), JSON.stringify({}), "utf8");
	resetMcpConstraintForTests();
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__a", agent: { id: "session-s1" } }), undefined);
	seedStore({ "p-1": { projectId: "p-1", mainSessionId: "m1", members: [], mcpLinks: [] } });
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__a", agent: { id: "session-s1" } }), undefined, "有项目但没连接 = 无约束");
});

// ── 完整用户旅程：连上 → 被拦 → 全清 → 恢复 ─────────────────────────────────
//
// 上面每条各自验证一个分支，这里验证「按用户操作的顺序走一遍」不出意外。
// 分支全绿但旅程断了是可能的（比如清空后索引没重建），所以单独走一遍。

test("旅程：连上 pencil 后 slack 被拦、pwsh 放行；一键全清后全部恢复", () => {
	// 1) 一开始没有任何约束
	clean();
	assert.equal(mcpConstraintGuard({ name: "mcp__slack__post", agent: { id: "session-s1" } }), undefined, "没约束时不该拦");

	// 2) 用户在画布上把 pencil 拖到 s1 上（等价于 POST /mcp-links 落库）
	seedStore({
		"p-1": {
			projectId: "p-1",
			mainSessionId: "session-main",
			members: [{ sessionId: "s1" }, { sessionId: "s2" }],
			mcpLinks: [{ server: "pencil", sessionId: "s1", createdAt: 1 }]
		}
	});
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__screenshot", agent: { id: "session-s1" } }), undefined, "连过的服务放行");
	assert.match(String(mcpConstraintGuard({ name: "mcp__slack__post", agent: { id: "session-s1" } })), /slack/, "没连的服务要拦");
	assert.equal(mcpConstraintGuard({ name: "pwsh", agent: { id: "session-s1" } }), undefined, "shell 永远放行");
	// s2 没被约束，不受影响
	assert.equal(mcpConstraintGuard({ name: "mcp__slack__post", agent: { id: "session-s2" } }), undefined, "另一个会话不受约束");
	// 主会话也没被约束
	assert.equal(mcpConstraintGuard({ name: "mcp__slack__post", agent: { id: "session-main" } }), undefined, "主会话不受约束");

	// 3) 用户点「一键全清」（等价于 DELETE /mcp-links?all=1）→ mcpLinks 变空数组
	seedStore({
		"p-1": {
			projectId: "p-1",
			mainSessionId: "session-main",
			members: [{ sessionId: "s1" }, { sessionId: "s2" }],
			mcpLinks: []
		}
	});
	assert.equal(mcpConstraintGuard({ name: "mcp__slack__post", agent: { id: "session-s1" } }), undefined, "全清后必须恢复放行");
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__screenshot", agent: { id: "session-s1" } }), undefined, "全清后原来连过的也放行");
});

test("旅程：只删一条线，其余约束还在", () => {
	seedStore({
		"p-1": {
			projectId: "p-1",
			mainSessionId: "session-main",
			members: [{ sessionId: "s1" }],
			mcpLinks: [
				{ server: "pencil", sessionId: "s1", createdAt: 1 },
				{ server: "github", sessionId: "s1", createdAt: 2 }
			]
		}
	});
	// 删掉 pencil 那条
	seedStore({
		"p-1": {
			projectId: "p-1",
			mainSessionId: "session-main",
			members: [{ sessionId: "s1" }],
			mcpLinks: [{ server: "github", sessionId: "s1", createdAt: 2 }]
		}
	});
	assert.match(String(mcpConstraintGuard({ name: "mcp__pencil__screenshot", agent: { id: "session-s1" } })), /pencil/, "删掉的线要解除约束");
	assert.equal(mcpConstraintGuard({ name: "mcp__github__create_issue", agent: { id: "session-s1" } }), undefined, "没删的线约束还在");
});

// ── TTL：索引缓存寿命 ───────────────────────────────────────────────────────
//
// MCP_CONSTRAINT_TTL = 2000 是给「外部手改 projects.json」留的陈旧上界。
// 这条行为写在 README 里，但没有测试钉住——补上。

test("TTL：索引不会无限陈旧（过期后重建，看得到外部改的 store）", async () => {
	clean();
	// 故意不调 resetMcpConstraintForTests()：让上一个测试留下的缓存留着，
	// 模拟「插件跑着，有人从外部手改了 projects.json」。
	writeFileSync(
		join(ISOLATED, "projects.json"),
		JSON.stringify({
			projects: {
				"p-1": {
					projectId: "p-1",
					mainSessionId: "session-main",
					members: [{ sessionId: "s1" }],
					mcpLinks: [{ server: "pencil", sessionId: "s1", createdAt: 1 }]
				}
			}
		}, null, 1),
		"utf8"
	);
	// 缓存年龄取决于进入这个测试的时机，两种结果都合法，不断言。
	const before = mcpConstraintGuard({ name: "mcp__slack__post", agent: { id: "session-s1" } });
	assert.ok(before === undefined || typeof before === "string", "before 只能是放行或拒绝");
	// 等过一个 TTL（MCP_CONSTRAINT_TTL = 2000）再问一次：必须看得到新建的约束。
	// 这条行为写在 README 里（「新建的约束最多 2 秒后生效」），这里钉住它不会无限陈旧。
	await new Promise((resolve) => setTimeout(resolve, 2200));
	assert.match(String(mcpConstraintGuard({ name: "mcp__slack__post", agent: { id: "session-s1" } })), /slack/, "超过 TTL 后必须看得到新建的约束");
	assert.equal(mcpConstraintGuard({ name: "mcp__pencil__screenshot", agent: { id: "session-s1" } }), undefined, "连过的服务放行");
});