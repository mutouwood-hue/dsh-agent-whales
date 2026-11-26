/**
 * dsh-agent-whales — 浏览器半边。
 *
 * 每多一个「正在干活」的智能体（Lead 或 teammate），页面顶端就多一只游动的鲸鱼娘。
 *
 * 数据来源（全部走宿主已提供的槽位能力，不自己抓 DOM）：
 *   - useSessions(sel)      ← client-ui-session 的 provideRoot 全局座位，
 *                             快照形如 { ids, byId, phase, projectionsBySession }。
 *                             byId[id] = { sessionId, title, running, origin, retainedBy, ... }
 *   - useSessionStatus(sel) ← 同一座位暴露的 uiSession 状态表（Map: id → { running, ... }），
 *                             由 remote 事件 `api-session/status` 与列表基线驱动。
 *   - agentTeam 投影        ← @deepseek-ai/dsh-experimental-agent-team 挂在 Lead 会话上的投影：
 *                             projectionsBySession[leadId].values.agentTeam =
 *                             { members: [{ id, name, role, phase, error? }], tasks, failure? }
 *                             members[0] 永远是 Lead 伪行（name === "lead"）。
 *
 * 判定「正在干活」：
 *   phase === "failed"        → 不算（鲸鱼沉了）
 *   phase === "provisioning"  → 算（正在起，属干活过程）
 *   其余（active/lead）       → 看会话 running；优先 uiSession 状态表，其次列表行 running
 *                              （子智能体会话的列表行 running 不保证可信，状态表优先）。
 *
 * 没有 agentTeam 投影时退化为「当前会话自己」——即在没有 Agent Teams 的 profile 里，
 * 这只 Lead 一干活仍会有一只鲸鱼。
 *
 * 形象：素材为社区「鲸鱼娘」二创图（角色参考 TreapGoGo/deepseek-whale-girl，MIT License，
 * 图片由 AI 生成）。D1 起素材不再内联进本文件：由 tools/build-assets.py 产成 assets/art.json，
 * 宿主半边按 manifest + 每张 WebP 提供 /agent-whales/api/art/*，本文件只留空的 ART 表，
 * 运行时由 artLoader 按用户当前皮肤分批拉取（L1 base → L2 常用帧 → L3 心情/状态帧）。
 * 同时保留早期的手绘矢量鲸鱼作为「经典皮肤」与首帧占位兜底。
 */
window.__ModuleLoader__.load({
	id: "dsh-agent-whales",
	factory: (require) => {
		var react = require("react");
		var h = react.createElement;
		// 波次 3：留住宿主给的 require——新画布的 React Flow chunk 走 `require.async("./client.flow.js")`
		// 按需加载（宿主 dsh-client-modules 的包内 chunk 契约），主包仍只同步 require("react")。
		var wbRequire = require;

		// ── 常量 ────────────────────────────────────────────────────────────────
		var NS = "agent-whales";
		var STORAGE_KEY = "dsh-agent-whales.settings";
		var STYLE_ID = "dsh-agent-whales-styles";
		/** scale=100 时的角色高度（px）。旧版矢量鲸鱼是 46px 宽，实测 96px 才认得出脸。 */
		var BASE_HEIGHT = 96;
		/** 单行最多画几只，超出的收成「+N」。 */
		var MAX_VISIBLE = 8;
		/** 「当前工具」轮询：正常间隔与失败退避上限（毫秒）。 */
		var POLL_INTERVAL = 2000;
		var POLL_MAX_INTERVAL = 30000;
		/** 一棵家族树里最多补进多少个子 agent，防止失控的树塞满顶栏。 */
		var MAX_DESCENDANTS = 12;
		/** 队形配色（顶色 / 底色）；经典皮肤里 Lead 固定用品牌蓝。 */
		var PALETTE = [
			["#7FB2FF", "#2E7BE0"],
			["#8E9BFF", "#4D5BE0"],
			["#6FD8E8", "#1E9FB8"],
			["#B79CFF", "#6E56E0"]
		];
		var LEAD_COLOR = ["#8FA8FF", "#3B55F0"];
		var EMPTY_STATE = { ids: [], byId: {}, phase: "ready", projectionsBySession: {} };
		var EMPTY_STORE = {
			getSnapshot: function () { return EMPTY_STATE; },
			subscribe: function () { return function () {}; }
		};
		var EMPTY_STATUS = new Map();

		// <art:begin> —— D1：素材不再内联进 bundle。
		// 这里必须是空表；运行时由 artLoader 从宿主的 /agent-whales/api/art/* 按皮肤分批拉取。
		// 旧的 tools/embed-art.mjs 内联构建仍然兼容：ART 非空时 artLoader 视为「已经就绪」，不联网。
		var ART = {};
		// <art:end>

		// ── 素材健康度：manifest 重试耗尽（或旧内联构建被 CSP 拦图）时退回经典皮肤 ──
		var artStatus = {
			broken: false,
			listeners: new Set(),
			getSnapshot: function () { return artStatus.broken; },
			subscribe: function (listener) {
				artStatus.listeners.add(listener);
				return function () { artStatus.listeners.delete(listener); };
			},
			markBroken: function () {
				if (artStatus.broken) return;
				artStatus.broken = true;
				artStatus.listeners.forEach(function (listener) { listener(); });
			},
			/**
			 * 素材后来恢复可用：撤掉「退矢量」标记（只有 artLoader 在重试成功后调）。
			 *
			 * 2026-10-31 真机事故：宿主并行加载插件，页面加载瞬间 /art/* 还是 404，
			 * 客户端一次失败就 markBroken → 用户不刷新就一直是经典金鱼。现在 broken 只由
			 * 「重试耗尽」或「base 帧真挂」触发，并且 manifest 后来拉通时可以被撤销。
			 */
			reset: function () {
				if (!artStatus.broken) return;
				artStatus.broken = false;
				artStatus.listeners.forEach(function (listener) { listener(); });
			}
		};

		// ── 素材加载器（D1：素材出 bundle，运行时按皮肤分批拉）─────────────────
		//
		// 契约（宿主半边 lib/index.js 提供，同一个 origin，相对路径直接 fetch）：
		//   GET /agent-whales/api/art/manifest    -> { version, keys: { "<key>": { w, h, bytes, skin } } }
		//   GET /agent-whales/api/art/<key>.webp  -> WebP 二进制（cache-control: immutable）
		//
		// 分层（PRD §34.2）：L1 base 帧最先到（首帧），L2 blink/entry/exit（常用帧），L3 其余（心情/状态帧）。
		// 失败策略：manifest 拉不到 → 有限退避重试（1s→2s→4s→8s，共 5 次尝试约 15s）；重试期间保持
		//   矢量兜底但**不** markBroken，宿主晚就绪时页面能自愈（回前台 / 换皮肤 / 重新挂载都会再试）；
		//   只有重试耗尽才 markBroken，且 manifest 后来拉通时会被撤销。
		//   单张帧失败（含 base）→ 该帧不进 ART，frameOf 自然退回 base / 逐只走矢量；不设全局 broken，
		//   这样换皮肤或回前台重试成功后能直接恢复。
		// 幂等：同一皮肤只排一次队；切皮肤只补拉新皮肤的键，已加载的 key 留在 ART 里不删。
		var ART_MANIFEST_URL = "/agent-whales/api/art/manifest";
		var ART_ASSET_PREFIX = "/agent-whales/api/art/";
		/**
		 * manifest 失败后的重试节奏（毫秒）：1s → 2s → 4s → 8s。
		 * 4 次重试 = 最多 5 次尝试，累计等待约 15s；耗尽后停手（宿主真没这个能力时不能无限打）。
		 */
		var ART_RETRY_DELAYS = [1000, 2000, 4000, 8000];
		var ART_MAX_ATTEMPTS = ART_RETRY_DELAYS.length + 1;
		/** 每个皮肤的主帧（L1）：它先到，别的一律排在它后面。 */
		var ART_SKIN_BASE = { q: "q-smile", mature: "m-base", classic: "c-idle" };
		/** 每个皮肤的常用帧（L2）：眨眼 / 入场 / 退场 / 工作态。 */
		var ART_SKIN_L2 = {
			q: ["q-blink", "q-wave", "q-proud"],
			mature: ["m-blink", "m-wave", "m-proud"],
			classic: ["c-work"]
		};

		/**
		 * 取 fetch：优先 window.fetch（浏览器与离线测试都走它），退回全局 fetch。
		 * 离线测试用 loadPlugin().win.fetch 注入假实现，不用污染 Node 全局。
		 */
		function resolveFetch() {
			if (typeof window !== "undefined" && window && typeof window.fetch === "function") return window.fetch;
			if (typeof fetch === "function") return fetch;
			return undefined;
		}

		/** key → 皮肤家族；manifest 的 skin 字段优先，缺失时按前缀兜底。 */
		function artFamilyOf(key, entry) {
			var skin = entry && entry.skin;
			if (skin === "q" || skin === "mature" || skin === "classic") return skin;
			if (typeof key !== "string") return undefined;
			if (key.slice(0, 2) === "q-") return "q";
			if (key.slice(0, 2) === "m-") return "mature";
			if (key.slice(0, 2) === "c-") return "classic";
			return undefined;
		}

		var artLoader = (function () {
			var listeners = new Set();
			var catalog = null; // key -> { w, h, family }
			var wanted = {}; // family -> true（用户看过的皮肤）
			var families = {}; // family -> "loading" | "ready" | "failed"
			var keyState = {}; // key -> "loading" | "ok" | "failed"
			var manifestState = "idle"; // idle | loading | ready | failed（failed = 本轮重试耗尽，可被 retry 唤醒）
			var manifestAttempts = 0; // 本轮已经发起的尝试次数（成功后清零）
			var manifestEpoch = 0; // 每次主动重来 +1，用来作废在途回调与等待中的重试
			var retryWait = false; // 正在退避等待下一次尝试
			var loaderBroke = false; // artStatus.broken 是不是我们打的（重试成功后由我们撤销）
			var hostAliveRetried = false; // 「宿主已经能用」信号只给一次重试，避免变成无限循环
			var visibilityBound = false;
			/** 退避等待实现：生产用 setTimeout，测试注入「立即 resolve」以免依赖真实计时。 */
			var wait = function (ms) {
				return new Promise(function (resolve) { setTimeout(resolve, ms); });
			};
			var idleResolvers = [];
			// 旧构建（embed-art 内联过）已经自带素材：视为就绪，一个网络请求都不发。
			var inline = Object.keys(ART).length > 0;
			var snapshot = { version: 0, manifest: manifestState, families: {}, loaded: 0, total: 0 };

			function loadedCount() {
				var count = 0;
				Object.keys(ART).forEach(function (key) {
					if (ART[key]) count += 1;
				});
				return count;
			}
			function isIdle() {
				if (manifestState === "loading") return false;
				// 已经点名要看、但还没排队的皮肤也算「没落定」——否则 whenIdle 会在
				// 「manifest 刚到、分波还没开始」的缝隙里提前 resolve。
				var wantedNames = Object.keys(wanted);
				for (var w = 0; w < wantedNames.length; w++) {
					if (families[wantedNames[w]] === undefined) return false;
				}
				var names = Object.keys(families);
				for (var i = 0; i < names.length; i++) {
					if (families[names[i]] === "loading") return false;
				}
				return true;
			}
			function flushIdle() {
				if (idleResolvers.length === 0) return;
				var list = idleResolvers;
				idleResolvers = [];
				list.forEach(function (resolve) { resolve(); });
			}
			function publish() {
				snapshot = {
					version: snapshot.version + 1,
					manifest: inline ? "ready" : manifestState,
					families: Object.assign({}, families),
					loaded: loadedCount(),
					total: inline ? loadedCount() : catalog === null ? 0 : Object.keys(catalog).length,
					attempts: inline ? 0 : manifestAttempts,
					retrying: inline ? false : retryWait
				};
				listeners.forEach(function (listener) { listener(); });
				if (isIdle()) flushIdle();
			}
			/** manifest 归一化：只接受有正尺寸、能归到某个皮肤家族的条目。 */
			function normalizeManifest(data) {
				var keys = data && typeof data === "object" && data.keys && typeof data.keys === "object" ? data.keys : null;
				if (keys === null) return null;
				var out = {};
				var count = 0;
				Object.keys(keys).forEach(function (key) {
					var entry = keys[key];
					if (!entry || typeof entry !== "object") return;
					var w = Number(entry.w);
					var h = Number(entry.h);
					if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return;
					var family = artFamilyOf(key, entry);
					if (family === undefined) return;
					out[key] = { w: Math.round(w), h: Math.round(h), family: family };
					count += 1;
				});
				return count > 0 ? out : null;
			}
			/** 只有 artLoader 打 broken 时才记 loaderBroke：重试成功后由我们撤销，别的来源不碰。 */
			function markBrokenByLoader() {
				if (artStatus.broken) return;
				loaderBroke = true;
				artStatus.markBroken();
			}
			/** 清单失败时，已经点名的皮肤都不会有素材：落定为 failed，别留悬浮状态。 */
			function markFamiliesFailed() {
				Object.keys(wanted).forEach(function (family) {
					if (families[family] === undefined) families[family] = "failed";
				});
			}
			/**
			 * 发起一次 manifest 尝试。失败 → 有限退避（见 ART_RETRY_DELAYS），耗尽才落 failed。
			 * 每次尝试带一个 epoch：主动重来会 +1，旧的在途/等待回调直接作废，避免重复请求。
			 */
			function startManifestAttempt() {
				if (manifestState === "ready") return;
				var epoch = manifestEpoch;
				manifestState = "loading";
				retryWait = false;
				manifestAttempts += 1;
				publish();
				var doFetch = resolveFetch();
				if (typeof doFetch !== "function") {
					failManifestAttempt(epoch);
					return;
				}
				var request;
				try {
					request = doFetch(ART_MANIFEST_URL, { headers: { accept: "application/json" }, cache: "no-store" });
				} catch (error) {
					request = null;
				}
				Promise.resolve(request)
					.then(function (response) {
						return response && response.ok === true ? response.json() : null;
					})
					.then(function (data) {
						if (epoch !== manifestEpoch) return;
						var next = normalizeManifest(data);
						if (next === null) {
							failManifestAttempt(epoch);
							return;
						}
						onManifestReady(next);
					})
					.catch(function () {
						if (epoch !== manifestEpoch) return;
						failManifestAttempt(epoch);
					});
			}
			function onManifestReady(next) {
				catalog = next;
				manifestState = "ready";
				retryWait = false;
				manifestAttempts = 0;
				// 之前因为「宿主还没就绪」退过矢量：现在素材回来了，把图层恢复成位图——
				// 这正是事故里缺的那一步：用户切回窗口/点一下皮肤就能自愈，不用 Ctrl+R。
				if (loaderBroke) {
					loaderBroke = false;
					artStatus.reset();
				}
				// 先把已点名的皮肤排进队列（它会自己 publish），再发一次「清单就绪」，
				// 这样 isIdle 不会在两步之间误判成「都落定了」。
				Object.keys(wanted).forEach(function (family) { runFamily(family); });
				publish();
			}
			function failManifestAttempt(epoch) {
				if (epoch !== manifestEpoch) return;
				if (manifestAttempts >= ART_MAX_ATTEMPTS) {
					// 重试耗尽 = 宿主确实没有素材能力（或长期不可用）：这时候才 latch 成 broken。
					manifestState = "failed";
					retryWait = false;
					markFamiliesFailed();
					markBrokenByLoader();
					publish();
					return;
				}
				// 还没耗尽：ART 是空的，渲染自然走矢量兜底，但**不** markBroken ——
				// 宿主晚几天就绪也好，页面要能自己恢复。
				manifestState = "loading";
				retryWait = true;
				publish();
				var delay = ART_RETRY_DELAYS[Math.min(manifestAttempts - 1, ART_RETRY_DELAYS.length - 1)];
				var waitEpoch = epoch;
				wait(delay).then(function () {
					if (waitEpoch !== manifestEpoch) return;
					startManifestAttempt();
				});
			}
			/**
			 * 主动重来一轮（页面回前台 / 用户切皮肤 / 重新挂载时调）。
			 * 已经 ready 或正在尝试时不打扰；只有 failed（或 idle）才真的再打一轮。
			 */
			function retryManifest() {
				if (manifestState === "ready" || manifestState === "loading") return false;
				manifestEpoch += 1;
				manifestAttempts = 0;
				retryWait = false;
				manifestState = "idle";
				// 上一轮把皮肤标成 failed 了：重来时要能重新排队
				Object.keys(families).forEach(function (family) {
					if (families[family] === "failed") delete families[family];
				});
				startManifestAttempt();
				return true;
			}
			function ensureManifest() {
				if (manifestState === "ready" || manifestState === "loading" || manifestState === "failed") return;
				startManifestAttempt();
			}
			/** 页面回到前台时给失败过的素材一次自愈机会（用户不必手动刷新）。 */
			function bindVisibility() {
				if (visibilityBound) return;
				visibilityBound = true;
				if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
				document.addEventListener("visibilitychange", function () {
					if (typeof document !== "undefined" && document.hidden === true) return;
					onVisible();
				});
			}
			function onVisible() {
				if (manifestState === "failed") {
					retryManifest();
					return;
				}
				if (catalog === null) return;
				// 清单是好的、但某个皮肤整层失败（例如启动瞬间图片路由还没就绪）：回前台补一次。
				Object.keys(families).forEach(function (family) {
					if (families[family] !== "failed") return;
					clearFamilyState(family);
					runFamily(family);
				});
			}
			/** 清掉一套皮肤的失败记录（换皮肤/回前台重试时用），连同它名下的 key 状态。 */
			function clearFamilyState(family) {
				if (catalog !== null) {
					Object.keys(catalog).forEach(function (key) {
						if (catalog[key].family === family) keyState[key] = undefined;
					});
				}
				delete families[family];
			}
			/** 一个皮肤分几波：base → 常用帧 → 其余（排序固定，便于断言与稳定渲染）。 */
			function wavesOf(family) {
				var keys = Object.keys(catalog).filter(function (key) { return catalog[key].family === family; });
				if (keys.length === 0) return null;
				var base = ART_SKIN_BASE[family];
				var l2 = (ART_SKIN_L2[family] || []).filter(function (key) { return keys.indexOf(key) >= 0; });
				var l1 = keys.indexOf(base) >= 0 ? [base] : [];
				var rest = keys.filter(function (key) {
					return l1.indexOf(key) < 0 && l2.indexOf(key) < 0;
				}).sort();
				var waves = [];
				if (l1.length > 0) waves.push(l1);
				if (l2.length > 0) waves.push(l2);
				if (rest.length > 0) waves.push(rest);
				return waves;
			}
			function loadKey(key) {
				if (keyState[key] === "ok" || keyState[key] === "loading") return Promise.resolve();
				var entry = catalog[key];
				var doFetch = resolveFetch();
				if (!entry || typeof doFetch !== "function") {
					// 单帧拿不到只影响这一帧：ART 里没有它，frameOf 会退回 base；
					// 全局 broken 只留给「manifest 重试耗尽」，别让一张图把整层锁成矢量。
					keyState[key] = "failed";
					publish();
					return Promise.resolve();
				}
				keyState[key] = "loading";
				var uri = ART_ASSET_PREFIX + encodeURIComponent(key) + ".webp";
				var request;
				try {
					request = doFetch(uri, { cache: "force-cache", headers: { accept: "image/webp" } });
				} catch (error) {
					request = null;
				}
				return Promise.resolve(request)
					.then(function (response) {
						if (!response || response.ok !== true) throw new Error("art unavailable: " + key);
						// 把响应体读掉，确保浏览器真的把它缓存住；<img> 用同一个 URL 不会二次下载。
						if (typeof response.arrayBuffer === "function") {
							return Promise.resolve(response.arrayBuffer()).then(function () { return undefined; }, function () { return undefined; });
						}
						return undefined;
					})
					.then(function () {
						keyState[key] = "ok";
						ART[key] = { w: entry.w, h: entry.h, uri: uri };
						publish();
					})
					.catch(function () {
						keyState[key] = "failed";
						// 单帧失败只摘掉这一帧（frameOf 会自动退回 base）；不设全局 broken，
						// 这样换皮肤/回前台重试成功后能直接恢复，不用刷新。
						publish();
					});
			}
			function runFamily(family) {
				if (catalog === null || families[family] !== undefined) return;
				var waves = wavesOf(family);
				if (waves === null) {
					// 宿主没有这套素材：这一套算失败，但不影响别的皮肤
					families[family] = "failed";
					publish();
					return;
				}
				families[family] = "loading";
				publish();
				var chain = Promise.resolve();
				waves.forEach(function (wave) {
					// 按波串行：首帧必须先于常用帧，常用帧必须先于心情/状态帧
					chain = chain.then(function () {
						return Promise.all(wave.map(function (key) { return loadKey(key); }));
					});
				});
				chain.then(function () {
					var okCount = Object.keys(catalog).filter(function (key) {
						return catalog[key].family === family && keyState[key] === "ok";
					}).length;
					families[family] = okCount > 0 ? "ready" : "failed";
					// 整套一张都没拿到：这一套这个皮肤不可用（渲染会逐只退矢量），
					// 但不设全局 broken —— 换皮肤/回前台还能再试，不该一坏到底。
					publish();
				});
			}
			return {
				getSnapshot: function () { return snapshot; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				/** 请求某套皮肤（q | mature | classic）的素材；重复调用不会重复排队。 */
				ensureSkin: function (family) {
					if (family !== "q" && family !== "mature" && family !== "classic") return;
					if (inline) return;
					bindVisibility();
					var firstTime = wanted[family] !== true;
					wanted[family] = true;
					if (manifestState === "failed") {
						// 宿主晚就绪是常态：切皮肤 / 面板重新打开是用户的主动动作，给一次重来的机会。
						retryManifest();
					} else {
						ensureManifest();
					}
					if (catalog === null) return;
					if (!firstTime && families[family] === "failed") {
						// 这一套之前整层失败过（帧全 404）：再次被点名时补拉一次，别永久放弃。
						clearFamilyState(family);
					}
					runFamily(family);
				},
				/**
				 * <img> 加载失败时把这一帧从 ART 里摘掉，下一次渲染 frameOf 会退回 base。
				 * 运行时路由失败只摘掉这一帧（不设全局 broken）；旧的内联构建走 markBroken（CSP 拦 data: 时只能退矢量）。
				 */
				rejectKey: function (key) {
					if (!key) return;
					if (inline) {
						// 旧的「内联 data:」构建：被 CSP 拦掉时只能整层退矢量（没有别的来源可补）。
						artStatus.markBroken();
						return;
					}
					// 运行时路由：摘掉这一帧即可。frameOf 会退回 base；base 也没了就是逐只矢量。
					if (Object.prototype.hasOwnProperty.call(ART, key)) delete ART[key];
					keyState[key] = "failed";
					publish();
				},
				/** 测试/调试：已排队的皮肤都落定（或失败）后 resolve。 */
				whenIdle: function () {
					if (isIdle()) return Promise.resolve();
					return new Promise(function (resolve) { idleResolvers.push(resolve); });
				},
				/**
				 * 测试/宿主集成：替换重试等待实现。
				 * 传 `function () { return Promise.resolve(); }` 即零延迟（测试里不依赖真实计时）；
				 * 传空恢复默认 setTimeout。
				 */
				setRetryWait: function (fn) {
					wait = typeof fn === "function"
						? fn
						: function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
				},
				/** 主动重来一轮（页面回前台就是走这条；测试也可以直接调）。 */
				retry: function () { return retryManifest(); },
				/**
				 * 「宿主已经能用」信号：activity 轮询成功说明插件的 /agent-whales/api/* 路由活了
				 * （事故场景：页面加载时素材 404，十几分钟后宿主才把插件拉起来；activity 先恢复，
				 * 这时不必等用户切窗口，借这个信号补一轮即可）。
				 * 只给一次，且不额外发请求——之后还失败就交给用户动作（切皮肤/回前台）触发。
				 * @returns {boolean} 是否真的发起了重试
				 */
				notifyHostAlive: function () {
					if (hostAliveRetried) return false;
					if (manifestState !== "failed") return false;
					hostAliveRetried = true;
					return retryManifest();
				}
			};
		})();

		/**
		 * 展开状态：哪些角色被点开了下一层。
		 *
		 * 放外部 store，一是重渲染不掉状态，二是离屏测试可以直接驱动它，
		 * 三是 getSnapshot 只在真的变化时换引用（useSyncExternalStore 的要求）。
		 */
		function createIdSet() {
			var ids = new Set();
			var version = 0;
			var snapshot = { version: 0, ids: [] };
			var listeners = new Set();
			function publish() {
				version += 1;
				snapshot = { version: version, ids: Array.from(ids) };
				listeners.forEach(function (listener) { listener(); });
			}
			return {
				getSnapshot: function () { return snapshot; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				has: function (id) { return ids.has(String(id)); },
				toggle: function (id) {
					var key = String(id);
					if (ids.has(key)) ids.delete(key); else ids.add(key);
					publish();
				},
				/** 测试/预览用：直接给定展开集合。 */
				set: function (list) {
					ids = new Set((list || []).map(String));
					publish();
				}
			};
		}

		var expanded = createIdSet();

		// ── 拖拽位置（单独一个 localStorage 键，别把设置搞成数据仓库）────────────
		var POS_KEY = "dsh-agent-whales.positions";

		/**
		 * { [sessionKey]: { x, y } } —— 相对队形左上角的像素坐标。
		 * 存外部 store 的原因和 expanded 一样：不掉状态、测试可直接驱动。
		 */
		function createPositions() {
			var map = read();
			var version = 0;
			/**
			 * 初值必须带上已经读出来的坐标。
			 * 以前这里给的是空表，坐标只留在闭包里，要等下一次 publish()（用户再拖一次）
			 * 才进快照——刷新页面后位置全部丢失，等于持久化没生效。
			 */
			var snapshot = { version: 0, map: Object.assign({}, map) };
			var listeners = new Set();
			function read() {
				try {
					var raw = window.localStorage.getItem(POS_KEY);
					var parsed = raw === null ? null : JSON.parse(raw);
					if (!parsed || typeof parsed !== "object") return {};
					// 数组也是 object；手改成数组时当作空表，别把数字下标当成会话 key。
					if (Object.prototype.toString.call(parsed) !== "[object Object]") return {};
					return parsed;
				} catch (error) {
					return {};
				}
			}
			function publish() {
				version += 1;
				snapshot = { version: version, map: Object.assign({}, map) };
				try {
					window.localStorage.setItem(POS_KEY, JSON.stringify(map));
				} catch (error) {
					/* 隐私模式下继续用内存值 */
				}
				listeners.forEach(function (listener) { listener(); });
			}
			return {
				getSnapshot: function () { return snapshot; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				has: function (key) { return map[String(key)] !== undefined; },
				/** @param {{x:number,y:number}} position */
				set: function (key, position) {
					map[String(key)] = { x: Math.round(position.x), y: Math.round(position.y) };
					publish();
				},
				remove: function (key) {
					if (map[String(key)] === undefined) return;
					delete map[String(key)];
					publish();
				},
				clear: function () {
					map = {};
					publish();
				}
			};
		}

		var positions = createPositions();

		/**
		 * 算出每一行该不该脱离队形、脱离后落在哪。
		 *
		 * 规则：自己拖过就用自己存的坐标；否则看最近的「被拖过的祖先」，按层差往右下
		 * 偏移一点点——这样父鱼被挪走时小鱼跟着走，而不是留在原地孤零零的。
		 * 纯函数，便于离线断言。
		 */
		function resolveOffsets(rows, map, spacing) {
			var dx = spacing && isFinite(spacing.dx) ? spacing.dx : 30;
			var dy = spacing && isFinite(spacing.dy) ? spacing.dy : 12;
			var byKey = {};
			rows.forEach(function (row) { byKey[row.whale.key] = row; });

			/**
			 * 一个坐标值能不能用：必须是真的数字、有限、不离谱，且不是「取消事件」留下的 (0,0)。
			 * 历史脏数据也要在这里挡住，否则角色会一直钉在左上角。
			 */
			function usable(entry) {
				if (!entry || typeof entry !== "object") return false;
				// 不能用全局 isFinite：它会把 null→0、"12"→12、true→1 强转成合法坐标。
				// JSON 存不下 NaN（会变成 null），而拖拽事件是可能产生 NaN 的，
				// 于是「先出现 NaN、刷新后变 null」正好是历史事故「角色被钉到左上角」的复现路径。
				if (typeof entry.x !== "number" || typeof entry.y !== "number") return false;
				if (!isFinite(entry.x) || !isFinite(entry.y)) return false;
				if (Math.abs(entry.x) >= 4000 || Math.abs(entry.y) >= 4000) return false;
				if (Math.abs(entry.x) < 2 && Math.abs(entry.y) < 2) return false;
				return true;
			}

			var out = {};
			rows.forEach(function (row) {
				var key = row.whale.key;
				var own = map[key];
				if (usable(own)) {
					out[key] = { x: Math.round(own.x), y: Math.round(own.y), own: true };
					return;
				}
				var cur = row.parent;
				var hops = 1;
				var guard = 0;
				while (cur !== undefined && guard++ < 32) {
					var anchor = map[cur];
					if (usable(anchor)) {
						out[key] = {
							x: Math.round(anchor.x) + Math.round(hops * dx),
							y: Math.round(anchor.y) + Math.round(hops * dy),
							own: false
						};
						return;
					}
					var parentRow = byKey[cur];
					cur = parentRow ? parentRow.parent : undefined;
					hops += 1;
				}
			});
			return out;
		}

		// ── 样式（容器用主题 token，插画本身是素材、允许自带色）─────────────────
		var CSS = [
			".daw-layer{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:1}",
			".daw-pod{position:absolute;left:0;right:0;display:flex;align-items:flex-end;gap:6px;pointer-events:none}",
			".daw-pod-left{justify-content:flex-start;padding-left:20px}",
			".daw-pod-center{justify-content:center}",
			".daw-pod-right{justify-content:flex-end;padding-right:20px}",
			".daw-whale{position:relative;display:flex;flex-direction:column;align-items:center;flex:none;will-change:transform;transform-origin:50% 100%;animation:daw-in .55s cubic-bezier(.2,.9,.3,1.35) both}",
			".daw-whale-out{animation:daw-out .72s cubic-bezier(.4,0,.7,.2) both}",
			".daw-swim{display:block;line-height:0;transform-origin:50% 100%;animation:daw-bob var(--daw-dur,3.4s) ease-in-out infinite;animation-delay:var(--daw-delay,0s)}",
			".daw-stage{position:relative;display:inline-block;line-height:0}",
			".daw-sprite{display:block;height:100%;width:auto;user-select:none;-webkit-user-drag:none;filter:drop-shadow(0 2px 4px rgba(17,25,50,.16));animation:daw-fade .3s ease-out both}",
			".daw-art{display:block;height:100%;width:auto;overflow:visible}",
			".daw-frame{position:absolute;left:50%;bottom:0;transform:translateX(-50%)}",			".daw-frame-entry{animation:daw-frame-out .65s ease-in .45s both}",
			".daw-frame-blink{opacity:0;animation:daw-blink var(--daw-blink-dur,6.4s) steps(1,end) infinite;animation-delay:var(--daw-blink-delay,1.2s)}",
			".daw-halo{position:absolute;left:50%;bottom:-2px;width:76%;height:10px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(closest-side,rgba(59,85,240,.34),rgba(59,85,240,0));filter:blur(2px);animation:daw-halo var(--daw-dur,3.4s) ease-in-out infinite}",
			".daw-bubbles{position:absolute;left:0;right:0;bottom:8%;height:58%;pointer-events:none}",
			".daw-bubbles i{position:absolute;bottom:0;left:var(--bx,50%);width:var(--bs,4px);height:var(--bs,4px);border-radius:50%;background:rgba(122,182,255,.9);box-shadow:0 0 6px rgba(90,150,255,.5);opacity:0;animation:daw-bubble var(--daw-bub-dur,3.2s) linear infinite;animation-delay:var(--daw-bub-delay,0s)}",
			".daw-dots{position:absolute;left:50%;top:-1px;display:flex;gap:3px;transform:translateX(-50%);opacity:0;transition:opacity .2s ease}",
			".daw-whale[data-state=provisioning] .daw-dots{opacity:1}",
			".daw-dots i{width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3B55F0);animation:daw-dot 1.2s ease-in-out infinite}",
			".daw-dots i:nth-child(2){animation-delay:.15s}",
			".daw-dots i:nth-child(3){animation-delay:.3s}",
			".daw-whale[data-state=provisioning] .daw-sprite{animation:daw-pulse 1.15s ease-in-out infinite}",
			".daw-whale[data-state=failed] .daw-sprite{filter:grayscale(1) opacity(.55)}",
			".daw-whale[data-state=idle] .daw-sprite{filter:grayscale(.35) opacity(.6)}",
			".daw-whale[data-state=idle] .daw-frame,.daw-whale[data-state=idle] .daw-halo,.daw-whale[data-state=idle] .daw-bubbles{display:none}",
			".daw-whale[data-state=idle] .daw-label{opacity:.65}",
			".daw-label{margin-top:1px;max-width:var(--daw-col,116px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-variant-numeric:tabular-nums;text-shadow:0 0 3px var(--dsw-alias-bg-base,#fff),0 0 3px var(--dsw-alias-bg-base,#fff)}",
			".daw-team-bar{flex:0 1 auto;min-width:0;align-self:flex-end;margin:0 10px 6px 0;padding:4px 10px;border-radius:11px;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.1));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(300px,32vw);box-shadow:0 2px 8px rgba(17,25,50,.12)}",
			".daw-team-bar b{font-weight:600;color:var(--dsw-alias-label-primary);margin-right:4px}",
			".daw-count{flex:none;white-space:nowrap;margin:0 0 6px 2px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;font-variant-numeric:tabular-nums;align-self:center}",
			".daw-unit[data-drag='1']{pointer-events:auto;cursor:grab;touch-action:none}",
			".daw-unit:focus-visible{outline:2px solid var(--dsw-alias-border-focus,var(--dsw-alias-brand-primary,#3B55F0));outline-offset:2px;border-radius:10px}",
			".daw-unit[data-clickable='1']{pointer-events:auto}",
			".daw-unit[data-clickable='1'][data-drag='0']{cursor:pointer}",
			".daw-unit[data-dragging='true']{cursor:grabbing;z-index:9;opacity:.92;filter:drop-shadow(0 6px 12px rgba(17,25,50,.28))}",
			".daw-unit[data-dragging='true'] .daw-swim{animation:none}",
			".daw-defs{position:absolute;width:0;height:0;overflow:hidden}",
			".daw-tail{transform-box:fill-box;transform-origin:100% 50%;animation:daw-wag var(--daw-dur,3.4s) ease-in-out infinite}",
			".daw-drop{transform-box:fill-box;transform-origin:50% 100%;animation:daw-spout calc(var(--daw-dur,3.4s) * .5) ease-out infinite}",
			".daw-unit{position:relative;display:flex;flex-direction:column;align-items:center;flex:none;pointer-events:none;max-width:var(--daw-col,116px)}",
			".daw-unit[data-depth='1']{margin-left:10px}",
			".daw-unit[data-depth='2']{margin-left:20px}",
			".daw-unit[data-depth='3']{margin-left:30px}",
			".daw-bind{position:absolute;left:-9px;bottom:8px;width:9px;height:1px;background:var(--dsw-alias-border-l2,rgba(90,120,190,.4))}",
			".daw-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:6px;width:max-content;max-width:var(--daw-col,116px);padding:3px 7px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.1));color:var(--dsw-alias-label-primary);font-size:11px;line-height:14px;text-align:center;white-space:normal;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;box-shadow:0 2px 8px rgba(17,25,50,.14);pointer-events:none;z-index:2}",
			".daw-bubble:after{content:'';position:absolute;left:50%;top:100%;width:0;height:0;margin-left:-4px;border:4px solid transparent;border-top-color:var(--dsw-alias-bg-elevated,#fff)}",
			".daw-tasks{display:flex;flex-direction:column;gap:2px;margin-top:2px;max-width:var(--daw-col,116px);align-items:flex-start}",
			".daw-task{display:flex;align-items:center;gap:4px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));max-width:100%;text-shadow:0 0 3px var(--dsw-alias-bg-base,#fff)}",
			".daw-task b{flex:none;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.45}",
			".daw-task[data-status=in_progress] b{background:#3B82F6;opacity:1}",
			".daw-task[data-status=completed] b{background:#22C55E;opacity:1}",
			".daw-task span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".daw-expand{margin-top:2px;padding:0 6px;height:14px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary);font-size:9px;line-height:12px;cursor:pointer;pointer-events:auto;font-variant-numeric:tabular-nums}",
			".daw-expand:hover{color:var(--dsw-alias-label-primary)}",
			".daw-layer[data-motion=off] .daw-swim,.daw-layer[data-motion=off] .daw-halo,.daw-layer[data-motion=off] .daw-frame-entry,.daw-layer[data-motion=off] .daw-frame-blink,.daw-layer[data-motion=off] .daw-dots i,.daw-layer[data-motion=off] .daw-tail,.daw-layer[data-motion=off] .daw-drop,.daw-layer[data-motion=off] .daw-whale,.daw-layer[data-motion=off] .daw-sprite{animation:none}",
			".daw-layer[data-motion=off] .daw-frame-entry,.daw-layer[data-motion=off] .daw-bubbles{display:none}",
			// 等你（波次 B）：复用 q-wave，但整只常驻循环摆手，区别于一次性的入场挥手；气泡用强调色常驻。
			".daw-whale[data-face=waiting] .daw-sprite{animation:daw-beckon 1.1s ease-in-out infinite}",
			".daw-unit[data-waiting=\"1\"]>.daw-bubble{background:#fff4d6;color:#7a4b00;border-color:#f0b429;font-weight:600}",
			"@keyframes daw-beckon{0%,100%{transform:rotate(-4deg) translateY(0)}50%{transform:rotate(4deg) translateY(-3px)}}",
			".daw-layer[data-motion=off] .daw-whale[data-face=waiting] .daw-sprite{animation:none}",
			// 上下文血条：满 → 空；剩余 ≤35% 琥珀、≤15% 红（颜色之外还有 aria-label 文字，不靠色传信息）。
			".daw-ctx{display:block;width:60%;max-width:72px;height:5px;margin:3px auto 0;border-radius:3px;background:rgba(17,25,50,.18);overflow:hidden}",
			".daw-ctx b{display:block;height:100%;background:#2fb344}",
			".daw-ctx[data-level=mid] b{background:#f0b429}.daw-ctx[data-level=low] b{background:#d63939}",
			".daw-layer[data-resting='1'] .daw-pod{filter:grayscale(.35) opacity(.72)}",
			// ── 图形编排面板 ──
			".daw-graph-toggle{pointer-events:auto;flex:none;margin:0 0 6px 6px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.12));background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;cursor:pointer;box-shadow:0 2px 8px rgba(17,25,50,.10)}",
			".daw-graph-launcher{position:fixed;left:16px;bottom:16px;z-index:40;margin:0;padding:6px 12px;box-shadow:0 4px 14px rgba(17,25,50,.16)}",
			".daw-graph-toggle.is-on{background:var(--dsw-alias-brand-primary,#3b55f0);border-color:transparent;color:#fff}",
			".daw-graph{position:absolute;right:16px;top:calc(var(--dsh-frame-top-clearance,0px) + 104px);width:min(560px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.12));border-radius:14px;box-shadow:0 12px 32px rgba(17,25,50,.18);pointer-events:auto;z-index:6;overflow:hidden}",
			".daw-graph-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.08));font-size:12px}",
			".daw-graph-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".daw-graph-close{margin-left:auto;border:0;background:none;font-size:16px;line-height:1;cursor:pointer;color:var(--dsw-alias-label-secondary)}",
			".daw-graph-body{flex:1;overflow:auto;padding:12px}",
			".daw-graph-canvas{position:relative;margin:0 auto}",
			".daw-graph-lines{position:absolute;inset:0;pointer-events:none}",
			".daw-graph-line{stroke:var(--dsw-alias-border-l2,rgba(17,25,50,.22));stroke-width:1.5}",
			".daw-graph-node{position:absolute;display:flex;flex-direction:column;gap:2px;padding:4px 6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.1));background:var(--dsw-alias-bg-elevated,#fff);cursor:pointer;user-select:none;touch-action:none;box-sizing:border-box}",
			".daw-graph-node.is-focused{outline:2px solid var(--dsw-alias-brand-primary,#3b55f0);outline-offset:1px}",
			".daw-graph-node.is-idle{opacity:.6}",
			".daw-graph-node.is-starting{border-style:dashed}",
			".daw-graph-face-row{display:flex;align-items:center;gap:5px;min-width:0}",
			".daw-graph-face{width:22px;height:22px;object-fit:contain;flex:none}",
			".daw-graph-name{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".daw-graph-meta{display:flex;align-items:center;gap:4px;min-width:0}",
			".daw-graph-dot{width:6px;height:6px;border-radius:50%;flex:none;background:#22a06b}",
			".daw-graph-dot[data-phase='idle']{background:#9aa0aa}",
			".daw-graph-dot[data-phase='provisioning']{background:#e0a018}",
			".daw-graph-task{font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".daw-graph-foot{border-top:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.08));padding:8px 10px}",
			".daw-graph-row{display:flex;align-items:center;gap:6px}",
			".daw-graph-target{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".daw-graph-input{flex:1;min-width:0;font-size:12px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.18));background:transparent;color:inherit}",
			".daw-graph-send{font-size:11px;padding:4px 10px;border-radius:8px;border:0;background:var(--dsw-alias-brand-primary,#3b55f0);color:#fff;cursor:pointer}",
			".daw-graph-send:disabled{opacity:.5;cursor:default}",
			".daw-graph-error{margin-bottom:6px;font-size:11px;color:#d33}",
			// ── P0：会话内画布视图（只读）──
			".daw-canvas{padding:16px 18px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-elevated,#fff);min-height:100%}",
			".daw-canvas-head{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}",
			".daw-canvas-head b{font-size:14px}",
			".daw-canvas-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".daw-canvas-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".daw-canvas-cols{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px}",
			".daw-canvas-col h4{margin:0 0 8px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}",
			".daw-canvas-card{display:flex;flex-direction:column;gap:2px;padding:7px 10px;margin-bottom:6px;border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.12));border-radius:8px;background:var(--dsw-alias-bg-elevated,#fff)}",
			".daw-canvas-card b{font-size:12px;font-weight:600}",
			".daw-canvas-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".daw-canvas-blocked{font-size:11px;color:#8a6208}",
			".daw-canvas-empty{margin:0;padding:10px;border:1px dashed var(--dsw-alias-border-l2,rgba(17,25,50,.18));border-radius:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".daw-canvas-foot{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.08));font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			// ── 目标条（conversation.input.dock 叠加层：W2 / D2 第一步）──
			// 它挂在官方 composer 上方，不在 .daw-wb 令牌根里，所以一律走宿主别名令牌 +
			// 兜底值（与 .daw-canvas / .daw-team-bar 同一套写法），不引 --daw-*。
			".daw-goalbar{display:flex;flex-direction:column;gap:6px;margin:0 0 8px;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-elevated,transparent));border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 13%,transparent));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}",
			".daw-goalbar-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-goalbar-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-brand-primary,#3B55F0)}",
			".daw-goalbar-label{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".daw-goalbar-text{min-width:0;max-width:min(520px,60vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}",
			".daw-goalbar-src{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}",
			".daw-goalbar-status{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}",
			".daw-goalbar-fill{flex:1;min-width:8px}",
			".daw-goalbar-btn{min-height:28px;padding:0 8px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;font-family:inherit;font-weight:550;cursor:pointer;white-space:nowrap}",
			".daw-goalbar-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}.daw-goalbar-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3B55F0);outline-offset:1px}",
			".daw-goalbar-btn:disabled{opacity:.5;cursor:not-allowed}",
			".daw-goalbar-msg{font-size:11px;line-height:15px}",
			".daw-goalbar-msg[data-tone=ok]{color:#1B7A4F}",
			".daw-goalbar-msg[data-tone=warn]{color:#8A6208}",
			".daw-goalbar-msg[data-tone=danger]{color:#B23B3B}",
			".daw-layer[data-paused=true] *{animation-play-state:paused!important}",
			"@keyframes daw-in{from{opacity:0;transform:translateY(18px) scale(.62)}to{opacity:1;transform:translateY(0) scale(1)}}",
			"@keyframes daw-fade{from{opacity:0}to{opacity:1}}",
			"@keyframes daw-out{from{opacity:1;transform:translateY(0) scale(1)}to{opacity:0;transform:translateY(14px) scale(.72)}}",
			"@keyframes daw-bob{0%{transform:translateY(0) rotate(-1.2deg)}50%{transform:translateY(var(--daw-amp,-4px)) rotate(1.2deg)}100%{transform:translateY(0) rotate(-1.2deg)}}",
			"@keyframes daw-frame-out{from{opacity:1}to{opacity:0}}",
			"@keyframes daw-blink{0%,95.5%{opacity:0}96.5%,98.5%{opacity:1}100%{opacity:0}}",
			"@keyframes daw-halo{0%,100%{opacity:.4;transform:translateX(-50%) scale(.92)}50%{opacity:.85;transform:translateX(-50%) scale(1.06)}}",
			"@keyframes daw-bubble{0%{opacity:0;transform:translateY(0) scale(.55)}14%{opacity:.9}100%{opacity:0;transform:translateY(-44px) scale(1.15)}}",
			"@keyframes daw-dot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}",
			"@keyframes daw-wag{0%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}100%{transform:rotate(-7deg)}}",
			"@keyframes daw-spout{0%{opacity:0;transform:translateY(5px) scale(.5)}35%{opacity:1}100%{opacity:0;transform:translateY(-13px) scale(1.15)}}",
			"@keyframes daw-pulse{0%,100%{opacity:1}50%{opacity:.55}}",
			".daw-section{display:flex;flex-direction:column;gap:10px}",
			".daw-head{display:flex;align-items:baseline;gap:8px}",
			".daw-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
			".daw-live{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".daw-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			// 紧跟某一行开关的说明文字：视觉上贴住上面那行，别被当成下一条设置
			".daw-row+.daw-hint{margin-top:-4px}",
			".daw-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
			".daw-rows{display:flex;flex-direction:column;gap:8px;max-width:560px}",
			".daw-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:28px}",
			".daw-row-label{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".daw-row-control{display:flex;align-items:center;gap:8px;min-width:0}",
			".daw-value{min-width:52px;text-align:right;font-size:12px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-variant-numeric:tabular-nums}",
			".daw-range{width:180px;accent-color:var(--dsw-alias-brand-primary)}",
			".daw-seg{display:inline-flex;padding:1px;gap:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}",
			".daw-seg button{padding:3px 10px;border:0;border-radius:7px;background:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;cursor:pointer;transition:background .15s ease,color .15s ease}",
			".daw-seg button:hover{color:var(--dsw-alias-label-primary)}",
			".daw-seg button[data-on=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary)}",
			".daw-switch{position:relative;flex:none;display:inline-block;width:36px;height:20px}",
			".daw-switch input{position:absolute;inset:0;margin:0;opacity:0;cursor:pointer}",
			".daw-switch i{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .18s ease;pointer-events:none}",
			".daw-switch i:after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s ease}",
			".daw-switch input:checked+i{background:var(--dsw-alias-brand-primary)}",
			".daw-switch input:checked+i:after{transform:translateX(16px)}",
			".daw-switch input:focus-visible+i{box-shadow:0 0 0 2px var(--dsw-alias-border-focus,var(--dsw-alias-brand-primary))}",
			".daw-switch input:disabled{cursor:not-allowed}",
			".daw-switch input:disabled+i{opacity:.45;cursor:not-allowed}",
			".daw-btn{display:inline-flex;align-items:center;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;cursor:pointer;transition:.18s ease}",
			".daw-btn:hover{color:var(--dsw-alias-label-primary)}",
			"@media (prefers-reduced-motion:reduce){.daw-swim,.daw-halo,.daw-frame-entry,.daw-frame-blink,.daw-bubbles i,.daw-dots i,.daw-tail,.daw-drop,.daw-whale,.daw-sprite{animation:none}.daw-frame-entry{display:none}}"
		].join("");

		function injectStyles() {
			// 极少数宿主/内嵌环境里 head 还不可用；宁可不注入样式，也别让 apply 抛出去。
			var head = typeof document !== "undefined" && document ? document.head : null;
			if (!head || typeof document.createElement !== "function") return function () {};
			if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID) !== null) {
				return function () {};
			}
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.dataset.plugin = "dsh-agent-whales";
			// 工作台样式并进同一个 <style>：宿主对样式标签数量敏感，多开一个既难清理，
			// 也让「注入一次」的断言失真。
			el.textContent = CSS + (typeof WB_CSS === "string" ? WB_CSS : "");
			head.appendChild(el);
			return function () {
				if (el.parentNode !== null) el.parentNode.removeChild(el);
			};
		}

		// ── 设置（localStorage 持久化 + 外部 store，供 useSyncExternalStore 订阅）──
		var DEFAULTS = {
			enabled: true,
			/** members：每个正在干活的智能体一只；teams：每个有成员在干活的团队一只。 */
			countMode: "members",
			/** left | center | right */
			position: "center",
			/** mix：Lead 成熟版 + 成员 Q 版；q/mature：全部统一；classic：早期手绘矢量鲸鱼 */
			skin: "q",
			/** off | soft | normal | lively */
			motion: "normal",
			/** 相对内容顶端的垂直偏移（px，负数上移）。默认 40 是把角色压到会话头那一行、给头顶气泡留出空间。 */
			offset: 56,
			/** 角色高度百分比（相对 BASE_HEIGHT）。 */
			scale: 100,
			/** 整队不透明度百分比。 */
			opacity: 100,
			/** 动画速度百分比。 */
			speed: 100,
			/** 气泡粒子。 */
			particles: true,
			/** 头顶对话气泡：显示该角色当前最新在做的事。 */
			bubbles: true,
			/** 没有正事可说时，冒一句俏皮话。 */
			quips: true,
			/** 状态表情：思考 / 收工庆祝 / 团队完成时换用专门的帧。关掉只走心情轮换。 */
			stateFaces: true,
			/** 出错时是否把「出错脸」画出来（默认开；嫌吵可关，只影响表现）。 */
			errorFaces: true,
			/** 工具动画：按当前在跑的工具类别（读 / 改 / 命令）切帧。关掉只走心情轮换。 */
			toolFaces: true,
			/** 等待举旗：审批 / 提问等你回应时角色挥手 + 「等你」气泡（默认开；关掉不影响审批本身）。 */
			waitFaces: true,
			/** 队形左侧的「大伙在干什么」汇总条。 */
			teamBar: true,
			/** 没人在干活时也把最后一批角色挂在屏幕上（灰显）。 */
			alwaysShow: true,
			/** 角色脚下的任务行。 */
			tasks: true,
			/** 已收工的子 agent 也画出来（灰显），关掉就只画正在跑的。 */
			idleChildren: true,
			/** 允许用鼠标把角色拖到任意位置；双击该角色复位。 */
			draggable: true,
			/** 名字标签。 */
			labels: false,
			/** 上下文血条：角色身上显示会话上下文余量（默认关，PRD 决策；数据口径见 docs/wave0-signals.md）。 */
			contextBar: false,
			/** 工作台主题（T-6）：light 默认；dark 是风格选项，只影响外观。 */
			theme: "system",
			officeScene: "auto"
		};

		var SKINS = ["mix", "q", "mature", "classic"];
		var MOTIONS = ["off", "soft", "normal", "lively"];

		function intOr(value, min, max, fallback) {
			var n = typeof value === "number" ? value : parseInt(value, 10);
			if (!isFinite(n)) return fallback;
			n = Math.round(n);
			return n < min ? min : n > max ? max : n;
		}

		function oneOf(value, allowed, fallback) {
			return allowed.indexOf(value) >= 0 ? value : fallback;
		}

		function normalizeSettings(raw) {
			var input = raw && typeof raw === "object" ? raw : {};
			return {
				enabled: input.enabled !== false,
				countMode: input.countMode === "teams" ? "teams" : "members",
				position: input.position === "left" || input.position === "right" ? input.position : "center",
				skin: oneOf(input.skin, SKINS, DEFAULTS.skin),
				motion: oneOf(input.motion, MOTIONS, DEFAULTS.motion),
				offset: intOr(input.offset, -60, 120, DEFAULTS.offset),
				scale: intOr(input.scale, 40, 200, DEFAULTS.scale),
				opacity: intOr(input.opacity, 20, 100, DEFAULTS.opacity),
				speed: intOr(input.speed, 25, 250, DEFAULTS.speed),
				particles: input.particles !== false,
				bubbles: input.bubbles !== false,
				quips: input.quips !== false,
				stateFaces: input.stateFaces !== false,
				errorFaces: input.errorFaces !== false,
				toolFaces: input.toolFaces !== false,
				waitFaces: input.waitFaces !== false,
				teamBar: input.teamBar !== false,
				alwaysShow: input.alwaysShow !== false,
				tasks: input.tasks !== false,
				idleChildren: input.idleChildren !== false,
				draggable: input.draggable !== false,
				labels: input.labels === true,
				contextBar: input.contextBar === true,
				theme: oneOf(input.theme, ["system", "light", "dark"], DEFAULTS.theme),
				officeScene: oneOf(input.officeScene, ["auto", "day", "night"], DEFAULTS.officeScene)
			};
		}

		function createSettings() {
			var listeners = new Set();
			var value = normalizeSettings(readRaw());
			function readRaw() {
				try {
					var raw = window.localStorage.getItem(STORAGE_KEY);
					return raw === null ? null : JSON.parse(raw);
				} catch (error) {
					return null;
				}
			}
			function publish(next) {
				if (JSON.stringify(next) === JSON.stringify(value)) return;
				value = next;
				try {
					window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
				} catch (error) {
					/* 隐私模式/配额不足时继续用内存值 */
				}
				listeners.forEach(function (listener) { listener(); });
			}
			return {
				getSnapshot: function () { return value; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				set: function (patch) { publish(normalizeSettings(Object.assign({}, value, patch))); },
				reset: function () { publish(normalizeSettings(null)); }
			};
		}

		var settings = createSettings();

		// ── 纯逻辑：从两个 store 快照折叠出鲸鱼清单（便于离线自测）──────────────
		function isMainView(row) {
			return !!row && !!row.retainedBy && (row.retainedBy.mainView || 0) > 0;
		}

		/** 当前主视图里的会话 id；找不到就退回最后一个已知会话。 */
		function currentSessionId(state) {
			if (!state) return undefined;
			var byId = state.byId || {};
			var ids = Array.isArray(state.ids) && state.ids.length ? state.ids : Object.keys(byId);
			var i;
			for (i = ids.length - 1; i >= 0; i--) {
				if (isMainView(byId[ids[i]])) return ids[i];
			}
			var keys = Object.keys(byId);
			for (i = keys.length - 1; i >= 0; i--) {
				if (isMainView(byId[keys[i]])) return keys[i];
			}
			return ids.length ? ids[ids.length - 1] : undefined;
		}

		/** Lead 会话上的 agentTeam 投影；没有团队投影时返回 undefined。 */
		function teamOf(state, leadId) {
			if (!state || leadId === undefined || leadId === null) return undefined;
			var projections = state.projectionsBySession || {};
			var store = projections[leadId];
			var team = store && store.values ? store.values.agentTeam : undefined;
			return team && Array.isArray(team.members) ? team : undefined;
		}

		/** 某个会话是否在跑：uiSession 状态表优先，列表行 running 兜底。 */
		function runningOf(statusMap, byId, id) {
			var live = statusMap && typeof statusMap.get === "function" ? statusMap.get(id) : undefined;
			if (live && typeof live.running === "boolean") return live.running;
			var row = byId ? byId[id] : undefined;
			return row ? row.running === true : undefined;
		}

		function memberWorking(member, running) {
			if (member.phase === "failed") return false;
			if (member.phase === "provisioning") return true;
			return running === true;
		}

		function describeWhale(member, leadId, byId) {
			var isLead = member.role === "lead" || member.id === leadId;
			var row = byId ? byId[member.id] : undefined;
			var label = isLead
				? (row && typeof row.title === "string" && row.title !== "" ? row.title : "lead")
				: (member.name || "agent");
			return {
				key: String(member.id),
				label: String(label),
				/** 名册里的名字（任务板的 ownerName 用它匹配，和展示用的 label 不是一回事）。 */
				name: String(member.name || member.id),
				/** 会话父子指针（宿主在 useSessions 的行里已经算好），用于画家族树。 */
				parentId: row && row.parentId !== undefined && row.parentId !== null ? String(row.parentId) : undefined,
				lead: isLead,
				phase: member.phase === "provisioning" ? "provisioning" : "running"
			};
		}

		function safeLeadId(leadIdOf, sessionId) {
			try {
				var resolved = leadIdOf(sessionId);
				return resolved === undefined || resolved === null ? sessionId : resolved;
			} catch (error) {
				return sessionId;
			}
		}

		/**
		 * 折叠出「现在应该有几只鲸鱼」。
		 * @returns {{ signature: string, whales: Array<{key,label,lead,phase}> }}
		 */
		function buildPod(state, statusMap, options, leadIdOf) {
			var opts = options || DEFAULTS;
			var byId = (state && state.byId) || {};
			var currentId = currentSessionId(state);
			var leadId = currentId === undefined ? undefined : safeLeadId(leadIdOf, currentId);
			var whales = [];

			if (opts.countMode === "teams") {
				// 按团队计数：每个「至少一名成员在干活」的团队一只鲸鱼（跨会话汇总）。
				var projections = (state && state.projectionsBySession) || {};
				Object.keys(projections).forEach(function (id) {
					var team = teamOf(state, id);
					if (!team) return;
					for (var i = 0; i < team.members.length; i++) {
						var member = team.members[i];
						if (!memberWorking(member, runningOf(statusMap, byId, member.id))) continue;
						var whale = describeWhale(member, id, byId);
						whale.key = "team:" + String(id);
						whales.push(whale);
						return;
					}
				});
				if (whales.length === 0 && leadId !== undefined) {
					var solo = soloWhale(leadId, statusMap, byId);
					if (solo) whales.push(solo);
				}
			} else {
				// 默认：正在干活的智能体各一只（只看当前会话所属团队）。
				if (leadId === undefined) return finishPod(whales, opts);
				var team = teamOf(state, leadId);
				var members = team ? team.members : [{ id: leadId, name: "lead", role: "lead", phase: "active" }];
				members.forEach(function (member) {
					if (memberWorking(member, runningOf(statusMap, byId, member.id))) {
						whales.push(describeWhale(member, leadId, byId));
						return;
					}
					// 收工的团队成员也要留在画面上（灰显）。
					// 之前这里直接 return，子会话通道又因为「名册 id 一律跳过」不再兜底，
					// 结果一个跑完团队任务的会话看上去像从来没组过队。
					if (opts.idleChildren === false) return;
					if (member.phase === "failed" || member.role === "lead") return;
					var idleWhale = describeWhale(member, leadId, byId);
					idleWhale.phase = "idle";
					whales.push(idleWhale);
				});
			}
			if (opts.includeSubagents !== false) {
				// 名册管过的 id 全部先登记，避免 failed 的成员被当成「子 agent」又冒出来。
				var handled = {};
				var projections = (state && state.projectionsBySession) || {};
				Object.keys(projections).forEach(function (sid) {
					var team = teamOf(state, sid);
					if (!team) return;
					team.members.forEach(function (member) { handled[String(member.id)] = true; });
				});
				addDescendants(whales, byId, statusMap, MAX_DESCENDANTS, handled, opts.idleChildren !== false);
			}
			return finishPod(whales, opts);
		}

		/** 没有团队投影时的退化：Lead 自己在干活就一只鲸鱼。 */
		function soloWhale(leadId, statusMap, byId) {
			if (runningOf(statusMap, byId, leadId) !== true) return undefined;
			return describeWhale({ id: leadId, name: "lead", role: "lead", phase: "active" }, leadId, byId);
		}

		/**
		 * 把「挂在已有角色下面的子 agent」也纳入清单。
		 *
		 * 子会话的父指针就在 useSessions 的 byId 行里（parentId，宿主已经算好），
		 * 所以这里只是沿着 parentId 逐层 BFS，不需要任何额外请求。
		 * 上限存在的意义是别让一棵失控的树把顶栏塞满。
		 */
		function addDescendants(whales, byId, statusMap, limit, handled, includeIdle) {
			var seen = {};
			var skip = handled || {};
			whales.forEach(function (whale) { seen[whale.key] = true; });
			var queue = whales.map(function (whale) { return whale.key; });
			var added = 0;
			while (queue.length > 0 && added < limit) {
				var parentId = queue.shift();
				var ids = Object.keys(byId);
				for (var i = 0; i < ids.length; i++) {
					var id = ids[i];
					// 名册里出现过的 id 一律交给名册规则处理（failed 的成员不能再借这条路回来）。
					if (seen[id] === true || skip[id] === true || added >= limit) continue;
					var row = byId[id];
					if (!row || String(row.parentId) !== String(parentId)) continue;
					var working = runningOf(statusMap, byId, id) === true;
					// 收工的子会话默认也留在画面上（灰显），否则一个跑完 22 个子 agent 的会话
					// 看上去会像「从来没组过队」。
					if (!working && includeIdle === false) continue;
					seen[id] = true;
					added += 1;
					var label = String(row.title || id);
					whales.push({
						key: String(id),
						label: label,
						name: label,
						parentId: String(parentId),
						lead: false,
						phase: working ? "running" : "idle",
						subagent: true
					});
					queue.push(String(id));
				}
			}
			return whales;
		}

		/**
		 * 「启动中」最多算这么久。名册里成员长时间停在 provisioning（spawn 了但会话
		 * 一直没跑起来）时，如果继续按「在干活」计数，就会出现「提示 4 只在干活、
		 * 实际只有 2 只在动」——超时就按收工处理，灰显但不占名额。
		 */
		var PROVISIONING_GRACE_MS = 90 * 1000;
		var provisioningSince = {};

		function expireProvisioning(whales, now) {
			var seen = {};
			whales.forEach(function (whale) {
				seen[whale.key] = true;
				if (whale.phase !== "provisioning") { delete provisioningSince[whale.key]; return; }
				var since = provisioningSince[whale.key];
				if (!isFinite(since)) { provisioningSince[whale.key] = now; return; }
				if (now - since > PROVISIONING_GRACE_MS) whale.phase = "idle";
			});
			Object.keys(provisioningSince).forEach(function (key) {
				if (seen[key] !== true) delete provisioningSince[key];
			});
		}

		function finishPod(whales, opts) {
			expireProvisioning(whales, Date.now());
			var parts = [opts.countMode];
			whales.forEach(function (whale) {
				parts.push(whale.key + "\u0001" + whale.label + "\u0001" + whale.phase + "\u0001" + (whale.lead ? "1" : "0"));
			});
			return { signature: parts.join("\u0002"), whales: whales };
		}

		/**
		 * 单行放不下时的排布：先按数量线性缩小，再截断成「前 MAX_VISIBLE 只 + N」。
		 * 纯函数，便于离线断言。
		 */
		function planPod(whales, size) {
			var list = Array.isArray(whales) ? whales : [];
			var overflow = list.length > MAX_VISIBLE ? list.length - MAX_VISIBLE : 0;
			var visible = overflow > 0 ? list.slice(0, MAX_VISIBLE) : list;
			var shrink = list.length > 3 ? Math.max(56, Math.round(size - (list.length - 3) * 8)) : size;
			return {
				size: Math.min(size, shrink),
				whales: visible,
				overflow: overflow,
				total: list.length
			};
		}

		/**
		 * 按会话父子关系把角色摊平成带 depth 的行，同时算出「可见 / 已展开 / 有下级」。
		 *
		 * 规则：
		 *   - 父会话不在清单里（已收工或 failed）时，子会话降级为根，绝不凭空消失；
		 *   - 默认只露出第 0、1 层，更深的层要有祖先被点开才出现；
		 *   - 沿父链走有步数上限，亲戚关系成环也不会死循环。
		 *
		 * @param {Array} whales buildPod 折出来的清单
		 * @param {Array} whales buildPod 折出来的清单（每项带 parentId）
		 * @param {(id: string) => boolean} has 当前展开集合的查询
		 */
		function lineageOf(whales, has) {
			var inPod = {};
			whales.forEach(function (whale) { inPod[whale.key] = true; });

			var parentOf = {};
			whales.forEach(function (whale) {
				var parentId = whale.parentId === undefined || whale.parentId === null ? undefined : String(whale.parentId);
				if (parentId === undefined || parentId === whale.key || inPod[parentId] !== true) parentId = undefined;
				parentOf[whale.key] = parentId;
			});

			var kidsOf = {};
			var roots = [];
			whales.forEach(function (whale) {
				var parentId = parentOf[whale.key];
				if (parentId === undefined) { roots.push(whale); return; }
				if (kidsOf[parentId] === undefined) kidsOf[parentId] = [];
				kidsOf[parentId].push(whale);
			});

			var rows = [];
			var seen = {};
			function walk(node, depth) {
				if (seen[node.key]) return;
				seen[node.key] = true;
				var kids = kidsOf[node.key] || [];
				rows.push({ whale: node, depth: depth, parent: parentOf[node.key], children: kids.length });
				for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
			}
			roots.forEach(function (root) { walk(root, 0); });
			whales.forEach(function (whale) { if (seen[whale.key] !== true) walk(whale, 0); });

			function ancestorsOpen(row) {
				var cur = row.parent;
				var guard = 0;
				while (cur !== undefined && guard++ < 32) {
					var grand = parentOf[cur];
					// 根层默认就露着，不需要被点开；只有非根的祖先才要求展开。
					if (grand !== undefined && has(cur) !== true) return false;
					cur = grand;
				}
				return true;
			}

			var visibleOf = {};
			rows.forEach(function (row) {
				visibleOf[row.whale.key] = row.depth <= 1 || ancestorsOpen(row);
			});

			return rows.map(function (row) {
				var kids = kidsOf[row.whale.key] || [];
				var hiddenHere = 0;
				for (var i = 0; i < kids.length; i++) {
					if (visibleOf[kids[i].key] !== true) hiddenHere += 1;
				}
				return {
					whale: row.whale,
					depth: row.depth,
					/** 父会话 key：拖拽时靠它算「跟着父级走」，别丢。 */
					parent: row.parent,
					children: row.children,
					/** 点一下能放出来几个直接下级；为 0 就没有展开按钮。 */
					hidden: hiddenHere,
					expanded: has(row.whale.key) === true,
					visible: visibleOf[row.whale.key] === true
				};
			});
		}

		/**
		 * 任务板里挂在某个成员名下的任务，进行中优先、其次待办、最后完成。
		 * Lead 额外接管「还没人认领」的团队任务，否则这些任务在界面上完全看不见。
		 */
		function tasksOf(team, name, includeUnowned) {
			if (!team || !Array.isArray(team.tasks) || name === undefined) return [];
			var rankOf = { in_progress: 0, pending: 1, completed: 2 };
			return team.tasks
				.filter(function (task) {
					if (!task || task.status === "deleted") return false;
					if (task.ownerName === name) return true;
					var ownerless = task.ownerName === undefined || task.ownerName === null || task.ownerName === "";
					return includeUnowned === true && ownerless;
				})
				.sort(function (a, b) {
					var ra = rankOf[a.status] === undefined ? 3 : rankOf[a.status];
					var rb = rankOf[b.status] === undefined ? 3 : rankOf[b.status];
					return ra - rb;
				});
		}

		/**
		 * 头部气泡里那句「当前正在进行的最新工作」。
		 *
		 * 客户端能拿到的最细粒度真源是任务板：优先取自己名下进行中的任务标题，
		 * 没有就退回会话标题；Lead 再兜一层「团队里任意进行中的任务」。
		 * 拿不到逐条工具调用级别的话术，这里不编。
		 */
		function activityOf(whale, team, byId) {
			var mine = tasksOf(team, whale.name);
			var active = mine.filter(function (task) { return task.status === "in_progress"; })[0];
			if (active) return active.subject;
			var row = byId ? byId[whale.key] : undefined;
			if (row && typeof row.title === "string" && row.title !== "") return row.title;
			if (whale.lead && team && Array.isArray(team.tasks)) {
				var any = team.tasks.filter(function (task) { return task && task.status === "in_progress"; })[0];
				if (any) return any.subject;
			}
			return undefined;
		}

		/** 这个角色名下是否真有「进行中」的任务——有它才值得占气泡说正事。 */
		function hasActiveTask(team, whale) {
			if (!team || !Array.isArray(team.tasks)) return false;
			return tasksOf(team, whale.name, whale.lead === true).some(function (task) {
				return task.status === "in_progress";
			});
		}

		/**
		 * 俏皮话：没有正事可说的时候，让角色自己冒一句。
		 *
		 * 刻意写短（≤8 个汉字）——气泡宽度锁在角色列宽内，长了会被省略号吃掉。
		 * 选词只看「状态 + 序号 + tick」，纯函数，测试可断言，也不需要为每只单开计时器。
		 */
		var QUIPS = {
			// 干活时冒的：一半是状态，一半是「应答感」的话
			running: [
				"马上就好", "正在写码", "再核对下", "就快好了", "别急别急", "在动手了",
				"当然可以", "好问题", "交给我吧", "稳稳接住", "收到啦"
			],
			provisioning: ["在起了", "等我一下", "马上开工", "我就在这里"],
			idle: ["收工啦", "歇会儿", "摸鱼中", "随时叫我", "我在这儿"],
			fallback: ["在的", "有事说", "我就在这里"]
		};

		function quipFor(state, seed, tick) {
			var pool = QUIPS[state] || QUIPS.fallback;
			var n = Math.abs(Math.floor(seed) + Math.floor(tick || 0));
			return pool[n % pool.length];
		}

		/** 工具名 → 一句人话（≤5 字，气泡列宽有限）。 */
		var TOOL_QUIPS = {
			read: "在读文件",
			edit: "在改文件",
			write: "在写文件",
			bash: "在跑命令",
			pwsh: "在跑命令",
			grep: "在搜代码",
			glob: "在找文件",
			web_search: "在上网查",
			web_fetch: "在抓网页",
			todo_write: "在列计划",
			spawn_teammate: "在派活",
			send_message: "在传话",
			team_task_create: "在拆任务",
			// 串门：装了 dsh-session-bridge 时，它的工具调用会落到这里，气泡就变成「去串门」
			session_bridge_create: "开新房",
			session_bridge_send: "去串门",
			session_bridge_wait: "等回话",
			session_bridge_read: "看邻居",
			session_bridge_segments: "看邻居",
			session_bridge_find: "找邻居",
			session_bridge_status: "瞅一眼",
			session_bridge_resume: "叫醒他",
			session_bridge_cancel: "喊停",
			session_bridge_archive: "送客",
			session_bridge_unarchive: "请回来",
			session_bridge_monitor_start: "盯着他",
			session_bridge_monitor_stop: "不盯了",
			session_bridge_monitor_list: "数一眼",
			session_bridge_archived: "翻名单",
			// 我们自己的串门工具（v0.15 起内建，不依赖外部插件）
			whales_visit_send: "去串门",
			whales_visit_read: "看邻居",
			whales_visit_list: "数一眼",
			whales_visit_resume: "叫醒他"
		};

		function toolQuip(name) {
			var key = String(name || "").toLowerCase();
			return TOOL_QUIPS[key] || "在干活";
		}

		/**
		 * 工具名 → 干活动作类别（PRD「状态表现力增强」§4.1）：读 / 改 / 命令。
		 * 只认明确的几类；其余（含串门、派活、上网查）返回 undefined，保持原来的心情轮换——
		 * 宁可不换帧，也不要把「在上网查」硬塞成「在看书」。
		 * 前缀只认 mcp__ 之外的原生名；MCP 工具名带服务前缀，一律不猜。
		 */
		var TOOL_CATEGORY = {
			read: "read", grep: "read", glob: "read", web_fetch: "read",
			edit: "edit", write: "edit", patch: "edit", apply_patch: "edit", notebook_edit: "edit",
			bash: "run", pwsh: "run", shell: "run"
		};

		function toolCategory(name) {
			var key = String(name || "").toLowerCase();
			return Object.prototype.hasOwnProperty.call(TOOL_CATEGORY, key) ? TOOL_CATEGORY[key] : undefined;
		}

		/**
		 * 气泡最终说什么，优先级：
		 *   名下进行中的任务（语义上的「在做什么」）
		 * → 宿主报上来的当前工具（机械上的「正在做什么」）
		 * → 俏皮话
		 * → 会话标题（仅当俏皮话被关掉）
		 */
		function pickBubbleText(input) {
			if (input.task) return String(input.task);
			if (input.tool) return toolQuip(input.tool);
			if (input.quips !== false) return quipFor(input.state, input.index || 0, input.tick || 0);
			return input.title ? String(input.title) : undefined;
		}

		/**
		 * 团队汇总条：把「谁在干什么」压成一行。
		 * 同样的话合并（三个人都在跑命令就只写一次），超出条数用 +N 收尾。
		 */
		function teamBarText(entries, limit) {
			var seen = {};
			var parts = [];
			(entries || []).forEach(function (entry) {
				var text = entry && entry.text ? String(entry.text) : "";
				if (text === "" || seen[text] === true) return;
				seen[text] = true;
				parts.push(text);
			});
			if (parts.length === 0) return undefined;
			var max = limit || 4;
			if (parts.length > max) {
				return parts.slice(0, max).join(" · ") + " +" + (parts.length - max);
			}
			return parts.join(" · ");
		}

		/**
		 * 宿主报上来的活动快照（GET /agent-whales/api/activity）。
		 *
		 * map：sessionId → 工具名，省得每次比较整棵树。
		 * visitTools / ultra / controlToken：「串门工具」「ultra 模式」两个开关的宿主真相与写接口凭证。
		 *   这几项**只从宿主来**，不落 localStorage —— 否则刷新后会和宿主不一致，
		 *   用户还会看到自己手改出来的假状态。ultra 的持久化在宿主半边（ultra.json），
		 *   所以重启后真相仍在，客户端不需要也不应该自己存。
		 * visitTools / ultra === undefined 表示「还没拿到第一次快照」，设置页据此显示未就绪。
		 */
		var toolActivity = (function () {
			var snapshot = { version: 0, map: {}, visitTools: undefined, ultra: undefined, controlToken: "", fetched: false, state: {} };
			var listeners = new Set();
			/** 宿主 state 字段：只保留认识的字段并做类型守卫，脏值当「没有这条事实」。 */
			function sanitizeState(raw) {
				var next = {};
				var ids = raw && typeof raw === "object" ? Object.keys(raw) : [];
				for (var i = 0; i < ids.length; i++) {
					var id = ids[i];
					var row = raw[id];
					if (!row || typeof row !== "object") continue;
					var item = {};
					if (typeof row.since === "number" && isFinite(row.since)) item.since = row.since;
					if (row.running === true) item.running = true;
					if (row.streaming === true) item.streaming = true;
					if (typeof row.runStartedAt === "number" && isFinite(row.runStartedAt)) item.runStartedAt = row.runStartedAt;
					if (typeof row.lastRunMs === "number" && isFinite(row.lastRunMs)) item.lastRunMs = row.lastRunMs;
					if (typeof row.lastErrorAt === "number" && isFinite(row.lastErrorAt)) {
						item.lastErrorAt = row.lastErrorAt;
						item.lastErrorKind = typeof row.lastErrorKind === "string" ? row.lastErrorKind : "unknown";
					}
					if (typeof row.lastTurnEndAt === "number" && isFinite(row.lastTurnEndAt)) item.lastTurnEndAt = row.lastTurnEndAt;
					next[id] = item;
				}
				return next;
			}
			function sanitize(active) {
				var next = {};
				var keys = active && typeof active === "object" ? Object.keys(active) : [];
				keys.forEach(function (key) {
					var tool = active[key] && active[key].tool;
					if (typeof tool === "string" && tool !== "") next[key] = tool;
				});
				return next;
			}
			function sameMap(left, right) {
				var leftKeys = Object.keys(left);
				var rightKeys = Object.keys(right);
				if (leftKeys.length !== rightKeys.length) return false;
				for (var i = 0; i < leftKeys.length; i++) {
					if (left[leftKeys[i]] !== right[leftKeys[i]]) return false;
				}
				return true;
			}
			/** 五项都没变就不换引用：useSyncExternalStore 靠这个避免抖动。 */
			function commit(next) {
				var sameState = JSON.stringify(next.state) === JSON.stringify(snapshot.state);
				if (sameMap(next.map, snapshot.map)
					&& next.visitTools === snapshot.visitTools
					&& next.ultra === snapshot.ultra
					&& next.controlToken === snapshot.controlToken
					&& next.fetched === snapshot.fetched
					&& sameState) return;
				snapshot = {
					version: snapshot.version + 1,
					map: next.map,
					visitTools: next.visitTools,
					ultra: next.ultra,
					controlToken: next.controlToken,
					fetched: next.fetched,
					state: next.state
				};
				listeners.forEach(function (listener) { listener(); });
			}
			return {
				getSnapshot: function () { return snapshot; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				/** 旧路径：只更新工具表（离线测试与老宿主兼容用）。 @param {Record<string, {tool?: string}>} active */
				replace: function (active) {
					commit({
						map: sanitize(active),
						visitTools: snapshot.visitTools,
						ultra: snapshot.ultra,
						controlToken: snapshot.controlToken,
						fetched: snapshot.fetched,
						state: snapshot.state
					});
				},
				/** 整份响应落地：工具表 + 开关真相 + 写接口 token + 运行时状态。 @param {{active?: object, visitTools?: boolean, controlToken?: string, state?: object}} payload */
				apply: function (payload) {
					var data = payload && typeof payload === "object" ? payload : {};
					commit({
						map: sanitize(data.active),
						// 宿主没给就沿用上一次：老版本宿主没有这几个字段时，开关停在「未就绪」而不是乱跳。
						visitTools: typeof data.visitTools === "boolean" ? data.visitTools : snapshot.visitTools,
						ultra: typeof data.ultra === "boolean" ? data.ultra : snapshot.ultra,
						controlToken: typeof data.controlToken === "string" ? data.controlToken : snapshot.controlToken,
						// 旧宿主没有 state：给空对象，客户端自然降级成「只会 work / idle」。
						state: sanitizeState(data.state),
						// 这次响应成功了：用来区分「还没读到」和「宿主根本没这个能力」。
						fetched: true
					});
				},
				/** POST 204 之后调用：宿主真相已经等于刚写下去的值，不必等下一次轮询。 */
				confirmVisitTools: function (value) {
					commit({
						map: snapshot.map,
						visitTools: value === true,
						ultra: snapshot.ultra,
						controlToken: snapshot.controlToken,
						fetched: snapshot.fetched,
						state: snapshot.state
					});
				},
				/** ultra 模式 POST 204 之后：同上，只翻 ultra 一位，不动其它字段。 */
				confirmUltra: function (value) {
					commit({
						map: snapshot.map,
						visitTools: snapshot.visitTools,
						ultra: value === true,
						controlToken: snapshot.controlToken,
						fetched: snapshot.fetched,
						state: snapshot.state
					});
				}
			};
		})();

		/**
		 * 活动快照轮询器（模块级、引用计数）。
		 *
		 * 为什么不是每个组件各起一个：顶端图层（WhaleLayer）和设置页（WhaleSettingsSection）
		 * 都要读这份快照，各起一条就是双倍请求；引用计数保证同一时刻只有一条轮询链。
		 *
		 * 为什么「串门工具」关掉之后仍然要保持轮询：这个开关的真相（visitTools）就在
		 * activity 响应里，停了轮询，设置页就永远读不到宿主状态，开关也没法显示、没法回滚。
		 * 省资源的部分由宿主负责（关掉后 4 个工具定义不再进模型请求），客户端这边只是
		 * 一个 2 秒一次、失败会退避的只读快照请求。**别把它"优化"成停轮询。**
		 */
		function createActivityPoll() {
			var refs = 0;
			var run = null;
			/** 一轮真实轮询：state 由这次运行独占，停止后旧 promise 链写不进新一轮。 */
			function startRun() {
				var fetchImpl = resolveFetch();
				if (typeof fetchImpl !== "function") return;
				var state = {
					stopped: false,
					timer: null,
					inFlight: false,
					delay: POLL_INTERVAL,
					controller: typeof AbortController === "function" ? new AbortController() : null
				};
				run = state;
				function schedule(ms) {
					if (state.stopped) return;
					state.timer = setTimeout(poll, ms);
				}
				function poll() {
					state.timer = null;
					if (state.stopped) return;
					if (typeof document !== "undefined" && document.hidden === true) {
						schedule(POLL_INTERVAL);
						return;
					}
					if (state.inFlight) {
						schedule(state.delay);
						return;
					}
					state.inFlight = true;
					var ok = false;
					var options = { headers: { accept: "application/json" }, cache: "no-store" };
					if (state.controller) options.signal = state.controller.signal;
					try {
						fetchImpl("/agent-whales/api/activity", options)
							.then(function (response) {
								return response && response.ok ? response.json() : null;
							})
							.then(function (data) {
								ok = Boolean(data);
								if (!state.stopped && data) {
									toolActivity.apply(data);
									// activity 能通 = 插件的 /agent-whales/api/* 路由已经注册好了。
									// 如果素材之前因为「宿主还没就绪」失败过，这里补一轮（一次性，不发额外请求）。
									artLoader.notifyHostAlive();
								}
							})
							.catch(function () { /* 宿主没挂路由就算了，退避后再试 */ })
							.then(function () {
								state.inFlight = false;
								if (state.stopped) return;
								state.delay = ok ? POLL_INTERVAL : Math.min(POLL_MAX_INTERVAL, state.delay * 2);
								schedule(state.delay);
							});
					} catch (error) {
						/* file:// 或非 http 环境下 fetch 可能同步抛 */
						state.inFlight = false;
						state.delay = Math.min(POLL_MAX_INTERVAL, state.delay * 2);
						schedule(state.delay);
					}
				}
				// 从后台切回来时立刻补一次，不用等退避窗口走完。
				function wake() {
					if (state.stopped || typeof document === "undefined" || document.hidden === true) return;
					if (state.timer !== null) clearTimeout(state.timer);
					state.timer = null;
					state.delay = POLL_INTERVAL;
					poll();
				}
				if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
					document.addEventListener("visibilitychange", wake);
				}
				state.wake = wake;
				poll();
			}
			function stopRun() {
				var state = run;
				run = null;
				if (!state) return;
				state.stopped = true;
				if (state.timer !== null) clearTimeout(state.timer);
				state.timer = null;
				if (state.controller) {
					try { state.controller.abort(); } catch (error) { /* 有些环境不支持 signal */ }
				}
				state.controller = null;
				if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
					document.removeEventListener("visibilitychange", state.wake);
				}
			}
			return {
				start: function () {
					refs += 1;
					if (refs > 1) return;
					if (typeof resolveFetch() !== "function") return; // 环境没有 fetch：不轮询，开关保持未就绪
					startRun();
				},
				stop: function () {
					if (refs === 0) return;
					refs -= 1;
					if (refs === 0) stopRun();
				}
			};
		}

		var activityPoll = createActivityPoll();

		/**
		 * 写「串门工具」开关。
		 *
		 * 契约（宿主半边 lib/index.js 提供）：
		 *   POST /agent-whales/api/visit-tools
		 *   content-type: application/json   x-whales-token: 最近一次 GET 拿到的 controlToken
		 *   body: {"enabled": true|false}     成功 204；403 / 400 / 500 视为失败
		 * @param {boolean} value
		 * @returns {Promise<void>} 失败时 reject —— 调用方负责把 UI 回滚，不要留着乐观态
		 */
		function postVisitTools(value) {
			var fetchImpl = resolveFetch();
			if (typeof fetchImpl !== "function") return Promise.reject(new Error("fetch unavailable"));
			var token = toolActivity.getSnapshot().controlToken;
			var request;
			try {
				request = fetchImpl("/agent-whales/api/visit-tools", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						// token 每次 GET 都会刷新；用最近一次快照里的值，过期了宿主会 403。
						"x-whales-token": String(token || "")
					},
					body: JSON.stringify({ enabled: value === true })
				});
			} catch (error) {
				return Promise.reject(error);
			}
			return Promise.resolve(request).then(function (response) {
				if (response && response.ok) return undefined;
				var error = new Error("visit-tools write rejected: " + (response ? response.status : "no response"));
				error.status = response ? response.status : 0;
				throw error;
			});
		}

		/**
		 * 写「ultra 模式」开关（强制加载 deep-effort 执行契约）。
		 *
		 * 契约与串门工具开关同构（宿主半边 lib/index.js）：
		 *   POST /agent-whales/api/ultra
		 *   content-type: application/json   x-whales-token: 最近一次 GET 拿到的 controlToken
		 *   body: {"enabled": true|false}     成功 204；403 / 400 / 500 视为失败
		 * 宿主会把状态落盘（ultra.json），所以刷新/重启后真相不变——客户端不自己存。
		 * @param {boolean} value
		 * @returns {Promise<void>} 失败时 reject —— 调用方负责把 UI 回滚，不要留着乐观态
		 */
		function postUltra(value) {
			var fetchImpl = resolveFetch();
			if (typeof fetchImpl !== "function") return Promise.reject(new Error("fetch unavailable"));
			var token = toolActivity.getSnapshot().controlToken;
			var request;
			try {
				request = fetchImpl("/agent-whales/api/ultra", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						// token 每次 GET 都会刷新；用最近一次快照里的值，过期了宿主会 403。
						"x-whales-token": String(token || "")
					},
					body: JSON.stringify({ enabled: value === true })
				});
			} catch (error) {
				return Promise.reject(error);
			}
			return Promise.resolve(request).then(function (response) {
				if (response && response.ok) return undefined;
				var error = new Error("ultra write rejected: " + (response ? response.status : "no response"));
				error.status = response ? response.status : 0;
				throw error;
			});
		}

		/**
		 * 折叠结果的引用缓存：签名（= 鲸鱼集合内容）不变时复用同一对象。
		 *
		 * useSyncExternalStore 要求 getSnapshot 在数据未变时返回同一引用，否则会无限重渲染；
		 * 而 useSessions 的选择器每次渲染都会重新调用，所以缓存必须挂在组件实例上（useRef），
		 * 输入（状态表 / 设置）由 inputsRef 提供，随渲染更新。
		 */
		function createPodSelector(inputsRef, leadIdOf) {
			var memory = { signature: null, value: null };
			return function (state) {
				var inputs = inputsRef.current;
				var next = buildPod(state, inputs.status, inputs.settings, leadIdOf);
				if (memory.value !== null && memory.signature === next.signature) return memory.value;
				memory.signature = next.signature;
				memory.value = next;
				return next;
			};
		}

		// ── 精灵图选帧 ─────────────────────────────────────────────────────────
		/** mix 模式下 Lead 走成熟版、成员走 Q 版；其余模式全体统一。 */
		function familyOf(skin, isLead) {
			if (skin === "classic") return "classic";
			if (skin === "q") return "q";
			if (skin === "mature") return "mature";
			return isLead ? "mature" : "q";
		}

		var Q_FRAMES = { base: "q-smile", blink: "q-blink", entry: "q-wave", exit: "q-proud", sleepy: "q-sleepy", think: "q-think", oops: "q-oops", celebrate: "q-cry", teamDone: "q-heart", read: "q-read", type: "q-type", run: "q-run" };
		/**
		 * 工具动作帧（读 / 改 / 命令）：q-read / q-type / q-run 已于 2026-11-18 入库并并入上面的 Q_FRAMES，
		 * 所以这张「待入库」表现在是空的。保留它是为了下一批还没入库的帧有地方登记：
		 * test/client-robustness 的交叉验证要求 Q_FRAMES 里每个 key 都在素材库里（防止拼错帧名后静默退回基础帧），
		 * 还没入库的帧不能放进 Q_FRAMES，只能先放这里；frameOf 只在素材真的加载了才采用。
		 * 入库后必须并入 Q_FRAMES 并删掉这里的条目（反向护栏测试盯着，入库了没认领会红）。
		 */
		var Q_PENDING_FRAMES = {};
		/** 成熟版：素材库里 C11/C13/C16/C18/C20/C83 是同一批头肩近景，可以做同样的逐帧。工具帧不做（头肩近景表现不了打字），缺省就走原逻辑。 */
		var M_FRAMES = { base: "m-base", blink: "m-blink", entry: "m-wave", exit: "m-proud", sleepy: "m-base", think: "m-think", oops: "m-oops", celebrate: "m-proud", teamDone: "m-proud" };
		/** 经典皮肤（像素小人）：没有心情轮换，但有思考 / 出错 / 完成三态；「改」复用抱键盘的 c-work。 */
		var C_FRAMES = { base: "c-idle", work: "c-work", think: "c-think", oops: "c-oops", celebrate: "c-done" };

		/**
		 * 心情帧池：每 3 个 tick（约 24 秒）换一次表情，让角色看起来是活的。
		 * 只用**全身构图**的那几张——C78 那种大头特写混进来会像换了个人。
		 * 2026-10-30 补入 q-shy / m-shy（连片红晕，96px 下与微笑可区分）。
		 */
		var Q_MOOD_RUNNING = ["q-smile", "q-laugh", "q-pout", "q-surprise", "q-shy"];
		var Q_MOOD_IDLE = ["q-sleepy"];

		var M_MOOD_RUNNING = ["m-base", "m-laugh", "m-pout", "m-surprise", "m-shy"];
		var M_MOOD_IDLE = ["m-base"];

		/**
		 * @param {"q"|"mature"|"classic"} family
		 * @param {string} phase running | provisioning | idle
		 * @param {number} tick
		 */
		function pickMoodKey(family, phase, tick) {
			var working = phase !== "idle" && phase !== "provisioning";
			var pool;
			if (family === "mature") pool = working ? M_MOOD_RUNNING : M_MOOD_IDLE;
			else pool = working ? Q_MOOD_RUNNING : Q_MOOD_IDLE;
			var key = pool[Math.floor((tick || 0) / 3) % pool.length];
			return ART[key] ? key : undefined;
		}

		// ── 状态表情：把宿主上报的运行时事实翻成「这张脸该是什么」 ────────────────
		// 宿主只负责报事实（在跑 / 正在输出 / 最近失败 / 最近回合结束 + 这轮跑了多久），
		// 帧的选择与时长全在这里——表现层要跟心情轮换、眨眼、入场退场、设置联动。
		var FACE_ERROR_MS = 8000;
		var FACE_CELEBRATE_MS = 6000;
		var FACE_MIN_RUN_MS = 5000;

		/**
		 * 「等你」判定（PRD 增量 §4.2，波次 B）。信号来自宿主 uiSession.sessionStatus 行上的
		 * pendingInteraction.kind（官方侧栏的「等待审批 / 等待回答 / 待审计划」徽标读的是同一个字段，
		 * 来源核实见 docs/wave0-signals.md）。只认官方侧栏认的三种 kind；别的值（未来新增 / 脏数据）
		 * 一律不举旗——宁可漏报，不要让一只鲸鱼莫名其妙地一直挥手。
		 */
		var WAITING_KINDS = { approval: true, question: true, "plan-review": true };
		function isWaiting(pending) {
			return !!pending && typeof pending === "object" && WAITING_KINDS[pending.kind] === true;
		}

		/** 从 uiSession 状态表（Map: id → { running, pendingInteraction, ... }）取某会话的待处理交互；表缺失 / 形状不对一律 undefined。 */
		function pendingOf(statusRows, key) {
			if (!statusRows || typeof statusRows.get !== "function") return undefined;
			var row = statusRows.get(key);
			return row && typeof row === "object" ? row.pendingInteraction : undefined;
		}

		/**
		 * 上下文余量百分比（0–100，满 = 100），口径逐字对齐官方对话页 ContextMeter 的 contextOccupancy
		 * （dsh-client-ui-conversation：分子 = projectedTokens ?? pressureTokens，分母 = contextWindow，
		 * 占用封顶 100）——同一会话在官方页和鲸鱼头顶不能说两个数。缺分子或分母一律 undefined：
		 * 不显示 0%、也不拿估计值凑（provider 还没上报用量 / 路由没声明窗口都属于此类）。
		 */
		function contextLeft(projections, key) {
			var pressure = projections && projections[key] && projections[key].values ? projections[key].values.contextPressure : undefined;
			if (!pressure || typeof pressure !== "object") return undefined;
			var used = pressure.projectedTokens != null ? pressure.projectedTokens : pressure.pressureTokens;
			var win = pressure.contextWindow;
			if (typeof used !== "number" || typeof win !== "number" || !isFinite(used) || !isFinite(win) || used < 0 || win <= 0) return undefined;
			return 100 - Math.min(100, Math.round(used / win * 100));
		}

		/**
		 * @param {object} row 宿主 state[sessionId]
		 * @param {number} now
		 * @param {object} settings 至少含 { stateFaces, errorFaces }；toolFaces / waitFaces 可选（缺省视为开）
		 * @param {string} [tool] 宿主 active 表里这个会话当前在跑的工具名
		 * @param {object} [pending] 客户端 uiSession.sessionStatus 行的 pendingInteraction（有则在等人）
		 * @returns {"failed"|"waiting"|"celebrating"|"thinking"|"reading"|"editing"|"running"|"working"|"idle"}
		 */
		function faceOf(row, now, settings, tool, pending) {
			var opts = settings || DEFAULTS;
			var item = row && typeof row === "object" ? row : {};
			var running = item.running === true;
			if (opts.stateFaces === false) return running ? "working" : "idle";
			if (opts.errorFaces !== false
				&& typeof item.lastErrorAt === "number"
				&& now - item.lastErrorAt >= 0
				&& now - item.lastErrorAt < FACE_ERROR_MS) {
				return "failed";
			}
			// 等你：优先级仅次于失败、高于一切「在干活」的表现——用户此刻能做的唯一有用的事就是回应它。
			if (opts.waitFaces !== false && isWaiting(pending)) return "waiting";
			if (typeof item.lastTurnEndAt === "number"
				&& now - item.lastTurnEndAt >= 0
				&& now - item.lastTurnEndAt < FACE_CELEBRATE_MS
				&& (typeof item.lastRunMs !== "number" || item.lastRunMs >= FACE_MIN_RUN_MS)) {
				return "celebrating";
			}
			// 「思考」只在模型真的在输出时出现（用户拍板：宁可短，不要一直托腮）。
			if (item.streaming === true) return "thinking";
			// 工具动画：只在「会话确实在跑」且工具归得进读/改/命令时出现；关了就退回原来的 working。
			if (running && opts.toolFaces !== false) {
				var category = toolCategory(tool);
				if (category === "read") return "reading";
				if (category === "edit") return "editing";
				if (category === "run") return "running";
			}
			return running ? "working" : "idle";
		}

		/**
		 * 注意：工具面孔**不需要**最小驻留去抖。活动快照由客户端 2 秒轮询一次（POLL_INTERVAL），
		 * 面孔最快 2 秒才会变一次，「高频工具让帧疯狂跳变」在这条数据通路下物理上不会发生。
		 * 反过来的限制才是真的：短于一个轮询周期的工具调用，客户端根本看不到——动画只对持续较久的工具出现。
		 */

		/** 状态 → 帧变体名；工作/空闲沿用原有逻辑，返回 undefined。 */
		function faceVariant(face) {
			if (face === "failed") return "oops";
			if (face === "thinking") return "think";
			if (face === "celebrating") return "celebrate";
			if (face === "teamDone") return "teamDone";
			// 等你：复用入场挥手帧（PRD 决策：不新做 q-wait）。区别于入场的一次性挥手——
			// 这里不叠入场/眨眼帧、而是整只常驻循环摆动（见 .daw-whale[data-face=waiting]）。
			if (face === "waiting") return "entry";
			if (face === "reading") return "read";
			if (face === "editing") return "type";
			if (face === "running") return "run";
			return undefined;
		}

		/**
		 * 工具动作变体：这些帧是「新增素材」，缺帧时**不能**回退到 base——
		 * 渲染处只要 faceKey 有值就会压掉心情轮换 / 眨眼 / 入场帧，回退成 base 会把整只角色冻成静态微笑，
		 * 比「没有这个功能」更糟。所以缺帧一律返回 undefined，调用方按没有工具动画处理。
		 */
		var TOOL_VARIANTS = { read: true, type: true, run: true };

		/**
		 * 取某个状态该用哪张图。
		 * @param {string} skin  mix | q | mature | classic
		 * @param {boolean} isLead
		 * @param {string} variant base | blink | entry | exit | sleepy | read | type | run
		 * @returns {string|undefined} ART 的 key；undefined 表示该皮肤没有位图（走矢量）
		 */
		function frameOf(skin, isLead, variant) {
			var family = familyOf(skin, isLead);
			if (family === "classic") return undefined;
			var frames = family === "mature" ? M_FRAMES : Q_FRAMES;
			var key = frames[variant] || frames.base;
			if (TOOL_VARIANTS[variant] === true) {
				// 只有 Q 版有工具帧：成熟版（头肩近景）表现不了打字，经典皮肤已在上面提前返回。
				// 素材入库前在 Q_PENDING_FRAMES，入库后并入 Q_FRAMES——两处都认，且必须真的已加载才采用。
				if (family === "mature") return undefined;
				var toolKey = Q_FRAMES[variant] || Q_PENDING_FRAMES[variant];
				return toolKey && ART[toolKey] ? toolKey : undefined;
			}
			if (ART[key]) return key;
			return ART[frames.base] ? frames.base : undefined;
		}

		/** 素材可用性：只要当前皮肤该有的主帧存在，就能用位图。 */
		function artOf(key) {
			return key && ART[key] ? ART[key] : undefined;
		}

		// ── 渲染 ───────────────────────────────────────────────────────────────
		function fallbackUseStore(selector) {
			return react.useSyncExternalStore(
				EMPTY_STORE.subscribe,
				function () { return selector(EMPTY_STATE); },
				function () { return selector(EMPTY_STATE); }
			);
		}

		function hookOf(maybeHook) {
			return typeof maybeHook === "function" ? maybeHook : fallbackUseStore;
		}

		function gradDef(id, pair) {
			return h("linearGradient", { key: id, id: id, x1: "0", y1: "0", x2: "0", y2: "1" },
				h("stop", { offset: "0", stopColor: pair[0] }),
				h("stop", { offset: "1", stopColor: pair[1] })
			);
		}

		function whaleDefs() {
			return h("svg", { className: "daw-defs", "aria-hidden": "true", focusable: "false" },
				h("defs", null,
					PALETTE.map(function (pair, index) { return gradDef("daw-g" + index, pair); }),
					gradDef("daw-g-lead", LEAD_COLOR)
				)
			);
		}

		/** 经典皮肤：早期手绘矢量鲸鱼（身体 + 尾鳍 + 眼睛 + 微笑 + 喷水，Lead 多顶小皇冠）。 */
		function ClassicWhale(props) {
			var whale = props.whale;
			var index = props.index;
			var fill = whale.lead ? "url(#daw-g-lead)" : "url(#daw-g" + (index % PALETTE.length) + ")";
			var tailColor = whale.lead ? "#2B44D8" : PALETTE[index % PALETTE.length][1];
			var dropDelay = function (step) { return { animationDelay: (step).toFixed(2) + "s" }; };
			return h("svg", { className: "daw-art", viewBox: "0 -16 134 100", "aria-hidden": "true", focusable: "false" },
				h("g", { className: "daw-spout", fill: "#CFE6FF", opacity: "0.95" },
					h("ellipse", { className: "daw-drop", cx: "86", cy: "0", rx: "4", ry: "5.6", style: dropDelay(0) }),
					h("ellipse", { className: "daw-drop", cx: "97", cy: "-6", rx: "4.4", ry: "6.2", style: dropDelay(0.28) }),
					h("ellipse", { className: "daw-drop", cx: "108", cy: "0", rx: "4", ry: "5.6", style: dropDelay(0.56) })
				),
				h("g", { className: "daw-tail", fill: tailColor },
					h("path", { d: "M48 30 C36 22 24 11 20 0 C34 8 44 17 52 24 Z" }),
					h("path", { d: "M48 42 C38 48 28 58 26 70 C40 64 50 56 56 48 Z" })
				),
				h("path", {
					d: "M46 26 C58 10 84 4 104 12 C122 19 131 32 126 46 C121 61 100 70 78 68 C58 66 45 56 41 44 C38 36 41 30 46 26 Z",
					fill: fill
				}),
				h("path", { d: "M70 58 C74 71 84 77 95 74 C88 70 80 64 74 56 Z", fill: tailColor }),
				h("ellipse", { cx: "84", cy: "60", rx: "34", ry: "13", fill: "#FFFFFF", opacity: "0.16" }),
				whale.lead
					? h("path", { d: "M92 6 L95 -1 L99 5 L103 -1 L106 6 Z", fill: "#FFC53D" })
					: null,
				h("circle", { cx: "108", cy: "30", r: "4.1", fill: "#0B1B3A" }),
				h("circle", { cx: "109.4", cy: "28.6", r: "1.5", fill: "#FFFFFF", opacity: "0.9" }),
				h("path", { d: "M98 44 C103 49 112 49 117 43", fill: "none", stroke: "#0B1B3A", strokeWidth: "2.6", strokeLinecap: "round" })
			);
		}

		function spriteImg(props) {
			var artKey = props.artKey;
			return h("img", {
				className: "daw-sprite" + (props.extra ? " " + props.extra : ""),
				src: props.art.uri,
				width: props.art.w,
				height: props.art.h,
				alt: "",
				draggable: "false",
				decoding: "async",
				// 网络图比内联 data: 更容易 onError：单帧失败只摘掉这一帧（frameOf 退回 base），
				// 运行时路由下只摘掉这一帧（不设全局 broken）；旧的内联构建才 markBroken。
				onError: function () {
					if (artKey) artLoader.rejectKey(artKey);
					else artStatus.markBroken();
				},
				style: props.style
			});
		}

		function bubbles(count, seed, speedFactor) {
			var items = [];
			for (var i = 0; i < count; i++) {
				var bx = 18 + ((seed * 37 + i * 53) % 64);
				var size = 3 + ((seed + i * 3) % 4);
				items.push(h("i", {
					key: i,
					style: {
						"--bx": bx + "%",
						"--bs": size + "px",
						"--daw-bub-delay": (((seed * 13 + i * 47) % 100) / 100 * 3).toFixed(2) + "s",
						"--daw-bub-dur": ((2.8 + ((seed + i * 7) % 14) / 10) / speedFactor).toFixed(2) + "s"
					}
				}));
			}
			return h("span", { className: "daw-bubbles", "aria-hidden": "true" }, items);
		}

		/**
		 * 一只鲸鱼娘。位图皮肤下由 base / entry / blink 三层图叠出来：
		 * 入场时先亮「挥手」帧再淡出，之后靠 CSS 交叉淡变做眨眼，全程不需要 JS 计时器。
		 */
		function Whale(props) {
			var whale = props.whale;
			var index = props.index;
			var skin = props.skin || DEFAULTS.skin;
			var speed = props.speed || 100;
			var motion = props.motion || DEFAULTS.motion;
			var size = props.size || BASE_HEIGHT;
			var phase = whale.phase;
			var leaving = props.leaving === true;
			var classic = props.classic === true;

			var delay = (index % 5) * 0.26;
			var speedFactor = Math.max(0.25, (props.speed || 100) / 100);
			var duration = (3.4 / speedFactor).toFixed(2) + "s";
			var amp = motion === "lively" ? "-6px" : motion === "soft" ? "-2px" : "-4px";
			var bubbleCount = motion === "lively" ? 6 : motion === "soft" ? 2 : 4;

			// 状态帧（思考 / 出错 / 收工庆祝）优先：它压过心情轮换，否则思考态会被心情帧吃掉。
			var face = props.face;
			var faceKey = faceVariant(face) ? frameOf(skin, whale.lead, faceVariant(face)) : undefined;
			var faceArt = !leaving && faceKey ? artOf(faceKey) : undefined;

			// 心情帧优先；没有就退回原来的 base/sleepy，出退场仍然走专门的帧。
			var moodKey = faceArt ? undefined : (props.moodKey && artOf(props.moodKey) ? props.moodKey : undefined);
			var baseKey = leaving
				? frameOf(skin, whale.lead, "exit")
				: (faceArt
					? faceKey
					: (moodKey || (phase === "provisioning" ? frameOf(skin, whale.lead, "sleepy") : frameOf(skin, whale.lead, "base"))));
			var baseArt = artOf(baseKey);
			var entryKey = frameOf(skin, whale.lead, "entry");
			// 状态帧在场时不要再叠入场/眨眼帧：那会让「在哭」「出错」被挥手帧盖掉。
			var entryArt = !leaving && !faceArt && entryKey && entryKey !== baseKey ? artOf(entryKey) : undefined;
			var blinkKey = frameOf(skin, whale.lead, "blink");
			var blinkArt = !leaving && !faceArt && phase !== "provisioning" && blinkKey && blinkKey !== baseKey ? artOf(blinkKey) : undefined;

			// 经典皮肤：Martty 的像素小人。没有心情轮换，但有思考 / 出错 / 完成三态。
			// 图片被安全策略拦掉时（classicVector）仍然退回手绘矢量鲸鱼，保证还有东西可看。
			var classicKey = face === "failed"
				? C_FRAMES.oops
				: face === "waiting"
					? C_FRAMES.work
					: face === "thinking"
					? C_FRAMES.think
					: face === "celebrating"
						? C_FRAMES.celebrate
						: (phase === "idle" ? C_FRAMES.base : C_FRAMES.work);
			var classicArt = classic && props.classicVector !== true ? artOf(classicKey) : undefined;

			var body;
			if (classicArt) {
				body = h("div", { className: "daw-stage", style: { height: size + "px" } },
					spriteImg({ art: classicArt, artKey: classicKey }),
					h("i", { className: "daw-halo", "aria-hidden": "true" }),
					props.particles ? bubbles(bubbleCount, index, speedFactor) : null
				);
			} else if (classic || !baseArt) {
				body = h("div", { className: "daw-stage", style: { height: size + "px", width: Math.round(size * 1.34) + "px" } },
					h(ClassicWhale, { whale: whale, index: index })
				);
			} else {
				body = h("div", { className: "daw-stage", style: { height: size + "px" } },
					spriteImg({ art: baseArt, artKey: baseKey }),
					entryArt ? spriteImg({ art: entryArt, artKey: entryKey, extra: "daw-frame daw-frame-entry" }) : null,
					blinkArt
						? spriteImg({
							art: blinkArt,
							artKey: blinkKey,
							extra: "daw-frame daw-frame-blink",
							style: {
								"--daw-blink-delay": (1.1 + (index % 4) * 0.9).toFixed(2) + "s",
								"--daw-blink-dur": ((5.6 + (index % 3) * 1.4) / speedFactor).toFixed(2) + "s"
							}
						})
						: null,
					h("i", { className: "daw-halo", "aria-hidden": "true" }),
					props.particles ? bubbles(bubbleCount, index, speedFactor) : null
				);
			}

			var depth = props.depth || 0;
			var activity = props.activity;
			var tasks = props.tasks || [];
			var childCount = props.childCount || 0;
			var expandedNow = props.expanded === true;

			var bubble = activity && props.showBubble !== false
				? h("span", { className: "daw-bubble", title: activity }, String(activity))
				: null;

			var taskList = props.showTasks !== false && tasks.length > 0
				? h("span", { className: "daw-tasks" },
					tasks.slice(0, 2).map(function (task, taskIndex) {
						return h("span", {
							key: String(task.id || taskIndex),
							className: "daw-task",
							"data-status": String(task.status || "pending"),
							title: String(task.subject || "")
						},
							h("b", null),
							h("span", null, String(task.subject || ""))
						);
					})
				)
				: null;

			var toggle = props.canExpand === true
				? h("button", {
					className: "daw-expand",
					type: "button",
					title: expandedNow ? props.collapseTitle : props.expandTitle,
					"aria-label": expandedNow ? props.collapseTitle : props.expandTitle,
					"aria-expanded": expandedNow,
					onClick: function (event) {
						if (event && typeof event.stopPropagation === "function") event.stopPropagation();
						expanded.toggle(whale.key);
					}
				}, expandedNow ? "−" : "+" + childCount)
				: null;

			var dragRef = react.useRef(null);
			var dragMovedRef = react.useRef(false);
			var clickTimerRef = react.useRef(null);
			var unitRef = react.useRef(null);

			// 单击跳会话有一个 230ms 的延迟计时器（留给双击复位）。组件卸载时必须清掉，
			// 否则卸载之后还会调一次 onFocus，把用户切到一只已经不在的鲸鱼上。
			react.useEffect(function () {
				return function () {
					if (clickTimerRef.current !== null) {
						clearTimeout(clickTimerRef.current);
						clickTimerRef.current = null;
					}
					dragRef.current = null;
				};
			}, []);

			/** 收尾：清掉拖拽标记与临时 transform（up / cancel / 失焦 / 按钮已松开都走这里）。 */
			function endDrag(unit) {
				var node = unit || (unitRef.current);
				dragRef.current = null;
				if (node && node.removeAttribute) {
					node.removeAttribute("data-dragging");
					node.style.transform = "";
				}
			}

			function onPointerDown(event) {
				// 每次按下都清掉「刚拖过」的标记；否则拖完那一下的 click 会误触发跳转。
				dragMovedRef.current = false;
				if (props.draggable !== true || leaving) return;
				if (event.button !== undefined && event.button !== 0) return;
				// 多点触控：只认第一根手指，否则第二根按下会覆盖起点，拖动时角色会跳。
				if (event.isPrimary === false) return;
				if (dragRef.current !== null) return;
				var unit = event.currentTarget;
				var pod = unit && unit.closest ? unit.closest(".daw-pod") : null;
				if (!pod || typeof unit.getBoundingClientRect !== "function") return;
				var podRect = pod.getBoundingClientRect();
				var rect = unit.getBoundingClientRect();
				dragRef.current = {
					pointerId: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					baseX: rect.left - podRect.left,
					baseY: rect.top - podRect.top,
					moved: false
				};
				if (typeof unit.setPointerCapture === "function" && event.pointerId !== undefined) {
					try { unit.setPointerCapture(event.pointerId); } catch (error) { /* 某些环境不支持 */ }
				}
			}

			function onPointerMove(event) {
				var drag = dragRef.current;
				if (!drag) return;
				if (drag.pointerId !== undefined && event.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
				// 指针在角色外面松开时（没拿到 pointerup，或指针捕获被浏览器丢掉）会留下
				// 「粘住」的状态：之后鼠标只是从角色上划过也会把它拖走。buttons 为 0 就是这种情况。
				if (event.buttons === 0) {
					endDrag(event.currentTarget);
					return;
				}
				var dx = event.clientX - drag.startX;
				var dy = event.clientY - drag.startY;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
				drag.moved = true;
				var unit = event.currentTarget;
				if (unit && unit.setAttribute) {
					unit.setAttribute("data-dragging", "true");
					unit.style.transform = "translate(" + Math.round(dx) + "px," + Math.round(dy) + "px)";
				}
			}

			/**
			 * pointercancel（滚动、切窗口、手势被判成别的手势）不能当拖拽结果提交：
			 * 这类事件的 clientX/clientY 通常是 0，提交下去就是「把鱼瞬移到左上角」。
			 */
			function onPointerCancel(event) {
				var drag = dragRef.current;
				// 真的拖动过才吞掉随后那一下 click；只是按了一下就取消，仍算点击。
				if (drag && drag.moved) dragMovedRef.current = true;
				endDrag(event && event.currentTarget);
			}

			function onPointerUp(event) {
				var drag = dragRef.current;
				if (!drag) return;
				if (drag.pointerId !== undefined && event.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
				endDrag(event.currentTarget);
				if (!drag.moved) return;
				dragMovedRef.current = true;
				// (0,0) 几乎必然是取消/合成事件的占位坐标，落盘只会把角色甩到左上角。
				if (event.clientX === 0 && event.clientY === 0) return;
				var dx = event.clientX - drag.startX;
				var dy = event.clientY - drag.startY;
				if (typeof props.onMove === "function") {
					props.onMove(whale.key, { x: drag.baseX + dx, y: drag.baseY + dy });
				}
			}

			/**
			 * 单击：有下级就展开/收起（「点大的，把小的放出来」），
			 * 叶子节点才跳会话。双击仍然是复位位置。
			 */
			function onClick() {
				if (dragMovedRef.current) return;
				if (props.canExpand === true || props.expanded === true) {
					expanded.toggle(whale.key);
					return;
				}
				if (typeof props.onFocus !== "function") return;
				if (clickTimerRef.current !== null) return;
				clickTimerRef.current = setTimeout(function () {
					clickTimerRef.current = null;
					props.onFocus(whale.key);
				}, 230);
			}

			function onDoubleClick() {
				if (clickTimerRef.current !== null) {
					clearTimeout(clickTimerRef.current);
					clickTimerRef.current = null;
				}
				if (props.draggable === true && typeof props.onReset === "function") props.onReset(whale.key);
			}

			/**
			 * 键盘等价物：回车 / 空格 = 单击。
			 * 只给「没有展开按钮」的叶子角色挂（有展开按钮时，键盘焦点落在那个按钮上，
			 * 免得出现「按钮里套按钮」这种更糟的可访问性结构）。
			 */
			var leafActionable = typeof props.onFocus === "function"
				&& props.canExpand !== true
				&& leaving !== true;
			function onKeyDown(event) {
				if (!event) return;
				if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
				if (typeof event.preventDefault === "function") event.preventDefault();
				if (typeof props.onFocus === "function") props.onFocus(whale.key);
			}

			// 列宽跟着实际尺寸走：气泡/标签都被它限制，保证「气泡不超过自己这一列」，
			// 相邻列之间还留着 6px 间隙，所以永远不会互相压。
			var colWidth = Math.max(96, Math.round(size * 0.98));
			var unitStyle = Object.assign(
				{ "--daw-col": colWidth + "px" },
				props.offset ? { position: "absolute", left: props.offset.x + "px", top: props.offset.y + "px" } : null
			);

			return h("div", {
				className: "daw-unit",
				ref: unitRef,
				style: unitStyle,
				"data-depth": String(depth),
				"data-agent": whale.label,
				// 等你：气泡是 .daw-unit 的子元素（与 .daw-whale 是兄弟），强调色要挂在 unit 上才选得到。
				"data-waiting": face === "waiting" ? "1" : undefined,
				"data-drag": props.draggable === true ? "1" : "0",
				"data-clickable": typeof props.onFocus === "function" ? "1" : "0",
				title: typeof props.onFocus === "function" ? props.focusTitle : undefined,
				role: leafActionable ? "button" : undefined,
				tabIndex: leafActionable ? 0 : undefined,
				"aria-label": leafActionable ? String(activity ? activity : whale.label) : undefined,
				onKeyDown: leafActionable ? onKeyDown : undefined,
				onClick: onClick,
				onPointerDown: props.draggable === true ? onPointerDown : undefined,
				onPointerMove: props.draggable === true ? onPointerMove : undefined,
				onPointerUp: props.draggable === true ? onPointerUp : undefined,
				onPointerCancel: props.draggable === true ? onPointerCancel : undefined,
				// 指针捕获被浏览器丢掉（切窗口、触控被判成系统手势）时也要收尾，
				// 否则会留下「粘住」的拖拽状态。
				onLostPointerCapture: props.draggable === true
					? function (event) { if (dragRef.current !== null) endDrag(event && event.currentTarget); }
					: undefined,
				onDoubleClick: props.draggable === true ? onDoubleClick : undefined
			},
				bubble,
				depth > 0 ? h("i", { className: "daw-bind", "aria-hidden": "true" }) : null,
				h("div", {
					className: "daw-whale" + (leaving ? " daw-whale-out" : ""),
					style: { animationDelay: (index * 0.09).toFixed(2) + "s" },
					"data-state": phase,
					// 等你：CSS 据此做常驻循环摆动（入场挥手是一次性的，这个不退场、直到用户回应）。
					"data-face": face === "waiting" ? "waiting" : undefined,
					"data-lead": whale.lead ? "1" : "0",
					"data-agent": whale.label
				},
					h("div", {
						className: "daw-swim",
						// 这一层全是插画/粒子/呼吸动画，读屏只需要知道有没有这只、在干什么。
						"aria-hidden": "true",
						style: {
							"--daw-dur": duration,
							"--daw-delay": delay.toFixed(2) + "s",
							"--daw-amp": amp
						}
					},
						body,
						h("span", { className: "daw-dots", "aria-hidden": "true" }, h("i", null), h("i", null), h("i", null))
					),
					props.labels ? h("span", { className: "daw-label", title: whale.label }, whale.label) : null,
					typeof props.contextLeft === "number"
						? h("i", {
							className: "daw-ctx", role: "img", "data-level": props.contextLeft <= 15 ? "low" : props.contextLeft <= 35 ? "mid" : "ok",
							"aria-label": props.contextTitle + " " + props.contextLeft + "%", title: props.contextTitle + " " + props.contextLeft + "%"
						}, h("b", { style: { width: props.contextLeft + "%" } }))
						: null
				),
				taskList,
				toggle
			);
		}

		/** 任务板投影的选择器：任务内容一变就换引用，供气泡与任务行使用。 */
		function createTeamSelector(leadIdOf) {
			var memory = { signature: null, value: null };
			return function (state) {
				var byId = (state && state.byId) || {};
				var currentId = currentSessionId(state);
				var leadId = currentId === undefined ? undefined : safeLeadId(leadIdOf, currentId);
				var team = leadId === undefined ? undefined : teamOf(state, leadId);
				var tasks = team && Array.isArray(team.tasks) ? team.tasks : [];
				var signature = String(leadId) + "|" + tasks.map(function (task) {
					if (!task) return "";
					return String(task.id) + ":" + String(task.status) + ":" + String(task.subject || "") + ":" + String(task.ownerName || "");
				}).join("\u0001");
				if (memory.value !== null && memory.signature === signature) return memory.value;
				memory.signature = signature;
				memory.value = { leadId: leadId, team: team, byId: byId };
				return memory.value;
			};
		}

		/**
		 * 订阅两个 store 并折叠出当前鲸鱼集合（图层与设置页共用）。
		 * 状态表先读：它一变就重渲染，选择器随即按新表重算。
		 */
		function usePod(props, snap) {
			var useSessions = hookOf(props.useSessions);
			var useSessionStatus = hookOf(props.useSessionStatus);
			var inputsRef = react.useRef(null);
			var selectorRef = react.useRef(null);
			var teamSelectorRef = react.useRef(null);
			var ctxSelectorRef = react.useRef(null);
			var statusMap = useSessionStatus(function (state) { return state || EMPTY_STATUS; }) || EMPTY_STATUS;
			if (inputsRef.current === null) inputsRef.current = { status: statusMap, settings: snap };
			if (selectorRef.current === null) selectorRef.current = createPodSelector(inputsRef, props.leadIdOf);
			if (teamSelectorRef.current === null) teamSelectorRef.current = createTeamSelector(props.leadIdOf);
			inputsRef.current.status = statusMap;
			inputsRef.current.settings = snap;
			// 血条数据：开关关着时选择器恒返回 undefined——不订阅投影变化，默认关就真的零开销。
			if (ctxSelectorRef.current === null) ctxSelectorRef.current = function (state) {
				return inputsRef.current.settings.contextBar === true && state ? state.projectionsBySession : undefined;
			};
			return {
				pod: useSessions(selectorRef.current),
				team: useSessions(teamSelectorRef.current),
				projections: useSessions(ctxSelectorRef.current),
				// 等你（波次 B）：每会话一行的 { running, pendingInteraction }，图层按鲸鱼 key 取。
				status: statusMap
			};
		}

		/** 顶端角色图层。 */
		// ── 图形编排面板 ──────────────────────────────────────────────────────
		//
		// 数据全部来自已有的会话快照（byId 里的 parentId + useSessionStatus）：不新增
		// 宿主依赖，也不需要后端存图。节点 = 一只智能体，边 = 父子/委派关系。
		// 面板能做的事：看状态、双击打开会话、选中后直接发一句话（走宿主
		// POST /agent-whales/api/send，落地路径与串门工具完全相同）。

		var GRAPH_FLAG_KEY = "dsh-agent-whales.graph";
		var GRAPH_POS_KEY = "dsh-agent-whales.graph-pos";
		var GRAPH_SEND_URL = "/agent-whales/api/send";
		/** 面板里一列节点的宽度与行高（与 CSS 卡片尺寸一致）。 */
		var GRAPH_COL_W = 124;
		var GRAPH_ROW_H = 84;

		function readJsonObject(key) {
			try {
				var raw = window.localStorage.getItem(key);
				var parsed = raw === null ? null : JSON.parse(raw);
				if (!parsed || Object.prototype.toString.call(parsed) !== "[object Object]") return {};
				return parsed;
			} catch (error) {
				return {};
			}
		}

		function writeJson(key, value) {
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch (error) {
				/* 隐私模式下继续用内存值 */
			}
		}

		/** 面板开合：布尔值也要能订阅，否则宿主渲染不会跟着变。 */
		function createFlag(key, fallback) {
			var value = fallback === true;
			try {
				var raw = window.localStorage.getItem(key);
				if (raw === "1") value = true;
				else if (raw === "0") value = false;
			} catch (error) {
				/* 用默认值 */
			}
			var listeners = new Set();
			return {
				getSnapshot: function () { return value; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				set: function (next) {
					var bool = next === true;
					if (bool === value) return;
					value = bool;
					try { window.localStorage.setItem(key, bool ? "1" : "0"); } catch (error) { /* 忽略 */ }
					listeners.forEach(function (listener) { listener(); });
				}
			};
		}

		var graphOpenStore = createFlag(GRAPH_FLAG_KEY, false);

		/** 手动拖动过的节点偏移：{ [key]: {x, y} }。 */
		var graphPositions = (function () {
			var map = readJsonObject(GRAPH_POS_KEY);
			var version = 0;
			var snapshot = { version: 0, map: Object.assign({}, map) };
			var listeners = new Set();
			function publish() {
				version += 1;
				snapshot = { version: version, map: Object.assign({}, map) };
				writeJson(GRAPH_POS_KEY, map);
				listeners.forEach(function (listener) { listener(); });
			}
			return {
				getSnapshot: function () { return snapshot; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				set: function (key, point) {
					if (!point || !isFinite(point.x) || !isFinite(point.y)) return;
					if (Math.abs(point.x) > 4000 || Math.abs(point.y) > 4000) return;
					map[key] = { x: Math.round(point.x), y: Math.round(point.y) };
					publish();
				},
				clear: function () { map = {}; publish(); }
			};
		})();

		/**
		 * 纯函数：把带 depth / parent 的行摊成画布坐标。
		 *
		 * 每层一行、层内水平居中；深度夹在 0..8，避免脏数据把画布拉成几万像素高。
		 * manual 是**相对自动布局的偏移**（拖动后落盘的就是它），这样窗口变化时节点
		 * 仍然跟着层级走，不会散架。
		 *
		 * @param {Array<{whale: {key: string, label?: string, phase?: string}, depth?: number, parent?: string}>} rows
		 * @param {{[key: string]: {x: number, y: number}}} [manual]
		 * @returns {{width: number, height: number, nodes: Array, edges: Array}}
		 */
		function graphLayout(rows, manual) {
			var list = Array.isArray(rows) ? rows : [];
			var byDepth = {};
			list.forEach(function (row) {
				if (!row || !row.whale || row.whale.key === undefined) return;
				var depth = typeof row.depth === "number" && isFinite(row.depth) ? Math.round(row.depth) : 0;
				if (depth < 0) depth = 0;
				if (depth > 8) depth = 8;
				(byDepth[depth] = byDepth[depth] || []).push(row);
			});
			var depths = Object.keys(byDepth).map(Number).sort(function (a, b) { return a - b; });
			var widest = 1;
			depths.forEach(function (depth) { widest = Math.max(widest, byDepth[depth].length); });
			var width = widest * GRAPH_COL_W;
			var height = (depths.length === 0 ? 1 : depths[depths.length - 1] + 1) * GRAPH_ROW_H;
			var nodes = [];
			var byKey = {};
			depths.forEach(function (depth) {
				var line = byDepth[depth];
				var offset = (width - line.length * GRAPH_COL_W) / 2;
				line.forEach(function (row, index) {
					var key = String(row.whale.key);
					var baseX = Math.round(offset + index * GRAPH_COL_W);
					var baseY = depth * GRAPH_ROW_H;
					var shift = manual && manual[key];
					var shiftX = shift && isFinite(shift.x) ? Math.round(shift.x) : 0;
					var shiftY = shift && isFinite(shift.y) ? Math.round(shift.y) : 0;
					var node = {
						key: key,
						label: String(row.whale.label || key),
						phase: row.whale.phase === "idle" ? "idle" : row.whale.phase === "provisioning" ? "provisioning" : "running",
						depth: depth,
						parent: row.parent === undefined || row.parent === null ? undefined : String(row.parent),
						x: baseX + shiftX,
						y: baseY + shiftY,
						baseX: baseX,
						baseY: baseY
					};
					nodes.push(node);
					byKey[key] = node;
				});
			});
			var edges = [];
			nodes.forEach(function (node) {
				if (node.parent === undefined) return;
				var parent = byKey[node.parent];
				if (!parent) return;
				edges.push({
					from: parent.key,
					to: node.key,
					x1: parent.x + (GRAPH_COL_W - 10) / 2,
					y1: parent.y + 52,
					x2: node.x + (GRAPH_COL_W - 10) / 2,
					y2: node.y
				});
			});
			return { width: width, height: height, nodes: nodes, edges: edges };
		}

		/** 给某个节点发一句话。失败时把宿主的错误文字抛出来，面板会显示。 */
		function postGraphSend(sessionId, text, mode) {
			var doFetch = resolveFetch();
			if (!doFetch) return Promise.reject(new Error("fetch unavailable"));
			var snap = toolActivity.getSnapshot ? toolActivity.getSnapshot() : {};
			var token = snap && typeof snap.controlToken === "string" ? snap.controlToken : "";
			return doFetch(GRAPH_SEND_URL, {
				method: "POST",
				headers: { "content-type": "application/json", "x-whales-token": token },
				body: JSON.stringify({ sessionId: sessionId, text: text, mode: mode === "queue" ? "queue" : "steer" })
			}).then(function (res) {
				if (res && res.ok) return res.json();
				return (res && typeof res.text === "function" ? res.text() : Promise.resolve("")).then(function (message) {
					throw new Error(message || "发送失败");
				});
			});
		}

		/**
		 * 图形编排面板：上面是拓扑，选中节点后在底部发一句话。
		 * 不持有会话真相（真相仍在会话快照里），只有一个写操作。
		 */
		function WhaleGraph(props) {
			var t = props.t;
			var layout = graphLayout(props.rows, props.manual);
			var focusState = react.useState("");
			var focused = focusState[0];
			var setFocused = focusState[1];
			var draftState = react.useState("");
			var draft = draftState[0];
			var setDraft = draftState[1];
			var busyState = react.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = react.useState("");
			var error = errorState[0];
			var setError = errorState[1];
			var dragRef = react.useRef(null);

			var node = null;
			for (var i = 0; i < layout.nodes.length; i += 1) {
				if (layout.nodes[i].key === focused) node = layout.nodes[i];
			}

			function submit(event) {
				if (event && typeof event.preventDefault === "function") event.preventDefault();
				var text = String(draft || "").trim();
				if (text === "" || !node || busy) return;
				setBusy(true);
				setError("");
				Promise.resolve(props.onSend(node.key, text))
					.then(function () { setDraft(""); })
					.catch(function (failure) { setError(String(failure && failure.message ? failure.message : failure)); })
					.then(function () { setBusy(false); });
			}

			function onNodeDown(event, target) {
				if (!event || event.button !== 0) return;
				dragRef.current = { key: target.key, startX: event.clientX, startY: event.clientY };
			}

			function onNodeMove(event) {
				var drag = dragRef.current;
				if (!drag) return;
				var dx = event.clientX - drag.startX;
				var dy = event.clientY - drag.startY;
				// 小于 3px 当成点击，避免手一抖就把节点挪走。
				if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
				if (typeof event.preventDefault === "function") event.preventDefault();
				graphPositions.set(drag.key, { x: dx, y: dy });
			}

			return h("div", { className: "daw-graph", role: "dialog", "aria-label": t("graphTitle") },
				h("div", { className: "daw-graph-head" },
					h("b", null, t("graphTitle")),
					h("span", { className: "daw-graph-hint" }, t("graphHint")),
					h("button", {
						className: "daw-graph-close",
						type: "button",
						"aria-label": t("graphClose"),
						onClick: function () { graphOpenStore.set(false); }
					}, "×")
				),
				h("div", { className: "daw-graph-body" },
					h("div", { className: "daw-graph-canvas", style: { width: layout.width + "px", height: layout.height + "px" } },
						h("svg", {
							className: "daw-graph-lines",
							width: layout.width,
							height: layout.height,
							viewBox: "0 0 " + layout.width + " " + layout.height,
							"aria-hidden": "true"
						}, layout.edges.map(function (edge) {
							return h("path", {
								key: edge.from + "->" + edge.to,
								className: "daw-graph-line",
								fill: "none",
								d: "M" + edge.x1 + " " + edge.y1 + " C" + edge.x1 + " " + (edge.y1 + 26) + " " + edge.x2 + " " + (edge.y2 - 26) + " " + edge.x2 + " " + edge.y2
							});
						})),
						layout.nodes.map(function (item) {
							var art = props.faceOf ? props.faceOf(item.key) : undefined;
							return h("div", {
								key: item.key,
								className: "daw-graph-node"
									+ (item.key === focused ? " is-focused" : "")
									+ (item.phase === "idle" ? " is-idle" : "")
									+ (item.phase === "provisioning" ? " is-starting" : ""),
								style: { left: item.x + "px", top: item.y + "px", width: GRAPH_COL_W - 10 + "px" },
								onClick: function () { setFocused(item.key); },
								onDoubleClick: function () { if (props.onOpen) props.onOpen(item.key); },
								onPointerDown: function (event) { onNodeDown(event, item); },
								onPointerMove: onNodeMove,
								onPointerUp: function () { dragRef.current = null; },
								onPointerLeave: function () { dragRef.current = null; },
								title: item.label
							},
								h("div", { className: "daw-graph-face-row" },
									art && art.uri ? h("img", { className: "daw-graph-face", src: art.uri, alt: "", draggable: "false" }) : null,
									h("span", { className: "daw-graph-name" }, item.label)
								),
								h("div", { className: "daw-graph-meta" },
									h("i", { className: "daw-graph-dot", "data-phase": item.phase }),
									h("span", { className: "daw-graph-task" }, props.taskOf ? props.taskOf(item.key) || t("graphIdle") : t("graphIdle"))
								)
							);
						})
					)
				),
				h("form", { className: "daw-graph-foot", onSubmit: submit },
					error ? h("div", { className: "daw-graph-error" }, error) : null,
					h("div", { className: "daw-graph-row" },
						h("span", { className: "daw-graph-target" }, node ? node.label : t("graphPick")),
						h("input", {
							className: "daw-graph-input",
							type: "text",
							value: draft,
							placeholder: t("graphPlaceholder"),
							onChange: function (event) { setDraft(event.target.value); },
							disabled: !node || busy
						}),
						h("button", { className: "daw-graph-send", type: "submit", disabled: !node || busy }, busy ? t("graphSending") : t("graphSend"))
					)
				)
			);
		}

		function WhaleLayer(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var snap = react.useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			var graphOpen = react.useSyncExternalStore(graphOpenStore.subscribe, graphOpenStore.getSnapshot, graphOpenStore.getSnapshot);
			var graphManual = react.useSyncExternalStore(graphPositions.subscribe, graphPositions.getSnapshot, graphPositions.getSnapshot);
			var artBroken = react.useSyncExternalStore(artStatus.subscribe, artStatus.getSnapshot, artStatus.getSnapshot);
			// 素材是运行时按皮肤分批拉的：这个订阅只为了让「新帧到货 / 加载失败」触发重渲染。
			var artSnap = react.useSyncExternalStore(artLoader.subscribe, artLoader.getSnapshot, artLoader.getSnapshot);
			var expandedSnap = react.useSyncExternalStore(expanded.subscribe, expanded.getSnapshot, expanded.getSnapshot);
			var positionsSnap = react.useSyncExternalStore(positions.subscribe, positions.getSnapshot, positions.getSnapshot);
			var podState = usePod(props, snap);
			var pod = podState.pod;
			var teamInfo = podState.team;
			var statusRows = podState.status;
			var projectionRows = podState.projections;
			var layerRef = react.useRef(null);

			// 俏皮话轮换用的时钟：一个 8 秒 tick 供全队共用，不必给每只单开计时器。
			// 关掉插件后不再空转（否则每 8 秒白白重渲染一次，什么都不画）。
			var tickPair = react.useState(0);
			var tick = tickPair[0];
			var setTick = tickPair[1];
			react.useEffect(function () {
				if (snap.enabled !== true) return function () {};
				var timer = setInterval(function () { setTick(function (n) { return n + 1; }); }, 8000);
				return function () { clearInterval(timer); };
			}, [snap.enabled]);

			var activitySnap = react.useSyncExternalStore(
				toolActivity.subscribe,
				toolActivity.getSnapshot,
				toolActivity.getSnapshot
			);
			// 活动快照轮询（2s / 失败退避 / 可见性唤醒 / 单飞）在模块级的 activityPoll 里，
			// 这里只按「插件是否启用」进场退场；退场后引用计数归零，轮询与监听一并停掉。
			// 设置页也读同一份快照，所以那边也会 start/stop —— 两边同时可见时仍然只有一条轮询链。
			react.useEffect(function () {
				if (snap.enabled !== true) return function () {};
				activityPoll.start();
				return function () { activityPoll.stop(); };
			}, [snap.enabled]);

			// 素材按当前皮肤分批加载：mix 需要 mature（Lead）+ q（成员）两套。
			// 注意：这里**不能**在 artBroken 时提前 return —— 用户切皮肤/重新挂载正是我们
			// 重试 manifest 的机会（artLoader.ensureSkin 内部会对 failed 状态再打一轮）。
			// ensureSkin 自身幂等，重复调用不会重复请求。
			react.useEffect(function () {
				if (snap.enabled !== true) return function () {};
				artLoader.ensureSkin(familyOf(snap.skin, true));
				artLoader.ensureSkin(familyOf(snap.skin, false));
				return function () {};
			}, [snap.enabled, snap.skin]);

			// 出场/退场：离开的鲸鱼再留一会儿，播完 daw-out 再卸载。
			var [leaving, setLeaving] = react.useState([]);
			var knownRef = react.useRef({});
			var timersRef = react.useRef({});
			react.useEffect(function () {
				var known = knownRef.current;
				var next = {};
				pod.whales.forEach(function (whale) { next[whale.key] = whale; });
				var gone = Object.keys(known).filter(function (key) { return !(key in next); });
				if (gone.length) {
					setLeaving(function (current) {
						var added = gone.map(function (key) { return known[key]; }).filter(Boolean);
						return current.concat(added).slice(-12);
					});
					gone.forEach(function (key) {
						if (timersRef.current[key] !== undefined) return;
						timersRef.current[key] = setTimeout(function () {
							delete timersRef.current[key];
							setLeaving(function (current) {
								return current.filter(function (whale) { return whale.key !== key; });
							});
						}, 780);
					});
				}
				knownRef.current = next;
			});
			react.useEffect(function () {
				return function () {
					Object.keys(timersRef.current).forEach(function (key) { clearTimeout(timersRef.current[key]); });
					timersRef.current = {};
				};
			}, []);

			// 页面不可见时暂停所有动画，避免后台空转。
			react.useEffect(function () {
				if (typeof document === "undefined" || typeof document.addEventListener !== "function") return function () {};
				function sync() {
					var el = layerRef.current;
					if (!el || !el.style) return;
					el.setAttribute("data-paused", document.hidden === true ? "true" : "false");
				}
				document.addEventListener("visibilitychange", sync);
				sync();
				return function () { document.removeEventListener("visibilitychange", sync); };
			}, []);

			if (!snap.enabled) return null;

			var live = pod.whales;
			/**
			 * 真正在干活的数量（灰显的已收工子级、以及迟迟没起来的「启动中」都不算）。
			 * 早先这里用 `phase !== "idle"`，把 provisioning 也算成在干活，于是名册里
			 * 卡住两个成员时提示「4 只在干活」，实际只有 2 只在动。
			 */
			var working = live.filter(function (whale) { return whale.phase === "running"; }).length;
			var starting = live.filter(function (whale) { return whale.phase === "provisioning"; }).length;
			var liveKeys = {};
			live.forEach(function (whale) { liveKeys[whale.key] = true; });
			// 同一会话在 780ms 内又开工时，只画新的那只，避免重复 key。
			var shown = live.map(function (whale) { return { whale: whale, leaving: false }; })
				.concat(leaving
					.filter(function (whale) { return liveKeys[whale.key] !== true; })
					.map(function (whale) { return { whale: whale, leaving: true }; }));
			if (shown.length === 0) return null;
			// 只剩收工灰显、又没有任何正在离场的角色时，整层不渲染——
			// 否则一个早就没人干活的会话会永久挂着一排灰鱼。
			if (working === 0 && starting === 0 && leaving.length === 0 && snap.alwaysShow !== true) return null;

			var baseSize = Math.round(BASE_HEIGHT * snap.scale / 100);
			var has = function (id) { return expandedSnap.ids.indexOf(String(id)) >= 0; };
			var rows = lineageOf(shown.map(function (item) { return item.whale; }), has);
			var rowByKey = {};
			rows.forEach(function (row) { rowByKey[row.whale.key] = row; });
			// 跟随间距按角色尺寸算：写死 30px 时，子级会比父级还窄，直接叠在身上。
			var offsets = resolveOffsets(rows, positionsSnap.map, {
				dx: Math.round(baseSize * 0.62),
				dy: Math.round(baseSize * 0.85)
			});
			var visibleRows = rows.filter(function (row) { return row.visible; });
			if (visibleRows.length === 0) return null;

			var leavingByKey = {};
			shown.forEach(function (item) { leavingByKey[item.whale.key] = item.leaving === true; });

			/**
			 * 拖出视口也要能找回来。
			 * 落点坐标是相对队形左上角的，之前只挡住 |x|>4000 这种离谱值：把角色拖到
			 * 屏幕右侧外面照样落盘，之后就再也点不到它了（双击复位也没机会触发）。
			 * 这里夹在图层可见范围内，留 24px 余量保证还有一条边露在外面。
			 */
			function clampToViewport(next) {
				var el = layerRef.current;
				if (!el || typeof el.getBoundingClientRect !== "function") return next;
				var rect = el.getBoundingClientRect();
				if (!rect || !isFinite(rect.width) || !isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return next;
				var maxX = Math.max(0, Math.round(rect.width) - 24);
				var maxY = Math.max(0, Math.round(rect.height) - 24);
				return {
					x: Math.min(maxX, Math.max(-24, next.x)),
					y: Math.min(maxY, Math.max(-24, next.y))
				};
			}

			var plan = planPod(visibleRows.map(function (row) { return row.whale; }), baseSize);
			var offset = snap.offset >= 0 ? "+ " + snap.offset : "- " + (-snap.offset);
			// 素材被拦（例如 CSP 不允许 data:）时整体退回经典皮肤，而不是留一排空位。
			var effectiveSkin = artBroken ? "classic" : snap.skin;
			var teamTasks = teamInfo && teamInfo.team ? teamInfo.team : undefined;
			// 团队全完成：有任务、没有未完成的、且队里已经没人在跑。
			// 这是 P2 的 teamDone → Q 版切「比心」（q-heart）；成熟版没有比心素材，沿用得意帧。
			var teamAllDone = false;
			if (snap.stateFaces !== false && teamInfo && teamInfo.team) {
				var allTasks = Array.isArray(teamInfo.team.tasks) ? teamInfo.team.tasks : [];
				var liveTasks = allTasks.filter(function (item) { return item && item.status !== "deleted"; });
				var nobodyRunning = !pod.whales.some(function (whale) { return whale.phase !== "idle"; });
				teamAllDone = nobodyRunning && liveTasks.length > 0 && liveTasks.every(function (item) {
					return item.status === "completed";
				});
			}

			// 「大伙在干什么」汇总条：只在两只以上在干活时才值得占地方。
			var barEntries = visibleRows
				.filter(function (row) { return row.whale.phase === "running"; })
				.map(function (row) {
					var whale = row.whale;
					var real = activityOf(whale, teamTasks, teamInfo ? teamInfo.byId : undefined);
					var tool = activitySnap.map[whale.key];
					// 汇总条只占一行，条目太长会把队形挤出屏幕，这里先截断。
					var text = hasActiveTask(teamTasks, whale) ? real : tool ? toolQuip(tool) : real;
					if (typeof text === "string" && text.length > 16) text = text.slice(0, 16) + "…";
					return { text: text };
				});
			var barText = snap.teamBar !== false && working > 1 ? teamBarText(barEntries, 3) : undefined;

			/**
			 * 气泡说什么，优先级见 pickBubbleText：
			 * 任务 → 当前工具 → 俏皮话 → 会话标题。
			 */
			function bubbleTextOf(whale, index) {
				var real = activityOf(whale, teamTasks, teamInfo ? teamInfo.byId : undefined);
				var hasTask = hasActiveTask(teamTasks, whale);
				var state = whale.phase === "idle" ? "idle" : whale.phase === "provisioning" ? "provisioning" : "running";
				return pickBubbleText({
					task: hasTask ? real : undefined,
					// 收工的角色不再报「正在用什么工具」
					tool: !hasTask && whale.phase !== "idle" ? activitySnap.map[whale.key] : undefined,
					state: state,
					index: index,
					tick: tick,
					quips: snap.quips,
					title: real
				});
			}
			return h("div", {
				className: "daw-layer",
				ref: layerRef,
				"data-motion": snap.motion,
				"data-skin": effectiveSkin,
				// idle | loading | ready | failed —— 素材加载状态，方便排查与离线断言
				"data-art": artSnap.manifest,
				"data-art-frames": String(artSnap.loaded),
				"data-resting": working === 0 ? "1" : "0"
			},
				whaleDefs(),
				h("div", {
					className: "daw-pod daw-pod-" + snap.position,
					style: {
						top: "calc(var(--dsh-frame-top-clearance, 0px) " + offset + "px)",
						opacity: String(snap.opacity / 100)
					},
					"data-agent-whales": String(working),
					// 以前整块 aria-hidden，但里面其实有可聚焦的「展开下级」按钮——读屏用户
					// 会遇到「不可见却能用 Tab 聚焦的按钮」。现在整块作为一组播报，插画层自己
					// 单独的 aria-hidden，键盘焦点只落在真正能操作的控件上。
					role: "group",
					"aria-label": t("title")
				},
					barText
						? h("div", { className: "daw-team-bar", title: barText },
							h("b", null, t("count", { count: working }), starting > 0 ? " · " + t("starting", { count: starting }) : null),
							barText
						)
						: null,
					plan.whales.map(function (whale, index) {
						var row = rowByKey[whale.key];
						var depth = row ? row.depth : 0;
						// 每深一层明显缩小一档，子级看起来才像「小小鱼」。
						var rowSize = depth === 0 ? plan.size : Math.max(34, Math.round(plan.size * (1 - 0.26 * depth)));
						// 运行时状态 → 这张脸。收工庆祝优先；整队收工时 Lead 换「比心」。
						var rowFace = faceOf(
							activitySnap && activitySnap.state ? activitySnap.state[whale.key] : undefined,
							Date.now(),
							snap,
							activitySnap && activitySnap.map ? activitySnap.map[whale.key] : undefined,
							pendingOf(statusRows, whale.key)
						);
						if (teamAllDone && whale.lead === true && rowFace !== "celebrating") rowFace = "teamDone";
						return h(Whale, {
							key: whale.key,
							whale: whale,
							index: index,
							depth: depth,
							size: rowSize,
							skin: effectiveSkin,
							motion: snap.motion,
							speed: snap.speed,
							particles: snap.particles,
							labels: snap.labels,
							classic: effectiveSkin === "classic",
							classicVector: artBroken,
							leaving: leavingByKey[whale.key] === true,
							// 运行时状态 → 这张脸（failed / celebrating / thinking / working / idle / teamDone）。
							face: rowFace,
							// 上下文余量（%）：开关关着时 projectionRows 恒为 undefined → 不画。
							contextLeft: snap.contextBar === true ? contextLeft(projectionRows, whale.key) : undefined,
							contextTitle: t("contextTitle"),
							// 只有 Q 版有心情帧；成熟版那套没有逐帧素材。
							moodKey: leavingByKey[whale.key] !== true
								? pickMoodKey(familyOf(effectiveSkin, whale.lead), whale.phase, tick)
								: undefined,
							// 等你时气泡固定说「等你」：优先级压过任务 / 工具 / 俏皮话（PRD §4.2）；
							// 但「对话气泡」总开关关着就仍然不画——用户关掉气泡是明确选择。
							activity: snap.bubbles ? (rowFace === "waiting" ? t("waiting") : bubbleTextOf(whale, index)) : undefined,
							tasks: snap.tasks ? tasksOf(teamTasks, whale.name, whale.lead === true) : [],
							showBubble: snap.bubbles !== false,
							showTasks: snap.tasks !== false,
							childCount: row ? (row.expanded ? row.children : row.hidden) : 0,
							canExpand: row ? row.expanded === true || row.hidden > 0 : false,
							offset: offsets[whale.key],
							draggable: snap.draggable === true,
							onMove: function (key, next) {
								// 只接受有限且不离谱的坐标；离谱值会让角色永远挂在屏幕外或角落。
								if (!next || !isFinite(next.x) || !isFinite(next.y)) return;
								if (Math.abs(next.x) > 4000 || Math.abs(next.y) > 4000) return;
								positions.set(key, clampToViewport(next));
							},
							onReset: function (key) { positions.remove(key); },
							onFocus: typeof props.focusSession === "function"
								? function (key) {
									var target = rowByKey[key];
									props.focusSession(key, target ? target.parent : undefined);
								}
								: undefined,
							expanded: row ? row.expanded : false,
							expandTitle: t("expand"),
							collapseTitle: t("collapse"),
							focusTitle: t("focus")
						});
					}),
					plan.overflow > 0
						? h("span", { className: "daw-count" }, "+" + plan.overflow)
						: null,
					snap.labels && working + starting > 0
						? h("span", { className: "daw-count" }, t("count", { count: working }), starting > 0 ? " · " + t("starting", { count: starting }) : null)
						: null,
				),
				// 编排入口不再放顶部队形尾部：那里会挡住 DSH 原生侧栏按钮。
				h("button", {
					className: "daw-graph-toggle daw-graph-launcher" + (graphOpen ? " is-on" : ""),
					type: "button",
					"aria-pressed": graphOpen ? "true" : "false",
					title: t("graphTitle"),
					onClick: function (event) {
						if (event && typeof event.stopPropagation === "function") event.stopPropagation();
						graphOpenStore.set(!graphOpen);
					}
				}, t("graph")),
				graphOpen
					? h(WhaleGraph, {
						rows: rows,
						manual: graphManual.map,
						t: t,
						faceOf: function (key) {
							var row = rowByKey[key];
							if (!row) return undefined;
							return artOf(frameOf(effectiveSkin, row.whale.lead === true, "base"));
						},
						taskOf: function (key) {
							var row = rowByKey[key];
							if (!row) return "";
							return activityOf(row.whale, teamTasks, teamInfo ? teamInfo.byId : undefined) || "";
						},
						onOpen: function (key) {
							var row = rowByKey[key];
							if (typeof props.focusSession === "function") props.focusSession(key, row ? row.parent : undefined);
						},
						onSend: function (key, text) { return postGraphSend(key, text, "steer"); }
					})
					: null
			);
		}

		/** 设置页控件。disabled 用于「宿主状态还没到」的开关（未就绪时别让用户点出假状态）。 */
		function Switch(props) {
			return h("label", { className: "daw-switch" + (props.disabled === true ? " daw-switch-disabled" : "") },
				h("input", {
					type: "checkbox",
					checked: props.checked,
					disabled: props.disabled === true,
					"aria-label": props.label,
					"aria-describedby": props.describedBy,
					onChange: function (event) { props.onChange(event.target.checked === true); }
				}),
				h("i", null)
			);
		}

		function Rows(props) {
			return h("div", { className: "daw-rows" }, props.children);
		}

		function Row(props) {
			return h("div", { className: "daw-row" },
				h("span", { className: "daw-row-label" }, props.label),
				h("span", { className: "daw-row-control" }, props.children)
			);
		}

		function RangeRow(props) {
			return h(Row, { label: props.label },
				h("input", {
					className: "daw-range",
					type: "range",
					min: props.min,
					max: props.max,
					step: props.step || 1,
					value: props.value,
					"aria-label": props.label,
					onChange: function (event) { props.onChange(parseInt(event.target.value, 10)); }
				}),
				h("span", { className: "daw-value" }, props.display(props.value))
			);
		}

		function SegRow(props) {
			return h(Row, { label: props.label },
				h("span", { className: "daw-seg", role: "group", "aria-label": props.label },
					props.options.map(function (option) {
						return h("button", {
							key: option.value,
							type: "button",
							"data-on": String(props.value) === String(option.value) ? "true" : "false",
							"aria-pressed": String(props.value) === String(option.value),
							onClick: function () { props.onChange(option.value); }
						}, option.label);
					})
				)
			);
		}

		/** 「串门工具」说明文字的 id（aria-describedby 用；这个设置页只有一个实例）。 */
		var VISIT_HINT_ID = "daw-agent-whales-visit-tools-hint";
		/** 「ultra 模式」说明文字的 id（aria-describedby 用）。 */
		var ULTRA_HINT_ID = "daw-agent-whales-ultra-hint";

		/** 智能体鲸鱼设置页。 */
		function WhaleSettingsSection(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var snap = react.useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			var graphOpen = react.useSyncExternalStore(graphOpenStore.subscribe, graphOpenStore.getSnapshot, graphOpenStore.getSnapshot);
			var graphManual = react.useSyncExternalStore(graphPositions.subscribe, graphPositions.getSnapshot, graphPositions.getSnapshot);
			var artBroken = react.useSyncExternalStore(artStatus.subscribe, artStatus.getSnapshot, artStatus.getSnapshot);
			var pod = usePod(props, snap).pod;

			// ── 「串门工具」开关 ──────────────────────────────────────────────
			// 真相在宿主（activity 快照的 visitTools），本地只有「正在写的乐观值」。
			var visitSnap = react.useSyncExternalStore(
				toolActivity.subscribe,
				toolActivity.getSnapshot,
				toolActivity.getSnapshot
			);
			var visitPair = react.useState(null);
			var visitPending = visitPair[0];
			var setVisitPending = visitPair[1];
			var visitBusyRef = react.useRef(false);
			var visitMountedRef = react.useRef(true);
			react.useEffect(function () {
				visitMountedRef.current = true;
				return function () { visitMountedRef.current = false; };
			}, []);
			// 设置页看得到的时候才需要这条轮询（图层那边也会 start，引用计数保证不重复）：
			// 开关没有第一次快照就没法显示，插件被禁用时图层不轮询，只能靠这里补上。
			react.useEffect(function () {
				activityPoll.start();
				return function () { activityPoll.stop(); };
			}, []);

			/**
			 * 点开关：
			 *   - 同一时刻只飞一个请求，连点直接忽略（避免乱序响应把状态写花）；
			 *   - 先乐观显示，POST 204 之后才算数；
			 *   - 403（token 过期）/ 400 / 500 / 网络失败 → 立刻回滚成宿主真相，面板保持可用。
			 * 失败后下一次 2s 轮询还会把真相再校正一遍，所以这里不需要额外补偿逻辑。
			 */
			function changeVisitTools(next) {
				if (visitBusyRef.current) return;
				if (typeof visitSnap.visitTools !== "boolean") return; // 未就绪：等快照
				visitBusyRef.current = true;
				setVisitPending(next === true);
				postVisitTools(next).then(function () {
					visitBusyRef.current = false;
					toolActivity.confirmVisitTools(next);
					if (visitMountedRef.current) setVisitPending(null);
				}).catch(function () {
					visitBusyRef.current = false;
					if (visitMountedRef.current) setVisitPending(null);
				});
			}

			// ── 「ultra 模式」开关 ──────────────────────────────────────────────
			// 与串门工具同一条链：真相在宿主（activity 快照的 ultra），本地只有乐观值；
			// 差别是宿主会把状态落盘，所以刷新/重启后仍是上次的值。
			var ultraPair = react.useState(null);
			var ultraPending = ultraPair[0];
			var setUltraPending = ultraPair[1];
			var ultraBusyRef = react.useRef(false);
			/**
			 * 点开关：同一时刻只飞一个请求；先乐观显示，POST 204 之后才算数；
			 * 失败立刻回滚成宿主真相（下一次 2s 轮询还会再校正一遍）。
			 */
			function changeUltra(next) {
				if (ultraBusyRef.current) return;
				if (typeof visitSnap.ultra !== "boolean") return; // 未就绪：等快照
				ultraBusyRef.current = true;
				setUltraPending(next === true);
				postUltra(next).then(function () {
					ultraBusyRef.current = false;
					toolActivity.confirmUltra(next);
					setUltraPending(null);
				}).catch(function () {
					ultraBusyRef.current = false;
					setUltraPending(null);
				});
			}

			var ultraReady = typeof visitSnap.ultra === "boolean";
			// 未就绪先显示 false（宿主默认关闭），但开关是 disabled 的，用户点不了假状态。
			var ultraValue = ultraPending !== null ? ultraPending : ultraReady ? visitSnap.ultra : false;
			var ultraSupported = ultraReady || visitSnap.fetched !== true;

			var visitReady = typeof visitSnap.visitTools === "boolean";
			// 未就绪先显示 true（宿主默认开启），但开关是 disabled 的，用户点不了假状态。
			var visitValue = visitPending !== null ? visitPending : visitReady ? visitSnap.visitTools : true;
			// 已经成功拿到过快照、但宿主没给 visitTools 字段 = 老版本宿主根本没这个能力：
			// 那就不显示这一行，别留一个永远灰色的开关。
			var visitSupported = visitReady || visitSnap.fetched !== true;

			// 只数真在干活的；收工灰显的不算，否则「当前 N 只在干活」会虚高。
			var live = pod.whales.filter(function (whale) { return whale.phase === "running"; }).length;
			var preset = snap.scale === 67 ? "compact" : snap.scale === 100 ? "standard" : snap.scale === 133 ? "loose" : "custom";

			return h("div", { className: "daw-section" },
				h("div", { className: "daw-head" },
					h("div", { className: "daw-title" }, t("title")),
					h("div", { className: "daw-live" }, live > 0 ? t("live", { count: live }) : t("liveNone"))
				),
				h("div", { className: "daw-hint" }, t("hint")),
				artBroken ? h("div", { className: "daw-warn" }, t("artBroken")) : null,
				h(Rows, null,
					h(Row, { label: t("enabled") },
						h(Switch, {
							label: t("enabled"),
							checked: snap.enabled,
							onChange: function (value) { settings.set({ enabled: value }); }
						})
					),
					h(SegRow, {
						label: t("countMode"),
						value: snap.countMode,
						options: [
							{ value: "members", label: t("mode.members") },
							{ value: "teams", label: t("mode.teams") }
						],
						onChange: function (value) { settings.set({ countMode: value }); }
					}),
					h(SegRow, {
						label: t("position"),
						value: snap.position,
						options: [
							{ value: "left", label: t("position.left") },
							{ value: "center", label: t("position.center") },
							{ value: "right", label: t("position.right") }
						],
						onChange: function (value) { settings.set({ position: value }); }
					}),
					h(SegRow, {
						label: t("skin"),
						value: snap.skin,
						options: [
							{ value: "mix", label: t("skin.mix") },
							{ value: "q", label: t("skin.q") },
							{ value: "mature", label: t("skin.mature") },
							{ value: "classic", label: t("skin.classic") }
						],
						onChange: function (value) { settings.set({ skin: value }); }
					}),
					h(SegRow, {
						label: t("motion"),
						value: snap.motion,
						options: [
							{ value: "off", label: t("motion.off") },
							{ value: "soft", label: t("motion.soft") },
							{ value: "normal", label: t("motion.normal") },
							{ value: "lively", label: t("motion.lively") }
						],
						onChange: function (value) { settings.set({ motion: value }); }
					}),
					h(SegRow, {
						label: t("sizePreset"),
						value: preset,
						options: [
							{ value: "compact", label: t("preset.compact") },
							{ value: "standard", label: t("preset.standard") },
							{ value: "loose", label: t("preset.loose") }
						],
						onChange: function (value) {
							settings.set({ scale: value === "compact" ? 67 : value === "loose" ? 133 : 100 });
						}
					}),
					h(RangeRow, {
						label: t("offset"),
						value: snap.offset,
						min: -60,
						max: 120,
						step: 2,
						display: function (value) { return value + " px"; },
						onChange: function (value) { settings.set({ offset: value }); }
					}),
					h(RangeRow, {
						label: t("scale"),
						value: snap.scale,
						min: 40,
						max: 200,
						display: function (value) { return Math.round(BASE_HEIGHT * value / 100) + " px"; },
						onChange: function (value) { settings.set({ scale: value }); }
					}),
					h(RangeRow, {
						label: t("opacity"),
						value: snap.opacity,
						min: 20,
						max: 100,
						display: function (value) { return value + " %"; },
						onChange: function (value) { settings.set({ opacity: value }); }
					}),
					h(RangeRow, {
						label: t("speed"),
						value: snap.speed,
						min: 25,
						max: 250,
						step: 5,
						display: function (value) { return value + " %"; },
						onChange: function (value) { settings.set({ speed: value }); }
					}),
					h(Row, { label: t("particles") },
						h(Switch, {
							label: t("particles"),
							checked: snap.particles,
							onChange: function (value) { settings.set({ particles: value }); }
						})
					),
					h(Row, { label: t("bubbles") },
						h(Switch, {
							label: t("bubbles"),
							checked: snap.bubbles,
							onChange: function (value) { settings.set({ bubbles: value }); }
						})
					),
					h(Row, { label: t("quips") },
						h(Switch, {
							label: t("quips"),
							checked: snap.quips,
							onChange: function (value) { settings.set({ quips: value }); }
						})
					),
					// 状态表情：宿主上报的运行时事实（思考 / 失败 / 收工）驱动专门的帧。
					h(Row, { label: t("stateFaces") },
						h(Switch, {
							label: t("stateFaces"),
							checked: snap.stateFaces,
							onChange: function (value) { settings.set({ stateFaces: value }); }
						})
					),
					h("span", { className: "daw-hint", id: "daw-agent-whales-state-faces-hint" }, t("stateFacesHint")),
					h(Row, { label: t("errorFaces") },
						h(Switch, {
							label: t("errorFaces"),
							checked: snap.errorFaces,
							disabled: snap.stateFaces !== true,
							onChange: function (value) { settings.set({ errorFaces: value }); }
						})
					),
					h("span", { className: "daw-hint", id: "daw-agent-whales-error-faces-hint" }, t("errorFacesHint")),
					// 工具动画：同样挂在「状态表情」总闸下（faceOf 一开头 stateFaces === false 就整体放弃）。
					h(Row, { label: t("toolFaces") },
						h(Switch, {
							label: t("toolFaces"),
							checked: snap.toolFaces,
							disabled: snap.stateFaces !== true,
							onChange: function (value) { settings.set({ toolFaces: value }); }
						})
					),
					h("span", { className: "daw-hint", id: "daw-agent-whales-tool-faces-hint" }, t("toolFacesHint")),
					// 等待举旗：同样挂在「状态表情」总闸下（faceOf 一开头 stateFaces === false 就整体放弃）。
					h(Row, { label: t("waitFaces") },
						h(Switch, {
							label: t("waitFaces"),
							checked: snap.waitFaces,
							disabled: snap.stateFaces !== true,
							onChange: function (value) { settings.set({ waitFaces: value }); }
						})
					),
					h("span", { className: "daw-hint", id: "daw-agent-whales-wait-faces-hint" }, t("waitFacesHint")),
					// 上下文血条：默认关；不挂在状态表情总闸下（它不是表情，是常驻读数）。
					h(Row, { label: t("contextBar") },
						h(Switch, {
							label: t("contextBar"),
							checked: snap.contextBar,
							onChange: function (value) { settings.set({ contextBar: value }); }
						})
					),
					h("span", { className: "daw-hint", id: "daw-agent-whales-context-bar-hint" }, t("contextBarHint")),
					h(Row, { label: t("alwaysShow") },
						h(Switch, {
							label: t("alwaysShow"),
							checked: snap.alwaysShow,
							onChange: function (value) { settings.set({ alwaysShow: value }); }
						})
					),
					h(Row, { label: t("teamBar") },
						h(Switch, {
							label: t("teamBar"),
							checked: snap.teamBar,
							onChange: function (value) { settings.set({ teamBar: value }); }
						})
					),
					// 「串门工具」开关：值来自宿主 activity 快照（visitTools），点一下 POST 到宿主。
					// 放在团队相关开关旁边——它是「智能体之间能不能互相串门」的团队级能力。
					visitSupported
						? h(Row, { label: t("visitTools") },
							h(Switch, {
								label: t("visitTools"),
								describedBy: VISIT_HINT_ID,
								checked: visitValue,
								// 未拿到第一次快照 / 正在写：一律不可点，避免用户看到假状态去点
								disabled: visitReady !== true || visitPending !== null,
								onChange: changeVisitTools
							})
						)
						: null,
					visitSupported ? h("div", { className: "daw-hint", id: VISIT_HINT_ID }, t("visitToolsHint")) : null,
					// 「ultra 模式」开关：同样只在宿主给了 ultra 字段时出现（老宿主不显示，不留灰开关）。
					ultraSupported
						? h(Row, { label: t("ultra") },
							h(Switch, {
								label: t("ultra"),
								describedBy: ULTRA_HINT_ID,
								checked: ultraValue,
								// 未拿到第一次快照 / 正在写：一律不可点，避免用户看到假状态去点
								disabled: ultraReady !== true || ultraPending !== null,
								onChange: changeUltra
							})
						)
					: null,
					ultraSupported ? h("div", { className: "daw-hint", id: ULTRA_HINT_ID }, t("ultraHint")) : null,
					h(Row, { label: t("tasks") },
						h(Switch, {
							label: t("tasks"),
							checked: snap.tasks,
							onChange: function (value) { settings.set({ tasks: value }); }
						})
					),
					h(Row, { label: t("idleChildren") },
						h(Switch, {
							label: t("idleChildren"),
							checked: snap.idleChildren,
							onChange: function (value) { settings.set({ idleChildren: value }); }
						})
					),
					h(Row, { label: t("draggable") },
						h(Switch, {
							label: t("draggable"),
							checked: snap.draggable,
							onChange: function (value) {
								settings.set({ draggable: value });
								if (value === false) positions.clear();
							}
						})
					),
					h(Row, { label: t("labels") },
						h(Switch, {
							label: t("labels"),
							checked: snap.labels,
							onChange: function (value) { settings.set({ labels: value }); }
						})
					),
					h("div", { className: "daw-row" },
						h("span", null),
						h("button", {
							className: "daw-btn",
							type: "button",
							onClick: function () { settings.reset(); positions.clear(); }
						}, t("reset"))
					)
				)
			);
		}

		// ── 文案（中英键集合必须一致）───────────────────────────────────────────
		var DICT = {
			zh: {
				"title": "智能体鲸鱼",
				"hint": "每多一个正在干活的智能体（Lead 或 teammate），页面顶端就多一只鲸鱼娘；智能体收工，它潜入水里。素材：鲸鱼娘二创图，角色参考 TreapGoGo/deepseek-whale-girl（MIT）。",
				"enabled": "启用",
				"countMode": "计数方式",
				"mode.members": "按成员",
				"mode.teams": "按团队",
				"position": "水平位置",
				"position.left": "左",
				"position.center": "中",
				"position.right": "右",
				"skin": "形象风格",
				"skin.mix": "混合",
				"skin.q": "Q 版",
				"skin.mature": "成熟版",
				"skin.classic": "经典皮肤",
				"motion": "动画强度",
				"motion.off": "关",
				"motion.soft": "轻微",
				"motion.normal": "标准",
				"motion.lively": "活泼",
				"sizePreset": "尺寸预设",
				"preset.compact": "紧凑",
				"preset.standard": "标准",
				"preset.loose": "宽松",
				"offset": "垂直偏移",
				"scale": "角色大小",
				"opacity": "不透明度",
				"speed": "游动速度",
				"particles": "气泡粒子",
				"bubbles": "对话气泡",
				"quips": "俏皮话",
				"stateFaces": "状态表情",
				"stateFacesHint": "思考时托腮、收工轻哭、团队全完成比心；关掉只走心情轮换。",
				"errorFaces": "出错表情",
				"errorFacesHint": "工具或模型失败时把「出错脸」画出来（8 秒后自动恢复）。",
				"toolFaces": "工具动画",
				"waitFaces": "等待举旗",
				"waitFacesHint": "审批或提问在等你回应时，角色挥手并显示「等你」，直到你处理完。关掉不影响审批本身。",
				"waiting": "等你",
				"contextBar": "上下文血条",
				"contextBarHint": "角色身上显示这个会话的上下文还剩多少（与对话页的占用圈同一口径）。provider 还没上报用量时不显示。",
				"contextTitle": "上下文余量",
				"toolFacesHint": "按正在用的工具切动作：读文件看书、改文件敲键盘、跑命令敲终端；关掉只走心情轮换。短于 2 秒的工具来不及显示。",
				"teamBar": "团队汇总",
				"visitTools": "串门工具",
				"visitToolsHint": "让智能体可以列出、读取并给其它会话发消息（每轮请求会多带 4 个工具定义）。",
				"ultra": "ultra 模式",
				"ultraHint": "强制加载 deep-effort 执行契约：效果优先于成本，先取证、必须自验、不确定就多查、交付前自检边界。打开后每一轮都在上下文里，状态会记住，重启后仍生效。",
				"alwaysShow": "没活也挂着",
				"tasks": "显示任务",
				"idleChildren": "已收工子级",
				"draggable": "可拖拽",
				"expand": "展开这个智能体的下级",
				"collapse": "收起下级",
				"focus": "单击切到这个智能体的会话；双击复位位置",
				"labels": "显示名字",
				"artBroken": "角色立绘没能加载（可能被页面的安全策略拦了），当前已自动切到经典皮肤。",
				"live": "当前 {count} 只鲸鱼在干活",
				"liveNone": "当前没有智能体在干活",
				"count": "{count} 只在干活",
				"starting": "{count} 只启动中",
				"canvasTitle": "协作概览",
				"canvasHint": "只读 · 与 Chat 并列",
				"canvasCount": "{members} 成员 · {tasks} 任务",
				"canvasTasks": "任务（依赖任务板）",
				"canvasMembers": "执行者",
				"canvasEmptyTasks": "这个会话还没有任务",
				"canvasEmptyMembers": "还没有成员",
				"canvasRunning": "进行中",
				"canvasDone": "已完成",
				"canvasPending": "待处理",
				"canvasUnowned": "未分配",
				"canvasReady": "就绪",
				"canvasBlockedBy": "前置 {count} 条",
				"canvasReadonly": "只读视图：任务与成员的写操作将陆续接入。",
				"graph": "编排",
				"graphTitle": "智能体编排",
				"graphHint": "点节点选中 · 双击打开会话 · 拖动可挪位",
				"graphClose": "关闭",
				"graphPick": "先选一个节点",
				"graphIdle": "空闲",
				"graphPlaceholder": "给这个智能体说一句…",
				"graphSend": "发送",
				"graphSending": "发送中…",
				"reset": "恢复默认"
			},
			en: {
				"title": "Agent Whales",
				"hint": "One whale girl swims at the top of the page for every working agent (lead or teammate); when an agent stops, she dives away. Art: fan-made whale girl, character reference TreapGoGo/deepseek-whale-girl (MIT).",
				"enabled": "Enabled",
				"countMode": "Count by",
				"mode.members": "Member",
				"mode.teams": "Team",
				"position": "Horizontal",
				"position.left": "Left",
				"position.center": "Center",
				"position.right": "Right",
				"skin": "Style",
				"skin.mix": "Mixed",
				"skin.q": "Chibi",
				"skin.mature": "Mature",
				"skin.classic": "Classic",
				"motion": "Animation",
				"motion.off": "Off",
				"motion.soft": "Soft",
				"motion.normal": "Normal",
				"motion.lively": "Lively",
				"sizePreset": "Size preset",
				"preset.compact": "Compact",
				"preset.standard": "Standard",
				"preset.loose": "Loose",
				"offset": "Vertical offset",
				"scale": "Character size",
				"opacity": "Opacity",
				"speed": "Swim speed",
				"particles": "Bubbles",
				"bubbles": "Speech bubble",
				"quips": "Quips",
				"stateFaces": "State faces",
				"stateFacesHint": "Pensive while thinking, teary when a run finishes, heart for a completed team. Off = mood rotation only.",
				"errorFaces": "Error face",
				"errorFacesHint": "Show a sheepish face when a tool or the model fails (auto-recovers after 8s).",
				"toolFaces": "Tool animation",
				"waitFaces": "Waiting flag",
				"waitFacesHint": "While an approval or question is waiting for you, the character waves and says \"Your turn\" until you respond. Turning it off does not affect the approval itself.",
				"waiting": "Your turn",
				"contextBar": "Context bar",
				"contextBarHint": "Show how much context this session has left on the character (same measure as the occupancy ring on the chat page). Hidden until the provider reports usage.",
				"contextTitle": "Context left",
				"toolFacesHint": "Switch pose by the tool in use: reading, typing, or running a command. Off = mood rotation only. Tools shorter than 2s are too quick to show.",
				"teamBar": "Team summary",
				"visitTools": "Visit tools",
				"visitToolsHint": "Let agents list, read, and message other sessions (adds 4 tool definitions to every request).",
				"ultra": "Ultra mode",
				"ultraHint": "Force-load the deep-effort execution contract: effect over cost — gather evidence first, verify every change, investigate when unsure, self-check boundaries before delivery. Active in every turn while on; the state persists across restarts.",
				"alwaysShow": "Keep when idle",
				"tasks": "Show tasks",
				"idleChildren": "Idle children",
				"draggable": "Draggable",
				"expand": "Show this agent's children",
				"collapse": "Collapse children",
				"focus": "Click to open this agent's session; double-click to reset its position",
				"labels": "Show names",
				"artBroken": "The character art failed to load (likely blocked by the page's security policy); the classic skin is active.",
				"live": "{count} whale(s) working",
				"liveNone": "No agent is working",
				"count": "{count} working",
				"starting": "{count} starting",
				"canvasTitle": "Collaboration overview",
				"canvasHint": "read-only · beside Chat",
				"canvasCount": "{members} members · {tasks} tasks",
				"canvasTasks": "Tasks (dependency board)",
				"canvasMembers": "Executors",
				"canvasEmptyTasks": "No tasks in this session yet",
				"canvasEmptyMembers": "No members yet",
				"canvasRunning": "in progress",
				"canvasDone": "done",
				"canvasPending": "pending",
				"canvasUnowned": "unowned",
				"canvasReady": "ready",
				"canvasBlockedBy": "{count} blockers",
				"canvasReadonly": "Read-only view: write actions will follow.",
				"graph": "Arrange",
				"graphTitle": "Agent graph",
				"graphHint": "click to select · double-click to open · drag to move",
				"graphClose": "Close",
				"graphPick": "pick a node",
				"graphIdle": "idle",
				"graphPlaceholder": "say something to this agent…",
				"graphSend": "Send",
				"graphSending": "Sending…",
				"reset": "Reset defaults"
			}
		};

		/** 必需服务：slots（槽位）、sessions（Lead 归属解析）、locale（文案）。 */
		var inject = ["slots", "sessions", "locale"];

		/**
		 * 把「subagent 地址」翻成 `uiWorkspace.openSession` 认得的 target。
		 *
		 * 官方团队面板用的是同一套：Lead 传字符串，teammate 传
		 * `{ parentSessionId, childSessionId, mode }`。绑定里拿不到地址时
		 * 退化成「有父级就用 continuable 打开子会话」，再不行就裸传 id。
		 */
		function sessionTargetOf(address, sessionId, parentId) {
			if (address && address.parentSessionId && address.childSessionId) {
				return {
					parentSessionId: String(address.parentSessionId),
					childSessionId: String(address.childSessionId),
					mode: address.mode || "continuable"
				};
			}
			if (parentId !== undefined && parentId !== null && String(parentId) !== String(sessionId)) {
				return {
					parentSessionId: String(parentId),
					childSessionId: String(sessionId),
					mode: "continuable"
				};
			}
			return String(sessionId);
		}

		/** 装配阶段出问题时的统一出口：记一条告警，别让一个座位拖垮整个插件。 */
		function reportSetupError(seat, error) {
			if (typeof console === "undefined" || !console || typeof console.warn !== "function") return;
			console.warn("[agent-whales] " + seat + " 装配失败：", error);
		}

		/**
		 * 会话内的「协作概览」（只读）。
		 *
		 * 注册在 conversation.view 列表槽里，与官方 Chat / Trajectory 并列——这是接管
		 * 主页面风险最低的一步：不影子任何官方渲染，出问题切回 Chat 即可。
		 *
		 * 这一版只**呈现**当前会话所属团队的任务与成员，不提供任何写操作；数据全部
		 * 来自已有的会话快照与团队投影（不新增宿主依赖）。
		 */
		function WhaleCanvasView(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			// 两个 hook 必须无条件调用；槽位没给就退化成"没有数据"，不炸整个视图。
			var sessionsState = (typeof props.useSessions === "function" ? props.useSessions : function () { return undefined; })(function (value) { return value; });
			var statusMap = (typeof props.useSessionStatus === "function" ? props.useSessionStatus : function () { return undefined; })(function (value) { return value; });

			var currentId = sessionsState ? currentSessionId(sessionsState) : undefined;
			var leadId = currentId === undefined ? undefined : safeLeadId(props.leadIdOf, currentId);
			var team = sessionsState && leadId !== undefined ? teamOf(sessionsState, leadId) : undefined;

			var tasks = team && Array.isArray(team.tasks)
				? team.tasks.filter(function (task) { return task && task.status !== "deleted"; })
				: [];
			var members = team && Array.isArray(team.members) ? team.members : [];
			var byId = (sessionsState && sessionsState.byId) || {};

			function statusText(status) {
				if (status === "in_progress") return t("canvasRunning");
				if (status === "completed") return t("canvasDone");
				return t("canvasPending");
			}

			return h("div", { className: "daw-canvas", "data-agent-whales-canvas": "1" },
				h("header", { className: "daw-canvas-head" },
					h("b", null, t("canvasTitle")),
					h("span", { className: "daw-canvas-hint" }, t("canvasHint")),
					h("span", { className: "daw-canvas-count" },
						t("canvasCount", { members: members.length, tasks: tasks.length }))
				),
				h("div", { className: "daw-canvas-cols" },
					h("section", { className: "daw-canvas-col" },
						h("h4", null, t("canvasTasks")),
						tasks.length === 0
							? h("p", { className: "daw-canvas-empty" }, t("canvasEmptyTasks"))
							: tasks.slice(0, 24).map(function (task) {
								var owner = typeof task.ownerName === "string" && task.ownerName !== "" ? task.ownerName : t("canvasUnowned");
								return h("article", { className: "daw-canvas-card", key: String(task.id) },
									h("b", null, String(task.subject || task.id)),
									h("span", { className: "daw-canvas-meta" },
										statusText(task.status) + " · " + owner +
										(task.ready === true ? " · " + t("canvasReady") : "")),
									task.blockedBy && task.blockedBy.length > 0
										? h("span", { className: "daw-canvas-blocked" },
											t("canvasBlockedBy", { count: task.blockedBy.length }))
										: null
								);
							})
					),
					h("section", { className: "daw-canvas-col" },
						h("h4", null, t("canvasMembers")),
						members.length === 0
							? h("p", { className: "daw-canvas-empty" }, t("canvasEmptyMembers"))
							: members.map(function (member) {
								var row = byId[String(member.id)];
								var title = row && typeof row.title === "string" && row.title !== "" ? row.title : undefined;
								return h("article", { className: "daw-canvas-card", key: String(member.id) },
									h("b", null, String(member.name || member.id)),
									h("span", { className: "daw-canvas-meta" },
										String(member.role || "teammate") + " · " + String(member.phase || "") +
										(title === undefined ? "" : " · " + title))
								);
							})
					)
				),
				h("footer", { className: "daw-canvas-foot" }, t("canvasReadonly"))
			);
		}

		function apply(ctx) {
			ctx.effect(function () {
				try {
					return injectStyles();
				} catch (error) {
					reportSetupError("styles", error);
					return function () {};
				}
			}, "agent-whales: styles");
			ctx.effect(function () {
				try {
					return ctx.locale.register(NS, DICT);
				} catch (error) {
					// 重复装配（热重载、插件重新启用）时同名 namespace 已经注册过会抛错；
					// 这时沿用已有文案即可，别让一条文案注册失败把图层和设置页一起带走。
					reportSetupError("locale", error);
					return function () {};
				}
			}, "agent-whales: locale");

			// 当前会话若本身是 teammate，鲸鱼数应挂到它的 Lead 团队上。
			function leadIdOf(sessionId) {
				try {
					var sessions = ctx.sessions;
					if (!sessions || typeof sessions.binding !== "function") return sessionId;
					var binding = sessions.binding(sessionId);
					var snapshot = binding && binding.session ? binding.session.getSnapshot() : undefined;
					var address = snapshot && snapshot.subagent ? snapshot.subagent.address : undefined;
					return (address && address.parentSessionId) || sessionId;
				} catch (error) {
					return sessionId;
				}
			}

			/**
			 * 点某只角色 → 切到它的会话。
			 *
			 * 走的是官方团队面板同一条路：`ctx.uiWorkspace.openSession`。
			 * 这个服务按需读取而不是硬依赖——拿不到就只是「点了没反应」，
			 * 不会让整个图层起不来。
			 */
			function focusSession(sessionId, parentId) {
				var workspace = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
				if (!workspace || typeof workspace.openSession !== "function") return false;
				var address;
				try {
					var sessions = ctx.sessions;
					if (sessions && typeof sessions.binding === "function") {
						var binding = sessions.binding(sessionId);
						var snapshot = binding && binding.session ? binding.session.getSnapshot() : undefined;
						address = snapshot && snapshot.subagent ? snapshot.subagent.address : undefined;
					}
				} catch (error) {
					address = undefined;
				}
				try {
					workspace.openSession(sessionTargetOf(address, sessionId, parentId));
					return true;
				} catch (error) {
					return false;
				}
			}

			// 两个座位各自独立兜底：设置页注册失败时，顶端的鲸鱼图层仍然应该在。
			// （slots.inject 对「槽位还没声明」是等待而不是抛错，这里防的是 register 本身出问题。）
			function mountSeat(seat, slotName, options, component) {
				try {
					ctx.slots.inject(slotName, function () {
						try {
							return ctx.slots.register(options, component);
						} catch (error) {
							reportSetupError(seat, error);
							return function () {};
						}
					});
				} catch (error) {
					reportSetupError(seat, error);
				}
			}

			mountSeat("overlay", "shell.overlay", {
				name: "shell.overlay",
				id: "agent-whales",
				order: 40,
				locale: NS,
				inject: function () { return { leadIdOf: leadIdOf, focusSession: focusSession }; }
			}, WhaleLayer);

			mountSeat("settings", "settings.section", {
				name: "settings.section",
				id: "agent-whales",
				order: 14,
				label: "智能体鲸鱼 · Agent Whales",
				locale: NS,
				inject: function () { return { leadIdOf: leadIdOf, focusSession: focusSession }; }
			}, WhaleSettingsSection);

			// 只读团队概览与项目画布使用不同的入口。
			mountSeat("canvas", "conversation.view", {
				name: "conversation.view",
				id: "whales-canvas",
				order: 60,
				label: function () {
					var translate = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : undefined;
					return typeof translate === "function" ? translate("canvasTitle") : DICT.zh.canvasTitle;
				},
				locale: NS,
				inject: function () { return { leadIdOf: leadIdOf, focusSession: focusSession }; }
			}, WhaleCanvasView);

			// M6：工作台文案单独一个命名空间（与装饰层 DICT 分开，整块替换不影响鲸鱼娘）。
			ctx.effect(function () {
				try {
					return ctx.locale.register(WB_NS, WB_TEXT);
				} catch (error) {
					// 重复装配（热重载）时同名命名空间已注册过会抛错；沿用已有文案即可。
					reportSetupError("workbench locale", error);
					return function () {};
				}
			}, "agent-whales: workbench locale");

			// 画布优先（v2.2 九（续二））：会话引用与新建会话，经 inject 下发给工作台。
			// 两个函数在 apply 里定义一次，引用稳定——useRetainedSession 以它为 effect 依赖。
			function retainSession(sessionId) {
				var sessions = ctx.sessions;
				if (!sessions || typeof sessions.retain !== "function") return null;
				return sessions.retain(sessionId, { source: "whalesCanvas" });
			}
			function createSession(options) {
				var sessions = ctx.sessions;
				if (!sessions || typeof sessions.create !== "function") return Promise.reject(new Error("sessions.create unavailable"));
				return sessions.create(options || {});
			}

			// P2：独立主面板。main 是 keyed 槽——只用我们自己的 key，绝不覆盖 conversation
			// （§45.4 约束 1）；keyed 槽按 {key, priority, locale} 认选项，不传 id/order。
			// 顶栏「返回对话」切回官方会话。
			// children 声明一个 session 作用域子槽：渲染器因此下发 SessionProvider + renderSlot，
			// 画布 Composer 卡才能显式绑定主对话（官方 ui-subagent 侧栏对话同一做法）。
			mountSeat("workbench", "main", {
				name: "main",
				key: "whales-canvas",
				locale: WB_NS,
				children: { "whales.canvas.session": { kind: "single", scope: "session" } },
				inject: function () { return { leadIdOf: leadIdOf, focusSession: focusSession, retainSession: retainSession, createSession: createSession }; }
			}, WhaleWorkbench);
			// 同一份 inject 存一份给右侧栏 body 用（见 WB_WORKBENCH_INJECT 的注释）。
			WB_WORKBENCH_INJECT = { leadIdOf: leadIdOf, focusSession: focusSession, retainSession: retainSession, createSession: createSession };

			mountSeat("canvas-session", "whales.canvas.session", {
				name: "whales.canvas.session",
				locale: WB_NS
			}, WbSessionComposer);

			// DSH 右侧栏画布入口保留；只去掉画布内容内部的侧栏（WhaleWorkbench 的 narrow 模式）。
			mountSeat("canvas-tab-body", "sidebar.right.pane.tab", {
				name: "sidebar.right.pane.tab",
				key: WHALES_RIGHT_TAB_ID,
				locale: WB_NS,
				inject: function () { return { hooks: {} }; }
			}, WhaleRightTabBody);
			function registerDesignTail(scope) {
				var slots = scope.slots;
				slots.inject("conversation.chat.turnTail", function () {
					var conversation = scope.uiConversation || (typeof scope.get === "function" && scope.get("uiConversation"));
					if (!conversation || !conversation.events || typeof conversation.events.register !== "function") return;
					var disposeEvents = conversation.events.register(whaleDesignTurnDefinition);
					try {
						var disposeTail = slots.register({
							name: "conversation.chat.turnTail", id: DESIGN_TURN_KEY, locale: WB_NS
						}, WhaleDesignTurnTail);
						return function () { disposeTail(); disposeEvents(); };
					} catch (error) {
						disposeEvents();
						reportSetupError("chat design", error);
					}
				});
			}
			try {
				if (typeof ctx.inject === "function") ctx.inject(["uiConversation"], registerDesignTail);
				else registerDesignTail(ctx);
			} catch (error) { reportSetupError("chat design", error); }
			// 右侧栏服务可以在插件之后加载，等注册表就绪再登记画布。
			function registerCanvasTab(scope) {
				var tabRegistry = scope.sidebarRightTabs || (typeof scope.get === "function" && scope.get("sidebarRightTabs"));
				if (tabRegistry && typeof tabRegistry.register === "function") {
					return tabRegistry.register({
						id: WHALES_RIGHT_TAB_ID,
						kind: WHALES_RIGHT_TAB_KIND,
						priority: "extension",
						title: function () { return "画布"; },
						guide: [{ id: "whales-canvas", order: 50, title: function () { return "画布"; }, description: function () { return "这个对话所在的画布"; } }]
					});
				}
			}
			try {
				if (typeof ctx.inject === "function") ctx.inject(["sidebarRightTabs"], registerCanvasTab);
				else ctx.effect(function () { return registerCanvasTab(ctx); }, "agent-whales: canvas sidebar tab");
			} catch (error) { reportSetupError("canvas-tab-register", error); }

			// 侧栏全局面板入口（list 槽 {id, order}）；点了才切面板，不默认抢占。
			mountSeat("panel-entry", "sidebar.panellist", {
				name: "sidebar.panellist",
				id: "whales-canvas",
				order: 40,
				locale: WB_NS,
				label: function () {
					var translate = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(WB_NS) : undefined;
					return wbT({ t: translate })("nav.projects");
				},
				inject: function () { return { focusSession: focusSession }; }
			}, WhalePanelEntry);

			mountSeat("project-canvas-action", "conversation.session.header.utilities", {
				name: "conversation.session.header.utilities",
				id: "whales-project-canvas",
				order: 40,
				locale: WB_NS,
				inject: function () { return { leadIdOf: leadIdOf }; }
			}, WhaleProjectCanvasAction);

			// W2 / D2 递进第一步：目标条叠在官方 composer 上方（conversation.input.dock，
			// list 槽 {id, order}）。**不设 priority**——我们是叠加，不影子官方 composer
			// （§47.3 D2 硬约束：先叠目标条验证，达标后才考虑影子 composer）。
			// 官方 QueueDock / TodoDock 用 order 20，我们排在其后。
			mountSeat("goal", "conversation.input.dock", {
				name: "conversation.input.dock",
				id: "whales-goal",
				order: 40,
				locale: WB_NS,
				inject: function () { return { leadIdOf: leadIdOf, focusSession: focusSession }; }
			}, WhaleGoalBar);

			// 供面板入口在组件里调宿主 layout 服务（ctx 只在 apply 期拿得到）。
			wbCtx = ctx;
		}

		// ── M6 项目工作台（whales-canvas 主面板）─────────────────────────────────
		//
		// 设计依据：设计图pen.pen（U-1..U-10 屏幕 / M6-* 组件 / T-1..T-14 规格）与
		// PRD §45.3 P2（独立主面板，新增 main key 不覆盖 conversation）、§51–§55。
		// 边界：不影子官方会话流、不替换 conversation key；所有读写走宿主半边
		// /agent-whales/api/*，与 whales_* 工具共用同一套 store，不建第二事实源。

		var WB_NS = "agent-whales-workbench";
		// 右侧栏 tab 类型（用户反馈 2026-11-24）：id 是「这个实现的唯一名」，
		// kind 是「这类 tab 是什么」——注册与打开都用它。
		var WHALES_RIGHT_TAB_ID = "agent-whales-canvas";
		var WHALES_RIGHT_TAB_KIND = "whales-canvas";
		var DESIGN_TURN_KEY = "agent-whales-design-delivery";
		// 右侧栏 tab body 拿不到工作台那一套 inject（slot 是 session 作用域的），
		// 所以在 apply 期把 inject 值存到这里，body 渲染时直接用——效果与「主区工作台」完全一致。
		var WB_WORKBENCH_INJECT = null;
		var WB_API = "/agent-whales/api";
		// 工作台不再定时轮询：每次重拉都会重建节点/列表，拖拽、缩放、输入时尤其干扰。
		// 写操作后主动 invalidate；用户点顶栏「刷新」或重新切回窗口时再同步。

		/**
		 * 设计 token（T-6）。浅色为默认，暗色是设置里的风格选项；两套键集合必须一致，
		 * 组件只引用 var(--daw-*)，切主题即换色，不写第二套组件。
		 */
		var WB_TOKENS = {
			light: {
				"bg": "#EEF1F6", "surface": "#FFFFFF", "surface-muted": "#FAFBFD", "border": "#DCE2EE",
				"text": "#1B2333", "text-secondary": "#4A5468", "text-muted": "#8A93A6",
				"brand": "#3B55F0", "ok": "#22A06B", "warn": "#E0A018", "danger": "#D64545", "accent": "#C05BD0",
				"ok-bg": "#EAF7F0", "warn-bg": "#FDF6E7", "danger-bg": "#FDF0F0", "accent-bg": "#F9EFFA"
			},
			dark: {
				"bg": "#101318", "surface": "#181B22", "surface-muted": "#1F232C", "border": "#2A2F3A",
				"text": "#E8EAEE", "text-secondary": "#A0A6B0", "text-muted": "#6B7280",
				"brand": "#5B8CFF", "ok": "#3FB27F", "warn": "#E0A018", "danger": "#E06C6C", "accent": "#C879E0",
				"ok-bg": "#12241C", "warn-bg": "#2A2415", "danger-bg": "#2E1A1A", "accent-bg": "#261B2B"
			}
		};

		/** 简报总预算（PRD §54.7：项目简报与对话简报共用 2000 token，按序填充、超限丢弃）。 */
		var WB_BRIEF_BUDGET = 2000;

		/** 文案（中英键集合必须一致；与装饰层 DICT 分开注册，便于整块替换）。 */
		var WB_TEXT = {
			zh: {
				"nav.projects": "项目",
				"nav.inbox": "需要我处理",
				"inbox.empty": "没有待处理事项",
				"nav.settings": "设置",
				"top.running": "执行中 {count}",
				"top.back": "返回对话",
				"top.refresh": "刷新",
				"top.toList": "回项目列表",
				"list.title": "项目",
				"list.desc": "每个项目是独立容器：一个主对话 + 若干项目对话 + 一张任务表",
				"list.new": "＋ 新建项目",
				"list.export": "导出快照（ZIP）",
				"list.export.desc": "把项目/画布/交接/事件/提案五个数据文件打包下载（备份用；含会话 id 与任务正文，不含凭据）",
				"list.export.busy": "正在打包快照…",
				"list.export.done": "已导出 {n} 个文件（ZIP）",
				"list.export.failed": "导出失败：{reason}",
				"list.stat.active": "进行中项目",
				"list.stat.inbox": "待我处理",
				"list.stat.tickets": "执行中工单",
				"list.card.members": "成员 {count}",
				"list.card.tasks": "任务 {done}/{total}",
				"req.title": "需求",
				"req.empty": "还没有需求",
				"req.empty.hint": "在画布上让 Composer 画流程图或原型时，会自动建第一个需求",
				"req.virtual.title": "旧任务与原型",
				"req.virtual": "未归类",
				"req.virtual.hint": "没归到任何需求的旧任务 / 原型",
				"req.stage.clarify": "澄清",
				"req.stage.design": "设计",
				"req.stage.develop": "开发",
				"req.stage.accept": "验收",
				"req.stage.mismatch": "不符",
				"req.stage.passed": "通过",
				"req.attention": "需要你处理",
				"req.attention.confirm-design": "待确认设计",
				"req.attention.e2e-mismatch": "验收不符",
				"req.attention.rework-limit": "返工超限",
				"req.meta": "任务 {done}/{total} · 原型 {protos}",
				"req.design": "设计 v{v}",
				"req.design.none": "设计未确认",
				"req.prd.edit": "编辑 PRD",
				"req.prd.empty": "添加 Markdown 正文、工作区文件或外部文档。",
				"req.prd.mode": "PRD 来源",
				"req.prd.markdown": "Markdown 正文",
				"req.prd.file": "工作区 Markdown 文件",
				"req.prd.link": "Notion 或网页链接",
				"req.prd.summary": "摘要（可选）",
				"req.prd.refresh": "从文件刷新",
				"req.prd.notion": "打开 Notion",
				"req.prd.acceptance": "验收标准",
				"req.next": "下一步",
				"req.more": "还有 {n} 个需求",
				"req.new": "＋ 新需求",
				"req.new.title": "新需求",
				"req.new.name": "需求名称",
				"req.new.goal": "目标（可选）",
				"req.new.fail": "创建失败：{reason}",
				"tab.reqs": "需求",
				"tab.note.reqs": "一个需求从澄清到验收的全过程：设计确认、E2E 运行、批注与回流",
				"req.page.desc": "每个需求有自己的设计版本、任务和验收。点一个需求看详情。",
				"req.back": "← 返回需求列表",
				"req.section.design": "设计",
				"req.section.e2e": "E2E 验收",
				"req.design.confirm": "确认设计",
				"req.review.boardTools": "画板工具",
				"req.review.design": "设计稿",
				"req.review.handoff": "交接",
				"req.review.testing": "验收",
				"req.review.chooseBoard": "选择画板",
				"req.review.noHandoff": "确认设计后，可以在这里选择前端对话并跟踪交付。",
				"req.review.editLive": "修改当前稿",
				"req.review.history": "历次交接（{n}）",
				"req.review.current": "当前确认稿",
				"req.review.annotate": "标注修改",
				"req.handoff.title": "前端交接",
				"req.handoff.pending": "交付内容有更新 · 确认新版本后可交接",
				"req.handoff.pick": "选择前端对话",
				"req.handoff.send": "交给前端",
				"req.handoff.retry": "重新发送",
				"req.handoff.preview": "查看确认稿",
				"req.handoff.hide": "收起确认稿",
				"req.handoff.sending": "发送中",
				"req.handoff.sent": "已发送 · 等待进度",
				"req.handoff.failed": "未送达",
				"req.handoff.offline": "未送达 · 对话未唤醒",
				"req.handoff.unknown": "送达待核实",
				"req.handoff.draft": "已回报进度",
				"req.handoff.done": "已交付",
				"req.handoff.prd": "PRD v{v}",
				"req.handoff.noPrd": "未附 PRD",
				"req.handoff.external": "外部链接指向文档的当前内容。确认时已保存链接及随附的摘要。",
				"req.handoff.missing": "以下设计缺少源码",
				"req.design.open": "去画布看原型",
				"canvas.design.prototype": "原型帧",
				"canvas.design.annotate": "标注",
				"canvas.design.editDirect": "直接改",
				"canvas.design.chatOpen": "在画布中打开",
				"canvas.design.chatLoading": "正在加载预览…",
				"canvas.design.chatUnavailable": "预览加载失败，可以在画布中查看。",
				"canvas.design.chatBack": "返回上一屏",
				"req.design.reviewHint": "在这里查看设计、对画板元素留言，或打开画布继续修改。确认后当前内容会固化为新设计版本。",
				"req.design.empty": "这个需求还没有原型帧或画板。",
				"req.design.comments": "待处理标注",
				"req.design.resolve": "标记已处理",
				"req.design.commentResolved": "标注已标记为已处理",
				"req.design.openCanvas": "在画布中修改",
				"req.run.start": "开始验收",
				"req.run.finish": "结束这次运行",
				"req.run.none": "还没有运行。任务全部完工后会自动建（可在设置里改成手动），也可以点「开始验收」。",
				"req.run.meta": "驱动 {driver} · 设计 {v}",
				"req.run.status.queued": "排队中",
				"req.run.status.running": "运行中",
				"req.run.status.passed": "通过",
				"req.run.status.failed": "不符",
				"req.run.status.error": "出错",
				"req.case.status.pending": "待跑",
				"req.case.status.running": "运行中",
				"req.case.status.passed": "通过",
				"req.case.status.accepted": "可接受",
				"req.case.status.failed": "不符",
				"req.case.status.error": "出错",
				"req.case.mark.passed": "标通过",
				"req.case.mark.failed": "标不符",
				"req.case.accept": "标为可接受",
				"req.case.reflowed": "已回流 · {to}",
				"req.case.diagnosis": "初判（{who}，{kind}）：{reason}",
				"req.by.ai": "AI",
				"req.by.user": "人",
				"req.reflow": "回流返工",
				"req.reflow.code": "实现问题",
				"req.reflow.design": "设计问题",
				"req.reflow.requirement": "需求问题",
				"req.limit": "已返工 {n} 次（上限 {cap}），不再自动回流。建议回到需求重新评审，或把问题标为可接受。",
				"req.ann.add": "写批注",
				"req.ann.hint": "在截图上拖一个框，或直接写下你的预期",
				"req.ann.boxed": "已框选，写下你的预期",
				"req.ann.placeholder": "你预期看到什么",
				"req.ann.save": "保存批注",
				"req.ann.expected": "预期",
				"req.ann.sent": "已回流",
				"req.ann.remove": "删除",
				"req.shot.upload": "上传截图",
				"canvas.req.new": "＋ 新需求",
				"req.filter.title": "筛选需求",
				"req.owner": "负责人",
				"req.owner.none": "未指定",
				"req.owner.set": "负责人：{name}",
				"req.owner.unset": "未指定负责人",
				"req.owner.hint": "指定项目里的一个对话负责这个需求：设计 / 需求类的验收回流会优先发给它；它不在线时如实告诉你没送到，不会悄悄改发别人。",
				"req.filter.owner.title": "按负责人筛选",
				"req.filter.owner.all": "全部负责人",
				"req.filter.owner.none": "未指定负责人",
				"canvas.zoom.far": "远景：只看状态",
				"canvas.zoom.mid": "中景：看摘要",
				"canvas.zoom.near": "近景：看全文",
				"canvas.zoom.hint": "滚轮缩放画布：缩小只看状态，放大看到全文",
				"req.filter.all": "全部",
				"req.filter.attention": "需要我处理",
				"req.filter.mismatch": "E2E 不符",
				"req.filter.active": "进行中",
				"req.filter.passed": "已通过",
				"req.filter.empty": "没有符合这个筛选的需求",
				"canvas.req.open": "需求 · 需要你处理 {n}",
				"canvas.req.title": "打开需求页：看每个需求的设计、验收和返工",
				"canvas.req.more": "画布上只画前 12 个需求，还有 {n} 个，点这里去需求页看全部",
				"req.cfg.title": "E2E 验收配置",
				"req.cfg.summary": "触发：{trigger} · 驱动：{driver}",
				"req.cfg.edit": "修改",
				"req.cfg.collapse": "收起",
				"req.cfg.trigger": "触发方式",
				"req.cfg.trigger.auto": "任务全部完工后自动运行",
				"req.cfg.trigger.manual": "人点「开始验收」",
				"req.cfg.driver": "执行驱动",
				"req.cfg.driver.manual": "手动录入（人自己传截图、标结果）",
				"req.cfg.driver.tabbit-cli": "tabbit CLI（网页）",
				"req.cfg.driver.computer-use": "computer use（实验）",
				"req.cfg.executor": "执行器会话",
				"req.cfg.executor.none": "（未选择）",
				"req.cfg.cu.warn": "computer use 需要你自己安装第三方插件 dsh-kimi-assemble 和 KimiCU。目前只验证过「只读观察」；点击 / 输入这类动作没验证过，而且会短暂占用真实鼠标键盘。没有对应工具时，执行器会把用例上报为「出错」。",
				"req.cfg.baseUrl": "被测地址（可空）",
				"req.cfg.save": "保存配置",
				"req.cfg.saved": "已保存",
				"req.cfg.needExecutor": "选了非手动驱动，需要同时选一个执行器会话。",
				"list.empty.title": "空态：还没有项目",
				"list.empty.desc": "画布不设默认视图；进入项目面板需要一个项目。",
				"list.empty.create": "创建项目（选主对话）",
				"list.empty.join": "加入已有对话",
				"list.join.title": "加入已有对话（列出历史对话）",
				"list.join.archived": "已归档 · 可加入但不自动恢复",
				"list.join.taken": "已在其他项目（40701）",
				"list.join.action": "加入",
				"common.loading": "加载中…",
				"common.error": "读不到数据",
				"common.retry": "重试",
				"canvas.session.unbound": "当前对话还没有加入鲸鱼项目。让 Agent 在对话里画流程图、原型或设计图，就会自动创建项目画布。",
				"common.none": "—",
				"common.close": "关闭",
				"common.cancel": "取消",
				"common.confirm": "确认",
				"common.save": "保存",
				"common.refresh": "刷新",
				"tab.canvas": "画布",
				"tab.table": "任务",
				"tab.table.count": "{count} 项未完成",
				"tab.tasks": "任务",
				"tab.brief": "项目简报",
				"tab.exec": "执行",
				"tab.office": "办公室",
				"office.members": "{count} 个工位",
				"office.attention": "{count} 位等你处理",
				"office.room.page": "房间 {page}/{total}",
				"office.room.prev": "上一个房间",
				"office.room.next": "下一个房间",
				"office.empty": "项目里还没有成员。把对话加入项目后，这里会给每个成员一张工位。",
				"office.pose.idle": "空闲",
				"office.pose.type": "在写东西",
				"office.pose.read": "在读文件",
				"office.pose.run": "在跑命令",
				"office.pose.think": "思考中",
				"office.pose.wait": "等你",
				"office.pose.done": "刚收工",
				"office.pose.oops": "出错了",
				"office.pose.sleep": "离线",
				"office.tool": "正在用：{tool}",
				"office.open": "打开对话",
				"office.main": "主对话",
				"office.untitled": "未命名对话 · {id}",
				"office.scene.label": "办公室场景",
				"office.scene.auto": "自动",
				"office.scene.day": "白天",
				"office.scene.night": "夜间",
				"office.scene.schedule": "按本地时间切换，07:00–19:00 为白天",
				"office.task.assigned": "分配任务",
				"office.task.active": "进行中的任务",
				"office.task.blocked": "受阻的任务",
				"office.task.none": "暂无分配任务",
				"office.task.loading": "正在读取任务",
				"office.task.unavailable": "暂时读不到任务",
				"office.wait.approval": "等你审批",
				"office.wait.question": "等你回答",
				"office.wait.plan-review": "等你审阅计划",
				"office.wait.report": "等你处理任务回报",
				"office.wait.member": "等 {name} 完成「{task}」",
				"office.wait.task": "等「{task}」完成",
				"office.wait.removed": "依赖任务已移除",
				"tab.note.canvas": "超级画布：对话 / Agent / 上下文 / 文件 / 流程图 / 原型混排在一张图上",
				"tab.note.table": "任务表（含所属需求 / 依赖 / 命令）+ 执行状态（工单、日志尾、report、自动派发）",
				"tab.note.tasks": "任务走插件自建任务表；依赖 blockedBy 只在这里，不上画布",
				"tab.note.brief": "共享上下文只有两层：项目简报 + 按需读取；每轮自动注入已被否决",
				"tab.note.exec": "worker 无人值守在子工作树干活；人只看状态、日志尾部与 report",
				"canvas.link.empty": "这两者之间还没有交接记录",
				"canvas.link.count": "共 {count} 条",
				"canvas.link.fromUser": "你",
				"canvas.addAgent": "＋ 添加 Agent",
				"canvas.addAgent.none": "没有可加入的会话",
				"canvas.addAgent.modal": "添加 Agent 到画布",
				"canvas.addAgent.ok": "加入",
				"canvas.goal": "目标：{goal}",
				"canvas.goal.none": "还没写目标：在简报里补一条项目目标",
				"canvas.node.folder": "文件夹 · 本地",
				"canvas.node.agent": "Agent",
				"canvas.node.composer": "主对话",
				"canvas.empty": "画布上还没有任务。选好上下文后直接发送，或先加一个 Agent。",
				"canvas.empty.send": "发送到主对话",
				"canvas.empty.put": "把目标放入输入框",
				"canvas.empty.put.title": "把项目目标放进官方输入框，不切换面板、不自动发送",
				"canvas.zoom": "缩放",
				"canvas.zoomFit": "适应画布",
				"canvas.minimap": "小地图",
				"canvas.minimap.jump": "小地图 · 点击跳转",
				"canvas.grid": "网格",
				"canvas.guide": "操作指南",
				"canvas.hint": "滚轮上下 · Shift+滚轮左右 · Ctrl+滚轮缩放 · 拖动空白平移 · 双击节点改字",
				"inspect.kind.link": "关联",
				"inspect.kind.agent": "Agent",
				"inspect.kind.folder": "落点",
				"inspect.kind.composer": "Composer",
				"inspect.tools": "最近调用",
				"inspect.tools.count": "共 {count} 次",
				"inspect.dispatch": "派发",
				"inspect.dispatch.title": "把这个任务派给它的负责人（宿主 CAS，冲突会重报）",
				"inspect.goal.edit": "改目标",
				"inspect.goal.placeholder": "这个项目要达成什么",
				"inspect.people": "牵扯到",
				"inspect.done": "另有 {count} 个已完工",
				"inspect.blocked.wait": "等依赖",
				"inspect.blocked.deleted": "依赖没了",
				"canvas.delete.title": "删除节点",
				"canvas.delete.body": "删除「{name}」只解除画布引用：不影响会话、不影响任务。",
				"canvas.delete.affected": "受影响：{agents} 个 Agent · {tasks} 个进行中任务（标记 handed_back，不自动取消）",
				"canvas.link.deny": "这条连线不被允许：自连 / 重复连线 / 跨项目都会被拒绝",
				"canvas.link.new": "松开鼠标建关联线；删除需再次确认",
				"canvas.mcp.allowed": "可用 MCP：{servers}",
				"canvas.fallback.loading": "画布加载中…",
				"canvas.fallback.failed": "画布加载失败：{reason}",
				"canvas.fallback.unavailable": "当前 DSH 版本不支持画布（需要按需加载能力）。请更新 DSH；需求页、表格等页签不受影响。",
				"canvas.fallback.retry": "重试",
				"canvas.growth.aria": "任务进度：共 {total} 步，已完成 {done} 步",
				"canvas.agent.chip.online": "在线",
				"canvas.agent.wake": "唤醒",
				"canvas.agent.wake.title": "这个成员的会话已下线。点击把它重新拉上线（只上线，不会自动派任务）",
				"canvas.agent.wake.ok": "已唤醒：{name}",
				"canvas.agent.wake.already": "{name} 本来就在线",
				"canvas.agent.wake.notlive": "宿主已执行恢复，但会话仍未上线",
				"canvas.agent.wake.fail": "唤醒失败：{reason}",
				"canvas.agent.chip.idle": "空闲",
				"canvas.agent.chip.done": "已报完工",
				"canvas.link.reason.blocked": "等待 {task}",
				"canvas.link.reason.link": "会话关联",
				"canvas.agent.chip.done.title": "执行器已报完工，还没有人核对（reported done ≠ verified）",
				"canvas.agent.chip.draft": "草稿中",
				"canvas.agent.chip.handed_back": "待我决定",
				"canvas.agent.chip.human_action": "求人处理",
				"tasks.report.outside": "其中 {count}/{total} 个产物在声明的写入范围之外：{refs}",
				"composer.placeholder": "写给主对话的话（放入输入框后由你发送）",
				"composer.put": "放入输入框",
				"composer.put.title": "把内容放进官方输入框，不自动发送",
				"composer.put.inserted": "已放入输入框，请检查后自行发送",
				"composer.put.copied": "无法写入输入框，已复制",
				"composer.put.failed": "无法写入输入框，也无法复制，请手动选中下方文本",
				"composer.prefix.proposal": "[提案 v{version} {proposalId}] ",
				"composer.prefix.task": "[任务 {taskId} · {subject}] ",
				"composer.prefix.note": "会带上引用前缀（身份，不代写指令）",
				"composer.prefix.none": "不带前缀",
				"composer.degrade": "当前面板拿不到官方输入框，将复制到剪贴板",
				"chat.placeholder": "直接和主对话说话（Enter 发送，Shift+Enter 换行）",
				"chat.send": "发送",
				"chat.send.title": "由你点击发送到主对话（插件不会替你自动发送）",
				"chat.sending": "发送中…",
				"chat.running": "主对话正在处理…",
				"chat.idle": "空闲 · 输入后发送开始新一轮",
				"chat.empty": "还没有回复。写下目标，点发送，主对话就开始干活。",
				"chat.open": "在对话中打开",
				"chat.openFull": "查看完整对话",
				"chat.preview.question": "最近提问",
				"chat.preview.reply": "最近回复",
				"chat.unavailable": "拿不到这个会话的输入接口（宿主版本过旧或会话已关闭）",
				"chat.load.failed": "读不到回复记录：{error}",
				"chat.question.title": "主对话在问你",
				"chat.question.plan": "计划待审",
				"chat.question.status": "等你回答",
				"chat.question.multi": "可多选",
				"chat.question.custom": "其他：自己写答案",
				"chat.question.submit": "提交回答",
				"chat.question.submitting": "提交中…",
				"chat.question.incomplete": "第 {n} 题还没回答",
				"chat.question.failed": "提交失败：{error}",
				"chat.question.countdown": "{s} 秒后主对话先继续（之后仍可回答）；动一下选项就不再倒计时",
				"chat.question.readonly": "打开完整对话后即可回答",
				"chat.approval": "有一条审批在等你，请打开完整对话处理",
				"start.title": "从画布开始",
				"start.desc": "不用先开 DSH 对话：在这里写下目标并发送，系统会自动建好主对话与项目。",
				"start.entry": "✦ 从画布开始",
				"start.workspace": "工作区",
				"start.workspace.default": "默认工作区",
				"start.placeholder": "例如：给审批流引擎做表单导入导出，支持 Excel 和 JSON",
				"start.send": "发送并开始",
				"start.busy": "正在建主对话与项目…",
				"start.failed": "没能开始：{error}",
				"start.no.create": "当前宿主不支持从插件新建会话，请用「＋ 新建项目」关联已有对话",
				"start.back": "返回项目列表",
				"proposal.conversations": "组建方案：确认后将新建 {count} 个对话并加入项目（只建对话与任务，不开工）",
				"proposal.conversation.defaultPreset": "（默认 preset）",
				"proposal.expand": "展开",
				"proposal.collapse": "收起",
				"canvas.dep.deny": "依赖线两端都要是对话（Agent / Composer）",
				"canvas.dep.added": "已加依赖：{count} 条任务改为等待上游",
				"canvas.dep.same": "依赖已存在，没有变化",
				"canvas.dep.fail": "依赖没建成：{reason}",
				"canvas.mode.title": "拖锚点连线：",
				"canvas.mode.relay": "允许互发",
				"canvas.mode.dependency": "依赖",
				"canvas.mode.relay.title": "虚线：两个对话之间允许互发消息（无方向）",
				"canvas.mode.dependency.title": "实线：从上游拖到下游，下游的任务等上游完成（落库为任务依赖）",
				"canvas.legend.title": "线型",
				"canvas.legend.dependency": "实线箭头 · 依赖（下游等上游）",
				"canvas.legend.relay": "虚线 · 允许互发",
				"canvas.legend.context": "粗管 · 上下文（本轮带上）",
				"canvas.legend.flow": "流程线 · 流程图内部（是 / 否 / 例外）",
				"canvas.legend.view": "细点线 · 对话产出的视图卡",
				"canvas.legend.side": "长虚线 · 侧聊读取的对话背景",
				"canvas.side.add": "＋ 侧聊",
				"canvas.side.title": "侧聊",
				"canvas.side.readonly": "只读 · 不动原对话",
				"canvas.side.noSource": "还没连到对话：从对话卡拖一条线到这里",
				"canvas.side.empty": "连好线后在下面提问，它会先读完连着的对话再回答。",
				"canvas.side.thinking": "思考中…",
				"canvas.side.cancel": "取消",
				"canvas.side.cancelled": "已取消",
				"canvas.side.failed": "没答成：",
				"canvas.side.placeholder": "问点什么（Enter 发送，Shift+Enter 换行）",
				"canvas.side.send": "发送",
				"canvas.side.remove": "删除侧聊",
				"canvas.side.linkfail": "侧聊连线失败：{reason}",
				"canvas.side.deny": "侧聊只能连到对话卡（Agent / Composer）",
				"canvas.side.unlink": "断开这条背景线",
				"canvas.view.untitled": "视图",
				"canvas.view.answerfail": "提交失败：{reason}",
				"canvas.node.file": "文件",
				"canvas.node.link.notion": "Notion",
				"canvas.node.link.feishu": "飞书",
				"canvas.node.link.web": "网页",
				"canvas.file.fold": "还有 {count} 个较早的文件",
				"canvas.file.mark.read": "读过",
				"canvas.file.mark.write": "改过",
				"canvas.file.mark.ref": "@引用",
				"canvas.flow.ai": "AI 生成 {count}",
				"canvas.flow.add": "＋ 步骤",
				"canvas.flow.undo": "撤销 AI 生成",
				"canvas.flow.evidence": "来源消息：{refs}（AI 生成，人改过就锁定）",
				"canvas.flow.edit": "改这一步的文字（改过之后 AI 重画不会覆盖）",
				"canvas.flow.newStep": "新步骤",
				"canvas.flow.label": "连线标签（是 / 否 / 例外，可留空）",
				"canvas.flow.connectDeny": "流程线只能连同一张流程图里的两个步骤",
				"canvas.flow.fail": "流程图没改成：{reason}",
				"canvas.flow.summary": "流程图「{title}」· {count} 个步骤（新画布里查看与编辑）",
				"canvas.proto.edit": "编辑",
				"canvas.proto.loading": "组件包加载中…",
				"canvas.proto.packFailed": "组件包加载失败：",
				"canvas.proto.editorLoading": "原型编辑器加载中（约 1MB，只在第一次编辑时下载）…",
				"canvas.proto.editorFailed": "原型编辑器加载失败：{reason}",
				"canvas.proto.add": "＋ 原型帧",
				"canvas.design.component": "组件",
				"canvas.design.artboard": "画板",
				"canvas.design.ai": "AI",
				"canvas.design.usedBy": "被用",
				"canvas.design.example": "例子",
				"canvas.design.edit": "编辑",
				"canvas.proto.blank": "新页面",
				"canvas.library.add": "＋ 组件库",
				"canvas.library.exists": "画布上已经有组件库节点了：在它上面切换组件包即可",
				"canvas.library.title": "组件库",
				"canvas.library.coverage": "覆盖通用词表",
				"canvas.library.missing": "缺",
				"canvas.library.local": "本地",
				"canvas.library.import": "导入自己的组件包（如 CDS）：放到 ",
				"canvas.library.usedBy": "原型 × ",
				"tasks.verify.done": "已核对",
				"tasks.verify.by": "由 {by} 核对",
				"tasks.verify.reviewed": "评审已报通过",
				"tasks.verify.reviewed.title": "评审任务 {task} 已报完工（执行器自报，未经人工核对）",
				"tasks.action.verify": "核对通过",
				"canvas.agent.chip.verified": "已核对",
				"canvas.growth.title": "生长进度 · {done}/{total}",
				"canvas.growth.step.source": "来源",
				"canvas.growth.step.worker": "执行",
				"tasks.filter.all": "全部",
				"tasks.filter.pending": "待办",
				"tasks.filter.in_progress": "进行中",
				"tasks.filter.completed": "已完成",
				"tasks.filter.blocked": "被阻塞",
				"tasks.new": "＋ 新建任务",
				"tasks.col.task": "任务",
				"tasks.col.owner": "owner",
				"tasks.col.blockedBy": "依赖",
				"tasks.col.worktree": "落点",
				"tasks.col.report": "report",
				"tasks.col.status": "状态",
				"tasks.status.pending": "待处理",
				"tasks.status.in_progress": "进行中",
				"tasks.status.completed": "已完成",
				"tasks.status.deleted": "已删除",
				"tasks.blocked.deleted": "前置已删除",
				"tasks.blocked.wait": "等待前置",
				"tasks.report.done": "done 完成",
				"tasks.report.draft": "draft 草稿",
				"tasks.report.handed_back": "handed_back 退回",
				"tasks.report.human_action": "human_action 求人",
				"tasks.report.note": "done / draft worker 可写；handed_back / human_action 只能人关 · 冲突重报不覆盖",
				"tasks.action.assign": "指派",
				"tasks.action.dispatch": "派发",
				"tasks.action.reopen": "重开",
				"tasks.action.unassign": "取消指派",
				"tasks.action.report": "写 report",
				"tasks.assign.title": "指派「{subject}」",
				"tasks.assign.owner": "负责人（项目成员）",
				"tasks.assign.dispatch": "指派后立即派发",
				"tasks.report.title": "写 report · 「{subject}」",
				"tasks.report.summary": "结论摘要",
				"tasks.report.artifacts": "产物（文件或链接，每行一条）",
				"tasks.report.conflict": "别人已改过这条 report（{code}）→ 重报，不覆盖、无强制写",
				"brief.desc": "两者共用 2000 token 总预算；返回带 version / updatedAt / truncated / omitted",
				"brief.project": "项目简报",
				"brief.goal": "目标",
				"brief.decisions": "已定决策",
				"brief.constraints": "约束",
				"brief.budget": "预算 {used} / 2000 token",
				"brief.save": "保存（基于 v{version}）",
				"brief.cas": "版本 CAS：expectedVersion 必须等于当前 v{version}",
				"brief.conflict": "简报已被更新（当前 v{latest}，你编辑时基于 v{base}）— 请刷新后再改。",
				"brief.conversation": "对话简报",
				"brief.proxy": "代写",
				"brief.proxyNote": "人可代写并标「代写」；对话之间不能互相代写，主对话也不行。",
				"brief.duty": "职责",
				"brief.conclusions": "当前结论",
				"brief.artifacts": "产物清单",
				"brief.readin": "读入本轮",
				"brief.foot": "每轮自动注入全量上下文已被否决：简报与对话摘要共用 2000 token 预算，超出按「最近 + 相关」裁剪，不静默丢",
				"exec.ticket.state": "{state} · {elapsed}",
				"exec.ticket.owner": "owner {owner}",
				"exec.ticket.where": "{worktree} · dsh-agent-whales-worker",
				"exec.ticket.first": "落点是一等字段",
				"exec.ticket.full": "查看完整日志",
				"exec.ticket.report": "写 report",
				"exec.ticket.note": "worker 只能发起 handed_back，关闭只能人做",
				"exec.today": "今日完成 {count}",
				"exec.today.note": "done = 人已确认关闭",
				"auto.title": "唤醒后自动派任务",
				"auto.desc": "成员被唤醒后，把挂在 ta 名下、因离线而没发出去的任务自动补发。默认 L2：先挂起一小段时间，你可以撤销。",
				"auto.tier.L1": "L1 不自动派",
				"auto.tier.L2": "L2 有撤销窗口",
				"auto.tier.L3": "L3 立即派",
				"auto.tier.L1.note": "唤醒只上线，任务仍等你手动发。",
				"auto.tier.L2.note": "唤醒后挂起 {seconds} 秒再发，期间可撤销。",
				"auto.tier.L3.note": "唤醒后立即发，没有撤销窗口。",
				"auto.approval": "自动派发的任务遇到审批",
				"auto.approval.wait": "停在「等你」（默认）",
				"auto.approval.approve-all": "全部同意",
				"auto.approval.approve-all.note": "只批准自动派发的在办任务名下的请求，每次批准都写审计；其它请求仍停在「等你」。",
				"auto.limits": "限额",
				"auto.limit.perMemberPerMinute": "每成员每分钟（条）",
				"auto.limit.projectConcurrent": "项目同时在派（条）",
				"auto.limit.maxChainDepth": "连锁层数",
				"auto.limit.save": "保存限额",
				"auto.confirm.title": "确认放宽",
				"auto.confirm.L3": "L3 会在唤醒后立即发出任务，没有撤销窗口。确认由你为这个项目开启？",
				"auto.confirm.approve-all": "「全部同意」会在不经你点击的情况下批准自动派发任务的审批请求。确认由你为这个项目开启？",
				"auto.confirm.ok": "确认开启",
				"auto.pending": "等待发出（{count}）",
				"auto.pending.row": "{task} · {seconds} 秒后发出",
				"auto.pending.undo": "撤销",
				"auto.pending.undone": "已撤销：{task}",
				"auto.pending.gone": "这条已经发出或不存在",
				"auto.audit": "最近记录",
				"auto.audit.empty": "还没有自动派发记录",
				"auto.saved": "已保存",
				"auto.fail": "保存失败：{reason}",
				"exec.popover.human": "只能人关",
				"inbox.title": "需要我处理（{count}）",
				"inbox.desc": "只汇总需要人决定的事；不替用户做决定，也不自动重派",
				"inbox.group.proposals": "提案待确认",
				"inbox.action.proposal": "查看提案",
				"inbox.action.requirement": "去处理（打开画布）",
				"inbox.action.report": "查看 report · 给人决定",
				"inbox.action.handed": "查看 report · 改派或关闭",
				"inbox.action.task": "查看任务",
				"inbox.foot": "human_action / handed_back 来自 worker 的 report：worker 只能发起，关闭只能人把 report 改 done 或删除任务",
				"activity.events": "事件时间线（只读）",
				"activity.events.desc": "插件记录的提案提交 / 任务命令 / 交接结果 / 存储降级事件，按时间倒序，最近 30 条。主会话消息、工作区监听、定时三类来源本期没有接入。",
				"handoff.title": "发送记录",
				"handoff.desc": "已产出 ≠ 已送达：发送 / 失败 / 结果未知三态分开报，未知不自动重派",
				"handoff.export": "导出证据",
				"handoff.col.time": "时间",
				"handoff.col.route": "从 → 到",
				"handoff.col.summary": "消息摘要",
				"handoff.col.result": "结果",
				"handoff.col.evidence": "证据",
				"handoff.result.sent": "已发送",
				"handoff.result.failed": "失败（对方未运行）",
				"handoff.result.unknown": "结果未知（不自动重派）",
				"handoff.legend": "三态：",
				"handoff.note": "不承诺「恰好一次」：重启后只能回「可能已生效」",
				"event.state.pending": "待评估",
				"event.state.opened": "已开工单",
				"replay.title": "任务过程 · {subject}",
				"replay.entries": "明细流水",
				"replay.foot": "replay 记「任务怎么来的、怎么跑的」；发送记录记「消息送到没有」。两者不合并：「已回复」不等于 report 为 done。",
				"replay.open": "查看过程",
				"replay.step.source": "Source",
				"replay.step.trigger": "Trigger",
				"replay.step.policy": "Policy",
				"replay.step.ticket": "Ticket",
				"replay.step.worker": "Worker",
				"replay.step.report": "Report",
				"replay.step.extra": "其他",
				"replay.state.done": "已完成",
				"replay.state.active": "进行中",
				"replay.state.pending": "未开始",
				"replay.state.skipped": "跳过",
				"replay.obs.current": "当前工具：{tool} · {elapsed}",
				"replay.obs.commands": "跑命令 {count} 次",
				"replay.obs.files": "写文件 {count} 个",
				"replay.obs.note": "计数是执行会话口径（跨任务累计），不是这个任务单独跑的量",
				"replay.empty": "这个任务还没有过程记录。",
				"event.action.note": "开工单 = 进任务表 + 执行台；忽略 = 留痕不建单",
				"event.empty": "还没有事件：主会话消息、工作区变更与定时触发会先进这里评估。",
				"set.menu.look": "外观",
				"set.menu.advanced": "高级",
				"set.loading": "加载中…",
				"set.mcp.title": "MCP 约束",
				"set.mcp.project": "项目",
				"set.mcp.noProject": "还没有项目：先建一个项目，才能给它的对话限定 MCP。",
				"set.mcp.rule": "给项目里的对话限定可用的 MCP 服务。规则：一个对话只要被勾选过任何服务，就「只能用被勾选的那些」；一个都没勾选（没有连过）= 不受限，想用什么用什么。所以勾选是「收紧」，不是「放行」。",
				"set.mcp.restricted": "当前有 {count} 个对话受限",
				"set.mcp.unrestricted": "当前没有任何对话受限",
				"set.mcp.tools": "{count} 个工具",
				"set.mcp.only": "只能用：{servers}",
				"set.mcp.free": "不受限",
				"set.mcp.empty": "当前没有可用的 MCP 服务：先在 DSH 里连上 MCP server。",
				"set.mcp.stale": "有 {count} 条约束指向已不在项目里的对话（宿主仍保留；一键全清可以去掉）",
				"set.mcp.fail": "操作失败：{reason}",
				"set.mcp.clear": "一键全清",
				"set.mcp.clear.confirm": "再点一次确认：清空该项目的全部 MCP 约束",
				"set.mcp.cleared": "已清空该项目的全部 MCP 约束",
				"set.snapshot.title": "数据快照",
				"set.theme": "外观 · 主题",
				"set.theme.light": "浅色",
				"set.theme.system": "跟随系统",
				"set.theme.dark": "暗色",
				"set.foot": "适用于画布和工作台",
				"draft.prefix": "关于提案 v{version}（{proposalId}）：",
				"draft.insert": "带入",
				"draft.insert.title": "把提案引用带进输入框，接着写你的修改意见",
				"draft.insert.locked": "已锁定的提案，改提案请提交新提案",
				"draft.insert.clipboard": "当前面板拿不到输入框，将复制到剪贴板",
				"draft.state.inserted": "已带入，请回车发送",
				"draft.state.copied": "无法写入输入框，已复制",
				"draft.state.failed": "无法写入输入框，请手动复制：",
				"draft.boundary": "“带入”只服务「让 Lead 改提案」；永不显示“已发送”，提交仍由你在官方输入框回车。",
				"goal.label": "目标",
				"goal.from.session": "来源：会话标题（读不到目标消息首行）",
				"goal.status": "提案 v{version} 待确认",
				"goal.status.locked": "提案 v{version} 已确认、已锁定",
				"goal.view": "查看",
				"goal.view.none": "没找到这条提案所属的项目，只显示状态",
				"chat.canvas.open": "项目画布",
				"chat.canvas.hint": "在右侧打开项目画布",
				"chat.canvas.failed": "项目画布暂时打不开，请稍后重试",
				"about.desc": "鲸鱼娘是角色的表现层，不是产品模型本身；权威状态只看卡片与徽标。"
			},
			en: {
				"nav.projects": "Projects",
				"nav.inbox": "Needs me",
				"inbox.empty": "Nothing needs attention",
				"nav.settings": "Settings",
				"top.running": "{count} running",
				"top.back": "Back to Chat",
				"top.refresh": "Refresh",
				"top.toList": "Back to project list",
				"list.title": "Projects",
				"list.desc": "Each project is an isolated container: one main conversation, member conversations, and one task table",
				"list.new": "＋ New project",
				"list.export": "Export snapshot (ZIP)",
				"list.export.desc": "Download the five data files (projects / canvas / handoffs / events / proposals) as a backup. Contains session ids and task text; no credentials",
				"list.export.busy": "Packing snapshot…",
				"list.export.done": "Exported {n} files (ZIP)",
				"list.export.failed": "Export failed: {reason}",
				"list.stat.active": "Active projects",
				"list.stat.inbox": "Needs me",
				"list.stat.tickets": "Running tickets",
				"list.card.members": "{count} members",
				"list.card.tasks": "Tasks {done}/{total}",
				"req.title": "Requirements",
				"req.empty": "No requirements yet",
				"req.empty.hint": "The first one is created automatically when the Composer draws a flowchart or prototype",
				"req.virtual.title": "Older tasks and prototypes",
				"req.virtual": "Unassigned",
				"req.virtual.hint": "Older tasks / prototypes not tied to any requirement",
				"req.stage.clarify": "Clarify",
				"req.stage.design": "Design",
				"req.stage.develop": "Build",
				"req.stage.accept": "Accept",
				"req.stage.mismatch": "Mismatch",
				"req.stage.passed": "Passed",
				"req.attention": "Needs you",
				"req.attention.confirm-design": "Confirm design",
				"req.attention.e2e-mismatch": "Acceptance mismatch",
				"req.attention.rework-limit": "Rework limit hit",
				"req.meta": "Tasks {done}/{total} · Prototypes {protos}",
				"req.design": "Design v{v}",
				"req.design.none": "Design unconfirmed",
				"req.prd.edit": "Edit PRD",
				"req.prd.empty": "Add Markdown, a workspace file, or a document link.",
				"req.prd.mode": "PRD source",
				"req.prd.markdown": "Markdown",
				"req.prd.file": "Workspace Markdown file",
				"req.prd.link": "Notion or web link",
				"req.prd.summary": "Summary (optional)",
				"req.prd.refresh": "Refresh from file",
				"req.prd.notion": "Open in Notion",
				"req.prd.acceptance": "Acceptance criteria",
				"req.next": "Next",
				"req.more": "{n} more requirements",
				"req.new": "+ New requirement",
				"req.new.title": "New requirement",
				"req.new.name": "Requirement name",
				"req.new.goal": "Goal (optional)",
				"req.new.fail": "Create failed: {reason}",
				"tab.reqs": "Requirements",
				"tab.note.reqs": "A requirement from clarify to accept: design confirmation, E2E runs, annotations and send-back",
				"req.page.desc": "Each requirement has its own design version, tasks and acceptance. Click one for details.",
				"req.back": "← Back to requirements",
				"req.section.design": "Design",
				"req.section.e2e": "E2E acceptance",
				"req.design.confirm": "Confirm design",
				"req.review.boardTools": "Artboard tools",
				"req.review.design": "Design",
				"req.review.handoff": "Handoff",
				"req.review.testing": "Testing",
				"req.review.chooseBoard": "Choose a design",
				"req.review.noHandoff": "Confirm a design to choose a frontend conversation and track delivery here.",
				"req.review.editLive": "Edit live design",
				"req.review.history": "Past handoffs ({n})",
				"req.review.current": "Current confirmation",
				"req.review.annotate": "Mark a change",
				"req.handoff.title": "Frontend handoff",
				"req.handoff.pending": "The handoff changed. Confirm a new version before sending it.",
				"req.handoff.pick": "Choose a frontend conversation",
				"req.handoff.send": "Send to frontend",
				"req.handoff.retry": "Retry sending",
				"req.handoff.preview": "View confirmed design",
				"req.handoff.hide": "Collapse confirmed design",
				"req.handoff.sending": "Sending",
				"req.handoff.sent": "Sent · Waiting for progress",
				"req.handoff.failed": "Delivery failed",
				"req.handoff.offline": "Delivery failed · Conversation sleeping",
				"req.handoff.unknown": "Delivery unconfirmed",
				"req.handoff.draft": "Progress reported",
				"req.handoff.done": "Delivered",
				"req.handoff.prd": "PRD v{v}",
				"req.handoff.noPrd": "No PRD attached",
				"req.handoff.external": "The external link opens the current document. The confirmed version retains the link and any attached summary.",
				"req.handoff.missing": "Designs missing source files",
				"req.design.open": "View prototype on canvas",
				"canvas.design.prototype": "Prototype",
				"canvas.design.annotate": "Annotate",
				"canvas.design.editDirect": "Edit directly",
				"canvas.design.chatOpen": "Open in canvas",
				"canvas.design.chatLoading": "Loading preview…",
				"canvas.design.chatUnavailable": "The preview failed to load. Open it in the canvas to view it.",
				"canvas.design.chatBack": "Back to previous screen",
				"req.design.reviewHint": "Review the design, leave comments on artboard elements, or open the canvas to edit. Confirming freezes the current content as a new design version.",
				"req.design.empty": "This requirement has no prototype or artboard yet.",
				"req.design.comments": "Open annotations",
				"req.design.resolve": "Mark resolved",
				"req.design.commentResolved": "Annotation marked as resolved",
				"req.design.openCanvas": "Edit on canvas",
				"req.run.start": "Start acceptance",
				"req.run.finish": "Finish this run",
				"req.run.none": "No runs yet. One is created automatically once all tasks are done (switch to manual in settings), or click \"Start acceptance\".",
				"req.run.meta": "driver {driver} · design {v}",
				"req.run.status.queued": "Queued",
				"req.run.status.running": "Running",
				"req.run.status.passed": "Passed",
				"req.run.status.failed": "Mismatch",
				"req.run.status.error": "Error",
				"req.case.status.pending": "Pending",
				"req.case.status.running": "Running",
				"req.case.status.passed": "Passed",
				"req.case.status.accepted": "Accepted",
				"req.case.status.failed": "Mismatch",
				"req.case.status.error": "Error",
				"req.case.mark.passed": "Mark passed",
				"req.case.mark.failed": "Mark mismatch",
				"req.case.accept": "Accept as is",
				"req.case.reflowed": "Sent back · {to}",
				"req.case.diagnosis": "Initial call ({who}, {kind}): {reason}",
				"req.by.ai": "AI",
				"req.by.user": "human",
				"req.reflow": "Send back for rework",
				"req.reflow.code": "implementation",
				"req.reflow.design": "design",
				"req.reflow.requirement": "requirement",
				"req.limit": "Reworked {n} times (limit {cap}); no more automatic send-backs. Re-review the requirement, or accept the issue as is.",
				"req.ann.add": "Add note",
				"req.ann.hint": "Drag a box on the screenshot, or just write what you expected",
				"req.ann.boxed": "Boxed — write what you expected",
				"req.ann.placeholder": "What did you expect to see",
				"req.ann.save": "Save note",
				"req.ann.expected": "Expected",
				"req.ann.sent": "Sent back",
				"req.ann.remove": "Remove",
				"req.shot.upload": "Upload screenshot",
				"canvas.req.new": "+ New requirement",
				"req.filter.title": "Filter requirements",
				"req.owner": "Owner",
				"req.owner.none": "Unassigned",
				"req.owner.set": "Owner: {name}",
				"req.owner.unset": "No owner",
				"req.owner.hint": "Pick one conversation in this project to own this requirement: design / requirement send-backs from acceptance go to it first. If it is offline you are told it was not delivered; nothing is quietly redirected.",
				"req.filter.owner.title": "Filter by owner",
				"req.filter.owner.all": "All owners",
				"req.filter.owner.none": "No owner",
				"canvas.zoom.far": "Far: status only",
				"canvas.zoom.mid": "Mid: summary",
				"canvas.zoom.near": "Near: full text",
				"canvas.zoom.hint": "Scroll to zoom: zoom out for status only, zoom in for full text",
				"req.filter.all": "All",
				"req.filter.attention": "Needs me",
				"req.filter.mismatch": "E2E mismatch",
				"req.filter.active": "In progress",
				"req.filter.passed": "Passed",
				"req.filter.empty": "No requirement matches this filter",
				"canvas.req.open": "Requirements · {n} need you",
				"canvas.req.title": "Open the requirements page: design, acceptance and rework per requirement",
				"canvas.req.more": "Only the first 12 requirements are drawn on the canvas; {n} more. Click to see them all on the requirements page",
				"req.cfg.title": "E2E acceptance settings",
				"req.cfg.summary": "Trigger: {trigger} · Driver: {driver}",
				"req.cfg.edit": "Edit",
				"req.cfg.collapse": "Collapse",
				"req.cfg.trigger": "Trigger",
				"req.cfg.trigger.auto": "Automatically once all tasks are done",
				"req.cfg.trigger.manual": "A human clicks \"Start acceptance\"",
				"req.cfg.driver": "Driver",
				"req.cfg.driver.manual": "Manual (a human uploads screenshots and marks results)",
				"req.cfg.driver.tabbit-cli": "tabbit CLI (web)",
				"req.cfg.driver.computer-use": "computer use (experimental)",
				"req.cfg.executor": "Executor session",
				"req.cfg.executor.none": "(none)",
				"req.cfg.cu.warn": "computer use needs the third-party plugin dsh-kimi-assemble and KimiCU, which you install yourself. Only read-only observation has been verified; actions such as click / type are not, and they briefly take over the real mouse and keyboard. Without those tools the executor reports cases as \"error\".",
				"req.cfg.baseUrl": "Base URL (optional)",
				"req.cfg.save": "Save settings",
				"req.cfg.saved": "Saved",
				"req.cfg.needExecutor": "A non-manual driver needs an executor session.",
				"list.empty.title": "No projects yet",
				"list.empty.desc": "The canvas has no default view; opening the project panel needs a project.",
				"list.empty.create": "Create project (pick main conversation)",
				"list.empty.join": "Join existing conversation",
				"list.join.title": "Join an existing conversation",
				"list.join.archived": "Archived · joinable, not auto-resumed",
				"list.join.taken": "Already in another project (40701)",
				"list.join.action": "Join",
				"common.loading": "Loading…",
				"common.error": "Cannot load data",
				"common.retry": "Retry",
				"canvas.session.unbound": "This conversation is not in a Whales project yet. Ask the agent to draw a flowchart or prototype to create its project canvas automatically.",
				"common.none": "—",
				"common.close": "Close",
				"common.cancel": "Cancel",
				"common.confirm": "Confirm",
				"common.save": "Save",
				"common.refresh": "Refresh",
				"tab.canvas": "Canvas",
				"tab.table": "Tasks",
				"tab.table.count": "Unfinished tasks: {count}",
				"tab.tasks": "Tasks",
				"tab.brief": "Project brief",
				"tab.exec": "Execution",
				"tab.office": "Office",
				"office.members": "Desks: {count}",
				"office.attention": "Waiting for you: {count}",
				"office.room.page": "Room {page}/{total}",
				"office.room.prev": "Previous room",
				"office.room.next": "Next room",
				"office.empty": "No members in this project yet. Add a conversation to the project and it gets a desk here.",
				"office.pose.idle": "Idle",
				"office.pose.type": "Writing",
				"office.pose.read": "Reading",
				"office.pose.run": "Running a command",
				"office.pose.think": "Thinking",
				"office.pose.wait": "Waiting for you",
				"office.pose.done": "Just finished",
				"office.pose.oops": "Hit an error",
				"office.pose.sleep": "Offline",
				"office.tool": "Using: {tool}",
				"office.open": "Open conversation",
				"office.main": "Main",
				"office.untitled": "Untitled conversation · {id}",
				"office.scene.label": "Office scene",
				"office.scene.auto": "Auto",
				"office.scene.day": "Day",
				"office.scene.night": "Night",
				"office.scene.schedule": "Daylight from 07:00 to 19:00 local time",
				"office.task.assigned": "Assigned task",
				"office.task.active": "Task in progress",
				"office.task.blocked": "Blocked task",
				"office.task.none": "No assigned task",
				"office.task.loading": "Loading tasks",
				"office.task.unavailable": "Tasks unavailable",
				"office.wait.approval": "Waiting for your approval",
				"office.wait.question": "Waiting for your answer",
				"office.wait.plan-review": "Waiting for your plan review",
				"office.wait.report": "Task report needs your attention",
				"office.wait.member": "Waiting for {name} to finish {task}",
				"office.wait.task": "Waiting for {task}",
				"office.wait.removed": "Dependency was removed",
				"tab.note.canvas": "Super canvas: conversation / Agent / context / files / flowcharts / prototypes on one board",
				"tab.note.table": "Task table (with requirement / dependencies / commands) + execution status (tickets, log tail, report, auto-dispatch)",
				"tab.note.tasks": "Tasks live in the plugin task table; blockedBy dependencies stay here, never on the canvas",
				"tab.note.brief": "Shared context is two layers: project brief + on-demand reads; per-turn injection was rejected",
				"tab.note.exec": "Workers run unattended in a sub-worktree; humans watch status, log tail and report",
				"canvas.link.empty": "No handoff between these two yet",
				"canvas.link.count": "{count} total",
				"canvas.link.fromUser": "You",
				"canvas.addAgent": "＋ Add Agent",
				"canvas.addAgent.none": "No session available",
				"canvas.addAgent.modal": "Add an Agent to the canvas",
				"canvas.addAgent.ok": "Add",
				"canvas.goal": "Goal: {goal}",
				"canvas.goal.none": "No goal yet: add one in the brief",
				"canvas.node.folder": "Folder · local",
				"canvas.node.agent": "Agent",
				"canvas.node.composer": "Main conversation",
				"canvas.empty": "No tasks on the canvas yet. Pick a context and send, or add an Agent first.",
				"canvas.empty.send": "Send to main conversation",
				"canvas.empty.put": "Put goal into input",
				"canvas.empty.put.title": "Puts the project goal into the official input; no panel switch, no auto-send",
				"canvas.zoom": "Zoom",
				"canvas.zoomFit": "Fit",
				"canvas.minimap": "Minimap",
				"canvas.minimap.jump": "Minimap · click to jump",
				"canvas.grid": "Grid",
				"canvas.guide": "Guide",
				"canvas.hint": "Wheel vertical · Shift+wheel horizontal · Ctrl+wheel zoom · drag blank to pan · double-click a node to edit",
				"inspect.kind.link": "Link",
				"inspect.kind.agent": "Agent",
				"inspect.kind.folder": "Target",
				"inspect.kind.composer": "Composer",
				"inspect.tools": "Recent calls",
				"inspect.tools.count": "{count} calls",
				"inspect.dispatch": "Dispatch",
				"inspect.dispatch.title": "Dispatch this task to its owner (host CAS, conflicts are re-reported)",
				"inspect.goal.edit": "Edit goal",
				"inspect.goal.placeholder": "What this project should achieve",
				"inspect.people": "Involves",
				"inspect.done": "{count} more completed",
				"inspect.blocked.wait": "waiting on dependency",
				"inspect.blocked.deleted": "dependency gone",
				"canvas.delete.title": "Delete node",
				"canvas.delete.body": "Deleting “{name}” only drops the canvas reference: sessions and tasks are untouched.",
				"canvas.delete.affected": "Affected: {agents} Agents · {tasks} in-progress tasks (marked handed_back, never auto-cancelled)",
				"canvas.link.deny": "This link is not allowed: self-links, duplicates and cross-project links are rejected",
				"canvas.link.new": "Release to create the link; deleting needs confirmation",
				"canvas.mcp.allowed": "Allowed MCP: {servers}",
				"canvas.fallback.loading": "Loading canvas…",
				"canvas.fallback.failed": "Canvas failed to load: {reason}",
				"canvas.fallback.unavailable": "This DSH version cannot show the canvas (it needs on-demand loading). Please update DSH; the Requirements and other tabs still work.",
				"canvas.fallback.retry": "Retry",
				"canvas.growth.aria": "Task progress: {done} of {total} steps done",
				"canvas.agent.chip.online": "online",
				"canvas.agent.wake": "Wake",
				"canvas.agent.wake.title": "This member's session is offline. Click to bring it back online (it only comes online; no task is dispatched)",
				"canvas.agent.wake.ok": "Woke {name}",
				"canvas.agent.wake.already": "{name} was already online",
				"canvas.agent.wake.notlive": "The host ran the resume, but the session is still not online",
				"canvas.agent.wake.fail": "Wake failed: {reason}",
				"canvas.agent.chip.idle": "idle",
				"canvas.agent.chip.done": "reported done",
				"canvas.link.reason.blocked": "waits on {task}",
				"canvas.link.reason.link": "session link",
				"canvas.agent.chip.done.title": "The executor reported done; nobody has verified it yet (reported done ≠ verified)",
				"canvas.agent.chip.draft": "draft",
				"canvas.agent.chip.handed_back": "needs you",
				"canvas.agent.chip.human_action": "asks a human",
				"tasks.report.outside": "{count} of {total} artifacts fall outside the declared write scopes: {refs}",
				"composer.placeholder": "A note for the main conversation (put into the input, you send it)",
				"composer.put": "Put into input",
				"composer.put.title": "Puts the text into the official input; does not send",
				"composer.put.inserted": "Put into the input — review and send it yourself",
				"composer.put.copied": "Cannot write to the input; copied instead",
				"composer.put.failed": "Cannot write to the input or copy; select the text manually",
				"composer.prefix.proposal": "[proposal v{version} {proposalId}] ",
				"composer.prefix.task": "[task {taskId} · {subject}] ",
				"composer.prefix.note": "A reference prefix is added (identity only, no instructions)",
				"composer.prefix.none": "No prefix",
				"composer.degrade": "This panel cannot reach the official input; the text will be copied instead",
				"chat.placeholder": "Talk to the main conversation directly (Enter sends, Shift+Enter for a new line)",
				"chat.send": "Send",
				"chat.send.title": "Sent to the main conversation because you clicked; the plugin never sends on its own",
				"chat.sending": "Sending…",
				"chat.running": "The main conversation is working…",
				"chat.idle": "Idle · send to start a new turn",
				"chat.empty": "No reply yet. Write the goal and send; the main conversation starts working.",
				"chat.open": "Open in chat",
				"chat.openFull": "Read full conversation",
				"chat.preview.question": "Latest question",
				"chat.preview.reply": "Latest reply",
				"chat.unavailable": "This conversation's input is not reachable (old host or closed session)",
				"chat.load.failed": "Cannot read replies: {error}",
				"chat.question.title": "The main conversation is asking you",
				"chat.question.plan": "Plan awaiting review",
				"chat.question.status": "Waiting for your answer",
				"chat.question.multi": "Multiple choice",
				"chat.question.custom": "Other: write your own answer",
				"chat.question.submit": "Submit answer",
				"chat.question.submitting": "Submitting…",
				"chat.question.incomplete": "Question {n} is not answered yet",
				"chat.question.failed": "Submit failed: {error}",
				"chat.question.countdown": "The conversation moves on in {s}s (you can still answer later); touching an option stops the countdown",
				"chat.question.readonly": "Open the full conversation to answer",
				"chat.approval": "Open the full conversation to review the pending approval",
				"start.title": "Start from the canvas",
				"start.desc": "No DSH conversation needed first: write the goal here and send; the main conversation and the project are created for you.",
				"start.entry": "✦ Start from canvas",
				"start.workspace": "Workspace",
				"start.workspace.default": "Default workspace",
				"start.placeholder": "e.g. Add form import/export to the approval engine, Excel and JSON",
				"start.send": "Send and start",
				"start.busy": "Creating the main conversation and project…",
				"start.failed": "Could not start: {error}",
				"start.no.create": "This host cannot create conversations from plugins; use \"+ New project\" with an existing conversation",
				"start.back": "Back to projects",
				"proposal.conversations": "Team plan: confirming creates {count} conversations and adds them to the project (creates only; nothing starts)",
				"proposal.conversation.defaultPreset": " (default preset)",
				"proposal.expand": "Expand",
				"proposal.collapse": "Collapse",
				"canvas.dep.deny": "Both ends of a dependency must be conversations (Agent / Composer)",
				"canvas.dep.added": "Dependency added: {count} tasks now wait for upstream",
				"canvas.dep.same": "Dependency already exists; nothing changed",
				"canvas.dep.fail": "Dependency not created: {reason}",
				"canvas.mode.title": "Drag to connect:",
				"canvas.mode.relay": "May message",
				"canvas.mode.dependency": "Depends on",
				"canvas.mode.relay.title": "Dashed: the two conversations may message each other (undirected)",
				"canvas.mode.dependency.title": "Solid: drag from upstream to downstream; downstream tasks wait (stored as task dependencies)",
				"canvas.legend.title": "Lines",
				"canvas.legend.dependency": "Solid arrow · dependency (downstream waits)",
				"canvas.legend.relay": "Dashed · may message",
				"canvas.legend.context": "Thick pipe · context (included this turn)",
				"canvas.legend.flow": "Flow line · inside a flowchart (yes / no / exception)",
				"canvas.legend.view": "Fine dots · view card a conversation produced",
				"canvas.legend.side": "Long dashes · conversation a side chat reads",
				"canvas.side.add": "+ Side chat",
				"canvas.side.title": "Side chat",
				"canvas.side.readonly": "Read-only · leaves the original alone",
				"canvas.side.noSource": "Not linked yet: drag a line here from a conversation card",
				"canvas.side.empty": "Once linked, ask below: it reads the linked conversations first, then answers.",
				"canvas.side.thinking": "Thinking…",
				"canvas.side.cancel": "Cancel",
				"canvas.side.cancelled": "Cancelled",
				"canvas.side.failed": "No answer: ",
				"canvas.side.placeholder": "Ask something (Enter to send, Shift+Enter for a new line)",
				"canvas.side.send": "Send",
				"canvas.side.remove": "Delete side chat",
				"canvas.side.linkfail": "Side chat link failed: {reason}",
				"canvas.side.deny": "A side chat can only link to a conversation card (Agent / Composer)",
				"canvas.side.unlink": "Unlink this context line",
				"canvas.view.untitled": "View",
				"canvas.view.answerfail": "Submit failed: {reason}",
				"canvas.node.file": "File",
				"canvas.node.link.notion": "Notion",
				"canvas.node.link.feishu": "Feishu",
				"canvas.node.link.web": "Web",
				"canvas.file.fold": "{count} older files",
				"canvas.file.mark.read": "read",
				"canvas.file.mark.write": "edited",
				"canvas.file.mark.ref": "@mentioned",
				"canvas.flow.ai": "AI-generated {count}",
				"canvas.flow.add": "+ Step",
				"canvas.flow.undo": "Undo AI drawing",
				"canvas.flow.evidence": "Source messages: {refs} (AI-generated; locked once you edit)",
				"canvas.flow.edit": "Edit this step (AI redraws will not overwrite your edit)",
				"canvas.flow.newStep": "New step",
				"canvas.flow.label": "Edge label (yes / no / exception, optional)",
				"canvas.flow.connectDeny": "Flow lines only connect two steps of the same flowchart",
				"canvas.flow.fail": "Flowchart not changed: {reason}",
				"canvas.flow.summary": "Flowchart \"{title}\" · {count} steps (view and edit in the new canvas)",
				"canvas.proto.edit": "Edit",
				"canvas.proto.loading": "Loading component pack…",
				"canvas.proto.packFailed": "Component pack failed to load: ",
				"canvas.proto.editorLoading": "Loading prototype editor (~1MB, first edit only)…",
				"canvas.proto.editorFailed": "Prototype editor failed to load: {reason}",
				"canvas.proto.add": "+ Prototype",
				"canvas.design.component": "Component",
				"canvas.design.artboard": "Artboard",
				"canvas.design.ai": "AI",
				"canvas.design.usedBy": "Used by",
				"canvas.design.example": "Example",
				"canvas.design.edit": "Edit",
				"canvas.proto.blank": "New page",
				"canvas.library.add": "+ Component library",
				"canvas.library.exists": "The canvas already has a component library node; switch packs on it",
				"canvas.library.title": "Component library",
				"canvas.library.coverage": "Covers vocabulary",
				"canvas.library.missing": "missing",
				"canvas.library.local": "local",
				"canvas.library.import": "Import your own pack (e.g. CDS) into ",
				"canvas.library.usedBy": "prototypes × ",
				"tasks.verify.done": "verified",
				"tasks.verify.by": "verified by {by}",
				"tasks.verify.reviewed": "review reported",
				"tasks.verify.reviewed.title": "Review task {task} reported done (executor self-report, not human-verified)",
				"tasks.action.verify": "Verify",
				"canvas.agent.chip.verified": "verified",
				"canvas.growth.title": "Growth · {done}/{total}",
				"canvas.growth.step.source": "Source",
				"canvas.growth.step.worker": "Worker",
				"tasks.filter.all": "All",
				"tasks.filter.pending": "To do",
				"tasks.filter.in_progress": "Running",
				"tasks.filter.completed": "Done",
				"tasks.filter.blocked": "Blocked",
				"tasks.new": "＋ New task",
				"tasks.col.task": "Task",
				"tasks.col.owner": "owner",
				"tasks.col.blockedBy": "Depends on",
				"tasks.col.worktree": "Worktree",
				"tasks.col.report": "report",
				"tasks.col.status": "Status",
				"tasks.status.pending": "Pending",
				"tasks.status.in_progress": "Running",
				"tasks.status.completed": "Completed",
				"tasks.status.deleted": "Deleted",
				"tasks.blocked.deleted": "Blocker deleted",
				"tasks.blocked.wait": "Waiting for blocker",
				"tasks.report.done": "done · completed",
				"tasks.report.draft": "draft",
				"tasks.report.handed_back": "handed_back",
				"tasks.report.human_action": "human_action",
				"tasks.report.note": "done / draft are worker-writable; handed_back / human_action close only by a human · conflicts re-report, never overwrite",
				"tasks.action.assign": "Assign",
				"tasks.action.dispatch": "Dispatch",
				"tasks.action.reopen": "Reopen",
				"tasks.action.unassign": "Unassign",
				"tasks.action.report": "Write report",
				"tasks.assign.title": "Assign “{subject}”",
				"tasks.assign.owner": "Owner (project member)",
				"tasks.assign.dispatch": "Dispatch right after assigning",
				"tasks.report.title": "Write report · “{subject}”",
				"tasks.report.summary": "Summary",
				"tasks.report.artifacts": "Artifacts (file or URL, one per line)",
				"tasks.report.conflict": "Someone else changed this report ({code}) → re-report, never overwrite, no force write",
				"brief.desc": "Both share one 2000-token budget; responses carry version / updatedAt / truncated / omitted",
				"brief.project": "Project brief",
				"brief.goal": "Goal",
				"brief.decisions": "Decisions",
				"brief.constraints": "Constraints",
				"brief.budget": "Budget {used} / 2000 tokens",
				"brief.save": "Save (based on v{version})",
				"brief.cas": "Version CAS: expectedVersion must equal current v{version}",
				"brief.conflict": "The brief changed (now v{latest}, you edited v{base}) — refresh and retry.",
				"brief.conversation": "Conversation brief",
				"brief.proxy": "proxy",
				"brief.proxyNote": "A human may write for a conversation and it is marked; conversations never write for each other, not even the main one.",
				"brief.duty": "Duty",
				"brief.conclusions": "Conclusions",
				"brief.artifacts": "Artifacts",
				"brief.readin": "Read into this turn",
				"brief.foot": "Per-turn full-context injection was rejected: briefs share a 2000-token budget, overflow drops by recency + relevance, never silently",
				"exec.ticket.state": "{state} · {elapsed}",
				"exec.ticket.owner": "owner {owner}",
				"exec.ticket.where": "{worktree} · dsh-agent-whales-worker",
				"exec.ticket.first": "Worktree is a first-class field",
				"exec.ticket.full": "Full log",
				"exec.ticket.report": "Write report",
				"exec.ticket.note": "A worker may only initiate handed_back; closing is human-only",
				"exec.today": "Completed today {count}",
				"exec.today.note": "done = confirmed closed by a human",
				"auto.title": "Auto-dispatch after wake",
				"auto.desc": "When a member is woken, tasks assigned to them that were not sent because they were offline are sent automatically. Default L2 holds them briefly so you can undo.",
				"auto.tier.L1": "L1 never auto-send",
				"auto.tier.L2": "L2 with undo window",
				"auto.tier.L3": "L3 send immediately",
				"auto.tier.L1.note": "Waking only brings the member online; tasks wait for you to send them.",
				"auto.tier.L2.note": "After a wake, tasks are held {seconds}s before sending and can be undone.",
				"auto.tier.L3.note": "After a wake, tasks are sent at once with no undo window.",
				"auto.approval": "When an auto-dispatched task asks for approval",
				"auto.approval.wait": "Stop at \"waiting for you\" (default)",
				"auto.approval.approve-all": "Approve all",
				"auto.approval.approve-all.note": "Only approves requests from members whose in-progress task was auto-dispatched, and writes an audit entry each time. Other requests still wait for you.",
				"auto.limits": "Limits",
				"auto.limit.perMemberPerMinute": "Per member per minute",
				"auto.limit.projectConcurrent": "Project in flight",
				"auto.limit.maxChainDepth": "Chain depth",
				"auto.limit.save": "Save limits",
				"auto.confirm.title": "Confirm loosening",
				"auto.confirm.L3": "L3 sends tasks immediately after a wake with no undo window. Turn it on for this project?",
				"auto.confirm.approve-all": "\"Approve all\" approves approval requests of auto-dispatched tasks without a click from you. Turn it on for this project?",
				"auto.confirm.ok": "Turn on",
				"auto.pending": "Waiting to send ({count})",
				"auto.pending.row": "{task} · sends in {seconds}s",
				"auto.pending.undo": "Undo",
				"auto.pending.undone": "Undone: {task}",
				"auto.pending.gone": "Already sent or no longer pending",
				"auto.audit": "Recent activity",
				"auto.audit.empty": "No auto-dispatch activity yet",
				"auto.saved": "Saved",
				"auto.fail": "Save failed: {reason}",
				"exec.popover.human": "human-only",
				"inbox.title": "Needs me ({count})",
				"inbox.desc": "Only decisions that need a human; never decides for you, never re-dispatches",
				"inbox.group.proposals": "Proposal to confirm",
				"inbox.action.proposal": "View proposal",
				"inbox.action.requirement": "Handle (open canvas)",
				"inbox.action.report": "View report · decide",
				"inbox.action.handed": "View report · reassign or close",
				"inbox.action.task": "View task",
				"inbox.foot": "human_action / handed_back come from a worker's report: a worker only initiates; closing is a human setting report to done or deleting the task",
				"activity.events": "Event timeline (read-only)",
				"activity.events.desc": "Proposal submissions, task commands, handoff results and store-degraded events recorded by the plugin, newest first, last 30. Main-session messages, workspace watching and schedules are not wired up yet.",
				"handoff.title": "Handoffs",
				"handoff.desc": "Produced ≠ delivered: sent / failed / unknown are reported separately; unknown is never re-dispatched",
				"handoff.export": "Export evidence",
				"handoff.col.time": "Time",
				"handoff.col.route": "From → To",
				"handoff.col.summary": "Summary",
				"handoff.col.result": "Result",
				"handoff.col.evidence": "Evidence",
				"handoff.result.sent": "Sent",
				"handoff.result.failed": "Failed (target not running)",
				"handoff.result.unknown": "Unknown (no auto re-dispatch)",
				"handoff.legend": "Three states:",
				"handoff.note": "No exactly-once promise: after a restart the only answer is “may have landed”",
				"event.state.pending": "To assess",
				"event.state.opened": "Ticket opened",
				"replay.title": "Task replay · {subject}",
				"replay.entries": "Entry stream",
				"replay.foot": "Replay records how a task came to be and ran; handoffs record whether a message landed. They never merge: \"replied\" is not report=done.",
				"replay.open": "Replay",
				"replay.step.source": "Source",
				"replay.step.trigger": "Trigger",
				"replay.step.policy": "Policy",
				"replay.step.ticket": "Ticket",
				"replay.step.worker": "Worker",
				"replay.step.report": "Report",
				"replay.step.extra": "Other",
				"replay.state.done": "done",
				"replay.state.active": "running",
				"replay.state.pending": "not started",
				"replay.state.skipped": "skipped",
				"replay.obs.current": "Current tool: {tool} · {elapsed}",
				"replay.obs.commands": "{count} commands",
				"replay.obs.files": "{count} files written",
				"replay.obs.note": "Counts are per execution session (cumulative across tasks), not for this task alone",
				"replay.empty": "No replay recorded for this task yet.",
				"event.action.note": "Open ticket = task table + exec bench; ignore = keep a trace, no ticket",
				"event.empty": "No events yet: main-session messages, workspace changes and schedule triggers land here first.",
				"set.menu.look": "Appearance",
				"set.menu.advanced": "Advanced",
				"set.loading": "Loading…",
				"set.mcp.title": "MCP constraints",
				"set.mcp.project": "Project",
				"set.mcp.noProject": "No project yet: create one first, then you can limit its conversations' MCP access.",
				"set.mcp.rule": "Limit which MCP services the conversations in a project may use. Rule: once a conversation has been ticked for any service it may only use the ticked ones; a conversation with none ticked is unrestricted and may use anything. So ticking tightens access, it does not grant it.",
				"set.mcp.restricted": "{count} conversation(s) currently restricted",
				"set.mcp.unrestricted": "No conversation is currently restricted",
				"set.mcp.tools": "{count} tools",
				"set.mcp.only": "Only: {servers}",
				"set.mcp.free": "Unrestricted",
				"set.mcp.empty": "No MCP service available: connect an MCP server in DSH first.",
				"set.mcp.stale": "{count} constraint(s) point at conversations no longer in the project (the host keeps them; Clear all removes them)",
				"set.mcp.fail": "Failed: {reason}",
				"set.mcp.clear": "Clear all",
				"set.mcp.clear.confirm": "Click again to confirm: clear ALL MCP constraints of this project",
				"set.mcp.cleared": "All MCP constraints of this project cleared",
				"set.snapshot.title": "Data snapshot",
				"set.theme": "Appearance · theme",
				"set.theme.light": "Light",
				"set.theme.system": "System",
				"set.theme.dark": "Dark",
				"set.foot": "The appearance applies to the canvas and workbench",
				"draft.prefix": "Re proposal v{version} ({proposalId}): ",
				"draft.insert": "Bring in",
				"draft.insert.title": "Bring the proposal reference into the input box, then write your changes",
				"draft.insert.locked": "This proposal is confirmed and locked; to change it, submit a new proposal",
				"draft.insert.clipboard": "This panel cannot reach the input box; the text will be copied to the clipboard",
				"draft.state.inserted": "Brought in - press Enter to send",
				"draft.state.copied": "Cannot write to the input box; copied",
				"draft.state.failed": "Cannot write to the input box; copy manually: ",
				"draft.boundary": "Bring-in only serves letting the Lead change the proposal; it never shows sent, you still submit with Enter in the official input box.",
				"goal.label": "Goal",
				"goal.from.session": "Source: session title (the goal message first line is unavailable)",
				"goal.status": "Proposal v{version} awaiting confirmation",
				"goal.status.locked": "Proposal v{version} confirmed and locked",
				"goal.view": "View",
				"goal.view.none": "No project found for this proposal; status only",
				"chat.canvas.open": "Project canvas",
				"chat.canvas.hint": "Open the project canvas in the right sidebar",
				"chat.canvas.failed": "Couldn't open the project canvas. Try again shortly.",
				"about.desc": "The whale girl is a presentation layer, not the product model; authoritative state lives on cards and badges."
			}
		};

		function wbFill(template, vars) {
			if (typeof template !== "string") return "";
			if (!vars) return template;
			return template.replace(/\{(\w+)\}/g, function (all, key) {
				return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all;
			});
		}

		/**
		 * 文案解析：优先槽位注入的 t（注册进 agent-whales-workbench 命名空间），
		 * 拿不到就退回内置中文表——离线测试与老宿主都不该因此白屏。
		 */
		function wbT(props) {
			var injected = props && typeof props.t === "function" ? props.t : undefined;
			return function (key, vars) {
				if (injected !== undefined) {
					try {
						var value = injected(key, vars);
						if (typeof value === "string" && value !== "" && value !== key) return value;
					} catch (error) { /* 退回内置表 */ }
				}
				return wbFill(WB_TEXT.zh[key], vars);
			};
		}

		/** token 预算估算（PRD §53.9.8 第 3 条：中日韩 1 字 = 1 token，其他 4 字符 = 1 token）。 */
		function wbEstimateTokens(text) {
			var source = typeof text === "string" ? text : "";
			var cjk = 0;
			var other = 0;
			for (var i = 0; i < source.length; i += 1) {
				var code = source.charCodeAt(i);
				// CJK 统一表意文字 + 假名 + 谚文 + 全角标点区间
				if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x3000 && code <= 0x303f)) cjk += 1;
				else other += 1;
			}
			return cjk + Math.ceil(other / 4);
		}

		/**
		 * 简报按序填充：goal → constraints → decisions（新的在前）→ duty → conclusions → artifacts。
		 * 超出预算的条目直接丢弃并计数；被截断的那条保留标注（标记本身计入预算）。
		 */
		function wbBriefFill(brief, budget) {
			var limit = typeof budget === "number" && budget > 0 ? budget : WB_BRIEF_BUDGET;
			var source = brief && typeof brief === "object" ? brief : {};
			var out = { goal: "", constraints: [], decisions: [], duty: "", conclusions: [], artifacts: [], used: 0, truncated: false, omitted: 0 };
			var left = limit;
			function take(text) {
				var value = typeof text === "string" ? text : "";
				var cost = wbEstimateTokens(value);
				if (cost > left) {
					out.truncated = true;
					out.omitted += 1;
					return "";
				}
				left -= cost;
				out.used += cost;
				return value;
			}
			out.goal = take(source.goal);
			var constraints = Array.isArray(source.constraints) ? source.constraints : [];
			for (var i = 0; i < constraints.length; i += 1) {
				var constraint = take(constraints[i]);
				if (constraint !== "") out.constraints.push(constraint);
			}
			var decisions = Array.isArray(source.decisions) ? source.decisions.slice() : [];
			decisions.reverse();
			for (var j = 0; j < decisions.length; j += 1) {
				var decision = take(decisions[j]);
				if (decision !== "") out.decisions.push(decision);
			}
			out.duty = take(source.duty);
			var conclusions = Array.isArray(source.conclusions) ? source.conclusions : [];
			for (var k = 0; k < conclusions.length; k += 1) {
				var conclusion = take(conclusions[k]);
				if (conclusion !== "") out.conclusions.push(conclusion);
			}
			var artifacts = Array.isArray(source.artifacts) ? source.artifacts : [];
			for (var m = 0; m < artifacts.length; m += 1) {
				var artifact = artifacts[m];
				var label = typeof artifact === "string" ? artifact : (artifact && typeof artifact.ref === "string" ? artifact.ref : "");
				var kept = take(label);
				if (kept !== "") out.artifacts.push(typeof artifact === "string" ? artifact : Object.assign({}, artifact, { ref: kept }));
			}
			return out;
		}

		/** 时钟：今天 → HH:MM；昨天 → 昨天 HH:MM；更早 → MM-DD。 */
		function wbFormatClock(ts, now) {
			var at = typeof ts === "number" && isFinite(ts) ? ts : 0;
			var base = typeof now === "number" && isFinite(now) ? now : Date.now();
			if (at <= 0) return "";
			var then = new Date(at);
			var today = new Date(base);
			function pad(value) { return value < 10 ? "0" + value : String(value); }
			var sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
			if (sameDay) return pad(then.getHours()) + ":" + pad(then.getMinutes());
			var yesterday = new Date(base - 24 * 3600 * 1000);
			if (then.getFullYear() === yesterday.getFullYear() && then.getMonth() === yesterday.getMonth() && then.getDate() === yesterday.getDate()) {
				return "昨天 " + pad(then.getHours()) + ":" + pad(then.getMinutes());
			}
			return pad(then.getMonth() + 1) + "-" + pad(then.getDate());
		}

		function wbElapsed(ms) {
			var value = typeof ms === "number" && isFinite(ms) && ms > 0 ? ms : 0;
			var seconds = Math.floor(value / 1000);
			if (seconds < 60) return seconds + "s";
			var minutes = Math.floor(seconds / 60);
			if (minutes < 60) return minutes + "m" + pad2(seconds % 60) + "s";
			var hours = Math.floor(minutes / 60);
			if (hours < 24) return hours + "h" + pad2(minutes % 60) + "m";
			return Math.floor(hours / 24) + "d" + pad2(hours % 24) + "h";
			function pad2(value) { return value < 10 ? "0" + value : String(value); }
		}

		// ── 路由（内部状态路由；PRD §45.2：不覆盖 conversation key）────────────────

		/**
		 * 解析内部路由。返回 { kind, projectId, tab }：
		 *   list / first / inbox / handoffs / events / team / settings / workbench
		 * 非法片段一律回落 list，绝不因一个坏链接白屏。
		 */
		/** 页签归一化：任务/执行 → 表格；旧需求与简报入口 → 画布内审。 */
		function wbTabOf(tab) {
			var moved = { tasks: "table", exec: "table", brief: "canvas", reqs: "canvas" };
			var key = String(tab || "canvas");
			if (Object.prototype.hasOwnProperty.call(moved, key)) return moved[key];
			return ["canvas", "table", "office"].indexOf(key) >= 0 ? key : "canvas";
		}

		function wbRouteOf(path) {
			var source = typeof path === "string" ? path : "";
			var parts = source.split("/").filter(function (part) { return part !== ""; });
			if (parts.length === 0) return { kind: "list" };
			var head = parts[0];
			if (head === "p" && parts.length >= 2) {
				var tab = parts.length >= 3 ? parts[2] : "canvas";
				return { kind: "workbench", projectId: decodeURIComponent(parts[1]), tab: wbTabOf(tab) };
			}
			// 重新规划 R3：发送记录 / 事件台并入「需要我处理」，团队 / 首次体验页已删除。
			if (head === "handoffs" || head === "events") return { kind: "inbox" };
			if (["inbox", "settings"].indexOf(head) >= 0) return { kind: head };
			return { kind: "list" };
		}

		function wbPathOf(route) {
			var target = route && typeof route === "object" ? route : {};
			if (target.kind === "workbench") {
				return "/p/" + encodeURIComponent(String(target.projectId || "")) + "/" + (target.tab || "canvas");
			}
			if (target.kind === "list" || target.kind === undefined) return "/";
			return "/" + String(target.kind);
		}

		/** 任务行视图：状态文案 / 色调 / ready / 阻塞原因 / report 片，全部派生不落库。 */
		function wbTaskRowView(task, tasks) {
			var source = task && typeof task === "object" ? task : {};
			var table = tasks && typeof tasks === "object" ? tasks : {};
			var blockedBy = Array.isArray(source.blockedBy) ? source.blockedBy : [];
			var missing = blockedBy.filter(function (id) { return table[id] === undefined; });
			var deleted = blockedBy.filter(function (id) { return table[id] !== undefined && table[id].status === "deleted"; });
			var unfinished = blockedBy.filter(function (id) {
				var blocker = table[id];
				return blocker !== undefined && blocker.status !== "completed" && blocker.status !== "deleted";
			});
			var ready = source.status === "pending" && unfinished.length === 0 && missing.length === 0 && deleted.length === 0;
			var blockedReason;
			if (missing.length > 0 || deleted.length > 0) blockedReason = "deleted";
			else if (unfinished.length > 0) blockedReason = "wait";
			var report = source.report && typeof source.report === "object" ? source.report : null;
			return {
				taskId: String(source.taskId || ""),
				subject: String(source.subject || ""),
				status: String(source.status || "pending"),
				...(source.designHandoff ? { designHandoff: source.designHandoff } : {}),
				ownerSessionId: source.ownerSessionId === undefined ? null : source.ownerSessionId,
				blockedBy: blockedBy,
				blockedReason: blockedReason,
				ready: ready,
				worktree: typeof source.worktree === "string" && source.worktree !== "" ? source.worktree : null,
				execRoot: typeof source.execRoot === "string" && source.execRoot !== "" ? source.execRoot : null,
				revision: typeof source.revision === "number" ? source.revision : 1,
				report: report === null ? null : {
					status: String(report.status || "draft"),
					summary: String(report.summary || ""),
					rev: typeof report.rev === "number" ? report.rev : 0,
					at: typeof report.at === "number" ? report.at : 0,
					bySessionId: typeof report.bySessionId === "string" ? report.bySessionId : ""
				}
			};
		}

		/** report 四态与「谁能写」：worker 只能写 done/draft 或发起后两类；后两类只能人关。 */
		function wbReportRules(bySessionId) {
			var worker = !(typeof bySessionId !== "string" || bySessionId === "" || bySessionId === "user");
			return {
				worker: worker,
				all: ["done", "draft", "handed_back", "human_action"],
				writable: worker ? ["done", "draft"] : ["done", "draft", "handed_back", "human_action"],
				initiatable: worker ? ["handed_back", "human_action"] : [],
				closable: worker ? [] : ["done", "draft"]
			};
		}

		/** 待办分组计数：空组也保留（前端按 key 渲染，不猜顺序）。 */
		function wbInboxView(inbox) {
			var groups = inbox && Array.isArray(inbox.groups) ? inbox.groups : [];
			var view = {};
			var total = 0;
			for (var i = 0; i < groups.length; i += 1) {
				var group = groups[i];
				if (!group || typeof group.key !== "string") continue;
				var items = Array.isArray(group.items) ? group.items : [];
				view[group.key] = { label: String(group.label || group.key), items: items };
				total += items.length;
			}
			return { groups: view, total: total };
		}

		// ── 需求主线 P3：项目卡里的需求总览（宿主 GET /projects/:id/requirements 已把阶段推导好，这里只做展示折算）──

		var WB_REQ_STAGE_ORDER = ["clarify", "design", "develop", "accept", "mismatch", "passed"];
		/** 宿主阶段色调（neutral/info/warn/bad/ok）→ 工作台芯片色调（neutral/brand/warn/danger/ok）；未知回 neutral。 */
		var WB_REQ_TONES = { neutral: "neutral", info: "brand", warn: "warn", bad: "danger", ok: "ok" };

		/**
		 * 把宿主返回的需求视图整理成卡片行：保证字段齐全、阶段落在词表内、坏数据不抛。
		 * 返回按「最需要处理的在前」排序的数组（需要你处理 > 进行中 > 澄清 > 已通过 > 未归类），虚拟「未归类」永远垫底。
		 */
		function wbRequirementRows(payload) {
			var list = payload && Array.isArray(payload.requirements) ? payload.requirements : [];
			var rows = list.filter(function (item) { return item && typeof item === "object" && typeof item.reqId === "string"; }).map(function (item) {
				var stage = WB_REQ_STAGE_ORDER.indexOf(item.stage) >= 0 ? item.stage : "clarify";
				var counts = item.counts && typeof item.counts === "object" ? item.counts : {};
				return {
					reqId: item.reqId,
					title: typeof item.title === "string" && item.title !== "" ? item.title : item.reqId,
					virtual: item.virtual === true,
					stage: stage,
					tone: Object.prototype.hasOwnProperty.call(WB_REQ_TONES, item.tone) ? WB_REQ_TONES[item.tone] : "neutral",
					next: typeof item.next === "string" ? item.next : "",
					attention: typeof item.attention === "string" && item.attention !== "" ? item.attention : "",
					designVersion: typeof item.designVersion === "number" ? item.designVersion : 0,
					revision: typeof item.revision === "number" ? item.revision : 1,
					ownerSessionId: typeof item.ownerSessionId === "string" ? item.ownerSessionId : "",
					tasks: typeof counts.tasks === "number" ? counts.tasks : 0,
					tasksDone: typeof counts.tasksDone === "number" ? counts.tasksDone : 0,
					prototypes: typeof counts.prototypes === "number" ? counts.prototypes : 0,
					updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0
				};
			});
			function rank(row) {
				if (row.virtual) return 9;
				if (row.attention !== "") return 0;
				if (row.stage === "develop" || row.stage === "design" || row.stage === "accept") return 1;
				if (row.stage === "clarify") return 2;
				return 3;
			}
			rows.sort(function (a, b) { return rank(a) - rank(b) || b.updatedAt - a.updatedAt; });
			return rows;
		}

		/**
		 * 项目里每个对话的显示名：宿主给的会话标题 > 成员登记的角色名 > 截断的 id（12 字符）。
		 * 标题等于 id 或全空白都算「没有标题」。主对话没登记进成员表也要有名字。坏数据跳过。
		 */
		function wbMemberNames(project, sessionsPayload) {
			var names = {};
			var members = project && Array.isArray(project.members) ? project.members : [];
			var rows = sessionsPayload && Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [];
			var titleOf = {};
			rows.forEach(function (row) { if (row && typeof row.sessionId === "string" && typeof row.title === "string" && row.title.trim() !== "" && row.title !== row.sessionId) titleOf[row.sessionId] = row.title; });
			function nameFor(id, registered) {
				if (titleOf[id]) return titleOf[id];
				if (typeof registered === "string" && registered.trim() !== "" && registered !== id) return registered;
				return id.slice(0, 12);
			}
			members.forEach(function (member) { if (member && typeof member.sessionId === "string" && member.sessionId !== "") names[member.sessionId] = nameFor(member.sessionId, member.title); });
			if (project && typeof project.mainSessionId === "string" && project.mainSessionId !== "" && names[project.mainSessionId] === undefined) names[project.mainSessionId] = nameFor(project.mainSessionId, "");
			return names;
		}

		/** 按负责人筛：all（含未归类）/ none（没有负责人；不含虚拟的未归类）/ 某个对话 id。没有这个负责人 = 空，不回落成全部。 */
		function wbRequirementByOwner(rows, ownerKey) {
			var list = Array.isArray(rows) ? rows : [];
			if (ownerKey === undefined || ownerKey === null || ownerKey === "all") return list;
			return list.filter(function (row) {
				if (!row || row.virtual === true) return false;
				var owner = typeof row.ownerSessionId === "string" ? row.ownerSessionId : "";
				return ownerKey === "none" ? owner === "" : owner === ownerKey;
			});
		}

		/** 负责人下拉的选项：全部 / 未指定 / 真有需求的负责人（带数字）。负责人不在名字表里（旧数据）也能筛，名字退到截断 id。 */
		function wbOwnerFilterOptions(rows, names) {
			var list = Array.isArray(rows) ? rows : [];
			var known = names && typeof names === "object" ? names : {};
			var counts = {};
			var order = [];
			list.forEach(function (row) {
				if (!row || row.virtual === true) return;
				var owner = typeof row.ownerSessionId === "string" ? row.ownerSessionId : "";
				if (owner === "") return;
				if (counts[owner] === undefined) { counts[owner] = 0; order.push(owner); }
				counts[owner] += 1;
			});
			var options = [
				{ key: "all", count: list.length },
				{ key: "none", count: wbRequirementByOwner(list, "none").length }
			];
			order.forEach(function (owner) { options.push({ key: owner, count: counts[owner], label: known[owner] || owner.slice(0, 12) }); });
			return options;
		}

		/** 一条运行结果在界面上的色调与文案键。accepted = 人标了「可接受」。 */
		var WB_RESULT_TONES = { pending: "neutral", running: "brand", passed: "ok", accepted: "ok", failed: "danger", error: "warn" };

		/**
		 * 需求详情页上「现在能做什么」的判定（按钮显不显示都从这里来，宿主仍会再校验一遍）：
		 *   confirmDesign  有原型帧、且从没确认过或确认后又改了
		 *   startRun       任务全完工（至少一个）、没有没结束的运行
		 *   reflow         最近一次运行已结束、还有没回流的失败 / 出错用例
		 * 都只是「入口该不该亮」，不替宿主做决定。
		 */
		function wbRequirementActions(view, runs) {
			var v = view && typeof view === "object" ? view : {};
			var evidence = v.evidence && typeof v.evidence === "object" ? v.evidence : {};
			var list = Array.isArray(runs) ? runs : [];
			var open = list.filter(function (run) { return run && (run.status === "queued" || run.status === "running"); })[0];
			var latest = list.filter(function (run) { return run && run.status !== "queued" && run.status !== "running"; })[0];
			var latestFailed = latest && (latest.failed > 0 || latest.errored > 0);
			var left = latest ? (latest.failed + latest.errored) - (latest.reflowed || 0) : 0;
			return {
				confirmDesign: v.virtual !== true && (typeof v.designConfirmable === "boolean"
					? v.designConfirmable : (evidence.designCount > 0 || evidence.prototypeCount > 0) && evidence.dirtyPrototypeCount > 0),
				startRun: v.virtual !== true && evidence.taskTotal > 0 && evidence.taskDone >= evidence.taskTotal && open === undefined && evidence.dirtyPrototypeCount === 0 && !evidence.reviewPending,
				openRunId: open ? open.runId : "",
				reflow: !!(latestFailed && left > 0),
				reworkLimit: !!(evidence.reworkCap > 0 && evidence.reworkCount >= evidence.reworkCap),
				latestRunId: latest ? latest.runId : ""
			};
		}

		var WB_SHOT_MAX_BYTES = 5 * 1024 * 1024;
		var WB_SHOT_EXT = /\.(png|jpe?g|webp)$/i;

		/**
		 * 手动录入的截图：浏览器里先挡一道（扩展名 / 大小 / 是不是空），读成 base64 交给宿主。
		 * 宿主仍会再校验（文件头魔数、大小、文件名），这里只是别把明显不行的白白传一遍。
		 * 返回 Promise<{ name, data }>；不合格 reject 带中文原因（界面直接显示）。
		 */
		function wbFileToUpload(file) {
			if (!file || typeof file.name !== "string") return Promise.reject(new Error("没有选中文件"));
			if (!WB_SHOT_EXT.test(file.name)) return Promise.reject(new Error("只支持 png / jpg / webp 图片（录屏由执行器附加）"));
			if (!(file.size > 0)) return Promise.reject(new Error("文件是空的"));
			if (file.size > WB_SHOT_MAX_BYTES) return Promise.reject(new Error("图片超过 5MB，请压缩后再传"));
			if (typeof file.arrayBuffer !== "function") return Promise.reject(new Error("当前浏览器读不了这个文件"));
			return file.arrayBuffer().then(function (buffer) {
				var bytes = new Uint8Array(buffer);
				var binary = "";
				for (var i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
				return { name: file.name, data: btoa(binary) };
			});
		}

		/** 配置表单：当前值 → 表单状态；表单状态 → 只含「真的改了」的字段的补丁（没改就不发请求）。 */
		function wbE2eConfigDraft(config) {
			var c = config && typeof config === "object" ? config : {};
			return { trigger: c.trigger === "manual" ? "manual" : "auto", driver: ["tabbit-cli", "computer-use"].indexOf(c.driver) >= 0 ? c.driver : "manual", executorSessionId: typeof c.executorSessionId === "string" ? c.executorSessionId : "", baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : "" };
		}
		function wbE2eConfigPatch(saved, draft) {
			var base = wbE2eConfigDraft(saved);
			var patch = {};
			["trigger", "driver", "executorSessionId", "baseUrl"].forEach(function (key) {
				var next = key === "baseUrl" ? String(draft[key] || "").trim() : draft[key];
				if (next !== base[key]) patch[key] = next;
			});
			// 选了非手动驱动、没选执行器：这样的运行没人跑，前端先拦住并给出原因（宿主也会拒绝）。
			var driver = patch.driver !== undefined ? patch.driver : base.driver;
			var executor = patch.executorSessionId !== undefined ? patch.executorSessionId : base.executorSessionId;
			if (driver !== "manual" && executor === "") return { patch: patch, error: "needExecutor" };
			return { patch: patch, error: "" };
		}

		/** 回流落点的显示文案键（实现 / 设计 / 需求）。 */
		function wbReflowTargetKey(kind) {
			return kind === "design" ? "req.reflow.design" : kind === "requirement" ? "req.reflow.requirement" : "req.reflow.code";
		}

		/** 框选批注：把屏幕上的拖拽（起点 / 终点，相对截图元素左上角的像素）折成 0..1 的框；太小（< 1%）当没框。 */
		function wbRectFromDrag(start, end, width, height) {
			if (!start || !end || !(width > 0) || !(height > 0)) return null;
			function clamp(v) { return Math.max(0, Math.min(1, v)); }
			var x1 = clamp(start.x / width), y1 = clamp(start.y / height), x2 = clamp(end.x / width), y2 = clamp(end.y / height);
			var rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
			if (rect.w < 0.01 || rect.h < 0.01) return null;
			return { x: Math.round(rect.x * 10000) / 10000, y: Math.round(rect.y * 10000) / 10000, w: Math.round(rect.w * 10000) / 10000, h: Math.round(rect.h * 10000) / 10000 };
		}
		var WB_REQ_FILTERS = ["all", "attention", "mismatch", "active", "passed"];

		/**
		 * 需求列表筛选（设计稿 ①：「待我确认」「E2E 不符」）。
		 *   attention  需要你处理的（待确认设计 / 验收不符 / 返工超限）
		 *   mismatch   E2E 不符（含返工超限，它们都在「不符」阶段）
		 *   active     进行中：澄清 / 设计 / 开发 / 验收
		 *   passed     已通过
		 * 虚拟「未归类」只出现在「全部」里：它没有阶段可筛。未知筛选键回落成「全部」。
		 */
		function wbRequirementFilter(rows, key) {
			var list = Array.isArray(rows) ? rows : [];
			var k = WB_REQ_FILTERS.indexOf(key) >= 0 ? key : "all";
			if (k === "all") return list;
			return list.filter(function (row) {
				if (!row || row.virtual === true) return false;
				if (k === "attention") return row.attention !== "";
				if (k === "mismatch") return row.stage === "mismatch";
				if (k === "passed") return row.stage === "passed";
				return row.stage === "clarify" || row.stage === "design" || row.stage === "develop" || row.stage === "accept";
			});
		}

		/** 每个筛选键下有几个（芯片上的数字）。 */
		function wbRequirementFilterCounts(rows) {
			var out = {};
			WB_REQ_FILTERS.forEach(function (key) { out[key] = wbRequirementFilter(rows, key).length; });
			return out;
		}

		/** 一个项目的需求汇总：每个阶段几个、几个需要你处理。项目卡的角标用。 */
		function wbRequirementSummary(rows) {
			var summary = { total: 0, attention: 0, byStage: {} };
			WB_REQ_STAGE_ORDER.forEach(function (stage) { summary.byStage[stage] = 0; });
			(Array.isArray(rows) ? rows : []).forEach(function (row) {
				if (!row || row.virtual) return;
				summary.total += 1;
				summary.byStage[row.stage] += 1;
				if (row.attention !== "") summary.attention += 1;
			});
			return summary;
		}

		/**
		 * 画布图布局：三类节点 + 无向关联线。位置由调用方给出（拖拽后单独持久化），
		 * 这里只负责把「节点 + 关联」折算成可渲染的边（贝塞尔用二次曲线近似）。
		 */
		/**
		 * Composer 的前缀（Q1 结论）：只引用身份，**不带任何指令性措辞**。
		 * 优先引用提案身份（与目标条同一口径），没有提案就引用当前选中/负责的任务身份。
		 * 两者都没有 → 空前缀（用户自己写，我们不替他起头）。
		 */
		function wbComposerPrefix(task, t) {
			var row = task && typeof task === "object" ? task : null;
			if (row === null) return "";
			var proposal = row.sourceProposal && typeof row.sourceProposal === "object" ? row.sourceProposal : null;
			if (proposal !== null && typeof proposal.proposalId === "string" && proposal.proposalId !== "") {
				var version = typeof proposal.version === "number" && proposal.version > 0 ? Math.floor(proposal.version) : 1;
				var vars = { version: version, proposalId: proposal.proposalId };
				if (typeof t === "function") return t("composer.prefix.proposal", vars);
				return "[提案 v" + version + " " + proposal.proposalId + "] ";
			}
			var taskId = typeof row.taskId === "string" ? row.taskId : "";
			var subject = typeof row.subject === "string" ? row.subject.trim() : "";
			if (taskId === "" && subject === "") return "";
			if (typeof t === "function") return t("composer.prefix.task", { taskId: taskId, subject: subject });
			return "[任务 " + taskId + (subject !== "" ? " · " + subject : "") + "] ";
		}

		/**
		 * 核对视图（Q3 结论）：人工核对是独立字段，**不并入任务状态**。
		 * 返回 { verified: bool, by, at, note }；没有核对字段时 verified=false。
		 */
		function wbVerifiedView(task) {
			var row = task && typeof task === "object" ? task : {};
			var v = row.verified && typeof row.verified === "object" ? row.verified : null;
			if (v === null) return { verified: false, by: "", at: 0, note: "" };
			return {
				verified: true,
				by: typeof v.by === "string" ? v.by : "",
				at: typeof v.at === "number" ? v.at : 0,
				note: typeof v.note === "string" ? v.note : ""
			};
		}

		/**
		 * 评审次信号（Q3 结论）：以本任务为前置（blockedBy）的评审任务已报完工 →
		 * 「评审已报通过」。措辞与人工「已核对」刻意区分——一个是人核的，一个是执行器报的。
		 * 返回 { reviewed: bool, byTaskId, at }。
		 */
		function wbReviewSignal(task, tasks) {
			var row = task && typeof task === "object" ? task : {};
			var self = typeof row.taskId === "string" ? row.taskId : "";
			var rows = Array.isArray(tasks) ? tasks : [];
			var hit = null;
			rows.forEach(function (one) {
				if (!one || !Array.isArray(one.blockedBy)) return;
				if (one.blockedBy.indexOf(self) < 0) return;
				if (!one.report || typeof one.report !== "object") return;
				if (one.report.status !== "done") return;
				if (hit === null || (one.report.at || 0) > (hit.report.at || 0)) hit = one;
			});
			if (hit === null) return { reviewed: false, byTaskId: "", at: 0 };
			return { reviewed: true, byTaskId: String(hit.taskId || ""), at: typeof hit.report.at === "number" ? hit.report.at : 0 };
		}
		/**
		 * 依赖连线（借鉴 oh-my-hermes 图上 "Waits on N lanes" 的边标注）。
		 * 我们的画布此前只画 project.links（会话关联）与 MCP 约束，**blockedBy 依赖从不上线**——
		 * 谁在等谁全靠用户自己记。这里按任务的 blockedBy 派生 {a: 阻塞方会话, b: 等待方会话}：
		 * 只有两端都落在画布 Agent 节点上（两端任务都有 owner）才画，否则画出来是一根断线。
		 * label 由调用方补（要 t），这里只给 taskId 与 reason。
		 */
		function wbDepLinks(tasks) {
			var rows = Array.isArray(tasks) ? tasks : [];
			var byId = {};
			rows.forEach(function (row) {
				if (row && typeof row.taskId === "string" && row.taskId !== "") byId[row.taskId] = row;
			});
			var out = [];
			rows.forEach(function (row) {
				if (!row || !Array.isArray(row.blockedBy)) return;
				if (typeof row.ownerSessionId !== "string" || row.ownerSessionId === "") return;
				row.blockedBy.forEach(function (blockerId) {
					var blocker = byId[String(blockerId)];
					if (!blocker) return;
					if (typeof blocker.ownerSessionId !== "string" || blocker.ownerSessionId === "") return;
					if (blocker.ownerSessionId === row.ownerSessionId) return;
					out.push({
						a: blocker.ownerSessionId,
						b: row.ownerSessionId,
						reason: "blocked",
						waitTaskId: String(blockerId),
						taskId: String(row.taskId)
					});
				});
			});
			// 去重：同一对会话之间只留一条（多条依赖画一根线，理由取第一条）
			var seen = {};
			return out.filter(function (edge) {
				var key = edge.a + "|" + edge.b;
				if (seen[key]) return false;
				seen[key] = true;
				return true;
			});
		}
		function wbCanvasEdges(nodes, links) {
			var byId = {};
			var list = Array.isArray(nodes) ? nodes : [];
			for (var i = 0; i < list.length; i += 1) {
				var node = list[i];
				if (node && typeof node.id === "string") byId[node.id] = node;
			}
			var edges = [];
			var pairs = Array.isArray(links) ? links : [];
			for (var j = 0; j < pairs.length; j += 1) {
				var link = pairs[j];
				if (!link) continue;
				var a = byId[String(link.a)];
				var b = byId[String(link.b)];
				if (a === undefined || b === undefined || a === b) continue;
				edges.push({
					a: String(link.a), b: String(link.b),
					// 连线理由（OMH 图上 「Waits on 2 lanes」 的同款）：没有理由的线不标文字，
					// 只在高亮/检视时才知道是关联还是约束，用户得自己记。
					reason: typeof link.reason === "string" ? link.reason : "",
					label: typeof link.label === "string" ? link.label : "",
					x1: (a.x || 0) + (a.w || 0) / 2, y1: (a.y || 0) + (a.h || 0) / 2,
					x2: (b.x || 0) + (b.w || 0) / 2, y2: (b.y || 0) + (b.h || 0) / 2
				});
			}
			return edges;
		}

		// ── M6 工作台样式（token 见 WB_TOKENS；只引用 var(--daw-*)，切主题即换色）──
		var WB_DARK_PALETTE = "color-scheme:dark;--daw-bg:#101318;--daw-surface:#181B22;--daw-surface-muted:#1F232C;--daw-border:#2A2F3A;--daw-text:#E8EAEE;--daw-text-secondary:#A0A6B0;--daw-text-muted:#A0A6B0;--daw-brand:#83A7FF;--daw-on-brand:#111C36;--daw-ok:#3FB27F;--daw-warn:#E0A018;--daw-danger:#E06C6C;--daw-accent:#C879E0;--daw-ok-bg:#12241C;--daw-warn-bg:#2A2415;--daw-danger-bg:#2E1A1A;--daw-accent-bg:#261B2B";
		var WB_CSS = [
			".daw-wb{--daw-bg:#EEF1F6;--daw-surface:#FFFFFF;--daw-surface-muted:#FAFBFD;--daw-border:#DCE2EE;--daw-text:#1B2333;--daw-text-secondary:#4A5468;--daw-text-muted:#667184;--daw-brand:#3B55F0;--daw-on-brand:#fff;--daw-ok:#22A06B;--daw-warn:#E0A018;--daw-danger:#D64545;--daw-accent:#C05BD0;--daw-ok-bg:#EAF7F0;--daw-warn-bg:#FDF6E7;--daw-danger-bg:#FDF0F0;--daw-accent-bg:#F9EFFA;color-scheme:light;display:flex;height:100%;min-height:0;background:var(--daw-bg);color:var(--daw-text);font-family:'Noto Sans SC',system-ui,-apple-system,sans-serif;font-size:12px;line-height:1.5;box-sizing:border-box}",
			".daw-wb *,.daw-wb *::before,.daw-wb *::after{box-sizing:border-box}",
			".daw-wb[data-wb-theme=dark]{" + WB_DARK_PALETTE + "}",
			"@media(prefers-color-scheme:dark){.daw-wb[data-wb-theme=system]{" + WB_DARK_PALETTE + "}}",
			".daw-wb-main{flex:1;min-width:0;display:flex;flex-direction:column}",
			".daw-wb-top{height:56px;flex:none;display:flex;align-items:center;gap:12px;padding:0 24px;background:var(--daw-surface);border-bottom:1px solid var(--daw-border)}",
			".daw-wb-top-wide{height:auto;min-height:56px;flex-wrap:wrap;padding-block:8px}.daw-wb-top-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-left:auto}",
			".daw-wb-top-actions .daw-wb-btn[aria-current=page]{background:var(--daw-surface-muted);color:var(--daw-text);font-weight:650}",
			".daw-wb-top-badge{padding:1px 6px;border-radius:999px;background:var(--daw-warn-bg);color:var(--daw-warn);font-size:10px;font-variant-numeric:tabular-nums}",
			".daw-wb-crumb{font-size:12px;color:var(--daw-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px}",
			".daw-wb-crumb-link{border:0;background:none;padding:0;font:inherit;color:var(--daw-text-muted);cursor:pointer;text-decoration:none}",
			".daw-wb-crumb-link:hover{color:var(--daw-brand);text-decoration:underline}",
			".daw-wb-run{display:flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:var(--daw-ok-bg);color:var(--daw-ok);font-size:10.5px;font-weight:700;white-space:nowrap}",
			".daw-wb-run i{width:6px;height:6px;border-radius:50%;background:var(--daw-ok)}",
			".daw-wb-tabs{height:44px;flex:none;display:flex;align-items:center;gap:4px;padding:0 24px;background:var(--daw-surface);border-bottom:1px solid var(--daw-border);overflow-x:auto}",
			".daw-wb-tab{display:flex;align-items:center;gap:6px;padding:5px 12px;border:0;border-radius:8px;background:none;color:var(--daw-text-secondary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}",
			".daw-wb-tab[data-on=true]{background:var(--daw-surface-muted);color:var(--daw-text);font-weight:700;box-shadow:inset 0 -2px 0 var(--daw-brand)}",
			".daw-wb-tab-badge{padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--daw-text) 9%,transparent);color:var(--daw-text-secondary);font-size:10px;font-weight:650;font-variant-numeric:tabular-nums}",
			".daw-wb-tabnote{margin-left:auto;padding-left:16px;font-size:10.5px;color:var(--daw-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			// `.daw-wb-body-full` 必须自己是 positioned：画布里 `.daw-wb-canvaswrap` 是
			// `position:absolute;inset:0`，没有 positioned 祖先时包含块落到初始包含块
			// （视口）——画布会盖住侧栏、把侧栏导航的点击整个吃掉（2026-11-16 真机实测：
			// 进项目画布后侧栏消失，点「需要我处理」被 `.daw-wb-stage` 拦截）。
			".daw-wb-body{position:relative;flex:1;min-height:0;overflow:auto;padding:24px}",
			".daw-wb-body-full{padding:0;overflow:hidden}",
			".daw-wb-page{display:flex;flex-direction:column;gap:20px;max-width:1208px}",
			".daw-wb-pagehead{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}",
			".daw-wb-h1{font-size:18px;font-weight:700;color:var(--daw-text);margin:0}",
			".daw-wb-desc{font-size:11.5px;color:var(--daw-text-secondary);margin-top:4px}",
			".daw-wb-headfill{flex:1}",
			".daw-wb-btn,.daw-wb-zoombtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;min-height:34px;padding:0 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--daw-text,#24262c);font-family:inherit;font-size:12px;font-weight:550;line-height:1.25;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s,color .15s}",
			".daw-wb-btn:focus-visible,.daw-wb-zoombtn:focus-visible{outline:2px solid var(--daw-brand,#6c7ae6);outline-offset:2px}",
			".daw-wb-btn:disabled,.daw-wb-zoombtn:disabled{opacity:.48;cursor:not-allowed}",
			".daw-wb-btn:is([data-variant=primary],:not([data-variant])){background:var(--daw-text,#24262c);color:var(--daw-surface,#fff);font-weight:650}",
			".daw-wb-btn:is([data-variant=primary],:not([data-variant])):hover:not(:disabled){background:color-mix(in srgb,var(--daw-text,#24262c) 86%,var(--daw-surface,#fff))}",
			".daw-wb-btn[data-variant=ghost]{border-color:var(--daw-border,#dce2ee)}",
			".daw-wb-btn[data-variant=quiet],.daw-wb-btn[data-variant=tool],.daw-wb-zoombtn{color:var(--daw-text-secondary,#565d6c)}",
			".daw-wb-btn:is([data-variant=ghost],[data-variant=quiet],[data-variant=tool],[data-variant=small]):hover:not(:disabled),.daw-wb-zoombtn:hover:not(:disabled){background:color-mix(in srgb,var(--daw-text,#24262c) 8%,transparent);color:var(--daw-text,#24262c)}",
			".daw-wb-btn[data-on=true],.daw-wb-btn[data-variant=tool][aria-pressed=true],.daw-wb-zoombtn[data-on=true]{background:color-mix(in srgb,var(--daw-text,#24262c) 13%,transparent);color:var(--daw-text,#24262c);font-weight:650}",
			".daw-wb-btn[data-variant=danger]{background:var(--daw-danger-bg,#fff1f1);color:var(--daw-danger,#a72835)}.daw-wb-btn[data-variant=danger]:hover:not(:disabled){background:color-mix(in srgb,var(--daw-danger,#a72835) 15%,var(--daw-surface,#fff))}",
			".daw-wb-btn[data-variant=small],.daw-wb-zoombtn{min-height:30px;padding:0 10px}",
			".daw-wb-board-tools{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:var(--daw-surface-muted,#f4f5f7);border:1px solid var(--daw-border,#dce2ee)}",
			".daw-wb-board-tools>.daw-wb-btn{min-height:28px;padding:0 8px;border-radius:6px}",
			".daw-wb-stats{display:flex;gap:12px;flex-wrap:wrap}",
			".daw-wb-stat{flex:1;min-width:180px;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:14px 16px}",
			".daw-wb-stat-v{font-size:22px;font-weight:700;color:var(--daw-text);font-variant-numeric:tabular-nums}",
			".daw-wb-stat-n{font-size:10.5px;color:var(--daw-text-muted);margin-top:2px}",
			".daw-wb-grid{display:flex;flex-wrap:wrap;gap:16px}",
			".daw-wb-card{width:380px;max-width:100%;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;text-align:left;font-family:inherit;cursor:pointer;color:inherit}",
			".daw-wb-card:hover{border-color:var(--daw-brand)}",
			".daw-wb-card-head{display:flex;align-items:center;gap:10px}",
			".daw-wb-reqs{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--daw-border);padding-top:10px}",
			".daw-wb-req{display:flex;flex-direction:column;gap:3px;padding:6px 8px;border-radius:8px;background:var(--daw-surface-muted)}",
			".daw-wb-req[data-attention]:not([data-attention=\"\"]){outline:1px solid var(--daw-danger)}",
			".daw-wb-req[data-virtual=true]{opacity:.75}",
			".daw-wb-req-top{display:flex;align-items:center;gap:8px;min-width:0}",
			".daw-wb-req-title{flex:1;min-width:0;font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".daw-wb-req-attn{font-size:10.5px;font-weight:700;color:var(--daw-danger);white-space:nowrap}",
			".daw-wb-req-meta{display:flex;gap:10px;font-size:10.5px;color:var(--daw-text-secondary)}",
			".daw-wb-req-next{font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-req-more,.daw-wb-req-empty{font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-req-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".daw-wb-card[data-attention]:not([data-attention=\"\"]){outline:1px solid var(--daw-danger)}",
			".daw-wb-e2erun{display:flex;flex-direction:column;gap:8px;border:1px solid var(--daw-border);border-radius:10px;padding:10px 12px;background:var(--daw-surface)}",
			".daw-wb-e2erun-head{display:flex;align-items:center;gap:8px}",
			".daw-wb-case{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;background:var(--daw-surface-muted)}",
			".daw-wb-case[data-status=failed],.daw-wb-case[data-status=error]{outline:1px solid var(--daw-danger)}",
			".daw-wb-case-top{display:flex;align-items:center;gap:8px}",
			".daw-wb-case-title{font-size:12px;font-weight:700}",
			".daw-wb-case-note{font-size:11px;color:var(--daw-text-secondary)}",
			".daw-wb-case-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
			".daw-wb-shots{display:flex;gap:8px;flex-wrap:wrap}",
			".daw-wb-shot{position:relative;display:inline-block;line-height:0;border:1px solid var(--daw-border);border-radius:6px;overflow:hidden;cursor:crosshair}",
			".daw-wb-shot[data-picked=true]{outline:2px solid var(--daw-accent)}",
			".daw-wb-shot img{max-width:320px;max-height:220px;display:block;user-select:none}",
			".daw-wb-shot-box{position:absolute;border:2px solid var(--daw-danger);background:rgba(192,38,45,.12);pointer-events:none}",
			".daw-wb-shot-box[data-handled=true]{border-style:dashed;opacity:.55}",
			".daw-wb-ann{display:flex;align-items:center;gap:8px;font-size:11.5px}",
			".daw-wb-ann[data-handled=true]{opacity:.6}",
			".daw-wb-ann-edit{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-wb-ann-edit .daw-wb-input{flex:1;min-width:200px;width:auto}",
			".daw-wb-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
			".daw-wb-filters button{padding:4px 12px;border-radius:999px;border:1px solid var(--daw-border);background:var(--daw-surface);color:var(--daw-text-secondary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}",
			".daw-wb-filters button[data-on=true]{background:var(--daw-brand);border-color:var(--daw-brand);color:var(--daw-on-brand,#fff);font-weight:700}",
			".daw-wb-filters .daw-wb-owner-filter{width:auto;min-width:180px;max-width:280px}",
			".daw-wb-zoomlevel{margin-left:10px;padding:2px 8px;border-radius:999px;background:var(--daw-surface-muted)}",
			".daw-wb-flow[data-zoom=far] .daw-wb-reqnode .daw-wb-req-next,.daw-wb-flow[data-zoom=far] .daw-wb-reqnode .daw-wb-reqnode-top .daw-wb-note,.daw-wb-flow[data-zoom=far] .daw-wb-node-sub{display:none}",
			".daw-wb-flow[data-zoom=far] .daw-wb-reqnode-title{font-size:18px;max-width:150px}",
			".daw-wb-flow[data-zoom=mid] .daw-wb-reqnode .daw-wb-req-next{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
			".daw-wb-flow[data-zoom=near] .daw-wb-reqnode-title{max-width:200px}",
			".daw-wb-reqnode{gap:8px}",
			".daw-wb-reqnode[data-attention]:not([data-attention=\"\"]){border-color:var(--daw-danger);box-shadow:0 0 0 1px var(--daw-danger),0 2px 10px rgba(17,25,50,.07)}",
			".daw-wb-reqnode-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}",
			".daw-wb-reqnode-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-wb-cfg-body{display:flex;flex-direction:column;gap:10px;max-width:520px}",
			".daw-wb-cfg-field{display:flex;flex-direction:column;gap:4px}",
			".daw-wb-upload{position:relative;display:inline-flex;cursor:pointer}",
			".daw-wb-upload input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%}",
			".daw-wb-card-icon{width:30px;height:30px;flex:none;border-radius:9px;background:var(--daw-surface-muted);display:flex;align-items:center;justify-content:center;font-size:13px}",
			".daw-wb-card-title{font-size:13px;font-weight:700;color:var(--daw-text)}",
			".daw-wb-card-fill{flex:1}",
			".daw-wb-progress{height:6px;border-radius:999px;background:var(--daw-surface-muted);overflow:hidden}",
			".daw-wb-progress i{display:block;height:100%;border-radius:999px;background:var(--daw-brand)}",
			".daw-wb-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:10.5px;color:var(--daw-text-secondary)}",
			".daw-wb-card-note{font-size:11px;color:var(--daw-text-muted)}",
			".daw-wb-empty{width:380px;max-width:100%;min-height:180px;background:var(--daw-surface);border:1px dashed var(--daw-border);border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}",
			".daw-wb-empty-icon{font-size:22px}",
			".daw-wb-empty-title{font-size:13px;font-weight:700}",
			".daw-wb-empty-desc{font-size:11px;color:var(--daw-text-muted)}",
			".daw-wb-table{background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;overflow:hidden}",
			".daw-wb-tr{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--daw-border)}",
			".daw-wb-tr:last-child{border-bottom:0}",
			".daw-wb-tr[data-head=true]{background:var(--daw-surface-muted);font-size:10.5px;font-weight:700;color:var(--daw-text-muted)}",
			".daw-wb-td{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".daw-wb-td-task{flex:1;min-width:160px}",
			".daw-wb-td-owner{width:120px;flex:none}",
			".daw-wb-td-dep{width:130px;flex:none}",
			".daw-wb-td-where{width:110px;flex:none}",
			".daw-wb-td-report{width:130px;flex:none}",
			".daw-wb-td-status{width:96px;flex:none}",
			".daw-wb-td-time{width:64px;flex:none;font-variant-numeric:tabular-nums;color:var(--daw-text-secondary)}",
			".daw-wb-td-route{width:190px;flex:none}",
			".daw-wb-td-summary{flex:1;min-width:160px}",
			".daw-wb-td-result{width:170px;flex:none}",
			".daw-wb-td-evidence{width:120px;flex:none;font-variant-numeric:tabular-nums;color:var(--daw-text-muted)}",
			".daw-wb-td-actions{width:150px;flex:none;display:flex;gap:6px;justify-content:flex-end}",
			".daw-wb-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:700;background:var(--daw-surface-muted);color:var(--daw-text-secondary);white-space:nowrap}",
			".daw-wb-chip i{width:6px;height:6px;flex:none;border-radius:50%;background:currentColor}",
			".daw-wb-chip[data-tone=ok]{background:var(--daw-ok-bg);color:var(--daw-ok)}",
			".daw-wb-chip[data-tone=warn]{background:var(--daw-warn-bg);color:var(--daw-warn)}",
			".daw-wb-chip[data-tone=danger]{background:var(--daw-danger-bg);color:var(--daw-danger)}",
			".daw-wb-chip[data-tone=brand]{background:var(--daw-accent-bg);color:var(--daw-accent)}",
			".daw-wb-chip[data-tone=accent]{background:var(--daw-accent-bg);color:var(--daw-accent)}",
			".daw-wb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-wb-filter{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;border:1px solid var(--daw-border);background:var(--daw-surface);color:var(--daw-text-secondary);font-size:11.5px;font-family:inherit;cursor:pointer}",
			".daw-wb-filter[data-on=true]{background:var(--daw-brand);border-color:var(--daw-brand);color:var(--daw-on-brand,#fff);font-weight:700}",
			".daw-wb-filter b{font-variant-numeric:tabular-nums;opacity:.75;font-weight:700}",
			".daw-wb-toolfill{flex:1}",
			".daw-wb-note{font-size:11px;color:var(--daw-text-muted)}",
			".daw-wb-cols{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}",
			".daw-wb-panel{background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}",
			".daw-wb-panel-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--daw-text)}",
			".daw-wb-kv{display:flex;gap:10px;font-size:11.5px}",
			".daw-wb-kv-key{width:64px;flex:none;color:var(--daw-text-muted)}",
			".daw-wb-kv-val{flex:1;min-width:0;color:var(--daw-text);white-space:pre-wrap;word-break:break-word}",
			".daw-wb-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;font-size:11.5px}",
			".daw-wb-banner[data-tone=warn]{background:var(--daw-warn-bg);color:var(--daw-warn)}",
			".daw-wb-banner[data-tone=danger]{background:var(--daw-danger-bg);color:var(--daw-danger)}",
			".daw-wb-banner[data-tone=ok]{background:var(--daw-ok-bg);color:var(--daw-ok)}",
			".daw-wb-input,.daw-wb-textarea,.daw-wb-select{width:100%;padding:7px 10px;border-radius:9px;border:1px solid var(--daw-border);background:var(--daw-surface-muted);color:var(--daw-text);font-size:12px;font-family:inherit}",
			".daw-wb-textarea{min-height:64px;resize:vertical}",
			".daw-chat-artifact{min-width:0;margin-block:12px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 24%,transparent));border-radius:12px;overflow:hidden;--daw-text:currentColor;--daw-border:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 24%,transparent));--daw-surface:var(--dsw-alias-bg-layer-1,transparent)}",
			".daw-chat-artifact-head{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--daw-border)}.daw-chat-artifact-head>strong{min-width:0;overflow-wrap:anywhere}",
			".daw-chat-artifact-stage{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 5%,transparent));padding:12px 0}.daw-chat-artifact .daw-wb-btn[data-variant=quiet]{color:inherit}",
			".daw-prd-content{display:grid;gap:8px;min-width:0;overflow-wrap:anywhere}.daw-chat-prd .daw-prd-content{padding:12px;max-height:370px;overflow:auto}",
			".daw-prd-content .daw-md>:first-child,.daw-prd-content ul{margin-top:0}.daw-prd-content .daw-md>:last-child,.daw-prd-content ul{margin-bottom:0}.daw-prd-content .daw-md{min-width:0;overflow:auto}",
			".daw-prd-content .daw-md :is(h2,h3,h4,h5,h6){margin:.65em 0 .3em}.daw-prd-content pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}",
			".daw-prd-content table{border-collapse:collapse;text-align:left}.daw-prd-content :is(th,td){border:1px solid var(--daw-border,#dce2ee);padding:4px 8px}",
			".daw-prd-form{display:grid;gap:8px}.daw-prd-form label{display:grid;gap:4px}.daw-prd-form textarea{min-height:180px}",
			".daw-wb-label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--daw-text-secondary)}",
			".daw-wb-mask{position:fixed;inset:0;background:rgba(13,18,28,.44);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}",
			".daw-wb-mask-canvas{position:absolute;z-index:30}",
			".daw-wb-modal{width:560px;max-width:100%;max-height:100%;overflow:auto;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 48px rgba(10,15,30,.3)}",
			".daw-wb-modal-wide{width:min(680px,100%)}",
			".daw-wb[data-narrow='true']{width:100%;min-width:0}",
			".daw-wb[data-narrow='true'] .daw-wb-top{height:40px;padding:0 10px;gap:6px}",
			".daw-wb[data-narrow='true'] .daw-wb-tabs{padding:0 10px}",
			".daw-wb-design-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:14px;align-items:start}",
			".daw-wb-design-card{border:1px solid var(--daw-border);border-radius:12px;overflow:hidden;background:var(--daw-surface)}",
			".daw-wb-design-card-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--daw-border)}",
			".daw-wb-modal-title{font-size:14px;font-weight:700}",
			".daw-wb-modal-foot{display:flex;gap:8px;justify-content:flex-end}",
			".daw-wb-mask-review{padding:clamp(8px,2.5%,20px)}.daw-wb-review-dialog{width:min(740px,100%);height:min(800px,100%);padding:0;gap:0;overflow:hidden;display:flex;flex-direction:column;background:var(--daw-bg);border-radius:14px}",
			".daw-wb-review-top{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--daw-surface);border-bottom:1px solid var(--daw-border);flex:none}.daw-wb-review-top h2{margin:0;min-width:0;flex:1;font-size:15px;line-height:1.35;overflow-wrap:anywhere}.daw-wb-review-top .daw-wb-btn{height:32px;min-width:32px;padding:0 8px}",
			".daw-wb-review-list,.daw-wb-design-review{flex:1;min-height:0}.daw-wb-review-list{overflow:auto;padding:14px}.daw-wb-design-review{display:flex;flex-direction:column}",
			".daw-wb-review-nav{flex:none;padding:10px 14px 0;background:var(--daw-surface);border-bottom:1px solid var(--daw-border)}.daw-wb-review-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-bottom:8px}.daw-wb-review-meta .daw-wb-note{font-size:12px;line-height:1.45}",
			".daw-wb-review-tabs{display:flex;gap:2px;overflow-x:auto}.daw-wb-review-tabs button{flex:1;padding:9px 7px 10px;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;background:transparent;color:var(--daw-text-secondary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.daw-wb-review-tabs button[aria-selected=true]{font-weight:700;color:var(--daw-text);border-bottom-color:var(--daw-brand);background:var(--daw-surface-muted)}",
			".daw-wb-review-tabs button:focus-visible,.daw-wb-review-body :is(input,select,textarea,summary,a):focus-visible,.daw-wb-review-body:focus-visible{outline:2px solid var(--daw-brand);outline-offset:-2px}",
			".daw-wb-review-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px 14px;min-width:0}.daw-wb-review-body[hidden]{display:none}.daw-wb-review-body .daw-wb-panel{padding:12px}.daw-wb-review-body .daw-wb-panel p{margin:0;line-height:1.5}",
			".daw-wb-review-design-hd,.daw-wb-review-confirm,.daw-wb-handoff-head,.daw-wb-handoff-person{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-width:0}.daw-wb-review-design-hd label{display:grid;gap:4px;min-width:0;flex:1}.daw-wb-review-confirm{flex:none;padding:9px 14px;border-top:1px solid var(--daw-border);background:var(--daw-surface);justify-content:space-between}.daw-wb-review-confirm .daw-wb-note{font-size:12px}",
			".daw-wb-review-comments{display:grid;gap:6px;margin:0;padding:0;list-style:none}.daw-wb-review-comments li{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 0;border-top:1px solid var(--daw-border);font-size:12px;overflow-wrap:anywhere}.daw-wb-review-comments li>span{flex:1;min-width:140px}",
			".daw-wb-handoff-card{display:grid;gap:10px;padding:12px;border:1px solid var(--daw-border);border-radius:10px;background:var(--daw-surface)}.daw-wb-handoff-head{justify-content:space-between}.daw-wb-handoff-head>div{display:grid;gap:3px}.daw-wb-handoff-person{overflow-wrap:anywhere}.daw-wb-handoff-person .daw-wb-btn{margin-left:auto}",
			".daw-wb-handoff-form{display:flex;align-items:end;gap:8px;flex-wrap:wrap}.daw-wb-handoff-form label{flex:1 1 145px;min-width:0}.daw-wb-handoff-files{list-style:none;display:grid;gap:5px;padding:0;margin:0}.daw-wb-handoff-files li{padding:7px 9px;border-radius:6px;background:var(--daw-surface-muted);font-size:12px;overflow-wrap:anywhere}.daw-wb-handoff-files a{color:var(--daw-brand)}.daw-wb-handoff-history>summary{padding:7px 2px;color:var(--daw-text-secondary);cursor:pointer}.daw-wb-handoff-history[open]>.daw-wb-handoff-card{margin-top:8px}",
			".daw-wb-canvaswrap{position:absolute;inset:0}",
			".daw-wb-canvas-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;background:var(--daw-bg);color:var(--daw-text-secondary)}",
			// 画布全屏化后，跟在舞台后面的工具条与提示条被 inset:0 的舞台整个盖住——「删除」「一键全清」
			// 「新 / 经典画布」从来点不到（2026-11-17 真机：React Flow 控件 intercepts pointer events）。改成浮在舞台之上。
			".daw-wb-canvaswrap>.daw-wb-toolbar{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:21;width:max-content;max-width:min(720px,calc(100% - 32px));flex-wrap:wrap;justify-content:center;gap:6px;padding:8px 10px;border:1px solid var(--daw-border);border-radius:10px;background:var(--daw-surface);box-shadow:0 6px 18px rgba(0,0,0,.08)}",
			".daw-wb-canvaswrap>.daw-wb-toolbar>.daw-wb-note{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}",
			".daw-wb-canvaswrap>.daw-wb-toolbar>.daw-wb-btn{flex:0 0 auto}.daw-wb-canvaswrap>.daw-wb-toolbar>.daw-wb-btn[data-variant=ghost]{border-color:transparent}",
			".daw-wb[data-narrow='true'] .react-flow__minimap{display:none}",
			".daw-wb-canvaswrap>.daw-wb-banner{position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:22;max-width:560px}",
			".daw-wb-node{position:absolute;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:10px 12px;box-shadow:0 2px 10px rgba(17,25,50,.07);cursor:grab;user-select:none;display:flex;flex-direction:column;gap:6px}",
			".daw-wb-node[data-kind=guide]{border-style:dashed;box-shadow:none}",
".daw-wb-node[data-selected=true]{outline:2px solid var(--daw-brand);outline-offset:1px}",
			".daw-wb-node-head{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--daw-text-muted)}",
			".daw-wb-node-tag{width:22px;height:22px;flex:none;border-radius:7px;background:var(--daw-surface-muted);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--daw-text-secondary)}",
			".daw-wb-node-fill{flex:1}",
			".daw-wb-node-name{font-size:12.5px;font-weight:700;color:var(--daw-text)}",
			".daw-wb-node-sub{font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-node-row{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--daw-text-secondary)}",
			".daw-wb-goal{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;background:var(--daw-accent-bg);color:var(--daw-accent);font-size:11.5px;font-weight:700}",
			".daw-wb-goal i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--daw-accent)}",
			".daw-wb-goal-badge{padding:1px 8px;border-radius:999px;background:rgba(255,255,255,.5);font-size:10px}",
			".daw-wb-inspect{margin-top:10px;padding:10px 12px;border:1px solid var(--daw-border);border-radius:10px;background:var(--daw-surface)}",
			".daw-wb-inspect-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-wb-inspect-kind{flex:none;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--daw-text-muted)}",
			".daw-wb-inspect-title{flex:none;font-weight:600;color:var(--daw-text)}",
			".daw-wb-inspect-body{display:flex;flex-direction:column;gap:6px;margin-top:8px}",
			".daw-wb-inspect-tasks{display:flex;flex-direction:column;gap:4px}",
			".daw-wb-inspect-task{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}",
			".daw-wb-inspect-task-subject{min-width:0;color:var(--daw-text)}",
			".daw-wb-inspect-task-where{font-size:11px;color:var(--daw-text-muted);font-family:ui-monospace,SFMono-Regular,monospace}",
			".daw-wb-inspect-task-blocked{font-size:11px;color:var(--daw-danger)}",
			".daw-wb-inspect-label{flex:none;font-size:11px;color:var(--daw-text-muted)}",
			".daw-wb-inspect-note{font-size:11.5px;color:var(--daw-text-secondary)}",
						".daw-wb-inspect-goal{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--daw-border);border-radius:8px}",
			".daw-wb-inspect-goal-read{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-wb-inspect-goal-text{min-width:0;font-size:11.5px;color:var(--daw-text)}",
			".daw-wb-inspect-goal-edit{display:flex;flex-direction:column;gap:6px}",
			".daw-wb-inspect-goal-input{width:100%;min-height:56px;padding:6px 8px;border:1px solid var(--daw-border);border-radius:6px;background:var(--daw-bg);color:var(--daw-text);font-family:inherit;font-size:11.5px;line-height:1.5;resize:vertical}",
			".daw-wb-inspect-goal-actions{display:flex;gap:6px;justify-content:flex-end}",
			".daw-wb-inspect-goal-error{font-size:11px;color:var(--daw-danger)}",
".daw-wb-inspect-done{font-size:11px;color:var(--daw-text-muted);font-variant-numeric:tabular-nums}",
			".daw-wb-inspect-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-wb-inspect-toollist{display:flex;gap:4px;flex-wrap:wrap;min-width:0}",
			".daw-wb-inspect-tool{padding:1px 6px;border-radius:5px;background:var(--daw-surface-muted);border:1px solid var(--daw-border);font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--daw-text-secondary)}",
			".daw-wb-inspect-toolcount{flex:none;font-size:11px;color:var(--daw-text-muted);font-variant-numeric:tabular-nums}",
			".daw-wb-ticket{background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
			".daw-wb-ticket-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:var(--daw-text-secondary);background:var(--daw-surface-muted);border-radius:9px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;max-height:96px;overflow:auto}",
			".daw-office-controls{display:flex;gap:2px;padding:3px;border:1px solid var(--daw-border);border-radius:9px;background:var(--daw-surface)}",
			".daw-office-controls>.daw-wb-btn{min-height:29px;padding-inline:11px;border-radius:6px}",
			".daw-office-controls>.daw-wb-btn[aria-pressed=true]{background:var(--daw-text);color:var(--daw-surface);font-weight:700}",
			".daw-office-room{position:relative;isolation:isolate;container:office / inline-size;--office-room:#e8dfcf;--office-card:#faf7ef;--office-line:#d6cbb8;--office-ink:#252b23;--office-muted:#536054;--office-focus:#3e6953;--office-wait:#674212;--office-wait-bg:#f2e2c5;border:1px solid var(--office-line);border-radius:14px;background:var(--office-room);color:var(--office-ink);overflow:hidden}",
			".daw-office-room[data-scene=night]{--office-room:#192221;--office-card:#25312f;--office-line:#64746b;--office-ink:#f4eddf;--office-muted:#c1cbbf;--office-focus:#a2d6ba;--office-wait:#f7dfa3;--office-wait-bg:#4d3923}",
			".daw-office-stage{position:relative;aspect-ratio:2 / 1;background:var(--office-room);overflow:hidden}",
			".daw-office-backdrop{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none}",
			".daw-office-stage img[hidden]{display:none}",
			".daw-office-fixture,.daw-office-actor{position:absolute;left:var(--home-x);top:var(--home-y);transform:translate(-50%,-100%);pointer-events:none}",
			".daw-office-fixture{width:12.5%;z-index:1;filter:drop-shadow(0 2px 3px #24160945)}",
			".daw-office-actor{width:11%;aspect-ratio:3 / 4;z-index:2}",
			".daw-office-actor::before{position:absolute;left:15%;right:15%;bottom:3%;height:8%;content:\"\";border-radius:50%;background:#21180d38;filter:blur(3px)}",
			".daw-office-actor[data-motion=desk],.daw-office-actor[data-motion=type]{width:14%}",
			".daw-office-room[data-dense] .daw-office-fixture{width:10%}.daw-office-room[data-dense] .daw-office-actor{width:9%}.daw-office-room[data-dense] .daw-office-actor[data-motion=desk],.daw-office-room[data-dense] .daw-office-actor[data-motion=type]{width:11%}",
			".daw-office-actor[data-motion=roam]{z-index:3;animation:daw-office-roam 20s linear infinite;animation-delay:var(--office-motion-offset)}",
			".daw-office-scene-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center bottom;filter:drop-shadow(0 2px 2px #21190f45)}",
			".daw-office-room[data-scene=night] .daw-office-scene-img,.daw-office-room[data-scene=night] .daw-office-fixture{filter:brightness(.85) saturate(.91) drop-shadow(0 2px 3px #110e0870)}",
			".daw-office-actor[data-motion=roam] .daw-office-action,.daw-office-actor[data-motion=roam] .daw-office-action-img{animation-delay:var(--office-motion-offset)}",
			".daw-office-actor[data-motion=roam] .daw-office-action{position:absolute;inset:0;opacity:0}",
			".daw-office-actor[data-motion=roam] [data-action=walk]{animation:daw-office-travel 20s linear infinite;animation-delay:var(--office-motion-offset)}",
			".daw-office-actor[data-motion=roam] [data-action=game]{animation:daw-office-play 20s linear infinite;animation-delay:var(--office-motion-offset)}",
			".daw-office-actor[data-motion=roam] [data-action=coffee]{animation:daw-office-sip 20s linear infinite;animation-delay:var(--office-motion-offset)}",
			".daw-office-actor[data-motion=roam] [data-action=walk] .daw-office-action-img{animation:daw-office-face 20s step-end infinite;animation-delay:var(--office-motion-offset)}",
			".daw-office-actor[data-motion=roam] [data-action=walk] .daw-office-action-img img{animation:daw-office-step .54s ease-in-out infinite}",
			".daw-office-actor[data-motion=roam] .daw-office-action-img{position:absolute;inset:0}",
			".daw-office-actor[data-motion=roam] .daw-office-avatar{display:none}",
			".daw-office-actor[data-motion=type] .daw-office-action-img{animation:daw-office-type .72s steps(1,end) infinite}",
			".daw-office-actor [data-action=game] img{animation:daw-office-game 1.45s ease-in-out infinite}",
			".daw-office-actor [data-action=coffee] img{animation:daw-office-coffee 3.1s ease-in-out infinite}",
			"@keyframes daw-office-roam{0%,5%{left:var(--home-x);top:var(--home-y)}14%{left:var(--home-x);top:var(--aisle-y)}32%{left:var(--rest-x);top:var(--aisle-y)}38%,71%{left:var(--rest-x);top:var(--rest-y)}77%{left:var(--rest-x);top:var(--aisle-y)}93%{left:var(--home-x);top:var(--aisle-y)}100%{left:var(--home-x);top:var(--home-y)}}",
			"@keyframes daw-office-travel{0%,35%,74%,100%{opacity:1}39%,70%{opacity:0}}",
			"@keyframes daw-office-play{0%,34%,57%,100%{opacity:0}38%,53%{opacity:1}}",
			"@keyframes daw-office-sip{0%,53%,74%,100%{opacity:0}57%,70%{opacity:1}}",
			"@keyframes daw-office-face{0%{transform:none}72%{transform:scaleX(-1)}100%{transform:none}}",
			"@keyframes daw-office-step{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-3px) rotate(1deg)}}",
			"@keyframes daw-office-type{0%,42%,79%,100%{transform:translateY(0)}18%,60%{transform:translateY(-1.6px) rotate(-.55deg)}}",
			"@keyframes daw-office-game{0%,100%{transform:rotate(-1deg) translateY(1px)}50%{transform:rotate(1.4deg) translateY(-1px)}}",
			"@keyframes daw-office-coffee{0%,100%{transform:rotate(-1.5deg)}46%,62%{transform:translateY(-3px) rotate(2.3deg)}}",
			".daw-office-stations{position:absolute;inset:0;z-index:5;pointer-events:none}",
			".daw-office-desk{position:absolute;left:var(--home-x);bottom:12px;transform:translateX(-50%);width:min(20%,220px);min-width:0;padding:7px 9px;border:1px solid var(--office-line);border-radius:7px;background:var(--office-card);color:var(--office-ink);text-align:left;font:inherit;cursor:pointer;pointer-events:auto;box-shadow:0 2px 8px #291b1533}",
			".daw-office-desk:hover,.daw-office-desk:focus-visible{border-color:var(--office-focus)}.daw-office-desk:focus-visible{outline:2px solid var(--office-focus);outline-offset:2px}",
			"@container office (min-width:941px){.daw-office-room[data-dense] .daw-office-desk{top:calc(var(--home-y) + 2.4%);bottom:auto;width:min(18%,195px);padding:4px 6px}.daw-office-room[data-dense] .daw-office-tool,.daw-office-task small:first-child:not(:only-child){display:none}}",
			".daw-office-desk[data-attention=true]{border-color:var(--office-wait)}",
			".daw-office-info{display:grid;gap:3px;min-width:0}",
			".daw-office-name{display:flex;align-items:flex-start;justify-content:space-between;gap:4px;width:100%}.daw-office-plate{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700}.daw-office-arrow{color:var(--office-muted);font-size:12px;line-height:1.4}",
			".daw-office-chips{display:flex;gap:4px;align-items:center;flex-wrap:wrap;color:var(--office-muted)}.daw-office-room .daw-wb-chip{padding:0 5px;font-size:10px}.daw-office-room .daw-wb-chip[data-tone=neutral]{color:var(--office-muted);background:color-mix(in srgb,var(--office-ink) 8%,transparent)}.daw-office-room .daw-wb-chip[data-tone=warn]{color:var(--office-wait);background:var(--office-wait-bg)}",
			".daw-office-task{display:grid;gap:1px;width:100%;min-width:0;font-size:11.5px;line-height:1.35}",
			".daw-office-task small,.daw-office-tool{font-size:10px;color:var(--office-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.daw-office-task strong{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".daw-office-wait{display:block;max-width:100%;padding:2px 4px;border-radius:4px;background:var(--office-wait-bg);color:var(--office-wait);font-size:10px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".daw-office-pages{display:flex;align-items:center;gap:6px}.daw-office-pages .daw-wb-btn{padding:0 8px;min-height:29px}.daw-office-page-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			"@container office (max-width:940px){.daw-office-stations{position:relative;display:grid;gap:0;border-top:1px solid var(--office-line);background:var(--office-card)}.daw-office-desk{position:static;transform:none;width:100%;padding:6px 10px;border:0;border-radius:0;background:transparent;box-shadow:none}.daw-office-desk+.daw-office-desk{border-top:1px solid var(--office-line)}.daw-office-desk:focus-visible{outline-offset:-3px}.daw-office-info{gap:2px}.daw-office-task{grid-template-columns:auto minmax(0,1fr);gap:4px}.daw-office-wait{white-space:normal}.daw-office-tool{display:none}}",
			"@media (prefers-reduced-motion:reduce){.daw-office-actor[data-motion=roam],.daw-office-actor[data-motion=type] .daw-office-action-img{animation:none}.daw-office-actor[data-motion=roam]>.daw-office-avatar:not([hidden]){display:block}.daw-office-actor[data-motion=roam]>.daw-office-action{display:none;animation:none}}",
			".daw-wb-group{display:flex;flex-direction:column;gap:10px}",
			".daw-wb-group-head{display:flex;align-items:center;gap:8px}",
			".daw-wb-todo{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px}",
			".daw-wb-todo-index{width:24px;height:24px;flex:none;border-radius:999px;background:var(--daw-surface-muted);color:var(--daw-text-secondary);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}",
			".daw-wb-todo-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
			".daw-wb-todo-text{font-size:12.5px;color:var(--daw-text)}",
			".daw-wb-todo-src{font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-mcp{display:flex;flex-direction:column;gap:10px}",
			".daw-wb-mcp-group{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--daw-border);border-radius:10px;background:var(--daw-surface)}",
			".daw-wb-mcp-server{font-size:12px;font-weight:700}",
			".daw-wb-mcp-row{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer}",
			".daw-wb-mcp-row input{width:auto;margin:0}",
			".daw-wb-menu{width:180px;flex:none;display:flex;flex-direction:column;gap:2px}",
			".daw-wb-menu button{padding:7px 10px;border:0;border-radius:8px;background:none;color:var(--daw-text-secondary);font-size:12px;font-family:inherit;text-align:left;cursor:pointer}",
			".daw-wb-menu button[data-on=true]{background:var(--daw-surface-muted);color:var(--daw-text);font-weight:700}",
			".daw-wb-hero{background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:16px}",
			".daw-wb-steps{display:flex;gap:12px;flex-wrap:wrap}",
			".daw-wb-step{flex:1;min-width:200px;background:var(--daw-surface-muted);border-radius:11px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}",
			".daw-wb-step-no{width:20px;height:20px;border-radius:999px;background:var(--daw-brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}",
			".daw-wb-step-title{font-size:12.5px;font-weight:700}",
			".daw-wb-step-desc{font-size:11px;color:var(--daw-text-secondary)}",
			".daw-wb-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 24px;color:var(--daw-text-muted);font-size:12px}",
			".daw-wb-eventrow{background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}",
			".daw-wb-eventrow[data-open=true]{border-color:var(--daw-brand)}",
			".daw-wb-event-head{display:flex;align-items:center;gap:10px}",
			".daw-wb-event-src{width:64px;flex:none;font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-event-body{flex:1;min-width:0}",
			".daw-wb-event-text{font-size:12px;color:var(--daw-text)}",
			".daw-wb-event-sub{font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-timeline{display:flex;flex-direction:column;gap:0}",
			".daw-wb-tl-step{display:flex;gap:12px;padding:10px 0}",
			".daw-wb-tl-rail{width:16px;flex:none;display:flex;flex-direction:column;align-items:center}",
			".daw-wb-tl-dot{width:11px;height:11px;flex:none;border-radius:999px;background:var(--daw-text-muted);border:2px solid var(--daw-surface)}",
			".daw-wb-tl-step[data-state=done] .daw-wb-tl-dot{background:var(--daw-ok)}",
			".daw-wb-tl-step[data-state=active] .daw-wb-tl-dot{background:var(--daw-brand);box-shadow:0 0 0 3px var(--daw-accent-bg)}",
			".daw-wb-tl-step[data-state=skipped] .daw-wb-tl-dot{background:transparent;border:2px dashed var(--daw-border)}",
			".daw-wb-tl-line{flex:1;width:2px;min-height:14px;background:var(--daw-border);margin:3px 0}",
			".daw-wb-tl-step:last-child .daw-wb-tl-line{display:none}",
			".daw-wb-tl-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
			".daw-wb-tl-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".daw-wb-tl-name{font-size:12.5px;font-weight:700;color:var(--daw-text)}",
			".daw-wb-tl-when{font-size:10.5px;color:var(--daw-text-muted);font-variant-numeric:tabular-nums}",
			".daw-wb-tl-text{font-size:11.5px;color:var(--daw-text-secondary);word-break:break-word}",
			".daw-wb-tl-step[data-state=pending] .daw-wb-tl-name,.daw-wb-tl-step[data-state=skipped] .daw-wb-tl-name{color:var(--daw-text-muted);font-weight:400}",
			".daw-wb-tl-obs{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-growth{display:flex;gap:3px;width:100%;margin-top:2px}",
			".daw-wb-composer{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:2px}",
			".daw-wb-composer-input{width:100%;resize:none;border:1px solid var(--daw-border);border-radius:8px;background:var(--daw-surface-muted);color:var(--daw-text);font-family:inherit;font-size:11px;line-height:1.5;padding:6px 8px}",
			".daw-wb-composer-row{display:flex;align-items:center;gap:6px}",
			".daw-wb-chat{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:2px;cursor:auto}",
			".daw-wb-floatpanel{position:absolute;left:12px;bottom:64px;width:380px;max-width:calc(100% - 24px);max-height:calc(100% - 88px);overflow:auto;z-index:20;pointer-events:none}",
			".daw-wb-floatpanel>*{pointer-events:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)}",
			".daw-wb-plan{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--daw-border);border-radius:8px;background:var(--daw-surface-muted);font-size:12px;line-height:1.5}",
			".daw-wb-flow{position:absolute;inset:0;background:var(--daw-bg)}",
			".daw-wb-flow .react-flow{--xy-background-color:var(--daw-bg);--xy-node-background-color:transparent;--xy-node-border:none;--xy-node-boxshadow-hover:none;--xy-node-boxshadow-selected:none;--xy-minimap-background-color:var(--daw-surface);--xy-controls-button-background-color:var(--daw-surface);--xy-controls-button-color:var(--daw-text-secondary);--xy-controls-button-background-color-hover:var(--daw-surface-muted);--xy-controls-button-color-hover:var(--daw-text);--xy-controls-button-border-color:var(--daw-border);--xy-edge-label-background-color:var(--daw-surface);--xy-edge-label-color:var(--daw-text-secondary)}",
			".daw-wb-flow .react-flow__controls{gap:2px;padding:3px;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:10px;box-shadow:none}",
			".daw-wb-flow .react-flow__controls-button{width:30px;height:30px;border:0;border-radius:6px}.daw-wb-flow .react-flow__controls-button:focus-visible{outline:2px solid var(--daw-brand);outline-offset:-2px}",
			".daw-wb-flow .react-flow__node{padding:0;border:0;background:transparent;box-shadow:none;width:auto}",
			".daw-wb-flowcell{position:relative}",
			".daw-wb-node[data-kind=file] .daw-wb-node-name,.daw-wb-node[data-kind=link] .daw-wb-node-name,.daw-wb-node[data-kind=file] .daw-wb-node-sub{word-break:break-all;overflow-wrap:anywhere}",
			".daw-wb-flowcell>.daw-wb-node{position:relative!important;left:auto!important;top:auto!important;margin:0}",
			".daw-wb-flowcell .daw-wb-anchor{display:none}",
			".daw-wb-flowcell .daw-wb-node-head{cursor:grab}",
			".daw-wb-handle{width:10px;height:10px;border:2px solid var(--daw-surface);background:var(--daw-brand)}",
			".daw-wb-handle[data-handle^=t-],.daw-wb-handle[data-handle=s-b],.daw-wb-handle[data-handle=s-l],.daw-wb-handle[data-handle=s-t]{opacity:0;width:6px;height:6px}",
			".daw-wb-flowcell:hover .daw-wb-handle[data-handle^=t-]{opacity:.5}",
			".daw-wb-flow .react-flow__edge.daw-wb-edge-dependency path{stroke:var(--daw-brand)}",
			".daw-wb-flow .react-flow__edge.daw-wb-edge-relay path{stroke:var(--daw-text-muted)}",
			".daw-wb-flow .react-flow__edge.daw-wb-edge-context path{stroke:var(--daw-text-secondary)}",
			".daw-wb-flow .react-flow__edge.selected path{stroke:var(--daw-danger)}",
			".daw-wb-flow .react-flow__edge.daw-wb-edge-flow path{stroke:var(--daw-ok)}",
			".daw-wb-flow .react-flow__edge.daw-wb-edge-view path{stroke:var(--daw-accent)}",
			".daw-wb-flow .react-flow__edge.daw-wb-edge-side path{stroke:var(--daw-brand)}",
			".daw-wb-flowgroup{border:1.5px dashed var(--daw-ok);border-radius:12px;background:color-mix(in srgb,var(--daw-ok-bg) 55%,transparent)}",
			".daw-wb-reqframe{box-sizing:border-box;position:relative;border:1.5px dashed var(--daw-border);border-radius:14px;background:color-mix(in srgb,var(--daw-brand) 4%,transparent);pointer-events:none}",
			".daw-wb-reqframe[data-attention]:not([data-attention=\"\"]){border-color:var(--daw-danger)}",
			".daw-wb-reqframe-head{position:absolute;left:14px;right:14px;top:8px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--daw-text-secondary);overflow:hidden;white-space:nowrap}",
			".daw-wb-reqframe-title{font-weight:700;color:var(--daw-text);overflow:hidden;text-overflow:ellipsis}",
			".daw-wb-flow[data-zoom=far] .daw-wb-reqframe-head{font-size:20px;top:2px}",
			".daw-wb-flow[data-zoom=far] .daw-wb-reqframe-title{font-size:24px}",
			".daw-wb-flowgroup-head{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:grab;font-size:12px;color:var(--daw-text);white-space:nowrap}",
			".daw-wb-flowgroup-head>b{overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".daw-wb-flowgroup-head>button,.daw-wb-flowgroup-head>.daw-wb-flowstep-ai{flex:none;white-space:nowrap}",
			".daw-wb-flowstep{position:relative;display:flex;align-items:center;justify-content:center;padding:6px 10px;border:1.5px solid var(--daw-ok);background:var(--daw-surface);color:var(--daw-text);font-size:12px;line-height:1.35;text-align:center;border-radius:10px}",
			".daw-wb-flowstep[data-shape=start],.daw-wb-flowstep[data-shape=end]{border-radius:999px;background:var(--daw-ok-bg)}",
			".daw-wb-flowstep[data-shape=decision]{border:0;background:transparent}",
			".daw-wb-flowstep[data-shape=decision]::before{content:'';position:absolute;inset:16px;transform:rotate(45deg);border:1.5px solid var(--daw-warn);background:var(--daw-warn-bg);border-radius:6px}",
			".daw-wb-flowstep-text{position:relative;max-width:100%;word-break:break-word}",
			// 内联编辑输入框（双击节点就地改字）：占满节点、无边框、跟正文同字体，看着像"字自己变成可编辑了"
			".daw-wb-flowstep-input{position:relative;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary,#3B55F0);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;text-align:center;padding:2px 4px;outline:none}",
			".daw-wb-flowstep[data-editing=true]{cursor:text}",
			".daw-wb-flowstep[data-shape=decision] .daw-wb-flowstep-text{max-width:84px}",
			".daw-wb-flowstep-ai{position:relative;font-size:10px;line-height:1;padding:2px 5px;border-radius:999px;background:var(--daw-accent-bg);color:var(--daw-accent);font-weight:600}",
			".daw-wb-flowstep>.daw-wb-flowstep-ai{position:absolute;top:-8px;right:-6px}",
			".daw-wb-flowbar{position:absolute;top:12px;left:12px;z-index:6;display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--daw-border);border-radius:8px;background:var(--daw-surface)}",
			".daw-wb-legend{position:absolute;top:59px;left:12px;z-index:6;padding:6px 9px;border:1px solid var(--daw-border);border-radius:8px;background:var(--daw-surface);font-size:11px;color:var(--daw-text-secondary)}",
			".daw-wb-legend-title{font-weight:600;color:var(--daw-text);cursor:pointer}.daw-wb-legend[open] summary{margin-bottom:6px}.daw-wb-legend[open] .daw-wb-legend-row{padding:2px 0}",
			".daw-wb-legend-row{display:flex;align-items:center;gap:6px}",
			".daw-wb-legend-line{stroke:var(--daw-text-muted);stroke-width:2}",
			".daw-wb-legend-line[data-kind=dependency]{stroke:var(--daw-brand)}",
			".daw-wb-legend-line[data-kind=relay]{stroke-dasharray:6 4}",
			".daw-wb-legend-line[data-kind=context]{stroke-width:6;stroke-opacity:.3}",
			".daw-wb-legend-line[data-kind=flow]{stroke:var(--daw-ok)}",
			".daw-wb-legend-line[data-kind=view]{stroke:var(--daw-accent);stroke-dasharray:1 3}",
			".daw-wb-legend-line[data-kind=side]{stroke:var(--daw-brand);stroke-dasharray:10 5}",
			// 浮层容器不占盒子：里面的弹窗 / 连线检视 / 原型编辑器各自 absolute 定位到画布上（真机 2026-11-17：
			// 原来 position:relative 的空盒让原型编辑器 inset:0 塌成 0×0，点「编辑」什么都看不见）
			".daw-wb-flow-overlay{display:contents}",
			".daw-wb-plan-title{font-weight:600;color:var(--daw-text)}",
			".daw-wb-chat-status{display:flex;align-items:center;gap:6px}",
			".daw-wb-chat-preview{display:grid;gap:4px;padding:8px 10px;border:1px solid var(--daw-border);border-radius:8px;background:var(--daw-surface-muted)}",
			".daw-wb-chat-preview b{font-size:11px;color:var(--daw-text-secondary);font-weight:600}",
			".daw-wb-chat-preview p{margin:0;font-size:12px;line-height:1.5;color:var(--daw-text);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere}",
			".daw-wb-question{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--daw-warn);border-radius:8px;background:var(--daw-surface);user-select:text;max-height:260px;overflow:auto}",
			".daw-wb-question-item{display:flex;flex-direction:column;gap:4px}",
			".daw-wb-question-item b{font-size:11px;color:var(--daw-text-muted);font-weight:600}",
			".daw-wb-question-text{font-size:12px;line-height:1.5;color:var(--daw-text);white-space:pre-wrap;word-break:break-word}",
			".daw-wb-question-detail{font-size:11px;line-height:1.5;color:var(--daw-text-secondary);white-space:pre-wrap;word-break:break-word;max-height:72px;overflow:auto}",
			".daw-wb-question-option{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;text-align:left;font:inherit;font-size:11px;line-height:1.4;padding:5px 8px;border:1px solid var(--daw-border);border-radius:6px;background:var(--daw-surface-muted);color:var(--daw-text);cursor:pointer}",
			".daw-wb-question-option[data-selected=true]{border-color:var(--daw-accent);background:var(--daw-accent-bg)}",
			".daw-wb-question-option:disabled{cursor:default;opacity:.75}",
			".daw-wb-question-option span{color:var(--daw-text-muted)}",
			".daw-wb-question-custom{width:100%;border:1px solid var(--daw-border);border-radius:6px;background:var(--daw-surface-muted);color:var(--daw-text);font:inherit;font-size:11px;padding:4px 8px}",
			".daw-wb-start{display:flex;justify-content:center;padding:48px 16px}",
			".daw-wb-start-card{display:flex;flex-direction:column;gap:10px;width:560px;max-width:100%;padding:16px;border:1px solid var(--daw-border);border-radius:12px;background:var(--daw-surface);box-shadow:0 8px 24px rgba(0,0,0,.08)}",
			".daw-wb-start-ws{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--daw-text-secondary)}",
			".daw-wb-start-ws select{flex:1;border:1px solid var(--daw-border);border-radius:6px;background:var(--daw-surface-muted);color:var(--daw-text);padding:4px 6px;font:inherit}",
			".daw-wb-growth-seg{flex:1 1 0;height:4px;min-width:0;border-radius:999px;background:var(--daw-border)}",
			".daw-wb-growth-seg[data-state=done]{background:var(--daw-ok)}",
			".daw-wb-growth-seg[data-state=active]{background:var(--daw-brand)}",
			".daw-wb-growth-seg[data-state=skipped]{background:transparent;border:1px dashed var(--daw-border)}",
			".daw-wb-tl-entries{max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:6px}",
			".daw-wb-tl-entry{display:flex;gap:8px;font-size:11px}",
			".daw-wb-tl-entry time{flex:none;width:46px;color:var(--daw-text-muted);font-variant-numeric:tabular-nums}",
		].join("");

		// ── M6 工作台数据访问（与工具侧同一个宿主路由；不建第二事实源）────────────

		function wbToken() {
			var snap = toolActivity.getSnapshot();
			return snap && typeof snap.controlToken === "string" ? snap.controlToken : "";
		}

		/**
		 * 调宿主路由。写操作带 x-whales-token（同源证明，与既有命令路由同一把）；
		 * 失败时抛出带宿主 msg 的 Error，页面显示「读不到数据 + 重试」。
		 */
		function wbApi(path, options) {
			var doFetch = resolveFetch();
			if (typeof doFetch !== "function") return Promise.reject(new Error("fetch unavailable"));
			var opts = options || {};
			var headers = { "content-type": "application/json" };
			var token = wbToken();
			if (token !== "") headers["x-whales-token"] = token;
			return doFetch(WB_API + path, {
				method: opts.method || "GET",
				headers: headers,
				body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
			}).then(function (res) {
				if (res && res.ok) return typeof res.json === "function" ? res.json() : null;
				var status = res && typeof res.status === "number" ? res.status : 0;
				return Promise.reject(new Error("http " + status));
			});
		}

		/**
		 * 写操作专用：与 wbApi 同一把令牌，但 4xx 也解析响应体，把宿主给的原因（msg）原样抛给界面
		 * （wbApi 对非 2xx 只抛 "http 400"，用户看不到「没有原型帧」这类真原因）。成功返回 data。
		 */
		function wbWrite(path, method, body) {
			var doFetch = resolveFetch();
			if (typeof doFetch !== "function") return Promise.reject(new Error("fetch unavailable"));
			var headers = { "content-type": "application/json" };
			var token = wbToken();
			if (token !== "") headers["x-whales-token"] = token;
			return doFetch(WB_API + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(function (res) {
				var status = res && typeof res.status === "number" ? res.status : 0;
				var parse = res && typeof res.json === "function" ? res.json() : Promise.resolve(null);
				return Promise.resolve(parse).catch(function () { return null; }).then(function (payload) {
					if (payload && typeof payload === "object" && typeof payload.code === "number") {
						if (payload.code === 200) return payload.data === undefined ? null : payload.data;
						var error = new Error(typeof payload.msg === "string" && payload.msg !== "" ? payload.msg : "code " + payload.code);
						error.data = payload.data;
						throw error;
					}
					throw new Error("http " + status);
				});
			});
		}

		/** 信封解包：code !== 200 一律当失败（宿主业务码语义见 lib/index.js）。 */
		function wbUnwrap(payload) {
			if (!payload || typeof payload !== "object") throw new Error("bad payload");
			var code = typeof payload.code === "number" ? payload.code : 0;
			if (code !== 200) throw new Error(typeof payload.msg === "string" && payload.msg !== "" ? payload.msg : ("code " + code));
			return payload.data === undefined ? null : payload.data;
		}

		/**
		 * 宿主里有几条老路由返回的是裸 JSON（没有 {code,msg,data} 信封），/activity 是其中之一
		 * （同一个响应还要给鲸鱼头顶的活动轮询用，见 toolActivity）。照信封解包会因为缺 code 抛 "code 0"，
		 * 于是 useWb("/activity") 在真机上永远是报错态——执行页的「$ 工具」与办公室姿势都拿不到数据；
		 * 假宿主一直把它包成信封返回，单元测试因此没暴露（2026-11-18 办公室真机验证时发现）。
		 * 这里对白名单路径放行裸 JSON；若哪天宿主改成信封，带数字 code 的响应仍按信封解。
		 */
		function wbIsRawPath(url) {
			return typeof url === "string" && (url === "/activity" || url.indexOf("/activity?") === 0);
		}

		function wbUnwrapRaw(payload) {
			if (!payload || typeof payload !== "object") throw new Error("bad payload");
			return typeof payload.code === "number" ? wbUnwrap(payload) : payload;
		}

		/**
		 * 只读资源缓存：一个 URL 一份快照，多个组件共享。
		 * 不再定时轮询：写操作后主动失效，用户点刷新或窗口重新获得焦点时同步；
		 * 内容没变不发布新快照，避免重绘画布、打断拖拽与输入。
		 */
		var wbCache = (function () {
			var entries = {};
			var focusListening = false;
			var lastFocusAt = 0;
			/** 调用方还没有 lead 会话时可传 null：返回常量空快照，不建 entry、不发请求。 */
			var EMPTY_VIEW = { data: undefined, error: null, loading: false, at: 0 };
			function liveUrl(url) { return typeof url === "string" && url !== ""; }
			function entryOf(url) {
				var entry = entries[url];
				if (entry === undefined) {
					entry = {
						url: url, data: undefined, error: null, loading: false, at: 0,
						listeners: new Set(), timer: null, inflight: null, reloadRequested: false, view: { data: undefined, error: null, loading: false, at: 0 }
					};
					entries[url] = entry;
				}
				return entry;
			}
			function publish(entry) {
				var next = { data: entry.data, error: entry.error, loading: entry.loading, at: entry.at };
				var prev = entry.view;
				if (prev.data === next.data && prev.error === next.error && prev.loading === next.loading && prev.at === next.at) return;
				entry.view = next;
				entry.listeners.forEach(function (listener) { listener(); });
			}
			function load(entry, forceReload) {
				if (entry.inflight !== null) { if (forceReload === true) entry.reloadRequested = true; return entry.inflight; }
				var initial = entry.data === undefined && entry.at === 0;
				var changed = false;
				entry.loading = true;
				entry.inflight = wbApi(entry.url).then(function (payload) {
					var next = wbIsRawPath(entry.url) ? wbUnwrapRaw(payload) : wbUnwrap(payload);
					if (JSON.stringify(next) !== JSON.stringify(entry.data)) {
						entry.data = next;
						entry.at = Date.now();
						changed = true;
					}
					if (entry.error !== null) changed = true;
					entry.error = null;
				}).catch(function (error) {
					// 信封业务码非 200 是在「履行路径里抛错」，只挂第二参捕获不到，必须用 catch。
					var message = error && error.message ? error.message : String(error);
					changed = entry.error !== message;
					entry.error = message;
				}).then(function () {
					entry.loading = false;
					entry.inflight = null;
					if (initial || changed) publish(entry);
					// 写操作发生在旧 GET 期间：旧快照发布后必须再拉一次，不能吞掉 invalidate。
					if (entry.reloadRequested) {
						entry.reloadRequested = false;
						if (entry.listeners.size > 0) { entry.inflight = load(entry); return entry.inflight; }
					}
				});
				// 先挂 inflight 再发布初始 loading：同步 listener 重入 read/invalidate 时才能正确去重。
				if (initial) publish(entry);
				return entry.inflight;
			}
			function refreshVisible() {
				if (typeof document !== "undefined" && document && document.hidden === true) return;
				var now = Date.now();
				if (now - lastFocusAt < 1000) return;
				lastFocusAt = now;
				Object.keys(entries).forEach(function (url) {
					if (entries[url].listeners.size > 0) load(entries[url], true);
				});
			}
			function ensureFocusListening() {
				if (focusListening || typeof window === "undefined" || !window || typeof window.addEventListener !== "function") return;
				window.addEventListener("focus", refreshVisible);
				if (typeof document !== "undefined" && document && typeof document.addEventListener === "function") document.addEventListener("visibilitychange", refreshVisible);
				focusListening = true;
			}
			return {
				subscribe: function (url, listener) {
					if (!liveUrl(url)) return function () {};
					var entry = entryOf(url);
					entry.listeners.add(listener);
					if (entry.listeners.size === 1) {
						ensureFocusListening();
						load(entry);
						// 只有执行台/办公室的实时活动保留轮询；项目、画布、任务等不定时刷新。
						if (url === "/activity") entry.timer = setInterval(function () {
							if (typeof document === "undefined" || !document || document.hidden !== true) load(entry);
						}, 5000);
					}
					return function () {
						entry.listeners.delete(listener);
						if (entry.listeners.size === 0 && entry.timer !== null) { clearInterval(entry.timer); entry.timer = null; }
					};
				},
				getSnapshot: function (url) { return liveUrl(url) ? entryOf(url).view : EMPTY_VIEW; },
				/** 立即读一次（写操作后 / 手动刷新；与后台同步共用去重）。 */
				read: function (url) {
					if (!liveUrl(url)) return Promise.resolve(undefined);
					var entry = entryOf(url);
					return load(entry).then(function () {
						if (entry.error !== null) throw new Error(entry.error);
						return entry.data;
					});
				},
				/** 前缀失效：写操作后把相关 URL 全部重拉（不动没被订阅的，避免空转）。 */
				invalidate: function (prefix) {
					Object.keys(entries).forEach(function (url) {
						if (url.indexOf(prefix) !== 0) return;
						var entry = entries[url];
						if (entry.listeners.size > 0) load(entry, true);
					});
				},
				/** 仅供离线测试：清掉所有条目与窗口监听。 */
				reset: function () {
					if (focusListening && typeof window !== "undefined" && window && typeof window.removeEventListener === "function") window.removeEventListener("focus", refreshVisible);
					if (focusListening && typeof document !== "undefined" && document && typeof document.removeEventListener === "function") document.removeEventListener("visibilitychange", refreshVisible);
					Object.keys(entries).forEach(function (url) { if (entries[url].timer !== null) clearInterval(entries[url].timer); });
					focusListening = false;
					lastFocusAt = 0;
					entries = {};
				}
			};
		})();

		/** 组件里读一份只读资源：useSyncExternalStore(订阅, 快照)。
		 *  subscribe / getSnapshot 必须按 url **稳定**：React 在 subscribe 引用变化时会
		 *  「退订 → 重订阅」，而 wbCache 的重订阅会再触发一次 load → 同步 publish → 重渲染，
		 *  在只有一个订阅者的 URL 上这就成环。inline 函数每次渲染都是新引用，正是成因。
		 *  （2026-11-16 真浏览器实测：页面 load 永不触发、主线程被占满、且没有任何报错；
		 *   真实宿主只因 fetch 比 effect 慢而被 inflight 去重挡着，响应一快就会中招。） */
		function useWb(url) {
			var subscribe = react.useCallback(function (listener) { return wbCache.subscribe(url, listener); }, [url]);
			var getSnapshot = react.useCallback(function () { return wbCache.getSnapshot(url); }, [url]);
			return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		// 用工具事件按会话和回合定位交付，回放旧对话时也能找到同一份快照。
		var whaleDesignTurnDefinition = {
			kind: DESIGN_TURN_KEY,
			match: function (event) {
				var data = event && event.data;
				if (!data || !Number.isFinite(data.turn)) return null;
				var id = String(data.turn);
				if (event.type === "turn/start") return { id: id, role: "start" };
				if (event.type === "tool/call" && (data.name === "whales_design_write" || data.name === "whales_requirement")) {
					var args = data.arguments;
					if (typeof args === "string") { try { args = JSON.parse(args); } catch (error) { args = null; } }
					if (!args || (data.name === "whales_design_write" ? args.kind !== "component"
						: (args.action === "create" || args.action === "update") && args.prd)) return { id: id, role: "update" };
				}
				if (event.type === "tool/result") return { id: id, role: "update" };
				return null;
			},
			start: function (_context, match) {
				return { turn: match.event.data.turn, calls: new Set(), deliveries: [] };
			},
			update: function (context, match) {
				var state = context.state;
				var event = match.event;
				if (event.type === "tool/call" && typeof event.data.callId === "string") {
					return Object.assign({}, state, { calls: new Set(Array.from(state.calls).concat(event.data.callId)) });
				}
				var message = event.data.message;
				var id = message && ((message.source && message.source.callId) || message.toolCallId);
				if (!state.calls.has(id) || state.deliveries.indexOf(id) >= 0 || message.isError === true) return state;
				return Object.assign({}, state, { deliveries: state.deliveries.concat(id) });
			},
			buildLocationData: function (context, scope, previous) {
				var state = context.state;
				if (scope !== "turn" || !state || state.deliveries.length === 0) return null;
				if (previous && previous.value === state.deliveries) return previous;
				return { kind: "turn", turn: state.turn, key: DESIGN_TURN_KEY, value: state.deliveries };
			}
		};

		function WhaleDesignTurnTail(props) {
			var turn = props.turn;
			var source = turn && turn.data && typeof turn.data.source === "function" ? turn.data.source(DESIGN_TURN_KEY) : null;
			var calls = react.useSyncExternalStore(source ? source.subscribe : EMPTY_STORE.subscribe, source ? source.getSnapshot : function () { return undefined; });
			if (!Array.isArray(calls) || typeof props.sessionId !== "string" || props.sessionId === "") return null;
			return calls.map(function (callId) {
				return h(WhaleDesignDeliveryCard, { key: callId, sessionId: props.sessionId, callId: callId, t: props.t, openFile: props.openFile });
			});
		}

		function WhaleDesignDeliveryCard(props) {
			var t = wbT(props);
			react.useEffect(function () {
				activityPoll.start();
				return function () { activityPoll.stop(); };
			}, []);
			var token = react.useSyncExternalStore(toolActivity.subscribe, wbToken, wbToken);
			var url = "/design/delivery?sessionId=" + encodeURIComponent(props.sessionId) + "&callId=" + encodeURIComponent(props.callId);
			var delivery = useWb(token ? url : null).data;
			var chunk = react.useSyncExternalStore(wbDesignLoader.subscribe, wbDesignLoader.get, wbDesignLoader.get);
			react.useEffect(function () { if (delivery && delivery.type !== "prd") wbDesignLoader.load(); }, [delivery]);
			if (!delivery) return null;
			if (delivery.type === "prd") return h("section", { className: "daw-chat-artifact daw-chat-prd", "data-whales-prd-delivery": props.callId },
				h("header", { className: "daw-chat-artifact-head" },
					h("strong", null, delivery.title, " · PRD v" + delivery.version),
					h(WbBtn, { variant: "quiet", onClick: function () {
						wbOpenArtifact(props.sessionId, delivery.projectId, "req:" + delivery.reqId, delivery.reqId);
					} }, t("canvas.design.chatOpen"))),
				h(WbPrdContent, { prd: delivery.prd, acceptance: delivery.acceptance, openFile: props.openFile, t: t }));
			var board = delivery.boards.find(function (item) { return item.id === delivery.entryId; });
			if (!board) return null;
			return h("section", { className: "daw-chat-artifact", "aria-label": board.title || board.id, "data-whales-design-delivery": props.callId },
			h("header", { className: "daw-chat-artifact-head" },
				h("strong", null, board.title || board.id),
				h(WbBtn, { variant: "quiet", onClick: function () { wbOpenDesignDelivery(props.sessionId, delivery); } }, t("canvas.design.chatOpen"))),
			h("div", { className: "daw-chat-artifact-stage" }, chunk.status === "ready" && typeof chunk.lib.DesignChatPreview === "function"
				? h(chunk.lib.DesignChatPreview, { delivery: delivery, backLabel: t("canvas.design.chatBack") })
				: h("p", { role: "status", style: { padding: "0 12px 8px" } },
					t(chunk.status === "failed" || chunk.status === "unavailable" ? "canvas.design.chatUnavailable" : "canvas.design.chatLoading"))));
		}

		/** 宿主文件变更通知：只失效受影响的数据，不定时全局刷新。 */
		function useStoreStream(projectId) {
			react.useEffect(function () {
				if (!projectId || typeof EventSource === "undefined") return undefined;
				var source = new EventSource(WB_API + "/store-stream?projectId=" + encodeURIComponent(projectId));
				function changed(event) {
					var payload;
					try { payload = JSON.parse(event.data); } catch (error) { return; }
					var files = payload && Array.isArray(payload.files) ? payload.files : [];
					files.forEach(function (name) {
						if (/projects\.json/.test(name)) {
							wbCache.invalidate("/projects");
							wbCache.invalidate("/tasks");
							wbCache.invalidate("/inbox");
							wbCache.invalidate("/proposals");
						} else if (/canvas\.json/.test(name) || /design-comments/.test(name)) {
							wbCache.invalidate("/canvas");
							wbCache.invalidate("/design/comments");
							wbCache.invalidate("/projects/" + encodeURIComponent(projectId) + "/requirements");
						}
						else if (/handoffs\.json/.test(name)) { wbCache.invalidate("/handoffs"); wbCache.invalidate("/inbox"); }
						else if (/events\.json/.test(name)) { wbCache.invalidate("/events"); wbCache.invalidate("/inbox"); }
						else if (/proposals\.json/.test(name)) { wbCache.invalidate("/proposals"); wbCache.invalidate("/inbox"); }
						else if (/views\.json/.test(name)) wbCache.invalidate("/views");
					});
				}
				source.addEventListener("store-changed", changed);
				source.addEventListener("open", function () { wbCache.invalidate("/"); });
				return function () { source.close(); };
			}, [projectId]);
		}

		// ── M6 工作台组件 ────────────────────────────────────────────────────────

		/** apply 期留一份 ctx：面板入口要在组件里切宿主 layout 服务。 */
		var wbCtx = null;
		var wbCanvasFocus = (function () {
			var current = null;
			var listeners = new Set();
			return {
				get: function () { return current; },
				subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
				set: function (focus) { current = focus; listeners.forEach(function (listener) { listener(); }); }
			};
		})();

		function wbOpenDesignDelivery(sessionId, delivery) {
			return wbOpenArtifact(sessionId, delivery.projectId, "board:" + delivery.entryId);
		}

		function wbOpenArtifact(sessionId, projectId, elementId, reqId) {
			var focus = { sessionId: sessionId, projectId: projectId, elementId: elementId, reqId: reqId };
			wbCanvasFocus.set(focus);
			wbCache.invalidate("/projects");
			wbCache.invalidate("/canvas?projectId=" + encodeURIComponent(projectId));
			return wbOpenCanvasInRightSidebar(projectId, focus);
		}

	function WhaleProjectCanvasAction(props) {
		var t = wbT(props);
		var sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
		var projects = useWb(sessionId === "" ? null : "/projects");
		var leadId = sessionId === "" ? "" : safeLeadId(props.leadIdOf, sessionId);
		var project = wbProjectOfSession(projects.data, [sessionId, leadId]);
		var errorState = react.useState("");
		if (project === null) return null;
		return h(react.Fragment, null,
			h("button", {
				type: "button", className: "daw-goalbar-btn", "data-whales-project-canvas": "",
				title: t("chat.canvas.hint"),
				onClick: function () {
					errorState[1](wbOpenCanvasInRightSidebar(project.projectId) ? "" : sessionId);
				}
			}, t("chat.canvas.open")),
			errorState[0] === sessionId ? h("span", { role: "status", className: "daw-goalbar-msg" }, t("chat.canvas.failed")) : null);
	}

	/** 优先在 DSH 右侧栏打开画布；老宿主才退回主面板。 */
		function wbOpenCanvasInRightSidebar(projectId, focus) {
			try {
				var right = wbCtx && typeof wbCtx.get === "function" ? wbCtx.get("sidebarRight") : undefined;
				if (right && typeof right.openTab === "function") {
					if (!focus && typeof projectId === "string" && projectId !== "") wbRoute.project(projectId, "canvas");
					right.openTab(WHALES_RIGHT_TAB_KIND);
					return true;
				}
			} catch (error) { /* 宿主不支持就走下面的退路 */ }
			if (focus) wbRoute.set({ kind: "workbench", projectId: projectId, tab: "canvas", focus: focus });
			else if (typeof projectId === "string" && projectId !== "") wbRoute.project(projectId, "canvas");
			return wbSelectPanel("whales-canvas");
		}

		/** 切到插件自己的主面板；拿不到 layout 服务（老宿主 / 离线测试）就静默失败。 */
		function wbSelectPanel(panelId) {
			var layout = wbCtx && typeof wbCtx.get === "function" ? wbCtx.get("layout") : undefined;
			if (!layout || typeof layout.selectPanel !== "function") return false;
			try {
				layout.selectPanel(panelId);
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 右侧栏 tab 的 body（`sidebar.right.pane.tab`，按类型 id 分发）。
		 *
		 * 用户反馈 2026-11-24：「在侧边打开画布」要真的开在**右侧栏**里。这个组件就是右侧栏里那一页的正文：
		 * 直接把「主区工作台」同一套渲染搬进来（同一份 inject、同一个 WhaleWorkbench），
		 * 所以侧栏里看到的和主区打开的是同一个画布，不是两套东西。
		 *
		 * 槽位是 session 作用域的，body 拿不到工作台的 inject——改用 apply 期存下的 WB_WORKBENCH_INJECT。
		 */
		function WhaleRightTabBody(props) {
			var inject = WB_WORKBENCH_INJECT || {};
			// 右侧栏是 session 作用域槽：每个会话有自己的画布。绝不能读全局 wbRoute——
			// 左侧切会话只换宿主标题，若正文仍用全局路由，就会一直显示上一个项目（2026-11-25 真机反馈）。
			var sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			var leadId = sessionId === "" ? "" : safeLeadId(inject.leadIdOf, sessionId);
			var projectsSnap = useWb(sessionId === "" ? null : "/projects");
			var tabState = react.useState("canvas");
			var pageState = react.useState("canvas");
			var focus = react.useSyncExternalStore(wbCanvasFocus.subscribe, wbCanvasFocus.get, wbCanvasFocus.get);
			var requested = focus && focus.sessionId === sessionId ? focus : null;
			var project = wbProjectOfSession(projectsSnap.data, [sessionId, leadId]);
			if (requested && projectsSnap.data && Array.isArray(projectsSnap.data.projects)) {
				project = projectsSnap.data.projects.find(function (item) { return item.projectId === requested.projectId; }) || project;
			}
			react.useEffect(function () {
				if (!requested) return;
				tabState[1]("canvas");
				pageState[1]("canvas");
			}, [requested]);
			var route = { kind: "scoped-loading", sessionId: sessionId };
			// 已有快照时继续展示旧画面；瞬时刷新失败不能把整个画布卸载成错误页。
			if (projectsSnap.data !== undefined) {
				route = project === null
					? { kind: "scoped-unbound", sessionId: sessionId }
					: (pageState[0] === "canvas"
						? { kind: "workbench", projectId: project.projectId, tab: wbTabOf(tabState[0]) }
						: { kind: pageState[0], projectId: project.projectId });
			} else if (projectsSnap.error) route = { kind: "scoped-error", sessionId: sessionId, error: projectsSnap.error };
			function navigate(target) {
				// 侧栏内只切本项目页签/设置；不写全局路由，避免影响主面板，也避免另一个会话串图。
				if (!target) return;
				if (target.kind === "workbench" && project && target.projectId === project.projectId) { tabState[1](target.tab || "canvas"); pageState[1]("canvas"); }
				else if (target.kind === "settings") pageState[1]("settings");
			}
			return h(WhaleWorkbench, Object.assign({}, inject, {
				// 工作台在侧栏里要自适应宽度（主区那道最小宽度在这里会把内容挤爆）
				narrow: true,
				t: props.t,
				useSessions: props.useSessions,
				useSessionStatus: props.useSessionStatus,
				route: route,
				canvasFocus: requested && project && requested.projectId === project.projectId ? requested : null,
				onNavigate: navigate
			}));
		}

		/** 新宿主绘制侧栏入口，旧宿主仍可用自带按钮。 */
		function WhalePanelEntry(props) {
			var t = wbT(props);
			if (Number.isFinite(props.size)) {
				return h("svg", { width: props.size, height: props.size, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.45, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
					h("rect", { x: 2.75, y: 3, width: 14.5, height: 14, rx: 2.5 }),
					h("path", { d: "M8 3v14M11 7h3.5M11 10h3.5" }));
			}
			return h("button", {
				type: "button",
				title: t("nav.projects"),
				"aria-label": t("nav.projects"),
				onClick: function () { wbSelectPanel("whales-canvas"); },
				style: {
					display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px",
					borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2, rgba(17,25,50,.12))",
					background: "var(--dsw-alias-bg-elevated, #fff)", color: "var(--dsw-alias-label-secondary)",
					fontSize: 12, lineHeight: "16px", cursor: "pointer", fontFamily: "inherit"
				}
			}, "🐋 ", t("nav.projects"));
		}

		/** 内部路由（不碰浏览器 history：宿主自己的路由状态不该被插件改写）。 */
		var wbRoute = (function () {
			var listeners = new Set();
			var KEY = "dsh-agent-whales.last-view";
			var KINDS = ["list", "start", "inbox", "settings", "workbench"];
			// 重新规划 R3：「发送记录」「事件台」并入「需要我处理」，「团队」「首次体验」页已删——旧版本记住的路由落到最近的去处，不留死链接。
			var MOVED = { handoffs: "inbox", events: "inbox", team: "list", first: "list" };
			/** 记住上次选择（U-9 / T-5 / D10）：刷新、换标签页回来都落回原处。
			 *  没有记录时仍然是 list——「不记住」不等于「首次默认进画布」，两者必须分开。 */
			function recall() {
				try {
					var raw = window.localStorage.getItem(KEY);
					var parsed = raw === null ? null : JSON.parse(raw);
					if (!parsed || typeof parsed !== "object") return { kind: "list" };
					var kind = String(parsed.kind || "");
					if (Object.prototype.hasOwnProperty.call(MOVED, kind)) return { kind: MOVED[kind] };
					if (KINDS.indexOf(kind) < 0) return { kind: "list" };
					if (kind === "workbench") {
						var projectId = String(parsed.projectId || "");
						if (projectId === "") return { kind: "list" };
						return { kind: "workbench", projectId: projectId, tab: wbTabOf(parsed.tab) };
					}
					return { kind: kind };
				} catch (error) { return { kind: "list" }; }
			}
			function remember(route) {
				try { window.localStorage.setItem(KEY, JSON.stringify(route)); } catch (error) { /* 隐私模式不持久化，本次会话仍正常 */ }
			}
			var value = recall();
			return {
				get: function () { return value; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				set: function (next) {
					value = next && typeof next === "object" ? next : { kind: "list" };
					remember(value);
					listeners.forEach(function (listener) { listener(); });
				},
				list: function () { wbRoute.set({ kind: "list" }); },
				project: function (projectId, tab) {
					wbRoute.set({ kind: "workbench", projectId: String(projectId || ""), tab: tab || "canvas" });
				},
				kind: function (kind) { wbRoute.set({ kind: kind }); }
			};
		})();

		function WbBtn(props) {
			return h("button", {
				type: "button",
				className: "daw-wb-btn",
				"data-variant": props.variant || "primary",
				disabled: props.disabled === true,
				title: props.title,
				"aria-label": props["aria-label"],
				"aria-current": props["aria-current"],
				onClick: props.onClick
			}, props.children);
		}

		function WbChip(props) {
			return h("span", { className: "daw-wb-chip", "data-tone": props.tone || "neutral", title: props.title },
				props.dot === false ? null : h("i"),
				props.children);
		}

		function WbPage(props) {
			return h("div", { className: "daw-wb-page" },
				h("div", { className: "daw-wb-pagehead" },
					h("div", { className: "daw-wb-headfill" },
						h("h2", { className: "daw-wb-h1" }, props.title),
						props.desc ? h("div", { className: "daw-wb-desc" }, props.desc) : null),
					props.actions),
				props.children);
		}

		function WbModal(props) {
			var t = wbT(props);
			return h("div", { className: "daw-wb-mask" + (props.canvasAnchored ? " daw-wb-mask-canvas" : ""), onClick: function (event) { if (event && event.target === event.currentTarget && props.onClose) props.onClose(); } },
				h("div", { className: "daw-wb-modal" + (props.wide ? " daw-wb-modal-wide" : ""), role: "dialog", "aria-label": props.title },
					h("div", { className: "daw-wb-modal-title" }, props.title),
					props.children,
					h("div", { className: "daw-wb-modal-foot" },
						props.onClose ? h(WbBtn, { variant: "ghost", onClick: props.onClose }, t("common.cancel")) : null,
						props.footer)));
		}

		function WbReviewDialog(props) {
			var closeButton = react.useRef(null);
			react.useEffect(function () {
				var before = typeof document !== "undefined" ? document.activeElement : null;
				closeButton.current?.focus({ preventScroll: true });
				return function () { if (before && before.isConnected) before.focus({ preventScroll: true }); };
			}, []);
			function onKeyDown(event) {
				if (event.defaultPrevented) return;
				if (event.key === "Escape") {
					event.stopPropagation();
					props.onClose();
				}
				if (event.key === "Tab") {
					var controls = Array.from(event.currentTarget.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],iframe,[tabindex='0']")).filter(function (item) { return item.tabIndex >= 0 && item.getClientRects().length > 0; });
					var from = event.shiftKey ? controls[0] : controls[controls.length - 1];
					if (controls.length && event.target === from) {
						event.preventDefault();
						(event.shiftKey ? controls[controls.length - 1] : controls[0]).focus();
					}
				}
			}
			return h("div", { className: "daw-wb-mask daw-wb-mask-canvas daw-wb-mask-review", onClick: function (event) { if (event.target === event.currentTarget) props.onClose(); } },
				h("div", { className: "daw-wb-modal daw-wb-review-dialog", role: "dialog", "aria-label": props.title, "aria-modal": true, onKeyDown: onKeyDown },
					h("header", { className: "daw-wb-review-top" },
						props.onBack ? h("button", { type: "button", className: "daw-wb-btn", "data-variant": "quiet", "aria-label": props.t("req.back"), title: props.t("req.back"), onClick: props.onBack }, "←") : null,
						h("h2", null, props.title),
						h("button", { type: "button", ref: closeButton, className: "daw-wb-btn", "data-variant": "quiet", "aria-label": props.t("common.close"), title: props.t("common.close"), onClick: props.onClose }, "×")),
					props.children));
		}

		function WbState(props) {
			var t = wbT(props);
			if (props.error) {
				return h("div", { className: "daw-wb-state" },
					h("div", null, t("common.error") + " · " + props.error),
					h("span", { className: "daw-wb-toolbar" },
						h(WbBtn, { variant: "ghost", onClick: props.onRetry }, t("common.retry")),
						// 项目级失败（404 / store 只读 / 网络错）时给条出路：回项目列表。
						// 不传 onExit 的页面（如待办）不渲染，保持原样。
						props.onExit ? h(WbBtn, { variant: "ghost", onClick: props.onExit }, t("top.toList")) : null));
			}
			if (props.loading) return h("div", { className: "daw-wb-state" }, t("common.loading"));
			if (props.empty) return h("div", { className: "daw-wb-state" }, props.empty);
			return props.children;
		}

		/** 会话名单（加入对话 / owner 显示名 / 画布 Agent 节点共用一份）。 */
		function useWbSessions(props) {
			var hook = props && typeof props.useSessions === "function" ? props.useSessions : undefined;
			var state = hook === undefined ? undefined : hook(function (value) { return value; });
			return state;
		}

		function wbSessionRows(state) {
			if (!state || !state.byId) return [];
			return Object.keys(state.byId).map(function (id) {
				var row = state.byId[id] || {};
				return {
					sessionId: id,
					title: typeof row.title === "string" && row.title !== "" ? row.title : id,
					running: row.running === true,
					live: row.running === true || (row.origin !== undefined && row.origin !== "history"),
					// 宿主 /sessions 下发的权威 live；客户端 store 的行没有这个布尔，缺省就是不离线。
					offline: row.live === false,
					parentSessionId: row.parentId === undefined ? undefined : row.parentId
				};
			});
		}

		// ── 侧栏 / 顶栏 / 工作台外壳 ───────────────────────────────────────────

		function WbTopbar(props) {
			var t = wbT(props);
			var route = props.route;
			var inbox = useWb(props.narrow ? null : "/inbox");
			function refresh() { wbCache.invalidate("/"); }
			if (props.narrow) {
				return h("header", { className: "daw-wb-top" },
					h("b", { className: "daw-wb-note" }, props.projectName || t("nav.projects")),
					h("span", { className: "daw-wb-toolfill" }),
					h(WbBtn, { variant: "quiet", title: t("top.refresh"), "aria-label": t("top.refresh"), onClick: refresh }, "↻"),
					typeof props.onSettings === "function" ? h(WbBtn, { variant: "quiet", title: t("nav.settings"), "aria-label": t("nav.settings"), onClick: props.onSettings }, "⚙") : null);
			}
			function navigate(kind) {
				if (typeof props.onNavigate === "function") props.onNavigate({ kind: kind });
				else wbRoute.kind(kind);
			}
			var crumbLink = h("button", { type: "button", className: "daw-wb-crumb-link", title: t("top.toList"), onClick: function () { navigate("list"); } }, t("nav.projects"));
			var location = route.kind === "workbench" ? props.projectName
				: route.kind === "settings" ? t("nav.settings") : route.kind === "inbox" ? t("nav.inbox") : "";
			var total = wbInboxView(inbox.data).total;
			return h("header", { className: "daw-wb-top daw-wb-top-wide" },
				h("span", { className: "daw-wb-crumb" }, route.kind === "list" ? t("nav.projects") : crumbLink, location ? " / " + location : null),
				props.running > 0 ? h("span", { className: "daw-wb-run" }, h("i"), t("top.running", { count: props.running })) : null,
				h("div", { className: "daw-wb-top-actions" },
					h(WbBtn, { variant: "quiet", "aria-current": route.kind === "inbox" ? "page" : undefined, onClick: function () { navigate("inbox"); } },
						t("nav.inbox"), total > 0 ? h("span", { className: "daw-wb-top-badge" }, String(total)) : null),
					h(WbBtn, { variant: "quiet", "aria-current": route.kind === "settings" ? "page" : undefined, onClick: function () { navigate("settings"); } }, t("nav.settings")),
					h(WbBtn, { variant: "quiet", title: t("top.refresh"), onClick: refresh }, t("top.refresh")),
					props.onBack ? h(WbBtn, { variant: "ghost", onClick: props.onBack }, t("top.back")) : null));
		}

		function WbTabs(props) {
			var t = wbT(props);
			var route = props.route;
			var tabs = [
				{ key: "canvas", label: t("tab.canvas"), note: t("tab.note.canvas") },
				{ key: "table", label: t("tab.table"), note: t("tab.note.table"), badge: (props.openTasks || 0) + (props.runningTasks || 0) },
				{ key: "office", label: t("tab.office") }
			];
			var note = tabs.find(function (tab) { return tab.key === route.tab; })?.note;
			return h("nav", { className: "daw-wb-tabs" },
				tabs.map(function (tab) {
					var badgeLabel = tab.badge > 0 ? t("tab.table.count", { count: tab.badge }) : undefined;
					return h("button", {
						key: tab.key,
						type: "button",
						className: "daw-wb-tab",
						"data-on": String(route.tab === tab.key),
						title: badgeLabel,
						"aria-label": badgeLabel ? tab.label + " · " + badgeLabel : undefined,
						onClick: function () { if (typeof props.onNavigate === "function") props.onNavigate({ kind: "workbench", projectId: route.projectId, tab: tab.key }); else wbRoute.project(route.projectId, tab.key); }
					},
						tab.label,
						badgeLabel ? h("span", { className: "daw-wb-tab-badge", "aria-hidden": "true" }, String(tab.badge)) : null);
				}),
				note ? h("span", { className: "daw-wb-tabnote" }, note) : null);
		}

		// ── U-1 项目列表 ───────────────────────────────────────────────────────

		/** 项目卡里的需求列表：每个需求一行（阶段芯片 + 名称 + 计数 + 下一步）。最多显示 4 个，其余折叠成一行提示。 */
		function WbRequirementList(props) {
			var t = wbT(props);
			var rows = props.rows;
			var shown = rows.slice(0, 4);
			if (rows.length === 0) return h("div", { className: "daw-wb-req-empty", title: t("req.empty.hint") }, t("req.empty"));
			return h("div", { className: "daw-wb-reqs", "data-testid": "req-list" },
				shown.map(function (row) {
					return h("div", { key: row.reqId, className: "daw-wb-req", "data-virtual": String(row.virtual), "data-attention": row.attention },
						h("div", { className: "daw-wb-req-top" },
							h(WbChip, { tone: row.tone }, row.virtual ? t("req.virtual") : t("req.stage." + row.stage)),
							h("span", { className: "daw-wb-req-title", title: row.virtual ? t("req.virtual.hint") : row.title }, row.virtual ? t("req.virtual.title") : row.title),
							row.attention !== "" ? h("span", { className: "daw-wb-req-attn" }, t("req.attention." + row.attention)) : null),
						h("div", { className: "daw-wb-req-meta" },
							h("span", null, t("req.meta", { done: row.tasksDone, total: row.tasks, protos: row.prototypes })),
							row.virtual ? null : h("span", null, row.designVersion > 0 ? t("req.design", { v: row.designVersion }) : (row.prototypes > 0 ? t("req.design.none") : ""))),
						row.next !== "" ? h("div", { className: "daw-wb-req-next" }, t("req.next") + "：" + row.next) : null);
				}),
				rows.length > shown.length ? h("div", { className: "daw-wb-req-more" }, t("req.more", { n: rows.length - shown.length })) : null);
		}

		function WbProjectCard(props) {
			var t = wbT(props);
			var project = props.project;
			var tasks = useWb("/tasks?projectId=" + encodeURIComponent(project.projectId));
			var reqSnap = useWb("/projects/" + encodeURIComponent(project.projectId) + "/requirements");
			var reqRows = wbRequirementRows(reqSnap.data);
			var reqSummary = wbRequirementSummary(reqRows);
			var rows = tasks.data && Array.isArray(tasks.data.tasks) ? tasks.data.tasks : [];
			var total = rows.length;
			var done = rows.filter(function (row) { return row.status === "completed"; }).length;
			var running = rows.filter(function (row) { return row.status === "in_progress"; }).length;
			var percent = total === 0 ? 0 : Math.round((done / total) * 100);
			return h("button", { type: "button", className: "daw-wb-card", onClick: function () { wbRoute.project(project.projectId, "canvas"); } },
				h("div", { className: "daw-wb-card-head" },
					h("span", { className: "daw-wb-card-icon" }, "🐋"),
					h("span", { className: "daw-wb-card-title" }, project.name || project.projectId),
					h("span", { className: "daw-wb-card-fill" }),
					h(WbChip, { tone: running > 0 ? "ok" : "neutral" }, running > 0 ? t("tasks.status.in_progress") : t("tasks.status.pending")),
					reqSummary.attention > 0 ? h(WbChip, { tone: "danger", title: t("req.attention") }, t("req.attention") + " " + reqSummary.attention) : null),
				h("div", { className: "daw-wb-progress" }, h("i", { style: { width: percent + "%" } })),
				h("div", { className: "daw-wb-meta" },
					h("span", null, t("list.card.members", { count: (project.members || []).length })),
					h("span", null, t("list.card.tasks", { done: done, total: total }))),
				h("div", { className: "daw-wb-card-note" }, project.brief && project.brief.goal ? project.brief.goal : t("canvas.goal.none")),
				reqSnap.data ? h(WbRequirementList, { rows: reqRows, t: t }) : null);
		}

		function WbProjectList(props) {
			var t = wbT(props);
			var projects = useWb("/projects");
			var inbox = useWb("/inbox");
			var rows = projects.data && Array.isArray(projects.data.projects) ? projects.data.projects : [];
			var counts = wbInboxView(inbox.data);
			var modalState = react.useState(null);
			var modal = modalState[0];
			var setModal = modalState[1];
			var sessions = useWbSessions(props);
			var sessionRows = wbSessionRows(sessions);
			function createProject(name, mainSessionId, goal) {
				return wbApi("/projects", { method: "POST", body: { name: name, mainSessionId: mainSessionId, goal: goal } })
					.then(function (payload) {
						wbCache.invalidate("/projects");
						wbCache.invalidate("/inbox");
						var project = payload && payload.data && payload.data.project;
						if (project) wbRoute.project(project.projectId, "canvas");
					});
			}

			function joinProject(projectId, sessionId) {
				return wbApi("/projects/" + encodeURIComponent(projectId) + "/members", { method: "POST", body: { sessionId: sessionId } })
					.then(function () { wbCache.invalidate("/projects"); });
			}

			return h(WbPage, {
				title: t("list.title"),
				desc: t("list.desc"),
				actions: [
					h(WbBtn, { key: "new", variant: "ghost", onClick: function () { setModal({ kind: "create" }); } }, t("list.new")),
					h(WbBtn, { key: "start", onClick: function () { wbRoute.kind("start"); } }, t("start.entry"))
				]
			},
				h("div", { className: "daw-wb-stats" },
					h("div", { className: "daw-wb-stat" },
						h("div", { className: "daw-wb-stat-v" }, String(rows.length)),
						h("div", { className: "daw-wb-stat-n" }, t("list.stat.active"))),
					h("div", { className: "daw-wb-stat" },
						h("div", { className: "daw-wb-stat-v" }, String(counts.total)),
						h("div", { className: "daw-wb-stat-n" }, t("list.stat.inbox"))),
					h("div", { className: "daw-wb-stat" },
						h("div", { className: "daw-wb-stat-v" }, String(props.runningTasks || 0)),
						h("div", { className: "daw-wb-stat-n" }, t("list.stat.tickets")))),

				h(WbState, {
					loading: projects.loading && rows.length === 0,
					error: projects.error,
					onRetry: function () { wbCache.read("/projects"); },
					empty: rows.length === 0 && !projects.loading ? h("div", { className: "daw-wb-grid" },
						h("div", { className: "daw-wb-empty" },
							h("div", { className: "daw-wb-empty-icon" }, "🐋"),
							h("div", { className: "daw-wb-empty-title" }, t("list.empty.title")),
							h("div", { className: "daw-wb-empty-desc" }, t("list.empty.desc")),
							h("div", { className: "daw-wb-toolbar" },
								h(WbBtn, { onClick: function () { wbRoute.kind("start"); } }, t("start.entry")),
								h(WbBtn, { variant: "ghost", onClick: function () { setModal({ kind: "create" }); } }, t("list.empty.create")),
								h(WbBtn, { variant: "ghost", onClick: function () { setModal({ kind: "join" }); } }, t("list.empty.join"))))) : null
				},
					rows.length === 0 ? null : h("div", { className: "daw-wb-grid" },
						rows.map(function (project) {
							return h(WbProjectCard, { key: project.projectId, project: project, t: t });
						}),
						h("button", { type: "button", className: "daw-wb-card", "data-variant": "ghost", onClick: function () { setModal({ kind: "join" }); } },
							h("div", { className: "daw-wb-empty-icon" }, "＋"),
							h("div", { className: "daw-wb-empty-title" }, t("list.empty.join")),
							h("div", { className: "daw-wb-empty-desc" }, t("list.join.title"))))),
				modal !== null && modal.kind === "create"
					? h(WbCreateProject, {
						t: t,
						sessions: sessionRows,
						onClose: function () { setModal(null); },
						onCreate: createProject
					})
					: null,
				modal !== null && modal.kind === "join"
					? h(WbJoinProject, {
						t: t,
						projects: rows,
						sessions: sessionRows,
						onClose: function () { setModal(null); },
						onJoin: joinProject
					})
					: null);
		}

		function WbCreateProject(props) {
			var t = wbT(props);
			var nameState = react.useState("");
			var mainState = react.useState(props.sessions.length > 0 ? props.sessions[0].sessionId : "");
			var goalState = react.useState("");
			var busyState = react.useState(false);
			var errorState = react.useState("");
			var busy = busyState[0];
			return h(WbModal, {
				title: t("list.new"),
				onClose: props.onClose,
				t: t,
				footer: h(WbBtn, {
					disabled: busy || nameState[0].trim() === "" || mainState[0] === "",
					onClick: function () {
						busyState[1](true);
						errorState[1]("");
						props.onCreate(nameState[0].trim(), mainState[0], goalState[0].trim())
							.then(function () { props.onClose(); })
							.catch(function (error) { errorState[1](error.message); busyState[1](false); });
					}
				}, t("common.confirm"))
			},
				h("label", { className: "daw-wb-label" }, t("list.title"),
					h("input", { className: "daw-wb-input", value: nameState[0], onChange: function (event) { nameState[1](event.target.value); } })),
				h("label", { className: "daw-wb-label" }, t("tasks.assign.owner"),
					h("select", { className: "daw-wb-select", value: mainState[0], onChange: function (event) { mainState[1](event.target.value); } },
						props.sessions.map(function (row) {
							return h("option", { key: row.sessionId, value: row.sessionId }, row.title + (row.running ? "" : " · " + t("list.join.archived")));
						}))),
				h("label", { className: "daw-wb-label" }, t("brief.goal"),
					h("textarea", { className: "daw-wb-textarea", value: goalState[0], onChange: function (event) { goalState[1](event.target.value); } })),
				errorState[0] ? h("div", { className: "daw-wb-banner", "data-tone": "danger" }, errorState[0]) : null);
		}

		/**
		 * 哪些会话还能加入这个项目（画布「添加 Agent」用）。
		 *
		 * 主对话与现有成员必须排除：一个对话只能属于一个项目（宿主 40701），
		 * 不排除就会让用户点一个必然失败的选项。坏数据一律当「不能加」，不抛。
		 * 纯函数：离线测试同口径。
		 */
		/**
		 * 子会话自动入项目（v2.2 波次 2）的画布侧兜底：父会话已在项目里、自己还不在、
		 * 也没被用户手动移出过的会话。有就调宿主 POST /projects/:id/adopt（宿主再判一遍归属）。
		 * 返回排序后的 sessionId 列表（用作 effect 依赖键，列表不变就不重复请求）。
		 */
		function wbAdoptCandidates(project, sessions) {
			if (!project || !Array.isArray(sessions)) return [];
			var members = {};
			(Array.isArray(project.members) ? project.members : []).forEach(function (member) { if (member && member.sessionId) members[member.sessionId] = true; });
			if (project.mainSessionId) members[project.mainSessionId] = true;
			var dismissed = Array.isArray(project.dismissed) ? project.dismissed : [];
			return sessions.filter(function (row) {
				return row && typeof row.sessionId === "string" && typeof row.parentSessionId === "string"
					&& members[row.parentSessionId] === true && members[row.sessionId] !== true && dismissed.indexOf(row.sessionId) < 0;
			}).map(function (row) { return row.sessionId; }).sort();
		}

		function wbAddableSessions(sessions, project) {
			var rows = Array.isArray(sessions) ? sessions : [];
			var taken = {};
			var main = project && typeof project.mainSessionId === "string" ? project.mainSessionId : "";
			if (main !== "") taken[main] = true;
			var members = project && Array.isArray(project.members) ? project.members : [];
			members.forEach(function (member) {
				var id = member && typeof member.sessionId === "string" ? member.sessionId : "";
				if (id !== "") taken[id] = true;
			});
			return rows.filter(function (row) {
				var id = row && typeof row.sessionId === "string" ? row.sessionId : "";
				return id !== "" && taken[id] !== true;
			});
		}

		function WbJoinProject(props) {
			var t = wbT(props);
			var pickedState = react.useState(props.projects.length > 0 ? props.projects[0].projectId : "");
			var busyState = react.useState("");
			var hintState = react.useState("");
			return h(WbModal, { title: t("list.join.title"), onClose: props.onClose, t: t },
				h("label", { className: "daw-wb-label" }, t("nav.projects"),
					h("select", {
						className: "daw-wb-select",
						value: pickedState[0],
						onChange: function (event) { pickedState[1](event.target.value); }
					},
						props.projects.map(function (project) {
							return h("option", { key: project.projectId, value: project.projectId }, project.name || project.projectId);
						}))),
				h("div", { className: "daw-wb-group" },
					props.sessions.map(function (row) {
						var taken = props.projects.some(function (project) {
							return project.mainSessionId === row.sessionId || (project.members || []).some(function (member) { return member.sessionId === row.sessionId; });
						});
						return h("div", { key: row.sessionId, className: "daw-wb-todo" },
							h("div", { className: "daw-wb-todo-body" },
								h("div", { className: "daw-wb-todo-text" }, row.title),
								h("div", { className: "daw-wb-todo-src" }, taken ? t("list.join.taken") : (row.running ? "" : t("list.join.archived")))),
							h(WbBtn, {
								variant: "small",
								disabled: taken || busyState[0] === row.sessionId || pickedState[0] === "",
								onClick: function () {
									busyState[1](row.sessionId);
									props.onJoin(pickedState[0], row.sessionId)
										.then(function () { props.onClose(); })
										.catch(function () { busyState[1](""); });
								}
							}, t("list.join.action")));
					})));
		}

		// ── U-2 节点画画布（T-4 / D11）──────────────────────────────────────────

		/** 节点位置单独持久化（与拖拽位置同一个思路：别把画布数据塞进设置键）。 */
		// 画布位置：宿主 canvas.json 是权威（刷新/换设备不丢、agent 也能改），
		// localStorage 只做「拖拽即时反馈」和「宿主还没回来」的离线兜底。
		//   - hydrate：把宿主快照灌进缓存，同时并回本地（本地可能是换设备前唯一的记录）
		//   - set：先改本地（UI 立刻动），再防抖整体 PUT；带 expectedRevision，40902 重读重报一次
		var wbNodePositions = (function () {
			var KEY = "dsh-agent-whales.canvas-positions";
			var FLUSH_MS = 400;
			var cache = {};
			var timers = {};
			var flushing = {};
			function read() {
				try {
					var raw = window.localStorage.getItem(KEY);
					var parsed = raw === null ? {} : JSON.parse(raw);
					return parsed && typeof parsed === "object" ? parsed : {};
				} catch (error) { return {}; }
			}
			function write(table) {
				try { window.localStorage.setItem(KEY, JSON.stringify(table)); } catch (error) { /* 配额不足就不持久化 */ }
			}
			function snapOf(projectId) {
				var snap = cache[projectId];
				if (snap === undefined) { snap = { rev: 0, nodes: {} }; cache[projectId] = snap; }
				return snap;
			}
			function flush(projectId) {
				if (flushing[projectId] === true) { timers[projectId] = setTimeout(function () { flush(projectId); }, FLUSH_MS); return; }
				var snap = snapOf(projectId);
				flushing[projectId] = true;
				wbApi("/canvas?projectId=" + encodeURIComponent(projectId), {
					method: "PUT",
					body: { expectedRevision: snap.rev, nodes: snap.nodes }
				}).then(function (payload) {
					var data = payload && payload.data ? payload.data : {};
					if (typeof data.rev === "number") snap.rev = data.rev;
				}).catch(function (error) {
					// 过期（40902）：重读最新快照后重报一次；别覆盖别人刚摆的位置。
					var message = String(error && error.message ? error.message : error);
					if (message.indexOf("revision") < 0 && message.indexOf("40902") < 0) return;
					wbApi("/canvas?projectId=" + encodeURIComponent(projectId)).then(function (payload) {
						var data = payload && payload.data ? payload.data : {};
						if (!data || typeof data.rev !== "number") return;
						snap.rev = data.rev;
						snap.nodes = data.nodes && typeof data.nodes === "object" ? data.nodes : {};
						return wbApi("/canvas?projectId=" + encodeURIComponent(projectId), { method: "PUT", body: { expectedRevision: snap.rev, nodes: snap.nodes } });
					}).catch(function () { /* 重读也失败就等下次拖拽再试，本地值仍在 */ });
				}).then(function () {
					flushing[projectId] = false;
				});
			}
			return {
				hydrate: function (projectId, data) {
					if (!data || typeof data !== "object") return;
					var nodes = data.nodes && typeof data.nodes === "object" ? data.nodes : {};
					var snap = snapOf(projectId);
					snap.rev = typeof data.rev === "number" ? data.rev : 0;
					snap.nodes = nodes;
					var table = read();
					for (var key in nodes) {
						if (Object.prototype.hasOwnProperty.call(nodes, key)) table[projectId + ":" + key] = nodes[key];
					}
					write(table);
				},
				get: function (projectId, nodeId) {
					var snap = cache[projectId];
					if (snap && snap.nodes[nodeId]) return snap.nodes[nodeId];
					var table = read();
					var row = table[projectId + ":" + nodeId];
					return row && typeof row.x === "number" && typeof row.y === "number" ? row : undefined;
				},
				set: function (projectId, nodeId, x, y) {
					var snap = snapOf(projectId);
					var prev = snap.nodes[nodeId];
					var row = { x: Math.round(x), y: Math.round(y), w: prev ? prev.w : 0, h: prev ? prev.h : 0 };
					snap.nodes[nodeId] = row;
					var table = read();
					table[projectId + ":" + nodeId] = row;
					write(table);
					if (timers[projectId] !== undefined) clearTimeout(timers[projectId]);
					timers[projectId] = setTimeout(function () { flush(projectId); }, FLUSH_MS);
				},
				flushNow: function (projectId) {
					if (timers[projectId] !== undefined) clearTimeout(timers[projectId]);
					flush(projectId);
				}
			};
		})();

		/**
		 * 两个写入范围是否可能指向同一个文件（与宿主 projectTaskView 的 writeScopeWarnings 同口径，
		 * 两边必须一致，否则界面说的和宿主罚的不是一件事）。
		 */
		function wbScopeOverlaps(a, b) {
			var left = typeof a === "string" ? a.trim() : "";
			var right = typeof b === "string" ? b.trim() : "";
			if (left === "" || right === "") return false;
			return left === right || left.indexOf(right) === 0 || right.indexOf(left) === 0;
		}

		/**
		 * report 的产物里，哪些落在任务声明的写入范围之外（借鉴 troupe workOf 的 outside）。
		 * 没有声明 writeScopes 时不做判断——「没声明」不是「允许一切」，但也不是越界的证据。
		 * 返回 { total, outside: [ref...] }；坏数据不抛。
		 */
		function wbArtifactsOutside(task) {
			var row = task && typeof task === "object" ? task : {};
			var scopes = Array.isArray(row.writeScopes) ? row.writeScopes.filter(function (one) { return typeof one === "string" && one.trim() !== ""; }) : [];
			var report = row.report && typeof row.report === "object" ? row.report : null;
			var artifacts = report !== null && Array.isArray(report.artifacts) ? report.artifacts : [];
			var refs = [];
			artifacts.forEach(function (item) {
				var ref = typeof item === "string" ? item : (item && typeof item.ref === "string" ? item.ref : "");
				if (ref.trim() !== "") refs.push(ref.trim());
			});
			if (scopes.length === 0) return { total: refs.length, outside: [] };
			var outside = refs.filter(function (ref) { return !scopes.some(function (scope) { return wbScopeOverlaps(scope, ref); }); });
			return { total: refs.length, outside: outside };
		}

		/**
		 * Agent 卡的当前态（借鉴 troupe roleState 的优先序：**证据压过观感**）。
		 * 有 report 就按 report 显示（写过 done 的就是 done，哪怕它还挂在提示符上）；
		 * 没有 report 才看会话在不在线。返回 { tone, key }，key 是文案键后缀。
		 */
		function wbAgentChip(task, online) {
			var report = task && typeof task === "object" && task.report && typeof task.report === "object" ? task.report : null;
			if (task && typeof task === "object" && task.verified && typeof task.verified === "object") {
				return { tone: "ok", key: "verified" };
			}
			if (report !== null) {
				if (report.status === "done") return { tone: "ok", key: "done" };
				if (report.status === "handed_back") return { tone: "warn", key: "handed_back" };
				if (report.status === "human_action") return { tone: "danger", key: "human_action" };
				return { tone: "brand", key: "draft" };
			}
			return online === true ? { tone: "ok", key: "online" } : { tone: "neutral", key: "idle" };
		}
		/**
		 * Agent 卡的分段生长进度（设计参考图 V2；口径抄 CDS ApprovalFlow 的等宽分段）：
		 * 六步 = T-13 的 source → trigger → policy → ticket → worker → report，
		 * **全部从任务行已有字段派生，不发额外请求**（画布上一次渲染拿全）。
		 * state ∈ done | active | pending | skipped：
		 *   - source/trigger/policy：有来源提案 = done（提案链路），没有 = skipped（手动创建）
		 *   - ticket：任务已建 = done
		 *   - worker：有 owner = done；in_progress = active；没派 = pending
		 *   - report：done = 回流关闭；draft/handed_back/human_action = active；没有 = pending
		 * 分段**等宽、不按耗时加权**（「进度是步数而非时间」，CDS 同款判据）。
		 */
		function wbAgentSteps(row) {
			var task = row && typeof row === "object" ? row : {};
			var fromProposal = !!(task.sourceProposal && typeof task.sourceProposal === "object" && task.sourceProposal.proposalId);
			var hasOwner = typeof task.ownerSessionId === "string" && task.ownerSessionId !== "";
			var report = task.report && typeof task.report === "object" ? task.report : null;
			var reportState = "pending";
			if (report !== null) reportState = report.status === "done" ? "done" : "active";
			return [
				{ key: "source", state: fromProposal ? "done" : "skipped" },
				{ key: "trigger", state: fromProposal ? "done" : "skipped" },
				{ key: "policy", state: fromProposal ? "done" : "skipped" },
				{ key: "ticket", state: "done" },
				{ key: "worker", state: hasOwner ? (task.status === "in_progress" ? "active" : "done") : "pending" },
				{ key: "report", state: reportState }
			];
		}

		/** 分段进度的可读名（CDS：role="img" + aria-label，纯图形必须有文字复述）。 */
		function wbGrowthLabel(steps, t) {
			var done = 0;
			(steps || []).forEach(function (step) { if (step && step.state === "done") done += 1; });
			var total = (steps || []).length;
			if (typeof t === "function") return t("canvas.growth.aria", { done: done, total: total });
			return "共 " + total + " 步，已完成 " + done + " 步";
		}
		/**
		 * 落点归一 key：与宿主 `normalizeLandingPath` 同一套**词法**规则（去首尾空白、
		 * 去掉段级 `.`、解析 `..`、折叠重复分隔符、去尾分隔符；UNC 与盘符根保留前导分隔符），
		 * 末尾再把分隔符统一折成 `/`——手填时正斜杠/反斜杠混用很常见（Windows 上从 git
		 * 输出里复制来的路径全是正斜杠），不折叠就会被拆成两个节点。
		 *
		 * 为什么画布要去重：上下文节点按落点聚合，同一个目录的两种写法会被拆成两个节点——
		 * 「活在哪跑」由此失真。realpath（符号链接、磁盘大小写）浏览器侧做不到，由宿主在
		 * 落点入库时归一；这里是老数据与手改数据的二道防线。**大小写不折叠**：POSIX 上
		 * 大小写不同的确是不同目录，而 Windows 的大小写漂移已由宿主 realpath 修掉。
		 */
		function wbWhereKey(where) {
			var raw = typeof where === "string" ? where.trim() : "";
			if (raw === "") return "";
			// 前导分隔符是路径的一部分：单个 = 根，两个及以上 = UNC，不能一起折掉。
			var leading = /^[\\/]+/.exec(raw);
			var unc = leading !== null && leading[0].length >= 2;
			var body = leading === null ? raw : raw.slice(leading[0].length);
			var separator = raw.indexOf("\\") !== -1 ? "\\" : "/";
			var segments = [];
			var parts = body.split(/[\\/]+/);
			for (var i = 0; i < parts.length; i += 1) {
				var segment = parts[i];
				if (segment === "" || segment === ".") continue;
				if (segment === "..") {
					if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
					else segments.push("..");
					continue;
				}
				segments.push(segment);
			}
			var joined = segments.join(separator);
			if (joined === "") {
				// 只剩 `.`/`..` 且不以分隔符开头：语义是「当前目录」，按没有落点处理，别冒充根目录。
				if (leading === null) return "";
				return unc ? "//" : "/";
			}
			var driveRoot = /^[a-zA-Z]:$/.test(joined);
			var prefix = leading === null ? "" : (unc ? "//" : "/");
			// 盘符根（C: → C:/）要留住分隔符，否则 "C:" 不是绝对路径。
			var key = prefix + joined + (driveRoot ? separator : "");
			// 分隔符统一折成 `/`：key 只用于去重与节点 id，不参与展示。
			return key.split("\\").join("/");
		}

		/**
		 * 画布节点：对话节点来自项目成员（主对话 = Composer，其余 = Agent）；
		 * 上下文节点来自任务落点（worktree / execRoot 的**归一后**去重值）——落点是一等字段
		 * （§55.3.1），画布上能看到「活在哪跑」。
		 */
		function wbCanvasNodes(project, tasks, sessions) {
			var members = project && Array.isArray(project.members) ? project.members : [];
			var mainSessionId = project ? project.mainSessionId : undefined;
			var bySession = {};
			(sessions || []).forEach(function (row) { bySession[row.sessionId] = row; });
			var nodes = [];
			var contexts = {};
			(tasks || []).forEach(function (task) {
				var where = typeof task.worktree === "string" && task.worktree !== "" ? task.worktree
					: (typeof task.execRoot === "string" && task.execRoot !== "" ? task.execRoot : null);
				if (where === null) return;
				var key = wbWhereKey(where);
				if (key === "") return;
				// id 与分组用归一 key；标题用**首次见到的原样**（去首尾空白）——展示用户写的
				// 那条，去重归去重。宿主入库时已归一过，这里主要兜老数据与手改数据。
				var shown = where.trim();
				var entry = contexts[key] || (contexts[key] = { id: "ctx:" + key, kind: "folder", title: shown, tasks: [] });
				entry.tasks.push(task);
			});
			var contextList = Object.keys(contexts).map(function (key) { return contexts[key]; });
			contextList.forEach(function (node, index) {
				node.x = 24;
				node.y = 24 + index * 118;
				node.w = 220;
				node.h = 102;
				node.sub = node.tasks.length + " · " + (node.tasks[0] && node.tasks[0].subject ? node.tasks[0].subject : "");
				nodes.push(node);
			});
			var agents = members.filter(function (member) { return member && member.sessionId !== mainSessionId; });
			agents.forEach(function (member, index) {
				var row = bySession[member.sessionId];
				var owned = (tasks || []).filter(function (task) { return task.ownerSessionId === member.sessionId && task.status !== "completed" && task.status !== "deleted"; });
				// 落点取它负责的在跑任务的 worktree / execRoot；没有就明说「—」，不编。
				var where = "";
				for (var w = 0; w < owned.length; w += 1) {
					var candidate = typeof owned[w].worktree === "string" && owned[w].worktree !== "" ? owned[w].worktree
						: (typeof owned[w].execRoot === "string" && owned[w].execRoot !== "" ? owned[w].execRoot : "");
					if (candidate !== "") { where = candidate; break; }
				}
				nodes.push({
					id: member.sessionId,
					kind: "agent",
					sessionId: member.sessionId,
					role: member.role || "member",
					// 组建方案 / 子会话自动入项目时，新会话还没有标题（没说过话）：用登记时带的角色名兜底。
					// wbSessionRows 会把空标题填成 sessionId，所以「标题等于 id」也算没有标题（真机 2026-11-17）。
					title: row && row.title && row.title !== member.sessionId ? row.title : (typeof member.title === "string" && member.title !== "" ? member.title : member.sessionId),
					addedBy: typeof member.addedBy === "string" ? member.addedBy : "manual",
					sub: (owned.length > 0 ? owned[0].subject : (row && row.running ? "在线" : "空闲")),
					// 生长进度用：这个 Agent 负责的那条任务（没有就退化到空数组 → 六段全 pending/skipped）
					task: owned.length > 0 ? owned[0] : null,
					worktree: where,
					online: !!(row && row.running),
					// 宿主权威的「会话已下线」（/sessions 的 live === false）：只有它为真才显示「唤醒」。
					// 空闲但活着的会话 online 也是 false，不能拿 online 判离线。
					offline: !!(row && row.offline),
					// 行距 168 = 卡高 148 + 20：原来 138 比卡高还小，两张 Agent 卡上下叠 10px
					// （2026-11-17 真机两两求交抓到）；「添加 Agent」占位与 MCP 列本来就按 168 算。
					x: 800, y: 24 + index * 168, w: 200, h: 148
				});
			});
			// Composer（Q1 轻量版）：只绑主对话；卡内一个输入框 + 「放入输入框」按钮。
			// 不做 /命令、不切模型（无数据源就不显示，不编）；写入走官方 insertText，
			// 被拒降级剪贴板，再不行让用户手动复制——**绝不自动提交**。
			var mainRow = bySession[mainSessionId];
			var mainMember = members.find(function (member) { return member && member.sessionId === mainSessionId; });
			var mainTitle = mainRow && mainRow.title !== mainSessionId ? mainRow.title : "";
			nodes.push({
				id: mainSessionId || "main",
				kind: "composer",
				sessionId: mainSessionId,
				title: mainTitle || (mainMember && mainMember.title) || (project && project.name) || "",
				// 前缀素材：主对话负责的那条任务（没有就 null → 空前缀，用户自己起头）
				task: (tasks || []).filter(function (one) { return one && one.ownerSessionId === mainSessionId && one.status !== "completed" && one.status !== "deleted"; })[0] || null,
				online: true,
				x: 430, y: 220, w: 320, h: 330
			});
			return nodes;
		}


		/**
		 * 约束表 → 画布连线对。a = "mcp:<服务名>"，b = 会话 id。
		 * 单独一层是因为约束表的存储形状是 {server, sessionId}，和 project.links 的 {a, b} 不同，
		 * 而 wbCanvasEdges 只认 {a, b}——在这里做形状适配，渲染与测试都只用一种口径。
		 */
		function wbMcpLinkPairs(data) {
			var source = data && typeof data === "object" ? data : {};
			var links = Array.isArray(source.links) ? source.links : [];
			var out = [];
			for (var i = 0; i < links.length; i += 1) {
				var link = links[i];
				if (!link || typeof link !== "object") continue;
				var server = typeof link.server === "string" ? link.server : "";
				var sessionId = typeof link.sessionId === "string" ? link.sessionId : "";
				if (server === "" || sessionId === "") continue;
				out.push({ a: "mcp:" + server, b: sessionId, server: server });
			}
			return out;
		}

		/**
		 * 会话 → 被允许的 MCP 服务名列表（Agent 节点挂徽标用）。
		 * 没有约束的会话不出现在结果里——「不在表里」和「被允许一切」是两回事，
		 * 前者是默认全放行，后者不该由徽标表达。
		 */
		function wbMcpAllowedBySession(data) {
			var pairs = wbMcpLinkPairs(data);
			var map = {};
			for (var i = 0; i < pairs.length; i += 1) {
				var pair = pairs[i];
				if (map[pair.b] === undefined) map[pair.b] = [];
				if (map[pair.b].indexOf(pair.server) < 0) map[pair.b].push(pair.server);
			}
			return map;
		}

		/**
		 * 「设置 › 高级 › MCP 约束」的数据视图：每个成员一行 + 服务列表。
		 * 语义取自宿主 mcpConstraintGuard：会话**只要连过任何 MCP 服务，就只能用连过的那些**；一个都没连过 = 不受限。
		 * 所以 restricted = allowed 非空。指向「已不可用的服务」的旧约束要保留在 allowed 里——宿主仍按它拦，
		 * 界面若把它藏掉就会谎称「不受限」。指向「已不是成员的会话」的旧约束不凭空多一行，只计数（staleLinks）。
		 */
		function wbMcpMatrix(data, names) {
			var source = data && typeof data === "object" ? data : {};
			var known = names && typeof names === "object" ? names : {};
			var servers = (Array.isArray(source.available) ? source.available : []).filter(function (item) {
				return item && typeof item === "object" && typeof item.server === "string" && item.server !== "";
			}).map(function (item) { return { server: item.server, toolCount: typeof item.toolCount === "number" ? item.toolCount : 0 }; });
			var ids = [];
			var main = typeof source.mainSessionId === "string" ? source.mainSessionId : "";
			if (main !== "") ids.push(main);
			(Array.isArray(source.members) ? source.members : []).forEach(function (member) {
				if (member && typeof member.sessionId === "string" && member.sessionId !== "" && ids.indexOf(member.sessionId) < 0) ids.push(member.sessionId);
			});
			var pairs = wbMcpLinkPairs(source);
			var rows = ids.map(function (id) {
				var allowed = pairs.filter(function (pair) { return pair.b === id; }).map(function (pair) { return pair.server; });
				return { sessionId: id, name: known[id] || id.slice(0, 12), restricted: allowed.length > 0, allowed: allowed };
			});
			return {
				servers: servers,
				rows: rows,
				restrictedCount: rows.filter(function (row) { return row.restricted; }).length,
				linkCount: pairs.length,
				staleLinks: pairs.filter(function (pair) { return ids.indexOf(pair.b) < 0; }).length
			};
		}

		/** 某成员是否被授权某个 MCP 服务。 */
		function wbMcpHas(data, server, sessionId) {
			return wbMcpLinkPairs(data).some(function (pair) { return pair.server === server && pair.b === sessionId; });
		}


		/**
		 * 画布节点检视（开发协作定位 · A/C 方向）。
		 *
		 * 为什么加它：画布原来只能「摆位置、连关联线、删节点」——那是个拓扑图，不是开发工具。
		 * 开发者盯着一个节点时真正想问的是「这个 Agent 在干什么、卡在哪儿、活儿派到哪了」，
		 * 而这些信息此前散在任务板和待办两个页签里，看一个节点要切两次 Tab。
		 *
		 * 口径约束：
		 *   - 纯函数，不碰 DOM、不发请求，全部从已拉到的快照推导（离线测试同口径）；
		 *   - 状态词一律复用 wbTaskRowView / wbInboxView，**不另造一套**；
		 *   - 读不到就说「没有/还没写」，不编造；
		 *   - 事件台账不带 sessionId（宿主 eventView 已核实），所以检视器**不猜**事件归属。
		 *
		 * @param node wbCanvasNodes 产出的节点
		 * @param ctx  { tasks, sessions, project, inbox }
		 */
		function wbNodeInspector(node, ctx) {
			if (!node || typeof node !== "object") return null;
			var options = ctx && typeof ctx === "object" ? ctx : {};
			var tasks = Array.isArray(options.tasks) ? options.tasks : [];
			var sessions = Array.isArray(options.sessions) ? options.sessions : [];
			var project = options.project && typeof options.project === "object" ? options.project : null;
			var inbox = options.inbox && typeof options.inbox === "object" ? options.inbox : null;
			var byId = {};
			tasks.forEach(function (task) { byId[String(task.taskId)] = task; });
			var bySession = {};
			sessions.forEach(function (row) { bySession[String(row.sessionId)] = row; });
			var kind = String(node.kind || "");

			function rows(list) {
				return list.map(function (task) {
					var view = wbTaskRowView(task, byId);
					return {
						taskId: view.taskId,
						subject: view.subject,
						status: view.status,
						ready: view.ready,
						blockedReason: view.blockedReason || null,
						where: view.worktree || view.execRoot || null,
						revision: view.revision,
						ownerSessionId: view.ownerSessionId,
						...(view.designHandoff ? { designHandoff: view.designHandoff } : {}),
						report: view.report
					};
				});
			}
			function titleOf(sessionId) {
				var row = bySession[String(sessionId)];
				return row && typeof row.title === "string" && row.title !== "" ? row.title : String(sessionId);
			}
			/** 已完工/已删的不计入「在干什么」，只计数。 */
			function live(list) {
				return list.filter(function (task) { return task.status !== "completed" && task.status !== "deleted" });
			}

			if (kind === "agent") {
				var sessionId = String(node.sessionId || node.id || "");
				var row = bySession[sessionId];
				var owned = tasks.filter(function (task) { return String(task.ownerSessionId || "") === sessionId; });
				var active = rows(live(owned));
				// 观测层：它最近调过哪些工具。数据来自宿主 /sessions 的 recentTools
				//（= 会话事件里的 tool/call，已在真实落盘会话里核实过形状）。
				// 只观测：这里不做任何「允许/禁止」判断，那是约束层的事。
				var tools = row && Array.isArray(row.recentTools)
					? row.recentTools.filter(function (item) { return item && typeof item.name === "string" && item.name !== ""; })
					: [];
				var toolNames = {};
				var toolList = [];
					tools.forEach(function (item) {
						if (toolNames[item.name] === true) return;
						toolNames[item.name] = true;
						toolList.push(item.name);
					});
				return {
					kind: "agent",
					title: typeof node.title === "string" ? node.title : sessionId,
					statusLabel: row && row.running ? "在线" : "空闲",
					statusTone: row && row.running ? "ok" : "neutral",
					tasks: active,
					doneCount: owned.length - active.length,
					// 去重后的工具名（同一工具调多次只算一次），保持最近优先的顺序
					toolNames: toolList,
					toolCallCount: tools.length,
					people: [],
					notes: active.length === 0 ? ["没有进行中的任务"] : []
				};
			}
			if (kind === "folder") {
				var list = Array.isArray(node.tasks) ? node.tasks : [];
				var activeRows = rows(live(list));
				var seen = {};
				var people = [];
				list.forEach(function (task) {
					var owner = String(task.ownerSessionId || "");
					if (owner === "" || seen[owner] === true) return;
					seen[owner] = true;
					people.push(titleOf(owner));
				});
				return {
					kind: "folder",
					title: typeof node.title === "string" ? node.title : "",
					statusLabel: activeRows.length + " 个任务指向这里",
					statusTone: activeRows.length > 0 ? "ok" : "neutral",
					tasks: activeRows,
					doneCount: list.length - activeRows.length,
					people: people,
					notes: activeRows.length === 0 ? ["没有进行中的任务指向这个落点"] : []
				};
			}
			if (kind === "composer") {
				var groups = inbox === null ? {} : wbInboxView(inbox).groups;
				var pending = groups.proposals ? groups.proposals.items.length : 0;
				var brief = project && project.brief ? project.brief : null;
				var briefVersion = brief && typeof brief.version === "number" ? brief.version : 1;
				var goalText = brief && typeof brief.goal === "string" ? brief.goal : "";
				return {
					kind: "composer",
					title: typeof node.title === "string" ? node.title : "",
					statusLabel: pending > 0 ? pending + " 条提案待确认" : "没有待确认提案",
					statusTone: pending > 0 ? "warn" : "neutral",
					tasks: [],
					doneCount: 0,
					people: [],
					goal: goalText,
					briefVersion: briefVersion,
					notes: [
						brief ? "项目简报已写（v" + briefVersion + "）" : "项目简报还没写",
						"主对话管提案与派发，不直接领任务"
					]
				};
			}
			if (kind === "file" || kind === "link") {
				// 波次 4：谁碰过这个文件 / 链接（只读事实，来自宿主 references）
				var marks = node.sessions && typeof node.sessions === "object" ? node.sessions : {};
				var touched = [];
				Object.keys(marks).forEach(function (sid) {
					var stat = marks[sid] || {};
					var parts = [];
					if (stat.write > 0) parts.push("改过 " + stat.write + " 次");
					if (stat.read > 0) parts.push("读过 " + stat.read + " 次");
					if (stat.ref > 0) parts.push("@引用 " + stat.ref + " 次");
					touched.push(titleOf(sid) + " · " + (parts.length > 0 ? parts.join("、") : "引用"));
				});
				return {
					kind: kind,
					title: kind === "link" ? String(node.url || node.title || "") : String(node.path || node.title || ""),
					statusLabel: node.fold ? "折叠了 " + (node.count || 0) + " 个较早的文件" : touched.length + " 个对话碰过",
					statusTone: "neutral",
					tasks: [],
					doneCount: 0,
					people: touched,
					notes: kind === "link" ? ["双击在新窗口打开"] : ["来源：会话日志里的读写工具调用、任务产物、用户 @ 引用"]
				};
			}
			return null;
		}

		/**
		 * 节点检视面板（开发协作定位 · A/C 方向）。
		 *
		 * 数据全部来自 props.data（= wbNodeInspector 的纯函数结果），这里只负责排版：
		 * 状态词与色调一律复用任务板同一套键（tasks.status.* / tasks.report.* / wbReportTone），
		 * 不另造一套，避免同一个「进行中」在两处长得不一样。
		 */
		/**
		 * 两个会话之间的交接记录（画布「连线检视」用）。
		 *
		 * 为什么加它：此前点连线只有「删除」一个动作，而节点有检视卡——严重不对称。
		 * 用户想看看这两个 Agent 之间发生过什么，只能去「发送记录」页签。
		 * 而连线承载的正是这层关系，数据也一直在（/handoffs 账本）。
		 *
		 * 口径：无向——A→B 与 B→A 都算「这两者之间」；from 可能是 "user"（人直接说），
		 * 所以不能假设两端都是会话 id。只读，纯函数，离线测试同口径。
		 */
		function wbLinkHandoffs(handoffs, a, b) {
			var list = Array.isArray(handoffs) ? handoffs : [];
			var left = String(a || "");
			var right = String(b || "");
			if (left === "" || right === "") return [];
			return list.filter(function (entry) {
				if (!entry || typeof entry !== "object") return false;
				var from = String(entry.from || "");
				var to = String(entry.to || "");
				return (from === left && to === right) || (from === right && to === left);
			}).map(function (entry) {
				return {
					kind: typeof entry.kind === "string" ? entry.kind : "",
					from: String(entry.from || ""),
					to: String(entry.to || ""),
					at: typeof entry.at === "number" ? entry.at : 0
				};
			}).sort(function (x, y) { return y.at - x.at; });
		}

		function WbNodeInspector(props) {
			var t = wbT(props);
			var data = props.data;
			if (!data || typeof data !== "object") return null;
			// 组件自己也要防坏数据：纯函数已经守过一遍，但 props 可能来自任何调用方，
			// 「一个节点检视把整块画布带崩」是不能接受的（与全库「坏数据不炸」同一口径）。
			var tasks = Array.isArray(data.tasks) ? data.tasks : [];
			var people = Array.isArray(data.people) ? data.people : [];
			var notes = Array.isArray(data.notes) ? data.notes : [];
			var doneCount = typeof data.doneCount === "number" && data.doneCount > 0 ? data.doneCount : 0;
			var kindKey = "inspect.kind." + String(data.kind || "");
			// 观测层：最近调用过的工具（去重后的名字 + 总次数）。约束层做之前，这里只展示不判断。
			var toolNames = Array.isArray(data.toolNames) ? data.toolNames.filter(function (name) { return typeof name === "string" && name !== ""; }) : [];
			var toolCallCount = typeof data.toolCallCount === "number" && data.toolCallCount > 0 ? data.toolCallCount : 0;
			// B2：Composer 卡内改目标（此前读内容/改内容都要去简报页签）
			var goalText = typeof data.goal === "string" ? data.goal : "";
			var goalEditState = react.useState(false);
			var goalEditing = goalEditState[0];
			var setGoalEditing = goalEditState[1];
			var goalDraftState = react.useState("");
			var goalDraft = goalDraftState[0];
			var setGoalDraft = goalDraftState[1];
			var goalSavingState = react.useState(false);
			var goalSaving = goalSavingState[0];
			var setGoalSaving = goalSavingState[1];
			var goalErrorState = react.useState("");
			var goalError = goalErrorState[0];
			var setGoalError = goalErrorState[1];
			function briefVersionOf(row) { return row && typeof row.briefVersion === "number" ? row.briefVersion : 1; }
			function saveGoal() {
				setGoalSaving(true);
				setGoalError("");
				wbApi("/projects/" + encodeURIComponent(props.projectId) + "/brief", {
					method: "PUT",
					body: { expectedVersion: briefVersionOf(data), goal: goalDraft }
				}).then(function (payload) {
					setGoalSaving(false);
					if (payload && payload.code !== 200) {
						setGoalError(t("brief.conflict", { latest: payload.data && payload.data.latestVersion, base: briefVersionOf(data) }));
						return;
					}
					wbCache.invalidate("/projects/" + encodeURIComponent(props.projectId));
					setGoalEditing(false);
				}).catch(function (failure) {
					setGoalSaving(false);
					setGoalError(failure && failure.message ? failure.message : String(failure));
				});
			}

			return h("div", { className: "daw-wb-inspect", "data-kind": String(data.kind || "") },
				h("div", { className: "daw-wb-inspect-head" },
					h("span", { className: "daw-wb-inspect-kind" }, t(kindKey)),
					h("span", { className: "daw-wb-inspect-title" }, (typeof data.title === "string" ? data.title : "") || t("common.none")),
					h(WbChip, { tone: data.statusTone }, typeof data.statusLabel === "string" ? data.statusLabel : ""),
					h("span", { className: "daw-wb-toolfill" }),
					props.onClose ? h(WbBtn, { variant: "ghost", onClick: props.onClose }, t("common.close")) : null),
				h("div", { className: "daw-wb-inspect-body" },
					tasks.length > 0
						? h("div", { className: "daw-wb-inspect-tasks" }, tasks.map(function (row) {
							var item = row && typeof row === "object" ? row : {};
							var tone = item.status === "completed" ? "ok" : item.status === "in_progress" ? "brand" : item.blockedReason != null ? "danger" : "neutral";
							var dispatchable = typeof props.onDispatch === "function" && !item.designHandoff
								&& (item.status === "pending" || item.status === "in_progress")
								&& typeof item.ownerSessionId === "string" && item.ownerSessionId !== "";
							return h("div", { key: String(item.taskId || ""), className: "daw-wb-inspect-task" },
								h("span", { className: "daw-wb-inspect-task-subject" }, item.subject || item.taskId || t("common.none")),
								h(WbChip, { tone: tone }, t("tasks.status." + String(item.status || "pending"))),
								item.report == null ? null : h(WbChip, { tone: wbReportTone(item.report.status), title: item.report.summary }, t("tasks.report." + String(item.report.status || "draft"))),
								h("span", { className: "daw-wb-inspect-task-where" }, item.where || t("common.none")),
								item.blockedReason != null ? h("span", { className: "daw-wb-inspect-task-blocked" }, t("inspect.blocked." + String(item.blockedReason))) : null,
								// B1：画布上直接派发。只对「有主且未完工」的给按钮——没主的要先指派，那是任务板的活。
								dispatchable ? h(WbBtn, { variant: "ghost", title: t("inspect.dispatch.title"), onClick: function () { props.onDispatch(item.taskId, item.revision); } }, t("inspect.dispatch")) : null);
						}))
						: null,
					toolNames.length > 0
						? h("div", { className: "daw-wb-inspect-tools" },
							h("span", { className: "daw-wb-inspect-label" }, t("inspect.tools")),
							h("span", { className: "daw-wb-inspect-toollist" }, toolNames.map(function (name, index) {
								return h("code", { key: index, className: "daw-wb-inspect-tool" }, name);
							})),
							h("span", { className: "daw-wb-inspect-toolcount" }, t("inspect.tools.count", { count: toolCallCount })))
						: null,
					people.length > 0
						? h("div", { className: "daw-wb-inspect-people" },
							h("span", { className: "daw-wb-inspect-label" }, t("inspect.people")),
							h("span", null, people.join("、")))
						: null,
					// B2：Composer 卡内直接改目标
					String(data.kind || "") === "composer" && typeof props.projectId === "string" && props.projectId !== ""
						? h("div", { className: "daw-wb-inspect-goal" },
							goalEditing === true
								? h("div", { className: "daw-wb-inspect-goal-edit" },
									h("textarea", { className: "daw-wb-inspect-goal-input", value: goalDraft, rows: 3, onChange: function (event) { setGoalDraft(event.target.value); }, placeholder: t("inspect.goal.placeholder") }),
									goalError !== "" ? h("div", { className: "daw-wb-inspect-goal-error" }, goalError) : null,
									h("div", { className: "daw-wb-inspect-goal-actions" },
										h(WbBtn, { variant: "ghost", onClick: function () { setGoalEditing(false); setGoalError(""); } }, t("common.cancel")),
										h(WbBtn, { disabled: goalSaving === true, onClick: saveGoal }, t("common.save"))))
								: h("div", { className: "daw-wb-inspect-goal-read" },
									h("span", { className: "daw-wb-inspect-goal-text" }, goalText === "" ? t("canvas.goal.none") : goalText),
									h(WbBtn, { variant: "ghost", onClick: function () { setGoalDraft(goalText); setGoalEditing(true); } }, t("inspect.goal.edit"))))
						: null,
					notes.map(function (note, index) {
						return h("div", { key: index, className: "daw-wb-inspect-note" }, typeof note === "string" ? note : "");
					}),
					doneCount > 0 ? h("div", { className: "daw-wb-inspect-done" }, t("inspect.done", { count: doneCount })) : null));
		}

		// ── 波次 3：新画布（React Flow 12 + dagre，按需 chunk）────────────────────────
		//
		// lib/client.flow.js 由 tools/flow-chunk/build.mjs 生成：宿主包内 chunk 契约
		// （`require.async("./client.flow.js")`，文件自己 __ModuleLoader__.load({id, chunk})）。
		// React / ReactDOM 用宿主共享模块表里的同一份，主包体积门禁不受影响。
		// 拿不到（旧宿主、离线垫片、网络失败）一律退回经典舞台——画布永远有得用。


		/** React Flow chunk 的加载状态：idle → loading → ready / failed；宿主没有按需 chunk 能力 = unavailable。 */
		var wbFlowLoader = (function () {
			var listeners = new Set();
			var snapshot = { status: "idle", lib: null, error: "" };
			function publish(next) {
				snapshot = next;
				listeners.forEach(function (listener) { listener(); });
			}
			function injectCss(css) {
				try {
					if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return;
					if (typeof document.getElementById === "function" && document.getElementById("dsh-agent-whales-flow-css")) return;
					var style = document.createElement("style");
					style.id = "dsh-agent-whales-flow-css";
					style.textContent = String(css || "");
					document.head.appendChild(style);
				} catch (error) { /* 样式没注入上只是难看，不阻断 */ }
			}
			function load() {
				if (snapshot.status !== "idle") return;
				if (!wbRequire || typeof wbRequire.async !== "function") {
					publish({ status: "unavailable", lib: null, error: "" });
					return;
				}
				publish({ status: "loading", lib: null, error: "" });
				Promise.resolve().then(function () { return wbRequire.async("./client.flow.js"); }).then(function (lib) {
					if (!lib || typeof lib.ReactFlow !== "function" && typeof lib.ReactFlow !== "object") throw new Error("client.flow.js 没有导出 ReactFlow");
					injectCss(lib.FLOW_CSS);
					publish({ status: "ready", lib: lib, error: "" });
				}).catch(function (error) {
					publish({ status: "failed", lib: null, error: error && error.message ? error.message : String(error) });
				});
			}
			return {
				get: function () { return snapshot; },
				subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
				load: load,
				retry: function () {
					if (snapshot.status === "failed") snapshot = { status: "idle", lib: null, error: "" };
					load();
				}
			};
		})();

		/**
		 * 波次 6：原型帧预览 / 组件库节点（client.proto.js，约 41KB）与完整 Puck 编辑器（client.puck.js，约 1.1MB，
		 * 只在点「编辑」时加载）。与 wbFlowLoader 同一套四态：宿主没有 require.async = unavailable。
		 */
		function wbChunkLoader(fileName, ready, onReady) {
			var listeners = new Set();
			var snapshot = { status: "idle", lib: null, error: "" };
			function publish(next) { snapshot = next; listeners.forEach(function (listener) { listener(); }); }
			return {
				get: function () { return snapshot; },
				subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
				load: function () {
					if (snapshot.status === "failed") snapshot = { status: "idle", lib: null, error: "" };
					if (snapshot.status !== "idle") return;
					if (!wbRequire || typeof wbRequire.async !== "function") { publish({ status: "unavailable", lib: null, error: "" }); return; }
					publish({ status: "loading", lib: null, error: "" });
					Promise.resolve().then(function () { return wbRequire.async("./" + fileName); }).then(function (lib) {
						if (!lib || !ready(lib)) throw new Error(fileName + " 导出不完整");
						if (typeof onReady === "function") onReady(lib);
						publish({ status: "ready", lib: lib, error: "" });
					}).catch(function (error) { publish({ status: "failed", lib: null, error: error && error.message ? error.message : String(error) }); });
				}
			};
		}
		var wbProtoLoader = wbChunkLoader("client.proto.js", function (lib) { return typeof lib.PrototypeNode === "function" && typeof lib.LibraryNode === "function"; });
		/**
		 * show_view 卡片节点 + 侧聊节点（client.view.js，约 78KB）。有视图卡 / 侧聊，或用户点「＋ 侧聊」时才加载。
		 * 样式（VIEW_CSS）随 chunk 导出，加载即注入 <head>；节点样式全部限定在 .daw-view-node / .daw-side-node 与 .dv-* 下，
		 * 不碰 DSH 页面上别的东西。
		 */
		/**
		 * 组件工坊（设计方案 §9.1）：组件 / 画板节点 + 沙箱预览 + 在线画布登记（client.design.js，约 29KB）。
		 * 只在画布上出现 kind=component / kind=artboard 的元素时才加载，主包门禁不动。
		 */
		var wbDesignLoader = wbChunkLoader("client.design.js", function (lib) {
			return typeof lib.DesignComponentNode === "function" && typeof lib.DesignArtboardNode === "function";
		});
		/** useDesignLive 内部有 effect，必须放在独立子组件里，不能随 chunk ready 条件改变父组件 hook 数。 */
		function WbDesignLiveBridge(props) {
			if (props.lib && typeof props.lib.useDesignLive === "function") props.lib.useDesignLive(props.projectId, props.token, { packId: props.packId });
			return null;
		}
		var wbViewLoader = wbChunkLoader("client.view.js", function (lib) { return typeof lib.ViewNode === "function" && typeof lib.SideNode === "function"; }, function (lib) {
			try {
				if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return;
				if (typeof document.getElementById === "function" && document.getElementById("dsh-agent-whales-view-css")) return;
				var style = document.createElement("style");
				style.id = "dsh-agent-whales-view-css";
				style.textContent = String(lib.VIEW_CSS || "");
				document.head.appendChild(style);
			} catch (error) { /* 样式没注入上只是难看，不阻断 */ }
		});
		// Puck 检测不到自己的样式会把编辑器 visibility:hidden（真机 2026-11-17：点「编辑」后一片空白）——加载即注入。
		// 它的样式是 CSS Modules（_Puck_xxx 哈希类）+ --puck-* 变量，不会改 DSH 页面上别的东西。
		var wbPuckLoader = wbChunkLoader("client.puck.js", function (lib) { return typeof lib.Puck === "function"; }, function (lib) {
			try {
				if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return;
				if (typeof document.getElementById === "function" && document.getElementById("dsh-agent-whales-puck-css")) return;
				var style = document.createElement("style");
				style.id = "dsh-agent-whales-puck-css";
				style.textContent = String(lib.PUCK_CSS || "");
				document.head.appendChild(style);
			} catch (error) { /* 注入失败只是编辑器难看 */ }
		});

		/**
		 * 原型帧 / 组件库元素 → 画布节点规格（纯函数，波次 6）。
		 * 组件库节点决定所有原型用哪套组件（D-6：换节点 = 换组件）；没有组件库节点时用内置 shadcn。
		 */
		function wbProtoLayout(elements, packs, origin) {
			var list = Array.isArray(elements) ? elements : [];
			var known = Array.isArray(packs) ? packs : [];
			var library = list.filter(function (el) { return el && el.kind === "library"; })[0] || null;
			var packId = library && library.data && typeof library.data.packId === "string" ? library.data.packId : "shadcn";
			var packMeta = known.filter(function (meta) { return meta && meta.id === packId; })[0] || { id: "shadcn", name: "shadcn/ui（内置）", builtin: true, license: "MIT" };
			var base = origin || { x: 1500, y: 24 };
			var y = base.y + (library ? 250 : 0);
			var prototypes = list.filter(function (el) { return el && el.kind === "prototype"; }).map(function (el) {
				var fixed = typeof el.x === "number" && typeof el.y === "number";
				var row = { el: el, x: fixed ? el.x : base.x, y: fixed ? el.y : y };
				if (!fixed) y += (el.data && el.data.width === "mobile" ? 560 : 440);
				return row;
			});
			return {
				packMeta: packMeta,
				library: library,
				libraryPos: library && typeof library.x === "number" && typeof library.y === "number" ? { x: library.x, y: library.y } : base,
				prototypes: prototypes,
				edges: library ? prototypes.map(function (row) { return { source: library.id, target: row.el.id }; }) : []
			};
		}

		/**
		 * 画布连线 → React Flow 边（两种线 + 粗管 + 约束线）。PRD v2.2 九（续二）连线语义：
		 *   dependency 实线 + 箭头（上游 → 下游，下游等上游，可在画布上画 / 删，落库 blockedBy）；
		 *   relay      虚线、无向（允许互发，project.links）；
		 *   mcp        点线（约束，MCP → 会话）；
		 *   context    粗管（上下文 → 负责它任务的 Agent：本轮带上该上下文），只读。
		 * data.pick 是选中后写进 picked 的键（删除走同一套 removeLink）；context 不可选。
		 */
		function wbFlowEdges(edges, nodes, tasks, t) {
			var tr = typeof t === "function" ? t : function (key) { return wbFill(WB_TEXT.zh[key]); };
			var out = [];
			var seen = {};
			var nodeIds = {};
			(Array.isArray(nodes) ? nodes : []).forEach(function (node) { if (node && typeof node.id === "string") nodeIds[node.id] = node; });
			/**
			 * 锚点按两端相对位置挑（四边各一个）：同一列上下排的 Agent 之间走上下边，
			 * 不再从右边绕一圈回左边（2026-11-17 真机截图：依赖线在同列两卡之间打了个圈）。
			 */
			function sides(a, b) {
				var na = nodeIds[a];
				var nb = nodeIds[b];
				if (!na || !nb) return {};
				var ax = (na.x || 0) + (na.w || 0) / 2;
				var ay = (na.y || 0) + (na.h || 0) / 2;
				var bx = (nb.x || 0) + (nb.w || 0) / 2;
				var by = (nb.y || 0) + (nb.h || 0) / 2;
				var dx = bx - ax;
				var dy = by - ay;
				if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { sourceHandle: "s-r", targetHandle: "t-l" } : { sourceHandle: "s-l", targetHandle: "t-r" };
				return dy >= 0 ? { sourceHandle: "s-b", targetHandle: "t-t" } : { sourceHandle: "s-t", targetHandle: "t-b" };
			}
			(Array.isArray(edges) ? edges : []).forEach(function (edge) {
				if (!edge || typeof edge.a !== "string" || typeof edge.b !== "string") return;
				// 波次 4：文件 / 链接 → 对话，用上下文同款粗管，边上标「读过 / 改过 / @引用」，只读
				if (typeof edge.reason === "string" && edge.reason.indexOf("file-") === 0) {
					var mark = edge.reason.slice(5);
					var fileId = "file:" + edge.a + "|" + edge.b;
					if (seen[fileId]) return;
					seen[fileId] = true;
					out.push(Object.assign({
						id: fileId,
						source: edge.a,
						target: edge.b,
						className: "daw-wb-edge-context daw-wb-edge-file-" + mark,
						selectable: false,
						label: tr("canvas.file.mark." + (mark === "write" || mark === "ref" ? mark : "read")),
						style: { strokeWidth: mark === "write" ? 6 : 4, strokeOpacity: mark === "write" ? 0.45 : 0.25 },
						data: { kind: "context", mark: mark, pick: null }
					}, sides(edge.a, edge.b)));
					return;
				}
				var kind = edge.reason === "blocked" ? "dependency" : "relay";
				var id = kind + ":" + edge.a + "|" + edge.b;
				if (seen[id]) return;
				seen[id] = true;
				var spec = Object.assign({
					id: id,
					source: edge.a,
					target: edge.b,
					className: "daw-wb-edge-" + kind,
					data: { kind: kind, pick: kind === "dependency" ? "dep:" + edge.a + "|" + edge.b : edge.a + "|" + edge.b }
				}, sides(edge.a, edge.b));
				if (kind === "dependency") {
					spec.markerEnd = { type: "arrowclosed", width: 16, height: 16 };
					spec.style = { strokeWidth: 2 };
					if (typeof edge.label === "string" && edge.label !== "") spec.label = edge.label;
				} else {
					spec.style = { strokeWidth: 1.5, strokeDasharray: "6 4" };
				}
				out.push(spec);
			});
			(Array.isArray(nodes) ? nodes : []).forEach(function (node) {
				if (!node || node.kind !== "folder" || !Array.isArray(node.tasks)) return;
				var owners = {};
				node.tasks.forEach(function (task) {
					if (task && typeof task.ownerSessionId === "string" && task.ownerSessionId !== "" && nodeIds[task.ownerSessionId]) owners[task.ownerSessionId] = true;
				});
				Object.keys(owners).forEach(function (sessionId) {
					out.push(Object.assign({
						id: "context:" + node.id + "|" + sessionId,
						source: node.id,
						target: sessionId,
						className: "daw-wb-edge-context",
						selectable: false,
						style: { strokeWidth: 7, strokeOpacity: 0.28 },
						data: { kind: "context", pick: null }
					}, sides(node.id, sessionId)));
				});
			});
			return out;
		}

		var WB_REQ_NODE = { x: -300, y: 24, w: 230, h: 132, gap: 16, max: 12 };

		/**
		 * 画布上的需求卡布局（纯函数）：每个需求一张卡，排在画布最左边一列（负 x，不挤占 Agent / 上下文列）；
		 * 用户拖过的以位置表为准（getSaved(id) 返回 {x,y} 或 undefined）。虚拟「未归类」不上画布——它不是用户能处理的东西；
		 * 最多 12 张，其余折叠到「还有 N 个」提示（要看全的去需求页）。
		 */
		function wbRequirementCanvasItems(rows, getSaved, origin) {
			var base = origin && typeof origin.x === "number" && typeof origin.y === "number" ? origin : { x: WB_REQ_NODE.x, y: WB_REQ_NODE.y };
			var list = (Array.isArray(rows) ? rows : []).filter(function (row) { return row && row.virtual !== true && typeof row.reqId === "string"; });
			var shown = list.slice(0, WB_REQ_NODE.max);
			return {
				hidden: list.length - shown.length,
				items: shown.map(function (row, index) {
					var id = "req:" + row.reqId;
					var saved = typeof getSaved === "function" ? getSaved(id) : undefined;
					var fixed = saved && typeof saved.x === "number" && typeof saved.y === "number";
					var defaultY = base.y + index * (WB_REQ_NODE.h + WB_REQ_NODE.gap);
					return { id: id, row: row, reqId: row.reqId, fixed: fixed === true, defaultY: defaultY, x: fixed ? saved.x : base.x, y: fixed ? saved.y : defaultY, w: WB_REQ_NODE.w };
				})
			};
		}

		/** 一张需求卡（经典壳 .daw-wb-node，进新画布后由 flowcell 重置定位）。点卡去需求页；只有卡头能拖。 */
		function wbRequirementCard(row, t, onOpen, pos, ownerName) {
			var style = { width: WB_REQ_NODE.w, cursor: "pointer" };
			if (pos && typeof pos.left === "number" && typeof pos.top === "number") { style.left = pos.left; style.top = pos.top; }
			return h("div", { key: "req:" + row.reqId, className: "daw-wb-node daw-wb-reqnode", "data-kind": "requirement", "data-attention": row.attention, "data-stage": row.stage, "data-owner": row.ownerSessionId, style: style, onClick: onOpen, title: row.next },
				h("div", { className: "daw-wb-node-head" },
					h("span", { className: "daw-wb-node-tag" }, "◎"),
					h("span", { className: "daw-wb-reqnode-title" }, row.title),
					h("span", { className: "daw-wb-node-fill" }),
					row.attention !== "" ? h("span", { className: "daw-wb-req-attn" }, t("req.attention." + row.attention)) : null),
				h("div", { className: "daw-wb-reqnode-top" },
					h(WbChip, { tone: row.tone }, t("req.stage." + row.stage)),
					h("span", { className: "daw-wb-note" }, t("req.meta", { done: row.tasksDone, total: row.tasks, protos: row.prototypes }))),
				// 负责人：调用方给了名字表（ownerName !== undefined）才显示；没指定显示「未指定负责人」。
				ownerName === undefined ? null : h("div", { className: "daw-wb-note" }, row.ownerSessionId !== "" ? t("req.owner.set", { name: ownerName || row.ownerSessionId.slice(0, 12) }) : t("req.owner.unset")),
				row.next !== "" ? h("div", { className: "daw-wb-req-next" }, row.next) : null);
		}

		/** 元素（原型帧 / 流程图分组框）归属的需求 id：元素自己或 data 里写过才算，没写过就是空串（不凭空猜）。 */
		function wbElementRequirementId(el) {
			if (!el || typeof el !== "object") return "";
			if (typeof el.requirementId === "string" && el.requirementId !== "") return el.requirementId;
			if (el.data && typeof el.data === "object" && typeof el.data.requirementId === "string") return el.data.requirementId;
			return "";
		}

		/** 需求分带的间距：带内成员之间 memberGap；带与带之间 gap；带上要画分组框（标题条 head + 内边距 pad）时用 framedGap，免得框叠框。 */
		var WB_REQ_BAND = { gap: 16, framedGap: 80, memberGap: 24, pad: 20, head: 36 };

		/** 一组盒子 {x,y,w,h} 的分组框包围盒：四周留 pad，上面多留一条标题条 head。空输入给 null。 */
		function wbFrameBox(boxes) {
			var list = (Array.isArray(boxes) ? boxes : []).filter(function (b) { return b && typeof b.x === "number" && typeof b.y === "number" && typeof b.w === "number" && typeof b.h === "number" && isFinite(b.x + b.y + b.w + b.h); });
			if (list.length === 0) return null;
			var minX = Math.min.apply(null, list.map(function (b) { return b.x; }));
			var maxX = Math.max.apply(null, list.map(function (b) { return b.x + b.w; }));
			var minY = Math.min.apply(null, list.map(function (b) { return b.y; }));
			var maxY = Math.max.apply(null, list.map(function (b) { return b.y + b.h; }));
			return { x: minX - WB_REQ_BAND.pad, y: minY - WB_REQ_BAND.head, w: maxX - minX + 2 * WB_REQ_BAND.pad, h: maxY - minY + WB_REQ_BAND.head + WB_REQ_BAND.pad };
		}

		/**
		 * 需求分带布局（纯函数，设计稿 §7 ② 需求分组框）。
		 *   cards   wbRequirementCanvasItems 的 items（带 fixed / defaultY：用户拖过的卡位置固定）
		 *   members [{ id, reqId, w, h, fixed, x, y }]：原型帧 / 流程图分组框；fixed = 用户拖过（位置以存下的为准）
		 * 返回 { cards: {id: {x,y}}, members: {id: {x,y}}, frames: [{ id, reqId, x, y, w, h, memberCount, members: [{id,w,h}] }] }（框的 x/y/w/h 是按「假定槽位尺寸」算的回退值；舞台拿到测得的真实尺寸后会按 members 重算）：
		 *   · 没拖过的成员默认排在自己需求卡的**左边**，和卡顶对齐，一个挨一个向左排；一带的高度 = max(卡高, 最高的成员)，下一个需求带排在它下面；
		 *   · 拖过的卡 / 成员保持原位（不参与排队），分组框按**当前真实位置**取包围盒——所以拖动后框跟着走；
		 *   · 有成员才画框：只有一张卡的需求不画（框住一张卡是噪音）；没有归属的成员（reqId 空 / 需求不在画布上）一律不碰，仍走原来的默认位置。
		 */
		function wbRequirementBands(cards, members) {
			var out = { cards: {}, members: {}, frames: [] };
			var cardList = (Array.isArray(cards) ? cards : []).filter(function (item) { return item && typeof item.id === "string" && item.row && typeof item.row.reqId === "string" && typeof item.x === "number" && typeof item.y === "number" && typeof item.w === "number"; });
			var memberList = (Array.isArray(members) ? members : []).filter(function (m) { return m && typeof m.id === "string" && typeof m.reqId === "string" && m.reqId !== "" && typeof m.w === "number" && typeof m.h === "number" && isFinite(m.w) && isFinite(m.h); });
			if (cardList.length === 0) return out;
			var cursor = typeof cardList[0].defaultY === "number" ? cardList[0].defaultY : cardList[0].y;
			var placedAny = false;
			var prevFramed = false;
			cardList.forEach(function (card) {
				var reqId = card.row.reqId;
				var own = memberList.filter(function (m) { return m.reqId === reqId; });
				var framed = own.length > 0;
				var free = own.filter(function (m) { return m.fixed !== true; });
				var bandH = free.reduce(function (acc, m) { return Math.max(acc, m.h); }, WB_REQ_NODE.h);
				var y;
				if (card.fixed === true) {
					y = card.y;
				} else {
					if (placedAny) cursor += (prevFramed || framed) ? WB_REQ_BAND.framedGap : WB_REQ_BAND.gap;
					y = cursor;
					cursor = y + bandH;
					placedAny = true;
					prevFramed = framed;
				}
				out.cards[card.id] = { x: card.x, y: y };
				var boxes = [{ id: card.id, x: card.x, y: y, w: card.w, h: WB_REQ_NODE.h }];
				var xc = card.x - WB_REQ_BAND.memberGap;
				own.forEach(function (m) {
					var pos;
					if (m.fixed === true && typeof m.x === "number" && typeof m.y === "number") {
						pos = { x: m.x, y: m.y };
					} else {
						pos = { x: xc - m.w, y: y };
						xc = pos.x - WB_REQ_BAND.memberGap;
						out.members[m.id] = pos;
					}
					boxes.push({ id: m.id, x: pos.x, y: pos.y, w: m.w, h: m.h });
				});
				if (!framed) return;
				var box = wbFrameBox(boxes);
				out.frames.push({ id: "reqframe:" + reqId, reqId: reqId, x: box.x, y: box.y, w: box.w, h: box.h, memberCount: own.length, members: boxes.map(function (b) { return { id: b.id, w: b.w, h: b.h }; }) });
			});			return out;
		}
		/** 画布的节点清单：派生节点与空态引导卡。 */
		function wbFlowItems(input) {
			var src = input || {};
			var items = [];
			(Array.isArray(src.nodes) ? src.nodes : []).forEach(function (node) {
				if (!node || typeof node.id !== "string") return;
				items.push({ id: node.id, kind: node.kind, x: node.x, y: node.y, w: node.w, el: typeof src.nodeEl === "function" ? src.nodeEl(node) : null });
			});
			if (src.emptyGuideEl) items.push({ id: "__guide", kind: "guide", x: 430, y: 576, w: 320, el: src.emptyGuideEl, handles: false });
			return items;
		}

		/** React Flow 自定义节点：外壳 + 左入右出两个锚点，内容就是经典舞台那张卡。 */
		var WB_FLOW_NODE_TYPES = null;
		function wbFlowNodeTypes(lib, protoLib, viewLib, designLib) {
			// nodeTypes 必须引用稳定：React Flow 每次拿到新对象都会警告并重挂全部节点
			if (WB_FLOW_NODE_TYPES !== null && WB_FLOW_NODE_TYPES.lib === lib && WB_FLOW_NODE_TYPES.protoLib === (protoLib || null) && WB_FLOW_NODE_TYPES.viewLib === (viewLib || null) && WB_FLOW_NODE_TYPES.designLib === (designLib || null)) return WB_FLOW_NODE_TYPES.types;
			/** 流程图节点（波次 5）：胶囊 / 圆角矩形 / 菱形；AI 生成且未被人改过的带「AI」角标。 */
			function WhaleFlowStep(p) {
				var d = p && p.data ? p.data : {};
				var shape = d.shape || "step";
				var size = wbFlowNodeSize(shape);
				// 内联编辑（用户反馈 2026-11-24）：**双击就地改字**，不再弹 window.prompt 弹窗。
				// 画布工具的习惯就是原地改：看得见上下文、改完回车即生效、Esc 取消。
				var editingState = react.useState(false);
				var editing = editingState[0];
				var draftState = react.useState("");
				var draft = draftState[0];
				var inputRef = react.useRef(null);
				react.useEffect(function () {
					if (!editing) return undefined;
					var timer = setTimeout(function () {
						var el = inputRef.current;
						if (el && typeof el.focus === "function") { el.focus(); if (typeof el.select === "function") el.select(); }
					}, 0);
					return function () { clearTimeout(timer); };
				}, [editing]);
				function commit() {
					var next = String(draft || "").trim();
					editingState[1](false);
					if (next === "" || next === (d.text || "")) return;
					if (typeof d.onCommit === "function") d.onCommit(next.slice(0, 120));
				}
				var body = editing
					? h("input", {
						ref: inputRef,
						className: "daw-wb-flowstep-input nodrag nopan",
						value: draft,
						onChange: function (event) { draftState[1](event.target.value); },
						onKeyDown: function (event) {
							if (event.key === "Enter") { event.preventDefault(); commit(); }
							else if (event.key === "Escape") { event.preventDefault(); editingState[1](false); }
							event.stopPropagation();
						},
						onBlur: function () { commit(); },
						onDoubleClick: function (event) { event.stopPropagation(); }
					})
					: h("span", { className: "daw-wb-flowstep-text" }, d.text || "");
				return h("div", {
					className: "daw-wb-flowstep",
					"data-shape": shape,
					"data-ai": d.ai ? "true" : "false",
					"data-editing": editing ? "true" : "false",
					title: editing ? undefined : (d.evidence || undefined),
					style: { width: size.w, height: size.h },
					onDoubleClick: function (event) {
						if (event && typeof event.stopPropagation === "function") event.stopPropagation();
						if (editing) return;
						draftState[1](d.text || "");
						editingState[1](true);
					}
				},
					h(lib.Handle, { type: "target", position: lib.Position.Top, className: "daw-wb-handle", id: "t-t" }),
					body,
					d.ai ? h("span", { className: "daw-wb-flowstep-ai" }, "AI") : null,
					h(lib.Handle, { type: "source", position: lib.Position.Bottom, className: "daw-wb-handle", id: "s-b" }));
			}
			/** 流程图分组框：标题 + AI 节点数 + 「＋步骤」「撤销 AI 生成」。 */
			function WhaleFlowGroup(p) {
				var d = p && p.data ? p.data : {};
				return h("div", { className: "daw-wb-flowgroup", style: { width: d.w, height: d.h } },
					h("div", { className: "daw-wb-flowgroup-head daw-wb-node-head" },
						h("span", { className: "daw-wb-node-tag" }, "⇄"),
						h("b", null, d.title || ""),
						d.aiCount > 0 ? h("span", { className: "daw-wb-flowstep-ai" }, d.aiLabel) : null,
						h("span", { className: "daw-wb-node-fill" }),
						typeof d.onAdd === "function" ? h("button", { type: "button", className: "daw-wb-zoombtn nodrag", onClick: d.onAdd }, d.addLabel) : null,
						d.aiCount > 0 && typeof d.onUndo === "function" ? h("button", { type: "button", className: "daw-wb-zoombtn nodrag", onClick: d.onUndo }, d.undoLabel) : null));
			}
			/** 需求分组框（设计稿 §7 ②）：虚线框 + 标题条（需求名 · 阶段 · 待办）。不可拖、不可选、不挡鼠标——框里的卡照常点、照常拖。 */
			function WhaleReqFrame(p) {
				var d = p && p.data ? p.data : {};
				return h("div", { className: "daw-wb-reqframe", "data-stage": d.stage || "", "data-attention": d.attention || "", style: { width: d.w, height: d.h } },
					h("div", { className: "daw-wb-reqframe-head" },
						h("span", { className: "daw-wb-reqframe-title" }, d.title || ""),
						h("span", { className: "daw-wb-reqframe-stage" }, d.stageLabel || ""),
						d.attentionLabel ? h("span", { className: "daw-wb-req-attn" }, d.attentionLabel) : null));
			}
			function WhaleFlowNode(p) {
				var d = p && p.data ? p.data : {};
				var handles = d.handles === false ? [] : [
					["target", "t-l", lib.Position.Left], ["target", "t-t", lib.Position.Top], ["target", "t-r", lib.Position.Right], ["target", "t-b", lib.Position.Bottom],
					["source", "s-r", lib.Position.Right], ["source", "s-b", lib.Position.Bottom], ["source", "s-l", lib.Position.Left], ["source", "s-t", lib.Position.Top]
				];
				return h("div", { className: "daw-wb-flowcell", "data-kind": d.kind || "", style: { width: d.w || 200 } },
					d.el || null,
					handles.map(function (spec) {
						// 每边一个入口 + 一个出口；只有右边的出口显眼（拖它连线），其余是给自动选边用的隐形锚点
						return h(lib.Handle, { key: spec[1], id: spec[1], type: spec[0], position: spec[2], className: "daw-wb-handle", "data-handle": spec[1] });
					}));
			}
			var types = { whale: WhaleFlowNode, whaleFlowStep: WhaleFlowStep, whaleFlowGroup: WhaleFlowGroup, whaleReqFrame: WhaleReqFrame };
			// 波次 6：原型帧 / 组件库节点来自 client.proto.js（按需加载后才有）
			if (protoLib && typeof protoLib.PrototypeNode === "function") { types.whaleProto = protoLib.PrototypeNode; types.whaleLibrary = protoLib.LibraryNode; }
			// 组件工坊：组件 / 画板节点（client.design.js）。沙箱 iframe 在 chunk 里自己管，这里只套一层连线锚点。
			if (designLib && typeof designLib.DesignComponentNode === "function") {
				types.whaleDesignComponent = function WhaleDesignComponentNode(p) {
					return h("div", { className: "daw-wb-flowcell", "data-kind": "design-component", style: { position: "relative" } }, h(designLib.DesignComponentNode, p));
				};
				types.whaleDesignArtboard = function WhaleDesignArtboardNode(p) {
					return h("div", { className: "daw-wb-flowcell", "data-kind": "design-artboard", style: { position: "relative" } }, h(designLib.DesignArtboardNode, p));
				};
			}
			// show_view 卡片 / 侧聊（client.view.js）：chunk 里的节点只管「画」，连线锚点由这里用 React Flow 的 Handle 包上。
			// 卡片：顶部入口 t-t（从产出它的对话牵一条线过来）；侧聊：顶部入口 t-t（对话背景线汇到这里）。
			if (viewLib && typeof viewLib.ViewNode === "function" && typeof viewLib.SideNode === "function") {
				types.whaleView = function WhaleViewNode(p) {
					return h("div", { className: "daw-wb-flowcell", "data-kind": "view", style: { position: "relative" } },
						h(lib.Handle, { type: "target", position: lib.Position.Top, className: "daw-wb-handle", id: "t-t", "data-handle": "t-t" }),
						h(viewLib.ViewNode, p));
				};
				types.whaleSide = function WhaleSideNode(p) {
					return h("div", { className: "daw-wb-flowcell", "data-kind": "side", style: { position: "relative" } },
						h(lib.Handle, { type: "target", position: lib.Position.Top, className: "daw-wb-handle", id: "t-t", "data-handle": "t-t" }),
						h(lib.Handle, { type: "target", position: lib.Position.Left, className: "daw-wb-handle", id: "t-l", "data-handle": "t-l" }),
						h(viewLib.SideNode, p));
				};
			}
			WB_FLOW_NODE_TYPES = { lib: lib, protoLib: protoLib || null, viewLib: viewLib || null, designLib: designLib || null, types: types };
			return WB_FLOW_NODE_TYPES.types;
		}

		/**
		 * 缩放三档（设计稿 ③）：远景看状态 / 中景看摘要 / 近景看全文。按 React Flow 的 zoom 阈值切：
		 * 小于 0.5 远景，大于等于 1 近景，其余中景。非数字 / 非有限数回落中景（不乱切）。
		 */
		function wbZoomLevel(zoom) {
			if (typeof zoom !== "number" || !isFinite(zoom)) return "mid";
			if (zoom < 0.5) return "far";
			if (zoom >= 1) return "near";
			return "mid";
		}

		/** 新画布舞台：ReactFlow + 背景 / 缩放控件 / 小地图 + 连线模式条 + 线型图例 + 浮层。 */
		function WbFlowStage(props) {
			var t = wbT(props);
			var lib = props.lib;
			var nodesState = react.useState([]);
			var zoomState = react.useState("mid");
			var latest = react.useRef([]);
			var prevById = {};
			(nodesState[0] || []).forEach(function (node) { prevById[node.id] = node; });
			var rfNodes = (props.items || []).map(function (item) {
				var prev = prevById[item.id];
				var node = {
					id: item.id,
					type: "whale",
					position: prev && prev.position ? prev.position : { x: item.x || 0, y: item.y || 0 },
					data: { el: item.el, kind: item.kind, w: item.w, handles: item.handles },
					selected: props.picked === item.id,
					// 只有卡头能拖：卡里有输入框 / 按钮，整卡可拖会把打字变成拖拽
					dragHandle: ".daw-wb-node-head"
				};
				// 流程图节点 / 分组（波次 5）：自带类型、父子关系与数据；位置以元素表为准（拖动后写回元素表）
				if (item.rf) {
					node = Object.assign(node, item.rf);
					if (!item.rf.dragHandle) delete node.dragHandle;
					// 拖动中跟手（applyNodeChanges 给的 dragging 位置），松手后以元素表为准
					node.position = prev && prev.dragging && prev.position ? prev.position : (item.rf.position || node.position);
				}
				if (prev && prev.measured) node.measured = prev.measured;
				return node;
			});
			// 需求分组框：几何按成员的**实时位置 + 测得的真实尺寸**算（没测到就用布局给的回退尺寸）——框贴着内容，拖动时也跟着走。
			var frameById = {};
			rfNodes.forEach(function (node) { frameById[node.id] = node; });
			(props.items || []).forEach(function (item, index) {
				if (!item || !Array.isArray(item.frameOf)) return;
				var box = wbFrameBox(item.frameOf.map(function (m) {
					var member = frameById[m.id];
					if (!member || !member.position) return null;
					var mw = member.measured && member.measured.width > 0 ? member.measured.width : m.w;
					var mh = member.measured && member.measured.height > 0 ? member.measured.height : m.h;
					return { x: member.position.x, y: member.position.y, w: mw, h: mh };
				}));
				var frameNode = rfNodes[index];
				if (!box || !frameNode) return;
				frameNode.position = { x: box.x, y: box.y };
				frameNode.style = Object.assign({}, frameNode.style, { width: box.w, height: box.h });
				frameNode.data = Object.assign({}, frameNode.data, { w: box.w, h: box.h });
			});
			latest.current = rfNodes;
			// 节点集合变了（文件 / 新 Agent 陆续出现）就重新适配视口；只看 id 集合，拖动不触发。
			// 真机 2026-11-17：文件节点晚于首帧到达，落在初始视口左侧外面，看不见。
			var instanceRef = react.useRef(null);
			var idsKey = rfNodes.map(function (node) { return node.id; }).sort().join("|");
			function fitCanvas(instance) {
				if (!instance || typeof instance.fitView !== "function") return;
				var options = { padding: 0.18, maxZoom: 1, duration: 200 };
				if (props.focus && rfNodes.some(function (node) { return node.id === props.focus.elementId; })) {
					options.nodes = [{ id: props.focus.elementId }];
				}
				try { instance.fitView(options); } catch (error) { /* 不影响画布操作 */ }
			}
			react.useEffect(function () {
				fitCanvas(instanceRef.current);
			}, [idsKey, props.focus]);
			function onNodesChange(changes) {
				nodesState[1](lib.applyNodeChanges(changes, latest.current));
			}
			var mode = props.connectMode === "dependency" ? "dependency" : "relay";
			var legend = ["dependency", "relay", "context", "flow"].concat(Array.isArray(props.extraLegend) ? props.extraLegend : []);
			return h("div", { className: "daw-wb-flow", "data-zoom": zoomState[0] },
				h(lib.ReactFlow, {
					nodes: rfNodes,
					// 缩放档位：任何视口变化（滚轮 / 拖拽 / fitView）都会回调；只在档位变了才 setState，平移不重渲染。
					onViewportChange: function (viewport) { if (viewport && typeof viewport.zoom === "number") zoomState[1](wbZoomLevel(viewport.zoom)); },
					edges: props.edges || [],
					nodeTypes: wbFlowNodeTypes(lib, props.protoLib, props.viewLib, props.designLib),
					onNodesChange: onNodesChange,
					onInit: function (instance) {
						instanceRef.current = instance;
						if (props.focus) fitCanvas(instance);
						try { if (instance && typeof instance.getZoom === "function") zoomState[1](wbZoomLevel(instance.getZoom())); } catch (error) { /* 读不到就保持中景 */ }
					},
					onConnect: function (connection) {
						if (connection && connection.source && connection.target && typeof props.onConnect === "function") props.onConnect(connection.source, connection.target);
					},
					onNodeClick: function (event, node) { if (typeof props.onPick === "function") props.onPick(node.id.indexOf("__") === 0 ? null : node.id); },
					onEdgeClick: function (event, edge) { if (edge && edge.data && edge.data.pick && typeof props.onPick === "function") props.onPick(edge.data.pick); },
					onPaneClick: function () { if (typeof props.onPick === "function") props.onPick(null); },
					onNodeDragStop: function (event, node) {
						// 占位 / 引导卡（__ 开头）与需求分组框（reqframe: 开头，纯装饰、位置由成员推出来）都不写位置表
					if (!node || node.id.indexOf("__") === 0 || node.id.indexOf("reqframe:") === 0 || typeof props.onMove !== "function") return;
						props.onMove(node.id, Math.round(node.position.x), Math.round(node.position.y));
					},
					// 删除走工具条的「删除」按钮（带确认语义），不让 Backspace 静默删线
					deleteKeyCode: null,
					fitView: true,
					// 留出左上角模式条 / 图例的位置，且不放大过 1（截图里卡片被放到 135%，字比侧栏还大）
					fitViewOptions: { padding: 0.18, maxZoom: 1 },
					// 手势（用户反馈 2026-11-24）：滚轮默认是**上下滚动**，不是缩放——
					// React Flow 的默认 zoomOnScroll=true 会让「滚一下页面就放大了」，很别扭。
					// 现在的映射：滚轮 = 上下平移 · Shift+滚轮 = 左右平移 · Ctrl/⌘+滚轮 = 缩放 · 拖空白 = 平移。
					// （onViewportChange 只回调，不影响手势，所以缩放档位显示仍然准。）
					zoomOnScroll: false,
					zoomOnPinch: true,
					zoomOnDoubleClick: false,
					panOnScroll: true,
					panOnScrollSpeed: 0.8,
					panOnScrollMode: "free",
					panOnDrag: true,
					preventScrolling: true,
					minZoom: 0.3,
					maxZoom: 2
				},
					props.gridOn ? h(lib.Background, { gap: 16 }) : null,
					// 缩放控件放右上：左下是提案浮层，叠在一起会把控件盖住（真机截图）
					h(lib.Controls, { showInteractive: false, position: "top-right" }),
					h(lib.MiniMap, {
						pannable: true, zoomable: true,
						nodeColor: "var(--daw-text-muted)",
						maskColor: "color-mix(in srgb,var(--daw-bg) 76%,transparent)"
					})),
				h("div", { className: "daw-wb-flowbar" },
					h("span", { className: "daw-wb-note" }, t("canvas.mode.title")),
					h("span", { className: "daw-wb-note daw-wb-zoomlevel", "data-zoom-label": zoomState[0], title: t("canvas.zoom.hint") }, t("canvas.zoom." + zoomState[0])),
					["relay", "dependency"].map(function (key) {
						return h("button", {
							key: key,
							type: "button",
							className: "daw-wb-zoombtn",
							"data-on": String(mode === key),
							"aria-pressed": mode === key,
							title: t("canvas.mode." + key + ".title"),
							onClick: function () { if (typeof props.onConnectMode === "function") props.onConnectMode(key); }
						}, t("canvas.mode." + key));
					})),
				h("details", { className: "daw-wb-legend" },
					h("summary", { className: "daw-wb-legend-title" }, t("canvas.legend.title")),
					h("div", { role: "list", "aria-label": t("canvas.legend.title") }, legend.map(function (key) {
						return h("div", { key: key, className: "daw-wb-legend-row", role: "listitem", "data-kind": key },
							h("svg", { width: 34, height: 10, "aria-hidden": "true" },
								h("line", { x1: 2, y1: 5, x2: 30, y2: 5, className: "daw-wb-legend-line", "data-kind": key })),
							h("span", null, t("canvas.legend." + key)));
					}))),
				(props.overlays || []).map(function (overlay, index) { return overlay ? h("div", { key: index, className: "daw-wb-flow-overlay" }, overlay) : null; }));
		}

		/**
		 * 文件 / 外部引用节点（PRD v2.2 波次 4，D-1）：宿主 /projects/:id/references 的结果 →
		 * 画布节点 + 「文件 → 对话」粗管连线。只认事实（日志 tool/call、report 产物、用户 @ / 链接）。
		 * 护栏：每个对话只展示最近 perSession 个文件，其余折叠成一个「+N 个文件」节点；链接最多 maxLinks 个。
		 * 纯函数：refs 坏了给空，sessionIds 是画布上实际存在的会话节点（只连得到的才画）。
		 */
		function wbReferenceNodes(refs, sessionIds, options) {
			var opts = options || {};
			var perSession = typeof opts.perSession === "number" ? opts.perSession : 4;
			var maxLinks = typeof opts.maxLinks === "number" ? opts.maxLinks : 8;
			var startY = typeof opts.startY === "number" ? opts.startY : 24;
			var onCanvas = {};
			(Array.isArray(sessionIds) ? sessionIds : []).forEach(function (id) { if (typeof id === "string") onCanvas[id] = true; });
			var files = refs && Array.isArray(refs.files) ? refs.files.filter(function (row) { return row && typeof row.key === "string" && row.sessions && typeof row.sessions === "object"; }) : [];
			var links = refs && Array.isArray(refs.links) ? refs.links.filter(function (row) { return row && typeof row.url === "string"; }) : [];
			// 每个会话按「它自己最近碰的时间」挑前 perSession 个
			var bySession = {};
			files.forEach(function (file) {
				Object.keys(file.sessions).forEach(function (sid) {
					if (onCanvas[sid] !== true) return;
					(bySession[sid] || (bySession[sid] = [])).push({ file: file, at: file.sessions[sid] && typeof file.sessions[sid].at === "number" ? file.sessions[sid].at : 0 });
				});
			});
			var shown = {};
			var folded = {};
			Object.keys(bySession).forEach(function (sid) {
				var list = bySession[sid].sort(function (a, b) { return b.at - a.at; });
				list.forEach(function (row, index) {
					if (index < perSession) shown[row.file.key] = row.file;
					else folded[sid] = (folded[sid] || 0) + 1;
				});
			});
			function markOf(stat) {
				if (!stat) return "";
				if (stat.write > 0) return "write";
				if (stat.ref > 0) return "ref";
				return stat.read > 0 ? "read" : "";
			}
			var nodes = [];
			var edges = [];
			var y = startY;
			Object.keys(shown).map(function (key) { return shown[key]; }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).forEach(function (file) {
				var path = typeof file.path === "string" && file.path !== "" ? file.path : file.key;
				var slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
				var id = "file:" + file.key;
				nodes.push({ id: id, kind: "file", title: slash >= 0 ? path.slice(slash + 1) : path, sub: slash >= 0 ? path.slice(0, slash) : "", path: path, sessions: file.sessions, x: 24, y: y, w: 220, h: 96 });
				// 行距按真实卡高（卡头 + 名 + 路径约 96px）：按 72 排会两两叠（真机 2026-11-17 求交抓到）
				y += 108;
				Object.keys(file.sessions).forEach(function (sid) {
					var mark = markOf(file.sessions[sid]);
					if (onCanvas[sid] !== true || mark === "") return;
					edges.push({ a: id, b: sid, reason: "file-" + mark });
				});
			});
			Object.keys(folded).sort().forEach(function (sid) {
				var id = "file:+" + sid;
				nodes.push({ id: id, kind: "file", fold: true, title: "+" + folded[sid], sub: "", path: "", count: folded[sid], x: 24, y: y, w: 220, h: 72 });
				y += 84;
				edges.push({ a: id, b: sid, reason: "file-read" });
			});
			links.slice(0, maxLinks).forEach(function (link) {
				var id = "link:" + link.url;
				var label = link.url.replace(/^https?:\/\//, "");
				nodes.push({ id: id, kind: "link", linkKind: link.kind === "notion" || link.kind === "feishu" ? link.kind : "web", title: label.length > 30 ? label.slice(0, 30) + "…" : label, sub: "", url: link.url, x: 24, y: y, w: 220, h: 96 });
				y += 108;
				(Array.isArray(link.sessions) ? link.sessions : []).forEach(function (sid) {
					if (onCanvas[sid] === true) edges.push({ a: id, b: sid, reason: "file-ref" });
				});
			});
			return { nodes: nodes, edges: edges };
		}

		/**
		 * 流程图元素（波次 5）→ 按 flowId 分组：[{groupId, flowId, title, nodes, edges, aiCount}]。
		 * 元素来自宿主 canvas.json 的 elements（whales_flow_draw 写入 / 用户在画布上改）。纯函数。
		 */
		function wbFlowGroups(elements) {
			var list = Array.isArray(elements) ? elements : [];
			var groups = {};
			list.forEach(function (el) {
				if (!el || typeof el.id !== "string" || !el.data || typeof el.data.flowId !== "string") return;
				var flowId = el.data.flowId;
				var group = groups[flowId] || (groups[flowId] = { groupId: "flow:" + flowId, flowId: flowId, title: "", nodes: [], edges: [], aiCount: 0, group: null });
				if (el.kind === "group") { group.title = typeof el.data.title === "string" ? el.data.title : ""; group.group = el; return; }
				if (el.kind === "flow") {
					group.nodes.push(el);
					if (el.provenance && el.provenance.by === "agent" && el.userEdited !== true) group.aiCount += 1;
				} else if (el.kind === "edge") group.edges.push(el);
			});
			return Object.keys(groups).sort().map(function (key) { return groups[key]; });
		}

		/** 流程节点尺寸：起止胶囊 / 步骤圆角矩形 / 判断菱形（外接正方形）。 */
		function wbFlowNodeSize(shape) {
			if (shape === "decision") return { w: 132, h: 132 };
			if (shape === "start" || shape === "end") return { w: 150, h: 44 };
			return { w: 170, h: 52 };
		}

		/**
		 * 一张流程图的版式：缺坐标的节点用 dagre（自上而下）排，人拖过的（x/y 有值）保持。
		 * layout(nodes, edges, opts) 由 React Flow chunk 提供；拿不到就按顺序竖排。返回 {pos: {id:{x,y}}, w, h}。
		 */
		function wbFlowLayout(group, layout) {
			var sized = group.nodes.map(function (el) {
				var size = wbFlowNodeSize(el.data.shape);
				return { id: el.id, w: size.w, h: size.h, x: el.x, y: el.y };
			});
			var auto = {};
			if (typeof layout === "function") {
				try {
					auto = layout(sized, group.edges.map(function (edge) { return { source: edge.data.source, target: edge.data.target }; }), { rankdir: "TB", nodesep: 36, ranksep: 48 });
				} catch (error) { auto = {}; }
			}
			var pos = {};
			var maxX = 0;
			var maxY = 0;
			sized.forEach(function (node, index) {
				var fixed = typeof node.x === "number" && typeof node.y === "number";
				var p = fixed ? { x: node.x, y: node.y } : (auto[node.id] || { x: 24, y: 24 + index * 80 });
				// 组框内留出 40px 标题栏
				pos[node.id] = { x: Math.max(8, p.x), y: Math.max(44, fixed ? p.y : p.y + 24) };
				maxX = Math.max(maxX, pos[node.id].x + node.w);
				maxY = Math.max(maxY, pos[node.id].y + node.h);
			});
			// 标题栏要放下「标题 + AI 计数 + ＋步骤 + 撤销」，太窄会挤成两行（真机 2026-11-17）
			return { pos: pos, w: Math.max(380, maxX + 24), h: Math.max(140, maxY + 24) };
		}

		function WbCanvasPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var projectSnap = useWb("/projects/" + encodeURIComponent(projectId));
			var tasksSnap = useWb("/tasks?projectId=" + encodeURIComponent(projectId));
			var sessionsSnap = useWb("/sessions");
			var project = projectSnap.data && projectSnap.data.project ? projectSnap.data.project : null;
			// 需求卡上显示负责人名：必须在经典画布的卡被构造之前就算好（var 提升：晚定义会拿到 undefined）。
			var reqOwnerNames = wbMemberNames(project, sessionsSnap.data);
			var tasks = tasksSnap.data && Array.isArray(tasksSnap.data.tasks) ? tasksSnap.data.tasks : [];
			var sessionRows = wbSessionRows(sessionsSnap.data && sessionsSnap.data.sessions ? { byId: indexById(sessionsSnap.data.sessions) } : undefined);
			var pickState = react.useState(null);
			var picked = pickState[0];
			var setPicked = pickState[1];
			react.useEffect(function () {
				if (props.focus) setPicked(props.focus.elementId);
			}, [props.focus]);
			var addState = react.useState(false);
			// 同上：元组解构后再用。漏解构时 setAddState 未声明（点击即抛 ReferenceError）、
			// 「adding === true」也永远不成立（弹窗打不开）。
			var adding = addState[0];
			var setAdding = addState[1];
			// Composer 轻量版的草稿（Q1）：只在画布内暂存，点「放入输入框」才进官方输入框
			var composerDraftState = react.useState("");
			// 空态引导的「新建任务」：画布内弹窗，不切页签（切页签就是离开画布）
			var createOpenState = react.useState(false);
			var setCreateOpen = createOpenState[1];
			var composerDraft = composerDraftState[0];
			var setComposerDraft = composerDraftState[1];
			// 加人 / 建约束时的「哪个正在飞」。此前只有 busyState[0]/[1] 的用法、没有声明——
			// 点「加入」或「删除节点」立刻抛 ReferenceError（初始渲染走不到那些分支所以没炸）。
			var busyState = react.useState("");
			var hintState = react.useState("");
			var hint = hintState[0];
			// 画布优先：持有主对话的会话引用，Composer 卡经 SessionProvider 真写入 / 直接提交。
			// 必须在早返回之前调用（hook 顺序）。
			var mainRef = useRetainedSession(props.retainSession,
				projectSnap.data && projectSnap.data.project && typeof projectSnap.data.project.mainSessionId === "string"
					? projectSnap.data.project.mainSessionId : "");
			// 重新规划 R2：经典画布已删除，新画布（React Flow，按需 chunk）是唯一的画布。
			var flowState = react.useSyncExternalStore(wbFlowLoader.subscribe, wbFlowLoader.get, wbFlowLoader.get);
			var connectModeState = react.useState("relay");
			var connectMode = connectModeState[0];
			var setConnectMode = connectModeState[1];
			var flowMode = flowState.status === "ready";
			react.useEffect(function () { wbFlowLoader.load(); }, []);
			// 子会话自动入项目的兜底（宿主 tools/result 触发漏掉时）：候选列表变了才请求一次。
			var adoptKey = wbAdoptCandidates(projectSnap.data && projectSnap.data.project ? projectSnap.data.project : null,
				sessionsSnap.data && Array.isArray(sessionsSnap.data.sessions) ? sessionsSnap.data.sessions : null).join("|");
			react.useEffect(function () {
				if (adoptKey === "") return;
				wbApi("/projects/" + encodeURIComponent(projectId) + "/adopt", { method: "POST", body: {} })
					.then(wbUnwrap)
					.then(function (data) {
						if (data && Array.isArray(data.adopted) && data.adopted.length > 0) {
							wbCache.invalidate("/projects/" + encodeURIComponent(projectId));
							wbCache.invalidate("/projects");
						}
					})
					.catch(function () { /* 兜底失败不打扰用户：宿主侧触发器仍在 */ });
			}, [projectId, adoptKey]);
			// 下面这些 hook 必须在「项目还没到」的早退之前：此前 canvasSnap 在早退之后，项目从 null 变成有值时
			// hook 数量会变（React「Rendered more hooks」），只是缓存命中时首帧就有项目才没暴露。
			var canvasSnap = useWb("/canvas?projectId=" + encodeURIComponent(projectId));
			// 波次 6：组件包列表（内置 shadcn + 本地导入）与原型预览 / 编辑器 chunk
			var packsSnap = useWb("/component-packs");
			// 需求卡：每个需求一张，排在画布最左列（需求主线 P3）。旧宿主没有该路由时 data 为空，不画。
			var reqCanvasSnap = useWb("/projects/" + encodeURIComponent(projectId) + "/requirements");
			var protoState = react.useSyncExternalStore(wbProtoLoader.subscribe, wbProtoLoader.get, wbProtoLoader.get);
			var puckState = react.useSyncExternalStore(wbPuckLoader.subscribe, wbPuckLoader.get, wbPuckLoader.get);
			var editingState = react.useState(null);
			var reqReviewState = react.useState(null);
			var reqStartTab = react.useState("design");
			var reviewCanvasFocus = react.useState(null);
			var inboxOpenState = react.useState(false);
			function openRequirement(reqId) {
				reqStartTab[1]("design");
				reqReviewState[1](reqId || "");
			}
			react.useEffect(function () {
				reviewCanvasFocus[1](null);
				if (props.focus && props.focus.reqId) {
					reqStartTab[1]("prd");
					reqReviewState[1](props.focus.reqId);
				}
			}, [props.focus]);
			var editingProto = editingState[0];
			var setEditingProto = editingState[1];
			function closeEditor() { setEditingProto(null); }
			var hasProtoElements = canvasSnap.data && Array.isArray(canvasSnap.data.elements)
				&& canvasSnap.data.elements.some(function (el) { return el && (el.kind === "prototype" || el.kind === "library"); });
			react.useEffect(function () {
				if (hasProtoElements) wbProtoLoader.load();
			}, [hasProtoElements]);
			// 组件工坊：有组件 / 画板元素时才拉 client.design.js（29KB，含沙箱宿主）
			var designState = react.useSyncExternalStore(wbDesignLoader.subscribe, wbDesignLoader.get, wbDesignLoader.get);
			// 在线画布登记（设计方案 §8.3）：让 agent 的 whales_design_write 能拿到真实渲染回报。
			// 只有 chunk 加载好、拿到 token 才挂；没有它时工具会如实回 unverified，不会假装渲染过。
			var designToken = wbToken();
			var designElements = canvasSnap.data && Array.isArray(canvasSnap.data.elements)
				? canvasSnap.data.elements.filter(function (el) { return el && (el.kind === "component" || el.kind === "artboard"); })
				: [];
			var protoPlan = wbProtoLayout(canvasSnap.data && Array.isArray(canvasSnap.data.elements) ? canvasSnap.data.elements : [], packsSnap.data && Array.isArray(packsSnap.data.packs) ? packsSnap.data.packs : []);
			var hasDesignElements = designElements.length > 0;
			react.useEffect(function () {
				if (hasDesignElements) wbDesignLoader.load();
			}, [hasDesignElements]);
			// show_view 卡片 + 侧聊。hook 必须在「项目还没到」的早退之前（见上面的注释）。
			// 卡按「属于这个项目的会话」取：卡画出来时会话可能还没入项目，所以不能只按 projectId 过滤。
			var viewSessionIds = [];
			if (project !== null && project !== undefined) {
				[project.mainSessionId].concat(Array.isArray(project.members) ? project.members.map(function (member) { return member && member.sessionId; }) : []).forEach(function (id) {
					if (typeof id === "string" && id !== "" && viewSessionIds.indexOf(id) < 0) viewSessionIds.push(id);
				});
			}
			var viewsUrl = viewSessionIds.length > 0 ? "/views?projectId=" + encodeURIComponent(projectId) + "&sessionIds=" + encodeURIComponent(viewSessionIds.join(",")) : "";
			var sideUrl = "/side?projectId=" + encodeURIComponent(projectId);
			var viewsSnap = useWb(viewsUrl);
			var sideSnap = useWb(sideUrl);
			var viewState = react.useSyncExternalStore(wbViewLoader.subscribe, wbViewLoader.get, wbViewLoader.get);
			var viewUiState = react.useState({});
			var viewUi = viewUiState[0];
			var setViewUi = viewUiState[1];
			var viewRows = viewsSnap.data && Array.isArray(viewsSnap.data.views) ? viewsSnap.data.views : [];
			var sideChats = sideSnap.data && Array.isArray(sideSnap.data.chats) ? sideSnap.data.chats : [];
			var hasViewNodes = viewRows.length > 0 || sideChats.length > 0;
			react.useEffect(function () {
				if (hasViewNodes) wbViewLoader.load();
			}, [hasViewNodes]);
			// 侧聊答题中：1.5s 一拉（默认 5s 轮询太慢），答完自动停。
			var sideAnswering = sideChats.some(function (chat) { return (chat.entries || []).some(function (entry) { return entry && entry.status === "answering"; }); });
			react.useEffect(function () {
				if (!sideAnswering) return undefined;
				var timer = setInterval(function () { wbCache.read(sideUrl).catch(function () { /* 下次再拉 */ }); }, 1500);
				return function () { clearInterval(timer); };
			}, [sideAnswering, sideUrl]);

			if (project === null) {
				return h(WbState, { loading: projectSnap.loading, error: projectSnap.error, onRetry: function () { wbCache.read("/projects/" + encodeURIComponent(projectId)); }, onExit: function () { wbRoute.set({ kind: "list" }); } });
			}
			var inboxSnap = useWb("/inbox?projectId=" + encodeURIComponent(projectId));
				var handoffsSnap = useWb("/handoffs?projectId=" + encodeURIComponent(projectId));
			// 约束层（§14 探针实测后落地）：MCP 服务节点 + 已建立的约束。
			// 与 canvas/inbox/handoffs 同一批拉，画布一次渲染拿全，不在这里发额外请求。
			var mcpSnap = useWb("/projects/" + encodeURIComponent(projectId) + "/mcp-links");
			// 波次 4：文件 / 外部引用（宿主从会话日志、report 产物、用户 @ / 链接派生）
			var refsSnap = useWb("/projects/" + encodeURIComponent(projectId) + "/references");
			var mcpAllowed = wbMcpAllowedBySession(mcpSnap.data);
			wbNodePositions.hydrate(projectId, canvasSnap.data);
			var nodes = wbCanvasNodes(project, tasks, sessionRows);
			// Composer 卡的真对话面（拿得到 SessionProvider + 会话引用时）；拿不到就退回 Q1 轻量版。
			var chatSlot = mainRef && typeof props.SessionProvider === "function" && typeof props.renderSlot === "function"
				? h(WbBoundary, { fallback: function () { return h("div", { className: "daw-wb-note" }, t("chat.unavailable")); } },
					h(props.SessionProvider, { session: mainRef },
						props.renderSlot("whales.canvas.session", { onOpenSession: props.onOpenSession, wbUseSessionStatus: props.useSessionStatus })))
				: null;
			// 波次 4：文件 / 外部引用节点，排在左列上下文节点下面
			var refSessionIds = nodes.filter(function (item) { return typeof item.sessionId === "string" && item.sessionId !== ""; }).map(function (item) { return item.sessionId; });
			var contextCount = nodes.filter(function (item) { return item.kind === "folder"; }).length;
			var refGraph = wbReferenceNodes(refsSnap.data, refSessionIds, { startY: 24 + contextCount * 118 });
			nodes = nodes.concat(refGraph.nodes);
			// 选中的是节点（不是连线「a|b」）时才检视；连线只有删除一个动作。
				// 选中连线时取出两端与中点，供连线检视卡定位。
			// 必须在 edges 算出来之后：var 提升会让 edges 在这上面变成 undefined，
			// 一点选中连线就抛 "Cannot read properties of undefined (reading 'filter')"
			// （初始挂载 picked 为 null 走不到这里，所以这个序错从没被冒烟测到）。
			nodes.forEach(function (node) {
				var saved = wbNodePositions.get(projectId, node.id);
				if (saved !== undefined) { node.x = saved.x; node.y = saved.y; }
			});
			// 连线两类：project.links（会话↔会话，无向关联）与 mcpLinks（MCP→会话，约束）。
			// 后者存储形状不同，先适配成 {a,b} 再进同一个 wbCanvasEdges——渲染与命中判定只留一套。
			// 依赖连线：blockedBy 派生（OMH 的 「Waits on N lanes」）。只在两端都有 owner 时才画。
			var depLinks = wbDepLinks(tasks).map(function (edge) {
				return { a: edge.a, b: edge.b, reason: "blocked", label: t("canvas.link.reason.blocked", { task: edge.waitTaskId }) };
			});
			var links = (Array.isArray(project.links) ? project.links : []).concat(depLinks).concat(refGraph.edges);
			var edges = wbCanvasEdges(nodes, links);
			var pickedLink = null;
			if (picked !== null && picked.indexOf("|") >= 0) {
				var parts = picked.split("|");
				pickedLink = {
					a: parts[0], b: parts[1],
					// 新画布没有经典舞台的坐标系：连线检视卡固定在画布上方中间
					midX: 360,
					midY: 96
				};
			}
			var pickedNode = picked === null || picked.indexOf("|") >= 0
				? null
				: (nodes.filter(function (item) { return item.id === picked; })[0] || null);
			var goal = project.brief && typeof project.brief.goal === "string" ? project.brief.goal : "";
			/**
			 * 元素表写入（波次 5：流程图的拖动 / 改字 / 加步骤 / 连线 / 撤销 / 删除共用）。
			 * 带 rev（CAS）；40902 时重读一次再试——位置表拖拽也在涨 rev，撞上很正常。
			 */
			function writeElements(change, attempt) {
				var tries = typeof attempt === "number" ? attempt : 0;
				var rev = canvasSnap.data && typeof canvasSnap.data.rev === "number" ? canvasSnap.data.rev : 0;
				var url = "/canvas?projectId=" + encodeURIComponent(projectId);
				function send(expected) {
					return wbApi("/canvas/elements", { method: "POST", body: { projectId: projectId, expectedRevision: expected, upsert: change.upsert || [], remove: change.remove || [] } });
				}
				return send(rev).then(function (payload) {
					if (payload && payload.code === 40902 && tries < 1) {
						var latest = payload.data && typeof payload.data.currentRevision === "number" ? payload.data.currentRevision : rev;
						return send(latest);
					}
					return payload;
				}).then(function (payload) {
					wbCache.invalidate(url);
					if (payload && payload.code !== 200) hintState[1](t("canvas.flow.fail", { reason: payload.msg || ("code " + payload.code) }));
					return payload;
				}).catch(function (error) { hintState[1](t("canvas.flow.fail", { reason: error && error.message ? error.message : String(error) })); });
			}
			function elementById(id) {
				var list = canvasSnap.data && Array.isArray(canvasSnap.data.elements) ? canvasSnap.data.elements : [];
				return list.filter(function (el) { return el && el.id === id; })[0] || null;
			}
			function moveFlowElement(id, x, y) {
				var el = elementById(id);
				if (el === null) return;
				writeElements({ upsert: [Object.assign({}, el, { x: x, y: y })] });
			}
			/** 改一个流程节点的文字（内联编辑提交时调用；不再弹 window.prompt）。 */
			function commitFlowStepText(el, next) {
				var text = String(next || "").trim();
				if (text === "" || text === (el.data.text || "")) return;
				writeElements({ upsert: [Object.assign({}, el, { data: Object.assign({}, el.data, { text: text.slice(0, 120) }) })] });
			}
			function addFlowStep(group, laid) {
				var key = "u" + Date.now().toString(36).slice(-6);
				writeElements({ upsert: [{ id: group.groupId + ":" + key, kind: "flow", parentId: group.groupId, x: 24, y: Math.max(48, laid.h - 8), data: { flowId: group.flowId, key: key, shape: "step", text: t("canvas.flow.newStep") } }] });
			}
			function connectFlowSteps(fromId, toId) {
				var from = elementById(fromId);
				var to = elementById(toId);
				if (!from || !to || from.kind !== "flow" || to.kind !== "flow" || from.data.flowId !== to.data.flowId || fromId === toId) { hintState[1](t("canvas.flow.connectDeny")); return; }
				var label = typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt(t("canvas.flow.label"), "") : "";
				var groupId = "flow:" + from.data.flowId;
				writeElements({ upsert: [{ id: groupId + ":e:" + from.data.key + ">" + to.data.key, kind: "edge", parentId: groupId, data: { flowId: from.data.flowId, source: fromId, target: toId, fromKey: from.data.key, toKey: to.data.key, label: typeof label === "string" ? label.trim().slice(0, 12) : "" } }] });
			}
			/** 一键撤销 AI 生成：删掉这张图里 AI 画的、人没改过的节点与连线；什么都不剩就连分组一起删。 */
			function undoFlowGroup(group) {
				var ai = group.nodes.filter(function (el) { return el.provenance && el.provenance.by === "agent" && el.userEdited !== true; }).map(function (el) { return el.id; });
				var aiEdges = group.edges.filter(function (el) { return el.provenance && el.provenance.by === "agent" && el.userEdited !== true; }).map(function (el) { return el.id; });
				var remaining = group.nodes.length - ai.length;
				writeElements({ remove: ai.concat(aiEdges).concat(remaining === 0 ? [group.groupId] : []) });
			}
			/** 组件库节点换包（D-6：换节点 = 换组件；所有原型帧跟着换实现）。 */
			function switchPack(library, packId) {
				if (!library || typeof packId !== "string" || packId === "") return;
				writeElements({ upsert: [Object.assign({}, library, { data: Object.assign({}, library.data, { packId: packId }) })] });
			}
			/** 工具条：放一个组件库节点（已有就不重复放）/ 放一张空白原型帧。 */
			function addLibraryNode() {
				var exists = (canvasSnap.data && Array.isArray(canvasSnap.data.elements) ? canvasSnap.data.elements : []).some(function (el) { return el && el.kind === "library"; });
				if (exists) { hintState[1](t("canvas.library.exists")); return; }
				writeElements({ upsert: [{ id: "library:main", kind: "library", data: { packId: "shadcn" } }] });
			}
			function addBlankPrototype() {
				var key = "p" + Date.now().toString(36).slice(-6);
				writeElements({ upsert: [{ id: "proto:" + key, kind: "prototype", data: { prototypeId: key, title: t("canvas.proto.blank"), width: "desktop", puck: { content: [{ type: "Heading", props: { id: "Heading-1", text: t("canvas.proto.blank"), level: "2" } }], root: { props: {} } } } }] });
			}
			// ── show_view 卡片 / 侧聊的动作（宿主路由见 lib/view-host.js；写操作带 x-whales-token，由 wbApi 负责）──
			function viewCall(path, options) {
				return wbApi(path, options).then(wbUnwrap);
			}
			function patchViewUi(id, patch) {
				setViewUi(function (before) {
					var next = Object.assign({}, before);
					next[id] = Object.assign({}, before[id] || {}, patch);
					return next;
				});
			}
			function answerViewCard(id, action, values) {
				patchViewUi(id, { busy: true, error: "" });
				viewCall("/views/" + encodeURIComponent(id) + "/answer", { method: "POST", body: { action: action, values: values } })
					.then(function () { patchViewUi(id, { busy: false, error: "" }); wbCache.invalidate("/views"); })
					.catch(function (error) { patchViewUi(id, { busy: false, error: t("canvas.view.answerfail", { reason: error && error.message ? error.message : String(error) }) }); });
			}
			function dismissViewCard(id) {
				patchViewUi(id, { busy: true, error: "" });
				viewCall("/views/" + encodeURIComponent(id) + "/dismiss", { method: "POST", body: {} })
					.then(function () { patchViewUi(id, { busy: false }); wbCache.invalidate("/views"); })
					.catch(function (error) { patchViewUi(id, { busy: false, error: t("canvas.view.answerfail", { reason: error && error.message ? error.message : String(error) }) }); });
			}
			function addSideChat() {
				wbViewLoader.load();
				viewCall("/side", { method: "POST", body: { projectId: projectId, title: t("canvas.side.title"), sources: [] } })
					.then(function () { wbCache.invalidate("/side"); })
					.catch(function (error) { hintState[1](t("canvas.side.linkfail", { reason: error && error.message ? error.message : String(error) })); });
			}
			function setSideSources(chat, sources) {
				return viewCall("/side/" + encodeURIComponent(chat.id) + "/sources", { method: "PUT", body: { sources: sources } })
					.then(function () { wbCache.invalidate("/side"); hintState[1](""); })
					.catch(function (error) { hintState[1](t("canvas.side.linkfail", { reason: error && error.message ? error.message : String(error) })); });
			}
			/** 侧聊的线：任一端是侧聊节点，另一端必须是对话卡（有 sessionId）。返回 true = 已处理（不再走 connectNodes）。 */
			function connectSideChat(fromId, toId) {
				var fromSide = fromId.indexOf("side:") === 0;
				var toSide = toId.indexOf("side:") === 0;
				if (!fromSide && !toSide) return false;
				if (fromSide && toSide) { hintState[1](t("canvas.side.deny")); return true; }
				var chatId = (fromSide ? fromId : toId).slice(5);
				var otherId = fromSide ? toId : fromId;
				var other = nodes.filter(function (item) { return item.id === otherId; })[0] || null;
				var chat = sideChats.filter(function (item) { return item.id === chatId; })[0] || null;
				if (other === null || chat === null || typeof other.sessionId !== "string" || other.sessionId === "") { hintState[1](t("canvas.side.deny")); return true; }
				if ((chat.sources || []).indexOf(other.sessionId) >= 0) return true;
				setSideSources(chat, (chat.sources || []).concat([other.sessionId]));
				return true;
			}
			function removeSideEdge(pickId) {
				var body = pickId.slice("sideedge:".length).split("~");
				var chat = sideChats.filter(function (item) { return item.id === body[0]; })[0] || null;
				if (chat === null) return;
				setSideSources(chat, (chat.sources || []).filter(function (id) { return id !== body[1]; })).then(function () { setPicked(null); });
			}
			function askSide(chat, text) {
				return viewCall("/side/" + encodeURIComponent(chat.id) + "/ask", { method: "POST", body: { text: text } })
					.then(function () { return wbCache.read(sideUrl); })
					.catch(function (error) { hintState[1](t("canvas.side.linkfail", { reason: error && error.message ? error.message : String(error) })); throw error; });
			}
			function cancelSide(chat, entryId) {
				viewCall("/side/" + encodeURIComponent(chat.id) + "/cancel", { method: "POST", body: { entryId: entryId } })
					.then(function () { wbCache.invalidate("/side"); })
					.catch(function () { /* 已经答完 / 已取消：下一次轮询会刷新 */ });
			}
			function removeSide(chat) {
				viewCall("/side/" + encodeURIComponent(chat.id), { method: "DELETE" })
					.then(function () { wbCache.invalidate("/side"); setPicked(null); })
					.catch(function (error) { hintState[1](t("canvas.side.linkfail", { reason: error && error.message ? error.message : String(error) })); });
			}
			/** 删除选中的流程节点 / 流程线（工具条「删除」）。 */
			function removeFlowElement(id) {
				var elId = id.indexOf("el:") === 0 ? id.slice(3) : id;
				var target = elementById(elId);
				// 删分组 = 删整张图（不留没有框的孤儿步骤）
				var ids = target && target.kind === "group"
					? (canvasSnap.data.elements || []).filter(function (el) { return el && el.data && el.data.flowId === target.data.flowId; }).map(function (el) { return el.id; })
					: [elId];
				writeElements({ remove: ids }).then(function () { setPicked(null); });
			}

			/**
			 * 建线（经典舞台拖锚点 / 新画布 onConnect 共用）。
			 * mode：relay = 允许互发（虚线，project.links）；dependency = 依赖（实线，落库 blockedBy）。
			 * 一端是 MCP 节点时不论 mode 都是「约束」，走 /mcp-links。
			 */
			function connectNodes(fromId, toId, mode) {
				var target = nodes.filter(function (item) { return item.id === toId; })[0] || null;
				var source = nodes.filter(function (item) { return item.id === fromId; })[0] || null;
				if (target === null || source === null || fromId === toId) { hintState[1](t("canvas.link.deny")); return; }
				if (mode === "dependency") {
					// 依赖（实线）：两端都得是会话节点；落库为任务 blockedBy，成环 / 没有任务由宿主拒并给人话。
					if (typeof source.sessionId !== "string" || typeof target.sessionId !== "string") { hintState[1](t("canvas.dep.deny")); return; }
					wbApi("/projects/" + encodeURIComponent(projectId) + "/dependencies", { method: "POST", body: { from: source.sessionId, to: target.sessionId, action: "add" } })
						.then(wbUnwrap)
						.then(function (data) {
							wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId));
							hintState[1](data && Array.isArray(data.changed) && data.changed.length > 0 ? t("canvas.dep.added", { count: data.changed.length }) : t("canvas.dep.same"));
						})
						.catch(function (error) { hintState[1](t("canvas.dep.fail", { reason: error && error.message ? error.message : String(error) })); });
					return;
				}
				// 只看真正的互发线：依赖线 / 约束线同一对端点不算「已连过」
				var exists = (Array.isArray(project.links) ? project.links : []).some(function (link) {
					return (link.a === fromId && link.b === toId) || (link.b === fromId && link.a === toId);
				});
				if (exists) { hintState[1](t("canvas.link.deny")); return; }
				wbApi("/projects/" + encodeURIComponent(projectId) + "/links", { method: "POST", body: { a: fromId, b: toId } })
					.then(function () { wbCache.invalidate("/projects/" + encodeURIComponent(projectId)); hintState[1](""); })
					.catch(function (error) { hintState[1](error.message); });
			}

			function removeLink(link) {
				// 依赖线（新画布选中时 picked 是 "dep:<上游>|<下游>"）：走 /dependencies remove，去掉 blockedBy。
				if (typeof link.a === "string" && link.a.indexOf("dep:") === 0) {
					wbApi("/projects/" + encodeURIComponent(projectId) + "/dependencies", { method: "POST", body: { from: link.a.slice(4), to: link.b, action: "remove" } })
						.then(wbUnwrap)
						.then(function () { wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); setPicked(null); })
						.catch(function (error) { hintState[1](t("canvas.dep.fail", { reason: error && error.message ? error.message : String(error) })); });
					return;
				}
				wbApi("/projects/" + encodeURIComponent(projectId) + "/links", { method: "DELETE", body: { a: link.a, b: link.b } })
					.then(function () { wbCache.invalidate("/projects/" + encodeURIComponent(projectId)); setPicked(null); })
					.catch(function (error) { hintState[1](error.message); });
			}

				// A1：画布上增派 Agent。此前空态文案写着「或先加一个 Agent」却没有入口——
				// 用户在照做时发现无路可走。宿主路由 POST /projects/:id/members 一直都有，
				// 差的只是画布侧的一个落点。占位节点排在最后一个 Agent 正下方，和节点流对齐。
				var addableSessions = wbAddableSessions(sessionRows, project);
				function addMember(sessionId) {
					return wbApi("/projects/" + encodeURIComponent(projectId) + "/members", { method: "POST", body: { sessionId: sessionId } })
						.then(function () {
							wbCache.invalidate("/projects/" + encodeURIComponent(projectId));
							wbCache.invalidate("/inbox?projectId=" + encodeURIComponent(projectId));
							setAdding(false);
						}, function (error) { hintState[1](error.message); });
				}
			// 波次 3：经典舞台的各块元素在构建时顺手留引用，新画布（React Flow）原样复用，不写第二套节点 UI。
			// 波次 D：离线成员「唤醒」。只把会话拉上线——不派任务、不批量；宿主范围闸只认本项目成员，
			// 失败原因（宿主 msg）如实显示在提示条里，不静默。
			var wakeAgent = function (node) {
				busyState[1]("wake:" + node.sessionId);
				hintState[1]("");
				wbApi("/projects/" + encodeURIComponent(projectId) + "/resume", { method: "POST", body: { sessionId: node.sessionId } })
					.then(wbUnwrap)
					.then(function (data) {
						wbCache.invalidate("/sessions");
						if (data && data.live === false) throw new Error(t("canvas.agent.wake.notlive"));
						hintState[1](t(data && data.resumed === false ? "canvas.agent.wake.already" : "canvas.agent.wake.ok", { name: node.title }));
					})
					.catch(function (error) { hintState[1](t("canvas.agent.wake.fail", { reason: error && error.message ? error.message : String(error) })); })
					.then(function () { busyState[1](""); });
			};
			var nodeEl = function (node) {
							return h("div", {
								key: node.id,
								className: "daw-wb-node",
								"data-kind": node.kind,
								"data-selected": String(picked === node.id),
								style: { left: node.x + "px", top: node.y + "px", width: node.w + "px", minHeight: node.h + "px" },
								"data-link-kind": node.kind === "link" ? node.linkKind : undefined,
								title: node.kind === "file" ? (node.fold ? t("canvas.file.fold", { count: node.count }) : node.path) : node.kind === "link" ? node.url : undefined,
								onDoubleClick: node.sessionId ? function () { if (typeof props.onOpenSession === "function") props.onOpenSession(node.sessionId); }
									: node.kind === "link" && typeof node.url === "string" ? function () { try { window.open(node.url, "_blank", "noopener"); } catch (error) { /* 弹窗被拦就算了 */ } }
									: undefined
							},
								h("div", { className: "daw-wb-node-head" },
								h("span", { className: "daw-wb-node-tag" }, node.kind === "composer" ? "✦" : node.kind === "agent" ? "⚙" : node.kind === "file" ? "📄" : node.kind === "link" ? "🔗" : "dir"),
								h("span", null, node.kind === "composer" ? t("canvas.node.composer") : node.kind === "agent" ? (node.offline === true ? h(WbBtn, { variant: "small", disabled: busyState[0] !== "", title: t("canvas.agent.wake.title"), onClick: function (event) { if (event && typeof event.stopPropagation === "function") event.stopPropagation(); wakeAgent(node); } }, t("canvas.agent.wake")) : t("canvas.node.agent")) : node.kind === "file" ? t("canvas.node.file") : node.kind === "link" ? t("canvas.node.link." + (node.linkKind || "web")) : t("canvas.node.folder")),
								h("span", { className: "daw-wb-node-fill" }),
								node.kind === "agent"
								? h(WbChip, { tone: wbAgentChip(node.task, node.online).tone, dot: true, title: wbAgentChip(node.task, node.online).key === "done" ? t("canvas.agent.chip.done.title") : undefined }, t("canvas.agent.chip." + wbAgentChip(node.task, node.online).key))
								: null),
								h("div", { className: "daw-wb-node-name" }, node.kind === "file" && node.fold ? t("canvas.file.fold", { count: node.count }) : node.title),
								node.sub ? h("div", { className: "daw-wb-node-sub" }, node.sub) : null,
								// Composer 轻量版（Q1）：卡内输入框 + 「放入输入框」。只绑主对话；
								// 不做 /命令、不切模型（无数据源就不显示，不编）；写入走官方 insertText，
								// 被拒降级剪贴板，再不行让用户手动复制——绝不自动提交。
								node.kind === "composer" && chatSlot !== null
								? chatSlot
								: node.kind === "composer"
								? h("div", { className: "daw-wb-composer" },
									h("textarea", {
										className: "daw-wb-composer-input",
										rows: 3,
										value: composerDraft,
										placeholder: t("composer.placeholder"),
										onChange: function (event) { setComposerDraft(event.target.value); }
									}),
									h("div", { className: "daw-wb-composer-row" },
										h("span", { className: "daw-wb-note" }, wbHasInputActions(props.inputActions)
										? (wbComposerPrefix(node.task, t) !== "" ? t("composer.prefix.note") : t("composer.prefix.none"))
										: t("composer.degrade")),
										h("span", { className: "daw-wb-node-fill" }),
										h(WbBtn, {
											variant: "small",
											disabled: composerDraft.trim() === "",
											title: t("composer.put.title"),
											onClick: function () {
												var body = wbComposerPrefix(node.task, t) + composerDraft;
												wbInsertDraft(body, props.inputActions).then(function (result) {
													hintState[1](t("composer.put." + result.state));
													if (result.state === "inserted") setComposerDraft("");
												});
											}
										}, t("composer.put"))),
									typeof props.onOpenSession === "function" && node.sessionId
										? h(WbBtn, { variant: "ghost", onClick: function () { props.onOpenSession(node.sessionId); } }, t("chat.openFull"))
										: null)
								: null,
								node.kind === "agent"
								? h("div", { className: "daw-wb-node-row" },
								h("span", { className: "daw-wb-node-tag" }, "⚙"),
								h("span", null, t("exec.ticket.where", { worktree: node.worktree || node.execRoot || t("common.none") })))
								: null,
								// 约束可见性：Agent 卡上直接写出被允许的 MCP，不用去连线上数。
								// 没有约束的会话不渲染这一行——「不在表里」是默认全放行，不是「允许一切」。
								node.kind === "agent" && mcpAllowed[node.sessionId]
								? h("div", { className: "daw-wb-node-row" },
								h("span", { className: "daw-wb-node-tag" }, "⌘"),
								h("span", null, t("canvas.mcp.allowed", { servers: mcpAllowed[node.sessionId].join(" · ") })))
								: null,
								// 生长进度：等宽六段（T-13 六步）。卡高按 kind 固定 148——
								// 锚点由 node.h 算，内容增减不能让它变高（CDS 同款决策）。
								node.kind === "agent"
								? h("div", {
									className: "daw-wb-growth",
									role: "img",
									"aria-label": wbGrowthLabel(wbAgentSteps(node.task), t),
									title: wbGrowthLabel(wbAgentSteps(node.task), t)
								},
									wbAgentSteps(node.task).map(function (step, index) {
										return h("span", { key: index, className: "daw-wb-growth-seg", "data-state": step.state });
									}))
								: null
								);
					};
			var emptyGuideEl = tasks.length === 0
				? h("div", { className: "daw-wb-node", "data-kind": "guide", style: { left: 430, top: 576, width: 320, cursor: "default" } },
					h("div", { className: "daw-wb-node-name" }, t("canvas.empty")),
					h("div", { className: "daw-wb-toolbar" },
						h(WbBtn, { variant: "small", onClick: function () { setCreateOpen(true); } }, t("tasks.new")),
						h(WbBtn, {
							variant: "ghost",
							title: t("canvas.empty.put.title"),
							onClick: function () {
								wbInsertDraft(goal !== "" ? goal : t("canvas.goal.none"), props.inputActions).then(function (result) {
									hintState[1](t("composer.put." + result.state));
								});
							}
						}, t("canvas.empty.put"))))
				: null;
			var addModalEl = adding === true
					? h(WbModal, {
						t: t, title: t("canvas.addAgent.modal"), canvasAnchored: true, onClose: function () { setAdding(false); },
						children: addableSessions.length === 0
							? h("div", { className: "daw-wb-note" }, t("canvas.addAgent.none"))
							: h("div", { className: "daw-wb-group" }, addableSessions.map(function (row) {
								return h("div", { key: row.sessionId, className: "daw-wb-todo" },
									h("div", { className: "daw-wb-todo-body" },
										h("div", { className: "daw-wb-todo-text" }, row.title),
										h("div", { className: "daw-wb-todo-src" }, row.running ? "" : t("list.join.archived"))),
									h(WbBtn, {
										variant: "small", disabled: busyState[0] !== "",
										onClick: function () {
											busyState[1](row.sessionId);
											addMember(row.sessionId).then(function () { busyState[1](""); }, function () { busyState[1](""); });
										}
									}, t("canvas.addAgent.ok")));
							})),
						actions: null
					})
					: null;
			var linkInspectEl = pickedLink !== null
					? (function () {
						var linkRows = wbLinkHandoffs(handoffsSnap.data && handoffsSnap.data.entries, pickedLink.a, pickedLink.b);
						var titleA = pickedLink.a;
						var titleB = pickedLink.b;
						nodes.forEach(function (item) {
							if (item.id === pickedLink.a) titleA = item.title || titleA;
							if (item.id === pickedLink.b) titleB = item.title || titleB;
						});
						return h("div", {
							className: "daw-wb-inspect",
							style: { position: "absolute", left: pickedLink.midX, top: pickedLink.midY + 14, width: 380, zIndex: 5 }
						},
							h("div", { className: "daw-wb-inspect-head" },
								h("span", { className: "daw-wb-inspect-kind" }, t("inspect.kind.link")),
								h("span", { className: "daw-wb-inspect-title" }, titleA + " ↔ " + titleB),
								h("span", { className: "daw-wb-toolfill" }),
								h(WbBtn, { variant: "ghost", onClick: function () { setPicked(null); } }, t("common.close"))),
							h("div", { className: "daw-wb-inspect-body" },
								linkRows.length === 0
									? h("div", { className: "daw-wb-inspect-note" }, t("canvas.link.empty"))
									: h("div", { className: "daw-wb-inspect-tasks" }, linkRows.slice(0, 12).map(function (row, index) {
										return h("div", { key: index, className: "daw-wb-inspect-task" },
											h("span", { className: "daw-wb-inspect-task-subject" }, row.from === "user" ? t("canvas.link.fromUser") : row.from),
											h("span", { className: "daw-wb-inspect-task-where" }, "→ " + row.to),
											h("span", { className: "daw-wb-inspect-toolcount" }, row.at > 0 ? wbFormatClock(row.at) : ""));
										}))),
							h("div", { className: "daw-wb-inspect-done" }, t("canvas.link.count", { count: linkRows.length })));
						})()
					: null;
			// 波次 3：新画布（React Flow，按需 chunk）。拿不到（旧宿主 / 离线垫片 / 加载失败）就用经典舞台。
			// 波次 5：流程图分组 + 流程节点 + 流程线（元素表），排在 Agent 列右侧。
			var flowGroups = wbFlowGroups(canvasSnap.data && Array.isArray(canvasSnap.data.elements) ? canvasSnap.data.elements : []);
			var flowExtraItems = [];
			var flowExtraEdges = [];
			var reqCanvas = wbRequirementCanvasItems(wbRequirementRows(reqCanvasSnap.data), function (id) { return wbNodePositions.get(projectId, id); });
			var canvasElements = canvasSnap.data && Array.isArray(canvasSnap.data.elements) ? canvasSnap.data.elements : [];
			protoPlan = wbProtoLayout(canvasElements, packsSnap.data && Array.isArray(packsSnap.data.packs) ? packsSnap.data.packs : [], { x: 1540, y: 24 });
			// 需求分组框（设计稿 §7 ②）：每个需求一带——需求卡 + 它名下的原型帧 / 流程图分组框排成一行，外面画一圈虚线框。
			// 只有新画布（要用 dagre 量流程图的尺寸）才分带；没拖过的成员默认排到自己需求卡的左边，拖过的保持原位，框跟着真实位置走。
			var bandPlan = { cards: {}, members: {}, frames: [] };
			var flowLaid = {};
			if (flowMode && flowState.lib) {
				var bandMembers = [];
				protoPlan.prototypes.forEach(function (row) {
					var protoFixed = typeof row.el.x === "number" && typeof row.el.y === "number";
					bandMembers.push({ id: row.el.id, reqId: wbElementRequirementId(row.el), w: 440, h: row.el.data && row.el.data.width === "mobile" ? 560 : 440, fixed: protoFixed, x: row.x, y: row.y });
				});
				flowGroups.forEach(function (group) {
					var laidFor = wbFlowLayout(group, flowState.lib.layoutWithDagre);
					flowLaid[group.groupId] = laidFor;
					var groupFixed = !!(group.group && typeof group.group.x === "number" && typeof group.group.y === "number");
					bandMembers.push({ id: group.groupId, reqId: group.group ? wbElementRequirementId(group.group) : "", w: laidFor.w, h: laidFor.h, fixed: groupFixed, x: groupFixed ? group.group.x : 0, y: groupFixed ? group.group.y : 0 });
				});
				bandPlan = wbRequirementBands(reqCanvas.items, bandMembers);
				reqCanvas.items.forEach(function (item) { var placed = bandPlan.cards[item.id]; if (placed) { item.x = placed.x; item.y = placed.y; } });
				protoPlan.prototypes.forEach(function (row) { var placed = bandPlan.members[row.el.id]; if (placed) { row.x = placed.x; row.y = placed.y; } });
			}
			var reqRowById = {};
			reqCanvas.items.forEach(function (item) { reqRowById[item.row.reqId] = item.row; });
			var frameItems = bandPlan.frames.map(function (frame) {
				var frameRow = reqRowById[frame.reqId] || {};
				return {
					id: frame.id, kind: "reqframe", x: frame.x, y: frame.y, w: frame.w,
					frameOf: frame.members,
					rf: {
						type: "whaleReqFrame", position: { x: frame.x, y: frame.y },
						draggable: false, selectable: false, focusable: false, zIndex: -1,
						style: { width: frame.w, height: frame.h, pointerEvents: "none" },
						data: {
							title: frameRow.title || "", stage: frameRow.stage || "", attention: frameRow.attention || "", w: frame.w, h: frame.h,
							stageLabel: frameRow.stage ? t("req.stage." + frameRow.stage) : "", attentionLabel: frameRow.attention ? t("req.attention." + frameRow.attention) : ""
						}
					}
				};
			});
			if (flowMode && flowState.lib) {
				reqCanvas.items.forEach(function (item) {
					flowExtraItems.push({ id: item.id, kind: "requirement", x: item.x, y: item.y, w: item.w, el: wbRequirementCard(item.row, t, function () { openRequirement(item.row.reqId); }, undefined, reqOwnerNames[item.row.ownerSessionId] || "") });
				});
				var groupY = 24;
				flowGroups.forEach(function (group) {
					var laid = flowLaid[group.groupId] || wbFlowLayout(group, flowState.lib.layoutWithDagre);
					var bandedPos = bandPlan.members[group.groupId];
					var groupPos = bandedPos ? bandedPos : (group.group && typeof group.group.x === "number" && typeof group.group.y === "number" ? { x: group.group.x, y: group.group.y } : { x: 1080, y: groupY });
					if (!bandedPos) groupY = groupPos.y + laid.h + 32;
					flowExtraItems.push({
						id: group.groupId, kind: "flowgroup", x: groupPos.x, y: groupPos.y, w: laid.w,
						rf: {
							type: "whaleFlowGroup",
							position: groupPos,
							dragHandle: ".daw-wb-flowgroup-head",
							style: { width: laid.w, height: laid.h },
							data: {
								title: group.title, w: laid.w, h: laid.h, aiCount: group.aiCount,
								aiLabel: t("canvas.flow.ai", { count: group.aiCount }),
								addLabel: t("canvas.flow.add"), undoLabel: t("canvas.flow.undo"),
								onAdd: function () { addFlowStep(group, laid); },
								onUndo: function () { undoFlowGroup(group); }
							}
						}
					});
					group.nodes.forEach(function (el) {
						var ai = el.provenance && el.provenance.by === "agent" && el.userEdited !== true;
						var refs = el.provenance && Array.isArray(el.provenance.sourceMessageIds) ? el.provenance.sourceMessageIds : [];
						flowExtraItems.push({
							id: el.id, kind: "flowstep", x: 0, y: 0, w: wbFlowNodeSize(el.data.shape).w,
							rf: {
								type: "whaleFlowStep",
								parentId: group.groupId,
								extent: "parent",
								position: laid.pos[el.id] || { x: 24, y: 48 },
								data: {
									shape: el.data.shape, text: el.data.text, ai: ai,
									evidence: refs.length > 0 ? t("canvas.flow.evidence", { refs: refs.join(", ") }) : "",
									// 内联编辑提交：双击节点就地改字，回车/失焦落盘
							onCommit: function (next) { commitFlowStepText(el, next); }
								}
							}
						});
					});
					group.edges.forEach(function (edge) {
						flowExtraEdges.push({
							id: edge.id,
							source: edge.data.source,
							target: edge.data.target,
							sourceHandle: "s-b",
							targetHandle: "t-t",
							type: "smoothstep",
							className: "daw-wb-edge-flow",
							label: edge.data.label || undefined,
							markerEnd: { type: "arrowclosed", width: 14, height: 14 },
							style: { strokeWidth: 1.8 },
							data: { kind: "flow", pick: "el:" + edge.id }
						});
					});
				});
			}
			// 波次 6：原型帧 + 组件库节点（排在流程图右侧）；连线 = 「这些原型用这个组件库」，只读
			var protoLabels = {
				edit: t("canvas.proto.edit"), loading: t("canvas.proto.loading"), packFailed: t("canvas.proto.packFailed"),
				title: t("canvas.library.title"), coverage: t("canvas.library.coverage"), missing: t("canvas.library.missing"),
				local: t("canvas.library.local"), importHint: t("canvas.library.import"), usedBy: t("canvas.library.usedBy"), close: t("common.close")
			};
			if (flowMode && protoState.status === "ready") {
				if (protoPlan.library) {
					flowExtraItems.push({
						id: protoPlan.library.id, kind: "library", x: protoPlan.libraryPos.x, y: protoPlan.libraryPos.y, w: 260,
						rf: {
							type: "whaleLibrary",
							position: protoPlan.libraryPos,
							dragHandle: ".daw-proto-head",
							data: {
								packMeta: protoPlan.packMeta,
								packs: packsSnap.data && Array.isArray(packsSnap.data.packs) ? packsSnap.data.packs : [protoPlan.packMeta],
								dir: packsSnap.data && packsSnap.data.dir ? packsSnap.data.dir : "",
								usedBy: protoPlan.prototypes.length,
								labels: protoLabels,
								onSwitch: function (packId) { switchPack(protoPlan.library, packId); }
							}
						}
					});
				}
				protoPlan.prototypes.forEach(function (row) {
					var el = row.el;
					flowExtraItems.push({
						id: el.id, kind: "prototype", x: row.x, y: row.y, w: 440,
						rf: {
							type: "whaleProto",
							position: { x: row.x, y: row.y },
							dragHandle: ".daw-proto-head",
							data: {
								title: el.data.title, width: el.data.width, puck: el.data.puck, packMeta: protoPlan.packMeta,
								ai: el.provenance && el.provenance.by === "agent" && el.userEdited !== true,
								labels: protoLabels,
								onEdit: function () { wbPuckLoader.load(); setEditingProto(el.id); }
							}
						}
					});
				});
				protoPlan.edges.forEach(function (edge) {
					flowExtraEdges.push({ id: "lib:" + edge.target, source: edge.source, target: edge.target, className: "daw-wb-edge-library", selectable: false, style: { strokeWidth: 1.2, strokeDasharray: "1 5" }, data: { kind: "library", pick: null } });
				});
			}
			// 组件工坊（设计方案 §9.1）：组件放项目级「组件区」（左上固定一列），画板放它自己的需求带里。
			// 位置仍以位置表为准（人拖过的优先），没摆过的给一个稳定的默认位置。
			var designLabels = {
				component: t("canvas.design.component") || "组件",
				artboard: t("canvas.design.artboard") || "画板",
				ai: t("canvas.design.ai") || "AI",
				usedBy: t("canvas.design.usedBy") || "被用",
				example: t("canvas.design.example") || "例子",
				edit: t("canvas.design.edit") || "编辑",
				annotate: t("canvas.design.annotate") || "标注",
				editDirect: t("canvas.design.editDirect") || "直接改"
			};
			if (flowMode && designState.status === "ready" && designElements.length > 0) {
				var componentRowY = 24;
				var artboardRowY = 24;
				designElements.forEach(function (el) {
					var data = el.data && typeof el.data === "object" ? el.data : {};
					var isComponent = el.kind === "component";
					var row = wbNodePositions.get(projectId, el.id) || el;
					var defaultX = isComponent ? -560 : 40;
					var defaultY = isComponent ? componentRowY : artboardRowY;
					if (isComponent) componentRowY += 380;
					else artboardRowY += 320;
					var x = row && Number.isFinite(row.x) ? row.x : defaultX;
					var y = row && Number.isFinite(row.y) ? row.y : defaultY;
					flowExtraItems.push({
						id: el.id,
						kind: el.kind,
						x: x,
						y: y,
						w: isComponent ? 420 : 460,
						rf: {
							type: isComponent ? "whaleDesignComponent" : "whaleDesignArtboard",
							position: { x: x, y: y },
							dragHandle: "[data-design-head]",
							data: {
								original: data,
								projectId: projectId,
								token: wbToken(),
								ai: el.provenance && el.provenance.by === "agent" && el.userEdited !== true,
								labels: designLabels,
								onEdit: function () { if (typeof wbDesignLoader.get().lib.openSourceEditor === "function") wbDesignLoader.get().lib.openSourceEditor(Object.assign({}, el, { projectId: projectId, token: wbToken() })); },
								onDesignChanged: function () {
									wbCache.invalidate("/canvas?projectId=" + encodeURIComponent(projectId));
									wbCache.invalidate("/projects/" + encodeURIComponent(projectId) + "/requirements");
								}
							}
						}
					});
				});
				// 画板之间的跳转关系画成虚线（方案 §9.1：links 画成虚线）
				designElements.forEach(function (el) {
					if (el.kind !== "artboard") return;
					var links = el.data && Array.isArray(el.data.links) ? el.data.links : [];
					links.forEach(function (targetId) {
						var to = "board:" + targetId;
						flowExtraEdges.push({ id: "design-link:" + el.id + ">" + to, source: el.id, target: to, className: "daw-wb-edge-library", selectable: false, style: { strokeWidth: 1.2, strokeDasharray: "6 4" }, data: { kind: "artboard-link", pick: null } });
					});
				});
			}
			// show_view 卡片 + 侧聊（client.view.js）。位置：用户拖过的以位置表为准；默认——
			// 来自 Composer 的卡片贴在 Composer 正下方「伸出来」，其余（Agent 产出的卡、侧聊）排在画布底部一行。
			var viewExtraLegend = [];
			if (flowMode && viewState.status === "ready") {
				var sessionNodeById = {};
				var viewBottom = 24;
				nodes.forEach(function (item) {
					if (typeof item.sessionId === "string" && item.sessionId !== "") sessionNodeById[item.sessionId] = item;
					viewBottom = Math.max(viewBottom, (item.y || 0) + (item.h || 200));
				});
				var rowIndex = 0;
				var nextRowPos = function () { var pos = { x: 24 + rowIndex * 380, y: viewBottom + 60 }; rowIndex += 1; return pos; };
				var viewLabels = {
					title: t("canvas.side.title"), readonly: t("canvas.side.readonly"), noSource: t("canvas.side.noSource"), empty: t("canvas.side.empty"),
					thinking: t("canvas.side.thinking"), cancel: t("canvas.side.cancel"), cancelled: t("canvas.side.cancelled"), failed: t("canvas.side.failed"),
					placeholder: t("canvas.side.placeholder"), send: t("canvas.side.send"), remove: t("canvas.side.remove"), untitled: t("canvas.view.untitled")
				};
				sideChats.forEach(function (chat) {
					var id = "side:" + chat.id;
					var saved = wbNodePositions.get(projectId, id);
					var pos = saved ? { x: saved.x, y: saved.y } : nextRowPos();
					var sources = (chat.sources || []).map(function (sessionId) {
						var node = sessionNodeById[sessionId];
						return { id: sessionId, title: node ? node.title : "" };
					});
					flowExtraItems.push({
						id: id, kind: "side", x: pos.x, y: pos.y, w: 340,
						rf: {
							type: "whaleSide", position: pos, dragHandle: ".daw-side-head",
							data: {
								title: chat.title, sources: sources, entries: chat.entries || [], labels: viewLabels,
								onAsk: function (text) { return askSide(chat, text); },
								onCancel: function (entryId) { cancelSide(chat, entryId); },
								onRemove: function () { removeSide(chat); }
							}
						}
					});
					(chat.sources || []).forEach(function (sessionId) {
						var node = sessionNodeById[sessionId];
						if (!node) return;
						// 线从对话卡出发、汇到侧聊：读的方向 = 背景流向
						flowExtraEdges.push({
							id: "sideedge:" + chat.id + "~" + sessionId, source: node.id, target: id, sourceHandle: "s-b", targetHandle: "t-t",
							type: "smoothstep", className: "daw-wb-edge-side", style: { strokeWidth: 1.6, strokeDasharray: "10 5" },
							markerEnd: { type: "arrowclosed", width: 12, height: 12 }, data: { kind: "side", pick: "sideedge:" + chat.id + "~" + sessionId }
						});
					});
					if (viewExtraLegend.indexOf("side") < 0) viewExtraLegend.push("side");
				});
				var perComposer = {};
				viewRows.forEach(function (row) {
					var src = sessionNodeById[row.sessionId];
					if (!src) return; // 产出它的对话不在本项目画布上：不画，也不报错
					var id = "view:" + row.id;
					var saved = wbNodePositions.get(projectId, id);
					var pos;
					if (saved) pos = { x: saved.x, y: saved.y };
					else if (src.kind === "composer") {
						var slot = perComposer[src.id] = (perComposer[src.id] || 0) + 1;
						// Composer 的声明高度（330）低于真对话面实际渲染高度（聊天区会撑高），留 120 才不贴边、关联线才看得见。
						pos = { x: (src.x || 0) + (slot - 1) * 380, y: (src.y || 0) + (src.h || 200) + 120 };
					} else pos = nextRowPos();
					var ui = viewUi[row.id] || {};
					flowExtraItems.push({
						id: id, kind: "view", x: pos.x, y: pos.y, w: 360,
						rf: {
							type: "whaleView", position: pos, dragHandle: ".daw-view-head",
							data: {
								id: row.id, title: row.title, view: row.view, status: row.status, answer: row.answer, source: src.title,
								busy: ui.busy === true, error: ui.error || "", labels: viewLabels,
								onAnswer: function (action, values) { answerViewCard(row.id, action, values); },
								onDismiss: function () { dismissViewCard(row.id); }
							}
						}
					});
					flowExtraEdges.push({
						id: "viewedge:" + row.id, source: src.id, target: id, sourceHandle: "s-b", targetHandle: "t-t",
						type: "smoothstep", className: "daw-wb-edge-view", selectable: false, style: { strokeWidth: 1.4, strokeDasharray: "1 4" },
						data: { kind: "view", pick: null }
					});
					if (viewExtraLegend.indexOf("view") < 0) viewExtraLegend.push("view");
				});
			}
			// 组件工坊（设计方案 §10）：Puck 积木栏要看到本项目的组件，得把它们的编译产物一起拿到。
			// 只在「有项目组件」时拉；渲染时每个组件是一个沙箱岛（不直接执行）。
			var projectComponents = {};
			if (hasDesignElements && designState.status === "ready") {
				designElements.forEach(function (el) {
					if (!el || el.kind !== "component") return;
					var name = el.data && el.data.name ? el.data.name : "";
					if (name === "") return;
					projectComponents[name] = {
						title: (el.data && el.data.title) || name,
						propsSchema: (el.data && el.data.propsSchema) || {},
						compiled: "",
						dependencies: []
					};
				});
			}
			var designEntitiesSnap = useWb(hasDesignElements ? "/design/entities?projectId=" + encodeURIComponent(projectId) : "");
			var designEntities = designEntitiesSnap && designEntitiesSnap.data && Array.isArray(designEntitiesSnap.data.entities) ? designEntitiesSnap.data.entities : [];
			designEntities.forEach(function (row) {
				if (!row || typeof row.name !== "string") return;
				if (projectComponents[row.name] === undefined) return;
				projectComponents[row.name].compiled = row.compiled || "";
				projectComponents[row.name].dependencies = Array.isArray(row.dependencies) ? row.dependencies : [];
				if (Array.isArray(row.examples) && row.examples.length > 0) projectComponents[row.name].examples = row.examples;
			});
			var editingEl = editingProto !== null ? (canvasElements.filter(function (el) { return el && el.id === editingProto; })[0] || null) : null;
			var editorEl = editingEl !== null && protoState.status === "ready"
				? (puckState.status === "ready"
					? h(protoState.lib.PrototypeEditor, {
						Puck: puckState.lib.Puck,
						title: editingEl.data.title,
						packMeta: protoPlan.packMeta,
						projectComponents: Object.keys(projectComponents).length > 0 ? projectComponents : undefined,
						data: editingEl.data.puck,
						labels: protoLabels,
						onClose: closeEditor,
						onSave: function (next) {
							writeElements({ upsert: [Object.assign({}, editingEl, { data: Object.assign({}, editingEl.data, { puck: next }) })] }).then(function (payload) {
								if (payload && payload.code === 200) setEditingProto(null);
							});
						}
					})
					: h("div", { className: "daw-wb-banner", "data-tone": puckState.status === "failed" ? "danger" : "ok" },
						puckState.status === "failed" ? t("canvas.proto.editorFailed", { reason: puckState.error }) : t("canvas.proto.editorLoading")))
				: null;
			var reqReviewRows = wbRequirementRows(reqCanvasSnap.data);
			var reqReviewId = reqReviewState[0];
			var reqReviewRow = reqReviewRows.filter(function (row) { return row.reqId === reqReviewId; })[0] || null;
			var reqModalEl = reqReviewId === null ? null : h(WbReviewDialog, {
				t: t,
				title: reqReviewId === "" ? t("req.title") : (reqReviewRow ? reqReviewRow.title : t("req.title")),
				onBack: reqReviewId ? function () { openRequirement(""); } : null,
				onClose: function () { reqReviewState[1](null); }
			}, reqReviewId === ""
				? h("div", { className: "daw-wb-review-list daw-wb-design-grid" }, reqReviewRows.filter(function (row) { return !row.virtual; }).map(function (row) {
					return h("button", { key: row.reqId, type: "button", className: "daw-wb-card", "data-req-id": row.reqId, onClick: function () { openRequirement(row.reqId); } },
						h("div", { className: "daw-wb-card-head" }, h("b", null, row.title), row.attention ? h("span", { className: "daw-wb-req-attn" }, t("req.attention." + row.attention)) : null),
						h("div", { className: "daw-wb-note" }, row.next));
				}))
				: h(WbRequirementCanvasPanel, {
					key: reqReviewId + ":" + reqStartTab[0], t: t, projectId: projectId, reqId: reqReviewId, initialTab: reqStartTab[0], onOpenSession: props.onOpenSession,
					onOpenElement: function (id) {
						reqReviewState[1](null);
						setPicked(id);
						reviewCanvasFocus[1]({ elementId: id });
					}
				}));
			var inboxModalEl = inboxOpenState[0] ? h(WbCanvasInboxModal, { t: t, projectId: projectId, onClose: function () { inboxOpenState[1](false); }, onOpen: function (item) {
				inboxOpenState[1](false);
				if (item && item.reqId) openRequirement(item.reqId);
				else if (item && item.kind === "task") { if (typeof props.onNavigate === "function") props.onNavigate({ kind: "workbench", projectId: projectId, tab: "table" }); else wbRoute.project(projectId, "table"); }
			} }) : null;
			var flowStage = flowMode && flowState.lib
				? h(WbFlowStage, {
					t: t,
					lib: flowState.lib,
					protoLib: protoState.status === "ready" ? protoState.lib : null,
					viewLib: viewState.status === "ready" ? viewState.lib : null,
					designLib: designState.status === "ready" ? designState.lib : null,
					extraLegend: viewExtraLegend,
					gridOn: true,
					picked: picked,
					focus: reviewCanvasFocus[0] || props.focus,
					items: frameItems.concat(wbFlowItems({
						nodes: nodes,
						nodeEl: nodeEl,
						emptyGuideEl: emptyGuideEl
					})).concat(flowExtraItems),
					edges: wbFlowEdges(edges, nodes, tasks, t).concat(flowExtraEdges),
					connectMode: connectMode,
					onConnectMode: setConnectMode,
					onConnect: function (fromId, toId) {
						if (fromId.indexOf("flow:") === 0 && toId.indexOf("flow:") === 0) { connectFlowSteps(fromId, toId); return; }
						if (connectSideChat(fromId, toId)) return;
						connectNodes(fromId, toId, connectMode);
					},
					onPick: function (id) { setPicked(id); },
					onMove: function (id, x, y) {
						if (id.indexOf("flow:") === 0 || id.indexOf("proto:") === 0 || id.indexOf("library:") === 0) { moveFlowElement(id, x, y); return; }
						wbNodePositions.set(projectId, id, x, y);
					},
					overlays: [linkInspectEl, editorEl]
				})
				: null;
			return h("div", { className: "daw-wb-canvaswrap" },
				designState.status === "ready" && designToken !== "" ? h(WbDesignLiveBridge, { lib: designState.lib, projectId: projectId, token: designToken, packId: protoPlan.packMeta && protoPlan.packMeta.id }) : null,
				// 新画布是唯一的画布。宿主不支持按需加载 / 加载失败时给一块明确的说明（需求页、任务页等其余页签不受影响），不再退回第二套画布。
				flowStage !== null ? flowStage : h("div", { className: "daw-wb-canvas-fallback", "data-state": flowState.status },
					h("div", { className: "daw-wb-empty-title" }, flowState.status === "loading" || flowState.status === "idle" ? t("canvas.fallback.loading") : flowState.status === "failed" ? t("canvas.fallback.failed", { reason: flowState.error || "" }) : t("canvas.fallback.unavailable")),
					flowState.status === "failed" ? h("div", { className: "daw-wb-toolbar" }, h(WbBtn, { variant: "ghost", onClick: function () { wbFlowLoader.retry(); } }, t("canvas.fallback.retry"))) : null),
				reqModalEl,
				inboxModalEl,
				addModalEl,
				h("div", { className: "daw-wb-toolbar", "aria-label": t("tab.note.canvas") },
					// 只放操作按钮；说明文字留在页签提示里，避免窄画布上互相覆盖。
					// 需求与待办都在画布内打开，不再去独立需求页/左侧菜单。
					h(WbBtn, { variant: "ghost", onClick: function () { inboxOpenState[1](true); } }, t("nav.inbox")),
					h(WbBtn, { variant: "ghost", title: reqCanvas.hidden > 0 ? t("canvas.req.more", { n: reqCanvas.hidden }) : t("canvas.req.title"), onClick: function () { openRequirement(""); } },
						reqCanvas.items.length === 0 ? t("canvas.req.new") : t("canvas.req.open", { n: wbRequirementSummary(wbRequirementRows(reqCanvasSnap.data)).attention })),
					h(WbBtn, { variant: "ghost", onClick: function () { setAdding(true); } }, t("canvas.addAgent")),
					picked !== null && (picked.indexOf("flow:") === 0 || picked.indexOf("el:") === 0 || picked.indexOf("proto:") === 0 || picked.indexOf("library:") === 0)
						? h(WbBtn, { variant: "danger", onClick: function () { removeFlowElement(picked); } }, t("canvas.delete.title"))
						: null,
					flowMode && protoState.status !== "unavailable"
						? h(WbBtn, { variant: "ghost", onClick: function () { wbProtoLoader.load(); addBlankPrototype(); } }, t("canvas.proto.add"))
						: null,
					flowMode && viewState.status !== "unavailable"
						? h(WbBtn, { variant: "ghost", onClick: addSideChat }, t("canvas.side.add"))
						: null,
					picked !== null && picked.indexOf("sideedge:") === 0
						? h(WbBtn, { variant: "danger", onClick: function () { removeSideEdge(picked); } }, t("canvas.side.unlink"))
						: null,
					flowMode && protoState.status !== "unavailable"
						? h(WbBtn, { variant: "ghost", onClick: function () { wbProtoLoader.load(); addLibraryNode(); } }, t("canvas.library.add"))
						: null,
					picked !== null && picked.indexOf("|") >= 0
						? h(WbBtn, {
							variant: "danger",
							onClick: function () {
								var parts = picked.split("|");
								removeLink({ a: parts[0], b: parts[1] });
							}
						}, t("canvas.delete.title"))
						: null,
					picked !== null && picked.indexOf("|") < 0 && picked !== (project.mainSessionId || "main") && nodes.some(function (item) { return item.id === picked && typeof item.sessionId === "string"; })
						? h(WbBtn, {
							variant: "danger",
							onClick: function () {
								var node = nodes.filter(function (item) { return item.id === picked; })[0];
								if (node && typeof node.sessionId === "string" && typeof props.onRemoveMember === "function") props.onRemoveMember(node.sessionId, node.title, tasks);
							}
						}, t("canvas.delete.title"))
						: null),
				hint !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "warn" }, hint) : null,
				// 节点检视（A/C 方向）：选中节点后把「它在干什么」摊开，不用切到任务板/待办页签。
				pickedNode !== null
					? h(WbNodeInspector, {
						t: t,
						data: wbNodeInspector(pickedNode, { tasks: tasks, sessions: sessionRows, project: project, inbox: inboxSnap.data }),
					projectId: projectId,
					// B1：画布上直接派发。走宿主既有命令路由，CAS 冲突由宿主拒，这里只把原因显示出来。
					onDispatch: function (taskId, revision) {
						return wbTaskCommand(projectId, taskId, "dispatch", { expectedRevision: revision }).then(function () {
							wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId));
							wbCache.invalidate("/projects/" + encodeURIComponent(projectId));
							wbCache.invalidate("/inbox?projectId=" + encodeURIComponent(projectId));
						}, function (error) { hintState[1](error.message); });
					},
						onClose: function () { setPicked(null); }
					})
					: null,
				// 提案卡浮在画布右上角：画布全屏化后它曾被 .daw-wb-stage 盖住、「确认」点不到
				// （2026-11-17 真机 Tabbit 抓到：stage intercepts pointer events）。
				h("div", { className: "daw-wb-floatpanel" },
					h(WbProposalCard, { t: t, projectId: projectId, leadSessionId: project.mainSessionId, collapsible: true })),
				// 空态引导的「新建任务」：画布内弹窗（与任务页同一个件，不另做一套）。
				// rows 用 tasks（原始任务行）——本页面没有 views（那是任务页/执行台的映射数组），
				// 2026-11-16 真机实测：传 views 会 ReferenceError 把整个 main 槽位崩掉。
				createOpenState[0] === true
					? h(WbCreateTaskModal, {
						t: t,
						canvasAnchored: true,
						rows: tasks,
						onClose: function () { setCreateOpen(false); },
						onCreate: function (input) {
							wbCreateTask(projectId, input).then(function () {
								wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId));
								wbCache.invalidate("/inbox");
								setCreateOpen(false);
							}).catch(function (failure) { hintState[1](failure.message); });
						}
					})
					: null);
		}

		// ── 画布优先（PRD v2.2 九（续二），2026-11-17）：直接在画布里和主对话说话 ──────
		//
		// 宿主契约（2026-11-17 源码核实，dsh-client-ui-renderer scoped-slots.tsx）：slot 条目
		// 声明了 session 作用域的子槽后，渲染器会下发 `SessionProvider` 与 `renderSlot`；
		// `SessionProvider session={reference}` 显式绑定任意会话（reference 来自
		// `ctx.sessions.retain`），子槽组件就拿到该会话的 `inputActions` / `useSession` /
		// `useInput`。官方右侧栏的子 agent 对话就是这么挂的（ui-subagent sidebar-chat）。
		// 于是插件全屏画布里的 Composer 卡也能真写入、由用户点击直接提交——不再降级剪贴板。
		// 边界（禁止清单第 1 条）：只有用户点了才提交；唯一的「代点」是首条消息——那是
		// 用户在「从画布开始」里亲手点的发送，会话建好后补交这一次，取走即删。

		/** 首条消息暂存：sessionId → 文本。取走即删，同一句话只会提交一次。 */
		var wbPendingFirst = {};

		function wbTakePending(sessionId) {
			var key = typeof sessionId === "string" ? sessionId : "";
			if (key === "" || !Object.prototype.hasOwnProperty.call(wbPendingFirst, key)) return "";
			var text = wbPendingFirst[key];
			delete wbPendingFirst[key];
			return typeof text === "string" ? text : "";
		}

		/** 项目名默认取用户第一句话的首行（压空白、最多 24 字），之后可改。 */
		function wbProjectNameFrom(text) {
			var lines = String(text === undefined || text === null ? "" : text).split(/\r?\n/);
			for (var i = 0; i < lines.length; i += 1) {
				var flat = lines[i].replace(/\s+/g, " ").trim();
				if (flat !== "") return flat.length > 24 ? flat.slice(0, 24) + "…" : flat;
			}
			return "未命名项目";
		}

		/** 工作区快照 → [{id, name}]；形状不认识就给空数组（下拉不显示，走宿主默认）。 */
		function wbWorkspaceItems(snapshot) {
			var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
			var out = [];
			items.forEach(function (item) {
				if (!item || typeof item !== "object") return;
				var rawId = item.workspaceId !== undefined && item.workspaceId !== null ? item.workspaceId : item.id;
				var id = rawId !== undefined && rawId !== null ? String(rawId) : "";
				if (id === "") return;
				// 宿主 WorkspaceView 是 {workspaceId, path, title}（2026-11-17 真机发现：此前按 {id,name} 认，下拉一直是空的）
				var name = typeof item.title === "string" && item.title !== "" ? item.title
					: typeof item.name === "string" && item.name !== "" ? item.name
					: typeof item.label === "string" && item.label !== "" ? item.label
					: typeof item.path === "string" && item.path !== "" ? item.path
					: Array.isArray(item.roots) && typeof item.roots[0] === "string" ? item.roots[0] : id;
				out.push({ id: id, name: name });
			});
			return out;
		}

		/** 回复记录 → 最近一轮：最后一条用户消息 + 它之后的最后一条回复（还没回就 null）。 */
		function wbLastExchange(rows) {
			var list = Array.isArray(rows) ? rows : [];
			var userIndex = -1;
			for (var i = list.length - 1; i >= 0; i -= 1) {
				if (list[i] && list[i].role === "user") { userIndex = i; break; }
			}
			var reply = null;
			for (var j = list.length - 1; j > userIndex; j -= 1) {
				if (list[j] && list[j].role === "assistant" && typeof list[j].text === "string") { reply = list[j].text; break; }
			}
			return {
				user: userIndex >= 0 && typeof list[userIndex].text === "string" ? list[userIndex].text : null,
				reply: reply
			};
		}

		/**
		 * 持有一个会话引用（retain → 卸载 / 换会话时 release）。拿不到就回 null，调用方降级。
		 * retain 必须是稳定引用（apply 里定义一次，经 inject 下发），否则每次渲染都重 retain。
		 */
		function useRetainedSession(retain, sessionId) {
			var refState = react.useState(null);
			var id = typeof sessionId === "string" ? sessionId : "";
			react.useEffect(function () {
				if (typeof retain !== "function" || id === "") { refState[1](null); return undefined; }
				var reference = null;
				try { reference = retain(id); } catch (error) { reference = null; }
				refState[1](reference);
				return function () {
					if (reference && typeof reference.release === "function") {
						try { reference.release(); } catch (error) { /* 已释放 / 宿主已卸载 */ }
					}
				};
			}, [retain, id]);
			return refState[0];
		}

		/**
		 * 错误边界：SessionProvider 在引用失效时会抛（"Session reference is not active"），
		 * 不能让它把整个工作台的 slot entry 带崩。真 React 走 class 路径；
		 * 离线垫片没有 Component、直接当函数调用，就退化成透传 children。
		 */
		var WbBoundary = (function () {
			function Boundary(props) {
				if (!(this instanceof Boundary)) return props ? props.children : null;
				if (typeof react.Component === "function") react.Component.call(this, props);
				this.props = props;
				this.state = { error: null };
			}
			if (typeof react.Component === "function") {
				Boundary.prototype = Object.create(react.Component.prototype);
				Boundary.prototype.constructor = Boundary;
				Boundary.getDerivedStateFromError = function (error) { return { error: error }; };
				Boundary.prototype.componentDidCatch = function (error) { reportSetupError("canvas session", error); };
				Boundary.prototype.render = function () {
					if (this.state && this.state.error) {
						return typeof this.props.fallback === "function" ? this.props.fallback(this.state.error) : null;
					}
					return this.props.children === undefined ? null : this.props.children;
				};
			}
			return Boundary;
		})();

		/**
		 * 提问 → 统一形状（宿主 PendingQuestion.questions 用 multiSelect；日志兜底也已折成 multiSelect，
		 * 模型原始参数的 multi_select 一并认）。坏项跳过；缺 id 用序号补（作答时原样带回）。
		 */
		function wbQuestionItems(list) {
			var out = [];
			(Array.isArray(list) ? list : []).forEach(function (raw, index) {
				if (!raw || typeof raw !== "object" || typeof raw.question !== "string") return;
				var options = [];
				(Array.isArray(raw.options) ? raw.options : []).forEach(function (option) {
					if (!option || typeof option.label !== "string" || option.label === "") return;
					options.push({ label: option.label, description: typeof option.description === "string" ? option.description : "" });
				});
				out.push({
					id: typeof raw.id === "string" && raw.id !== "" ? raw.id : "q" + index,
					question: raw.question,
					header: typeof raw.header === "string" ? raw.header : "",
					detail: typeof raw.detail === "string" ? raw.detail : "",
					multi: raw.multiSelect === true || raw.multi_select === true,
					options: options
				});
			});
			return out;
		}

		/**
		 * 草稿 → 回答批次，口径逐字对齐官方提问卡（dsh-client-ui-user-questions submitDrafts）：
		 * 自己写了答案时单选题只带 custom，多选题 selected 与 custom 并存。
		 * @returns {{missing: number, answer: {answers: object[]}}} missing 为第一道没答的题（-1 = 都答了）
		 */
		function wbQuestionAnswer(items, drafts) {
			var missing = -1;
			var answers = items.map(function (item, index) {
				var draft = drafts && drafts[index] ? drafts[index] : { selected: [], custom: "" };
				var selected = Array.isArray(draft.selected) ? draft.selected : [];
				var custom = typeof draft.custom === "string" ? draft.custom.trim() : "";
				if (selected.length === 0 && custom === "" && missing < 0) missing = index;
				var row = { id: item.id, selected: custom === "" || item.multi ? selected.slice() : [] };
				if (custom !== "") row.custom = custom;
				return row;
			});
			return { missing: missing, answer: { answers: answers } };
		}

		/**
		 * 画布 Composer 里的「主对话在问你」（真机反馈 2026-11-18：主对话用 ask_user_question 提问时，
		 * 问题只在官方对话页输入框位置出卡，画布上看不到它在问什么）。
		 *
		 * 两个来源：
		 *   - live：宿主 uiSession.sessionStatus 行上的 pendingInteraction（官方提问卡的同一个对象，
		 *     kind = question / plan-review）。作答走它自己的 answer()，与官方卡同一条回答通道；
		 *     哪个界面先答，另一个随宿主投影收起。
		 *   - logged：/sessions/:id/messages 从日志兜底出的 question（没有回答通道，只读 + 指路）。
		 * 边界：只有用户点「提交回答」才作答，插件不替用户选。
		 */
		function WbPendingQuestion(props) {
			var t = props.t;
			var live = props.live || null;
			var items = wbQuestionItems(live ? live.questions : props.logged ? props.logged.questions : []);
			var key = live && typeof live.key === "string" ? live.key : props.logged && props.logged.callId ? "logged:" + props.logged.callId : "logged";
			var draftState = react.useState({ key: "", drafts: [] });
			var busyState = react.useState(false);
			var errorState = react.useState("");
			var tickState = react.useState(0);
			var tickRef = react.useRef(0);
			var engagedRef = react.useRef("");

			// 宿主卡片状态（回答通道 / 倒计时）变了要重画：订阅它自己的 subscribe。
			react.useEffect(function () {
				if (!live || typeof live.subscribe !== "function") return undefined;
				var stop = live.subscribe(function () { tickRef.current += 1; tickState[1](tickRef.current); });
				return typeof stop === "function" ? stop : undefined;
			}, [live]);

			var snap = null;
			if (live && typeof live.snapshot === "function") {
				try { snap = live.snapshot(); } catch (error) { snap = null; }
			}
			var answerable = !!(live && typeof live.answer === "function" && snap && snap.channel !== "none" && snap.closed !== true && !live.review);
			var drafts = draftState[0].key === key ? draftState[0].drafts : [];
			var plan = live && live.kind === "plan-review";

			function engage() {
				// 第一次动手就停掉倒计时（官方卡「编辑后改为无限等待」同一口径）。
				if (!live || engagedRef.current === key || typeof live.engage !== "function") return;
				engagedRef.current = key;
				try { live.engage(); } catch (error) { /* 旧宿主没有 engage：倒计时照走 */ }
			}
			function update(index, change) {
				engage();
				var next = items.map(function (item, i) {
					var current = drafts[i] || { selected: [], custom: "" };
					return i === index ? change(current, item) : current;
				});
				draftState[1]({ key: key, drafts: next });
				errorState[1]("");
			}
			function choose(index, label) {
				update(index, function (current, item) {
					if (item.multi) {
						var has = current.selected.indexOf(label) >= 0;
						return { selected: has ? current.selected.filter(function (v) { return v !== label; }) : current.selected.concat([label]), custom: current.custom };
					}
					return { selected: [label], custom: "" };
				});
			}
			function write(index, value) {
				update(index, function (current, item) {
					return { selected: item.multi ? current.selected : [], custom: value };
				});
			}
			function submit() {
				if (!answerable || busyState[0]) return;
				var built = wbQuestionAnswer(items, drafts);
				if (built.missing >= 0) { errorState[1](t("chat.question.incomplete", { n: built.missing + 1 })); return; }
				var channel = snap ? snap.channel : "";
				busyState[1](true);
				errorState[1]("");
				var result;
				try { result = live.answer(built.answer); } catch (error) { result = Promise.reject(error); }
				Promise.resolve(result).then(function () {
					busyState[1](false);
					// 已继续（rpc）的问题宿主不会自己收卡，与官方卡一样答完收起。
					if (channel === "rpc" && typeof live.dismiss === "function") {
						try { Promise.resolve(live.dismiss()).catch(function () {}); } catch (error) { /* 收不起不影响回答已送达 */ }
					}
				}).catch(function (error) {
					busyState[1](false);
					errorState[1](t("chat.question.failed", { error: error && error.message ? error.message : String(error) }));
				});
			}

			if (items.length === 0) return null;
			var countdown = snap && snap.countdown && snap.countdown.running ? Math.max(0, Math.ceil((Number(snap.countdown.remainingMs) || 0) / 1000)) : null;
			return h("div", { className: "daw-wb-question", "data-question-key": key, "data-question-mode": answerable ? "live" : "readonly", role: "group", "aria-label": t(plan ? "chat.question.plan" : "chat.question.title") },
				h("div", { className: "daw-wb-chat-status" },
					h(WbChip, { tone: "warn", dot: true }, t(plan ? "chat.question.plan" : "chat.question.title"))),
				countdown !== null ? h("div", { className: "daw-wb-note" }, t("chat.question.countdown", { s: countdown })) : null,
				items.map(function (item, index) {
					var draft = drafts[index] || { selected: [], custom: "" };
					return h("div", { key: item.id + ":" + index, className: "daw-wb-question-item", "data-question-id": item.id },
						item.header !== "" || item.multi ? h("b", null, item.header + (item.header !== "" && item.multi ? " · " : "") + (item.multi ? t("chat.question.multi") : "")) : null,
						h("div", { className: "daw-wb-question-text" }, item.question),
						item.detail !== "" ? h("div", { className: "daw-wb-question-detail" }, item.detail.length > 600 ? item.detail.slice(0, 600) + "…" : item.detail) : null,
						item.options.map(function (option, optionIndex) {
							var selected = draft.selected.indexOf(option.label) >= 0;
							return h("button", {
								key: option.label + ":" + optionIndex,
								type: "button",
								className: "daw-wb-question-option",
								"data-selected": selected ? "true" : "false",
								"data-option": option.label,
								disabled: !answerable || busyState[0],
								title: option.description || undefined,
								onClick: function () { choose(index, option.label); }
							}, (item.multi ? (selected ? "☑ " : "☐ ") : (selected ? "● " : "○ ")) + option.label,
								option.description !== "" ? h("span", null, option.description) : null);
						}),
						answerable ? h("input", {
							className: "daw-wb-question-custom",
							type: "text",
							value: draft.custom,
							placeholder: t("chat.question.custom"),
							disabled: busyState[0],
							onChange: function (event) { write(index, event && event.target ? event.target.value : ""); },
							onKeyDown: function (event) {
								if (!event || event.key !== "Enter") return;
								var native = event.nativeEvent;
								if (event.isComposing || (native && native.isComposing)) return;
								if (typeof event.preventDefault === "function") event.preventDefault();
								submit();
							}
						}) : null);
				}),
				errorState[0] !== "" ? h("div", { className: "daw-wb-note", "data-tone": "danger" }, errorState[0]) : null,
				answerable
					? h("div", { className: "daw-wb-composer-row" },
						h("span", { className: "daw-wb-node-fill" }),
						h(WbBtn, { variant: "small", disabled: busyState[0], onClick: submit }, t(busyState[0] ? "chat.question.submitting" : "chat.question.submit")))
					: h("div", { className: "daw-wb-note" }, t("chat.question.readonly")));
		}

		/**
		 * 画布 Composer（session 作用域子槽 `whales.canvas.session` 的占用者）。
		 * 发送 = setDraft + submit（与官方输入框同一条提交链，同一个会话的同一份草稿）；
		 * 回复从宿主 `/sessions/:id/messages` 读（会话日志折叠，跑着时 2.5s 一拉）。
		 */
		function WbSessionComposer(props) {
			var t = wbT(props);
			var sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			var actions = props.inputActions;
			var canSend = !!(actions && typeof actions.setDraft === "function" && typeof actions.submit === "function");
			var running = typeof props.useSession === "function" ? props.useSession(function (s) { return !!(s && s.running); }) : false;
			var phase = typeof props.useInput === "function" ? props.useInput(function (s) { return s && typeof s.phase === "string" ? s.phase : "plain"; }) : "plain";
			var draftState = react.useState("");
			var rowsState = react.useState(null);
			var loggedState = react.useState(null);
			var errorState = react.useState("");
			var sentRef = react.useRef("");
			var busy = phase === "sending" || phase === "adjudicating" || phase === "submitting";
			// 这个会话此刻在等人回应什么（官方提问卡 / 审批的同一个对象）。状态表 hook 优先用槽的标准件，
			// 拿不到用画布页经 owner props 递下来的那份；选定后不变，hook 调用顺序稳定。
			var statusHook = typeof props.useSessionStatus === "function" ? props.useSessionStatus
				: typeof props.wbUseSessionStatus === "function" ? props.wbUseSessionStatus : null;
			var pending = statusHook ? statusHook(function (rows) { return pendingOf(rows, sessionId); }) : undefined;
			var liveQuestion = pending && (pending.kind === "question" || pending.kind === "plan-review") && Array.isArray(pending.questions) ? pending : null;
			var waitingApproval = !!(pending && pending.kind === "approval");

			function send(text) {
				var body = typeof text === "string" ? text.trim() : "";
				if (body === "" || !canSend) return false;
				try {
					actions.setDraft(body);
					actions.submit();
					return true;
				} catch (error) {
					errorState[1](error && error.message ? error.message : String(error));
					return false;
				}
			}

			// 首条消息：用户在「从画布开始」里点的那次发送，会话建好后补交（取走即删）。
			react.useEffect(function () {
				if (!canSend || sessionId === "" || sentRef.current === sessionId) return;
				var pending = wbTakePending(sessionId);
				if (pending === "") return;
				sentRef.current = sessionId;
				send(pending);
			}, [sessionId, canSend]);

			react.useEffect(function () {
				if (sessionId === "") return undefined;
				var alive = true;
				function load() {
					wbApi("/sessions/" + encodeURIComponent(sessionId) + "/messages?limit=8").then(wbUnwrap).then(function (data) {
						if (!alive) return;
						rowsState[1](data && Array.isArray(data.rows) ? data.rows : []);
						loggedState[1](data && data.question && Array.isArray(data.question.questions) ? data.question : null);
						errorState[1]("");
					}).catch(function (error) {
						if (alive) errorState[1](t("chat.load.failed", { error: error && error.message ? error.message : String(error) }));
					});
				}
				load();
				// 跑完那一刻 running 由真变假，effect 重跑 → 再拉一次拿到最终回复。
				var timer = running || busy ? setInterval(load, 2500) : null;
				return function () {
					alive = false;
					if (timer !== null) clearInterval(timer);
				};
			}, [sessionId, running, busy, !!pending]);

			function submitDraft() {
				if (busy) return;
				if (send(draftState[0])) draftState[1]("");
			}

			var rows = rowsState[0];
			var last = wbLastExchange(rows);
			var active = running || busy;
			var logged = liveQuestion === null ? loggedState[0] : null;
			var asking = liveQuestion !== null || logged !== null;
			var status = asking ? t("chat.question.status") : busy ? t("chat.sending") : running ? t("chat.running") : t("chat.idle");
			function stop(event) { if (event && typeof event.stopPropagation === "function") event.stopPropagation(); }
			return h("div", {
				className: "daw-wb-chat",
				"data-session": sessionId,
				// 卡内操作不能冒泡成「拖节点 / 双击进会话」
				onPointerDown: stop,
				onDoubleClick: stop
			},
				h("div", { className: "daw-wb-chat-status" },
					h(WbChip, { tone: active || asking || waitingApproval ? "warn" : "neutral", dot: true }, status)),
				rows === null ? null
					: last.user === null && last.reply === null ? h("div", { className: "daw-wb-note" }, t("chat.empty"))
					: h("div", { className: "daw-wb-chat-preview", "aria-live": "polite" },
						h("b", null, t(last.reply === null ? "chat.preview.question" : "chat.preview.reply")),
						h("p", null, last.reply === null ? last.user : last.reply)),
				errorState[0] !== "" ? h("div", { className: "daw-wb-note", "data-tone": "danger" }, errorState[0]) : null,
				asking ? h(WbPendingQuestion, { key: liveQuestion ? "live:" + liveQuestion.key : "logged", t: t, live: liveQuestion, logged: logged }) : null,
				waitingApproval ? h("div", { className: "daw-wb-note", "data-tone": "warn" }, t("chat.approval")) : null,
				canSend ? null : h("div", { className: "daw-wb-note" }, t("chat.unavailable")),
				h("textarea", {
					className: "daw-wb-composer-input",
					rows: 3,
					value: draftState[0],
					placeholder: t("chat.placeholder"),
					disabled: !canSend || busy,
					onChange: function (event) { draftState[1](event && event.target ? event.target.value : ""); },
					onKeyDown: function (event) {
						if (!event || event.key !== "Enter" || event.shiftKey) return;
						var native = event.nativeEvent;
						if (event.isComposing || (native && native.isComposing)) return;
						if (typeof event.preventDefault === "function") event.preventDefault();
						submitDraft();
					}
				}),
				h("div", { className: "daw-wb-composer-row" },
					typeof props.onOpenSession === "function" && sessionId !== ""
						? h(WbBtn, { variant: "ghost", onClick: function () { props.onOpenSession(sessionId); } }, t("chat.openFull"))
						: null,
					h("span", { className: "daw-wb-node-fill" }),
					h(WbBtn, {
						variant: "small",
						disabled: !canSend || busy || draftState[0].trim() === "",
						title: t("chat.send.title"),
						onClick: submitDraft
					}, t("chat.send"))));
		}

		/**
		 * 「从画布开始」：不用先开 DSH 对话。用户写目标并点发送 →
		 * `ctx.sessions.create` 建主对话（不跳页）→ POST /projects 自动建项目 →
		 * 进项目画布，Composer 挂上后补交这句话。
		 */
		function WbStartPage(props) {
			var t = wbT(props);
			var workspaces = typeof props.useWorkspaces === "function" ? props.useWorkspaces(function (s) { return s; }) : undefined;
			var items = wbWorkspaceItems(workspaces);
			var textState = react.useState("");
			var wsState = react.useState("");
			var busyState = react.useState(false);
			var errState = react.useState("");
			var canCreate = typeof props.createSession === "function";
			// 默认选第一个工作区（与侧栏的默认工作区一致）；不选会让新会话落进「未分组」。
			var workspaceId = wsState[0] !== "" ? wsState[0] : (items.length > 0 ? items[0].id : "");

			function start() {
				var text = textState[0].trim();
				if (text === "" || busyState[0]) return;
				if (!canCreate) { errState[1](t("start.no.create")); return; }
				busyState[1](true);
				errState[1]("");
				var opts = workspaceId !== "" ? { workspaceId: workspaceId } : {};
				Promise.resolve().then(function () { return props.createSession(opts); }).then(function (sessionId) {
					if (typeof sessionId !== "string" || sessionId === "") throw new Error("no session id");
					return wbApi("/projects", { method: "POST", body: { name: wbProjectNameFrom(text), mainSessionId: sessionId, goal: text } })
						.then(wbUnwrap)
						.then(function (data) {
							var project = data && data.project;
							if (!project || !project.projectId) throw new Error("project not created");
							wbPendingFirst[sessionId] = text;
							wbCache.invalidate("/projects");
							wbCache.invalidate("/inbox");
							wbRoute.project(project.projectId, "canvas");
						});
				}).catch(function (error) {
					busyState[1](false);
					errState[1](t("start.failed", { error: error && error.message ? error.message : String(error) }));
				});
			}

			return h(WbPage, {
				title: t("start.title"),
				desc: t("start.desc"),
				actions: [h(WbBtn, { key: "back", variant: "ghost", onClick: function () { wbRoute.list(); } }, t("start.back"))]
			},
				h("div", { className: "daw-wb-start" },
					h("div", { className: "daw-wb-start-card", "data-kind": "composer" },
						h("div", { className: "daw-wb-node-head" },
							h("span", { className: "daw-wb-node-tag" }, "✦"),
							h("span", null, t("canvas.node.composer"))),
						items.length > 0
							? h("label", { className: "daw-wb-start-ws" },
								h("span", null, t("start.workspace")),
								h("select", {
									value: workspaceId,
									onChange: function (event) { wsState[1](event && event.target ? event.target.value : ""); }
								},
									items.map(function (item) { return h("option", { key: item.id, value: item.id }, item.name); })))
							: null,
						h("textarea", {
							className: "daw-wb-composer-input",
							rows: 4,
							value: textState[0],
							placeholder: t("start.placeholder"),
							disabled: busyState[0],
							onChange: function (event) { textState[1](event && event.target ? event.target.value : ""); },
							onKeyDown: function (event) {
								if (!event || event.key !== "Enter" || event.shiftKey) return;
								var native = event.nativeEvent;
								if (event.isComposing || (native && native.isComposing)) return;
								if (typeof event.preventDefault === "function") event.preventDefault();
								start();
							}
						}),
						h("div", { className: "daw-wb-composer-row" },
							h("span", { className: "daw-wb-note" }, busyState[0] ? t("start.busy") : canCreate ? t("chat.send.title") : t("start.no.create")),
							h("span", { className: "daw-wb-node-fill" }),
							h(WbBtn, { disabled: busyState[0] || !canCreate || textState[0].trim() === "", onClick: start }, t("start.send"))),
						errState[0] !== "" ? h("div", { className: "daw-wb-note", "data-tone": "danger" }, errState[0]) : null)));
		}

		// ── M6-5 「带入输入框」与目标条（W2 浏览器半边：PRD §48.2 / §49.1 / §49.4）──
		//
		// 官方契约（2026-11-10 在宿主实现里逐字核实）：`inputActions` 是 standard props
		// （`ctx.uiSession.provide()`，与 `useConversation` / `useInput` 并列）；
		// `captureInsertion()` 捕获草稿选区与 revision；`insertText(text, span)` 在 revision
		// 仍有效且编辑器可编辑时插入一次可撤销的纯文本编辑，被拒时返回 false
		// （冻结 / 已销毁 / revision 过期）。所以「带入」零 DOM、不碰框架状态。

		/** 当前面板有没有官方草稿 API（main 面板可能没有；没有就走剪贴板降级）。 */
		function wbHasInputActions(inputActions) {
			return inputActions !== null && typeof inputActions === "object" && typeof inputActions.insertText === "function";
		}

		/**
		 * 「带入」的引用前缀（PRD §49.1）：只引用提案身份（版本 + 编号），不带任何
		 * 指令性措辞——用户接着自己写修改意见。是引用，不是指令模板。
		 * 纯函数：t 可选（组件传 wbT(props)），缺省退回内置中文表，离线测试同口径。
		 */
		function wbDraftPrefix(proposal, t) {
			if (proposal === null || typeof proposal !== "object") return "";
			var id = typeof proposal.proposalId === "string" ? proposal.proposalId : "";
			// 版本取整：脏数据（小数 / 负数）也不能把「v7.5」带进用户输入框。
			var version = typeof proposal.version === "number" && proposal.version > 0 ? Math.floor(proposal.version) : 1;
			var vars = { version: version, proposalId: id };
			var template = typeof t === "function" ? t("draft.prefix", vars) : WB_TEXT.zh["draft.prefix"];
			return wbFill(template, vars);
		}

		/**
		 * insertText 结果判定：只有明确表示成功才算插入成功；false / undefined /
		 * 说不清的形状一律当被拒——文本走剪贴板降级，不丢。
		 */
		function wbInsertAccepted(result) {
			if (result === true) return true;
			if (result !== null && typeof result === "object") {
				return result.ok === true || result.accepted === true || result.applied === true || result.inserted === true;
			}
			return false;
		}

		/**
		 * 剪贴板降级的最后一步：隐藏 textarea + execCommand（老浏览器 / 非安全上下文）。
		 * 这是全插件唯一被允许的 DOM 触碰，层层兜底：任何一步炸了都只返回 false。
		 */
		function wbCopyFallback(text) {
			try {
				var doc = typeof document !== "undefined" ? document : undefined;
				if (!doc || typeof doc.createElement !== "function" || typeof doc.execCommand !== "function") return false;
				if (doc.body === undefined || doc.body === null || typeof doc.body.appendChild !== "function") return false;
				var area = doc.createElement("textarea");
				area.value = text;
				if (typeof area.setAttribute === "function") { area.setAttribute("readonly", ""); area.setAttribute("aria-hidden", "true"); }
				area.style.position = "fixed";
				area.style.top = "-9999px";
				area.style.opacity = "0";
				doc.body.appendChild(area);
				if (typeof area.select === "function") area.select();
				var ok = false;
				try { ok = doc.execCommand("copy") === true; } catch (error) { ok = false; }
				try {
					if (typeof area.remove === "function") area.remove();
					else if (typeof doc.body.removeChild === "function") doc.body.removeChild(area);
				} catch (error) { /* 摘不掉也不影响结果 */ }
				return ok;
			} catch (error) {
				return false;
			}
		}

		/** 写剪贴板：优先 navigator.clipboard，失败退隐藏 textarea；都不成才让调用方显示原文。 */
		function wbCopyText(text) {
			return new Promise(function (resolve) {
				var clip = typeof navigator !== "undefined" && navigator ? navigator.clipboard : undefined;
				if (clip === undefined || typeof clip.writeText !== "function") { resolve(wbCopyFallback(text)); return; }
				var outcome;
				try { outcome = clip.writeText(text); } catch (error) { resolve(wbCopyFallback(text)); return; }
				if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") {
					outcome.then(function () { resolve(true); }, function () { resolve(wbCopyFallback(text)); });
					return;
				}
				// 同步返回（老浏览器形状）：不当成成功，再走一遍降级链路确认。
				resolve(wbCopyFallback(text));
			});
		}

		/**
		 * 「带入」主链（PRD §48.2）：先试官方草稿 API；被拒（revision 过期 /
		 * 编辑器不可编辑 / 没有 inputActions）→ 剪贴板降级 → 再不行返回原文让用户手动复制。
		 * 返回 Promise<{state:"inserted"|"copied"|"failed", text}>；绝不自动提交。
		 */
		function wbInsertDraft(text, inputActions) {
			var body = typeof text === "string" ? text : "";
			function degrade() {
				return wbCopyText(body).then(function (ok) {
					return { state: ok === true ? "copied" : "failed", text: body };
				});
			}
			if (!wbHasInputActions(inputActions)) return degrade();
			var outcome;
			try {
				var span = typeof inputActions.captureInsertion === "function" ? inputActions.captureInsertion() : undefined;
				outcome = inputActions.insertText(body, span);
			} catch (error) {
				return degrade();
			}
			if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") {
				return outcome.then(function (settled) {
					return wbInsertAccepted(settled) ? { state: "inserted", text: body } : degrade();
				}, function () { return degrade(); });
			}
			return wbInsertAccepted(outcome) ? Promise.resolve({ state: "inserted", text: body }) : degrade();
		}

		// ── 快照导出（ZIP，store 不压缩）────────────────────────────────────
		//
		// 借 chat-demo 历史导出的形状（fflate + 明确的数据边界），落地时按本插件的
		// 约束改了两处：
		//   · 不引压缩库：client.js 是单文件 bundle（prepack 门禁 560KB），而备份对象是
		//     几个 JSON（几十 KB 级），store 模式几十行就够，压缩收益有限；
		//   · 内容走宿主新开的只读路由 GET /agent-whales/api/snapshot——各业务路由返回的
		//     是**视图**（projectView / 任务派生 / 收件箱聚合），备份要的是盘上真源。
		// 数据边界：插件自己只存项目/画布/交接/事件/提案五份 JSON，**不含任何凭据**；
		// 快照里仍会带会话 id 与任务正文，所以只在用户点了「导出」时才生成。

		/** CRC-32 表（ZIP 标准多项式 0xEDB88320，反射）。 */
		var WB_CRC_TABLE = (function () {
			var table = [];
			for (var n = 0; n < 256; n += 1) {
				var c = n;
				for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
				table[n] = c >>> 0;
			}
			return table;
		})();

		/**
		 * CRC-32（返回无符号 32 位）。测试向量：ASCII "123456789" → 0xCBF43926。
		 * @param {Uint8Array} bytes
		 * @returns {number}
		 */
		function wbCrc32(bytes) {
			var crc = 0xFFFFFFFF;
			for (var i = 0; i < bytes.length; i += 1) crc = WB_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
			return (crc ^ 0xFFFFFFFF) >>> 0;
		}

		/** UTF-8 编码：TextEncoder 优先，老宿主退手工代理对编码。 */
		function wbUtf8(text) {
			var value = typeof text === "string" ? text : "";
			if (typeof TextEncoder === "function") return new TextEncoder().encode(value);
			var out = [];
			for (var i = 0; i < value.length; i += 1) {
				var code = value.charCodeAt(i);
				if (code < 0x80) out.push(code);
				else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
				else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
					var next = value.charCodeAt(i + 1);
					if (next >= 0xdc00 && next <= 0xdfff) {
						var point = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
						out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
						i += 1;
						continue;
					}
					out.push(0xef, 0xbf, 0xbd);
					continue;
				} else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
			}
			return new Uint8Array(out);
		}

		/** DOS 时间戳（ZIP 头要）：本地时间，秒粒度（DOS 只有 2 秒精度）。 */
		function wbDosStamp(date) {
			var year = date.getFullYear();
			if (year < 1980) year = 1980;
			var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
			var day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
			return { time: time, date: day };
		}

		/**
		 * 打 ZIP（method 0 = store，不压缩）。
		 *
		 * 纯函数：不碰 DOM、不抛。返回 Uint8Array；环境缺 DataView/Uint8Array 时返回
		 * undefined，让调用方走「说清导不了」的降级——别把异常抛给 React。
		 *
		 * @param {Array<{name: string, text: string}>} entries 条目（name 用 UTF-8）
		 * @param {Date} [when] 时间戳，默认现在
		 * @returns {Uint8Array | undefined}
		 */
		function wbBuildZip(entries, when) {
			if (typeof Uint8Array !== "function" || typeof DataView !== "function") return undefined;
			var list = Array.isArray(entries) ? entries : [];
			var stamp = wbDosStamp(when instanceof Date ? when : new Date());
			var chunks = [];
			var central = [];
			var offset = 0;
			for (var index = 0; index < list.length; index += 1) {
				var entry = list[index] || {};
				var name = typeof entry.name === "string" ? entry.name : ("entry-" + index);
				var body = wbUtf8(typeof entry.text === "string" ? entry.text : "");
				var nameBytes = wbUtf8(name);
				var crc = wbCrc32(body);
				var header = new Uint8Array(30 + nameBytes.length);
				var view = new DataView(header.buffer);
				view.setUint32(0, 0x04034b50, true);
				view.setUint16(4, 20, true);
				view.setUint16(6, 0x0800, true); // UTF-8 文件名
				view.setUint16(8, 0, true); // store
				view.setUint16(10, stamp.time, true);
				view.setUint16(12, stamp.date, true);
				view.setUint32(14, crc, true);
				view.setUint32(18, body.length, true);
				view.setUint32(22, body.length, true);
				view.setUint16(26, nameBytes.length, true);
				view.setUint16(28, 0, true);
				header.set(nameBytes, 30);
				chunks.push(header, body);
				var dir = new Uint8Array(46 + nameBytes.length);
				var dirView = new DataView(dir.buffer);
				dirView.setUint32(0, 0x02014b50, true);
				dirView.setUint16(4, 20, true);
				dirView.setUint16(6, 20, true);
				dirView.setUint16(8, 0x0800, true);
				dirView.setUint16(10, 0, true);
				dirView.setUint16(12, stamp.time, true);
				dirView.setUint16(14, stamp.date, true);
				dirView.setUint32(16, crc, true);
				dirView.setUint32(20, body.length, true);
				dirView.setUint32(24, body.length, true);
				dirView.setUint16(28, nameBytes.length, true);
				dirView.setUint16(30, 0, true);
				dirView.setUint16(32, 0, true);
				dirView.setUint16(34, 0, true);
				dirView.setUint16(36, 0, true);
				dirView.setUint32(38, 0, true);
				dirView.setUint32(42, offset, true);
				dir.set(nameBytes, 46);
				central.push(dir);
				offset += header.length + body.length;
			}
			var centralSize = 0;
			for (var c = 0; c < central.length; c += 1) centralSize += central[c].length;
			var end = new Uint8Array(22);
			var endView = new DataView(end.buffer);
			endView.setUint32(0, 0x06054b50, true);
			endView.setUint16(4, 0, true);
			endView.setUint16(6, 0, true);
			endView.setUint16(8, central.length, true);
			endView.setUint16(10, central.length, true);
			endView.setUint32(12, centralSize, true);
			endView.setUint32(16, offset, true);
			endView.setUint16(20, 0, true);
			var all = chunks.concat(central, [end]);
			var total = 0;
			for (var i = 0; i < all.length; i += 1) total += all[i].length;
			var zip = new Uint8Array(total);
			var cursor = 0;
			for (var j = 0; j < all.length; j += 1) { zip.set(all[j], cursor); cursor += all[j].length; }
			return zip;
		}

		/** 快照 ZIP 里附的说明：这是什么、哪些文件不在/只读。导出要能自己解释自己。 */
		function wbSnapshotReadme(files) {
			var lines = [
				"dsh-agent-whales 快照导出",
				"=========================",
				"",
				"这是什么：dsh-agent-whales 插件自己那五个数据文件的原文备份。",
				"生成时间：" + new Date().toISOString(),
				"",
				"文件说明：",
				"  projects.json  项目 / 成员 / 关联线 / 任务 / MCP 约束（含简报）",
				"  canvas.json    画布节点位置（按项目分页 + revision）",
				"  handoffs.json  交接账本（谁在什么时候给谁发了什么）",
				"  events.json    事件台账（提案提交 / 任务命令 / 交接结果 / 存储降级）",
				"  proposals.json 任务提案（含未确认的）",
				"",
				"数据边界：以上五份是插件写入的全部数据，不含任何凭据或密钥；",
				"但含会话 id 与任务正文，分享前请自行确认。",
				""
			];
			var list = Array.isArray(files) ? files : [];
			var missing = [];
			var readonly = [];
			for (var i = 0; i < list.length; i += 1) {
				var file = list[i];
				if (!file || typeof file.name !== "string") continue;
				if (file.present !== true) missing.push(file.name);
				if (file.readonly === true) readonly.push(file.name);
			}
			if (missing.length > 0) lines.push("本次未包含（文件不存在）：" + missing.join("、"));
			var backed = [];
			for (var b = 0; b < list.length; b += 1) {
				var row = list[b];
				if (row && row.present !== true && typeof row.backupPath === "string" && row.backupPath !== "") backed.push(row.name + "（已备份到 " + row.backupPath + "）");
			}
			if (backed.length > 0) lines.push("以下文件原路径已不在（损坏后被改名备份），本次不含其内容：" + backed.join("、"));
			if (readonly.length > 0) lines.push("注意：以下文件处于只读降级状态（内容可能是损坏前的最后一份好快照）：" + readonly.join("、"));
			if (missing.length === 0 && readonly.length === 0) lines.push("本次包含全部五个文件，均正常可读。");
			lines.push("");
			return lines.join("\n");
		}

		/** 触发浏览器下载；环境不支持时返回 false（调用方据此说清，不抛）。 */
		function wbDownloadFile(filename, bytes, mime) {
			try {
				if (typeof Blob !== "function" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof document === "undefined" || !document) return false;
				var blob = new Blob([bytes], { type: mime || "application/zip" });
				var url = URL.createObjectURL(blob);
				var link = document.createElement("a");
				link.href = url;
				link.download = filename;
				if (document.body) document.body.appendChild(link);
				link.click();
				if (document.body) document.body.removeChild(link);
				if (typeof URL.revokeObjectURL === "function") setTimeout(function () { URL.revokeObjectURL(url); }, 0);
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 从快照响应里挑出要打包的条目：只收 present 的文件（缺文件与空文件是两件事，
		 * 缺的由 README 说明），末尾附一份 README.txt——导出物要能自己解释自己。
		 *
		 * @param {object} payload GET /snapshot 的 data
		 * @returns {Array<{name: string, text: string}>}
		 */
		function wbSnapshotEntries(payload) {
			var files = payload && Array.isArray(payload.files) ? payload.files : [];
			var entries = [];
			for (var i = 0; i < files.length; i += 1) {
				var file = files[i];
				if (!file || file.present !== true || file.data === null || file.data === undefined) continue;
				entries.push({ name: file.name, text: JSON.stringify(file.data, null, 2) + "\n" });
			}
			entries.push({ name: "README.txt", text: wbSnapshotReadme(files) });
			return entries;
		}

		/**
		 * 导出全量快照：GET /snapshot → 挑条目 → 打 ZIP → 下载。
		 * 返回 Promise<{files: number}>；任何一步失败都 reject（调用方显示原因）。
		 */
		function wbExportSnapshot() {
			return wbApi("/snapshot").then(function (payload) {
				var data = payload && payload.data ? payload.data : {};
				var entries = wbSnapshotEntries(data);
				var zip = wbBuildZip(entries);
				if (zip === undefined) throw new Error("当前浏览器打不出 ZIP（缺 Uint8Array/DataView）");
				var stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
				var ok = wbDownloadFile("dsh-agent-whales-snapshot-" + stamp + ".zip", zip);
				if (ok !== true) throw new Error("浏览器不接受这次下载（Blob/URL 不可用）");
				// files 报的是**数据文件**数（不含 README）：UI 说「已导出 N 个文件」要对得上用户认知。
				return { files: entries.length - 1 };
			});
		}

		/**
		 * 目标条标题（PRD §49.1）：目标 = 最新提案 sourceMessageId 指向的那条用户消息，
		 * 标题直接截取消息首行、不另造标题。客户端没有读单条消息的路由，所以消息首行
		 * 拿不到时退回会话标题，并用 from 注明来源——绝不编造目标文本。
		 */
		function wbGoalTitle(messageFirstLine, sessionTitle) {
			var line = typeof messageFirstLine === "string" ? messageFirstLine.split("\n")[0].trim() : "";
			if (line !== "") return { text: line, from: "message" };
			var title = typeof sessionTitle === "string" ? sessionTitle.trim() : "";
			if (title !== "") return { text: title, from: "session" };
			return { text: "", from: "none" };
		}

		/**
		 * 「查看」要跳的项目：先按提案编号在收件箱里找精确归属（宿主聚合时写了
		 * projectId），再按主会话匹配项目列表；都推断不出返回空串——调用方只显示
		 * 状态、不跳转，不猜。
		 */
		function wbGoalProjectId(proposalId, leadSessionId, inbox, projects) {
			var id = typeof proposalId === "string" ? proposalId : "";
			if (id === "") return "";
			var groups = inbox !== null && typeof inbox === "object" && Array.isArray(inbox.groups) ? inbox.groups : [];
			for (var g = 0; g < groups.length; g += 1) {
				var items = groups[g] && Array.isArray(groups[g].items) ? groups[g].items : [];
				for (var i = 0; i < items.length; i += 1) {
					var row = items[i];
					if (row && row.proposalId === id && typeof row.projectId === "string" && row.projectId !== "") return row.projectId;
				}
			}
			var list = Array.isArray(projects)
				? projects
				: (projects !== null && typeof projects === "object" && Array.isArray(projects.projects) ? projects.projects : []);
			var lead = typeof leadSessionId === "string" ? leadSessionId : "";
			for (var p = 0; p < list.length; p += 1) {
				var project = list[p];
				if (project && lead !== "" && project.mainSessionId === lead && typeof project.projectId === "string" && project.projectId !== "") return project.projectId;
			}
			return "";
		}

		/** 某个会话所在的项目（主对话或成员都算）；ids 依次尝试，找不到返回 null。 */
		function wbProjectOfSession(projects, ids) {
			var list = Array.isArray(projects)
				? projects
				: (projects !== null && typeof projects === "object" && Array.isArray(projects.projects) ? projects.projects : []);
			var wanted = (Array.isArray(ids) ? ids : [ids]).filter(function (id) { return typeof id === "string" && id !== ""; });
			for (var w = 0; w < wanted.length; w += 1) {
				for (var p = 0; p < list.length; p += 1) {
					var project = list[p];
					if (!project || typeof project.projectId !== "string" || project.projectId === "") continue;
					if (project.mainSessionId === wanted[w]) return project;
					var members = Array.isArray(project.members) ? project.members : [];
					if (members.some(function (member) { return member && member.sessionId === wanted[w]; })) return project;
				}
			}
			return null;
		}

		// ── M6-5 目标条 + 提案卡（D6 最小版：只读展示 + 确认后逐条建任务）────────

		function WbProposalCard(props) {
			var t = wbT(props);
			var leadSessionId = props.leadSessionId;
			var snap = useWb(leadSessionId ? "/proposals?leadSessionId=" + encodeURIComponent(leadSessionId) : null);
			var proposal = snap.data && snap.data.proposal ? snap.data.proposal : null;
			var busyState = react.useState(false);
			var errorState = react.useState("");
			var error = errorState[0];
			// 「带入」三态结果（inserted / copied / failed）与 tone 一起存，渲染时按 tone 上色。
			var draftState = react.useState({ text: "", tone: "" });
			var draft = draftState[0];
			// 画布浮层里可收起：已确认的提案默认收起，别挡住右侧 Agent 列（真机 2026-11-17）。
			var openState = react.useState(null);
			if (proposal === null) return null;
			var items = Array.isArray(proposal.items) ? proposal.items : [];
			// §51.4 组建方案：新建对话之前就显示将新建几个、各用什么 preset（PRD 原话）。
			var conversations = Array.isArray(proposal.conversations) ? proposal.conversations : [];
			var createdConversations = proposal.confirmed && Array.isArray(proposal.confirmed.conversations) ? proposal.confirmed.conversations : [];
			var locked = proposal.locked === true;
			var created = proposal.confirmed && Array.isArray(proposal.confirmed.created) ? proposal.confirmed.created : [];
			var failed = proposal.confirmed && Array.isArray(proposal.confirmed.failed) ? proposal.confirmed.failed : [];

			function confirm() {
				busyState[1](true);
				errorState[1]("");
				wbApi("/proposals/" + encodeURIComponent(proposal.proposalId) + "/confirm", {
					method: "POST",
					body: { leadSessionId: leadSessionId, version: proposal.version, requestId: wbUuid() }
				}).then(function (payload) {
					busyState[1](false);
					if (payload && payload.code !== 200) errorState[1](payload.msg || ("code " + payload.code));
					wbCache.invalidate("/proposals");
					wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(props.projectId));
					wbCache.invalidate("/inbox");
				}).catch(function (failure) { errorState[1](failure.message); busyState[1](false); });
			}

			/**
			 * 「带入」：把这条提案的引用前缀带进当前会话输入框（PRD §49.1：只服务
			 * 「让 Lead 改提案」）。main 面板拿不到 inputActions，所以这里允许降级——
			 * 按钮 title 会说明；插入后不自动提交，成功态只说「已带入，请回车发送」。
			 */
			function insert() {
				if (busyState[0]) return;
				busyState[1](true);
				wbInsertDraft(wbDraftPrefix(proposal, t), props.inputActions).then(function (result) {
					busyState[1](false);
					if (result.state === "inserted") { draftState[1]({ text: t("draft.state.inserted"), tone: "ok" }); return; }
					if (result.state === "copied") { draftState[1]({ text: t("draft.state.copied"), tone: "warn" }); return; }
					draftState[1]({ text: t("draft.state.failed") + result.text, tone: "danger" });
				}, function () { busyState[1](false); });
			}

			var draftNotes = [t("draft.insert.title")];
			if (locked) draftNotes.push(t("draft.insert.locked"));
			if (!wbHasInputActions(props.inputActions)) draftNotes.push(t("draft.insert.clipboard"));

			var collapsible = props.collapsible === true;
			var collapsed = collapsible && (openState[0] === null ? locked : openState[0] === false);
			var toggle = collapsible
				? h(WbBtn, { variant: "ghost", onClick: function () { openState[1](collapsed); } }, collapsed ? t("proposal.expand") : t("proposal.collapse"))
				: null;
			if (collapsed) {
				return h("div", { className: "daw-wb-panel", "data-collapsed": "true" },
					h("div", { className: "daw-wb-panel-title" },
						h("span", null, t("inbox.group.proposals")),
						h("span", { className: "daw-wb-toolfill" }),
						h(WbChip, { tone: locked ? "ok" : "warn" }, locked ? t("event.state.opened") : t("event.state.pending")),
						toggle));
			}

			return h("div", { className: "daw-wb-panel" },
				h("div", { className: "daw-wb-panel-title" },
					h("span", null, t("inbox.group.proposals")),
					h("span", { className: "daw-wb-toolfill" }),
					h(WbChip, { tone: locked ? "ok" : "warn" }, locked ? t("event.state.opened") : t("event.state.pending")),
					h("span", { className: "daw-wb-note" }, proposal.proposalId + " · v" + proposal.version + " · " + items.length),
					toggle),
				error !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "danger" }, error) : null,
				draft.text !== "" ? h("div", { className: "daw-wb-banner", "data-tone": draft.tone }, draft.text) : null,
				conversations.length > 0
					? h("div", { className: "daw-wb-plan", "data-proposal-conversations": String(conversations.length) },
						h("div", { className: "daw-wb-plan-title" }, t("proposal.conversations", { count: conversations.length })),
						conversations.map(function (conv) {
							var made = createdConversations.filter(function (row) { return row && row.key === conv.key; })[0];
							return h("div", { key: conv.key, className: "daw-wb-todo-src" },
								(made ? "✓ " : "· ") + conv.title + (conv.agentPreset ? "（" + conv.agentPreset + "）" : t("proposal.conversation.defaultPreset")) +
								(conv.duty ? " · " + conv.duty : ""));
						}))
					: null,
				items.map(function (item, index) {
					var deps = Array.isArray(item.blockedBy) && item.blockedBy.length > 0 ? item.blockedBy.join("、") : t("common.none");
					return h("div", { key: index, className: "daw-wb-todo" },
						h("div", { className: "daw-wb-todo-index" }, String(item.key || index + 1)),
						h("div", { className: "daw-wb-todo-body" },
							h("div", { className: "daw-wb-todo-text" }, item.subject || item.title || ""),
							h("div", { className: "daw-wb-todo-src" },
								t("tasks.col.blockedBy") + " " + deps +
								(item.suggestedOwner ? " · " + t("tasks.assign.owner") + " " + item.suggestedOwner : ""))),
						locked ? h(WbChip, { tone: "ok" }, t("event.state.opened")) : null);
				}),
				h("div", { className: "daw-wb-toolbar" },
					locked
						? h("span", { className: "daw-wb-note" }, t("tasks.report.note"))
						: h(WbBtn, { disabled: busyState[0], onClick: confirm }, t("common.confirm")),
					h(WbBtn, { variant: "ghost", disabled: busyState[0], title: draftNotes.join(" · "), onClick: insert }, t("draft.insert")),
					h("span", { className: "daw-wb-toolfill" }),
					created.length > 0 ? h("span", { className: "daw-wb-note" }, t("event.state.opened") + " " + created.length) : null,
					failed.length > 0 ? h("span", { className: "daw-wb-note" }, t("handoff.result.failed") + " " + failed.length) : null),
				// 边界说明常驻底部（设计稿 M6-5「带入边界」）：不做成弹窗，用户随时看得到。
				h("div", { className: "daw-wb-note" }, t("draft.boundary")),
				h("div", { className: "daw-wb-note" }, t("event.action.note")));
		}

		/**
		 * 目标条（W2 / D2 递进第一步）：叠在官方 composer 上方（conversation.input.dock），
		 * **不设 priority**——我们是叠加，不影子官方 composer（§47.3 D2 硬约束）。
		 * 出任何问题只丢这一条，不影响官方输入区（mountSeat 有 reportSetupError 兜底，
		 * 组件内所有可选 props 也都退化成「没有数据」）。
		 *
		 * 内容（PRD §49.1 / §49.4）：目标 = 最新提案 sourceMessageId 指向的那条用户消息
		 * 首行（客户端没有读单条消息的路由 → 退回会话标题并注明来源，不编造）；
		 * 提案状态行 + 「查看」切到工作台并定位提案卡；有提案才给「带入」；
		 * 还没有提案时只显示一句引导，不放「带入」。
		 */
		function WhaleGoalBar(props) {
			var t = wbT(props);
			// hook 全部无条件调用（顺序稳定）；标准 props 缺一个就退化成「没有数据」。
			var sessionsState = (typeof props.useSessions === "function" ? props.useSessions : function () { return undefined; })(function (value) { return value; });
			var currentId = typeof props.sessionId === "string" && props.sessionId !== ""
				? props.sessionId
				: (sessionsState ? currentSessionId(sessionsState) : undefined);
			var leadId = currentId === undefined ? undefined : safeLeadId(props.leadIdOf, currentId);
			var proposals = useWb(leadId === undefined ? null : "/proposals?leadSessionId=" + encodeURIComponent(leadId));
			var projectsSnap = useWb(currentId === undefined ? null : "/projects");
			var ownProject = wbProjectOfSession(projectsSnap.data, [currentId, leadId]);
			var messageState = react.useState({ text: "", tone: "" });
			var message = messageState[0];
			var busyState = react.useState(false);
			var busy = busyState[0];

			var proposal = proposals.data && proposals.data.proposal ? proposals.data.proposal : null;
			var leadRow = sessionsState && sessionsState.byId && leadId !== undefined ? sessionsState.byId[leadId] : undefined;
			var sessionTitle = leadRow && typeof leadRow.title === "string" ? leadRow.title : "";
			// 消息首行取不到（客户端无此路由）→ 传 undefined，由 wbGoalTitle 走会话标题兜底。
			var goal = wbGoalTitle(undefined, sessionTitle);

			function insert() {
				if (busy || proposal === null) return;
				busyState[1](true);
				wbInsertDraft(wbDraftPrefix(proposal, t), props.inputActions).then(function (result) {
					busyState[1](false);
					if (result.state === "inserted") { messageState[1]({ text: t("draft.state.inserted"), tone: "ok" }); return; }
					if (result.state === "copied") { messageState[1]({ text: t("draft.state.copied"), tone: "warn" }); return; }
					messageState[1]({ text: t("draft.state.failed") + result.text, tone: "danger" });
				}, function () { busyState[1](false); });
			}

			/**
			 * 「查看」：切到插件工作台并定位到提案卡。项目归属按需推断（收件箱精确匹配 →
			 * 项目列表按主会话兜底）；推断不出就不跳转，只在状态行说明——不猜、不乱跳。
			 */
			function view() {
				if (busy || proposal === null) return;
				busyState[1](true);
				Promise.all([
					wbApi("/inbox").then(wbUnwrap, function () { return undefined; }),
					wbApi("/projects").then(wbUnwrap, function () { return undefined; })
				]).then(function (pair) {
					var projectId = wbGoalProjectId(proposal.proposalId, leadId, pair[0], pair[1]);
					if (projectId === "" && ownProject !== null) projectId = ownProject.projectId;
					if (projectId !== "") {
						wbSelectPanel("whales-canvas");
						wbRoute.project(projectId, "canvas");
					} else {
						messageState[1]({ text: t("goal.view.none"), tone: "warn" });
					}
					busyState[1](false);
				}, function () { busyState[1](false); });
			}

			if (proposal === null) return null;

			var version = typeof proposal.version === "number" && proposal.version > 0 ? Math.floor(proposal.version) : 1;
			var locked = proposal.locked === true;
			var draftNotes = [t("draft.insert.title")];
			if (locked) draftNotes.push(t("draft.insert.locked"));
			if (!wbHasInputActions(props.inputActions)) draftNotes.push(t("draft.insert.clipboard"));
			return h("div", { className: "daw-goalbar", "data-whales-goal": "1" },
				h("div", { className: "daw-goalbar-row" },
					h("span", { className: "daw-goalbar-dot" }),
					h("span", { className: "daw-goalbar-label" }, t("goal.label")),
					h("span", {
						className: "daw-goalbar-text",
						title: goal.from === "session" ? t("goal.from.session") : undefined
					}, goal.text === "" ? t("common.none") : goal.text),
					goal.from === "session" ? h("span", { className: "daw-goalbar-src" }, t("goal.from.session")) : null,
					h("span", { className: "daw-goalbar-fill" }),
					h("span", { className: "daw-goalbar-status" }, locked ? t("goal.status.locked", { version: version }) : t("goal.status", { version: version })),
					h("button", { type: "button", className: "daw-goalbar-btn", disabled: busy, onClick: view }, t("goal.view")),
					h("button", {
						type: "button",
						className: "daw-goalbar-btn",
						disabled: busy,
						title: draftNotes.join(" · "),
						onClick: insert
					}, t("draft.insert"))),
				message.text !== "" ? h("div", { className: "daw-goalbar-msg", "data-tone": message.tone }, message.text) : null);
		}

		function indexById(rows) {
			var byId = {};
			(rows || []).forEach(function (row) {
				if (row && typeof row.sessionId === "string") byId[row.sessionId] = row;
			});
			return byId;
		}

		// ── 需求页（需求主线 P3）：需求列表 → 需求详情（设计确认 / E2E 运行 / 批注 / 回流）─────────────

		/** 项目级 E2E 配置面板（触发方式 / 驱动 / 执行器 / 被测地址）。放在需求页顶部，收起时只占一行。 */
		function WbE2eConfigPanel(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var url = "/projects/" + encodeURIComponent(projectId);
			var snap = useWb(url);
			var project = snap.data && snap.data.project ? snap.data.project : null;
			var openState = react.useState(false);
			var draftState = react.useState(null);
			var msgState = react.useState("");
			if (project === null) return null;
			var saved = wbE2eConfigDraft(project.e2eConfig);
			var draft = draftState[0] === null ? saved : draftState[0];
			var members = Array.isArray(project.members) ? project.members : [];
			function set(key, value) { var next = Object.assign({}, draft); next[key] = value; draftState[1](next); msgState[1](""); }
			var plan = wbE2eConfigPatch(project.e2eConfig, draft);
			var dirty = Object.keys(plan.patch).length > 0;
			function save() {
				if (!dirty) return;
				if (plan.error === "needExecutor") { msgState[1](t("req.cfg.needExecutor")); return; }
				wbWrite(url + "/e2e-config", "PUT", plan.patch).then(function () {
					draftState[1](null); msgState[1](t("req.cfg.saved"));
					wbCache.invalidate(url);
				}).catch(function (error) { msgState[1](error && error.message ? error.message : String(error)); });
			}
			function field(label, control) { return h("label", { className: "daw-wb-cfg-field" }, h("span", { className: "daw-wb-note" }, label), control); }
			return h("div", { className: "daw-wb-panel daw-wb-cfg" },
				h("div", { className: "daw-wb-e2erun-head" },
					h("div", { className: "daw-wb-panel-title" }, t("req.cfg.title")),
					h("span", { className: "daw-wb-note" }, t("req.cfg.summary", { trigger: t("req.cfg.trigger." + saved.trigger), driver: t("req.cfg.driver." + saved.driver) })),
					h("span", { className: "daw-wb-card-fill" }),
					h(WbBtn, { variant: "ghost", onClick: function () { openState[1](!openState[0]); } }, openState[0] ? t("req.cfg.collapse") : t("req.cfg.edit"))),
				openState[0] ? h("div", { className: "daw-wb-cfg-body" },
					field(t("req.cfg.trigger"), h("select", { className: "daw-wb-select", value: draft.trigger, onChange: function (event) { set("trigger", event.target.value); } },
						h("option", { value: "auto" }, t("req.cfg.trigger.auto")), h("option", { value: "manual" }, t("req.cfg.trigger.manual")))),
					field(t("req.cfg.driver"), h("select", { className: "daw-wb-select", value: draft.driver, onChange: function (event) { set("driver", event.target.value); } },
						h("option", { value: "manual" }, t("req.cfg.driver.manual")), h("option", { value: "tabbit-cli" }, t("req.cfg.driver.tabbit-cli")), h("option", { value: "computer-use" }, t("req.cfg.driver.computer-use")))),
					draft.driver !== "manual" ? field(t("req.cfg.executor"), h("select", { className: "daw-wb-select", value: draft.executorSessionId, onChange: function (event) { set("executorSessionId", event.target.value); } },
						[h("option", { key: "", value: "" }, t("req.cfg.executor.none"))].concat(members.map(function (member) { return h("option", { key: member.sessionId, value: member.sessionId }, (member.title || member.sessionId.slice(0, 12))); })))) : null,
					draft.driver === "computer-use" ? h("div", { className: "daw-wb-note" }, t("req.cfg.cu.warn")) : null,
					field(t("req.cfg.baseUrl"), h("input", { className: "daw-wb-input", value: draft.baseUrl, placeholder: "http://127.0.0.1:3250", onChange: function (event) { set("baseUrl", event.target.value); } })),
					h("div", { className: "daw-wb-case-actions" },
						h(WbBtn, { disabled: !dirty, onClick: save }, t("req.cfg.save")),
						msgState[0] !== "" ? h("span", { className: "daw-wb-note", role: "status" }, msgState[0]) : null)) : null);
		}

		function WbReqRunCard(props) {
			var t = wbT(props);
			var run = props.run;
			var runUrl = "/projects/" + encodeURIComponent(props.projectId) + "/e2e/" + encodeURIComponent(run.runId);
			var annState = react.useState(null);
			var ann = annState[0];
			var setAnn = annState[1];
			var textState = react.useState("");
			var text = textState[0];
			var setText = textState[1];
			var dragState = react.useState(null);
			var drag = dragState[0];
			var setDrag = dragState[1];
			function refresh() {
				wbCache.invalidate(runUrl);
				wbCache.invalidate("/projects/" + encodeURIComponent(props.projectId) + "/requirements");
				wbCache.invalidate("/projects/" + encodeURIComponent(props.projectId) + "/requirements/" + encodeURIComponent(props.reqId));
				wbCache.invalidate("/projects/" + encodeURIComponent(props.projectId) + "/requirements/" + encodeURIComponent(props.reqId) + "/e2e");
				wbCache.invalidate("/inbox");
				wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(props.projectId));
			}
			function act(promise) {
				return promise.then(function () { props.onNote(""); refresh(); }).catch(function (error) { props.onNote(error && error.message ? error.message : String(error)); });
			}
			function setResult(caseId, status) {
				return act(wbWrite(runUrl + "/results/" + encodeURIComponent(caseId), "PUT", { status: status }));
			}
			function uploadShot(caseId, file) {
				if (!file) return;
				return wbFileToUpload(file).then(function (payload) {
					return wbWrite(runUrl + "/shots/" + encodeURIComponent(caseId), "POST", payload);
				}).then(function () { props.onNote(""); refresh(); }).catch(function (error) { props.onNote(error && error.message ? error.message : String(error)); });
			}
			function saveAnnotation() {
				if (ann === null || text.trim() === "") return;
				var body = { caseId: ann.caseId, expected: text.trim() };
				if (ann.shot) body.shot = ann.shot;
				if (ann.rect) body.rect = ann.rect;
				return act(wbWrite(runUrl + "/annotations", "POST", body).then(function () { setAnn(null); setText(""); }));
			}
			var open = run.status === "queued" || run.status === "running";
			var annotations = Array.isArray(run.annotations) ? run.annotations : [];
			return h("div", { className: "daw-wb-e2erun", "data-run": run.runId },
				h("div", { className: "daw-wb-e2erun-head" },
					h(WbChip, { tone: run.status === "passed" ? "ok" : run.status === "failed" ? "danger" : run.status === "error" ? "warn" : "brand" }, t("req.run.status." + run.status)),
					h("b", null, run.runId),
					h("span", { className: "daw-wb-note" }, t("req.run.meta", { driver: run.driver, v: run.designVersion > 0 ? "v" + run.designVersion : t("req.design.none") })),
					h("span", { className: "daw-wb-card-fill" }),
					open ? h(WbBtn, { variant: "ghost", onClick: function () { act(wbWrite(runUrl + "/finish", "POST", {})); } }, t("req.run.finish")) : null),
				(Array.isArray(run.results) ? run.results : []).map(function (row) {
					var failed = row.status === "failed" || row.status === "error";
					var shots = (Array.isArray(row.shots) ? row.shots : []).filter(function (name) { return !/\.webm$/i.test(name); });
					return h("div", { key: row.caseId, className: "daw-wb-case", "data-status": row.status },
						h("div", { className: "daw-wb-case-top" },
							h(WbChip, { tone: WB_RESULT_TONES[row.status] || "neutral" }, t("req.case.status." + row.status)),
							h("span", { className: "daw-wb-case-title" }, row.caseId + " · " + row.title),
							row.reflowed ? h("span", { className: "daw-wb-note" }, t("req.case.reflowed", { to: t(wbReflowTargetKey(row.reflowedTo)) })) : null),
						row.note ? h("div", { className: "daw-wb-case-note" }, row.note) : null,
						row.diagnosis ? h("div", { className: "daw-wb-case-note" }, t("req.case.diagnosis", { who: row.diagnosis.by === "user" ? t("req.by.user") : t("req.by.ai"), kind: t(wbReflowTargetKey(row.diagnosis.kind)), reason: row.diagnosis.reason || "" })) : null,
						shots.length > 0 ? h("div", { className: "daw-wb-shots" }, shots.map(function (name) {
							var src = WB_API + runUrl + "/files/" + encodeURIComponent(name);
							var picked = ann !== null && ann.caseId === row.caseId && ann.shot === name;
							return h("div", { key: name, className: "daw-wb-shot", "data-picked": String(picked) },
								h("img", {
									src: src, alt: name, draggable: false,
									onMouseDown: failed ? function (event) { var box = event.currentTarget.getBoundingClientRect(); setDrag({ caseId: row.caseId, shot: name, start: { x: event.clientX - box.left, y: event.clientY - box.top } }); } : undefined,
									onMouseUp: failed ? function (event) {
										var box = event.currentTarget.getBoundingClientRect();
										var rect = drag && drag.shot === name ? wbRectFromDrag(drag.start, { x: event.clientX - box.left, y: event.clientY - box.top }, box.width, box.height) : null;
										setAnn({ caseId: row.caseId, shot: name, rect: rect });
										setDrag(null);
									} : undefined
								}),
								picked && ann.rect ? h("i", { className: "daw-wb-shot-box", style: { left: ann.rect.x * 100 + "%", top: ann.rect.y * 100 + "%", width: ann.rect.w * 100 + "%", height: ann.rect.h * 100 + "%" } }) : null,
								annotations.filter(function (a) { return a.caseId === row.caseId && a.shot === name && a.rect; }).map(function (a) {
									return h("i", { key: a.annId, className: "daw-wb-shot-box", "data-handled": String(a.handled === true), style: { left: a.rect.x * 100 + "%", top: a.rect.y * 100 + "%", width: a.rect.w * 100 + "%", height: a.rect.h * 100 + "%" } });
								}));
						})) : null,
						annotations.filter(function (a) { return a.caseId === row.caseId; }).map(function (a) {
							return h("div", { key: a.annId, className: "daw-wb-ann", "data-handled": String(a.handled === true) },
								h("span", null, t("req.ann.expected") + "：" + a.expected),
								a.handled === true ? h("span", { className: "daw-wb-note" }, t("req.ann.sent")) : h(WbBtn, { variant: "small", onClick: function () { act(wbWrite(runUrl + "/annotations/" + encodeURIComponent(a.annId), "DELETE")); } }, t("req.ann.remove")));
						}),
						failed && ann !== null && ann.caseId === row.caseId ? h("div", { className: "daw-wb-ann-edit" },
							h("div", { className: "daw-wb-note" }, ann.rect ? t("req.ann.boxed") : t("req.ann.hint")),
							h("input", { className: "daw-wb-input", value: text, placeholder: t("req.ann.placeholder"), onChange: function (event) { setText(event.target.value); } }),
							h(WbBtn, { variant: "small", disabled: text.trim() === "", onClick: saveAnnotation }, t("req.ann.save")),
							h(WbBtn, { variant: "small", onClick: function () { setAnn(null); setText(""); } }, t("common.cancel"))) : null,
						h("div", { className: "daw-wb-case-actions" },
							open && run.driver === "manual" ? h("label", { key: "up", className: "daw-wb-upload" },
								h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", onChange: function (event) { return uploadShot(row.caseId, event.target && event.target.files ? event.target.files[0] : null); } }),
								h("span", { className: "daw-wb-btn", "data-variant": "small" }, t("req.shot.upload"))) : null,
							open ? [
								h(WbBtn, { key: "p", variant: "small", onClick: function () { setResult(row.caseId, "passed"); } }, t("req.case.mark.passed")),
								h(WbBtn, { key: "f", variant: "small", onClick: function () { setResult(row.caseId, "failed"); } }, t("req.case.mark.failed"))
							] : null,
							!open && failed && !row.reflowed ? [
								h(WbBtn, { key: "n", variant: "small", onClick: function () { setAnn({ caseId: row.caseId, shot: null, rect: null }); } }, t("req.ann.add")),
								h(WbBtn, { key: "a", variant: "small", onClick: function () { act(wbWrite(runUrl + "/results/" + encodeURIComponent(row.caseId) + "/accept", "POST")); } }, t("req.case.accept"))
							] : null));
				}));
		}

		/** 画布内的待办列表：不再要求用户进独立「需求」页或左侧菜单。 */
		function WbCanvasInboxModal(props) {
			var t = wbT(props);
			var snap = useWb("/inbox?projectId=" + encodeURIComponent(props.projectId));
			var view = wbInboxView(snap.data);
			var rows = [];
			Object.keys(view.groups).forEach(function (key) {
				view.groups[key].items.forEach(function (item) { rows.push({ group: view.groups[key].label, item: item }); });
			});
			return h(WbModal, { title: t("nav.inbox"), onClose: props.onClose, canvasAnchored: true },
				snap.error ? h(WbState, { error: snap.error, onRetry: function () { wbCache.read("/inbox?projectId=" + encodeURIComponent(props.projectId)); } }) : null,
				rows.length === 0 ? h("div", { className: "daw-wb-state" }, t("inbox.empty")) : rows.map(function (row, index) {
					var item = row.item || {};
					return h("button", { key: String(item.taskId || item.reqId || item.proposalId || index), type: "button", className: "daw-wb-card", onClick: function () { props.onOpen(item); } },
						h("div", { className: "daw-wb-card-head" }, h("b", null, item.subject || item.title || item.taskId || item.reqId || item.proposalId || "")),
						h("div", { className: "daw-wb-note" }, row.group + (item.reason ? " · " + item.reason : "")));
				}));
		}

		/** 需求在设计画布上的产物：原型帧 + 画板；流程图仍回画布本体查看。 */
		function wbRequirementDesignItems(elements, reqId) {
			return (Array.isArray(elements) ? elements : []).filter(function (el) {
				return el && (el.kind === "prototype" || el.kind === "artboard") && wbElementRequirementId(el) === reqId;
			});
		}

		/**
		 * 设计审查区：需求卡/画布审查面板共用。直接复用画布的沙箱画板与原型渲染，
		 * 不另做静态截图；画板的「💬 评论」会把意见发回 Composer。
		 */
		function WbDesignReview(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var reqId = props.reqId;
			var canvasUrl = "/canvas?projectId=" + encodeURIComponent(projectId);
			var commentsUrl = "/design/comments?projectId=" + encodeURIComponent(projectId);
			var canvasSnap = useWb(canvasUrl);
			var packsSnap = useWb("/component-packs");
			var commentsSnap = useWb(commentsUrl);
			var token = react.useSyncExternalStore(toolActivity.subscribe, wbToken, wbToken);
			var elements = canvasSnap.data && Array.isArray(canvasSnap.data.elements) ? canvasSnap.data.elements : [];
			var items = wbRequirementDesignItems(elements, reqId);
			var localSelection = react.useState("");
			var wanted = props.boardId === undefined ? localSelection[0] : props.boardId;
			var selected = items.find(function (el) { return el.id === wanted; }) || items[0];
			var prototype = selected && selected.kind === "prototype";
			var protoState = react.useSyncExternalStore(wbProtoLoader.subscribe, wbProtoLoader.get, wbProtoLoader.get);
			var designState = react.useSyncExternalStore(wbDesignLoader.subscribe, wbDesignLoader.get, wbDesignLoader.get);
			react.useEffect(function () {
				if (selected) (prototype ? wbProtoLoader : wbDesignLoader).load();
			}, [selected, prototype]);
			var noteState = react.useState("");
			function refresh() {
				wbCache.invalidate(canvasUrl);
				wbCache.invalidate(commentsUrl);
				wbCache.invalidate("/projects/" + encodeURIComponent(projectId) + "/requirements");
			}
			function resolveComment(id) {
				wbWrite("/design/comments/resolve", "POST", { projectId: projectId, ids: [id] }).then(function () {
					noteState[1](t("req.design.commentResolved"));
					refresh();
				}).catch(function (error) { noteState[1](String(error && error.message || error)); });
			}
			if (canvasSnap.loading && canvasSnap.data === undefined) return h(WbState, { loading: true });
			if (canvasSnap.error) return h(WbState, { error: canvasSnap.error, onRetry: function () { wbCache.read(canvasUrl); } });
			if (!selected) return h("div", { className: "daw-wb-state", "data-design-review": reqId }, t("req.design.empty"));
			var data = selected.data && typeof selected.data === "object" ? selected.data : {};
			var target = prototype ? "proto:" + selected.id : "board:" + (data.artboardId || selected.id.replace(/^board:/, ""));
			var comments = commentsSnap.data && Array.isArray(commentsSnap.data.comments) ? commentsSnap.data.comments : [];
			comments = comments.filter(function (row) { return row && row.status !== "resolved" && row.target === target; });
			var chunk = prototype ? protoState : designState;
			var body = h("div", { className: "daw-wb-state", role: "status" }, t(chunk.status === "failed" || chunk.status === "unavailable" ? "canvas.design.chatUnavailable" : "common.loading"));
			if (prototype && protoState.lib) {
				var protoPlan = wbProtoLayout(elements, packsSnap.data && Array.isArray(packsSnap.data.packs) ? packsSnap.data.packs : []);
				body = h(protoState.lib.PrototypeNode, { key: selected.id, readOnly: true, fit: true, data: Object.assign({}, data, { packMeta: protoPlan.packMeta }) });
			} else if (!prototype && designState.lib) {
				body = h(designState.lib.DesignArtboardNode, {
					key: selected.id, review: true, maxHeight: 560,
					data: { original: data, projectId: projectId, token: token, labels: { annotate: t("req.review.annotate"), editDirect: t("canvas.design.editDirect"), toolGroup: t("req.review.boardTools") }, onDesignChanged: refresh }
				});
			}
			return h("div", { className: "daw-wb-panel", "data-design-review": reqId },
				h("div", { className: "daw-wb-review-design-hd" },
					items.length > 1 ? h("label", { className: "daw-wb-label" }, t("req.review.chooseBoard"),
						h("select", { className: "daw-wb-select", value: selected.id, onChange: function (event) {
							(props.onBoardChange || localSelection[1])(event.target.value);
						} }, items.map(function (el) { return h("option", { key: el.id, value: el.id }, el.data?.title || el.id); }))) : null,
					typeof props.onOpenElement === "function" ? h(WbBtn, { variant: "quiet", onClick: function () { props.onOpenElement(selected.id); } }, t("req.design.openCanvas")) : null),
				h("div", { className: "daw-wb-design-card", "data-design-id": selected.id }, body),
				comments.length ? h("div", null,
					h("div", { className: "daw-wb-panel-title" }, t("req.design.comments") + " · " + comments.length),
					h("ul", { className: "daw-wb-review-comments" }, comments.map(function (row) {
						return h("li", { key: row.id, "data-comment-id": row.id },
							h("span", null, (row.tag ? row.tag + " · " : "") + (row.line ? "L" + row.line + " · " : "") + row.body),
							h(WbBtn, { variant: "ghost", onClick: function () { resolveComment(row.id); } }, t("req.design.resolve")));
					}))) : null,
				noteState[0] ? h("div", { className: "daw-wb-note", role: "status" }, noteState[0]) : null);
		}

		function WbPrdContent(props) {
			var prd = props.prd || {};
			var t = wbT(props);
			var chunk = react.useSyncExternalStore(wbViewLoader.subscribe, wbViewLoader.get, wbViewLoader.get);
			react.useEffect(function () { if (prd.markdown) wbViewLoader.load(); }, [prd.markdown]);
			var markdown = chunk.status === "ready" && chunk.lib.MiniMarkdown;
			var notion = typeof prd.url === "string" && /^https?:\/\/(?:[^/]+\.)?notion\.(?:so|site)(?:[:/?#]|$)/i.test(prd.url);
			return h("div", { className: "daw-prd-content" },
				prd.file ? (typeof props.openFile === "function"
					? h("button", { type: "button", className: "daw-wb-textbtn", onClick: function () { props.openFile(prd.file); } }, prd.file)
					: h("code", null, prd.file)) : null,
				typeof prd.url === "string" && /^https?:\/\//i.test(prd.url)
					? h("a", { href: prd.url, target: "_blank", rel: "noopener noreferrer", title: prd.url }, notion ? t("req.prd.notion") : prd.url) : null,
				prd.markdown ? (typeof markdown === "function" ? h(markdown, { text: prd.markdown, allowLinks: true }) : h("pre", null, prd.markdown)) : null,
				Array.isArray(props.acceptance) && props.acceptance.length ? h("div", null,
					h("strong", null, t("req.prd.acceptance")),
					h("ul", null, props.acceptance.map(function (point, index) { return h("li", { key: index }, point); }))) : null);
		}

		function WbRequirementPrd(props) {
			var t = wbT(props);
			var view = props.view;
			var prd = view.prd || {};
			var draftState = react.useState(null);
			var busyState = react.useState(false);
			var errorState = react.useState("");
			var draft = draftState[0];
			var projectBase = "/projects/" + encodeURIComponent(props.projectId);
			var refs = useWb(draft && draft.mode !== "markdown" ? projectBase + "/references" : null).data;
			function edit() {
				errorState[1]("");
				draftState[1]({ mode: prd.file ? "file" : prd.url ? "link" : "markdown", file: prd.file || "", url: prd.url || "", markdown: prd.markdown || "", revision: view.revision });
			}
			function change(key, value) {
				draftState[1](function (previous) { return Object.assign({}, previous, { [key]: value }); });
			}
			function save(value, revision) {
				errorState[1]("");
				busyState[1](true);
				wbWrite(props.base, "PATCH", { expectedRevision: revision, prd: value }).then(function () {
					draftState[1](null);
					wbCache.invalidate(props.base);
					wbCache.invalidate(projectBase + "/requirements");
				}).catch(function (error) {
					errorState[1](String(error && error.message || error));
					wbCache.invalidate(props.base);
				}).finally(function () { busyState[1](false); });
			}
			var mode = draft && draft.mode;
			var referenceInput = mode === "file" || mode === "link";
			var referenceKey = mode === "file" ? "file" : "url";
			var referenceRows = refs && (mode === "file" ? refs.files : refs.links);
			var options = Array.isArray(referenceRows) ? referenceRows.map(function (row) { return row && (mode === "file" ? row.path : row.url); })
				.filter(function (value) { return typeof value === "string" && (mode !== "file" || /\.(?:md|markdown)$/i.test(value)); }) : [];
			var listId = "daw-prd-sources-" + view.reqId;
			return h("section", { className: "daw-wb-panel", "data-requirement-prd": view.reqId },
				h("div", { className: "daw-wb-case-actions" },
					h("strong", null, "PRD", view.prd && view.prdRevision ? " · v" + view.prdRevision : ""),
					h("span", { className: "daw-wb-toolfill" }),
					!draft && prd.file ? h(WbBtn, { variant: "ghost", disabled: busyState[0], onClick: function () { save({ file: prd.file }, view.revision); } }, t("req.prd.refresh")) : null,
					!draft ? h(WbBtn, { variant: "ghost", disabled: busyState[0], onClick: edit }, t("req.prd.edit")) : null),
				draft ? h("form", { className: "daw-prd-form", onSubmit: function (event) {
					event.preventDefault();
					var value = mode === "file" ? { file: draft.file.trim() } : mode === "link" ? { url: draft.url.trim(), markdown: draft.markdown } : { markdown: draft.markdown };
					save(value, draft.revision);
				} },
					h("label", null, t("req.prd.mode"),
						h("select", { className: "daw-wb-select", "aria-label": t("req.prd.mode"), value: mode, onChange: function (event) { change("mode", event.target.value); } },
							["markdown", "file", "link"].map(function (key) { return h("option", { key: key, value: key }, t("req.prd." + key)); }))),
					referenceInput ? h("label", null, t("req.prd." + mode),
						h("input", { className: "daw-wb-input", type: mode === "link" ? "url" : "text", list: listId, value: draft[referenceKey], required: true, onChange: function (event) { change(referenceKey, event.target.value); } }),
						h("datalist", { id: listId }, Array.from(new Set(options)).slice(0, 30).map(function (value) { return h("option", { key: value, value: value }); }))) : null,
					mode !== "file" ? h("label", null, t(mode === "link" ? "req.prd.summary" : "req.prd.markdown"),
						h("textarea", { className: "daw-wb-input daw-wb-textarea", value: draft.markdown, required: mode === "markdown", onChange: function (event) { change("markdown", event.target.value); } })) : null,
					h("div", { className: "daw-wb-case-actions" },
						h("button", { type: "submit", className: "daw-wb-btn", disabled: busyState[0] }, t("common.save")),
						h(WbBtn, { variant: "ghost", disabled: busyState[0], onClick: function () { draftState[1](null); errorState[1](""); } }, t("common.cancel"))))
					: view.prd ? h(WbPrdContent, { prd: prd, acceptance: view.acceptance, t: t }) : h("p", { className: "daw-wb-note" }, t("req.prd.empty")),
				errorState[0] ? h("p", { role: "alert", className: "daw-wb-note" }, errorState[0]) : null);
		}

		function WbConfirmedDesign(props) {
			var t = props.t;
			var snap = useWb(props.url);
			var bundle = snap.data && snap.data.bundle;
			var design = react.useSyncExternalStore(wbDesignLoader.subscribe, wbDesignLoader.get, wbDesignLoader.get);
			var proto = react.useSyncExternalStore(wbProtoLoader.subscribe, wbProtoLoader.get, wbProtoLoader.get);
			var packs = useWb(bundle && Object.keys(bundle.snapshot.prototypes).length ? "/component-packs" : null).data;
			var entries = bundle ? bundle.preview.boards.filter(function (board) { return bundle.entries.indexOf(board.id) >= 0; }) : [];
			var chosen = react.useState("");
			var shownBoard = react.useState("");
			var boardId = entries.some(function (board) { return board.id === chosen[0]; }) ? chosen[0] : (entries[0] && entries[0].id);
			var previewDelivery = react.useMemo(function () { return boardId ? Object.assign({}, bundle.preview, { entryId: boardId }) : null; }, [bundle, boardId]);
			react.useEffect(function () {
				if (bundle && bundle.preview.boards.length) wbDesignLoader.load();
				if (bundle && Object.keys(bundle.snapshot.prototypes).length) wbProtoLoader.load();
			}, [bundle]);
			if (!bundle) return h(WbState, { error: snap.error, loading: !snap.error, onRetry: function () { wbCache.read(props.url); } });
			var packMeta = packs && Array.isArray(packs.packs) && packs.packs.find(function (pack) { return pack.id === bundle.packId; });
			return h("div", { className: "daw-wb-panel", "data-confirmed-design": bundle.version },
				typeof props.onEditDesign === "function"
					? h("div", { className: "daw-wb-case-actions" }, h(WbBtn, { variant: "ghost", onClick: function () { props.onEditDesign(shownBoard[0] || boardId); } }, t("req.review.editLive"))) : null,
				bundle.goal ? h("p", null, bundle.goal) : null,
				h(WbPrdContent, { prd: bundle.prd, acceptance: bundle.acceptance, t: t }),
				bundle.prd && bundle.prd.url ? h("p", { className: "daw-wb-note" }, t("req.handoff.external")) : null,
				entries.length > 1 ? h("select", { className: "daw-wb-select", "aria-label": t("canvas.design.artboard"), value: boardId, onChange: function (event) { chosen[1](event.target.value); } },
					entries.map(function (board) { return h("option", { key: board.id, value: board.id }, board.title || board.id); })) : null,
				boardId ? (design.lib && design.lib.DesignChatPreview
					? h(design.lib.DesignChatPreview, { key: boardId, delivery: previewDelivery, onBoardChange: shownBoard[1], backLabel: t("canvas.design.chatBack") })
					: h("p", { role: "status" }, t(design.status === "failed" || design.status === "unavailable" ? "canvas.design.chatUnavailable" : "canvas.design.chatLoading"))) : null,
				Object.entries(bundle.snapshot.prototypes).map(function (entry) {
					return proto.lib && proto.lib.PrototypeNode && packMeta
						? h(proto.lib.PrototypeNode, { key: entry[0], readOnly: true, fit: true, data: Object.assign({}, entry[1], { packMeta: packMeta, projectComponents: bundle.prototypeComponents }) })
						: h("p", { key: entry[0], className: "daw-wb-note" }, entry[1].title || entry[0]);
				}),
				Object.entries(bundle.snapshot.flows).map(function (entry) {
					var flow = entry[1];
					var nodes = Object.fromEntries(flow.nodes.map(function (node) { return [node.key, node.text]; }));
					return h("div", { key: entry[0] },
						h("strong", null, flow.title || entry[0]),
						h("ul", null, (flow.edges.length ? flow.edges.map(function (edge) {
							return (nodes[edge.from] || edge.from) + " → " + (nodes[edge.to] || edge.to) + (edge.label ? " (" + edge.label + ")" : "");
						}) : flow.nodes.map(function (node) { return node.text || node.key; })).map(function (line, index) { return h("li", { key: index }, line); })));
				}),
				bundle.comments.length ? h("div", null, h("strong", null, t("req.design.comments")),
					h("ul", null, bundle.comments.map(function (row) { return h("li", { key: row.id }, row.target + (row.line ? " · L" + row.line : "") + " · " + row.body); }))) : null,
				bundle.sources.missing.length ? h("p", { className: "daw-wb-note" }, t("req.handoff.missing") + " · " + bundle.sources.missing.join("、")) : null);
		}

		function WbRequirementHandoff(props) {
			var t = props.t;
			var view = props.view;
			var projectPath = "/projects/" + encodeURIComponent(view.projectId);
			var route = props.base + "/handoff";
			var versions = view.designVersions || [];
			var head = versions.find(function (version) { return version.v === view.designVersion && version.hasHandoff; });
			var tasks = view.designHandoffs || [];
			var latestTask = head && tasks.find(function (task) { return task.version === head.v; });
			var project = useWb(head || tasks.length ? projectPath : null).data;
			var sessions = useWb(head || tasks.length ? "/sessions" : null).data;
			var token = react.useSyncExternalStore(toolActivity.subscribe, wbToken, wbToken);
			var names = wbMemberNames(project && project.project, sessions);
			var selected = react.useState(null);
			var preview = react.useState(null);
			var busy = react.useState(false);
			var note = react.useState("");
			var pending = view.evidence && view.evidence.reviewPending;
			var retry = latestTask && !latestTask.report && latestTask.dispatch && latestTask.dispatch.status === "failed";
			var target = selected[0] === null && retry ? latestTask.sessionId : selected[0];
			if (!target || !names[target]) target = "";
			function send() {
				busy[1](true);
				note[1]("");
				wbWrite(route, "POST", { version: head.v, sessionId: target }).catch(function (error) {
					note[1](String(error && error.message || error));
				}).finally(function () {
					busy[1](false);
					wbCache.invalidate(props.base);
					wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(view.projectId));
				});
			}
			function renderVersion(row, current) {
				var meta = versions.find(function (version) { return version.v === row.version; });
				var opened = preview[0] === row.version;
				var state = row.dispatch && row.dispatch.status;
				if (state === "sending" && Date.now() - row.dispatch.at > 20000) state = "unknown";
				var progress = row.report && row.report.status;
				var label = progress === "done" || progress === "draft" ? t("req.handoff." + progress)
					: progress ? t("tasks.report." + progress)
					: state === "failed" && row.dispatch.reason === "owner-not-running" ? t("req.handoff.offline")
					: state ? t("req.handoff." + state) : "";
				return h("article", { className: "daw-wb-handoff-card", key: row.version, "data-handoff-version": row.version },
					h("div", { className: "daw-wb-handoff-head" },
						h("div", null,
							h("strong", null, t("req.design", { v: row.version })),
							h("span", { className: "daw-wb-note" }, current ? t("req.review.current") + (meta ? " · " : "") : null,
								meta ? h("span", null, t(meta.prdRevision ? "req.handoff.prd" : "req.handoff.noPrd", { v: meta.prdRevision })) : null)),
						h(WbBtn, { variant: "ghost", onClick: function () { preview[1](opened ? null : row.version); } }, t(opened ? "req.handoff.hide" : "req.handoff.preview"))),
					row.sessionId ? h("div", { className: "daw-wb-handoff-person" },
						h("span", null, names[row.sessionId] || row.sessionId),
						label ? h("span", { role: "status" }, h(WbChip, { tone: progress === "done" ? "ok" : state === "failed" || state === "unknown" ? "warn" : "neutral" }, label)) : null,
						typeof props.onOpenSession === "function" ? h(WbBtn, { variant: "ghost", onClick: function () { props.onOpenSession(row.sessionId); } }, t("chat.open")) : null) : null,
					row.report && row.report.summary ? h("p", { className: "daw-prd-content" }, row.report.summary) : null,
					row.report && row.report.artifacts && row.report.artifacts.length ? h("ul", { className: "daw-wb-handoff-files" }, row.report.artifacts.map(function (artifact, index) {
						return h("li", { key: index }, artifact.kind === "url" && /^https?:\/\//i.test(artifact.ref)
							? h("a", { href: artifact.ref, target: "_blank", rel: "noopener noreferrer" }, artifact.note || artifact.ref)
							: h(react.Fragment, null, h("code", null, artifact.ref), artifact.note ? " · " + artifact.note : ""));
					})) : null,
					opened && token ? h(WbConfirmedDesign, { t: t, url: route + "/" + row.version, onEditDesign: props.onEditDesign }) : null);
			}
			var history = tasks.filter(function (row) { return !head || row.version !== head.v; });
			return h("section", { className: "daw-wb-panel", "data-frontend-handoff": view.reqId },
				h("div", { className: "daw-wb-panel-title" }, t("req.handoff.title")),
				!head && tasks.length === 0 ? h("p", { className: "daw-wb-note" }, t("req.review.noHandoff")) : null,
				pending ? h("div", { className: "daw-wb-banner", "data-tone": "warn", role: "status" }, t("req.handoff.pending")) : null,
				head && !pending && (!latestTask || retry) ? h("div", { className: "daw-wb-handoff-form" },
					h("label", { className: "daw-wb-label" }, t("req.handoff.pick"),
						h("select", { className: "daw-wb-select", value: target, disabled: busy[0], onChange: function (event) { selected[1](event.target.value); } },
							[h("option", { key: "", value: "" }, "—")].concat(Object.keys(names).map(function (id) { return h("option", { key: id, value: id }, names[id]); })))),
					h(WbBtn, { disabled: target === "" || busy[0] || !token, onClick: send }, t(busy[0] ? "req.handoff.sending" : retry ? "req.handoff.retry" : "req.handoff.send"))) : null,
				note[0] ? h("p", { role: "alert", className: "daw-wb-note" }, note[0]) : null,
				head ? renderVersion(latestTask || { version: head.v }, true) : null,
				history.length ? h("details", { className: "daw-wb-handoff-history" },
					h("summary", null, t("req.review.history", { n: history.length })),
					history.map(function (row) { return renderVersion(row, false); })) : null);
		}

		/** 画布内的需求审查面板：PRD、设计预览、评论、确认设计和 E2E。 */
		function WbRequirementCanvasPanel(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var reqId = props.reqId;
			var base = "/projects/" + encodeURIComponent(projectId) + "/requirements/" + encodeURIComponent(reqId);
			var snap = useWb(base);
			var runsSnap = useWb(base + "/e2e");
			var view = snap.data && snap.data.requirement ? snap.data.requirement : null;
			var runs = runsSnap.data && Array.isArray(runsSnap.data.runs) ? runsSnap.data.runs : [];
			var actions = wbRequirementActions(view, runs);
			var section = react.useState(props.initialTab || "prd");
			var selectedBoard = react.useState("");
			var busyState = react.useState(false);
			var noteState = react.useState("");
			var runNoteState = react.useState("");
			var nav = react.useRef(null);
			var panelKey = "daw-review-" + (typeof react.useId === "function" ? react.useId() : reqId);
			function runWrite(path, body, after) {
				busyState[1](true);
				noteState[1]("");
				wbWrite(path, "POST", body).then(function () {
					busyState[1](false);
					wbCache.invalidate(base);
					wbCache.invalidate(base + "/e2e");
					wbCache.invalidate("/projects/" + encodeURIComponent(projectId) + "/requirements");
					wbCache.invalidate("/inbox");
					if (typeof after === "function") after();
				}).catch(function (error) { busyState[1](false); noteState[1](String(error && error.message || error)); });
			}
			if (snap.error) return h(WbState, { error: snap.error, onRetry: function () { wbCache.read(base); } });
			if (!view) return h(WbState, { loading: true });
			var tabs = [
				{ id: "design", label: t("req.review.design") },
				{ id: "prd", label: "PRD" },
				{ id: "handoff", label: t("req.review.handoff") },
				{ id: "testing", label: t("req.review.testing") }
			].filter(function (tab) { return !view.virtual || tab.id === "design" || tab.id === "testing"; });
			var active = tabs.some(function (tab) { return tab.id === section[0]; }) ? section[0] : tabs[0].id;
			function changeTab(id, focus) {
				section[1](id);
				if (focus) nav.current?.querySelector('[data-review-tab="' + id + '"]')?.focus();
			}
			function onTabKey(event, index) {
				var move = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
				if (!Object.hasOwn(move, event.key)) return;
				event.preventDefault();
				changeTab(tabs[move[event.key]].id, true);
			}
			function openLiveDesign(boardId) {
				if (boardId) selectedBoard[1]("board:" + boardId);
				changeTab("design", true);
			}
			function tabPanel(id, content) {
				return h("div", {
					id: panelKey + "-" + id, role: "tabpanel", "aria-labelledby": panelKey + "-tab-" + id,
					className: "daw-wb-review-body", tabIndex: 0, hidden: active !== id
				}, content);
			}
			return h("div", { className: "daw-wb-design-review" },
				h("div", { className: "daw-wb-review-nav" },
					h("div", { className: "daw-wb-review-meta" },
						h(WbChip, { tone: view.tone === "info" ? "brand" : view.tone === "bad" ? "danger" : view.tone }, view.stageLabel || view.stage),
						view.next ? h("span", { className: "daw-wb-note" }, view.next) : null),
					h("div", { ref: nav, className: "daw-wb-review-tabs", role: "tablist", "aria-label": t("req.title") }, tabs.map(function (tab, index) {
						return h("button", {
							key: tab.id, id: panelKey + "-tab-" + tab.id, type: "button", role: "tab", tabIndex: active === tab.id ? 0 : -1, "data-review-tab": tab.id,
							"aria-selected": active === tab.id, "aria-controls": panelKey + "-" + tab.id,
							onKeyDown: function (event) { onTabKey(event, index); }, onClick: function () { changeTab(tab.id); }
						}, tab.label);
					}))),
				tabPanel("design", active === "design" ? h(WbDesignReview, {
					t: t, projectId: projectId, reqId: reqId, onOpenElement: props.onOpenElement, boardId: selectedBoard[0], onBoardChange: selectedBoard[1]
				}) : null),
				view.virtual ? null : tabPanel("prd", h(WbRequirementPrd, { key: reqId, view: view, projectId: projectId, base: base, t: t })),
				view.virtual ? null : tabPanel("handoff", h(WbRequirementHandoff, {
					key: reqId, t: t, view: view, base: base, onOpenSession: props.onOpenSession, onEditDesign: openLiveDesign
				})),
				tabPanel("testing", active !== "testing" ? null : h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("req.section.e2e") + "（" + runs.length + "）"),
					h("div", { className: "daw-wb-case-actions" },
						h(WbBtn, { disabled: busyState[0] || !actions.startRun, onClick: function () { runWrite(base + "/e2e", {}); } }, t("req.run.start")),
						h(WbBtn, { variant: "ghost", disabled: busyState[0] || !actions.reflow || actions.reworkLimit, onClick: function () { runWrite("/projects/" + encodeURIComponent(projectId) + "/e2e/" + encodeURIComponent(actions.latestRunId) + "/reflow", {}); } }, t("req.reflow"))),
					runNoteState[0] ? h("div", { className: "daw-wb-note", role: "status" }, runNoteState[0]) : null,
					runs.length === 0 ? h("div", { className: "daw-wb-note" }, t("req.run.none")) : runs.slice(0, 3).map(function (item) { return h(WbReqRunCard, { key: item.runId, run: item, projectId: projectId, reqId: reqId, t: t, onNote: runNoteState[1] }); }))),
				noteState[0] ? h("div", { className: "daw-wb-banner", "data-tone": "warn", role: "alert" }, noteState[0]) : null,
				view.virtual || !actions.confirmDesign ? null : h("footer", { className: "daw-wb-review-confirm" },
					h("span", { className: "daw-wb-note" }, view.designVersion > 0 ? t("req.design", { v: view.designVersion }) : t("req.design.none")),
					h(WbBtn, {
						disabled: busyState[0],
						onClick: function () { runWrite(base + "/confirm-design", { expectedRevision: view.revision }, function () { changeTab("handoff", true); }); }
					}, t("req.design.confirm"))));
		}

		function WbReqDetail(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var base = "/projects/" + encodeURIComponent(projectId) + "/requirements/" + encodeURIComponent(props.reqId);
			var snap = useWb(base);
			var runsSnap = useWb(base + "/e2e");
			var view = snap.data && snap.data.requirement ? snap.data.requirement : null;
			var summaries = runsSnap.data && Array.isArray(runsSnap.data.runs) ? runsSnap.data.runs : [];
			var detailProject = useWb("/projects/" + encodeURIComponent(projectId));
			var detailSessions = useWb("/sessions");
			var memberNames = wbMemberNames(detailProject.data && detailProject.data.project ? detailProject.data.project : null, detailSessions.data);
			var noteState = react.useState("");
			var note = noteState[0];
			var setNote = noteState[1];
			var openRun = summaries.filter(function (run) { return run.status === "queued" || run.status === "running"; })[0];
			var shownIds = summaries.slice(0, 3).map(function (run) { return run.runId; });
			var run1 = useWb(shownIds[0] ? "/projects/" + encodeURIComponent(projectId) + "/e2e/" + encodeURIComponent(shownIds[0]) : null);
			var run2 = useWb(shownIds[1] ? "/projects/" + encodeURIComponent(projectId) + "/e2e/" + encodeURIComponent(shownIds[1]) : null);
			var run3 = useWb(shownIds[2] ? "/projects/" + encodeURIComponent(projectId) + "/e2e/" + encodeURIComponent(shownIds[2]) : null);
			var runs = [run1, run2, run3].map(function (item) { return item.data && item.data.run ? item.data.run : null; }).filter(function (run) { return run !== null; });
			var actions = wbRequirementActions(view, summaries);
			function refresh() {
				wbCache.invalidate(base);
				wbCache.invalidate(base + "/e2e");
				// 回流 / 结束运行会改动运行详情本身（批注已回流、用例标记），详情页里展示的每条运行都要重取，
				// 否则界面还显示「删除」按钮而宿主里这条批注早已回流（2026-11-19 真机发现）。
				shownIds.forEach(function (id) { wbCache.invalidate("/projects/" + encodeURIComponent(projectId) + "/e2e/" + encodeURIComponent(id)); });
				wbCache.invalidate("/projects/" + encodeURIComponent(projectId) + "/requirements");
				wbCache.invalidate("/inbox");
				wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId));
			}
			function run(promise) {
				return promise.then(function () { setNote(""); refresh(); }).catch(function (error) { setNote(error && error.message ? error.message : String(error)); });
			}
			if (view === null) {
				return h(WbState, { loading: snap.loading && snap.data === undefined, error: snap.error, onRetry: function () { wbCache.read(base); } }, h("div", { className: "daw-wb-state" }, t("common.none")));
			}
			var rev = view.revision;
			return h(WbPage, {
				title: view.virtual ? t("req.virtual.title") : view.title,
				desc: view.goal || (view.virtual ? t("req.virtual.hint") : ""),
				actions: h(WbBtn, { variant: "ghost", onClick: props.onBack }, t("req.back"))
			},
				h("div", { className: "daw-wb-req-head" },
					h(WbChip, { tone: view.tone === "info" ? "brand" : view.tone === "bad" ? "danger" : view.tone }, view.virtual ? t("req.virtual") : t("req.stage." + view.stage)),
					view.attention ? h("span", { className: "daw-wb-req-attn" }, t("req.attention." + view.attention)) : null,
					h("span", { className: "daw-wb-note" }, t("req.next") + "：" + view.next)),
				note !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "warn", role: "alert" }, note) : null,
				view.virtual ? null : h(WbRequirementPrd, { key: props.reqId, view: view, projectId: projectId, base: base, t: t }),
				view.virtual ? null : h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("req.owner")),
					h("select", { className: "daw-wb-select", "data-owner-select": "", "aria-label": t("req.owner"), value: view.ownerSessionId || "", onChange: function (event) { run(wbWrite(base, "PATCH", { expectedRevision: rev, ownerSessionId: event.target.value })); } },
						[h("option", { key: "", value: "" }, t("req.owner.none"))].concat(Object.keys(memberNames).map(function (id) { return h("option", { key: id, value: id }, memberNames[id]); }))),
					h("div", { className: "daw-wb-note" }, t("req.owner.hint"))),
				view.virtual ? null : h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("req.section.design")),
					h("div", { className: "daw-wb-note" }, view.designVersion > 0 ? t("req.design", { v: view.designVersion }) : t("req.design.none")),
					h("div", { className: "daw-wb-case-actions" },
						h(WbBtn, { disabled: !actions.confirmDesign, onClick: function () { run(wbWrite(base + "/confirm-design", "POST", { expectedRevision: rev })); } }, t("req.design.confirm")),
						h(WbBtn, { variant: "ghost", onClick: function () { wbRoute.project(projectId, "canvas"); } }, t("req.design.open")))),
				view.virtual ? null : h(WbRequirementHandoff, { key: props.reqId, t: t, view: view, base: base, onOpenSession: props.onOpenSession }),
				view.virtual ? null : h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("req.section.e2e") + "（" + summaries.length + "）"),
					actions.reworkLimit ? h("div", { className: "daw-wb-banner", "data-tone": "warn" }, t("req.limit", { n: view.reworkCount, cap: view.reworkCap })) : null,
					h("div", { className: "daw-wb-case-actions" },
						h(WbBtn, { disabled: !actions.startRun, onClick: function () { run(wbWrite(base + "/e2e", "POST", {})); } }, t("req.run.start")),
						h(WbBtn, { variant: "ghost", disabled: !actions.reflow || actions.reworkLimit, onClick: function () { run(wbWrite("/projects/" + encodeURIComponent(projectId) + "/e2e/" + encodeURIComponent(actions.latestRunId) + "/reflow", "POST", {})); } }, t("req.reflow"))),
					summaries.length === 0 ? h("div", { className: "daw-wb-note" }, t("req.run.none")) : null,
					runs.map(function (item) { return h(WbReqRunCard, { key: item.runId, run: item, projectId: projectId, reqId: props.reqId, t: t, onNote: setNote }); })));
		}

		function WbReqsPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var url = "/projects/" + encodeURIComponent(projectId) + "/requirements";
			var snap = useWb(url);
			var allRows = wbRequirementRows(snap.data);
			var projectSnap = useWb("/projects/" + encodeURIComponent(projectId));
			var sessionsSnap = useWb("/sessions");
			var names = wbMemberNames(projectSnap.data && projectSnap.data.project ? projectSnap.data.project : null, sessionsSnap.data);
			var ownerState = react.useState("all");
			var ownerOptions = wbOwnerFilterOptions(allRows, names);
			// 选中的负责人如果不在选项里了（比如他的需求都被改走了），回落成「全部」，别把人困在一个空列表里。
			var ownerKey = ownerOptions.some(function (option) { return option.key === ownerState[0]; }) ? ownerState[0] : "all";
			var ownerRows = wbRequirementByOwner(allRows, ownerKey);
			var filterState = react.useState("all");
			var filterKey = WB_REQ_FILTERS.indexOf(filterState[0]) >= 0 ? filterState[0] : "all";
			var filterCounts = wbRequirementFilterCounts(ownerRows);
			var rows = wbRequirementFilter(ownerRows, filterKey);
			var pickState = react.useState("");
			var picked = pickState[0];
			var setPicked = pickState[1];
			var nameState = react.useState("");
			var name = nameState[0];
			var setName = nameState[1];
			var errState = react.useState("");
			var err = errState[0];
			var setErr = errState[1];
			function create() {
				var title = name.trim();
				if (title === "") return;
				wbWrite(url, "POST", { title: title }).then(function (data) {
					setName(""); setErr("");
					wbCache.invalidate(url);
					if (data && data.requirement) setPicked(data.requirement.reqId);
				}).catch(function (error) { setErr(t("req.new.fail", { reason: error && error.message ? error.message : String(error) })); });
			}
			if (picked !== "") return h(WbReqDetail, { t: t, projectId: projectId, reqId: picked, onOpenSession: props.onOpenSession, onBack: function () { setPicked(""); } });
			return h(WbPage, { title: t("req.title"), desc: t("req.page.desc") },
				h(WbE2eConfigPanel, { t: t, projectId: projectId }),
				h("div", { className: "daw-wb-case-actions" },
					h("input", { className: "daw-wb-input", value: name, placeholder: t("req.new.name"), onChange: function (event) { setName(event.target.value); }, onKeyDown: function (event) { if (event && event.key === "Enter") create(); } }),
					h(WbBtn, { disabled: name.trim() === "", onClick: create }, t("req.new"))),
				err !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "warn", role: "alert" }, err) : null,
				ownerOptions.length > 2 ? h("div", { className: "daw-wb-filters" },
					h("select", { className: "daw-wb-select daw-wb-owner-filter", "data-owner-filter": "", "aria-label": t("req.filter.owner.title"), title: t("req.filter.owner.title"), value: ownerKey, onChange: function (event) { ownerState[1](event.target.value); } },
						ownerOptions.map(function (option) {
							var label = option.key === "all" ? t("req.filter.owner.all") : option.key === "none" ? t("req.filter.owner.none") : option.label;
							return h("option", { key: option.key, value: option.key }, label + " " + option.count);
						}))) : null,
				allRows.length > 0 ? h("div", { className: "daw-wb-filters", role: "group", "aria-label": t("req.filter.title") },
					WB_REQ_FILTERS.map(function (key) {
						return h("button", { key: key, type: "button", className: "daw-wb-zoombtn", "data-on": String(filterKey === key), "data-filter": key, onClick: function () { filterState[1](key); } },
							t("req.filter." + key) + " " + filterCounts[key]);
					})) : null,
				h(WbState, { loading: snap.loading && snap.data === undefined, error: snap.error, onRetry: function () { wbCache.read(url); } },
					rows.length === 0 ? h("div", { className: "daw-wb-state" }, allRows.length === 0 ? t("req.empty") : t("req.filter.empty")) : h("div", { className: "daw-wb-grid" }, rows.map(function (row) {
						return h("button", { key: row.reqId, type: "button", className: "daw-wb-card", "data-attention": row.attention, onClick: function () { setPicked(row.reqId); } },
							h("div", { className: "daw-wb-card-head" },
								h(WbChip, { tone: row.tone }, row.virtual ? t("req.virtual") : t("req.stage." + row.stage)),
								h("span", { className: "daw-wb-card-title" }, row.virtual ? t("req.virtual.title") : row.title),
								row.attention !== "" ? h("span", { className: "daw-wb-req-attn" }, t("req.attention." + row.attention)) : null),
							h("div", { className: "daw-wb-meta" }, h("span", null, t("req.meta", { done: row.tasksDone, total: row.tasks, protos: row.prototypes }))),
							row.virtual ? null : h("div", { className: "daw-wb-note", "data-owner": row.ownerSessionId }, row.ownerSessionId !== "" ? t("req.owner.set", { name: names[row.ownerSessionId] || row.ownerSessionId.slice(0, 12) }) : t("req.owner.unset")),
							row.next !== "" ? h("div", { className: "daw-wb-card-note" }, t("req.next") + "：" + row.next) : null);
					}))),
				// 项目简报（原「简报」页签）：并入需求页底部。简报仍是项目级的一份——「每个需求一份」没有做（见重规划文档）。
				h(WbBriefPage, { t: t, projectId: projectId, embedded: true }));
		}
		/**
		 * 任务页把项目任务表与执行状态放在一起。
		 */
		function WbTablePage(props) {
			var t = wbT(props);
			return h("div", { className: "daw-wb-stack", "data-table-page": "" },
				h(WbTasksPage, { t: t, projectId: props.projectId, embedded: true }),
				h(WbExecPage, { t: t, projectId: props.projectId, onOpenSession: props.onOpenSession, embedded: true }));
		}

		// ── U-3 项目任务（M6-3）─────────────────────────────────────────────────

		function wbUuid() {
			if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
			return "wb-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
		}

		function wbTaskCommand(projectId, taskId, action, extra) {
			var body = Object.assign({ projectId: projectId, requestId: wbUuid(), action: action }, extra || {});
			return wbApi("/tasks/" + encodeURIComponent(taskId) + "/commands", { method: "POST", body: body }).then(wbUnwrap);
		}

		function wbReportTone(status) {
			if (status === "done") return "ok";
			if (status === "draft") return "neutral";
			if (status === "handed_back") return "warn";
			if (status === "human_action") return "danger";
			return "neutral";
		}

		/** 六步 key → 文案键（设计稿 T-13：Source → Trigger → Policy → Ticket → Worker → Report）。 */
		var WB_TIMELINE_STEPS = [
			{ key: "source", name: "replay.step.source" },
			{ key: "trigger", name: "replay.step.trigger" },
			{ key: "policy", name: "replay.step.policy" },
			{ key: "ticket", name: "replay.step.ticket" },
			{ key: "worker", name: "replay.step.worker" },
			{ key: "report", name: "replay.step.report" }
		];

		/**
		 * 时间线视图：把宿主回的 steps 补齐成固定六步（缺的步补 pending，未知 key 追加在尾部），
		 * 明细流水按 at 倒序。宿主少给/多给都不能让 UI 缺环或乱序。
		 */
		function wbTimelineView(data) {
			var steps = data && Array.isArray(data.steps) ? data.steps : [];
			var byKey = {};
			steps.forEach(function (step) {
				if (step && typeof step.key === "string") byKey[step.key] = step;
			});
			var ordered = WB_TIMELINE_STEPS.map(function (meta) {
				var step = byKey[meta.key];
				return {
					key: meta.key,
					name: meta.name,
					state: step && typeof step.state === "string" ? step.state : "pending",
					phase: step && typeof step.phase === "string" ? step.phase : "",
					at: step && typeof step.at === "number" ? step.at : 0,
					until: step && typeof step.until === "number" ? step.until : 0,
					title: step && typeof step.title === "string" ? step.title : "",
					detail: step && typeof step.detail === "string" ? step.detail : "",
					evidence: step && typeof step.evidence === "string" ? step.evidence : ""
				};
			});
			// 宿主将来源书新增的步（不存在的 key）追加在尾部，不丢事实
			steps.forEach(function (step) {
				if (!step || typeof step.key !== "string") return;
				var known = WB_TIMELINE_STEPS.some(function (meta) { return meta.key === step.key; });
				if (known) return;
				ordered.push({
					key: step.key, name: "replay.step.extra", state: String(step.state || "pending"),
					phase: String(step.phase || ""), at: typeof step.at === "number" ? step.at : 0,
					until: typeof step.until === "number" ? step.until : 0, title: String(step.title || ""),
					detail: String(step.detail || ""), evidence: String(step.evidence || "")
				});
			});
			var entries = data && Array.isArray(data.entries) ? data.entries.slice() : [];
			entries.sort(function (left, right) { return (right.at || 0) - (left.at || 0); });
			return { steps: ordered, entries: entries };
		}

		function wbTimelineStateTone(state) {
			if (state === "done") return "ok";
			if (state === "active") return "brand";
			return "neutral";
		}

		/** 任务过程弹层（T-13）：六步时间线 + observations + 明细流水。只挂任务卡详情，不占导航。 */
		function WbTaskReplayModal(props) {
			var t = wbT(props);
			var task = props.task;
			var projectId = props.projectId;
			var url = "/tasks/" + encodeURIComponent(task.taskId) + "/timeline?projectId=" + encodeURIComponent(projectId);
			var obsUrl = "/tasks/" + encodeURIComponent(task.taskId) + "/observations?projectId=" + encodeURIComponent(projectId);
			var snap = useWb(url);
			var obsSnap = useWb(obsUrl);
			var view = wbTimelineView(snap.data);
			var obs = obsSnap.data || null;
			return h(WbModal, {
				title: t("replay.title", { subject: task.subject || task.taskId }),
				onClose: props.onClose,
				t: t,
				footer: h(WbBtn, { variant: "ghost", onClick: function () { wbCache.read(url); wbCache.read(obsUrl); } }, t("common.refresh"))
			},
				h(WbState, { loading: snap.loading && snap.data === undefined, error: snap.error, onRetry: function () { wbCache.read(url); } },
					view.steps.length === 0
						? h("div", { className: "daw-wb-state" }, t("replay.empty"))
						: h("div", { className: "daw-wb-timeline" },
							view.steps.map(function (step, index) {
								return h("div", { key: step.key + ":" + index, className: "daw-wb-tl-step", "data-state": step.state },
									h("div", { className: "daw-wb-tl-rail" },
										h("span", { className: "daw-wb-tl-dot" }),
										h("span", { className: "daw-wb-tl-line" })),
									h("div", { className: "daw-wb-tl-body" },
										h("div", { className: "daw-wb-tl-head" },
											h("span", { className: "daw-wb-tl-name" }, t(step.name)),
											h("span", { className: "daw-wb-tl-when" },
												(step.phase ? step.phase + " · " : "") +
												(step.at ? wbFormatClock(step.at) : "") +
												(step.until ? " → " + wbFormatClock(step.until) : "")),
											h(WbChip, { tone: wbTimelineStateTone(step.state) }, t("replay.state." + step.state))),
										step.title ? h("div", { className: "daw-wb-tl-text" }, step.title) : null,
										step.detail ? h("div", { className: "daw-wb-tl-text", title: step.detail }, step.detail) : null,
										step.evidence ? h("div", { className: "daw-wb-tl-obs" }, h("span", null, step.evidence)) : null));
							}))),
				obs !== null && obs.current
					? h("div", { className: "daw-wb-banner", "data-tone": "ok" },
						t("replay.obs.current", { tool: obs.current.tool, elapsed: wbElapsed(obs.current.ageMs) }))
					: null,
				obs !== null && obs.counts
					? h("div", { className: "daw-wb-tl-obs" },
						h("span", null, t("replay.obs.commands", { count: obs.counts.commands || 0 })),
						h("span", null, t("replay.obs.files", { count: obs.counts.files || 0 })),
						h("span", { className: "daw-wb-note", title: t("replay.obs.note") }, t("replay.obs.note")))
					: null,
				obs !== null && obs.note ? h("div", { className: "daw-wb-note" }, obs.note) : null,
				view.entries.length > 0
					? h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("replay.entries")),
						h("div", { className: "daw-wb-tl-entries" },
							view.entries.map(function (entry, index) {
								return h("div", { key: index, className: "daw-wb-tl-entry" },
									h("time", null, entry.at ? wbFormatClock(entry.at) : ""),
									h("span", null, (entry.kind ? entry.kind + " · " : "") + (entry.text || "") + (entry.evidence ? " · " + entry.evidence : "") + (entry.by ? " · " + entry.by : "")));
							})))
					: null,
				h("div", { className: "daw-wb-note" }, t("replay.foot")));
		}

		function WbTasksPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var tasksSnap = useWb("/tasks?projectId=" + encodeURIComponent(projectId));
			var projectSnap = useWb("/projects/" + encodeURIComponent(projectId));
			var sessionsSnap = useWb("/sessions");
			var filterState = react.useState("all");
			var filter = filterState[0];
			var rows = tasksSnap.data && Array.isArray(tasksSnap.data.tasks) ? tasksSnap.data.tasks : [];
			var byId = {};
			rows.forEach(function (row) { byId[row.taskId] = row; });
			var views = rows.map(function (row) { return wbTaskRowView(row, byId); });
			var members = projectSnap.data && projectSnap.data.project ? (projectSnap.data.project.members || []) : [];
			var sessionRows = wbSessionRows(sessionsSnap.data && sessionsSnap.data.sessions ? { byId: indexById(sessionsSnap.data.sessions) } : undefined);
			var modalState = react.useState(null);
			var replayState = react.useState(null);
			var modal = modalState[0];
			var setModal = modalState[1];
			var busyState = react.useState("");
			var hintState = react.useState("");
			var busy = busyState[0];
			var hint = hintState[0];
			var errorState = react.useState("");
			var error = errorState[0];

			var counts = {
				all: views.length,
				pending: views.filter(function (row) { return row.status === "pending"; }).length,
				in_progress: views.filter(function (row) { return row.status === "in_progress"; }).length,
				completed: views.filter(function (row) { return row.status === "completed"; }).length,
				blocked: views.filter(function (row) { return row.status === "pending" && row.blockedReason !== undefined; }).length
			};
			var shown = views.filter(function (row) {
				if (filter === "all") return row.status !== "deleted";
				if (filter === "blocked") return row.status === "pending" && row.blockedReason !== undefined;
				return row.status === filter;
			});

			function run(action, task, extra) {
				busyState[1](task.taskId + ":" + action);
				errorState[1]("");
				hintState[1]("");
				wbTaskCommand(projectId, task.taskId, action, extra)
					.then(function (result) {
						// Q4：规划时提示只提示、不拦截。没有 hint 就不显示（不制造噪音）。
						if (result && typeof result.scopeOrderHint === "string" && result.scopeOrderHint !== "") hintState[1](result.scopeOrderHint);
						wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); wbCache.invalidate("/inbox"); busyState[1](""); setModal(null);
					})
					.catch(function (failure) { errorState[1](failure.message); busyState[1](""); });
			}

			return h(props.embedded ? WbSection : WbPage, {
				title: t("tab.tasks"),
				desc: t("tab.note.tasks"),
				actions: h(WbBtn, { onClick: function () { setModal({ kind: "create" }); } }, t("tasks.new"))
			},
				h("div", { className: "daw-wb-toolbar" },
					["all", "pending", "in_progress", "completed", "blocked"].map(function (key) {
						return h("button", {
							key: key,
							type: "button",
							className: "daw-wb-filter",
							"data-on": String(filter === key),
							onClick: function () { filterState[1](key); }
						}, t("tasks.filter." + key), h("b", null, String(counts[key])));
					})),
				error !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "danger" }, error) : null,
				// Q4：规划时提示（写入范围重叠且无先后顺序 → 建议补依赖）。warn，只提示不拦。
				hint !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "warn" }, hint) : null,
				h(WbState, { loading: tasksSnap.loading && rows.length === 0, error: tasksSnap.error, onRetry: function () { wbCache.read("/tasks?projectId=" + encodeURIComponent(projectId)); }, onExit: function () { wbRoute.set({ kind: "list" }); } },
					h("div", { className: "daw-wb-table" },
						h("div", { className: "daw-wb-tr", "data-head": "true" },
							h("span", { className: "daw-wb-td daw-wb-td-task" }, t("tasks.col.task")),
							h("span", { className: "daw-wb-td daw-wb-td-owner" }, t("tasks.col.owner")),
							h("span", { className: "daw-wb-td daw-wb-td-dep" }, t("tasks.col.blockedBy")),
							h("span", { className: "daw-wb-td daw-wb-td-where" }, t("tasks.col.worktree")),
							h("span", { className: "daw-wb-td daw-wb-td-report" }, t("tasks.col.report")),
							h("span", { className: "daw-wb-td daw-wb-td-status" }, t("tasks.col.status")),
							h("span", { className: "daw-wb-td daw-wb-td-actions" })),
						shown.length === 0
							? h("div", { className: "daw-wb-tr" }, h("span", { className: "daw-wb-note" }, t("event.empty")))
							: shown.map(function (row) {
								var owner = sessionRows.filter(function (session) { return session.sessionId === row.ownerSessionId; })[0];
								var ownerName = owner ? owner.title : (row.ownerSessionId ? String(row.ownerSessionId).slice(0, 12) : t("common.none"));
								var dep = row.blockedBy.length === 0 ? t("common.none")
									: row.blockedBy.map(function (id) {
										var blocker = byId[id];
										if (blocker === undefined) return id + "（" + t("tasks.blocked.deleted") + "）";
										if (blocker.status === "deleted") return (blocker.subject || id) + "（" + t("tasks.blocked.deleted") + "）";
										if (blocker.status !== "completed") return (blocker.subject || id) + "（" + t("tasks.blocked.wait") + "）";
										return blocker.subject || id;
									}).join("、");
								var statusTone = row.status === "completed" ? "ok" : row.status === "in_progress" ? "brand" : row.blockedReason !== undefined ? "danger" : "neutral";
								return h("div", { key: row.taskId, className: "daw-wb-tr" },
									h("span", { className: "daw-wb-td daw-wb-td-task" }, row.subject || row.taskId),
									h("span", { className: "daw-wb-td daw-wb-td-owner" }, ownerName),
									h("span", { className: "daw-wb-td daw-wb-td-dep", title: dep }, dep),
									h("span", { className: "daw-wb-td daw-wb-td-where" }, row.worktree || row.execRoot || t("common.none")),
									h("span", { className: "daw-wb-td daw-wb-td-report" },
										row.report === null
											? h("span", { className: "daw-wb-note" }, t("common.none"))
											: h(WbChip, { tone: wbReportTone(row.report.status), title: row.report.summary }, t("tasks.report." + row.report.status) + " · rev " + row.report.rev),
										// Q3：已核对（人工，独立字段）与评审已报通过（次信号，执行器报的）分开说
										wbVerifiedView(row).verified
											? h(WbChip, { tone: "ok", title: t("tasks.verify.by", { by: wbVerifiedView(row).by }) }, t("tasks.verify.done"))
											: (wbReviewSignal(row, rows).reviewed
												? h(WbChip, { tone: "neutral", title: t("tasks.verify.reviewed.title", { task: wbReviewSignal(row, rows).byTaskId }) }, t("tasks.verify.reviewed"))
												: null)),
									h("span", { className: "daw-wb-td daw-wb-td-status" },
										h(WbChip, { tone: statusTone }, t("tasks.status." + row.status))),
									h("span", { className: "daw-wb-td daw-wb-td-actions" },
										!row.designHandoff && row.status === "completed"
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { run("reopen", row, { expectedRevision: row.revision }); } }, t("tasks.action.reopen"))
													: null,
										!row.designHandoff && row.status !== "completed" && row.ownerSessionId === null
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { setModal({ kind: "assign", task: row }); } }, t("tasks.action.assign"))
													: null,
										!row.designHandoff && row.status !== "completed" && row.ownerSessionId !== null
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { run("unassign", row, { expectedRevision: row.revision }); } }, t("tasks.action.unassign"))
													: null,
										!row.designHandoff && row.status !== "completed" && row.ownerSessionId !== null
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { run("dispatch", row, {}); } }, t("tasks.action.dispatch"))
													: null,
										// Q3：人工核对入口。只有主对话能核（宿主侧也校验），所以这里无条件显示，
									// 被拒时 banner 会说明原因；已核对过就换成再核（覆盖，备注可改）。
									row.report !== null && row.report.status === "done"
										? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { run("verify", row, { expectedRevision: row.revision, note: "" }); } }, t("tasks.action.verify"))
										: null,
									h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { setModal({ kind: "report", task: row }); } }, t("tasks.action.report")),
										h(WbBtn, { variant: "ghost", disabled: busy !== "", title: t("replay.open"), onClick: function () { setModal({ kind: "report", task: row }); replayState[1](row); } }, t("replay.open"))));
							}))),
				h("div", { className: "daw-wb-toolbar" },
					h("span", { className: "daw-wb-note" }, t("tasks.report.note"))),
				modal !== null && modal.kind === "assign"
					? h(WbAssignModal, { t: t, task: modal.task, members: members, sessions: sessionRows, busy: busy !== "", onClose: function () { setModal(null); }, onAssign: function (owner, dispatch) { run(dispatch ? "assign-and-dispatch" : "assign", modal.task, { owner: owner, expectedRevision: modal.task.revision }); } })
					: null,
				modal !== null && modal.kind === "report"
					? h(WbReportModal, { t: t, task: modal.task, busy: busy !== "", onClose: function () { setModal(null); }, onSubmit: function (report) { wbWriteReport(projectId, modal.task, report).then(function () { wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); wbCache.invalidate("/inbox"); setModal(null); }).catch(function (failure) { errorState[1](t("tasks.report.conflict", { code: failure.message })); }); } })
					: null,
				replayState[0] !== null
					? h(WbTaskReplayModal, { t: t, task: replayState[0], projectId: projectId, onClose: function () { replayState[1](null); } })
					: null,
				modal !== null && modal.kind === "create"
					? h(WbCreateTaskModal, { t: t, rows: views, onClose: function () { setModal(null); }, onCreate: function (input) { wbCreateTask(projectId, input).then(function () { wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); setModal(null); }).catch(function (failure) { errorState[1](failure.message); }); } })
					: null);
		}

		function wbWriteReport(projectId, task, report) {
			return wbApi("/tasks/" + encodeURIComponent(task.taskId) + "/report", {
				method: "PUT",
				body: {
					projectId: projectId,
					expectedRevision: task.revision,
					report: { status: report.status, summary: report.summary, artifacts: report.artifacts },
					bySessionId: "user"
				}
			}).then(wbUnwrap);
		}

		function wbCreateTask(projectId, input) {
			return wbApi("/tasks", {
				method: "POST",
				body: Object.assign({ projectId: projectId }, input)
			}).then(wbUnwrap);
		}

		function WbAssignModal(props) {
			var t = wbT(props);
			var ownerState = react.useState(props.members.length > 0 ? props.members[0].sessionId : "");
			var dispatchState = react.useState(true);
			return h(WbModal, {
				title: t("tasks.assign.title", { subject: props.task.subject || props.task.taskId }),
				onClose: props.onClose,
				t: t,
				footer: h(WbBtn, {
					disabled: props.busy || ownerState[0] === "",
					onClick: function () { props.onAssign(ownerState[0], dispatchState[0]); }
				}, t("tasks.action.assign"))
			},
				h("label", { className: "daw-wb-label" }, t("tasks.assign.owner"),
					h("select", { className: "daw-wb-select", value: ownerState[0], onChange: function (event) { ownerState[1](event.target.value); } },
						props.members.map(function (member) {
							var row = props.sessions.filter(function (session) { return session.sessionId === member.sessionId; })[0];
							return h("option", { key: member.sessionId, value: member.sessionId }, (row ? row.title : member.sessionId) + (member.role === "main" ? " · main" : ""));
						}))),
				h("label", { className: "daw-wb-label" },
					h("input", { type: "checkbox", checked: dispatchState[0], onChange: function (event) { dispatchState[1](event.target.checked === true); } }),
					" " + t("tasks.assign.dispatch")));
		}

		function WbReportModal(props) {
			var t = wbT(props);
			var statusState = react.useState(props.task.report ? props.task.report.status : "draft");
			var summaryState = react.useState(props.task.report ? props.task.report.summary : "");
			var artifactsState = react.useState(props.task.report && Array.isArray(props.task.report.artifacts)
				? props.task.report.artifacts.map(function (item) { return typeof item === "string" ? item : (item && item.ref) || ""; }).join("\n")
				: "");
			var rules = wbReportRules("user");
			return h(WbModal, {
				title: t("tasks.report.title", { subject: props.task.subject || props.task.taskId }),
				onClose: props.onClose,
				t: t,
				footer: h(WbBtn, {
					disabled: props.busy,
					onClick: function () {
						props.onSubmit({
							status: statusState[0],
							summary: summaryState[0].trim(),
							artifacts: artifactsState[0].split("\n").map(function (line) { return line.trim(); }).filter(function (line) { return line !== ""; }).map(function (line) { return { kind: "file", ref: line, note: "" }; })
						});
					}
				}, t("common.save"))
			},
				h("div", { className: "daw-wb-toolbar" },
					rules.all.map(function (status) {
						return h("button", {
							key: status,
							type: "button",
							className: "daw-wb-filter",
							"data-on": String(statusState[0] === status),
							onClick: function () { statusState[1](status); }
						}, t("tasks.report." + status), rules.writable.indexOf(status) >= 0 ? "" : " · " + t("exec.popover.human"));
					})),
				h("label", { className: "daw-wb-label" }, t("tasks.report.summary"),
					h("textarea", { className: "daw-wb-textarea", value: summaryState[0], onChange: function (event) { summaryState[1](event.target.value); } })),
				h("label", { className: "daw-wb-label" }, t("tasks.report.artifacts"),
					h("textarea", { className: "daw-wb-textarea", value: artifactsState[0], onChange: function (event) { artifactsState[1](event.target.value); } })),
				// 越界提示（借鉴 troupe workOf 的 outside）：产物里没有写入范围覆盖的那些——
				// 这正是 handed_back「超 scope」一直缺的证据面。没有声明范围时不提示
				// （「没声明」不是越界的证据）。
				wbArtifactsOutside(props.task).outside.length > 0
					? h("div", { className: "daw-wb-banner", "data-tone": "warn" }, t("tasks.report.outside", {
						count: wbArtifactsOutside(props.task).outside.length,
						total: wbArtifactsOutside(props.task).total,
						refs: wbArtifactsOutside(props.task).outside.slice(0, 3).join("、")
					}))
					: null,
				h("div", { className: "daw-wb-note" }, t("tasks.report.note")));
		}

		function WbCreateTaskModal(props) {
			var t = wbT(props);
			var subjectState = react.useState("");
			var descState = react.useState("");
			var depState = react.useState("");
			var whereState = react.useState("");
			return h(WbModal, {
				title: t("tasks.new"),
				onClose: props.onClose,
				t: t,
				canvasAnchored: props.canvasAnchored === true,
				footer: h(WbBtn, {
					disabled: subjectState[0].trim() === "",
					onClick: function () {
						props.onCreate({
							subject: subjectState[0].trim(),
							description: descState[0].trim(),
							blockedBy: depState[0].split(",").map(function (part) { return part.trim(); }).filter(function (part) { return part !== ""; }),
							worktree: whereState[0].trim() === "" ? undefined : whereState[0].trim()
						});
					}
				}, t("common.confirm"))
			},
				h("label", { className: "daw-wb-label" }, t("tasks.col.task"),
					h("input", { className: "daw-wb-input", value: subjectState[0], onChange: function (event) { subjectState[1](event.target.value); } })),
				h("label", { className: "daw-wb-label" }, t("brief.desc"),
					h("textarea", { className: "daw-wb-textarea", value: descState[0], onChange: function (event) { descState[1](event.target.value); } })),
				h("label", { className: "daw-wb-label" }, t("tasks.col.blockedBy"),
					h("input", {
						className: "daw-wb-input",
						value: depState[0],
						placeholder: props.rows.map(function (row) { return row.taskId; }).join(", "),
						onChange: function (event) { depState[1](event.target.value); }
					})),
				h("label", { className: "daw-wb-label" }, t("tasks.col.worktree"),
					h("input", { className: "daw-wb-input", value: whereState[0], placeholder: "work/<ticket>", onChange: function (event) { whereState[1](event.target.value); } })));
		}

		// ── U-4 简报（M6-2）────────────────────────────────────────────────────

		function WbBriefPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var projectSnap = useWb("/projects/" + encodeURIComponent(projectId));
			var sessionsSnap = useWb("/sessions");
			var project = projectSnap.data && projectSnap.data.project ? projectSnap.data.project : null;
			var sessionRows = wbSessionRows(sessionsSnap.data && sessionsSnap.data.sessions ? { byId: indexById(sessionsSnap.data.sessions) } : undefined);
			var goalState = react.useState("");
			var decisionsState = react.useState("");
			var constraintsState = react.useState("");
			var baseState = react.useState(0);
			var errorState = react.useState("");
			var error = errorState[0];
			var brief = project && project.brief ? project.brief : null;

			if (brief !== null && baseState[0] !== brief.version) {
				goalState[1](typeof brief.goal === "string" ? brief.goal : "");
				decisionsState[1]((Array.isArray(brief.decisions) ? brief.decisions : []).join("\n"));
				constraintsState[1]((Array.isArray(brief.constraints) ? brief.constraints : []).join("\n"));
				baseState[1](brief.version);
			}
			var fill = wbBriefFill({
				goal: goalState[0],
				constraints: constraintsState[0].split("\n").filter(function (line) { return line.trim() !== ""; }),
				decisions: decisionsState[0].split("\n").filter(function (line) { return line.trim() !== ""; })
			});
			var percent = Math.min(100, Math.round((fill.used / WB_BRIEF_BUDGET) * 100));

			function save() {
				errorState[1]("");
				wbApi("/projects/" + encodeURIComponent(projectId) + "/brief", {
					method: "PUT",
					body: {
						expectedVersion: baseState[0],
						goal: goalState[0],
						decisions: decisionsState[0].split("\n").map(function (line) { return line.trim(); }).filter(function (line) { return line !== ""; }),
						constraints: constraintsState[0].split("\n").map(function (line) { return line.trim(); }).filter(function (line) { return line !== ""; })
					}
				}).then(function (payload) {
					wbCache.invalidate("/projects/" + encodeURIComponent(projectId));
					if (payload && payload.code !== 200) errorState[1](t("brief.conflict", { latest: payload.data && payload.data.latestVersion, base: baseState[0] }));
				}).catch(function (failure) { errorState[1](failure.message); });
			}

			if (project === null) {
				return h(WbState, { loading: projectSnap.loading, error: projectSnap.error, onRetry: function () { wbCache.read("/projects/" + encodeURIComponent(projectId)); }, onExit: function () { wbRoute.set({ kind: "list" }); } });
			}
			var members = Array.isArray(project.members) ? project.members : [];
			return h(props.embedded ? WbSection : WbPage, { title: t("tab.brief"), desc: t("brief.desc") },
				error !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "warn" }, error) : null,
				h("div", { className: "daw-wb-cols" },
					h("div", { className: "daw-wb-panel", style: { flex: "1 1 420px" } },
						h("div", { className: "daw-wb-panel-title" },
							t("brief.project"),
							h("span", { className: "daw-wb-toolfill" }),
							h(WbChip, { tone: "neutral" }, "v" + (brief ? brief.version : 1))),
						h("div", { className: "daw-wb-kv" },
							h("span", { className: "daw-wb-kv-key" }, t("brief.budget")),
							h("span", { className: "daw-wb-kv-val" }, t("brief.budget", { used: fill.used }) + (fill.truncated ? " · truncated" : ""))),
						h("div", { className: "daw-wb-progress" }, h("i", { style: { width: percent + "%" } })),
						h("label", { className: "daw-wb-label" }, t("brief.goal"),
							h("textarea", { className: "daw-wb-textarea", value: goalState[0], onChange: function (event) { goalState[1](event.target.value); } })),
						h("label", { className: "daw-wb-label" }, t("brief.decisions"),
							h("textarea", { className: "daw-wb-textarea", value: decisionsState[0], onChange: function (event) { decisionsState[1](event.target.value); } })),
						h("label", { className: "daw-wb-label" }, t("brief.constraints"),
							h("textarea", { className: "daw-wb-textarea", value: constraintsState[0], onChange: function (event) { constraintsState[1](event.target.value); } })),
						h("div", { className: "daw-wb-toolbar" },
							h(WbBtn, { onClick: save }, t("brief.save", { version: baseState[0] })),
							h("span", { className: "daw-wb-note" }, t("brief.cas", { version: brief ? brief.version : 1 })))),
					h("div", { className: "daw-wb-panel", style: { flex: "1 1 420px" } },
						h("div", { className: "daw-wb-panel-title" }, t("brief.conversation")),
						h("div", { className: "daw-wb-note" }, t("brief.proxyNote")),
						members.map(function (member) {
							return h(WbConversationBrief, { key: member.sessionId, t: t, member: member, sessions: sessionRows, isMain: member.sessionId === project.mainSessionId });
						}))),
				h("div", { className: "daw-wb-note" }, t("brief.foot")));
		}

		function WbConversationBrief(props) {
			var t = wbT(props);
			var sessionId = props.member.sessionId;
			var snap = useWb("/briefs/" + encodeURIComponent(sessionId));
			var brief = snap.data && snap.data.brief ? snap.data.brief : null;
			var dutyState = react.useState("");
			var conclusionsState = react.useState("");
			var artifactsState = react.useState("");
			var baseState = react.useState(0);
			var openState = react.useState(false);
			var open = openState[0];
			if (brief !== null && baseState[0] !== brief.version) {
				dutyState[1](typeof brief.duty === "string" ? brief.duty : "");
				conclusionsState[1]((Array.isArray(brief.conclusions) ? brief.conclusions : []).join("\n"));
				artifactsState[1]((Array.isArray(brief.artifacts) ? brief.artifacts : []).map(function (item) { return typeof item === "string" ? item : (item && item.ref) || ""; }).join("\n"));
				baseState[1](brief.version);
			}
			var row = props.sessions.filter(function (session) { return session.sessionId === sessionId; })[0];
			var name = row ? row.title : sessionId;
			return h("div", { className: "daw-wb-ticket" },
				h("div", { className: "daw-wb-panel-title" },
					h("span", null, name + (props.isMain ? " · " + t("nav.projects") : "")),
					h("span", { className: "daw-wb-toolfill" }),
					brief && brief.proxy === true ? h(WbChip, { tone: "warn" }, t("brief.proxy")) : null,
					h(WbBtn, { variant: "ghost", onClick: function () { openState[1](!open); } }, open ? t("common.close") : t("brief.readin"))),
				brief === null
					? h("div", { className: "daw-wb-note" }, t("common.loading"))
					: h("div", { className: "daw-wb-kv" },
						h("span", { className: "daw-wb-kv-key" }, t("brief.duty")),
						h("span", { className: "daw-wb-kv-val" }, brief.duty || t("common.none")),
						h("span", { className: "daw-wb-kv-key" }, t("brief.conclusions")),
						h("span", { className: "daw-wb-kv-val" }, (brief.conclusions || []).join("；") || t("common.none")),
						h("span", { className: "daw-wb-kv-key" }, t("brief.artifacts")),
						h("span", { className: "daw-wb-kv-val" }, (brief.artifacts || []).map(function (item) { return typeof item === "string" ? item : (item && item.ref) || ""; }).join(" · ") || t("common.none"))),
				open
					? h("div", { className: "daw-wb-group" },
						h("label", { className: "daw-wb-label" }, t("brief.duty"),
							h("input", { className: "daw-wb-input", value: dutyState[0], onChange: function (event) { dutyState[1](event.target.value); } })),
						h("label", { className: "daw-wb-label" }, t("brief.conclusions"),
							h("textarea", { className: "daw-wb-textarea", value: conclusionsState[0], onChange: function (event) { conclusionsState[1](event.target.value); } })),
						h("label", { className: "daw-wb-label" }, t("brief.artifacts"),
							h("textarea", { className: "daw-wb-textarea", value: artifactsState[0], onChange: function (event) { artifactsState[1](event.target.value); } })),
						h(WbBtn, {
							onClick: function () {
								wbApi("/briefs/" + encodeURIComponent(sessionId), {
									method: "PUT",
									body: {
										expectedVersion: baseState[0],
										duty: dutyState[0],
										conclusions: conclusionsState[0].split("\n").map(function (line) { return line.trim(); }).filter(function (line) { return line !== ""; }),
										artifacts: artifactsState[0].split("\n").map(function (line) { return line.trim(); }).filter(function (line) { return line !== ""; }),
										proxy: true
									}
								}).then(function () { wbCache.invalidate("/briefs/" + encodeURIComponent(sessionId)); openState[1](false); });
							}
						}, t("common.save")))
					: null);
		}

		// ── 第二期 X1–X3：唤醒后自动派任务的项目设置（档位 / 审批 / 限额 / 撤销 / 审计）──────

		var WB_AUTO_TIERS = ["L1", "L2", "L3"];
		var WB_AUTO_LIMIT_KEYS = ["perMemberPerMinute", "projectConcurrent", "maxChainDepth"];

		/** 把宿主返回的 pending 行换算成「还剩几秒」；负数一律按 0，不显示倒计时负值。 */
		function wbAutoSecondsLeft(dueAt, now) {
			var left = typeof dueAt === "number" ? Math.ceil((dueAt - now) / 1000) : 0;
			return left > 0 ? left : 0;
		}

		function WbAutoPanel(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var names = props.taskNames || {};
			var url = "/projects/" + encodeURIComponent(projectId) + "/auto";
			var snap = useWb(url);
			var data = snap.data && typeof snap.data === "object" ? snap.data : null;
			var config = data && data.auto && typeof data.auto === "object" ? data.auto : null;
			var pending = data && Array.isArray(data.pending) ? data.pending : [];
			var audit = data && Array.isArray(data.audit) ? data.audit.slice(-8).reverse() : [];
			var nowState = react.useState(Date.now());
			var confirmState = react.useState(null);
			var noticeState = react.useState({ tone: "", text: "" });
			var limitsState = react.useState(null);
			var busyState = react.useState(false);

			// 撤销窗口只有几秒，而共享轮询是 5s：有挂起项时本面板自己每秒读一次并刷新倒计时。
			var hasPending = pending.length > 0;
			react.useEffect(function () {
				if (!hasPending) return undefined;
				var timer = setInterval(function () {
					nowState[1](Date.now());
					wbCache.read(url).catch(function () {});
				}, 1000);
				return function () { clearInterval(timer); };
			}, [hasPending, url]);

			function notify(tone, text) { noticeState[1]({ tone: tone, text: text }); }

			function save(patch, confirmed) {
				busyState[1](true);
				var body = Object.assign({}, patch);
				if (confirmed === true) body.confirm = true;
				return wbApi(url, { method: "PUT", body: body }).then(function (payload) {
					wbUnwrap(payload);
					confirmState[1](null);
					limitsState[1](null);
					notify("ok", t("auto.saved"));
					return wbCache.read(url);
				}).catch(function (failure) {
					notify("danger", t("auto.fail", { reason: failure && failure.message ? failure.message : "?" }));
				}).then(function () { busyState[1](false); });
			}

			/** 放宽（升 L3 / 开全部同意）先停在确认条上，用户点「确认开启」才带 confirm 发出去。 */
			function request(patch, loosenKey) {
				if (loosenKey !== "") { confirmState[1]({ patch: patch, key: loosenKey }); return; }
				save(patch, false);
			}

			function undo(row) {
				wbApi("/projects/" + encodeURIComponent(projectId) + "/auto-undo", { method: "POST", body: { taskId: row.taskId } }).then(function (payload) {
					wbUnwrap(payload);
					notify("ok", t("auto.pending.undone", { task: names[row.taskId] || row.taskId }));
				}).catch(function () {
					notify("warn", t("auto.pending.gone"));
				}).then(function () { wbCache.read(url).catch(function () {}); });
			}

			if (config === null) {
				return h("div", { className: "daw-wb-panel", "data-wb-auto": "loading" },
					h("div", { className: "daw-wb-panel-title" }, t("auto.title")),
					h(WbState, { loading: snap.loading, error: snap.error, onRetry: function () { wbCache.read(url).catch(function () {}); } }, null));
			}

			var draft = limitsState[0];
			var shownLimits = draft !== null ? draft : config;
			var dirty = draft !== null && WB_AUTO_LIMIT_KEYS.some(function (key) { return Number(draft[key]) !== config[key]; });
			var notice = noticeState[0];

			return h("div", { className: "daw-wb-panel", "data-wb-auto": "ready" },
				h("div", { className: "daw-wb-panel-title" }, t("auto.title")),
				h("div", { className: "daw-wb-note" }, t("auto.desc")),
				h("div", { className: "daw-wb-toolbar" }, WB_AUTO_TIERS.map(function (tier) {
					return h("button", {
						key: tier,
						type: "button",
						className: "daw-wb-filter",
						"data-tier": tier,
						"data-on": String(config.tier === tier),
						disabled: busyState[0],
						onClick: function () { if (config.tier !== tier) request({ tier: tier }, tier === "L3" ? "L3" : ""); }
					}, t("auto.tier." + tier));
				})),
				h("div", { className: "daw-wb-note" }, t("auto.tier." + config.tier + ".note", { seconds: Math.round(config.undoWindowMs / 1000) })),
				h("div", { className: "daw-wb-note" }, t("auto.approval")),
				h("div", { className: "daw-wb-toolbar" }, ["wait", "approve-all"].map(function (mode) {
					return h("button", {
						key: mode,
						type: "button",
						className: "daw-wb-filter",
						"data-approval": mode,
						"data-on": String(config.approval === mode),
						disabled: busyState[0],
						onClick: function () { if (config.approval !== mode) request({ approval: mode }, mode === "approve-all" ? "approve-all" : ""); }
					}, t("auto.approval." + mode));
				})),
				config.approval === "approve-all" ? h("div", { className: "daw-wb-note" }, t("auto.approval.approve-all.note")) : null,
				confirmState[0] !== null
					? h("div", { className: "daw-wb-banner", "data-tone": "warn", "data-wb-auto-confirm": confirmState[0].key },
						h("span", { className: "daw-wb-headfill" }, t("auto.confirm." + confirmState[0].key)),
						h(WbBtn, { variant: "ghost", onClick: function () { confirmState[1](null); } }, t("common.cancel")),
						h(WbBtn, { disabled: busyState[0], onClick: function () { save(confirmState[0].patch, true); } }, t("auto.confirm.ok")))
					: null,
				h("div", { className: "daw-wb-note" }, t("auto.limits")),
				h("div", { className: "daw-wb-toolbar" }, WB_AUTO_LIMIT_KEYS.map(function (key) {
					return h("label", { key: key, className: "daw-wb-note" },
						t("auto.limit." + key) + " ",
						h("input", {
							className: "daw-wb-input",
							type: "number",
							min: 1,
							style: { width: 80 },
							"data-limit": key,
							value: shownLimits[key],
							onChange: function (event) {
								var next = Object.assign({}, shownLimits);
								next[key] = event.target.value;
								limitsState[1](next);
							}
						}));
				}).concat([h(WbBtn, {
					key: "save",
					variant: "ghost",
					disabled: busyState[0] || !dirty,
					onClick: function () {
						var patch = {};
						WB_AUTO_LIMIT_KEYS.forEach(function (key) { patch[key] = Number(draft[key]); });
						save(patch, false);
					}
				}, t("auto.limit.save"))])),
				notice.text !== "" ? h("div", { className: "daw-wb-banner", "data-tone": notice.tone === "" ? "ok" : notice.tone }, notice.text) : null,
				hasPending
					? h("div", { className: "daw-wb-panel-title", "data-wb-auto-pending": "true" }, t("auto.pending", { count: pending.length }))
					: null,
				pending.map(function (row) {
					return h("div", { key: row.taskId, className: "daw-wb-todo" },
						h("div", { className: "daw-wb-todo-body" },
							h("div", { className: "daw-wb-todo-text" }, t("auto.pending.row", { task: names[row.taskId] || row.taskId, seconds: wbAutoSecondsLeft(row.dueAt, nowState[0]) }))),
						h(WbBtn, { variant: "ghost", onClick: function () { undo(row); } }, t("auto.pending.undo")));
				}),
				h("div", { className: "daw-wb-panel-title" }, t("auto.audit")),
				audit.length === 0
					? h("div", { className: "daw-wb-note" }, t("auto.audit.empty"))
					: audit.map(function (entry, index) {
						var at = Date.parse(entry.at);
						return h("div", { key: String(entry.at) + ":" + index, className: "daw-wb-kv" },
							h("span", { className: "daw-wb-kv-key" }, isFinite(at) ? wbFormatClock(at) : ""),
							h("span", { className: "daw-wb-kv-val" }, [entry.kind, entry.outcome, entry.reason, names[entry.taskId] || entry.taskId].filter(function (part) { return typeof part === "string" && part !== ""; }).join(" · ")));
					}));
		}

		// ── U-5 执行台最小版（M6-3 执行态 + report 四态）────────────────────────

		function WbExecPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var tasksSnap = useWb("/tasks?projectId=" + encodeURIComponent(projectId));
			var sessionsSnap = useWb("/sessions");
			var activitySnap = useWb("/activity");
			var rows = tasksSnap.data && Array.isArray(tasksSnap.data.tasks) ? tasksSnap.data.tasks : [];
			var byId = {};
			rows.forEach(function (row) { byId[row.taskId] = row; });
			var views = rows.map(function (row) { return wbTaskRowView(row, byId); });
			var sessionRows = wbSessionRows(sessionsSnap.data && sessionsSnap.data.sessions ? { byId: indexById(sessionsSnap.data.sessions) } : undefined);
			var active = activitySnap.data && activitySnap.data.active && typeof activitySnap.data.active === "object" ? activitySnap.data.active : {};
			var running = views.filter(function (row) { return row.status === "in_progress"; });
			var today = views.filter(function (row) {
				return row.status === "completed" && row.report !== null && row.report.status === "done";
			});
			var modalState = react.useState(null);
			// 元组必须解构：整个 modalState 当值用时「!== null」永远为真——弹窗会常驻、
			// task 传成 [value, setter] 导致标题「undefined」、取消也关不掉（2026-11-14 真机 bug）。
			var modalTask = modalState[0];
			var setModalTask = modalState[1];
			var errorState = react.useState("");
			var error = errorState[0];

			function toolOf(sessionId) {
				var entry = active[sessionId];
				return entry && typeof entry.tool === "string" ? entry.tool : null;
			}

			var taskNames = {};
			rows.forEach(function (row) { taskNames[row.taskId] = row.subject || row.taskId; });

			return h(props.embedded ? WbSection : WbPage, { title: t("tab.exec"), desc: t("tab.note.exec") },
				error !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "danger" }, error) : null,
				h(WbAutoPanel, { t: t, projectId: projectId, taskNames: taskNames }),
				running.length === 0
					? h("div", { className: "daw-wb-state" }, t("canvas.empty"))
					: running.map(function (row) {
						var owner = sessionRows.filter(function (session) { return session.sessionId === row.ownerSessionId; })[0];
						var tool = row.ownerSessionId ? toolOf(row.ownerSessionId) : null;
						return h("div", { key: row.taskId, className: "daw-wb-ticket" },
							h("div", { className: "daw-wb-panel-title" },
								h("span", null, row.subject || row.taskId),
								h("span", { className: "daw-wb-toolfill" }),
								h(WbChip, { tone: "brand" }, t("exec.ticket.state", {
								state: tool ? "$ " + tool : t("tasks.status.in_progress"),
								// 耗时用「任务最近一次变更到现在」：这是账本里真有的事实，不编造运行时长。
								elapsed: wbElapsed(typeof row.updatedAt === "number" ? Date.now() - row.updatedAt : 0)
							}))),
							h("div", { className: "daw-wb-meta" },
								h("span", null, t("exec.ticket.owner", { owner: owner ? owner.title : (row.ownerSessionId || t("common.none")) })),
								h("span", null, t("exec.ticket.where", { worktree: row.worktree || row.execRoot || t("common.none") })),
								h("span", { className: "daw-wb-note" }, t("exec.ticket.first"))),
							h("div", { className: "daw-wb-ticket-log" }, tool ? "$ " + tool : "$ " + t("common.loading")),
							h("div", { className: "daw-wb-toolbar" },
								h(WbBtn, { variant: "ghost", onClick: function () { if (typeof props.onOpenSession === "function") props.onOpenSession(row.ownerSessionId); } }, t("exec.ticket.full")),
								h(WbBtn, {
									variant: "ghost",
									onClick: function () { setModalTask(row); }
								}, t("exec.ticket.report")),
								h("span", { className: "daw-wb-note" }, t("exec.ticket.note"))));
					}),
				h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("exec.today", { count: today.length })),
					h("div", { className: "daw-wb-note" }, t("exec.today.note")),
					today.map(function (row) {
						return h("div", { key: row.taskId, className: "daw-wb-todo" },
							h("div", { className: "daw-wb-todo-index" }, "✓"),
							h("div", { className: "daw-wb-todo-body" },
								h("div", { className: "daw-wb-todo-text" }, row.subject || row.taskId),
								h("div", { className: "daw-wb-todo-src" }, t("tasks.report.done") + " · rev " + (row.report ? row.report.rev : 0))));
					})),
				modalTask !== null
					? h(WbReportModal, {
						t: t,
						task: modalTask,
						busy: false,
						onClose: function () { setModalTask(null); },
						onSubmit: function (report) {
							wbWriteReport(projectId, modalTask, report)
								.then(function () { wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); wbCache.invalidate("/inbox"); setModalTask(null); })
								.catch(function (failure) { errorState[1](t("tasks.report.conflict", { code: failure.message })); });
						}
					})
					: null);
		}

		// ── 办公室 ───────────────────────────────────────────────────────────────
		var WB_OFFICE_URL = "/agent-whales/api/office/";
		var WB_OFFICE_CHARACTERS = ["cat", "goldfish", "liang"];
		var WB_OFFICE_IDLE_ACTIONS = ["walk", "game", "coffee"];
		var WB_OFFICE_SPOTS = [
			{ homeX: 16, homeY: 63, aisleY: 77, restX: 86, restY: 65 },
			{ homeX: 37, homeY: 63, aisleY: 74, restX: 78, restY: 62 },
			{ homeX: 58, homeY: 63, aisleY: 79, restX: 92, restY: 74 }
		];
		var WB_OFFICE_DENSE_SPOTS = [
			{ homeX: 14, homeY: 52, aisleY: 92, restX: 81, restY: 68 },
			{ homeX: 35, homeY: 52, aisleY: 88, restX: 89, restY: 64 },
			{ homeX: 56, homeY: 52, aisleY: 90, restX: 92, restY: 73 },
			{ homeX: 19, homeY: 78, aisleY: 95, restX: 79, restY: 82 },
			{ homeX: 40, homeY: 78, aisleY: 94, restX: 88, restY: 83 },
			{ homeX: 61, homeY: 78, aisleY: 91, restX: 95, restY: 87 }
		];
		var WB_OFFICE_FACE_POSE = {
			failed: "oops", waiting: "wait", celebrating: "done", thinking: "think",
			reading: "read", editing: "type", running: "run", working: "type", idle: "idle"
		};
		var WB_OFFICE_FACE_SETTINGS = { stateFaces: true, errorFaces: true, toolFaces: true, waitFaces: true };

		function wbOfficeSceneAt(mode, hour) {
			return mode === "day" || mode === "night" ? mode : (hour >= 7 && hour < 19 ? "day" : "night");
		}

		function wbOfficeArt(key) {
			return WB_OFFICE_URL + "o-studio-" + key + ".webp";
		}

		function wbOfficePlacement(spot) {
			return {
				"--home-x": spot.homeX + "%", "--home-y": spot.homeY + "%",
				"--rest-x": spot.restX + "%", "--rest-y": spot.restY + "%",
				"--aisle-y": spot.aisleY + "%"
			};
		}

		function onMissingOfficeArt(event) {
			event.currentTarget.hidden = true;
		}

		/**
		 * 一个成员此刻的姿势。优先级：离线 > 出错 > 等你 > 刚收工 > 思考 > 读 / 改 / 命令 > 在跑 > 空闲（后面几级由 faceOf 决定）。
		 * @param input { offline, row（/activity 的 state 行，已并入 running）, tool, pending, now }
		 */
		function wbOfficePose(input) {
			var source = input && typeof input === "object" ? input : {};
			if (source.offline === true) return "sleep";
			var face = faceOf(source.row, typeof source.now === "number" ? source.now : Date.now(), WB_OFFICE_FACE_SETTINGS, source.tool, source.pending);
			return WB_OFFICE_FACE_POSE[face] || "idle";
		}

		/**
		 * 工位名牌上写什么：对话的中文名。取值顺序与画布一致并补上宿主侧栏的标题——
		 *   /sessions 的标题 → 宿主客户端会话表里的标题 → 加入项目时登记的角色名（如「前端」）。
		 * 空串、纯空白、等于会话 id 的都算没有（wbSessionRows 会把空标题填成 id）。
		 * 都没有就返回 named:false，由调用方写「主对话」或「未命名对话」，绝不把整串 id 摆出来。
		 */
		function wbOfficeTitle(input) {
			var source = input && typeof input === "object" ? input : {};
			var id = typeof source.sessionId === "string" ? source.sessionId : "";
			var candidates = [source.routeTitle, source.storeTitle, source.memberTitle];
			for (var i = 0; i < candidates.length; i += 1) {
				var text = typeof candidates[i] === "string" ? candidates[i].trim() : "";
				if (text !== "" && text !== id) return { text: text, named: true };
			}
			return { text: "", named: false };
		}

		/** 没有名字时给一个能区分的短后缀（去掉 session- 前缀，取前 6 位）。 */
		function wbOfficeShortId(id) {
			return String(id || "").replace(/^session-/, "").slice(0, 6);
		}

		/** 任务状态和会话活动分别来自各自的数据源。优先把需要人处理或受阻的任务放到工位。 */
		function wbOfficeTask(taskRows, byId) {
			var selected = null;
			var highest = 0;
			taskRows.forEach(function (row) {
				if (row.status === "deleted" || row.status === "completed") return;
				var task = wbTaskRowView(row, byId);
				var report = task.report && task.report.status;
				var needsUser = report === "human_action" || report === "handed_back";
				var rank = needsUser ? 4 : task.blockedReason ? 3 : task.status === "in_progress" ? 2 : 1;
				if (rank <= highest) return;
				highest = rank;
				var dependency = task.blockedReason === "wait" ? task.blockedBy.map(function (id) { return byId[id]; }).find(function (entry) {
					return entry && entry.status !== "completed" && entry.status !== "deleted";
				}) : null;
				selected = { task: task, needsUser: needsUser, dependency: dependency };
			});
			return selected;
		}

		function WbOfficePage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var projectSnap = useWb("/projects/" + encodeURIComponent(projectId));
			var sessionsSnap = useWb("/sessions");
			var activitySnap = useWb("/activity");
			var useStatus = typeof props.useSessionStatus === "function" ? props.useSessionStatus : function () { return undefined; };
			var statusMap = useStatus(function (value) { return value; });
			var storeRows = wbSessionRows(useWbSessions(props));
			var tasksSnap = useWb("/tasks?projectId=" + encodeURIComponent(projectId));
			var preferences = react.useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			var sceneMode = preferences.officeScene;
			var hourState = react.useState(new Date().getHours());
			var roomState = react.useState({ projectId: projectId, index: 0 });
			react.useEffect(function () {
				if (sceneMode !== "auto") return undefined;
				function refreshHour() { hourState[1](new Date().getHours()); }
				refreshHour();
				var timer = setInterval(refreshHour, 30_000);
				return function () { clearInterval(timer); };
			}, [sceneMode]);
			var scene = wbOfficeSceneAt(sceneMode, hourState[0]);

			var project = projectSnap.data && projectSnap.data.project ? projectSnap.data.project : null;
			if (project === null) {
				return h(WbState, { loading: projectSnap.loading, error: projectSnap.error, onRetry: function () { wbCache.read("/projects/" + encodeURIComponent(projectId)); }, onExit: function () { wbRoute.set({ kind: "list" }); } });
			}
			var sessionRows = wbSessionRows(sessionsSnap.data && sessionsSnap.data.sessions ? { byId: indexById(sessionsSnap.data.sessions) } : undefined);
			var activity = activitySnap.data && typeof activitySnap.data === "object" ? activitySnap.data : {};
			var active = activity.active && typeof activity.active === "object" ? activity.active : {};
			var activityState = activity.state && typeof activity.state === "object" ? activity.state : {};
			var now = Date.now();

			var members = Array.isArray(project.members) ? project.members : [];
			var ids = [];
			function add(id) { if (typeof id === "string" && id !== "" && ids.indexOf(id) < 0) ids.push(id); }
			add(project.mainSessionId);
			members.forEach(function (member) { if (member) add(member.sessionId); });

			var byTask = Object.create(null);
			var byOwner = Object.create(null);
			var taskRows = tasksSnap.data && Array.isArray(tasksSnap.data.tasks) ? tasksSnap.data.tasks : [];
			taskRows.forEach(function (task) {
				if (!task || !task.taskId) return;
				byTask[task.taskId] = task;
				if (typeof task.ownerSessionId === "string" && task.ownerSessionId !== "") {
					(byOwner[task.ownerSessionId] || (byOwner[task.ownerSessionId] = [])).push(task);
				}
			});
			var liveById = indexById(sessionRows);
			var storedById = indexById(storeRows);
			var memberById = indexById(members.filter(Boolean));

			var desks = ids.map(function (id, index) {
				var session = liveById[id];
				var stored = storedById[id];
				var member = memberById[id];
				var entry = active[id];
				var tool = entry && typeof entry.tool === "string" ? entry.tool : null;
				var statusRow = statusMap && typeof statusMap.get === "function" ? statusMap.get(id) : undefined;
				var running = (statusRow && statusRow.running === true) || (session !== undefined && session.running === true) || (tool !== null);
				var row = Object.assign({}, activityState[id], { running: running || (activityState[id] !== undefined && activityState[id].running === true) });
				// 离线：宿主 /sessions 只列「已挂载」的会话，离线会话压根不在里面——所以光看 live:false 是漏的
				// （2026-11-18 真机：离线的成员显示「空闲」还在踱步；合成数据里离线成员带 live:false，没暴露）。
				// 列表加载成功、这个成员不在里面、而且没有任何在跑的迹象，才判离线；
				// 列表没加载出来（读不到 / 还在加载）不判，免得网络抖一下全屋子的人集体睡着。
				var listLoaded = sessionsSnap.data !== undefined && sessionsSnap.data !== null && Array.isArray(sessionsSnap.data.sessions);
				var offline = (session !== undefined && session.offline === true) || (listLoaded && session === undefined && row.running !== true && tool === null);
				var pending = pendingOf(statusMap, id);
				var pose = wbOfficePose({
					offline: offline,
					row: row,
					tool: tool,
					pending: pending,
					now: now
				});
				var main = id === project.mainSessionId;
				var named = wbOfficeTitle({
					sessionId: id,
					routeTitle: session ? session.title : undefined,
					storeTitle: stored ? stored.title : undefined,
					memberTitle: member ? member.title : undefined
				});
				var title = named.named ? named.text : (main ? t("office.main") : t("office.untitled", { id: wbOfficeShortId(id) }));
				// 主对话没有名字时名牌本身就写「主对话」，不再重复贴一枚「主对话」标签。
				return {
					id: id, index: index, title: title, main: main && named.named, pose: pose, tool: tool,
					character: WB_OFFICE_CHARACTERS[index % WB_OFFICE_CHARACTERS.length],
					pending: isWaiting(pending) ? pending : null,
					assignment: wbOfficeTask(byOwner[id] || [], byTask)
				};
			});

			function toneOf(pose) {
				if (pose === "wait") return "warn";
				if (pose === "oops") return "danger";
				if (pose === "done") return "ok";
				if (pose === "type" || pose === "run" || pose === "read" || pose === "think") return "brand";
				return "neutral";
			}

			var names = Object.fromEntries(desks.map(function (desk) { return [desk.id, desk.title]; }));
			var attention = desks.filter(function (desk) { return desk.pending || desk.assignment?.needsUser; }).length;
			var summary = [t("office.members", { count: desks.length })];
			if (attention) summary.push(t("office.attention", { count: attention }));
			var capacity = WB_OFFICE_DENSE_SPOTS.length;
			var roomCount = Math.max(1, Math.ceil(desks.length / capacity));
			var roomIndex = roomState[0].projectId === projectId ? Math.min(roomState[0].index, roomCount - 1) : 0;
			var firstDesk = roomIndex * capacity;
			var currentDesks = desks.slice(firstDesk, firstDesk + capacity);
			var dense = currentDesks.length > WB_OFFICE_SPOTS.length;
			var spots = dense ? WB_OFFICE_DENSE_SPOTS : WB_OFFICE_SPOTS;
			var sceneControls = h("div", { className: "daw-office-controls", role: "group", "aria-label": t("office.scene.label") },
				["auto", "day", "night"].map(function (mode) {
					return h("button", {
						key: mode, type: "button", className: "daw-wb-btn", "data-variant": "quiet",
						"aria-pressed": sceneMode === mode, title: mode === "auto" ? t("office.scene.schedule") : undefined,
						onClick: function () { settings.set({ officeScene: mode }); }
					}, t("office.scene." + mode));
				}));
			function shiftRoom(step) {
				roomState[1]({ projectId: projectId, index: Math.max(0, Math.min(roomCount - 1, roomIndex + step)) });
			}
			var roomControls = roomCount > 1 ? h("div", { className: "daw-office-pages" },
				h(WbBtn, { variant: "ghost", disabled: roomIndex === 0, "aria-label": t("office.room.prev"), onClick: function () { shiftRoom(-1); } }, "‹"),
				h("span", { className: "daw-wb-note", role: "status" }, t("office.room.page", { page: roomIndex + 1, total: roomCount })),
				h(WbBtn, { variant: "ghost", disabled: roomIndex === roomCount - 1, "aria-label": t("office.room.next"), onClick: function () { shiftRoom(1); } }, "›")) : null;
			var actions = h("div", { className: "daw-office-page-actions" }, roomControls, sceneControls);

			function renderSceneActor(desk, slot) {
				var seated = ["type", "read", "run", "think"].indexOf(desk.pose) >= 0;
				var roaming = desk.pose === "idle";
				var motion = seated ? (desk.pose === "type" ? "type" : "desk") : roaming ? "roam" : "standing";
				var props = wbOfficePlacement(spots[slot]);
				var avatar = wbOfficeArt(desk.character + "-" + (seated ? "type" : "walk"));
				var fallback = wbOfficeArt(desk.character);
				function onActorArtError(event) {
					var image = event.currentTarget;
					if (image.getAttribute("src") === fallback) onMissingOfficeArt(event);
					else image.src = fallback;
				}
				return h(react.Fragment, { key: desk.id },
					seated ? null : h("img", {
						className: "daw-office-fixture", style: props, src: wbOfficeArt("room-desk"), alt: "",
						decoding: "async", onError: onMissingOfficeArt
					}),
					h("div", {
						className: "daw-office-actor", "data-character": desk.character, "data-motion": motion, "data-actor-session": desk.id,
						style: Object.assign({}, props, { "--office-motion-offset": -(slot * 2.7) + "s" })
					},
						h("img", {
							className: "daw-office-scene-img daw-office-avatar" + (seated ? " daw-office-action-img" : ""),
							src: avatar, alt: "", decoding: "async", onError: onActorArtError
						}),
						roaming ? WB_OFFICE_IDLE_ACTIONS.map(function (action) {
							return h("span", { key: action, className: "daw-office-action", "data-action": action },
								h("span", { className: "daw-office-action-img" }, h("img", {
									className: "daw-office-scene-img", src: wbOfficeArt(desk.character + "-" + action),
									alt: "", decoding: "async", onError: onActorArtError
								})));
						}) : null));
			}

			function renderDesk(desk, slot) {
				var status = t("office.pose." + desk.pose);
				var assignment = desk.assignment;
				var task = assignment && assignment.task;
				var waiting = "";
				var needsUser = Boolean(desk.pending || assignment?.needsUser);
				if (desk.pending) waiting = t("office.wait." + desk.pending.kind);
				else if (assignment?.needsUser) waiting = t("office.wait.report");
				else if (task?.blockedReason === "deleted") waiting = t("office.wait.removed");
				else if (assignment?.dependency) {
					var dependency = assignment.dependency;
					var owner = names[dependency.ownerSessionId];
					waiting = t(owner ? "office.wait.member" : "office.wait.task", { name: owner, task: dependency.subject });
				}
				var taskLabel = task ? t(task.blockedReason ? "office.task.blocked" : task.status === "in_progress" ? "office.task.active" : "office.task.assigned") : "";
				var taskName = task ? task.subject : t(tasksSnap.error ? "office.task.unavailable" : tasksSnap.data === undefined ? "office.task.loading" : "office.task.none");
				return h("button", {
					key: desk.id, type: "button", className: "daw-office-desk",
					"data-pose": desk.pose, "data-session": desk.id, "data-attention": String(needsUser),
					style: wbOfficePlacement(spots[slot]),
					title: [t("office.open"), desk.title, taskName, waiting].filter(Boolean).join(" · "),
					"aria-label": [desk.title, status, taskLabel, taskName, waiting].filter(Boolean).join(" · "),
					onClick: function () { if (typeof props.onOpenSession === "function") props.onOpenSession(desk.id); }
				},
					h("span", { className: "daw-office-info" },
						h("span", { className: "daw-office-name" },
							h("span", { className: "daw-office-plate" }, desk.title),
							h("span", { className: "daw-office-arrow", "aria-hidden": "true" }, "↗")),
						h("span", { className: "daw-office-chips" },
							h(WbChip, { tone: toneOf(desk.pose) }, status),
							desk.main ? h(WbChip, { tone: "neutral" }, t("office.main")) : null,
							desk.tool ? h("span", { className: "daw-office-tool" }, t("office.tool", { tool: desk.tool })) : null),
						h("span", { className: "daw-office-task" },
							taskLabel ? h("small", null, taskLabel) : null,
							task ? h("strong", null, taskName) : h("small", null, taskName)),
						waiting ? h("span", { className: "daw-office-wait" }, waiting) : null));
			}

			return h(WbPage, { title: t("tab.office"), desc: summary.join(" · "), actions: actions },
				desks.length === 0
					? h("div", { className: "daw-wb-state" }, t("office.empty"))
					: h("div", { className: "daw-office-room", "data-scene": scene, "data-dense": dense ? "" : undefined, "data-testid": "office-room" },
						h("div", { className: "daw-office-stage", "aria-hidden": "true" },
							h("img", { key: scene, className: "daw-office-backdrop", src: wbOfficeArt("room-" + scene), alt: "", decoding: "async", onError: onMissingOfficeArt }),
							currentDesks.map(renderSceneActor)),
						h("div", { className: "daw-office-stations" }, currentDesks.map(renderDesk))));
		}

		// ── U-6 需要我处理（M6-6）──────────────────────────────────────────────

		function WbInboxPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var url = projectId ? "/inbox?projectId=" + encodeURIComponent(projectId) : "/inbox";
			var inbox = useWb(url);
			var counts = wbInboxView(inbox.data);
			var order = ["requirements", "proposals", "worker", "handed_back", "system"];
			var actions = {
				requirements: t("inbox.action.requirement"),
				proposals: t("inbox.action.proposal"),
				worker: t("inbox.action.report"),
				handed_back: t("inbox.action.handed"),
				system: t("inbox.action.task")
			};
			function openItem(group, item) {
				if ((group === "proposals" || group === "requirements") && item.projectId) wbRoute.project(item.projectId, "canvas");
				else if (item.projectId) wbRoute.project(item.projectId, item.kind === "task" ? "table" : "canvas");
				else wbRoute.list();
			}
			return h(WbPage, {
				title: t("inbox.title", { count: counts.total }),
				desc: t("inbox.desc"),
				actions: h(WbBtn, { variant: "ghost", onClick: function () { wbCache.read(url); } }, t("common.refresh"))
			},
				h(WbState, { loading: inbox.loading && inbox.data === undefined, error: inbox.error, onRetry: function () { wbCache.read(url); } },
					counts.total === 0
						? h("div", { className: "daw-wb-state" }, t("event.empty"))
						: order.map(function (key) {
							var group = counts.groups[key];
							if (group === undefined || group.items.length === 0) return null;
							return h("div", { key: key, className: "daw-wb-group" },
								h("div", { className: "daw-wb-group-head" },
									h(WbChip, { tone: key === "worker" || key === "requirements" ? "danger" : key === "handed_back" ? "warn" : "neutral" }, group.label),
									h("span", { className: "daw-wb-note" }, String(group.items.length))),
								group.items.map(function (item, index) {
									var isReq = item.kind === "requirement";
									var headline = isReq ? (item.subject + " · " + t("req.attention." + item.attention)) : (item.subject || item.reason || item.proposalId || t("common.none"));
									return h("div", { key: key + ":" + index, className: "daw-wb-todo" },
										h("div", { className: "daw-wb-todo-index" }, String(index + 1)),
										h("div", { className: "daw-wb-todo-body" },
											h("div", { className: "daw-wb-todo-text" }, headline),
											h("div", { className: "daw-wb-todo-src" },
												isReq ? ((item.reason || "") + " " + (item.at ? wbFormatClock(item.at) : "")) : (
												(item.kind ? item.kind + " · " : "") +
												(item.bySessionId || item.source || t("nav.projects")) + " " +
												(item.at ? wbFormatClock(item.at) : "")))),
										h(WbBtn, { variant: "ghost", onClick: function () { openItem(key, item); } }, actions[key] || t("inbox.action.task")));
								}));
						})),
				// 活动（原「发送记录」+「事件台」合并）：交接账本沿用原来的表；事件只留一条只读时间线。
				h(WbHandoffsPanel, { t: t, projectId: projectId, sessions: props.sessions }),
				h(WbEventsTimeline, { t: t, projectId: projectId }),
				h("div", { className: "daw-wb-note" }, t("inbox.foot")));
		}

		// ── 活动：发送记录（M6-4）+ 只读事件时间线 ——并入「需要我处理」页（重新规划 R3：不再有独立的「发送记录」「事件台」菜单）──

		/** 分区外壳：标题 + 右侧操作 + 说明 + 内容（原来是整页 WbPage，现在是页面里的一个面板）。 */
		function WbSection(props) {
			return h("div", { className: "daw-wb-panel" },
				h("div", { className: "daw-wb-toolbar" },
					h("div", { className: "daw-wb-panel-title" }, props.title),
					h("span", { className: "daw-wb-toolfill" }),
					props.actions || null),
				props.desc ? h("div", { className: "daw-wb-note" }, props.desc) : null,
				props.children);
		}

		function WbHandoffsPanel(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var url = projectId ? "/handoffs?projectId=" + encodeURIComponent(projectId) : "/handoffs";
			var snap = useWb(url);
			var entries = snap.data && Array.isArray(snap.data.entries) ? snap.data.entries : [];
			var sessionRows = wbSessionRows(props.sessions);
			function nameOf(sessionId) {
				var row = sessionRows.filter(function (session) { return session.sessionId === sessionId; })[0];
				return row ? row.title : String(sessionId || "").slice(0, 12);
			}
			function resultChip(entry) {
				if (entry.result === "failed") return h(WbChip, { tone: "danger" }, t("handoff.result.failed"));
				if (entry.result === "unknown") return h(WbChip, { tone: "warn" }, t("handoff.result.unknown"));
				return h(WbChip, { tone: "ok" }, t("handoff.result.sent"));
			}
			return h(WbSection, {
				title: t("handoff.title"),
				desc: t("handoff.desc"),
				actions: h(WbBtn, {
					variant: "ghost",
					onClick: function () {
						// 「导出证据」名副其实：把当前这份账本原文下载走（以前这个按钮只是
						// 刷新缓存——按钮说了导出却给刷新，是最坏的一种撒谎）。
						wbDownloadFile(
							"dsh-agent-whales-handoffs-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".json",
							wbUtf8(JSON.stringify({ exportedAt: new Date().toISOString(), entries: entries }, null, 2) + "\n"),
							"application/json"
						);
					}
				}, t("handoff.export"))
			},
				h(WbState, { loading: snap.loading && entries.length === 0, error: snap.error, onRetry: function () { wbCache.read(url); } },
					h("div", { className: "daw-wb-table" },
						h("div", { className: "daw-wb-tr", "data-head": "true" },
							h("span", { className: "daw-wb-td daw-wb-td-time" }, t("handoff.col.time")),
							h("span", { className: "daw-wb-td daw-wb-td-route" }, t("handoff.col.route")),
							h("span", { className: "daw-wb-td daw-wb-td-summary" }, t("handoff.col.summary")),
							h("span", { className: "daw-wb-td daw-wb-td-result" }, t("handoff.col.result")),
							h("span", { className: "daw-wb-td daw-wb-td-evidence" }, t("handoff.col.evidence"))),
						entries.length === 0
							? h("div", { className: "daw-wb-tr" }, h("span", { className: "daw-wb-note" }, t("common.none")))
							: entries.map(function (entry, index) {
								return h("div", { key: index, className: "daw-wb-tr" },
									h("span", { className: "daw-wb-td daw-wb-td-time" }, wbFormatClock(entry.at)),
									h("span", { className: "daw-wb-td daw-wb-td-route" }, nameOf(entry.from) + " → " + nameOf(entry.to)),
									h("span", { className: "daw-wb-td daw-wb-td-summary", title: entry.messageId }, entry.messageId ? String(entry.messageId).slice(0, 40) : (entry.kind || "")),
									h("span", { className: "daw-wb-td daw-wb-td-result" }, resultChip(entry)),
									h("span", { className: "daw-wb-td daw-wb-td-evidence" }, entry.evidence || entry.messageId || t("common.none")));
							}))),
				h("div", { className: "daw-wb-toolbar" },
					h("span", { className: "daw-wb-note" }, t("handoff.legend")),
					h(WbChip, { tone: "ok" }, t("handoff.result.sent")),
					h(WbChip, { tone: "danger" }, t("handoff.result.failed")),
					h(WbChip, { tone: "warn" }, t("handoff.result.unknown")),
					h("span", { className: "daw-wb-toolfill" }),
					h("span", { className: "daw-wb-note" }, t("handoff.note"))));
		}

		/**
		 * 活动 · 事件时间线（只读）。事件台以前有「开工单 / 忽略 / 标噪声」三个动作、Source 健康面板和三条规则；
		 * 三类事件来源（主会话消息 / 工作区监听 / 定时）本期都没接，动作也没人用，所以只留一条按时间倒序的流水：
		 * 时间 · 来源 · 种类 · 原文。事件的存储（events.json）与宿主写入照旧。
		 */
		function WbEventsTimeline(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var url = projectId ? "/events?projectId=" + encodeURIComponent(projectId) : "/events";
			var snap = useWb(url);
			var rows = snap.data && Array.isArray(snap.data.events) ? snap.data.events.filter(function (row) { return row && typeof row === "object"; }) : [];
			var shown = rows.slice(0, 30);
			return h(WbSection, { title: t("activity.events"), desc: t("activity.events.desc") },
				h(WbState, { loading: snap.loading && rows.length === 0, error: snap.error, onRetry: function () { wbCache.read(url); } },
					shown.length === 0
						? h("div", { className: "daw-wb-note", "data-events-empty": "" }, t("common.none"))
						: h("div", { className: "daw-wb-table", "data-events": "" },
							shown.map(function (row, index) {
								var text = typeof row.text === "string" ? row.text : "";
								return h("div", { key: row.eventId || index, className: "daw-wb-tr", "data-event": row.eventId || "" },
									h("span", { className: "daw-wb-td daw-wb-td-time" }, row.at ? wbFormatClock(row.at) : ""),
									h("span", { className: "daw-wb-td" }, String(row.source || "")),
									h("span", { className: "daw-wb-td" }, String(row.kind || "")),
									h("span", { className: "daw-wb-td daw-wb-td-summary", title: text }, text.length > 80 ? text.slice(0, 80) + "…" : text));
							}))));
		}
		/**
		 * 高级 · MCP 约束：给项目里的会话限定可用的 MCP 服务。
		 * 以前是画布上的「MCP 服务节点 + 拖线」，现在是一张列表：每个服务一组，每个成员一个开关。
		 * 开关是**受控的**——值永远来自宿主的真相，写失败时不改界面（不撒谎），并把宿主给的真原因显示出来。
		 */
		function WbMcpBody(props) {
			var t = props.t;
			var projectId = props.projectId;
			var url = "/projects/" + encodeURIComponent(projectId) + "/mcp-links";
			var snap = useWb(url);
			var sessions = useWb("/sessions");
			var projectSnap = useWb("/projects/" + encodeURIComponent(projectId));
			var errorState = react.useState("");
			var confirmState = react.useState(false);
			var data = snap.data && typeof snap.data === "object" ? snap.data : null;
			var names = wbMemberNames({ mainSessionId: data ? data.mainSessionId : "", members: data && Array.isArray(data.members) ? data.members : [] }, sessions.data);
			var projectMembers = projectSnap.data && projectSnap.data.project && Array.isArray(projectSnap.data.project.members) ? projectSnap.data.project.members : [];
			projectMembers.forEach(function (member) { if (member && typeof member.title === "string" && member.title !== "" && member.sessionId && (names[member.sessionId] === undefined || names[member.sessionId] === member.sessionId.slice(0, 12))) names[member.sessionId] = member.title; });
			var matrix = wbMcpMatrix(data, names);

			function write(method, body, pathSuffix) {
				errorState[1]("");
				confirmState[1](false);
				return wbWrite(url + (pathSuffix || ""), method, body)
					.then(function () { wbCache.invalidate(url); })
					.catch(function (error) { errorState[1](error && error.message ? error.message : String(error)); });
			}

			if (snap.error && data === null) {
				return h("div", { className: "daw-wb-mcp" }, h(WbState, { loading: false, error: snap.error, onRetry: function () { wbCache.read(url); } }));
			}
			return h("div", { className: "daw-wb-mcp" },
				h("div", { className: "daw-wb-note" }, t("set.mcp.rule")),
				data === null ? h("div", { className: "daw-wb-note" }, t("set.loading")) : null,
				data !== null && matrix.servers.length === 0 ? h("div", { className: "daw-wb-note", "data-mcp-empty": "" }, t("set.mcp.empty")) : null,
				data !== null && matrix.rows.length > 0 ? h("div", { className: "daw-wb-note" },
					matrix.restrictedCount > 0 ? t("set.mcp.restricted", { count: matrix.restrictedCount }) : t("set.mcp.unrestricted")) : null,
				matrix.staleLinks > 0 ? h("div", { className: "daw-wb-note", "data-tone": "warn" }, t("set.mcp.stale", { count: matrix.staleLinks })) : null,
				matrix.servers.map(function (server) {
					return h("div", { key: server.server, className: "daw-wb-mcp-group", "data-server": server.server },
						h("div", { className: "daw-wb-mcp-server" }, server.server, " ", h("span", { className: "daw-wb-note" }, t("set.mcp.tools", { count: server.toolCount }))),
						matrix.rows.map(function (row) {
							var key = server.server + "|" + row.sessionId;
							return h("label", { key: key, className: "daw-wb-mcp-row" },
								h("input", {
									type: "checkbox",
									"data-mcp-toggle": key,
									checked: wbMcpHas(data, server.server, row.sessionId),
									onChange: function (event) {
										var on = event && event.target && event.target.checked === true;
										write(on ? "POST" : "DELETE", { server: server.server, sessionId: row.sessionId });
									}
								}),
								h("span", null, row.name),
								row.restricted ? h("span", { className: "daw-wb-note" }, t("set.mcp.only", { servers: row.allowed.join("、") })) : h("span", { className: "daw-wb-note" }, t("set.mcp.free")));
						}));
				}),
				errorState[0] !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "danger" }, t("set.mcp.fail", { reason: errorState[0] })) : null,
				matrix.linkCount > 0 ? h("div", { className: "daw-wb-toolbar" },
					h("button", {
						type: "button",
						className: "daw-wb-btn",
						"data-variant": "ghost",
						"data-mcp-clear": "",
						onClick: function () {
							if (confirmState[0] !== true) { confirmState[1](true); return; }
							write("DELETE", undefined, "?all=1");
						}
					}, confirmState[0] === true ? t("set.mcp.clear.confirm") : t("set.mcp.clear"))) : null);
		}

		function WbAdvancedPanel(props) {
			var t = props.t;
			var projects = useWb("/projects");
			var rows = projects.data && Array.isArray(projects.data.projects) ? projects.data.projects : [];
			var pickState = react.useState("");
			var exportState = react.useState("");
			var picked = rows.some(function (project) { return project.projectId === pickState[0]; }) ? pickState[0] : (rows[0] ? rows[0].projectId : "");

			function exportSnapshot() {
				exportState[1](t("list.export.busy"));
				return wbExportSnapshot()
					.then(function (result) { exportState[1](t("list.export.done", { n: result.files })); })
					.catch(function (error) { exportState[1](t("list.export.failed", { reason: error && error.message ? error.message : String(error) })); });
			}

			return h("div", { className: "daw-wb-stack" },
				h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("set.mcp.title")),
					rows.length === 0
						? h("div", { className: "daw-wb-note", "data-mcp-noproject": "" }, t("set.mcp.noProject"))
						: h("div", { className: "daw-wb-stack" },
							h("label", { className: "daw-wb-field" },
								h("span", { className: "daw-wb-note" }, t("set.mcp.project")),
								h("select", { className: "daw-wb-select", "data-mcp-project": "", value: picked, onChange: function (event) { pickState[1](event.target.value); } },
									rows.map(function (project) { return h("option", { key: project.projectId, value: project.projectId }, project.name || project.projectId); }))),
							h(WbMcpBody, { key: picked, t: t, projectId: picked }))),
				h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("set.snapshot.title")),
					h("div", { className: "daw-wb-note" }, t("list.export.desc")),
					h("div", { className: "daw-wb-toolbar" },
						h("button", { type: "button", className: "daw-wb-btn", "data-variant": "ghost", "data-export-snapshot": "", onClick: exportSnapshot, title: t("list.export.desc") }, t("list.export"))),
					exportState[0] !== "" ? h("div", { className: "daw-wb-note" }, exportState[0]) : null));
		}

		function WbSettingsPage(props) {
			var t = wbT(props);
			var snap = react.useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			var menuState = react.useState("look");
			// 重新规划 R5a：只剩「外观」和「高级」。通用 / 通知 / 关于 / 执行器说明只有一句话或描述已不存在的规则，已删除。
			var menus = [
				{ key: "look", label: t("set.menu.look") },
				{ key: "advanced", label: t("set.menu.advanced") }
			];
			function panel() {
				if (menuState[0] === "advanced") return h(WbAdvancedPanel, { t: t });
				return h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("set.theme")),
					h("div", { className: "daw-wb-toolbar" }, ["system", "light", "dark"].map(function (theme) {
						return h("button", {
							key: theme, type: "button", className: "daw-wb-filter", "data-on": String(snap.theme === theme), "aria-pressed": snap.theme === theme,
							onClick: function () { settings.set({ theme: theme }); }
						}, t("set.theme." + theme));
					})),
					h("div", { className: "daw-wb-note" }, t("set.foot")),
					h("div", { className: "daw-wb-note" }, t("about.desc")));
			}
			return h(WbPage, { title: t("nav.settings") },
				h("div", { className: "daw-wb-cols" },
					h("div", { className: "daw-wb-menu" },
						menus.map(function (menu) {
							return h("button", {
								key: menu.key,
								type: "button",
								"data-menu": menu.key,
								"data-on": String(menuState[0] === menu.key),
								onClick: function () { menuState[1](menu.key); }
							}, menu.label);
						})),
					h("div", { style: { flex: "1 1 520px" } }, panel())));
		}
		// ── 工作台外壳（main keyed 槽；PRD §45.2：不覆盖 conversation key）───────

		function WhaleWorkbench(props) {
			var t = wbT(props);
			var snap = react.useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			var globalRoute = react.useSyncExternalStore(wbRoute.subscribe, wbRoute.get, wbRoute.get);
			// 右侧栏等 session 作用域宿主显式给 route；主面板仍用全局路由。
			// hook 无条件调用，不能因为某个实例传了 route 就跳过全局订阅。
			var route = props.route || globalRoute;
			useStoreStream(route.kind === "workbench" ? route.projectId : "");
			function navigate(target) {
				if (typeof props.onNavigate === "function") props.onNavigate(target);
				else wbRoute.set(target);
			}
			var sessions = useWbSessions(props);
			var sessionRows = wbSessionRows(sessions);
			var running = sessionRows.filter(function (row) { return row.running; }).length;
			// 两个 hook 必须无条件调用（React 规矩）：不在工作台时就近复用侧栏已经在拉的
			// /projects 与 /inbox，既不破坏 hook 顺序，也不多发请求。
			var inProject = route.kind === "workbench";
			var projectSnap = useWb(inProject ? "/projects/" + encodeURIComponent(route.projectId) : "/projects");
			var tasksSnap = useWb(inProject ? "/tasks?projectId=" + encodeURIComponent(route.projectId) : "/inbox");
			var project = projectSnap.data && projectSnap.data.project ? projectSnap.data.project : null;
			var taskRows = tasksSnap.data && Array.isArray(tasksSnap.data.tasks) ? tasksSnap.data.tasks : [];
			var byId = {};
			taskRows.forEach(function (row) { byId[row.taskId] = row; });
			var taskViews = taskRows.map(function (row) { return wbTaskRowView(row, byId); });
			// 需求页签角标：需要你处理的需求数（不在项目内时订阅 /projects，已被侧栏订阅，不多发请求）。
			var reqSnap = useWb(inProject ? "/projects/" + encodeURIComponent(route.projectId) + "/requirements" : "/projects");
			var reqAttention = inProject ? wbRequirementSummary(wbRequirementRows(reqSnap.data)).attention : 0;

			function onOpenSession(sessionId) {
				if (typeof props.focusSession === "function" && sessionId) props.focusSession(sessionId);
			}

			function onRemoveMember(sessionId, title, tasks) {
				var affected = (tasks || []).filter(function (task) { return task.ownerSessionId === sessionId && task.status === "in_progress"; }).length;
				var agents = 0;
				var ok = typeof window !== "undefined" && window.confirm
					? window.confirm(t("canvas.delete.body", { name: title }) + "\n" + t("canvas.delete.affected", { agents: agents, tasks: affected }))
					: true;
				if (!ok) return;
				wbApi("/projects/" + encodeURIComponent(route.projectId) + "/members/" + encodeURIComponent(sessionId), { method: "DELETE" })
					.then(function () { wbCache.invalidate("/projects/" + encodeURIComponent(route.projectId)); })
					.catch(function () { /* 主对话不可移除由宿主拒绝；这里只兜住不炸 */ });
			}

			var page = null;
			if (route.kind === "scoped-loading") {
				page = h(WbState, { loading: true });
			} else if (route.kind === "scoped-error") {
				page = h(WbState, { error: route.error, onRetry: function () { wbCache.read("/projects"); } });
			} else if (route.kind === "scoped-unbound") {
				page = h(WbState, { empty: t("canvas.session.unbound") });
			} else if (route.kind === "workbench" && project !== null) {
				if (route.tab === "table") page = h(WbTablePage, { t: t, projectId: route.projectId, onOpenSession: onOpenSession });
				else if (route.tab === "office") page = h(WbOfficePage, { t: t, projectId: route.projectId, useSessionStatus: props.useSessionStatus, useSessions: props.useSessions, onOpenSession: onOpenSession });
				else page = h(WbCanvasPage, {
					t: t,
					projectId: route.projectId,
					focus: props.canvasFocus || route.focus,
					onOpenSession: onOpenSession,
					onRemoveMember: onRemoveMember,
					onNavigate: navigate,
					// Q1：Composer「放入输入框」用。主面板未必拿得到（官方 inputActions 是
					// standard props，按槽提供）；拿不到就走剪贴板降级，Composer 上会明说。
					inputActions: props.inputActions,
					// 画布优先：SessionProvider 显式绑定主对话后 Composer 卡真写入 / 直接提交。
					SessionProvider: props.SessionProvider,
					renderSlot: props.renderSlot,
					retainSession: props.retainSession,
					// Composer 卡要知道主对话是不是在等你回答（官方提问卡同一个 pendingInteraction）
					useSessionStatus: props.useSessionStatus
				});
			} else if (route.kind === "start") {
				page = h(WbStartPage, { t: t, createSession: props.createSession, useWorkspaces: props.useWorkspaces });
			} else if (route.kind === "workbench") {
				// 路由里记的项目不存在时，提供回项目列表的入口。
				page = h(WbState, { loading: projectSnap.loading, error: projectSnap.error, onRetry: function () { wbCache.read("/projects/" + encodeURIComponent(route.projectId)); }, onExit: function () { wbRoute.set({ kind: "list" }); } });
			} else if (route.kind === "inbox") {
				page = h(WbInboxPage, { t: t, sessions: sessions });
			} else if (route.kind === "settings") {
				page = h(WbSettingsPage, { t: t });
			} else {
				// useSessions 必须显式往下传：props 不会自动流向孙组件。漏了它
				// WbProjectList 里 useWbSessions 取不到钩子 → sessionRows 恒为 [] →
				// 「新建项目」的主会话下拉为空、确认按钮永久禁用（建不了项目）。
				page = h(WbProjectList, {
					t: t,
					useSessions: props.useSessions,
					runningTasks: taskViews.filter(function (row) { return row.status === "in_progress"; }).length
				});
			}

			return h("div", { className: "daw-wb", "data-wb-theme": snap.theme, "data-narrow": props.narrow === true ? "true" : "false" },
				h("div", { className: "daw-wb-main" },
					h(WbTopbar, {
						t: t,
						route: route,
						running: running,
						projectName: project ? project.name : undefined,
						narrow: props.narrow === true,
						onNavigate: navigate,
						onSettings: function () { navigate({ kind: "settings" }); },
						onBack: function () { wbSelectPanel("conversation"); }
					}),
					route.kind === "workbench"
						? h(WbTabs, {
							t: t,
							route: route,
							onNavigate: navigate,
							reqAttention: reqAttention,
							openTasks: taskViews.filter(function (row) { return row.status === "pending"; }).length,
							runningTasks: taskViews.filter(function (row) { return row.status === "in_progress"; }).length
						})
						: null,
					h("div", { className: "daw-wb-body" + (route.kind === "workbench" && route.tab === "canvas" ? " daw-wb-body-full" : "") }, page)));
		}

		var plugin = { apply: apply, inject: inject };
		// 仅供离线自测：不可枚举，宿主读插件选项时看不到它。
		Object.defineProperty(plugin, "__test", {
			enumerable: false,
			value: {
				DEFAULTS: DEFAULTS,
				BASE_HEIGHT: BASE_HEIGHT,
				MAX_VISIBLE: MAX_VISIBLE,
				normalizeSettings: normalizeSettings,
				buildPod: buildPod,
				provisioningSince: provisioningSince,
				PROVISIONING_GRACE_MS: PROVISIONING_GRACE_MS,
				currentSessionId: currentSessionId,
				WB_TEXT: WB_TEXT,
				teamOf: teamOf,
				planPod: planPod,
				addDescendants: addDescendants,
				resolveOffsets: resolveOffsets,
				sessionTargetOf: sessionTargetOf,
				positions: positions,
				lineageOf: lineageOf,
				tasksOf: tasksOf,
				hasActiveTask: hasActiveTask,
				quipFor: quipFor,
				pickMoodKey: pickMoodKey,
				toolQuip: toolQuip,
				teamBarText: teamBarText,
				graphLayout: graphLayout,
				WhaleGraph: WhaleGraph,
				WhaleCanvasView: WhaleCanvasView,
				graphOpenStore: graphOpenStore,
				graphPositions: graphPositions,
				postGraphSend: postGraphSend,
				pickBubbleText: pickBubbleText,
				toolActivity: toolActivity,
				activityPoll: activityPoll,
				postVisitTools: postVisitTools,
				activityOf: activityOf,
				expanded: expanded,
				frameOf: frameOf,
				faceOf: faceOf,
				faceVariant: faceVariant,
				toolCategory: toolCategory,
				isWaiting: isWaiting,
				pendingOf: pendingOf,
				contextLeft: contextLeft,
				familyOf: familyOf,
				artStatus: artStatus,
				artLoader: artLoader,
				ART_RETRY_DELAYS: ART_RETRY_DELAYS,
				ART_MAX_ATTEMPTS: ART_MAX_ATTEMPTS,
				ART: function () { return ART; },
				Whale: Whale,
				ClassicWhale: ClassicWhale,
				WhaleLayer: WhaleLayer,
				WhaleSettingsSection: WhaleSettingsSection,
				WB_TOKENS: WB_TOKENS,
				WB_TEXT: WB_TEXT,
				WB_CSS: WB_CSS,
				wbRoute: wbRoute,
				wbRouteOf: wbRouteOf,
				wbPathOf: wbPathOf,
				wbEstimateTokens: wbEstimateTokens,
				wbBriefFill: wbBriefFill,
				wbTaskRowView: wbTaskRowView,
				wbReportRules: wbReportRules,
				wbInboxView: wbInboxView,
				wbRequirementRows: wbRequirementRows,
				wbRequirementSummary: wbRequirementSummary,
				WbRequirementList: WbRequirementList,
				WbProjectCard: WbProjectCard,
				WbReqsPage: WbReqsPage,
				WbReqDetail: WbReqDetail,
				wbRequirementDesignItems: wbRequirementDesignItems,
				WbDesignReview: WbDesignReview,
				WbRequirementCanvasPanel: WbRequirementCanvasPanel,
				WbCanvasInboxModal: WbCanvasInboxModal,
				WbDesignLiveBridge: WbDesignLiveBridge,
				wbRequirementActions: wbRequirementActions,
				wbRectFromDrag: wbRectFromDrag,
				wbRequirementCanvasItems: wbRequirementCanvasItems,
				wbZoomLevel: wbZoomLevel,
				wbMcpMatrix: wbMcpMatrix,
				wbMcpHas: wbMcpHas,
				wbMemberNames: wbMemberNames,
				wbRequirementByOwner: wbRequirementByOwner,
				wbOwnerFilterOptions: wbOwnerFilterOptions,
				wbRequirementFilter: wbRequirementFilter,
				wbRequirementFilterCounts: wbRequirementFilterCounts,
				wbRequirementCard: wbRequirementCard,
				wbFileToUpload: wbFileToUpload,
				wbE2eConfigDraft: wbE2eConfigDraft,
				wbE2eConfigPatch: wbE2eConfigPatch,
				WbE2eConfigPanel: WbE2eConfigPanel,
				WbReqRunCard: WbReqRunCard,
				wbWrite: wbWrite,
				WbCanvasPage: WbCanvasPage,
				wbCanvasEdges: wbCanvasEdges,
				wbNodeInspector: wbNodeInspector,
				wbAddableSessions: wbAddableSessions,
				wbLinkHandoffs: wbLinkHandoffs,
				WbNodeInspector: WbNodeInspector,
				wbCanvasNodes: wbCanvasNodes,
				wbWhereKey: wbWhereKey,
				wbCrc32: wbCrc32,
				wbUtf8: wbUtf8,
				wbBuildZip: wbBuildZip,
				wbSnapshotReadme: wbSnapshotReadme,
				wbSnapshotEntries: wbSnapshotEntries,
				wbExportSnapshot: wbExportSnapshot,
				wbMcpLinkPairs: wbMcpLinkPairs,
				wbMcpAllowedBySession: wbMcpAllowedBySession,
				wbNodePositions: wbNodePositions,
				wbCache: wbCache,
				wbFormatClock: wbFormatClock,
				wbElapsed: wbElapsed,
				wbApi: wbApi,
				wbSelectPanel: wbSelectPanel,
				wbOpenCanvasInRightSidebar: wbOpenCanvasInRightSidebar,
				wbHasInputActions: wbHasInputActions,
				wbDraftPrefix: wbDraftPrefix,
				wbInsertDraft: wbInsertDraft,
				WbSessionComposer: WbSessionComposer,
				WbPendingQuestion: WbPendingQuestion,
				wbQuestionItems: wbQuestionItems,
				wbQuestionAnswer: wbQuestionAnswer,
				WbStartPage: WbStartPage,
				WbBoundary: WbBoundary,
				wbLastExchange: wbLastExchange,
				wbAdoptCandidates: wbAdoptCandidates,
				wbFlowEdges: wbFlowEdges,
				wbReferenceNodes: wbReferenceNodes,
				wbFlowGroups: wbFlowGroups,
				wbFlowLayout: wbFlowLayout,
				wbFlowNodeSize: wbFlowNodeSize,
				wbProtoLayout: wbProtoLayout,
				wbProtoLoader: wbProtoLoader,
				wbPuckLoader: wbPuckLoader,
				wbFlowItems: wbFlowItems,
				wbFlowLoader: wbFlowLoader,
				WbFlowStage: WbFlowStage,
				WbProposalCard: WbProposalCard,
				wbProjectNameFrom: wbProjectNameFrom,
				wbWorkspaceItems: wbWorkspaceItems,
				wbTakePending: wbTakePending,
				wbSetPending: function (sessionId, text) { wbPendingFirst[String(sessionId)] = String(text); },
				wbGoalTitle: wbGoalTitle,
				wbGoalProjectId: wbGoalProjectId,
				wbProjectOfSession: wbProjectOfSession,
				WhaleGoalBar: WhaleGoalBar,
				WhaleProjectCanvasAction: WhaleProjectCanvasAction,
				WhaleWorkbench: WhaleWorkbench,
				WhalePanelEntry: WhalePanelEntry,
				WbProjectList: WbProjectList,
				WbTasksPage: WbTasksPage,
				WbBriefPage: WbBriefPage,
				WbInboxPage: WbInboxPage,
				wbFlowNodeTypes: wbFlowNodeTypes,
				wbElementRequirementId: wbElementRequirementId,
				wbRequirementBands: wbRequirementBands,
				wbFrameBox: wbFrameBox,
				WB_REQ_BAND: WB_REQ_BAND,
				WbTablePage: WbTablePage,
				WbTabs: WbTabs,
				WbTopbar: WbTopbar,
				wbTabOf: wbTabOf,
				WbHandoffsPanel: WbHandoffsPanel,
				WbEventsTimeline: WbEventsTimeline,
				WbSection: WbSection,
				WbTaskReplayModal: WbTaskReplayModal,
				wbTimelineView: wbTimelineView,
				wbTimelineStateTone: wbTimelineStateTone,
				WB_TIMELINE_STEPS: WB_TIMELINE_STEPS,
				wbAgentSteps: wbAgentSteps,
				wbGrowthLabel: wbGrowthLabel,
				wbScopeOverlaps: wbScopeOverlaps,
				wbDepLinks: wbDepLinks,
				wbComposerPrefix: wbComposerPrefix,
				wbVerifiedView: wbVerifiedView,
				wbReviewSignal: wbReviewSignal,
				wbArtifactsOutside: wbArtifactsOutside,
				wbAgentChip: wbAgentChip,
				WbExecPage: WbExecPage,
				WbOfficePage: WbOfficePage,
				wbOfficePose: wbOfficePose,
				wbOfficeSceneAt: wbOfficeSceneAt,
				wbIsRawPath: wbIsRawPath,
				wbOfficeTitle: wbOfficeTitle,
				wbOfficeShortId: wbOfficeShortId,
				WbAutoPanel: WbAutoPanel,
				wbAutoSecondsLeft: wbAutoSecondsLeft,
				WbSettingsPage: WbSettingsPage,
				settings: settings
			}
		});
		return plugin;
	}
});
