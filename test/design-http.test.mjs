// 组件工坊 P1：`/design/*` HTTP 路由（设计方案 §8.3 / §9.2 / §9.3）。
//
// 守三条边界：① 读不需要 token，写要同源 token；② 人保存 = by=user（会把元素标成 userEdited → agent 之后被锁）；
// ③ 在线画布登记与渲染回报能让 `whales_design_write` 拿到 render 结果，没有在线画布就 unverified。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");
process.env.DSH_AGENT_WHALES_PRESET_DIR = mkdtempSync(join(tmpdir(), "aw-design-http-presets-"));

/** 假会话日志：一条用户消息（折叠成 m1），供 sourceMessageIds 核对。 */
const SESSION_EVENTS = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "做一个审批时间线组件" }] } }];

async function boot(workspacePath, sessionEvents) {
	const routes = [];
	const disposers = [];
	const tools = {};
	const followups = [];   // 记录 agent.followup 收到的消息（评论回传断言用）
	const ctx = {
		get(name) {
			if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
			if (name === "sessions") return { list: () => [], get: (id) => ({ id, title: id, running: false, session: { id } }) };
			if (name === "agents") return {
				// 会话 a 在线（评论回传要能送到），其它离线
				get: (id) => (id === "session-a" ? { id, status: "idle", session: { id, events: [] }, followup: (message) => { followups.push({ to: id, text: message && message.content && message.content[0] ? message.content[0].text : "" }); } } : undefined),
				list: () => []
			};
			if (name === "sessionPersistence") return { stat: () => undefined };
		// 消息证据：whales_design_write 要求 sourceMessageIds 能在会话日志里核对到（与 prototype_draw 同口径）
			if (name === "sessionQuery") return { readSession: async () => ({ events: sessionEvents }) };
			if (name === "workspaceRegistry") return { list: () => [{ path: workspacePath, sessionIds: ["session-a"] }] };
			if (name === "tools") return { register: (tool) => { tools[tool.name] = tool; return () => {}; }, schemas: () => [] };
			return undefined;
		},
		effect(run) { const dispose = run(); if (typeof dispose === "function") disposers.push(dispose); return dispose; },
		on() { return () => {}; }
	};
	plugin.apply(ctx);
	const route = routes.find((item) => item && typeof item.handler === "function");
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
		const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await res.text();
		let parsed;
		try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
		return { status: res.status, body: parsed };
	}
	const close = () => new Promise((resolve) => { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); server.close(() => resolve()); });
	return { call, close, tools, followups, base, handler: route.handler, dispose() { disposers.forEach((dispose) => dispose()); } };
}

function freshStore() {
	const dir = mkdtempSync(join(tmpdir(), "aw-design-http-"));
	plugin.setProjectStorePathForTests(join(dir, "projects.json"));
	plugin.setProposalStorePathForTests(join(dir, "proposals.json"));
	plugin.setHandoffsStorePathForTests(join(dir, "handoffs.json"));
	plugin.setEventsStorePathForTests(join(dir, "events.json"));
	plugin.resetDesignServiceForTests();
	return dir;
}

// 插件 envelope 的错误码（与 lib/index.js 的 PROJECT_CODE 同口径）
const PROJECT_PARAM = 40001;

const SOURCE = `import { Button } from "@cds";
export default function ApprovalTimeline({ label }: { label?: string }) {
  return (<div className="flex flex-col gap-4 p-5"><h2>{label || "审批时间线"}</h2><Button variant="primary">确定</Button></div>);
}
`;

