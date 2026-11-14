/**
 * dsh-agent-whales 离线冒烟测试。
 *   node --test test/
 *
 * 覆盖三件事：
 *   1. 信封/清单契约：注册 id === 包名、只 require("react")、apply 注册到预期的槽位。
 *   2. 计数口径：谁算「正在干活」，一个干活智能体 = 一只鲸鱼。
 *   3. 组件渲染：用最小 React 垫片把图层渲染出来，数一数真的有几只。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findByClass, installDocumentStub, loadPlugin, pluginDir, render, walk } from "./harness.mjs";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));

const LEAD = "lead-1";
const MATE_A = "mate-a";
const MATE_B = "mate-b";

function listState(overrides = {}) {
  return Object.assign(
    {
      ids: [LEAD, MATE_A, MATE_B],
      byId: {
        [LEAD]: { sessionId: LEAD, title: "鲸鱼插件开发", running: true, retainedBy: { mainView: 1 } },
        [MATE_A]: { sessionId: MATE_A, title: MATE_A, running: true, origin: "subagent", parentId: LEAD },
        [MATE_B]: { sessionId: MATE_B, title: MATE_B, running: false, origin: "subagent", parentId: LEAD }
      },
      phase: "ready",
      projectionsBySession: {
        [LEAD]: {
          values: {
            agentTeam: {
              members: [
                { id: LEAD, name: "lead", role: "lead", phase: "active" },
                { id: MATE_A, name: MATE_A, role: "teammate", phase: "active" },
                { id: MATE_B, name: MATE_B, role: "teammate", phase: "active" }
              ],
              tasks: []
            }
          },
          state: "idle",
          error: null
        }
      }
    },
    overrides
  );
}

function statusMap(entries) {
  return new Map(Object.entries(entries).map(([id, running]) => [id, { running: running === true }]));
}

function testApi() {
  return loadPlugin().plugin.__test;
}

// ── 素材加载（D1）：假宿主路由 ────────────────────────────────────────────
// 客户端不再内联 base64：素材由 artLoader 从 /agent-whales/api/art/* 拉。
// 这里用 loadPlugin().win.fetch 注入假实现，不碰 Node 全局，也不碰真宿主。
const ART_ROUTE = "/agent-whales/api/art/";
const ART_KEYS = {
  q: [
    "q-smile", "q-blink", "q-wave", "q-proud", "q-sleepy", "q-laugh", "q-pout",
    "q-surprise", "q-shy", "q-think", "q-oops", "q-heart", "q-cry"
  ],
  mature: ["m-base", "m-blink", "m-wave", "m-proud", "m-laugh", "m-pout", "m-surprise", "m-shy", "m-think", "m-oops"],
  classic: ["c-idle", "c-work", "c-think", "c-oops", "c-done"]
};
const ART_SIZES = { q: [168, 192], mature: [192, 192], classic: [177, 192] };
const ALL_ART_KEYS = Object.values(ART_KEYS).flat();

function artManifestBody(extraKeys = {}) {
  const keys = {};
  for (const [skin, list] of Object.entries(ART_KEYS)) {
    const [w, h] = ART_SIZES[skin];
    for (const key of list) keys[key] = { w, h, bytes: 1000, skin };
  }
  return { version: 1, keys: Object.assign(keys, extraKeys) };
}

/**
 * 假宿主：manifest + 每张 webp；记录请求顺序。
 * control 可运行时改：manifestStatus（数字）、manifestStatuses（按次消费的状态队列，
 * 用来模拟「第一次 404、第二次 200」）、manifestBody、failKeys。
 */
function createArtFetch(options = {}) {
  const log = [];
  const control = {
    manifestStatus: options.manifestStatus ?? 200,
    manifestStatuses: Array.isArray(options.manifestStatuses) ? options.manifestStatuses.slice() : null,
    manifestBody: Object.prototype.hasOwnProperty.call(options, "manifestBody")
      ? options.manifestBody
      : artManifestBody(),
    failKeys: new Set(options.failKeys || [])
  };
  const fetchImpl = (url) => {
    const target = String(url);
    log.push(target);
    if (target === ART_ROUTE + "manifest") {
      let status = control.manifestStatus;
      if (control.manifestStatuses !== null && control.manifestStatuses.length > 0) {
        status = control.manifestStatuses.shift();
      }
      if (status !== 200) return Promise.resolve({ ok: false, status });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(control.manifestBody) });
    }
    const match = new RegExp("^" + ART_ROUTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(.+)\\.webp$").exec(target);
    if (match === null) return Promise.resolve({ ok: false, status: 404 });
    const key = decodeURIComponent(match[1]);
    if (control.failKeys.has(key)) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) });
  };
  fetchImpl.log = log;
  fetchImpl.control = control;
  return fetchImpl;
}

function loadPluginWithArt(options = {}) {
  const loaded = loadPlugin();
  loaded.win.fetch = createArtFetch(options);
  return loaded;
}

/**
 * 失败场景专用：把重试等待换成「立即 resolve」，测试不依赖真实 setTimeout 计时。
 * （生产默认是 1s→2s→4s→8s 的真退避。）
 */
function loadPluginWithArtRetry(options = {}) {
  const loaded = loadPluginWithArt(options);
  loaded.plugin.__test.artLoader.setRetryWait(() => Promise.resolve());
  return loaded;
}

/** 触发若干皮肤的素材加载并等到全部落定（成功或失败、含全部重试）。 */
async function loadArt(loaded, families) {
  const { artLoader } = loaded.plugin.__test;
  for (const family of families) artLoader.ensureSkin(family);
  await artLoader.whenIdle();
}

function manifestCalls(loaded) {
  return loaded.win.fetch.log.filter((url) => url === ART_ROUTE + "manifest").length;
}

async function testApiWithArt(families = ["q", "mature"]) {
  const loaded = loadPluginWithArt();
  await loadArt(loaded, families);
  return loaded.plugin.__test;
}

// ── 1. 信封与清单契约 ──────────────────────────────────────────────────────
test("信封：注册 id 等于包名，且只 require('react')", () => {
  const { registration, requireLog } = loadPlugin();
  assert.equal(registration.id, manifest.name, "client.js 的 id 必须等于包名");
  assert.deepEqual(requireLog, ["react"], "浏览器半边只能 require 平台种子中的 react");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.equal(manifest.exports["./client"], "./lib/client.js");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
});

test("apply：注册 shell.overlay 与 settings.section，并登记中英文案", () => {
  const { plugin } = loadPlugin();
  const { appended } = installDocumentStub();
  const injections = [];
  const registrations = [];
  const dictionaries = [];
  const effects = [];

  const ctx = {
    effect(run, name) {
      effects.push(name);
      return run();
    },
    slots: {
      inject(key, register) { injections.push(key); registrations.push(register()); return () => {}; },
      register(options, component) { return { options, component }; }
    },
    sessions: { binding: () => undefined },
    locale: {
      // 装饰层与工作台各注册一个命名空间；测试要把两份都收下来，不能只留最后一个。
      register(namespace, dict) { dictionaries.push({ namespace, dict }); return () => {}; }
    }
  };

  plugin.apply(ctx);

  assert.deepEqual(injections, ["shell.overlay", "settings.section", "conversation.view", "main", "sidebar.panellist", "conversation.input.dock"]);
  assert.equal(registrations.length, 6);
  for (const entry of registrations.slice(0, 2)) {
    assert.equal(entry.options.id, "agent-whales");
    assert.equal(typeof entry.component, "function");
    assert.equal(typeof entry.options.inject, "function");
    assert.equal(typeof entry.options.inject().leadIdOf, "function");
  }
  // P0 画布：注册成与 Chat 并列的 view，且不影子官方渲染（不设 priority）
  const canvasSeat = registrations[2];
  assert.equal(canvasSeat.options.name, "conversation.view");
  assert.equal(canvasSeat.options.id, "whales-canvas");
  assert.equal(canvasSeat.options.priority, undefined, "不得影子官方 UI");
  assert.ok(String(canvasSeat.options.label).length > 0);
  assert.equal(typeof canvasSeat.component, "function");
  // M6/P2：独立主面板只用我们自己的 key，绝不覆盖 conversation（PRD §45.4）
  const workbenchSeat = registrations[3];
  assert.equal(workbenchSeat.options.name, "main");
  assert.equal(workbenchSeat.options.key, "whales-canvas");
  assert.equal(workbenchSeat.options.priority, undefined, "keyed 槽按 key 选择，不需要影子优先级");
  assert.equal(workbenchSeat.options.id, undefined, "keyed 槽不认 id（那是 list 槽的选项）");
  assert.equal(workbenchSeat.options.order, undefined, "keyed 槽不认 order");
  assert.equal(typeof workbenchSeat.component, "function");
  const entrySeat = registrations[4];
  assert.equal(entrySeat.options.name, "sidebar.panellist");
  assert.equal(entrySeat.options.id, "whales-canvas");
  assert.equal(typeof entrySeat.options.order, "number", "list 槽用 {id, order}");
  assert.equal(typeof entrySeat.component, "function");
  // W2/D2：目标条叠在 conversation.input.dock 上——**不影子**官方 composer（不设 priority）
  const dockSeat = registrations[5];
  assert.equal(dockSeat.options.name, "conversation.input.dock");
  assert.equal(dockSeat.options.priority, undefined, "D2 硬约束：叠加上方目标条，不影子官方输入区");
  assert.equal(typeof dockSeat.component, "function");
  assert.equal(appended.length, 1, "样式标签注入一次");
  assert.equal(appended[0].id, "dsh-agent-whales-styles");
  const dictionary = dictionaries.find((row) => row.namespace === "agent-whales");
  assert.ok(dictionary, "必须注册 agent-whales 命名空间");
  assert.deepEqual(
    Object.keys(dictionary.dict.zh).sort(),
    Object.keys(dictionary.dict.en).sort(),
    "中英文键集合必须一致"
  );
  const workbenchDict = dictionaries.find((row) => row.namespace === "agent-whales-workbench");
  assert.ok(workbenchDict, "M6 工作台文案必须注册自己的命名空间");
  assert.deepEqual(
    Object.keys(workbenchDict.dict.zh).sort(),
    Object.keys(workbenchDict.dict.en).sort(),
    "工作台中英文键集合必须一致"
  );
  assert.ok(effects.every((name) => typeof name === "string" && name.length > 0), "每个 effect 都要有名字");
  assert.ok(plugin.inject.includes("slots") && plugin.inject.includes("sessions"));
});

// ── 2. 计数口径 ───────────────────────────────────────────────────────────
test("当前会话：取主视图保留的会话，而不是列表里的最后一个", () => {
  const { currentSessionId } = testApi();
  assert.equal(currentSessionId(listState()), LEAD);
  // 没有主视图保留标记时退回最后一个已知会话（host 侧 ui-session 的同类兜底）
  const orphan = listState();
  orphan.byId[LEAD].retainedBy = { mainView: 0 };
  assert.equal(currentSessionId({ ids: [MATE_A, MATE_B], byId: orphan.byId, projectionsBySession: {} }), MATE_B);
});

test("名册：Lead 与 teammate 各一只；收工的成员灰显保留，failed 不画", () => {
  const { buildPod, DEFAULTS } = testApi();
  const pod = buildPod(listState(), statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false }), DEFAULTS, (id) => id);
  assert.deepEqual(pod.whales.map((w) => w.key), [LEAD, MATE_A, MATE_B]);
  assert.deepEqual(pod.whales.map((w) => w.label), ["鲸鱼插件开发", MATE_A, MATE_B]);
  assert.deepEqual(pod.whales.map((w) => w.lead), [true, false, false]);
  assert.deepEqual(pod.whales.map((w) => w.phase), ["running", "running", "idle"], "没在跑的成员以 idle 留下");
});

test("状态表优先于列表行：状态表说在跑，列表行说没跑，仍然算在跑", () => {
  const { buildPod, DEFAULTS } = testApi();
  const state = listState();
  state.byId[MATE_A].running = false; // 列表行不可信（子智能体会话常见）
  const pod = buildPod(state, statusMap({ [LEAD]: true, [MATE_A]: true }), DEFAULTS, (id) => id);
  assert.deepEqual(pod.whales.map((w) => w.key), [LEAD, MATE_A, MATE_B]);
});

test("状态表没有该会话时，退回列表行 running", () => {
  const { buildPod, DEFAULTS } = testApi();
  const pod = buildPod(listState(), new Map(), DEFAULTS, (id) => id);
  assert.deepEqual(pod.whales.map((w) => w.key), [LEAD, MATE_A, MATE_B]);
});

test("provisioning 算在干活，failed 不算", () => {
  const { buildPod, DEFAULTS } = testApi();
  const state = listState();
  state.projectionsBySession[LEAD].values.agentTeam.members = [
    { id: LEAD, name: "lead", role: "lead", phase: "active" },
    { id: MATE_A, name: MATE_A, role: "teammate", phase: "provisioning" },
    { id: MATE_B, name: MATE_B, role: "teammate", phase: "failed", error: "boom" }
  ];
  const pod = buildPod(state, statusMap({ [LEAD]: true, [MATE_A]: false, [MATE_B]: true }), DEFAULTS, (id) => id);
  assert.deepEqual(pod.whales.map((w) => w.key), [LEAD, MATE_A]);
  assert.equal(pod.whales[1].phase, "provisioning");
});

test("当前会话是 teammate 时，挂到它的 Lead 团队上", () => {
  const { buildPod, DEFAULTS } = testApi();
  const state = listState();
  state.byId[LEAD].retainedBy = { mainView: 0 };
  state.byId[MATE_A].retainedBy = { mainView: 1 }; // 用户正停在 teammate 的会话里
  const pod = buildPod(state, statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false }), DEFAULTS, () => LEAD);
  assert.deepEqual(pod.whales.map((w) => w.key), [LEAD, MATE_A, MATE_B]);
});

test("没有团队投影时退化：Lead 自己在干活也算一只（子 agent 照样挂上来）", () => {
  const { buildPod, DEFAULTS } = testApi();
  const state = listState({ projectionsBySession: {} });
  const pod = buildPod(state, statusMap({ [LEAD]: true }), DEFAULTS, (id) => id);
  assert.equal(pod.whales[0].key, LEAD);
  assert.equal(pod.whales[0].lead, true);
  // 夹具里 mate-a / mate-b 都是 Lead 的子会话：一个在跑、一个已收工，两个都要在（后者灰显）
  assert.deepEqual(pod.whales.map((w) => w.key), [LEAD, MATE_A, MATE_B]);
  assert.deepEqual(pod.whales.map((w) => w.phase), ["running", "running", "idle"]);
  assert.equal(pod.whales[1].parentId, LEAD, "子 agent 记住自己的父会话");

  const idle = buildPod(state, statusMap({ [LEAD]: false }), DEFAULTS, (id) => id);
  assert.equal(idle.whales.length, 0, "没人干活就没有鲸鱼");
});

test("countMode=teams：每个有成员在干活的团队只出一只", () => {
  const { buildPod, DEFAULTS } = testApi();
  const state = listState();
  state.projectionsBySession[MATE_A] = {
    values: {
      agentTeam: {
        members: [
          { id: MATE_A, name: "lead", role: "lead", phase: "active" },
          { id: MATE_B, name: MATE_B, role: "teammate", phase: "active" }
        ]
      }
    }
  };
  const teams = buildPod(
    state,
    statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false }),
    Object.assign({}, DEFAULTS, { countMode: "teams" }),
    (id) => id
  );
  assert.equal(teams.whales.length, 2, "两个团队各一只");
  assert.deepEqual(teams.whales.map((w) => w.key), ["team:" + LEAD, "team:" + MATE_A]);

  const members = buildPod(
    state,
    statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false }),
    DEFAULTS,
    (id) => id
  );
  assert.equal(members.whales.length, 3, "按成员算：Lead + mate-a（在跑）+ mate-b（收工灰显）");
});

test("签名只随鲸鱼集合变化：同一集合必须给出同一个引用", () => {
  const { buildPod, DEFAULTS } = testApi();
  const state = listState();
  const status = statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false });
  const first = buildPod(state, status, DEFAULTS, (id) => id);
  const second = buildPod(state, new Map(status), DEFAULTS, (id) => id);
  assert.equal(first.signature, second.signature, "等价的输入 → 等价签名（选择器据此复用引用）");
  const third = buildPod(state, statusMap({ [LEAD]: true, [MATE_A]: false }), DEFAULTS, (id) => id);
  assert.notEqual(first.signature, third.signature);
});

test("设置项会被夹到合法区间", () => {
  const { normalizeSettings, DEFAULTS } = testApi();
  assert.deepEqual(normalizeSettings(null), DEFAULTS);
  const clamped = normalizeSettings({ scale: 9999, opacity: -5, speed: 0, offset: 999, countMode: "nope", position: "nope" });
  assert.equal(clamped.scale, 200);
  assert.equal(clamped.opacity, 20);
  assert.equal(clamped.speed, 25);
  assert.equal(clamped.offset, 120);
  assert.equal(clamped.countMode, "members");
  assert.equal(clamped.position, "center");
});

// ── 3. 组件渲染 ───────────────────────────────────────────────────────────
function renderLayer(state, status) {
  const { plugin } = loadPlugin();
  const { WhaleLayer } = plugin.__test;
  const props = {
    useSessions: (selector) => selector(state),
    useSessionStatus: (selector) => selector(status),
    leadIdOf: (id) => id,
    t: (key, params) => (params ? key + ":" + params.count : key)
  };
  return { tree: render(WhaleLayer(props)), plugin };
}

