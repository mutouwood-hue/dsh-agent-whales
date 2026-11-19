/**
 * lib/view-host.js：show_view 卡片库 / 工具 / 作答，侧聊服务，路由分派。
 * 全部离线：文件落临时目录，投递与调模型都是桩。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createViewStore, createShowViewTool, answerView, createSideService, assembleText, transcriptOf, handleViewRoute, VIEW_CODE
} from "../lib/view-host.js";

function tmp() {
	const dir = mkdtempSync(join(tmpdir(), "whales-view-"));
	return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const CHART = { type: "chart", kind: "bar", categories: ["a", "b"], series: [{ values: [1, 2] }] };
const CHOICE = { type: "options", id: "pick", options: [{ label: "甲" }, { label: "乙" }] };
const agentOf = (id) => ({ id, session: { id } });
/** show_view 返回 { message }；测试关心的是给模型看的那句话。 */
const say = async (tool, args, exec) => (await tool.execute(args, exec)).message;

// ── 卡片库 ──

test("视图库：纯展示卡直接是 shown，交互卡是 pending，且同会话只留一张 pending", () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		const shown = store.add({ sessionId: "s1", title: "图", view: CHART, interactive: false });
		assert.equal(shown.status, "shown");
		const first = store.add({ sessionId: "s1", title: "选", view: CHOICE, interactive: true });
		const second = store.add({ sessionId: "s1", title: "再选", view: CHOICE, interactive: true });
		assert.equal(store.get(first.id).status, "expired");
		assert.equal(store.get(second.id).status, "pending");
		// 另一个会话的 pending 不受影响
		const other = store.add({ sessionId: "s2", title: "x", view: CHOICE, interactive: true });
		assert.equal(store.get(other.id).status, "pending");
	} finally { t.done(); }
});

test("视图库：按 sessionIds / projectId 取「属于这个项目」的卡，且有数量上限（新的留下）", () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		store.add({ sessionId: "a", projectId: "", title: "a1", view: CHART });
		store.add({ sessionId: "b", projectId: "p1", title: "b1", view: CHART });
		store.add({ sessionId: "c", projectId: "", title: "c1", view: CHART });
		const titles = (rows) => rows.map((row) => row.title).sort();
		assert.deepEqual(titles(store.list({ sessionIds: ["a"] })), ["a1"]);
		assert.deepEqual(titles(store.list({ sessionIds: ["a"], projectId: "p1" })), ["a1", "b1"], "会话 id 与项目 id 任一命中都算");
		assert.deepEqual(titles(store.list({ projectId: "p1" })), ["b1"]);
		assert.deepEqual(titles(store.list({ sessionId: "c" })), ["c1"]);
		assert.deepEqual(titles(store.list({ sessionIds: [] })), [], "空列表 = 不属于任何会话");
		assert.deepEqual(store.list({ limit: 2 }).map((row) => row.title), ["b1", "c1"], "只留最新的 2 张");
		for (let i = 0; i < 70; i += 1) store.add({ sessionId: "a", title: "n" + i, view: CHART });
		const viaRoute = (rows) => rows.length;
		assert.equal(viaRoute(store.list({ sessionIds: ["a"], limit: 60 })), 60);
	} finally { t.done(); }
});

test("视图库：重启后还在（落盘），损坏文件留 .corrupt 备份而不是静默覆盖", () => {
	const t = tmp();
	try {
		const file = join(t.dir, "views.json");
		createViewStore(file).add({ sessionId: "s1", title: "图", view: CHART, interactive: false });
		assert.equal(createViewStore(file).list({ sessionId: "s1" }).length, 1);
		writeFileSync(file, "{ 不是 json", "utf8");
		assert.equal(createViewStore(file).list().length, 0);
		assert.ok(readdirSync(t.dir).some((name) => name.includes(".corrupt-")), "应留下损坏备份");
	} finally { t.done(); }
});

test("视图库：用户发了别的消息，挂着的交互卡作废", () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		const row = store.add({ sessionId: "s1", title: "选", view: CHOICE, interactive: true });
		assert.equal(store.expireSession("s1"), 1);
		assert.equal(store.get(row.id).status, "expired");
		assert.equal(store.expireSession("s1"), 0);
	} finally { t.done(); }
});

// ── 工具 ──

