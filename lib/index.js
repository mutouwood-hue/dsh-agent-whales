/**
 * Host half of the dsh-agent-whales Web surface.
 *
 * 这一半有四件事：
 *
 * 1) 团队协作策略（2026-10-19）：往系统提示注册一段「默认先起团队」的策略。
 * 2) 工具活动采集（2026-10-26）：监听 `tools/execute` / `tools/result`，把「当前正在跑哪个工具」
 *    通过只读路由 `GET /agent-whales/api/activity` 交给浏览器半边，让头顶气泡能报到工具级。
 * 3) 串门（2026-10-29）：自己注册四个工具，让当前 agent 能去看/去打搅/拉起别的会话——
 *    参照 dsh-session-bridge 的核心机理（`agent.followup/steer` + 折叠 `session.events`），
 *    但只做「列表 / 发话 / 恢复 / 读回话」这一层，不搬它那套监控、思维链循环转移与归档。
 * 4) 串门开关（2026-10-30）：`POST /agent-whales/api/visit-tools`（唯一写操作，带 controlToken）
 *    在运行时整体注册/注销上面四个工具；默认开启值可被插件 config 的 `visitTools` 覆盖。
 * 5) 素材路由（2026-10-30 D1）：`GET /agent-whales/api/art/manifest` 与
 *    `GET /agent-whales/api/art/<key>.webp`。client.js 只含代码与矢量兜底，精灵图
 *    改由宿主提供，浏览器只加载当前皮肤用到的 key。
 *
 * 这些能力都刻意不用硬依赖（不写 inject）：这一行同时还负责让 dsh-client-modules
 * 扫到 `dsh.client` 去装配浏览器半边，等不到服务会连鲸鱼娘一起消失，所以一律
 * 可选读取 + 失败兜底。`apply()` 自身绝不向外抛异常。
 */
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

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
/**
 * 官方 `dsh-system-prompt` 的 SECTION_ORDERS 里 TEAM_POLICY = 600（中央分配表）。
 * 旧值 87 是自造值：会插到 PLAN_POLICY(500) 之前，让「默认起团队」排在计划模式
 * 「先别动手」之前，语义顺序是错的。读不到官方表时退回同一个常量。
 */
const SECTION_ORDER_FALLBACK = 600;
/** 官方团队包注册的服务名（`dsh-experimental-agent-team` 里 `super(ctx, "agentTeams")`）。 */
const TEAM_SERVICE = "agentTeams";

/** 工具活动路由：前缀挂载，只回一个只读快照。 */
const ACTIVITY_PATH = "/agent-whales/api";
/** 只读快照的唯一子路径（方法校验要按精确路径判，不能按子串判）。 */
const ACTIVITY_ENDPOINT = `${ACTIVITY_PATH}/activity`;
/** 超过这个时间没有更新、且会话已经不在跑的活动视为陈旧，不再报给客户端。 */
const ACTIVITY_TTL_MS = 5 * 60 * 1000;
/**
 * 活动条目的硬上限。TTL 只决定「报不报」，条目本身还要能回收：
 * 会话被杀/工具结果丢失时没有第二条事件来删表，只能靠按年龄回收。
 * 取 1h 是因为 wait_agent 这类长跑工具最长可以挂 3600s。
 */
const ACTIVITY_MAX_AGE_MS = 60 * 60 * 1000;
/** 会话条目上限，异常场景下也不让这张 Map 无限长。 */
const ACTIVITY_MAX_SESSIONS = 512;

/** 串门等回话的默认预算。 */
const VISIT_WAIT_MS = 60_000;
/**
 * 串门等回话的硬上限。阻塞式等待占用的是调用方的一整步，超过 2 分钟既没意义
 * 又会和宿主的工具预算打架；工具定义里再声明一个略大的 timeoutMs 兜底。
 */
const VISIT_MAX_WAIT_MS = 120_000;
/** 失败事实的有效期：过期就不再让角色摆出错表情，避免一次异常一直哭。 */
const ERROR_TTL_MS = 60 * 1000;
/** 运行时状态条目多久没动静就回收（turn-stopping / status 都可能再也不来）。 */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
/** 单条消息回读的截断长度：20 条 × 上百 KB 的代码块足以打爆别人机器的上下文。 */
const READ_TEXT_LIMIT = 4000;
/** 一次回读的文本总量预算，超出时只给最近的几条。 */
const READ_TOTAL_LIMIT = 60_000;
/** 列表工具的输出行数上限：几千条历史会话不在一次工具调用里全量下发。 */
const LIST_MAX_ROWS = 500;

/**
 * 把「会话 → 当前工具」的表压成给客户端的 JSON 快照。
 * @param {Map<string, {tool: string, startedAt: number}>} table
 * @param {number} now
 * @param {number} ttlMs
 */
export function activityPayload(table, now, ttlMs = ACTIVITY_TTL_MS) {
	// now 必须是有限数字：否则 JSON.stringify 会把 at 变成 null，客户端会当非法快照。
	const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
	const budget = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : ACTIVITY_TTL_MS;
	const active = {};
	for (const [sessionId, entry] of table) {
		if (!entry || typeof entry.tool !== "string") continue;
		// startedAt 也必须是有限数字：数字字符串会被减法强转成伪造的 ageMs。
		const startedAt = entry.startedAt;
		if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) continue;
		const age = at - startedAt;
		if (!(age >= 0) || age > budget) continue;
		active[sessionId] = { tool: entry.tool, ageMs: age };
	}
	return { at, active };
}

