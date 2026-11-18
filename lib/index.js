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
 * 6) ultra 模式（2026-11-16）：`POST /agent-whales/api/ultra`（第二个写操作，带 controlToken）
 *    强制加载随包的 deep-effort 执行契约：打开时把 skills/deep-effort/SKILL.md 正文注册成一段
 *    系统提示，每一轮都在上下文里；关掉时交空段。状态落盘 ultra.json，重启后仍保持。
 *
 * 这些能力都刻意不用硬依赖（不写 inject）：这一行同时还负责让 dsh-client-modules
 * 扫到 `dsh.client` 去装配浏览器半边，等不到服务会连鲸鱼娘一起消失，所以一律
 * 可选读取 + 失败兜底。`apply()` 自身绝不向外抛异常。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROTOTYPE_VOCAB } from './prototype-vocab.js';

// 数据根解析（2026-11-16）：与宿主 `@deepseek-ai/dsh-home-paths` 的 DSH_HOME 口径对齐。
// 融合自 fengshenx/dsh-leader-agent 的 `src/host/home-paths.js`（MIT）——照抄语义，不 import
// 宿主包（`engines.dsh` 只承诺版本范围，内部包会随版本漂移）。
// 为什么必须对齐：本插件的数据（projects/canvas/handoffs/events/proposals）与 worker preset
// 都写在 dsh home 下。两边算出的根不一致时，症状是数据写到别处、或读不到已有数据——
// 典型场景是开发实例把 DSH_HOME 指到工作树内的 `.dev/home`，而插件仍写用户真实的 ~/.dsh。
// 规则逐条照抄宿主（rc.2 与 rc.5 逐字相同）：
//   · 空或纯空白的 DSH_HOME 按未设处理；
//   · 单独的 `~` 与 `~/`、`~\` 前缀按家目录展开（`~user/x` 不展开，宿主也是这个结果）；
//   · 其余值一律 `resolve`——相对路径按进程 cwd、去尾分隔符、归一化 `.` 与 `..`；
//   · 宿主只用 trim 判空、取值仍用原值：带首尾空白时它算的是另一条路径，照抄才不分叉。
const DSH_HOME_DIR_NAME = ".dsh";

/**
 * 按宿主 `expandHomePath` 语义展开 `~` 前缀并解析成绝对路径。
 * @param {string} input 原始路径
 * @param {string} homeDir 用户主目录
 * @param {string} [cwd] 相对路径的基准，默认 `process.cwd()`
 * @returns {string} 绝对路径
 */
function expandHomePath(input, homeDir, cwd = process.cwd()) {
	const raw = String(input ?? "");
	const expanded = raw === "~"
		? homeDir
		: (raw.startsWith("~/") || raw.startsWith("~\\")) ? join(homeDir, raw.slice(2)) : raw;
	return resolve(cwd, expanded);
}

/**
 * 解析 dsh home：`DSH_HOME` 有值（去空白后非空）时按宿主口径展开，否则回落
 * `<homedir>/.dsh`。
 * @param {Record<string, string | undefined>} [env] 环境变量映射（只读 `DSH_HOME`）
 * @param {() => string} [resolveHome] 家目录解析器，默认 `os.homedir()`（测试可注入）
 * @returns {string} dsh home 绝对路径
 */
function resolveDshHome(env = process.env, resolveHome = homedir) {
	const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME : "";
	if (configured.trim() === "") return resolve(join(resolveHome(), DSH_HOME_DIR_NAME));
	return expandHomePath(configured, resolveHome());
}

const TEAM_POLICY = [
	"## 团队协作（默认开启）",
	"",
	"每个新会话默认以一个小团队推进，而不是你自己单干：",
	"",
	"1. 收到第一条消息后先判断任务形态。除了纯寒暄、单一事实问答、或一次只读操作之外，**默认先起团队**；拿不准时优先起团队，不要先单干再补救。",
	"2. 用 `subagent` 创建 1–3 个成员（需要继承当前对话历史时用 `subagent_fork`），每个职责单一、写入范围互不重叠；同一文件不要交给两个人改。`description` 写清边界，记下返回的 agent id。",
	"3. 用 `team_task_create` 把要并行的事拆成任务，写清验收标准与写入范围；有先后关系的用 `blocked_by` 串起来；任务 owner 填成员的 Session id。",
	"4. 用 `send_message({ agent_id, message })` 给成员补充上下文或纠偏，用 `list_agents` 看整棵成员树，用 `wait_agent` 等成员的下一条消息（任务状态变化不会唤醒它，等完再读任务）。",
	"5. 你自己只做整合、评审与最终答复，不要把手上的并行活儿重新串行做一遍。",
	"6. 确实无法拆分时（就一个问题、一次读取、一次确认）可以不建团队，但要在回复里说明为什么没建。",
	"",
	"## 提交流程（仅当你准备把目标拆给多个成员分工时）",
	"",
	"先用 `whales_propose_tasks` 提交结构化提案，等用户确认后由系统创建任务；",
	"不要用 Markdown 清单代替提案，也不要自己调用 `team_task_create` 绕过确认。",
	"简单问题直接回答，不要为了走流程而提案。",
	"",
	"不要创建没有具体产出、只是占位的 teammate。",
	"",
	"## 项目简报（按需读取）",
	"",
	"如果你属于某个项目，开始处理项目任务前先调用 `whales_brief_read` 读取项目简报；",
	"需要其他对话的结论时，读取对方的对话简报。简报可能会更新，做关键决策前请重读。"
].join("\n");

/** 仅供测试：团队策略段原文（含 M5 静态提示）。 */
export const TEAM_POLICY_TEXT = TEAM_POLICY;

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
/**
 * 从会话事件里抽「最近调过哪些工具」（观测层，MCP/agent 约束方案的第一层）。
 *
 * 为什么不需要探针：用户提出「把 MCP/agent 拖到画布连到某个对话 = 约束它只能用这些」。
 * 整件事的观测层（谁用了什么）根本不用动 tools.guard——会话事件里原生就有 tool/call，
 * 已在一个真实落盘会话里核实（~/.dsh/sessions 下的 session.v4.jsonl.zstd，解出来有
 * tool/call 与 tool/result 各若干条，data.name 就是工具名）。我们此前的 foldMessages
 * 只抽 type === "text"，把 tool/call 整个丢掉了，所以一直没发现这条现成数据。
 *
 * 口径：**只观测，不改任何行为**。从尾部往前扫且有扫描上限——/sessions 每 5s 被轮询，
 * 而 SESSIONS_MAX_ROWS 是 500，不能对每个会话都全量扫。
 *
 * @param events  sessionEvents() 的返回值
 * @param limit   最多返回几条（默认 8）
 * @param maxScan 最多往回看多少条事件（默认 200）
 * @returns [{name, at, seq}]，按时间正序；读不到就给空数组
 */
export function sessionToolCalls(events, limit = 8, maxScan = 200) {
	const list = Array.isArray(events) ? events : [];
	const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
	const scan = Number.isFinite(maxScan) && maxScan > 0 ? Math.floor(maxScan) : 200;
	const out = [];
	for (let i = list.length - 1; i >= 0 && out.length < want && list.length - i <= scan; i -= 1) {
		const event = list[i];
		if (!event || typeof event !== "object" || event.type !== "tool/call") continue;
		const data = event.data && typeof event.data === "object" ? event.data : {};
		const name = typeof data.name === "string" && data.name !== "" ? data.name : null;
		if (name === null) continue;
		out.push({
			name: name,
			at: typeof event.time === "number" ? event.time : 0,
			seq: typeof event.seq === "number" ? event.seq : 0
		});
	}
	return out.reverse();
}

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

// ── 回合级轨迹（whales_visit_trace 的纯函数层）──────────────────────────
//
// 借形 fengshenx/dsh-leader-agent 的 src/host/worker-transcript.js（MIT）：
// 三块观测拼图缺中间那一块——whales_visit_read 只给「谁说了什么」的文本行，
// event_replay 只放任务生命周期六步，气泡只报「当前在跑哪个工具」；缺的是
// **回合级轨迹**：这一轮投了什么任务、调了哪些工具、在哪一步失败的。画布上
// Agent 卡的 handed_back（超 scope 退回）一直缺这块证据面。

/** 单条正文的保留上限。 */
const TRACE_MESSAGE_LIMIT = 2000;
/** 单条工具失败原因的保留上限。 */
const TRACE_REASON_LIMIT = 200;
/**
 * 整段正文的总上限。
 *
 * 回合数与单条上限都挡不住体积：20 个回合 × 每轮两条消息 × 2000 字符仍有八万。
 * 这是给调用方读的视图，不是导出，超过这个量就该改用别的手段。
 */
const TRACE_TOTAL_LIMIT = 12000;
/** 一次最多回看的回合数：再多就不是「回看」，而是导出整个会话。 */
export const TRACE_MAX_TURNS = 20;
/** 默认回看的回合数。 */
export const TRACE_DEFAULT_TURNS = 2;

/**
 * 按字符数截断并标注。
 *
 * 切点落在 UTF-16 代理对中间时会留下孤立代理，渲染成 U+FFFD；回退一个码元到
 * 码点边界。只保证码点完整，不切字素簇：丢掉组合标记只影响重音，不是乱码。
 *
 * @param {string} text 原文
 * @param {number} limit 上限（UTF-16 码元数）
 * @returns {string} 截断后的文本
 */
function clipTrace(text, limit) {
	if (text.length <= limit) return text;
	let end = limit;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…（已截断，原长 ${text.length} 字符）`;
}

/**
 * 把会话事件折成回合列表。
 *
 * 回合边界取 `turn/start` / `turn/end`（agent loop 每轮开头与 finally 各 append 一次）。
 * 最后一轮可能还在跑：只有 `turn/start` 没有 `turn/end`，该回合的 `end` 保持 undefined，
 * 由调用方通过 `running` 标注。
 *
 * `user/message` 有三种生产者共用同一事件类型，按 `source.kind` 分桶：
 * `agent-message`（别的智能体经 whales_visit_send 派来的话）= 任务；
 * `user` = 真人输入；其余（agent-instructions / runtime-context / skill-catalog /
 * time-context / user-approval…）是宿主注入的上下文，只计数不展开——否则注入会占掉
 * 任务正文的预算，读的人看到一段没人说过的话。
 *
 * @param {object[]} events sessionEvents() / sessionQuery.readSession() 的返回值
 * @returns {{ turns: object[], running: boolean }} 回合列表与「是否有未收尾的回合」
 */
export function foldTurns(events) {
	const turns = [];
	/** 当前打开的回合；`turn/end` 之后置空，下一条消息另起一段。 */
	let current;
	/**
	 * 开一个新回合段。
	 * @returns {object} 新回合
	 */
	function open() {
		current = { turn: undefined, task: [], user: [], injected: 0, assistant: [], tools: [], end: undefined };
		turns.push(current);
		return current;
	}
	for (const event of Array.isArray(events) ? events : []) {
		if (!event || typeof event !== "object") continue;
		const data = event.data && typeof event.data === "object" ? event.data : {};
		switch (event.type) {
			case "turn/start": {
				// 上一段没等到 turn/end 就来了新一轮：保留它，由 running 标出没收尾。
				const item = open();
				item.turn = typeof data.turn === "number" ? data.turn : undefined;
				break;
			}
			case "turn/end": {
				if (current === undefined || current.end !== undefined) open();
				if (current.turn === undefined && typeof data.turn === "number") current.turn = data.turn;
				const reason = data.reason && typeof data.reason === "object" ? data.reason : {};
				const error = reason.error && typeof reason.error === "object" ? reason.error : undefined;
				current.end = {
					kind: typeof reason.kind === "string" ? reason.kind : "unknown",
					error: error !== undefined && typeof error.message === "string" ? error.message : undefined
				};
				current = undefined;
				break;
			}
			case "user/message": {
				const item = current ?? open();
				const text = blockText(data.content);
				if (text === undefined || text.trim() === "") break;
				const source = data.source && typeof data.source === "object" ? data.source : undefined;
				const kind = source !== undefined && typeof source.kind === "string" ? source.kind : undefined;
				if (kind === "agent-message") item.task.push(text);
				else if (kind === "user") item.user.push(text);
				else item.injected += 1;
				break;
			}
			case "assistant/message": {
				const item = current ?? open();
				const message = data.message && typeof data.message === "object" ? data.message : undefined;
				const text = message === undefined ? undefined : blockText(message.content);
				if (text === undefined || text.trim() === "") break;
				item.assistant.push(text);
				break;
			}
			case "tool/call": {
				const item = current ?? open();
				item.tools.push({
					callId: typeof data.callId === "string" ? data.callId : undefined,
					name: typeof data.name === "string" && data.name !== "" ? data.name : "unknown",
					failed: undefined,
					reason: undefined
				});
				break;
			}
			case "tool/result": {
				const item = current ?? open();
				const message = data.message && typeof data.message === "object" ? data.message : undefined;
				const callId = message !== undefined && typeof message.toolCallId === "string" ? message.toolCallId : undefined;
				const failed = message !== undefined && message.isError === true;
				const target = callId === undefined ? undefined : item.tools.find((tool) => tool.callId === callId);
				if (target === undefined) {
					// 没有配对的 tool/call 也不丢：宿主在工具恢复路径上会补写结果事件。
					item.tools.push({ callId, name: "unknown", failed, reason: failed ? describeToolFailure(data) : undefined });
					break;
				}
				target.failed = failed;
				if (failed) target.reason = describeToolFailure(data);
				break;
			}
			default:
				// 其余事件（step、请求头、压缩、系统/开发者消息）不进回合视图。
				break;
		}
	}
	const running = turns.length > 0 && turns[turns.length - 1].end === undefined;
	return { turns, running };
}

/**
 * 取一条失败工具结果的用户可见原因。
 *
 * 与上游的差别：本宿主的 `error` 对象带稳定的机器可读 `code`（FS_NOT_FOUND /
 * TOOL_TIMEOUT / ABORTED），比类名（FsError / ToolTimeoutError）更能说明问题，
 * 所以排在 name 之前；两者都没有才退回结果正文。
 *
 * @param {object} data `tool/result` 的事件 data
 * @returns {string} 失败原因
 */
function describeToolFailure(data) {
	const error = data.error && typeof data.error === "object" ? data.error : undefined;
	const candidates = [error?.reason, error?.code, error?.name, blockText(data.message?.content)];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim() !== "") return clipTrace(candidate.trim(), TRACE_REASON_LIMIT);
	}
	return "未说明原因";
}

/**
 * 把回合列表渲染成给调用方读的正文。
 *
 * 只渲染最近 `limit` 个回合，且整段正文再受 {@link TRACE_TOTAL_LIMIT} 约束：按「最新
 * 优先」累加，放不下的更早回合直接丢弃并标注条数。回合数上限挡不住体积——20 个
 * 回合 × 每轮两条消息 × 单条上限，仍能拼出十万字符，塞进调用方上下文会挤掉它自己的
 * 工作记忆。最新那一段单独超限时按总量硬截断。
 *
 * @param {object} options 渲染参数
 * @param {object[]} options.turns foldTurns().turns
 * @param {string} options.sessionId 会话 id
 * @param {string} options.name 会话显示名
 * @param {number} options.limit 保留的最近回合数
 * @param {boolean} [options.running] 最后一轮是否还在跑
 * @returns {string} 正文
 */
export function renderTranscript({ turns, sessionId, name, limit, running = false }) {
	const header = `会话 ${sessionId}${name === undefined || name === "" ? "" : `（${name}）`}：共 ${turns.length} 个回合`;
	if (turns.length === 0) return `${header}，日志里还没有任何回合。`;
	const selected = turns.slice(-limit);
	const blocks = selected.map(renderTurn);
	// 从最新往回装：放不下的更早回合丢掉，保证读者先看到最近的结论。
	const kept = [];
	let size = 0;
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (size + block.length > TRACE_TOTAL_LIMIT) {
			if (kept.length > 0) break;
			// 最新一回合自己就超限：截断它，否则整次读取拿不到任何内容。
			const clipped = clipTrace(block, TRACE_TOTAL_LIMIT);
			kept.unshift(clipped);
			size = clipped.length;
			break;
		}
		kept.unshift(block);
		size += block.length;
	}
	const shown = kept.length;
	const outsideTurns = turns.length - selected.length;
	const overflowTurns = selected.length - shown;
	const lines = [
		`${header}，以下是最新的 ${shown} 个${running ? "（最后一轮仍在执行中，内容可能不完整）" : ""}：`,
		...kept
	];
	if (outsideTurns > 0 || overflowTurns > 0) {
		const facts = [];
		if (outsideTurns > 0) facts.push(`更早的 ${outsideTurns} 个回合超出 turns=${limit} 的范围`);
		if (overflowTurns > 0) facts.push(`最近的 ${overflowTurns} 个回合因正文超出单次读取上限被丢弃`);
		// 体积上限固定：被挤掉的回合在任何 turns 值下都装不回来（调小只是少几个候选，
		// 调大仍超限），提示不能暗示调参可达。窗口外的部分调大 turns 仍然有效。
		const hint = overflowTurns > 0
			? "单次读取的总量上限固定，调 turns 取不到这些回合；需要更早的内容请让那个会话自己复述。"
			: "调大 turns 可以多看更早的回合。";
		lines.push("", `${facts.join("；")}，未展示。${hint}`);
	}
	return lines.join("\n");
}

/**
 * 渲染一个回合。
 *
 * @param {object} turn foldTurns 的一个回合
 * @returns {string} 该回合的正文段
 */
function renderTurn(turn) {
	const label = typeof turn.turn === "number" ? `回合 ${turn.turn}` : "回合（未标号）";
	const outcome = turn.end === undefined
		? "进行中"
		: turn.end.error === undefined ? turn.end.kind : `${turn.end.kind}：${clipTrace(turn.end.error, TRACE_REASON_LIMIT)}`;
	const lines = ["", `## ${label} · ${outcome}`];
	if (turn.task.length > 0) lines.push(`任务：${clipTrace(turn.task.join("\n\n"), TRACE_MESSAGE_LIMIT)}`);
	if (turn.user.length > 0) lines.push(`用户：${clipTrace(turn.user.join("\n\n"), TRACE_MESSAGE_LIMIT)}`);
	if (turn.task.length === 0 && turn.user.length === 0) lines.push("用户：（无）");
	if (turn.injected > 0) lines.push(`（另有 ${turn.injected} 条注入上下文，已省略）`);
	lines.push(`助手：${turn.assistant.length === 0 ? "（无）" : clipTrace(turn.assistant.join("\n\n"), TRACE_MESSAGE_LIMIT)}`);
	if (turn.tools.length > 0) {
		const tools = turn.tools.map((tool) => {
			if (tool.failed === true) return `${tool.name}（失败：${tool.reason ?? "未说明原因"}）`;
			return tool.name;
		});
		lines.push(`工具：${tools.join("、")}`);
	}
	return lines.join("\n");
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

/** 正在 resume 的会话：并发同名调用复用同一个 Promise，避免把同一会话拉起两次。串门工具与画布「唤醒」共用。 */
const RESUMING_SESSIONS = new Map();

/**
 * 把离线（已持久化）的会话拉上线，幂等：已在线直接返回，并发同 id 共用一次加载。
 * 串门工具 `whales_visit_resume` 与画布 Agent 卡「唤醒」（POST /projects/:id/resume）是同一条路径——
 * 这样「串门工具被关掉」时画布按钮照样可用，而两边的幂等 / 失败口径不会各写一份而漂移。
 *
 * 失败一律抛带中文原因的 Error（没有 agents 服务 / 没有 agents.resume / 宿主 resume 自己抛），
 * 调用方原样展示给人，不吞、不翻状态。
 *
 * @param {(name: string) => unknown} get
 * @param {string} sessionId 已 trim 的非空 id
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ sessionId: string, live: boolean, resumed: boolean }>}
 */
async function resumeSessionById(get, sessionId, signal) {
	const agents = get("agents");
	if (!agents) throw new Error("宿主没有 agents 服务，恢复不了会话");
	// 已经在线就直接返回——resume 不是每次都该做，重复调用会把会话反复拉起。
	if (liveAgent(get, sessionId)) return { sessionId, live: true, resumed: false };
	if (typeof agents.resume !== "function") throw new Error("宿主没有 agents.resume，无法恢复离线会话");
	// 并发幂等：同一会话的第二个调用复用第一次的 Promise，而不是各开一次加载。
	let pending = RESUMING_SESSIONS.get(sessionId);
	if (pending === undefined) {
		pending = Promise.resolve()
			.then(() => agents.resume({ resumeSessionId: sessionId, signal }))
			.finally(() => {
				RESUMING_SESSIONS.delete(sessionId);
			});
		RESUMING_SESSIONS.set(sessionId, pending);
	}
	const handle = await pending;
	// resume 会在返回前完成 publish（dsh-agent-loop 的 setupAndPublish），但失败的
	// 部分初始化可能只留下 handle：两者都认，拿不到就如实回报 live:false，不谎报。
	const after = liveAgent(get, sessionId) || (handle && handle.agent) || undefined;
	return { sessionId, live: Boolean(after), resumed: true };
}

/**
 * 读一个会话的完整事件日志（回合轨迹用）。
 *
 * 优先宿主 `sessionQuery.readSession()`：它是「live 优先」的语料读口——活会话读内存、
 * 离线会话读盘，都不唤醒会话、不产生模型调用。dsh-base 默认就挂着这个服务
 * （`openAt: never` 只关全文搜索，精确读取仍然可用），所以离线会话也有日志可读。
 *
 * 服务缺失时退到活会话的内存快照（与 whales_visit_read 同一条路）；两条路都读不到
 * 才抛错，并说清该先 whales_visit_resume。readSession 自己抛错时原样上抛：会话不存在、
 * 日志损坏要说真话，静默当成空日志会让调用方以为对方「什么都没做」。
 *
 * @param {(name: string) => unknown} get
 * @param {string} sessionId
 * @returns {Promise<object[]>} 完整事件数组
 */
async function readSessionLog(get, sessionId) {
	const query = typeof get === "function" ? get("sessionQuery") : undefined;
	if (query !== undefined && typeof query.readSession === "function") {
		const snapshot = await query.readSession(sessionId);
		if (!snapshot || !Array.isArray(snapshot.events)) {
			throw new Error(`会话 ${sessionId} 的日志形状不符（缺 events 数组），读不了`);
		}
		return snapshot.events;
	}
	const agent = liveAgent(get, sessionId);
	if (agent !== undefined) return sessionEvents(agent.session);
	throw new Error(`读不到会话 ${sessionId} 的日志：它不在线，当前组合也没有 sessionQuery 服务（可先用 whales_visit_resume 把它拉起来）`);
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

// ── 落点路径归一（M6 工单的 worktree / execRoot）────────────────────────
//
// 借形 fengshenx/dsh-leader-agent 的 session-index.js（MIT）里那条 realpath 归一
// 思路——**只搬归一，不搬「按目录自动归属会话」**（鲸鱼是显式加入制，一个对话只能
// 属于一个项目，40701）。
//
// 为什么需要：落点是用户手填的自由文本，同一个目录有多种写法（尾分隔符、`./`、
// 重复分隔符、符号链接、Windows 大小写）。画布的上下文节点按落点去重，字符串不等
// 就会把同一个目录拆成两个节点——「活在哪跑」由此失真。

/**
 * 词法归一：去首尾空白、去掉段级 `.`、解析 `..`、折叠重复分隔符、去尾分隔符
 * （根目录 `/`、`C:\`、UNC `\\server\share` 的前导部分保留）。
 *
 * 纯函数、同步、不碰 fs：浏览器半边（画布去重）与宿主半边（落点入库）用同一套规则，
 * 两边才不会各说各话。大小写与符号链接归一不了——那需要 fs，见 {@link canonicalLandingPath}。
 *
 * @param {unknown} input 原始落点
 * @returns {string} 归一后的落点；空/非字符串给 ""
 */
export function normalizeLandingPath(input) {
	if (typeof input !== "string") return "";
	const trimmed = input.trim();
	if (trimmed === "") return "";
	// 前导分隔符是路径的一部分：单个 = 根，两个及以上 = UNC（\\server\share 或 //server/share），
	// 折叠重复分隔符时不能把它们一起折掉。
	const leading = /^[\\/]+/.exec(trimmed);
	const unc = leading !== null && leading[0].length >= 2;
	const body = leading === null ? trimmed : trimmed.slice(leading[0].length);
	const segments = [];
	for (const segment of body.split(/[\\/]+/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			// 段顶的 `..` 没有可弹的父段：保留它，交给真实文件系统去解释。
			if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
			else segments.push("..");
			continue;
		}
		segments.push(segment);
	}
	const separator = trimmed.includes("\\") ? "\\" : "/";
	const joined = segments.join(separator);
	if (joined === "") {
		// 只剩 `.`/`..` 之类且不以分隔符开头：语义是「当前目录」，词法层面无法表达，
		// 按没有落点处理（画布侧空 key 不成节点），别冒充根目录。
		if (leading === null) return "";
		return unc ? separator + separator : separator;
	}
	// 盘符根（C: → C:\）要留住分隔符，否则 "C:" 不是绝对路径。
	const driveRoot = /^[a-zA-Z]:$/.test(joined);
	const prefix = leading === null ? "" : unc ? separator + separator : separator;
	return prefix + joined + (driveRoot ? separator : "");
}

/**
 * 入库前的落点归一：先词法，再 realpath（**只在路径已存在时**）。
 *
 * realpath 修掉词法修不了的两件事：符号链接（同一物理目录的两种写法）与磁盘上的
 * 真实大小写（Windows 路径大小写不敏感但保留大小写，手填时大小写漂移常见）。
 * 路径不存在（工单先建、落点后建是常态）或解析失败时回落词法结果——不抛错：
 * 落点归一失败不该让建任务失败。
 *
 * @param {unknown} input 原始落点
 * @param {(path: string) => string} [realpath] realpath 实现，默认 `fs.realpathSync.native`
 * @returns {string} 归一后的落点
 */
export function canonicalLandingPath(input, realpath) {
	const lexical = normalizeLandingPath(input);
	if (lexical === "") return "";
	const resolveRealpath = typeof realpath === "function" ? realpath : realpathSync.native;
	try {
		return resolveRealpath(lexical);
	} catch (error) {
		// ENOENT（还没建）/ EACCES（读不了）/ 任何其它：都按词法结果入库。
		return lexical;
	}
}

// ── 1) 团队协作策略 ──────────────────────────────────────────────────────

/**
 * 组装时判断团队（派生成员）工具是否真的可见。工具是 per-agent scope 注册的，所以先按 context.scope 查，
 * 再退到全局视图。返回 true/false；宿主根本没有 tools 服务（探测不到）时返回 undefined，由调用方决定兜底。
 * DSH v0.2.1-rc.2 起成员就是标准 subagent（`spawn_teammate` 已移除）；两种名字都认，兼容旧宿主。
 */
const TEAM_SPAWN_TOOLS = ["subagent", "spawn_teammate"];
function teamToolsAtAssembly(get, context) {
	const tools = get("tools");
	if (!tools || typeof tools.get !== "function") return undefined;
	const scope = context && typeof context === "object" ? context.scope : undefined;
	try {
		if (scope !== undefined && TEAM_SPAWN_TOOLS.some((name) => tools.get(name, scope))) return true;
	} catch (error) {
		/* scope 不合法就退回全局视图 */
	}
	try {
		return TEAM_SPAWN_TOOLS.some((name) => Boolean(tools.get(name)));
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

// ── 1b) 随包协议 skill（playbook）────────────────────────────────────────
//
// 借形 fengshenx/dsh-leader-agent 的 src/host/skills.js（MIT）：把包内
// `skills/<name>/SKILL.md` 注册成宿主的 skill provider，让模型能按需加载协议层。
//
// 为什么值得有：本插件的协议（提案 / 简报 / 画布 / 串门 / 台账）很长，全塞进系统提示
// 会占每一轮的上下文；工具 schema 又只说单个工具的用法，不说**顺序与边界**。skill 是
// 「模型要的时候才读」的那一层，正好补这个空。
//
// 与上游的两处差别：
//   · 宿主 API 是 `ctx.skills.registerProvider(provider)`（同步、返回 disposer），
//     上游同款；provider 缺失/注册失败一律静默跳过——协议层是增强，不是必需能力。
//   · frontmatter 只解析本 skill 用到的三个顶层标量（name / description / whenToUse），
//     不搬上游那套缩进嵌套 map（那是 SLOTS.md 的槽位元数据，鲸鱼没有槽位概念）。

/** 与 dsh skill-filesystem 的 bundled 语义对齐：项目内的同名副本（rank 200）优先于包内副本。 */
const BUNDLED_SKILL_RANK = 600;

/**
 * 随包 skill 的 provider 名。**必须与 package.json 的 name 一致**：宿主按 provider 标注
 *  skill 来源，用户在看到「这个 skill 是哪个插件带的」时对得上号。
 */
const SKILL_PROVIDER_NAME = "dsh-agent-whales";

/** skill 名（kebab-case）——宿主的 skill 工具按这个名字发现与加载。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 包内 skills 根目录（随包分发，见 package.json 的 files）。 */
const BUNDLED_SKILLS_ROOT = new URL("../skills/", import.meta.url);

/**
 * 解析 SKILL.md 的 frontmatter（最小 YAML 子集：顶层标量）。
 *
 * 只认 `---` 开头、`---` 结束之间的 `key: value` 行。标量规则与 YAML 一致：
 * 成对引号剥掉；**引号外的「空格 + #」之后是行内注释**——所以描述里要出现 `#`
 * 就得给值加引号，否则会被当注释截掉（截断的 description 会让 skill 发现不了）。
 * 没有 frontmatter 或格式不对时给空 data + 全文当正文，调用方据此跳过候选，不抛。
 *
 * @param {string} text SKILL.md 全文
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseSkillFrontmatter(text) {
	const source = typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";
	if (!source.startsWith("---\n")) return { data: {}, body: source };
	const end = source.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: source };
	const data = {};
	for (const line of source.slice(4, end).split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) continue;
		const key = trimmed.slice(0, separator).trim();
		if (key === "") continue;
		let value = trimmed.slice(separator + 1).trim();
		// 引号内的内容原样保留（含 # 与行内注释形态）；只有未加引号的值才剥行内注释。
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				value = value.slice(1, -1);
			} else {
				const comment = value.startsWith("#") ? 0 : value.indexOf(" #");
				if (comment !== -1) value = value.slice(0, comment).trim();
			}
		}
		if (value !== "") data[key] = value;
	}
	return { data, body: source.slice(end + 4).replace(/^\n+/, "") };
}

/**
 * 读一个 skill 目录，返回可发现的候选；不可用（缺 SKILL.md / 名字非法 / 没 description）
 * 时给 undefined——单个坏 skill 不该连累整个 catalog。
 *
 * @param {string} directory skill 目录绝对路径（字符串：locator 要能原样交给 path.join）
 * @param {string} providerName provider 名
 * @returns {object | undefined}
 */
function readSkillCandidate(directory, providerName) {
	const file = join(directory, "SKILL.md");
	let text;
	try {
		if (!existsSync(file)) return undefined;
		text = readFileSync(file, "utf8");
	} catch (error) {
		return undefined;
	}
	const { data } = parseSkillFrontmatter(text);
	const name = typeof data.name === "string" ? data.name : "";
	const description = typeof data.description === "string" ? data.description : "";
	if (!SKILL_NAME_PATTERN.test(name) || description === "") return undefined;
	const candidate = {
		name,
		description,
		invocation: { modelInvocable: true, userInvocable: true },
		source: "bundled",
		provider: providerName,
		path: file,
		rank: BUNDLED_SKILL_RANK,
		locator: { directory: directory },
		resourceBase: { kind: "directory", path: directory }
	};
	if (typeof data.whenToUse === "string" && data.whenToUse !== "") candidate.whenToUse = data.whenToUse;
	return candidate;
}

/**
 * 创建随包 skill provider（注册进 `ctx.skills`）。
 *
 * 目录读不到时**告警并返回空列表**：抛错会连累整个 skill catalog（别的 provider 也拿不到
 * 结果），而发布包漏了 skills 目录必须有个信号，不能静默变成「协议层凭空消失」。
 *
 * @param {object} options
 * @param {URL} [options.skillsRoot] skills 根目录
 * @param {string} options.providerName provider 名
 * @param {(message: string) => void} [options.logger] 告警出口
 * @returns {{ name: string, list: () => object[], get: (candidate: object) => object | undefined }}
 */
export function createBundledSkillProvider({ skillsRoot, providerName, logger }) {
	const root = skillsRoot === undefined ? BUNDLED_SKILLS_ROOT : skillsRoot;
	return {
		name: providerName,
		list() {
			let entries;
			try {
				entries = readdirSync(fileURLToPath(root), { withFileTypes: true });
			} catch (error) {
				logger?.(`读不到随包 skill 目录，协议层 skill 全部不可用：${fileURLToPath(root)}（${errorMessage(error)}）`);
				return [];
			}
			const candidates = [];
			const rootPath = fileURLToPath(root);
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const candidate = readSkillCandidate(join(rootPath, entry.name), providerName);
				if (candidate !== undefined) candidates.push(candidate);
			}
			return candidates;
		},
		get(candidate) {
			const directory = candidate && candidate.locator && typeof candidate.locator.directory === "string" ? candidate.locator.directory : undefined;
			if (directory === undefined) return undefined;
			let text;
			try {
				text = readFileSync(join(directory, "SKILL.md"), "utf8");
			} catch (error) {
				return undefined;
			}
			const { data, body } = parseSkillFrontmatter(text);
			return {
				...candidate,
				description: typeof data.description === "string" && data.description !== "" ? data.description : candidate.description,
				content: body.trim()
			};
		}
	};
}

/**
 * 把随包 skill provider 注册进宿主。`skills` 服务缺失（老宿主 / 被裁掉的组合）时
 * 静默返回——协议层是增强，不是必需能力。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} providerName provider 名（用包名，项目副本按 rank 覆盖）
 */
function registerBundledSkills(ctx, providerName) {
	const skills = ctx.get("skills");
	if (!skills || typeof skills.registerProvider !== "function") return;
	try {
		const provider = createBundledSkillProvider({ providerName, logger: (message) => warn(ctx, "bundled skills", new Error(message)) });
		const disposer = skills.registerProvider(provider);
		if (typeof disposer !== "function") return;
		ctx.effect(() => disposer, "agent-whales: bundled skills");
	} catch (error) {
		warn(ctx, "bundled skills", error);
	}
}

// ── 2) 工具活动采集 ──────────────────────────────────────────────────────
// ── 1c) ultra 模式：强制加载 deep-effort 执行契约 ───────────────────────────
//
// 背景（2026-11-16）：用户做了四臂对照实验（数据在 deep-effort 的 README/EXPERIMENT.md），
// 结论是「我们是 DeepSeek 公司、用量 unlimited」那句自我宣称不起作用，真正起作用的是它夹带的
// 三件事：**授权花预算、许可去查、许可去派工**。蒸馏成 49 行的 deep-effort 技能，随本插件分发
// （skills/deep-effort/SKILL.md）。
//
// 为什么要有「强制加载」这一层：skill 的默认消费路径是「模型要的时候才读」（目录 + skill 工具），
// 而 ultra 模式要的是**每一轮都在上下文里**，不依赖模型自觉调用。所以模式打开时，除随包 provider
// 让 deep-effort 可被发现外，再把正文注册成一段系统提示（systemPrompt.section）；关掉时交空字符
// 串——renderPrompt 会整段过滤空段，不占一行 token。段文本在**组装时**求值，因此运行时的开关
// 即时生效，不需要注销重注册。
//
// 为什么正文读文件而不是抄一份常量：SKILL.md 必须是唯一真源——目录条目、按需加载、强制段三处
// 都该是同一份文本。抄常量就会长出「改了技能文件、强制段还是旧版」这种最难查的分叉。
// frontmatter 的 name 必须是 deep-effort：防止有人往 skills/ 里丢个同名目录掉包。

/** ultra 段名（与 team-policy 同一条命名线）。 */
const ULTRA_SECTION_NAME = "agent-whales/ultra";
/**
 * 段顺序：官方分配表里 TEAM_POLICY = 600、PTC_ONLY = 800，610 是空位。
 * deep-effort 是执行契约，紧跟「默认先起团队」之后、各工具指导（1000+）之前，语义顺序是对的。
 */
const ULTRA_SECTION_ORDER = 610;

/**
 * 模式状态文件：`<DSH_HOME>/agent-whales/ultra.json`（DSH_HOME 未设时才是 `<homedir>/.dsh/...`，
 * 与插件其它 store 同一条口径）。环境变量可覆盖（测试/诊断用）。
 */
let ULTRA_MODE_FILE = (typeof process.env.DSH_AGENT_WHALES_ULTRA_FILE === "string" && process.env.DSH_AGENT_WHALES_ULTRA_FILE !== "")
	? process.env.DSH_AGENT_WHALES_ULTRA_FILE
	: join(resolveDshHome(), "agent-whales", "ultra.json");

/** 仅供离线测试：把模式状态文件指到临时路径（避免污染真实 ~/.dsh）。 */
export function setUltraModePathForTests(file) {
	if (typeof file !== "string" || file === "") return;
	ULTRA_MODE_FILE = file;
}

/** 仅供测试：读当前生效的模式状态文件路径。 */
export function ultraModeFileForTests() {
	return ULTRA_MODE_FILE;
}

/**
 * 初始开关：**持久化文件 > 插件 config > 默认关**。
 *
 * 默认关是刻意的：deep-effort 自己写了「单点小改、日常问答不要用」，一个默认全开的
 * 高预算契约会让简单任务也过度取证。config 里 `ultra: true` 可一劳永逸改默认。
 * 持久化文件让设置页的开关跨重启存活（2026-11-16 用户决定：开关要记住）。
 */
function initialUltraEnabled(config) {
	let persisted;
	try {
		const data = readStoreFile(ULTRA_MODE_FILE).data;
		if (data && typeof data.enabled === "boolean") persisted = data.enabled;
	} catch (error) {
		persisted = undefined;
	}
	if (persisted !== undefined) return persisted;
	return !!(config && typeof config === "object" && config.ultra === true);
}

/** deep-effort 的 SKILL.md 路径（随包分发，见 package.json 的 files）。 */
const DEEP_EFFORT_SKILL_NAME = "deep-effort";
const DEEP_EFFORT_SKILL_FILE = new URL(`../skills/${DEEP_EFFORT_SKILL_NAME}/SKILL.md`, import.meta.url);

/** 正文缓存：undefined = 还没读过；"" = 读不到（不反复读盘，也不反复告警）。 */
let deepEffortBodyCache;

/**
 * 读 deep-effort 正文并拼上「已强制加载」的表头。
 *
 * 表头那行是给模型的：它在目录里还能看到 deep-effort 条目，没有这行它会再去调一次
 * skill 工具，把同一份契约加载两遍。
 */
function deepEffortSectionText() {
	if (deepEffortBodyCache === undefined) {
		let body = "";
		try {
			const text = readFileSync(DEEP_EFFORT_SKILL_FILE, "utf8");
			const parsed = parseSkillFrontmatter(text);
			// 掉包防护：frontmatter 的 name 不是 deep-effort 就不强制加载。
			if (parsed.data.name === DEEP_EFFORT_SKILL_NAME && parsed.body.trim() !== "") body = parsed.body.trim();
		} catch (error) {
			body = "";
		}
		deepEffortBodyCache = body;
	}
	if (deepEffortBodyCache === "") return "";
	return [
		"## ultra 模式已开启：deep-effort 执行契约（强制加载）",
		"",
		"以下契约已经在你上下文里，**不要再调用 skill 工具加载 deep-effort**。",
		"",
		deepEffortBodyCache
	].join("\n");
}

/**
 * 创建 ultra 模式控制器。
 *
 * `setEnabled` 的语义是「先落盘再翻内存」：持久化是这个开关的硬承诺（用户明确要求重启后
 * 仍生效），落盘失败就整体回绝、内存状态不变——否则会出现「界面显示开着、重启后却关了」
 * 这种最难复现的漂移。写盘走通用 store 的原子写 + 单文件串行队列。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object | undefined} config 插件 entry 的 config（可选）
 * @returns {{ isEnabled: () => boolean, setEnabled: (next: boolean) => Promise<boolean> }}
 */
function createUltraMode(ctx, config) {
	let enabled = initialUltraEnabled(config);
	function isEnabled() { return enabled; }
	function setEnabled(next) {
		const want = next === true;
		if (want === enabled) return Promise.resolve(true);
		return writeStoreFile(ULTRA_MODE_FILE, { enabled: want, updatedAt: Date.now() }).then(
			function () { enabled = want; return true; },
			function (error) {
				if (error && error.code === "STORE_READONLY") return false;
				warn(ctx, "ultra mode write", error);
				return false;
			}
		);
	}
	return { isEnabled, setEnabled };
}

/**
 * 注册 ultra 段。段常驻（关时空串被过滤），开关只改 text() 的返回值。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ isEnabled: () => boolean }} ultra
 */
/**
 * v2.2 波次 5：流程图自动生成的提示段（四层机制第 2 层：点名 flow）。静态文本，不注入任何会话数据；
 * 任何对话都能用：不在项目里的对话首次画图会就地建项目（ensureSessionProject）。
 */
const FLOW_SECTION_NAME = "agent-whales:flow";
const FLOW_SECTION_ORDER = 640;
const FLOW_SECTION_TEXT = [
	"## 画布上的流程图与原型（dsh-agent-whales）",
	"讨论里已经出现了**有先后的步骤或分支判断**（流程、审批链、导入导出步骤、状态流转等），或用户要你「画一下」时，",
	"主动把它画到画布上：先 `whales_flow_read` 拿可引用的消息编号与已有图，再 `whales_flow_draw`。",
	"不需要用户先建项目：对话还不属于任何项目时，首次画图会自动为本对话建一个项目画布（工具结果里 projectCreated 为 true），照 projectNote 告诉用户去哪看。规则：",
	"1. 每个节点都要引用真实消息编号（sourceMessageIds）；说不清出处的步骤不要画——宁可少画，不可编造。",
	"2. 起止用 start/end，动作用 step，判断用 decision，分支边写「是 / 否 / 例外」。",
	"3. 同一件事复用同一个 flowId；用户手改过的节点不会被覆盖，你只需补新增。",
	"4. 讨论还不够成图就不画；工具回「节流」就等用户再说几句。画完在回复里提一句「已更新画布上的流程图」。",
	"5. 讨论到具体页面（表单、弹窗、列表页…）时，可用 `whales_prototype_draw` 画原型帧：只用通用词表组件，同样要引用消息编号；组件库由画布上的组件库节点决定，不要在原型里写具体库名。"
].join("\n");

function registerFlowSection(ctx) {
	const systemPrompt = ctx.get("systemPrompt");
	if (!systemPrompt || typeof systemPrompt.section !== "function") return;
	try {
		ctx.effect(() => {
			try {
				return systemPrompt.section({ name: FLOW_SECTION_NAME, order: FLOW_SECTION_ORDER, interpolate: false, text: FLOW_SECTION_TEXT });
			} catch (error) {
				warn(ctx, "flow section", error);
				return function () {};
			}
		}, "agent-whales: flow section");
	} catch (error) {
		warn(ctx, "flow section", error);
	}
}

function registerUltraSection(ctx, ultra) {
	const systemPrompt = ctx.get("systemPrompt");
	if (!systemPrompt || typeof systemPrompt.section !== "function") return;
	try {
		ctx.effect(
			() => {
				try {
					return systemPrompt.section({
						name: ULTRA_SECTION_NAME,
						order: ULTRA_SECTION_ORDER,
						// 技能正文按字面保留：里面出现 {{...}} 也不该被当提示词变量解析。
						interpolate: false,
						// 组装时求值：运行时的开关即时生效，且关掉时整段消失（空段被过滤）。
						text: () => (ultra.isEnabled() ? deepEffortSectionText() : "")
					});
				} catch (error) {
					// 提示段落注册失败不该拖垮本行。
					warn(ctx, "ultra section", error);
					return function () {};
				}
			},
			"agent-whales: ultra section"
		);
	} catch (error) {
		warn(ctx, "ultra section", error);
	}
}

/** 会派生子会话的工具名（团队 / 官方 subagent / 自定义 teammate）。命中才触发收编，别的工具不碰 store。 */
const CHILD_SPAWN_TOOL = /^(spawn_teammate|subagent|subagent_fork|spawn_agent|create_teammate)$/;
/** 结果事件到子会话出现在目录里之间有一点延迟：稍等再收，收不到再补一次。 */
const CHILD_ADOPT_DELAYS = [300, 2000];

/**
 * 子会话自动入项目的触发器（v2.2 波次 2）。返回 onToolResult(exec)：派生类工具结束后
 * 延迟收编（adoptChildSessions 只在真有可收的子会话时才写 store）。
 * 不自己 ctx.on("tools/result")：与活动采集共用一个监听器（宿主侧同名监听只挂一个，测试垫片也按名收）。
 */
function installChildAdoption(ctx, get) {
	const timers = new Set();
	function schedule() {
		for (const delay of CHILD_ADOPT_DELAYS) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				adoptChildSessions(get).catch((error) => warn(ctx, "adopt child sessions", error));
			}, delay);
			if (timer && typeof timer.unref === "function") timer.unref();
			timers.add(timer);
		}
	}
	if (ctx && typeof ctx.effect === "function") {
		ctx.effect(() => () => { for (const timer of timers) clearTimeout(timer); timers.clear(); }, "agent-whales: child adoption timers");
	}
	return function onToolResult(exec) {
		const name = exec && typeof exec.name === "string" ? exec.name : "";
		if (CHILD_SPAWN_TOOL.test(name)) schedule();
	};
}

