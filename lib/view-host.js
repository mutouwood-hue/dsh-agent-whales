/**
 * 宿主侧：show_view 卡片 + 侧聊（2026-11-18）。
 *
 * 本文件刻意不 import 任何 @deepseek-ai/* 包、也不碰 lib/index.js 的内部状态：所有外部能力
 * （会话投递、读会话文本、调模型、判根 agent）都由接线处注入，所以能离线单测，
 * 也不会和 index.js 的其他改动互相踩。接线点见本文件末尾 `describeWiring()`。
 *
 * 两块能力：
 *  1) show_view：agent 在对话里画图表 / 表格 / 表单。每张卡落一条记录（views.json），
 *     画布据此从产出它的对话旁边伸出一张关联卡片；交互卡（options / confirm / form / submit）
 *     等用户在卡上作答——作答是用户动作，走 followup 回到原会话，不是插件代发。
 *  2) 侧聊：画布上的一个对话节点，连线到若干对话后读取它们的文本背景再开聊。
 *     只读：不调工具、不写源会话。
 *
 * 校验 / 公式 / 回答协议来自 lib/view/（deep-view 0.1.2，Apache-2.0，已拷入，见 NOTICE.md）。
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { checkShownView, validateViewAnswer, viewReply, viewReplyText, showViewParameters, showViewDescription } from "./view/index.js";

const MAX_VIEWS = 500;
const MAX_CHATS = 100;
const MAX_ENTRIES_PER_CHAT = 200;
const MAX_SOURCES = 8;
const QUESTION_MAX = 4000;
const TRANSCRIPT_CHARS = 60000;

/** 业务码：与 lib/index.js 的 envelope 同族（成功 = 200，客户端 wbUnwrap 只认 200），接线处原样透传。 */
export const VIEW_CODE = { ok: 200, param: 40001, notFound: 40401, stale: 40901, busy: 40902, unavailable: 50301 };

class HostError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}
const fail = (code, message) => { throw new HostError(code, message); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ── 小型 JSON 文件库：同步读写 + 临时文件改名，进程内串行（Node 单线程，同步即原子）──

export function createJsonFile(file, empty) {
	function read() {
		if (!existsSync(file)) return empty();
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			return isRecord(parsed) ? parsed : empty();
		} catch (error) {
			// 损坏：留一份 .corrupt 再当空库用，绝不静默覆盖用户数据。
			try { renameSync(file, file + ".corrupt-" + Date.now()); } catch (renameError) { /* 留不下备份也要继续 */ }
			return empty();
		}
	}
	function write(data) {
		mkdirSync(dirname(file), { recursive: true });
		const temp = file + "." + process.pid + ".tmp";
		try {
			writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
			renameSync(temp, file);
		} catch (error) {
			try { unlinkSync(temp); } catch (unlinkError) { /* 临时文件可能没建出来 */ }
			throw error;
		}
	}
	return { read, write };
}

// ── 1) 视图卡片库 ──────────────────────────────────────────────────────────

/**
 * status：shown（纯展示）/ pending（等用户作答）/ answered / dismissed / expired（用户发了别的消息，卡作废）。
 * 同一会话同时只留一张 pending：新的交互卡出现，旧的作废。
 */