// ── 会话日志兼容层 ────────────────────────────────────────────────────────
// session.events 在部分版本上是 getter，新版本改成了 snapshotEvents()；两者都读，
// 读不到就回空数组——串门读不到东西可以，把会话搞崩不行。
export function sessionEvents(session) {
	if (!session || typeof session !== "object") return [];
	try {
		// events 可能是会抛错的 getter，读取本身也要兜住。
		const events = session.events;
		if (Array.isArray(events)) return events;
	} catch (error) {
		/* 回落到 snapshotEvents */
	}
	if (typeof session.snapshotEvents === "function") {
		try {
			const events = session.snapshotEvents();
			if (Array.isArray(events)) return events;
		} catch (error) {
			/* 读不到当没有 */
		}
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

/**
 * 压一行进结果。seq 缺失时不要放 `seq: undefined` 键：工具返回值必须是 lossless JSON，
 * 带 undefined 的对象会让宿主判整次调用为非法输出（dsh-util-values 的 walkJsonValue）。
 */
function pushRow(rows, event, role, text) {
	rows.push(Number.isFinite(event.seq) ? { seq: event.seq, role, text } : { role, text });
}

/** 折叠日志成「谁说了什么」的行；只保留文本，够串门看了。 */
export function foldMessages(events) {
	const rows = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (!event || typeof event !== "object") continue;
		if (event.type === "user/message") {
			const data = event.data && typeof event.data === "object" ? event.data : undefined;
			const source = data === undefined ? undefined : data.source;
			// source 为 null/畸形按「非用户消息」处理（只有完全缺省才当作真人输入）；
			// 这里必须先判空再读 kind，否则 data.source=null 会把整个折叠打崩。
			if (source !== undefined && (source === null || typeof source !== "object" || source.kind !== "user")) continue;
			const text = blockText(data && data.content);
			if (text === undefined) continue;
			pushRow(rows, event, "user", text);
		} else if (event.type === "assistant/message") {
			const message = event.data && event.data.message;
			const text = blockText(message && message.content);
			if (text === undefined) continue;
			pushRow(rows, event, "assistant", text);
		}
	}
	return rows;
}

/** 会话标题：优先 session/title（后写胜），否则第一条用户消息前 40 字。 */
export function titleOf(events) {
	let title;
	for (const event of Array.isArray(events) ? events : []) {
		// 全空白标题等于没标题，按「没有」处理，回落首条用户消息。
		if (event && event.type === "session/title" && event.data && typeof event.data.title === "string" && event.data.title.trim() !== "") {
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

/** 日志里最大的事件序号（等回话的基线）。Infinity 不是有效序号，不能当基线。 */
export function maxSeq(events) {
	let max = -1;
	for (const event of Array.isArray(events) ? events : []) {
		if (event && typeof event.seq === "number" && Number.isFinite(event.seq) && event.seq > max) max = event.seq;
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
 *
 * 只折叠「上次之后新增的事件」：日志是追加式的（Session.snapshotEvents 的契约），
 * 原来每 100ms 全量 fold 一次，长会话下是 O(n²)，会把宿主的事件循环拖住。
 */
export async function waitForReply(session, baselineSeq, timeoutMs, signal) {
	const started = Date.now();
	// 低层语义：0 或负值 = 立即判超时（确定性测试要用）；只有非数字/非有限值才回落默认预算。
	// 工具入口另有一层归一：whales_visit_send 把 <=0 当「没给」，换成默认预算。
	const budget = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : VISIT_WAIT_MS;
	let scanned = 0;
	let rows = [];
	let lastEvent;
	for (;;) {
		const events = sessionEvents(session);
		const last = events.length > 0 ? events[events.length - 1] : undefined;
		// 长度变短 = 被压缩/截断；长度没变但尾部换了事件 = 截断后又追加到同样长度。
		// 两种都要作废增量缓存重扫，否则会漏掉新回复（session 的事件是冻结对象，可直接比引用）。
		if (events.length < scanned || (scanned > 0 && events.length === scanned && last !== lastEvent)) {
			scanned = 0;
			rows = [];
		}
		if (events.length > scanned) {
			rows = rows.concat(foldMessages(events.slice(scanned)));
			scanned = events.length;
		}
		lastEvent = last;
		for (let i = rows.length - 1; i >= 0; i -= 1) {
			const row = rows[i];
			if (row.role === "assistant" && typeof row.seq === "number" && row.seq > baselineSeq) {
				return { text: row.text, seq: row.seq, timedOut: false, waitedMs: Date.now() - started };
			}
		}
		// 超时/中止分支不放 text 键：undefined 键会让返回值不再是 lossless JSON。
		if (signal && signal.aborted) return { seq: baselineSeq, timedOut: false, aborted: true, waitedMs: Date.now() - started };
		if (Date.now() - started >= budget) return { seq: baselineSeq, timedOut: true, waitedMs: Date.now() - started };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/** ctx.logger 可能不存在/被替换，记日志本身不能再抛。 */
function warn(ctx, what, error) {
	try {
		const logger = ctx && ctx.logger;
		if (logger && typeof logger.warn === "function") {
			logger.warn(`dsh-agent-whales: ${what} 被跳过（${errorMessage(error)}）`);
		}
	} catch (suppressed) {
		/* 日志失败不影响插件 */
	}
}

/**
 * ctx.get 在插件卸载/上下文销毁时可能抛错；所有服务读取都经这一层，
 * 缺服务或服务抛错一律当 undefined，apply 才能保证不把宿主 fiber 带崩。
 */
function safeGetter(ctx) {
	if (!ctx || typeof ctx.get !== "function") return () => undefined;
	return (name) => {
		try {
			return ctx.get(name);
		} catch (error) {
			return undefined;
		}
	};
}

/**
 * 等宿主服务就绪后再执行一段注册；服务重载时会按新 fiber 自动重跑。
 *
 * 为什么必须这样：宿主把 profile 里的插件**并行**加载（cordis-plugin-loader 的
 * EntryGroup.update 用 Promise.allSettled），常见插件的 apply 早于
 * webServer / tools / systemPrompt 注册完成。如果只在 apply 时用 ctx.get() 探一眼，
 * 那一刻读不到就会把整块能力静默跳过——症状正是「浏览器半边在跑（鲸鱼娘还在），
 * 但 /agent-whales/api/* 全 404、串门工具没注册、团队策略段也消失」。
 * `ctx.inject()` 是 cordis 官方原语（官方工具插件全都用它）：服务出现时执行 callback，
 * 服务换 fiber 时先撤销旧作用域再重跑，正好覆盖热重载。
 *
 * 测试垫片 / 老版本宿主没有 ctx.inject：退化为立即执行（与改造前行为一致）。
 *
 * @param {object} ctx 插件上下文
 * @param {string[]} names 依赖的服务名
 * @param {string} label 日志用名字
 * @param {(scope: object) => void} callback 服务就绪后执行；参数是注入了该服务的子上下文
 * @returns {boolean} true = 已交给 inject 延迟注册
 */
function whenService(ctx, names, label, callback) {
	if (ctx && typeof ctx.inject === "function") {
		try {
			ctx.inject(names, (scope) => {
				const target = scope && typeof scope.effect === "function" ? scope : ctx;
				try {
					callback(target);
				} catch (error) {
					// 单个能力注册失败只丢它自己，不能影响同一插件里的其它能力。
					warn(ctx, label, error);
				}
			});
			return true;
		} catch (error) {
			warn(ctx, label, error);
		}
	}
	callback(ctx);
	return false;
}

/** 取活着的 agent；agents 服务缺失/抛错都当不存在。 */
function liveAgent(get, sessionId) {
	const agents = get("agents");
	if (!agents || typeof agents.get !== "function") return undefined;
	try {
		return agents.get(sessionId);
	} catch (error) {
		return undefined;
	}
}

/** 工作区 → 会话 id 的归属表；读不到就当空表（列表工具退化成只列活会话）。 */
function sessionsByWorkspace(get) {
	const map = new Map();
	const registry = get("workspaceRegistry");
	if (!registry || typeof registry.list !== "function") return map;
	try {
		for (const workspace of registry.list()) {
			if (!workspace) continue;
			let ids;
			// sessionIds 是 Workspace 实体上的 getter，读它也可能抛错，单项兜住。
			try {
				ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
			} catch (error) {
				ids = [];
			}
			const workspaceId = workspace.id === undefined || workspace.id === null ? undefined : String(workspace.id);
			for (const id of ids) {
				if (id === undefined || id === null) continue;
				map.set(String(id), workspaceId === undefined ? "" : workspaceId);
			}
		}
	} catch (error) {
		/* 工作区表读不到不影响串门 */
	}
	return map;
}

/** 超过硬上限的条目直接回收，并把会话数压回上限；只在读写路径上调用。 */
function pruneActivity(running, now) {
	for (const [sessionId, calls] of running) {
		for (const [callId, entry] of calls) {
			const age = now - (entry && entry.startedAt);
			if (!(age >= 0) || age > ACTIVITY_MAX_AGE_MS) calls.delete(callId);
		}
		if (calls.size === 0) running.delete(sessionId);
	}
	while (running.size > ACTIVITY_MAX_SESSIONS) {
		let oldestSession;
		let oldestAt = Infinity;
		for (const [sessionId, calls] of running) {
			for (const entry of calls.values()) {
				if (entry && entry.startedAt < oldestAt) {
					oldestAt = entry.startedAt;
					oldestSession = sessionId;
				}
			}
		}
		if (oldestSession === undefined) break;
		running.delete(oldestSession);
	}
}

/** 每个会话可能有并发工具：快照只报「最近开始的那一个」，但删除要按 callId 精确删。 */
function flattenActivity(running) {
	const table = new Map();
	for (const [sessionId, calls] of running) {
		let latest;
		for (const entry of calls.values()) {
			if (!entry || typeof entry.tool !== "string") continue;
			if (latest === undefined || entry.startedAt >= latest.startedAt) latest = entry;
		}
		if (latest !== undefined) table.set(sessionId, latest);
	}
	return table;
}

// ── 运行时状态（思考 / 失败 / 回合结束）─────────────────────────────────
// 工具活动只回答「现在在跑哪个工具」，回答不了「在等模型」「刚失败」「这一轮干完了」。
// 后三件事宿主事件里都有，但客户端看不到，所以在宿主侧聚合成「每会话一行」的事实表，
// 跟工具活动一起挂同一个只读路由；**表现层的判断留给客户端**（帧选择、去抖都不该由宿主决定）。

/** @returns {Map<string, Record<string, unknown>>} */
function createRuntimeState() {
	return new Map();
}

function runtimeRow(state, sessionId, now) {
	let row = state.get(sessionId);
	if (row === undefined) {
		row = { touchedAt: now, since: now };
		state.set(sessionId, row);
	}
	row.touchedAt = now;
	return row;
}

/** 会话被杀 / 回合再无声息时不会再有事件来删表，只能按「最后活动时间」回收。 */
function pruneRuntimeState(state, now) {
	for (const [sessionId, row] of state) {
		const touched = row && typeof row.touchedAt === "number" ? row.touchedAt : 0;
		if (!(now - touched >= 0) || now - touched > STATE_MAX_AGE_MS) state.delete(sessionId);
	}
	while (state.size > ACTIVITY_MAX_SESSIONS) {
		let oldestId;
		let oldestAt = Infinity;
		for (const [sessionId, row] of state) {
			const touched = row && typeof row.touchedAt === "number" ? row.touchedAt : 0;
			if (touched < oldestAt) {
				oldestAt = touched;
				oldestId = sessionId;
			}
		}
		if (oldestId === undefined) break;
		state.delete(oldestId);
	}
}

/**
 * 压成客户端能直接用的形状。**只放有值的键**：undefined 在 JSON 里会消失，
 * 这个插件在 lossless JSON 上已经翻过车，不再留这种坑。
 */
function runtimeStatePayload(state, now) {
	const out = {};
	for (const [sessionId, row] of state) {
		const item = {};
		if (typeof row.since === "number") item.since = row.since;
		if (row.running === true) {
			item.running = true;
			if (typeof row.runStartedAt === "number") item.runStartedAt = row.runStartedAt;
		}
		if (typeof row.streamingSince === "number" && now - row.streamingSince <= ACTIVITY_MAX_AGE_MS) item.streaming = true;
		if (typeof row.lastRunMs === "number" && row.lastRunMs >= 0) item.lastRunMs = row.lastRunMs;
		if (typeof row.lastErrorAt === "number" && now - row.lastErrorAt >= 0 && now - row.lastErrorAt <= ERROR_TTL_MS) {
			item.lastErrorAt = row.lastErrorAt;
			item.lastErrorKind = typeof row.lastErrorKind === "string" ? row.lastErrorKind : "unknown";
		}
		if (typeof row.lastTurnEndAt === "number" && now - row.lastTurnEndAt >= 0 && now - row.lastTurnEndAt <= ACTIVITY_MAX_AGE_MS) {
			item.lastTurnEndAt = row.lastTurnEndAt;
		}
		// 一条事实都没有的行不发给客户端（脏事件只建了表、没写入任何事实）。
		if (Object.keys(item).length > 0) out[sessionId] = item;
	}
	return out;
}

/** 单条消息截断：保留开头，明确告诉模型后面还有。 */
function clipText(text) {
	if (typeof text !== "string" || text.length <= READ_TEXT_LIMIT) return text;
	return text.slice(0, READ_TEXT_LIMIT) + "…";
}

// ── 1) 团队协作策略 ──────────────────────────────────────────────────────

/**
 * 组装时判断团队工具是否真的可见。团队工具是 per-agent scope 注册的
 * （tool-agent-team 在 agent.ctx 里 register），所以先按 context.scope 查，
 * 再退到全局视图。返回 true/false；宿主根本没有 tools 服务（探测不到）时返回
 * undefined，由调用方决定兜底——「没有证据」不等于「证据表明没有」。
 */
function teamToolsAtAssembly(get, context) {
	const tools = get("tools");
	if (!tools || typeof tools.get !== "function") return undefined;
	const scope = context && typeof context === "object" ? context.scope : undefined;
	try {
		if (scope !== undefined && tools.get("spawn_teammate", scope)) return true;
	} catch (error) {
		/* scope 不合法就退回全局视图 */
	}
	try {
		return Boolean(tools.get("spawn_teammate"));
	} catch (error) {
		// 注册表本身读不了：当作「看不到团队工具」，不输出会指向不存在工具的策略。
		return false;
	}
}

function registerTeamPolicy(ctx, get) {
	const systemPrompt = get("systemPrompt");
	if (!systemPrompt || typeof systemPrompt.section !== "function") return;

	let order = SECTION_ORDER_FALLBACK;
	if (typeof systemPrompt.getSectionOrder === "function") {
		try {
			const official = systemPrompt.getSectionOrder("TEAM_POLICY");
			if (Number.isFinite(official)) order = official;
		} catch (error) {
			/* 官方分配表读不到就用保守常量 */
		}
	}

	try {
		ctx.effect(
			() => {
				try {
					return systemPrompt.section({
						name: SECTION_NAME,
						order,
						// 官方 `dsh-experimental-tool-agent-team` 会给每个 agent 注册 `team:policy`
						// （order 也是 TEAM_POLICY），名字不同不会互相覆盖 → 存在官方段就让位，
						// 交空字符串，renderPrompt 会把空段整段过滤掉。
						// 另一个条件：用户按 README 把团队行 disabled 后 spawn_teammate 不会注册，
						// 这时再输出「默认先起团队」就是让模型去调不存在的工具 → 也交空字符串。
						// 必须在「组装时」判断而不是 apply 时：patch 里 agent-whales 先于
						// agent-team 加载，且团队工具是 per-agent scope 注册的。
						text: (context) => {
							if (get(TEAM_SERVICE)) return "";
							const teamTools = teamToolsAtAssembly(get, context);
							return teamTools === false ? "" : TEAM_POLICY;
						}
					});
				} catch (error) {
					// 提示段落注册失败不该拖垮本行。
					warn(ctx, "team policy", error);
					return function () {};
				}
			},
			"agent-whales: team policy"
		);
	} catch (error) {
		warn(ctx, "team policy", error);
	}
}

// ── 2) 工具活动采集 ──────────────────────────────────────────────────────

function trackToolActivity(ctx, running, runtime) {
	if (typeof ctx.on !== "function") return;

	try {
		ctx.effect(
			() =>
				ctx.on("tools/execute", (exec, next) => {
					try {
						const sessionId = exec && exec.agent && exec.agent.id;
						const name = exec && exec.name;
						if (typeof sessionId === "string" && typeof name === "string") {
							let calls = running.get(sessionId);
							if (calls === undefined) {
								calls = new Map();
								running.set(sessionId, calls);
							}
							// 按 callId 记账：同会话并发工具时，先结束的那个不能把后开始的记录抹掉。
							calls.set(exec.callId === undefined ? `${Date.now()}:${Math.random()}` : String(exec.callId), {
								tool: name,
								startedAt: Date.now()
							});
							pruneActivity(running, Date.now());
						}
					} catch (error) {
						/* 采集失败绝不影响真实调用 */
					}
					return next();
				}),
			"agent-whales: tools/execute"
		);
	} catch (error) {
		warn(ctx, "tools/execute listener", error);
	}

	try {
		ctx.effect(
			() =>
				ctx.on("tools/result", (exec, result) => {
					try {
						const sessionId = exec && exec.agent && exec.agent.id;
						if (typeof sessionId !== "string") return;
						// 失败事实：result.isError 是真实契约（dsh-tools ToolExecutionResult），
						// 不是猜的；失败时 result.error 还带 ToolFailure。
						if (runtime && result && result.isError === true) {
							const at = Date.now();
							const row = runtimeRow(runtime, sessionId, at);
							row.lastErrorAt = at;
							row.lastErrorKind = "tool";
						}
						const calls = running.get(sessionId);
						if (calls === undefined) return;
						if (exec.callId === undefined) calls.clear();
						else calls.delete(String(exec.callId));
						if (calls.size === 0) running.delete(sessionId);
					} catch (error) {
						/* 同上 */
					}
				}),
			"agent-whales: tools/result"
		);
	} catch (error) {
		warn(ctx, "tools/result listener", error);
	}

	// 卸载时把状态一起放掉，热重载不会留下旧表的引用。
	try {
		ctx.effect(() => () => running.clear(), "agent-whales: activity state");
	} catch (error) {
		warn(ctx, "activity state", error);
	}
}

// ── 2b) 运行时状态采集（思考 / 失败 / 回合结束）───────────────────────────
// 契约来源（真实 DSH，逐条核对过）：
//   agent/status          { agent, status: 'idle'|'running' }        —— 驱动是否在跑
//   agent/assistant-stream{ agent, frame: {type:'start'|'chunk'|'end'} } —— 模型正在输出
//   agent/turn-stopping   { agent, turn, signal }                    —— 这一轮干完了
//   agent/error           { agent, turn, step, error }               —— 回合/步骤失败
// 根 ctx 上监听收全部 agent（事件声明里的 scope 过滤只约束 agent 作用域监听）。
function trackRuntimeState(ctx, runtime) {
	if (typeof ctx.on !== "function") return;

	const sessionOf = (payload) => {
		const agent = payload && payload.agent;
		const id = agent && agent.id;
		return typeof id === "string" ? id : undefined;
	};

	const on = (event, listener, label) => {
		try {
			ctx.effect(() => ctx.on(event, listener), `agent-whales: ${label}`);
		} catch (error) {
			warn(ctx, label, error);
		}
	};

	on(
		"agent/status",
		(payload) => {
			try {
				const sessionId = sessionOf(payload);
				if (sessionId === undefined) return;
				// 只认契约里存在的两个值；别的值不建表，避免脏事件凭空造会话。
				if (payload.status !== "running" && payload.status !== "idle") return;
				const at = Date.now();
				const row = runtimeRow(runtime, sessionId, at);
				const running = payload.status === "running";
				row.running = running;
				row.since = at;
				if (running) {
					if (typeof row.runStartedAt !== "number") row.runStartedAt = at;
				} else {
					// 收工就清掉「正在输出」，否则下一段 idle 会被当成还在思考；
					// 同时记下这一轮跑了多久——客户端用它决定「值不值得庆祝」。
					if (typeof row.runStartedAt === "number") row.lastRunMs = Math.max(0, at - row.runStartedAt);
					delete row.streamingSince;
					delete row.runStartedAt;
				}
				pruneRuntimeState(runtime, at);
			} catch (error) {
				/* 采集失败绝不影响宿主 */
			}
		},
		"agent status listener"
	);

	on(
		"agent/assistant-stream",
		(payload) => {
			try {
				const sessionId = sessionOf(payload);
				const frame = payload && payload.frame;
				if (sessionId === undefined || !frame) return;
				const at = Date.now();
				const row = runtimeRow(runtime, sessionId, at);
				if (frame.type === "start") row.streamingSince = at;
				else if (frame.type !== "chunk") delete row.streamingSince;
			} catch (error) {
				/* 同上 */
			}
		},
		"assistant stream listener"
	);

	on(
		"agent/turn-stopping",
		(payload) => {
			try {
				const sessionId = sessionOf(payload);
				if (sessionId === undefined) return;
				const at = Date.now();
				const row = runtimeRow(runtime, sessionId, at);
				row.lastTurnEndAt = at;
				delete row.streamingSince;
			} catch (error) {
				/* 同上 */
			}
		},
		"turn stopping listener"
	);

	on(
		"agent/error",
		(payload) => {
			try {
				const sessionId = sessionOf(payload);
				if (sessionId === undefined) return;
				const at = Date.now();
				const row = runtimeRow(runtime, sessionId, at);
				row.lastErrorAt = at;
				row.lastErrorKind = "agent";
			} catch (error) {
				/* 同上 */
			}
		},
		"agent error listener"
	);

	// 模型请求失败。这是 **waterfall**（不是 emit）：必须把决定权交回宿主，
	// 否则会吞掉下游的重试策略——所以无论如何都 return next()。
	on(
		"agent/request-error",
		(payload, next) => {
			try {
				const sessionId = sessionOf(payload);
				if (sessionId !== undefined) {
					const at = Date.now();
					const row = runtimeRow(runtime, sessionId, at);
					row.lastErrorAt = at;
					row.lastErrorKind = "request";
				}
			} catch (error) {
				/* 采集失败不能影响重试链路 */
			}
			return typeof next === "function" ? next() : undefined;
		},
		"request error listener"
	);

	// 卸载时把状态一起放掉，热重载不会留下旧表的引用。
	try {
		ctx.effect(() => () => runtime.clear(), "agent-whales: runtime state");
	} catch (error) {
		warn(ctx, "runtime state", error);
	}
}

// ── 3) 路由：只读快照 + 串门工具开关（全插件唯一的写操作）──────────────

/** 串门工具开关路由。POST 是唯一写操作，必须带 controlToken（理由见 handler）。 */
const VISIT_TOOLS_ENDPOINT = `${ACTIVITY_PATH}/visit-tools`;
/** 开关请求体上限：只收一个 {"enabled": boolean}，不读大包。 */
const TOGGLE_BODY_LIMIT = 4096;

/** 从 req.url 取 pathname；脏 URL 不做猜测，回空串让调用方按 404 处理。 */
function requestPathname(req) {
	try {
		return new URL(String((req && req.url) || "/"), "http://localhost").pathname;
	} catch (error) {
		return "";
	}
}

function requestMethod(req) {
	return String((req && req.method) || "GET").toUpperCase();
}

/** 纯文本响应：错误一律 text/plain，写失败（连接已断）也不再抛。 */
function sendText(res, statusCode, text) {
	try {
		if (res.headersSent) return;
		res.statusCode = statusCode;
		res.setHeader("content-type", "text/plain; charset=utf-8");
		res.setHeader("content-length", Buffer.byteLength(text));
		res.end(text);
	} catch (error) {
		/* 连接都没了就算了 */
	}
}

/** 无体响应（204/404/405）：同样不允许把异常抛回宿主。 */
function sendEmpty(res, statusCode) {
	try {
		if (res.headersSent) return;
		res.statusCode = statusCode;
		res.end();
	} catch (error) {
		/* 同上 */
	}
}

/**
 * 读一个很小的请求体。不信任 content-length，按实际字节封顶；
 * 请求对象不是流（伪请求/异常连接）或读取超时都当解析失败返回 undefined，
 * Promise 永远不会 reject（调用方 await 后按 400 处理）。
 */
function readRequestBody(req) {
	return new Promise((resolve) => {
		let settled = false;
		let size = 0;
		const chunks = [];
		const timer = setTimeout(() => finish(undefined), 5_000);
		if (timer && typeof timer.unref === "function") timer.unref();
		function finish(value) {
			if (settled) return;
			settled = true;
			try {
				clearTimeout(timer);
			} catch (error) {
				/* ignore */
			}
			resolve(value);
		}
		try {
			if (!req || typeof req.on !== "function") {
				finish(undefined);
				return;
			}
			req.on("data", (chunk) => {
				if (settled) return;
				try {
					const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
					size += buffer.length;
					if (size > TOGGLE_BODY_LIMIT) {
						finish(undefined);
						return;
					}
					chunks.push(buffer);
				} catch (error) {
					finish(undefined);
				}
			});
			req.on("end", () => {
				try {
					finish(chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8"));
				} catch (error) {
					finish(undefined);
				}
			});
			req.on("error", () => finish(undefined));
			req.on("aborted", () => finish(undefined));
		} catch (error) {
			finish(undefined);
		}
	});
}

/** GET/HEAD /agent-whales/api/activity：只读快照 + 开关状态 + controlToken。 */
function handleActivityRequest(req, res, get, running, control, runtime) {
	const method = requestMethod(req);
	if (requestPathname(req) !== ACTIVITY_ENDPOINT) {
		sendEmpty(res, 404);
		return;
	}
	if (method === "OPTIONS") {
		res.setHeader("allow", "GET, HEAD, OPTIONS");
		sendEmpty(res, 204);
		return;
	}
	if (method !== "GET" && method !== "HEAD") {
		// 只读路由：POST/PUT 之类一律 405，别让任何写入错觉成立。
		res.setHeader("allow", "GET, HEAD, OPTIONS");
		sendEmpty(res, 405);
		return;
	}

	const now = Date.now();
	pruneActivity(running, now);
	const table = flattenActivity(running);
	for (const [sessionId, entry] of table) {
		// 5 分钟 TTL 只对「会话已经不在跑」的陈旧条目生效；会话还在跑说明可能是
		// wait_agent 这类长跑工具，放宽到硬上限，避免干着活却从头顶消失。
		if (now - entry.startedAt <= ACTIVITY_TTL_MS) continue;
		const agent = liveAgent(get, sessionId);
		if (!agent || agent.status !== "running") table.delete(sessionId);
	}

	const visitTools = control && control.visitTools && typeof control.visitTools.isEnabled === "function" ? control.visitTools.isEnabled() === true : false;
	const controlToken = control && typeof control.controlToken === "string" ? control.controlToken : "";
	let state = {};
	if (runtime instanceof Map) {
		try {
			pruneRuntimeState(runtime, now);
			state = runtimeStatePayload(runtime, now);
		} catch (error) {
			state = {};
		}
	}
	let body;
	try {
		body = JSON.stringify({
			...activityPayload(table, now, ACTIVITY_MAX_AGE_MS),
			visitTools,
			controlToken,
			state
		});
	} catch (error) {
		body = `{"at":0,"active":{},"visitTools":false,"controlToken":"","state":{}}`;
	}
	res.statusCode = 200;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.setHeader("content-length", Buffer.byteLength(body));
	res.end(body);
}

/**
 * POST /agent-whales/api/visit-tools：运行时整体开关四个串门工具。
 *
 * 为什么需要 x-whales-token：这条路由在 DSH Web 上无鉴权可达（裸 curl 就能打到），
 * 而它是本插件唯一的写操作。controlToken 只出现在同源 GET 响应体里——跨源页面
 * 受 CORS 限制读不到响应体，就拿不到 token，伪造 POST 会被 403，构成有效的 CSRF 防护。
 * 它是「同源证明」而不是身份认证，别把它当鉴权用，更不要「顺手删掉」。
 */
function handleVisitToolsRequest(ctx, req, res, control) {
	const method = requestMethod(req);
	if (method === "OPTIONS") {
		res.setHeader("allow", "POST, OPTIONS");
		sendEmpty(res, 204);
		return Promise.resolve();
	}
	if (method !== "POST") {
		res.setHeader("allow", "POST, OPTIONS");
		sendEmpty(res, 405);
		return Promise.resolve();
	}

	const header = req && req.headers ? req.headers["x-whales-token"] : undefined;
	const token = Array.isArray(header) ? header[0] : header;
	if (typeof token !== "string" || !control || typeof control.controlToken !== "string" || token !== control.controlToken) {
		sendText(res, 403, "forbidden");
		return Promise.resolve();
	}

	// 同一时刻只允许一个 toggle 在飞：后到的按「已受理」回 204，避免重复注册/注销打架。
	if (control.toggling === true) {
		sendEmpty(res, 204);
		return Promise.resolve();
	}
	control.toggling = true;

	return (async () => {
		try {
			const text = await readRequestBody(req);
			if (typeof text !== "string" || text.trim() === "") {
				sendText(res, 400, "invalid body");
				return;
			}
			let payload;
			try {
				payload = JSON.parse(text);
			} catch (error) {
				sendText(res, 400, "invalid json");
				return;
			}
			if (!payload || typeof payload !== "object" || typeof payload.enabled !== "boolean") {
				sendText(res, 400, "enabled must be a boolean");
				return;
			}
			const visitTools = control.visitTools;
			if (!visitTools || typeof visitTools.setEnabled !== "function") {
				sendText(res, 500, "visit tools unavailable");
				return;
			}
			if (visitTools.setEnabled(payload.enabled) !== true) {
				sendText(res, 500, "cannot apply visit tools state");
				return;
			}
			sendEmpty(res, 204);
		} catch (error) {
			warn(ctx, "visit tools toggle", error);
			sendText(res, 500, "internal error");
		} finally {
			control.toggling = false;
		}
	})();
}

/** 一个前缀路由内的分发：同步路径自己兜住异常，异步 toggle 再挂一层 catch 防 unhandledRejection。 */
function dispatchRequest(ctx, req, res, get, running, control, runtime, art) {
	const pathname = requestPathname(req);
	try {
		if (pathname === ACTIVITY_ENDPOINT) {
			handleActivityRequest(req, res, get, running, control, runtime);
			return undefined;
		}
		if (pathname === VISIT_TOOLS_ENDPOINT) {
			const pending = handleVisitToolsRequest(ctx, req, res, control);
			// 把 promise 交回宿主（它会 await），并保证最后一道 catch 吞掉一切异常。
			if (pending && typeof pending.catch === "function") {
				return pending.catch((error) => {
					warn(ctx, "visit tools toggle", error);
					sendText(res, 500, "internal error");
				});
			}
			return pending;
		}
		// 素材路由是纯同步决策：不在素材路径上返回 undefined，落到下面的 404。
		if (art !== undefined && art !== null) {
			const artReply = artResponse(art, pathname, requestMethod(req));
			if (artReply !== undefined) {
				writeArtResponse(res, artReply);
				return undefined;
			}
		}
		sendEmpty(res, 404);
		return undefined;
	} catch (error) {
		// 宿主只会把 handler 的异常记 warn 后写 400；自己兜住，保证路由永不外抛。
		warn(ctx, "activity route handler", error);
		sendText(res, 500, "internal error");
		return undefined;
	}
}

function registerActivityRoute(ctx, get, running, control, runtime, art) {
	const webServer = get("webServer");
	if (!webServer || typeof webServer.register !== "function") return;

	try {
		ctx.effect(
			() => {
				try {
					return webServer.register({
						kind: "prefix",
						path: ACTIVITY_PATH,
						handler: (req, res) => dispatchRequest(ctx, req, res, get, running, control, runtime, art)
					});
				} catch (error) {
					// 同路径已被注册（重复 apply/热重载残留）时 register 会抛，别让 apply 失败。
					warn(ctx, "activity route", error);
					return function () {};
				}
			},
			"agent-whales: activity route"
		);
	} catch (error) {
		warn(ctx, "activity route", error);
	}
}

// ── 3b) 素材路由（D1：素材出 bundle，client.js 只留代码与矢量兜底）──────

/**
 * 素材清单路由；素材图是 /agent-whales/api/art/<key>.webp。
 * 白名单来自构建产物 assets/manifest.json（tools/build-manifest.mjs 生成），
 * 运行时**不扫目录**：只有清单里的 key 能命中，路径穿越天然进不了请求集合。
 */
const ART_MANIFEST_ENDPOINT = `${ACTIVITY_PATH}/art/manifest`;
const ART_IMAGE_PREFIX = `${ACTIVITY_PATH}/art/`;
const ART_IMAGE_SUFFIX = ".webp";
/** 宿主半边在 lib/ 下，素材在同级 assets/；换成别的目录只影响测试与打包布局。 */
const ART_ASSET_ROOT = new URL("../assets/", import.meta.url);
/** 图内容只随版本变化（换图 = 换 key 或升版本），可以放心长缓存。 */
const ART_CACHE_CONTROL = "public, max-age=86400, immutable";
/** 清单协议版本，必须与 tools/build-manifest.mjs、浏览器半边三方一致。 */
const ART_MANIFEST_VERSION = 1;
/** key 前缀 → skin；必须与 tools/build-manifest.mjs 的映射一致。 */
const ART_SKIN_BY_PREFIX = { q: "q", m: "mature", c: "classic" };

/** key 前缀决定皮肤；不认识的前缀返回 undefined。 */
function artSkinOfKey(key) {
	return typeof key === "string" && key.length > 0 ? ART_SKIN_BY_PREFIX[key.slice(0, 1)] : undefined;
}

/** key 形状校验：q-/m-/c- 前缀的小写 kebab 片段，不含路径分隔与上跳。 */
function isSafeArtKey(key) {
	return typeof key === "string" && key.length > 0 && key.length <= 64 && /^[qmc]-[a-z0-9][a-z0-9-]*$/.test(key);
}

/** 清单规范化：只保留协议字段（w/h/bytes/skin），脏值直接丢弃。 */
function normalizeArtManifest(parsed) {
	const keys = {};
	if (!parsed || typeof parsed !== "object" || !parsed.keys || typeof parsed.keys !== "object") {
		return { version: ART_MANIFEST_VERSION, keys };
	}
	for (const [key, raw] of Object.entries(parsed.keys)) {
		if (!isSafeArtKey(key) || !raw || typeof raw !== "object") continue;
		if (!Number.isInteger(raw.w) || raw.w <= 0) continue;
		if (!Number.isInteger(raw.h) || raw.h <= 0) continue;
		if (!Number.isInteger(raw.bytes) || raw.bytes <= 0) continue;
		const skin = raw.skin === "q" || raw.skin === "mature" || raw.skin === "classic" ? raw.skin : artSkinOfKey(key);
		if (skin === undefined) continue;
		keys[key] = { w: raw.w, h: raw.h, bytes: raw.bytes, skin };
	}
	return { version: ART_MANIFEST_VERSION, keys };
}

/**
 * 读素材清单并建立「按 key 取图」的内存缓存。
 *
 * asar 场景（桌面版把插件打进 app.asar 时）：普通 Node 的 fs 打开 asar 内部路径会抛
 * `ENOENT: no such file or directory, open '…\app.asar\…\assets\manifest.json'`
 * （readdir 同形；Electron 主进程的 fs 被 patch 过则可能可读，取决于宿主进程）。
 * 这里一律 try/catch：读不到就当作「这个部署没有素材」——manifest 回空表、图片全 404，
 * 插件本体与鲸鱼娘照常装配，绝不因为素材读失败把整行 fiber 带崩。
 *
 * 单张图按需读、命中后常驻（28 张 × ~13KB ≈ 338KB，可接受）；卸载时由 apply 里
 * 的 effect 调 clear() 释放，热重载不会留下旧缓存。
 *
 * @param {URL} [assetRoot] 素材目录（默认插件内 ../assets/；测试可传不存在/临时的目录）
 */
export function createArtStore(assetRoot = ART_ASSET_ROOT) {
	let manifest = { version: ART_MANIFEST_VERSION, keys: {} };
	let manifestBody = JSON.stringify(manifest);
	const cache = new Map();
	try {
		const parsed = JSON.parse(readFileSync(new URL("manifest.json", assetRoot), "utf8"));
		manifest = normalizeArtManifest(parsed);
		manifestBody = JSON.stringify(manifest);
	} catch (error) {
		// 缺文件 / 坏 JSON / asar 读失败：当作没有素材，不抛。
		manifest = { version: ART_MANIFEST_VERSION, keys: {} };
		manifestBody = JSON.stringify(manifest);
	}
	return {
		/** 已序列化好的清单 JSON 文本（每次请求直接复用，避免重复 stringify）。 */
		manifestBody,
		/** 当前白名单里的 key（排序取清单写入顺序，构建期已排序）。 */
		keys() {
			return Object.keys(manifest.keys);
		},
		/** 按 key 取图；不在白名单/文件缺失/读失败一律 undefined（调用方回 404）。 */
		read(key) {
			if (typeof key !== "string" || !Object.hasOwn(manifest.keys, key)) return undefined;
			const cached = cache.get(key);
			if (cached !== undefined) return cached;
			try {
				const buffer = readFileSync(new URL(`${key}${ART_IMAGE_SUFFIX}`, assetRoot));
				if (!Buffer.isBuffer(buffer) || buffer.length === 0) return undefined;
				const meta = manifest.keys[key];
				// 需求只要求「sha1 或字节长度」，这里用长度+尺寸：同一 URL 的缓存校验足够。
				const entry = { buffer, etag: `"${buffer.length.toString(16)}-${meta.w}x${meta.h}"` };
				cache.set(key, entry);
				return entry;
			} catch (error) {
				return undefined;
			}
		},
		/** 卸载/热重载时释放缓存（apply 里的 effect 调用）。 */
		clear() {
			cache.clear();
		}
	};
}

/** 从 pathname 解析素材 key；不是 /art/<key>.webp 形状（或含穿越片段）返回 undefined。 */
function artKeyOf(pathname) {
	if (typeof pathname !== "string" || !pathname.startsWith(ART_IMAGE_PREFIX)) return undefined;
	const rest = pathname.slice(ART_IMAGE_PREFIX.length);
	if (!rest.endsWith(ART_IMAGE_SUFFIX)) return undefined;
	const raw = rest.slice(0, -ART_IMAGE_SUFFIX.length);
	if (raw === "" || raw.includes("/") || raw.includes("\\") || raw.includes("..")) return undefined;
	try {
		return decodeURIComponent(raw);
	} catch (error) {
		return undefined;
	}
}

/**
 * 素材路由的纯决策：返回 { status, headers, body?, contentLength? }，不碰 res。
 * 完全同步（图已缓存），不引入 promise；也让「asar 读不到」「清单是脏的」这类
 * 没法在真实路径上复现的错误面可以在测试里直接覆盖。
 * 不是素材路径时返回 undefined，交给上层 404。
 */
export function artResponse(store, pathname, method) {
	const isManifest = pathname === ART_MANIFEST_ENDPOINT;
	const key = isManifest ? undefined : artKeyOf(pathname);
	if (!isManifest && key === undefined) return undefined;
	const allow = "GET, HEAD, OPTIONS";
	if (method === "OPTIONS") return { status: 204, headers: { allow } };
	if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { allow } };
	const isHead = method === "HEAD";
	if (isManifest) {
		const body = store.manifestBody;
		return {
			status: 200,
			headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
			...(isHead ? {} : { body }),
			contentLength: Buffer.byteLength(body)
		};
	}
	const entry = store.read(key);
	if (entry === undefined) return { status: 404, headers: {} };
	return {
		status: 200,
		headers: { "content-type": "image/webp", "cache-control": ART_CACHE_CONTROL, etag: entry.etag },
		...(isHead ? {} : { body: entry.buffer }),
		contentLength: entry.buffer.length
	};
}

/** 把素材决策写进 res；连接早断/响应对象异常都不外抛。 */
function writeArtResponse(res, response) {
	try {
		if (res.headersSent) return;
		res.statusCode = response.status;
		for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
		if (response.contentLength !== undefined) res.setHeader("content-length", String(response.contentLength));
		if (response.body === undefined) res.end();
		else res.end(response.body);
	} catch (error) {
		/* 连接都没了就算了 */
	}
}

// ── 4) 串门工具（可运行时整体开关）──────────────────────────────────────

/**
 * 从插件 entry 的 config 读初始开关：高级用户可以在 patch 里写
 * `config: { visitTools: false }` 一劳永逸。
 * 没有 Config schema 导出时 cordis 把 config 原样传给 apply（cordis/lib/index.js:956、1067），
 * 所以这里自己判类型；没配/配了非 false 都按默认开启。
 */
function initialVisitToolsEnabled(config) {
	return !(config && typeof config === "object" && config.visitTools === false);
}

/**
 * 创建四个串门工具，并返回可在运行时整体开关的控制器。
 * 任何一步失败都只跳过该工具，不影响本行装配浏览器半边。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {(name: string) => unknown} get
 * @param {boolean} initiallyEnabled
 * @returns {{ isEnabled: () => boolean, setEnabled: (next: boolean) => boolean }}
 */
function createVisitTools(ctx, get, initiallyEnabled) {
	const tools = get("tools");

	/** 正在 resume 的会话：并发同名调用复用同一个 Promise，避免把同一会话拉起两次。 */
	const resuming = new Map();
	/** 当前已在册的工具注销器；toggle 关掉与插件卸载都从这里取，保证每个底层 disposer 只跑一次。 */
	let disposers = [];
	let enabled = false;
	/** 工具定义只构造一次，注册/注销/再注册复用同一份。 */
	const definitions = [];

	/** 只收集定义，不注册；真正的注册发生在 registerAll（初始关闭时一次都不该发生）。 */
	function collectTool(tool) {
		definitions.push(tool);
	}

	/** 注册一个工具，返回幂等注销器；参数非法/宿主拒绝时返回 undefined（只丢这一个能力）。 */
	function registerOne(tool) {
		if (!tools || typeof tools.register !== "function") return undefined;
		// 历史事故：parameters 写成属性表会让 wire schema 的 type 变成 null，网关拒整个请求体。
		// 注册前自检根必须是 object，宁可不注册也不把非法 schema 交给宿主。
		if (!tool.parameters || typeof tool.parameters !== "object" || tool.parameters.type !== "object") {
			warn(ctx, `tool ${tool.name}`, new TypeError("parameters 必须是 type=object 的 JSON Schema"));
			return undefined;
		}
		const definition = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			// 声明自己的时间预算：宿主的 timeout 策略插件会从注册表读它，上限略大于我们自己的等待。
			...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
			output: {
				schema: tool.outputSchema,
				render: (_args, value) => [{ type: "text", text: tool.render(value) }]
			},
			execute: tool.execute,
			...(tool.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: tool.isConcurrencySafe })
		};
		let rawDisposer;
		try {
			rawDisposer = tools.register(definition);
		} catch (error) {
			warn(ctx, `tool ${tool.name}`, error);
			return undefined;
		}
		// 幂等注销：toggle 关闭和插件卸载可能都会调，底层 disposer 只能执行一次。
		let disposed = false;
		return function disposeVisitTool() {
			if (disposed) return;
			disposed = true;
			try {
				if (typeof rawDisposer === "function") rawDisposer();
			} catch (error) {
				warn(ctx, `tool ${tool.name} dispose`, error);
			}
		};
	}

	collectTool({
		name: "whales_visit_list",
		description:
			"列出这个 profile 里可以「串门」的会话：id、标题（能拿到时）、是否正在跑、属于哪个工作区。只读。" +
			"用来在给别的会话发消息之前先确认目标；subagent 会话也在列表里。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: {
			type: "object",
			properties: {
				sessions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							sessionId: { type: "string" },
							title: { type: "string" },
							running: { type: "boolean" },
							workspaceId: { type: "string" }
						},
						required: ["sessionId", "running"],
						additionalProperties: true
					}
				},
				count: { type: "integer" },
				total: { type: "integer" },
				truncated: { type: "boolean" }
			},
			required: ["count", "sessions"],
			additionalProperties: true
		},
		// 纯读：可以和其他工具并发，避免一次查 N 个会话被串行化。
		isConcurrencySafe: () => true,
		render: (value) => {
			const rows = value.sessions || [];
			if (rows.length === 0) return "（没有可串门的会话）";
			const lines = rows.map(
				(row) => `${row.running ? "●" : "○"} ${row.sessionId}${row.title ? ` 「${row.title}」` : ""}${row.workspaceId ? ` @${row.workspaceId}` : ""}`
			);
			if (value.truncated === true) lines.push(`（共 ${value.total} 个会话，只显示前 ${value.count} 个：正在跑的优先）`);
			return lines.join("\n");
		},
		async execute() {
			const agents = get("agents");
			let live = [];
			try {
				if (agents && typeof agents.list === "function") live = agents.list();
			} catch (error) {
				live = [];
			}
			const workspaces = sessionsByWorkspace(get);
			const ids = new Set(workspaces.keys());
			const liveIds = new Set();
			for (const agent of Array.isArray(live) ? live : []) {
				if (agent && agent.id) {
					ids.add(String(agent.id));
					liveIds.add(String(agent.id));
				}
			}
			const rows = [];
			for (const id of ids) {
				const agent = liveAgent(get, id);
				let title;
				if (agent && agent.session) {
					try {
						title = titleOf(sessionEvents(agent.session));
					} catch (error) {
						title = undefined;
					}
				}
				rows.push({
					sessionId: id,
					...(title === undefined ? {} : { title }),
					running: Boolean(agent && agent.status === "running"),
					...(workspaces.has(id) ? { workspaceId: workspaces.get(id) } : {})
				});
			}
			// 大 profile 保护：几千条历史会话不在一次工具调用里全量下发（上下文会被打爆）。
			// 正在跑的最先给，其次活着的，最后离线的；同组保持原有顺序（sort 稳定）。
			const rankOf = (row) => (row.running ? 0 : liveIds.has(row.sessionId) ? 1 : 2);
			rows.sort((left, right) => rankOf(left) - rankOf(right));
			const total = rows.length;
			const visible = total > LIST_MAX_ROWS ? rows.slice(0, LIST_MAX_ROWS) : rows;
			return { sessions: visible, count: visible.length, total, truncated: total > LIST_MAX_ROWS };
		}
	});

	collectTool({
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
				timeoutMs: { type: "number", description: `等回话的预算，默认 ${VISIT_WAIT_MS}ms，上限 ${VISIT_MAX_WAIT_MS}ms；≤0 按默认预算处理。` }
			},
			required: ["sessionId", "message"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				mode: { type: "string", enum: ["queue", "steer"] },
				accepted: { type: "boolean" },
				timedOut: { type: "boolean" },
				reply: {
					type: "object",
					properties: {
						waitedMs: { type: "number" },
						text: { type: "string" },
						aborted: { type: "boolean" }
					},
					required: ["waitedMs"],
					additionalProperties: true
				}
			},
			required: ["accepted", "mode", "sessionId", "timedOut"],
			additionalProperties: true
		},
		// 我们自己的等待硬上限是 120s，这里留 5s 给收发与调度，避免被宿主判超时。
		timeoutMs: VISIT_MAX_WAIT_MS + 5_000,
		// 会往别人信箱里塞消息：不并发，保持调用顺序。
		isConcurrencySafe: () => false,
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
			const agent = liveAgent(get, sessionId);
			if (!agent) throw new Error(`会话 ${sessionId} 现在不活着（离线会话需要先在 UI 里打开）`);
			const mode = args.mode === "steer" ? "steer" : "queue";
			const baseline = maxSeq(sessionEvents(agent.session));
			// followup/steer 是同步 void（dsh-agent runtime-types.d.ts:192/200），但调用本身可能
			// 同步抛（inbox 已 dispose 等），转成工具错误，别让它变成未捕获异常。
			try {
				if (mode === "steer") agent.steer(userMessage(text));
				else agent.followup(userMessage(text));
			} catch (error) {
				throw new Error(`会话 ${sessionId} 送信失败：${errorMessage(error)}`);
			}
			let reply;
			let timedOut = false;
			if (args.waitForReply === true) {
				// 工具入口把 <=0 当「没给」，用默认预算；低层 waitForReply 收到 0/负值仍是立即超时（便于测试/探活）。
				const budget =
					typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
						? Math.min(args.timeoutMs, VISIT_MAX_WAIT_MS)
						: VISIT_WAIT_MS;
				const result = await waitForReply(agent.session, baseline, budget, exec && exec.signal);
				timedOut = result.timedOut === true;
				// 不能留 undefined 键：宿主要求工具返回值是 lossless JSON，
				// undefined 在序列化时会被丢掉，导致整次调用被判为非法输出。
				reply = { waitedMs: result.waitedMs };
				if (typeof result.text === "string") reply.text = result.text;
				if (result.aborted === true) reply.aborted = true;
			}
			return { sessionId, mode, accepted: true, ...(reply ? { reply } : {}), timedOut };
		}
	});

	collectTool({
		name: "whales_visit_resume",
		description:
			"把已持久化（离线）的会话重新拉起来，之后就能用 whales_visit_send 给它发消息。幂等：本来就在线的会话直接返回，不会重复 Resume。",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "目标会话 id（用 whales_visit_list 查）。" }
			},
			required: ["sessionId"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				live: { type: "boolean" },
				resumed: { type: "boolean" }
			},
			required: ["live", "resumed", "sessionId"],
			additionalProperties: true
		},
		isConcurrencySafe: () => false,
		render: (value) => (value.resumed ? `会话 ${value.sessionId} 已恢复上线` : `会话 ${value.sessionId} 本来就在线`),
		async execute(args, exec) {
			const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
			if (sessionId === "") throw new Error("sessionId 不能为空");
			const agents = get("agents");
			if (!agents) throw new Error("宿主没有 agents 服务，恢复不了会话");
			// 已经在线就直接返回——resume 不是每次都该做，重复调用会把会话反复拉起。
			if (liveAgent(get, sessionId)) {
				return { sessionId, live: true, resumed: false };
			}
			if (typeof agents.resume !== "function") throw new Error("宿主没有 agents.resume，无法恢复离线会话");
			// 并发幂等：同一会话的第二个调用复用第一次的 Promise，而不是各开一次加载。
			let pending = resuming.get(sessionId);
			if (pending === undefined) {
				pending = Promise.resolve()
					.then(() => agents.resume({ resumeSessionId: sessionId, signal: exec && exec.signal }))
					.finally(() => {
						resuming.delete(sessionId);
					});
				resuming.set(sessionId, pending);
			}
			const handle = await pending;
			// resume 会在返回前完成 publish（dsh-agent-loop 的 setupAndPublish），但失败的
			// 部分初始化可能只留下 handle：两者都认，拿不到就如实回报 live:false，不谎报。
			const after = liveAgent(get, sessionId) || (handle && handle.agent) || undefined;
			return { sessionId, live: Boolean(after), resumed: true };
		}
	});

	collectTool({
		name: "whales_visit_read",
		description:
			"看看隔壁在说什么：读取某个会话最近的对话（user / assistant 文本行），默认最近 20 行。" +
			"活着的会话直接读内存日志；已归档/离线的会话读不到就报错说明，不会猜。" +
			"单条过长会截断（约 4000 字）；总量超限时只返回最近几条。",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "目标会话 id。" },
				limit: { type: "number", description: "取最近多少行，默认 20，最大 100。" }
			},
			required: ["sessionId"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				total: { type: "integer" },
				messages: {
					type: "array",
					items: {
						type: "object",
						properties: {
							seq: { type: "number" },
							role: { type: "string", enum: ["user", "assistant"] },
							text: { type: "string" }
						},
						required: ["role", "text"],
						additionalProperties: true
					}
				}
			},
			required: ["messages", "sessionId", "total"],
			additionalProperties: true
		},
		isConcurrencySafe: () => true,
		render: (value) => {
			const rows = value.messages || [];
			if (rows.length === 0) return "（这个会话没有可读的文本消息）";
			return rows.map((row) => `${row.role === "user" ? "用户" : "助手"}: ${row.text}`).join("\n");
		},
		async execute(args) {
			const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
			if (sessionId === "") throw new Error("sessionId 不能为空");
			const limit = typeof args?.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 20;
			const agent = liveAgent(get, sessionId);
			if (!agent) throw new Error(`会话 ${sessionId} 现在不活着，读不到内存日志（离线日志读取未实现）`);
			let rows = [];
			try {
				rows = foldMessages(sessionEvents(agent.session));
			} catch (error) {
				rows = [];
			}
			// 单条截断 + 总量预算：一条几百 KB 的代码块 × 20 条足以把别人的上下文打爆。
			// 从最新往回取，至少给一条；total 仍是完整行数，模型据此知道自己看到的是尾部。
			const tail = rows.slice(-limit);
			const messages = [];
			let budget = READ_TOTAL_LIMIT;
			for (let index = tail.length - 1; index >= 0; index -= 1) {
				const text = clipText(tail[index].text);
				if (messages.length > 0 && budget - text.length < 0) break;
				budget -= text.length;
				messages.unshift({ ...tail[index], text });
			}
			return { sessionId, total: rows.length, messages };
		}
	});

	/** 注册当前全部工具定义；部分失败时保留成功的那些（只丢个别能力）。 */
	function registerAll() {
		const next = [];
		for (const tool of definitions) {
			const dispose = registerOne(tool);
			if (typeof dispose === "function") next.push(dispose);
		}
		disposers = next;
		enabled = disposers.length > 0;
		return enabled;
	}

	/** 注销当前全部注册（逆序），清空列表；重复调用安全。 */
	function unregisterAll() {
		const current = disposers;
		disposers = [];
		enabled = false;
		for (let index = current.length - 1; index >= 0; index -= 1) {
			try {
				current[index]();
			} catch (error) {
				warn(ctx, "visit tools dispose", error);
			}
		}
	}

	/** 开关入口：返回 true 表示目标状态已达成；只开不关且宿主没有 tools 服务时返回 false。 */
	function setEnabled(nextValue) {
		const next = nextValue === true;
		if (next === enabled) return true;
		if (!next) {
			unregisterAll();
			return true;
		}
		if (!tools || typeof tools.register !== "function") return false;
		return registerAll();
	}

	// 插件卸载兜底：整个生命周期只挂一个 effect，反复 toggle 不会累积 effect。
	if (typeof ctx.effect === "function") {
		try {
			ctx.effect(() => () => unregisterAll(), "agent-whales: visit tools state");
		} catch (error) {
			warn(ctx, "visit tools state", error);
		}
	}

	// 初始状态来自 config（默认开启）；关闭时一次注册都不发生，工具定义根本不进请求。
	if (initiallyEnabled !== false) setEnabled(true);

	return { isEnabled: () => enabled, setEnabled };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ visitTools?: boolean } | undefined} config 插件 entry 的 config（可选）
 */