function trackToolActivity(ctx, running, runtime, onToolResult) {
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
					// v2.2 波次 2：派生类工具结束 → 子会话自动入项目（独立 try，不影响活动采集）。
					if (typeof onToolResult === "function") {
						try { onToolResult(exec); } catch (error) { /* 不得抛 */ }
					}
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
/** ultra 模式开关路由（强制加载 deep-effort 执行契约）；同样带 controlToken。 */
const ULTRA_ENDPOINT = `${ACTIVITY_PATH}/ultra`;
/** 图形面板给某个节点发消息（写操作，同样要 x-whales-token）。 */
const SEND_ENDPOINT = `${ACTIVITY_PATH}/send`;
/** 开关请求体上限：只收一个 {"enabled": boolean}，不读大包。 */
const TOGGLE_BODY_LIMIT = 4096;
/** 普通业务路由的请求体上限：2000 token 的中文简报约 6KB，4KB 装不下。 */
const ROUTE_BODY_LIMIT = 64 * 1024;

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
function readRequestBody(req, limit) {
	// 默认沿用开关路由的 4KB 上限；业务路由显式传 ROUTE_BODY_LIMIT。
	const maxBytes = typeof limit === "number" && limit > 0 ? limit : TOGGLE_BODY_LIMIT;
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
					if (size > maxBytes) {
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
	const ultra = control && control.ultra && typeof control.ultra.isEnabled === "function" ? control.ultra.isEnabled() === true : false;
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
			ultra,
			controlToken,
			state
		});
	} catch (error) {
		body = `{"at":0,"active":{},"visitTools":false,"ultra":false,"controlToken":"","state":{}}`;
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
 * POST /agent-whales/api/ultra：ultra 模式开关（强制加载 deep-effort 执行契约）。
 *
 * 与串门工具开关同一条契约：x-whales-token 同源证明（见 handleVisitToolsRequest 的理由），
 * body `{"enabled": boolean}`，成功 204。差别只在效果——它翻转的是一段系统提示，落盘到
 * `<DSH_HOME>/agent-whales/ultra.json`，重启后仍保持（用户 2026-11-16 明确要求「记住」）。
 * 写盘失败（只读降级/IO）回 500：这个开关的承诺包含持久化，不能「内存翻了、盘上没写」。
 */
function handleUltraRequest(ctx, req, res, control) {
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

	// 同一时刻只允许一个 toggle 在飞：后到的按「已受理」回 204，避免重复落盘乱序。
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
			const ultra = control.ultra;
			if (!ultra || typeof ultra.setEnabled !== "function") {
				sendText(res, 500, "ultra mode unavailable");
				return;
			}
			if (await ultra.setEnabled(payload.enabled) !== true) {
				// 落盘失败：内存状态没翻，界面会跟着轮询回滚到真值。
				sendText(res, 500, "cannot persist ultra mode state");
				return;
			}
			sendEmpty(res, 204);
		} catch (error) {
			warn(ctx, "ultra mode toggle", error);
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
			const raw = await readRequestBody(req, ROUTE_BODY_LIMIT);
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
			// 人是 HTTP 调用方（单用户，本期拥有全部权限）：来源一律如实标 user。
			// viaCard 只做展示（哪张对话卡触发的），不进入 source、也不进入账本 from。
			const viaCard = payload && typeof payload.viaCard === "string" ? payload.viaCard.trim() : "";
			if (sessionId === "" || text === "") {
				sendText(res, 400, "sessionId and text are required");
				return;
			}
			if (text.length > 4000) {
				sendText(res, 413, "text too long");
				return;
			}
			const agents = typeof get === "function" ? get("agents") : undefined;
			const agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined;
			if (!agent) {
				sendText(res, 409, "session is not live");
				return;
			}
			const message = humanMessage(text);
			if (mode === "steer" && typeof agent.steer === "function") agent.steer(message);
			else if (typeof agent.followup === "function") agent.followup(message);
			else {
				sendText(res, 500, "agent cannot accept messages");
				return;
			}
			// 账本 from 固定为 "user"；viaCard 只作为展示补充，不作为发送方。
			await recordSend(ctx, "user", sessionId, "visit", message.id, viaCard === "" ? {} : { viaCard: viaCard });
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

// 测试/诊断可用环境变量覆盖存储位置；默认落在 <DSH_HOME>/agent-whales/（DSH_HOME 未设时
// 才是 <homedir>/.dsh/agent-whales/——与宿主自己的数据根同一条口径）。
let PROPOSAL_STORE_FILE = (typeof process.env.DSH_AGENT_WHALES_PROPOSAL_FILE === "string" && process.env.DSH_AGENT_WHALES_PROPOSAL_FILE !== "")
	? process.env.DSH_AGENT_WHALES_PROPOSAL_FILE
	: join(resolveDshHome(), "agent-whales", "proposals.json");
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
	// §51.4 组建方案（v2.2 波次 2）：提案除任务外还可以带「对话」与「关联」两类条目。
	// 对话 key 与任务 key 共用一个命名空间（suggestedOwner 可直接写对话 key）；"main" 保留给主对话。
	const conversations = [];
	if (input.conversations !== undefined) {
		if (!Array.isArray(input.conversations)) return { error: "conversations must be an array" };
		if (input.conversations.length > 6) return { error: "conversations exceeds 6" };
		for (const raw of input.conversations) {
			if (!raw || typeof raw !== "object") return { error: "each conversation must be an object" };
			const key = typeof raw.key === "string" ? raw.key.trim() : "";
			const title = typeof raw.title === "string" ? raw.title.trim() : "";
			if (key === "" || title === "") return { error: "each conversation needs key and title" };
			if (key === "main") return { error: "conversation key \"main\" is reserved for the main session" };
			if (keys.has(key)) return { error: "duplicate key: " + key };
			keys.add(key);
			conversations.push({
				key: key,
				title: title,
				duty: typeof raw.duty === "string" ? raw.duty : "",
				...(typeof raw.agentPreset === "string" && raw.agentPreset.trim() !== "" ? { agentPreset: raw.agentPreset.trim() } : {})
			});
		}
	}
	const conversationKeys = new Set(conversations.map((row) => row.key));
	const links = [];
	if (input.links !== undefined) {
		if (!Array.isArray(input.links)) return { error: "links must be an array" };
		for (const raw of input.links) {
			const a = raw && typeof raw.a === "string" ? raw.a.trim() : "";
			const b = raw && typeof raw.b === "string" ? raw.b.trim() : "";
			if (a === "" || b === "" || a === b) return { error: "each link needs two different ends" };
			for (const end of [a, b]) {
				if (end !== "main" && !conversationKeys.has(end)) return { error: "unknown link end: " + end + " (use \"main\" or a conversation key)" };
			}
			links.push({ a: a, b: b });
		}
	}
	return {
		leadSessionId: leadSessionId,
		items: normalized,
		order: order,
		writeScopes: writeScopes,
		conversations: conversations,
		links: links
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
		...(Array.isArray(record.conversations) && record.conversations.length > 0 ? { conversations: record.conversations } : {}),
		...(Array.isArray(record.links) && record.links.length > 0 ? { links: record.links } : {}),
		...(record.writeScopes === undefined ? {} : { writeScopes: record.writeScopes }),
		locked: record.confirmed !== undefined,
		...(record.confirmed === undefined ? {} : {
			confirmed: {
				version: record.confirmed.version,
				created: record.confirmed.created,
				...(Array.isArray(record.confirmed.conversations) ? { conversations: record.confirmed.conversations } : {}),
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
	// 项目提案不依赖宿主团队（与确认路径同一口径）：团队服务缺失时画布上的提案卡也要看得到。
	const rawLead = queryParam(req.url, "leadSessionId");
	const leadKey = typeof rawLead === "string" ? rawLead.trim() : "";
	if (leadKey !== "") {
		const projectRecord = readProposalStore()[leadKey];
		if (projectRecord !== undefined && typeof projectRecord.projectId === "string" && projectRecord.projectId !== "") {
			sendEnvelope(res, 200, TASK_CODE.ok, "success", { proposal: proposalView(projectRecord), order: projectRecord.order });
			return;
		}
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
			const raw = await readRequestBody(req, ROUTE_BODY_LIMIT);
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
				"项目提案（带 projectId）还可以是「组建方案」：conversations 列出需要新建的对话（key/title/duty/agentPreset），用户整体确认一次后系统逐个新建并加入项目、自动与主对话连互发线；" +
				"links 列出额外的互发线（两端写 \"main\" 或对话 key）；任务的 suggestedOwner 写对话 key 时，确认后直接归给那个新对话（只指派、不派发）。" +
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
					writeScopes: { type: "array", items: { type: "string" } },
					conversations: {
						type: "array",
						description: "组建方案：需要新建的对话（仅项目提案；最多 6 个）。",
						items: {
							type: "object",
							properties: {
								key: { type: "string", description: "临时唯一键，任务 suggestedOwner / links 用它引用；不能叫 main。" },
								title: { type: "string", description: "对话名（角色），显示在画布 Agent 卡上。" },
								duty: { type: "string", description: "职责，写进该对话的对话简报。" },
								agentPreset: { type: "string", description: "可选：新对话使用的 preset（如 dsh-agent-whales-worker）。" }
							},
							required: ["key", "title"],
							additionalProperties: false
						}
					},
					links: {
						type: "array",
						description: "额外的互发线（虚线）：两端写 \"main\" 或对话 key。新对话与主对话之间的线会自动建，不必写。",
						items: {
							type: "object",
							properties: { a: { type: "string" }, b: { type: "string" } },
							required: ["a", "b"],
							additionalProperties: false
						}
					}
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
				if (projectId === "" && (validated.conversations.length > 0 || validated.links.length > 0)) {
					throw new Error("invalid proposal: conversations / links need a projectId (组建方案只用于项目提案)");
				}
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
					...(validated.conversations.length > 0 ? { conversations: validated.conversations } : {}),
					...(validated.links.length > 0 ? { links: validated.links } : {}),
					...(validated.writeScopes === undefined ? {} : { writeScopes: validated.writeScopes }),
					createdAt: Date.now()
				};
				store[validated.leadSessionId] = record;
				if (!(await writeProposalStore(ctx, store))) throw new Error("proposal store write failed");
				// 事件台接线：提案提交是插件自己的事实，趁热登记（await 它：ingestEvent 绝不抛，
				// 失败只在内部 warn；工具调用晚 1ms 比丢一条事件好）。
				try {
					await ingestEvent(ctx, {
						source: "plugin",
						kind: "proposal.submit",
						text: proposalBodyText(validated.items),
						evidence: proposalId,
						projectId: projectId === "" ? undefined : projectId
					});
				} catch (error) {
					warn(ctx, "event ingest", error);
				}
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
		// 跨用例隔离：换文件必须丢掉上一份"最后一次成功快照"，否则降级用例会拿旧快照。
		lastGoodProjectStore = undefined;
	}

	const PROJECT_CODE = {
		ok: 200,
		param: 40000,
		forbidden: 40301,
		notFound: 40401,
		conflict: 40701,
		mainFixed: 40702,
		notMain: 40706,
		// 约束层：连了一个不存在的 MCP 服务，或连到了非项目成员。
		mcpUnknown: 40709,
		mcpNotMember: 40710,
		// 画布「唤醒」：目标会话不属于本项目 / 宿主 resume 失败。
		notMember: 40711,
		resumeFailed: 50201,
		storeReadonly: 50302,
		internal: 50000
	};

	const PROJECTS_PREFIX = `${ACTIVITY_PATH}/projects`;

	/** 解析 /agent-whales/api/projects[/<id>[/members|links|resume[/<sid>]]]。 */
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
		if (parts.length === 2 && (parts[1] === "members" || parts[1] === "links" || parts[1] === "brief" || parts[1] === "mcp-links" || parts[1] === "adopt" || parts[1] === "dependencies" || parts[1] === "references" || parts[1] === "resume")) {
			return { kind: parts[1], projectId: projectId };
		}
		if (parts.length === 3 && parts[1] === "members") {
			return { kind: "member", projectId: projectId, sessionId: decode(parts[2]) };
		}
		return undefined;
	}

	let lastGoodProjectStore;
	/**
	 * 只读降级提示只记一次：一次 episode（坏掉 → 恢复成功）只落一条 store.degraded，
	 * 否则每 2s 的客户端轮询会把事件台刷成 suppressed 海洋。恢复成功后重置。
	 */
	let storeDegradedNoted = false;
	function readProjectStore() {
		const result = readStoreFile(projectsStoreFile());
		if (result.readonly) {
			// 只读降级：用最后一次成功解析的快照继续判定项目边界（不能因为存储坏了就全放开）。
			const fallback = lastGoodProjectStore;
			// 事件台接线：降级被发现时登记一条。fire-and-forget（这里是同步读路径，不能等记账），
			// ingestEvent 自身绝不抛，.catch 只是防御；ctx 拿不到，失败即静默。
			if (storeDegradedNoted === false) {
				storeDegradedNoted = true;
				ingestEvent(undefined, {
					source: "plugin",
					kind: "store.degraded",
					text: "projects.json 只读降级",
					evidence: typeof result.backupPath === "string" ? result.backupPath : ""
				}).catch(function () { /* 记账失败不影响降级读取 */ });
			}
			return {
				store: fallback === undefined ? { projects: {} } : fallback,
				readonly: true,
				backupPath: result.backupPath,
				degraded: fallback !== undefined,
				neverLoaded: fallback === undefined
			};
		}
		const store = result.data;
		if (store.projects === undefined || store.projects === null || typeof store.projects !== "object" || Array.isArray(store.projects)) {
			store.projects = {};
		}
		lastGoodProjectStore = store;
		storeDegradedNoted = false;
		return { store: store, readonly: false, backupPath: result.backupPath, degraded: false, neverLoaded: false };
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

	/** 建一条无向互发线（同项目、自连跳过、幂等）。返回是否新建。 */
	function projectAddLink(project, a, b, kind) {
		if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "" || a === b) return false;
		if (!Array.isArray(project.links)) project.links = [];
		const pair = normalizeLinkPair(a, b);
		if (project.links.some((link) => link && link.a === pair[0] && link.b === pair[1])) return false;
		project.links.push({ a: pair[0], b: pair[1], kind: kind || "relay", createdAt: Date.now() });
		project.updatedAt = Date.now();
		return true;
	}

	/**
	 * 把一个会话登记为项目成员（v2.2 波次 2：组建方案确认 / 子会话自动入项目共用）。
	 * 已在本项目 → 不动；已属别的项目 → 不抢（一个对话只属于一个项目，§51.8）。
	 * extra: { addedBy, title?, parentSessionId?, linkTo? } —— linkTo 给出就顺手连一条互发线。
	 * 返回 "added" | "already" | "occupied"。
	 */
	function projectAdoptMember(store, project, sessionId, extra) {
		const opts = extra || {};
		if (!Array.isArray(project.members)) project.members = [];
		if (project.members.some((member) => member && member.sessionId === sessionId)) return "already";
		const occupied = projectOfSession(store, sessionId);
		if (occupied !== undefined && occupied.projectId !== project.projectId) return "occupied";
		project.members.push({
			sessionId: sessionId,
			role: "member",
			addedBy: typeof opts.addedBy === "string" ? opts.addedBy : "auto",
			joinedAt: Date.now(),
			...(typeof opts.title === "string" && opts.title !== "" ? { title: opts.title } : {}),
			...(typeof opts.parentSessionId === "string" && opts.parentSessionId !== "" ? { parentSessionId: opts.parentSessionId } : {})
		});
		if (typeof opts.linkTo === "string") projectAddLink(project, sessionId, opts.linkTo, opts.addedBy === "auto" ? "auto" : "relay");
		project.updatedAt = Date.now();
		return "added";
	}

	/** 宿主侧新建一个普通会话（组建方案确认用）：落在主对话所在的工作区；可选 preset。 */
	async function createConversationSession(get, project, conv) {
		const controller = typeof get === "function" ? get("sessionController") : undefined;
		if (!controller || typeof controller.create !== "function") throw new Error("sessionController.create unavailable");
		const workspaceId = sessionsByWorkspace(get).get(String(project.mainSessionId));
		const request = Object.assign({},
			typeof workspaceId === "string" && workspaceId !== "" ? { workspaceId: workspaceId } : {},
			typeof conv.agentPreset === "string" && conv.agentPreset !== "" ? { agentPreset: conv.agentPreset } : {});
		const created = await controller.create(request);
		const sessionId = created && typeof created.sessionId === "string" ? created.sessionId : "";
		if (sessionId === "") throw new Error("session create returned no id");
		return sessionId;
	}

	/**
	 * 子会话自动入项目（v2.2 波次 2）：会话目录里父会话是某项目成员、自己还不属于任何项目的，
	 * 自动登记进同一项目并与父会话连互发线；一路迭代到没有新增（孙会话跟着子会话进）。
	 * 用户手动移出过的（project.dismissed）不再拉回来。返回 [{projectId, sessionId, parentSessionId}]。
	 */
	async function adoptChildSessions(get) {
		const service = typeof get === "function" ? get("sessions") : undefined;
		if (!service) return [];
		let rows;
		try { rows = await sessionRowsOf(service); } catch (error) { return []; }
		const children = [];
		for (const row of rows) {
			const session = row && row.session ? row.session : {};
			const header = session.header !== undefined && session.header !== null && typeof session.header === "object" ? session.header : session;
			const parent = typeof header.parentSessionId === "string" ? header.parentSessionId
				: typeof header.parentSession === "string" ? header.parentSession : "";
			if (parent !== "" && typeof row.sessionId === "string" && row.sessionId !== "") children.push({ sessionId: row.sessionId, parent: parent, title: typeof session.title === "string" ? session.title : "" });
		}
		if (children.length === 0) return [];
		// 只读预检：大多数时候没有可收的子会话，别为了「什么都没变」去抢写锁、重写 store。
		const preview = readProjectStore().store;
		const candidate = children.some((child) => projectOfSession(preview, child.sessionId) === undefined && projectOfSession(preview, child.parent) !== undefined);
		if (!candidate) return [];
		const adopted = [];
		await mutateProject(function (store) {
			let changed = true;
			while (changed) {
				changed = false;
				for (const child of children) {
					if (projectOfSession(store, child.sessionId) !== undefined) continue;
					const project = projectOfSession(store, child.parent);
					if (project === undefined) continue;
					const dismissed = Array.isArray(project.dismissed) ? project.dismissed : [];
					if (dismissed.indexOf(child.sessionId) >= 0) continue;
					if (projectAdoptMember(store, project, child.sessionId, { addedBy: "auto", parentSessionId: child.parent, linkTo: child.parent, title: child.title }) === "added") {
						adopted.push({ projectId: project.projectId, sessionId: child.sessionId, parentSessionId: child.parent });
						changed = true;
					}
				}
			}
			return adopted;
		});
		return adopted;
	}

	/** 新项目记录（POST /projects 与「对话内即时建项目」共用一个形状）。 */
	function newProjectRecord(name, mainSessionId, goal, origin) {
		const now = Date.now();
		return {
			projectId: "proj-" + randomUUID(),
			name: name,
			mainSessionId: mainSessionId,
			members: [{ sessionId: mainSessionId, role: "main", addedBy: "auto", joinedAt: now }],
			links: [],
			brief: {
				version: 1,
				goal: typeof goal === "string" ? goal : "",
				decisions: [],
				constraints: [],
				updatedAt: now,
				updatedBy: "user"
			},
			...(origin === "conversation" ? { origin: "conversation" } : {}),
			createdAt: now,
			updatedAt: now
		};
	}

	/** 对话内即时建项目的名字：会话标题优先；没有标题（或是宿主默认标题）就用时间戳。 */
	function conversationProjectName(title) {
		const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
		if (text !== "" && !/^(新对话|新会话|new (chat|session|conversation)|untitled)$/i.test(text)) return text.length > 40 ? text.slice(0, 40) + "…" : text;
		const now = new Date();
		const pad = (value) => String(value).padStart(2, "0");
		return "对话画布 " + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
	}

	/** 会话的父链（子代理 / 分叉会话）：[自己, 父, 祖父, …, 根]，最多 8 层；顺带取每层标题。 */
	async function sessionLineage(get, sessionId) {
		const parents = new Map();
		const titles = new Map();
		const service = typeof get === "function" ? get("sessions") : undefined;
		if (service) {
			let rows = [];
			try { rows = await sessionRowsOf(service); } catch (error) { rows = []; }
			for (const row of rows) {
				const session = row && row.session ? row.session : {};
				const header = session.header !== undefined && session.header !== null && typeof session.header === "object" ? session.header : session;
				const parent = typeof header.parentSessionId === "string" ? header.parentSessionId
					: typeof header.parentSession === "string" ? header.parentSession : "";
				if (parent !== "") parents.set(row.sessionId, parent);
				const title = typeof session.title === "string" ? session.title : typeof header.title === "string" ? header.title : "";
				if (title !== "") titles.set(row.sessionId, title);
			}
		}
		const chain = [sessionId];
		while (chain.length < 8) {
			const parent = parents.get(chain[chain.length - 1]);
			if (typeof parent !== "string" || parent === "" || chain.indexOf(parent) >= 0) break;
			chain.push(parent);
		}
		return { chain: chain, titles: titles };
	}

	/**
	 * 对话内直接激活（不要求用户先建项目）：会话已在项目里 → 原样返回；
	 * 祖先会话在项目里 → 把这一支父链登记进那个项目（与子会话自动入项目同口径，尊重 dismissed）；
	 * 都不在 → 以根会话为主对话即时建一个项目（origin: "conversation"）。
	 * 返回 { project, created, joined }；被用户移出过的会话返回 { project: undefined, dismissedFrom }。
	 */
	async function ensureSessionProject(get, sessionId) {
		const existing = projectOfSession(readProjectStore().store, sessionId);
		if (existing !== undefined) return { project: existing, created: false, joined: false };
		const lineage = await sessionLineage(get, sessionId);
		const chain = lineage.chain;
		const root = chain[chain.length - 1];
		const name = conversationProjectName(lineage.titles.get(root));
		const adoptChain = (store, project, upto) => {
			for (let i = upto - 1; i >= 0; i -= 1) {
				projectAdoptMember(store, project, chain[i], { addedBy: "auto", parentSessionId: chain[i + 1], linkTo: chain[i + 1], title: lineage.titles.get(chain[i]) || "" });
			}
		};
		return mutateProject(function (store) {
			const now = projectOfSession(store, sessionId);
			if (now !== undefined) return { project: now, created: false, joined: false };
			for (let i = 1; i < chain.length; i += 1) {
				const project = projectOfSession(store, chain[i]);
				if (project === undefined) continue;
				const dismissed = Array.isArray(project.dismissed) ? project.dismissed : [];
				if (chain.slice(0, i).some((id) => dismissed.indexOf(id) >= 0)) return { project: undefined, dismissedFrom: project };
				adoptChain(store, project, i);
				return { project: project, created: false, joined: true };
			}
			const record = newProjectRecord(name, root, "", "conversation");
			store.projects[record.projectId] = record;
			adoptChain(store, record, chain.length - 1);
			return { project: record, created: true, joined: false };
		});
	}

	/** 项目 revision 的兼容取法：存量项目没有这个字段，按 0；首次写关联线时初始化并 +1。
	 *  用途是画布 agent 工具（link/unlink）的过期守卫，不是防丢更新——防丢更新由 withStoreLock 重读保证。 */
	function projectRevOf(project) {
		return project && Number.isFinite(project.revision) ? project.revision : 0;
	}

	function projectView(project) {
		return {
			projectId: project.projectId,
			name: project.name,
			mainSessionId: project.mainSessionId,
			members: Array.isArray(project.members) ? project.members : [],
			links: Array.isArray(project.links) ? project.links : [],
			// v2.2 波次 2：用户手动移出过的会话（子会话自动入项目不再拉回）。
			dismissed: Array.isArray(project.dismissed) ? project.dismissed : [],
			// 约束层：MCP 连接表。画布与 guard 共用这一份，不另存。
			mcpLinks: Array.isArray(project.mcpLinks) ? project.mcpLinks : [],
			// 对话内即时建的项目（whales_flow_draw / prototype_draw 首次调用）标 "conversation"；用户手建的没有这个字段。
			origin: project.origin === "conversation" ? "conversation" : "user",
			// 关联线的 CAS 需要可观测：画布 agent 工具（whales_canvas_link/unlink）靠它带 expectedRevision。
			revision: projectRevOf(project),
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
			return JSON.parse(await readRequestBody(req, ROUTE_BODY_LIMIT));
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
					const record = newProjectRecord(name, mainSessionId, payload.goal, "user");
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

		// v2.2 波次 4：文件 / 外部引用（只读、无 token）。
		if (route.kind === "references") {
			if (method !== "GET" && method !== "HEAD") {
				res.setHeader("allow", "GET, HEAD");
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			const read = readProjectStore();
			const project = read.store.projects[route.projectId];
			if (project === undefined) { sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found"); return; }
			const tasks = projectTasksOf(read.store, route.projectId);
			const refs = await projectReferences(get, project, tasks);
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", Object.assign({ projectId: route.projectId }, refs));
			return;
		}

		// v2.2 波次 3：画布上画「依赖线」（实线）= Agent 级依赖，落库为任务 blockedBy。
		// body: { from, to, action: "add" | "remove" }。add：to 名下未完成任务都等 from 名下未完成任务；
		// remove：to 名下任务去掉所有指向 from 名下任务的 blockedBy。成环整次拒绝（40705），不半写。
		if (route.kind === "dependencies") {
			if (method !== "POST") {
				res.setHeader("allow", "POST");
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			const payload = await readJsonBody(req);
			const from = payload && typeof payload.from === "string" ? payload.from.trim() : "";
			const to = payload && typeof payload.to === "string" ? payload.to.trim() : "";
			const action = payload && payload.action === "remove" ? "remove" : "add";
			if (from === "" || to === "" || from === to) {
				sendEnvelope(res, 400, PROJECT_CODE.param, "from and to are required and must differ");
				return;
			}
			try {
				const result = await mutateProject(function (store) {
					const project = store.projects[route.projectId];
					if (project === undefined) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					if (!projectIsMember(project, from) || !projectIsMember(project, to)) throw routeFailure(PROJECT_TASK_EXTRA.notMember, "both ends must be project members");
					const tasks = ensureProjectTasks(store);
					const inProject = Object.keys(tasks).map((id) => tasks[id]).filter((task) => task && task.projectId === route.projectId && task.status !== "deleted");
					const open = (task) => task.status !== "completed";
					const upstream = inProject.filter((task) => task.ownerSessionId === from);
					const downstream = inProject.filter((task) => task.ownerSessionId === to && open(task));
					const changed = [];
					if (action === "add") {
						const blockers = upstream.filter(open).map((task) => task.taskId);
						if (blockers.length === 0 || downstream.length === 0) {
							throw routeFailure(PROJECT_CODE.param, "两端都需要有未完成的任务，依赖才有落点（先给它们派任务）");
						}
						for (const task of downstream) {
							const before = Array.isArray(task.blockedBy) ? task.blockedBy : [];
							const next = before.concat(blockers.filter((id) => before.indexOf(id) < 0));
							if (next.length === before.length) continue;
							if (projectBlockedByWouldCycle(tasks, task.taskId, next)) throw routeFailure(PROJECT_TASK_EXTRA.cycle, "dependency cycle");
							changed.push({ task, next });
						}
					} else {
						const upstreamIds = upstream.map((task) => task.taskId);
						for (const task of downstream) {
							const before = Array.isArray(task.blockedBy) ? task.blockedBy : [];
							const next = before.filter((id) => upstreamIds.indexOf(id) < 0);
							if (next.length !== before.length) changed.push({ task, next });
						}
					}
					const now = Date.now();
					for (const row of changed) {
						row.task.blockedBy = row.next;
						row.task.revision = (Number.isFinite(row.task.revision) ? row.task.revision : 1) + 1;
						row.task.updatedAt = now;
					}
					if (changed.length > 0) project.updatedAt = now;
					return { action: action, from: from, to: to, changed: changed.map((row) => ({ taskId: row.task.taskId, blockedBy: row.task.blockedBy, revision: row.task.revision })) };
				});
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", result);
			} catch (error) {
				sendStoreError(ctx, res, error);
			}
			return;
		}

		// v2.2 波次 2：子会话自动入项目的兜底入口（画布发现有父会话在项目里的子会话时调）。
		if (route.kind === "adopt") {
			if (method !== "POST") {
				res.setHeader("allow", "POST");
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			const exists = readProjectStore().store.projects[route.projectId];
			if (exists === undefined) { sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found"); return; }
			try {
				const adopted = (await adoptChildSessions(get)).filter((row) => row.projectId === route.projectId);
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { projectId: route.projectId, adopted: adopted });
			} catch (error) {
				sendStoreError(ctx, res, error);
			}
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

		// 画布 Agent 卡「唤醒」（PRD 增量 §4.6 · 波次 D）：把离线成员拉上线。
		// 范围闸：只放本项目已登记的成员（含主对话），不暴露全局 resume 能力；
		// 单次单会话、不批量、不派任务——唤醒不等于开工。业务失败一律 HTTP 200 + 非 200 业务码，原因如实回给人。
		if (route.kind === "resume") {
			if (method !== "POST") {
				res.setHeader("allow", "POST");
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
			const project = readProjectStore().store.projects[route.projectId];
			if (project === undefined) {
				sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found");
				return;
			}
			if (!projectIsMember(project, sessionId)) {
				sendEnvelope(res, 200, PROJECT_CODE.notMember, "session is not a member of this project");
				return;
			}
			if (!(await sessionExists(get, sessionId))) {
				sendEnvelope(res, 200, PROJECT_CODE.notFound, "session not found");
				return;
			}
			try {
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", await resumeSessionById(get, sessionId));
			} catch (error) {
				warn(ctx, "project resume", error);
				sendEnvelope(res, 200, PROJECT_CODE.resumeFailed, errorMessage(error).slice(0, 300));
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
					if (Array.isArray(project.dismissed)) project.dismissed = project.dismissed.filter((id) => id !== sessionId);
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
					// 手动移出的记下来：子会话自动入项目不再把它拉回来（v2.2 波次 2）。
					if (!Array.isArray(project.dismissed)) project.dismissed = [];
					if (project.dismissed.indexOf(route.sessionId) < 0) project.dismissed.push(route.sessionId);
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
		// ── 3b3) 约束层：MCP 连接表（连接即授权）──
		//
		// GET 读：可用 MCP 服务 + 已连接的 + 项目成员（画布画节点与连线要用这三样）。
		// POST {server, sessionId}：连。前置校验——服务必须真的在 tools 里，会话必须是项目成员。
		// DELETE {server, sessionId}：断一条。DELETE ?all=1：一键全清（保险 2）。
		if (route.kind === "mcp-links") {
			const readProject = () => {
				const read = readProjectStore();
				return read.store && read.store.projects ? read.store.projects[route.projectId] : undefined;
			};
			if (method === "GET" || method === "HEAD") {
				const project = readProject();
				if (project === undefined) { sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found"); return; }
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", {
					projectId: route.projectId,
					available: availableMcpServers(get),
					links: Array.isArray(project.mcpLinks) ? project.mcpLinks : [],
					members: Array.isArray(project.members) ? project.members : [],
					mainSessionId: project.mainSessionId
				});
				return;
			}
			if (method !== "POST" && method !== "DELETE") {
				res.setHeader("allow", "GET, HEAD, POST, DELETE");
				sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
				return;
			}
			if (!projectWriteGuard(res, req, control)) return;
			const payload = await readJsonBody(req);
			const query = new URL(String((req && req.url) || "/"), "http://localhost").searchParams;
			const clearAll = method === "DELETE" && (query.get("all") === "1" || query.get("all") === "true");
			if (method === "DELETE" && !clearAll && (payload === undefined || payload === null || typeof payload !== "object")) {
				sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body");
				return;
			}
			const server = payload && typeof payload.server === "string" ? payload.server.trim() : "";
			const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
			try {
				const result = await mutateProject(function (store) {
					const project = store.projects[route.projectId];
					if (project === undefined) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					if (!Array.isArray(project.mcpLinks)) project.mcpLinks = [];
					if (clearAll) {
						const removed = project.mcpLinks.length;
						project.mcpLinks = [];
						project.updatedAt = Date.now();
						return { project: projectView(project), cleared: removed };
					}
					if (server === "" || sessionId === "") throw routeFailure(PROJECT_CODE.param, "server and sessionId are required");
					// 前置校验：连一个不存在的服务等于连了个寂寞，拒。
					const known = availableMcpServers(get).some((row) => row.server === server);
					if (!known) throw routeFailure(PROJECT_CODE.mcpUnknown, "mcp server not available: " + server);
					const isMember = sessionId === project.mainSessionId || (Array.isArray(project.members) && project.members.some((m) => m && m.sessionId === sessionId));
					if (!isMember) throw routeFailure(PROJECT_CODE.mcpNotMember, "session is not a project member");
					const existing = project.mcpLinks.findIndex((link) => link && link.server === server && link.sessionId === sessionId);
					if (method === "POST") {
						if (existing < 0) {
							project.mcpLinks.push({ server, sessionId, createdAt: Date.now() });
							project.updatedAt = Date.now();
						}
						return { project: projectView(project), already: existing >= 0 };
					}
					if (existing >= 0) {
						project.mcpLinks.splice(existing, 1);
						project.updatedAt = Date.now();
					}
					return { project: projectView(project), removed: existing >= 0 };
				});
				mcpIndexDirty = true; // 自己的写，立刻让 guard 看到
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
		notLinked: 40707,
		// M6：handed_back/human_action 的退回结论只能人改，worker 只能发起不能关闭。
		reportHumanOnly: 40708
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
		// 只读降级：有最后一次成功快照就继续按快照判定；从启动起就没成功读过才放行并标 degraded。
		if (read.readonly && read.neverLoaded === true) return { ok: true, degraded: true };
		const degraded = read.readonly === true;
		const caller = typeof callerSessionId === "string" ? callerSessionId.trim() : "";
		const target = typeof targetSessionId === "string" ? targetSessionId.trim() : "";
		if (caller === "" || target === "") return { ok: true, degraded: degraded };
		const callerProject = projectOfSession(read.store, caller);
		const targetProject = projectOfSession(read.store, target);
		if (callerProject === undefined && targetProject === undefined) return { ok: true, legacy: true, degraded: degraded };
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
		return { ok: true, degraded: degraded };
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

	/** 人（UI）发起的消息：来源如实标 user，不伪装成任何对话。 */
	function humanMessage(text) {
		return { id: randomUUID(), role: "user", content: [{ type: "text", text: text }], source: { kind: "user" } };
	}

	// ── S1/M4 交接账本：独立文件 handoffs.json（与项目 store 解耦，不抢同一把锁）──
	const HANDOFFS_SUFFIX = "handoffs.json";
	const HANDOFFS_MAX_ENTRIES = 2000;
	let HANDOFFS_STORE_OVERRIDE;
	function handoffsStoreFile() {
		return HANDOFFS_STORE_OVERRIDE || join(PROPOSAL_STORE_DIR, HANDOFFS_SUFFIX);
	}
	/** 仅供离线测试：把账本指到临时路径。 */
	export function setHandoffsStorePathForTests(file) {
		if (typeof file === "string" && file !== "") HANDOFFS_STORE_OVERRIDE = file;
	}
	let handoffMutationChain = Promise.resolve();
	function mutateHandoffs(fn) {
		const run = handoffMutationChain.then(function () {
			const file = handoffsStoreFile();
			const read = readStoreFile(file);
			if (read.readonly) throw new StoreReadonlyError(file, read.backupPath);
			const store = read.data;
			if (store.entries === undefined || !Array.isArray(store.entries)) store.entries = [];
			// 超上限按文件滚动（改名归档、开新文件），不静默删除。
			if (store.entries.length >= HANDOFFS_MAX_ENTRIES) {
				const archive = file + ".rotated-" + Date.now() + ".json";
				try {
					renameSync(file, archive);
				} catch (error) {
					/* 归档失败就继续追加，绝不丢已登记的事实 */
				}
				store.entries = [];
			}
			const value = fn(store);
			return writeStoreFile(file, store).then(function () {
				return value;
			});
		});
		handoffMutationChain = run.then(function () {}, function () {});
		return run;
	}
	/** 登记一次跨会话发送事实；失败要 warn，不能吞掉。 */
	function recordSend(ctx, fromSessionId, toSessionId, kind, messageId, extra) {
		return mutateHandoffs(function (store) {
			store.entries.push(Object.assign({ kind: kind, from: fromSessionId, to: toSessionId, messageId: messageId, at: Date.now() }, extra === undefined ? {} : extra));
			return undefined;
		}).catch(function (error) {
			warn(ctx, "handoff record", error);
		});
	}

	// ── 3b4) W1.5 事件台：events.json（与 handoffs.json 同目录、同 store 层）────
	//
	// 诚实的来源边界（写进代码，不假装）：本期事件只来自**插件自己已经拥有的事实**——
	// 提案提交、任务命令、交接结果异常、store 只读降级。PRD 里的「主会话消息 /
	// 工作区文件监听 / 定时」三类 Source 本期不接（没有可靠的会话消息钩子；fs 监听
	// 要做自身状态目录排除与泄漏防护，留后续），所以事件台展示的是插件内部 trigger，
	// 不是宿主全局事件流。main-session / workspace / schedule 三个词表值保留给
	// 客户端筛选器（T-11 的源筛选项），本期不产事件。

	const EVENTS_SUFFIX = "events.json";
	const EVENTS_MAX_ENTRIES = 2000;
	/** 事件原文/证据的存储上限：与 REPORT_SUMMARY_LIMIT 同级的存储护栏，不是语义摘要。 */
	const EVENT_FIELD_LIMIT = 4000;
	/** 开工单主题的截断长度（T-11 展开态第一行就是它）。 */
	const EVENT_SUBJECT_LIMIT = 60;
	/** 自激保护窗口：同类事件 10 分钟内只评估一次（PRD §56.2 第 7 条）。 */
	const EVENT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
	/** 噪声屏蔽时长：被标记为噪声的 Source 24 小时不进收件箱（PRD §56.2 第 7 条）。 */
	const EVENT_NOISE_MUTE_MS = 24 * 60 * 60 * 1000;
	/** Source 词表：plugin 是本期唯一真实来源，其余三个保留给筛选器（本期不产事件）。 */
	const EVENT_SOURCE_LIST = ["plugin", "main-session", "workspace", "schedule"];
	const EVENT_KIND_LIST = ["proposal.submit", "task.command", "handoff.result", "store.degraded"];
	const EVENT_STATE_LIST = ["pending", "opened", "ignored", "suppressed", "noise"];
	/** Source 健康码固定词表（PRD §56.2 第 6 条：只用这五个词，不写自由文案）。 */
	const EVENT_HEALTH_LIST = ["ready", "assessing", "suppressed", "noise", "idle"];
	const EVENT_ACTION_LIST = ["open", "ignore", "noise"];

	let EVENTS_STORE_OVERRIDE;
	function eventsStoreFile() {
		return EVENTS_STORE_OVERRIDE || join(PROPOSAL_STORE_DIR, EVENTS_SUFFIX);
	}
	/** 仅供离线测试：把事件台指到临时路径（与 handoffs 同一规矩）。 */
	export function setEventsStorePathForTests(file) {
		if (typeof file === "string" && file !== "") EVENTS_STORE_OVERRIDE = file;
	}
	let eventMutationChain = Promise.resolve();
	/**
	 * 事件台账的「读-改-写」串行队列：与 mutateHandoffs 同一模式（自绵队列），
	 * 绝不和项目 store 抢同一把锁——事件记账慢一步不该堵住项目写。
	 */
	function mutateEvents(fn) {
		const run = eventMutationChain.then(function () {
			const file = eventsStoreFile();
			const read = readStoreFile(file);
			// 只读降级：拒绝写入但不把异常抛给调用方（由 ingestEvent 的 catch 收成 warn）。
			if (read.readonly) throw new StoreReadonlyError(file, read.backupPath);
			const store = read.data;
			if (store.events === undefined || store.events === null || typeof store.events !== "object" || Array.isArray(store.events)) store.events = {};
			if (store.noise === undefined || store.noise === null || typeof store.noise !== "object" || Array.isArray(store.noise)) store.noise = {};
			store.version = 1;
			// 超上限按文件滚动（改名归档、开新文件），不静默删除（与 handoffs 同一规矩）。
			if (Object.keys(store.events).length >= EVENTS_MAX_ENTRIES) {
				const archive = file + ".rotated-" + Date.now() + ".json";
				try {
					renameSync(file, archive);
				} catch (error) {
					/* 归档失败就继续追加，绝不丢已登记的事实 */
				}
				store.events = {};
			}
			const value = fn(store);
			return writeStoreFile(file, store).then(function () {
				return value;
			});
		});
		eventMutationChain = run.then(function () {}, function () {});
		return run;
	}

	/** 指纹 = kind + "|" + 归一化 text 前 80 字（归一化 = 去首尾空白、内部空白压成一格）。 */
	function eventFingerprintOf(kind, text) {
		const normalized = String(text === undefined || text === null ? "" : text).trim().replace(/\s+/g, " ").slice(0, 80);
		return kind + "|" + normalized;
	}

	/** 同 fingerprint 且在过去 10 分钟内的事件（自激保护：同类只评估一次）。 */
	function recentEventOf(events, fingerprint, now) {
		for (const event of Object.values(events)) {
			if (!event || event.fingerprint !== fingerprint) continue;
			const at = typeof event.at === "number" ? event.at : 0;
			if (now - at <= EVENT_DEDUPE_WINDOW_MS) return event;
		}
		return undefined;
	}

	/** 项目成员口径：主对话 + members（创建时主对话会自动进 members，这里仍兜一手）。 */
	function eventParticipantsOf(project) {
		const participants = [];
		if (typeof project.mainSessionId === "string" && project.mainSessionId !== "") participants.push(project.mainSessionId);
		if (Array.isArray(project.members)) {
			for (const member of project.members) {
				if (member && typeof member.sessionId === "string" && member.sessionId !== "" && participants.indexOf(member.sessionId) < 0) participants.push(member.sessionId);
			}
		}
		return participants;
	}

	/**
	 * 三条评估规则（纯函数：只读事件本身 + 两个 store，结果落 event.rules）。
	 * "hit" 的语义统一为「这条规则支持开工单」：
	 *   - rule: scope.match   有项目上下文且原文出现项目名/任一成员会话 id；
	 *   - rule: assignable    该项目存在当前没有 in_progress 任务的成员（main 也算成员）；
	 *   - rule: dedupe        没有同 kind（同项目口径）的 pending 事件；有 → 未命中。
	 * 没有项目上下文时 scope/assignable 记「无项目上下文」未命中，dedupe 照算。
	 */
	function evaluateEventRules(event, projectId, eventsStore, projectStore) {
		const rules = [];
		const scope = projectId === null ? null : projectId;
		const project = projectStore === undefined ? undefined : projectStore.projects[projectId];
		if (projectId === null) {
			rules.push({ name: "rule: scope.match", hit: false, detail: "无项目上下文" });
		} else if (project === undefined) {
			rules.push({ name: "rule: scope.match", hit: false, detail: "项目不存在（或 store 降级）" });
		} else {
			const participants = eventParticipantsOf(project);
			const hitName = typeof project.name === "string" && project.name !== "" && event.text.indexOf(project.name) >= 0 ? project.name : undefined;
			const hitId = hitName === undefined ? participants.find((id) => event.text.indexOf(id) >= 0) : undefined;
			if (hitName !== undefined) rules.push({ name: "rule: scope.match", hit: true, detail: "命中项目名「" + hitName + "」" });
			else if (hitId !== undefined) rules.push({ name: "rule: scope.match", hit: true, detail: "命中成员会话 " + hitId });
			else rules.push({ name: "rule: scope.match", hit: false, detail: "原文未出现项目名或成员会话 id" });
		}
		if (project === undefined) {
			rules.push({ name: "rule: assignable", hit: false, detail: projectId === null ? "无项目上下文" : "项目不存在（或 store 降级）" });
		} else {
			const participants = eventParticipantsOf(project);
			const tasks = projectStore.tasks !== undefined && projectStore.tasks !== null && typeof projectStore.tasks === "object" ? projectStore.tasks : {};
			const busy = new Set();
			for (const task of Object.values(tasks)) {
				if (!task || task.projectId !== project.projectId || task.status !== "in_progress") continue;
				if (typeof task.ownerSessionId === "string" && task.ownerSessionId !== "") busy.add(task.ownerSessionId);
			}
			const free = participants.filter((id) => busy.has(id) === false);
			if (free.length > 0) rules.push({ name: "rule: assignable", hit: true, detail: free.length + "/" + participants.length + " 个成员当前没有 in_progress 任务" });
			else rules.push({ name: "rule: assignable", hit: false, detail: participants.length + " 个成员全部有 in_progress 任务" });
		}
		let sameKindPending = 0;
		for (const other of Object.values(eventsStore.events)) {
			if (!other || other.eventId === event.eventId || other.kind !== event.kind || other.state !== "pending") continue;
			const otherScope = typeof other.projectId === "string" && other.projectId !== "" ? other.projectId : null;
			if (otherScope === scope) sameKindPending += 1;
		}
		if (sameKindPending > 0) rules.push({ name: "rule: dedupe", hit: false, detail: "已有 " + sameKindPending + " 条同 kind 待评估事件" });
		else rules.push({ name: "rule: dedupe", hit: true, detail: "无同类待评估事件" });
		return rules;
	}

	/**
	 * 登记一条事件并当场评估（事件台唯一入口；接线点与动作回写都走这里）。
	 *
	 * 全部同步、锁内完成，趁事实还热；任何失败只 warn——事实已经发生，不能因为
	 * 记账失败把主流程带崩。返回 Promise 便于测试 await，但绝不 reject。
	 *
	 * 流程：噪声闸 → 自激保护（去重）→ pending + 三条规则当场评估 → 写 store。
	 */
	function ingestEvent(ctx, input) {
		let source;
		let kind;
		let text;
		let evidence;
		let projectId;
		try {
			if (!input || typeof input !== "object") throw new Error("event input must be an object");
			source = typeof input.source === "string" ? input.source.trim() : "";
			kind = typeof input.kind === "string" ? input.kind.trim() : "";
			text = typeof input.text === "string" ? input.text : "";
			evidence = typeof input.evidence === "string" ? input.evidence : "";
			if (EVENT_SOURCE_LIST.indexOf(source) < 0) throw new Error("unsupported event source: " + source);
			if (EVENT_KIND_LIST.indexOf(kind) < 0) throw new Error("unsupported event kind: " + kind);
			projectId = typeof input.projectId === "string" && input.projectId.trim() !== "" ? input.projectId.trim() : null;
		} catch (error) {
			warn(ctx, "event ingest", error);
			return Promise.resolve(undefined);
		}
		const fingerprint = eventFingerprintOf(kind, text);
		const safeText = text.slice(0, EVENT_FIELD_LIMIT);
		const safeEvidence = evidence.slice(0, EVENT_FIELD_LIMIT);
		return mutateEvents(function (store) {
			const now = Date.now();
			const event = {
				eventId: "evt-" + randomUUID(),
				projectId: projectId,
				source: source,
				kind: kind,
				text: safeText,
				evidence: safeEvidence,
				fingerprint: fingerprint,
				at: now,
				state: "pending",
				rules: []
			};
			// 1) 噪声闸：该 Source 被标记为噪声且未过期 → 直接记 noise，不进待评估、不评估规则。
			const mutedUntil = typeof store.noise[source] === "number" ? store.noise[source] : 0;
			if (mutedUntil > now) {
				event.state = "noise";
				store.events[event.eventId] = event;
				return event;
			}
			// 2) 自激保护：同 fingerprint 10 分钟内已有事件 → suppressed（留痕，不算 pending）。
			if (recentEventOf(store.events, fingerprint, now) !== undefined) {
				event.state = "suppressed";
				store.events[event.eventId] = event;
				return event;
			}
			// 3) pending：三条规则当场评估。项目 store 只读降级时用最后一次成功快照判边界。
			const projectRead = projectId === null ? undefined : readProjectStore();
			event.rules = evaluateEventRules(event, projectId, store, projectRead === undefined ? undefined : projectRead.store);
			store.events[event.eventId] = event;
			return event;
		}).catch(function (error) {
			// events.json 自己损坏/只读：记账失败静默收场，主流程不受影响。
			warn(ctx, "event ingest", error);
			return undefined;
		});
	}

	/** 提案正文的逐字组合（供 proposal.submit 事件用）：每项一行「key · title」+ 描述原样，不摘要。 */
	function proposalBodyText(items) {
		return items
			.map((item) => String(item.key) + " · " + String(item.title) + (item.description === "" || item.description === undefined ? "" : "\n" + String(item.description)))
			.join("\n");
	}

	/** 事件 → 客户端视图（fingerprint 是内部去重字段，不下发）。 */
	function eventView(event) {
		if (!event || typeof event !== "object") return undefined;
		return {
			eventId: event.eventId,
			projectId: typeof event.projectId === "string" && event.projectId !== "" ? event.projectId : null,
			source: event.source,
			kind: event.kind,
			text: typeof event.text === "string" ? event.text : "",
			evidence: typeof event.evidence === "string" ? event.evidence : "",
			fingerprint: typeof event.fingerprint === "string" ? event.fingerprint : "",
			at: typeof event.at === "number" ? event.at : 0,
			state: EVENT_STATE_LIST.indexOf(event.state) >= 0 ? event.state : "pending",
			rules: Array.isArray(event.rules) ? event.rules.filter((rule) => rule && typeof rule === "object") : [],
			...(typeof event.ticketId === "string" ? { ticketId: event.ticketId } : {}),
			...(typeof event.decidedAt === "number" ? { decidedAt: event.decidedAt } : {}),
			...(typeof event.decidedBy === "string" ? { decidedBy: event.decidedBy } : {})
		};
	}

	/** 今天 00:00（插件跑在用户机器上，按本机时区；"今日"口径与 UI 一致）。 */
	function startOfToday(now) {
		const day = new Date(now);
		day.setHours(0, 0, 0, 0);
		return day.getTime();
	}

	/** 读事件台账快照（损坏/只读都已由 readStoreFile 兜底为空表，绝不抛）。 */
	function readEventsStore() {
		const read = readStoreFile(eventsStoreFile());
		const rawEvents = read.data.events;
		const rawNoise = read.data.noise;
		const events = rawEvents !== undefined && rawEvents !== null && typeof rawEvents === "object" && !Array.isArray(rawEvents) ? rawEvents : {};
		const noise = rawNoise !== undefined && rawNoise !== null && typeof rawNoise === "object" && !Array.isArray(rawNoise) ? rawNoise : {};
		return { events: Object.values(events).filter((event) => event && typeof event === "object"), noise: noise, readonly: read.readonly === true };
	}

	/** 项目口径：不带 projectId = 跨全部项目（与 handoffs 同口径）。 */
	function eventsInScope(events, projectId) {
		return projectId === "" ? events : events.filter((event) => event.projectId === projectId);
	}

	/**
	 * 单个 Source 的健康码（固定词表，PRD §56.2 第 6 条）。
	 * 判定顺序（先命中先返回）：噪声未过期 → 有 pending → 近 10 分钟有 suppressed
	 * → 今天没有事件 → ready。today/suppressed 两个计数是给右侧栏「自激保护」列用的。
	 */
	function eventHealthRowOf(events, source, noise, now, dayStart) {
		let pending = 0;
		let today = 0;
		let suppressedRecent = 0;
		let lastAt = 0;
		for (const event of events) {
			if (event.source !== source) continue;
			const at = typeof event.at === "number" ? event.at : 0;
			if (at > lastAt) lastAt = at;
			if (at >= dayStart) today += 1;
			if (event.state === "pending") pending += 1;
			if (event.state === "suppressed" && now - at <= EVENT_DEDUPE_WINDOW_MS) suppressedRecent += 1;
		}
		const mutedUntil = typeof noise[source] === "number" ? noise[source] : 0;
		const muted = mutedUntil > now;
		let state = "ready";
		if (muted) state = "noise";
		else if (pending > 0) state = "assessing";
		else if (suppressedRecent > 0) state = "suppressed";
		else if (today === 0) state = "idle";
		return {
			source: source,
			state: state,
			pending: pending,
			today: today,
			suppressed: suppressedRecent,
			lastAt: lastAt,
			...(muted ? { mutedUntil: mutedUntil } : {})
		};
	}

	/** 健康面板：四个词表 Source 恒在（否则看不出 idle），store 里出现的额外来源追加在后。 */
	function eventHealthOf(events, noise, now) {
		const dayStart = startOfToday(now);
		const sources = EVENT_SOURCE_LIST.slice();
		for (const event of events) {
			if (typeof event.source === "string" && sources.indexOf(event.source) < 0) sources.push(event.source);
		}
		return sources.map((source) => eventHealthRowOf(events, source, noise, now, dayStart));
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
		// report / worktree / execRoot 是 M6 工单字段：没有就明确给 null（前端显示 "—"）。
		// 不用 undefined：JSON 里「缺键」与「显式 null」在客户端是两条判断分支，混用会漏渲染。
		return Object.assign({}, task, {
			ready: ready,
			report: task.report === undefined || task.report === null ? null : task.report,
			worktree: typeof task.worktree === "string" && task.worktree !== "" ? task.worktree : null,
			execRoot: typeof task.execRoot === "string" && task.execRoot !== "" ? task.execRoot : null
		}, blockedReason === undefined ? {} : { blockedReason: blockedReason }, { writeScopeWarnings: warnings });
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
		// M6 落点字段：缺省不写（老任务视图里就是 null）；本期只存不建目录。
		// 入库前归一（尾分隔符/./重复分隔符 + 已存在时 realpath）：画布上下文节点按落点
		// 去重，同一个目录的两种写法会被拆成两个节点——「活在哪跑」由此失真。
		const worktree = canonicalLandingPath(input.worktree);
		const execRoot = canonicalLandingPath(input.execRoot);
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
			...(worktree === "" ? {} : { worktree: worktree }),
			...(execRoot === "" ? {} : { execRoot: execRoot }),
			...(input.sourceProposal === undefined ? {} : { sourceProposal: input.sourceProposal })
		};
		tasks[taskId] = task;
		return { task: task };
	}

	/**
	 * Q4「规划时提示」：两条任务的写入范围重叠、且彼此没有先后顺序时，给出
	 * 「建议补一条依赖」的提示。**只提示，不拦截、不改状态**——同步页结论：
	 * 不做依赖豁免（有顺序的重叠是真冲突，豁免会把它藏掉），也不强制。
	 * 没有可提示的返回 ""。
	 */
	function projectScopeOrderHint(store, project, task, owner) {
		const scopes = Array.isArray(task.writeScopes) ? task.writeScopes.filter(function (one) { return typeof one === "string" && one.trim() !== ""; }) : [];
		if (scopes.length === 0 || owner === "") return "";
		const tasks = store.tasks && typeof store.tasks === "object" ? store.tasks : {};
		const others = Object.keys(tasks).filter(function (id) { return id !== task.taskId; }).map(function (id) { return tasks[id]; }).filter(function (one) { return one && one.status !== "deleted" && one.status !== "completed" && typeof one.ownerSessionId === "string" && one.ownerSessionId !== "" && one.ownerSessionId !== owner; });
		const hits = [];
		for (const other of others) {
			const otherScopes = Array.isArray(other.writeScopes) ? other.writeScopes : [];
			let overlap = false;
			for (const a of scopes) {
				for (const b of otherScopes) {
					if (typeof a !== "string" || typeof b !== "string") continue;
					if (a.trim() === "" || b.trim() === "") continue;
					if (a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0) overlap = true;
				}
			}
			if (!overlap) continue;
			// 有先后顺序（任一方阻塞另一方）→ 不是并发冲突，不提示
			const blocked = Array.isArray(task.blockedBy) ? task.blockedBy : [];
			const otherBlocked = Array.isArray(other.blockedBy) ? other.blockedBy : [];
			if (blocked.indexOf(other.taskId) >= 0 || otherBlocked.indexOf(task.taskId) >= 0) continue;
			hits.push(String(other.taskId) + "（" + (typeof other.subject === "string" && other.subject !== "" ? other.subject : String(other.ownerSessionId)) + "）");
		}
		if (hits.length === 0) return "";
		return "写入范围与 " + hits.join("、") + " 重叠，且没有先后顺序；建议补一条依赖（blockedBy），否则两者可能同时改同一处";
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
		let scopeOrderHint = "";
		if (action === "assign") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			task.ownerSessionId = owner;
			task.status = "in_progress";
			scopeOrderHint = projectScopeOrderHint(store, project, task, owner);
			bump();
		} else if (action === "assign-and-dispatch") {
			if (task.status === "completed" || task.status === "deleted") return { code: TASK_CODE.taskClosed, msg: "task is closed" };
			task.ownerSessionId = owner;
			task.status = "in_progress";
			needsDispatch = true;
			scopeOrderHint = projectScopeOrderHint(store, project, task, owner);
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
		} else if (action === "verify") {
			// Q3「已核对」：人工核对是独立字段，**不并入任务状态**。
			// 只有项目主对话能核对（人通过主对话行事；worker 不能自核）。
			// 只能核对已报完工的任务——没报完工就谈不上核。
			const caller = typeof payload.callerSessionId === "string" ? payload.callerSessionId.trim() : "";
			if (caller === "" || caller !== project.mainSessionId) {
				return { code: PROJECT_TASK_EXTRA.reportHumanOnly, msg: "only the project main session can verify a task" };
			}
			if (!task.report || typeof task.report !== "object" || task.report.status !== "done") {
				return { code: TASK_CODE.taskClosed, msg: "only a task whose report is done can be verified" };
			}
			const note = typeof payload.note === "string" ? payload.note.trim() : "";
			task.verified = { by: caller, at: now, note: note };
			bump();
		} else {
			return { code: TASK_CODE.param, msg: "unsupported action" };
		}
		return {
			code: TASK_CODE.ok,
			msg: "success",
			data: { source: "project", task: projectTaskView(store, task), verified: task.verified === undefined ? null : { by: String(task.verified.by || ""), at: Number(task.verified.at || 0), note: String(task.verified.note || "") } },
			needsDispatch: needsDispatch,
			// Q4：只提示不拦截；没有可提示的就不带这个字段（不制造空字段噪音）
			...(scopeOrderHint === "" ? {} : { scopeOrderHint: scopeOrderHint }),
			snapshot: { taskId: task.taskId, subject: task.subject, ownerSessionId: task.ownerSessionId, projectId: project.projectId, revision: task.revision }
		};
	}
	/**
	 * 项目任务的派发：人（UI）发起，来源如实标 user，并带上任务引用（taskId/revision/projectId）。
	 * 访问闸只管「对话发起」的动作；人发起的派发不过闸。
	 * 以后若加「对话通过工具派发」，那一条再用 exec 身份过闸、标真实对话。
	 */
	async function dispatchProjectTask(ctx, get, task, timeoutMs) {
		const owner = task && typeof task.ownerSessionId === "string" ? task.ownerSessionId : "";
		if (owner === "") return Promise.resolve({ status: "not-requested", reason: "no-owner" });
		const agent = liveAgent(get, owner);
		if (agent === undefined) return Promise.resolve({ status: "failed", reason: "owner-not-running" });
		const effectiveTimeoutMs = typeof timeoutMs === "number" && timeoutMs >= 10 ? Math.min(timeoutMs, TASK_DISPATCH_TIMEOUT_MS) : TASK_DISPATCH_TIMEOUT_MS;
		let expired = false;
		const timeoutMarker = new Promise((resolve) => {
			const timer = setTimeout(() => {
				expired = true;
				resolve({ timedOut: true });
			}, effectiveTimeoutMs);
			if (timer && typeof timer.unref === "function") timer.unref();
		});
		const refs = "任务：" + String(task.taskId) + " · revision " + String(task.revision) + " · 项目 " + String(task.projectId);
		const message = humanMessage("开始任务：" + String(task.subject || task.taskId) + "\n" + refs);
		/**
		 * 交接结果异常（unknown / failed）才进事件台：成功发送已在 M6-4 账本（事后账本），
		 * 不必再进事件台。no-owner / owner-not-running 是投递前校验失败，消息都没造出来，
		 * 不算交接结果，不登记。await 它：ingestEvent 绝不抛，失败只在内部 warn。
		 */
		const noteHandoffResult = async function (status, reason) {
			try {
				await ingestEvent(ctx, {
					source: "plugin",
					kind: "handoff.result",
					text: "dispatch " + message.id,
					evidence: message.id,
					projectId: task.projectId
				});
			} catch (error) {
				warn(ctx, "event ingest", error);
			}
			return { status: status, reason: reason };
		};
		try {
			const sent = await Promise.race([
				Promise.resolve().then(async function () {
					if (typeof agent.followup !== "function") throw new Error("followup unavailable");
					// 真实 agent.followup 是同步 void；测试/包装实现可能返回 Promise，这里统一等到它 settle。
					await Promise.resolve(agent.followup(message));
					return { ok: true };
				}),
				timeoutMarker
			]);
			if (expired || (sent && sent.timedOut === true)) return noteHandoffResult("unknown", "dispatch-timeout");
			await recordSend(ctx, "user", owner, "dispatch", message.id, { taskId: task.taskId, revision: task.revision, projectId: task.projectId });
			return { status: "sent", messageId: message.id };
		} catch (error) {
			const detail = error && error.message ? String(error.message) : "";
			if (/timeout|timed out|etimedout/i.test(detail)) return noteHandoffResult("unknown", "dispatch-timeout");
			return noteHandoffResult("failed", "dispatch-rejected");
		}
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
		// §51.4 组建方案：先建对话 → 建关联 → 建任务（逐项结果，不假装全部原子成功）。
		// 重试同版本时跳过已建的对话（confirmed.conversations 记着 key → sessionId）。
		const conversationRows = Array.isArray(record.conversations) ? record.conversations : [];
		const createdConversations = sameVersion && Array.isArray(record.confirmed.conversations) ? record.confirmed.conversations.slice() : [];
		const sessionOfKey = { main: project.mainSessionId };
		createdConversations.forEach((row) => { sessionOfKey[row.key] = row.sessionId; });
		for (const conv of conversationRows) {
			if (sessionOfKey[conv.key] !== undefined) continue;
			try {
				const sessionId = await createConversationSession(get, project, conv);
				sessionOfKey[conv.key] = sessionId;
				createdConversations.push({ key: conv.key, sessionId: sessionId, title: conv.title });
				projectAdoptMember(read.store, project, sessionId, { addedBy: "proposal", title: conv.title, linkTo: project.mainSessionId });
				if (typeof conv.duty === "string" && conv.duty.trim() !== "") {
					writeConversationBrief(read.store, sessionId, project.projectId, { duty: conv.duty }, "user", true);
				}
			} catch (error) {
				pending.set("conversation:" + conv.key, { status: "failed", message: error && error.message ? String(error.message) : "create conversation failed" });
			}
		}
		for (const link of Array.isArray(record.links) ? record.links : []) {
			const a = sessionOfKey[link.a];
			const b = sessionOfKey[link.b];
			if (typeof a !== "string" || typeof b !== "string") {
				pending.set("link:" + link.a + "~" + link.b, { status: "blocked", message: "对话未建成，关联跳过" });
				continue;
			}
			projectAddLink(project, a, b, "proposal");
		}
		/** suggestedOwner：对话 key → 新对话；已是项目成员的 sessionId → 原样；其余只当建议不写。 */
		function ownerOf(item) {
			const raw = typeof item.suggestedOwner === "string" ? item.suggestedOwner.trim() : "";
			if (raw === "") return null;
			if (typeof sessionOfKey[raw] === "string") return sessionOfKey[raw];
			return projectIsMember(project, raw) ? raw : null;
		}
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
				// 组建方案里指给某个对话的任务：确认即指派（只写 owner，不派发——确认不等于开工）。
				const owner = ownerOf(item);
				if (owner !== null) outcome.task.ownerSessionId = owner;
				created.push({ key: key, taskId: outcome.task.taskId, revision: outcome.task.revision, ...(owner === null ? {} : { ownerSessionId: owner }) });
			}
			const failedList = pending.size === 0
				? undefined
				: Array.from(pending.entries()).map(([key, row]) => ({ key: key, status: row.status, message: row.message }));
			return { code: TASK_CODE.ok, msg: "success", http: 200, data: { source: "project", proposalId: proposalId, version: version, created: created, ...(createdConversations.length > 0 ? { conversations: createdConversations } : {}), ...(failedList === undefined ? {} : { failed: failedList }), ...(sameVersion ? { retried: true } : {}) } };
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
				...(createdConversations.length > 0 ? { conversations: createdConversations } : {}),
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
		try { payload = JSON.parse(await readRequestBody(req, ROUTE_BODY_LIMIT)); } catch (error) { sendEnvelope(res, 400, PROJECT_CODE.param, "invalid json body"); return; }
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
	/** 简报预算：项目简报与对话简报**共用** 2000 token 总预算。 */
	const BRIEF_TOKEN_LIMIT = 2000;
	const BRIEF_MARKER = "\n[简报已截断]";
	const BRIEF_MARKER_COST = 8;
	function briefCharCost(code) {
		const cjk = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x3000 && code <= 0x303f);
		return cjk ? 1 : 0.25;
	}
	function estimateBriefTokens(text) {
		let tokens = 0;
		for (const ch of String(text === undefined || text === null ? "" : text)) tokens += briefCharCost(ch.codePointAt(0));
		return tokens;
	}
	function newBriefBudget() {
		return { remaining: BRIEF_TOKEN_LIMIT, omitted: 0, truncated: false };
	}
	/** 从共享预算里取一段文本：够则整段，不够则截断填满并标一次。 */
	function takeBriefText(budget, text) {
		const source = String(text === undefined || text === null ? "" : text);
		if (source === "") return "";
		if (budget.remaining <= 0) {
			budget.truncated = true;
			return "";
		}
		const cost = estimateBriefTokens(source);
		if (cost <= budget.remaining) {
			budget.remaining -= cost;
			return source;
		}
		const usable = budget.remaining - BRIEF_MARKER_COST;
		let tokens = 0;
		let out = "";
		if (usable > 0) {
			for (const ch of source) {
				const c = briefCharCost(ch.codePointAt(0));
				if (tokens + c > usable) break;
				tokens += c;
				out += ch;
			}
		}
		budget.remaining = 0;
		budget.truncated = true;
		return out + BRIEF_MARKER;
	}
	/** 按顺序填列表；预算耗尽或某条被截断后，剩余条目计入 omitted 并丢弃。 */
	function takeBriefList(budget, list) {
		const source = Array.isArray(list) ? list : [];
		const out = [];
		for (let index = 0; index < source.length; index += 1) {
			if (budget.remaining <= 0) {
				budget.truncated = true;
				budget.omitted += source.length - index;
				break;
			}
			const item = String(source[index] === undefined || source[index] === null ? "" : source[index]);
			const cost = estimateBriefTokens(item);
			if (cost > budget.remaining) {
				const truncatedItem = takeBriefText(budget, item);
				out.push(truncatedItem);
				budget.omitted += source.length - index - 1;
				break;
			}
			budget.remaining -= cost;
			out.push(item);
		}
		return out;
	}
	/** 生成简报视图：goal → constraints → decisions（新的在前）→ duty → conclusions → artifacts，共用预算。 */
	function buildBriefViews(projectBrief, conversationBrief, sessionId) {
		const budget = newBriefBudget();
		let brief;
		if (projectBrief !== undefined && projectBrief !== null) {
			const decided = Array.isArray(projectBrief.decisions) ? projectBrief.decisions.slice().reverse() : [];
			brief = {
				version: projectBrief.version,
				updatedAt: projectBrief.updatedAt,
				updatedBy: projectBrief.updatedBy,
				goal: takeBriefText(budget, projectBrief.goal),
				constraints: takeBriefList(budget, projectBrief.constraints),
				decisions: takeBriefList(budget, decided)
			};
		}
		let conversation;
		if (sessionId !== undefined) {
			const view = conversationBriefView(conversationBrief, sessionId);
			conversation = {
				sessionId: view.sessionId,
				version: view.version,
				updatedAt: view.updatedAt,
				updatedBy: view.updatedBy,
				duty: takeBriefText(budget, view.duty),
				conclusions: takeBriefList(budget, view.conclusions),
				artifacts: takeBriefList(budget, view.artifacts)
			};
		}
		return { brief: brief, conversationBrief: conversation, truncated: budget.truncated, omitted: budget.omitted };
	}

	// ── v2.2 波次 5：流程图（flow 工具）——自动生成、直接画在画布上（D-2 / 九.2）────────────
	//
	// 硬约束（§57.3 保留）：每个流程节点必须带 sourceMessageIds，没有证据的节点不画（宁可少画）；
	// 消息不足时回「暂不足以生成流程图」并说缺什么。节流：同一张图在用户新说 2 句之前不重画（v2.1 当初
	// 禁止自动生成的理由是「太吵」）。用户手改过的节点锁定，重画只补新增（applyCanvasElements 负责）。
	// 证据口径：消息编号 = 调用方会话事件序号，写成 "m<seq>"；whales_flow_read 列出可引用的消息。
	const FLOW_SHAPES = ["start", "end", "step", "decision"];
	const FLOW_KEY = /^[A-Za-z0-9_-]{1,16}$/;
	const FLOW_ID = /^[a-z0-9-]{1,32}$/;
	const FLOW_REDRAW_MIN_USER_MESSAGES = 2;
	const flowDrawState = new Map();

	/** 调用方会话的可引用消息：[{ref:"m<seq>", role, text}]（text 截断）；读不到给空。 */
	async function flowMessagesOf(get, sessionId) {
		let events;
		try { events = await readSessionLog(get, sessionId); } catch (error) { return []; }
		return foldMessages(events).filter((row) => Number.isFinite(row.seq)).map((row) => ({ ref: "m" + row.seq, role: row.role, text: row.text }));
	}

	/** 某项目画布上已有的流程图（按 flowId 分组）。 */
	function flowsOnCanvas(page) {
		const elements = page && page.elements ? Object.values(page.elements) : [];
		const flows = {};
		for (const element of elements) {
			const flowId = element && element.data && typeof element.data.flowId === "string" ? element.data.flowId : "";
			if (flowId === "") continue;
			const flow = flows[flowId] || (flows[flowId] = { flowId: flowId, title: "", groupId: "flow:" + flowId, nodes: [], edges: [] });
			if (element.kind === "group") flow.title = typeof element.data.title === "string" ? element.data.title : "";
			else if (element.kind === "flow") flow.nodes.push({ id: element.id, key: element.data.key, shape: element.data.shape, text: element.data.text, userEdited: element.userEdited === true, sourceMessageIds: element.provenance && element.provenance.sourceMessageIds ? element.provenance.sourceMessageIds : [] });
			else if (element.kind === "edge") flow.edges.push({ id: element.id, from: element.data.fromKey, to: element.data.toKey, label: element.data.label || "", userEdited: element.userEdited === true });
		}
		return Object.values(flows);
	}

	/**
	 * 校验 + 生成要写入的元素。返回 { error } 或 { upsert, keep:Set(ids), dropped:[{key, reason}], edgeCount }。
	 * validRefs：调用方会话里真实存在的消息编号集合。
	 */
	function buildFlowElements(args, validRefs) {
		const flowId = typeof args.flowId === "string" && args.flowId.trim() !== "" ? args.flowId.trim().toLowerCase() : "main";
		if (!FLOW_ID.test(flowId)) return { error: "flowId 只能是 1–32 位小写字母 / 数字 / 连字符" };
		const title = typeof args.title === "string" ? args.title.trim().slice(0, 60) : "";
		if (title === "") return { error: "title 必填（这张流程图画的是什么）" };
		const rawNodes = Array.isArray(args.nodes) ? args.nodes : [];
		if (rawNodes.length > 40) return { error: "一张流程图最多 40 个节点" };
		const groupId = "flow:" + flowId;
		const upsert = [{ id: groupId, kind: "group", data: { flowId: flowId, title: title, kind: "flow" } }];
		const dropped = [];
		const keptKeys = new Set();
		for (const raw of rawNodes) {
			const key = raw && typeof raw.key === "string" ? raw.key.trim() : "";
			if (!FLOW_KEY.test(key)) { dropped.push({ key: key, reason: "key 只能是 1–16 位字母数字 _-" }); continue; }
			if (keptKeys.has(key)) { dropped.push({ key: key, reason: "key 重复" }); continue; }
			const shape = FLOW_SHAPES.indexOf(raw.shape) >= 0 ? raw.shape : "step";
			const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 120) : "";
			if (text === "") { dropped.push({ key: key, reason: "没有文字" }); continue; }
			const refs = Array.isArray(raw.sourceMessageIds) ? raw.sourceMessageIds.map((value) => String(value).trim()).filter((value) => validRefs.has(value)) : [];
			if (refs.length === 0) { dropped.push({ key: key, reason: "没有可核对的 sourceMessageIds（先用 whales_flow_read 看消息编号）" }); continue; }
			keptKeys.add(key);
			upsert.push({ id: groupId + ":" + key, kind: "flow", parentId: groupId, data: { flowId: flowId, key: key, shape: shape, text: text }, provenance: { sourceMessageIds: refs } });
		}
		let edgeCount = 0;
		for (const raw of Array.isArray(args.edges) ? args.edges : []) {
			const from = raw && typeof raw.from === "string" ? raw.from.trim() : "";
			const to = raw && typeof raw.to === "string" ? raw.to.trim() : "";
			if (!keptKeys.has(from) || !keptKeys.has(to) || from === to) continue;
			const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 12) : "";
			upsert.push({ id: groupId + ":e:" + from + ">" + to, kind: "edge", parentId: groupId, data: { flowId: flowId, source: groupId + ":" + from, target: groupId + ":" + to, fromKey: from, toKey: to, label: label } });
			edgeCount += 1;
		}
		return { flowId: flowId, title: title, groupId: groupId, upsert: upsert, keep: new Set(upsert.map((row) => row.id)), dropped: dropped, nodeCount: keptKeys.size, edgeCount: edgeCount };
	}

	function registerFlowTools(ctx, get) {
		const tools = get("tools");
		if (!tools || typeof tools.register !== "function") return;
		const disposers = [];
		function registerOne(tool) {
			let raw;
			try { raw = tools.register(tool); } catch (error) { warn(ctx, "flow tool", error); return; }
			if (typeof raw === "function") disposers.push(raw);
		}
		function callerIdOf(exec) {
			const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
			if (callerId === "") throw new Error("[40301] cannot determine the calling session");
			return callerId;
		}
		/**
		 * 画图要落在项目画布上，但不再要求用户先建项目：当前对话不在任何项目里时，
		 * 首次画图就地建一个（或并进祖先会话所在的项目），把结果告诉 agent 转述给用户。
		 */
		async function callerProject(exec) {
			const callerId = callerIdOf(exec);
			const ensured = await ensureSessionProject(get, callerId);
			if (ensured.project === undefined) {
				const name = ensured.dismissedFrom ? ensured.dismissedFrom.name : "";
				throw new Error("[40703] 本对话被用户从项目「" + name + "」移出过，不自动拉回；请用户在项目工作台里把它加回去再画");
			}
			const project = ensured.project;
			const info = { projectId: project.projectId, projectName: project.name, projectCreated: ensured.created === true, projectJoined: ensured.joined === true };
			if (info.projectCreated) info.projectNote = "本对话之前不属于任何项目，已自动建了项目「" + project.name + "」并把本对话设为主对话。画布在 DSH 侧栏「🐋 项目」里，输入框上方也会出现「打开画布」。请在回复里告诉用户。";
			else if (info.projectJoined) info.projectNote = "本对话已并入父对话所在的项目「" + project.name + "」。";
			return { callerId, project, info };
		}
		registerOne({
			name: "whales_flow_read",
			description: "读项目画布上已有的流程图（含用户手改锁定的节点），并列出当前会话里可引用的消息编号（m<序号>）。画流程图前先调它。不属于任何项目的对话也能调（flows 为空），首次画图会自动建项目。",
			parameters: { type: "object", properties: { limit: { type: "number", description: "列出最近多少条消息，默认 30，上限 80。" } }, additionalProperties: false },
			output: { schema: { type: "object", additionalProperties: true }, render: (value) => "流程图 " + String(value.flows ? value.flows.length : 0) + " 张 · 可引用消息 " + String(value.messages ? value.messages.length : 0) + " 条" },
			async execute(args, exec) {
				const callerId = callerIdOf(exec);
				// 只读：不在项目里也不建项目（建项目留给真正落图的 draw）。
				const project = projectOfSession(readProjectStore().store, callerId);
				const limit = Number.isFinite(Number(args && args.limit)) && Number(args.limit) > 0 ? Math.min(Math.floor(Number(args.limit)), 80) : 30;
				const messages = (await flowMessagesOf(get, callerId)).slice(-limit).map((row) => ({ ref: row.ref, role: row.role, text: row.text.length > 240 ? row.text.slice(0, 240) + "…" : row.text }));
				if (project === undefined) {
					return { projectId: null, flows: [], messages: messages, note: "本对话还不属于任何项目；直接调 whales_flow_draw / whales_prototype_draw，会自动为本对话建项目画布。" };
				}
				const page = canvasPageOf(readStoreFile(canvasStoreFile()).data, project.projectId);
				return { projectId: project.projectId, projectName: project.name, flows: flowsOnCanvas(page), messages: messages };
			}
		});
		registerOne({
			name: "whales_flow_draw",
			description: "把当前对话里已经讨论出来的流程直接画到项目画布上（会带「AI 生成」标记，用户可一键撤销）。" +
				"nodes：{key, shape: start|end|step|decision, text, sourceMessageIds:[\"m12\",…]}——每个节点必须引用 whales_flow_read 列出的消息编号，没有证据的节点会被丢掉；" +
				"edges：{from, to, label?}（判断分支写 是 / 否 / 例外）。同一 flowId 重画时，用户手改过的节点保持不动，只补新增。" +
				"讨论不足以成图时不要硬画；用户新说的话不到 2 句时重画会被节流。",
			parameters: {
				type: "object",
				properties: {
					flowId: { type: "string", description: "这张图的 id（小写字母数字连字符），默认 main；同一件事重画用同一个 id。" },
					title: { type: "string", description: "这张流程图画的是什么。" },
					nodes: {
						type: "array",
						items: {
							type: "object",
							properties: {
								key: { type: "string" },
								shape: { type: "string", enum: ["start", "end", "step", "decision"] },
								text: { type: "string" },
								sourceMessageIds: { type: "array", items: { type: "string" } }
							},
							required: ["key", "shape", "text", "sourceMessageIds"],
							additionalProperties: false
						}
					},
					edges: {
						type: "array",
						items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from", "to"], additionalProperties: false }
					}
				},
				required: ["title", "nodes"],
				additionalProperties: false
			},
			output: { schema: { type: "object", additionalProperties: true }, render: (value) => value.drawn ? "已画流程图「" + String(value.title) + "」：" + String(value.nodes) + " 个节点" : "没有画：" + String(value.reason) },
			async execute(args, exec) {
				const callerId = callerIdOf(exec);
				const messages = await flowMessagesOf(get, callerId);
				const built = buildFlowElements(args || {}, new Set(messages.map((row) => row.ref)));
				if (built.error !== undefined) throw new Error("[40001] " + built.error);
				if (built.nodeCount < 2) {
					return { drawn: false, reason: "暂不足以生成流程图", missing: "至少要 2 个有消息证据的步骤；被丢掉的节点见 dropped", dropped: built.dropped };
				}
				// 校验过了、确实要落图，才去确保项目存在（画不出来的调用不该凭空建项目）。
				const { project, info } = await callerProject(exec);
				const stateKey = project.projectId + ":" + built.flowId;
				const userCount = messages.filter((row) => row.role === "user").length;
				const last = flowDrawState.get(stateKey);
				const pageNow = canvasPageOf(readStoreFile(canvasStoreFile()).data, project.projectId);
				const exists = pageNow.elements && pageNow.elements[built.groupId] !== undefined;
				if (exists && last !== undefined && userCount - last.userCount < FLOW_REDRAW_MIN_USER_MESSAGES) {
					return { drawn: false, reason: "节流：上次画完之后用户新说的话不到 " + FLOW_REDRAW_MIN_USER_MESSAGES + " 句，先不重画", flowId: built.flowId, ...info };
				}
				let result;
				for (let attempt = 0; attempt < 3; attempt += 1) {
					const page = canvasPageOf(readStoreFile(canvasStoreFile()).data, project.projectId);
					const remove = Object.values(page.elements).filter((element) => element && element.data && element.data.flowId === built.flowId && !built.keep.has(element.id)).map((element) => element.id);
					try {
						result = await applyCanvasElements(project.projectId, { expectedRevision: page.rev, upsert: built.upsert, remove: remove, by: "agent", sessionId: callerId });
						break;
					} catch (error) {
						if (!(error && error.canvasCode === CANVAS_CODE.revConflict) || attempt === 2) throw error;
					}
				}
				flowDrawState.set(stateKey, { userCount: userCount, at: Date.now() });
				return { drawn: true, flowId: built.flowId, title: built.title, nodes: built.nodeCount, edges: built.edgeCount, dropped: built.dropped, locked: result.locked, rev: result.rev, ...info };
			}
		});
		registerOne({
			name: "whales_prototype_draw",
			description: "把讨论出来的页面画成「原型帧」放到项目画布上（带 AI 标记，用户可在画布上用 Puck 继续拖拽编辑）。" +
				"puck 是 Puck 数据 {content:[{type, props}]}，type 只能用通用词表：" + Object.keys(PROTOTYPE_VOCAB).join(" / ") +
				"；Card / Section / Dialog 的 content、Columns 的 left / right 是插槽（子节点数组）。不写具体组件库——画布上的组件库节点决定用哪套实现（默认 shadcn，可换成用户本地导入的包）。" +
				"sourceMessageIds 必填（同流程图：引用 whales_flow_read 列出的消息编号）。同一 prototypeId 重画会覆盖 AI 版本；用户改过的不覆盖。",
			parameters: {
				type: "object",
				properties: {
					prototypeId: { type: "string", description: "小写字母数字连字符，默认 main。" },
					title: { type: "string", description: "页面名，如「表单导入弹窗」。" },
					width: { type: "string", enum: ["desktop", "mobile"] },
					puck: { type: "object", description: "Puck 数据：{ content: [{ type, props }] }。", additionalProperties: true },
					sourceMessageIds: { type: "array", items: { type: "string" } }
				},
				required: ["title", "puck", "sourceMessageIds"],
				additionalProperties: false
			},
			output: { schema: { type: "object", additionalProperties: true }, render: (value) => value.drawn ? "已画原型「" + String(value.title) + "」：" + String(value.components) + " 个组件" : "没有画：" + String(value.reason) },
			async execute(args, exec) {
				const callerId = callerIdOf(exec);
				const input = args || {};
				const prototypeId = typeof input.prototypeId === "string" && input.prototypeId.trim() !== "" ? input.prototypeId.trim().toLowerCase() : "main";
				if (!FLOW_ID.test(prototypeId)) throw new Error("[40001] prototypeId 只能是 1–32 位小写字母 / 数字 / 连字符");
				const title = typeof input.title === "string" ? input.title.trim().slice(0, 60) : "";
				if (title === "") throw new Error("[40001] title 必填");
				const messages = await flowMessagesOf(get, callerId);
				const valid = new Set(messages.map((row) => row.ref));
				const refs = Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds.map((value) => String(value).trim()).filter((value) => valid.has(value)) : [];
				if (refs.length === 0) return { drawn: false, reason: "没有可核对的 sourceMessageIds：先用 whales_flow_read 看消息编号，原型要有讨论出处" };
				const checked = validatePrototypeData(input.puck);
				if (checked.error !== undefined) throw new Error("[40001] " + checked.error);
				if (checked.count === 0) return { drawn: false, reason: "原型里一个组件都没有" };
				const { project, info } = await callerProject(exec);
				const element = {
					id: "proto:" + prototypeId,
					kind: "prototype",
					data: { prototypeId: prototypeId, title: title, width: input.width === "mobile" ? "mobile" : "desktop", puck: checked.data },
					provenance: { sourceMessageIds: refs }
				};
				let result;
				for (let attempt = 0; attempt < 3; attempt += 1) {
					const page = canvasPageOf(readStoreFile(canvasStoreFile()).data, project.projectId);
					try {
						result = await applyCanvasElements(project.projectId, { expectedRevision: page.rev, upsert: [element], by: "agent", sessionId: callerId });
						break;
					} catch (error) {
						if (!(error && error.canvasCode === CANVAS_CODE.revConflict) || attempt === 2) throw error;
					}
				}
				if (result.rejected.length > 0) throw new Error("[40001] " + result.rejected[0].reason);
				if (result.locked.length > 0) return { drawn: false, reason: "用户改过这个原型，已锁定；换一个 prototypeId 画新版本", prototypeId: prototypeId, ...info };
				return { drawn: true, prototypeId: prototypeId, title: title, components: checked.count, rev: result.rev, ...info };
			}
		});
		if (ctx && typeof ctx.effect === "function") {
			try {
				ctx.effect(() => () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch (error) { /* 已注销 */ } } }, "agent-whales: flow tools");
			} catch (error) {
				warn(ctx, "flow tools effect", error);
			}
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
					const views = buildBriefViews(projectBriefOrDefault(project), undefined, undefined);
					return { target: "project", projectId: projectId, brief: views.brief, truncated: views.truncated, omitted: views.omitted };
				}
				const explicitSessionId = typeof args?.sessionId === "string" && args.sessionId.trim() !== "" ? args.sessionId.trim() : "";
				if (explicitSessionId === "") {
					const ownProject = projectOfSession(read.store, callerId);
					if (ownProject === undefined) {
						return { joinedProject: false, message: "未加入项目：当前会话不属于任何项目，没有可读取的项目简报。" };
					}
					const briefs = ensureConversationBriefs(read.store);
					const views = buildBriefViews(projectBriefOrDefault(ownProject), briefs[callerId], callerId);
					return {
						joinedProject: true,
						target: "project",
						projectId: ownProject.projectId,
						brief: views.brief,
						conversationBrief: views.conversationBrief,
						truncated: views.truncated,
						omitted: views.omitted
					};
				}
				const permission = crossReadPermission(read.store, callerId, explicitSessionId);
				if (permission.ok !== true) throw new Error("[" + permission.code + "] " + permission.msg);
				const views = buildBriefViews(undefined, ensureConversationBriefs(read.store)[explicitSessionId], explicitSessionId);
				return { target: "conversation", sessionId: explicitSessionId, brief: views.conversationBrief, truncated: views.truncated, omitted: views.omitted };
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
const TASK_ACTION_LIST = ["assign", "assign-and-dispatch", "dispatch", "unassign", "reopen", "verify"];
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
	const subagents = typeof get === "function" ? get("subagents") : undefined;
	// 两代宿主：旧版有 tryMembership（成员名册）；DSH v0.2.1-rc.2 起成员是标准 subagent，
	// 「Lead」= 子代理树的根（subagents.rootOf），团队是否开启看 agentTeams.isEnabled。
	const legacy = Boolean(teams && typeof teams.tryMembership === "function");
	const modern = Boolean(teams && typeof teams.isEnabled === "function" && subagents && typeof subagents.rootOf === "function");
	// 只读路径（提案/任务快照）不该因为"没有写能力"而不可用；写能力由各自的路由单独校验。
	if (!agents || typeof agents.get !== "function" || (!legacy && !modern)) {
		return { code: TASK_CODE.unavailable, msg: "team service unavailable" };
	}
	let lead;
	try {
		lead = agents.get(leadSessionId.trim());
	} catch (error) {
		lead = undefined;
	}
	if (!lead) return { code: TASK_CODE.forbidden, msg: "lead session is not live" };
	if (!legacy) {
		let root;
		let enabled = false;
		try {
			root = subagents.rootOf(lead);
			enabled = teams.isEnabled(lead) === true;
		} catch (error) {
			root = undefined;
		}
		if (!enabled) return { code: TASK_CODE.forbidden, msg: "caller is not in a team" };
		if (root !== lead) return { code: TASK_CODE.forbidden, msg: "caller is not the team lead" };
		return { lead: lead, teams: teams, subagents: subagents, membership: { role: "lead", id: String(lead.id) } };
	}
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

/** GET /agent-whales/api/tasks：任务 + 成员全量快照（不重建任何派发历史）。POST 由 dispatchRequest 分流到新建。 */
async function handleTasksRequest(ctx, req, res, get) {
	const method = requestMethod(req);
	// 同一条路径现在有 GET（快照）与 POST（新建）：allow 必须把两个动词都报出去，
	// 否则 CORS 预检会按 405 处理，UI 上的「＋ 新建任务」直接发不出去。
	if (method === "OPTIONS") {
		res.setHeader("allow", "GET, HEAD, POST, OPTIONS");
		sendEmpty(res, 204);
		return;
	}
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD, POST, OPTIONS");
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
		// 新宿主没有成员名册（listMembers 已移除）：成员就是子代理树，按 listDescendants 补；读不到给空，不编。
		let members = typeof caller.teams.listMembers === "function" ? caller.teams.listMembers(caller.lead) : [];
		if (typeof caller.teams.listMembers !== "function" && caller.subagents && typeof caller.subagents.listDescendants === "function") {
			try {
				const rows = await caller.subagents.listDescendants(String(caller.lead.id));
				members = (Array.isArray(rows) ? rows : []).map((row) => ({ id: row && (row.sessionId || row.id), name: row && (row.description || row.name || ""), role: "member", status: row && row.status, parentId: row && row.parentSessionId }));
			} catch (error) {
				members = [];
			}
		}
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
			const raw = await readRequestBody(req, ROUTE_BODY_LIMIT);
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
						const result = applyProjectTaskCommand(projectRead.store, project, projectTask, Object.assign({}, payload, { callerSessionId: project.mainSessionId }));
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
					dispatch = await dispatchProjectTask(ctx, get, applied.snapshot, payload.dispatchTimeoutMs);
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
				// 事件台接线：任务命令写成功是插件自己的事实，趁热登记（await 它：ingestEvent
				// 绝不抛，失败只在内部 warn；evidence 缺 requestId 时退用 taskId 指认事实）。
				try {
					const commandAction = typeof payload.action === "string" ? payload.action.trim() : "";
					const commandRequestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
					await ingestEvent(ctx, {
						source: "plugin",
						kind: "task.command",
						text: commandAction + " " + taskId,
						evidence: commandRequestId === "" ? taskId : commandRequestId,
						projectId: projectId
					});
				} catch (error) {
					warn(ctx, "event ingest", error);
				}
				sendEnvelope(res, 200, TASK_CODE.ok, "success", Object.assign({}, applied.data, dispatch === undefined ? {} : { dispatch: dispatch }, applied.scopeOrderHint === undefined ? {} : { scopeOrderHint: applied.scopeOrderHint }));
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

// ── 3c2) M6：任务 report（四态）+ 人机边界 ────────────────────────────────
//
// PRD §53.9.12：report 与任务同一条记录、同一套 CAS。
//   status ∈ done | draft | handed_back | human_action；
//   done/draft 由 worker 写；handed_back/human_action 是「退回给人」的结论，
//   只能人改——worker 只能发起，不能自己关回 done/draft（那等于 worker 给自己结案）。
// 冲突（expectedRevision 过期）→ 40902 + latestVersion：worker 重读后重报，
// 不提供强制写（PRD 明令「不覆盖」）。

const TASK_REPORT_SUFFIX = "/report";
const REPORT_STATUS_LIST = ["done", "draft", "handed_back", "human_action"];
/** 这两个状态的关闭权只在人手里（见上）。 */
const REPORT_HUMAN_ONLY_STATUS = ["handed_back", "human_action"];
const REPORT_SUMMARY_LIMIT = 4000;
const REPORT_ARTIFACT_LIMIT = 50;
const REPORT_ARTIFACT_REF_LIMIT = 500;

/** 解析 /agent-whales/api/tasks/<taskId>/report → taskId（与 /commands 后缀不同，不会冲突）。 */
function taskReportOf(pathname) {
	if (typeof pathname !== "string") return undefined;
	if (!pathname.startsWith(TASK_COMMANDS_PREFIX)) return undefined;
	if (!pathname.endsWith(TASK_REPORT_SUFFIX)) return undefined;
	const middle = pathname.slice(TASK_COMMANDS_PREFIX.length, pathname.length - TASK_REPORT_SUFFIX.length);
	if (middle === "" || middle.indexOf("/") >= 0) return undefined;
	try {
		return decodeURIComponent(middle);
	} catch (error) {
		return middle;
	}
}

/** artifacts 收敛：最多 50 条、每条 ref ≤ 500 字；脏值丢弃，绝不因脏数据拒掉整次上报。 */
function normalizeReportArtifacts(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const item of raw) {
		if (out.length >= REPORT_ARTIFACT_LIMIT) break;
		if (!item || typeof item !== "object") continue;
		const kind = item.kind === "url" ? "url" : item.kind === "file" ? "file" : undefined;
		if (kind === undefined) continue;
		const ref = typeof item.ref === "string" ? item.ref.slice(0, REPORT_ARTIFACT_REF_LIMIT) : "";
		if (ref === "") continue;
		out.push(Object.assign({ kind: kind, ref: ref }, typeof item.note === "string" ? { note: item.note } : {}));
	}
	return out;
}

/**
 * PUT /agent-whales/api/tasks/:taskId/report
 * body: { projectId, expectedRevision, report: { status, summary?, artifacts? }, bySessionId? }
 * 校验顺序：同源 token → projectId → store 可写 → 项目存在 → 任务存在未删 →
 * CAS（expectedRevision）→ 人机边界 → 落库（task.revision+1，report.rev 同步）。
 */
function handleTaskReportRequest(ctx, req, res, get, control, taskId) {
	const method = requestMethod(req);
	if (method === "OPTIONS") {
		res.setHeader("allow", "PUT, OPTIONS");
		sendEmpty(res, 204);
		return Promise.resolve();
	}
	if (method !== "PUT") {
		res.setHeader("allow", "PUT, OPTIONS");
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
			const raw = await readRequestBody(req, ROUTE_BODY_LIMIT);
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
			if (projectId === "") {
				sendEnvelope(res, 400, TASK_CODE.param, "projectId is required");
				return;
			}
			const report = payload.report;
			if (!report || typeof report !== "object") {
				sendEnvelope(res, 400, TASK_CODE.param, "report is required");
				return;
			}
			const status = typeof report.status === "string" ? report.status : "";
			if (REPORT_STATUS_LIST.indexOf(status) < 0) {
				sendEnvelope(res, 400, TASK_CODE.param, "report.status must be one of " + REPORT_STATUS_LIST.join(", "));
				return;
			}
			const expectedRevision = payload.expectedRevision;
			if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
				sendEnvelope(res, 400, TASK_CODE.param, "expectedRevision must be a positive integer");
				return;
			}
			// 身份：缺省或 "user" = 人（UI 操作）；其它值 = worker（执行会话自报）。
			const bySessionId = typeof payload.bySessionId === "string" ? payload.bySessionId.trim() : "";
			const actor = bySessionId === "" || bySessionId === "user" ? "user" : bySessionId;
			// 脏值在锁外先收敛：summary 截断、artifacts 限条数，不走业务拒绝路径。
			const summary = typeof report.summary === "string" ? report.summary.slice(0, REPORT_SUMMARY_LIMIT) : "";
			const artifacts = normalizeReportArtifacts(report.artifacts);
			let applied;
			try {
				applied = await withStoreLock(function () {
					const projectRead = readProjectStore();
					if (projectRead.readonly) throw new StoreReadonlyError(projectsStoreFile(), projectRead.backupPath);
					const project = projectRead.store.projects[projectId];
					if (project === undefined) return { code: PROJECT_CODE.notFound, msg: "project not found" };
					const task = projectTaskOf(projectRead.store, projectId, taskId);
					if (task === undefined) return { code: TASK_CODE.notFound, msg: "task not found" };
					if (task.status === "deleted") return { code: TASK_CODE.taskDeleted, msg: "task is deleted" };
					if (task.revision !== expectedRevision) {
						// latestVersion 是本路由契约（PRD/客户端口径），latestRevision 与 commands 的冲突响应同键，
						// 两个键给同一个值：UI 无论按哪套写法读都能拿到最新版本号。
						return { code: TASK_CODE.revisionConflict, msg: "task revision conflict", data: { latestVersion: task.revision, latestRevision: task.revision } };
					}
					const previous = task.report !== undefined && task.report !== null && typeof task.report.status === "string" ? task.report.status : undefined;
					if (actor !== "user" && previous !== undefined && REPORT_HUMAN_ONLY_STATUS.indexOf(previous) >= 0 && REPORT_HUMAN_ONLY_STATUS.indexOf(status) < 0) {
						return { code: PROJECT_TASK_EXTRA.reportHumanOnly, msg: "handed_back/human_action can only be closed by a human" };
					}
					const now = Date.now();
					task.report = { status: status, summary: summary, artifacts: artifacts, rev: task.revision + 1, at: now, bySessionId: actor };
					task.revision = task.revision + 1;
					task.updatedAt = now;
					project.updatedAt = now;
					return writeStoreFile(projectsStoreFile(), projectRead.store).then(function () {
						return { code: TASK_CODE.ok, msg: "success", data: { source: "project", task: projectTaskView(projectRead.store, task) } };
					});
				});
			} catch (error) {
				if (error && error.code === "STORE_READONLY") {
					sendEnvelope(res, 503, PROJECT_CODE.storeReadonly, "store is read-only (corrupted, backed up)");
					return;
				}
				throw error;
			}
			if (applied.code !== TASK_CODE.ok) {
				sendEnvelope(res, 200, applied.code, applied.msg, applied.data);
				return;
			}
			sendEnvelope(res, 200, TASK_CODE.ok, "success", applied.data);
		} catch (error) {
			warn(ctx, "task report", error);
			sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
		}
	})();
}

// ── 3c3) M6 工作台读接口：发送记录 / 待办聚合 ──────────────────────────────
//
// 两个接口都只读，给 UI 的「发送记录」与「需要我处理」当稳定数据源，
// 不再让浏览器半边各自去拼 projects.json / proposals.json。

const HANDOFFS_ENDPOINT = `${ACTIVITY_PATH}/handoffs`;
const INBOX_ENDPOINT = `${ACTIVITY_PATH}/inbox`;
const SNAPSHOT_ENDPOINT = `${ACTIVITY_PATH}/snapshot`;
const HANDOFFS_LIMIT_DEFAULT = 200;
const HANDOFFS_LIMIT_MAX = 500;

/** GET /agent-whales/api/handoffs?projectId=&limit=：跨会话发送记录，按 at 倒序。 */
function handleHandoffsRequest(ctx, req, res) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const rawProjectId = queryParam(req.url, "projectId");
	const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
	let limit = HANDOFFS_LIMIT_DEFAULT;
	const rawLimit = queryParam(req.url, "limit");
	if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
		const parsed = Number(rawLimit);
		if (Number.isFinite(parsed)) limit = Math.min(Math.max(Math.floor(parsed), 1), HANDOFFS_LIMIT_MAX);
	}
	// 只读降级：账本损坏时 readStoreFile 已备份原文件，这里回空表——UI 显示空而不是报错。
	const read = readStoreFile(handoffsStoreFile());
	let entries = Array.isArray(read.data.entries) ? read.data.entries.filter((entry) => entry && typeof entry === "object") : [];
	if (projectId !== "") {
		const projectRead = readProjectStore();
		const project = projectRead.store.projects[projectId];
		if (project === undefined) {
			sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found");
			return;
		}
		const members = new Set();
		if (typeof project.mainSessionId === "string") members.add(project.mainSessionId);
		if (Array.isArray(project.members)) {
			for (const member of project.members) {
				if (member && typeof member.sessionId === "string") members.add(member.sessionId);
			}
		}
		entries = entries.filter((entry) => members.has(entry.from) || members.has(entry.to));
	}
	entries = entries
		.slice()
		.sort((a, b) => (typeof b.at === "number" ? b.at : 0) - (typeof a.at === "number" ? a.at : 0))
		.slice(0, limit);
	sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { source: "project", projectId: projectId === "" ? null : projectId, entries: entries });
}

/** GET /agent-whales/api/inbox?projectId=：「需要我处理」四组聚合；空组也保留（前端按 key 渲染）。 */
function handleInboxRequest(ctx, req, res) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const rawProjectId = queryParam(req.url, "projectId");
	const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
	const projectRead = readProjectStore();
	const proposalsRead = readStoreFile(PROPOSAL_STORE_FILE);
	const handoffsRead = readStoreFile(handoffsStoreFile());
	const store = projectRead.store;
	const projects = store.projects !== undefined && store.projects !== null && typeof store.projects === "object" ? store.projects : {};
	const inScope = (value) => projectId === "" || value === projectId;
	const byAtDesc = (a, b) => (typeof b.at === "number" ? b.at : 0) - (typeof a.at === "number" ? a.at : 0);
	const taskSubject = (task) => typeof task.subject === "string" ? task.subject : "";

	// 提案待确认：只收带项目归属的（宿主板提案没有 projectId，不进项目待办）；
	// 已确认的不再是「待确认」，不出现。
	const proposals = [];
	for (const record of Object.values(proposalsRead.data)) {
		if (!record || typeof record !== "object") continue;
		if (typeof record.projectId !== "string" || record.projectId === "") continue;
		if (!inScope(record.projectId)) continue;
		if (record.confirmed !== undefined) continue;
		const first = Array.isArray(record.items) && record.items.length > 0 ? record.items[0] : undefined;
		proposals.push({
			kind: "proposal",
			proposalId: record.proposalId,
			version: record.version,
			subject: first && typeof first.title === "string" ? first.title : "",
			at: typeof record.createdAt === "number" ? record.createdAt : 0,
			projectId: record.projectId
		});
	}

	const worker = [];
	const handedBack = [];
	const system = [];
	const tasks = store.tasks !== undefined && store.tasks !== null && typeof store.tasks === "object" ? store.tasks : {};
	for (const task of Object.values(tasks)) {
		if (!task || typeof task !== "object") continue;
		if (typeof task.projectId !== "string" || !inScope(task.projectId)) continue;
		// 已删除的任务不再需要任何人处理，四组都不收。
		if (task.status === "deleted") continue;
		const report = task.report !== undefined && task.report !== null && typeof task.report === "object" ? task.report : undefined;
		const at = report !== undefined && typeof report.at === "number" ? report.at : 0;
		if (report !== undefined && report.status === "human_action") {
			worker.push({ kind: "task", taskId: task.taskId, projectId: task.projectId, subject: taskSubject(task), report: report, at: at });
		}
		if (report !== undefined && report.status === "handed_back") {
			handedBack.push({ kind: "task", taskId: task.taskId, projectId: task.projectId, subject: taskSubject(task), report: report, at: at });
		}
		// blockedReason 由 projectTaskView 派生（前置缺失/已删除都算「前置已删除」）。
		if (projectTaskView(store, task).blockedReason === "前置已删除") {
			system.push({ kind: "task", taskId: task.taskId, projectId: task.projectId, subject: taskSubject(task), reason: "前置已删除", at: typeof task.updatedAt === "number" ? task.updatedAt : 0 });
		}
	}
	// store 只读降级：三个 store 任一坏掉都提醒一次（此时所有写接口都会 503，先让人知道）。
	if (projectRead.readonly === true || proposalsRead.readonly === true || handoffsRead.readonly === true) {
		system.push({ kind: "store", reason: "store-readonly", at: Date.now() });
	}

	proposals.sort(byAtDesc);
	worker.sort(byAtDesc);
	handedBack.sort(byAtDesc);
	system.sort(byAtDesc);
	sendEnvelope(res, 200, PROJECT_CODE.ok, "success", {
		source: "project",
		projectId: projectId === "" ? null : projectId,
		groups: [
			{ key: "proposals", label: "提案待确认", items: proposals },
			{ key: "worker", label: "worker 求人（human_action）", items: worker },
			{ key: "handed_back", label: "超 scope 退回（handed_back）", items: handedBack },
			{ key: "system", label: "系统提醒", items: system }
		]
	});
}

// ── 3c3a) 全量快照路由：把五个 store 的**原始内容**交给浏览器半边打 ZIP ──────
//
// 为什么不让客户端逐路爬：各路由返回的是**视图**（projectView / 任务派生 / 收件箱聚合），
// 不是盘上的真源。导出要的是真源，否则「导出」其实是「导出我们愿意展示的那部分」——
// 备份的意义正在于连当前不看的东西也一起带走。
//
// 读不要 token（与 activity / handoffs / inbox 同一定位：这些都是本插件自己的数据，
// 单用户本机；真正的写操作才要 controlToken）。借 chat-demo 历史导出的纪律：
// 每个文件如实标 present / readonly，缺文件给 null 而不是空对象——「这个文件不在」
// 与 「这个文件是空的」在备份里是两件事。

/** 快照里的五个文件：键 = ZIP 内的文件名。 */
function snapshotFiles() {
	return [
		{ name: "projects.json", file: projectsStoreFile() },
		{ name: "canvas.json", file: canvasStoreFile() },
		{ name: "handoffs.json", file: handoffsStoreFile() },
		{ name: "events.json", file: eventsStoreFile() },
		{ name: "proposals.json", file: PROPOSAL_STORE_FILE }
	];
}

/** GET /agent-whales/api/snapshot：五个 store 的原始内容 + 缺失/只读标注。 */
function handleSnapshotRequest(ctx, req, res) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const files = [];
	for (const entry of snapshotFiles()) {
		const read = readStoreFile(entry.file);
		const present = existsSync(entry.file);
		files.push({
			name: entry.name,
			// present=false 时给 null：缺文件与空文件是两件事，备份里不能混。
			present: present,
			readonly: read.readonly === true,
			// 损坏被改名备份时原路径已不存在：present=false 但 backupPath 有值。
			// 导出物里要说清数据去哪了，否则用户以为「这个文件从来没存在过」。
			backupPath: typeof read.backupPath === "string" ? read.backupPath : null,
			data: present ? read.data : null
		});
	}
	sendEnvelope(res, 200, TASK_CODE.ok, "success", { generatedAt: Date.now(), files: files });
}

// ── 3c3b) W1.5 事件台路由：收件箱快照 / Source 健康 / 三个处置动作 ────────────
//
// 读不要 token（与 activity / handoffs 同一定位），写要 x-whales-token。
//   open   = 进项目任务表（createProjectTaskInStore，不传 owner）+ 事件置 opened；
//   ignore = 留痕不建单；noise = 事件置 noise + 该 Source 屏蔽 24 小时。

const EVENTS_ENDPOINT = `${ACTIVITY_PATH}/events`;
const EVENTS_HEALTH_ENDPOINT = `${EVENTS_ENDPOINT}/health`;
const EVENTS_ACTIONS_SUFFIX = "/actions";
const EVENTS_LIMIT_DEFAULT = 200;
const EVENTS_LIMIT_MAX = 500;

/** GET /agent-whales/api/events?projectId=&source=&state=&limit=：事件台快照（at 倒序）。 */
function handleEventsRequest(ctx, req, res) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const rawProjectId = queryParam(req.url, "projectId");
	const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
	const rawSource = queryParam(req.url, "source");
	const source = typeof rawSource === "string" ? rawSource.trim() : "";
	const rawState = queryParam(req.url, "state");
	const state = typeof rawState === "string" ? rawState.trim() : "";
	let limit = EVENTS_LIMIT_DEFAULT;
	const rawLimit = queryParam(req.url, "limit");
	if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
		const parsed = Number(rawLimit);
		if (Number.isFinite(parsed)) limit = Math.min(Math.max(Math.floor(parsed), 1), EVENTS_LIMIT_MAX);
	}
	const snapshot = readEventsStore();
	const scoped = eventsInScope(snapshot.events, projectId);
	// stats 按项目口径算（不受 source/state 筛选影响）：它们是「这个范围今天怎么样」的总览。
	const now = Date.now();
	const dayStart = startOfToday(now);
	const stats = {
		pending: scoped.filter((event) => event.state === "pending").length,
		today: scoped.filter((event) => typeof event.at === "number" && event.at >= dayStart).length,
		opened: scoped.filter((event) => event.state === "opened").length,
		ignored: scoped.filter((event) => event.state === "ignored").length
	};
	let rows = scoped;
	if (source !== "") rows = rows.filter((event) => event.source === source);
	if (state !== "") rows = rows.filter((event) => event.state === state);
	rows = rows
		.slice()
		.sort((a, b) => (typeof b.at === "number" ? b.at : 0) - (typeof a.at === "number" ? a.at : 0))
		.slice(0, limit)
		.map(eventView)
		.filter((row) => row !== undefined);
	sendEnvelope(res, 200, PROJECT_CODE.ok, "success", {
		source: "plugin",
		projectId: projectId === "" ? null : projectId,
		events: rows,
		stats: stats,
		health: eventHealthOf(scoped, snapshot.noise, now)
	});
}