export function createViewStore(file, { now = Date.now } = {}) {
	const db = createJsonFile(file, () => ({ views: [] }));
	function load() {
		const data = db.read();
		if (!Array.isArray(data.views)) data.views = [];
		return data;
	}
	function trim(data) {
		if (data.views.length <= MAX_VIEWS) return;
		const keep = [];
		let over = data.views.length - MAX_VIEWS;
		for (const row of data.views) {
			if (over > 0 && row.status !== "pending") { over -= 1; continue; }
			keep.push(row);
		}
		data.views = keep;
	}
	return {
		add(input) {
			const data = load();
			const interactive = input.interactive === true;
			if (interactive) {
				for (const row of data.views) {
					if (row.sessionId === input.sessionId && row.status === "pending") { row.status = "expired"; row.finishedAt = now(); }
				}
			}
			const row = {
				id: randomUUID(),
				sessionId: input.sessionId,
				projectId: input.projectId || "",
				callId: input.callId || "",
				title: input.title || "",
				view: input.view,
				interactive,
				status: interactive ? "pending" : "shown",
				createdAt: now()
			};
			data.views.push(row);
			trim(data);
			db.write(data);
			return row;
		},
		get(id) { return load().views.find((row) => row.id === id); },
		list(filter = {}) {
			// sessionId 是硬过滤；projectId / sessionIds 是「属于这个项目」的两种证据（卡画出来时会话可能还没入项目，所以会话 id 也算）。
			const ids = Array.isArray(filter.sessionIds) ? new Set(filter.sessionIds) : undefined;
			const scoped = ids !== undefined || !!filter.projectId;
			const rows = load().views.filter((row) => {
				if (filter.sessionId && row.sessionId !== filter.sessionId) return false;
				if (!scoped) return true;
				return (ids !== undefined && ids.has(row.sessionId)) || (!!filter.projectId && row.projectId === filter.projectId);
			});
			const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 0;
			return limit > 0 ? rows.slice(-limit) : rows;
		},
		/** 把 pending 认领为 answered；不是 pending 返回 undefined（第二次作答被拒）。 */
		claim(id, answer) {
			const data = load();
			const row = data.views.find((item) => item.id === id);
			if (!row || row.status !== "pending") return undefined;
			row.status = "answered";
			row.answer = answer;
			row.finishedAt = now();
			db.write(data);
			return row;
		},
		/** 投递失败时把认领退回去。 */
		restore(id) {
			const data = load();
			const row = data.views.find((item) => item.id === id);
			if (!row || row.status !== "answered") return;
			row.status = "pending";
			delete row.answer;
			delete row.finishedAt;
			db.write(data);
		},
		dismiss(id) {
			const data = load();
			const row = data.views.find((item) => item.id === id);
			if (!row || row.status !== "pending") return undefined;
			row.status = "dismissed";
			row.finishedAt = now();
			db.write(data);
			return row;
		},
		/** 用户在该会话发了任意消息：挂着的交互卡作废（卡从画布上退成「已作废」，不刷新页面）。 */
		expireSession(sessionId) {
			const data = load();
			let changed = 0;
			for (const row of data.views) {
				if (row.sessionId === sessionId && row.status === "pending") { row.status = "expired"; row.finishedAt = now(); changed += 1; }
			}
			if (changed > 0) db.write(data);
			return changed;
		}
	};
}

/**
 * 上游 deep-view 的 parameters 是「属性表简写」（给 defineTool 用）；whales 一律 register 完整 JSON Schema，
 * 缺 type:"object" 会被宿主判非法（历史事故：type:null → 全网 400）。这里展开成完整 Schema。
 */
export const SHOW_VIEW_PARAMETERS = {
	type: "object",
	properties: {
		title: { type: "string", description: showViewParameters.title.description },
		view: { type: "object", additionalProperties: true, description: showViewParameters.view.description },
		await_reply: { type: "boolean", description: showViewParameters.await_reply.description }
	},
	required: ["view"],
	additionalProperties: false
};

/**
 * show_view 工具定义（裸对象，由接线处 `tools.register`）。
 * 输出是 `{ message }`：宿主要求 output.schema 为 object（与本仓库其他工具一致），渲染给模型的就是 message 一句话。
 *
 * @param {object} deps
 * @param {ReturnType<typeof createViewStore>} deps.store
 * @param {(agent: object) => string|undefined} deps.refuseNonRoot 非根 agent 返回拒绝理由，根 agent 返回 undefined
 * @param {(sessionId: string) => string} [deps.projectOf] 会话 → 项目 id（没有就空串）
 */
