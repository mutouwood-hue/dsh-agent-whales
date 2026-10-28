/**
 * Host half of the dsh-agent-whales Web surface.
 *
 * 这一半有三件事：
 *
 * 1) 团队协作策略（2026-10-19）：往系统提示注册一段「默认先起团队」的策略。
 * 2) 工具活动采集（2026-10-26）：监听 `tools/execute` / `tools/result`，把「当前正在跑哪个工具」
 *    通过只读路由 `GET /agent-whales/api/activity` 交给浏览器半边，让头顶气泡能报到工具级。
 * 3) 串门（2026-10-29）：自己注册三个工具，让当前 agent 能去看/去打搅别的会话——
 *    参照 dsh-session-bridge 的核心机理（`agent.followup/steer` + 折叠 `session.events`），
 *    但只做「列表 / 发话 / 读回话」这一层，不搬它那套监控、思维链循环转移与归档。
 *
 * 三个能力都刻意不用硬依赖（不写 inject）：这一行同时还负责让 dsh-client-modules
 * 扫到 `dsh.client` 去装配浏览器半边，等不到服务会连鲸鱼娘一起消失，所以一律
 * 可选读取 + 失败兜底。
 */
import { randomUUID } from 'node:crypto';

const TEAM_POLICY = [
	"## 团队协作（默认开启）",
	"",
	"每个新会话默认以一个小团队推进，而不是你自己单干：",
	"",
	"1. 收到第一条消息后先判断任务形态。除了纯寒暄、单一事实问答、或一次只读操作之外，**默认先起团队**；拿不准时优先起团队，不要先单干再补救。",
	"2. 用 `spawn_teammate` 创建 1–3 个 teammate，每个职责单一、写入范围互不重叠；同一文件不要交给两个人改。名字用 kebab-case，描述写清边界。",
	"3. 用 `team_task_create` 把要并行的事拆成任务，写清验收标准与写入范围；有先后关系的用 `blocked_by` 串起来。",
	"4. 用 `send_message` 给成员补充上下文或纠偏，用 `list_agents` 看谁还在跑，用 `wait_agent` 等进展，卡住了用 `interrupt_agent`。",
	"5. 你自己只做整合、评审与最终答复，不要把手上的并行活儿重新串行做一遍。",
	"6. 确实无法拆分时（就一个问题、一次读取、一次确认）可以不建团队，但要在回复里说明为什么没建。",
	"",
	"不要创建没有具体产出、只是占位的 teammate。"
].join("\n");

const SECTION_NAME = "agent-whales/team-policy";
const SECTION_ORDER = 87;

/** 工具活动路由：前缀挂载，只回一个只读快照。 */
const ACTIVITY_PATH = "/agent-whales/api";
/** 超过这个时间没有更新的活动视为陈旧，不再报给客户端。 */
const ACTIVITY_TTL_MS = 5 * 60 * 1000;
/** 串门等回话的默认预算。 */
const VISIT_WAIT_MS = 60_000;

/**
 * 把「会话 → 当前工具」的表压成给客户端的 JSON 快照。
 * @param {Map<string, {tool: string, startedAt: number}>} table
 * @param {number} now
 * @param {number} ttlMs
 */
export function activityPayload(table, now, ttlMs = ACTIVITY_TTL_MS) {
	const active = {};
	for (const [sessionId, entry] of table) {
		if (!entry || typeof entry.tool !== "string") continue;
		const age = now - entry.startedAt;
		if (!(age >= 0) || age > ttlMs) continue;
		active[sessionId] = { tool: entry.tool, ageMs: age };
	}
	return { at: now, active };
}

// ── 会话日志兼容层 ────────────────────────────────────────────────────────
// session.events 在部分版本上是 getter，新版本改成了 snapshotEvents()；两者都读，
// 读不到就回空数组——串门读不到东西可以，把会话搞崩不行。
export function sessionEvents(session) {
	if (!session || typeof session !== "object") return [];
	if (Array.isArray(session.events)) return session.events;
	if (typeof session.snapshotEvents === "function") {
		try { return session.snapshotEvents(); } catch { return []; }
	}
	return [];
}

