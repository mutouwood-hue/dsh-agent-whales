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
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
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
	"## 提交流程（仅当你准备把目标拆给多个成员分工时）",
	"",
	"先用 `whales_propose_tasks` 提交结构化提案，等用户确认后由系统创建任务；",
	"不要用 Markdown 清单代替提案，也不要自己调用 `team_task_create` 绕过确认。",
	"简单问题直接回答，不要为了走流程而提案。",
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
/** 图形面板给某个节点发消息（写操作，同样要 x-whales-token）。 */
const SEND_ENDPOINT = `${ACTIVITY_PATH}/send`;
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

/**
 * POST /agent-whales/api/send：图形面板里给某个节点「说一句话」。
 *
 * 落地路径与串门工具完全一致（agent.steer / agent.followup），区别只是调用方是
 * 浏览器面板而不是模型。它同样是写操作，所以沿用 x-whales-token 的同源证明。
 */
function handleSendRequest(ctx, req, res, get, control) {
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
	return (async () => {
		try {
			const raw = await readRequestBody(req);
			let payload;
			try {
				payload = JSON.parse(raw);
			} catch (error) {
				sendText(res, 400, "invalid json");
				return;
			}
			const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
			const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
			const mode = payload && payload.mode === "queue" ? "queue" : "steer";
			// M4：可选 fromSessionId（由哪个对话发起）。人是单用户，不带时按"人"处理；带上就按对话身份过访问闸。
			const fromSessionId = payload && typeof payload.fromSessionId === "string" ? payload.fromSessionId.trim() : "";
			if (sessionId === "" || text === "") {
				sendText(res, 400, "sessionId and text are required");
				return;
			}
			if (text.length > 4000) {
				sendText(res, 413, "text too long");
				return;
			}
			if (fromSessionId !== "") {
				const access = checkCrossSessionAccess(get, fromSessionId, sessionId);
				if (access.ok !== true) {
					sendText(res, 403, "[" + access.code + "] " + access.msg);
					return;
				}
			}
			const agents = typeof get === "function" ? get("agents") : undefined;
			const agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined;
			if (!agent) {
				sendText(res, 409, "session is not live");
				return;
			}
			// 带真实来源：对话发起 → agent-message；人（UI）发起 → user。
			const message = relayMessage(fromSessionId, text);
			if (mode === "steer" && typeof agent.steer === "function") agent.steer(message);
			else if (typeof agent.followup === "function") agent.followup(message);
			else {
				sendText(res, 500, "agent cannot accept messages");
				return;
			}
			if (fromSessionId !== "") {
				try { await recordSend(fromSessionId, sessionId, "graph", message.id); } catch (error) { /* 登记失败不影响发送事实 */ }
			}
			const body = JSON.stringify({ ok: true, sessionId, mode });
			res.statusCode = 200;
			res.setHeader("content-type", "application/json; charset=utf-8");
			res.setHeader("cache-control", "no-store");
			res.setHeader("content-length", Buffer.byteLength(body));
			res.end(body);
		} catch (error) {
			warn(ctx, "graph send", error);
			sendText(res, 500, "internal error");
		}
	})();
}
// ── 4) 提案协议（W2）：Lead 提交结构化任务提案 → 用户确认 → 按依赖顺序创建任务 ──
//
// 设计约束（裁定后）：
//   - 提案由 Lead 通过**专用工具**提交，schema 是 object、返回 lossless JSON；**不解析 Markdown**；
//   - 宿主校验：key 唯一、blockedByKeys 都存在、无环；新版本覆盖旧版本（旧确认失效）；
//   - 确认：按拓扑序逐项 createTask（宿主没有原子批量 API），key→真实 taskId；中途失败保留已建的；
//   - 持久化在宿主侧（不用 Notion、不当 UI 状态）：~/.dsh/agent-whales/proposals.json
//   - createTask 没有 owner 参数 → suggestedOwner 只是建议，确认时不写归属。

const PROPOSALS_ENDPOINT = `${ACTIVITY_PATH}/proposals`;
const PROPOSAL_CONFIRM_PREFIX = `${ACTIVITY_PATH}/proposals/`;
const PROPOSAL_CONFIRM_SUFFIX = "/confirm";

/** 解析 /agent-whales/api/proposals/<proposalId>/confirm → proposalId。 */
function proposalConfirmOf(pathname) {
	if (typeof pathname !== "string") return undefined;
	if (!pathname.startsWith(PROPOSAL_CONFIRM_PREFIX)) return undefined;
	if (!pathname.endsWith(PROPOSAL_CONFIRM_SUFFIX)) return undefined;
	const middle = pathname.slice(PROPOSAL_CONFIRM_PREFIX.length, pathname.length - PROPOSAL_CONFIRM_SUFFIX.length);
	if (middle === "" || middle.indexOf("/") >= 0) return undefined;
	try { return decodeURIComponent(middle); } catch (error) { return middle; }
}

// 测试/诊断可用环境变量覆盖存储位置；默认落在 ~/.dsh/agent-whales/。
let PROPOSAL_STORE_FILE = (typeof process.env.DSH_AGENT_WHALES_PROPOSAL_FILE === "string" && process.env.DSH_AGENT_WHALES_PROPOSAL_FILE !== "")
	? process.env.DSH_AGENT_WHALES_PROPOSAL_FILE
	: join(homedir(), ".dsh", "agent-whales", "proposals.json");
let PROPOSAL_STORE_DIR = dirname(PROPOSAL_STORE_FILE);

/** 仅供离线测试：把提案存储指到临时目录（避免污染真实 ~/.dsh）。 */
export function setProposalStorePathForTests(file) {
	if (typeof file !== "string" || file === "") return;
	PROPOSAL_STORE_FILE = file;
	PROPOSAL_STORE_DIR = dirname(file);
}
const PROPOSAL_ACTIONS = ["submit"];

/** 读取提案存储；任何异常都退回空表（坏文件不该让插件起不来）。 */
function readProposalStore() {
	// 统一走通用 store：损坏时返回空表并进入只读降级（不再"读空表后覆盖"）。
	return readStoreFile(PROPOSAL_STORE_FILE).data;
}

/** 写入提案存储；失败只记日志（提案是便利能力，不能因此拖垮工具调用）。 */
function writeProposalStore(ctx, store) {
	return writeStoreFile(PROPOSAL_STORE_FILE, store).then(
		function () { return true; },
		function (error) {
			if (error && error.code === "STORE_READONLY") return false;
			warn(ctx, "proposal store write", error);
			return false;
		}
	);
}

/** 校验提案结构；返回 { error } 或 { items }。 */
function validateProposal(input) {
	if (!input || typeof input !== "object") return { error: "proposal must be an object" };
	const leadSessionId = typeof input.leadSessionId === "string" && input.leadSessionId.trim() !== "" ? input.leadSessionId.trim() : undefined;
	if (leadSessionId === undefined) return { error: "leadSessionId is required" };
	const items = Array.isArray(input.items) ? input.items : undefined;
	if (items === undefined || items.length === 0) return { error: "items must be a non-empty array" };
	if (items.length > 24) return { error: "items exceeds 24" };
	const keys = new Set();
	const normalized = [];
	for (const raw of items) {
		if (!raw || typeof raw !== "object") return { error: "each item must be an object" };
		const key = typeof raw.key === "string" ? raw.key.trim() : "";
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		if (key === "" || title === "") return { error: "each item needs key and title" };
		if (keys.has(key)) return { error: "duplicate key: " + key };
		keys.add(key);
		const blockedByKeys = Array.isArray(raw.blockedByKeys) ? raw.blockedByKeys.map((value) => String(value)) : [];
		normalized.push({
			key: key,
			title: title,
			description: typeof raw.description === "string" ? raw.description : "",
			blockedByKeys: blockedByKeys,
			suggestedOwner: typeof raw.suggestedOwner === "string" ? raw.suggestedOwner : undefined,
			expectedOutput: typeof raw.expectedOutput === "string" ? raw.expectedOutput : ""
		});
	}
	for (const item of normalized) {
		for (const dep of item.blockedByKeys) {
			if (!keys.has(dep)) return { error: "unknown blockedByKey: " + dep + " (item " + item.key + ")" };
		}
	}
	// 环检测：拓扑排序长度不足 = 有环。
	const order = topologicalOrder(normalized);
	if (order === undefined) return { error: "proposal has a dependency cycle" };
	const writeScopes = Array.isArray(input.writeScopes) ? input.writeScopes.map((value) => String(value)) : undefined;
	return {
		leadSessionId: leadSessionId,
		items: normalized,
		order: order,
		writeScopes: writeScopes
	};
}

/** 拓扑排序（稳定：同层按声明顺序）。有环返回 undefined。 */
function topologicalOrder(items) {
	const byKey = new Map();
	items.forEach((item, index) => byKey.set(item.key, { item: item, index: index, indegree: item.blockedByKeys.length, kids: [] }));
	if (byKey.size !== items.length) return undefined;
	items.forEach((item) => {
		for (const dep of item.blockedByKeys) {
			const parent = byKey.get(dep);
			if (!parent) return undefined;
			parent.kids.push(item.key);
		}
	});
	const ready = items.map((item) => item.key).filter((key) => byKey.get(key).indegree === 0);
	ready.sort((a, b) => byKey.get(a).index - byKey.get(b).index);
	const order = [];
	while (ready.length > 0) {
		const key = ready.shift();
		order.push(key);
		for (const kid of byKey.get(key).kids) {
			const node = byKey.get(kid);
			node.indegree -= 1;
			if (node.indegree === 0) {
				// 插入保持声明顺序的稳定性
				let at = ready.length;
				for (let i = 0; i < ready.length; i += 1) {
					if (byKey.get(ready[i]).index > node.index) { at = i; break; }
				}
				ready.splice(at, 0, kid);
			}
		}
	}
	return order.length === items.length ? order : undefined;
}

/** 提案 -> 客户端的只读视图（不含内部字段）。 */
function proposalView(record) {
	if (!record) return undefined;
	return {
		proposalId: record.proposalId,
		version: record.version,
		leadSessionId: record.leadSessionId,
		sourceMessageId: record.sourceMessageId,
		createdAt: record.createdAt,
		items: record.items,
		...(record.writeScopes === undefined ? {} : { writeScopes: record.writeScopes }),
		locked: record.confirmed !== undefined,
		...(record.confirmed === undefined ? {} : {
			confirmed: {
				version: record.confirmed.version,
				created: record.confirmed.created,
				...(record.confirmed.failed === undefined ? {} : { failed: record.confirmed.failed })
			}
		})
	};
}

/** GET /agent-whales/api/proposals?leadSessionId=：当前 Lead 的最新提案。 */
function handleProposalsRequest(ctx, req, res, get) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const caller = teamCaller(get, queryParam(req.url, "leadSessionId"));
	if (caller.code !== undefined && caller.code !== TASK_CODE.ok) {
		sendEnvelope(res, caller.code === TASK_CODE.forbidden ? 403 : 200, caller.code, caller.msg);
		return;
	}
	const store = readProposalStore();
	const leadSessionId = String(caller.lead.id);
	const record = store[leadSessionId];
	sendEnvelope(res, 200, TASK_CODE.ok, "success", { proposal: proposalView(record), order: record ? record.order : undefined });
}

/**
 * POST /agent-whales/api/proposals/:proposalId/confirm
 * body: { leadSessionId, version, requestId }
 * 语义：只创建任务，不分配、不派发（owner 仍是建议）。
 */