/** GET /agent-whales/api/events/health：Source 健康面板（固定词表；projectId 可选收窄）。 */
function handleEventHealthRequest(ctx, req, res) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const rawProjectId = queryParam(req.url, "projectId");
	const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
	const snapshot = readEventsStore();
	sendEnvelope(res, 200, PROJECT_CODE.ok, "success", {
		source: "plugin",
		projectId: projectId === "" ? null : projectId,
		health: eventHealthOf(eventsInScope(snapshot.events, projectId), snapshot.noise, Date.now())
	});
}

/** 解析 /agent-whales/api/events/<eventId>/actions → eventId。 */
function eventActionOf(pathname) {
	if (typeof pathname !== "string") return undefined;
	if (!pathname.startsWith(EVENTS_ENDPOINT + "/")) return undefined;
	if (!pathname.endsWith(EVENTS_ACTIONS_SUFFIX)) return undefined;
	const middle = pathname.slice(EVENTS_ENDPOINT.length + 1, pathname.length - EVENTS_ACTIONS_SUFFIX.length);
	if (middle === "" || middle.indexOf("/") >= 0) return undefined;
	try {
		return decodeURIComponent(middle);
	} catch (error) {
		return middle;
	}
}

/** open 的项目口径：body.projectId 优先，缺省用事件记录里的 projectId（浏览器半边同规则）。 */
function resolveEventProjectId(rawProjectId, event) {
	const fromBody = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
	if (fromBody !== "") return fromBody;
	return typeof event.projectId === "string" ? event.projectId.trim() : "";
}