async function withApp(run, sessionEvents = SESSION_EVENTS) {
	const dir = freshStore();
	const app = await boot(dir, sessionEvents);
	try {
		const token = (await app.call("GET", "/activity")).body.controlToken;
		const projectId = (await app.call("POST", "/projects", { name: "设计项目", mainSessionId: "session-a" }, token)).body.data.project.projectId;
		return await run({ app, token, projectId, dir });
	} finally { app.dispose(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("对话画板保存本次交付版本，读取项目 CSS，并接受纯图片消息作为出处", () => withApp(async ({ app, token, projectId, dir }) => {
	const write = app.tools.whales_design_write;
	const agent = { id: "session-a" };
	const notes = await app.tools.whales_flow_read.execute({}, { agent });
	assert.ok(JSON.stringify(notes).includes("用户附图"));
	writeFileSync(join(dir, "theme.css"), ":root { --accent: #694bd6; }");
	const component = { kind: "component", name: "PeriodSwitch", sourceMessageIds: ["m1"], source: 'export default function PeriodSwitch(){ return <button>月</button>; }' };
	assert.equal((await write.execute(component, { agent })).written, true);
	const artboard = {
		kind: "artboard", artboardId: "recap", width: "mobile", styleFiles: ["theme.css"], sourceMessageIds: ["m1"],
		source: 'import PeriodSwitch from "@project/PeriodSwitch"; export const css = ".recap{border-radius:20px;color:var(--accent)}"; export default function Recap(){return <main className="recap">旧版 <PeriodSwitch /></main>;}'
	};
	const first = await write.execute(artboard, { agent, callId: "call-first" });
	assert.equal(first.chatPreview, true);
	const url = "/design/delivery?sessionId=session-a&callId=call-first";
	assert.equal((await app.call("GET", url)).status, 403);
	const saved = (await app.call("GET", url, undefined, token)).body.data;
	assert.equal(saved.projectId, projectId);
	assert.equal(saved.entryId, "recap");
	assert.match(saved.boards[0].code, /旧版/);
	assert.match(saved.boards[0].code, /--accent: #694bd6/);
	assert.match(saved.modules.PeriodSwitch, /月/);

	writeFileSync(join(dir, "theme.css"), ":root { --accent: #123456; }");
	await write.execute({ ...component, source: component.source.replace("月", "年") }, { agent });
	const newer = await write.execute({ ...artboard, source: artboard.source.replace("旧版", "新版") }, { agent, callId: "call-new" });
	assert.equal(newer.chatPreview, true);
	assert.deepEqual((await app.call("GET", url, undefined, token)).body.data, saved);
	const current = (await app.call("GET", "/design/delivery?sessionId=session-a&callId=call-new", undefined, token)).body.data;
	assert.match(current.boards[0].code, /新版/);
	assert.match(current.boards[0].code, /--accent: #123456/);
	assert.match(current.modules.PeriodSwitch, /年/);
	assert.equal((await app.call("GET", "/design/delivery?sessionId=session-other&callId=call-first", undefined, token)).body.data, null);
	await assert.rejects(write.execute({ ...artboard, styleFiles: ["../outside.css"] }, { agent }), /无法读取项目样式/);
}, [{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "image", id: "ref-1" }] } }]));

test("PRD 的 Markdown、工作区文件与 Notion 来源共用需求，旧回复保留已发布版本", () => withApp(async ({ app, token, projectId, dir }) => {
	const tool = app.tools.whales_requirement;
	const agent = { id: "session-a" };
	const created = await tool.execute({
		action: "create", title: "时间回顾", acceptance: ["点榜单能定位到地图"],
		prd: { markdown: "## 热力图\n隐藏家和公司" }
	}, { agent, callId: "prd-v1" });
	assert.equal(created.chatPreview, true);
	const id = created.requirement.reqId;
	const base = "/projects/" + projectId + "/requirements";
	const getSnapshot = async (callId) => (await app.call("GET", "/design/delivery?sessionId=session-a&callId=" + callId, undefined, token)).body.data;
	const first = await getSnapshot("prd-v1");
	assert.equal(first.type, "prd");
	assert.equal(first.reqId, id);
	assert.equal(first.version, 1);
	assert.match(first.prd.markdown, /热力图/);

	const board = await app.tools.whales_design_write.execute({
		kind: "artboard", artboardId: "recap-prd", title: "时间回顾", sourceMessageIds: ["m1"],
		source: "export default function Board(){return <main>到访热力图</main>;}"
	}, { agent, callId: "board-prd" });
	assert.equal(board.requirementId, id);

	const file = join(dir, "recap.md");
	writeFileSync(file, "# 文件版本\n从工作区读到的正文");
	const fromFile = await tool.execute({ action: "update", reqId: id, expectedRevision: created.requirement.revision,
		prd: { file } }, { agent, callId: "prd-v2" });
	assert.equal(fromFile.requirement.prdRevision, 2);
	assert.equal(fromFile.requirement.prd.file, "recap.md");
	writeFileSync(file, "# 文件已更改\n刷新后读取");
	const refreshed = (await app.call("PATCH", base + "/" + id, {
		expectedRevision: fromFile.requirement.revision, prd: { file: "recap.md" }
	}, token)).body.data.requirement;
	assert.equal(refreshed.prdRevision, 3);
	assert.match(refreshed.prd.markdown, /刷新后读取/);
	assert.match((await getSnapshot("prd-v2")).prd.markdown, /工作区读到/);
	assert.deepEqual(await getSnapshot("prd-v1"), first);

	const url = "https://example.notion.site/recap";
	const linked = await tool.execute({ action: "update", reqId: id, expectedRevision: refreshed.revision,
		prd: { url, markdown: "## 当前摘要\n以 Notion 中的范围为准" } }, { agent, callId: "prd-notion" });
	assert.equal(linked.requirement.prdRevision, 4);
	assert.equal((await getSnapshot("prd-notion")).prd.url, url);
	assert.equal((await app.call("GET", base + "/" + id)).body.data.requirement.prd.url, url);
	const listed = (await app.call("GET", base)).body.data.requirements.find((row) => row.reqId === id);
	assert.equal(listed.prd, undefined);
	assert.equal(listed.prdRevision, 4);
	await assert.rejects(tool.execute({ action: "update", reqId: id, prd: { url: "javascript:alert(1)" } }, { agent }), /HTTP\(S\)/);
	await assert.rejects(tool.execute({ action: "update", reqId: id, prd: { file: "../private.md" } }, { agent }), /无法读取 PRD 文件/);
}));

test("普通对话首次发布 PRD 时就地建立项目", () => withApp(async ({ app, projectId }) => {
	const agent = { id: "new-prd-conversation" };
	const first = await app.tools.whales_requirement.execute({
		action: "create", title: "新项目 PRD", prd: { markdown: "## 范围\n首轮需求" }
	}, { agent, callId: "first-prd" });
	assert.equal(first.chatPreview, true);
	assert.notEqual(first.projectId, projectId);
	assert.equal(first.requirement.composerSessionId, agent.id);
}));

test("文件变更流：SSE 连接先发 ready，并在文件变化时发定向通知", () => withApp(async ({ app, projectId, dir }) => {
	const headers = {};
	let text = "";
	const cleanup = [];
	const res = {
		statusCode: 0,
		setHeader(name, value) { headers[name] = value; },
		flushHeaders() {},
		write(chunk) { text += chunk; },
		end() {},
		on(event, listener) { if (event === "close") cleanup.push(listener); }
	};
	const req = { url: "/agent-whales/api/store-stream?projectId=" + encodeURIComponent(projectId), headers: {}, on() {} };
	await app.handler(req, res);
	assert.equal(res.statusCode, 200);
	assert.match(headers["content-type"], /text\/event-stream/);
	assert.match(text, /event: ready/);
	writeFileSync(join(dir, "canvas.json"), "{}");
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.match(text, /event: store-changed/);
	assert.match(text, /canvas\.json/);
	cleanup.forEach((listener) => listener());
}));

test("POST /design/source：人保存源码要 token；by=user 会把元素标成 userEdited（之后 agent 写入被锁）", () => withApp(async ({ app, token, projectId }) => {
	const anon = await app.call("POST", "/design/source", { projectId, name: "ApprovalTimeline", source: SOURCE });
	assert.equal(anon.body.code, 40301, "没有同源 token 不许写（PROJECT_CODE.forbidden）");

	const saved = await app.call("POST", "/design/source", { projectId, name: "ApprovalTimeline", title: "审批时间线", source: SOURCE }, token);
	assert.equal(saved.body.code, 200, JSON.stringify(saved.body));
	assert.equal(saved.body.data.written, true);

	// 画布元素存在且 userEdited
	const canvasBody = (await app.call("GET", `/canvas?projectId=${projectId}`)).body;
	const page = canvasBody.data.page || canvasBody.data;
	assert.ok(page && page.elements, "画布读要能拿到 elements，实际 " + JSON.stringify(canvasBody).slice(0, 120));
	// 画布读的 elements 是**数组**（元素快照），按 id 找
	const element = (Array.isArray(page.elements) ? page.elements : Object.values(page.elements)).find((row) => row && row.id === "comp:ApprovalTimeline");
	assert.ok(element, "元素要出现在画布上");
	assert.equal(element.kind, "component");
	assert.equal(element.userEdited, true, "人保存的就要锁定（agent 之后不能再改）");

	// agent 再写 → locked
	const write = app.tools.whales_design_write;
	const locked = await write.execute({ kind: "component", name: "ApprovalTimeline", source: SOURCE.replace("审批时间线", "审批时间线·改"), sourceMessageIds: ["m1"] }, { agent: { id: "session-a" } });
	assert.equal(locked.written, false);
	assert.equal(locked.locked, true);
}));

test("GET /design/source：读要同源 token（防匿名拿别人的源码）；不存在给 40401", () => withApp(async ({ app, token, projectId }) => {
	await app.call("POST", "/design/source", { projectId, name: "ApprovalTimeline", source: SOURCE }, token);
	const got = await app.call("GET", `/design/source?projectId=${projectId}&kind=component&id=ApprovalTimeline`, undefined, token);
	assert.equal(got.body.code, 200);
	assert.equal(got.body.data.source, SOURCE);
	assert.ok(Array.isArray(got.body.data.jsxTable) && got.body.data.jsxTable.length > 0, "定位表要带给前端（点选 / 评论用）");

	const missing = await app.call("GET", `/design/source?projectId=${projectId}&kind=component&id=Nope`, undefined, token);
	assert.equal(missing.body.code, 40401);
}));

test("画布直接改：/design/classes 与 /design/edit 能改文本和 token 类", () => withApp(async ({ app, token, projectId }) => {
	await app.call("POST", "/design/source", { projectId, name: "ApprovalTimeline", source: SOURCE }, token);
	const classes = await app.call("GET", `/design/classes?projectId=${projectId}&kind=component&id=ApprovalTimeline&wsrc=e0`, undefined, token);
	assert.equal(classes.body.code, 200, JSON.stringify(classes.body));
	assert.ok(classes.body.data.classes.some((row) => row.name === "flex"));

	const textEdit = await app.call("POST", "/design/edit", { projectId, kind: "component", name: "ApprovalTimeline", wsrc: "e2", text: "确认" }, token);
	assert.equal(textEdit.body.code, 200, JSON.stringify(textEdit.body));
	assert.match(textEdit.body.data.source, />确认<\/Button>/);

	const classEdit = await app.call("POST", "/design/edit", { projectId, kind: "component", name: "ApprovalTimeline", wsrc: "e0", fromClass: "flex", toClass: "grid" }, token);
	assert.equal(classEdit.body.code, 200, JSON.stringify(classEdit.body));
	assert.match(classEdit.body.data.source, /className="grid flex-col/);
}));

test("GET /design/components|artboards：列表只读；summary 给计数与组件包", () => withApp(async ({ app, token, projectId }) => {
	await app.call("POST", "/design/source", { projectId, name: "ApprovalTimeline", source: SOURCE }, token);
	const comps = await app.call("GET", `/design/components?projectId=${projectId}`, undefined, token);
	assert.equal(comps.body.code, 200);
	assert.deepEqual(comps.body.data.components.map((row) => row.name), ["ApprovalTimeline"]);
	const arts = await app.call("GET", `/design/artboards?projectId=${projectId}`, undefined, token);
	assert.deepEqual(arts.body.data.artboards, []);
	const summary = await app.call("GET", `/design/summary?projectId=${projectId}`, undefined, token);
	assert.equal(summary.body.data.summary.components, 1);
	assert.equal(summary.body.data.packId, "shadcn", "没有组件库节点时是内置包");
}));

test("在线画布：GET /design/live 登记 + 领请求；POST /design/live/result 把渲染回报交给等待方", () => withApp(async ({ app, token, projectId }) => {
	// 没登记过时，工具拿到的应该是 unverified
	// 不登记在线：工具应当在**短时间内**就给 unverified（no-live-canvas），不白等 8 秒
	const startedAt = Date.now();
	const unverified = await app.tools.whales_design_write.execute(
		{ kind: "component", name: "FirstCard", source: 'export default function FirstCard() { return <div className="p-4">x</div>; }', sourceMessageIds: ["m1"] },
		{ agent: { id: "session-a" } }
	);
	assert.equal(unverified.render.status, "unverified", "没有在线画布不能假装渲染过");
	assert.equal(unverified.render.visual, "unavailable");
	assert.ok(Date.now() - startedAt < 3000, "没有在线画布要立刻回 unverified，不要等满 8 秒");

	// 画布页登记在线
	const live = await app.call("GET", `/design/live?projectId=${projectId}`, undefined, token);
	assert.equal(live.body.code, 200);
	assert.equal(live.body.data.online, true);
	assert.equal(live.body.data.requests.length, 0);

	// 工具写一个，另一个「画布页」去领请求并回报
	// 工具会等在线画布回报；这里先发起，再去领请求（并发）
	const pending = app.tools.whales_design_write.execute(
		{ kind: "component", name: "SecondCard", source: 'export default function SecondCard() { return <div className="p-4">y</div>; }', sourceMessageIds: ["m1"] },
		{ agent: { id: "session-a" } }
	);
	// 等工具进入等待渲染回报的状态
	let requests = [];
	for (let i = 0; i < 100 && requests.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		requests = (await app.call("GET", `/design/live?projectId=${projectId}`, undefined, token)).body.data.requests;
	}
	assert.equal(requests.length, 1, "画布页应该能领到一条渲染请求");
	assert.equal(requests[0].target.type, "component");
	assert.equal(requests[0].target.name, "SecondCard");

	const settled = await app.call("POST", "/design/live/result", {
		requestId: requests[0].requestId,
		ok: true,
		ms: 15,
		width: 1024,
		height: 600,
		nodeCount: 12,
		textLength: 20,
		textSample: "y",
		buttons: 0,
		inputs: 0,
		tables: 0
	}, token);
	assert.equal(settled.body.data.settled, true);

	const result = await pending;
	assert.equal(result.render.status, "ok");
	assert.equal(result.render.dom.nodeCount, 12);
	assert.equal(result.render.visual, "unavailable", "即使渲染成功也要说清拿不到图");
}));

test("渲染回报：画布报错时工具拿到 status=error 与错误信息", () => withApp(async ({ app, token, projectId }) => {
	await app.call("GET", `/design/live?projectId=${projectId}`, undefined, token);
	const pending = app.tools.whales_design_write.execute(
		{ kind: "component", name: "BoomCard", source: 'export default function BoomCard() { return <div className="p-4">x</div>; }', sourceMessageIds: ["m1"] },
		{ agent: { id: "session-a" } }
	);
	let requests = [];
	for (let i = 0; i < 100 && requests.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		requests = (await app.call("GET", `/design/live?projectId=${projectId}`, undefined, token)).body.data.requests;
	}
	await app.call("POST", "/design/live/result", { requestId: requests[0].requestId, ok: false, error: "Cannot read properties of undefined" }, token);
	const result = await pending;
	assert.equal(result.render.status, "error");
	assert.match(result.render.error, /undefined/);
}));

test("评论钉：GET 不需 token；POST 要 token；落盘后能被 whales_design_read(what:comments) 读到", () => withApp(async ({ app, token, projectId }) => {
	const anon = await app.call("POST", `/design/comments?projectId=${projectId}`, { target: "comp:ApprovalTimeline", body: "这里换个颜色" });
	assert.equal(anon.body.code, 40301);

	const made = await app.call("POST", `/design/comments?projectId=${projectId}`, { target: "comp:ApprovalTimeline", wsrc: "e1", line: 3, column: 10, tag: "h2", body: "标题太大了" }, token);
	assert.equal(made.body.code, 200);
	assert.equal(made.body.data.comment.status, "open");
	assert.equal(made.body.data.comment.author, "user");

	const list = await app.call("GET", `/design/comments?projectId=${projectId}`, undefined, token);
	assert.equal(list.body.data.comments.length, 1);

	const read = await app.tools.whales_design_read.execute({ what: "comments" }, { agent: { id: "session-a" } });
	assert.equal(read.comments.length, 1);
	assert.equal(read.comments[0].body, "标题太大了");
	assert.equal(read.comments[0].line, 3);
}));

test("评论回传（设计方案 §9.3）：组件评论发给「最近写它的会话」；不在线时如实说没送到，但评论照样保存", () => withApp(async ({ app, token, projectId }) => {
	// 人保存一次，让 meta.sessionId 有值（记录「最近写它的会话」）
	await app.call("POST", "/design/source", { projectId, name: "ApprovalTimeline", source: SOURCE }, token);

	// 该组件没有 meta.sessionId（人保存时不带会话）→ 退到项目主对话（session-a，在线）
	const made = await app.call("POST", `/design/comments?projectId=${projectId}`, { target: "comp:ApprovalTimeline", wsrc: "e1", line: 3, column: 10, tag: "h2", body: "标题太大了" }, token);
	assert.equal(made.body.code, 200);
	assert.equal(made.body.data.comment.status, "open");
	// 这个 fixture 里 session-a（项目主对话）在线 → **必须真的送到**。
	// （P2 审计 I10：原来写 `assert.ok([四种].includes(x))`，任何值都通过，等于什么都没验）
	assert.equal(made.body.data.delivered, "sent", "评论要真的送到 agent，实际 " + made.body.data.delivered);
	assert.equal(app.followups.length, 1, "要真的发一条消息出去");
	const text = app.followups[0].text;
	assert.match(text, /评论/);
	assert.match(text, /ApprovalTimeline/);
	assert.match(text, /标题太大了/);
	assert.match(text, /第 3 行/, "消息里要带行列，agent 不用翻源码");
	assert.match(text, /resolvesComments/, "要告诉 agent 改完怎么标记已处理");

	// 评论无论如何都要落盘（送到与否不影响人写下的内容）
	const list = await app.call("GET", `/design/comments?projectId=${projectId}`, undefined, token);
	assert.equal(list.body.data.comments.length, 1);
}));

test("POST /design/source：编译失败回 40001 且不落盘；未知 /design 子路径回 404", () => withApp(async ({ app, token, projectId }) => {
	const bad = await app.call("POST", "/design/source", { projectId, name: "BrokenCard", source: "export default function BrokenCard() { return <div><span></div>; }" }, token);
	assert.ok([40000, 40001].includes(bad.body.code), "编译失败回参数错误码，实际 " + bad.body.code);
	assert.match(bad.body.msg || "", /第 \d+ 行/, "错误信息要带行列");
	const list = await app.call("GET", `/design/components?projectId=${projectId}`, undefined, token);
	assert.deepEqual(list.body.data.components, [], "编译失败不能有文件");

	const nope = await app.call("GET", "/design/nope");
	assert.equal(nope.status, 404);
}));

test("带 projectId 的越权：path 里的 projectId 只能是合法 id（不能借 ../ 读别的目录）", () => withApp(async ({ app, projectId, token }) => {
	const bad = await app.call("GET", `/design/source?projectId=../..&kind=component&id=ApprovalTimeline`, undefined, token);
	// 只认「被明确拒绝」的码：500 不算通过（那可能是崩了而不是挡住了）
	assert.ok([40001, 40401, 40301].includes(bad.body.code), "非法 projectId 要给出明确拒绝码，实际 " + bad.body.code);
	assert.equal(bad.body.data && bad.body.data.source, undefined, "绝不能返回任何源码内容");
}));

// ── P2 审计补的用例：compile / unlock / resolvesComments 闭环 ──────────────

test("POST /design/compile：只编译不落盘（编辑器改源码时的实时反馈）", () => withApp(async ({ app, token, projectId }) => {
	const ok = await app.call("POST", "/design/compile", { projectId, kind: "component", name: "Draft", source: SOURCE }, token);
	assert.equal(ok.body.code, 200, JSON.stringify(ok.body).slice(0, 200));
	assert.equal(ok.body.data.compile.ok, true);
	assert.ok(ok.body.data.compiled.length > 0, "要给编译产物（编辑器预览用）");
	// 不落盘：列表里不该出现 Draft
	const list = await app.call("GET", `/design/components?projectId=${projectId}`, undefined, token);
	assert.equal(list.body.data.components.some((row) => row.name === "Draft"), false, "compile 绝不能写盘");
	// 语法错要带回行列
	const bad = await app.call("POST", "/design/compile", { projectId, source: "export default function X() { return <div><span></div>; }" }, token);
	// 编译失败回 200 + compile.ok=false + 带行列的错误（编辑器靠它显示错误条，不靠 HTTP 状态码）
	assert.equal(bad.body.data.compile.ok, false, "语法错要如实回，实际 " + JSON.stringify(bad.body).slice(0, 160));
	assert.match(bad.body.data.compile.errors[0].message, /第 \d+ 行/, "错误信息要带行列");
	// 没 token 不许调（防止被当成跨项目探测工具）
	const anon = await app.call("POST", "/design/compile", { projectId, source: SOURCE });
	assert.equal(anon.body.code, 40301);
}));

test("POST /design/unlock：人显式解锁后 agent 能再写；解锁本身也要 token", () => withApp(async ({ app, token, projectId }) => {
	await app.call("POST", "/design/source", { projectId, name: "ApprovalTimeline", source: SOURCE }, token);
	const write = app.tools.whales_design_write;
	const locked = await write.execute({ kind: "component", name: "ApprovalTimeline", source: SOURCE.replace("审批时间线", "改了"), sourceMessageIds: ["m1"] }, { agent: { id: "session-a" } });
	assert.equal(locked.locked, true, "人保存过 → agent 被锁");

	const anon = await app.call("POST", "/design/unlock", { projectId, name: "ApprovalTimeline" });
	assert.equal(anon.body.code, 40301, "解锁只有人能点（要同源 token）");

	const unlocked = await app.call("POST", "/design/unlock", { projectId, name: "ApprovalTimeline" }, token);
	assert.equal(unlocked.body.code, 200, JSON.stringify(unlocked.body).slice(0, 200));
	assert.equal(unlocked.body.data.unlocked, true);

	const again = await write.execute({ kind: "component", name: "ApprovalTimeline", source: SOURCE.replace("审批时间线", "改了"), sourceMessageIds: ["m1"] }, { agent: { id: "session-a" } });
	assert.equal(again.written, true, "解锁后 agent 应该能写，实际 " + JSON.stringify(again).slice(0, 160));
}));

test("评论闭环（§9.3）：agent 带 resolvesComments 改完 → 评论变 resolved，read 不再列它", () => withApp(async ({ app, token, projectId }) => {
	const made = await app.call("POST", `/design/comments?projectId=${projectId}`, { target: "comp:ApprovalTimeline", wsrc: "e1", line: 3, body: "标题太大" }, token);
	const commentId = made.body.data.comment.id;
	assert.ok(commentId, "先有一条 open 评论");

	const write = app.tools.whales_design_write;
	const done = await write.execute({ kind: "component", name: "ApprovalTimeline", source: SOURCE, sourceMessageIds: ["m1"], resolvesComments: [commentId, "c-does-not-exist"] }, { agent: { id: "session-a" } });
	assert.equal(done.written, true);
	assert.deepEqual(done.resolvedComments, [commentId], "要标掉那条评论");
	assert.deepEqual(done.resolvedMissing, ["c-does-not-exist"], "不存在的 id 要如实说，不能装没事");

	const read = await app.tools.whales_design_read.execute({ what: "comments" }, { agent: { id: "session-a" } });
	assert.equal(read.comments.length, 0, "resolved 的不再出现在未处理列表里");

	// 人也能手动关
	const second = await app.call("POST", `/design/comments?projectId=${projectId}`, { target: "comp:ApprovalTimeline", body: "再改一处" }, token);
	const resolvedByUser = await app.call("POST", "/design/comments/resolve", { projectId, ids: [second.body.data.comment.id] }, token);
	assert.equal(resolvedByUser.body.data.resolved.length, 1);
}));

test("内置 shadcn 库节点下也能用 @cds（P3 真机抓到：曾误判成「不支持 raw」）", () => withApp(async ({ app, token, projectId }) => {
	// 画布上摆一个内置 shadcn 库节点
	await app.call("POST", "/canvas/elements", { projectId, upsert: [{ id: "lib:shadcn", kind: "library", x: 0, y: 0, w: 200, h: 100, data: { packId: "shadcn" } }] }, token);
	const src = 'import { Badge } from "@cds";\nexport default function CardWithBadge() { return <div className="p-4"><Badge>x</Badge></div>; }';
	const written = await app.call("POST", "/design/source", { projectId, name: "CardWithBadge", source: src }, token);
	assert.equal(written.body.code, 200, "内置包应该支持 @cds，实际：" + JSON.stringify(written.body).slice(0, 200));
	assert.equal(written.body.data.written, true);
	const back = await app.call("GET", `/design/source?projectId=${projectId}&kind=component&id=CardWithBadge`, undefined, token);
	assert.equal(back.body.data.compiledCode.length > 0, true, "要能编译出产物");
}));

test("pack-api：内置 shadcn 包也要给组件清单（真机验证：agent 抱怨过「没有 api.json，只能猜 props」）", () => withApp(async ({ app, token, projectId }) => {
	await app.call("POST", "/canvas/elements", { projectId, expectedRevision: 0, upsert: [{ id: "lib:shadcn", kind: "library", x: 0, y: 0, w: 200, h: 100, data: { packId: "shadcn" } }] }, token);
	const got = await app.call("GET", `/design/pack-api?projectId=${projectId}`, undefined, token);
	assert.equal(got.body.code, 200);
	assert.equal(got.body.data.packId, "shadcn");
	assert.ok(got.body.data.components !== null, "内置包必须给组件清单，不能是 null");
	const names = Object.keys(got.body.data.components);
	assert.ok(names.length >= 20, "清单要有全部原始组件，实际 " + names.length);
	for (const must of ["Button", "Input", "Badge", "Table", "Stack", "Title", "Text"]) {
		assert.ok(names.includes(must), "清单要包含 " + must);
	}
	// 每个组件要有 props 说明（agent 靠它写对 props，而不是猜）
	const button = got.body.data.components.Button.props;
	assert.ok(button && button.variant, "Button 要说明 variant");
	assert.deepEqual(button.variant.values, ["default", "secondary", "outline", "ghost", "destructive"]);
}));

test("高保真设计指南能在会话创建项目之前读取，并进入工具的文本输出", async () => {
	const dir = freshStore();
	const app = await boot(dir, SESSION_EVENTS);
	try {
		const designRead = app.tools.whales_design_read;
		const args = { what: "design-guide" };
		const guide = await designRead.execute(args, { agent: { id: "session-without-project" } });
		assert.match(guide.guide, /当前项目/);
		assert.match(guide.guide, /参考图/);
		assert.match(guide.guide, /先验看/);
		assert.match(designRead.output.render(args, guide)[0].text, /画板设计指南/);
	} finally {
		app.dispose();
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