test("渲染：2 个在干活 → 2 只角色（各带 agent 标签、Lead 标记与造型容器）", () => {
  const { tree } = renderLayer(listState(), statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false }));
  const whales = findByClass(tree, "daw-whale");
  assert.equal(whales.length, 3, "两只在干活 + 一只收工的成员灰显");
  assert.deepEqual(whales.map((node) => node.props["data-agent"]), ["鲸鱼插件开发", MATE_A, MATE_B]);
  assert.deepEqual(whales.map((node) => node.props["data-lead"]), ["1", "0", "0"]);
  assert.deepEqual(whales.map((node) => node.props["data-state"]), ["running", "running", "idle"]);
  assert.equal(findByClass(tree, "daw-stage").length, 3, "每只角色一个造型容器");

  // 素材是运行时加载的：没就绪之前用矢量鲸鱼占位（D1 的分层策略），不能等白屏。
  const sprites = findByClass(tree, "daw-sprite");
  assert.equal(sprites.length, 0, "素材未就绪时还没有位图");
  const arts = findByClass(tree, "daw-art");
  assert.equal(arts.length, 3, "三只角色各自用矢量鲸鱼占位");
  assert.equal(arts[0].props.viewBox, "0 -16 134 100");
  let gradientIds = [];
  walk(arts[0], (node) => {
    if (node.type === "path" && typeof node.props.fill === "string" && node.props.fill.startsWith("url(#")) {
      gradientIds.push(node.props.fill);
    }
  });
  assert.ok(gradientIds.length >= 1, "鲸鱼身体用渐变上色");
});

test("渲染：素材就绪后改用宿主路由的 <img>，不再画矢量占位", async () => {
  const loaded = loadPluginWithArt();
  await loadArt(loaded, ["q", "mature"]);
  const { WhaleLayer } = loaded.plugin.__test;
  const tree = render(WhaleLayer({
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false })),
    leadIdOf: (id) => id,
    t: (key, params) => (params ? key + ":" + params.count : key)
  }));
  assert.equal(findByClass(tree, "daw-art").length, 0, "有素材就不再画矢量");
  const sprites = findByClass(tree, "daw-sprite");
  assert.ok(sprites.length >= 4, "每只角色至少一张 base 位图，实际 " + sprites.length);
  for (const img of sprites) {
    assert.match(img.props.src, /^\/agent-whales\/api\/art\/[a-z-]+\.webp$/, "位图必须走宿主素材路由");
  }
  const layer = findByClass(tree, "daw-layer")[0];
  assert.equal(layer.props["data-art"], "ready", "图层暴露素材加载状态");
  assert.ok(Number(layer.props["data-art-frames"]) > 0, "已加载帧数必须可观测");
});

test("素材表：manifest 填进 ART 后每张都是路由 URL，尺寸来自宿主清单", async () => {
  const { ART } = await testApiWithArt(["q", "mature", "classic"]);
  const art = ART();
  assert.deepEqual(Object.keys(art).sort(), [...ALL_ART_KEYS].sort(), "28 张全部就位");
  for (const [key, value] of Object.entries(art)) {
    assert.equal(value.uri, ART_ROUTE + key + ".webp", key + " 的 src 必须是宿主路由");
    assert.equal(value.uri.includes("base64"), false, key + " 不得再带内联 base64");
    const skin = key.slice(0, 2) === "q-" ? "q" : key.slice(0, 2) === "m-" ? "mature" : "classic";
    assert.equal(value.w, ART_SIZES[skin][0], key + " 宽度必须来自 manifest");
    assert.equal(value.h, ART_SIZES[skin][1], key + " 高度必须来自 manifest");
  }
});

test("排布：超过 3 只线性缩小，超过上限截断成 +N", () => {
  const { planPod, MAX_VISIBLE, BASE_HEIGHT } = testApi();
  const keyed = (n) => Array.from({ length: n }, (_, i) => ({ key: "k" + i }));

  const one = planPod(keyed(1), BASE_HEIGHT);
  assert.equal(one.size, BASE_HEIGHT, "3 只以内不缩");
  assert.equal(one.overflow, 0);

  assert.equal(planPod(keyed(3), BASE_HEIGHT).size, BASE_HEIGHT);
  assert.equal(planPod(keyed(4), BASE_HEIGHT).size, BASE_HEIGHT - 8, "第 4 只开始每多一只缩 8px");

  const many = planPod(keyed(12), BASE_HEIGHT);
  assert.equal(many.whales.length, MAX_VISIBLE, "可见数量封顶");
  assert.equal(many.overflow, 12 - MAX_VISIBLE);
  assert.equal(many.total, 12);
  assert.ok(many.size >= 56, "缩小有下限，不会缩到看不见");
});

test("皮肤家族：混合模式 Lead 成熟版、成员 Q 版；经典皮肤没有位图", async () => {
  const { familyOf, frameOf } = await testApiWithArt(["q", "mature"]);
  assert.equal(familyOf("mix", true), "mature");
  assert.equal(familyOf("mix", false), "q");
  assert.equal(familyOf("q", true), "q");
  assert.equal(familyOf("mature", false), "mature");
  assert.equal(familyOf("classic", true), "classic");
  assert.equal(frameOf("classic", true, "base"), undefined, "经典皮肤走矢量，不取位图");

  assert.equal(frameOf("mix", false, "blink"), "q-blink", "Q 版有同构图的眨眼帧");
  assert.equal(frameOf("mix", true, "base"), "m-base", "成熟版也换成同批的头肩近景");
  assert.equal(frameOf("mix", true, "blink"), "m-blink", "成熟版现在有真正的眨眼帧");
  assert.equal(frameOf("mix", true, "exit"), "m-proud", "成熟版退场用得意帧");
});

test("家族树：默认只露出根与直接子，点开才出现孙级", () => {
  const { lineageOf } = testApi();
  const whales = [
    { key: "lead", label: "lead", name: "lead" },
    { key: "m1", parentId: "lead", label: "m1", name: "m1" },
    { key: "s1", parentId: "m1", label: "sub", name: "sub" }
  ];

  const closed = lineageOf(whales, () => false);
  assert.deepEqual(closed.map((row) => [row.whale.key, row.depth, row.visible]), [
    ["lead", 0, true],
    ["m1", 1, true],
    ["s1", 2, false]
  ]);
  assert.equal(closed[1].children, 1, "m1 有一个下级，才值得给展开按钮");

  assert.equal(closed[2].parent, "m1", "行里必须带上父会话 key，拖拽才能让子级跟着父级走");
  const open = lineageOf(whales, (id) => id === "m1");
  assert.equal(open[2].visible, true, "展开 m1 之后孙级出现");

  // 父会话不在清单里（已收工）→ 降级为根，绝不消失
  const orphan = lineageOf([{ key: "s1", parentId: "gone", label: "s", name: "s" }], () => false);
  assert.deepEqual(orphan.map((row) => [row.whale.key, row.depth]), [["s1", 0]]);

  // 父子成环也不能死循环
  const loop = lineageOf(
    [
      { key: "a", parentId: "b", label: "a", name: "a" },
      { key: "b", parentId: "a", label: "b", name: "b" }
    ],
    () => true
  );
  assert.equal(loop.length, 2, "环里的两个都要出现，且不会卡死");
});

test("任务与气泡：进行中优先，没任务就退回会话标题", () => {
  const { tasksOf, activityOf } = testApi();
  const team = {
    tasks: [
      { id: "t1", subject: "写 PRD", status: "completed", ownerName: "mate-a" },
      { id: "t2", subject: "跑回归", status: "in_progress", ownerName: "mate-a" },
      { id: "t3", subject: "看 diff", status: "pending", ownerName: "mate-a" },
      { id: "t4", subject: "别人的活", status: "in_progress", ownerName: "mate-b" },
      { id: "t5", subject: "已删", status: "deleted", ownerName: "mate-a" },
      { id: "t6", subject: "还没人认领的活", status: "pending" }
    ]
  };
  assert.deepEqual(
    tasksOf(team, "mate-a").map((task) => task.id),
    ["t2", "t3", "t1"],
    "进行中 → 待办 → 完成，并过滤已删除"
  );
  assert.deepEqual(
    tasksOf(team, "lead", true).map((task) => task.id),
    ["t6"],
    "Lead 额外接管没人认领的团队任务"
  );
  assert.deepEqual(tasksOf(team, "lead", false), [], "普通成员不接管别人的任务");

  const whale = { key: "mate-a", name: "mate-a", label: "mate-a" };
  assert.equal(activityOf(whale, team, {}), "跑回归", "气泡优先用自己名下进行中的任务");
  assert.equal(activityOf(whale, { tasks: [] }, { "mate-a": { title: "审计接口" } }), "审计接口", "没任务退回会话标题");
  assert.equal(activityOf({ key: "x", name: "x", label: "x" }, { tasks: [] }, {}), undefined, "什么都没有就不画气泡");
});

test("渲染：子 agent 挂到父会话下，默认收在父级里，点开才出现", () => {
  const SUB = "sub-1";
  const base = listState();
  base.ids = [LEAD, MATE_A, MATE_B, SUB];
  base.byId[SUB] = { sessionId: SUB, title: "子任务", running: true, origin: "subagent", parentId: MATE_A };
  const status = statusMap({ [LEAD]: true, [MATE_A]: true, [MATE_B]: false, [SUB]: true });

  const { plugin } = loadPlugin();
  function renderTree() {
    return render(plugin.__test.WhaleLayer({
      useSessions: (selector) => selector(base),
      useSessionStatus: (selector) => selector(status),
      leadIdOf: (id) => id,
      t: (key, params) => (params ? key + ":" + params.count : key)
    }));
  }

  const collapsed = renderTree();
  const units = findByClass(collapsed, "daw-unit");
  assert.equal(units.length, 3, "Lead + mate-a + 收工灰显的 mate-b；孙级先收着");
  assert.deepEqual(units.map((node) => node.props["data-depth"]), ["0", "1", "1"]);
  assert.equal(findByClass(collapsed, "daw-expand").length, 1, "mate-a 有下级，给一个展开按钮");
  assert.equal(findByClass(collapsed, "daw-task").length, 0, "没有任务板时不该画任务行");

  plugin.__test.expanded.set([MATE_A]);
  const opened = renderTree();
  assert.equal(findByClass(opened, "daw-unit").length, 4, "展开后孙级出现");
  assert.deepEqual(findByClass(opened, "daw-unit").map((node) => node.props["data-depth"]), ["0", "1", "2", "1"]);
});

test("设置项：风格 / 动画强度 / 粒子会被夹到合法值", () => {
  const { normalizeSettings, DEFAULTS } = testApi();
  const cleaned = normalizeSettings({ skin: "nope", motion: "nope" });
  assert.equal(cleaned.skin, DEFAULTS.skin);
  assert.equal(cleaned.motion, DEFAULTS.motion);
  assert.equal(normalizeSettings({ particles: false }).particles, false);
  assert.equal(normalizeSettings({ skin: "classic", motion: "off" }).skin, "classic");
});

test("渲染：没人干活时默认挂着灰显角色；关掉「没活也挂着」才整层消失", () => {
  const idleStatus = statusMap({ [LEAD]: false, [MATE_A]: false, [MATE_B]: false });

  // 默认 alwaysShow=true：最后一批角色灰显留在屏幕上（data-resting=1）
  const { tree } = renderLayer(listState(), idleStatus);
  assert.ok(tree, "默认挂着");
  const whales = findByClass(tree, "daw-whale");
  assert.deepEqual(whales.map((node) => node.props["data-state"]), ["idle", "idle"], "两员收工的成员灰显");

  // 关掉之后退回「不占位」的老行为
  const { plugin } = loadPlugin();
  const { WhaleLayer, settings } = plugin.__test;
  settings.set({ alwaysShow: false });
  const hidden = WhaleLayer({
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(idleStatus),
    leadIdOf: (id) => id,
    t: (key) => key
  });
  assert.equal(hidden, null);
});

test("渲染：关闭开关后整层消失", () => {
  const { plugin } = loadPlugin();
  const { WhaleLayer, settings } = plugin.__test;
  settings.set({ enabled: false });
  const tree = WhaleLayer({
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true })),
    leadIdOf: (id) => id,
    t: (key) => key
  });
  assert.equal(tree, null);
});

test("渲染：缺少宿主钩子时不炸（退化为空数据）", () => {
  const { plugin } = loadPlugin();
  const { WhaleLayer } = plugin.__test;
  const tree = WhaleLayer({ leadIdOf: (id) => id, t: (key) => key });
  assert.equal(tree, null, "拿不到会话数据时不渲染，但也不能抛异常");
});

test("渲染：设置页显示实时数量与全部控件", () => {
  const { plugin } = loadPlugin();
  const { WhaleSettingsSection } = plugin.__test;
  const tree = render(WhaleSettingsSection({
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true, [MATE_A]: true })),
    leadIdOf: (id) => id,
    t: (key, params) => (params ? key + ":" + params.count : key)
  }));
  const text = [];
  walk(tree, (node) => {
    if (typeof node.props.children === "string") text.push(node.props.children);
  });
  assert.ok(text.includes("live:2"), "设置页显示当前在干活的鲸鱼数：" + text.join("|"));
  const ranges = findByClass(tree, "daw-range");
  assert.equal(ranges.length, 4, "偏移 / 大小 / 不透明度 / 速度 四个滑杆");
  const switches = findByClass(tree, "daw-switch");
  // 2026-10-30 新增「状态表情」「出错表情」两个开关（v0.23 状态信号接线）
  assert.equal(switches.length, 13, "启用 / 粒子 / 对话气泡 / 俏皮话 / 状态表情 / 出错表情 / 没活也挂着 / 团队汇总 / 串门工具 / 显示任务 / 已收工子级 / 可拖拽 / 显示名字");
  const segments = findByClass(tree, "daw-seg");
  assert.equal(segments.length, 5, "计数方式 / 水平位置 / 形象风格 / 动画强度 / 尺寸预设五组分段控件");
});

// ── 4. 宿主半边：团队协作策略 ─────────────────────────────────────────────
test("宿主半边：注册团队协作策略，拿不到 systemPrompt 或注册失败时都不拖垮本行", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);

  const sections = [];
  const labels = [];
  host.apply({
    get: (name) => (name === "systemPrompt" ? { section: (section) => { sections.push(section); return () => {}; } } : undefined),
    effect: (run, label) => { labels.push(label); return run(); }
  });
  assert.equal(sections.length, 1, "只注册一个提示段落");
  assert.equal(sections[0].name, "agent-whales/team-policy");
  assert.ok(Number.isFinite(sections[0].order), "order 必须是有限数字");
  // 真实 dsh-system-prompt 契约：text 可以是 string，也可以是 (context) => string 的惰性段落。
  const policyText = typeof sections[0].text === "function" ? sections[0].text({}) : sections[0].text;
  assert.equal(typeof policyText, "string", "段落文本要么是 string，要么是返回 string 的函数");
  assert.ok(policyText.includes("spawn_teammate"), "策略里要点名团队工具");
  assert.ok(policyText.includes("默认先起团队"), "默认行为是起团队");
  assert.ok(labels.every((label) => typeof label === "string" && label.length > 0), "每个 effect 都要有名字");

  // 没有 systemPrompt 服务：安静跳过，不抛
  assert.doesNotThrow(() => host.apply({ get: () => undefined, effect: (run) => run() }));

  // section() 自身抛错：要被兜住（这一行还负责让浏览器半边被发现）
  const boom = { get: () => ({ section() { throw new Error("boom"); } }), effect: (run) => run(), on: () => () => {} };
  assert.doesNotThrow(() => host.apply(boom));
});
test("子代理：收工的也画成灰显，关掉开关才只留正在跑的", () => {
  const { buildPod, DEFAULTS } = testApi();
  const SUB = "sub-idle";
  const state = listState();
  state.ids.push(SUB);
  state.byId[SUB] = { sessionId: SUB, title: "跑完的子任务", running: false, origin: "subagent", parentId: MATE_A };
  const status = statusMap({ [LEAD]: true, [MATE_A]: true, [SUB]: false });

  const withIdle = buildPod(state, status, DEFAULTS, (id) => id);
  const found = withIdle.whales.find((whale) => whale.key === SUB);
  assert.ok(found, "收工的子会话也要留在画面上，否则看起来像从没组过队");
  assert.equal(found.phase, "idle");
  assert.equal(found.parentId, MATE_A, "仍然是 mate-a 的孩子");

  const runningOnly = buildPod(
    state,
    status,
    Object.assign({}, DEFAULTS, { idleChildren: false }),
    (id) => id
  );
  assert.equal(runningOnly.whales.some((whale) => whale.key === SUB), false, "关掉开关后不再画收工的");
});
test("拖拽：拖过的按自己的坐标，没拖过的跟着被拖的祖先走", () => {
  const { resolveOffsets } = testApi();
  const rows = [
    { whale: { key: "lead" }, depth: 0, parent: undefined },
    { whale: { key: "m1" }, depth: 1, parent: "lead" },
    { whale: { key: "s1" }, depth: 2, parent: "m1" },
    { whale: { key: "other" }, depth: 1, parent: "lead" }
  ];

  assert.deepEqual(resolveOffsets(rows, {}), {}, "没拖过就全部留在队形里");

  const leadMoved = resolveOffsets(rows, { lead: { x: 100, y: 40 } });
  assert.deepEqual(leadMoved.lead, { x: 100, y: 40, own: true });
  assert.deepEqual(leadMoved.m1, { x: 130, y: 52, own: false }, "子级跟着父级，往右下偏一档");
  assert.deepEqual(leadMoved.s1, { x: 160, y: 64, own: false }, "孙级再偏一档");

  const childMoved = resolveOffsets(rows, { m1: { x: 5, y: 6 } });
  assert.equal(childMoved.lead, undefined, "父级不受子级影响");
  assert.deepEqual(childMoved.m1, { x: 5, y: 6, own: true }, "自己拖过就用自己的坐标");
});