function handleProposalConfirmRequest(ctx, req, res, get, control, proposalId) {
	const method = requestMethod(req);
	if (method === "OPTIONS") { res.setHeader("allow", "POST, OPTIONS"); sendEmpty(res, 204); return Promise.resolve(); }
	if (method !== "POST") { res.setHeader("allow", "POST, OPTIONS"); sendEnvelope(res, 405, TASK_CODE.param, "method not allowed"); return Promise.resolve(); }
	const header = req && req.headers ? req.headers["x-whales-token"] : undefined;
	const token = Array.isArray(header) ? header[0] : header;
	if (typeof token !== "string" || !control || typeof control.controlToken !== "string" || token !== control.controlToken) {
		sendEnvelope(res, 403, TASK_CODE.forbidden, "same-origin token required");
		return Promise.resolve();
	}
	return (async () => {
		try {
			const raw = await readRequestBody(req);
			let payload;
			try { payload = JSON.parse(raw); } catch (error) { sendEnvelope(res, 400, TASK_CODE.param, "invalid json body"); return; }
			const requestId = payload && typeof payload.requestId === "string" ? payload.requestId.trim() : "";
			const version = payload && typeof payload.version === "number" ? payload.version : undefined;
			if (requestId === "" || version === undefined) { sendEnvelope(res, 400, TASK_CODE.param, "requestId and version are required"); return; }

			control.proposalConfirmInFlight = control.proposalConfirmInFlight || new Map();
			const memo = control.proposalConfirmInFlight;
			const existing = memo.get(requestId);
			if (existing) {
				const shared = await existing;
				sendEnvelope(res, 200, shared.code, shared.msg, { ...shared.data, replayed: true });
				return;
			}
			// 项目提案走项目任务表：不依赖 agentTeams，也不要求 Lead 存活。
			const payloadLead = typeof payload.leadSessionId === "string" ? payload.leadSessionId.trim() : "";
			const earlyStore = readProposalStore();
			const earlyRecord = payloadLead === "" ? undefined : earlyStore[payloadLead];
			if (earlyRecord !== undefined && typeof earlyRecord.projectId === "string" && earlyRecord.projectId !== "") {
				if (earlyRecord.proposalId !== proposalId) { sendEnvelope(res, 200, TASK_CODE.notFound, "proposal not found"); return; }
				if (earlyRecord.version !== version) { sendEnvelope(res, 200, TASK_CODE.revisionConflict, "proposal version changed", { latestVersion: earlyRecord.version }); return; }
				control.proposalConfirmInFlight = control.proposalConfirmInFlight || new Map();
				const sharedProject = control.proposalConfirmInFlight.get(requestId);
				if (sharedProject) {
					const shared = await sharedProject;
					sendEnvelope(res, 200, shared.code, shared.msg, Object.assign({}, shared.data, { replayed: true }));
					return;
				}
				await withStoreLock(async function () {
					const projectResult = await confirmProjectProposal(ctx, get, earlyRecord, proposalId, version, requestId, control.proposalConfirmInFlight);
					sendEnvelope(res, projectResult.http || 200, projectResult.code, projectResult.msg, projectResult.data);
				});
				return;
			}
			const caller = teamCaller(get, payload.leadSessionId);
			if (caller.code !== undefined && caller.code !== TASK_CODE.ok) {
				sendEnvelope(res, caller.code === TASK_CODE.forbidden ? 403 : 200, caller.code, caller.msg);
				return;
			}
			const store = readProposalStore();
			const record = store[String(caller.lead.id)];
			if (!record || record.proposalId !== proposalId) { sendEnvelope(res, 200, TASK_CODE.notFound, "proposal not found"); return; }
			if (record.version !== version) { sendEnvelope(res, 200, TASK_CODE.revisionConflict, "proposal version changed", { latestVersion: record.version }); return; }
			const alreadyConfirmed = record.confirmed !== undefined;
			const confirmedSameVersion = alreadyConfirmed && record.confirmed.version === version;
			const hasFailure = confirmedSameVersion && record.confirmed.failed !== undefined && record.confirmed.failed.length > 0;
			if (alreadyConfirmed && !confirmedSameVersion) {
				// 已确认即锁定：不再接受任何新版本的确认（新调整应走新提案/任务板命令）。
				sendEnvelope(res, 200, TASK_CODE.taskClosed, "proposal already confirmed and locked", { confirmedVersion: record.confirmed.version });
				return;
			}
			if (confirmedSameVersion && !hasFailure) {
				// 同版本已全部成功：返回既有结果，不重复创建。
				sendEnvelope(res, 200, TASK_CODE.ok, "success", { proposalId: proposalId, version: version, created: record.confirmed.created, already: true });
				return;
			}
			if (typeof caller.teams.createTask !== "function") { sendEnvelope(res, 500, TASK_CODE.internal, "team service cannot create tasks"); return; }

			// 重试语义（换新 requestId、同版本）：跳过已建项，只补缺失项；
			// 前置没建成的项标 blocked，不尝试创建；超时标 unknown，不自动重发。
			const created = confirmedSameVersion ? record.confirmed.created.slice() : [];
			const createdMap = {};
			created.forEach((row) => { createdMap[row.key] = row.taskId; });
			const pending = new Map();
			const order = Array.isArray(record.order) && record.order.length > 0 ? record.order : record.items.map((item) => item.key);
			const byKey = new Map(record.items.map((item) => [item.key, item]));
			const execution = (async () => {
				for (const key of order) {
					const item = byKey.get(key);
					if (!item) continue;
					if (createdMap[key] !== undefined) continue;
					const missingDep = item.blockedByKeys.find((dep) => createdMap[dep] === undefined);
					if (missingDep !== undefined) {
						pending.set(key, { status: "blocked", message: "前置未创建: " + missingDep });
						continue;
					}
					const blockedBy = item.blockedByKeys.map((dep) => createdMap[dep]).filter((value) => typeof value === "string");
					try {
						const task = await caller.teams.createTask(caller.lead, {
							subject: item.title,
							description: item.description,
							...(blockedBy.length === 0 ? {} : { blockedBy: blockedBy })
						});
						createdMap[key] = String(task.id);
						created.push({ key: key, taskId: String(task.id), revision: task.revision });
					} catch (error) {
						const message = error && error.message ? String(error.message) : "create failed";
						// 超时 = 结果未知：不当作失败重试，交给用户决定。
						const unknown = /timeout|timed out|etimedout|abort/i.test(message);
						pending.set(key, { status: unknown ? "unknown" : "failed", message: message, retryable: !unknown });
						continue;
					}
				}
				const failedList = pending.size === 0
					? undefined
					: Array.from(pending.entries()).map(([key, row]) => ({ key: key, status: row.status, message: row.message, ...(row.retryable === false ? { retryable: false } : {}) }));
				return { code: TASK_CODE.ok, msg: "success", data: { proposalId: proposalId, version: version, created: created, ...(failedList === undefined ? {} : { failed: failedList }), ...(confirmedSameVersion ? { retried: true } : {}) } };
			})();
			memo.set(requestId, execution);
			const result = await execution;
			// 记录确认结果（部分成功/未知也记：锁定 + 可重试的依据）
			const fresh = readProposalStore();
			const target = fresh[String(caller.lead.id)];
			if (target && target.proposalId === proposalId && target.version === version) {
				const failedList = result.data.failed;
				target.confirmed = {
					version: version,
					created: result.data.created,
					...(failedList === undefined ? {} : { failed: failedList }),
					lockedAt: Date.now()
				};
				const persisted = await writeProposalStore(ctx, fresh);
				if (!persisted) {
					// 任务已建，但确认结果没落盘：如实告知，不回滚、不假装成功。
					sendEnvelope(res, 200, result.code, result.msg, Object.assign({}, result.data, { storeReadonly: true }));
					return;
				}
			}
			sendEnvelope(res, 200, result.code, result.msg, result.data);

		} catch (error) {
			warn(ctx, "proposal confirm", error);
			sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
		}
	})();
}