/**
 * POST /agent-whales/api/events/:eventId/actions
 * body: { action: "open"|"ignore"|"noise", projectId?, requestId? }
 *   open   项目口径 = body.projectId 优先、缺省用事件自己的 projectId，两者都没有 → 40000；
 *          项目必须存在（40401）；事件必须是 pending（已处置 → 40904）；
 *          建单后事件 opened + ticketId + decidedAt/decidedBy="user"。
 *   ignore 事件 ignored + decidedAt/decidedBy="user"（留痕不建单）。
 *   noise  事件 noise，且 noise[source] = now + 24h（该 Source 24 小时不进收件箱）。
 * requestId 提供就走进程内回放：同 requestId 直接回上次结果，不重复建单。
 */
function handleEventActionsRequest(ctx, req, res, control, eventId) {
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
			const raw = await readRequestBody(req, ROUTE_BODY_LIMIT);
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
			const action = typeof payload.action === "string" ? payload.action.trim() : "";
			if (EVENT_ACTION_LIST.indexOf(action) < 0) {
				sendEnvelope(res, 400, TASK_CODE.param, "action must be one of " + EVENT_ACTION_LIST.join(", "));
				return;
			}
			const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
			// 进程内回放：同 requestId 直接回上次结果（与新建任务的回放同一语义）。
			control.eventActionMemo = control.eventActionMemo || new Map();
			if (requestId !== "") {
				const remembered = control.eventActionMemo.get(requestId);
				if (remembered !== undefined) {
					sendEnvelope(res, 200, TASK_CODE.ok, "success", Object.assign({}, remembered, { replayed: true }));
					return;
				}
			}
			// 事件必须存在（40401）且还没被处置（pending 之外都是终态 → 40904）。
			const event = readEventsStore().events.find((item) => item.eventId === eventId);
			if (event === undefined) {
				sendEnvelope(res, 200, TASK_CODE.notFound, "event not found");
				return;
			}
			if (event.state !== "pending") {
				sendEnvelope(res, 200, TASK_CODE.taskClosed, "event already decided");
				return;
			}
			// open 的项目口径：body.projectId 优先，缺省退回事件自己的 projectId（侧栏进事件台时
			// 前端没有当前项目）；两边都没有才拒绝。
			const projectId = resolveEventProjectId(payload.projectId, event);
			if (action === "open" && projectId === "") {
				sendEnvelope(res, 400, TASK_CODE.param, "projectId is required for open");
				return;
			}
			// open 的项目存在性预检（锁内还会再判一次）。
			if (action === "open" && readProjectStore().store.projects[projectId] === undefined) {
				sendEnvelope(res, 200, PROJECT_CODE.notFound, "project not found");
				return;
			}
			// 并发同事件同动作：共用同一次执行，绝不重复建单/重复处置。
			control.eventActionInFlight = control.eventActionInFlight || new Map();
			const flightKey = eventId + ":" + action;
			const inflight = control.eventActionInFlight.get(flightKey);
			if (inflight !== undefined) {
				const shared = await inflight;
				sendEnvelope(res, 200, shared.code, shared.msg, shared.data);
				return;
			}
			const execution = runEventAction(ctx, control, eventId, action, projectId).then((result) => {
				if (requestId !== "" && result.code === TASK_CODE.ok) {
					control.eventActionMemo.set(requestId, result.data);
					while (control.eventActionMemo.size > TASK_COMMAND_MEMO_LIMIT) {
						const oldest = control.eventActionMemo.keys().next();
						if (oldest.done) break;
						control.eventActionMemo.delete(oldest.value);
					}
				}
				return result;
			}).finally(() => {
				control.eventActionInFlight.delete(flightKey);
			});
			control.eventActionInFlight.set(flightKey, execution);
			const result = await execution;
			sendEnvelope(res, result.http || 200, result.code, result.msg, result.data);
		} catch (error) {
			warn(ctx, "event action", error);
			sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
		}
	})();
}