test("拖拽：位置单独持久化，关掉开关会清空", () => {
  const { positions } = testApi();
  positions.clear();
  assert.equal(positions.has("lead"), false);
  positions.set("lead", { x: 12.6, y: -3.2 });
  assert.equal(positions.has("lead"), true);
  assert.deepEqual(positions.getSnapshot().map.lead, { x: 13, y: -3 }, "坐标取整");
  positions.remove("lead");
  assert.equal(positions.has("lead"), false);

  positions.set("a", { x: 1, y: 2 });
  positions.clear();
  assert.deepEqual(positions.getSnapshot().map, {}, "清空后不留残值");
});
test("点击跳转：Lead 传 id，子会话传 addressed target", () => {
  const { sessionTargetOf } = testApi();
  assert.equal(sessionTargetOf(undefined, "lead-1", undefined), "lead-1", "Lead 直接传 id");

  assert.deepEqual(
    sessionTargetOf({ parentSessionId: "p", childSessionId: "c", mode: "oneshot" }, "c"),
    { parentSessionId: "p", childSessionId: "c", mode: "oneshot" },
    "有 subagent 地址就用原样的 mode"
  );

  assert.deepEqual(
    sessionTargetOf(undefined, "c", "p"),
    { parentSessionId: "p", childSessionId: "c", mode: "continuable" },
    "绑定里拿不到地址时，用父指针兜底"
  );

  assert.equal(sessionTargetOf(undefined, "c", "c"), "c", "父级等于自己就按普通会话打开");
});
test("俏皮话：按状态取、按 tick 轮换、越界有兜底", () => {
  const { quipFor } = testApi();
  const seen = new Set();
  for (let i = 0; i < 24; i++) seen.add(quipFor("running", i, 0));
  assert.ok(seen.size >= 3, "同一状态至少准备 3 句轮换，实际 " + seen.size);
  assert.notEqual(quipFor("running", 0, 0), quipFor("running", 0, 1), "tick 推进换一句");
  assert.equal(quipFor("running", 5, 1), quipFor("running", 6, 0), "序号 + tick 取模，可预测");
  assert.equal(typeof quipFor("no-such-state", 0, 0), "string", "未知状态走兜底文案");
  assert.ok(quipFor("idle", 0, 0).length <= 5, "俏皮话要短，气泡列宽有限");
});

test("气泡文案：有正事报正事，别人的任务不算自己的", () => {
  const { hasActiveTask } = testApi();
  const team = { tasks: [{ id: "t1", subject: "跑回归", status: "in_progress", ownerName: "mate-a" }] };
  assert.equal(hasActiveTask(team, { key: "m", name: "mate-a", lead: false }), true);
  assert.equal(hasActiveTask(team, { key: "x", name: "mate-b", lead: false }), false);
  assert.equal(hasActiveTask({ tasks: [] }, { key: "m", name: "mate-a", lead: false }), false);
  assert.equal(hasActiveTask(undefined, { key: "m", name: "mate-a", lead: false }), false);
});
test("工具级气泡：任务优先，其次当前工具，再俏皮话", () => {
  const { toolQuip, pickBubbleText } = testApi();
  assert.equal(toolQuip("read"), "在读文件");
  assert.equal(toolQuip("BASH"), "在跑命令", "工具名大小写不敏感");
  assert.equal(toolQuip("some-brand-new-tool"), "在干活", "没登记的工具给兜底文案");
  assert.equal(toolQuip(undefined), "在干活");

  assert.equal(pickBubbleText({ task: "跑回归", tool: "read", quips: true, state: "running", index: 0 }), "跑回归");
  assert.equal(pickBubbleText({ tool: "read", quips: true, state: "running", index: 0 }), "在读文件");
  assert.equal(pickBubbleText({ quips: true, state: "running", index: 0, tick: 0 }), "马上就好");
  assert.equal(pickBubbleText({ quips: false, title: "审计接口" }), "审计接口", "关掉俏皮话退回标题");
  assert.equal(pickBubbleText({ quips: false }), undefined);
});

test("工具活动快照：丢弃脏条目，内容不变时复用同一引用", () => {
  const { toolActivity } = testApi();
  toolActivity.replace({ a: { tool: "read" }, b: { nope: 1 } });
  assert.deepEqual(toolActivity.getSnapshot().map, { a: "read" });
  const before = toolActivity.getSnapshot();
  toolActivity.replace({ a: { tool: "read" } });
  assert.equal(toolActivity.getSnapshot(), before, "内容相同必须复用引用（否则会无限重渲染）");
  toolActivity.replace({ a: { tool: "bash" } });
  assert.notEqual(toolActivity.getSnapshot(), before);
  assert.deepEqual(toolActivity.getSnapshot().map, { a: "bash" });
});

test("宿主：工具活动快照按 TTL 过滤，并过滤脏条目", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const table = new Map([
    ["s1", { tool: "read", startedAt: 9900 }],
    ["s2", { tool: "bash", startedAt: 1000 }],
    ["s3", { tool: null, startedAt: 9900 }]
  ]);
  const snap = host.activityPayload(table, 10000, 5000);
  assert.deepEqual(Object.keys(snap.active), ["s1"], "超过 TTL（s2）与脏条目（s3）都被过滤");
  assert.deepEqual(snap.active.s1, { tool: "read", ageMs: 100 });
});

test("宿主：监听 tools/execute + tools/result，并挂只读活动路由", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const listeners = {};
  const routes = [];
  host.apply({
    get: (name) => {
      if (name === "systemPrompt") return { section: () => () => {} };
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      return undefined;
    },
    effect: (run) => { run(); return () => {}; },
    on: (name, fn) => { listeners[name] = fn; return () => {}; }
  });

  assert.equal(typeof listeners["tools/execute"], "function");
  assert.equal(typeof listeners["tools/result"], "function");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, "/agent-whales/api");

  function readActivity(url) {
    const chunks = [];
    const res = { statusCode: 0, setHeader() {}, end(body) { chunks.push(body); } };
    routes[0].handler({ url }, res);
    return { status: res.statusCode, body: res.statusCode === 200 && chunks.length ? JSON.parse(chunks[0]) : undefined };
  }

  let nextCalled = false;
  listeners["tools/execute"]({ name: "read", agent: { id: "s1" } }, () => { nextCalled = true; return Promise.resolve({}); });
  assert.equal(nextCalled, true, "waterfall 必须继续放行原始调用");
  assert.equal(readActivity("/agent-whales/api/activity").body.active.s1.tool, "read");

  listeners["tools/result"]({ name: "read", agent: { id: "s1" } });
  assert.deepEqual(readActivity("/agent-whales/api/activity").body.active, {}, "调用结束后必须清掉");

  assert.equal(readActivity("/agent-whales/api/nope").status, 404);
});
test("团队汇总条：同样的活只写一次，超量用 +N 收尾", () => {
  const { teamBarText } = testApi();
  assert.equal(teamBarText([]), undefined);
  assert.equal(teamBarText([{ text: "" }, { text: null }]), undefined);
  assert.equal(teamBarText([{ text: "在跑命令" }, { text: "在跑命令" }]), "在跑命令", "三个人跑命令只写一次");
  assert.equal(
    teamBarText([{ text: "审计接口" }, { text: "在跑命令" }, { text: "写文档" }]),
    "审计接口 · 在跑命令 · 写文档"
  );
  assert.equal(
    teamBarText([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }], 3),
    "a · b · c +2",
    "超出条数收尾"
  );
});
test("俏皮话池：既有干活状态，也有应答/陪伴那一路", () => {
  const { quipFor } = testApi();
  const pool = new Set();
  for (let i = 0; i < 40; i++) pool.add(quipFor("running", i, 0));
  assert.ok(pool.size >= 8, "running 池至少 8 句，实际 " + pool.size);
  for (const warm of ["当然可以", "好问题", "稳稳接住"]) {
    assert.ok(pool.has(warm), "应答应有「" + warm + "」这句");
  }
  for (const line of pool) assert.ok(line.length <= 5, "每句都要 ≤5 字：" + line);
  const idlePool = new Set();
  for (let i = 0; i < 20; i++) idlePool.add(quipFor("idle", i, 0));
  assert.ok(idlePool.has("随时叫我"), "收工池也要有应答感的句子");
});
test("拖拽：脏坐标不生效（取消事件的 0,0 与离谱值）", () => {
  const { resolveOffsets } = testApi();
  const rows = [
    { whale: { key: "lead" }, depth: 0, parent: undefined },
    { whale: { key: "m1" }, depth: 1, parent: "lead" }
  ];
  assert.deepEqual(resolveOffsets(rows, { lead: { x: 0, y: 0 } }), {}, "取消事件留下的 (0,0) 不算拖拽结果");
  assert.deepEqual(resolveOffsets(rows, { lead: { x: 99999, y: 3 } }), {}, "离谱坐标不生效");
  assert.deepEqual(resolveOffsets(rows, { lead: { x: NaN, y: 1 } }), {}, "非有限坐标不生效");
  assert.deepEqual(resolveOffsets(rows, { lead: { x: 120, y: -30 } }).lead, { x: 120, y: -30, own: true }, "正常坐标照常生效");
});
test("串门：session_bridge_* 的工具都翻译成短句，且不超过 5 字", () => {
  const { toolQuip } = testApi();
  assert.equal(toolQuip("session_bridge_send"), "去串门");
  assert.equal(toolQuip("session_bridge_read"), "看邻居");
  assert.equal(toolQuip("session_bridge_wait"), "等回话");
  assert.equal(toolQuip("session_bridge_archive"), "送客");
  const names = [
    "session_bridge_create", "session_bridge_send", "session_bridge_wait", "session_bridge_read",
    "session_bridge_segments", "session_bridge_find", "session_bridge_status", "session_bridge_resume",
    "session_bridge_cancel", "session_bridge_archive", "session_bridge_unarchive",
    "session_bridge_monitor_start", "session_bridge_monitor_stop", "session_bridge_monitor_list",
    "session_bridge_archived"
  ];
  for (const name of names) {
    const text = toolQuip(name);
    assert.notEqual(text, "在干活", name + " 应该有专属文案");
    assert.ok(text.length <= 5, name + " 的文案要 ≤5 字，实际「" + text + "」");
  }
});
test("串门：注册三个工具，发话走 followup/steer，读话折叠成文本行", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const registered = {};
  const followups = [];
  const steers = [];
  const session = {
    events: [
      { seq: 0, type: "session/title", data: { title: "隔壁的活" } },
      { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我看看" }] } },
      { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "看过了" }] } } }
    ]
  };
  const agent = {
    id: "s2",
    status: "idle",
    session,
    followup: (message) => followups.push(message),
    steer: (message) => steers.push(message)
  };

  host.apply({
    get: (name) => {
      if (name === "tools") return { register: (tool) => { registered[tool.name] = tool; } };
      if (name === "agents") return { get: (id) => (id === "s2" ? agent : undefined), list: () => [agent] };
      if (name === "workspaceRegistry") return { list: () => [{ id: "w1", sessionIds: ["s2"] }] };
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });

  assert.deepEqual(Object.keys(registered).sort(), ["whales_brief_read", "whales_brief_write", "whales_canvas_inspect", "whales_canvas_layout", "whales_canvas_link", "whales_canvas_list", "whales_canvas_unlink", "whales_propose_tasks", "whales_visit_list", "whales_visit_read", "whales_visit_resume", "whales_visit_send"]);
  assert.equal(typeof registered.whales_visit_send.output.render, "function", "工具必须带 output.render");
  // 网关按 OpenAI function calling 校验：parameters 必须是 { type: "object", properties } 的 JSON Schema。
  // 传「属性表」或空对象会让整轮请求 400（真实事故：whales_visit_list 变成 type: null）。
  for (const [name, tool] of Object.entries(registered)) {
    assert.equal(tool.parameters.type, "object", name + " 的 parameters 必须是 object schema");
    assert.equal(typeof tool.parameters.properties, "object", name + " 必须声明 properties");
    assert.equal(tool.output.schema.type, "object", name + " 的 output.schema 必须是 object schema");
  }

  const list = await registered.whales_visit_list.execute({}, { agent: { id: "caller-client" } });
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].title, "隔壁的活", "标题取自 session/title 事件");
  assert.equal(list.sessions[0].workspaceId, "w1");

  // 2026-10-31 用户决定：默认「插话」（steer），排队要显式指定。
  await registered.whales_visit_send.execute({ sessionId: "s2", message: "来串门" }, { agent: { id: "caller-client" } });
  assert.equal(steers.length, 1, "省略 mode → 默认插话（steer）");
  assert.equal(steers[0].role, "user");
  assert.equal(steers[0].content[0].text, "来串门");

  await registered.whales_visit_send.execute({ sessionId: "s2", message: "排队说", mode: "queue" }, { agent: { id: "caller-client" } });
  assert.equal(followups.length, 1, "显式 queue 走 followup");
  assert.equal(followups[0].content[0].text, "排队说");

  const read = await registered.whales_visit_read.execute({ sessionId: "s2" }, { agent: { id: "caller-client" } });
  assert.deepEqual(read.messages.map((row) => row.role), ["user", "assistant"]);
  assert.equal(read.messages[1].text, "看过了");

  await assert.rejects(() => registered.whales_visit_send.execute({ sessionId: "nope", message: "x" }, { agent: { id: "caller-client" } }), /不活着/);
  await assert.rejects(() => registered.whales_visit_send.execute({ sessionId: "s2", message: "  " }, { agent: { id: "caller-client" } }), /不能为空/);
});
test("心情帧：每 3 个 tick 换一次表情，收工只走抱膝", async () => {
  const { pickMoodKey } = await testApiWithArt(["q", "mature"]);
  assert.equal(pickMoodKey("q", "running", 0), "q-smile");
  assert.equal(pickMoodKey("q", "running", 2), "q-smile", "3 个 tick 内不换");
  assert.equal(pickMoodKey("q", "running", 3), "q-laugh");
  assert.equal(pickMoodKey("q", "running", 6), "q-pout");
  assert.equal(pickMoodKey("q", "running", 9), "q-surprise");
  // 2026-10-30 补入 q-shy（连片红晕），池子从 4 张变 5 张
  assert.equal(pickMoodKey("q", "running", 12), "q-shy", "第 5 张心情帧");
  assert.equal(pickMoodKey("q", "running", 15), "q-smile", "五个一循环");
  assert.equal(pickMoodKey("q", "idle", 3), "q-sleepy", "收工只走抱膝，不放大头特写");
  assert.equal(pickMoodKey("q", "provisioning", 3), "q-sleepy");
  // 成熟版同一套轮换，只是池子不同
  assert.equal(pickMoodKey("mature", "running", 0), "m-base");
  assert.equal(pickMoodKey("mature", "running", 3), "m-laugh");
  assert.equal(pickMoodKey("mature", "running", 6), "m-pout");
  assert.equal(pickMoodKey("mature", "running", 9), "m-surprise");
  assert.equal(pickMoodKey("mature", "running", 12), "m-shy", "成熟版同样补到 5 张");
  assert.equal(pickMoodKey("mature", "running", 15), "m-base", "五个一循环");
  assert.equal(pickMoodKey("mature", "idle", 3), "m-base", "成熟版收工固定用基础帧");
});
test("经典皮肤：用 Martty 像素小人的两帧，图片不可用时退回矢量", async () => {
  const loaded = loadPluginWithArt();
  await loadArt(loaded, ["classic"]);
  const { WhaleLayer, settings, artStatus } = loaded.plugin.__test;
  settings.set({ skin: "classic" });
  const props = {
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true })),
    leadIdOf: (id) => id,
    t: (key) => key
  };

  const tree = render(WhaleLayer(props));
  assert.equal(findByClass(tree, "daw-art").length, 0, "经典皮肤不再画矢量鲸鱼");
  const sprites = findByClass(tree, "daw-sprite");
  assert.ok(sprites.length >= 1, "经典皮肤用位图");
  assert.match(sprites[0].props.src, /^\/agent-whales\/api\/art\/c-[a-z]+\.webp$/, "而且走宿主素材路由");
  // 图片被安全策略拦掉（artBroken）时退回手绘矢量，保证还有东西可看
  artStatus.broken = true;
  const fallback = render(WhaleLayer(props));
  assert.ok(findByClass(fallback, "daw-art").length >= 1, "退回矢量鲸鱼");
  artStatus.broken = false;
});
test("串门：工具返回值必须是 lossless JSON（不能带 undefined 键）", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const registered = {};
  const session = {
    events: [
      { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "你好" }] } }
    ]
  };
  const agent = { id: "s3", status: "idle", session, followup() {}, steer() {}, cancel() {} };
  host.apply({
    get: (name) => {
      if (name === "tools") return { register: (tool) => { registered[tool.name] = tool; } };
      if (name === "agents") return { get: (id) => (id === "s3" ? agent : undefined), list: () => [agent] };
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });

  /** 宿主按「序列化再解析」校验工具输出；出现 undefined 键就会被判非法。 */
  function assertLossless(value, path = "$") {
    if (value === undefined) throw new Error("undefined at " + path);
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) assertLossless(child, path + "." + key);
  }

  const list = await registered.whales_visit_list.execute({}, { agent: { id: "caller-client" } });
  assertLossless(list);
  const read = await registered.whales_visit_read.execute({ sessionId: "s3" }, { agent: { id: "caller-client" } });
  assertLossless(read);

  // 关键回归：等回复超时时不能把 { text: undefined } 带出来
  const sent = await registered.whales_visit_send.execute(
    { sessionId: "s3", message: "测试", waitForReply: true, timeoutMs: 1 },
    { agent: { id: "caller-client" } }
  );
  assert.equal(sent.timedOut, true, "1ms 预算必然超时");
  assert.ok(sent.reply, "超时也要回一个 reply 对象");
  assert.equal("text" in sent.reply, false, "没拿到文本就不能有这个键");
  assertLossless(sent);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), sent, "序列化往返必须等价");
});
test("串门：resume 幂等，离线会话才会真的拉起", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const registered = {};
  const resumed = [];
  let live = new Set(["already-on"]);
  const liveAgent = (id) => (live.has(id) ? { id, status: "idle", session: { events: [] } } : undefined);

  host.apply({
    get: (name) => {
      if (name === "tools") return { register: (tool) => { registered[tool.name] = tool; } };
      if (name === "agents") {
        return {
          get: liveAgent,
          list: () => [...live].map(liveAgent),
          resume: async (options) => {
            resumed.push(options.resumeSessionId);
            live.add(options.resumeSessionId);
            return { agent: liveAgent(options.resumeSessionId), dispose: async () => {} };
          }
        };
      }
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });

  const tool = registered.whales_visit_resume;
  assert.ok(tool, "必须注册 whales_visit_resume");
  assert.equal(tool.parameters.type, "object", "parameters 必须是 object schema");

  const already = await tool.execute({ sessionId: "already-on" }, {});
  assert.deepEqual(already, { sessionId: "already-on", live: true, resumed: false }, "在线会话不重复 resume");
  assert.equal(resumed.length, 0);

  const offline = await tool.execute({ sessionId: "offline-1" }, {});
  assert.deepEqual(resumed, ["offline-1"], "resume 用 resumeSessionId 传参");
  assert.deepEqual(offline, { sessionId: "offline-1", live: true, resumed: true });

  await assert.rejects(() => tool.execute({ sessionId: "  " }, {}), /不能为空/);
  // 输出必须是 lossless JSON（无 undefined 键），否则宿主判非法
  assert.deepEqual(JSON.parse(JSON.stringify(offline)), offline);
});