export function createShowViewTool({ store, refuseNonRoot, projectOf }) {
	async function run(args, exec) {
		const checked = checkShownView(args && args.title, args && args.view);
		if (checked.error !== undefined) return checked.error;
		if (!checked.interactive && args.await_reply === true) return "This view has nothing to submit; call show_view with await_reply: false.";
		if (checked.interactive && args.await_reply === false) return "This view has controls to submit, so it waits for the user's answer; call show_view without await_reply: false.";
		const sessionId = exec && exec.agent && exec.agent.session && typeof exec.agent.session.id === "string" ? exec.agent.session.id : (exec && exec.agent && typeof exec.agent.id === "string" ? exec.agent.id : "");
		if (checked.interactive) {
			const refused = typeof refuseNonRoot === "function" ? refuseNonRoot(exec && exec.agent) : undefined;
			if (refused !== undefined) return refused;
			if (sessionId === "") return "This view cannot wait for the user here; include the question in your reply instead.";
		}
		if (sessionId !== "") {
			try {
				store.add({ sessionId, projectId: typeof projectOf === "function" ? projectOf(sessionId) : "", callId: exec && exec.callId, title: checked.title, view: checked.view, interactive: checked.interactive });
			} catch (error) {
				// 展示型：存不下也不该让 agent 的回复失败；交互型：存不下就等不了答案，如实说。
				if (checked.interactive) return "The view could not be kept open for an answer: " + (error && error.message ? error.message : String(error));
			}
		}
		if (!checked.interactive) return "The view is on screen.";
		if (exec && typeof exec.concludeTurn === "function") exec.concludeTurn();
		return "The view is on screen; the user's answer arrives as their next message.";
	}
	return {
		name: "show_view",
		description: showViewDescription({ where: "the chat", placement: "It appears under your reply, and on the project canvas as a card linked to this conversation." }),
		parameters: SHOW_VIEW_PARAMETERS,
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: value && typeof value.message === "string" ? value.message : "(empty)" }]
		},
		async execute(args, exec) {
			return { message: await run(args, exec) };
		}
	};
}

/**
 * 用户在卡上作答：校验 → 认领 → 作为用户消息投回原会话。
 * 投递失败把认领退回去，用户可以再点一次。
 *
 * @param {object} deps
 * @param {ReturnType<typeof createViewStore>} deps.store
 * @param {(sessionId: string, message: object) => Promise<void>|void} deps.deliver 投递（接线处：agent.followup）
 */
