// show_view 卡片 + 侧聊 的真 HTTP 端到端：宿主半边跑在真 http server 上，真 socket。
//
// 覆盖：工具注册 → agent 调 show_view → 画布按会话/项目取到卡 → 无 token 的作答被 403 →
//       带 token 作答 → 以 user 来源 followup 回原会话 → 第二次作答 stale；
//       用户发了别的消息 → 挂着的卡作废；子 agent 开等人的卡被拒；
//       侧聊：创建 → 没连线不能问 → 连线 → 提问（读源会话、走 llm.stream、不带 tools）→ 落盘 →
//       追问带上问答对；重启后仍在。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");

async function boot(dir, overrides = {}) {
	plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
	const routes = [];
	const tools = [];
	const listeners = new Map();
	const followups = [];
	const streams = [];
	const root = { id: "session-root", session: { id: "session-root", requestHeader: () => ({ config: { provider: "p", model: "m" } }) }, followup: (message) => followups.push(message) };
	const sub = { id: "session-sub", session: { id: "session-sub" }, followup() {} };
	const live = new Map([[root.id, root], [sub.id, sub]]);
	const events = {
		"session-root": [
			{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "后端接口做到哪了" }] } },
			{ type: "assistant/message", seq: 2, data: { message: { content: [{ type: "text", text: "登录接口已完成，剩导入接口" }] } } }
		]
	};
	const ctx = {
		get(name) {
			if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
			if (name === "tools") return { register: (tool) => { if (overrides.dupShowView && tool.name === "show_view") throw new Error("duplicate tool show_view"); tools.push(tool); return () => {}; }, schemas: () => [] };
			// 真实宿主（0.2.2-rc.3）的形状：agents 只有 get / list（没有 roots()）；判根靠 subagents.rootOf(agent)。
			// 以前这里的假 agents 自带 roots()，所以「根判定在真机上永远失败」这个 bug 单测一直是绿的。
			if (name === "agents") return { get: (id) => live.get(id), list: () => [] };
			if (name === "subagents") return overrides.noSubagents ? undefined : { rootOf: (agent) => { if (overrides.rootOfThrows) throw new Error("boom"); return agent === sub ? root : agent; } };
			if (name === "sessions") return { list: () => [], get: () => undefined };
			if (name === "sessionPersistence") return { stat: () => undefined };
			if (name === "sessionQuery") return { readSession: async (id) => { if (!events[id]) throw new Error("no such session"); return { events: events[id] }; } };
			if (name === "llm") return { stream: (request) => { streams.push(request); return (overrides.stream || defaultStream)(request); } };
			return undefined;
		},
		effect(run) { return run(); },
		on(event, listener) { listeners.set(event, listener); return () => {}; }
	};
	async function* defaultStream() {
		yield { type: "text-delta", index: 0, text: "后端：登录已完成，" };
		yield { type: "text-delta", index: 0, text: "导入接口还没做。" };
		yield { type: "finish", reason: { kind: "stop" } };
	}
	plugin.apply(ctx, { viewDir: dir });
	const route = routes.find((item) => item && typeof item.handler === "function");
	assert.ok(route, "活动路由必须挂载");
	const server = createServer((req, res) => {
		Promise.resolve().then(() => route.handler(req, res)).catch((error) => {
			if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ code: 500, msg: String(error && error.message) })); }
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}/agent-whales/api`;
	async function call(method, path, body, token) {
		const headers = {};
		if (token) headers["x-whales-token"] = token;
		if (body !== undefined) headers["content-type"] = "application/json";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		if (timer.unref) timer.unref();
		const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
		const text = await res.text();
		let parsed; try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
		return { status: res.status, body: parsed, text };
	}
	const close = () => new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); });
	const tokenOf = async () => (await call("GET", "/activity")).body.controlToken;
	const showView = tools.find((tool) => tool.name === "show_view");
	const say = async (args, exec) => (await showView.execute(args, exec)).message;
	return { call, close, tokenOf, tools, showView, say, listeners, followups, streams, root, sub, events };
}

function tmp() {
	const dir = mkdtempSync(join(tmpdir(), "whales-view-e2e-"));
	return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const PICK = { type: "options", id: "pick", options: [{ label: "方案甲" }, { label: "方案乙" }] };
const CHART = { type: "chart", kind: "bar", categories: ["a", "b"], series: [{ values: [1, 2] }] };

test("e2e：show_view 工具被注册；展示卡立即返回，画布能按会话取到", async () => {
	const t = tmp();
	const h = await boot(t.dir);
	try {
		assert.ok(h.showView, "show_view 必须注册进 tools");
		assert.equal(await h.say({ title: "对比", view: CHART }, { agent: h.root }), "The view is on screen.");
		const listed = await h.call("GET", "/views?sessionId=session-root");
		assert.equal(listed.status, 200);
		assert.equal(listed.body.code, 200);
		assert.equal(listed.body.data.views.length, 1);
		assert.equal(listed.body.data.views[0].status, "shown");
		assert.equal((await h.call("GET", "/views?sessionId=session-other")).body.data.views.length, 0);
	} finally { await h.close(); t.done(); }
});

test("e2e：交互卡 → 无 token 403 → 带 token 作答 → 以 user 来源 followup 回原会话 → 再答 stale", async () => {
	const t = tmp();
	const h = await boot(t.dir);
	try {
		let concluded = 0;
		await h.say({ title: "选方案", view: PICK }, { agent: h.root, callId: "c1", concludeTurn: () => { concluded += 1; } });
		assert.equal(concluded, 1, "交互卡要结束当前回合");
		const view = (await h.call("GET", "/views?sessionId=session-root")).body.data.views[0];
		assert.equal(view.status, "pending");
		const url = "/views/" + view.id + "/answer";
		const body = { action: "pick", values: { selected: ["方案乙"] } };
		assert.equal((await h.call("POST", url, body)).status, 403, "没带同源证明必须拒绝");
		assert.equal(h.followups.length, 0);
		const token = await h.tokenOf();
		const ok = await h.call("POST", url, body, token);
		assert.equal(ok.body.code, 200);
		assert.equal(ok.body.data.view.status, "answered");
		assert.equal(h.followups.length, 1);
		assert.deepEqual(h.followups[0].source, { kind: "user" });
		assert.match(h.followups[0].content[0].text, /选方案/);
		assert.match(h.followups[0].content[0].text, /方案乙/);
		const again = await h.call("POST", url, body, token);
		assert.equal(again.body.code, 40901, "第二次作答是 stale");
		assert.equal(h.followups.length, 1, "不会重复投递");
		// 不合规的答案：参数错误，且不认领
		await h.say({ title: "再选", view: PICK }, { agent: h.root });
		const next = (await h.call("GET", "/views?sessionId=session-root")).body.data.views.find((row) => row.status === "pending");
		const bad = await h.call("POST", "/views/" + next.id + "/answer", { action: "pick", values: { selected: ["不存在"] } }, token);
		assert.equal(bad.body.code, 40001);
		assert.equal((await h.call("GET", "/views?sessionId=session-root")).body.data.views.find((row) => row.id === next.id).status, "pending");
	} finally { await h.close(); t.done(); }
});

test("e2e：会话不在线时作答失败并退回认领，之后上线可以再答", async () => {
	const t = tmp();
	const h = await boot(t.dir);
	try {
		// 画卡的会话之后下线：把 root 的 followup 换成抛错的版本最接近「会话不在线」之外的投递失败
		await h.say({ title: "选", view: PICK }, { agent: h.root });
		const view = (await h.call("GET", "/views?sessionId=session-root")).body.data.views[0];
		const token = await h.tokenOf();
		const original = h.root.followup;
		h.root.followup = () => { throw new Error("通道已关闭"); };
		const failed = await h.call("POST", "/views/" + view.id + "/answer", { action: "pick", values: { selected: ["方案甲"] } }, token);
		assert.equal(failed.body.code, 50301);
		assert.match(failed.body.msg, /通道已关闭/);
		assert.equal((await h.call("GET", "/views?sessionId=session-root")).body.data.views[0].status, "pending", "投递失败要退回 pending");
		h.root.followup = original;
		assert.equal((await h.call("POST", "/views/" + view.id + "/answer", { action: "pick", values: { selected: ["方案甲"] } }, token)).body.code, 200);
	} finally { await h.close(); t.done(); }
});

test("e2e：用户在该会话发了别的消息，挂着的卡作废；其他会话的卡不受影响", async () => {
	const t = tmp();
	const h = await boot(t.dir);
	try {
		await h.say({ title: "选", view: PICK }, { agent: h.root });
		const listener = h.listeners.get("session/event");
		assert.equal(typeof listener, "function", "必须监听 session/event");
		// agent 自己的消息 / 别的来源不算
		listener({ id: "session-root" }, { type: "user/message", data: { source: { kind: "agent-message" } } });
		assert.equal((await h.call("GET", "/views?sessionId=session-root")).body.data.views[0].status, "pending");
		listener({ id: "session-other" }, { type: "user/message", data: { source: { kind: "user" } } });
		assert.equal((await h.call("GET", "/views?sessionId=session-root")).body.data.views[0].status, "pending");
		listener({ id: "session-root" }, { type: "user/message", data: { source: { kind: "user" } } });
		assert.equal((await h.call("GET", "/views?sessionId=session-root")).body.data.views[0].status, "expired");
	} finally { await h.close(); t.done(); }
});

test("e2e：根判定对着真实宿主形状——agents 没有 roots()，根会话能开交互卡；没有 subagents 服务时放行；rootOf 抛错时保守拒绝", async () => {
	const t = tmp();
	const h = await boot(t.dir);
	try {
		// 真实形状下，根 agent 能开等人的卡（这是真机上踩到的坑）
		const out = await h.say({ view: PICK }, { agent: h.root });
		assert.match(out, /answer arrives as their next message/);
		assert.equal((await h.call("GET", "/views?sessionId=session-root")).body.data.views[0].status, "pending");
		// 子 agent 仍被拒
		assert.match(await h.say({ view: PICK }, { agent: h.sub }), /only works in a root session/);
	} finally { await h.close(); t.done(); }
	// 没有 subagents 服务：无从证明是子 agent → 放行（不能因为缺服务就让所有根会话开不出卡）
	const t2 = tmp();
	const h2 = await boot(t2.dir, { noSubagents: true });
	try {
		assert.match(await h2.say({ view: PICK }, { agent: h2.root }), /answer arrives as their next message/);
	} finally { await h2.close(); t2.done(); }
	// rootOf 抛错：保守拒绝（宁可不开卡，也不把子 agent 当根）
	const t3 = tmp();
	const h3 = await boot(t3.dir, { rootOfThrows: true });
	try {
		assert.match(await h3.say({ view: PICK }, { agent: h3.root }), /only works in a root session/);
	} finally { await h3.close(); t3.done(); }
});

test("e2e：子 agent 不能开等人的卡（被拒且不落库），但能画展示卡", async () => {
	const t = tmp();
	const h = await boot(t.dir);
	try {
		assert.match(await h.say({ view: PICK }, { agent: h.sub }), /only works in a root session/);
		assert.equal((await h.call("GET", "/views")).body.data.views.length, 0);
		assert.equal(await h.say({ view: CHART }, { agent: h.sub }), "The view is on screen.");
		assert.equal((await h.call("GET", "/views")).body.data.views.length, 1);
	} finally { await h.close(); t.done(); }
});

test("e2e：侧聊——没连线不能问；连线后读源会话、走 llm.stream（不带 tools）、答案落盘；追问带问答对；重启还在", async () => {
	const t = tmp();
	let h = await boot(t.dir);
	try {
		const token = await h.tokenOf();
		assert.equal((await h.call("POST", "/side", { projectId: "p1" })).status, 403, "写操作要同源证明");
		const created = await h.call("POST", "/side", { projectId: "p1", title: "问后端" }, token);
		const chatId = created.body.data.chat.id;
		const noSource = await h.call("POST", "/side/" + chatId + "/ask", { text: "做完了吗" }, token);
		assert.equal(noSource.body.code, 40001, "没连线不能问");
		assert.equal((await h.call("PUT", "/side/" + chatId + "/sources", { sources: ["session-root"] }, token)).body.data.chat.sources[0], "session-root");
		const asked = await h.call("POST", "/side/" + chatId + "/ask", { text: "做完了吗" }, token);
		assert.equal(asked.body.code, 200);
		assert.equal(asked.body.data.entry.status, "answering");
		// 答案异步落盘：轮询列表
		let entry;
		for (let i = 0; i < 50 && !(entry && entry.status !== "answering"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			entry = (await h.call("GET", "/side?projectId=p1")).body.data.chats[0].entries[0];
		}
		assert.equal(entry.status, "done");
		assert.equal(entry.answer, "后端：登录已完成，导入接口还没做。");
		const request = h.streams[0];
		assert.equal(request.provider, "p", "沿用源对话的模型路由");
		assert.equal(request.tools, undefined, "侧聊绝不带 tools");
		assert.match(request.messages[0].content[0].text, /登录接口已完成，剩导入接口/, "背景里要有源会话的文本");
		assert.match(request.messages[0].content[0].text, /做完了吗$/);
		assert.equal(h.followups.length, 0, "侧聊不写回任何对话");
		// 追问：带上第一轮问答对
		await h.call("POST", "/side/" + chatId + "/ask", { text: "那导入呢" }, token);
		for (let i = 0; i < 50 && h.streams.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
		const second = h.streams[1].messages;
		assert.deepEqual(second.map((message) => message.role), ["user", "assistant", "user"]);
		assert.equal(second[1].source.kind, "model");
		await new Promise((resolve) => setTimeout(resolve, 100));
		// 重启：新宿主实例读同一目录
		await h.close();
		h = await boot(t.dir);
		const chats = (await h.call("GET", "/side?projectId=p1")).body.data.chats;
		assert.equal(chats.length, 1);
		assert.equal(chats[0].entries[0].answer, "后端：登录已完成，导入接口还没做。");
		assert.deepEqual(chats[0].sources, ["session-root"]);
		assert.equal((await h.call("DELETE", "/side/" + chatId, undefined, await h.tokenOf())).body.data.removed, true);
	} finally { await h.close(); t.done(); }
});

test("e2e：侧聊——源会话读不到时背景写明；模型失败落成 failed 并带原因", async () => {
	const t = tmp();
	const h = await boot(t.dir, { stream: async function* () { yield { type: "finish", reason: { kind: "error", failure: { message: "上游 429" } } }; } });
	try {
		const token = await h.tokenOf();
		const chatId = (await h.call("POST", "/side", { projectId: "p1", sources: ["session-root", "session-gone"] }, token)).body.data.chat.id;
		await h.call("POST", "/side/" + chatId + "/ask", { text: "问" }, token);
		let entry;
		for (let i = 0; i < 50 && !(entry && entry.status !== "answering"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			entry = (await h.call("GET", "/side?projectId=p1")).body.data.chats[0].entries[0];
		}
		assert.equal(entry.status, "failed");
		assert.match(entry.error, /429/);
		assert.match(h.streams[0].messages[0].content[0].text, /读不到这个对话：no such session/);
	} finally { await h.close(); t.done(); }
});

test("e2e：别家已注册同名 show_view 时只 warn：其他工具照常、/views 与 /side 路由仍然可用（没有 ctx.inject 的直通路径也一样）", async () => {
	const t = tmp();
	const h = await boot(t.dir, { dupShowView: true });
	try {
		assert.equal(h.showView, undefined, "重复的 show_view 没有注册成功");
		assert.ok(h.tools.length > 0, "其他工具照常注册");
		const listed = await h.call("GET", "/views");
		assert.equal(listed.body.code, 200, "路由不能因为工具重复而变成 unavailable");
		const token = await h.tokenOf();
		assert.equal((await h.call("POST", "/side", { projectId: "p1" }, token)).body.code, 200, "侧聊照常可用");
	} finally { await h.close(); t.done(); }
});