// ── 状态表情（v0.23 状态信号接线，2026-10-30）──────────────────────────────
test("状态表情：失败 > 庆祝 > 思考 > 工作 > 空闲 的优先级与时效", () => {
  const { faceOf, faceVariant } = testApi();
  const now = 1_000_000;
  const opts = { stateFaces: true, errorFaces: true };

  assert.equal(faceOf({}, now, opts), "idle");
  assert.equal(faceOf({ running: true }, now, opts), "working");
  assert.equal(faceOf({ running: true, streaming: true }, now, opts), "thinking");
  assert.equal(faceOf({ lastErrorAt: now - 1000 }, now, opts), "failed");
  assert.equal(faceOf({ lastErrorAt: now - 9000 }, now, opts), "idle", "8 秒后失败脸自动恢复");
  assert.equal(faceOf({ lastTurnEndAt: now - 1000, lastRunMs: 6000 }, now, opts), "celebrating");
  assert.equal(faceOf({ lastTurnEndAt: now - 1000, lastRunMs: 1000 }, now, opts), "idle", "跑得太短不庆祝");
  assert.equal(faceOf({ lastTurnEndAt: now - 7000, lastRunMs: 6000 }, now, opts), "idle", "6 秒窗口外不庆祝");
  assert.equal(faceOf({ lastErrorAt: now - 1000 }, now, { stateFaces: true, errorFaces: false }), "idle", "关掉出错表情就不显示");
  assert.equal(faceOf({ running: true, streaming: true }, now, { stateFaces: false }), "working", "关掉状态表情退回工作/空闲");
  assert.equal(faceOf({ running: true, streaming: true }, now, { stateFaces: false }), "working");
  assert.equal(faceOf(null, now, opts), "idle", "空数据不抛");
  assert.equal(faceOf({ lastErrorAt: "x", lastTurnEndAt: NaN, streaming: 1, running: "yes" }, now, opts), "idle", "脏数据不抛");
  assert.equal(faceOf({ running: true, lastErrorAt: now - 100 }, now, opts), "failed", "失败压过在跑");

  assert.equal(faceVariant("failed"), "oops");
  assert.equal(faceVariant("thinking"), "think");
  assert.equal(faceVariant("celebrating"), "celebrate");
  assert.equal(faceVariant("working"), undefined);
  assert.equal(faceVariant("idle"), undefined);
});

test("状态表情：Q / 成熟 / 经典的思考·出错·庆祝帧都已接线", async () => {
  const { frameOf, ART } = await testApiWithArt(["q", "mature", "classic"]);
  const art = ART();
  assert.equal(frameOf("q", false, "think"), "q-think");
  assert.equal(frameOf("q", false, "oops"), "q-oops");
  assert.equal(frameOf("q", false, "celebrate"), "q-cry");
  assert.equal(frameOf("mature", true, "think"), "m-think");
  assert.equal(frameOf("mature", true, "oops"), "m-oops");
  assert.equal(frameOf("mature", true, "celebrate"), "m-proud", "成熟版没有 m-done，收工沿用得意帧");
  for (const key of ["q-think", "q-oops", "q-cry", "q-heart", "m-think", "m-oops", "c-think", "c-oops", "c-done"]) {
    assert.ok(art[key], key + " 必须已经加载进 ART，否则 frameOf 会静默退回基础帧");
  }
});

test("设置：状态表情默认开，只有显式 false 才关", () => {
  const { normalizeSettings, DEFAULTS } = testApi();
  assert.equal(DEFAULTS.stateFaces, true);
  assert.equal(DEFAULTS.errorFaces, true);
  assert.equal(normalizeSettings({ stateFaces: false }).stateFaces, false);
  assert.equal(normalizeSettings({ errorFaces: false }).errorFaces, false);
  assert.equal(normalizeSettings({ stateFaces: "no" }).stateFaces, true, "非布尔值不该把开关关掉");
  assert.equal(normalizeSettings({ errorFaces: 0 }).errorFaces, true);
});

test("活动快照：宿主 state 字段脏数据不会污染快照、也不会抛", () => {
  const { toolActivity } = testApi();
  const before = toolActivity.getSnapshot().state;
  assert.equal(typeof before, "object");
  toolActivity.apply({ active: {}, state: { s1: { running: true, lastErrorAt: "x", streaming: "yes", lastRunMs: NaN } } });
  const row = toolActivity.getSnapshot().state.s1;
  assert.equal(row.running, true);
  assert.equal("lastErrorAt" in row, false, "非数字时间戳要丢掉");
  assert.equal("streaming" in row, false, "非 true 的 streaming 要丢掉");
  assert.equal("lastRunMs" in row, false, "NaN 要丢掉");
  toolActivity.apply({ active: {} });
  assert.deepEqual(toolActivity.getSnapshot().state, {}, "旧宿主没 state 时降级成空表，不保留旧值");
});


// ── P2：团队全完成 → 比心（2026-10-30）────────────────────────────────────
test("状态表情：teamDone 映射到比心帧，且 q-heart 真的在 ART 里", async () => {
  const { faceVariant, frameOf, ART } = await testApiWithArt(["q", "mature"]);
  assert.equal(faceVariant("teamDone"), "teamDone");
  assert.equal(frameOf("q", false, "teamDone"), "q-heart");
  assert.equal(frameOf("mature", true, "teamDone"), "m-proud", "成熟版没有比心素材，沿用得意帧");
  assert.ok(ART()["q-heart"], "q-heart 必须已加载");
});

// ── D1：素材加载器（按皮肤分批 / 失败降级 / 幂等）──────────────────────────
test("素材加载：manifest 之后按皮肤分波（L1 base → L2 常用 → L3 其余），且只拉所选皮肤", async () => {
  const loaded = loadPluginWithArt();
  await loadArt(loaded, ["q"]);
  const log = loaded.win.fetch.log;
  const { ART } = loaded.plugin.__test;

  assert.equal(log[0], ART_ROUTE + "manifest", "第一件事是拉清单");
  assert.equal(log[1], ART_ROUTE + "q-smile.webp", "L1：base 帧必须第一个到");

  const indexOf = (key) => log.indexOf(ART_ROUTE + key + ".webp");
  const blink = indexOf("q-blink");
  const wave = indexOf("q-wave");
  const proud = indexOf("q-proud");
  const think = indexOf("q-think");
  const heart = indexOf("q-heart");
  assert.ok(blink > 1 && wave > 1 && proud > 1, "L2：常用帧在 base 之后");
  assert.ok(Math.min(blink, wave, proud) < Math.min(think, heart), "L2 必须先于 L3（心情/状态帧）");

  // 只请求了 q-*（外加 manifest）
  for (const url of log.slice(1)) assert.match(url, /^\/agent-whales\/api\/art\/q-[a-z]+\.webp$/);
  assert.equal(log.length, 1 + ART_KEYS.q.length, "manifest + 13 张 Q 版");
  assert.deepEqual(Object.keys(ART()).sort(), [...ART_KEYS.q].sort());
});

test("素材加载：重复 ensureSkin 不重复请求；切皮肤只补拉新皮肤", async () => {
  const loaded = loadPluginWithArt();
  const { artLoader, ART } = loaded.plugin.__test;

  await loadArt(loaded, ["q"]);
  const afterQ = loaded.win.fetch.log.length;
  await loadArt(loaded, ["q"]); // 同一皮肤再来一次
  assert.equal(loaded.win.fetch.log.length, afterQ, "同一皮肤只加载一次");

  await loadArt(loaded, ["mature"]);
  const log = loaded.win.fetch.log;
  assert.equal(log.filter((url) => url.endsWith("manifest")).length, 1, "manifest 只拉一次");
  assert.equal(log.length, 1 + ART_KEYS.q.length + ART_KEYS.mature.length, "切皮肤只补拉 m-*");
  assert.equal(ART()["q-smile"].uri, ART_ROUTE + "q-smile.webp", "旧皮肤的素材留着不删，切回来不用再拉");
});

test("素材加载：单帧 404 只丢这一帧，frameOf 退回 base，不影响其它帧", async () => {
  const loaded = loadPluginWithArt({ failKeys: ["q-blink"] });
  await loadArt(loaded, ["q"]);
  const { ART, frameOf, artStatus } = loaded.plugin.__test;

  assert.equal(ART()["q-blink"], undefined, "失败的帧不得进 ART");
  assert.ok(ART()["q-smile"], "base 帧照常可用");
  assert.equal(frameOf("q", false, "blink"), "q-smile", "眨眼帧挂了就退回 base，而不是整层变矢量");
  assert.equal(frameOf("q", false, "base"), "q-smile");
  assert.equal(artStatus.broken, false, "非 base 帧失败不能把整层打成矢量");
});

test("素材加载：base 帧 404 → 该皮肤没有主帧、逐只退矢量（不误伤全局）；manifest 重试耗尽 → 整层退矢量", async () => {
  const baseGone = loadPluginWithArt({ failKeys: ["q-smile"] });
  await loadArt(baseGone, ["q"]);
  const baseApi = baseGone.plugin.__test;
  assert.equal(baseApi.ART()["q-smile"], undefined, "404 的 base 帧不得进 ART");
  assert.equal(baseApi.frameOf("q", false, "base"), undefined, "没有主帧 → frameOf 不给位图，渲染逐只退矢量");
  assert.equal(baseApi.artStatus.broken, false, "帧级失败不设全局 broken（换皮肤/回前台还能救）");
  const baseTree = render(baseApi.WhaleLayer({
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true })),
    leadIdOf: (id) => id,
    t: (key) => key
  }));
  assert.ok(findByClass(baseTree, "daw-art").length >= 1, "没有主帧时画矢量兜底");

  const noManifest = loadPluginWithArtRetry({ manifestStatus: 404 });
  const { ART_MAX_ATTEMPTS } = noManifest.plugin.__test;
  await loadArt(noManifest, ["q"]);
  assert.equal(noManifest.plugin.__test.artStatus.broken, true, "manifest 重试耗尽后整层退矢量");
  assert.deepEqual(Object.keys(noManifest.plugin.__test.ART()), [], "一张图都不应该进 ART");
  assert.equal(manifestCalls(noManifest), ART_MAX_ATTEMPTS, "manifest 只允许有限次重试");
  assert.equal(
    noManifest.win.fetch.log.filter((url) => url.endsWith(".webp")).length,
    0,
    "manifest 都拉不到时不得再试探单帧"
  );
});

test("素材加载：manifest 第一次 404、第二次 200 → 自动重试成功并渲染位图", async () => {
  const { ART_MAX_ATTEMPTS } = testApi();
  const loaded = loadPluginWithArtRetry({ manifestStatuses: [404, 200] });
  await loadArt(loaded, ["q"]);
  const { ART, artStatus } = loaded.plugin.__test;

  assert.equal(manifestCalls(loaded), 2, "manifest 恰好请求两次（一次失败 + 一次成功）");
  assert.ok(manifestCalls(loaded) < ART_MAX_ATTEMPTS, "成功之后不再重试");
  assert.ok(ART()["q-smile"], "重试成功后素材进 ART");
  assert.equal(artStatus.broken, false, "重试期间不得提前 latch 成 broken");

  const tree = render(loaded.plugin.__test.WhaleLayer({
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true })),
    leadIdOf: (id) => id,
    t: (key) => key
  }));
  assert.ok(findByClass(tree, "daw-sprite").length >= 1, "重试成功后渲染出 <img>");
});

test("素材加载：重试期间保持矢量占位、不提前 markBroken；最终成功后淡入位图", async () => {
  // 手动控制重试闸门，模拟「宿主还在起、客户端已经渲染过一帧」
  let release = null;
  const loaded = loadPluginWithArt({ manifestStatus: 404 });
  const { artLoader, artStatus, WhaleLayer } = loaded.plugin.__test;
  artLoader.setRetryWait(() => new Promise((resolve) => { release = resolve; }));

  artLoader.ensureSkin("q");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(artStatus.broken, false, "第一次失败只是「在重试」，不许 markBroken");
  assert.equal(artLoader.getSnapshot().retrying, true, "快照要能看出正在退避重试");

  const tree = render(WhaleLayer({
    useSessions: (selector) => selector({ ids: [], byId: {}, phase: "ready", projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
    leadIdOf: (id) => id,
    t: (key) => key
  }));
  // 空会话时图层返回 null，这里只验证重试期间不抛、不 broken
  assert.equal(tree, null);
  assert.equal(artStatus.broken, false);

  // 闸门放行 + 宿主恢复：下一轮就该成功
  loaded.win.fetch.control.manifestStatus = 200;
  const idle = artLoader.whenIdle();
  assert.equal(typeof release, "function", "应当有一个在等待的重试");
  release();
  await idle;
  assert.ok(loaded.plugin.__test.ART()["q-smile"], "重试成功后素材就绪");
  assert.equal(artStatus.broken, false);
});

test("素材加载：重试耗尽后不再无限请求，且能被「回前台」唤醒自愈", async () => {
  const { installDocumentStub } = await import("./harness.mjs");
  const doc = installDocumentStub();
  try {
    const loaded = loadPluginWithArtRetry({ manifestStatus: 404 });
    const { artLoader, artStatus, ART_MAX_ATTEMPTS: maxAttempts } = loaded.plugin.__test;
    await loadArt(loaded, ["q"]);
    assert.equal(artStatus.broken, true, "重试耗尽后整层退矢量");
    assert.equal(manifestCalls(loaded), maxAttempts, "尝试次数封顶");

    // 就此停手：再等也不会继续打
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manifestCalls(loaded), maxAttempts, "耗尽后不再无限重试");

    // 宿主终于起来了：用户切回窗口就该自愈，不用 Ctrl+R
    loaded.win.fetch.control.manifestStatus = 200;
    doc.document.hidden = false;
    doc.document.dispatchEvent({ type: "visibilitychange" });
    await artLoader.whenIdle();
    assert.equal(artStatus.broken, false, "回前台重试成功后撤销 broken");
    assert.ok(loaded.plugin.__test.ART()["q-smile"], "素材恢复");
    assert.ok(manifestCalls(loaded) > maxAttempts, "回前台确实又打了一轮");
  } finally {
    delete globalThis.document;
  }
});

test("素材加载：重试耗尽后切皮肤也能唤醒重试", async () => {
  const loaded = loadPluginWithArtRetry({ manifestStatus: 404 });
  const { artLoader, artStatus } = loaded.plugin.__test;
  await loadArt(loaded, ["q"]);
  assert.equal(artStatus.broken, true);

  loaded.win.fetch.control.manifestStatus = 200;
  artLoader.ensureSkin("mature"); // 用户的主动动作
  await artLoader.whenIdle();
  assert.equal(artStatus.broken, false, "切皮肤触发重试，成功后恢复");
  assert.ok(loaded.plugin.__test.ART()["m-base"], "新皮肤素材就绪");
});

test("素材加载：manifest 脏数据（缺 keys / 尺寸非法）→ 重试耗尽后退矢量且不抛", async () => {
  const { ART_MAX_ATTEMPTS } = testApi();
  for (const body of [null, {}, { keys: {} }, { keys: { "q-smile": { w: 0, h: 192 } } }, { keys: "nope" }]) {
    const loaded = loadPluginWithArtRetry({ manifestBody: body });
    await assert.doesNotReject(() => loadArt(loaded, ["q"]));
    assert.equal(loaded.plugin.__test.artStatus.broken, true, "脏清单必须退矢量：" + JSON.stringify(body));
    assert.deepEqual(Object.keys(loaded.plugin.__test.ART()), [], "脏清单不得塞进半截素材");
    assert.equal(manifestCalls(loaded), ART_MAX_ATTEMPTS, "脏清单也走有限重试：" + JSON.stringify(body));
  }
});

test("素材加载：加载中不阻塞渲染，失败后仍有矢量兜底（不白屏）", async () => {
  const loaded = loadPluginWithArtRetry({ manifestStatus: 500 });
  const props = {
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true })),
    leadIdOf: (id) => id,
    t: (key) => key
  };
  // 加载进行中先渲染一次：必须是矢量占位，不能抛
  const loading = render(loaded.plugin.__test.WhaleLayer(props));
  assert.ok(findByClass(loading, "daw-whale").length >= 1, "素材没到货也要画角色");
  assert.ok(findByClass(loading, "daw-art").length >= 1, "用矢量占位");
  await loadArt(loaded, ["q"]);
  const failed = render(loaded.plugin.__test.WhaleLayer(props));
  assert.ok(findByClass(failed, "daw-art").length >= 1, "失败后仍然有矢量兜底");
  assert.equal(findByClass(failed, "daw-sprite").length, 0, "失败后不再尝试位图");
});