function blockText(content, wantedType = "text") {
	if (!Array.isArray(content)) return undefined;
	const parts = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		if (raw.type === wantedType && typeof raw.text === "string" && raw.text !== "") parts.push(raw.text);
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

/** 折叠日志成「谁说了什么」的行；只保留文本，够串门看了。 */
export function foldMessages(events) {
	const rows = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (!event || typeof event !== "object") continue;
		if (event.type === "user/message") {
			const source = event.data && event.data.source;
			if (source !== undefined && source.kind !== "user") continue;
			const text = blockText(event.data && event.data.content);
			if (text === undefined) continue;
			rows.push({ seq: event.seq, role: "user", text });
		} else if (event.type === "assistant/message") {
			const message = event.data && event.data.message;
			const text = blockText(message && message.content);
			if (text === undefined) continue;
			rows.push({ seq: event.seq, role: "assistant", text });
		}
	}
	return rows;
}

/** 会话标题：优先 session/title（后写胜），否则第一条用户消息前 40 字。 */
export function titleOf(events) {
	let title;
	for (const event of Array.isArray(events) ? events : []) {
		if (event && event.type === "session/title" && event.data && typeof event.data.title === "string" && event.data.title !== "") {
			title = event.data.title;
		}
	}
	if (title !== undefined) return title;
	for (const row of foldMessages(events)) {
		if (row.role !== "user") continue;
		const flat = row.text.replace(/\s+/g, " ").trim();
		if (flat === "") continue;
		return flat.length > 40 ? flat.slice(0, 40) + "…" : flat;
	}
	return undefined;
}

/** 日志里最大的事件序号（等回话的基线）。 */
export function maxSeq(events) {
	let max = -1;
	for (const event of Array.isArray(events) ? events : []) {
		if (event && typeof event.seq === "number" && event.seq > max) max = event.seq;
	}
	return max;
}

/** agent.followup / steer 接受的用户消息形状。 */
export function userMessage(text) {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: { kind: "user" }
	};
}

/**
 * 轮询等一条新的 assistant 文本。超时返回 timedOut 而不是抛错——
 * 串门没等到人回话是常态，不该让工具调用失败。
 */