/** 执行一个事件动作（锁外已校验 action/projectId/事件存在）。返回 { code, msg, data, http? }。 */
async function runEventAction(ctx, control, eventId, action, projectId) {
	const decidedAt = Date.now();
	if (action === "ignore" || action === "noise") {
		return mutateEvents(function (store) {
			const target = store.events[eventId];
			if (target === undefined) return { code: TASK_CODE.notFound, msg: "event not found" };
			if (target.state !== "pending") return { code: TASK_CODE.taskClosed, msg: "event already decided" };
			target.state = action === "ignore" ? "ignored" : "noise";
			target.decidedAt = decidedAt;
			target.decidedBy = "user";
			if (action === "noise") {
				// 噪声闸：该 Source 24 小时不进收件箱（PRD §56.2 第 7 条）。
				store.noise[target.source] = decidedAt + EVENT_NOISE_MUTE_MS;
			}
			return { code: TASK_CODE.ok, msg: "success", data: { event: eventView(target) } };
		}).catch(function (error) {
			if (error && error.code === "STORE_READONLY") return { code: PROJECT_CODE.storeReadonly, msg: "store is read-only (corrupted, backed up)", http: 503 };
			warn(ctx, "event action", error);
			return { code: TASK_CODE.internal, msg: "internal error", http: 500 };
		});
	}
	// open：先建单（项目 store 锁），再把事件置 opened（事件台账锁）——顺序不能反：
	// 工单是事实，事件只是记账；建单失败绝不能把事件标成已开工单。
	const existing = readEventsStore().events.find((item) => item.eventId === eventId);
	if (existing === undefined) return { code: TASK_CODE.notFound, msg: "event not found" };
	if (existing.state !== "pending") return { code: TASK_CODE.taskClosed, msg: "event already decided" };
	const subject = String(existing.text === undefined ? "" : existing.text).slice(0, EVENT_SUBJECT_LIMIT);
	const description = [
		typeof existing.text === "string" ? existing.text : "",
		"",
		"证据：" + (typeof existing.evidence === "string" && existing.evidence !== "" ? existing.evidence : "（无）"),
		"来源：事件台 " + existing.eventId + " · " + existing.kind + " · " + existing.source
	].join("\n");
	let created;
	try {
		created = await withStoreLock(function () {
			const read = readProjectStore();
			if (read.readonly) throw new StoreReadonlyError(projectsStoreFile(), read.backupPath);
			const project = read.store.projects[projectId];
			if (project === undefined) return { code: PROJECT_CODE.notFound, msg: "project not found" };
			const outcome = createProjectTaskInStore(read.store, project, { subject: subject, description: description });
			if (outcome.code !== undefined) return { code: outcome.code, msg: outcome.msg };
			return writeStoreFile(projectsStoreFile(), read.store).then(function () {
				return { code: TASK_CODE.ok, task: projectTaskView(read.store, outcome.task) };
			});
		});
	} catch (error) {
		if (error && error.code === "STORE_READONLY") return { code: PROJECT_CODE.storeReadonly, msg: "store is read-only (corrupted, backed up)", http: 503 };
		warn(ctx, "event open", error);
		return { code: TASK_CODE.internal, msg: "internal error", http: 500 };
	}
	if (created.code !== TASK_CODE.ok) return created;
	// 事件置 opened；这一步失败只 warn——工单已经建了（事实已成），不回滚任务。
	let decided = eventView(existing);
	try {
		decided = await mutateEvents(function (store) {
			const target = store.events[eventId];
			if (target === undefined || target.state !== "pending") return eventView(target === undefined ? existing : target);
			target.state = "opened";
			target.ticketId = created.task.taskId;
			target.decidedAt = decidedAt;
			target.decidedBy = "user";
			return eventView(target);
		});
	} catch (error) {
		warn(ctx, "event open", error);
	}
	return { code: TASK_CODE.ok, msg: "success", data: { event: decided, ticket: created.task } };
}
	// ── 3c5) W2 观测：任务时间线 / Worker 观测（T-13 event_replay）─────────────
	//
	// 设计依据（设计图 T-13，帧 e6QPoS）：「这个任务发生过什么」只挂在任务卡详情，
	// 不占导航（PRD §55.3 第 3 条：event_replay / observations 放 W2，不占 W1；
	// W1 只在任务卡上给状态与日志尾部两个最小可见性锚点）。时间线六步 =
	// Source → Trigger → Policy → Ticket → Worker → Report，一步一证据；与 §39–41
	// 账本的分工：replay 记任务生命周期，账本记送达证据，「已回复」不等于 report 为 done。
	//
	// 诚实边界（写进代码，不假装）：六步与明细全部从**既有事实**派生——
	// events.json（W1.5 台账）/ proposals.json（确认记录）/ 项目任务表（含 dispatch
	// 事实）/ handoffs.json（送达账本）/ 活动快照（running 表）/ 会话日志
	// （session.events）。没有的事实就 pending/skipped + note，不编时间、不编状态。
	// 两个路由都只读、都不要 token（与 activity / handoffs 同一定位）；各自 try/catch
	// 兜底，一处读不到不影响其它处——观测面宁可少一步证据，也不能整页 500。

	const TASK_TIMELINE_SUFFIX = "/timeline";
	const TASK_OBSERVATIONS_SUFFIX = "/observations";
	/** 时间线明细的默认条数与硬上限（与事件台/账本同级）。 */
	const TIMELINE_ENTRY_LIMIT_DEFAULT = 50;
	const TIMELINE_ENTRY_LIMIT_MAX = 200;
	/** 观测 tail 的默认条数与硬上限（与串门回读同口径）。 */
	const OBS_TAIL_LIMIT_DEFAULT = 20;
	const OBS_TAIL_LIMIT_MAX = 100;
	/**
	 * 观测单条（工具名 + 参数摘要）的截断长度：tail 是给 UI 扫的，不是给模型读全文的；
	 * 总量预算直接复用 READ_TOTAL_LIMIT——与 READ_TEXT_LIMIT / READ_TOTAL_LIMIT 同思路。
	 */
	const OBS_ENTRY_LIMIT = 500;
	/** 工具名归类词表（counts 用）。分不出来进 other——不硬编、不猜。 */
	const OBS_COMMAND_TOOLS = ["bash", "pwsh", "powershell", "shell", "sh", "cmd", "zsh", "run", "exec", "run_command", "execute_command"];
	const OBS_FILE_TOOLS = ["str-replace-editor", "fs_write", "write", "write_file", "edit", "edit_file", "create_file", "apply_patch", "patch", "multi_edit", "fs_edit", "save_file"];

	/** 解析 /agent-whales/api/tasks/<taskId>/timeline → taskId（与 /commands、/report 同套路）。 */
	function taskTimelineOf(pathname) {
		if (typeof pathname !== "string") return undefined;
		if (!pathname.startsWith(TASK_COMMANDS_PREFIX)) return undefined;
		if (!pathname.endsWith(TASK_TIMELINE_SUFFIX)) return undefined;
		const middle = pathname.slice(TASK_COMMANDS_PREFIX.length, pathname.length - TASK_TIMELINE_SUFFIX.length);
		if (middle === "" || middle.indexOf("/") >= 0) return undefined;
		try {
			return decodeURIComponent(middle);
		} catch (error) {
			return middle;
		}
	}

	/** 解析 /agent-whales/api/tasks/<taskId>/observations → taskId。 */
	function taskObservationsOf(pathname) {
		if (typeof pathname !== "string") return undefined;
		if (!pathname.startsWith(TASK_COMMANDS_PREFIX)) return undefined;
		if (!pathname.endsWith(TASK_OBSERVATIONS_SUFFIX)) return undefined;
		const middle = pathname.slice(TASK_COMMANDS_PREFIX.length, pathname.length - TASK_OBSERVATIONS_SUFFIX.length);
		if (middle === "" || middle.indexOf("/") >= 0) return undefined;
		try {
			return decodeURIComponent(middle);
		} catch (error) {
			return middle;
		}
	}

	/**
	 * 按 taskId 找项目任务。给了 projectId 就严格按项目找（taskId 全局唯一，但调用方
	 * 可能带错项目）；没给就跨全部项目按 id 找（与事件台「不带 projectId = 跨全部项目」
	 * 同口径）。返回 { kind: "task", task } / { kind: "not-found" } / { kind: "missing-project" }。
	 * missing-project 由调用方按宽松口径回空：页面轮询时项目被删不该刷错误（与 inbox 一致），
	 * 而项目存在却找不到任务才是真的 40401——两者不能混成一个错。
	 */
	function resolveObservedTask(store, rawProjectId, taskId) {
		const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
		if (projectId !== "") {
			if (store.projects[projectId] === undefined) return { kind: "missing-project", projectId: projectId };
			const task = projectTaskOf(store, projectId, taskId);
			return task === undefined ? { kind: "not-found" } : { kind: "task", task: task };
		}
		const task = ensureProjectTasks(store)[taskId];
		return task === undefined ? { kind: "not-found" } : { kind: "task", task: task };
	}

	/** 数字字段的安全读取：脏值一律当没有，绝不让 undefined 被减法强转成假事实。 */
	function finiteNumberOf(value) {
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	}

	/** 字符串字段的安全读取（null/数字都当没有）。 */
	function stringOf(value) {
		return typeof value === "string" ? value : "";
	}

	/** 任务上的来源提案（没有就是手动创建）；形状不对也当没有。 */
	function sourceProposalOf(task) {
		return task.sourceProposal !== undefined && task.sourceProposal !== null && typeof task.sourceProposal === "object" ? task.sourceProposal : undefined;
	}

	/** 任务上的 report（没有就是没回流）；形状不对也当没有。 */
	function reportOfTask(task) {
		return task.report !== undefined && task.report !== null && typeof task.report === "object" ? task.report : undefined;
	}

	/**
	 * blockedBy 的历史注脚（policy 步用）：前置 id + 解锁时间（最后一个前置完成的时间）。
	 * 仍在等待 / 前置不在就明说——不猜解锁时间。
	 */
	function blockedByNoteOf(tasks, blockedBy) {
		if (!Array.isArray(blockedBy) || blockedBy.length === 0) return undefined;
		const ids = blockedBy.map((id) => String(id));
		let unlockAt = 0;
		const waiting = [];
		for (const id of ids) {
			const blocker = tasks[id];
			if (blocker === undefined) { waiting.push(id + "（不存在）"); continue; }
			if (blocker.status === "deleted") { waiting.push(id + "（已删除）"); continue; }
			if (blocker.status !== "completed") { waiting.push(id); continue; }
			const at = finiteNumberOf(blocker.completedAt) !== undefined ? finiteNumberOf(blocker.completedAt) : (finiteNumberOf(blocker.updatedAt) !== undefined ? finiteNumberOf(blocker.updatedAt) : 0);
			if (at > unlockAt) unlockAt = at;
		}
		const head = "曾被 " + ids.join("、") + " 挡住";
		if (waiting.length > 0) return head + " · 仍在等待 " + waiting.join("、");
		return unlockAt > 0 ? head + " · 解锁于 " + unlockAt : head;
	}

	/**
	 * 六步派生（纯函数：只读 task + 关联事实，不落库不抛）。字段口径贴设计稿 T-13：
	 * phase 是阶段词（主会话/落库/评估/开工单/执行/回流），at 是这一步的发生时间，
	 * until 只给 worker 步（执行结束 = 回流时间或 completedAt），evidence 一步一证据。
	 * state ∈ done|active|pending|skipped：active 只给「正在跑」或「回流了但没关」的那一步。
	 */
	function timelineStepsOf(input) {
		const task = input.task;
		const tasks = input.tasks !== undefined && input.tasks !== null ? input.tasks : {};
		const submitEvent = input.submitEvent;
		const proposalRecord = input.proposalRecord;
		const dispatchFact = input.dispatchFact;
		const toolCounts = input.toolCounts;
		const sourceProposal = sourceProposalOf(task);
		const proposalId = sourceProposal !== undefined ? stringOf(sourceProposal.proposalId) : "";
		const report = reportOfTask(task);
		const steps = [];

		// ── source（主会话）：任务从哪来。提案来源 = proposal.submit 事件的逐字原文；
		//    手动创建（POST /tasks 不写 sourceProposal）→ skipped。
		if (proposalId === "" || submitEvent === undefined) {
			steps.push({
				key: "source",
				state: "skipped",
				phase: "主会话",
				title: "Source",
				detail: proposalId === "" ? "手动创建，无来源提案" : "来源事件已不在台账（可能已滚动归档）",
				...(proposalId === "" ? {} : { evidence: proposalId })
			});
		} else {
			const verbatim = stringOf(submitEvent.text).replace(/\s+/g, " ").trim();
			steps.push({
				key: "source",
				state: "done",
				...(finiteNumberOf(submitEvent.at) === undefined ? {} : { at: finiteNumberOf(submitEvent.at) }),
				phase: "主会话",
				title: "Source",
				detail: "「" + verbatim.slice(0, 60) + "」逐字原文，未摘要、未改写",
				evidence: stringOf(submitEvent.eventId)
			});
		}

		// ── trigger（落库）：事件落进 events.json 的事实。与 source 是同一事件的两面：
		//    source 讲「原文是什么」，trigger 讲「落库记录是什么」。
		if (proposalId === "" || submitEvent === undefined) {
			steps.push({ key: "trigger", state: "skipped", phase: "落库", title: "Trigger", detail: proposalId === "" ? "手动创建，无 Trigger" : "来源事件不在台账" });
		} else {
			steps.push({
				key: "trigger",
				state: "done",
				...(finiteNumberOf(submitEvent.at) === undefined ? {} : { at: finiteNumberOf(submitEvent.at) }),
				phase: "落库",
				title: "Trigger",
				detail: stringOf(submitEvent.eventId) + " · source=" + stringOf(submitEvent.source) + " · 未摘要、未改写",
				evidence: stringOf(submitEvent.eventId)
			});
		}

		// ── policy（评估）：策略放行。提案来源 = 提案确认那一刻（confirmed.lockedAt）；
		//    手动创建 = 任务创建即视为通过。被 blockedBy 挡过的，detail 写前置 id 与解锁时间。
		const confirmed = proposalRecord !== undefined && proposalRecord.confirmed !== undefined && proposalRecord.confirmed !== null && typeof proposalRecord.confirmed === "object" ? proposalRecord.confirmed : undefined;
		let policyAt;
		let policyDetail;
		if (proposalId === "") {
			policyAt = finiteNumberOf(task.createdAt);
			policyDetail = "手动创建，创建即通过";
		} else if (confirmed !== undefined && finiteNumberOf(confirmed.lockedAt) !== undefined) {
			policyAt = finiteNumberOf(confirmed.lockedAt);
			const createdCount = Array.isArray(confirmed.created) ? confirmed.created.length : 0;
			policyDetail = "提案 v" + String(proposalRecord.version) + " 确认 · " + createdCount + " 项建单";
		} else {
			// 有来源提案但确认记录不在/未确认：以任务创建时间近似，明说近似，不编确认时间。
			policyAt = finiteNumberOf(task.createdAt);
			policyDetail = "提案确认记录不在台账（或未确认），以任务创建时间近似";
		}
		const blockedNote = blockedByNoteOf(tasks, task.blockedBy);
		if (blockedNote !== undefined) policyDetail += " · " + blockedNote;
		steps.push(Object.assign({
			key: "policy",
			state: "done",
			phase: "评估",
			title: "Policy",
			detail: policyDetail,
			evidence: proposalId === "" ? stringOf(task.taskId) : proposalId
		}, policyAt === undefined ? {} : { at: policyAt }));

		// ── ticket（开工单）：任务创建。detail 带 subject 前 60 字 + owner + 落点。
		const ticketParts = [stringOf(task.subject).slice(0, 60)];
		ticketParts.push(stringOf(task.ownerSessionId) === "" ? "未指派 owner" : "owner " + stringOf(task.ownerSessionId));
		if (stringOf(task.worktree) !== "") ticketParts.push("落点 " + stringOf(task.worktree));
		else if (stringOf(task.execRoot) !== "") ticketParts.push("execRoot " + stringOf(task.execRoot));
		steps.push(Object.assign({
			key: "ticket",
			state: "done",
			phase: "开工单",
			title: "Ticket",
			detail: ticketParts.join(" · "),
			evidence: stringOf(task.taskId)
		}, finiteNumberOf(task.createdAt) === undefined ? {} : { at: finiteNumberOf(task.createdAt) }));

		// ── worker（执行）：owner 首次赋值没有单独时间戳，用 updatedAt 近似并注明；
		//    dispatch 事实（task.dispatch 或 dispatchFacts 里该 taskId 的最新记录）与
		//    工具归类计数（会话口径，见 gatherTimelineFacts 的说明）进 detail。
		//    until = 执行结束时间（回流 at / completedAt）；还在跑就没有 until。
		const owner = stringOf(task.ownerSessionId);
		if (owner === "") {
			steps.push({ key: "worker", state: "pending", phase: "执行", title: "Worker", detail: "未指派 owner" });
		} else {
			const detailParts = ["owner " + owner + "（无单独指派时间戳，以任务 updatedAt 近似）"];
			if (dispatchFact !== undefined) {
				const status = stringOf(dispatchFact.status);
				let factText = "派发 " + (status === "" ? "结果未知" : status);
				if (finiteNumberOf(dispatchFact.at) !== undefined) factText += " · " + String(dispatchFact.at);
				if (stringOf(dispatchFact.reason) !== "") factText += "（" + stringOf(dispatchFact.reason) + "）";
				detailParts.push(factText);
			}
			if (toolCounts !== undefined && (toolCounts.commands + toolCounts.files + toolCounts.other) > 0) {
				detailParts.push("跑命令 " + toolCounts.commands + " 次 · 写文件 " + toolCounts.files + " 个 · 其它 " + toolCounts.other + " 次");
			}
			const until = report !== undefined && finiteNumberOf(report.at) !== undefined
				? finiteNumberOf(report.at)
				: (task.status === "completed" ? finiteNumberOf(task.completedAt) : undefined);
			// 有回流、或任务已关闭，执行都算结束；否则「已指派未回流」是正在跑。
			const workerState = report !== undefined || task.status === "completed" ? "done" : "active";
			steps.push(Object.assign({
				key: "worker",
				state: workerState,
				phase: "执行",
				title: "Worker",
				detail: detailParts.join(" · ")
			}, finiteNumberOf(task.updatedAt) === undefined ? {} : { at: finiteNumberOf(task.updatedAt) }, until === undefined ? {} : { until: until }));
		}

		// ── report（回流）：report=done 即回流关闭（设计稿 T-13：关闭体现在这一步的
		//    state 上，不单列 close 步）；draft/handed_back/human_action 是「回流了
		//    但没关」→ active，summary 前 120 字进 detail。
		if (report === undefined) {
			steps.push({ key: "report", state: "pending", phase: "回流", title: "Report", detail: "尚未回流" });
		} else {
			const status = stringOf(report.status);
			const summary = stringOf(report.summary).replace(/\s+/g, " ").trim();
			const rev = report.rev === undefined ? "?" : String(report.rev);
			const detailParts = [
				status === "" ? "（无状态）" : status,
				"rev " + rev,
				"bySessionId " + (stringOf(report.bySessionId) === "" ? "（未知）" : stringOf(report.bySessionId)),
				"artifacts " + (Array.isArray(report.artifacts) ? report.artifacts.length : 0)
			];
			if (summary !== "") detailParts.push(summary.slice(0, 120));
			steps.push(Object.assign({
				key: "report",
				state: status === "done" ? "done" : "active",
				phase: "回流",
				title: "Report",
				detail: detailParts.join(" · "),
				evidence: "rev " + rev
			}, finiteNumberOf(report.at) === undefined ? {} : { at: finiteNumberOf(report.at) }));
		}
		return steps;
	}

	/** 事件是否与这个任务相关（三条显式关联规则；没有关联就不猜）。 */
	function eventRelatesToTask(event, task, proposalId) {
		if (!event || typeof event !== "object") return false;
		if (stringOf(event.ticketId) !== "" && stringOf(event.ticketId) === stringOf(task.taskId)) return true;
		const evidence = stringOf(event.evidence);
		if (evidence !== "" && evidence.indexOf(stringOf(task.taskId)) >= 0) return true;
		if (event.kind === "task.command" && stringOf(event.text).indexOf(stringOf(task.taskId)) >= 0) return true;
		if (proposalId !== "" && event.kind === "proposal.submit" && evidence === proposalId) return true;
		return false;
	}

	/**
	 * 时间线明细：三处聚合（events.json / handoffs.json / 任务自己的 report），at 倒序。
	 * 去重键 = kind|at|evidence|text：只 collapse 真正同一条记录被记了两遍的情况，
	 * 绝不会把两条不同的事实合成一条——观测面丢证据比多一条严重。
	 * 已知边界（不假装）：handoff.result 事件只记 messageId、不带 taskId，任务维度
	 * 关联不上；派发异常看 worker 步的 dispatch 事实（task.dispatch / dispatchFacts）。
	 */
	function timelineEntriesOf(task, limit) {
		const entries = [];
		const seen = new Set();
		const taskId = stringOf(task.taskId);
		const sourceProposal = sourceProposalOf(task);
		const proposalId = sourceProposal !== undefined ? stringOf(sourceProposal.proposalId) : "";
		const push = (row) => {
			const at = finiteNumberOf(row.at) === undefined ? 0 : finiteNumberOf(row.at);
			const kind = stringOf(row.kind);
			const evidence = stringOf(row.evidence);
			const text = stringOf(row.text);
			const key = kind + "|" + at + "|" + evidence + "|" + text;
			if (seen.has(key)) return;
			seen.add(key);
			entries.push(Object.assign({ at: at, kind: kind, text: text }, evidence === "" ? {} : { evidence: evidence }, stringOf(row.by) === "" ? {} : { by: stringOf(row.by) }));
		};
		// ① events.json：与该任务相关的事件（项目口径 = 任务自己的项目）。
		try {
			const snapshot = readEventsStore();
			for (const event of snapshot.events) {
				if (stringOf(event.projectId) !== stringOf(task.projectId)) continue;
				if (!eventRelatesToTask(event, task, proposalId)) continue;
				push({ at: event.at, kind: event.kind, text: clipText(stringOf(event.text)), evidence: event.evidence, by: event.decidedBy });
			}
		} catch (error) {
			/* 台账读不到只少一类明细，其它两类照给 */
		}
		// ② handoffs.json：taskId 匹配的发送记录（kind/from/to/messageId/revision）。
		try {
			const read = readStoreFile(handoffsStoreFile());
			const rows = Array.isArray(read.data.entries) ? read.data.entries : [];
			for (const row of rows) {
				if (!row || typeof row !== "object" || stringOf(row.taskId) !== taskId) continue;
				const text = "派发到 " + stringOf(row.to)
					+ (stringOf(row.messageId) === "" ? "" : " · " + stringOf(row.messageId))
					+ (finiteNumberOf(row.revision) === undefined ? "" : " · revision " + String(row.revision));
				push({ at: row.at, kind: stringOf(row.kind) === "" ? "dispatch" : stringOf(row.kind), text: text, evidence: row.messageId, by: row.from });
			}
		} catch (error) {
			/* 同上 */
		}
		// ③ 任务自己的 report 写入（当前 report 算一条：rev 就是它的身份）。
		const report = reportOfTask(task);
		if (report !== undefined) {
			push({
				at: report.at,
				kind: "report",
				text: stringOf(report.summary) === "" ? stringOf(report.status) : stringOf(report.summary),
				evidence: "rev " + (report.rev === undefined ? "?" : String(report.rev)),
				by: report.bySessionId
			});
		}
		entries.sort((a, b) => b.at - a.at);
		return entries.slice(0, limit);
	}

	/**
	 * 汇总一个任务的时间线关联事实：来源事件（proposal.submit）、提案确认记录、
	 * 最近一次 dispatch 事实、owner 会话的工具归类计数。任何一处读不到都不影响其它处。
	 */
	function gatherTimelineFacts(ctx, get, task) {
		const facts = { submitEvent: undefined, proposalRecord: undefined, dispatchFact: undefined, toolCounts: undefined };
		const sourceProposal = sourceProposalOf(task);
		const proposalId = sourceProposal !== undefined ? stringOf(sourceProposal.proposalId) : "";
		if (proposalId !== "") {
			try {
				const snapshot = readEventsStore();
				facts.submitEvent = snapshot.events.find((event) => event.kind === "proposal.submit" && stringOf(event.evidence) === proposalId);
			} catch (error) {
				/* 台账读不到就当没有来源事件，六步会如实标出来 */
			}
			try {
				const proposals = readProposalStore();
				for (const record of Object.values(proposals)) {
					if (record && typeof record === "object" && stringOf(record.proposalId) === proposalId) { facts.proposalRecord = record; break; }
				}
			} catch (error) {
				/* 同上 */
			}
		}
		// dispatch 事实：任务上的最近一次优先（写命令时 revision 未变就落在任务上）；
		// 否则 dispatchFacts 里该 taskId 的最新一条（at 倒序）——派发可能发生在旧 revision 上，
		// 按当前 revision 匹配会漏，所以取最新不取等 revision。
		try {
			if (task.dispatch !== undefined && task.dispatch !== null && typeof task.dispatch === "object") {
				facts.dispatchFact = { status: stringOf(task.dispatch.status), reason: stringOf(task.dispatch.reason) };
			} else {
				const read = readProjectStore();
				const rows = Array.isArray(read.store.dispatchFacts) ? read.store.dispatchFacts : [];
				const matched = rows
					.filter((row) => row && typeof row === "object" && row.taskId === task.taskId)
					.slice()
					.sort((a, b) => (finiteNumberOf(b.at) === undefined ? 0 : finiteNumberOf(b.at)) - (finiteNumberOf(a.at) === undefined ? 0 : finiteNumberOf(a.at)))[0];
				if (matched !== undefined && matched.dispatch && typeof matched.dispatch === "object") {
					facts.dispatchFact = { status: stringOf(matched.dispatch.status), reason: stringOf(matched.dispatch.reason), at: finiteNumberOf(matched.at) };
				}
			}
		} catch (error) {
			/* dispatch 事实读不到只影响 worker 步的 detail */
		}
		// 工具归类计数：owner 会话活着才读日志（会话口径——日志不带任务归属，
		// 数不出「这个任务跑了多少命令」，UI 别把它当任务口径用）。
		const owner = stringOf(task.ownerSessionId);
		if (owner !== "") {
			try {
				const agent = liveAgent(get, owner);
				if (agent !== undefined) {
					facts.toolCounts = toolCountsOf(toolCallsOf(sessionEvents(agent.session)));
				}
			} catch (error) {
				warn(ctx, "timeline tool counts", error);
			}
		}
		return facts;
	}

	/** 从数组里取第一个有限数字（脏值跳过）。 */
	function firstFiniteNumber(values) {
		for (const value of values) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
		return undefined;
	}

	/** 从数组里取第一个非空字符串。 */
	function firstNonEmptyString(values) {
		for (const value of values) {
			if (typeof value === "string" && value !== "") return value;
		}
		return undefined;
	}

	/** 参数摘要：arguments 可能是 JSON 字符串或对象，压成一行（截断在 tail 组装时做）。 */
	function toolArgsDigest(args) {
		let text;
		if (typeof args === "string") text = args;
		else if (args !== undefined && args !== null && typeof args === "object") {
			try {
				text = JSON.stringify(args);
			} catch (error) {
				text = "";
			}
		} else {
			text = "";
		}
		return text.replace(/\s+/g, " ").trim();
	}

	/**
	 * 从会话日志抽工具调用（observations 的 tail 用）。两种形状都认：
	 *   a) 事件级 tool/call（{ type: "tool/call", data: { name, arguments } }）；
	 *   b) assistant/message 内容块里的 tool-call（{ type: "tool-call", id, name, arguments }）——
	 *      dsh-experimental-agent-team 的 projection 契约里工具调用就是这种内容块。
	 * 同一个 callId 只留一条（a 与 b 可能重复记同一次调用）；返回保持日志顺序（即新旧顺序）。
	 */
	function toolCallsOf(events) {
		const rows = [];
		const seen = new Set();
		// 行内绝不放 undefined 键：toolCallsOf 是导出函数，返回值可能被直接 JSON 化，
		// 带 undefined 的对象过不了宿主的 lossless 校验（同 foldMessages 的 pushRow 规矩）。
		const add = (name, id, at, seq, args) => {
			const callId = id === undefined ? "" : String(id);
			if (callId !== "") {
				if (seen.has(callId)) return;
				seen.add(callId);
			}
			rows.push(Object.assign({ name: name }, at === undefined ? {} : { at: at }, seq === undefined ? {} : { seq: seq }, args === undefined ? {} : { args: args }));
		};
		for (const event of Array.isArray(events) ? events : []) {
			if (!event || typeof event !== "object") continue;
			const data = event.data !== undefined && event.data !== null && typeof event.data === "object" ? event.data : undefined;
			const at = firstFiniteNumber([event.at, event.time, event.timestamp, event.ts, data === undefined ? undefined : data.at, data === undefined ? undefined : data.time]);
			const seq = firstFiniteNumber([event.seq]);
			if (event.type === "tool/call") {
				const name = firstNonEmptyString([data === undefined ? undefined : data.name, data === undefined ? undefined : (data.tool && data.tool.name), data === undefined ? undefined : data.toolName, event.name]);
				const id = firstNonEmptyString([data === undefined ? undefined : data.id, data === undefined ? undefined : data.callId, event.callId]);
				add(name === undefined ? "" : name, id, at, seq, toolArgsDigest(data === undefined ? event.arguments : (data.arguments === undefined ? event.arguments : data.arguments)));
			} else if (event.type === "assistant/message") {
				const message = data !== undefined && data.message !== undefined && data.message !== null && typeof data.message === "object" ? data.message : undefined;
				const content = message !== undefined && Array.isArray(message.content) ? message.content : [];
				for (const block of content) {
					if (!block || typeof block !== "object" || block.type !== "tool-call") continue;
					add(stringOf(block.name), stringOf(block.id) === "" ? undefined : stringOf(block.id), at, seq, toolArgsDigest(block.arguments));
				}
			}
		}
		return rows;
	}

	/** 工具名归类（counts）。分不出来进 other——不硬编、不猜。 */
	function toolCountsOf(rows) {
		const counts = { commands: 0, files: 0, other: 0 };
		for (const row of Array.isArray(rows) ? rows : []) {
			const name = row && typeof row.name === "string" ? row.name : "";
			if (OBS_COMMAND_TOOLS.indexOf(name) >= 0) counts.commands += 1;
			else if (OBS_FILE_TOOLS.indexOf(name) >= 0) counts.files += 1;
			else counts.other += 1;
		}
		return counts;
	}

	/**
	 * tail 组装：日志顺序即新旧，按 seq（没有 seq 才按 at）倒序取最近 limit 条；
	 * 单条（工具名 + 参数摘要）截断到 OBS_ENTRY_LIMIT，总量预算 READ_TOTAL_LIMIT，
	 * 超了从老的一侧砍、至少留一条（与 whales_visit_read 同一套护栏思路）。
	 */
	function observationTailOf(rows, limit) {
		// limit 归一：非正数/脏值按默认 20（路由侧另有 1..100 的夹取；纯函数不重复夹）。
		const cap = finiteNumberOf(limit);
		const take = cap === undefined ? OBS_TAIL_LIMIT_DEFAULT : Math.max(1, Math.floor(cap));
		const ordered = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
			const seqA = a.seq === undefined ? -1 : a.seq;
			const seqB = b.seq === undefined ? -1 : b.seq;
			if (seqA !== seqB) return seqB - seqA;
			const atA = a.at === undefined ? -1 : a.at;
			const atB = b.at === undefined ? -1 : b.at;
			return atB - atA;
		});
		const recent = ordered.slice(0, take);
		const tail = [];
		let budget = READ_TOTAL_LIMIT;
		for (const row of recent) {
			const name = row.name === "" ? "unknown" : row.name;
			const args = row.args.length > OBS_ENTRY_LIMIT ? row.args.slice(0, OBS_ENTRY_LIMIT) + "…" : row.args;
			const size = name.length + args.length;
			if (tail.length > 0 && budget - size < 0) break;
			budget -= size;
			tail.push(Object.assign({ tool: name }, row.at === undefined ? {} : { at: row.at }, row.seq === undefined ? {} : { seq: row.seq }, args === "" ? {} : { args: args }));
		}
		return tail;
	}

	/** 观测路由的 limit 解析（默认 20、上限 100，与串门回读同口径）。 */
	function observationLimitOf(req) {
		let limit = OBS_TAIL_LIMIT_DEFAULT;
		const rawLimit = queryParam(req.url, "limit");
		if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
			const parsed = Number(rawLimit);
			if (Number.isFinite(parsed)) limit = Math.min(Math.max(Math.floor(parsed), 1), OBS_TAIL_LIMIT_MAX);
		}
		return limit;
	}

	/**
	 * GET /agent-whales/api/tasks/:taskId/timeline?projectId=&limit=
	 * 六步时间线（T-13）+ 明细流水。只读、无 token。项目不存在时宽松回空 + note
	 * （页面轮询时项目被删不该刷错误，与 inbox 同口径）；taskId 真不存在 → 40401。
	 */
	function handleTaskTimelineRequest(ctx, req, res, get, taskId) {
		const method = requestMethod(req);
		if (method !== "GET" && method !== "HEAD") {
			res.setHeader("allow", "GET, HEAD");
			sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
			return;
		}
		try {
			const rawProjectId = queryParam(req.url, "projectId");
			const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
			let limit = TIMELINE_ENTRY_LIMIT_DEFAULT;
			const rawLimit = queryParam(req.url, "limit");
			if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
				const parsed = Number(rawLimit);
				if (Number.isFinite(parsed)) limit = Math.min(Math.max(Math.floor(parsed), 1), TIMELINE_ENTRY_LIMIT_MAX);
			}
			const read = readProjectStore();
			const resolved = resolveObservedTask(read.store, projectId, taskId);
			if (resolved.kind === "missing-project") {
				sendEnvelope(res, 200, TASK_CODE.ok, "success", {
					source: "project",
					projectId: projectId === "" ? null : projectId,
					taskId: taskId,
					steps: [],
					entries: [],
					note: "项目不存在（可能已删除），时间线为空"
				});
				return;
			}
			if (resolved.kind === "not-found") {
				sendEnvelope(res, 200, TASK_CODE.notFound, "task not found");
				return;
			}
			const task = resolved.task;
			const facts = gatherTimelineFacts(ctx, get, task);
			const steps = timelineStepsOf({
				task: task,
				tasks: ensureProjectTasks(read.store),
				submitEvent: facts.submitEvent,
				proposalRecord: facts.proposalRecord,
				dispatchFact: facts.dispatchFact,
				toolCounts: facts.toolCounts
			});
			const entries = timelineEntriesOf(task, limit);
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", {
				source: "project",
				projectId: stringOf(task.projectId),
				taskId: stringOf(task.taskId),
				steps: steps,
				entries: entries
			});
		} catch (error) {
			warn(ctx, "task timeline", error);
			sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
		}
	}

	/**
	 * GET /agent-whales/api/tasks/:taskId/observations?projectId=&limit=
	 * Worker 侧「这个任务正在发生什么」：owner 会话的当前工具（活动快照，与 /activity
	 * 同一张表同一套 TTL——执行台同源）+ 日志尾部（tool/call 事件）。
	 * 只读、无 token；owner 没指派 / 会话不在跑 / 服务缺失都回空 + note，绝不抛。
	 */
	function handleTaskObservationsRequest(ctx, req, res, get, running, taskId) {
		const method = requestMethod(req);
		if (method !== "GET" && method !== "HEAD") {
			res.setHeader("allow", "GET, HEAD");
			sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
			return;
		}
		try {
			const rawProjectId = queryParam(req.url, "projectId");
			const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
			const limit = observationLimitOf(req);
			const read = readProjectStore();
			const resolved = resolveObservedTask(read.store, projectId, taskId);
			if (resolved.kind === "missing-project") {
				// 宽松回空（与 inbox / timeline 同口径）：项目被删时页面轮询不该刷错误。
				sendEnvelope(res, 200, TASK_CODE.ok, "success", {
					source: "project",
					projectId: projectId === "" ? null : projectId,
					taskId: taskId,
					sessionId: null,
					current: null,
					tail: [],
					note: "项目不存在（可能已删除），观测为空"
				});
				return;
			}
			if (resolved.kind === "not-found") {
				sendEnvelope(res, 200, TASK_CODE.notFound, "task not found");
				return;
			}
			const task = resolved.task;
			const owner = stringOf(task.ownerSessionId);
			if (owner === "") {
				sendEnvelope(res, 200, PROJECT_CODE.ok, "success", {
					source: "project",
					projectId: stringOf(task.projectId),
					taskId: stringOf(task.taskId),
					sessionId: null,
					current: null,
					tail: [],
					note: "任务未指派 owner，没有可观测的执行会话"
				});
				return;
			}
			// current：活动快照。TTL 与 /activity 同一套口径——5 分钟内的条目都算新；
			// 更老的只有会话还在跑才报（wait_agent 这类长跑工具不能从头顶消失）。
			let current = null;
			try {
				const table = flattenActivity(running);
				const entry = table.get(owner);
				if (entry !== undefined && typeof entry.tool === "string" && finiteNumberOf(entry.startedAt) !== undefined) {
					const now = Date.now();
					const age = now - entry.startedAt;
					const agent = liveAgent(get, owner);
					const fresh = age >= 0 && (age <= ACTIVITY_TTL_MS || (age <= ACTIVITY_MAX_AGE_MS && agent !== undefined && agent.status === "running"));
					if (fresh) current = { tool: entry.tool, ageMs: age };
				}
			} catch (error) {
				current = null;
			}
			// tail + counts：会话日志的 tool/call 事件。取不到（会话不在跑/服务缺失）
			// → 空 + note；日志里还没有工具调用也明说，不拿空数组装没事。
			let tail = [];
			let counts;
			let note;
			try {
				const agent = liveAgent(get, owner);
				if (agent === undefined) {
					note = "owner 会话当前不在运行，读不到日志尾部";
				} else {
					const rows = toolCallsOf(sessionEvents(agent.session));
					counts = toolCountsOf(rows);
					tail = observationTailOf(rows, limit);
					if (tail.length === 0) note = "会话日志里还没有工具调用";
				}
			} catch (error) {
				tail = [];
				note = "会话日志读取失败，只给活动快照";
			}
			sendEnvelope(res, 200, PROJECT_CODE.ok, "success", Object.assign({
				source: "project",
				projectId: stringOf(task.projectId),
				taskId: stringOf(task.taskId),
				sessionId: owner,
				current: current,
				tail: tail
			}, counts === undefined ? {} : { counts: counts }, note === undefined ? {} : { note: note }));
		} catch (error) {
			warn(ctx, "task observations", error);
			sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
		}
	}