test("素材加载：退避节奏是 1s→2s→4s→8s（记录真实请求的延迟值，不睡真实时间）", async () => {
  const loaded = loadPluginWithArt({ manifestStatus: 404 });
  const { artLoader, ART_RETRY_DELAYS } = loaded.plugin.__test;
  const seen = [];
  // 只记录、立即放行：断言的是「请求了多少毫秒」，不是真的等
  artLoader.setRetryWait((ms) => { seen.push(ms); return Promise.resolve(); });
  await loadArt(loaded, ["q"]);
  assert.deepEqual(seen, ART_RETRY_DELAYS, "重试节奏必须是 1s→2s→4s→8s");
  assert.deepEqual(ART_RETRY_DELAYS, [1000, 2000, 4000, 8000]);
  // 5 次尝试（首次 + 4 次重试），累计等待 15s
  assert.equal(seen.reduce((sum, ms) => sum + ms, 0), 15000, "总退避时长 15s");
});

test("素材加载：重试耗尽后，activity 通了（宿主路由已就绪）自动补一轮，且只补一次", async () => {
  const loaded = loadPluginWithArtRetry({ manifestStatus: 404 });
  const { artLoader, artStatus, activityPoll } = loaded.plugin.__test;
  await loadArt(loaded, ["q"]);
  assert.equal(artStatus.broken, true, "先耗尽重试、退矢量");

  // 宿主终于起来了：activity 路由 200（同一个 /agent-whales/api 前缀）
  const artFetch = loaded.win.fetch;
  const fetchImpl = (url, options) => {
    if (String(url) === "/agent-whales/api/activity") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ active: {}, state: {} }) });
    }
    return artFetch(url, options);
  };
  fetchImpl.log = artFetch.log;
  fetchImpl.control = artFetch.control;
  loaded.win.fetch = fetchImpl;

  loaded.win.fetch.control.manifestStatus = 200;
  activityPoll.start();
  try {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await artLoader.whenIdle();
  } finally {
    activityPoll.stop();
  }
  assert.equal(artStatus.broken, false, "宿主路由恢复后自愈，不用刷新");
  assert.ok(loaded.plugin.__test.ART()["q-smile"], "素材补拉成功");

  // 只补一次：再给宿主「活着」的信号也不该重复重试
  loaded.win.fetch.control.manifestStatus = 404;
  assert.equal(artLoader.notifyHostAlive(), false, "hostAlive 信号只消费一次");
});

test("体积：client.js 不再内联 base64 素材，且控制在 420KB 以内", () => {
  // 上限 200KB → 420KB（M6 工作台）→ 560KB（M6 画布波次，2026-11-14）：dsh.client 只认一个 ./client
  // 导出，装饰层与十屏工作台共用同一个单文件 bundle；素材依旧出包、不内联。
  const source = readFileSync(join(pluginDir, "lib", "client.js"), "utf8");
  assert.equal(source.includes("data:image/webp;base64"), false, "bundle 里不得再出现内联 WebP");
  const bytes = Buffer.byteLength(source, "utf8");
  assert.ok(bytes < 560 * 1024, "client.js 必须 ≤560KB，实际 " + Math.round(bytes / 1024) + "KB");
  assert.ok(source.includes("var ART = {};"), "ART 必须保留空表占位，等运行时填充");
});


// ── 串门投递方式：默认插话，可用 config 改回排队（2026-10-31 用户决定）────
test("串门：默认插话（steer），config.visitMode=queue / visitSteer=false 可改回排队", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);

  async function run(config) {
    const registered = {};
    const calls = { followup: 0, steer: 0 };
    const session = { events: [] };
    const agent = {
      id: "s9",
      status: "idle",
      session,
      followup: () => { calls.followup += 1; },
      steer: () => { calls.steer += 1; }
    };
    host.apply({
      get: (name) => {
        if (name === "tools") return { register: (tool) => { registered[tool.name] = tool; } };
        if (name === "agents") return { get: (id) => (id === "s9" ? agent : undefined), list: () => [agent] };
        return undefined;
      },
      on: () => () => {},
      effect: (fn) => { fn(); return () => {}; }
    }, config);
    await registered.whales_visit_send.execute({ sessionId: "s9", message: "hi" }, { agent: { id: "caller-client" } });
    return calls;
  }

  assert.deepEqual(await run(undefined), { followup: 0, steer: 1 }, "不配置时默认插话");
  assert.deepEqual(await run({ visitMode: "queue" }), { followup: 1, steer: 0 }, "config.visitMode=queue → 默认排队");
  assert.deepEqual(await run({ visitSteer: false }), { followup: 1, steer: 0 }, "兼容 config.visitSteer=false");
  assert.deepEqual(await run({ visitMode: "nonsense" }), { followup: 0, steer: 1 }, "脏配置退回插话");
});

test("计数只算真正在跑的：启动中单独标注，卡住超时降级为收工", () => {
  const { buildPod, DEFAULTS, provisioningSince, PROVISIONING_GRACE_MS } = testApi();
  const { plugin } = loadPlugin();
  const state = listState();
  const STUCK_A = "session-stuck-a";
  const STUCK_B = "session-stuck-b";
  state.projectionsBySession[LEAD].values.agentTeam.members = [
    { id: LEAD, name: "lead", role: "lead", phase: "active" },
    { id: MATE_A, name: MATE_A, role: "teammate", phase: "active" },
    { id: STUCK_A, name: "stuck-a", role: "teammate", phase: "provisioning" },
    { id: STUCK_B, name: "stuck-b", role: "teammate", phase: "provisioning" }
  ];
  const status = statusMap({ [LEAD]: true, [MATE_A]: true, [STUCK_A]: false, [STUCK_B]: false });

  // 刚 spawn、还在启动窗口内：它们仍要画出来，但不计入「在干活」
  delete provisioningSince[STUCK_A];
  delete provisioningSince[STUCK_B];
  const fresh = buildPod(state, status, DEFAULTS, (id) => id);
  assert.deepEqual(
    fresh.whales.map((w) => [w.key, w.phase]),
    [[LEAD, "running"], [MATE_A, "running"], [STUCK_A, "provisioning"], [STUCK_B, "provisioning"], [MATE_B, "idle"]]
  );

  // 界面上：只报 2 只在干活 + 2 只启动中（而不是笼统的 4 只在干活）
  const { WhaleLayer, settings } = plugin.__test;
  settings.set({ labels: true });
  const tree = WhaleLayer({
    useSessions: (selector) => selector(state),
    useSessionStatus: (selector) => selector(status),
    leadIdOf: (id) => id,
    t: (key, params) => (params ? key + ":" + params.count : key)
  });
  const chips = findByClass(tree, "daw-count");
  assert.ok(chips.length >= 1, "标签开启时应有计数条");
  const texts = chips.map((chip) => chip.props.children.join(""));
  assert.ok(texts.includes("count:2 · starting:2"), "计数必须区分在干活与启动中，实际：" + JSON.stringify(texts));

  // 超过宽限期仍没起来的，降级为 idle（灰显），不再挂「启动中」
  provisioningSince[STUCK_A] = Date.now() - PROVISIONING_GRACE_MS - 1000;
  provisioningSince[STUCK_B] = Date.now() - PROVISIONING_GRACE_MS - 1000;
  const aged = buildPod(state, status, DEFAULTS, (id) => id);
  assert.deepEqual(
    aged.whales.map((w) => [w.key, w.phase]),
    [[LEAD, "running"], [MATE_A, "running"], [STUCK_A, "idle"], [STUCK_B, "idle"], [MATE_B, "idle"]]
  );
  delete provisioningSince[STUCK_A];
  delete provisioningSince[STUCK_B];
});
test("图形面板：分层布局、偏移叠加与脏数据兜底", () => {
  const { graphLayout } = testApi();
  const rows = [
    { whale: { key: "lead", label: "Lead", phase: "running" }, depth: 0 },
    { whale: { key: "a", label: "A", phase: "running" }, depth: 1, parent: "lead" },
    { whale: { key: "b", label: "B", phase: "idle" }, depth: 1, parent: "lead" }
  ];
  const layout = graphLayout(rows);
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 2, "每个有父节点的都画一条边");
  assert.equal(layout.nodes[0].y, 0);
  assert.equal(layout.nodes[1].y, 84, "第二层下移一行");
  assert.equal(layout.nodes[1].parent, "lead");
  assert.ok(layout.width >= 248, "两层各两个节点时画布够宽");
  assert.equal(layout.nodes[2].phase, "idle", "idle 保留给面板做灰显");

  const moved = graphLayout(rows, { a: { x: 40, y: -10 } });
  const a = moved.nodes.find((n) => n.key === "a");
  const base = layout.nodes.find((n) => n.key === "a");
  assert.equal(a.x, base.x + 40, "拖动偏移叠加在自动布局上");
  assert.equal(a.y, base.y - 10);

  assert.equal(graphLayout(null).nodes.length, 0, "空数据不炸");
  const deep = graphLayout([{ whale: { key: "x" }, depth: 99, parent: "nope" }]);
  assert.equal(deep.nodes[0].depth, 8, "过深夹到 8");
  assert.equal(deep.edges.length, 0, "父节点不在图里就不画边");
});

test("图形面板：POST /api/send 校验 token 并把话投给 agent", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const routes = [];
  const delivered = [];
  const agent = {
    id: "s-live",
    status: "running",
    session: { events: [] },
    followup(message) { delivered.push(message); },
    steer(message) { delivered.push(message); }
  };
  host.apply({
    get: (name) => {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "agents") return { get: (id) => (id === "s-live" ? agent : undefined) };
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });
  const route = routes.find((item) => item && typeof item.handler === "function");
  assert.ok(route, "必须注册了 /agent-whales/api 前缀路由");

  function fakeReq(method, url, headers, body) {
    const listeners = {};
    const req = {
      method,
      url,
      headers: headers || {},
      on(event, fn) {
        (listeners[event] = listeners[event] || []).push(fn);
        return req;
      }
    };
    setTimeout(() => {
      if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
      (listeners.end || []).forEach((fn) => fn());
    }, 0);
    return req;
  }
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {},
      body: "",
      setHeader(key, value) { this.headers[key] = value; },
      end(chunk) { if (chunk !== undefined) this.body += String(chunk); }
    };
  }

  const probe = fakeRes();
  await route.handler(fakeReq("GET", "/agent-whales/api/activity", {}, undefined), probe);
  const token = JSON.parse(probe.body).controlToken;
  assert.equal(typeof token, "string");

  const denied = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/send", {}, JSON.stringify({ sessionId: "s-live", text: "hi" })), denied);
  assert.equal(denied.statusCode, 403, "没有 token 必须 403");

  const ok = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/send", { "x-whales-token": token }, JSON.stringify({ sessionId: "s-live", text: "来串门", mode: "queue" })), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].content[0].text, "来串门");
  assert.deepEqual(JSON.parse(ok.body), { ok: true, sessionId: "s-live", mode: "queue" });

  const missing = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/send", { "x-whales-token": token }, JSON.stringify({ sessionId: "s-live", text: "  " })), missing);
  assert.equal(missing.statusCode, 400, "空文本必须 400");
});

test("任务命令路由 v2：信封、鉴权、五个 action、并发去重、超时 unknown 不重派", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const routes = [];
  const calls = { update: [], send: [] };
  const lead = { id: "lead-session", status: "running", session: { events: [] } };
  const teammate = { id: "mate-b", status: "inactive", session: { events: [] } };
  let task = { id: "t1", revision: 1, subject: "干活", description: "", status: "pending", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] };
  let lateSend = null;

  const teams = {
    tryMembership: (agent) => (agent && agent.id === lead.id ? { root: lead, id: "team-1", role: "lead", name: "lead" } : agent && agent.id === teammate.id ? { root: lead, id: "team-1", role: "teammate", name: "mate-b" } : undefined),
    listTasks: () => [task],
    listMembers: () => [{ id: lead.id, name: "lead", role: "lead", status: "running", diagnostics: [] }],
    getTask: (_caller, id) => {
      if (id !== task.id) throw new Error("team task not found");
      return task;
    },
    updateTask: async (_caller, request) => {
      calls.update.push(request);
      await new Promise((resolve) => setTimeout(resolve, 5)); // 让并发请求有机会重叠
      if (request.expectedRevision !== task.revision) throw new Error("team task revision conflict");
      if (request.action === "reopen") {
        task = Object.assign({}, task, { revision: task.revision + 1, status: "pending", ownerName: undefined, ready: true });
        return task;
      }
      if (task.ready === false && task.blockedBy.length > 0) throw new Error(`team task ${task.id} is blocked`);
      task = Object.assign({}, task, { revision: task.revision + 1, status: "in_progress", ownerName: request.owner, ready: false });
      return task;
    },
    sendMessage: (_caller, request) => {
      calls.send.push(request);
      // 挂起：等测试显式放行（模拟「投递结果晚到」）
      return new Promise((resolve) => { lateSend = () => resolve({ messageId: "msg-late" }); });
    }
  };

  host.apply({
    get: (name) => {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "agents") return { get: (id) => (id === lead.id ? lead : id === teammate.id ? teammate : undefined) };
      if (name === "agentTeams") return teams;
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });
  const route = routes.find((item) => item && typeof item.handler === "function");
  assert.ok(route);

  function fakeReq(method, url, headers, body) {
    const listeners = {};
    const req = { method, url, headers: headers || {}, on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return req; } };
    setTimeout(() => {
      if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
      (listeners.end || []).forEach((fn) => fn());
    }, 0);
    return req;
  }
  function fakeRes() {
    return { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(chunk) { if (chunk !== undefined) this.body += String(chunk); } };
  }
  const probe = fakeRes();
  await route.handler(fakeReq("GET", "/agent-whales/api/activity", {}, undefined), probe);
  const token = JSON.parse(probe.body).controlToken;

  // 信封：只读快照
  const snapshot = fakeRes();
  await route.handler(fakeReq("GET", "/agent-whales/api/tasks?leadSessionId=" + lead.id, {}, undefined), snapshot);
  assert.equal(snapshot.statusCode, 200);
  const snap = JSON.parse(snapshot.body);
  assert.equal(snap.code, 200);
  assert.ok(snap.data && Array.isArray(snap.data.tasks) && snap.data.tasks.length === 1, "任务放在 data 里");

  // 鉴权：非 Lead → HTTP 403 + 40301
  const notLead = fakeRes();
  await route.handler(fakeReq("GET", "/agent-whales/api/tasks?leadSessionId=" + teammate.id, {}, undefined), notLead);
  assert.equal(notLead.statusCode, 403);
  assert.equal(JSON.parse(notLead.body).code, 40301);

  // 无 token → 403
  const denied = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/tasks/t1/commands", {}, JSON.stringify({})), denied);
  assert.equal(denied.statusCode, 403);

  const command = (body) => [fakeReq("POST", "/agent-whales/api/tasks/t1/commands", { "x-whales-token": token }, JSON.stringify(body)), fakeRes()];

  // 非法 action → HTTP 400 + 40000
  let [bad, badRes] = command({ leadSessionId: lead.id, requestId: "b1", action: "nuke" });
  await route.handler(bad, badRes);
  assert.equal(badRes.statusCode, 400);
  assert.equal(JSON.parse(badRes.body).code, 40000);

  // assign：只写任务板，不派发；业务量放 data.task / data.dispatch
  let [a1, a1Res] = command({ leadSessionId: lead.id, requestId: "r1", action: "assign", owner: "mate-b", expectedRevision: 1 });
  await route.handler(a1, a1Res);
  assert.equal(a1Res.statusCode, 200);
  const a1Body = JSON.parse(a1Res.body);
  assert.equal(a1Body.code, 200);
  assert.equal(a1Body.data.dispatch.status, "not-requested");
  assert.equal(a1Body.data.task.ownerName, "mate-b");
  assert.equal(calls.send.length, 0);

  // 同 requestId 重放：不重复写
  let [a2, a2Res] = command({ leadSessionId: lead.id, requestId: "r1", action: "assign", owner: "mate-b", expectedRevision: 1 });
  await route.handler(a2, a2Res);
  assert.equal(JSON.parse(a2Res.body).data.replayed, true);
  assert.equal(calls.update.length, 1);

  // 同 ID 不同 payload → code 40903（HTTP 200）
  let [a3, a3Res] = command({ leadSessionId: lead.id, requestId: "r1", action: "assign", owner: "lead", expectedRevision: 2 });
  await route.handler(a3, a3Res);
  assert.equal(a3Res.statusCode, 200);
  assert.equal(JSON.parse(a3Res.body).code, 40903);

  // dispatch：不写任务板
  const beforeDispatchUpdates = calls.update.length;
  let [d1, d1Res] = command({ leadSessionId: lead.id, requestId: "r2", action: "dispatch", dispatchTimeoutMs: 20 });
  await route.handler(d1, d1Res);
  const d1Body = JSON.parse(d1Res.body);
  assert.equal(d1Body.code, 200);
  assert.equal(calls.update.length, beforeDispatchUpdates, "单独派发不得写任务板");
  assert.equal(d1Body.data.dispatch.status, "unknown", "超时必须回 unknown，不能宣称成功");
  assert.equal(calls.send.length, 1);
  if (lateSend) lateSend();
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 重放同一 requestId：即使底层晚到成功，也不得再次派发
  let [d2, d2Res] = command({ leadSessionId: lead.id, requestId: "r2", action: "dispatch", dispatchTimeoutMs: 20 });
  await route.handler(d2, d2Res);
  assert.equal(calls.send.length, 1, "unknown 之后重放不得重复派发");
  assert.equal(JSON.parse(d2Res.body).data.replayed, true);

  // 并发同 requestId：update 与 send 各只发生一次
  task = Object.assign({}, task, { id: "t2", revision: 1, status: "pending", ownerName: undefined, ready: true, blockedBy: [] });
  const before = { update: calls.update.length, send: calls.send.length };
  const post = (body) => [fakeReq("POST", "/agent-whales/api/tasks/t2/commands", { "x-whales-token": token }, JSON.stringify(body)), fakeRes()];
  let [c1, c1Res] = post({ leadSessionId: lead.id, requestId: "r3", action: "assign-and-dispatch", owner: "mate-b", expectedRevision: 1, dispatchTimeoutMs: 20 });
  let [c2, c2Res] = post({ leadSessionId: lead.id, requestId: "r3", action: "assign-and-dispatch", owner: "mate-b", expectedRevision: 1, dispatchTimeoutMs: 20 });
  await Promise.all([route.handler(c1, c1Res), route.handler(c2, c2Res)]);
  assert.equal(calls.update.length, before.update + 1, "并发同 ID 只能写一次任务板");
  assert.equal(calls.send.length, before.send + 1, "并发同 ID 只能派发一次");

  // 被阻塞 → code 40901 且不派发
  task = Object.assign({}, task, { id: "t3", revision: 1, status: "pending", ownerName: undefined, ready: false, blockedBy: ["t9"] });
  const beforeBlock = calls.send.length;
  let [b1, b1Res] = [fakeReq("POST", "/agent-whales/api/tasks/t3/commands", { "x-whales-token": token }, JSON.stringify({ leadSessionId: lead.id, requestId: "r4", action: "assign-and-dispatch", owner: "mate-b", expectedRevision: 1 })), fakeRes()];
  await route.handler(b1, b1Res);
  assert.equal(b1Res.statusCode, 200);
  assert.equal(JSON.parse(b1Res.body).code, 40901);
  assert.equal(calls.send.length, beforeBlock, "阻塞任务不得派发");

  // revision 冲突 → code 40902 + maybeApplied（回到 t1，当前 revision 已推进）
  task = Object.assign({}, task, { id: "t1", revision: 5, status: "in_progress", ownerName: "mate-b", ready: false, blockedBy: [] });
  let [x1, x1Res] = command({ leadSessionId: lead.id, requestId: "r5", action: "assign", owner: "lead", expectedRevision: 1 });
  await route.handler(x1, x1Res);
  const x1Body = JSON.parse(x1Res.body);
  assert.equal(x1Body.code, 40902);
  assert.equal(x1Body.data.maybeApplied, true);

  // unassign：写任务板回未认领
  let [u1, u1Res] = [fakeReq("POST", "/agent-whales/api/tasks/t1/commands", { "x-whales-token": token }, JSON.stringify({ leadSessionId: lead.id, requestId: "r6", action: "unassign", expectedRevision: task.revision })), fakeRes()];
  await route.handler(u1, u1Res);
  const u1Body = JSON.parse(u1Res.body);
  assert.equal(u1Body.code, 200, u1Res.body);
  assert.equal(u1Body.data.task.ownerName === undefined, true, "unassign 必须清空 owner");
});
test("画布视图：渲染任务/成员；缺数据时给空态而不是崩", () => {
  const { plugin } = loadPlugin();
  const { WhaleCanvasView } = plugin.__test;
  assert.equal(typeof WhaleCanvasView, "function");

  const full = render(WhaleCanvasView({
    useSessions: (selector) => selector(listState()),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: true })),
    leadIdOf: (id) => id,
    t: (key, params) => (params ? key + ":" + params.members + "/" + params.tasks : key)
  }));
  assert.equal(findByClass(full, "daw-canvas").length, 1, "必须有画布根节点");
  assert.equal(findByClass(full, "daw-canvas-head").length, 1);
  const cards = findByClass(full, "daw-canvas-card");
  assert.ok(cards.length >= 3, "任务与成员都要出卡片，实际 " + cards.length);
  assert.ok(findByClass(full, "daw-canvas-foot").length === 1, "必须有只读提示");

  // 没有团队投影时：空态文案，且不抛
  const empty = render(WhaleCanvasView({
    useSessions: (selector) => selector(listState({ projectionsBySession: {} })),
    useSessionStatus: (selector) => selector(statusMap({ [LEAD]: false })),
    leadIdOf: (id) => id,
    t: (key) => key
  }));
  assert.equal(findByClass(empty, "daw-canvas-card").length, 0);
  assert.equal(findByClass(empty, "daw-canvas-empty").length, 2, "任务与成员各一条空态");

  // 槽位没给 hook 也不崩
  const bare = render(WhaleCanvasView({ t: (key) => key }));
  assert.equal(findByClass(bare, "daw-canvas").length, 1);
});
test("提案：校验 key 唯一 / 前置存在 / 无环 / 拓扑序稳定", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const ok = host.validateProposal({
    leadSessionId: "s1",
    items: [
      { key: "a", title: "A" },
      { key: "b", title: "B", blockedByKeys: ["a"] },
      { key: "c", title: "C", blockedByKeys: ["b"] }
    ]
  });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.order, ["a", "b", "c"]);

  assert.match(host.validateProposal({ leadSessionId: "s1", items: [{ key: "a", title: "A" }, { key: "a", title: "B" }] }).error, /duplicate/);
  assert.match(host.validateProposal({ leadSessionId: "s1", items: [{ key: "a", title: "A", blockedByKeys: ["x"] }] }).error, /unknown/);
  assert.match(host.validateProposal({ leadSessionId: "s1", items: [{ key: "a", title: "A", blockedByKeys: ["b"] }, { key: "b", title: "B", blockedByKeys: ["a"] }] }).error, /cycle/);
  assert.match(host.validateProposal({ leadSessionId: "", items: [{ key: "a", title: "A" }] }).error, /leadSessionId/);
  assert.match(host.validateProposal({ leadSessionId: "s1", items: [] }).error, /non-empty/);

  // 同层按声明顺序（稳定）
  const stable = host.validateProposal({ leadSessionId: "s1", items: [{ key: "z", title: "Z" }, { key: "y", title: "Y" }] });
  assert.deepEqual(stable.order, ["z", "y"]);
});

