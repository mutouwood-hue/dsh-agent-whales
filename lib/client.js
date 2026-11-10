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
			".daw-layer[data-resting='1'] .daw-pod{filter:grayscale(.35) opacity(.72)}",
			// ── 图形编排面板 ──
			".daw-graph-toggle{pointer-events:auto;flex:none;margin:0 0 6px 6px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(17,25,50,.12));background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;cursor:pointer;box-shadow:0 2px 8px rgba(17,25,50,.10)}",
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
			/** 工作台主题（T-6）：light 默认；dark 是风格选项，只影响外观。 */
			theme: "light"
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
				teamBar: input.teamBar !== false,
				alwaysShow: input.alwaysShow !== false,
				tasks: input.tasks !== false,
				idleChildren: input.idleChildren !== false,
				draggable: input.draggable !== false,
				labels: input.labels === true,
				theme: input.theme === "dark" ? "dark" : "light"
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
		 * visitTools / controlToken：「串门工具」开关的宿主真相与写接口凭证。
		 *   这两项**只从宿主来**，不落 localStorage —— 否则刷新后会和宿主不一致，
		 *   用户还会看到自己手改出来的假状态。
		 * visitTools === undefined 表示「还没拿到第一次快照」，设置页据此显示未就绪。
		 */
		var toolActivity = (function () {
			var snapshot = { version: 0, map: {}, visitTools: undefined, controlToken: "", fetched: false, state: {} };
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
			/** 四项都没变就不换引用：useSyncExternalStore 靠这个避免抖动。 */
			function commit(next) {
				var sameState = JSON.stringify(next.state) === JSON.stringify(snapshot.state);
				if (sameMap(next.map, snapshot.map)
					&& next.visitTools === snapshot.visitTools
					&& next.controlToken === snapshot.controlToken
					&& next.fetched === snapshot.fetched
					&& sameState) return;
				snapshot = {
					version: snapshot.version + 1,
					map: next.map,
					visitTools: next.visitTools,
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
						// 宿主没给就沿用上一次：老版本宿主没有这两个字段时，开关停在「未就绪」而不是乱跳。
						visitTools: typeof data.visitTools === "boolean" ? data.visitTools : snapshot.visitTools,
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

		var Q_FRAMES = { base: "q-smile", blink: "q-blink", entry: "q-wave", exit: "q-proud", sleepy: "q-sleepy", think: "q-think", oops: "q-oops", celebrate: "q-cry", teamDone: "q-heart" };
		/** 成熟版：素材库里 C11/C13/C16/C18/C20/C83 是同一批头肩近景，可以做同样的逐帧。 */
		var M_FRAMES = { base: "m-base", blink: "m-blink", entry: "m-wave", exit: "m-proud", sleepy: "m-base", think: "m-think", oops: "m-oops", celebrate: "m-proud", teamDone: "m-proud" };
		/** 经典皮肤（像素小人）：没有心情轮换，但有思考 / 出错 / 完成三态。 */
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
		 * @param {object} row 宿主 state[sessionId]
		 * @param {number} now
		 * @param {object} settings 至少含 { stateFaces, errorFaces }
		 * @returns {"failed"|"celebrating"|"thinking"|"working"|"idle"}
		 */
		function faceOf(row, now, settings) {
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
			if (typeof item.lastTurnEndAt === "number"
				&& now - item.lastTurnEndAt >= 0
				&& now - item.lastTurnEndAt < FACE_CELEBRATE_MS
				&& (typeof item.lastRunMs !== "number" || item.lastRunMs >= FACE_MIN_RUN_MS)) {
				return "celebrating";
			}
			// 「思考」只在模型真的在输出时出现（用户拍板：宁可短，不要一直托腮）。
			if (item.streaming === true) return "thinking";
			return running ? "working" : "idle";
		}

		/** 状态 → 帧变体名；工作/空闲沿用原有逻辑，返回 undefined。 */
		function faceVariant(face) {
			if (face === "failed") return "oops";
			if (face === "thinking") return "think";
			if (face === "celebrating") return "celebrate";
			if (face === "teamDone") return "teamDone";
			return undefined;
		}

		/**
		 * 取某个状态该用哪张图。
		 * @param {string} skin  mix | q | mature | classic
		 * @param {boolean} isLead
		 * @param {string} variant base | blink | entry | exit | sleepy
		 * @returns {string|undefined} ART 的 key；undefined 表示该皮肤没有位图（走矢量）
		 */
		function frameOf(skin, isLead, variant) {
			var family = familyOf(skin, isLead);
			if (family === "classic") return undefined;
			var frames = family === "mature" ? M_FRAMES : Q_FRAMES;
			var key = frames[variant] || frames.base;
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
					props.labels ? h("span", { className: "daw-label", title: whale.label }, whale.label) : null
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
			var statusMap = useSessionStatus(function (state) { return state || EMPTY_STATUS; }) || EMPTY_STATUS;
			if (inputsRef.current === null) inputsRef.current = { status: statusMap, settings: snap };
			if (selectorRef.current === null) selectorRef.current = createPodSelector(inputsRef, props.leadIdOf);
			if (teamSelectorRef.current === null) teamSelectorRef.current = createTeamSelector(props.leadIdOf);
			inputsRef.current.status = statusMap;
			inputsRef.current.settings = snap;
			return {
				pod: useSessions(selectorRef.current),
				team: useSessions(teamSelectorRef.current)
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
						var rowFace = faceOf(activitySnap && activitySnap.state ? activitySnap.state[whale.key] : undefined, Date.now(), snap);
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
							// 只有 Q 版有心情帧；成熟版那套没有逐帧素材。
							moodKey: leavingByKey[whale.key] !== true
								? pickMoodKey(familyOf(effectiveSkin, whale.lead), whale.phase, tick)
								: undefined,
							activity: snap.bubbles ? bubbleTextOf(whale, index) : undefined,
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
					// 图形编排面板的开关：常驻在队形尾部，不参与计数。
					h("button", {
						className: "daw-graph-toggle" + (graphOpen ? " is-on" : ""),
						type: "button",
						"aria-pressed": graphOpen ? "true" : "false",
						title: t("graphTitle"),
						onClick: function (event) {
							if (event && typeof event.stopPropagation === "function") event.stopPropagation();
							graphOpenStore.set(!graphOpen);
						}
					}, t("graph"))
				),
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
				"teamBar": "团队汇总",
				"visitTools": "串门工具",
				"visitToolsHint": "让智能体可以列出、读取并给其它会话发消息（每轮请求会多带 4 个工具定义）。",
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
				"canvasTitle": "画布",
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
				"teamBar": "Team summary",
				"visitTools": "Visit tools",
				"visitToolsHint": "Let agents list, read, and message other sessions (adds 4 tool definitions to every request).",
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
				"canvasTitle": "Canvas",
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
		 * P0：会话内的「画布」视图（只读）。
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

			// P0：与官方 Chat / Trajectory 并列的「画布」视图（只读，不影子官方渲染）。
			mountSeat("canvas", "conversation.view", {
				name: "conversation.view",
				id: "whales-canvas",
				order: 60,
				label: "画布 · Agent Whales",
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

			// P2：独立主面板。main 是 keyed 槽——只用我们自己的 key，绝不覆盖 conversation
			// （§45.4 约束 1）；keyed 槽按 {key, priority, locale} 认选项，不传 id/order。
			// 顶栏「一键回退」切回官方会话。
			mountSeat("workbench", "main", {
				name: "main",
				key: "whales-canvas",
				locale: WB_NS,
				inject: function () { return { leadIdOf: leadIdOf, focusSession: focusSession }; }
			}, WhaleWorkbench);

			// 侧栏全局面板入口（list 槽 {id, order}）；点了才切面板，不默认抢占。
			mountSeat("panel-entry", "sidebar.panellist", {
				name: "sidebar.panellist",
				id: "whales-canvas",
				order: 40,
				locale: WB_NS,
				inject: function () { return { focusSession: focusSession }; }
			}, WhalePanelEntry);

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
		var WB_API = "/agent-whales/api";
		var WB_POLL_MS = 5000;

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
				"nav.handoffs": "发送记录",
				"nav.events": "事件台",
				"nav.team": "团队",
				"nav.settings": "设置",
				"brand.name": "dsh-agent-whales",
				"brand.sub": "v0.24 · 项目工作台",
				"top.search": "搜索项目 / 任务 / 消息",
				"top.running": "执行中 {count}",
				"top.back": "一键回退",
				"top.view.canvas": "画布",
				"top.view.chat": "Chat（官方）",
				"list.title": "项目",
				"list.desc": "每个项目是独立容器：一个主对话 + 若干项目对话 + 一张任务表",
				"list.new": "＋ 新建项目",
				"list.stat.active": "进行中项目",
				"list.stat.inbox": "待我处理",
				"list.stat.tickets": "执行中工单",
				"list.stat.events": "今日事件",
				"list.card.members": "成员 {count}",
				"list.card.tasks": "任务 {done}/{total}",
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
				"common.none": "—",
				"common.close": "关闭",
				"common.cancel": "取消",
				"common.confirm": "确认",
				"common.save": "保存",
				"common.refresh": "刷新",
				"tab.canvas": "画布",
				"tab.tasks": "任务",
				"tab.brief": "简报",
				"tab.exec": "执行",
				"tab.note.canvas": "画布只承载三类节点：上下文 / Agent / Composer",
				"tab.note.tasks": "任务走插件自建任务表；依赖 blockedBy 只在这里，不上画布",
				"tab.note.brief": "共享上下文只有两层：项目简报 + 按需读取；每轮自动注入已被否决",
				"tab.note.exec": "worker 无人值守在子工作树干活；人只看状态、日志尾部与 report",
				"canvas.goal": "目标：{goal}",
				"canvas.goal.none": "还没写目标：在简报里补一条项目目标",
				"canvas.node.folder": "文件夹 · 本地",
				"canvas.node.agent": "Agent",
				"canvas.node.composer": "Composer · 会话即画布",
				"canvas.empty": "画布上还没有任务。选好上下文后直接发送，或先加一个 Agent。",
				"canvas.empty.send": "发送到主对话",
				"canvas.zoom": "缩放",
				"canvas.zoomFit": "适应画布",
				"canvas.guide": "操作指南",
				"canvas.hint": "滚轮上下 · Shift+滚轮左右 · Ctrl+滚轮缩放 · 拖动空白平移",
				"canvas.delete.title": "删除节点",
				"canvas.delete.body": "删除「{name}」只解除画布引用：不影响会话、不影响任务。",
				"canvas.delete.affected": "受影响：{agents} 个 Agent · {tasks} 个进行中任务（标记 handed_back，不自动取消）",
				"canvas.link.deny": "这条连线不被允许：自连 / 重复连线 / 跨项目都会被拒绝",
				"canvas.link.new": "松开鼠标建关联线；删除需再次确认",
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
				"exec.popover.human": "只能人关",
				"inbox.title": "需要我处理（{count}）",
				"inbox.desc": "只汇总需要人决定的事；不替用户做决定，也不自动重派",
				"inbox.group.proposals": "提案待确认",
				"inbox.action.proposal": "查看提案",
				"inbox.action.report": "查看 report · 给人决定",
				"inbox.action.handed": "查看 report · 改派或关闭",
				"inbox.action.task": "查看任务",
				"inbox.foot": "human_action / handed_back 来自 worker 的 report：worker 只能发起，关闭只能人把 report 改 done 或删除任务",
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
				"event.title": "事件台",
				"event.desc": "事件先进来评估，再决定开工单还是忽略；与发送记录是前后两个面",
				"event.pending": "待评估 {count}",
				"event.filter.all": "全部",
				"event.state.pending": "待评估",
				"event.state.opened": "已开工单",
				"event.state.ignored": "已忽略",
				"event.state.suppressed": "已抑制",
				"event.action.note": "开工单 = 进任务表 + 执行台；忽略 = 留痕不建单",
				"event.foot": "自激保护已开启：同类事件 10 分钟内只评估一次；被标记为噪声的 Source 24 小时内不再进收件箱",
				"event.empty": "还没有事件：主会话消息、工作区变更与定时触发会先进这里评估。",
				"first.welcome": "把项目搬进节点画布",
				"first.desc": "上下文、Agent、Composer 三类节点摆在一张图上；消息在连线上走，任务在节点里长。默认不进画布——你上次选了什么，下次就还是什么。",
				"first.step1": "选上下文",
				"first.step1.desc": "仓库或文件夹拖上画布，Agent 才有活干",
				"first.step2": "加 Agent",
				"first.step2.desc": "最多 3 个；每个 Agent 是一个独立会话",
				"first.step3": "直接发送",
				"first.step3.desc": "在 Composer 里说话，或派一个任务给它",
				"first.switch": "切到节点画布 View",
				"first.card.official": "不替换官方会话",
				"first.card.official.desc": "官方消息流与审批渲染原样保留；画布是另一个 View，随时切回",
				"first.card.nodispatch": "不自动重派",
				"first.card.nodispatch.desc": "派发结果三态分开报；未知不自动重派，等人决定",
				"first.card.dark": "暗色是选项",
				"first.card.dark.desc": "默认浅色；想要暗色在设置里开，两种都验收过",
				"set.menu.general": "通用",
				"set.menu.look": "外观",
				"set.menu.worker": "执行器",
				"set.menu.notify": "通知",
				"set.menu.about": "关于",
				"set.theme": "外观 · 主题",
				"set.theme.light": "浅色（默认）",
				"set.theme.dark": "暗色",
				"set.worker": "执行器 · worker preset",
				"set.worker.preset": "执行 Session 预设",
				"set.worker.dir": "工单目录",
				"set.worker.dir.desc": "<workspace>/.dsh-agent-whales/work/<ticketId>；无 workspaceRoot 时回退 execRoot",
				"set.worker.dedupe": "同类事件抑制",
				"set.worker.dedupe.desc": "同类事件 10 分钟内只评估一次",
				"set.worker.noise": "噪声 Source 屏蔽",
				"set.worker.noise.desc": "被标记为噪声的 Source 24 小时内不再进收件箱",
				"set.foot": "默认浅色，暗色为风格选项（两种都已验收）；改主题只影响外观，不影响落点、preset 与任何已留痕数据",
				"team.desc": "团队成员来自宿主名册；项目成员关系由插件项目注册表维护，两者不混。",
				"team.host": "宿主团队（只读）",
				"about.desc": "鲸鱼娘是角色的表现层，不是产品模型本身；权威状态只看卡片与徽标。"
			},
			en: {
				"nav.projects": "Projects",
				"nav.inbox": "Needs me",
				"nav.handoffs": "Handoffs",
				"nav.events": "Events",
				"nav.team": "Team",
				"nav.settings": "Settings",
				"brand.name": "dsh-agent-whales",
				"brand.sub": "v0.24 · Project workbench",
				"top.search": "Search projects / tasks / messages",
				"top.running": "{count} running",
				"top.back": "Back to Chat",
				"top.view.canvas": "Canvas",
				"top.view.chat": "Chat (official)",
				"list.title": "Projects",
				"list.desc": "Each project is an isolated container: one main conversation, member conversations, and one task table",
				"list.new": "＋ New project",
				"list.stat.active": "Active projects",
				"list.stat.inbox": "Needs me",
				"list.stat.tickets": "Running tickets",
				"list.stat.events": "Events today",
				"list.card.members": "{count} members",
				"list.card.tasks": "Tasks {done}/{total}",
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
				"common.none": "—",
				"common.close": "Close",
				"common.cancel": "Cancel",
				"common.confirm": "Confirm",
				"common.save": "Save",
				"common.refresh": "Refresh",
				"tab.canvas": "Canvas",
				"tab.tasks": "Tasks",
				"tab.brief": "Brief",
				"tab.exec": "Exec",
				"tab.note.canvas": "The canvas carries three node kinds only: context / Agent / Composer",
				"tab.note.tasks": "Tasks live in the plugin task table; blockedBy dependencies stay here, never on the canvas",
				"tab.note.brief": "Shared context is two layers: project brief + on-demand reads; per-turn injection was rejected",
				"tab.note.exec": "Workers run unattended in a sub-worktree; humans watch status, log tail and report",
				"canvas.goal": "Goal: {goal}",
				"canvas.goal.none": "No goal yet: add one in the brief",
				"canvas.node.folder": "Folder · local",
				"canvas.node.agent": "Agent",
				"canvas.node.composer": "Composer · session as canvas",
				"canvas.empty": "No tasks on the canvas yet. Pick a context and send, or add an Agent first.",
				"canvas.empty.send": "Send to main conversation",
				"canvas.zoom": "Zoom",
				"canvas.zoomFit": "Fit",
				"canvas.guide": "Guide",
				"canvas.hint": "Wheel vertical · Shift+wheel horizontal · Ctrl+wheel zoom · drag blank to pan",
				"canvas.delete.title": "Delete node",
				"canvas.delete.body": "Deleting “{name}” only drops the canvas reference: sessions and tasks are untouched.",
				"canvas.delete.affected": "Affected: {agents} Agents · {tasks} in-progress tasks (marked handed_back, never auto-cancelled)",
				"canvas.link.deny": "This link is not allowed: self-links, duplicates and cross-project links are rejected",
				"canvas.link.new": "Release to create the link; deleting needs confirmation",
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
				"exec.popover.human": "human-only",
				"inbox.title": "Needs me ({count})",
				"inbox.desc": "Only decisions that need a human; never decides for you, never re-dispatches",
				"inbox.group.proposals": "Proposal to confirm",
				"inbox.action.proposal": "View proposal",
				"inbox.action.report": "View report · decide",
				"inbox.action.handed": "View report · reassign or close",
				"inbox.action.task": "View task",
				"inbox.foot": "human_action / handed_back come from a worker's report: a worker only initiates; closing is a human setting report to done or deleting the task",
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
				"event.title": "Events",
				"event.desc": "Events are assessed first, then opened as a ticket or ignored; the counterpart of handoffs",
				"event.pending": "{count} to assess",
				"event.filter.all": "All",
				"event.state.pending": "To assess",
				"event.state.opened": "Ticket opened",
				"event.state.ignored": "Ignored",
				"event.state.suppressed": "Suppressed",
				"event.action.note": "Open ticket = task table + exec bench; ignore = keep a trace, no ticket",
				"event.foot": "Self-excitation protection is on: same-kind events are assessed once per 10 minutes; noise-marked sources stay out of the inbox for 24 hours",
				"event.empty": "No events yet: main-session messages, workspace changes and schedule triggers land here first.",
				"first.welcome": "Move your project onto the node canvas",
				"first.desc": "Context, Agent and Composer nodes on one graph; messages travel on links, tasks grow inside nodes. The canvas is not the default — whatever you chose last time stays.",
				"first.step1": "Pick context",
				"first.step1.desc": "Drag a repository or folder on, or Agents have nothing to do",
				"first.step2": "Add Agents",
				"first.step2.desc": "Up to 3; each Agent is its own session",
				"first.step3": "Just send",
				"first.step3.desc": "Talk in the Composer, or dispatch a task to it",
				"first.switch": "Switch to the canvas View",
				"first.card.official": "Official session untouched",
				"first.card.official.desc": "Official message flow and approval rendering stay as-is; the canvas is another View, one click away",
				"first.card.nodispatch": "No auto re-dispatch",
				"first.card.nodispatch.desc": "Dispatch results report three states; unknown waits for a human",
				"first.card.dark": "Dark is an option",
				"first.card.dark.desc": "Light by default; turn dark on in settings — both are verified",
				"set.menu.general": "General",
				"set.menu.look": "Appearance",
				"set.menu.worker": "Executor",
				"set.menu.notify": "Notifications",
				"set.menu.about": "About",
				"set.theme": "Appearance · theme",
				"set.theme.light": "Light (default)",
				"set.theme.dark": "Dark",
				"set.worker": "Executor · worker preset",
				"set.worker.preset": "Execution session preset",
				"set.worker.dir": "Ticket directory",
				"set.worker.dir.desc": "<workspace>/.dsh-agent-whales/work/<ticketId>; falls back to execRoot without workspaceRoot",
				"set.worker.dedupe": "Same-kind suppression",
				"set.worker.dedupe.desc": "Same-kind events are assessed once per 10 minutes",
				"set.worker.noise": "Noise source muting",
				"set.worker.noise.desc": "Noise-marked sources stay out of the inbox for 24 hours",
				"set.foot": "Light by default, dark as a style option (both verified); the theme only changes appearance, never worktrees, presets or recorded facts",
				"team.desc": "Team members come from the host roster; project membership is kept by the plugin project registry. The two never mix.",
				"team.host": "Host team (read-only)",
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
		function wbRouteOf(path) {
			var source = typeof path === "string" ? path : "";
			var parts = source.split("/").filter(function (part) { return part !== ""; });
			if (parts.length === 0) return { kind: "list" };
			var head = parts[0];
			if (head === "p" && parts.length >= 2) {
				var tab = parts.length >= 3 ? parts[2] : "canvas";
				return { kind: "workbench", projectId: decodeURIComponent(parts[1]), tab: ["canvas", "tasks", "brief", "exec"].indexOf(tab) >= 0 ? tab : "canvas" };
			}
			if (["inbox", "handoffs", "events", "team", "settings", "first"].indexOf(head) >= 0) return { kind: head };
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

		/**
		 * 画布图布局：三类节点 + 无向关联线。位置由调用方给出（拖拽后单独持久化），
		 * 这里只负责把「节点 + 关联」折算成可渲染的边（贝塞尔用二次曲线近似）。
		 */
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
					x1: (a.x || 0) + (a.w || 0) / 2, y1: (a.y || 0) + (a.h || 0) / 2,
					x2: (b.x || 0) + (b.w || 0) / 2, y2: (b.y || 0) + (b.h || 0) / 2
				});
			}
			return edges;
		}

		// ── M6 工作台样式（token 见 WB_TOKENS；只引用 var(--daw-*)，切主题即换色）──
		var WB_CSS = [
			".daw-wb{--daw-bg:#EEF1F6;--daw-surface:#FFFFFF;--daw-surface-muted:#FAFBFD;--daw-border:#DCE2EE;--daw-text:#1B2333;--daw-text-secondary:#4A5468;--daw-text-muted:#8A93A6;--daw-brand:#3B55F0;--daw-ok:#22A06B;--daw-warn:#E0A018;--daw-danger:#D64545;--daw-accent:#C05BD0;--daw-ok-bg:#EAF7F0;--daw-warn-bg:#FDF6E7;--daw-danger-bg:#FDF0F0;--daw-accent-bg:#F9EFFA;display:flex;height:100%;min-height:0;background:var(--daw-bg);color:var(--daw-text);font-family:'Noto Sans SC',system-ui,-apple-system,sans-serif;font-size:12px;line-height:1.5;box-sizing:border-box}",
			".daw-wb *,.daw-wb *::before,.daw-wb *::after{box-sizing:border-box}",
			".daw-wb[data-wb-theme=dark]{--daw-bg:#101318;--daw-surface:#181B22;--daw-surface-muted:#1F232C;--daw-border:#2A2F3A;--daw-text:#E8EAEE;--daw-text-secondary:#A0A6B0;--daw-text-muted:#6B7280;--daw-brand:#5B8CFF;--daw-ok:#3FB27F;--daw-warn:#E0A018;--daw-danger:#E06C6C;--daw-accent:#C879E0;--daw-ok-bg:#12241C;--daw-warn-bg:#2A2415;--daw-danger-bg:#2E1A1A;--daw-accent-bg:#261B2B}",
			".daw-wb-side{width:232px;flex:none;background:var(--daw-surface);padding:16px 12px;display:flex;flex-direction:column;gap:2px;overflow:auto;border-right:1px solid var(--daw-border)}",
			".daw-wb-brand{display:flex;align-items:center;gap:9px;padding:0 4px 14px}",
			".daw-wb-brand-icon{width:30px;height:30px;flex:none;border-radius:9px;background:var(--daw-brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px}",
			".daw-wb-brand-text{display:flex;flex-direction:column;gap:1px;min-width:0}",
			".daw-wb-brand-name{font-size:12.5px;font-weight:700;color:var(--daw-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".daw-wb-brand-sub{font-size:9px;color:var(--daw-text-muted)}",
			".daw-wb-nav{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border-radius:8px;border:0;background:var(--daw-surface);color:var(--daw-text-secondary);font-size:12px;font-family:inherit;cursor:pointer;text-align:left}",
			".daw-wb-nav:hover{background:var(--daw-surface-muted)}",
			".daw-wb-nav[data-on=true]{background:var(--daw-brand);color:#fff;font-weight:700}",
			".daw-wb-nav-dot{width:6px;height:6px;flex:none;border-radius:999px;background:var(--daw-text-muted)}",
			".daw-wb-nav[data-on=true] .daw-wb-nav-dot{background:#fff}",
			".daw-wb-nav-fill{flex:1;min-width:0}",
			".daw-wb-nav-badge{padding:1px 7px;border-radius:999px;background:var(--daw-danger-bg);color:var(--daw-danger);font-size:9.5px;font-weight:700;font-variant-numeric:tabular-nums}",
			".daw-wb-nav[data-on=true] .daw-wb-nav-badge{background:rgba(255,255,255,.24);color:#fff}",
			".daw-wb-sidespacer{flex:1;min-height:12px}",
			".daw-wb-user{margin-top:8px;display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:9px;background:var(--daw-surface-muted)}",
			".daw-wb-avatar{width:26px;height:26px;flex:none;border-radius:999px;background:var(--daw-brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}",
			".daw-wb-user-name{font-size:11px;font-weight:700;color:var(--daw-text)}",
			".daw-wb-user-sub{font-size:9px;color:var(--daw-ok)}",
			".daw-wb-main{flex:1;min-width:0;display:flex;flex-direction:column}",
			".daw-wb-top{height:56px;flex:none;display:flex;align-items:center;gap:12px;padding:0 24px;background:var(--daw-surface);border-bottom:1px solid var(--daw-border)}",
			".daw-wb-crumb{font-size:12px;color:var(--daw-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".daw-wb-run{display:flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:var(--daw-ok-bg);color:var(--daw-ok);font-size:10.5px;font-weight:700;white-space:nowrap}",
			".daw-wb-run i{width:6px;height:6px;border-radius:50%;background:var(--daw-ok)}",
			".daw-wb-search{margin-left:auto;display:flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--daw-border);background:var(--daw-surface-muted);color:var(--daw-text-muted);font-size:11px;min-width:200px;max-width:280px;flex:1}",
			".daw-wb-viewseg{display:flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:var(--daw-surface-muted);border:1px solid var(--daw-border)}",
			".daw-wb-viewseg button{padding:3px 10px;border:0;border-radius:7px;background:none;color:var(--daw-text-secondary);font-size:11px;font-family:inherit;cursor:pointer}",
			".daw-wb-viewseg button[data-on=true]{background:var(--daw-surface);color:var(--daw-text);font-weight:700;box-shadow:0 1px 3px rgba(17,25,50,.12)}",
			".daw-wb-tabs{height:44px;flex:none;display:flex;align-items:center;gap:4px;padding:0 24px;background:var(--daw-surface);border-bottom:1px solid var(--daw-border);overflow-x:auto}",
			".daw-wb-tab{display:flex;align-items:center;gap:6px;padding:5px 12px;border:0;border-radius:8px;background:none;color:var(--daw-text-secondary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}",
			".daw-wb-tab[data-on=true]{background:var(--daw-surface-muted);color:var(--daw-text);font-weight:700;box-shadow:inset 0 -2px 0 var(--daw-brand)}",
			".daw-wb-tab-badge{padding:0 6px;border-radius:999px;background:var(--daw-danger-bg);color:var(--daw-danger);font-size:9.5px;font-weight:700}",
			".daw-wb-tabnote{margin-left:auto;padding-left:16px;font-size:10.5px;color:var(--daw-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".daw-wb-body{flex:1;min-height:0;overflow:auto;padding:24px}",
			".daw-wb-page{display:flex;flex-direction:column;gap:20px;max-width:1208px}",
			".daw-wb-pagehead{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}",
			".daw-wb-h1{font-size:18px;font-weight:700;color:var(--daw-text);margin:0}",
			".daw-wb-desc{font-size:11.5px;color:var(--daw-text-secondary);margin-top:4px}",
			".daw-wb-headfill{flex:1}",
			".daw-wb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 14px;border-radius:9px;border:1px solid var(--daw-brand);background:var(--daw-brand);color:#fff;font-size:12px;font-family:inherit;font-weight:700;cursor:pointer;white-space:nowrap}",
			".daw-wb-btn:disabled{opacity:.5;cursor:not-allowed}",
			".daw-wb-btn[data-variant=ghost]{background:var(--daw-surface);color:var(--daw-text-secondary);border-color:var(--daw-border);font-weight:400}",
			".daw-wb-btn[data-variant=danger]{background:var(--daw-danger);border-color:var(--daw-danger)}",
			".daw-wb-btn[data-variant=small]{padding:4px 10px;font-size:11px;border-radius:8px}",
			".daw-wb-stats{display:flex;gap:12px;flex-wrap:wrap}",
			".daw-wb-stat{flex:1;min-width:180px;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:14px 16px}",
			".daw-wb-stat-v{font-size:22px;font-weight:700;color:var(--daw-text);font-variant-numeric:tabular-nums}",
			".daw-wb-stat-n{font-size:10.5px;color:var(--daw-text-muted);margin-top:2px}",
			".daw-wb-grid{display:flex;flex-wrap:wrap;gap:16px}",
			".daw-wb-card{width:380px;max-width:100%;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;text-align:left;font-family:inherit;cursor:pointer;color:inherit}",
			".daw-wb-card:hover{border-color:var(--daw-brand)}",
			".daw-wb-card-head{display:flex;align-items:center;gap:10px}",
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
			".daw-wb-filter[data-on=true]{background:var(--daw-brand);border-color:var(--daw-brand);color:#fff;font-weight:700}",
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
			".daw-wb-label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--daw-text-secondary)}",
			".daw-wb-mask{position:fixed;inset:0;background:rgba(13,18,28,.44);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}",
			".daw-wb-modal{width:560px;max-width:100%;max-height:100%;overflow:auto;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 48px rgba(10,15,30,.3)}",
			".daw-wb-modal-title{font-size:14px;font-weight:700}",
			".daw-wb-modal-foot{display:flex;gap:8px;justify-content:flex-end}",
			".daw-wb-canvaswrap{position:relative;flex:1;min-height:540px;display:flex;flex-direction:column;gap:12px}",
			".daw-wb-canvas{position:relative;flex:1;min-height:520px;overflow:hidden;background:var(--daw-bg);border:1px solid var(--daw-border);border-radius:12px;touch-action:none}",
			".daw-wb-canvas-grid{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(to right,var(--daw-border) 1px,transparent 1px),linear-gradient(to bottom,var(--daw-border) 1px,transparent 1px);background-size:32px 32px;opacity:.5}",
			".daw-wb-stage{position:absolute;left:0;top:0;transform-origin:0 0}",
			".daw-wb-link{position:absolute;pointer-events:none;overflow:visible}",
			".daw-wb-link path{fill:none;stroke:var(--daw-text-muted);stroke-width:1.5}",
			".daw-wb-link[data-selected=true] path{stroke:var(--daw-brand);stroke-width:2.5}",
			".daw-wb-node{position:absolute;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:10px 12px;box-shadow:0 2px 10px rgba(17,25,50,.07);cursor:grab;user-select:none;display:flex;flex-direction:column;gap:6px}",
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
			".daw-wb-zoombar{position:absolute;left:12px;bottom:12px;display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:999px;background:var(--daw-surface);border:1px solid var(--daw-border);box-shadow:0 2px 8px rgba(17,25,50,.1)}",
			".daw-wb-zoombar button{width:22px;height:22px;border:0;border-radius:999px;background:var(--daw-surface-muted);color:var(--daw-text-secondary);font-size:13px;line-height:1;cursor:pointer}",
			".daw-wb-zoombar span{font-size:10.5px;color:var(--daw-text-secondary);min-width:38px;text-align:center;font-variant-numeric:tabular-nums}",
			".daw-wb-zoombar .daw-wb-zoomtext{border:0;background:none;cursor:pointer;font-size:10px;padding:0 6px;width:auto;min-width:0}",
			".daw-wb-mini{position:absolute;right:12px;bottom:12px;width:160px;height:100px;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:9px;overflow:hidden;box-shadow:0 2px 8px rgba(17,25,50,.1)}",
			".daw-wb-mini-block{position:absolute;border-radius:2px;background:var(--daw-text-muted);opacity:.55}",
			".daw-wb-mini-view{position:absolute;border:1.5px solid var(--daw-brand);border-radius:3px}",
			".daw-wb-canvas-hint{font-size:10.5px;color:var(--daw-text-muted)}",
			".daw-wb-ticket{background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
			".daw-wb-ticket-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:var(--daw-text-secondary);background:var(--daw-surface-muted);border-radius:9px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;max-height:96px;overflow:auto}",
			".daw-wb-group{display:flex;flex-direction:column;gap:10px}",
			".daw-wb-group-head{display:flex;align-items:center;gap:8px}",
			".daw-wb-todo{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;background:var(--daw-surface);border:1px solid var(--daw-border);border-radius:12px}",
			".daw-wb-todo-index{width:24px;height:24px;flex:none;border-radius:999px;background:var(--daw-surface-muted);color:var(--daw-text-secondary);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}",
			".daw-wb-todo-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
			".daw-wb-todo-text{font-size:12.5px;color:var(--daw-text)}",
			".daw-wb-todo-src{font-size:10.5px;color:var(--daw-text-muted)}",
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
			".daw-wb-event-sub{font-size:10.5px;color:var(--daw-text-muted)}"
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

		/** 信封解包：code !== 200 一律当失败（宿主业务码语义见 lib/index.js）。 */
		function wbUnwrap(payload) {
			if (!payload || typeof payload !== "object") throw new Error("bad payload");
			var code = typeof payload.code === "number" ? payload.code : 0;
			if (code !== 200) throw new Error(typeof payload.msg === "string" && payload.msg !== "" ? payload.msg : ("code " + code));
			return payload.data === undefined ? null : payload.data;
		}

		/**
		 * 只读资源缓存：一个 URL 一份快照 + 引用计数轮询。
		 * 为什么模块级：工作台多个组件读同一份数据（任务表同时被画布/任务页/待办用），
		 * 各起各的轮询会把 2s 级的宿主快照拉爆。
		 */
		var wbCache = (function () {
			var entries = {};
			function entryOf(url) {
				var entry = entries[url];
				if (entry === undefined) {
					entry = {
						url: url, data: undefined, error: null, loading: false, at: 0,
						listeners: new Set(), timer: null, inflight: null, view: { data: undefined, error: null, loading: false, at: 0 }
					};
					entries[url] = entry;
				}
				return entry;
			}
			function publish(entry) {
				entry.view = { data: entry.data, error: entry.error, loading: entry.loading, at: entry.at };
				entry.listeners.forEach(function (listener) { listener(); });
			}
			function load(entry) {
				if (entry.inflight !== null) return entry.inflight;
				entry.loading = true;
				publish(entry);
				entry.inflight = wbApi(entry.url).then(function (payload) {
					entry.data = wbUnwrap(payload);
					entry.error = null;
					entry.at = Date.now();
				}).catch(function (error) {
					// 信封业务码非 200 是在「履行路径里抛错」，只挂第二参捕获不到，必须用 catch。
					entry.error = error && error.message ? error.message : String(error);
				}).then(function () {
					entry.loading = false;
					entry.inflight = null;
					publish(entry);
				});
				return entry.inflight;
			}
			return {
				subscribe: function (url, listener) {
					var entry = entryOf(url);
					entry.listeners.add(listener);
					if (entry.timer === null) {
						load(entry);
						entry.timer = setInterval(function () { load(entry); }, WB_POLL_MS);
					}
					return function () {
						entry.listeners.delete(listener);
						if (entry.listeners.size === 0 && entry.timer !== null) {
							clearInterval(entry.timer);
							entry.timer = null;
						}
					};
				},
				getSnapshot: function (url) { return entryOf(url).view; },
				/** 立即读一次（ mutations 后手动刷新用；与轮询共用去重）。 */
				read: function (url) {
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
						if (entry.listeners.size > 0) load(entry);
					});
				},
				/** 仅供离线测试：清掉所有条目与轮询。 */
				reset: function () {
					Object.keys(entries).forEach(function (url) {
						var entry = entries[url];
						if (entry.timer !== null) clearInterval(entry.timer);
					});
					entries = {};
				}
			};
		})();

		/** 组件里读一份只读资源：useSyncExternalStore(订阅, 快照)。 */
		function useWb(url) {
			return react.useSyncExternalStore(
				function (listener) { return wbCache.subscribe(url, listener); },
				function () { return wbCache.getSnapshot(url); },
				function () { return wbCache.getSnapshot(url); }
			);
		}

		// ── M6 工作台组件 ────────────────────────────────────────────────────────

		/** apply 期留一份 ctx：面板入口要在组件里切宿主 layout 服务。 */
		var wbCtx = null;

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

		/** sidebar.panellist 入口：一个图标 + 文案的按钮，点了才进工作台。 */
		function WhalePanelEntry(props) {
			var t = wbT(props);
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
			var value = { kind: "list" };
			return {
				get: function () { return value; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				set: function (next) {
					value = next && typeof next === "object" ? next : { kind: "list" };
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
			return h("div", { className: "daw-wb-mask", onClick: function (event) { if (event && event.target === event.currentTarget && props.onClose) props.onClose(); } },
				h("div", { className: "daw-wb-modal", role: "dialog", "aria-label": props.title },
					h("div", { className: "daw-wb-modal-title" }, props.title),
					props.children,
					h("div", { className: "daw-wb-modal-foot" },
						props.onClose ? h(WbBtn, { variant: "ghost", onClick: props.onClose }, t("common.cancel")) : null,
						props.footer)));
		}

		function WbState(props) {
			var t = wbT(props);
			if (props.error) {
				return h("div", { className: "daw-wb-state" },
					h("div", null, t("common.error") + " · " + props.error),
					h(WbBtn, { variant: "ghost", onClick: props.onRetry }, t("common.retry")));
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
					parentSessionId: row.parentId === undefined ? undefined : row.parentId
				};
			});
		}

		// ── 侧栏 / 顶栏 / 工作台外壳 ───────────────────────────────────────────

		function WbSidebar(props) {
			var t = wbT(props);
			var inbox = useWb("/inbox");
			var events = useWb("/events");
			var route = props.route;
			var counts = wbInboxView(inbox.data);
			var eventCount = events.data && Array.isArray(events.data.events)
				? events.data.events.filter(function (row) { return row && row.state === "pending"; }).length
				: 0;
			var items = [
				{ key: "list", label: t("nav.projects"), badge: 0 },
				{ key: "inbox", label: t("nav.inbox"), badge: counts.total },
				{ key: "handoffs", label: t("nav.handoffs"), badge: 0 },
				{ key: "events", label: t("nav.events"), badge: eventCount },
				{ key: "team", label: t("nav.team"), badge: 0 },
				{ key: "settings", label: t("nav.settings"), badge: 0 }
			];
			function active(key) {
				if (route.kind === "workbench") return key === "list";
				return route.kind === key;
			}
			return h("aside", { className: "daw-wb-side" },
				h("div", { className: "daw-wb-brand" },
					h("div", { className: "daw-wb-brand-icon" }, "🐋"),
					h("div", { className: "daw-wb-brand-text" },
						h("div", { className: "daw-wb-brand-name" }, t("brand.name")),
						h("div", { className: "daw-wb-brand-sub" }, t("brand.sub")))),
				items.map(function (item) {
					return h("button", {
						key: item.key,
						type: "button",
						className: "daw-wb-nav",
						"data-on": String(active(item.key)),
						onClick: function () { wbRoute.kind(item.key); }
					},
						h("span", { className: "daw-wb-nav-dot" }),
						h("span", { className: "daw-wb-nav-fill" }, item.label),
						item.badge > 0 ? h("span", { className: "daw-wb-nav-badge" }, String(item.badge)) : null);
				}),
				h("div", { className: "daw-wb-sidespacer" }),
				h("div", { className: "daw-wb-user" },
					h("div", { className: "daw-wb-avatar" }, "宿"),
					h("div", null,
						h("div", { className: "daw-wb-user-name" }, t("team.host")),
						h("div", { className: "daw-wb-user-sub" }, t("top.running", { count: props.running || 0 })))));
		}

		function WbTopbar(props) {
			var t = wbT(props);
			var route = props.route;
			var crumb = route.kind === "workbench"
				? (props.projectName ? t("nav.projects") + " / " + props.projectName : t("nav.projects"))
				: t("nav.projects");
			return h("header", { className: "daw-wb-top" },
				h("span", { className: "daw-wb-crumb" }, crumb),
				props.running > 0 ? h("span", { className: "daw-wb-run" }, h("i"), t("top.running", { count: props.running })) : null,
				h("span", { className: "daw-wb-search" }, "🔍 ", t("top.search")),
				route.kind === "workbench" || route.kind === "list"
					? h("span", { className: "daw-wb-viewseg" },
						h("button", { type: "button", "data-on": "true", title: t("top.view.canvas") }, t("top.view.canvas")),
						h("button", { type: "button", "data-on": "false", title: t("top.view.chat"), onClick: props.onBack }, t("top.view.chat")))
					: null,
				props.onBack ? h(WbBtn, { variant: "ghost", onClick: props.onBack, title: t("top.back") }, t("top.back")) : null,
				h("div", { className: "daw-wb-avatar" }, "宿"));
		}

		function WbTabs(props) {
			var t = wbT(props);
			var route = props.route;
			var tabs = [
				{ key: "canvas", label: t("tab.canvas"), note: t("tab.note.canvas") },
				{ key: "tasks", label: t("tab.tasks"), note: t("tab.note.tasks"), badge: props.openTasks || 0 },
				{ key: "brief", label: t("tab.brief"), note: t("tab.note.brief") },
				{ key: "exec", label: t("tab.exec"), note: t("tab.note.exec"), badge: props.runningTasks || 0 }
			];
			return h("nav", { className: "daw-wb-tabs" },
				tabs.map(function (tab) {
					return h("button", {
						key: tab.key,
						type: "button",
						className: "daw-wb-tab",
						"data-on": String(route.tab === tab.key),
						onClick: function () { wbRoute.project(route.projectId, tab.key); }
					},
						tab.label,
						tab.badge > 0 ? h("span", { className: "daw-wb-tab-badge" }, String(tab.badge)) : null);
				}),
				h("span", { className: "daw-wb-tabnote" }, tabs.filter(function (tab) { return tab.key === route.tab; })[0].note));
		}

		// ── U-1 项目列表 ───────────────────────────────────────────────────────

		function WbProjectCard(props) {
			var t = wbT(props);
			var project = props.project;
			var tasks = useWb("/tasks?projectId=" + encodeURIComponent(project.projectId));
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
					h(WbChip, { tone: running > 0 ? "ok" : "neutral" }, running > 0 ? t("tasks.status.in_progress") : t("tasks.status.pending"))),
				h("div", { className: "daw-wb-progress" }, h("i", { style: { width: percent + "%" } })),
				h("div", { className: "daw-wb-meta" },
					h("span", null, t("list.card.members", { count: (project.members || []).length })),
					h("span", null, t("list.card.tasks", { done: done, total: total }))),
				h("div", { className: "daw-wb-card-note" }, project.brief && project.brief.goal ? project.brief.goal : t("canvas.goal.none")));
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
				actions: h(WbBtn, { onClick: function () { setModal({ kind: "create" }); } }, t("list.new"))
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
						h("div", { className: "daw-wb-stat-n" }, t("list.stat.tickets"))),
					h("div", { className: "daw-wb-stat" },
						h("div", { className: "daw-wb-stat-v" }, String(props.eventCount || 0)),
						h("div", { className: "daw-wb-stat-n" }, t("list.stat.events")))),
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
								h(WbBtn, { onClick: function () { setModal({ kind: "create" }); } }, t("list.empty.create")),
								h(WbBtn, { variant: "ghost", onClick: function () { setModal({ kind: "join" }); } }, t("list.empty.join"))))) : null
				},
					rows.length === 0 ? null : h("div", { className: "daw-wb-grid" },
						rows.map(function (project) {
							return h(WbProjectCard, { key: project.projectId, project: project, t: t });
						}),
						h("button", { type: "button", className: "daw-wb-card", "data-variant": "ghost", onClick: function () { setModal({ kind: "join" }); } },
							h("div", { className: "daw-wb-empty-icon" }, "＋"),
							h("div", { className: "daw-wb-empty-title" }, t("list.empty.join")),
							h("div", { className: "daw-wb-empty-desc" }, t("list.join.title")))),
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
					: null));
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

		function WbJoinProject(props) {
			var t = wbT(props);
			var pickedState = react.useState(props.projects.length > 0 ? props.projects[0].projectId : "");
			var busyState = react.useState("");
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
		var wbNodePositions = (function () {
			var KEY = "dsh-agent-whales.canvas-positions";
			function read() {
				try {
					var raw = window.localStorage.getItem(KEY);
					var parsed = raw === null ? {} : JSON.parse(raw);
					return parsed && typeof parsed === "object" ? parsed : {};
				} catch (error) { return {}; }
			}
			return {
				get: function (projectId, nodeId) {
					var table = read();
					var row = table[projectId + ":" + nodeId];
					return row && typeof row.x === "number" && typeof row.y === "number" ? row : undefined;
				},
				set: function (projectId, nodeId, x, y) {
					var table = read();
					table[projectId + ":" + nodeId] = { x: Math.round(x), y: Math.round(y) };
					try { window.localStorage.setItem(KEY, JSON.stringify(table)); } catch (error) { /* 配额不足就不持久化 */ }
				}
			};
		})();

		/**
		 * 画布节点：对话节点来自项目成员（主对话 = Composer，其余 = Agent）；
		 * 上下文节点来自任务落点（worktree / execRoot 的去重值）——落点是一等字段
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
				var entry = contexts[where] || (contexts[where] = { id: "ctx:" + where, kind: "folder", title: where, tasks: [] });
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
					title: row && row.title ? row.title : member.sessionId,
					sub: (owned.length > 0 ? owned[0].subject : (row && row.running ? "在线" : "空闲")),
					worktree: where,
					online: !!(row && row.running),
					x: 680, y: 24 + index * 138, w: 200, h: 118
				});
			});
			nodes.push({
				id: mainSessionId || "main",
				kind: "composer",
				sessionId: mainSessionId,
				title: "Composer · 会话即画布",
				sub: (project && project.name ? project.name : ""),
				online: true,
				x: 340, y: 168, w: 300, h: 224
			});
			return nodes;
		}

		function WbCanvasPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var projectSnap = useWb("/projects/" + encodeURIComponent(projectId));
			var tasksSnap = useWb("/tasks?projectId=" + encodeURIComponent(projectId));
			var sessionsSnap = useWb("/sessions");
			var project = projectSnap.data && projectSnap.data.project ? projectSnap.data.project : null;
			var tasks = tasksSnap.data && Array.isArray(tasksSnap.data.tasks) ? tasksSnap.data.tasks : [];
			var sessionRows = wbSessionRows(sessionsSnap.data && sessionsSnap.data.sessions ? { byId: indexById(sessionsSnap.data.sessions) } : undefined);
			var view = react.useState({ x: 0, y: 0, scale: 1 });
			var pan = view[0];
			var setPan = view[1];
			var pickState = react.useState(null);
			var picked = pickState[0];
			var setPicked = pickState[1];
			var linkingState = react.useState(null);
			var linking = linkingState[0];
			var setLinking = linkingState[1];
			var dragRef = react.useRef(null);
			var stageRef = react.useRef(null);
			var hintState = react.useState("");
			var hint = hintState[0];

			if (project === null) {
				return h(WbState, { loading: projectSnap.loading, error: projectSnap.error, onRetry: function () { wbCache.read("/projects/" + encodeURIComponent(projectId)); } });
			}
			var nodes = wbCanvasNodes(project, tasks, sessionRows);
			nodes.forEach(function (node) {
				var saved = wbNodePositions.get(projectId, node.id);
				if (saved !== undefined) { node.x = saved.x; node.y = saved.y; }
			});
			var links = Array.isArray(project.links) ? project.links : [];
			var edges = wbCanvasEdges(nodes, links);
			var goal = project.brief && typeof project.brief.goal === "string" ? project.brief.goal : "";
			var stageW = 920;
			var stageH = 520;

			function stagePoint(event) {
				var el = stageRef.current;
				if (!el || typeof el.getBoundingClientRect !== "function") return { x: 0, y: 0 };
				var rect = el.getBoundingClientRect();
				var clientX = event && typeof event.clientX === "number" ? event.clientX : 0;
				var clientY = event && typeof event.clientY === "number" ? event.clientY : 0;
				return { x: (clientX - rect.left - pan.x) / pan.scale, y: (clientY - rect.top - pan.y) / pan.scale };
			}

			function nodeAt(point) {
				for (var i = nodes.length - 1; i >= 0; i -= 1) {
					var node = nodes[i];
					if (point.x >= node.x && point.x <= node.x + node.w && point.y >= node.y && point.y <= node.y + node.h) return node;
				}
				return null;
			}

			function onWheel(event) {
				if (!event) return;
				if (typeof event.preventDefault === "function") event.preventDefault();
				var next = { x: pan.x, y: pan.y, scale: pan.scale };
				if (event.ctrlKey === true) {
					var factor = event.deltaY > 0 ? 0.9 : 1.1;
					next.scale = Math.min(2, Math.max(0.4, pan.scale * factor));
				} else if (event.shiftKey === true) {
					next.x -= event.deltaY;
				} else {
					next.y -= event.deltaY;
				}
				setPan(next);
			}

			function onCanvasDown(event) {
				var point = stagePoint(event);
				var node = nodeAt(point);
				if (node === null) {
					dragRef.current = { kind: "pan", startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
					setPicked(null);
				} else {
					dragRef.current = { kind: "node", node: node, offsetX: point.x - node.x, offsetY: point.y - node.y, moved: false };
					setPicked(node.id);
				}
			}

			function onCanvasMove(event) {
				var drag = dragRef.current;
				if (drag === null) {
					if (linking !== null) {
						var hover = stagePoint(event);
						setLinking({ from: linking.from, x: hover.x, y: hover.y });
					}
					return;
				}
				if (drag.kind === "pan") {
					setPan({ x: drag.originX + (event.clientX - drag.startX), y: drag.originY + (event.clientY - drag.startY), scale: pan.scale });
					return;
				}
				var point = stagePoint(event);
				var x = Math.max(0, point.x - drag.offsetX);
				var y = Math.max(0, point.y - drag.offsetY);
				drag.node.x = x;
				drag.node.y = y;
				drag.moved = true;
				// 位置即时生效（React 状态在 pointerup 才提交），拖拽中直接改节点坐标。
				setPicked(picked === null ? null : picked + "");
			}

			function onCanvasUp(event) {
				var drag = dragRef.current;
				dragRef.current = null;
				if (linking !== null) {
					var target = nodeAt(stagePoint(event));
					setLinking(null);
					if (target === null || target.id === linking.from) { hintState[1](t("canvas.link.deny")); return; }
					var exists = links.some(function (link) {
						return (link.a === linking.from && link.b === target.id) || (link.b === linking.from && link.a === target.id);
					});
					if (exists) { hintState[1](t("canvas.link.deny")); return; }
					wbApi("/projects/" + encodeURIComponent(projectId) + "/links", { method: "POST", body: { a: linking.from, b: target.id } })
						.then(function () { wbCache.invalidate("/projects/" + encodeURIComponent(projectId)); hintState[1](""); })
						.catch(function (error) { hintState[1](error.message); });
					return;
				}
				if (drag !== null && drag.kind === "node" && drag.moved === true) {
					wbNodePositions.set(projectId, drag.node.id, drag.node.x, drag.node.y);
				}
			}

			function removeLink(link) {
				wbApi("/projects/" + encodeURIComponent(projectId) + "/links", { method: "DELETE", body: { a: link.a, b: link.b } })
					.then(function () { wbCache.invalidate("/projects/" + encodeURIComponent(projectId)); setPicked(null); })
					.catch(function (error) { hintState[1](error.message); });
			}

			function fit() {
				setPan({ x: 0, y: 0, scale: 1 });
			}

			return h("div", { className: "daw-wb-canvaswrap" },
				h("div", {
					className: "daw-wb-canvas",
					onWheel: onWheel,
					onPointerDown: onCanvasDown,
					onPointerMove: onCanvasMove,
					onPointerUp: onCanvasUp
				},
					h("div", { className: "daw-wb-canvas-grid" }),
					h("div", {
						className: "daw-wb-stage",
						ref: stageRef,
						style: { width: stageW + "px", height: stageH + "px", transform: "translate(" + pan.x + "px," + pan.y + "px) scale(" + pan.scale + ")" }
					},
						h("svg", { className: "daw-wb-link", width: stageW, height: stageH, style: { position: "absolute", left: 0, top: 0 } },
							edges.map(function (edge, index) {
								var midX = (edge.x1 + edge.x2) / 2;
								var path = "M" + edge.x1 + " " + edge.y1 + " C" + midX + " " + edge.y1 + " " + midX + " " + edge.y2 + " " + edge.x2 + " " + edge.y2;
								var selected = picked === edge.a + "|" + edge.b;
								return h("g", { key: index },
									h("path", { d: path, "data-selected": String(selected) }),
									h("path", {
										d: path, stroke: "transparent", strokeWidth: 14, style: { cursor: "pointer" },
										onClick: function () { setPicked(edge.a + "|" + edge.b); }
									}));
							}),
							linking !== null
								? h("path", { d: "M" + (nodes.filter(function (n) { return n.id === linking.from; })[0] || { x: 0, y: 0, w: 0, h: 0 }).x + " " + linking.y, stroke: "var(--daw-brand)", strokeDasharray: "4 4" })
								: null),
						goal !== ""
							? h("div", { className: "daw-wb-goal", style: { position: "absolute", left: 340, top: 24 } },
								h("i"), t("canvas.goal", { goal: goal.length > 40 ? goal.slice(0, 40) + "…" : goal }))
							: h("div", { className: "daw-wb-goal", style: { position: "absolute", left: 340, top: 24 } }, h("i"), t("canvas.goal.none")),
						nodes.map(function (node) {
							return h("div", {
								key: node.id,
								className: "daw-wb-node",
								"data-kind": node.kind,
								"data-selected": String(picked === node.id),
								style: { left: node.x + "px", top: node.y + "px", width: node.w + "px", minHeight: node.h + "px" },
								onDoubleClick: node.sessionId ? function () { props.onOpenSession(node.sessionId); } : undefined
							},
								h("div", { className: "daw-wb-node-head" },
									h("span", { className: "daw-wb-node-tag" }, node.kind === "composer" ? "✦" : node.kind === "agent" ? "⚙" : "dir"),
									h("span", null, node.kind === "composer" ? t("canvas.node.composer") : node.kind === "agent" ? t("canvas.node.agent") : t("canvas.node.folder")),
									h("span", { className: "daw-wb-node-fill" }),
									node.kind === "agent" ? h(WbChip, { tone: node.online ? "ok" : "neutral", dot: true }, node.online ? "在线" : "空闲") : null),
								h("div", { className: "daw-wb-node-name" }, node.title),
								h("div", { className: "daw-wb-node-sub" }, node.sub),
								node.kind === "agent"
									? h("div", { className: "daw-wb-node-row" },
										h("span", { className: "daw-wb-node-tag" }, "⚙"),
										h("span", null, t("exec.ticket.where", { worktree: node.worktree || node.execRoot || t("common.none") })))
									: null,
								h("div", {
									className: "daw-wb-node-tag",
									style: { position: "absolute", right: -7, top: "50%", width: 14, height: 14, borderRadius: 999, cursor: "crosshair", border: "2px solid var(--daw-surface)" },
									title: t("canvas.link.new"),
									onPointerDown: function (event) {
										if (event && typeof event.stopPropagation === "function") event.stopPropagation();
										var point = stagePoint(event);
										setLinking({ from: node.id, x: point.x, y: point.y });
									}
								}));
						}),
						tasks.length === 0
							? h("div", { className: "daw-wb-node", style: { left: 250, top: 400, width: 400, cursor: "default", "data-kind": "guide" } },
								h("div", { className: "daw-wb-node-name" }, t("canvas.empty")),
								h("div", { className: "daw-wb-toolbar" },
									h(WbBtn, { variant: "small", onClick: function () { wbRoute.project(projectId, "tasks"); } }, t("tasks.new")),
									h(WbBtn, { variant: "small", variant: "ghost", onClick: function () { props.onOpenSession(project.mainSessionId); } }, t("canvas.empty.send"))))
							: null),
					h("div", { className: "daw-wb-zoombar" },
						h("button", { type: "button", title: t("canvas.zoom"), onClick: function () { setPan({ x: pan.x, y: pan.y, scale: Math.max(0.4, pan.scale - 0.1) }); } }, "−"),
						h("span", null, Math.round(pan.scale * 100) + "%"),
						h("button", { type: "button", title: t("canvas.zoom"), onClick: function () { setPan({ x: pan.x, y: pan.y, scale: Math.min(2, pan.scale + 0.1) }); } }, "＋"),
						h("button", { type: "button", className: "daw-wb-zoomtext", onClick: fit }, t("canvas.zoomFit")),
						h("button", { type: "button", className: "daw-wb-zoomtext", onClick: function () { hintState[1](t("canvas.hint")); } }, t("canvas.guide"))),
					h("div", { className: "daw-wb-mini" },
						nodes.map(function (node) {
							return h("div", {
								key: node.id,
								className: "daw-wb-mini-block",
								style: {
									left: (node.x / stageW) * 100 + "%",
									top: (node.y / stageH) * 100 + "%",
									width: Math.max(3, (node.w / stageW) * 100) + "%",
									height: Math.max(3, (node.h / stageH) * 100) + "%"
								}
							});
						}))),
				h("div", { className: "daw-wb-toolbar" },
					h("span", { className: "daw-wb-note" }, t("tab.note.canvas")),
					h("span", { className: "daw-wb-toolfill" }),
					picked !== null && picked.indexOf("|") >= 0
						? h(WbBtn, {
							variant: "danger",
							onClick: function () {
								var parts = picked.split("|");
								removeLink({ a: parts[0], b: parts[1] });
							}
						}, t("canvas.delete.title"))
						: null,
					picked !== null && picked.indexOf("|") < 0 && picked !== (project.mainSessionId || "main")
						? h(WbBtn, {
							variant: "danger",
							onClick: function () {
								var node = nodes.filter(function (item) { return item.id === picked; })[0];
								if (node && typeof node.sessionId === "string") props.onRemoveMember(node.sessionId, node.title, tasks);
							}
						}, t("canvas.delete.title"))
						: null),
				hint !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "warn" }, hint) : null,
				h(WbProposalCard, { t: t, projectId: projectId, leadSessionId: project.mainSessionId }));
		}

		// ── M6-5 目标条 + 提案卡（D6 最小版：只读展示 + 确认后逐条建任务）────────

		function WbProposalCard(props) {
			var t = wbT(props);
			var leadSessionId = props.leadSessionId;
			var snap = useWb(leadSessionId ? "/proposals?leadSessionId=" + encodeURIComponent(leadSessionId) : "/proposals");
			var proposal = snap.data && snap.data.proposal ? snap.data.proposal : null;
			var busyState = react.useState(false);
			var errorState = react.useState("");
			var error = errorState[0];
			if (proposal === null) return null;
			var items = Array.isArray(proposal.items) ? proposal.items : [];
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

			return h("div", { className: "daw-wb-panel" },
				h("div", { className: "daw-wb-panel-title" },
					h("span", null, t("inbox.group.proposals")),
					h("span", { className: "daw-wb-toolfill" }),
					h(WbChip, { tone: locked ? "ok" : "warn" }, locked ? t("event.state.opened") : t("event.state.pending")),
					h("span", { className: "daw-wb-note" }, proposal.proposalId + " · v" + proposal.version + " · " + items.length)),
				error !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "danger" }, error) : null,
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
					h("span", { className: "daw-wb-toolfill" }),
					created.length > 0 ? h("span", { className: "daw-wb-note" }, t("event.state.opened") + " " + created.length) : null,
					failed.length > 0 ? h("span", { className: "daw-wb-note" }, t("handoff.result.failed") + " " + failed.length) : null),
				h("div", { className: "daw-wb-note" }, t("event.action.note")));
		}

		function indexById(rows) {
			var byId = {};
			(rows || []).forEach(function (row) {
				if (row && typeof row.sessionId === "string") byId[row.sessionId] = row;
			});
			return byId;
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
			var modal = modalState[0];
			var setModal = modalState[1];
			var busyState = react.useState("");
			var busy = busyState[0];
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
				wbTaskCommand(projectId, task.taskId, action, extra)
					.then(function () { wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); wbCache.invalidate("/inbox"); busyState[1](""); setModal(null); })
					.catch(function (failure) { errorState[1](failure.message); busyState[1](""); });
			}

			return h(WbPage, {
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
				h(WbState, { loading: tasksSnap.loading && rows.length === 0, error: tasksSnap.error, onRetry: function () { wbCache.read("/tasks?projectId=" + encodeURIComponent(projectId)); } },
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
											: h(WbChip, { tone: wbReportTone(row.report.status), title: row.report.summary }, t("tasks.report." + row.report.status) + " · rev " + row.report.rev)),
									h("span", { className: "daw-wb-td daw-wb-td-status" },
										h(WbChip, { tone: statusTone }, t("tasks.status." + row.status))),
									h("span", { className: "daw-wb-td daw-wb-td-actions" },
										row.status === "completed"
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { run("reopen", row, { expectedRevision: row.revision }); } }, t("tasks.action.reopen"))
													: null,
										row.status !== "completed" && row.ownerSessionId === null
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { setModal({ kind: "assign", task: row }); } }, t("tasks.action.assign"))
													: null,
										row.status !== "completed" && row.ownerSessionId !== null
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { run("unassign", row, { expectedRevision: row.revision }); } }, t("tasks.action.unassign"))
													: null,
										row.status !== "completed" && row.ownerSessionId !== null
													? h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { run("dispatch", row, {}); } }, t("tasks.action.dispatch"))
													: null,
										h(WbBtn, { variant: "ghost", disabled: busy !== "", onClick: function () { setModal({ kind: "report", task: row }); } }, t("tasks.action.report"))));
							}))),
				h("div", { className: "daw-wb-toolbar" },
					h("span", { className: "daw-wb-note" }, t("tasks.report.note"))),
				modal !== null && modal.kind === "assign"
					? h(WbAssignModal, { t: t, task: modal.task, members: members, sessions: sessionRows, busy: busy !== "", onClose: function () { setModal(null); }, onAssign: function (owner, dispatch) { run(dispatch ? "assign-and-dispatch" : "assign", modal.task, { owner: owner, expectedRevision: modal.task.revision }); } })
					: null,
				modal !== null && modal.kind === "report"
					? h(WbReportModal, { t: t, task: modal.task, busy: busy !== "", onClose: function () { setModal(null); }, onSubmit: function (report) { wbWriteReport(projectId, modal.task, report).then(function () { wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); wbCache.invalidate("/inbox"); setModal(null); }).catch(function (failure) { errorState[1](t("tasks.report.conflict", { code: failure.message })); }); } })
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
				return h(WbState, { loading: projectSnap.loading, error: projectSnap.error, onRetry: function () { wbCache.read("/projects/" + encodeURIComponent(projectId)); } });
			}
			var members = Array.isArray(project.members) ? project.members : [];
			return h(WbPage, { title: t("tab.brief"), desc: t("brief.desc") },
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
			var errorState = react.useState("");
			var error = errorState[0];

			function toolOf(sessionId) {
				var entry = active[sessionId];
				return entry && typeof entry.tool === "string" ? entry.tool : null;
			}

			return h(WbPage, { title: t("tab.exec"), desc: t("tab.note.exec") },
				error !== "" ? h("div", { className: "daw-wb-banner", "data-tone": "danger" }, error) : null,
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
								h(WbBtn, { variant: "ghost", onClick: function () { props.onOpenSession(row.ownerSessionId); } }, t("exec.ticket.full")),
								h(WbBtn, {
									variant: "ghost",
									onClick: function () { modalState[1](row); }
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
				modalState !== null					? h(WbReportModal, {
						t: t,
						task: modalState,
						busy: false,
						onClose: function () { modalState[1](null); },
						onSubmit: function (report) {
							wbWriteReport(projectId, modalState, report)
								.then(function () { wbCache.invalidate("/tasks?projectId=" + encodeURIComponent(projectId)); wbCache.invalidate("/inbox"); modalState[1](null); })
								.catch(function (failure) { errorState[1](t("tasks.report.conflict", { code: failure.message })); });
						}
					})
					: null);
		}

		// ── U-6 需要我处理（M6-6）──────────────────────────────────────────────

		function WbInboxPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var url = projectId ? "/inbox?projectId=" + encodeURIComponent(projectId) : "/inbox";
			var inbox = useWb(url);
			var counts = wbInboxView(inbox.data);
			var order = ["proposals", "worker", "handed_back", "system"];
			var actions = {
				proposals: t("inbox.action.proposal"),
				worker: t("inbox.action.report"),
				handed_back: t("inbox.action.handed"),
				system: t("inbox.action.task")
			};
			function openItem(group, item) {
				if (group === "proposals" && item.projectId) wbRoute.project(item.projectId, "canvas");
				else if (item.projectId) wbRoute.project(item.projectId, item.kind === "task" ? "tasks" : "canvas");
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
									h(WbChip, { tone: key === "worker" ? "danger" : key === "handed_back" ? "warn" : "neutral" }, group.label),
									h("span", { className: "daw-wb-note" }, String(group.items.length))),
								group.items.map(function (item, index) {
									return h("div", { key: key + ":" + index, className: "daw-wb-todo" },
										h("div", { className: "daw-wb-todo-index" }, String(index + 1)),
										h("div", { className: "daw-wb-todo-body" },
											h("div", { className: "daw-wb-todo-text" }, item.subject || item.reason || item.proposalId || t("common.none")),
											h("div", { className: "daw-wb-todo-src" },
												(item.kind ? item.kind + " · " : "") +
												(item.bySessionId || item.source || t("nav.projects")) + " " +
												(item.at ? wbFormatClock(item.at) : ""))),
										h(WbBtn, { variant: "ghost", onClick: function () { openItem(key, item); } }, actions[key] || t("inbox.action.task")));
								}));
						})),
				h("div", { className: "daw-wb-note" }, t("inbox.foot")));
		}

		// ── U-7 发送记录（M6-4）────────────────────────────────────────────────

		function WbHandoffsPage(props) {
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
			return h(WbPage, {
				title: t("handoff.title"),
				desc: t("handoff.desc"),
				actions: h(WbBtn, { variant: "ghost", onClick: function () { wbCache.read(url); } }, t("handoff.export"))
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

		// ── U-8 事件台（最小版：真实来源 = 待办聚合，交互留 W1.5）────────────────

		function WbEventsPage(props) {
			var t = wbT(props);
			var projectId = props.projectId;
			var url = projectId ? "/inbox?projectId=" + encodeURIComponent(projectId) : "/inbox";
			var inbox = useWb(url);
			var counts = wbInboxView(inbox.data);
			var filterState = react.useState("all");
			var groups = ["proposals", "worker", "handed_back", "system"];
			var rows = [];
			groups.forEach(function (key) {
				var group = counts.groups[key];
				if (group === undefined) return;
				group.items.forEach(function (item, index) {
					rows.push({ key: key + ":" + index, source: key, text: item.subject || item.reason || item.proposalId || "", at: item.at || 0, detail: item });
				});
			});
			rows.sort(function (left, right) { return right.at - left.at; });
			var shown = filterState === "all" ? rows : rows.filter(function (row) { return row.source === filterState; });
			return h(WbPage, {
				title: t("event.title"),
				desc: t("event.desc"),
				actions: h("div", { className: "daw-wb-toolbar" },
					h(WbChip, { tone: "danger" }, t("event.pending", { count: counts.total })),
					h(WbBtn, { variant: "ghost", onClick: function () { wbCache.read(url); } }, t("common.refresh")))
			},
				h("div", { className: "daw-wb-toolbar" },
					["all"].concat(groups).map(function (key) {
						return h("button", {
							key: key,
							type: "button",
							className: "daw-wb-filter",
							"data-on": String(filterState === key),
							onClick: function () { filterState[1](key); }
						}, key === "all" ? t("event.filter.all") : (counts.groups[key] ? counts.groups[key].label : key));
					}),
					h("span", { className: "daw-wb-toolfill" }),
					h("span", { className: "daw-wb-note" }, t("event.desc"))),
				h(WbState, { loading: inbox.loading && inbox.data === undefined, error: inbox.error, onRetry: function () { wbCache.read(url); } },
					shown.length === 0
						? h("div", { className: "daw-wb-state" }, t("event.empty"))
						: shown.map(function (row) {
							return h("div", { key: row.key, className: "daw-wb-eventrow" },
								h("div", { className: "daw-wb-event-head" },
									h("span", { className: "daw-wb-event-src" }, row.source),
									h("div", { className: "daw-wb-event-body" },
										h("div", { className: "daw-wb-event-text" }, row.text),
										h("div", { className: "daw-wb-event-sub" }, row.at ? wbFormatClock(row.at) : "")),
									h(WbChip, { tone: "neutral" }, t("event.state.pending"))),
								h("div", { className: "daw-wb-note" }, t("event.action.note")));
						})),
				h("div", { className: "daw-wb-note" }, t("event.foot")));
		}

		// ── U-9 首次体验 / U-10 设置 / 团队 ─────────────────────────────────────

		function WbFirstPage(props) {
			var t = wbT(props);
			return h(WbPage, { title: t("first.welcome") },
				h("div", { className: "daw-wb-hero" },
					h("div", { className: "daw-wb-empty-icon" }, "🐋"),
					h("div", { className: "daw-wb-h1" }, t("first.welcome")),
					h("div", { className: "daw-wb-desc" }, t("first.desc")),
					h("div", { className: "daw-wb-steps" },
						[1, 2, 3].map(function (step) {
							return h("div", { key: step, className: "daw-wb-step" },
								h("div", { className: "daw-wb-step-no" }, String(step)),
								h("div", { className: "daw-wb-step-title" }, t("first.step" + step)),
								h("div", { className: "daw-wb-step-desc" }, t("first.step" + step + ".desc")));
						})),
					h("div", { className: "daw-wb-toolbar" },
						h(WbBtn, { onClick: function () { wbRoute.list(); } }, t("first.switch")),
						h(WbBtn, { variant: "ghost", onClick: function () { wbRoute.kind("settings"); } }, t("nav.settings")))),
				h("div", { className: "daw-wb-grid" },
					h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("first.card.official")),
						h("div", { className: "daw-wb-note" }, t("first.card.official.desc"))),
					h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("first.card.nodispatch")),
						h("div", { className: "daw-wb-note" }, t("first.card.nodispatch.desc"))),
					h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("first.card.dark")),
						h("div", { className: "daw-wb-note" }, t("first.card.dark.desc")))));
		}

		function WbSettingsPage(props) {
			var t = wbT(props);
			var snap = react.useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			var menuState = react.useState("look");
			var menus = [
				{ key: "general", label: t("set.menu.general") },
				{ key: "look", label: t("set.menu.look") },
				{ key: "worker", label: t("set.menu.worker") },
				{ key: "notify", label: t("set.menu.notify") },
				{ key: "about", label: t("set.menu.about") }
			];
			function panel() {
				if (menuState[0] === "look") {
					return h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("set.theme")),
						h("div", { className: "daw-wb-toolbar" },
							h("button", {
								type: "button",
								className: "daw-wb-filter",
								"data-on": String(snap.theme !== "dark"),
								onClick: function () { settings.set({ theme: "light" }); }
							}, t("set.theme.light")),
							h("button", {
								type: "button",
								className: "daw-wb-filter",
								"data-on": String(snap.theme === "dark"),
								onClick: function () { settings.set({ theme: "dark" }); }
							}, t("set.theme.dark"))),
						h("div", { className: "daw-wb-note" }, t("set.foot")));
				}
				if (menuState[0] === "worker") {
					return h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("set.worker")),
						h("div", { className: "daw-wb-kv" },
							h("span", { className: "daw-wb-kv-key" }, t("set.worker.preset")),
							h("span", { className: "daw-wb-kv-val" }, "dsh-agent-whales-worker"),
							h("span", { className: "daw-wb-kv-key" }, t("set.worker.dir")),
							h("span", { className: "daw-wb-kv-val" }, t("set.worker.dir.desc")),
							h("span", { className: "daw-wb-kv-key" }, t("set.worker.dedupe")),
							h("span", { className: "daw-wb-kv-val" }, t("set.worker.dedupe.desc")),
							h("span", { className: "daw-wb-kv-key" }, t("set.worker.noise")),
							h("span", { className: "daw-wb-kv-val" }, t("set.worker.noise.desc"))),
						h("div", { className: "daw-wb-note" }, t("exec.ticket.note")));
				}
				if (menuState[0] === "about") {
					return h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("about.desc")),
						h("div", { className: "daw-wb-note" }, t("brand.name") + " · " + t("brand.sub")));
				}
				if (menuState[0] === "notify") {
					return h("div", { className: "daw-wb-panel" },
						h("div", { className: "daw-wb-panel-title" }, t("set.menu.notify")),
						h("div", { className: "daw-wb-note" }, t("inbox.foot")));
				}
				return h("div", { className: "daw-wb-panel" },
					h("div", { className: "daw-wb-panel-title" }, t("set.menu.general")),
					h("div", { className: "daw-wb-note" }, t("list.desc")));
			}
			return h(WbPage, { title: t("nav.settings") },
				h("div", { className: "daw-wb-cols" },
					h("div", { className: "daw-wb-menu" },
						menus.map(function (menu) {
							return h("button", {
								key: menu.key,
								type: "button",
								"data-on": String(menuState[0] === menu.key),
								onClick: function () { menuState[1](menu.key); }
							}, menu.label);
						})),
					h("div", { className: "daw-wb-panel", style: { flex: "1 1 520px" } }, panel())));
		}

		function WbTeamPage(props) {
			var t = wbT(props);
			var sessions = wbSessionRows(props.sessions);
			return h(WbPage, { title: t("nav.team"), desc: t("team.desc") },
				h("div", { className: "daw-wb-table" },
					h("div", { className: "daw-wb-tr", "data-head": "true" },
						h("span", { className: "daw-wb-td daw-wb-td-task" }, t("team.host")),
						h("span", { className: "daw-wb-td daw-wb-td-status" }, t("tasks.col.status"))),
					sessions.map(function (row) {
						return h("div", { key: row.sessionId, className: "daw-wb-tr" },
							h("span", { className: "daw-wb-td daw-wb-td-task" }, row.title),
							h("span", { className: "daw-wb-td daw-wb-td-status" },
								h(WbChip, { tone: row.running ? "ok" : "neutral" }, row.running ? t("tasks.status.in_progress") : t("tasks.status.pending"))));
					})));
		}

		// ── 工作台外壳（main keyed 槽；PRD §45.2：不覆盖 conversation key）───────

		function WhaleWorkbench(props) {
			var t = wbT(props);
			var snap = react.useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			var route = react.useSyncExternalStore(wbRoute.subscribe, wbRoute.get, wbRoute.get);
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
			if (route.kind === "workbench" && project !== null) {
				if (route.tab === "tasks") page = h(WbTasksPage, { t: t, projectId: route.projectId });
				else if (route.tab === "brief") page = h(WbBriefPage, { t: t, projectId: route.projectId });
				else if (route.tab === "exec") page = h(WbExecPage, { t: t, projectId: route.projectId, onOpenSession: onOpenSession });
				else page = h(WbCanvasPage, {
					t: t,
					projectId: route.projectId,
					onOpenSession: onOpenSession,
					onRemoveMember: onRemoveMember
				});
			} else if (route.kind === "workbench") {
				page = h(WbState, { loading: projectSnap.loading, error: projectSnap.error, onRetry: function () { wbCache.read("/projects/" + encodeURIComponent(route.projectId)); } });
			} else if (route.kind === "inbox") {
				page = h(WbInboxPage, { t: t });
			} else if (route.kind === "handoffs") {
				page = h(WbHandoffsPage, { t: t, sessions: sessions });
			} else if (route.kind === "events") {
				page = h(WbEventsPage, { t: t });
			} else if (route.kind === "team") {
				page = h(WbTeamPage, { t: t, sessions: sessions });
			} else if (route.kind === "settings") {
				page = h(WbSettingsPage, { t: t });
			} else if (route.kind === "first") {
				page = h(WbFirstPage, { t: t });
			} else {
				page = h(WbProjectList, {
					t: t,
					runningTasks: taskViews.filter(function (row) { return row.status === "in_progress"; }).length,
					eventCount: 0
				});
			}

			return h("div", { className: "daw-wb", "data-wb-theme": snap.theme === "dark" ? "dark" : "light" },
				h(WbSidebar, { t: t, route: route, running: running }),
				h("div", { className: "daw-wb-main" },
					h(WbTopbar, {
						t: t,
						route: route,
						running: running,
						projectName: project ? project.name : undefined,
						onBack: function () { wbSelectPanel("conversation"); }
					}),
					route.kind === "workbench"
						? h(WbTabs, {
							t: t,
							route: route,
							openTasks: taskViews.filter(function (row) { return row.status === "pending"; }).length,
							runningTasks: taskViews.filter(function (row) { return row.status === "in_progress"; }).length
						})
						: null,
					h("div", { className: "daw-wb-body" }, page)));
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
				wbCanvasEdges: wbCanvasEdges,
				wbCanvasNodes: wbCanvasNodes,
				wbFormatClock: wbFormatClock,
				wbElapsed: wbElapsed,
				wbCache: wbCache,
				wbApi: wbApi,
				wbSelectPanel: wbSelectPanel,
				WhaleWorkbench: WhaleWorkbench,
				WhalePanelEntry: WhalePanelEntry,
				WbProjectList: WbProjectList,
				WbTasksPage: WbTasksPage,
				WbBriefPage: WbBriefPage,
				WbInboxPage: WbInboxPage,
				WbHandoffsPage: WbHandoffsPage,
				WbEventsPage: WbEventsPage,
				WbExecPage: WbExecPage,
				WbFirstPage: WbFirstPage,
				WbSettingsPage: WbSettingsPage,
				WbTeamPage: WbTeamPage,
				settings: settings
			}
		});
		return plugin;
	}
});