test("show_view：展示卡立即返回并落库；非法视图原样给错误、不落库", async () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		const tool = createShowViewTool({ store, refuseNonRoot: () => undefined, projectOf: () => "p1" });
		assert.equal(await say(tool, { view: CHART }, { agent: agentOf("s1") }), "The view is on screen.");
		const rows = store.list({ projectId: "p1" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].sessionId, "s1");
		const bad = await say(tool, { view: { type: "nope" } }, { agent: agentOf("s1") });
		assert.match(bad, /unknown component/);
		assert.equal(store.list().length, 1);
	} finally { t.done(); }
});

test("show_view：交互卡结束当前回合、挂起；await_reply 与卡类型矛盾被拒", async () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		const tool = createShowViewTool({ store, refuseNonRoot: () => undefined });
		let concluded = 0;
		const out = await say(tool, { view: CHOICE }, { agent: agentOf("s1"), callId: "c1", concludeTurn: () => { concluded += 1; } });
		assert.match(out, /answer arrives as their next message/);
		assert.equal(concluded, 1);
		assert.equal(store.list({ sessionId: "s1" })[0].status, "pending");
		assert.match(await say(tool, { view: CHART, await_reply: true }, { agent: agentOf("s1") }), /nothing to submit/);
		assert.match(await say(tool, { view: CHOICE, await_reply: false }, { agent: agentOf("s1") }), /waits for the user/);
	} finally { t.done(); }
});

test("show_view：子 agent 不能开会等人的卡，但能画展示卡", async () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		const tool = createShowViewTool({ store, refuseNonRoot: () => "only root" });
		assert.equal(await say(tool, { view: CHOICE }, { agent: agentOf("sub") }), "only root");
		assert.equal(store.list().length, 0);
		assert.equal(await say(tool, { view: CHART }, { agent: agentOf("sub") }), "The view is on screen.");
	} finally { t.done(); }
});

test("show_view 工具定义：parameters 是完整 JSON Schema（不是上游的属性表简写），output.schema 是 object，render 取 message", async () => {
	const t = tmp();
	try {
		const tool = createShowViewTool({ store: createViewStore(join(t.dir, "views.json")), refuseNonRoot: () => undefined });
		// 网关按 function calling 校验：缺 type:"object" 会让整轮请求 400（历史事故）
		assert.equal(tool.parameters.type, "object");
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["await_reply", "title", "view"]);
		assert.deepEqual(tool.parameters.required, ["view"], "view 必填；上游简写里的 required:true 要展开成数组");
		assert.equal(tool.parameters.properties.view.type, "object");
		assert.equal(tool.parameters.properties.view.required, undefined, "属性内部不能再带 required:true");
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(tool.output.schema.type, "object");
		const value = await tool.execute({ view: CHART }, { agent: agentOf("s1") });
		assert.equal(typeof value, "object");
		assert.deepEqual(tool.output.render({}, value), [{ type: "text", text: "The view is on screen." }]);
		assert.deepEqual(tool.output.render({}, undefined), [{ type: "text", text: "(empty)" }], "没有返回值也不能抛");
	} finally { t.done(); }
});

// ── 作答 ──

test("作答：校验后认领，以 user 来源、可读文本投回原会话；第二次作答被拒", async () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		const row = store.add({ sessionId: "s1", title: "选方案", view: CHOICE, interactive: true });
		const sent = [];
		const deliver = async (sessionId, message) => { sent.push({ sessionId, message }); };
		const done = await answerView({ store, deliver }, row.id, "pick", { selected: ["乙"] });
		assert.equal(done.status, "answered");
		assert.equal(sent.length, 1);
		assert.equal(sent[0].sessionId, "s1");
		assert.deepEqual(sent[0].message.source, { kind: "user" });
		const text = sent[0].message.content[0].text;
		assert.match(text, /选方案/);
		assert.match(text, /乙/);
		await assert.rejects(() => answerView({ store, deliver }, row.id, "pick", { selected: ["甲"] }), (error) => error.code === VIEW_CODE.stale);
		assert.equal(sent.length, 1);
	} finally { t.done(); }
});