/** Lead 专用：提交结构化任务提案（不解析 Markdown）。 */
function registerProposalTool(ctx, get) {
	const tools = get("tools");
	if (!tools || typeof tools.register !== "function") return;
	let rawDisposer;
	try {
		rawDisposer = tools.register({
			name: "whales_propose_tasks",
			description:
				"提交一份结构化任务提案（供用户在画布上确认后创建任务）。收到用户目标后用它提交，不要用 Markdown 清单代替。" +
				"items 里每个任务需要 key（临时唯一键）与 title；blockedByKeys 引用同一提案内其它 key；suggestedOwner 只是建议（createTask 没有 owner 参数，确认时不会写归属）。" +
				"提交后会生成新版本，旧版本的确认入口随之失效。",
			parameters: {
				type: "object",
				properties: {
					leadSessionId: { type: "string", description: "可省略；填了就必须等于当前会话（身份以执行上下文为准）。" },
					projectId: { type: "string", description: "项目 id（可选）。带上后提案确认会写入项目任务表，而不是宿主任务板。" },
					sourceMessageId: { type: "string", description: "触发本提案的用户消息 id（可选）。" },
					items: {
						type: "array",
						description: "任务项；按声明顺序即默认创建顺序（依赖仍以 blockedByKeys 为准）。",
						items: {
							type: "object",
							properties: {
								key: { type: "string" },
								title: { type: "string" },
								description: { type: "string" },
								blockedByKeys: { type: "array", items: { type: "string" } },
								suggestedOwner: { type: "string" },
								expectedOutput: { type: "string" }
							},
							required: ["key", "title"],
							additionalProperties: false
						}
					},
					writeScopes: { type: "array", items: { type: "string" } }
				},
				required: ["items"],
				additionalProperties: false
			},
			output: {
				schema: { type: "object", additionalProperties: true },
				render: (value) => "提案 " + String(value.proposalId) + " v" + String(value.version) + "（" + String(value.count) + " 项）已提交，等待用户确认"
			},
			async execute(args, exec) {
				// 身份只取执行上下文（§53.9.1）；参数自报的 leadSessionId 一律不采信。
				const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
				if (callerId === "") {
					const missing = new Error("[40301] cannot determine the calling session; proposal rejected");
					missing.code = "40301";
					throw missing;
				}
				const declaredLead = typeof args?.leadSessionId === "string" ? args.leadSessionId.trim() : "";
				if (declaredLead !== "" && declaredLead !== callerId) {
					const spoofed = new Error("[40301] leadSessionId does not match the calling session; proposal rejected");
					spoofed.code = "40301";
					throw spoofed;
				}
				const validated = validateProposal(Object.assign({}, args, { leadSessionId: callerId }));
				if (validated.error !== undefined) throw new Error("invalid proposal: " + validated.error);
				const projectId = typeof args.projectId === "string" ? args.projectId.trim() : "";
				if (projectId !== "") {
					const projectRead = readProjectStore();
					const project = projectRead.store.projects[projectId];
					if (project === undefined) throw new Error("[40401] invalid proposal: project not found");
					if (project.mainSessionId !== callerId) {
						const notMain = new Error("[40706] only the project main session may submit a proposal");
						notMain.code = "40706";
						throw notMain;
					}
				}
				return await withStoreLock(async function () {
				const store = readProposalStore();
				const previous = store[validated.leadSessionId];
				// 已确认（含部分成功）即锁定：后续调整提交为**新提案**（新 id、v1），不再给旧提案升版本。
				const locked = previous !== undefined && previous.confirmed !== undefined;
				const proposalId = previous && !locked && typeof previous.proposalId === "string" ? previous.proposalId : "prop-" + randomUUID();
				const version = previous && !locked && typeof previous.version === "number" ? previous.version + 1 : 1;
				const record = {
					proposalId: proposalId,
					version: version,
					leadSessionId: validated.leadSessionId,
					...(projectId === "" ? {} : { projectId: projectId }),
					...(typeof args.sourceMessageId === "string" ? { sourceMessageId: args.sourceMessageId } : {}),
					items: validated.items,
					order: validated.order,
					...(validated.writeScopes === undefined ? {} : { writeScopes: validated.writeScopes }),
					createdAt: Date.now()
				};
				store[validated.leadSessionId] = record;
				if (!(await writeProposalStore(ctx, store))) throw new Error("proposal store write failed");
				return { proposalId: proposalId, version: version, count: validated.items.length };
				});
			}
		});
	} catch (error) {
		warn(ctx, "proposal tool", error);
		return;
	}
	// 与串门工具一样把注销绑到注入作用域：服务重载/插件卸载时必须撤销，否则热重载会重复注册或泄漏。
	if (typeof rawDisposer !== "function") return;
	let disposed = false;
	const release = function () {
		if (disposed) return;
		disposed = true;
		try {
			rawDisposer();
		} catch (error) {
			warn(ctx, "proposal tool dispose", error);
		}
	};
	if (ctx && typeof ctx.effect === "function") {
		try {
			ctx.effect(() => release, "agent-whales: proposal tool");
		} catch (error) {
			warn(ctx, "proposal tool effect", error);
		}
	}
}

	// ── 3b2) 通用持久化 store（M1）：原子写 / 损坏备份 + 只读降级 / 进程内串行 ──
	//
	// 为什么不是"解析失败就读空表"：那会让下一次写入用空表覆盖原文件，数据永久丢失。
	// 现在的规则：解析失败 → 原文件改名为 <file>.corrupt-<时间戳> → 该 store 进入只读降级，
	// 读仍可用（返回空表），写被拒绝并返回 503；插件照常启动，装饰层不受影响。

	const STORE_STATE = new Map();
	const STORE_QUEUES = new Map();

	function storeStateOf(file) {
		let state = STORE_STATE.get(file);
		if (state === undefined) {
			state = { readonly: false, backupPath: undefined };
			STORE_STATE.set(file, state);
		}
		return state;
	}

	class StoreReadonlyError extends Error {
		constructor(file, backupPath) {
			super("store is read-only after corruption: " + file);
			this.name = "StoreReadonlyError";
			this.code = "STORE_READONLY";
			this.backupPath = backupPath;
		}
	}

	/** 读 store：不存在 = 空表；损坏 = 备份 + 只读降级（读仍返回空表）。 */
	function readStoreFile(file) {
		const state = storeStateOf(file);
		if (state.readonly) return { data: {}, readonly: true, backupPath: state.backupPath };
		let raw;
		try {
			raw = readFileSync(file, "utf8");
		} catch (error) {
			if (error && error.code === "ENOENT") return { data: {}, readonly: false, backupPath: undefined };
			// 读不了（权限/IO）同样按只读处理：宁可不写，也不覆盖。
			state.readonly = true;
			return { data: {}, readonly: true, backupPath: undefined };
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			parsed = undefined;
		}
		if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			const backupPath = file + ".corrupt-" + Date.now();
			try {
				renameSync(file, backupPath);
				state.backupPath = backupPath;
			} catch (error) {
				state.backupPath = undefined;
			}
			state.readonly = true;
			return { data: {}, readonly: true, backupPath: state.backupPath };
		}
		return { data: parsed, readonly: false, backupPath: undefined };
	}

	/** 写 store：只读降级时拒绝；临时文件 + rename 原子写；同一文件串行。 */
	function writeStoreFile(file, data) {
		const state = storeStateOf(file);
		if (state.readonly) return Promise.reject(new StoreReadonlyError(file, state.backupPath));
		const previous = STORE_QUEUES.get(file) || Promise.resolve();
		const next = previous.then(function () {
			mkdirSync(dirname(file), { recursive: true });
			const temp = file + ".tmp-" + process.pid + "-" + randomUUID();
			writeFileSync(temp, JSON.stringify(data), "utf8");
			renameSync(temp, file);
		});
		STORE_QUEUES.set(file, next.then(function () {}, function () {}));
		return next;
	}

	// ── 3b3) 项目注册表（M1）：项目 / 成员 / 关联线（任务表在 M2 才接）──
	//
	// 写操作不只串行"落盘"，还要串行"读-改-写"：否则两个并发创建会各自基于旧快照写回，丢更新。
	// 统一写队列：projects.json / proposals.json 的"读-改-写"全部串行，
	// 避免两个 handler 各读旧快照再各写回造成跨实体丢更新（CAS 也才真正生效）。
	let storeMutationChain = Promise.resolve();
	function withStoreLock(operation) {
		const run = storeMutationChain.then(operation, operation);
		storeMutationChain = run.then(function () {}, function () {});
		return run;
	}
	function handleProjectRoute(ctx, req, res, get, control, route) {
		// 锁粒度细化：这里不再整体包锁；各写分支只在自己的「读最新 → 同步改 → 原子写」段进 withStoreLock。
		return handleProjectRouteInner(ctx, req, res, get, control, route);
	}

	const PROJECTS_STORE_SUFFIX = "projects.json";
	let PROJECTS_STORE_OVERRIDE;
	function projectsStoreFile() {
		return PROJECTS_STORE_OVERRIDE || join(PROPOSAL_STORE_DIR, PROJECTS_STORE_SUFFIX);
	}
	/** 仅供离线测试：把项目 store 指到临时目录。 */
	export function setProjectStorePathForTests(file) {
		if (typeof file !== "string" || file === "") return;
		PROJECTS_STORE_OVERRIDE = file;
	}

	const PROJECT_CODE = {
		ok: 200,
		param: 40000,
		forbidden: 40301,
		notFound: 40401,
		conflict: 40701,
		mainFixed: 40702,
		notMain: 40706,
		storeReadonly: 50302,
		internal: 50000
	};

	const PROJECTS_PREFIX = `${ACTIVITY_PATH}/projects`;

	/** 解析 /agent-whales/api/projects[/<id>[/members|links[/<sid>]]]。 */
	function parseProjectRoute(pathname) {
		if (typeof pathname !== "string") return undefined;
		if (pathname === PROJECTS_PREFIX) return { kind: "collection" };
		if (!pathname.startsWith(PROJECTS_PREFIX + "/")) return undefined;
		const parts = pathname.slice(PROJECTS_PREFIX.length + 1).split("/").filter((part) => part !== "");
		if (parts.length === 0) return undefined;
		const decode = (value) => {
			try { return decodeURIComponent(value); } catch (error) { return value; }
		};
		const projectId = decode(parts[0]);
		if (parts.length === 1) return { kind: "project", projectId: projectId };
		if (parts.length === 2 && (parts[1] === "members" || parts[1] === "links" || parts[1] === "brief")) {
			return { kind: parts[1], projectId: projectId };
		}
		if (parts.length === 3 && parts[1] === "members") {
			return { kind: "member", projectId: projectId, sessionId: decode(parts[2]) };
		}
		return undefined;
	}

	function readProjectStore() {
		const result = readStoreFile(projectsStoreFile());
		const store = result.data;
		if (store.projects === undefined || store.projects === null || typeof store.projects !== "object" || Array.isArray(store.projects)) {
			store.projects = {};
		}
		return { store: store, readonly: result.readonly, backupPath: result.backupPath };
	}

	function writeProjectStore(ctx, store) {
		return writeStoreFile(projectsStoreFile(), store).then(
			function () { return true; },
			function (error) {
				if (error && error.code === "STORE_READONLY") return false;
				warn(ctx, "project store write", error);
				return false;
			}
		);
	}

	/** 一个对话只能属于一个项目：返回它所在的项目（不存在则 undefined）。 */
	function projectOfSession(store, sessionId) {
		for (const project of Object.values(store.projects)) {
			if (!project || !Array.isArray(project.members)) continue;
			if (project.mainSessionId === sessionId) return project;
			for (const member of project.members) {
				if (member && member.sessionId === sessionId) return project;
			}
		}
		return undefined;
	}

	/** 会话是否存在（不要求在运行）：live 会话 / agent / 持久化 stat 任一命中。 */
	async function sessionExists(get, sessionId) {
		const id = typeof sessionId === "string" ? sessionId.trim() : "";
		if (id === "") return false;
		const sessions = typeof get === "function" ? get("sessions") : undefined;
		if (sessions && typeof sessions.get === "function") {
			try {
				if (sessions.get(id) !== undefined) return true;
			} catch (error) { /* 继续走后备 */ }
		}
		const agents = typeof get === "function" ? get("agents") : undefined;
		if (agents && typeof agents.get === "function") {
			try {
				if (agents.get(id) !== undefined) return true;
			} catch (error) { /* 继续走后备 */ }
		}
		const persistence = typeof get === "function" ? get("sessionPersistence") : undefined;
		if (persistence && typeof persistence.stat === "function") {
			try {
				const stat = await Promise.resolve(persistence.stat(id));
				return stat !== undefined && stat !== null && stat !== false;
			} catch (error) {
				return false;
			}
		}
		return false;
	}

	function normalizeLinkPair(a, b) {
		return a < b ? [a, b] : [b, a];
	}

	function projectView(project) {
		return {
			projectId: project.projectId,
			name: project.name,
			mainSessionId: project.mainSessionId,
			members: Array.isArray(project.members) ? project.members : [],
			links: Array.isArray(project.links) ? project.links : [],
			brief: project.brief,
			createdAt: project.createdAt,
			updatedAt: project.updatedAt
		};
	}

	/** 项目的写前置：同源 token + store 可写。返回 {ok} 或已发送响应。 */
	function projectWriteGuard(res, req, control) {
		const header = req && req.headers ? req.headers["x-whales-token"] : undefined;
		const token = Array.isArray(header) ? header[0] : header;
		if (typeof token !== "string" || !control || typeof control.controlToken !== "string" || token !== control.controlToken) {
			sendEnvelope(res, 403, PROJECT_CODE.forbidden, "same-origin token required");
			return false;
		}
		return true;
	}

	/** 锁外解析请求体（await 不占写锁）。 */
	async function readJsonBody(req) {
		try {
			return JSON.parse(await readRequestBody(req));
		} catch (error) {
			return undefined;
		}
	}

	/** 业务失败（锁内抛出 → 由 sendStoreError 翻成响应）。 */
	function routeFailure(code, message, data) {
		const error = new Error(message);
		error.projectCode = code;
		error.projectData = data;
		return error;
	}

	/** 统一写入口：串行队列里完成「读最新 → 同步 mutate → 原子写」。 */
	function mutateProject(fn) {
		return withStoreLock(function () {
			const read = readProjectStore();
			if (read.readonly) throw new StoreReadonlyError(projectsStoreFile(), read.backupPath);
			const value = fn(read.store);
			return writeStoreFile(projectsStoreFile(), read.store).then(function () {
				return value;
			});
		});
	}

	function sendStoreError(ctx, res, error) {
		if (error && error.code === "STORE_READONLY") {
			sendEnvelope(res, 503, PROJECT_CODE.storeReadonly, "store is read-only (corrupted, backed up)");
			return;
		}
		if (error && typeof error.projectCode === "number") {
			sendEnvelope(res, 200, error.projectCode, error.message, error.projectData);
			return;
		}
		warn(ctx, "project route", error);
		sendEnvelope(res, 500, PROJECT_CODE.internal, "internal error");
	}

	/**
	 * 项目路由。约定：请求体解析 / 参数校验 / 会话存在性检查都在**锁外**；
	 * 锁内只做「读最新 store → 同步校验并修改 → 原子写」，避免慢操作拖住全局写入。
	 */
	async function handleProjectRouteInner(ctx, req, res, get, control, route) {
		const method = requestMethod(req);
		if (route.kind === "collection") {
			if (method === "GET" || method === "HEAD") {
				const read = readProjectStore();
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { projects: Object.values(read.store.projects).map(projectView) });
				return;
			}
			if (method !== "POST") {
				res.setHeader("allow", "GET, HEAD, POST");
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			const payload = await readJsonBody(req);
			if (payload === undefined || payload === null || typeof payload !== "object") {
				sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body");
				return;
			}
			const name = typeof payload.name === "string" ? payload.name.trim() : "";
			const mainSessionId = typeof payload.mainSessionId === "string" ? payload.mainSessionId.trim() : "";
			if (name === "" || mainSessionId === "") {
				sendEnvelope(res, 400, PROJECT_CODE.param, "name and mainSessionId are required");
				return;
			}
			if (!(await sessionExists(get, mainSessionId))) {
				sendEnvelope(res, 200, PROJECT_CODE.notFound, "main session not found");
				return;
			}
			try {
				const project = await mutateProject(function (store) {
					const occupied = projectOfSession(store, mainSessionId);
					if (occupied !== undefined) {
						throw routeFailure(PROJECT_CODE.conflict, "main session already belongs to a project", { projectId: occupied.projectId });
					}
					const now = Date.now();
					const record = {
						projectId: "proj-" + randomUUID(),
						name: name,
						mainSessionId: mainSessionId,
						members: [{ sessionId: mainSessionId, role: "main", addedBy: "auto", joinedAt: now }],
						links: [],
						brief: {
							version: 1,
							goal: typeof payload.goal === "string" ? payload.goal : "",
							decisions: [],
							constraints: [],
							updatedAt: now,
							updatedBy: "user"
						},
						createdAt: now,
						updatedAt: now
					};
					store.projects[record.projectId] = record;
					return record;
				});
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { project: projectView(project) });
			} catch (error) {
				sendStoreError(ctx, res, error);
			}
			return;
		}

		// 单项目路由：先做只读存在性判断（不占锁）。
		const snapshot = readProjectStore();
		if (snapshot.store.projects[route.projectId] === undefined) {
			sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found");
			return;
		}

		if (route.kind === "project") {
			if (method !== "GET" && method !== "HEAD") {
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { project: projectView(snapshot.store.projects[route.projectId]) });
			return;
		}

		if (route.kind === "brief") {
			if (method === "GET" || method === "HEAD") {
				const read = readProjectStore();
				const project = read.store.projects[route.projectId];
				if (project === undefined) { sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found"); return; }
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { brief: projectBriefOrDefault(project) });
				return;
			}
			if (method !== "PUT") {
				res.setHeader("allow", "GET, HEAD, PUT");
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			const payload = await readJsonBody(req);
			if (payload === undefined || payload === null || typeof payload !== "object") {
				sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body");
				return;
			}
			try {
				const brief = await mutateProject(function (store) {
					const project = store.projects[route.projectId];
					if (project === undefined) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					const result = writeProjectBrief(project, payload, "user");
					if (result.code !== TASK_CODE.ok) throw routeFailure(result.code, result.msg, result.data);
					project.updatedAt = Date.now();
					return result.data.brief;
				});
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { brief: brief });
			} catch (error) {
				sendStoreError(ctx, res, error);
			}
			return;
		}

		if (route.kind === "members") {
			if (method !== "POST") {
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			const payload = await readJsonBody(req);
			if (payload === undefined || payload === null || typeof payload !== "object") {
				sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body");
				return;
			}
			const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
			if (sessionId === "") {
				sendEnvelope(res, 400, PROJECT_CODE.param, "sessionId is required");
				return;
			}
			if (!(await sessionExists(get, sessionId))) {
				sendEnvelope(res, 200, PROJECT_CODE.notFound, "session not found");
				return;
			}
			try {
				const result = await mutateProject(function (store) {
					const project = store.projects[route.projectId];
					if (project === undefined) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					if (!Array.isArray(project.members)) project.members = [];
					if (!Array.isArray(project.links)) project.links = [];
					if (project.members.some((member) => member && member.sessionId === sessionId)) {
						return { project: projectView(project), already: true };
					}
					const occupied = projectOfSession(store, sessionId);
					if (occupied !== undefined) {
						throw routeFailure(PROJECT_CODE.conflict, "session already belongs to a project", { projectId: occupied.projectId });
					}
					project.members.push({ sessionId: sessionId, role: "member", addedBy: "manual", joinedAt: Date.now() });
					const pair = normalizeLinkPair(sessionId, project.mainSessionId);
					if (pair[0] !== pair[1] && !project.links.some((link) => link && link.a === pair[0] && link.b === pair[1])) {
						project.links.push({ a: pair[0], b: pair[1], kind: "relay", createdAt: Date.now() });
					}
					project.updatedAt = Date.now();
					return { project: projectView(project) };
				});
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", result);
			} catch (error) {
				sendStoreError(ctx, res, error);
			}
			return;
		}

		if (route.kind === "member") {
			if (method !== "DELETE") {
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			try {
				const project = await mutateProject(function (store) {
					const project = store.projects[route.projectId];
					if (project === undefined) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					if (route.sessionId === project.mainSessionId) throw routeFailure(PROJECT_CODE.mainFixed, "main session cannot be removed");
					if (!Array.isArray(project.members)) project.members = [];
					const index = project.members.findIndex((member) => member && member.sessionId === route.sessionId);
					if (index < 0) throw routeFailure(PROJECT_CODE.notFound, "member not found");
					project.members.splice(index, 1);
					project.links = (Array.isArray(project.links) ? project.links : []).filter((link) => link && link.a !== route.sessionId && link.b !== route.sessionId);
					project.updatedAt = Date.now();
					return projectView(project);
				});
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { project: project });
			} catch (error) {
				sendStoreError(ctx, res, error);
			}
			return;
		}

		if (route.kind === "links") {
			if (method !== "POST" && method !== "DELETE") {
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			const payload = await readJsonBody(req);
			if (payload === undefined || payload === null || typeof payload !== "object") {
				sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body");
				return;
			}
			const a = typeof payload.a === "string" ? payload.a.trim() : "";
			const b = typeof payload.b === "string" ? payload.b.trim() : "";
			if (a === "" || b === "") {
				sendEnvelope(res, 400, PROJECT_CODE.param, "a and b are required");
				return;
			}
			if (a === b) {
				sendEnvelope(res, 400, PROJECT_CODE.param, "a and b must differ");
				return;
			}
			const pair = normalizeLinkPair(a, b);
			try {
				const result = await mutateProject(function (store) {
					const project = store.projects[route.projectId];
					if (project === undefined) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					if (!Array.isArray(project.members)) project.members = [];
					if (!Array.isArray(project.links)) project.links = [];
					const isMember = (id) => id === project.mainSessionId || project.members.some((member) => member && member.sessionId === id);
					if (!isMember(a) || !isMember(b)) throw routeFailure(PROJECT_CODE.param, "both sides must be project members");
					const existing = project.links.findIndex((link) => link && link.a === pair[0] && link.b === pair[1]);
					if (method === "POST") {
						if (existing < 0) {
							project.links.push({ a: pair[0], b: pair[1], kind: "relay", createdAt: Date.now() });
							project.updatedAt = Date.now();
						}
						return { project: projectView(project), already: existing >= 0 };
					}
					if (existing >= 0) {
						project.links.splice(existing, 1);
						project.updatedAt = Date.now();
					}
					return { project: projectView(project), removed: existing >= 0 };
				});
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", result);
			} catch (error) {
				sendStoreError(ctx, res, error);
			}
			return;
		}
	}

	// ── 3b4) M2：项目任务表（方案 A）──
	//
	// 为什么自建：宿主任务板 owner 只能是团队成员（§52.1 实测），加入项目的历史对话接不了任务。
	// source 语义（§53.9.9）：带 projectId 只返回项目表（顶层 source="project"），
	// 带 leadSessionId 只返回宿主板（顶层 source="host"），两者不得混在同一响应里。

	const PROJECT_TASK_EXTRA = {
		notMember: 40703,
		crossProjectBlocker: 40704,
		cycle: 40705,
		notLinked: 40707
	};

	function ensureProjectTasks(store) {
		if (store.tasks === undefined || store.tasks === null || typeof store.tasks !== "object" || Array.isArray(store.tasks)) {
			store.tasks = {};
		}
		return store.tasks;
	}

	function projectTasksOf(store, projectId) {
		const tasks = ensureProjectTasks(store);
		return Object.values(tasks).filter((task) => task && task.projectId === projectId);
	}

	function projectTaskOf(store, projectId, taskId) {
		const tasks = ensureProjectTasks(store);
		const task = tasks[taskId];
		return task !== undefined && task.projectId === projectId ? task : undefined;
	}

	function projectIsMember(project, sessionId) {
		if (sessionId === project.mainSessionId) return true;
		return Array.isArray(project.members) && project.members.some((member) => member && member.sessionId === sessionId);
	}

	/**
	 * 跨会话访问闸（M4）：只要发送方或接收方任一方在项目里，就必须「同项目 + 有关联线」；
	 * 双方都不在任何项目里 → 放行（旧串门行为不变）。
	 */
	function checkCrossSessionAccess(get, callerSessionId, targetSessionId) {
		const read = readProjectStore();
		if (read.readonly) return { ok: true, degraded: true };
		const caller = typeof callerSessionId === "string" ? callerSessionId.trim() : "";
		const target = typeof targetSessionId === "string" ? targetSessionId.trim() : "";
		if (caller === "" || target === "") return { ok: true };
		const callerProject = projectOfSession(read.store, caller);
		const targetProject = projectOfSession(read.store, target);
		if (callerProject === undefined && targetProject === undefined) return { ok: true, legacy: true };
		if (callerProject === undefined || targetProject === undefined) {
			return { code: PROJECT_TASK_EXTRA.notMember, msg: "one side is not in a project" };
		}
		if (callerProject.projectId !== targetProject.projectId) {
			return { code: PROJECT_TASK_EXTRA.crossProjectBlocker, msg: "not in the same project" };
		}
		if (!projectIsMember(callerProject, caller) || !projectIsMember(callerProject, target)) {
			return { code: PROJECT_TASK_EXTRA.notMember, msg: "both sides must be project members" };
		}
		const links = Array.isArray(callerProject.links) ? callerProject.links : [];
		const linked = caller === target || links.some((link) => link && ((link.a === caller && link.b === target) || (link.a === target && link.b === caller)));
		if (!linked) return { code: PROJECT_TASK_EXTRA.notLinked, msg: "no link between the two sessions" };
		return { ok: true };
	}

	/** 带真实来源的中继消息（不再是裸的 kind:user）。 */
	function relayMessage(callerSessionId, text) {
		const sender = typeof callerSessionId === "string" && callerSessionId.trim() !== "" ? callerSessionId.trim() : undefined;
		return {
			id: randomUUID(),
			role: "user",
			content: [{ type: "text", text: text }],
			source: sender === undefined ? { kind: "user" } : { kind: "agent-message", form: "relay", senderSessionId: sender }
		};
	}

	/** M4 发送登记：锁内追加一条发送事实（不带外部 await）。 */
	function recordSend(fromSessionId, toSessionId, kind, messageId, extra) {
		return mutateProject(function (store) {
			store.sends = Array.isArray(store.sends) ? store.sends : [];
			if (store.sends.length > 500) store.sends.shift();
			store.sends.push(Object.assign({ from: fromSessionId, to: toSessionId, kind: kind, messageId: messageId, at: Date.now() }, extra === undefined ? {} : extra));
			return undefined;
		});
	}

	/** 项目任务视图：ready / blockedReason / writeScopeWarnings 全部派生不落库。 */
	function projectTaskView(store, task) {
		const tasks = ensureProjectTasks(store);
		const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
		const blockers = blockedBy.map((id) => tasks[id]).filter(Boolean);
		const missingBlocker = blockedBy.find((id) => tasks[id] === undefined);
		const deletedBlocker = blockedBy.find((id) => tasks[id] !== undefined && tasks[id].status === "deleted");
		const unfinished = blockers.filter((item) => item.status !== "completed");
		const ready = task.status === "pending" && blockedBy.length === blockers.length && unfinished.length === 0 && missingBlocker === undefined && deletedBlocker === undefined;
		let blockedReason;
		if (deletedBlocker !== undefined || missingBlocker !== undefined) blockedReason = "前置已删除";
		else if (unfinished.length > 0) blockedReason = "等待前置";
		const warnings = [];
		if (Array.isArray(task.writeScopes) && task.writeScopes.length > 0 && task.status === "in_progress") {
			for (const other of Object.values(tasks)) {
				if (!other || other.taskId === task.taskId || other.projectId !== task.projectId || other.status !== "in_progress") continue;
				if (!Array.isArray(other.writeScopes)) continue;
				for (const scope of task.writeScopes) {
					for (const otherScope of other.writeScopes) {
						if (scope === otherScope || scope.startsWith(otherScope) || otherScope.startsWith(scope)) {
							warnings.push({ taskId: other.taskId, writeScope: scope, otherWriteScope: otherScope });
						}
					}
				}
			}
		}
		return Object.assign({}, task, { ready: ready }, blockedReason === undefined ? {} : { blockedReason: blockedReason }, { writeScopeWarnings: warnings });
	}

	/** 依赖成环检测：从 nextBlockedBy 出发能否回到 taskId。 */
	function projectBlockedByWouldCycle(tasks, taskId, blockedBy) {
		const seen = new Set();
		const stack = blockedBy.slice();
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === taskId) return true;
			if (seen.has(current)) continue;
			seen.add(current);
			const task = tasks[current];
			if (task && Array.isArray(task.blockedBy)) stack.push.apply(stack, task.blockedBy);
		}
		return false;
	}

	/** 在项目表里创建任务（本地写，不调用宿主 createTask）。返回 { task } 或 { code, msg }。 */
	function createProjectTaskInStore(store, project, input) {
		const tasks = ensureProjectTasks(store);
		const blockedBy = Array.isArray(input.blockedBy) ? input.blockedBy.map((id) => String(id)) : [];
		for (const blockerId of blockedBy) {
			const blocker = tasks[blockerId];
			if (blocker === undefined || blocker.projectId !== project.projectId) {
				return { code: PROJECT_TASK_EXTRA.crossProjectBlocker, msg: "blockedBy task is not in this project" };
			}
			if (blocker.status === "deleted") {
				return { code: TASK_CODE.taskDeleted, msg: "blockedBy task is deleted" };
			}
		}
		const taskId = "ptask-" + randomUUID().slice(0, 8);
		if (projectBlockedByWouldCycle(tasks, taskId, blockedBy)) {
			return { code: PROJECT_TASK_EXTRA.cycle, msg: "dependency cycle" };
		}
		const now = Date.now();
		const task = {
			taskId: taskId,
			projectId: project.projectId,
			subject: String(input.subject || ""),
			description: String(input.description || ""),
			blockedBy: blockedBy,
			writeScopes: Array.isArray(input.writeScopes) ? input.writeScopes.map((value) => String(value)) : [],
			status: "pending",
			ownerSessionId: null,
			revision: 1,
			createdAt: now,
			updatedAt: now,
			...(input.sourceProposal === undefined ? {} : { sourceProposal: input.sourceProposal })
		};
		tasks[taskId] = task;
		return { task: task };
	}

	/** 项目任务状态变更（纯同步、不派发）：只在锁内调用。 */
	function applyProjectTaskCommand(store, project, task, payload) {
		const action = payload.action;
		const expectedRevision = payload.expectedRevision;
		const needsRevision = action !== "dispatch";
		if (needsRevision && task.revision !== expectedRevision) {
			return { code: TASK_CODE.revisionConflict, msg: "task revision conflict", data: { latestRevision: task.revision } };
		}
		const owner = typeof payload.owner === "string" ? payload.owner.trim() : "";
		if ((action === "assign" || action === "assign-and-dispatch") && owner === "") {
			return { code: TASK_CODE.param, msg: "owner is required for " + action };
		}
		if (owner !== "" && !projectIsMember(project, owner)) {
			return { code: PROJECT_TASK_EXTRA.notMember, msg: "owner must be a project member" };
		}
		const now = Date.now();
		const bump = function () { task.revision += 1; task.updatedAt = now; project.updatedAt = now; };
		let needsDispatch = false;
		if (action === "assign") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			task.ownerSessionId = owner;
			task.status = "in_progress";
			bump();
		} else if (action === "assign-and-dispatch") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			task.ownerSessionId = owner;
			task.status = "in_progress";
			needsDispatch = true;
			bump();
		} else if (action === "dispatch") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			needsDispatch = true;
		} else if (action === "unassign") {
			task.ownerSessionId = null;
			task.status = task.status === "completed" ? "completed" : "pending";
			bump();
		} else if (action === "reopen") {
			if (task.status !== "completed") return { code: TASK_CODE.taskClosed, msg: "only completed tasks can be reopened" };
			task.status = "pending";
			task.ownerSessionId = null;
			task.completedAt = null;
			bump();
		} else {
			return { code: TASK_CODE.param, msg: "unsupported action" };
		}
		return {
			code: TASK_CODE.ok,
			msg: "success",
			data: { source: "project", task: projectTaskView(store, task) },
			needsDispatch: needsDispatch,
			snapshot: { taskId: task.taskId, subject: task.subject, ownerSessionId: task.ownerSessionId }
		};
	}
	/** 项目任务的派发：直接投递到 owner 会话（项目成员是 sessionId，不是团队成员名）。 */
	async function dispatchProjectTask(get, task, timeoutMs, callerSessionId) {
		const owner = task && typeof task.ownerSessionId === "string" ? task.ownerSessionId : "";
		if (owner === "") return Promise.resolve({ status: "not-requested", reason: "no-owner" });
		// M4：派发也要过同一道访问闸（发起方 = 项目主对话）。
		if (typeof callerSessionId === "string" && callerSessionId !== "") {
			const access = checkCrossSessionAccess(get, callerSessionId, owner);
			if (access.ok !== true) return Promise.resolve({ status: "failed", reason: "access-denied", code: access.code });
		}
		const agent = liveAgent(get, owner);
		if (agent === undefined) return Promise.resolve({ status: "failed", reason: "owner-not-running" });
		const effectiveTimeoutMs = typeof timeoutMs === "number" && timeoutMs >= 10 ? Math.min(timeoutMs, TASK_DISPATCH_TIMEOUT_MS) : TASK_DISPATCH_TIMEOUT_MS;
		let expired = false;
		try {
			const timeoutMarker = new Promise((resolve) => {
				const timer = setTimeout(() => {
					expired = true;
					resolve({ timedOut: true });
				}, effectiveTimeoutMs);
				if (timer && typeof timer.unref === "function") timer.unref();
			});
			const message = relayMessage(callerSessionId, "开始任务：" + String(task.subject || task.taskId));
			const sent = await Promise.race([
				Promise.resolve().then(async function () {
					if (typeof agent.followup !== "function") throw new Error("followup unavailable");
					// 真实 agent.followup 是同步 void；测试/包装实现可能返回 Promise，这里统一等到它 settle。
					await Promise.resolve(agent.followup(message));
					return { ok: true };
				}),
				timeoutMarker
			]);
			if (expired || (sent && sent.timedOut === true)) return { status: "unknown", reason: "dispatch-timeout" };
			return { status: "sent", messageId: message.id };
		} catch (error) {
			const message = error && error.message ? String(error.message) : "";
			if (/timeout|timed out|etimedout/i.test(message)) return { status: "unknown", reason: "dispatch-timeout" };
			return { status: "failed", reason: "dispatch-rejected" };
		}
	}

	/** 执行一条项目任务命令（CAS + 成员校验 + 依赖校验）。 */
	async function runProjectTaskCommand(get, store, project, task, payload) {
		const action = payload.action;
		const expectedRevision = payload.expectedRevision;
		const needsRevision = action !== "dispatch";
		if (needsRevision && task.revision !== expectedRevision) {
			return { code: TASK_CODE.revisionConflict, msg: "task revision conflict", data: { latestRevision: task.revision } };
		}
		const owner = typeof payload.owner === "string" ? payload.owner.trim() : "";
		if ((action === "assign" || action === "assign-and-dispatch") && owner === "") {
			return { code: TASK_CODE.param, msg: "owner is required for " + action };
		}
		if (owner !== "" && !projectIsMember(project, owner)) {
			return { code: PROJECT_TASK_EXTRA.notMember, msg: "owner must be a project member" };
		}
		const now = Date.now();
		const bump = () => {
			task.revision += 1;
			task.updatedAt = now;
			project.updatedAt = now;
		};
		let dispatch;
		if (action === "assign") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			task.ownerSessionId = owner;
			task.status = "in_progress";
			bump();
		} else if (action === "assign-and-dispatch") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			task.ownerSessionId = owner;
			task.status = "in_progress";
			bump();
			dispatch = await dispatchProjectTask(get, task, payload.dispatchTimeoutMs);
		} else if (action === "dispatch") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			dispatch = await dispatchProjectTask(get, task, payload.dispatchTimeoutMs);
		} else if (action === "unassign") {
			task.ownerSessionId = null;
			task.status = task.status === "completed" ? "completed" : "pending";
			bump();
		} else if (action === "reopen") {
			if (task.status !== "completed") return { code: TASK_CODE.taskClosed, msg: "only completed tasks can be reopened" };
			task.status = "pending";
			task.ownerSessionId = null;
			task.completedAt = null;
			bump();
		} else {
			return { code: TASK_CODE.param, msg: "unsupported action" };
		}
		return { code: TASK_CODE.ok, msg: "success", data: { source: "project", task: projectTaskView(store, task), ...(dispatch === undefined ? {} : { dispatch: dispatch }) } };
	}

	/** 项目提案确认：写入项目任务表（含锁定/重试/未知语义），不碰宿主任务板。 */
	async function confirmProjectProposal(ctx, get, record, proposalId, version, requestId, memo) {
		// 在写锁内重读提案记录：并发确认时必须基于最新状态判断，不能信任 handler 早先的快照。
		const freshProposals = readProposalStore();
		const latestRecord = freshProposals[String(record.leadSessionId)];
		if (latestRecord === undefined || latestRecord.proposalId !== proposalId) return { code: TASK_CODE.notFound, msg: "proposal not found", http: 200 };
		if (latestRecord.version !== version) return { code: TASK_CODE.revisionConflict, msg: "proposal version changed", http: 200, data: { latestVersion: latestRecord.version } };
		record = latestRecord;
		const read = readProjectStore();
		const project = read.store.projects[record.projectId];
		if (project === undefined) return { code: PROJECT_CODE.notFound, msg: "project not found", http: 200 };
		const alreadyConfirmed = record.confirmed !== undefined;
		const sameVersion = alreadyConfirmed && record.confirmed.version === version;
		const hasFailure = sameVersion && Array.isArray(record.confirmed.failed) && record.confirmed.failed.length > 0;
		if (alreadyConfirmed && !sameVersion) {
			return { code: TASK_CODE.taskClosed, msg: "proposal already confirmed and locked", http: 200, data: { confirmedVersion: record.confirmed.version } };
		}
		if (sameVersion && !hasFailure) {
			return { code: TASK_CODE.ok, msg: "success", http: 200, data: { source: "project", proposalId: proposalId, version: version, created: record.confirmed.created, already: true } };
		}
		const created = sameVersion ? record.confirmed.created.slice() : [];
		const createdMap = {};
		created.forEach((row) => { createdMap[row.key] = row.taskId; });
		const pending = new Map();
		const order = Array.isArray(record.order) && record.order.length > 0 ? record.order : record.items.map((item) => item.key);
		const byKey = new Map(record.items.map((item) => [item.key, item]));
		const execution = (async () => {
			for (const key of order) {
				const item = byKey.get(key);
				if (!item) continue;
				if (createdMap[key] !== undefined) continue;
				const missingDep = item.blockedByKeys.find((dep) => createdMap[dep] === undefined);
				if (missingDep !== undefined) {
					pending.set(key, { status: "blocked", message: "前置未创建: " + missingDep });
					continue;
				}
				const blockedBy = item.blockedByKeys.map((dep) => createdMap[dep]).filter((value) => typeof value === "string");
				const outcome = createProjectTaskInStore(read.store, project, {
					subject: item.title,
					description: item.description,
					blockedBy: blockedBy,
					sourceProposal: { proposalId: proposalId, version: version, key: key }
				});
				if (outcome.code !== undefined) {
					pending.set(key, { status: "failed", message: outcome.msg });
					continue;
				}
				createdMap[key] = outcome.task.taskId;
				created.push({ key: key, taskId: outcome.task.taskId, revision: outcome.task.revision });
			}
			const failedList = pending.size === 0
				? undefined
				: Array.from(pending.entries()).map(([key, row]) => ({ key: key, status: row.status, message: row.message }));
			return { code: TASK_CODE.ok, msg: "success", http: 200, data: { source: "project", proposalId: proposalId, version: version, created: created, ...(failedList === undefined ? {} : { failed: failedList }), ...(sameVersion ? { retried: true } : {}) } };
		})();
		if (typeof requestId === "string" && requestId !== "" && memo instanceof Map) memo.set(requestId, execution);
		const result = await execution;
		const persisted = await writeProjectStore(ctx, read.store);
		if (!persisted) return { code: PROJECT_CODE.storeReadonly, msg: "store is read-only (corrupted, backed up)", http: 503 };
		const fresh = readProposalStore();
		const target = fresh[String(record.leadSessionId)];
		if (target && target.proposalId === proposalId && target.version === version) {
			const failedList = result.data.failed;
			target.confirmed = {
				version: version,
				created: result.data.created,
				...(failedList === undefined ? {} : { failed: failedList }),
				lockedAt: Date.now()
			};
			await writeProposalStore(ctx, fresh);
		}
		return result;
	}

	/** GET /api/tasks?projectId= → 只返回项目任务表；不得混入宿主任务板数据。 */
	function handleProjectTasksRequest(ctx, res, get, projectId) {
		const { store } = readProjectStore();
		const project = store.projects[projectId];
		if (project === undefined) {
			sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found");
			return;
		}
		const tasks = projectTasksOf(store, projectId).map((task) => projectTaskView(store, task));
		sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { source: "project", projectId: projectId, tasks: tasks });
	}

	// ── 3b5) M3：简报（项目简报 / 对话简报）──
	//
	// 项目简报：项目级共享上下文，有版本号（CAS），人（UI）或主对话（工具）可写；
	// 对话简报：每个对话自己的职责/结论/产物清单，只有自己能写（人可代写并标 user）；
	// 跨读：只有同项目 + 有关联的两个对话能互读，且只返回简报字段。

	function ensureConversationBriefs(store) {
		if (store.conversationBriefs === undefined || store.conversationBriefs === null || typeof store.conversationBriefs !== "object" || Array.isArray(store.conversationBriefs)) {
			store.conversationBriefs = {};
		}
		return store.conversationBriefs;
	}

	function projectBriefOrDefault(project) {
		if (project.brief === undefined || project.brief === null || typeof project.brief !== "object") {
			project.brief = { version: 1, goal: "", decisions: [], constraints: [], updatedAt: Date.now(), updatedBy: "user" };
		}
		return project.brief;
	}

	function conversationBriefView(brief, sessionId) {
		if (brief === undefined) return { sessionId: sessionId, version: 0, duty: "", conclusions: [], artifacts: [], updatedBy: undefined };
		return {
			sessionId: brief.sessionId,
			projectId: brief.projectId,
			version: brief.version,
			duty: brief.duty,
			conclusions: brief.conclusions,
			artifacts: brief.artifacts,
			updatedAt: brief.updatedAt,
			updatedBy: brief.updatedBy,
			...(brief.proxy === undefined ? {} : { proxy: brief.proxy })
		};
	}

	/** 项目简报写：CAS（expectedVersion 必须等于当前 version）。 */
	function writeProjectBrief(project, payload, updatedBy) {
		const brief = projectBriefOrDefault(project);
		const expectedVersion = payload.expectedVersion;
		if (typeof expectedVersion === "number" && expectedVersion !== brief.version) {
			return { code: TASK_CODE.revisionConflict, msg: "brief version conflict", data: { latestVersion: brief.version } };
		}
		if (typeof payload.goal === "string") brief.goal = payload.goal;
		if (Array.isArray(payload.decisions)) brief.decisions = payload.decisions.map((item) => String(item));
		if (Array.isArray(payload.constraints)) brief.constraints = payload.constraints.map((item) => String(item));
		brief.version = (typeof brief.version === "number" ? brief.version : 1) + 1;
		brief.updatedAt = Date.now();
		brief.updatedBy = updatedBy;
		return { code: TASK_CODE.ok, msg: "success", data: { brief: brief } };
	}

	/** 对话简报写：只有本人（或人代写）；不带 CAS 由调用方决定。 */
	function writeConversationBrief(store, sessionId, projectId, payload, updatedBy, proxy) {
		const briefs = ensureConversationBriefs(store);
		const current = briefs[sessionId] || { sessionId: sessionId, projectId: projectId, version: 0, duty: "", conclusions: [], artifacts: [], updatedAt: 0 };
		if (typeof payload.expectedVersion === "number" && payload.expectedVersion !== current.version) {
			return { code: TASK_CODE.revisionConflict, msg: "brief version conflict", data: { latestVersion: current.version } };
		}
		if (typeof payload.duty === "string") current.duty = payload.duty;
		if (Array.isArray(payload.conclusions)) current.conclusions = payload.conclusions.map((item) => String(item));
		if (Array.isArray(payload.artifacts)) current.artifacts = payload.artifacts.map((item) => String(item));
		current.projectId = projectId === undefined ? current.projectId : projectId;
		current.version = (typeof current.version === "number" ? current.version : 0) + 1;
		current.updatedAt = Date.now();
		current.updatedBy = updatedBy;
		if (proxy === true) current.proxy = true;
		briefs[sessionId] = current;
		return { code: TASK_CODE.ok, msg: "success", data: { brief: conversationBriefView(current, sessionId) } };
	}

	/** 跨读权限：同项目 + 有关联线（或同一会话）。返回 { ok } 或 { code, msg }。 */
	function crossReadPermission(store, readerSessionId, targetSessionId) {
		if (readerSessionId === targetSessionId) return { ok: true };
		const project = projectOfSession(store, targetSessionId);
		if (project === undefined) return { code: PROJECT_CODE.notFound, msg: "session is not in any project" };
		if (!projectIsMember(project, readerSessionId)) return { code: PROJECT_TASK_EXTRA.notMember, msg: "reader is not in the same project" };
		const links = Array.isArray(project.links) ? project.links : [];
		const linked = links.some((link) => link && ((link.a === readerSessionId && link.b === targetSessionId) || (link.a === targetSessionId && link.b === readerSessionId)));
		if (!linked) return { code: PROJECT_TASK_EXTRA.notLinked, msg: "no link between the two sessions" };
		return { ok: true };
	}

	async function handleProjectBriefRoute(ctx, req, res, control, projectId) {
		const method = requestMethod(req);
		const read = readProjectStore();
		const project = read.store.projects[projectId];
		if (project === undefined) { sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found"); return; }
		if (method === "GET" || method === "HEAD") {
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { brief: projectBriefOrDefault(project) });
			return;
		}
		if (method !== "PUT") { res.setHeader("allow", "GET, HEAD, PUT"); sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed"); return; }
		if (!projectWriteGuard(res, req, control)) return;
		if (read.readonly) { sendEnvelope(res, 503, PROJECT_CODE.storeReadonly, "store is read-only (corrupted, backed up)"); return; }
		let payload;
		try { payload = JSON.parse(await readRequestBody(req)); } catch (error) { sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body"); return; }
		const result = writeProjectBrief(project, payload || {}, "user");
		if (result.code === TASK_CODE.ok) {
			project.updatedAt = Date.now();
			const persisted = await writeProjectStore(ctx, read.store);
			if (!persisted) { sendEnvelope(res, 503, PROJECT_CODE.storeReadonly, "store is read-only (corrupted, backed up)"); return; }
		}
		sendEnvelope(res, 200, result.code, result.msg, result.data);
	}

	/** 对话简报路由：GET 直读；PUT 在锁外解析 body，锁内「读最新 → 改 → 原子写」。 */
	async function handleBriefRoutes(ctx, req, res, control, sessionId, previewReader) {
		const method = requestMethod(req);
		if (previewReader !== undefined) {
			// previewAs 只做展示（UI 以某对话视角预览），不承担鉴权；真正的跨读权限只在工具侧校验。
			if (method !== "GET" && method !== "HEAD") { sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed"); return; }
			const read = readProjectStore();
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { brief: conversationBriefView(ensureConversationBriefs(read.store)[sessionId], sessionId), previewAs: previewReader });
			return;
		}
		if (method === "GET" || method === "HEAD") {
			const read = readProjectStore();
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { brief: conversationBriefView(ensureConversationBriefs(read.store)[sessionId], sessionId) });
			return;
		}
		if (method !== "PUT") { res.setHeader("allow", "GET, HEAD, PUT"); sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed"); return; }
		if (!projectWriteGuard(res, req, control)) return;
		const payload = await readJsonBody(req);
		if (payload === undefined || payload === null || typeof payload !== "object") { sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body"); return; }
		try {
			const brief = await mutateProject(function (store) {
				const project = projectOfSession(store, sessionId);
				const result = writeConversationBrief(store, sessionId, project === undefined ? undefined : project.projectId, payload, "user", true);
				if (result.code !== TASK_CODE.ok) throw routeFailure(result.code, result.msg, result.data);
				return result.data.brief;
			});
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { brief: brief });
		} catch (error) {
			sendStoreError(ctx, res, error);
		}
	}
	function registerBriefTools(ctx, get) {
		const tools = get("tools");
		if (!tools || typeof tools.register !== "function") return;
		const disposers = [];
		function registerOne(tool) {
			let raw;
			try { raw = tools.register(tool); } catch (error) { warn(ctx, "brief tool", error); return; }
			if (typeof raw === "function") disposers.push(raw);
		}
		registerOne({
			name: "whales_brief_read",
			description: "读取项目简报或某个对话的简报。身份取当前会话，不接受参数自报；跨对话读取要求同项目且有关联线。",
			parameters: {
				type: "object",
				properties: {
					projectId: { type: "string", description: "读项目简报时给项目 id。" },
					sessionId: { type: "string", description: "读某个对话的简报时给会话 id（可选，默认读自己）。" }
				},
				additionalProperties: false
			},
			output: { schema: { type: "object", additionalProperties: true }, render: (value) => "简报 v" + String(value.brief && value.brief.version) },
			async execute(args, exec) {
				const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
				if (callerId === "") throw new Error("[40301] cannot determine the calling session");
				const read = readProjectStore();
				const projectId = typeof args?.projectId === "string" ? args.projectId.trim() : "";
				if (projectId !== "") {
					const project = read.store.projects[projectId];
					if (project === undefined) throw new Error("[40401] project not found");
					if (!projectIsMember(project, callerId)) throw new Error("[40703] caller is not a project member");
					return { target: "project", projectId: projectId, brief: projectBriefOrDefault(project) };
				}
				const targetSessionId = typeof args?.sessionId === "string" && args.sessionId.trim() !== "" ? args.sessionId.trim() : callerId;
				const permission = crossReadPermission(read.store, callerId, targetSessionId);
				if (permission.ok !== true) throw new Error("[" + permission.code + "] " + permission.msg);
				return { target: "conversation", sessionId: targetSessionId, brief: conversationBriefView(ensureConversationBriefs(read.store)[targetSessionId], targetSessionId) };
			}
		});
		registerOne({
			name: "whales_brief_write",
			description: "写简报：项目简报只能由项目主对话写；对话简报只能写自己的。身份取当前会话，不接受参数自报。",
			parameters: {
				type: "object",
				properties: {
					projectId: { type: "string", description: "写项目简报时给项目 id。" },
					expectedVersion: { type: "number", description: "版本号 CAS（可选）。" },
					goal: { type: "string" },
					decisions: { type: "array", items: { type: "string" } },
					constraints: { type: "array", items: { type: "string" } },
					duty: { type: "string", description: "写自己的对话简报时：职责。" },
					conclusions: { type: "array", items: { type: "string" } },
					artifacts: { type: "array", items: { type: "string" } }
				},
				additionalProperties: false
			},
			output: { schema: { type: "object", additionalProperties: true }, render: (value) => "已写入简报 v" + String(value.brief && value.brief.version) },
			async execute(args, exec) {
				const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
				if (callerId === "") throw new Error("[40301] cannot determine the calling session");
				const read = readProjectStore();
				const projectId = typeof args?.projectId === "string" ? args.projectId.trim() : "";
				if (projectId !== "") {
					const project = read.store.projects[projectId];
					if (project === undefined) throw new Error("[40401] project not found");
					if (project.mainSessionId !== callerId) throw new Error("[40706] only the project main session may write the project brief");
					const result = writeProjectBrief(project, args || {}, callerId);
					if (result.code !== TASK_CODE.ok) throw new Error("[" + result.code + "] " + result.msg);
					project.updatedAt = Date.now();
					if (!(await writeProjectStore(ctx, read.store))) throw new Error("[50302] store is read-only");
					return { target: "project", projectId: projectId, brief: result.data.brief };
				}
				const project = projectOfSession(read.store, callerId);
				const result = writeConversationBrief(read.store, callerId, project === undefined ? undefined : project.projectId, args || {}, callerId, false);
				if (result.code !== TASK_CODE.ok) throw new Error("[" + result.code + "] " + result.msg);
				if (!(await writeProjectStore(ctx, read.store))) throw new Error("[50302] store is read-only");
				return { target: "conversation", sessionId: callerId, brief: result.data.brief };
			}
		});
		ctx.effect(() => () => { for (const dispose of disposers) { try { dispose(); } catch (error) { /* ignore */ } } }, "agent-whales: brief tools");
	}

// ── 3c) 任务板命令路由（E4：最小真实闭环）────────────────────────────────
//
// 形态（与 api-design-spec 对齐）：
//   GET  /agent-whales/api/tasks?leadSessionId=...        只读：任务 + 成员全量快照
//   POST /agent-whales/api/tasks/:taskId/commands         有限类型化命令
//
// 信封：{ code, msg, data }；HTTP 只表达传输层。
//   - 成功：HTTP 200，code=200，data.task / data.dispatch
//   - 业务失败：HTTP 200 + 非 200 业务码（冲突 409xx、找不到 404xx、参数 400xx）
//   - 鉴权失败：HTTP 403 + code=40301（token / caller 不满足）
//   - 结构错误：HTTP 400 + code=40000（JSON/字段形状）
//
// 命令（首批只开放这五个，按钮映射见 README/PRD）：
//   assign              owner 必填；写任务板（认领/改派）
//   assign-and-dispatch assign 成功后派发一次
//   dispatch            不改任务板，只按当前 owner 派发（单独派发不得再 reassign 一次）
//   unassign            写任务板：reassign 省略 owner（回到未认领）
//   reopen              写任务板：reopen（只用于重开已完成任务）
//
// 幂等：requestId + payload 指纹。
//   - 已完成：回放结果（replayed:true），绝不重复写/重派；
//   - 进行中（并发同 ID）：共享同一个 Promise，只执行一次；
//   - 这是**进程内去重**，不是跨重启恢复；重启后只能靠 CAS 冲突表达「可能已生效」。
//
// 派发语义：dispatch.status ∈ not-requested | sent | failed | unknown。
//   sent 只表示「投进了 inbox」，不表示任务在执行；unknown 表示超时且结果未知。

const TASKS_ENDPOINT = `${ACTIVITY_PATH}/tasks`;
const TASK_COMMANDS_PREFIX = `${ACTIVITY_PATH}/tasks/`;
const TASK_COMMANDS_SUFFIX = "/commands";
const TASK_ACTION_LIST = ["assign", "assign-and-dispatch", "dispatch", "unassign", "reopen"];
/** requestId 幂等窗口（进程内）。 */
const TASK_COMMAND_MEMO_LIMIT = 200;
/** 派发单条消息超时；超时 = 结果未知，不自动重试。 */
const TASK_DISPATCH_TIMEOUT_MS = 15_000;

/** 稳定业务码（新路由专用；不改既有老路由）。 */
const TASK_CODE = {
	ok: 200,
	param: 40000,
	forbidden: 40301,
	notFound: 40401,
	blocked: 40901,
	revisionConflict: 40902,
	requestReused: 40903,
	taskClosed: 40904,
	noOwner: 40905,
	taskDeleted: 40906,
	unavailable: 50301,
	internal: 50000
};

function sendEnvelope(res, httpStatus, code, msg, data) {
	const payload = { code: code, msg: msg };
	if (data !== undefined) payload.data = data;
	let body;
	try {
		body = JSON.stringify(payload);
	} catch (error) {
		body = '{"code":50000,"msg":"encode failed"}';
		httpStatus = 500;
	}
	res.statusCode = httpStatus;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.setHeader("content-length", Buffer.byteLength(body));
	res.end(body);
}

/** 极简 query 取值（不引入 URL 依赖，也不信任绝对 URL）。 */
function queryParam(rawUrl, name) {
	const raw = typeof rawUrl === "string" ? rawUrl : "";
	const q = raw.indexOf("?");
	if (q < 0) return undefined;
	const parts = raw.slice(q + 1).split("&");
	for (const part of parts) {
		const eq = part.indexOf("=");
		const key = eq < 0 ? part : part.slice(0, eq);
		if (key !== name) continue;
		const value = eq < 0 ? "" : part.slice(eq + 1);
		try {
			return decodeURIComponent(value);
		} catch (error) {
			return value;
		}
	}
	return undefined;
}

/** 解析 /agent-whales/api/tasks/<taskId>/commands → taskId。 */
function taskCommandOf(pathname) {
	if (typeof pathname !== "string") return undefined;
	if (!pathname.startsWith(TASK_COMMANDS_PREFIX)) return undefined;
	if (!pathname.endsWith(TASK_COMMANDS_SUFFIX)) return undefined;
	const middle = pathname.slice(TASK_COMMANDS_PREFIX.length, pathname.length - TASK_COMMANDS_SUFFIX.length);
	if (middle === "" || middle.indexOf("/") >= 0) return undefined;
	try {
		return decodeURIComponent(middle);
	} catch (error) {
		return middle;
	}
}

/**
 * 取「本次命令的授权上下文」：caller 必须是该团队的**存活 Lead**。
 * 不信浏览器传参本身，一律回查 agents + agentTeams。
 */
function teamCaller(get, leadSessionId) {
	if (typeof leadSessionId !== "string" || leadSessionId.trim() === "") return { code: TASK_CODE.param, msg: "leadSessionId is required" };
	const agents = typeof get === "function" ? get("agents") : undefined;
	const teams = typeof get === "function" ? get("agentTeams") : undefined;
	// 只读路径（提案/任务快照）不该因为"没有写能力"而不可用；写能力由各自的路由单独校验。
	if (!agents || typeof agents.get !== "function" || !teams || typeof teams.tryMembership !== "function") {
		return { code: TASK_CODE.unavailable, msg: "team service unavailable" };
	}
	let lead;
	try {
		lead = agents.get(leadSessionId.trim());
	} catch (error) {
		lead = undefined;
	}
	if (!lead) return { code: TASK_CODE.forbidden, msg: "lead session is not live" };
	let membership;
	try {
		membership = typeof teams.tryMembership === "function" ? teams.tryMembership(lead) : undefined;
	} catch (error) {
		membership = undefined;
	}
	if (!membership) return { code: TASK_CODE.forbidden, msg: "caller is not in a team" };
	if (membership.role !== "lead") return { code: TASK_CODE.forbidden, msg: "caller is not the team lead" };
	return { lead: lead, teams: teams, membership: membership };
}

/** GET /agent-whales/api/tasks：任务 + 成员全量快照（不重建任何派发历史）。 */
function handleTasksRequest(ctx, req, res, get) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const projectId = queryParam(req.url, "projectId");
	const leadSessionId = queryParam(req.url, "leadSessionId");
	const hasProject = typeof projectId === "string" && projectId.trim() !== "";
	const hasLead = typeof leadSessionId === "string" && leadSessionId.trim() !== "";
	if (hasProject === hasLead) {
		sendEnvelope(res, 400, TASK_CODE.param, "exactly one of projectId or leadSessionId is required");
		return;
	}
	if (hasProject) {
		handleProjectTasksRequest(ctx, res, get, projectId.trim());
		return;
	}
	const caller = teamCaller(get, leadSessionId);
	if (caller.code !== undefined && caller.code !== TASK_CODE.ok) {
		const http = caller.code === TASK_CODE.forbidden ? 403 : 200;
		sendEnvelope(res, http, caller.code, caller.msg);
		return;
	}
	try {
		const tasks = caller.teams.listTasks(caller.lead);
		const members = typeof caller.teams.listMembers === "function" ? caller.teams.listMembers(caller.lead) : [];
		sendEnvelope(res, 200, TASK_CODE.ok, "success", { source: "host", tasks: tasks, members: members });
	} catch (error) {
		warn(ctx, "tasks snapshot", error);
		sendEnvelope(res, 500, TASK_CODE.internal, "snapshot failed");
	}
}

/** 宿主异常 → 稳定业务码（不外泄内部 message）。 */
function taskErrorOf(error) {
	const message = error && typeof error.message === "string" ? error.message : "";
	if (/blocked/i.test(message)) return { code: TASK_CODE.blocked, msg: "task is blocked by unfinished dependencies" };
	if (/revision|conflict|stale/i.test(message)) return { code: TASK_CODE.revisionConflict, msg: "task revision conflict" };
	if (/not.?found|unknown task|no such task/i.test(message)) return { code: TASK_CODE.notFound, msg: "task not found" };
	if (/deleted/i.test(message)) return { code: TASK_CODE.taskDeleted, msg: "task is deleted" };
	if (/completed/i.test(message)) return { code: TASK_CODE.taskClosed, msg: "task is already completed" };
	return { code: TASK_CODE.internal, msg: "task command failed" };
}

/**
 * 派发：把「开始这个任务」投递到 owner 的 inbox。
 * 只回 sent / failed / unknown；sent 只代表进了 inbox。
 */
async function dispatchTaskTo(caller, task, owner, timeoutMs) {
	const teams = caller.teams;
	if (typeof teams.sendMessage !== "function") return { status: "failed", reason: "send-unavailable" };
	const effectiveTimeoutMs = typeof timeoutMs === "number" && timeoutMs >= 10 ? Math.min(timeoutMs, TASK_DISPATCH_TIMEOUT_MS) : TASK_DISPATCH_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => {
		try {
			controller.abort();
		} catch (error) {
			/* ignore */
		}
	}, effectiveTimeoutMs);
	if (timer && typeof timer.unref === "function") timer.unref();
	try {
		const content = [{ type: "text", text: "开始任务：" + String(task.subject || task.id) }];
		// 与超时 race：底层即使不理会 abortSignal，也不能把整条路由拖挂。
		// 超时后底层晚到成功也不能回写结果——那正是「结果未知」，由调用方决定如何处理。
		let expired = false;
		const timeoutMarker = new Promise((resolve) => {
			const t = setTimeout(() => {
				expired = true;
				resolve({ timedOut: true });
			}, effectiveTimeoutMs);
			if (t && typeof t.unref === "function") t.unref();
		});
		const sent = await Promise.race([
			teams.sendMessage(caller.lead, { target: owner, content: content, signal: controller.signal }),
			timeoutMarker
		]);
		if (expired || (sent && sent.timedOut === true)) return { status: "unknown", reason: "dispatch-timeout" };
		const messageId = sent && typeof sent.messageId === "string" ? sent.messageId : undefined;
		return messageId === undefined ? { status: "sent" } : { status: "sent", messageId: messageId };
	} catch (error) {
		if (controller.signal.aborted) return { status: "unknown", reason: "dispatch-timeout" };
		return { status: "failed", reason: "dispatch-rejected" };
	} finally {
		try {
			clearTimeout(timer);
		} catch (error) {
			/* ignore */
		}
	}
}