test("提案：确认按拓扑序创建任务；版本不符拒绝；重放不重复", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aw-proposal-"));
  const storeFile = pathMod.join(dir, "proposals.json");
  host.setProposalStorePathForTests(storeFile);

  const record = {
    proposalId: "p1",
    version: 2,
    leadSessionId: "lead-session",
    items: [
      { key: "a", title: "A", description: "", blockedByKeys: [], expectedOutput: "" },
      { key: "b", title: "B", description: "", blockedByKeys: ["a"], expectedOutput: "" }
    ],
    order: ["a", "b"],
    createdAt: Date.now()
  };
  fs.writeFileSync(storeFile, JSON.stringify({ "lead-session": record }), "utf8");

  const routes = [];
  const created = [];
  const lead = { id: "lead-session", status: "running", session: { events: [] } };
  const teams = {
    tryMembership: () => ({ root: lead, id: "team-1", role: "lead", name: "lead" }),
    listTasks: () => [],
    listMembers: () => [{ id: lead.id, name: "lead", role: "lead", status: "running", diagnostics: [] }],
    createTask: async (_caller, request) => {
      created.push({ subject: request.subject, blockedBy: request.blockedBy });
      return { id: "task-" + (10 + created.length), revision: 1 };
    }
  };
  host.apply({
    get: (name) => {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "agents") return { get: (id) => (id === lead.id ? lead : undefined), list: () => [lead] };
      if (name === "agentTeams") return teams;
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });
  const route = routes.find((item) => item && typeof item.handler === "function");
  assert.ok(route, "必须有 api 前缀路由");

  function fakeReq(method, url, headers, body) {
    const listeners = {};
    const req = { method, url, headers: headers || {}, on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return req; } };
    setTimeout(() => {
      if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
      (listeners.end || []).forEach((fn) => fn());
    }, 0);
    return req;
  }
  function fakeRes() {
    return { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(chunk) { if (chunk !== undefined) this.body += String(chunk); } };
  }
  const probe = fakeRes();
  await route.handler(fakeReq("GET", "/agent-whales/api/activity", {}, undefined), probe);
  const token = JSON.parse(probe.body).controlToken;

  // 读取提案
  const read = fakeRes();
  await route.handler(fakeReq("GET", "/agent-whales/api/proposals?leadSessionId=" + lead.id, {}, undefined), read);
  assert.equal(read.statusCode, 200);
  const readBody = JSON.parse(read.body);
  assert.equal(readBody.code, 200);
  assert.equal(readBody.data.proposal.version, 2);
  assert.deepEqual(readBody.data.proposal.items.map((item) => item.key), ["a", "b"]);

  // 版本不符 → 40902
  const stale = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/proposals/p1/confirm", { "x-whales-token": token }, JSON.stringify({ leadSessionId: lead.id, version: 1, requestId: "c0" })), stale);
  assert.equal(JSON.parse(stale.body).code, 40902);

  // 正常确认：按拓扑序创建，blockedBy 用真实 taskId
  const ok = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/proposals/p1/confirm", { "x-whales-token": token }, JSON.stringify({ leadSessionId: lead.id, version: 2, requestId: "c1" })), ok);
  const okBody = JSON.parse(ok.body);
  assert.equal(okBody.code, 200, ok.body);
  assert.deepEqual(okBody.data.created.map((row) => row.key), ["a", "b"]);
  assert.equal(created.length, 2);
  assert.equal(created[0].subject, "A");
  assert.equal(created[1].blockedBy.length, 1, "第二项必须引用第一项的真实 taskId");
  assert.equal(created[1].blockedBy[0], okBody.data.created[0].taskId);

  // 同 requestId 重放：不重复创建
  const replay = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/proposals/p1/confirm", { "x-whales-token": token }, JSON.stringify({ leadSessionId: lead.id, version: 2, requestId: "c1" })), replay);
  assert.equal(created.length, 2, "重放不得重复创建");
  assert.equal(JSON.parse(replay.body).data.replayed, true);

  // 换 requestId 再确认同一版本：已确认则返回既有结果
  const again = fakeRes();
  await route.handler(fakeReq("POST", "/agent-whales/api/proposals/p1/confirm", { "x-whales-token": token }, JSON.stringify({ leadSessionId: lead.id, version: 2, requestId: "c2" })), again);
  assert.equal(created.length, 2, "已确认的版本不得重复创建");
});
test("提案：确认后锁定；部分失败可补建；前置未建标 blocked；旧提案不再接受新版本", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aw-lock-"));
  const storeFile = pathMod.join(dir, "proposals.json");
  host.setProposalStorePathForTests(storeFile);

  const routes = [];
  const created = [];
  let failNext = false;
  const lead = { id: "lead-session", status: "running", session: { events: [] } };
  const tools = {};
  const teams = {
    tryMembership: () => ({ root: lead, id: "team-1", role: "lead", name: "lead" }),
    listTasks: () => [],
    listMembers: () => [],
    createTask: async (_caller, request) => {
      if (request.subject === "B" && failNext) { failNext = false; throw new Error("boom: cannot create"); }
      created.push(request.subject);
      return { id: "task-" + (20 + created.length), revision: 1 };
    }
  };
  host.apply({
    get: (name) => {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "agents") return { get: (id) => (id === lead.id ? lead : undefined), list: () => [lead] };
      if (name === "agentTeams") return teams;
      if (name === "tools") return { register: (tool) => { tools[tool.name] = tool; return () => {}; } };
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });
  const propose = tools.whales_propose_tasks;
  assert.ok(propose, "必须注册提案工具");

  const submitted = await propose.execute({
    leadSessionId: lead.id,
    items: [
      { key: "a", title: "A" },
      { key: "b", title: "B", blockedByKeys: ["a"] },
      { key: "c", title: "C", blockedByKeys: ["b"] }
    ]
  }, { agent: { id: lead.id } });
  assert.equal(submitted.version, 1);

  const route = routes.find((item) => item && typeof item.handler === "function");
  function fakeReq(method, url, headers, body) {
    const listeners = {};
    const req = { method, url, headers: headers || {}, on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return req; } };
    setTimeout(() => {
      if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
      (listeners.end || []).forEach((fn) => fn());
    }, 0);
    return req;
  }
  function fakeRes() {
    return { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(chunk) { if (chunk !== undefined) this.body += String(chunk); } };
  }
  const probe = fakeRes();
  await route.handler(fakeReq("GET", "/agent-whales/api/activity", {}, undefined), probe);
  const token = JSON.parse(probe.body).controlToken;
  const confirmUrl = "/agent-whales/api/proposals/" + submitted.proposalId + "/confirm";
  const post = (body) => [fakeReq("POST", confirmUrl, { "x-whales-token": token }, JSON.stringify(body)), fakeRes()];

  // 第一次：B 失败 → A 已建；B failed；C 因前置未建标 blocked
  failNext = true;
  let [req1, res1] = post({ leadSessionId: lead.id, version: 1, requestId: "k1" });
  await route.handler(req1, res1);
  const first = JSON.parse(res1.body);
  assert.equal(first.code, 200, res1.body);
  assert.deepEqual(first.data.created.map((row) => row.key), ["a"]);
  assert.deepEqual(first.data.failed.map((row) => row.key).sort(), ["b", "c"]);
  const cState = first.data.failed.find((row) => row.key === "c");
  assert.equal(cState.status, "blocked", "C 的前置未建 → blocked，不应尝试创建");
  assert.equal(created.length, 1, "只应真正创建 A");

  // 重试（新 requestId、同版本）：跳过已建 A，补建 B/C
  let [req2, res2] = post({ leadSessionId: lead.id, version: 1, requestId: "k2" });
  await route.handler(req2, res2);
  const retried = JSON.parse(res2.body);
  assert.equal(retried.code, 200, res2.body);
  assert.deepEqual(retried.data.created.map((row) => row.key), ["a", "b", "c"], "重试后应补齐并保留已建项");
  assert.equal(created.length, 3, "重试不得重复创建 A");

  // 锁：确认后再提交 → 新提案（新 id、v1），旧提案不升版本
  const second = await propose.execute({ leadSessionId: lead.id, items: [{ key: "d", title: "D" }] }, { agent: { id: lead.id } });
  assert.notEqual(second.proposalId, submitted.proposalId, "已锁定后必须开新提案");
  assert.equal(second.version, 1);

  // 新提案提交后，旧提案的记录被替换：旧确认入口一律失效（notFound 也是失效的一种）
  let [req3, res3] = post({ leadSessionId: lead.id, version: 2, requestId: "k3" });
  await route.handler(req3, res3);
  const staleBody = JSON.parse(res3.body);
  assert.ok(staleBody.code === 40401 || staleBody.code === 40904, "旧提案确认必须被拒，实际 " + staleBody.code);
});
// ── M1：通用 store 层 + 项目注册表 ────────────────────────────────────────────
function m1Harness(host, fs, os, pathMod) {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aw-m1-"));
  host.setProjectStorePathForTests(pathMod.join(dir, "projects.json"));
  host.setProposalStorePathForTests(pathMod.join(dir, "proposals.json"));
  host.setHandoffsStorePathForTests(pathMod.join(dir, "handoffs.json"));
  const routes = [];
  const tools = {};
  const live = new Set(["session-a", "session-b", "session-x", "session-y", "session-hang", "session-ok"]);
  const archived = new Set(["session-old"]);
  const followups = [];
  host.apply({
    get: (name) => {
      if (name === "webServer") return { register: (route) => { routes.push(route); return () => {}; } };
      if (name === "sessions") return { get: (id) => (live.has(id) ? { id } : undefined) };
      if (name === "agents") return {
        get: (id) => (live.has(id) ? {
          id,
          status: "running",
          session: { events: [] },
          followup: (message) => {
            followups.push({ id: id, text: message && message.content && message.content[0] ? message.content[0].text : "", source: message && message.source });
            if (id === "session-hang") return new Promise(() => {});
            if (id === "session-b") throw new Error("timed out while dispatching");
          },
          steer: (message) => {
            followups.push({ id: id, text: message && message.content && message.content[0] ? message.content[0].text : "", source: message && message.source, steer: true });
          }
        } : undefined),
        list: () => []
      };
      if (name === "sessionPersistence") return { stat: (id) => (archived.has(id) ? { id } : undefined) };
      if (name === "agentTeams") return {
        tryMembership: (agent) => ({ root: agent, id: "team-1", role: "lead", name: "lead" }),
        listTasks: () => [],
        listMembers: () => [{ id: "session-a", name: "lead", role: "lead", status: "running", diagnostics: [] }]
      };
      if (name === "tools") return { register: (tool) => { tools[tool.name] = tool; return () => {}; } };
      return undefined;
    },
    on: () => () => {},
    effect: (run) => { run(); return () => {}; }
  });
  const route = routes.find((item) => item && typeof item.handler === "function");
  function fakeReq(method, url, headers, body) {
    const listeners = {};
    const req = { method, url, headers: headers || {}, on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return req; } };
    setTimeout(() => {
      if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
      (listeners.end || []).forEach((fn) => fn());
    }, 0);
    return req;
  }
  function fakeRes() {
    return { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(chunk) { if (chunk !== undefined) this.body += String(chunk); } };
  }
  async function call(method, url, headers, body) {
    const res = fakeRes();
    await route.handler(fakeReq(method, url, headers, body), res);
    let json;
    try { json = JSON.parse(res.body); } catch { json = undefined; }
    return { status: res.statusCode, body: json };
  }
  let token;
  return { dir, tools, call, followups, async raw(method, url, headers, body) {
    const res = fakeRes();
    await route.handler(fakeReq(method, url, headers, body), res);
    return { status: res.statusCode, text: res.body };
  }, async token() {
    if (token === undefined) {
      const res = await call("GET", "/agent-whales/api/activity");
      token = res.body.controlToken;
    }
    return token;
  } };
}