test("作答：答案不合规拒绝且不认领；投递失败把认领退回，可以再点", async () => {
	const t = tmp();
	try {
		const store = createViewStore(join(t.dir, "views.json"));
		const row = store.add({ sessionId: "s1", title: "选", view: CHOICE, interactive: true });
		await assert.rejects(() => answerView({ store, deliver: async () => {} }, row.id, "pick", { selected: ["丙"] }), (error) => error.code === VIEW_CODE.param);
		assert.equal(store.get(row.id).status, "pending");
		await assert.rejects(() => answerView({ store, deliver: async () => { throw new Error("会话不在线"); } }, row.id, "pick", { selected: ["甲"] }), (error) => error.code === VIEW_CODE.unavailable);
		assert.equal(store.get(row.id).status, "pending");
		const ok = await answerView({ store, deliver: async () => {} }, row.id, "pick", { selected: ["甲"] });
		assert.equal(ok.status, "answered");
	} finally { t.done(); }
});

// ── 侧聊 ──

function sideFixture(dir, overrides = {}) {
	const calls = [];
	const service = createSideService({
		file: join(dir, "side.json"),
		readSource: overrides.readSource || (async (id) => ({ title: "对话" + id, rows: [{ role: "user", text: "你好 " + id }, { role: "assistant", text: "收到" }] })),
		callModel: overrides.callModel || (async (request) => { calls.push(request); return { text: "答案" + calls.length }; })
	});
	return { service, calls };
}

test("侧聊：没连线不能问；连线后问答落盘，背景含每个源会话的文本", async () => {
	const t = tmp();
	try {
		const { service, calls } = sideFixture(t.dir);
		const chat = service.create({ projectId: "p1", title: "问问" });
		await assert.rejects(() => service.ask(chat.id, "后端做完了吗"), (error) => error.code === VIEW_CODE.param);
		service.setSources(chat.id, ["a", "b", "a"]);
		assert.deepEqual(service.list("p1")[0].sources, ["a", "b"], "重复的源去重");
		const started = await service.ask(chat.id, "后端做完了吗");
		await started.done;
		const saved = service.list("p1")[0].entries[0];
		assert.equal(saved.status, "done");
		assert.equal(saved.answer, "答案1");
		const first = calls[0].turns[0].text;
		assert.match(first, /agent-whales\/side/);
		assert.match(first, /<conversation id="a"/);
		assert.match(first, /<conversation id="b"/);
		assert.match(first, /后端做完了吗$/);
	} finally { t.done(); }
});

test("侧聊：追问带上已答完的问答对，背景只在第一条里出现一次", async () => {
	const t = tmp();
	try {
		const { service, calls } = sideFixture(t.dir);
		const chat = service.create({ projectId: "p1", sources: ["a"] });
		await (await service.ask(chat.id, "第一问")).done;
		await (await service.ask(chat.id, "第二问")).done;
		const turns = calls[1].turns;
		assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant", "user"]);
		assert.match(turns[0].text, /<conversation/);
		assert.match(turns[0].text, /第一问$/);
		assert.equal(turns[1].text, "答案1");
		assert.equal(turns[2].text, "第二问");
	} finally { t.done(); }
});

test("侧聊：同时只能有一个问题在答；取消后状态是 cancelled，晚到的答案不会覆盖", async () => {
	const t = tmp();
	try {
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		const { service } = sideFixture(t.dir, { callModel: async () => { await gate; return { text: "迟到的答案" }; } });
		const chat = service.create({ projectId: "p1", sources: ["a"] });
		const started = await service.ask(chat.id, "慢问题");
		await assert.rejects(() => service.ask(chat.id, "插队"), (error) => error.code === VIEW_CODE.busy);
		assert.equal(service.cancel(chat.id, started.entry.id), true);
		release();
		await started.done;
		const entry = service.list("p1")[0].entries[0];
		assert.equal(entry.status, "cancelled");
		assert.equal(entry.answer, "");
	} finally { t.done(); }
});

test("侧聊：取消后，不理会 abort 信号、晚到的答案也不能把 cancelled 写回 done", async () => {
	const t = tmp();
	try {
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		// 模型调用故意无视 signal：这是 abort 回合里「已经在路上的答案」的最坏情形。
		const { service } = sideFixture(t.dir, { callModel: async () => { await gate; return { text: "迟到的答案" }; } });
		const chat = service.create({ projectId: "p1", sources: ["a"] });
		const started = await service.ask(chat.id, "慢问题");
		service.cancel(chat.id, started.entry.id);
		release();
		await started.done;
		const entry = service.list("p1")[0].entries[0];
		assert.equal(entry.status, "cancelled");
		assert.equal(entry.answer, "");
	} finally { t.done(); }
});