export async function waitForReply(session, baselineSeq, timeoutMs, signal) {
	const started = Date.now();
	for (;;) {
		const rows = foldMessages(sessionEvents(session));
		for (let i = rows.length - 1; i >= 0; i -= 1) {
			const row = rows[i];
			if (row.role === "assistant" && row.seq > baselineSeq) {
				return { text: row.text, seq: row.seq, timedOut: false, waitedMs: Date.now() - started };
			}
		}
		if (signal && signal.aborted) return { text: undefined, seq: baselineSeq, timedOut: false, aborted: true, waitedMs: Date.now() - started };
		if (Date.now() - started >= timeoutMs) return { text: undefined, seq: baselineSeq, timedOut: true, waitedMs: Date.now() - started };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
	const get = typeof ctx.get === "function" ? (name) => ctx.get(name) : () => undefined;

	// ── 1) 团队协作策略 ────────────────────────────────────────────────────
	const systemPrompt = get("systemPrompt");
	if (systemPrompt && typeof systemPrompt.section === "function") {
		ctx.effect(function registerTeamPolicy() {
			try {
				return systemPrompt.section({
					name: SECTION_NAME,
					order: SECTION_ORDER,
					text: TEAM_POLICY
				});
			} catch (error) {
				// 提示段落注册失败不该拖垮本行。
				return function () {};
			}
		}, "agent-whales: team policy");
	}

	// ── 2) 工具活动采集 ────────────────────────────────────────────────────
	const running = new Map();
	const on = typeof ctx.on === "function" ? (name, listener) => ctx.on(name, listener) : undefined;

	if (on) {
		ctx.effect(
			() =>
				on("tools/execute", (exec, next) => {
					try {
						const sessionId = exec && exec.agent && exec.agent.id;
						const name = exec && exec.name;
						if (typeof sessionId === "string" && typeof name === "string") {
							running.set(sessionId, { tool: name, startedAt: Date.now() });
						}
					} catch (error) {
						/* 采集失败绝不影响真实调用 */
					}
					return next();
				}),
			"agent-whales: tools/execute"
		);

		ctx.effect(
			() =>
				on("tools/result", (exec) => {
					try {
						const sessionId = exec && exec.agent && exec.agent.id;
						if (typeof sessionId === "string") running.delete(sessionId);
					} catch (error) {
						/* 同上 */
					}
				}),
			"agent-whales: tools/result"
		);
	}

	// ── 3) 只读快照路由 ────────────────────────────────────────────────────
	const webServer = get("webServer");
	if (webServer && typeof webServer.register === "function") {
		ctx.effect(
			() =>
				webServer.register({
					kind: "prefix",
					path: ACTIVITY_PATH,
					handler: (req, res) => {
						const url = String((req && req.url) || "");
						if (url.indexOf("/activity") < 0) {
							res.statusCode = 404;
							res.end("not found");
							return;
						}
						let body;
						try {
							body = JSON.stringify(activityPayload(running, Date.now()));
						} catch (error) {
							body = '{"at":0,"active":{}}';
						}
						res.statusCode = 200;
						res.setHeader("content-type", "application/json; charset=utf-8");
						res.setHeader("cache-control", "no-store");
						res.end(body);
					}
				}),
			"agent-whales: activity route"
		);
	}

	// ── 4) 串门工具 ────────────────────────────────────────────────────────
	registerVisitTools(ctx, get);
}

/**
 * 注册三个串门工具。任何一步失败都只跳过该工具，不影响本行装配浏览器半边。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {(name: string) => unknown} get
 */
function registerVisitTools(ctx, get) {
	const tools = get("tools");
	if (!tools || typeof tools.register !== "function") return;

	/** @returns {{ id: string, status: string, session: unknown } | undefined} */
	function liveAgent(sessionId) {
		const agents = get("agents");
		if (!agents || typeof agents.get !== "function") return undefined;
		return agents.get(sessionId);
	}

	function sessionsByWorkspace() {
		const map = new Map();
		const registry = get("workspaceRegistry");
		if (!registry || typeof registry.list !== "function") return map;
		for (const workspace of registry.list()) {
			for (const id of workspace.sessionIds || []) map.set(String(id), String(workspace.id));
		}
		return map;
	}

	function safeRegister(tool) {
		try {
			tools.register({
				...tool,
				output: {
					schema: { type: "object", additionalProperties: true },
					render: (_args, value) => [{ type: "text", text: tool.render(value) }]
				}
			});
		} catch (error) {
			/* 工具注册失败只丢这一个能力 */
		}
	}

	safeRegister({
		name: "whales_visit_list",
		description:
			"列出这个 profile 里可以「串门」的会话：id、标题（能拿到时）、是否正在跑、属于哪个工作区。只读。" +
			"用来在给别的会话发消息之前先确认目标；subagent 会话也在列表里。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		render: (value) => {
			const rows = value.sessions || [];
			if (rows.length === 0) return "（没有可串门的会话）";
			return rows
				.map((row) => `${row.running ? "●" : "○"} ${row.sessionId}${row.title ? ` 「${row.title}」` : ""}${row.workspaceId ? ` @${row.workspaceId}` : ""}`)
				.join("\n");
		},
		async execute() {
			const agents = get("agents");
			const live = agents && typeof agents.list === "function" ? agents.list() : [];
			const workspaces = sessionsByWorkspace();
			const ids = new Set(workspaces.keys());
			for (const agent of live) if (agent && agent.id) ids.add(String(agent.id));
			const rows = [];
			for (const id of ids) {
				const agent = liveAgent(id);
				const title = agent && agent.session ? titleOf(sessionEvents(agent.session)) : undefined;
				rows.push({
					sessionId: id,
					...(title === undefined ? {} : { title }),
					running: Boolean(agent && agent.status === "running"),
					...(workspaces.has(id) ? { workspaceId: workspaces.get(id) } : {})
				});
			}
			return { sessions: rows, count: rows.length };
		}
	});

	safeRegister({
		name: "whales_visit_send",
		description:
			"去隔壁串门：给另一个会话发一条消息并让它开始干活（等同以用户身份说话）。" +
			"mode=queue 追加一轮（默认），mode=steer 打断它当前这一步并注入。目标必须是活着的会话（离线会话先把它在 UI 里打开）。" +
			"waitForReply=true 会阻塞到它产出下一条文本回复（默认不阻塞，只回执）。",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "目标会话 id（用 whales_visit_list 查）。" },
				message: { type: "string", description: "要说的话。" },
				mode: { type: "string", enum: ["queue", "steer"], description: "queue（默认）追加一轮；steer 打断当前步注入。" },
				waitForReply: { type: "boolean", description: "是否等它的下一条文本回复（默认 false）。" },
				timeoutMs: { type: "number", description: `等回话的预算，默认 ${VISIT_WAIT_MS}ms。` }
			},
			required: ["sessionId", "message"],
			additionalProperties: false
		},
		render: (value) => {
			const lines = [`已送到 ${value.sessionId}（${value.mode}）`];
			if (value.reply) lines.push(`回话：${value.reply.text ?? "（无文本）"}`);
			if (value.timedOut) lines.push(`[等到 ${value.waitedMs}ms 没等到新回复]`);
			return lines.join("\n");
		},
		async execute(args, exec) {
			const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
			const text = typeof args?.message === "string" ? args.message.trim() : "";
			if (sessionId === "") throw new Error("sessionId 不能为空");
			if (text === "") throw new Error("message 不能为空");
			const agent = liveAgent(sessionId);
			if (!agent) throw new Error(`会话 ${sessionId} 现在不活着（离线会话需要先在 UI 里打开）`);
			const mode = args.mode === "steer" ? "steer" : "queue";
			const baseline = maxSeq(sessionEvents(agent.session));
			if (mode === "steer") agent.steer(userMessage(text));
			else agent.followup(userMessage(text));
			let reply;
			let timedOut = false;
			if (args.waitForReply === true) {
				const budget = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? Math.min(args.timeoutMs, VISIT_WAIT_MS * 10) : VISIT_WAIT_MS;
				const result = await waitForReply(agent.session, baseline, budget, exec && exec.signal);
				timedOut = result.timedOut === true;
				reply = result.text === undefined ? { text: undefined, waitedMs: result.waitedMs } : { text: result.text, waitedMs: result.waitedMs };
			}
			return { sessionId, mode, accepted: true, ...(reply ? { reply } : {}), timedOut };
		}
	});

	safeRegister({
		name: "whales_visit_read",
		description:
			"看看隔壁在说什么：读取某个会话最近的对话（user / assistant 文本行），默认最近 20 行。" +
			"活着的会话直接读内存日志；已归档/离线的会话读不到就报错说明，不会猜。",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "目标会话 id。" },
				limit: { type: "number", description: "取最近多少行，默认 20，最大 100。" }
			},
			required: ["sessionId"],
			additionalProperties: false
		},
		render: (value) => {
			const rows = value.messages || [];
			if (rows.length === 0) return "（这个会话没有可读的文本消息）";
			return rows.map((row) => `${row.role === "user" ? "用户" : "助手"}: ${row.text}`).join("\n");
		},
		async execute(args) {
			const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
			if (sessionId === "") throw new Error("sessionId 不能为空");
			const limit = typeof args?.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 20;
			const agent = liveAgent(sessionId);
			if (!agent) throw new Error(`会话 ${sessionId} 现在不活着，读不到内存日志（离线日志读取未实现）`);
			const rows = foldMessages(sessionEvents(agent.session));
			return { sessionId, total: rows.length, messages: rows.slice(-limit) };
		}
	});
}