// ── 3c4) M6 工作台读接口：会话目录 ──────────────────────────────────────────
//
// 「加入已有对话 / 对话简报列表 / 画布 Agent 节点 / owner 显示名」都要把 sessionId
// 渲染成人能认的标题，浏览器半边自己拼不出这个目录。数据来源与 sessionExists 同源
// （sessions 附着 / agents live / sessionPersistence 归档），只读、不拉起任何会话。

const SESSIONS_ENDPOINT = `${ACTIVITY_PATH}/sessions`;
const SESSIONS_MAX_ROWS = 500;

/** 枚举 sessions 服务的会话行：兼容 list() / byId（Map 或对象）/ ids（数组或函数）三种形状。 */
async function sessionRowsOf(sessions) {
	const rows = [];
	const push = (id, session) => {
		const key = typeof id === "string" && id !== "" ? id
			: session && typeof session.id === "string" ? session.id
				: session && typeof session.sessionId === "string" ? session.sessionId : "";
		if (key !== "") rows.push({ sessionId: key, session: session && typeof session === "object" ? session : {} });
	};
	if (!sessions || typeof sessions !== "object") return rows;
	try {
		if (typeof sessions.list === "function") {
			const list = await Promise.resolve(sessions.list());
			if (Array.isArray(list)) {
				for (const session of list) push(undefined, session);
				if (rows.length > 0) return rows;
			}
		}
	} catch (error) { /* 换下一种形状 */ }
	try {
		const byId = sessions.byId;
		if (byId instanceof Map) {
			for (const [id, session] of byId) push(id, session);
			if (rows.length > 0) return rows;
		}
		if (byId && typeof byId === "object") {
			for (const [id, session] of Object.entries(byId)) push(id, session);
			if (rows.length > 0) return rows;
		}
	} catch (error) { /* 继续 */ }
	try {
		const ids = typeof sessions.ids === "function" ? await Promise.resolve(sessions.ids()) : sessions.ids;
		if (Array.isArray(ids)) {
			for (const entry of ids) {
				if (typeof entry === "string") push(entry, typeof sessions.get === "function" ? sessions.get(entry) : undefined);
				else if (entry && typeof entry === "object") push(undefined, entry);
			}
		}
	} catch (error) { /* 枚举不了就给空目录 */ }
	return rows;
}

// ── v2.2 波次 4：文件 / 外部引用节点（只认事实，不靠模型自报）────────────────────
//
// 来源三路：① 会话日志 tool/call 里读 / 写类工具的路径参数（与 observations 同源，不另建采集）；
// ② 任务 report.artifacts（kind=file）；③ 用户消息里的 @路径 与 http(s) 链接。
// 链接按域名分 notion / feishu / web（D-1 扩展：外部引用也做节点）。
const REF_PATH_KEYS = ["file_path", "filePath", "path", "target_file", "notebook_path", "file", "filename"];
const REF_WRITE_TOOL = /(write|edit|patch|create|replace|delete|remove|move|rename|save)/i;
const REF_READ_TOOL = /(read|grep|glob|view|cat|open|list|search|find|image|inspect|load)/i;
const REF_URL = /https?:\/\/[^\s<>"'`)\]}，。；、！？]+/g;
const REF_AT_PATH = /@(?:"([^"]+)"|([A-Za-z]:[\\/][^\s"'，。；]+|\/[^\s"'，。；]+|[\w.\-\\/]+\.[A-Za-z0-9]{1,8}))/g;
const REF_SCAN_EVENTS = 3000;
const REF_CACHE_MS = 10000;
const REF_MAX_FILES = 200;
const REF_MAX_LINKS = 60;
const refSessionCache = new Map();

