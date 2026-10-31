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
  let dictionary = null;
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
    locale: { register(namespace, dict) { dictionary = { namespace, dict }; return () => {}; } }
  };

  plugin.apply(ctx);

  assert.deepEqual(injections, ["shell.overlay", "settings.section"]);
  assert.equal(registrations.length, 2);
  for (const entry of registrations) {
    assert.equal(entry.options.id, "agent-whales");
    assert.equal(typeof entry.component, "function");
    assert.equal(typeof entry.options.inject, "function");
    assert.equal(typeof entry.options.inject().leadIdOf, "function");
  }
  assert.equal(appended.length, 1, "样式标签注入一次");
  assert.equal(appended[0].id, "dsh-agent-whales-styles");
  assert.equal(dictionary.namespace, "agent-whales");
  assert.deepEqual(
    Object.keys(dictionary.dict.zh).sort(),
    Object.keys(dictionary.dict.en).sort(),
    "中英文键集合必须一致"
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

  assert.deepEqual(Object.keys(registered).sort(), ["whales_visit_list", "whales_visit_read", "whales_visit_resume", "whales_visit_send"]);
  assert.equal(typeof registered.whales_visit_send.output.render, "function", "工具必须带 output.render");
  // 网关按 OpenAI function calling 校验：parameters 必须是 { type: "object", properties } 的 JSON Schema。
  // 传「属性表」或空对象会让整轮请求 400（真实事故：whales_visit_list 变成 type: null）。
  for (const [name, tool] of Object.entries(registered)) {
    assert.equal(tool.parameters.type, "object", name + " 的 parameters 必须是 object schema");
    assert.equal(typeof tool.parameters.properties, "object", name + " 必须声明 properties");
    assert.equal(tool.output.schema.type, "object", name + " 的 output.schema 必须是 object schema");
  }

  const list = await registered.whales_visit_list.execute({}, {});
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].title, "隔壁的活", "标题取自 session/title 事件");
  assert.equal(list.sessions[0].workspaceId, "w1");

  await registered.whales_visit_send.execute({ sessionId: "s2", message: "来串门" }, {});
  assert.equal(followups.length, 1, "queue 走 followup");
  assert.equal(followups[0].role, "user");
  assert.equal(followups[0].content[0].text, "来串门");

  await registered.whales_visit_send.execute({ sessionId: "s2", message: "打断", mode: "steer" }, {});
  assert.equal(steers.length, 1, "steer 走 steer");

  const read = await registered.whales_visit_read.execute({ sessionId: "s2" }, {});
  assert.deepEqual(read.messages.map((row) => row.role), ["user", "assistant"]);
  assert.equal(read.messages[1].text, "看过了");

  await assert.rejects(() => registered.whales_visit_send.execute({ sessionId: "nope", message: "x" }, {}), /不活着/);
  await assert.rejects(() => registered.whales_visit_send.execute({ sessionId: "s2", message: "  " }, {}), /不能为空/);
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

  const list = await registered.whales_visit_list.execute({}, {});
  assertLossless(list);
  const read = await registered.whales_visit_read.execute({ sessionId: "s3" }, {});
  assertLossless(read);

  // 关键回归：等回复超时时不能把 { text: undefined } 带出来
  const sent = await registered.whales_visit_send.execute(
    { sessionId: "s3", message: "测试", waitForReply: true, timeoutMs: 1 },
    {}
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

test("体积：client.js 不再内联 base64 素材，且控制在 200KB 以内", () => {
  const source = readFileSync(join(pluginDir, "lib", "client.js"), "utf8");
  assert.equal(source.includes("data:image/webp;base64"), false, "bundle 里不得再出现内联 WebP");
  const bytes = Buffer.byteLength(source, "utf8");
  assert.ok(bytes < 200 * 1024, "client.js 必须 ≤200KB（D1 目标），实际 " + Math.round(bytes / 1024) + "KB");
  assert.ok(source.includes("var ART = {};"), "ART 必须保留空表占位，等运行时填充");
});