test("M1 项目注册表：创建/加入/关联/移除，40701/40702/40401 与归档会话", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));

  // 1) 创建项目（主对话 = session-a）
  const created = await post("/agent-whales/api/projects", { name: "鲸鱼上线", mainSessionId: "session-a" });
  assert.equal(created.body.code, 200, JSON.stringify(created.body));
  const projectId = created.body.data.project.projectId;
  assert.equal(created.body.data.project.members.length, 1);

  // 2) 主对话已在别的项目 → 40701
  const dup = await post("/agent-whales/api/projects", { name: "第二个", mainSessionId: "session-a" });
  assert.equal(dup.body.code, 40701);

  // 3) 加入不存在的会话 → 40401
  const missing = await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-ghost" });
  assert.equal(missing.body.code, 40401);

  // 4) 加入已有会话 → 成功，且自动与主对话建关联
  const joined = await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
  assert.equal(joined.body.code, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body.data.project.links.map((l) => [l.a, l.b]), [["session-a", "session-b"]]);

  // 5) 加入归档会话（live 之外，persistence.stat 命中）→ 成功
  const archivedJoin = await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-old" });
  assert.equal(archivedJoin.body.code, 200, JSON.stringify(archivedJoin.body));

  // 6) 关联线：a===b 拒绝；非成员拒绝；重复创建幂等
  const selfLink = await post(`/agent-whales/api/projects/${projectId}/links`, { a: "session-a", b: "session-a" });
  assert.equal(selfLink.body.code, 40000);
  const outsiderLink = await post(`/agent-whales/api/projects/${projectId}/links`, { a: "session-a", b: "session-ghost" });
  assert.equal(outsiderLink.body.code, 40000);
  const before = (await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project.links.length;
  const again = await post(`/agent-whales/api/projects/${projectId}/links`, { a: "session-b", b: "session-a" });
  assert.equal(again.body.code, 200);
  assert.equal(again.body.data.already, true);
  assert.equal((await h.call("GET", `/agent-whales/api/projects/${projectId}`)).body.data.project.links.length, before, "重复创建不得增加");

  // 7) 移除成员：主对话 → 40702；普通成员 → 连带删除它的关联线
  const removeMain = await h.call("DELETE", `/agent-whales/api/projects/${projectId}/members/session-a`, { "x-whales-token": tk }, undefined);
  assert.equal(removeMain.body.code, 40702);
  const removeOld = await h.call("DELETE", `/agent-whales/api/projects/${projectId}/members/session-old`, { "x-whales-token": tk }, undefined);
  assert.equal(removeOld.body.code, 200);
  assert.equal(removeOld.body.data.project.members.some((m) => m.sessionId === "session-old"), false);
  assert.equal(removeOld.body.data.project.links.some((l) => l.a === "session-old" || l.b === "session-old"), false, "关联线必须连带删除");

  // 8) 并发创建两个项目：串行化后都保留（不丢更新）
  const [p1, p2] = await Promise.all([
    post("/agent-whales/api/projects", { name: "并发一", mainSessionId: "session-a" }),
    post("/agent-whales/api/projects", { name: "并发二", mainSessionId: "session-b" })
  ]);
  // session-a 已属于原项目 → 40701；session-b 也已是成员 → 40701；两者都应被拒而不是丢数据
  assert.ok([p1.body.code, p2.body.code].every((code) => code === 40701), "已占用会话必须 40701");
  const listed = await h.call("GET", "/agent-whales/api/projects");
  assert.equal(listed.body.data.projects.length, 1);
});