/** 路径归一成去重键：反斜杠转正斜杠、去尾斜杠、Windows 盘符路径不分大小写。 */
function refPathKey(raw) {
	let value = String(raw || "").trim().replace(/^file:\/\/\/?/i, "");
	try { value = decodeURIComponent(value); } catch (error) { /* 原样 */ }
	value = value.replace(/\\/g, "/").replace(/\/+$/, "");
	if (value === "" || value.length > 400) return "";
	return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

/** 链接分类：notion / feishu / web（D-1：外部引用也做节点）。 */
function refLinkKind(url) {
	let host = "";
	try { host = new URL(url).hostname.toLowerCase(); } catch (error) { return "web"; }
	if (/(^|\.)notion\.(so|site|com)$/.test(host)) return "notion";
	if (/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com|feishu\.net)$/.test(host)) return "feishu";
	return "web";
}

/** 一个会话日志 → { files: {key: {path, read, write, ref, at}}, links: {url: {url, kind, at}} }。纯函数。 */
export function referencesFromEvents(events) {
	const files = {};
	const links = {};
	const list = Array.isArray(events) ? events : [];
	const start = Math.max(0, list.length - REF_SCAN_EVENTS);
	function touchFile(raw, mark, at) {
		const key = refPathKey(raw);
		if (key === "") return;
		const shown = String(raw).trim().replace(/^file:\/\/\/?/i, "").replace(/\\/g, "/");
		const row = files[key] || (files[key] = { path: shown, read: 0, write: 0, ref: 0, at: 0 });
		row[mark] += 1;
		if (at > row.at) row.at = at;
	}
	function touchLink(url, at) {
		const clean = String(url).replace(/[.,;:!?]+$/, "");
		if (clean.length > 500) return;
		const row = links[clean] || (links[clean] = { url: clean, kind: refLinkKind(clean), at: 0 });
		if (at > row.at) row.at = at;
	}
	for (let i = start; i < list.length; i += 1) {
		const event = list[i];
		if (!event || typeof event !== "object") continue;
		const at = typeof event.time === "number" ? event.time : (typeof event.seq === "number" ? event.seq : 0);
		const data = event.data && typeof event.data === "object" ? event.data : {};
		if (event.type === "tool/call") {
			const name = typeof data.name === "string" ? data.name : "";
			let args = data.arguments;
			if (typeof args === "string") { try { args = JSON.parse(args); } catch (error) { args = undefined; } }
			if (!args || typeof args !== "object") continue;
			const mark = REF_WRITE_TOOL.test(name) ? "write" : "read";
			for (const key of REF_PATH_KEYS) {
				if (typeof args[key] === "string" && args[key].trim() !== "") touchFile(args[key], mark, at);
			}
			if (Array.isArray(args.paths)) args.paths.forEach((value) => { if (typeof value === "string") touchFile(value, mark, at); });
			if (typeof args.uri === "string" && /^file:\/\//i.test(args.uri)) touchFile(args.uri, mark, at);
			if (typeof args.url === "string" && /^https?:\/\//i.test(args.url)) touchLink(args.url, at);
			if (Array.isArray(args.urls)) args.urls.forEach((value) => { if (typeof value === "string" && /^https?:\/\//i.test(value)) touchLink(value, at); });
			continue;
		}
		if (event.type === "user/message") {
			const source = data.source;
			if (source !== undefined && (source === null || typeof source !== "object" || source.kind !== "user")) continue;
			const text = blockText(data.content);
			if (typeof text !== "string" || text === "") continue;
			for (const match of text.matchAll(REF_URL)) touchLink(match[0], at);
			for (const match of text.matchAll(REF_AT_PATH)) {
				const raw = match[1] || match[2] || "";
				if (raw !== "" && !/^https?:/i.test(raw)) touchFile(raw, "ref", at);
			}
		}
	}
	return { files, links };
}

/** 读会话日志并折叠成引用（10 秒缓存：画布每 5 秒轮询，长会话日志不能每次都全量解析）。 */
async function sessionReferences(get, sessionId) {
	const cached = refSessionCache.get(sessionId);
	if (cached && Date.now() - cached.at < REF_CACHE_MS) return cached.value;
	let value;
	try { value = referencesFromEvents(await readSessionLog(get, sessionId)); } catch (error) { value = { files: {}, links: {} }; }
	refSessionCache.set(sessionId, { at: Date.now(), value });
	if (refSessionCache.size > 200) refSessionCache.delete(refSessionCache.keys().next().value);
	return value;
}

/**
 * GET /projects/:id/references（只读、无 token）：
 * { files: [{ key, path, at, sessions: { sid: {read, write, ref, at} } }], links: [{ url, kind, at, sessions: [sid] }] }
 * 按最近使用时间倒序；artifacts 记为该任务 owner「改过」。
 */
async function projectReferences(get, project, tasks) {
	const members = Array.isArray(project.members) ? project.members.map((member) => member && member.sessionId).filter((id) => typeof id === "string" && id !== "") : [];
	if (typeof project.mainSessionId === "string" && members.indexOf(project.mainSessionId) < 0) members.unshift(project.mainSessionId);
	const files = {};
	const links = {};
	function addFile(sessionId, key, row) {
		const file = files[key] || (files[key] = { key: key, path: row.path, at: 0, sessions: {} });
		const mark = file.sessions[sessionId] || (file.sessions[sessionId] = { read: 0, write: 0, ref: 0, at: 0 });
		mark.read += row.read || 0;
		mark.write += row.write || 0;
		mark.ref += row.ref || 0;
		if ((row.at || 0) > mark.at) mark.at = row.at || 0;
		if ((row.at || 0) > file.at) file.at = row.at || 0;
	}
	for (const sessionId of members) {
		const refs = await sessionReferences(get, sessionId);
		for (const key of Object.keys(refs.files)) addFile(sessionId, key, refs.files[key]);
		for (const url of Object.keys(refs.links)) {
			const row = refs.links[url];
			const link = links[url] || (links[url] = { url: url, kind: row.kind, at: 0, sessions: [] });
			if (link.sessions.indexOf(sessionId) < 0) link.sessions.push(sessionId);
			if (row.at > link.at) link.at = row.at;
		}
	}
	for (const task of Array.isArray(tasks) ? tasks : []) {
		const owner = task && typeof task.ownerSessionId === "string" ? task.ownerSessionId : "";
		const artifacts = task && task.report && Array.isArray(task.report.artifacts) ? task.report.artifacts : [];
		if (owner === "") continue;
		for (const item of artifacts) {
			const ref = item && typeof item === "object" ? item.ref : item;
			if (typeof ref !== "string" || ref.trim() === "") continue;
			if (/^https?:\/\//i.test(ref)) {
				const link = links[ref] || (links[ref] = { url: ref, kind: refLinkKind(ref), at: 0, sessions: [] });
				if (link.sessions.indexOf(owner) < 0) link.sessions.push(owner);
				continue;
			}
			const key = refPathKey(ref);
			if (key !== "") addFile(owner, key, { path: ref, write: 1, at: task.report.at || 0 });
		}
	}
	return {
		files: Object.values(files).sort((a, b) => b.at - a.at).slice(0, REF_MAX_FILES),
		links: Object.values(links).sort((a, b) => b.at - a.at).slice(0, REF_MAX_LINKS)
	};
}

/** 画布 Composer 读回复：单条正文上限与条数上限（防一次性把长会话全塞进浏览器）。 */
const SESSION_MESSAGES_DEFAULT = 8;
const SESSION_MESSAGES_MAX = 40;
const SESSION_MESSAGE_TEXT_CAP = 4000;

/**
 * GET /agent-whales/api/sessions/:sessionId/messages?limit=
 * 画布优先（PRD v2.2 九（续二））：画布上的 Composer 卡要显示主对话的回复。
 * 走与 whales_visit_trace 同一条读口（sessionQuery.readSession，活会话读内存、离线读盘），
 * 只折叠「谁说了什么」的文本行，不含工具调用明细。只读、无 token（与 /sessions 同一定位）。
 * 读不到（会话不存在 / 不在线且无 sessionQuery）→ 200 + notFound 业务码，不刷 500。
 */
async function handleSessionMessagesRequest(ctx, req, res, get, sessionId) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	const id = typeof sessionId === "string" ? sessionId.trim() : "";
	if (id === "") {
		sendEnvelope(res, 400, TASK_CODE.param, "sessionId is required");
		return;
	}
	const rawLimit = Number(queryParam(req.url, "limit"));
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), SESSION_MESSAGES_MAX) : SESSION_MESSAGES_DEFAULT;
	let events;
	try {
		events = await readSessionLog(get, id);
	} catch (error) {
		sendEnvelope(res, 200, PROJECT_CODE.notFound, error && error.message ? error.message : "session not readable");
		return;
	}
	const all = foldMessages(events);
	const rows = all.slice(-limit).map((row) => {
		const text = typeof row.text === "string" ? row.text : "";
		const out = { role: row.role, text: text.length > SESSION_MESSAGE_TEXT_CAP ? text.slice(0, SESSION_MESSAGE_TEXT_CAP) + "…" : text };
		if (Number.isFinite(row.seq)) out.seq = row.seq;
		return out;
	});
	sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { sessionId: id, total: all.length, rows: rows });
}

/** GET /agent-whales/api/sessions：会话目录（只读、无 token；live 优先，再按标题排序）。 */
async function handleSessionsRequest(ctx, req, res, get) {
	const method = requestMethod(req);
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, TASK_CODE.param, "method not allowed");
		return;
	}
	let sessions = [];
	try {
		const service = typeof get === "function" ? get("sessions") : undefined;
		const agents = typeof get === "function" ? get("agents") : undefined;
		const persistence = typeof get === "function" ? get("sessionPersistence") : undefined;
		const rows = (await sessionRowsOf(service)).slice(0, SESSIONS_MAX_ROWS);
		for (const row of rows) {
			const id = row.sessionId;
			const session = row.session;
			const header = session.header !== undefined && session.header !== null && typeof session.header === "object" ? session.header : session;
			let attached;
			try { attached = service && typeof service.get === "function" ? service.get(id) : undefined; } catch (error) { attached = undefined; }
			let agent;
			try { agent = agents && typeof agents.get === "function" ? agents.get(id) : undefined; } catch (error) { agent = undefined; }
			const live = attached !== undefined || agent !== undefined;
			const running = session.running === true || (agent !== undefined && agent.status === "running");
			// 归档判定只对非 live 的做：live 会话不必碰持久化，省掉最多 500 次 stat。
			let archived = false;
			if (!live && persistence && typeof persistence.stat === "function") {
				try {
					const stat = await Promise.resolve(persistence.stat(id));
					archived = stat !== undefined && stat !== null && stat !== false;
				} catch (error) { archived = false; }
			}
			const parentSessionId = typeof header.parentSessionId === "string" ? header.parentSessionId
				: typeof header.parentSession === "string" ? header.parentSession : undefined;
			const rawTitle = typeof session.title === "string" ? session.title
				: typeof header.title === "string" ? header.title : titleOf(session.events);
			// 观测层：把这个会话最近调过的工具一起下发（有才给，没调过就不塞空数组）。
			const recentTools = sessionToolCalls(sessionEvents(session));
			sessions.push({
				sessionId: id,
				title: typeof rawTitle === "string" ? rawTitle : "",
				running: running === true,
				live: live === true,
				archived: archived === true,
				...(parentSessionId === undefined ? {} : { parentSessionId: parentSessionId }),
				...(recentTools.length > 0 ? { recentTools: recentTools } : {})
			});
		}
		// live 优先，再按标题：UI 选 owner / 加人时先看到正在跑的对话。
		sessions.sort((a, b) => (b.live === true ? 1 : 0) - (a.live === true ? 1 : 0) || a.title.localeCompare(b.title));
	} catch (error) {
		// 目录读不到（服务缺失/形状变了）给空数组：UI 显示「暂无会话」，不白屏。
		warn(ctx, "sessions route", error);
		sessions = [];
	}
	sendEnvelope(res, 200, PROJECT_CODE.ok, "success", { source: "host", sessions: sessions });
}

// ── 3c5) M6 工作台写接口：新建任务 ──────────────────────────────────────────
//
// U-3 任务页有「＋ 新建任务」：没有这个路由时 UI 只能绕道提案。校验全部复用
// createProjectTaskInStore（跨项目 blockedBy 40704 / 成环 40705 / deleted blocker 40906）。

/**
 * POST /agent-whales/api/tasks
 * body: { projectId, subject, description?, blockedBy?, writeScopes?, worktree?, execRoot?, requestId? }
 * requestId 提供时进程内去重（简化版 commands 幂等）：同 ID 直接回放已建任务，不重复写。
 */
function handleTaskCreateRequest(ctx, req, res, control) {
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
			const raw = await readRequestBody(req, ROUTE_BODY_LIMIT);
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
			if (projectId === "") {
				sendEnvelope(res, 400, TASK_CODE.param, "projectId is required");
				return;
			}
			const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
			if (subject === "") {
				sendEnvelope(res, 400, TASK_CODE.param, "subject is required");
				return;
			}
			const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
			control.taskCreateMemo = control.taskCreateMemo || new Map();
			if (requestId !== "") {
				const remembered = control.taskCreateMemo.get(requestId);
				if (remembered !== undefined) {
					sendEnvelope(res, 200, TASK_CODE.ok, "success", { source: "project", task: remembered, replayed: true });
					return;
				}
			}
			let created;
			try {
				created = await withStoreLock(function () {
					const read = readProjectStore();
					if (read.readonly) throw new StoreReadonlyError(projectsStoreFile(), read.backupPath);
					const project = read.store.projects[projectId];
					if (project === undefined) return { code: PROJECT_CODE.notFound, msg: "project not found" };
					const outcome = createProjectTaskInStore(read.store, project, {
						subject: subject,
						description: typeof payload.description === "string" ? payload.description : "",
						blockedBy: payload.blockedBy,
						writeScopes: payload.writeScopes,
						worktree: payload.worktree,
						execRoot: payload.execRoot
					});
					if (outcome.code !== undefined) return { code: outcome.code, msg: outcome.msg };
					return writeStoreFile(projectsStoreFile(), read.store).then(function () {
						return { code: TASK_CODE.ok, task: projectTaskView(read.store, outcome.task) };
					});
				});
			} catch (error) {
				if (error && error.code === "STORE_READONLY") {
					sendEnvelope(res, 503, PROJECT_CODE.storeReadonly, "store is read-only (corrupted, backed up)");
					return;
				}
				throw error;
			}
			if (created.code !== TASK_CODE.ok) {
				sendEnvelope(res, 200, created.code, created.msg);
				return;
			}
			if (requestId !== "") {
				control.taskCreateMemo.set(requestId, created.task);
				while (control.taskCreateMemo.size > TASK_COMMAND_MEMO_LIMIT) {
					const oldest = control.taskCreateMemo.keys().next();
					if (oldest.done) break;
					control.taskCreateMemo.delete(oldest.value);
				}
			}
			sendEnvelope(res, 200, TASK_CODE.ok, "success", { source: "project", task: created.task });
		} catch (error) {
			warn(ctx, "task create", error);
			sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
		}
	})();
}



// ── 3c) 画布页（R1 返工）：节点位置入 store，agent 可读写 ────────────────────
//
// 设计口径（PRD v2.1 §57.2 第 1 层）：
// - 节点是**派生**的：上下文节点来自任务落点（worktree/execRoot），Agent 节点来自项目成员，
//   Composer 是主会话。所以没有 node_add / node_delete——加节点等于加任务或加成员，那两条路已有 CAS。
// - 画布页只存「人摆过的位置」；连线复用 projects.json 的 links（单一真源，不复制一份）。
// - 位置写入带 expectedRevision，冲突 40902，重报不覆盖（与 §53.9.12 report CAS 同一套纪律）。
// - 没摆过的节点不落 store：用派生默认位置，避免一上来就写一堆噪声。
const CANVAS_SUFFIX = "canvas.json";
const CANVAS_PREFIX = ACTIVITY_PATH + "/canvas";
const CANVAS_CODE = {
	ok: 200,
	badRequest: 40001,
	notFound: 40401,
	revConflict: 40902,
	forbidden: 40301,
	storeReadonly: 40503,
	internal: 50000
};

function canvasStoreFile() {
	return join(PROPOSAL_STORE_DIR, CANVAS_SUFFIX);
}

/** 画布页读：不存在返回空页（rev 0），不报错——没摆过也是合法状态。 */
function canvasPageOf(store, projectId) {
	const pages = store && typeof store.pages === "object" && store.pages !== null && !Array.isArray(store.pages) ? store.pages : {};
	const page = pages[projectId];
	if (!page || typeof page !== "object" || Array.isArray(page)) return { rev: 0, nodes: {}, elements: {} };
	const nodes = page.nodes && typeof page.nodes === "object" && !Array.isArray(page.nodes) ? page.nodes : {};
	const elements = page.elements && typeof page.elements === "object" && !Array.isArray(page.elements) ? page.elements : {};
	return { rev: Number.isFinite(page.rev) ? page.rev : 0, nodes, elements };
}

// ── 画布元素（PRD v2.2 波次 3：store 元素化）────────────────────────────────────
//
// 位置表（nodes）只存「派生节点」被人摆过的坐标；元素表（elements）存「创作元素」本身——
// 文件 / 外部引用 / 流程图节点 / 原型帧 / 组件库 / 分组 / 便签 / 创作连线。agent 与人都能增删改，
// 与位置表共用同一个 rev（CAS，冲突 40902 不覆盖）。人改过的元素标 userEdited，之后 agent
// 的写入会被跳过并在 locked 里点名（D-2：手改锁定，重新生成只补新增）。
const CANVAS_ELEMENT_KINDS = ["note", "group", "file", "link", "flow", "prototype", "library", "edge"];
const CANVAS_ELEMENT_DATA_CAP = 16 * 1024;
/** 原型帧存整页 Puck 数据，单独放宽到 64KB。 */
const CANVAS_PROTOTYPE_DATA_CAP = 64 * 1024;
const CANVAS_ELEMENT_MAX = 400;

/**
 * 清洗一个元素；不合法返回 { error }。坐标可以省略（null → 客户端 dagre 自动布局）。
 * edge 元素必须有 data.source / data.target（指向元素 id 或派生节点 id）。
 */
function cleanCanvasElement(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "element must be an object" };
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (id === "" || id.length > 80) return { error: "element id required (≤ 80 chars)" };
	const kind = typeof raw.kind === "string" ? raw.kind : "";
	if (CANVAS_ELEMENT_KINDS.indexOf(kind) < 0) return { error: "unknown element kind: " + kind + " (" + id + ")" };
	const num = (value) => (value === null || value === undefined || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
	const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : {};
	let size;
	try { size = Buffer.byteLength(JSON.stringify(data), "utf8"); } catch (error) { return { error: "element data is not serializable (" + id + ")" }; }
	if (size > (kind === "prototype" ? CANVAS_PROTOTYPE_DATA_CAP : CANVAS_ELEMENT_DATA_CAP)) return { error: "element data exceeds " + (kind === "prototype" ? "64KB" : "16KB") + " (" + id + ")" };
	if (kind === "edge" && (typeof data.source !== "string" || typeof data.target !== "string" || data.source === "" || data.target === "")) {
		return { error: "edge element needs data.source and data.target (" + id + ")" };
	}
	const provenance = raw.provenance && typeof raw.provenance === "object" && !Array.isArray(raw.provenance) ? raw.provenance : {};
	return {
		element: {
			id: id,
			kind: kind,
			x: num(raw.x), y: num(raw.y), w: num(raw.w), h: num(raw.h),
			...(typeof raw.parentId === "string" && raw.parentId !== "" ? { parentId: raw.parentId } : {}),
			data: data,
			provenance: {
				by: provenance.by === "agent" ? "agent" : "user",
				...(typeof provenance.sessionId === "string" && provenance.sessionId !== "" ? { sessionId: provenance.sessionId } : {}),
				...(Array.isArray(provenance.sourceMessageIds) ? { sourceMessageIds: provenance.sourceMessageIds.map((value) => String(value)).slice(0, 50) } : {})
			}
		}
	};
}

/**
 * 元素表的一次写入（HTTP 与将来的 flow.* 工具共用）。
 * change: { expectedRevision, upsert?: [], remove?: [], by: "user"|"agent", sessionId? }
 * 返回 { projectId, rev, elements, locked, rejected }；rev 冲突抛 canvasRevisionError。
 */
async function applyCanvasElements(projectId, change) {
	const by = change && change.by === "agent" ? "agent" : "user";
	const upsert = Array.isArray(change && change.upsert) ? change.upsert : [];
	const remove = Array.isArray(change && change.remove) ? change.remove.map((value) => String(value)) : [];
	const cleaned = [];
	const rejected = [];
	for (const raw of upsert) {
		const result = cleanCanvasElement(raw);
		if (result.error !== undefined) rejected.push({ id: raw && typeof raw.id === "string" ? raw.id : "", reason: result.error });
		else cleaned.push(result.element);
	}
	return mutateCanvas(function (store) {
		if (store.pages === undefined || store.pages === null || typeof store.pages !== "object" || Array.isArray(store.pages)) store.pages = {};
		const page = canvasPageOf(store, projectId);
		if (page.rev !== Number(change.expectedRevision)) throw canvasRevisionError(page, projectId);
		const elements = Object.assign({}, page.elements);
		const locked = [];
		const now = new Date().toISOString();
		for (const element of cleaned) {
			const existing = elements[element.id];
			if (by === "agent" && existing && existing.userEdited === true) { locked.push(element.id); continue; }
			element.provenance = Object.assign({}, element.provenance, { by: existing && existing.provenance ? existing.provenance.by : by });
			if (by === "agent" && change.sessionId && !element.provenance.sessionId) element.provenance.sessionId = String(change.sessionId);
			// 人动过 agent 生成的元素 → 锁定（之后 agent 重画不覆盖）；人自己建的元素本来就是人的。
			element.userEdited = by === "user" ? true : (existing ? existing.userEdited === true : false);
			element.updatedAt = now;
			element.createdAt = existing && existing.createdAt ? existing.createdAt : now;
			elements[element.id] = element;
		}
		for (const id of remove) {
			if (elements[id] === undefined) continue;
			if (by === "agent" && elements[id].userEdited === true) { locked.push(id); continue; }
			delete elements[id];
			// 删元素顺带删挂在它上面的创作连线，不留指向空气的线
			for (const key of Object.keys(elements)) {
				const edge = elements[key];
				if (edge && edge.kind === "edge" && edge.data && (edge.data.source === id || edge.data.target === id)) delete elements[key];
			}
		}
		if (Object.keys(elements).length > CANVAS_ELEMENT_MAX) {
			const error = new Error("canvas element limit exceeded (" + CANVAS_ELEMENT_MAX + ")");
			error.canvasCode = CANVAS_CODE.badRequest;
			throw error;
		}
		const next = Object.assign({}, store.pages[projectId] || {}, { rev: page.rev + 1, nodes: page.nodes, elements: elements, updatedAt: now });
		store.pages[projectId] = next;
		return { projectId, rev: next.rev, elements: Object.values(elements), locked, rejected };
	});
}

// ── v2.2 波次 6：组件包（原型帧用）────────────────────────────────────────────────
//
// 内置 shadcn 风格包随 client.proto.js 发布；用户自己的包（如受控的 CDS）放在
// ~/.dsh/agent-whales/component-packs/<id>/{manifest.json, bundle.js, styles.css}，插件只负责发现与下发，
// 从不随插件分发第三方受控代码。bundle.js 在浏览器里与插件同权限运行——只放你信任的包。
const COMPONENT_PACK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COMPONENT_PACK_FILE_CAP = 4 * 1024 * 1024;
const BUILTIN_COMPONENT_PACK = { id: "shadcn", name: "shadcn/ui（内置）", builtin: true, license: "MIT", vocab: Object.keys(PROTOTYPE_VOCAB).length };

function componentPacksDir() {
	return join(PROPOSAL_STORE_DIR, "component-packs");
}

/** 列出本地组件包：manifest 坏 / 缺 bundle.js 的进 invalid，带原因，不悄悄跳过。 */
export function listComponentPacks(dir) {
	const root = typeof dir === "string" && dir !== "" ? dir : componentPacksDir();
	const packs = [BUILTIN_COMPONENT_PACK];
	const invalid = [];
	let entries = [];
	try { entries = readdirSync(root, { withFileTypes: true }); } catch (error) { return { dir: root, packs, invalid }; }
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const id = entry.name;
		if (!COMPONENT_PACK_ID.test(id) || id === "shadcn") { invalid.push({ id, reason: "目录名只能是小写字母数字连字符（且不能叫 shadcn）" }); continue; }
		let manifest;
		try { manifest = JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8")); } catch (error) { invalid.push({ id, reason: "manifest.json 读不到或不是 JSON" }); continue; }
		if (!existsSync(join(root, id, "bundle.js"))) { invalid.push({ id, reason: "缺 bundle.js" }); continue; }
		packs.push({
			id,
			name: typeof manifest.name === "string" && manifest.name !== "" ? manifest.name.slice(0, 40) : id,
			builtin: false,
			license: typeof manifest.license === "string" ? manifest.license.slice(0, 40) : "",
			version: typeof manifest.version === "string" ? manifest.version.slice(0, 20) : "",
			rootClass: typeof manifest.rootClass === "string" ? manifest.rootClass.slice(0, 200) : "",
			hasStyles: existsSync(join(root, id, "styles.css"))
		});
	}
	return { dir: root, packs, invalid };
}