/** 执行一条命令（已通过参数/鉴权校验）。返回 { code, msg, data? }。 */
async function runTaskCommand(ctx, command) {
	const { caller, taskId, action, owner, expectedRevision, dispatchTimeoutMs } = command;
	let before;
	try {
		before = caller.teams.getTask(caller.lead, taskId);
	} catch (error) {
		return { code: TASK_CODE.notFound, msg: "task not found" };
	}
	if (before.status === "deleted") return { code: TASK_CODE.taskDeleted, msg: "task is deleted" };

	// dispatch：不写任务板，只按现有 owner 派发。
	if (action === "dispatch") {
		const currentOwner = typeof before.ownerName === "string" ? before.ownerName : "";
		if (currentOwner === "") return { code: TASK_CODE.noOwner, msg: "task has no owner to dispatch to" };
		const dispatch = await dispatchTaskTo(caller, before, currentOwner, dispatchTimeoutMs);
		return { code: TASK_CODE.ok, msg: "success", data: { before: before, task: before, dispatch: dispatch } };
	}

	// 其余四个都写任务板。reopen 走 reopen；unassign 走 reassign 省略 owner。
	let request;
	if (action === "unassign") request = { taskId: taskId, expectedRevision: expectedRevision, action: "reassign" };
	else if (action === "reopen") request = { taskId: taskId, expectedRevision: expectedRevision, action: "reopen" };
	else request = { taskId: taskId, expectedRevision: expectedRevision, action: "reassign", owner: owner };

	let task;
	try {
		task = await caller.teams.updateTask(caller.lead, request);
	} catch (error) {
		warn(ctx, "task write", error);
		const mapped = taskErrorOf(error);
		const data = mapped.code === TASK_CODE.revisionConflict
			? { before: before, maybeApplied: true }
			: { before: before };
		return { code: mapped.code, msg: mapped.msg, data: data };
	}

	let dispatch = { status: "not-requested" };
	if (action === "assign-and-dispatch") dispatch = await dispatchTaskTo(caller, task, owner, dispatchTimeoutMs);
	return { code: TASK_CODE.ok, msg: "success", data: { before: before, task: task, dispatch: dispatch } };
}