export async function answerView({ store, deliver }, id, action, values) {
	const row = store.get(id);
	if (!row) fail(VIEW_CODE.notFound, "找不到这张卡片");
	if (row.status !== "pending") fail(VIEW_CODE.stale, "这张卡片已经不再等待作答");
	const checked = validateViewAnswer(row.view, action, values);
	if (checked.error !== undefined) fail(VIEW_CODE.param, checked.error);
	const reply = viewReply(row, action, values);
	if (reply === undefined) fail(VIEW_CODE.param, "答案无法生成");
	// 给模型看的是可读文本（带标题与答案摘要），来源如实标 user：这是人点出来的。
	const text = viewReplyText(reply.text);
	const claimed = store.claim(id, { action, values: checked });
	if (!claimed) fail(VIEW_CODE.stale, "这张卡片刚刚已被作答");
	try {
		await deliver(row.sessionId, { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
	} catch (error) {
		store.restore(id);
		fail(VIEW_CODE.unavailable, "投递失败：" + (error && error.message ? error.message : String(error)));
	}
	return store.get(id);
}

// ── 2) 侧聊 ────────────────────────────────────────────────────────────────

const SIDE_MARKER = "agent-whales/side";
const SIDE_PROMPT = [
	SIDE_MARKER,
	"以下是被连到这个侧聊上的对话记录（只读背景，截至现在）。请只根据这些记录和本侧聊里已有的问答回答。",
	"不要调用任何工具。记录里没有的信息就直说没有。不要声称自己做过任何事。"
].join("\n");
const SIDE_RETRY = "不要调用任何工具，只用文字回答。";

/** 把折叠后的消息行拼成背景文本；超长从头部截（保留最近的）。 */
export function transcriptOf(rows, { maxChars = TRANSCRIPT_CHARS } = {}) {
	const lines = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		const text = row && typeof row.text === "string" ? row.text.trim() : "";
		if (text === "") continue;
		lines.push((row.role === "assistant" ? "助手" : "用户") + "：" + text);
	}
	let joined = lines.join("\n\n");
	if (joined.length > maxChars) joined = "（更早的内容已省略）\n" + joined.slice(joined.length - maxChars);
	return joined;
}

/** 消费一次模型流：只取文本，识别工具调用与结束原因。chunk 形状见 dsh-llm assistant-stream。 */
export async function assembleText(stream) {
	let text = "";
	let toolCalls = false;
	let finish;
	for await (const chunk of stream) {
		if (!chunk || typeof chunk !== "object") continue;
		if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
		else if (chunk.type === "tool-call-delta") toolCalls = true;
		else if (chunk.type === "finish") finish = chunk.reason;
	}
	const kind = finish && finish.kind;
	if (kind === "error" || kind === "aborted") return { failed: (finish.failure && finish.failure.message) || kind };
	if (kind === "max-tokens") return { text: text.trim(), cutOff: true };
	return { text: text.trim(), toolCalls: toolCalls || kind === "tool-calls" };
}

/**
 * 侧聊服务。
 *
 * @param {object} deps
 * @param {string} deps.file side.json 路径
 * @param {(sessionId: string) => Promise<{title?: string, rows: {role: string, text: string}[]}>} deps.readSource 读源会话的文本行（live 读内存、离线读盘）
 * @param {(request: {sourceSessionId: string, turns: {role: "user"|"assistant", text: string}[], retry: boolean, signal: AbortSignal}) => Promise<{text?: string, failed?: string, cutOff?: boolean, toolCalls?: boolean}>} deps.callModel
 */
export function createSideService({ file, readSource, callModel, now = Date.now }) {
	const db = createJsonFile(file, () => ({ chats: [] }));
	const flights = new Map(); // entryId -> AbortController
	const load = () => { const data = db.read(); if (!Array.isArray(data.chats)) data.chats = []; return data; };
	const save = (data) => db.write(data);

	/** 进程重启时遗留的 answering 一律判失败（没有对应的飞行中调用）。 */
	function reconcile(data) {
		let touched = false;
		for (const chat of data.chats) {
			for (const entry of chat.entries || []) {
				if (entry.status === "answering" && !flights.has(entry.id)) { entry.status = "failed"; entry.error = entry.error || "重启前这次提问没有答完"; entry.finishedAt = entry.finishedAt || now(); touched = true; }
			}
		}
		if (touched) save(data);
		return data;
	}
	const findChat = (data, id) => data.chats.find((chat) => chat.id === id);
	const cleanSources = (value) => {
		const list = [];
		for (const raw of Array.isArray(value) ? value : []) {
			const id = typeof raw === "string" ? raw.trim() : "";
			if (id !== "" && !list.includes(id)) list.push(id);
		}
		return list.slice(0, MAX_SOURCES);
	};

	return {
		list(projectId) {
			return reconcile(load()).chats.filter((chat) => !projectId || chat.projectId === projectId);
		},
		create({ projectId, title, sources }) {
			const data = load();
			if (data.chats.length >= MAX_CHATS) fail(VIEW_CODE.param, "侧聊太多了，先删掉不用的");
			const chat = { id: randomUUID(), projectId: projectId || "", title: typeof title === "string" && title.trim() !== "" ? title.trim().slice(0, 60) : "侧聊", sources: cleanSources(sources), createdAt: now(), updatedAt: now(), entries: [] };
			data.chats.push(chat);
			save(data);
			return chat;
		},
		setSources(chatId, sources) {
			const data = load();
			const chat = findChat(data, chatId);
			if (!chat) fail(VIEW_CODE.notFound, "找不到这个侧聊");
			chat.sources = cleanSources(sources);
			chat.updatedAt = now();
			save(data);
			return chat;
		},
		remove(chatId) {
			const data = load();
			const chat = findChat(data, chatId);
			if (!chat) return false;
			for (const entry of chat.entries || []) { const flight = flights.get(entry.id); if (flight) flight.abort(); }
			data.chats = data.chats.filter((item) => item.id !== chatId);
			save(data);
			return true;
		},
		/** 提问：立刻落一条 answering 并返回；答案异步写回，前端轮询 list。 */
		async ask(chatId, text) {
			const question = typeof text === "string" ? text.trim() : "";
			if (question === "") fail(VIEW_CODE.param, "先写下要问的问题");
			if (question.length > QUESTION_MAX) fail(VIEW_CODE.param, "问题太长（上限 " + QUESTION_MAX + " 字）");
			const data = reconcile(load());
			const chat = findChat(data, chatId);
			if (!chat) fail(VIEW_CODE.notFound, "找不到这个侧聊");
			if ((chat.entries || []).some((entry) => entry.status === "answering")) fail(VIEW_CODE.busy, "上一个问题还没答完，等它或先取消");
			if (chat.sources.length === 0) fail(VIEW_CODE.param, "这个侧聊还没连到任何对话：先拖一条线过来");
			const entry = { id: randomUUID(), question, answer: "", status: "answering", createdAt: now() };
			chat.entries = chat.entries || [];
			chat.entries.push(entry);
			if (chat.entries.length > MAX_ENTRIES_PER_CHAT) chat.entries.splice(0, chat.entries.length - MAX_ENTRIES_PER_CHAT);
			chat.updatedAt = now();
			save(data);
			const controller = new AbortController();
			flights.set(entry.id, controller);
			const done = this.run(chat.id, entry.id, controller.signal);
			return { chatId: chat.id, entry: { ...entry }, done };
		},
		cancel(chatId, entryId) {
			const flight = flights.get(entryId);
			if (!flight) return false;
			// 先改状态再 abort：在 abort 回合里落地的调用不能再把它写成 done。
			const data = load();
			const entry = (findChat(data, chatId) || {}).entries && findChat(data, chatId).entries.find((item) => item.id === entryId);
			if (entry && entry.status === "answering") { entry.status = "cancelled"; entry.finishedAt = now(); save(data); }
			flight.abort();
			return true;
		},
		/** 内部：真正调模型。公开只是为了 ask 能引用；测试可直接 await ask().done。 */
		async run(chatId, entryId, signal) {
			const settle = (patch) => {
				const data = load();
				const chat = findChat(data, chatId);
				const entry = chat && (chat.entries || []).find((item) => item.id === entryId);
				if (!entry || entry.status !== "answering") return false; // 已被取消 / 删除：第一个落笔的赢
				Object.assign(entry, patch, { finishedAt: now() });
				chat.updatedAt = entry.finishedAt;
				save(data);
				return true;
			};
			try {
				const chat = findChat(load(), chatId);
				const entry = chat && chat.entries.find((item) => item.id === entryId);
				if (!chat || !entry) return;
				// 背景：每个源会话的文本行，按连线顺序拼接。读不到的源写明白，不静默跳过。
				const blocks = [];
				for (const sourceId of chat.sources) {
					try {
						const source = await readSource(sourceId);
						const body = transcriptOf(source && source.rows);
						blocks.push("<conversation id=\"" + sourceId + "\"" + (source && source.title ? " title=\"" + String(source.title).replace(/"/g, "'") + "\"" : "") + ">\n" + (body === "" ? "（这个对话还没有内容）" : body) + "\n</conversation>");
					} catch (error) {
						blocks.push("<conversation id=\"" + sourceId + "\">\n（读不到这个对话：" + (error && error.message ? error.message : String(error)) + "）\n</conversation>");
					}
				}
				if (signal.aborted) return;
				const context = SIDE_PROMPT + "\n\n" + blocks.join("\n\n");
				const done = chat.entries.filter((item) => item.id !== entryId && item.status === "done");
				const turns = [];
				done.forEach((item, index) => {
					turns.push({ role: "user", text: index === 0 ? context + "\n\n" + item.question : item.question });
					turns.push({ role: "assistant", text: item.answer });
				});
				const first = done.length === 0;
				for (let attempt = 0; attempt < 2; attempt += 1) {
					const askText = (first ? context + "\n\n" : "") + (attempt === 1 ? SIDE_RETRY + "\n\n" : "") + entry.question;
					const result = await callModel({ sourceSessionId: chat.sources[0], turns: [...turns, { role: "user", text: askText }], retry: attempt === 1, signal });
					if (signal.aborted) return;
					if (result.failed !== undefined) { settle({ status: "failed", error: String(result.failed), answer: "" }); return; }
					if (result.cutOff) { settle({ status: "failed", error: "回答被长度上限截断", answer: result.text || "" }); return; }
					if (result.toolCalls) { if (attempt === 0) continue; settle({ status: "failed", error: "模型在被告知不要用工具后仍调用了工具", answer: "" }); return; }
					if (!result.text) { settle({ status: "failed", error: "模型没有写任何内容", answer: "" }); return; }
					settle({ status: "done", answer: result.text });
					return;
				}
			} catch (error) {
				if (!signal.aborted) settle({ status: "failed", error: error && error.message ? error.message : String(error), answer: "" });
			} finally {
				flights.delete(entryId);
			}
		}
	};
}

// ── 3) 路由分派（纯函数；鉴权由接线处负责）──────────────────────────────────

/**
 * 把 `/views…` 与 `/side…` 的请求映射成 { status, code, msg, data }。
 * 读操作无需 token；所有写操作由接线处先验 x-whales-token 再调用本函数。
 *
 * 路由表（相对 /agent-whales/api）：
 *   GET    /views?sessionId=&projectId=
 *   POST   /views/:id/answer   { action, values }
 *   POST   /views/:id/dismiss
 *   GET    /side?projectId=
 *   POST   /side               { projectId, title, sources }
 *   PUT    /side/:id/sources   { sources }
 *   POST   /side/:id/ask       { text }
 *   POST   /side/:id/cancel    { entryId }
 *   DELETE /side/:id
 */
export async function handleViewRoute(host, method, path, query, body) {
	const ok = (data) => ({ status: 200, code: VIEW_CODE.ok, msg: "success", data });
	const parts = path.split("/").filter(Boolean);
	const b = isRecord(body) ? body : {};
	try {
		if (parts[0] === "views") {
			if (parts.length === 1 && method === "GET") {
				const sessionIds = typeof query.sessionIds === "string" && query.sessionIds !== "" ? query.sessionIds.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 64) : undefined;
				return ok({ views: host.views.list({ sessionId: query.sessionId, projectId: query.projectId, sessionIds, limit: 60 }) });
			}
			if (parts.length === 3 && method === "POST" && parts[2] === "answer") return ok({ view: await answerView({ store: host.views, deliver: host.deliver }, parts[1], b.action, b.values) });
			if (parts.length === 3 && method === "POST" && parts[2] === "dismiss") {
				const row = host.views.dismiss(parts[1]);
				if (!row) fail(VIEW_CODE.stale, "这张卡片已经不再等待作答");
				return ok({ view: row });
			}
		}
		if (parts[0] === "side") {
			if (parts.length === 1 && method === "GET") return ok({ chats: host.side.list(query.projectId) });
			if (parts.length === 1 && method === "POST") return ok({ chat: host.side.create({ projectId: b.projectId, title: b.title, sources: b.sources }) });
			if (parts.length === 2 && method === "DELETE") return ok({ removed: host.side.remove(parts[1]) });
			if (parts.length === 3 && method === "PUT" && parts[2] === "sources") return ok({ chat: host.side.setSources(parts[1], b.sources) });
			if (parts.length === 3 && method === "POST" && parts[2] === "ask") {
				const started = await host.side.ask(parts[1], b.text);
				return ok({ chatId: started.chatId, entry: started.entry });
			}
			if (parts.length === 3 && method === "POST" && parts[2] === "cancel") return ok({ cancelled: host.side.cancel(parts[1], String(b.entryId || "")) });
		}
		return { status: 404, code: VIEW_CODE.notFound, msg: "no such route", data: null };
	} catch (error) {
		if (error instanceof HostError) return { status: 200, code: error.code, msg: error.message, data: null };
		return { status: 500, code: 50001, msg: error && error.message ? error.message : String(error), data: null };
	}
}

/** 接线说明（供落到 index.js / client.js 时对照；本函数不做任何事）。 */
export function describeWiring() {
	return [
		"index.js: import { createViewStore, createShowViewTool, createSideService, handleViewRoute } from './view-host.js'",
		"index.js: tools.register(createShowViewTool({ store, refuseNonRoot, projectOf }))，用 try/catch 兜（别家已注册同名工具时 warn 而不是整插件起不来）",
		"index.js: ctx.on('session/event') 里 user/message → views.expireSession(sessionId)",
		"index.js: ACTIVITY_PATH 下新增 /views* 与 /side*：GET 无 token；POST/PUT/DELETE 先验 x-whales-token，再 handleViewRoute",
		"index.js: deliver = (sessionId, message) => agent.followup(message)（agents.get(sessionId)，不在线抛错）",
		"index.js: readSource = readSessionLog + foldMessages；callModel = ctx.get('llm').stream(...) 喂给 assembleText",
		"client.js: 新 chunk lib/client.view.js（tools/flow-chunk/build-view.mjs），画布加 view / side 两类节点"
	];
}