/** GET /component-packs（列表）· GET /component-packs/:id/bundle.js|styles.css（下发文件）。只读。 */
function handleComponentPacksRequest(res, pathname, method) {
	if (method !== "GET" && method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendEnvelope(res, 405, PROJECT_CODE.param, "method not allowed");
		return;
	}
	const base = ACTIVITY_PATH + "/component-packs";
	if (pathname === base) {
		sendEnvelope(res, 200, PROJECT_CODE.ok, "success", listComponentPacks());
		return;
	}
	const parts = pathname.slice(base.length + 1).split("/");
	const id = parts[0] || "";
	const file = parts[1] || "";
	if (parts.length !== 2 || !COMPONENT_PACK_ID.test(id) || (file !== "bundle.js" && file !== "styles.css")) {
		sendEnvelope(res, 404, PROJECT_CODE.notFound, "component pack file not found");
		return;
	}
	const full = join(componentPacksDir(), id, file);
	let body;
	try {
		body = readFileSync(full);
	} catch (error) {
		sendEnvelope(res, 404, PROJECT_CODE.notFound, "component pack file not found");
		return;
	}
	if (body.length > COMPONENT_PACK_FILE_CAP) {
		sendEnvelope(res, 413, PROJECT_CODE.param, "component pack file exceeds 4MB");
		return;
	}
	res.statusCode = 200;
	res.setHeader("content-type", file === "bundle.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(body);
}

/**
 * 校验 agent 写的原型（Puck 数据：{content:[{type, props}], root}）：只认词表组件，slot 字段必须是数组，
 * 层级 ≤ 6、节点 ≤ 200。返回 { error } 或 { data, count }（补齐 props.id）。
 */
export function validatePrototypeData(raw) {
	const content = raw && Array.isArray(raw.content) ? raw.content : null;
	if (content === null) return { error: "puck.content 必须是数组" };
	let count = 0;
	let seq = 0;
	function walk(items, depth) {
		if (depth > 6) throw new Error("嵌套超过 6 层");
		return items.map((item) => {
			if (!item || typeof item.type !== "string") throw new Error("每个节点要有 type");
			const spec = PROTOTYPE_VOCAB[item.type];
			if (!spec) throw new Error("不认识的组件 " + item.type + "（只能用通用词表：" + Object.keys(PROTOTYPE_VOCAB).join(", ") + "）");
			count += 1;
			if (count > 200) throw new Error("节点超过 200 个");
			const props = Object.assign({}, item.props && typeof item.props === "object" ? item.props : {});
			for (const key of Object.keys(spec.fields)) {
				if (spec.fields[key].type !== "slot") continue;
				if (props[key] === undefined) { props[key] = []; continue; }
				if (!Array.isArray(props[key])) throw new Error(item.type + "." + key + " 是插槽，值必须是节点数组");
				props[key] = walk(props[key], depth + 1);
			}
			seq += 1;
			props.id = typeof props.id === "string" && props.id !== "" ? props.id.slice(0, 60) : item.type + "-" + seq;
			return { type: item.type, props };
		});
	}
	try {
		return { data: { content: walk(content, 1), root: { props: raw.root && raw.root.props && typeof raw.root.props === "object" ? raw.root.props : {} } }, count };
	} catch (error) {
		return { error: error.message };
	}
}

/** POST /canvas/elements：{ projectId, expectedRevision, upsert?, remove? }，人写（带同源 token）。 */
async function handleCanvasElementsRequest(ctx, req, res, control) {
	if (requestMethod(req) !== "POST") {
		res.setHeader("allow", "POST");
		sendEnvelope(res, 405, CANVAS_CODE.badRequest, "method not allowed");
		return;
	}
	const header = req && req.headers ? req.headers["x-whales-token"] : undefined;
	const token = Array.isArray(header) ? header[0] : header;
	if (typeof token !== "string" || !control || typeof control.controlToken !== "string" || token !== control.controlToken) {
		sendEnvelope(res, 403, CANVAS_CODE.forbidden, "same-origin token required");
		return;
	}
	let body;
	// 原型帧整页 Puck 数据最多 64KB，外面再包一层 upsert / provenance：放宽到 256KB（只这一条路由）
	try { body = JSON.parse(await readRequestBody(req, 256 * 1024)); } catch (error) { body = undefined; }
	const projectId = body && typeof body.projectId === "string" ? body.projectId.trim() : "";
	if (projectId === "" || !Number.isFinite(Number(body.expectedRevision))) {
		sendEnvelope(res, 200, CANVAS_CODE.badRequest, "projectId and expectedRevision (number) required");
		return;
	}
	try {
		const result = await applyCanvasElements(projectId, { expectedRevision: body.expectedRevision, upsert: body.upsert, remove: body.remove, by: "user" });
		sendEnvelope(res, 200, CANVAS_CODE.ok, "success", result);
	} catch (error) {
		if (error && error.code === "STORE_READONLY") { sendEnvelope(res, 200, CANVAS_CODE.storeReadonly, "canvas store is read-only (corrupted, backed up)"); return; }
		if (error && typeof error.canvasCode === "number") { sendEnvelope(res, 200, error.canvasCode, error.message, error.canvasData); return; }
		warn(ctx, "canvas elements", error);
		sendEnvelope(res, 500, CANVAS_CODE.internal, "internal error");
	}
}

/** 串行「读最新 → mutate → 原子写」；与 projects/proposals 共用同一把写锁，跨实体不丢更新。 */
function mutateCanvas(operation) {
	return withStoreLock(function () {
		const read = readStoreFile(canvasStoreFile());
		if (read.readonly) throw new StoreReadonlyError(canvasStoreFile(), read.backupPath);
		const value = operation(read.data);
		return writeStoreFile(canvasStoreFile(), read.data).then(function () {
			return value;
		});
	});
}

function canvasRevisionError(page, projectId) {
	const error = new Error("canvas revision conflict");
	error.canvasCode = CANVAS_CODE.revConflict;
	error.canvasData = { projectId, currentRevision: page.rev };
	return error;
}

/** 清洗位置表：只留有限数值的 x/y，w/h 缺省 0（客户端按节点 kind 兜底）。 */
function cleanCanvasNodes(nodes) {
	const clean = {};
	if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return clean;
	for (const key of Object.keys(nodes)) {
		const node = nodes[key];
		if (!node || typeof node !== "object" || Array.isArray(node)) continue;
		const x = Number(node.x);
		const y = Number(node.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		const w = Number(node.w);
		const h = Number(node.h);
		clean[key] = { x, y, w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 };
	}
	return clean;
}

/** GET 读快照；PUT 整体覆盖位置表（画布节点不多，全量比增量简单且不会漏）。 */
async function handleCanvasRequest(ctx, req, res) {
	const url = new URL(String((req && req.url) || "/"), "http://localhost");
	const projectId = String(url.searchParams.get("projectId") || "");
	if (projectId === "") {
		sendEnvelope(res, 200, CANVAS_CODE.badRequest, "projectId required");
		return;
	}
	if (requestMethod(req) === "GET") {
		const read = readStoreFile(canvasStoreFile());
		if (read.readonly) {
			sendEnvelope(res, 200, CANVAS_CODE.storeReadonly, "canvas store is read-only (corrupted, backed up)");
			return;
		}
		const page = canvasPageOf(read.data, projectId);
		sendEnvelope(res, 200, CANVAS_CODE.ok, "success", { projectId, rev: page.rev, nodes: page.nodes, elements: Object.values(page.elements) });
		return;
	}
	let body;
	try {
		body = JSON.parse(await readRequestBody(req, ROUTE_BODY_LIMIT));
	} catch (error) {
		body = undefined;
	}
	const expected = body && typeof body === "object" ? Number(body.expectedRevision) : NaN;
	const nodes = body && typeof body === "object" ? body.nodes : undefined;
	if (!Number.isFinite(expected) || !nodes || typeof nodes !== "object" || Array.isArray(nodes)) {
		sendEnvelope(res, 200, CANVAS_CODE.badRequest, "expectedRevision (number) and nodes (object) required");
		return;
	}
	try {
		const result = await mutateCanvas(function (store) {
			if (store.pages === undefined || store.pages === null || typeof store.pages !== "object" || Array.isArray(store.pages)) store.pages = {};
			const page = canvasPageOf(store, projectId);
			if (page.rev !== expected) throw canvasRevisionError(page, projectId);
			const clean = cleanCanvasNodes(nodes);
			// 只覆盖位置表：元素表（波次 3）原样保留，不能被一次拖拽清空。
			const next = Object.assign({}, store.pages[projectId] || {}, { rev: page.rev + 1, nodes: clean, elements: page.elements, updatedAt: new Date().toISOString() });
			store.pages[projectId] = next;
			return { projectId, rev: next.rev, nodes: clean };
		});
		sendEnvelope(res, 200, CANVAS_CODE.ok, "success", result);
	} catch (error) {
		if (error && error.code === "STORE_READONLY") {
			sendEnvelope(res, 200, CANVAS_CODE.storeReadonly, "canvas store is read-only (corrupted, backed up)");
			return;
		}
		if (error && typeof error.canvasCode === "number") {
			sendEnvelope(res, 200, error.canvasCode, error.message, error.canvasData);
			return;
		}
		warn(ctx, "canvas write", error);
			sendEnvelope(res, 500, CANVAS_CODE.internal, "internal error");
		}
}

/** 一个前缀路由内的分发：同步路径自己兜住异常，异步 toggle 再挂一层 catch 防 unhandledRejection。 */
function dispatchRequest(ctx, req, res, get, running, control, runtime, art) {
	const pathname = requestPathname(req);
	try {
		// 波次 6：组件包（只读）
		if (pathname === ACTIVITY_PATH + "/component-packs" || pathname.startsWith(ACTIVITY_PATH + "/component-packs/")) {
			handleComponentPacksRequest(res, pathname, requestMethod(req));
			return undefined;
		}
		// 画布页（R1）：GET 读位置快照，PUT 整体覆盖位置表；与 tasks/events 同级前缀。
		if (pathname === CANVAS_PREFIX + "/elements") {
			return handleCanvasElementsRequest(ctx, req, res, control).catch((error) => {
				warn(ctx, "canvas elements", error);
				sendEnvelope(res, 500, CANVAS_CODE.internal, "internal error");
			});
		}
		if (pathname === CANVAS_PREFIX) {
			const pending = handleCanvasRequest(ctx, req, res);
			if (pending && typeof pending.catch === "function") {
				return pending.catch((error) => {
					warn(ctx, "canvas", error);
					sendEnvelope(res, 500, CANVAS_CODE.internal, "internal error");
				});
			}
			return pending;
		}
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
		// 画布优先（v2.2 九（续二））：画布 Composer 读主对话最近几轮（只读、无 token）。
		if (pathname.startsWith(SESSIONS_ENDPOINT + "/") && pathname.endsWith("/messages")) {
			const rawId = pathname.slice(SESSIONS_ENDPOINT.length + 1, pathname.length - "/messages".length);
			let sessionId = rawId;
			try { sessionId = decodeURIComponent(rawId); } catch (error) { sessionId = rawId; }
			const pendingMessages = handleSessionMessagesRequest(ctx, req, res, get, sessionId);
			return pendingMessages.catch((error) => {
				warn(ctx, "session messages", error);
				sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
			});
		}
		// 会话目录：只读、无 token（与 activity 快照同一定位）；放在 projects 路由附近。
		if (pathname === SESSIONS_ENDPOINT) {
			const pendingSessions = handleSessionsRequest(ctx, req, res, get);
			if (pendingSessions && typeof pendingSessions.catch === "function") {
				return pendingSessions.catch((error) => {
					warn(ctx, "sessions route", error);
					sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
				});
			}
			return pendingSessions;
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
			// POST 同路径新建任务（U-3「＋ 新建任务」）；GET 仍是任务快照。
			if (requestMethod(req) === "POST") {
				const pendingCreate = handleTaskCreateRequest(ctx, req, res, control);
				if (pendingCreate && typeof pendingCreate.catch === "function") {
					return pendingCreate.catch((error) => {
						warn(ctx, "task create", error);
						sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
					});
				}
				return pendingCreate;
			}
			// 新宿主补成员要 await listDescendants：返回 promise，并兜住异常（不留 unhandledRejection）
			const pendingTasks = handleTasksRequest(ctx, req, res, get);
			if (pendingTasks && typeof pendingTasks.catch === "function") {
				return pendingTasks.catch((error) => {
					warn(ctx, "tasks snapshot", error);
					if (!res.headersSent) sendEnvelope(res, 500, TASK_CODE.internal, "snapshot failed");
				});
			}
			return undefined;
		}
		if (pathname === HANDOFFS_ENDPOINT) {
			handleHandoffsRequest(ctx, req, res);
			return undefined;
		}
		if (pathname === INBOX_ENDPOINT) {
			handleInboxRequest(ctx, req, res);
			return undefined;
		}
		// 全量快照（只读、无 token）：五个 store 的原始内容，供浏览器半边打 ZIP 导出。
		if (pathname === SNAPSHOT_ENDPOINT) {
			handleSnapshotRequest(ctx, req, res);
			return undefined;
		}
		// 事件台（W1.5）：health 精确路径先判，再判集合，最后是 <eventId>/actions。
		if (pathname === EVENTS_HEALTH_ENDPOINT) {
			handleEventHealthRequest(ctx, req, res);
			return undefined;
		}
		if (pathname === EVENTS_ENDPOINT) {
			handleEventsRequest(ctx, req, res);
			return undefined;
		}
		const eventActionId = eventActionOf(pathname);
		if (eventActionId !== undefined) {
			const pendingEventAction = handleEventActionsRequest(ctx, req, res, control, eventActionId);
			if (pendingEventAction && typeof pendingEventAction.catch === "function") {
				return pendingEventAction.catch((error) => {
					warn(ctx, "event action", error);
					sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
				});
			}
			return pendingEventAction;
		}
		// W2 观测（T-13）：timeline / observations 两个只读路由（无 token，与 activity
		// 同一定位）。放在 taskCommandOf 之前：/timeline、/observations 后缀都不会被
		// /commands 匹配，先判少走一层解析；方法不符由各自 handler 回 405 + allow。
		const timelineTaskId = taskTimelineOf(pathname);
		if (timelineTaskId !== undefined) {
			handleTaskTimelineRequest(ctx, req, res, get, timelineTaskId);
			return undefined;
		}
		const observationsTaskId = taskObservationsOf(pathname);
		if (observationsTaskId !== undefined) {
			handleTaskObservationsRequest(ctx, req, res, get, running, observationsTaskId);
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
		// report 路由放在 commands 之后：taskCommandOf 只匹配 /commands 后缀，两者不会互吃。
		const reportTaskId = taskReportOf(pathname);
		if (reportTaskId !== undefined) {
			const pendingReport = handleTaskReportRequest(ctx, req, res, get, control, reportTaskId);
			if (pendingReport && typeof pendingReport.catch === "function") {
				return pendingReport.catch((error) => {
					warn(ctx, "task report", error);
					sendEnvelope(res, 500, TASK_CODE.internal, "internal error");
				});
			}
			return pendingReport;
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
		if (pathname === ULTRA_ENDPOINT) {
			const pending = handleUltraRequest(ctx, req, res, control);
			if (pending && typeof pending.catch === "function") {
				return pending.catch((error) => {
					warn(ctx, "ultra mode toggle", error);
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

// ── 约束层：MCP 连接即授权（2026-11-11 探针实测后落地）──────────────────────
//
// 依据：docs/plans/w1-节点图画布外壳与连线编辑.md §14。
// 探针实测 40/40 条工具调用：tools.guard(exec) 里 exec.agent 有值，
// 且 agent.id === agent.session.id === "session-<uuid>"。
// 契约（@deepseek-ai/dsh-tools lib/types/index.d.ts 逐字）：
//   export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
// 返回 undefined = 放行；返回字符串 = 拒绝且该串即理由；guardReason 取第一个非 undefined。
//
// 三个保险，缺一个不上线：
//   1. 默认全放行——没有任何 mcpLinks 时 guard 是 no-op 快路径，零开销。
//   2. 一键全清——DELETE /projects/:id/mcp-links?all=1，一键断开该项目全部连接。
//   3. 插件可关——整层挂在 whenService(["tools"]) 里，插件停用即消失，无残留。
//
// 口径：只拦 MCP 工具（名字以 mcp__ 开头），其余一律放行。
// 绝不用 ToolRestriction.allow：语义是 keep only / everything else is removed，
// 按 allow 实现会把 bash / 文件读写一起删掉，agent 直接残废。

const MCP_TOOL_PREFIX = "mcp__";
const MCP_SESSION_PREFIX = "session-";
const MCP_CONSTRAINT_TTL = 2000; // 索引缓存寿命 ms：给「外部手改 projects.json」一个陈旧上界

let mcpIndex = null;   // { [sessionId]: {projectId, servers} }；null = 待重建
let mcpIndexAt = 0;
let mcpIndexDirty = false; // 自己的写操作置 true，下次读立即重建

/** 从 agent 身上取会话 id。探针实测 agent.id 与 agent.session.id 同值，任取其一。 */
function sessionIdOfAgent(agent) {
	if (!agent || typeof agent !== "object") return "";
	const direct = typeof agent.id === "string" ? agent.id : "";
	const nested = agent.session && typeof agent.session.id === "string" ? agent.session.id : "";
	const raw = direct !== "" ? direct : nested;
	if (raw === "") return "";
	return raw.indexOf(MCP_SESSION_PREFIX) === 0 ? raw.slice(MCP_SESSION_PREFIX.length) : raw;
}

/** 从工具名取 MCP 服务名：mcp__<server>__<raw>。不是 MCP 工具返回 ""。 */
function mcpServerOfTool(name) {
	if (typeof name !== "string" || name.indexOf(MCP_TOOL_PREFIX) !== 0) return "";
	const rest = name.slice(MCP_TOOL_PREFIX.length);
	const cut = rest.indexOf("__");
	return cut > 0 ? rest.slice(0, cut) : "";
}

/** 列当前可用的 MCP 服务（从 tools 的 schema 过滤 mcp__ 前缀）。服务没就绪返回空数组。 */
function availableMcpServers(get) {
	try {
		const tools = typeof get === "function" ? get("tools") : undefined;
		if (!tools || typeof tools.schemas !== "function") return [];
		const counts = {};
		for (const schema of tools.schemas()) {
			const server = mcpServerOfTool(schema && schema.name);
			if (server !== "") counts[server] = (counts[server] || 0) + 1;
		}
		return Object.keys(counts).sort().map((server) => ({ server, toolCount: counts[server] }));
	} catch (error) { return []; }
}

/** 建「会话 → 允许的 MCP 服务」索引。全仓库只有这一个函数读 projects.json 做这件事。 */
function buildMcpIndex() {
	let store = {};
	try { store = readProjectStore().store || {}; } catch (error) { return {}; }
	const projects = store.projects && typeof store.projects === "object" ? store.projects : {};
	const index = {};
	for (const projectId of Object.keys(projects)) {
		const project = projects[projectId];
		if (!project || typeof project !== "object") continue;
		const links = Array.isArray(project.mcpLinks) ? project.mcpLinks : [];
		for (const link of links) {
			if (!link || typeof link !== "object") continue;
			const sessionId = typeof link.sessionId === "string" ? link.sessionId : "";
			const server = typeof link.server === "string" ? link.server : "";
			if (sessionId === "" || server === "") continue;
			if (!index[sessionId]) index[sessionId] = { projectId, servers: {} };
			index[sessionId].servers[server] = true;
		}
	}
	return index;
}

/** 取约束索引（带 TTL 缓存）。返回 null = 无任何约束，调用方走快路径。 */
function mcpConstraintIndex() {
	if (mcpIndexDirty) { mcpIndex = null; mcpIndexAt = 0; mcpIndexDirty = false; }
	const now = Date.now();
	if (mcpIndex === null || now - mcpIndexAt > MCP_CONSTRAINT_TTL) {
		mcpIndex = buildMcpIndex();
		mcpIndexAt = now;
	}
	return Object.keys(mcpIndex).length === 0 ? null : mcpIndex;
}

/** 约束层 guard。只拦 MCP 工具；身份取不到、非 MCP 工具、没连过这个服务，一律放行。 */
function mcpConstraintGuard(exec) {
	const index = mcpConstraintIndex();
	if (index === null) return undefined;
	const sessionId = sessionIdOfAgent(exec && exec.agent);
	if (sessionId === "") return undefined;
	const entry = index[sessionId];
	if (!entry) return undefined;
	const server = mcpServerOfTool(exec && exec.name);
	if (server === "") return undefined;
	if (entry.servers[server]) return undefined;
	return "该会话未连接 MCP 服务「" + server + "」";
}

/** 装约束层。重复 apply 由 ctx.effect 负责清理，不会叠。 */
function installMcpConstraint(ctx, scope) {
	const tools = scope && typeof scope.get === "function" ? scope.get("tools") : undefined;
	if (!tools || typeof tools.guard !== "function") return false;
	try {
		ctx.effect(() => tools.guard(mcpConstraintGuard), "agent-whales: mcp constraint");
		return true;
	} catch (error) {
		warn(ctx, "mcp constraint", error);
		return false;
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
			// M4/P2：发送方身份只取执行上下文；拿不到就拒绝（与提案工具一致），不静默跳过闸。
			const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
			if (callerId === "") throw new Error("[40301] cannot determine the calling session");
			{
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
			// 幂等 / 并发去重 / 失败口径都在共享函数里（画布「唤醒」按钮同一条路径）。
			return resumeSessionById(get, sessionId, exec && exec.signal);
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
			// M4/P2：与发送同权；拿不到执行上下文身份就拒绝，不静默跳过闸。
			const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
			if (callerId === "") throw new Error("[40301] cannot determine the calling session");
			{
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

	collectTool({
		name: "whales_visit_trace",
		description:
			"回放某个会话最近几轮是怎么干的：每轮投了什么任务、说过什么、调过哪些工具、哪一步失败与原因、每轮终态。" +
			"只读、不唤醒目标会话、不产生模型调用；它正在跑也能读（读到的是当前已落盘的部分）。" +
			"whales_visit_read 只给对话文本行，要看过程与失败原因用这个。",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "目标会话 id（用 whales_visit_list 查）。" },
				turns: { type: "number", description: `可选：回看最近几个回合，默认 ${TRACE_DEFAULT_TURNS}，上限 ${TRACE_MAX_TURNS}。工具调用只列名字与失败原因，正文按条截断。` }
			},
			required: ["sessionId"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				name: { type: "string" },
				totalTurns: { type: "number" },
				running: { type: "boolean" },
				text: { type: "string" }
			},
			required: ["sessionId", "name", "totalTurns", "running", "text"],
			additionalProperties: true
		},
		isConcurrencySafe: () => true,
		render: (value) => value.text,
		async execute(args, exec) {
			const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
			if (sessionId === "") throw new Error("sessionId 不能为空");
			// 入参 schema 在运行时不生效：turns 传成字符串会被 Number() 吞掉，
			// 调用方以为限了量、实际用了默认值——所以这里自己校验类型与范围。
			let turns = TRACE_DEFAULT_TURNS;
			if (args?.turns !== undefined) {
				if (typeof args.turns !== "number" || !Number.isInteger(args.turns) || args.turns < 1 || args.turns > TRACE_MAX_TURNS) {
					throw new Error(`turns 必须是 1 到 ${TRACE_MAX_TURNS} 的整数`);
				}
				turns = args.turns;
			}
			// 与 whales_visit_read 同权：拿不到执行上下文身份就拒绝，不静默跳过闸。
			const callerId = exec && exec.agent && typeof exec.agent.id === "string" ? String(exec.agent.id) : "";
			if (callerId === "") throw new Error("[40301] cannot determine the calling session");
			{
				const access = checkCrossSessionAccess(get, callerId, sessionId);
				if (access.ok !== true) throw new Error("[" + access.code + "] " + access.msg);
			}
			const events = await readSessionLog(get, sessionId);
			const name = titleOf(events) || sessionId;
			const folded = foldTurns(events);
			return {
				sessionId,
				name,
				totalTurns: folded.turns.length,
				running: folded.running,
				text: renderTranscript({ turns: folded.turns, sessionId, name, limit: turns, running: folded.running })
			};
		}
	});

	// ── 画布 agent 面（R1 返工 · v2.1 §57.2 第 1 层）────────────────────────
	//
	// 节点是派生的（上下文←任务落点、Agent←项目成员、Composer←主会话），所以只有
	// 「摆位置」与「改关联线」两类写；没有 node_add / node_delete。
	// presentCall 分 read/edit：用户能在官方消息流里看见 agent 在动画布。
	function canvasPositionsOf(store, projectId) {
		return canvasPageOf(store, projectId).nodes;
	}

	collectTool({
		name: "whales_canvas_list",
		description:
			"列出已经有画布页的项目（即有人摆过节点位置的项目）及其版本号。只读。" +
			"用来在读写画布前确认目标项目；空列表表示还没人摆过任何画布。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: {
			type: "object",
			properties: { pages: { type: "array", items: { type: "object", additionalProperties: true } } },
			required: ["pages"],
			additionalProperties: true
		},
		render: (value) => {
			const pages = Array.isArray(value && value.pages) ? value.pages : [];
			return pages.length === 0 ? "画布页：无" : "画布页 " + pages.length + " 个项目：" + pages.map((row) => row.projectId + " (rev " + row.rev + ", " + row.nodeCount + " 节点)").join("、");
		},
		execute: async () => {
			const read = readStoreFile(canvasStoreFile());
			const store = read.data || {};
			const all = store.pages && typeof store.pages === "object" && !Array.isArray(store.pages) ? store.pages : {};
			const pages = [];
			for (const projectId of Object.keys(all)) {
				const page = canvasPageOf(store, projectId);
				pages.push({ projectId, rev: page.rev, nodeCount: Object.keys(page.nodes).length });
			}
			return { pages };
		}
	});

	collectTool({
		name: "whales_canvas_inspect",
		description:
			"读一个项目的画布页：已保存的节点位置、会话关联线（links）、项目成员。" +
			"只读。节点本身是派生的——上下文节点来自任务落点（worktree/execRoot）、Agent 节点来自成员、Composer 是主对话；" +
			"要拿任务明细再调 /agent-whales/api/tasks?projectId=。",
		parameters: {
			type: "object",
			properties: { projectId: { type: "string", description: "项目 id（用 whales_canvas_list 查）。" } },
			required: ["projectId"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				rev: { type: "number" },
				positions: { type: "object", additionalProperties: true },
				links: { type: "array", items: { type: "object", additionalProperties: true } },
				members: { type: "array", items: { type: "object", additionalProperties: true } }
			},
			required: ["projectId", "rev", "positions", "links", "members"],
			additionalProperties: true
		},
		render: (value) => {
			const positions = value.positions || {};
			const links = Array.isArray(value.links) ? value.links : [];
			const members = Array.isArray(value.members) ? value.members : [];
			return "画布 " + value.projectId + " rev " + value.rev + "：已摆位置 " + Object.keys(positions).length + " 个、关联线 " + links.length + " 条、成员 " + members.length + " 人";
		},
		execute: async (args) => {
			const projectId = String((args && args.projectId) || "");
			if (projectId === "") return { error: { code: CANVAS_CODE.badRequest, message: "projectId required" } };
			const canvasRead = readStoreFile(canvasStoreFile());
			const page = canvasPageOf(canvasRead.data, projectId);
			const projectRead = readProjectStore();
			const project = projectRead.store && projectRead.store.projects ? projectRead.store.projects[projectId] : undefined;
			if (!project) return { error: { code: CANVAS_CODE.notFound, message: "project not found" } };
			const links = Array.isArray(project.links) ? project.links : [];
			const members = Array.isArray(project.members) ? project.members : [];
			return {
				projectId,
				rev: page.rev,
				positions: page.nodes,
				links: links.map((link) => ({ a: String(link && link.a), b: String(link && link.b) })),
				members: members.map((member) => ({ sessionId: String(member && member.sessionId), role: String((member && member.role) || "member") }))
			};
		}
	});

	collectTool({
		name: "whales_canvas_layout",
		description:
			"批量设置画布节点位置（整体覆盖该项目已保存的位置表）。写入前先 whales_canvas_inspect 拿 rev；" +
			"携带 expectedRevision，过期返回 40902 且**不覆盖**——重新 inspect 再报。节点 id 用 inspect 返回的会话 id 或 ctx:<落点>。",
		parameters: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "项目 id。" },
				expectedRevision: { type: "number", description: "inspect 得到的 rev；过期会 40902。" },
				positions: {
					type: "object",
					description: "节点 id → {x, y, w?, h?}；世界坐标，未列出的节点保持派生默认位置。"
				}
			},
			required: ["projectId", "expectedRevision", "positions"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				rev: { type: "number" },
				updated: { type: "number" }
			},
			required: ["projectId", "rev", "updated"],
			additionalProperties: true
		},
		render: (value) => "画布 " + value.projectId + " 位置已更新 → rev " + value.rev + "（" + value.updated + " 个节点）",
		execute: async (args) => {
			const projectId = String((args && args.projectId) || "");
			const expected = Number(args && args.expectedRevision);
			if (projectId === "" || !Number.isFinite(expected)) {
				return { error: { code: CANVAS_CODE.badRequest, message: "projectId and expectedRevision (number) required" } };
			}
			const positions = args && args.positions;
			if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
				return { error: { code: CANVAS_CODE.badRequest, message: "positions must be an object" } };
			}
			try {
				const result = await mutateCanvas(function (store) {
					if (store.pages === undefined || store.pages === null || typeof store.pages !== "object" || Array.isArray(store.pages)) store.pages = {};
					const page = canvasPageOf(store, projectId);
					if (page.rev !== expected) throw canvasRevisionError(page, projectId);
					const clean = cleanCanvasNodes(positions);
					const next = Object.assign({}, store.pages[projectId] || {}, { rev: page.rev + 1, nodes: clean, elements: page.elements, updatedAt: new Date().toISOString() });
					store.pages[projectId] = next;
					return { projectId, rev: next.rev, updated: Object.keys(clean).length };
				});
				return result;
			} catch (error) {
				if (error && error.code === "STORE_READONLY") {
					return { error: { code: CANVAS_CODE.storeReadonly, message: "canvas store is read-only (corrupted, backed up)" } };
				}
				if (error && typeof error.canvasCode === "number") {
					return { error: { code: error.canvasCode, message: error.message, currentRevision: error.canvasData && error.canvasData.currentRevision } };
				}
				return { error: { code: CANVAS_CODE.internal, message: "internal error" } };
			}
		}
	});

	collectTool({
		name: "whales_canvas_link",
		description:
			"在画布上建立或删除一条会话关联线（project.links）。关联线只表示「允许互发消息 / 互读」，" +
			"没有关联就不能发（PRD §51）。自连会被拒绝；重复连接返回已存在。携带 expectedRevision，过期 40902 不覆盖。",
		parameters: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "项目 id。" },
				a: { type: "string", description: "一端会话 id。" },
				b: { type: "string", description: "另一端会话 id。" },
				expectedRevision: { type: "number", description: "项目当前 rev（inspect 不返回项目 rev，可先 GET /projects/<id>）。" }
			},
			required: ["projectId", "a", "b", "expectedRevision"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: { projectId: { type: "string" }, created: { type: "boolean" }, links: { type: "number" } },
			required: ["projectId", "created"],
			additionalProperties: true
		},
		render: (value) => (value.created ? "已建立关联线 " : "关联线已存在 ") + value.projectId,
		execute: async (args) => {
			const projectId = String((args && args.projectId) || "");
			const a = String((args && args.a) || "");
			const b = String((args && args.b) || "");
			const expected = Number(args && args.expectedRevision);
			if (projectId === "" || a === "" || b === "" || !Number.isFinite(expected)) {
				return { error: { code: CANVAS_CODE.badRequest, message: "projectId, a, b and expectedRevision (number) required" } };
			}
			if (a === b) return { error: { code: CANVAS_CODE.badRequest, message: "self link is not allowed" } };
			try {
				return await mutateProject(function (store) {
					const project = store.projects ? store.projects[projectId] : undefined;
					if (!project) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					if (projectRevOf(project) !== expected) {
						throw routeFailure(TASK_CODE.revisionConflict, "project revision conflict", { currentRevision: projectRevOf(project) });
					}
					const links = Array.isArray(project.links) ? project.links : [];
					const exists = links.some((link) => {
						const x = String(link && link.a);
						const y = String(link && link.b);
						return (x === a && y === b) || (x === b && y === a);
					});
					if (exists) return { projectId, created: false, links: links.length };
					links.push({ a, b });
					project.links = links;
					project.revision = projectRevOf(project) + 1;
					return { projectId, created: true, links: links.length };
				});
			} catch (error) {
				if (error && error.code === "STORE_READONLY") {
					return { error: { code: PROJECT_CODE.storeReadonly, message: "store is read-only (corrupted, backed up)" } };
				}
				if (error && typeof error.projectCode === "number") {
					return { error: { code: error.projectCode, message: error.message, currentRevision: error.projectData && error.projectData.currentRevision } };
				}
				return { error: { code: PROJECT_CODE.internal, message: "internal error" } };
			}
		}
	});

	collectTool({
		name: "whales_canvas_unlink",
		description:
			"删除画布上一条会话关联线（只解除画布引用，不影响会话与任务；PRD §53.9.12 软删口径）。" +
			"携带 expectedRevision，过期 40902 不覆盖。线不存在时返回未删除（幂等）。",
		parameters: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "项目 id。" },
				a: { type: "string", description: "一端会话 id。" },
				b: { type: "string", description: "另一端会话 id。" },
				expectedRevision: { type: "number", description: "项目当前 rev。" }
			},
			required: ["projectId", "a", "b", "expectedRevision"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			properties: { projectId: { type: "string" }, removed: { type: "boolean" }, links: { type: "number" } },
			required: ["projectId", "removed"],
			additionalProperties: true
		},
		render: (value) => (value.removed ? "已删除关联线 " : "关联线不存在 ") + value.projectId,
		execute: async (args) => {
			const projectId = String((args && args.projectId) || "");
			const a = String((args && args.a) || "");
			const b = String((args && args.b) || "");
			const expected = Number(args && args.expectedRevision);
			if (projectId === "" || a === "" || b === "" || !Number.isFinite(expected)) {
				return { error: { code: CANVAS_CODE.badRequest, message: "projectId, a, b and expectedRevision (number) required" } };
			}
			try {
				return await mutateProject(function (store) {
					const project = store.projects ? store.projects[projectId] : undefined;
					if (!project) throw routeFailure(PROJECT_CODE.notFound, "project not found");
					if (projectRevOf(project) !== expected) {
						throw routeFailure(TASK_CODE.revisionConflict, "project revision conflict", { currentRevision: projectRevOf(project) });
					}
					const links = Array.isArray(project.links) ? project.links : [];
					const kept = links.filter((link) => {
						const x = String(link && link.a);
						const y = String(link && link.b);
						return !((x === a && y === b) || (x === b && y === a));
					});
					if (kept.length === links.length) return { projectId, removed: false, links: links.length };
					project.links = kept;
					project.revision = projectRevOf(project) + 1;
					return { projectId, removed: true, links: kept.length };
				});
			} catch (error) {
				if (error && error.code === "STORE_READONLY") {
					return { error: { code: PROJECT_CODE.storeReadonly, message: "store is read-only (corrupted, backed up)" } };
				}
				if (error && typeof error.projectCode === "number") {
					return { error: { code: error.projectCode, message: error.message, currentRevision: error.projectData && error.projectData.currentRevision } };
				}
				return { error: { code: PROJECT_CODE.internal, message: "internal error" } };
			}
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

// ── W1：worker preset 安装器 ────────────────────────────────────────────────
//
// 插件自带 presets/dsh-agent-whales-worker（复制 standard 后裁剪：无人值守干工单），
// 由宿主半边在 apply 时复制到用户 preset 根（~/.dsh/.agent-presets/，与
// @deepseek-ai/dsh-agent-presets 的 USER_PRESET_DIR 对齐）。
// 硬约束：目标已存在就整目录跳过——用户可能改过自己的版本，插件升级绝不覆盖。
// 失败只 warn：preset 是便利能力，装不上不影响插件其它能力。

const WORKER_PRESET_NAME = "dsh-agent-whales-worker";
const WORKER_PRESET_FILES = ["preset.yml", "agent.cordis.yml"];
/** 插件目录下 presets/<preset 名>/（lib/ 的上一级；打包后随 files 一起分发）。 */
const WORKER_PRESET_SOURCE_DIR = new URL(`../presets/${WORKER_PRESET_NAME}/`, import.meta.url);

/** 目标 preset 根：DSH_AGENT_WHALES_PRESET_DIR 可覆盖（测试用），默认用户 preset 根
 *  （`<DSH_HOME>/.agent-presets`，与宿主 dsh-agent-presets 的 USER_PRESET_DIR 同一条口径）。 */
function workerPresetRoot() {
	const override = typeof process.env.DSH_AGENT_WHALES_PRESET_DIR === "string" ? process.env.DSH_AGENT_WHALES_PRESET_DIR.trim() : "";
	return override !== "" ? override : join(resolveDshHome(), ".agent-presets");
}

/** 安装（幂等）。返回 { installed, target }；任何失败都向上抛，由调用方 warn 兜住。 */
function installWorkerPreset() {
	const target = join(workerPresetRoot(), WORKER_PRESET_NAME);
	// 已存在 = 用户装过/改过：整目录跳过，连文件都不比对（不覆盖是硬约束）。
	if (existsSync(target)) return { installed: false, target: target };
	const sources = WORKER_PRESET_FILES.map((name) => fileURLToPath(new URL(name, WORKER_PRESET_SOURCE_DIR)));
	// 源文件不齐（打包缺文件/asar 读不到）就先别建目标目录：否则留下一个空目录，
	// 下次 existsSync 命中「已存在」→ 这个 preset 永远装不上。
	for (const source of sources) {
		if (!existsSync(source)) throw new Error("worker preset source missing: " + source);
	}
	mkdirSync(target, { recursive: true });
	sources.forEach((source, index) => {
		copyFileSync(source, join(target, WORKER_PRESET_FILES[index]));
	});
	return { installed: true, target: target };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ visitTools?: boolean, ultra?: boolean } | undefined} config 插件 entry 的 config（可选）
 *   `visitTools: false` 默认关掉串门工具；`ultra: true` 默认打开 ultra 模式（无持久化文件时）。
 */
export { validateProposal, topologicalOrder, proposalView, createProjectTaskInStore, projectTaskView, projectBlockedByWouldCycle, ensureProjectTasks, ingestEvent, timelineStepsOf, toolCallsOf, observationTailOf, cleanCanvasElement, applyCanvasElements };
// 数据根口径（DSH_HOME 解析）导出给离线用例：这是「与宿主对齐」的契约，必须有回归。
export { resolveDshHome, expandHomePath };

// 约束层：纯函数与缓存重置钩子导出给测试。
export { sessionIdOfAgent, mcpServerOfTool, mcpConstraintGuard };

/** 仅供测试：清掉约束索引缓存，避免 2s TTL 让用例变慢变 flaky。 */
export function resetMcpConstraintForTests() {
	mcpIndex = null;
	mcpIndexAt = 0;
	mcpIndexDirty = false;
}

/** 仅供测试：读当前生效的提案存储文件（默认值随 DSH_HOME 变，覆盖后是覆盖值）。 */
export function proposalStoreFileForTests() {
	return PROPOSAL_STORE_FILE;
}

/** 仅供测试：读当前生效的 worker preset 目标根（默认值随 DSH_HOME 变）。 */
export function workerPresetRootForTests() {
	return workerPresetRoot();
}

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

	// W1：把自带的 worker preset 装到用户 preset 根（幂等，已存在不覆盖；失败只 warn）。
	try {
		installWorkerPreset();
	} catch (error) {
		warn(ctx, "worker preset install", error);
	}

	// 每一段都各自兜底：宿主服务缺失/抛错只丢对应能力，绝不让 apply 抛出去把插件 fiber 带崩。
	// 依赖宿主服务的注册一律走 whenService：宿主插件是并行加载的，apply 早于服务注册是常态。
	whenService(ctx, ["systemPrompt"], "team policy", (scope) => registerTeamPolicy(scope, get));
	// 随包协议 skill（playbook）：等 skills 服务就绪再注册；缺失/失败只丢这一层增强。
	whenService(ctx, ["skills"], "bundled skills", (scope) => registerBundledSkills(scope, SKILL_PROVIDER_NAME));

	// ultra 模式（2026-11-16）：强制加载 deep-effort 执行契约。控制器建在 whenService 之外——
	// 路由（webServer）与提示段（systemPrompt）都要读它，而这两个服务谁先就绪不确定。
	// 初始化失败（读状态文件抛错）只丢这一层：退回「永远关不上也打不开」的空实现。
	let ultra;
	try {
		ultra = createUltraMode(ctx, config);
	} catch (error) {
		warn(ctx, "ultra mode init", error);
		ultra = { isEnabled: () => false, setEnabled: () => Promise.resolve(false) };
	}
	whenService(ctx, ["systemPrompt"], "ultra section", (scope) => registerUltraSection(scope, ultra));
	whenService(ctx, ["systemPrompt"], "flow section", (scope) => registerFlowSection(scope));

	const running = new Map();
	const runtime = createRuntimeState();
	// v2.2 波次 2：子会话自动入项目。派生类工具（spawn_teammate / subagent …）一结束就收一次；
	// 漏掉的（宿主事件没触发、插件后装）由画布 POST /projects/:id/adopt 兜底。
	let onToolResult;
	try {
		onToolResult = installChildAdoption(ctx, get);
	} catch (error) {
		warn(ctx, "child adoption", error);
	}
	try {
		trackToolActivity(ctx, running, runtime, onToolResult);
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
	// v2.2 波次 5：流程图工具（读已有图 + 可引用消息；画图直接落画布）。
	registerFlowTools(scope, get);
	// 约束层：MCP 连接即授权。装不上不影响主流程（默认全放行本来就是安全态）。
	installMcpConstraint(ctx, scope);
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

	// 路由：等 webServer 就绪再注册（活动快照 / 串门开关 / ultra 开关 / 素材图共用同一个前缀路由）。
	whenService(ctx, ["webServer"], "activity route", (scope) => {
		try {
			// ultra 控制器在 apply 时就建好：路由只是把它接到 control 上，供 GET 回显与 POST 翻转。
			control.ultra = ultra;
			registerActivityRoute(scope, get, running, control, runtime, art);
		} catch (error) {
			warn(ctx, "activity route", error);
		}
	});
}