export function apply(ctx, config) {
	// 最外层兜底：任何一段意外抛错都只丢对应能力，绝不让插件 fiber 失败。
	// 这条是「默认插件」的硬要求——插件装到别人机器上，不能因为一个服务换名就整行加载失败，
	// 更不能因此把鲸鱼娘（浏览器半边）一起带走。内部各段仍有各自的细粒度 try/catch。
	try {
		applyPlugin(ctx, config);
	} catch (error) {
		warn(ctx, "apply", error);
	}
}

function applyPlugin(ctx, config) {
	const get = safeGetter(ctx);
	// 每次加载生成一次；客户端每 2s 拉 GET 会拿到当前值，热重载后自动跟上。
	// 它是 POST 开关的「同源证明」，不是鉴权 token（理由见 handleVisitToolsRequest）。
	const controlToken = randomBytes(16).toString("hex");
	const control = { controlToken, visitTools: null, toggling: false };

	// 每一段都各自兜底：宿主服务缺失/抛错只丢对应能力，绝不让 apply 抛出去把插件 fiber 带崩。
	// 依赖宿主服务的注册一律走 whenService：宿主插件是并行加载的，apply 早于服务注册是常态。
	whenService(ctx, ["systemPrompt"], "team policy", (scope) => registerTeamPolicy(scope, get));

	const running = new Map();
	const runtime = createRuntimeState();
	try {
		trackToolActivity(ctx, running, runtime);
	} catch (error) {
		warn(ctx, "tool activity", error);
	}
	try {
		trackRuntimeState(ctx, runtime);
	} catch (error) {
		warn(ctx, "runtime state", error);
	}

	// 串门工具：等 tools 就绪。GET 通过 control.visitTools 读实时状态，先后顺序无所谓。
	whenService(ctx, ["tools"], "visit tools", (scope) => {
		try {
			control.visitTools = createVisitTools(scope, get, initialVisitToolsEnabled(config));
		} catch (error) {
			warn(ctx, "visit tools", error);
			control.visitTools = null;
		}
	});

	// 素材清单在 apply 时读一次（~3KB），图按需读后驻留内存；asar 读不到会退化成空表。
	let art = null;
	try {
		art = createArtStore();
	} catch (error) {
		warn(ctx, "art store", error);
		art = null;
	}
	if (art !== null) {
		try {
			// 卸载/热重载时释放图片缓存，别把旧版本的 Buffer 留在内存里。
			ctx.effect(() => () => art.clear(), "agent-whales: art cache");
		} catch (error) {
			warn(ctx, "art cache", error);
		}
	}

	// 路由：等 webServer 就绪再注册（活动快照 / 串门开关 / 素材图共用同一个前缀路由）。
	whenService(ctx, ["webServer"], "activity route", (scope) => {
		try {
			registerActivityRoute(scope, get, running, control, runtime, art);
		} catch (error) {
			warn(ctx, "activity route", error);
		}
	});
}