test("侧聊：模型失败 / 空回答 / 调了工具（重试一次后仍调）都落成 failed，且说明原因", async () => {
	const t = tmp();
	try {
		const cases = [
			[{ failed: "上游 429" }, /429/],
			[{ text: "" }, /没有写任何内容/],
			[{ text: "x", toolCalls: true }, /工具/]
		];
		for (const [reply, pattern] of cases) {
			const { service } = sideFixture(t.dir, { callModel: async () => reply });
			const chat = service.create({ projectId: "p-" + Math.random(), sources: ["a"] });
			await (await service.ask(chat.id, "问")).done;
			const entry = service.list().find((item) => item.id === chat.id).entries[0];
			assert.equal(entry.status, "failed");
			assert.match(entry.error, pattern);
		}
	} finally { t.done(); }
});

test("侧聊：第一次调了工具会带「不要用工具」重试一次，第二次成功就是 done", async () => {
	const t = tmp();
	try {
		let n = 0;
		const seen = [];
		const { service } = sideFixture(t.dir, { callModel: async (request) => { n += 1; seen.push(request.retry); return n === 1 ? { text: "", toolCalls: true } : { text: "文字回答" }; } });
		const chat = service.create({ projectId: "p1", sources: ["a"] });
		await (await service.ask(chat.id, "问")).done;
		assert.deepEqual(seen, [false, true]);
		assert.equal(service.list("p1")[0].entries[0].status, "done");
	} finally { t.done(); }
});

test("侧聊：某个源读不到时背景里写明，不静默跳过，也不影响其他源", async () => {
	const t = tmp();
	try {
		const { service, calls } = sideFixture(t.dir, { readSource: async (id) => { if (id === "gone") throw new Error("离线且无日志"); return { rows: [{ role: "user", text: "在" }] }; } });
		const chat = service.create({ projectId: "p1", sources: ["ok", "gone"] });
		await (await service.ask(chat.id, "问")).done;
		assert.match(calls[0].turns[0].text, /读不到这个对话：离线且无日志/);
		assert.equal(service.list("p1")[0].entries[0].status, "done");
	} finally { t.done(); }
});

test("侧聊：重启遗留的 answering 判失败；删除侧聊会中止在飞的调用", async () => {
	const t = tmp();
	try {
		const first = sideFixture(t.dir, { callModel: () => new Promise(() => {}) });
		const chat = first.service.create({ projectId: "p1", sources: ["a"] });
		await first.service.ask(chat.id, "永远不回");
		// 模拟重启：新服务实例没有这条飞行记录
		const second = sideFixture(t.dir);
		const entry = second.service.list("p1")[0].entries[0];
		assert.equal(entry.status, "failed");
		assert.match(entry.error, /重启/);
		assert.equal(second.service.remove(chat.id), true);
		assert.equal(second.service.list("p1").length, 0);
	} finally { t.done(); }
});

test("契约：成功码必须是 200（客户端 wbUnwrap 只把 200 当成功），失败码都不是 200", async () => {
	// 客户端的判定原文：var code = typeof payload.code === "number" ? payload.code : 0; if (code !== 200) throw ...
	const clientSees = (payload) => (typeof payload.code === "number" ? payload.code : 0) === 200;
	const t = tmp();
	try {
		const views = createViewStore(join(t.dir, "views.json"));
		const { service: side } = sideFixture(t.dir);
		const host = { views, side, deliver: async () => {} };
		const row = views.add({ sessionId: "s1", projectId: "p1", title: "选", view: CHOICE, interactive: true });
		const good = [
			await handleViewRoute(host, "GET", "/views", {}),
			await handleViewRoute(host, "GET", "/side", {}),
			await handleViewRoute(host, "POST", "/side", {}, { projectId: "p1", sources: ["a"] }),
			await handleViewRoute(host, "POST", "/views/" + row.id + "/answer", {}, { action: "pick", values: { selected: ["甲"] } })
		];
		for (const result of good) assert.equal(clientSees(result), true, "成功必须被客户端认成成功：" + JSON.stringify(result.code));
		const bad = [
			await handleViewRoute(host, "POST", "/views/" + row.id + "/answer", {}, { action: "pick", values: { selected: ["甲"] } }), // stale
			await handleViewRoute(host, "POST", "/side/nope/ask", {}, { text: "问" }),                                                  // notFound
			await handleViewRoute(host, "POST", "/side", {}, {}).then(async (made) => handleViewRoute(host, "POST", "/side/" + made.data.chat.id + "/ask", {}, { text: "问" })), // 没连线
			await handleViewRoute(host, "GET", "/nothing", {})                                                                          // 404
		];
		for (const result of bad) assert.equal(clientSees(result), false, "失败不能被客户端认成成功：" + result.code);
		assert.equal(VIEW_CODE.ok, 200);
	} finally { t.done(); }
});

