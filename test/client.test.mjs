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

  // 素材没内联时退化成经典皮肤；内联之后应该是一串 WebP data URI。
  const hasArt = Object.keys(testApi().ART()).length > 0;
  if (hasArt) {
    const sprites = findByClass(tree, "daw-sprite");
    assert.ok(sprites.length >= 2, "位图模式下每只至少一张 img");
    for (const img of sprites) assert.match(img.props.src, /^data:image\/webp;base64,/);
  } else {
    const arts = findByClass(tree, "daw-art");
    assert.equal(arts.length, 2, "经典皮肤：每只一个 SVG");
    assert.equal(arts[0].props.viewBox, "0 -16 134 100");
    let gradientIds = [];
    walk(arts[0], (node) => {
      if (node.type === "path" && typeof node.props.fill === "string" && node.props.fill.startsWith("url(#")) {
        gradientIds.push(node.props.fill);
      }
    });
    assert.ok(gradientIds.length >= 1, "鲸鱼身体用渐变上色");
  }
});

test("素材表：内联后每个精灵都是 WebP data URI，尺寸在合理区间", (t) => {
  const art = testApi().ART();
  if (Object.keys(art).length === 0) {
    t.skip("素材尚未内联（先跑 tools/build-assets.py，再跑 tools/embed-art.mjs）");
    return;
  }
  for (const [key, value] of Object.entries(art)) {
    assert.match(value.uri, /^data:image\/webp;base64,/, key + " 必须是 WebP data URI");
    assert.ok(value.w > 0 && value.h > 0, key + " 缺少像素尺寸");
    assert.ok(value.h >= 64 && value.h <= 256, key + " 高度应在 64–256 之间，实际 " + value.h);
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

test("皮肤家族：混合模式 Lead 成熟版、成员 Q 版；经典皮肤没有位图", () => {
  const { familyOf, frameOf, ART } = testApi();
  assert.equal(familyOf("mix", true), "mature");
  assert.equal(familyOf("mix", false), "q");
  assert.equal(familyOf("q", true), "q");
  assert.equal(familyOf("mature", false), "mature");
  assert.equal(familyOf("classic", true), "classic");
  assert.equal(frameOf("classic", true, "base"), undefined, "经典皮肤走矢量，不取位图");

  if (Object.keys(ART()).length > 0) {
    assert.equal(frameOf("mix", false, "blink"), "q-blink", "Q 版有同构图的眨眼帧");
    assert.equal(frameOf("mix", true, "base"), "m-base", "成熟版也换成同批的头肩近景");
    assert.equal(frameOf("mix", true, "blink"), "m-blink", "成熟版现在有真正的眨眼帧");
    assert.equal(frameOf("mix", true, "exit"), "m-proud", "成熟版退场用得意帧");
  }
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
  assert.equal(switches.length, 10, "启用 / 粒子 / 对话气泡 / 俏皮话 / 没活也挂着 / 团队汇总 / 显示任务 / 已收工子级 / 可拖拽 / 显示名字");
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
  assert.ok(sections[0].text.includes("spawn_teammate"), "策略里要点名团队工具");
  assert.ok(sections[0].text.includes("默认先起团队"), "默认行为是起团队");
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

  assert.deepEqual(Object.keys(registered).sort(), ["whales_visit_list", "whales_visit_read", "whales_visit_send"]);
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
test("心情帧：每 3 个 tick 换一次表情，收工只走抱膝", () => {
  const { pickMoodKey, ART } = testApi();
  const art = ART();
  if (!art["q-laugh"]) {
    // 素材没接进来时不硬断言（和素材表那条用例同样的降级策略）
    assert.equal(pickMoodKey("q", "running", 0), undefined);
    return;
  }
  assert.equal(pickMoodKey("q", "running", 0), "q-smile");
  assert.equal(pickMoodKey("q", "running", 2), "q-smile", "3 个 tick 内不换");
  assert.equal(pickMoodKey("q", "running", 3), "q-laugh");
  assert.equal(pickMoodKey("q", "running", 6), "q-pout");
  assert.equal(pickMoodKey("q", "running", 9), "q-surprise");
  assert.equal(pickMoodKey("q", "running", 12), "q-smile", "四个一循环");
  assert.equal(pickMoodKey("q", "idle", 3), "q-sleepy", "收工只走抱膝，不放大头特写");
  assert.equal(pickMoodKey("q", "provisioning", 3), "q-sleepy");
  // 成熟版同一套轮换，只是池子不同
  assert.equal(pickMoodKey("mature", "running", 0), "m-base");
  assert.equal(pickMoodKey("mature", "running", 3), "m-laugh");
  assert.equal(pickMoodKey("mature", "running", 6), "m-pout");
  assert.equal(pickMoodKey("mature", "running", 9), "m-surprise");
  assert.equal(pickMoodKey("mature", "idle", 3), "m-base", "成熟版收工固定用基础帧");
});
test("经典皮肤：用 Martty 像素小人的两帧，图片不可用时退回矢量", () => {
  const { plugin } = loadPlugin();
  const { WhaleLayer, settings, artStatus } = plugin.__test;
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
  assert.match(sprites[0].props.src, /^data:image\/webp;base64,/, "而且是内联的 WebP");

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