/**
 * POST /agent-whales/api/tasks/:taskId/commands
 * body: { leadSessionId, requestId, action, owner?, expectedRevision? }
 *   - assign            owner、expectedRevision 必填
 *   - assign-and-dispatch 同上
 *   - dispatch          不需要 expectedRevision（不写任务板）
 *   - unassign          expectedRevision 必填
 *   - reopen            expectedRevision 必填
 */
function handleTaskCommandRequest(ctx, req, res, get, control, taskId) {
	const method = requestMethod(req);
	if (method === "OPTIONS") {
		res.setHeader("allow", "POST, OPTIONS");
		sendEmpty(res, 204);
		return Promise.resolve();
	}
	if (method !== "POST") {
		res.setHeader("allow", "POST, OPTIONS");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return Promise.resolve();
	}
	const header = req && req.headers ? req.headers["x-whales-token"] : undefined;
	const token = Array.isArray(header) ? header[0] : header;
	if (typeof token !== "string" || !control || typeof control.controlToken !== "string" || token !== control.controlToken) {
		sendEnvelope(res, 403, TASK_CODE.forbidden, "same-origin token required");
		return Promise.resolve();
	}

	return (async () => {
		try {
			const raw = await readRequestBody(req);
			let payload;
			try {
				payload = JSON.parse(raw);
			} catch (error) {
				sendEnvelope(res, 400, TASK_CODE.param, "invalid json body");
				return;
			}
			if (!payload || typeof payload !== "object") {
				sendEnvelope(res, 400, TASK_CODE.param, "invalid body");
				return;
			}
			const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
			if (projectId !== "") {
				let applied;
				try {
					applied = await withStoreLock(function () {
						const projectRead = readProjectStore();
						if (projectRead.readonly) throw new StoreReadonlyError(projectsStoreFile(), projectRead.backupPath);
						const project = projectRead.store.projects[projectId];
						if (project === undefined) return { code: PROJECT_CODE.notFound, msg: "project not found" };
						const projectTask = projectTaskOf(projectRead.store, projectId, taskId);
						if (projectTask === undefined) return { code: TASK_CODE.notFound, msg: "task not found" };
						if (projectTask.status === "deleted") return { code: TASK_CODE.taskDeleted, msg: "task is deleted" };
						const result = applyProjectTaskCommand(projectRead.store, project, projectTask, payload);
						if (result.code !== TASK_CODE.ok) return result;
						return writeStoreFile(projectsStoreFile(), projectRead.store).then(function () {
							return Object.assign({}, result, { revision: projectTask.revision, callerSessionId: project.mainSessionId });
						});
					});
				} catch (error) {
					if (error && error.code === "STORE_READONLY") { sendEnvelope(res, 503, PROJECT_CODE.storeReadonly, "store is read-only (corrupted, backed up)"); return; }
					throw error;
				}
				if (applied.code !== TASK_CODE.ok) {
					sendEnvelope(res, 200, applied.code, applied.msg, applied.data);
					return;
				}
				// 锁外派发（可能 15s 超时，绝不占全局写锁）；结果用短锁记录。
				let dispatch;
				if (applied.needsDispatch === true) {
					dispatch = await dispatchProjectTask(get, applied.snapshot, payload.dispatchTimeoutMs, applied.callerSessionId);
					await withStoreLock(function () {
						const read = readProjectStore();
						if (read.readonly) return undefined;
						const tasks = read.store.tasks === undefined || read.store.tasks === null ? undefined : read.store.tasks;
						const task = tasks === undefined ? undefined : tasks[applied.snapshot.taskId];
						read.store.dispatchFacts = Array.isArray(read.store.dispatchFacts) ? read.store.dispatchFacts : [];
						if (read.store.dispatchFacts.length > 200) read.store.dispatchFacts.shift();
						if (task !== undefined && task.revision === applied.revision) task.dispatch = dispatch;
						else read.store.dispatchFacts.push({ taskId: applied.snapshot.taskId, revision: applied.revision, dispatch: dispatch, at: Date.now(), currentRevision: task === undefined ? undefined : task.revision });
						return writeStoreFile(projectsStoreFile(), read.store);
					});
				}
				sendEnvelope(res, 200, TASK_CODE.ok, "success", Object.assign({}, applied.data, dispatch === undefined ? {} : { dispatch: dispatch }));
				return;
			}
			const action = payload.action;
			if (TASK_ACTION_LIST.indexOf(action) < 0) {
				sendEnvelope(res, 400, TASK_CODE.param, "action must be one of " + TASK_ACTION_LIST.join(", "));
				return;
			}
			const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
			if (requestId === "") {
				sendEnvelope(res, 400, TASK_CODE.param, "requestId is required");
				return;
			}
			const needsOwner = action === "assign" || action === "assign-and-dispatch";
			const owner = typeof payload.owner === "string" ? payload.owner.trim() : "";
			if (needsOwner && owner === "") {
				sendEnvelope(res, 400, TASK_CODE.param, "owner is required for " + action);
				return;
			}
			const rawTimeout = payload.dispatchTimeoutMs;
			const dispatchTimeoutMs = typeof rawTimeout === "number" && isFinite(rawTimeout) ? rawTimeout : undefined;
			const needsRevision = action !== "dispatch";
			const expectedRevision = payload.expectedRevision;
			if (needsRevision && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1)) {
				sendEnvelope(res, 400, TASK_CODE.param, "expectedRevision must be a positive integer");
				return;
			}

			// 进程内去重：指纹不同 = 复用 ID，拒绝；已完成 = 回放；进行中 = 共用同一个 Promise。
			control.taskCommandMemo = control.taskCommandMemo || new Map();
			control.taskCommandInFlight = control.taskCommandInFlight || new Map();
			const fingerprint = JSON.stringify([taskId, action, owner, needsRevision ? expectedRevision : null, payload.leadSessionId]);
			const remembered = control.taskCommandMemo.get(requestId);
			if (remembered) {
				if (remembered.fingerprint !== fingerprint) {
					sendEnvelope(res, 200, TASK_CODE.requestReused, "requestId reused with a different payload");
					return;
				}
				const replayed = Object.assign({}, remembered.result, { replayed: true });
				sendEnvelope(res, 200, replayed.code, replayed.msg, Object.assign({}, replayed.data, { replayed: true }));
				return;
			}

			const inflight = control.taskCommandInFlight.get(requestId);
			if (inflight) {
				// 并发同 ID：等同一个执行，绝不重复写/重复派发。
				const shared = await inflight.catch(() => ({ code: TASK_CODE.internal, msg: "task command failed" }));
				if (shared.fingerprint !== undefined && shared.fingerprint !== fingerprint) {
					sendEnvelope(res, 200, TASK_CODE.requestReused, "requestId reused with a different payload");
					return;
				}
				const result = shared.result || shared;
				sendEnvelope(res, 200, result.code, result.msg, result.data);
				return;
			}

			// 项目提案走项目任务表：不依赖 agentTeams，也不要求 Lead 存活。
			const payloadLead = typeof payload.leadSessionId === "string" ? payload.leadSessionId.trim() : "";
			const earlyStore = readProposalStore();
			const earlyRecord = payloadLead === "" ? undefined : earlyStore[payloadLead];
			if (earlyRecord !== undefined && typeof earlyRecord.projectId === "string" && earlyRecord.projectId !== "") {
				if (earlyRecord.proposalId !== proposalId) { sendEnvelope(res, 200, TASK_CODE.notFound, "proposal not found"); return; }
				if (earlyRecord.version !== version) { sendEnvelope(res, 200, TASK_CODE.revisionConflict, "proposal version changed", { latestVersion: earlyRecord.version }); return; }
				control.proposalConfirmInFlight = control.proposalConfirmInFlight || new Map();
				const sharedProject = control.proposalConfirmInFlight.get(requestId);
				if (sharedProject) {
					const shared = await sharedProject;
					sendEnvelope(res, 200, shared.code, shared.msg, Object.assign({}, shared.data, { replayed: true }));
					return;
				}
				await withStoreLock(async function () {
					const projectResult = await confirmProjectProposal(ctx, get, earlyRecord, proposalId, version, requestId, control.proposalConfirmInFlight);
					sendEnvelope(res, projectResult.http || 200, projectResult.code, projectResult.msg, projectResult.data);
				});
				return;
			}
			const caller = teamCaller(get, payload.leadSessionId);
			if (caller.code !== undefined && caller.code !== TASK_CODE.ok) {
				const http = caller.code === TASK_CODE.forbidden ? 403 : 200;
				sendEnvelope(res, http, caller.code, caller.msg);
				return;
			}

			const execution = runTaskCommand(ctx, {
				caller: caller,
				taskId: taskId,
				action: action,
				owner: owner,
				expectedRevision: expectedRevision,
				dispatchTimeoutMs: dispatchTimeoutMs
			}).then((result) => {
				control.taskCommandMemo.set(requestId, { fingerprint: fingerprint, result: result });
				while (control.taskCommandMemo.size > TASK_COMMAND_MEMO_LIMIT) {
					const oldest = control.taskCommandMemo.keys().next();
					if (oldest.done) break;
					control.taskCommandMemo.delete(oldest.value);
				}
				return { fingerprint: fingerprint, result: result };
			}).finally(() => {
				control.taskCommandInFlight.delete(requestId);
			});
			control.taskCommandInFlight.set(requestId, execution);
			const outcome = await execution;
			sendEnvelope(res, 200, outcome.result.code, outcome.result.msg, outcome.result.data);
		} catch (error) {
			warn(ctx, "task command", error);
			sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
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
		const briefsPrefix = ACTIVITY_PATH + "/briefs/";
		if (pathname === ACTIVITY_PATH + "/briefs" || pathname.startsWith(briefsPrefix)) {
			const rest = pathname === ACTIVITY_PATH + "/briefs" ? "" : pathname.slice(briefsPrefix.length);
			const segments = rest === "" ? [] : rest.split("/").filter(function (part) { return part !== ""; });
			const decodeBrief = function (value) { try { return decodeURIComponent(value); } catch (error) { return value; } };
			const previewAs = queryParam(req.url, "previewAs");
			if (segments.length === 1) {
				const previewReader = typeof previewAs === "string" && previewAs.trim() !== "" ? previewAs.trim() : undefined;
				const pendingBriefRoute = handleBriefRoutes(ctx, req, res, control, decodeBrief(segments[0]), previewReader);
				if (pendingBriefRoute && typeof pendingBriefRoute.catch === "function") return pendingBriefRoute.catch(function (error) { warn(ctx, "brief route", error); sendEnvelope(res, 500, PROJECT_CODE.internal, "internal error"); });
				return;
			}
			// previewAs 只是「以某个对话视角展示」的 UI 参数，**不是鉴权**：HTTP 调用方是人，人本就能读所有简报。
			// 真正的跨读权限只在工具侧（exec 身份）校验。
			sendEnvelope(res, 200, PROJECT_CODE.notFound, "not found");
			return;
		}
		const projectRoute = parseProjectRoute(pathname);
		if (projectRoute !== undefined) {
			const pendingProject = handleProjectRoute(ctx, req, res, get, control, projectRoute);
			if (pendingProject && typeof pendingProject.catch === "function") {
				return pendingProject.catch((error) => {
					warn(ctx, "project route", error);
					sendEnvelope(res, 500, PROJECT_CODE.internal, "internal error");
				});
			}
			return pendingProject;
		}
		if (pathname === PROPOSALS_ENDPOINT) {
			handleProposalsRequest(ctx, req, res, get);
			return undefined;
		}
		const confirmProposalId = proposalConfirmOf(pathname);
		if (confirmProposalId !== undefined) {
			const pendingConfirm = handleProposalConfirmRequest(ctx, req, res, get, control, confirmProposalId);
			if (pendingConfirm && typeof pendingConfirm.catch === "function") {
				return pendingConfirm.catch((error) => {
					warn(ctx, "proposal confirm", error);
					sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
				});
			}
			return pendingConfirm;
		}
		if (pathname === TASKS_ENDPOINT) {
			handleTasksRequest(ctx, req, res, get);
			return undefined;
		}
		const commandTaskId = taskCommandOf(pathname);
		if (commandTaskId !== undefined) {
			const pendingCommand = handleTaskCommandRequest(ctx, req, res, get, control, commandTaskId);
			if (pendingCommand && typeof pendingCommand.catch === "function") {
				return pendingCommand.catch((error) => {
					warn(ctx, "task command", error);
					sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
				});
			}
			return pendingCommand;
		}
		if (pathname === SEND_ENDPOINT) {
			const pending = handleSendRequest(ctx, req, res, get, control);
			if (pending && typeof pending.catch === "function") {
				return pending.catch((error) => {
					warn(ctx, "graph send", error);
					sendText(res, 500, "internal error");
				});
			}
			return pending;
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
 * 串门投递方式：**默认「插话」**（steer）。
 *
 * 2026-10-31 用户决定：智能体之间互相说话应该是插话、不是排队——排队要等对方把整轮跑完，
 * 协作就退化成串行。想恢复排队可在 patch 里写 `config: { visitMode: "queue" }`
 * （也兼容 `config: { visitSteer: false }`）。
 */
function initialVisitMode(config) {
	if (config && typeof config === "object") {
		if (config.visitMode === "queue") return "queue";
		if (config.visitSteer === false) return "queue";
	}
	return "steer";
}

/**
 * 创建四个串门工具，并返回可在运行时整体开关的控制器。
 * 任何一步失败都只跳过该工具，不影响本行装配浏览器半边。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {(name: string) => unknown} get
 * @param {boolean} initiallyEnabled
 * @param {"steer"|"queue"} [defaultMode] 省略时的投递方式：默认插话（steer）
 * @returns {{ isEnabled: () => boolean, setEnabled: (next: boolean) => boolean }}
 */
function createVisitTools(ctx, get, initiallyEnabled, defaultMode) {
	const tools = get("tools");
	// 只认契约里的两个值；配置脏了就退回「插话」。
	const fallbackMode = defaultMode === "queue" ? "queue" : "steer";

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
			"默认 **插话**（mode=steer）：它在跑的那一轮会在下一个步边界被注入你这句话，不用等整轮结束；" +
			"要排队等它跑完再处理就显式传 mode=queue。目标必须是活着的会话（离线会话先用 whales_visit_resume 拉起来）。" +
			"waitForReply=true 会阻塞到它产出下一条文本回复（默认不阻塞，只回执）。",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "目标会话 id（用 whales_visit_list 查）。" },
				message: { type: "string", description: "要说的话。" },
				mode: {
					type: "string",
					enum: ["steer", "queue"],
					description: "默认 steer（插话：在它下一个步边界注入，不打断正在进行的单步）；queue 排队等它整轮跑完。"
				},
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
			const lines = [`已送到 ${value.sessionId}（${value.mode === "steer" ? "插话" : "排队"}）`];
			if (value.reply) lines.push(`回话：${value.reply.text ?? "（无文本）"}`);
			if (value.timedOut) lines.push(`[等到 ${value.waitedMs}ms 没等到新回复]`);
			return lines.join("\n");
		},
		async execute(args, exec) {
			const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
			const text = typeof args?.message === "string" ? args.message.trim() : "";
			if (sessionId === "") throw new Error("sessionId 不能为空");
			if (text === "") throw new Error("message 不能为空");
			// M4：发送方身份只取执行上下文；任一方在项目里就必须同项目 + 有关联线。
			const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
			if (callerId !== "") {
				const access = checkCrossSessionAccess(get, callerId, sessionId);
				if (access.ok !== true) throw new Error("[" + access.code + "] " + access.msg);
			}
			const agent = liveAgent(get, sessionId);
			if (!agent) throw new Error(`会话 ${sessionId} 现在不活着（离线会话需要先在 UI 里打开）`);
			// 省略 mode → 用配置的默认投递方式（默认插话）。
			const mode = args.mode === "queue" ? "queue" : args.mode === "steer" ? "steer" : fallbackMode;
			const baseline = maxSeq(sessionEvents(agent.session));
			// followup/steer 是同步 void（dsh-agent runtime-types.d.ts:192/200），但调用本身可能
			// 同步抛（inbox 已 dispose 等），转成工具错误，别让它变成未捕获异常。
			// 带真实来源的中继消息（不再写成裸的 kind:user），并登记发送事实。
			const relay = relayMessage(callerId, text);
			try {
				if (mode === "steer") agent.steer(relay);
				else agent.followup(relay);
			} catch (error) {
				throw new Error(`会话 ${sessionId} 送信失败：${errorMessage(error)}`);
			}
			if (callerId !== "") {
				try { await recordSend(callerId, sessionId, "visit", relay.id); } catch (error) { /* 登记失败不影响发送事实 */ }
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
		async execute(args, exec) {
			const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
			if (sessionId === "") throw new Error("sessionId 不能为空");
			// M4：读取与发送同权——任一方在项目里就必须同项目 + 有关联线。
			const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
			if (callerId !== "") {
				const access = checkCrossSessionAccess(get, callerId, sessionId);
				if (access.ok !== true) throw new Error("[" + access.code + "] " + access.msg);
			}
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
export { validateProposal, topologicalOrder, proposalView, createProjectTaskInStore, projectTaskView, projectBlockedByWouldCycle, ensureProjectTasks };

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
			control.visitTools = createVisitTools(scope, get, initialVisitToolsEnabled(config), initialVisitMode(config));

	// W2：提案工具（Lead 提交结构化提案；与串门开关解耦，始终可用）。
	registerProposalTool(scope, get);
	// M3：简报工具（项目简报只读/主对话写；对话简报只能写自己）。
	registerBriefTools(scope, get);
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