// ── 工具函数 ──

test("assembleText：拼文本、认出工具调用与各种结束原因", async () => {
	async function* stream(chunks) { for (const chunk of chunks) yield chunk; }
	assert.deepEqual(await assembleText(stream([{ type: "text-delta", index: 0, text: "你" }, { type: "text-delta", index: 0, text: "好" }, { type: "finish", reason: { kind: "stop" } }])), { text: "你好", toolCalls: false });
	assert.equal((await assembleText(stream([{ type: "tool-call-delta", index: 0, id: "x", name: "bash", argumentsDelta: "{}" }, { type: "finish", reason: { kind: "tool-calls" } }]))).toolCalls, true);
	assert.deepEqual(await assembleText(stream([{ type: "text-delta", index: 0, text: "半" }, { type: "finish", reason: { kind: "max-tokens" } }])), { text: "半", cutOff: true });
	assert.deepEqual(await assembleText(stream([{ type: "finish", reason: { kind: "error", failure: { message: "挂了" } } }])), { failed: "挂了" });
});

test("transcriptOf：跳过空行、标注说话人；超长保留最近的部分", () => {
	assert.equal(transcriptOf([{ role: "user", text: "甲" }, { role: "assistant", text: "  " }, { role: "assistant", text: "乙" }]), "用户：甲\n\n助手：乙");
	const long = transcriptOf([{ role: "user", text: "x".repeat(50) }, { role: "user", text: "最近的一句" }], { maxChars: 30 });
	assert.match(long, /^（更早的内容已省略）/);
	assert.match(long, /最近的一句$/);
});

// ── 路由 ──

test("路由：views 列表 / 作答 / 作废，侧聊创建 / 连线 / 提问 / 删除，错误走业务码", async () => {
	const t = tmp();
	try {
		const views = createViewStore(join(t.dir, "views.json"));
		const { service: side } = sideFixture(t.dir);
		const delivered = [];
		const host = { views, side, deliver: async (sessionId, message) => { delivered.push([sessionId, message]); } };
		const row = views.add({ sessionId: "s1", projectId: "p1", title: "选", view: CHOICE, interactive: true });
		const listed = await handleViewRoute(host, "GET", "/views", { projectId: "p1" });
		assert.equal(listed.data.views.length, 1);
		const answered = await handleViewRoute(host, "POST", "/views/" + row.id + "/answer", {}, { action: "pick", values: { selected: ["甲"] } });
		assert.equal(answered.code, VIEW_CODE.ok);
		assert.equal(delivered.length, 1);
		const again = await handleViewRoute(host, "POST", "/views/" + row.id + "/answer", {}, { action: "pick", values: { selected: ["甲"] } });
		assert.equal(again.code, VIEW_CODE.stale);
		assert.equal((await handleViewRoute(host, "POST", "/views/nope/dismiss", {}, {})).code, VIEW_CODE.stale);

		const created = await handleViewRoute(host, "POST", "/side", {}, { projectId: "p1", title: "侧", sources: ["a"] });
		const chatId = created.data.chat.id;
		const asked = await handleViewRoute(host, "POST", "/side/" + chatId + "/ask", {}, { text: "问" });
		assert.equal(asked.code, VIEW_CODE.ok);
		assert.equal(asked.data.entry.status, "answering");
		assert.equal((await handleViewRoute(host, "POST", "/side/" + chatId + "/ask", {}, { text: "" })).code, VIEW_CODE.param);
		assert.equal((await handleViewRoute(host, "PUT", "/side/" + chatId + "/sources", {}, { sources: ["a", "b"] })).data.chat.sources.length, 2);
		assert.equal((await handleViewRoute(host, "DELETE", "/side/" + chatId, {})).data.removed, true);
		assert.equal((await handleViewRoute(host, "GET", "/nothing", {})).status, 404);
	} finally { t.done(); }
});