test("M1 store：损坏文件备份 + 只读降级 + 不覆盖原文件 + 并发写串行", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const projectsFile = pathMod.join(h.dir, "projects.json");
  const proposalsFile = pathMod.join(h.dir, "proposals.json");

  // 1) 项目 store 损坏
  fs.writeFileSync(projectsFile, "{ this is not json", "utf8");
  const brokenRead = await h.call("GET", "/agent-whales/api/projects");
  assert.equal(brokenRead.status, 200, "只读降级后读仍可用");
  assert.deepEqual(brokenRead.body.data.projects, []);
  const backups = fs.readdirSync(h.dir).filter((name) => name.includes("projects.json.corrupt-"));
  assert.equal(backups.length, 1, "损坏文件必须被备份一次，实际 " + fs.readdirSync(h.dir).join(","));
  const backupText = fs.readFileSync(pathMod.join(h.dir, backups[0]), "utf8");
  assert.equal(backupText, "{ this is not json", "备份必须是原始内容");

  const blocked = await h.call("POST", "/agent-whales/api/projects", { "x-whales-token": tk }, JSON.stringify({ name: "x", mainSessionId: "session-a" }));
  assert.equal(blocked.status, 503, "只读降级下写入必须是 503");
  assert.equal(blocked.body.code, 50302);
  assert.equal(fs.existsSync(projectsFile), false, "降级后不得重建/覆盖原文件");
  assert.equal(fs.existsSync(pathMod.join(h.dir, "projects.json")), false);

  // 2) 提案 store 同样处理：工具写入失败，但原文件不被覆盖
  fs.writeFileSync(proposalsFile, "not-json-at-all", "utf8");
  const propose = h.tools.whales_propose_tasks;
  assert.ok(propose, "提案工具必须注册");
  let threw = false;
  try {
    await propose.execute({ leadSessionId: "session-a", items: [{ key: "a", title: "A" }] }, { agent: { id: "session-a" } });
  } catch (error) {
    threw = true;
  }
  assert.equal(threw, true, "只读降级下提案写入必须失败，而不是静默覆盖");
  assert.equal(fs.existsSync(proposalsFile), false, "损坏的提案文件不得被覆盖");
  assert.equal(fs.readdirSync(h.dir).filter((name) => name.includes("proposals.json.corrupt-")).length, 1);

  // 3) 新目录下并发写入：两个项目都要保留（读-改-写也串行）
  const dir2 = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aw-m1b-"));
  host.setProjectStorePathForTests(pathMod.join(dir2, "projects.json"));
  const [x, y] = await Promise.all([
    h.call("POST", "/agent-whales/api/projects", { "x-whales-token": tk }, JSON.stringify({ name: "并发A", mainSessionId: "session-a" })),
    h.call("POST", "/agent-whales/api/projects", { "x-whales-token": tk }, JSON.stringify({ name: "并发B", mainSessionId: "session-b" }))
  ]);
  assert.equal(x.body.code, 200, JSON.stringify(x.body));
  assert.equal(y.body.code, 200, JSON.stringify(y.body));
  const stored = JSON.parse(fs.readFileSync(pathMod.join(dir2, "projects.json"), "utf8"));
  assert.equal(Object.keys(stored.projects).length, 2, "并发创建不得丢更新");
});test("M2 项目任务来源语义：projectId 只返回项目表、leadSessionId 只返回宿主板", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));

  const created = await post("/agent-whales/api/projects", { name: "上线", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });

  // 提案绑定项目 → 确认写入项目任务表
  const proposed = await h.tools.whales_propose_tasks.execute({
    leadSessionId: "session-a",
    projectId: projectId,
    items: [
      { key: "T1", title: "体检宿主" },
      { key: "T2", title: "体检浏览器", blockedByKeys: ["T1"] },
      { key: "T3", title: "打包", blockedByKeys: ["T2"] }
    ]
  }, { agent: { id: "session-a" } });
  const confirm = await post(`/agent-whales/api/proposals/${proposed.proposalId}/confirm`, { leadSessionId: "session-a", version: proposed.version, requestId: "m2c1" });
  assert.equal(confirm.body.code, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.data.source, "project");
  assert.deepEqual(confirm.body.data.created.map((row) => row.key), ["T1", "T2", "T3"]);

  const byProject = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
  assert.equal(byProject.body.code, 200);
  assert.equal(byProject.body.data.source, "project");
  assert.equal(byProject.body.data.tasks.length, 3);
  assert.equal(byProject.body.data.members, undefined, "项目查询不得混入宿主成员数据");
  const t2 = byProject.body.data.tasks.find((task) => task.subject === "体检浏览器");
  const t1 = byProject.body.data.tasks.find((task) => task.subject === "体检宿主");
  assert.deepEqual(t2.blockedBy, [t1.taskId], "blockedBy 必须指向项目内的真实 taskId");
  assert.equal(t2.ready, false);
  assert.equal(t1.ready, true);

  const byLead = await h.call("GET", "/agent-whales/api/tasks?leadSessionId=session-a");
  assert.equal(byLead.body.data.source, "host", "leadSessionId 只返回宿主板");
  assert.deepEqual(byLead.body.data.tasks, [], "宿主板里没有项目任务");
  assert.ok(Array.isArray(byLead.body.data.members), "宿主语义保留 members");

  const both = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}&leadSessionId=session-a`);
  assert.equal(both.body.code, 40000, "两个参数同时出现必须拒绝");

  // 锁定：确认后再提交 → 新提案
  const second = await h.tools.whales_propose_tasks.execute({ leadSessionId: "session-a", projectId: projectId, items: [{ key: "X", title: "新增项" }] }, { agent: { id: "session-a" } });
  assert.notEqual(second.proposalId, proposed.proposalId, "已确认后必须开新提案");
});

test("M2 项目任务：owner 非成员 40703、跨项目依赖 40704、成环检测、前置已删除", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "P", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
  const proposed = await h.tools.whales_propose_tasks.execute({ leadSessionId: "session-a", projectId: projectId, items: [{ key: "T1", title: "任务一" }] }, { agent: { id: "session-a" } });
  const confirm = await post(`/agent-whales/api/proposals/${proposed.proposalId}/confirm`, { leadSessionId: "session-a", version: 1, requestId: "o1" });
  const taskId = confirm.body.data.created[0].taskId;

  // owner 不是项目成员 → 40703
  const bad = await post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-ghost", expectedRevision: 1, requestId: "a1" });
  assert.equal(bad.body.code, 40703, JSON.stringify(bad.body));

  // 跨项目依赖 → 40704（用导出函数直接构造：其他项目的 task）
  const store = host.ensureProjectTasks({});
  store["ptask-other"] = { taskId: "ptask-other", projectId: "proj-other", blockedBy: [], status: "pending", revision: 1, subject: "外部" };
  const cross = host.createProjectTaskInStore({ tasks: store }, { projectId: "proj-1" }, { subject: "X", blockedBy: ["ptask-other"] });
  assert.equal(cross.code, 40704, "跨项目依赖必须拒绝");

  // 成环检测（改依赖时使用）：a←b、b←a
  const cyclic = {
    "t-a": { taskId: "t-a", blockedBy: ["t-b"] },
    "t-b": { taskId: "t-b", blockedBy: ["t-a"] }
  };
  assert.equal(host.projectBlockedByWouldCycle(cyclic, "t-a", ["t-b"]), true, "成环必须被识别");
  assert.equal(host.projectBlockedByWouldCycle(cyclic, "t-c", ["t-a"]), false, "无环必须放行");

  // 前置已删除：依赖视图标「前置已删除」，且不算 ready
  const deletedStore = {
    "t-done": { taskId: "t-done", projectId: "p", status: "deleted", blockedBy: [] },
    "t-wait": { taskId: "t-wait", projectId: "p", status: "pending", blockedBy: ["t-done"], revision: 1 }
  };
  const view = host.projectTaskView({ tasks: deletedStore }, deletedStore["t-wait"]);
  assert.equal(view.blockedReason, "前置已删除");
  assert.equal(view.ready, false);

  // unknown：派发时 owner 侧超时 → status=unknown（不是失败）
  const assignmentB = await post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "a2" });
  assert.equal(assignmentB.body.code, 200, JSON.stringify(assignmentB.body));
  const dispatch = await post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "dispatch", requestId: "a3" });
  assert.equal(dispatch.body.code, 200, JSON.stringify(dispatch.body));
  assert.equal(dispatch.body.data.dispatch.status, "unknown", "超时必须标 unknown");
});

test("M2 项目任务：部分成功后重试只补缺失项（retry）", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "R", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  const projectsFile = pathMod.join(h.dir, "projects.json");
  const proposalsFile = pathMod.join(h.dir, "proposals.json");

  // 造一个"部分成功"的现场：T1 已建，T2 待补
  const store = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
  store.tasks = store.tasks || {};
  store.tasks["ptask-done1"] = { taskId: "ptask-done1", projectId: projectId, subject: "T1", description: "", blockedBy: [], writeScopes: [], status: "pending", ownerSessionId: null, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
  fs.writeFileSync(projectsFile, JSON.stringify(store), "utf8");
  const record = {
    proposalId: "prop-retry",
    version: 1,
    leadSessionId: "session-a",
    projectId: projectId,
    items: [{ key: "T1", title: "T1", description: "", blockedByKeys: [] }, { key: "T2", title: "T2", description: "", blockedByKeys: ["T1"] }],
    order: ["T1", "T2"],
    createdAt: Date.now(),
    confirmed: { version: 1, created: [{ key: "T1", taskId: "ptask-done1", revision: 1 }], failed: [{ key: "T2", status: "failed", message: "boom" }], lockedAt: Date.now() }
  };
  fs.writeFileSync(proposalsFile, JSON.stringify({ "session-a": record }), "utf8");

  const retried = await post("/agent-whales/api/proposals/prop-retry/confirm", { leadSessionId: "session-a", version: 1, requestId: "retry-1" });
  assert.equal(retried.body.code, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.data.retried, true);
  assert.deepEqual(retried.body.data.created.map((row) => row.key), ["T1", "T2"], "重试必须保留已建项并补齐缺失项");
  assert.equal(retried.body.data.failed, undefined, "补齐后不应再有 failed");
  const after = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
  const t2 = after.body.data.tasks.find((task) => task.subject === "T2");
  assert.deepEqual(t2.blockedBy, ["ptask-done1"], "补建项必须引用已建前置的真实 id");
});
test("P1 提案身份：冒充 leadSessionId 被拒、非主对话带 projectId 被拒、主对话正常提交", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "身份", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
  const propose = h.tools.whales_propose_tasks;

  // 1) 冒充：exec=session-b，参数声明 session-a
  await assert.rejects(
    () => propose.execute({ leadSessionId: "session-a", projectId: projectId, items: [{ key: "X", title: "X" }] }, { agent: { id: "session-b" } }),
    /40301/,
    "参数自报的 leadSessionId 与执行上下文不一致必须拒绝"
  );

  // 2) 非主对话带 projectId：exec=session-b（是成员，不是主对话）
  await assert.rejects(
    () => propose.execute({ projectId: projectId, items: [{ key: "X", title: "X" }] }, { agent: { id: "session-b" } }),
    /40706/,
    "member 不能提交提案"
  );

  // 3) 主对话正常提交（exec=session-a）
  const submitted = await propose.execute({ projectId: projectId, items: [{ key: "T1", title: "正常" }] }, { agent: { id: "session-a" } });
  assert.ok(typeof submitted.proposalId === "string" && submitted.proposalId.startsWith("prop-"));

  // 4) 拿不到身份 → 拒绝
  await assert.rejects(
    () => propose.execute({ items: [{ key: "X", title: "X" }] }, {}),
    /40301/,
    "没有执行上下文身份时必须拒绝"
  );
});
test("M3 简报：项目简报 CAS、对话简报仅本人写、跨读要关联线", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const put = (url, body) => h.call("PUT", url, { "x-whales-token": tk }, JSON.stringify(body));

  const created = await post("/agent-whales/api/projects", { name: "简报", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;

  // 1) 项目简报：默认 v1；CAS 成功 +1；陈旧版本 → 40902
  const initial = await h.call("GET", `/agent-whales/api/projects/${projectId}/brief`);
  assert.equal(initial.body.data.brief.version, 1);
  const updated = await put(`/agent-whales/api/projects/${projectId}/brief`, { expectedVersion: 1, goal: "上线体检", decisions: ["先体检"] });
  assert.equal(updated.body.code, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.brief.version, 2);
  const stale = await put(`/agent-whales/api/projects/${projectId}/brief`, { expectedVersion: 1, goal: "旧版本" });
  assert.equal(stale.body.code, 40902, "陈旧版本必须 40902");

  // 2) 人代写对话简报：updatedBy=user 且标 proxy
  const proxyWrite = await put("/agent-whales/api/briefs/session-b", { duty: "负责浏览器半边", conclusions: ["已验证"] });
  assert.equal(proxyWrite.body.code, 200, JSON.stringify(proxyWrite.body));
  assert.equal(proxyWrite.body.data.brief.updatedBy, "user");
  assert.equal(proxyWrite.body.data.brief.proxy, true, "人代写必须标记 proxy");
  assert.equal(proxyWrite.body.data.brief.version, 1);

  // 3) 对话工具：只能写自己；项目简报只有主对话能写
  const briefWrite = h.tools.whales_brief_write;
  await assert.rejects(
    () => briefWrite.execute({ projectId, goal: "member 写项目简报" }, { agent: { id: "session-b" } }),
    /40706/,
    "member 不能写项目简报"
  );
  const own = await briefWrite.execute({ duty: "会话 b 自己的职责" }, { agent: { id: "session-b" } });
  assert.equal(own.brief.version, 2, "本轮写入应在上一次代写之后 +1");
  assert.equal(own.brief.updatedBy, "session-b");

  // 4) HTTP 读取：调用方是人（单用户），本来就能读所有简报；previewAs 只做展示，不是鉴权
  const httpRead = await h.call("GET", "/agent-whales/api/briefs/session-a");
  assert.equal(httpRead.body.code, 200, JSON.stringify(httpRead.body));
  const preview = await h.call("GET", "/agent-whales/api/briefs/session-a?previewAs=session-b");
  assert.equal(preview.body.code, 200);
  assert.equal(preview.body.data.previewAs, "session-b", "previewAs 只回展示字段");

  // 5) 跨读权限只在工具侧（exec 身份）：非成员 → 40703；加入建线后可读；删线后 40707
  const briefRead = h.tools.whales_brief_read;
  await assert.rejects(
    () => briefRead.execute({ sessionId: "session-a" }, { agent: { id: "session-b" } }),
    /40703/,
    "非项目成员不能跨读"
  );
  const joined = await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
  assert.equal(joined.body.code, 200, JSON.stringify(joined.body));
  const allowed = await briefRead.execute({ sessionId: "session-a" }, { agent: { id: "session-b" } });
  assert.equal(allowed.brief.sessionId, "session-a");
  const removed = await h.call("DELETE", `/agent-whales/api/projects/${projectId}/links`, { "x-whales-token": tk }, JSON.stringify({ a: "session-a", b: "session-b" }));
  assert.equal(removed.body.code, 200, JSON.stringify(removed.body));
  await assert.rejects(
    () => briefRead.execute({ sessionId: "session-a" }, { agent: { id: "session-b" } }),
    /40707/,
    "同项目但无关联线不能跨读"
  );

  // 6) 工具读自己永远放行
  const selfRead = await briefRead.execute({ sessionId: "session-b" }, { agent: { id: "session-b" } });
  assert.equal(selfRead.target, "conversation");
  assert.equal(selfRead.brief.sessionId, "session-b");
});

test("P2 提案 schema：leadSessionId 可选（身份以执行上下文为准）", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tool = h.tools.whales_propose_tasks;
  assert.ok(tool, "提案工具必须注册");
  assert.deepEqual(tool.parameters.required, ["items"], "leadSessionId 必须改成可选");
  assert.equal(tool.parameters.properties.leadSessionId !== undefined, true, "字段仍保留（可选）");
  assert.match(tool.parameters.properties.leadSessionId.description, /可省略/, "description 必须写明可省略");
  assert.match(tool.parameters.properties.leadSessionId.description, /必须等于当前会话/, "description 必须写明填了要一致");
});


test("M3 P1 并发：同 expectedVersion 两个 PUT 只能一个成功；跨实体并发不丢更新", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const put = (url, body) => h.call("PUT", url, { "x-whales-token": tk }, JSON.stringify(body));

  const created = await post("/agent-whales/api/projects", { name: "并发", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;

  // ① 同一个 expectedVersion 并发两次 PUT：只能一个成功，另一个 40902
  const [first, second] = await Promise.all([
    put(`/agent-whales/api/projects/${projectId}/brief`, { expectedVersion: 1, goal: "A" }),
    put(`/agent-whales/api/projects/${projectId}/brief`, { expectedVersion: 1, goal: "B" })
  ]);
  const codes = [first.body.code, second.body.code].sort();
  assert.deepEqual(codes, [200, 40902], "CAS 必须只有一个成功，实际 " + JSON.stringify(codes));
  const afterCas = await h.call("GET", `/agent-whales/api/projects/${projectId}/brief`);
  assert.equal(afterCas.body.data.brief.version, 2, "只应成功一次 → v2");

  // ② 并发「加成员 + 写简报」：两处修改都要保留
  const [, briefWrite] = await Promise.all([
    post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" }),
    put(`/agent-whales/api/projects/${projectId}/brief`, { expectedVersion: 2, goal: "并发简报" })
  ]);
  assert.equal(briefWrite.body.code, 200, JSON.stringify(briefWrite.body));
  const afterBoth = await h.call("GET", `/agent-whales/api/projects/${projectId}`);
  assert.equal(afterBoth.body.data.project.members.some((m) => m.sessionId === "session-b"), true, "成员修改不得被覆盖");
  assert.equal(afterBoth.body.data.project.brief.goal, "并发简报", "简报修改不得被覆盖");

  // ③ 并发「建关联 + 改任务」：两处修改都要保留
  const proposed = await h.tools.whales_propose_tasks.execute({ projectId, items: [{ key: "T1", title: "并发任务" }] }, { agent: { id: "session-a" } });
  const confirmed = await post(`/agent-whales/api/proposals/${proposed.proposalId}/confirm`, { leadSessionId: "session-a", version: 1, requestId: "cc1" });
  const taskId = confirmed.body.data.created[0].taskId;
  await h.call("DELETE", `/agent-whales/api/projects/${projectId}/links`, { "x-whales-token": tk }, JSON.stringify({ a: "session-a", b: "session-b" }));
  const [linkWrite, assignWrite] = await Promise.all([
    post(`/agent-whales/api/projects/${projectId}/links`, { a: "session-a", b: "session-b" }),
    post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-b", expectedRevision: 1, requestId: "cc2" })
  ]);
  assert.equal(linkWrite.body.code, 200, JSON.stringify(linkWrite.body));
  assert.equal(assignWrite.body.code, 200, JSON.stringify(assignWrite.body));
  const afterTask = await h.call("GET", `/agent-whales/api/tasks?projectId=${projectId}`);
  const taskAfter = afterTask.body.data.tasks.find((task) => task.taskId === taskId);
  assert.equal(taskAfter.ownerSessionId, "session-b", "任务改派不得被覆盖");
  const projectAfter = await h.call("GET", `/agent-whales/api/projects/${projectId}`);
  assert.equal(projectAfter.body.data.project.links.some((link) => (link.a === "session-a" && link.b === "session-b") || (link.a === "session-b" && link.b === "session-a")), true, "关联线不得被覆盖");
});

test("M4 访问闸：对话侧入口都走校验；HTTP 与派发按人处理并如实标 user；双方不在项目里保持旧行为", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "闸", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
  await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-ok" });

  // 1) 对话侧入口：visit_send —— 项目内 → 项目外，拒绝 40703
  await assert.rejects(
    () => h.tools.whales_visit_send.execute({ sessionId: "session-x", message: "hi" }, { agent: { id: "session-a" } }),
    /40703/,
    "visit_send：一方在项目里就必须同项目"
  );
  // 2) 对话侧入口：同项目、成员、但无关联线 → 40707
  await assert.rejects(
    () => h.tools.whales_visit_send.execute({ sessionId: "session-ok", message: "hi" }, { agent: { id: "session-b" } }),
    /40707/,
    "visit_send：同项目成员无关联线必须拒绝"
  );
  // 3) 对话侧入口：visit_read 与 send 同权
  await assert.rejects(
    () => h.tools.whales_visit_read.execute({ sessionId: "session-x" }, { agent: { id: "session-a" } }),
    /40703/,
    "visit_read：与 send 同权"
  );
  // 4) P2：拿不到执行上下文身份 → 40301（不再静默跳过闸）
  await assert.rejects(
    () => h.tools.whales_visit_send.execute({ sessionId: "session-y", message: "hi" }, {}),
    /40301/,
    "对话侧入口必须有执行上下文身份"
  );

  // 5) HTTP /api/send：调用方是人 → 不过闸、200、来源标 user（带任何参数都不改变这一点）
  const beforeHttp = h.followups.length;
  const apiSend = await h.raw("POST", "/agent-whales/api/send", { "x-whales-token": tk }, JSON.stringify({ sessionId: "session-x", text: "hi", fromSessionId: "session-a", viaCard: "session-a" }));
  assert.equal(apiSend.status, 200, "HTTP 发送按人处理，必须放行");
  assert.equal(h.followups.length, beforeHttp + 1);
  assert.equal(h.followups[h.followups.length - 1].source.kind, "user", "HTTP 发送必须如实标 user");
  const handoffsFile = pathMod.join(h.dir, "handoffs.json");
  const ledgerAfterHttp = JSON.parse(fs.readFileSync(handoffsFile, "utf8")).entries;
  const httpEntry = ledgerAfterHttp[ledgerAfterHttp.length - 1];
  assert.equal(httpEntry.from, "user", "账本 from 必须是 user");
  assert.equal(httpEntry.kind, "visit");

  // 6) 派发：人发起 → 不过闸、来源标 user、消息带任务引用（taskId/revision/projectId）
  const proposed = await h.tools.whales_propose_tasks.execute({ projectId, items: [{ key: "T1", title: "闸任务" }] }, { agent: { id: "session-a" } });
  const confirmed = await post(`/agent-whales/api/proposals/${proposed.proposalId}/confirm`, { leadSessionId: "session-a", version: 1, requestId: "g1" });
  const taskId = confirmed.body.data.created[0].taskId;
  const assigned = await post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-ok", expectedRevision: 1, requestId: "g2" });
  assert.equal(assigned.body.code, 200, JSON.stringify(assigned.body));
  await h.call("DELETE", `/agent-whales/api/projects/${projectId}/links`, { "x-whales-token": tk }, JSON.stringify({ a: "session-a", b: "session-ok" }));
  const dispatched = await post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "dispatch", requestId: "g3" });
  assert.equal(dispatched.body.code, 200, JSON.stringify(dispatched.body));
  assert.equal(dispatched.body.data.dispatch.status, "sent", "UI 派发不受关联线影响，必须照常发出");
  const dispatchMsg = h.followups[h.followups.length - 1];
  assert.equal(dispatchMsg.source.kind, "user", "派发来源必须如实标 user");
  assert.match(dispatchMsg.text, new RegExp(taskId), "派发消息必须带 taskId");
  assert.match(dispatchMsg.text, /revision \d+/, "派发消息必须带 revision");
  assert.match(dispatchMsg.text, new RegExp(projectId), "派发消息必须带 projectId");
  const ledgerAfterDispatch = JSON.parse(fs.readFileSync(handoffsFile, "utf8")).entries;
  const dispatchEntry = ledgerAfterDispatch[ledgerAfterDispatch.length - 1];
  assert.equal(dispatchEntry.kind, "dispatch");
  assert.equal(dispatchEntry.from, "user");
  assert.equal(dispatchEntry.taskId, taskId);

  // 7) 旧行为：双方都不在任何项目里 → 照常发送、来源真实（dialogue 侧）
  const before = h.followups.length;
  const legacy = await h.tools.whales_visit_send.execute({ sessionId: "session-y", message: "旧串门" }, { agent: { id: "session-x" } });
  assert.equal(legacy.accepted, true, "非项目会话之间的串门必须保持旧行为");
  assert.equal(h.followups.length, before + 1, "旧串门必须真的投递");
  assert.equal(h.followups[h.followups.length - 1].source.kind, "agent-message");
  assert.equal(h.followups[h.followups.length - 1].source.senderSessionId, "session-x", "对话发送必须带真实来源");
});
test("M4 P2 锁粒度：dispatch 挂起期间简报写入不被阻塞", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const put = (url, body) => h.call("PUT", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "锁粒度", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-hang" });
  const proposed = await h.tools.whales_propose_tasks.execute({ projectId, items: [{ key: "T1", title: "挂起任务" }] }, { agent: { id: "session-a" } });
  const confirmed = await post(`/agent-whales/api/proposals/${proposed.proposalId}/confirm`, { leadSessionId: "session-a", version: 1, requestId: "h1" });
  const taskId = confirmed.body.data.created[0].taskId;
  await post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "assign", owner: "session-hang", expectedRevision: 1, requestId: "h2" });

  const startedAt = Date.now();
  const dispatchPromise = post(`/agent-whales/api/tasks/${taskId}/commands`, { projectId, action: "dispatch", requestId: "h3", dispatchTimeoutMs: 300 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const briefWrite = await put(`/agent-whales/api/projects/${projectId}/brief`, { expectedVersion: 1, goal: "挂起期间写入" });
  const briefMs = Date.now() - startedAt;
  assert.equal(briefWrite.body.code, 200, JSON.stringify(briefWrite.body));
  assert.ok(briefMs < 250, "简报写入不得等待派发超时，实际 " + briefMs + "ms");
  const dispatched = await dispatchPromise;
  assert.equal(dispatched.body.code, 200, JSON.stringify(dispatched.body));
  assert.equal(dispatched.body.data.dispatch.status, "unknown", "挂起应超时标 unknown");
});

test("M4 P2：store 损坏后仍按最后一次成功快照判定项目边界", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "降级", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  // 先成功读一次，进入 last-good 快照
  await h.call("GET", `/agent-whales/api/projects/${projectId}`);
  // 把 projects.json 写坏
  fs.writeFileSync(pathMod.join(h.dir, "projects.json"), "not-json", "utf8");
  // 降级期间：对话侧闸仍按快照判定（项目内 → 项目外 仍然 40703）
  await assert.rejects(
    () => h.tools.whales_visit_send.execute({ sessionId: "session-x", message: "hi" }, { agent: { id: "session-a" } }),
    /40703/,
    "降级期间不能把项目边界全放开"
  );
  // 写操作仍是 503（不覆盖损坏文件）
  const write = await post("/agent-whales/api/projects", { name: "另一个", mainSessionId: "session-y" });
  assert.equal(write.status, 503, "降级期间写操作必须 503");
});

test("M5 简报按需读取：无参返回项目简报+自己的简报；项目外明确回落；超限截断", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "简报M5", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  await post(`/agent-whales/api/projects/${projectId}/members`, { sessionId: "session-b" });
  // 写项目简报 + 自己的对话简报
  await h.call("PUT", `/agent-whales/api/projects/${projectId}/brief`, { "x-whales-token": tk }, JSON.stringify({ expectedVersion: 1, goal: "上线前体检", decisions: ["先体检"], constraints: ["不碰 main"] }));
  await h.call("PUT", "/agent-whales/api/briefs/session-b", { "x-whales-token": tk }, JSON.stringify({ duty: "负责浏览器半边", conclusions: ["已验证"] }));

  const read = h.tools.whales_brief_read;
  const noArg = await read.execute({}, { agent: { id: "session-b" } });
  assert.equal(noArg.joinedProject, true);
  assert.equal(noArg.brief.version, 2, "项目简报带 version");
  assert.equal(typeof noArg.brief.updatedAt, "number", "项目简报带 updatedAt");
  assert.equal(noArg.brief.goal, "上线前体检");
  assert.equal(noArg.conversationBrief.sessionId, "session-b", "同时返回自己的对话简报");
  assert.equal(noArg.conversationBrief.duty, "负责浏览器半边");

  // 项目外会话：明确回落，不报错
  const outsider = await read.execute({}, { agent: { id: "session-x" } });
  assert.equal(outsider.joinedProject, false);
  assert.match(outsider.message, /未加入项目/);

  // 超限截断：写一份超过 2000 token 的 goal
  const longGoal = "测".repeat(2600);
  const longWrite = await h.call("PUT", `/agent-whales/api/projects/${projectId}/brief`, { "x-whales-token": tk }, JSON.stringify({ expectedVersion: 2, goal: longGoal }));
  assert.equal(longWrite.body.code, 200, "长简报写入必须成功：" + JSON.stringify(longWrite.body));
  const truncated = await read.execute({}, { agent: { id: "session-b" } });
  assert.ok(truncated.brief.goal.endsWith("[简报已截断]"), "超限必须标注截断：" + JSON.stringify({ len: truncated.brief.goal.length, tail: truncated.brief.goal.slice(-20), ver: truncated.brief.version }));
  assert.ok(truncated.brief.goal.length < longGoal.length, "必须真的截短");
});

test("M5 P2 简报总预算：12 条长决策共用 2000，超出丢弃并给 omitted", async () => {
  const host = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const h = m1Harness(host, fs, os, pathMod);
  const tk = await h.token();
  const post = (url, body) => h.call("POST", url, { "x-whales-token": tk }, JSON.stringify(body));
  const put = (url, body) => h.call("PUT", url, { "x-whales-token": tk }, JSON.stringify(body));
  const created = await post("/agent-whales/api/projects", { name: "预算", mainSessionId: "session-a" });
  const projectId = created.body.data.project.projectId;
  const decisions = [];
  for (let index = 0; index < 12; index += 1) decisions.push("决策" + index + "：" + "测".repeat(280));
  const write = await put(`/agent-whales/api/projects/${projectId}/brief`, { expectedVersion: 1, goal: "", decisions: decisions, constraints: [] });
  assert.equal(write.body.code, 200, JSON.stringify(write.body));

  const read = await h.tools.whales_brief_read.execute({}, { agent: { id: "session-a" } });
  assert.equal(read.truncated, true, "超预算必须标 truncated");
  assert.ok(read.omitted > 0, "必须给出 omitted 计数，实际 " + read.omitted);

  // 估算整份返回（含标记）：CJK 1 字=1 token，其他 4 字符=1 token
  function estimate(value) {
    let tokens = 0;
    const walk = (item) => {
      if (item === undefined || item === null) return;
      if (typeof item === "string") {
        for (const ch of item) {
          const code = ch.codePointAt(0);
          const cjk = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x3000 && code <= 0x303f);
          tokens += cjk ? 1 : 0.25;
        }
        return;
      }
      if (Array.isArray(item)) { item.forEach(walk); return; }
      if (typeof item === "object") { Object.keys(item).forEach((key) => { if (key !== "omitted") walk(item[key]); }); }
    };
    walk(value);
    // 只统计简报正文（版本号/时间等元数据不计 token 预算），从 brief/conversationBrief 里取
    return tokens;
  }
  const briefText = JSON.stringify({ brief: read.brief, conversationBrief: read.conversationBrief });
  // 上面 JSON 字符串里带引号/逗号等非 CJK 字符，按 4 字符≈1 token 计入，属同一估算规则
  const payload = { s: briefText };
  const total = estimate(briefText);
  assert.ok(total <= 2000 + 60, "总估算必须被 2000 上限约束（允许 JSON 结构字符的少量误差），实际 " + total);
  const combined = [read.brief && read.brief.goal].concat(read.brief && read.brief.constraints, read.brief && read.brief.decisions, read.conversationBrief && read.conversationBrief.duty, read.conversationBrief && read.conversationBrief.conclusions, read.conversationBrief && read.conversationBrief.artifacts).filter((item) => typeof item === "string");
  assert.ok(combined.length > 0, "必须有内容被返回");
});
