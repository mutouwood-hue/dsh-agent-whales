/**
 * 浏览器半边（lib/client.js）的对抗性回归测试。
 *
 * 走 test/harness.mjs 的 React 垫片与 __ModuleLoader__ 信封，和 client.test.mjs
 * 完全同一套加载方式；这里只补「脏数据 / 极端规模 / 重复装配 / 素材完整性」。
 *
 * 历史事故对应关系：
 *   - 脏 localStorage（被手改、NaN、越界、未知枚举）→ normalizeSettings 必须回落
 *   - 拖拽坐标 (0,0) / 99999 / NaN（JSON 化后变 null）→ 一律不得生效
 *   - 0 / 1 / 20 个 agent → 渲染不崩、数量与 planPod 口径一致、React key 唯一
 *   - 热重载重复 apply → 样式只注入一次，disposer 之后还能重新注入
 *   - 改了帧表忘了补图 → 引用集合必须 ⊆ ART，ART 必须与 assets/art.json 键集合一致
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { clientPath, findByClass, installDocumentStub, loadPlugin, pluginDir, render, walk } from "./harness.mjs";
// D1 之后素材不再内联：这组用例用一个假宿主路由把 manifest + webp 喂给 artLoader。
import { testApiWithArt } from "./artkit.mjs";

const artJsonPath = join(pluginDir, "assets", "art.json");

function testApi(options) {
  return loadPlugin(options).plugin.__test;
}

// ── 1. normalizeSettings：脏 localStorage 全部回落 ───────────────────────

test("normalizeSettings：非法 JSON / null / 数组 / 标量 / 未知键都回落到安全默认", () => {
  const payloads = [
    ["非法 JSON", "not-json{"],
    ["null", "null"],
    ["JSON 数组", "[]"],
    ["空对象", "{}"],
    ["未知键 size", '{"size":"abc"}'],
    ["未知键 size 负数", '{"size":-1}'],
    ["未知键 size 超大", '{"size":1000000000}'],
    ["旧 offsets 数组坐标", '{"offsets":{"a":[null,1]}}'],
    ["旧 offsets 零坐标", '{"offsets":{"a":[0,0]}}'],
    ["旧 offsets 离谱坐标", '{"offsets":{"a":[99999,0]}}'],
    ["字符串标量", '"just-a-string"'],
    ["数字标量", "42"],
    ["布尔标量", "true"]
  ];
  for (const [label, payload] of payloads) {
    const { DEFAULTS, settings } = testApi({ stored: payload });
    assert.deepEqual(settings.getSnapshot(), DEFAULTS, label + " 必须回落到默认设置");
  }
});

test("normalizeSettings：越界数值夹到边界，NaN/Infinity/对象走兜底", () => {
  const { normalizeSettings, DEFAULTS } = testApi();
  const clamped = normalizeSettings({
    scale: 9999,
    opacity: -5,
    speed: 0,
    offset: 999,
    position: "nope",
    countMode: "nope",
    skin: "nope",
    motion: "nope"
  });
  assert.equal(clamped.scale, 200);
  assert.equal(clamped.opacity, 20);
  assert.equal(clamped.speed, 25);
  assert.equal(clamped.offset, 120);
  assert.equal(clamped.position, "center");
  assert.equal(clamped.countMode, "members");
  assert.equal(clamped.skin, DEFAULTS.skin);
  assert.equal(clamped.motion, DEFAULTS.motion);

  for (const weird of [NaN, Infinity, -Infinity, "abc", {}, [], true, false]) {
    const snapshot = normalizeSettings({ scale: weird, opacity: weird, speed: weird, offset: weird });
    assert.ok(Number.isInteger(snapshot.scale) && snapshot.scale >= 40 && snapshot.scale <= 200, "scale 越界：" + String(weird));
    assert.ok(Number.isInteger(snapshot.opacity) && snapshot.opacity >= 20 && snapshot.opacity <= 100, "opacity 越界：" + String(weird));
    assert.ok(Number.isInteger(snapshot.speed) && snapshot.speed >= 25 && snapshot.speed <= 250, "speed 越界：" + String(weird));
    assert.ok(Number.isInteger(snapshot.offset) && snapshot.offset >= -60 && snapshot.offset <= 120, "offset 越界：" + String(weird));
  }

  assert.equal(normalizeSettings({ scale: "133" }).scale, 133, "数字字符串按数字解析");
  assert.equal(normalizeSettings({ scale: 40 }).scale, 40, "边界值保留");
  assert.equal(normalizeSettings({ enabled: false }).enabled, false);
  assert.equal(normalizeSettings({ particles: false }).particles, false);
  assert.equal(normalizeSettings({ labels: true }).labels, true);
});

test("normalizeSettings：合法枚举值原样保留，非法枚举回落默认", () => {
  const { normalizeSettings, DEFAULTS } = testApi();
  for (const skin of ["mix", "q", "mature", "classic"]) {
    assert.equal(normalizeSettings({ skin }).skin, skin);
  }
  for (const motion of ["off", "soft", "normal", "lively"]) {
    assert.equal(normalizeSettings({ motion }).motion, motion);
  }
  for (const position of ["left", "center", "right"]) {
    assert.equal(normalizeSettings({ position }).position, position);
  }
  assert.equal(normalizeSettings({ countMode: "teams" }).countMode, "teams");
  assert.equal(normalizeSettings({ skin: "Q" }).skin, DEFAULTS.skin, "枚举大小写不匹配就回落");
  assert.equal(normalizeSettings({ motion: null }).motion, DEFAULTS.motion);
  assert.equal(normalizeSettings({ position: 12 }).position, DEFAULTS.position);
});

test("settings.set：脏补丁被夹紧后写回 localStorage，且内容不变时不通知", () => {
  const loaded = loadPlugin({ stored: '{"scale":-5}' });
  const { settings, DEFAULTS } = loaded.plugin.__test;
  assert.equal(settings.getSnapshot().scale, 40, "载入时越界值就要夹紧");

  let changes = 0;
  const unsubscribe = settings.subscribe(() => { changes += 1; });
  settings.set({ scale: 1e9, skin: "nope", particles: false });
  const snapshot = settings.getSnapshot();
  assert.equal(snapshot.scale, 200);
  assert.equal(snapshot.skin, DEFAULTS.skin);
  assert.equal(snapshot.particles, false);
  assert.equal(changes, 1, "值变了才通知订阅者");

  const persisted = JSON.parse(loaded.win.localStorage.getItem("dsh-agent-whales.settings"));
  assert.deepEqual(persisted, snapshot, "持久化内容必须是夹紧后的设置");

  settings.set({ scale: 200, skin: DEFAULTS.skin, particles: false });
  assert.equal(changes, 1, "值没变不得重复通知（否则 useSyncExternalStore 会抖动）");
  unsubscribe();

  settings.reset();
  assert.deepEqual(settings.getSnapshot(), DEFAULTS);
  assert.deepEqual(JSON.parse(loaded.win.localStorage.getItem("dsh-agent-whales.settings")), DEFAULTS);
});

// ── 2. 拖拽坐标：脏数据不得把角色钉在角落 ────────────────────────────────

test("localStorage：不可用 / getItem 抛错时回默认，setItem 抛错时继续用内存值", () => {
  const blocked = loadPlugin({ throwOnGet: true, throwOnSet: true });
  const { settings, positions, DEFAULTS } = blocked.plugin.__test;
  assert.deepEqual(settings.getSnapshot(), DEFAULTS, "读不到存储就用默认设置");
  assert.deepEqual(positions.getSnapshot().map, {}, "读不到存储就用空坐标表");

  assert.doesNotThrow(() => settings.set({ scale: 150 }), "配额不足时 set 不能把 UI 打崩");
  assert.equal(settings.getSnapshot().scale, 150, "setItem 抛错后内存值仍然生效");
  assert.doesNotThrow(() => positions.set("a", { x: 10, y: 10 }));
  assert.deepEqual(positions.getSnapshot().map, { a: { x: 10, y: 10 } }, "坐标同样退化为内存态");

  const noStorage = loadPlugin({ noStorage: true });
  assert.deepEqual(noStorage.plugin.__test.settings.getSnapshot(), DEFAULTS, "localStorage 整个缺失也要能起 UI");
});

test("positions：载入的 (0,0)/99999/NaN/数组/缺字段坐标全部不生效", () => {
  const dirty = {
    zero: { x: 0, y: 0 },
    huge: { x: 99999, y: 0 },
    negativeHuge: { x: 0, y: -99999 },
    array: [1, 2],
    missing: { y: 5 },
    valid: { x: 12, y: -30 }
  };
  const { resolveOffsets } = testApi({ storedPositions: JSON.stringify(dirty) });
  const rows = Object.keys(dirty).map((key) => ({ whale: { key }, depth: 0, parent: undefined }));
  const offsets = resolveOffsets(rows, dirty);
  assert.deepEqual(Object.keys(offsets), ["valid"], "只有合法坐标能脱离队形");
  assert.deepEqual(offsets.valid, { x: 12, y: -30, own: true });

  // 内存里直接塞 NaN（localStorage 存不进 NaN，但拖拽事件可能产生）
  const direct = testApi();
  direct.positions.set("nan", { x: NaN, y: 1 });
  assert.deepEqual(direct.resolveOffsets([{ whale: { key: "nan" }, depth: 0 }], direct.positions.getSnapshot().map), {});
});

test("positions：载入的坐标必须出现在 getSnapshot 中（刷新后恢复）", () => {
  const persisted = { valid: { x: 12, y: -30 }, other: { x: 40, y: 10 } };
  const { positions } = testApi({ storedPositions: JSON.stringify(persisted) });
  assert.equal(positions.has("valid"), true, "has() 用的是读入的 map");
  assert.deepEqual(positions.getSnapshot().map, persisted, "getSnapshot() 必须与 has() 看到同一份数据，否则刷新后位置永远丢失");
});

test("positions：JSON 往返后的 null / 字符串 / 布尔坐标也不得生效", () => {
  // NaN 经过 JSON.stringify 会变成 null；"12" / true 则是手改 localStorage 的常见形态。
  const dirty = {
    nullX: { x: null, y: 5 },
    stringX: { x: "12", y: 5 },
    boolX: { x: true, y: 5 },
    nullY: { x: 30, y: null },
    valid: { x: 12, y: -30 }
  };
  const { resolveOffsets } = testApi({ storedPositions: JSON.stringify(dirty) });
  const rows = Object.keys(dirty).map((key) => ({ whale: { key }, depth: 0, parent: undefined }));
  const offsets = resolveOffsets(rows, dirty);
  assert.deepEqual(Object.keys(offsets), ["valid"], "非 number 的坐标一律视为脏数据，实际：" + JSON.stringify(offsets));
});

test("positions：非法 JSON / 非对象持久化内容读出空表", () => {
  for (const payload of ["not-json{", "null", "42", '"string"', "true"]) {
    const { positions } = testApi({ storedPositions: payload });
    const map = positions.getSnapshot().map;
    assert.equal(typeof map, "object");
    assert.deepEqual(map, {}, "脏位置数据必须回落到空表：" + payload);
  }
});

// ── 3. 渲染规模：0 / 1 / 20 个 agent ─────────────────────────────────────

function podState(count) {
  const ids = [];
  const byId = {};
  const members = [];
  for (let index = 1; index <= count; index += 1) {
    const id = index === 1 ? "lead" : "mate-" + index;
    ids.push(id);
    byId[id] = {
      sessionId: id,
      title: "agent-" + index,
      running: true,
      retainedBy: index === 1 ? { mainView: 1 } : { mainView: 0 }
    };
    members.push({
      id,
      name: "agent-" + index,
      role: index === 1 ? "lead" : "teammate",
      phase: "active"
    });
  }
  return {
    ids,
    byId,
    projectionsBySession: count === 0 ? {} : { lead: { values: { agentTeam: { members, tasks: [] } } } }
  };
}

function statusOf(state) {
  return new Map(state.ids.map((id) => [id, { running: true }]));
}

function layerProps(state) {
  return {
    useSessions: (selector) => selector(state),
    useSessionStatus: (selector) => selector(statusOf(state)),
    leadIdOf: (id) => id,
    t: (key, params) => (params ? key + ":" + params.count : key)
  };
}

/** 收集未展开的 Whale 组件元素（它们的 key 就是渲染时的 React key）。 */
function whaleElements(tree) {
  const collected = [];
  walk(tree, (node) => {
    if (node.props && node.props.whale && Object.prototype.hasOwnProperty.call(node.props, "key")) {
      collected.push(node);
    }
  });
  return collected;
}

test("渲染：0 个 agent 不崩，整层不渲染", () => {
  const { plugin } = loadPlugin();
  const props = layerProps(podState(0));
  let tree;
  assert.doesNotThrow(() => { tree = plugin.__test.WhaleLayer(props); });
  assert.equal(tree, null, "没有任何角色时返回 null");
  assert.equal(render(tree), null);
});

test("渲染：1 个 agent 恰好一只，且带 Lead 标记", () => {
  const state = podState(1);
  const { plugin } = loadPlugin();
  const tree = render(plugin.__test.WhaleLayer(layerProps(state)));
  const whales = findByClass(tree, "daw-whale");
  assert.equal(whales.length, 1);
  assert.equal(whales[0].props["data-lead"], "1");
  assert.equal(whales[0].props["data-state"], "running");
  assert.equal(findByClass(tree, "daw-stage").length, 1);
});

test("渲染：脏 localStorage 设置下仍能渲染，视觉参数被夹紧", () => {
  const { plugin } = loadPlugin({ stored: '{"scale":1e9,"opacity":-5,"position":"nope","skin":"nope","motion":"nope"}' });
  const { WhaleLayer, DEFAULTS } = plugin.__test;
  const tree = render(WhaleLayer(layerProps(podState(1))));
  const layer = findByClass(tree, "daw-layer")[0];
  assert.ok(layer, "脏设置不能把整层打没");
  assert.equal(layer.props["data-skin"], DEFAULTS.skin, "非法皮肤回落到默认");
  assert.equal(layer.props["data-motion"], DEFAULTS.motion, "非法动画强度回落到默认");
  const pod = findByClass(tree, "daw-pod")[0];
  assert.equal(pod.props.style.opacity, "0.2", "opacity -5 夹到 20%");
  assert.equal(findByClass(tree, "daw-whale").length, 1);
});

test("渲染：20 个 agent 不崩，可见数封顶到 MAX_VISIBLE，溢出显示 +N", () => {
  const state = podState(20);
  const { plugin } = loadPlugin();
  const { WhaleLayer, MAX_VISIBLE } = plugin.__test;
  const props = layerProps(state);

  const raw = WhaleLayer(props);
  assert.ok(raw, "20 个 agent 也要渲染");
  const whaleNodes = whaleElements(raw);
  assert.equal(whaleNodes.length, Math.min(MAX_VISIBLE, 20), "可见数量必须与 MAX_VISIBLE 口径一致");
  for (const node of whaleNodes) {
    assert.equal(node.props.key, node.props.whale.key, "React key 必须与 whales 的 key 一致");
    assert.ok(Number.isFinite(node.props.size) && node.props.size > 0, "尺寸必须有限且为正");
  }

  const tree = render(raw);
  assert.equal(findByClass(tree, "daw-whale").length, whaleNodes.length);
  const countNode = findByClass(tree, "daw-count").find((node) => node.props.children === "+" + (20 - MAX_VISIBLE));
  assert.ok(countNode, "溢出数量必须显示为 +" + (20 - MAX_VISIBLE));
});

test("渲染：多级家族树下 React key 唯一，尺寸/位置全部有限", () => {
  const state = podState(3);
  // 再把 mate-2 挂到 mate-2 的父级下、给 lead 一个子级，形成 depth 0/1
  state.byId["mate-2"].parentId = "lead";
  state.byId["mate-3"].parentId = "mate-2";
  const { plugin } = loadPlugin();
  const { WhaleLayer, expanded } = plugin.__test;
  expanded.set(["lead", "mate-2"]);
  const raw = WhaleLayer(layerProps(state));
  const nodes = whaleElements(raw);
  const keys = nodes.map((node) => String(node.props.key));
  assert.equal(new Set(keys).size, keys.length, "React key 必须唯一：" + keys.join(","));
  for (const node of nodes) {
    assert.ok(Number.isFinite(node.props.size) && node.props.size > 0);
    if (node.props.offset !== undefined) {
      assert.ok(Number.isFinite(node.props.offset.x) && Number.isFinite(node.props.offset.y), "拖拽偏移必须是有限数字");
      assert.ok(Math.abs(node.props.offset.x) < 4000 && Math.abs(node.props.offset.y) < 4000);
    }
  }
});

// ── 4. 重复装配（热重载）与样式注入 ─────────────────────────────────────

function clientCtx(disposers) {
  return {
    effect(run) {
      const disposer = run();
      if (typeof disposer === "function") disposers.push(disposer);
      return disposer;
    },
    locale: { register() { return () => {}; } },
    slots: {
      inject() { return () => {}; },
      register(options, component) { return { options, component }; }
    },
    sessions: { binding() { return undefined; } }
  };
}

test("apply：重复执行两次不重复注入样式，disposer 之后还能重新注入", () => {
  const { plugin } = loadPlugin();
  const { appended, document } = installDocumentStub();
  const disposers = [];
  try {
    plugin.apply(clientCtx(disposers));
    plugin.apply(clientCtx(disposers));
    assert.equal(appended.length, 1, "热重载重复 apply 只能有一个 style 标签");
    assert.equal(document.getElementById("dsh-agent-whales-styles"), appended[0]);

    disposers[0]("样式 disposer 必须真的移除节点");
    assert.equal(appended.length, 0, "disposer 运行后 style 必须被移除");

    plugin.apply(clientCtx(disposers));
    assert.equal(appended.length, 1, "清理之后重新装配要能再次注入");
  } finally {
    delete globalThis.document;
  }
});

// ── 5. 素材完整性：引用集合 ⊆ ART，ART 与 art.json 同源 ─────────────────

test("ART：frameOf / pickMoodKey 引用到的每一帧都真的存在", async () => {
  const { ART, frameOf, pickMoodKey } = await testApiWithArt(["q", "mature"]);
  const art = ART();
  assert.ok(Object.keys(art).length > 0, "D1 之后素材必须能从假宿主路由加载进来");

  for (const skin of ["mix", "q", "mature"]) {
    for (const isLead of [true, false]) {
      for (const variant of ["base", "blink", "entry", "exit", "sleepy", "unknown"]) {
        const key = frameOf(skin, isLead, variant);
        assert.equal(typeof key, "string", `frameOf(${skin}, ${isLead}, ${variant}) 必须给出帧`);
        assert.ok(art[key], "缺少帧 " + key);
      }
    }
  }
  assert.equal(frameOf("classic", true, "base"), undefined, "经典皮肤走矢量，不取位图");

  for (const family of ["q", "mature"]) {
    for (const phase of ["running", "provisioning", "idle"]) {
      for (let tick = 0; tick < 24; tick += 1) {
        const key = pickMoodKey(family, phase, tick);
        assert.equal(typeof key, "string", `pickMoodKey(${family}, ${phase}, ${tick})`);
        assert.ok(art[key], "缺少心情帧 " + key);
      }
    }
  }
});

test("ART：运行时素材表与 assets/art.json 的 key 集合、尺寸一致（防改了帧表忘了补图）", async () => {
  const art = (await testApiWithArt(["q", "mature", "classic"])).ART();
  assert.ok(Object.keys(art).length > 0, "素材必须已从假宿主路由加载");
  const source = JSON.parse(readFileSync(artJsonPath, "utf8"));
  const sprites = source && source.sprites;
  assert.ok(sprites && typeof sprites === "object", "assets/art.json 必须带 sprites 表");
  assert.deepEqual(Object.keys(art).sort(), Object.keys(sprites).sort(), "运行时素材表的 key 集合必须与 art.json 一致");

  for (const [key, entry] of Object.entries(art)) {
    // D1：uri 不再是 data URI，而是宿主素材路由的地址。
    assert.match(entry.uri, /^\/agent-whales\/api\/art\/[a-z0-9-]+\.webp$/, key + " 必须指向素材路由");
    assert.ok(Number.isFinite(entry.w) && entry.w > 0, key + " 宽度必须有限");
    assert.ok(Number.isFinite(entry.h) && entry.h > 0, key + " 高度必须有限");
    assert.equal(entry.w, sprites[key].w, key + " 宽度必须与 art.json 一致");
    assert.equal(entry.h, sprites[key].h, key + " 高度必须与 art.json 一致");
  }
});

test("ART：源码帧表/心情池里的 key 全部命中 ART（交叉验证，不整文件 dump）", async () => {
  const art = (await testApiWithArt(["q", "mature", "classic"])).ART();
  assert.ok(Object.keys(art).length > 0, "素材必须已从假宿主路由加载");
  const source = readFileSync(clientPath, "utf8");

  function quotedKeys(body) {
    return Array.from(body.matchAll(/"([^"]+)"/g), (match) => match[1]);
  }

  for (const name of ["Q_FRAMES", "M_FRAMES"]) {
    const match = new RegExp("var " + name + " = \\{([^}]*)\\}").exec(source);
    assert.ok(match, "源码里找不到帧表 " + name);
    const keys = quotedKeys(match[1]);
    assert.ok(keys.length > 0, name + " 不得为空表");
    for (const key of keys) assert.ok(art[key], name + " 引用了不存在的帧 " + key);
  }

  for (const name of ["Q_MOOD_RUNNING", "Q_MOOD_IDLE", "M_MOOD_RUNNING", "M_MOOD_IDLE"]) {
    const match = new RegExp("var " + name + " = \\[([^\\]]*)\\]").exec(source);
    assert.ok(match, "源码里找不到心情池 " + name);
    const keys = quotedKeys(match[1]);
    assert.ok(keys.length > 0, name + " 不得为空数组");
    for (const key of keys) assert.ok(art[key], name + " 引用了不存在的帧 " + key);
  }

  // 经典皮肤直接按 "c-idle"/"c-work" 取图；同样做引用集合校验。
  const logic = source.slice(source.indexOf("function createPositions"));
  assert.ok(logic.includes("artOf("), "源码里找不到经典皮肤的 artOf 取图逻辑");
  const classicKeys = Array.from(new Set(logic.matchAll(/"(c-[a-z0-9-]+)"/g)), (match) => match[1]);
  assert.ok(classicKeys.length > 0, "经典皮肤应当引用 c-* 素材");
  for (const key of classicKeys) assert.ok(art[key], "源码引用了不存在的经典皮肤帧 " + key);
});

// ── 6. 「串门工具」开关：宿主真相 + POST 写回 + 失败回滚 + i18n ────────────

function settingsPropsFor() {
  const state = podState(1);
  return {
    useSessions: (selector) => selector(state),
    useSessionStatus: (selector) => selector(statusOf(state)),
    leadIdOf: (id) => id,
    t: (key, params) => (params ? key + ":" + params.count : key)
  };
}

/** 从设置页未展开的元素树里找到「串门工具」那个 Switch 元素。 */
function visitToolsSwitch(plugin) {
  const raw = plugin.__test.WhaleSettingsSection(settingsPropsFor());
  let found = null;
  walk(raw, (node) => {
    if (found !== null) return;
    if (node.props && node.props.label === "visitTools" && typeof node.props.onChange === "function") found = node;
  });
  return found;
}

/** 让 fetch promise 链落地（事件循环跑一轮 macrotask 即足够）。 */
function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("串门开关：快照未到达前 disabled；拿到 visitTools 后启用并跟随宿主值", () => {
  const { plugin } = loadPlugin();
  const before = visitToolsSwitch(plugin);
  assert.ok(before, "设置页必须有串门工具开关");
  assert.equal(before.props.disabled, true, "没有第一次 activity 快照时必须 disabled");
  assert.equal(before.props.checked, true, "未就绪时显示宿主默认值 true，但不可点");

  plugin.__test.toolActivity.apply({ active: {}, visitTools: true, controlToken: "token-1" });
  const ready = visitToolsSwitch(plugin);
  assert.equal(ready.props.disabled, false, "拿到快照后必须可点");
  assert.equal(ready.props.checked, true);

  plugin.__test.toolActivity.apply({ active: {}, visitTools: false, controlToken: "token-2" });
  const off = visitToolsSwitch(plugin);
  assert.equal(off.props.disabled, false);
  assert.equal(off.props.checked, false, "开关必须跟随宿主真相，而不是 localStorage");
});

test("串门开关：点击发出正确的 POST（URL / 方法 / token 头 / body）", async () => {
  const { plugin } = loadPlugin();
  plugin.__test.toolActivity.apply({ active: {}, visitTools: true, controlToken: "token-abc123" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true, status: 204 });
  };
  try {
    visitToolsSwitch(plugin).props.onChange(false);
    await flushAsync();
    assert.equal(calls.length, 1, "一次点击只能发一个 POST");
    assert.equal(calls[0].url, "/agent-whales/api/visit-tools");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["content-type"], "application/json");
    assert.equal(calls[0].options.headers["x-whales-token"], "token-abc123", "必须带最近一次 GET 拿到的 token");
    assert.deepEqual(JSON.parse(calls[0].options.body), { enabled: false });
    assert.equal(plugin.__test.toolActivity.getSnapshot().visitTools, false, "204 后宿主真相立即更新，不必等 2s 轮询");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test("串门开关：403 / 网络失败时回滚到宿主原值，不停在乐观态", async () => {
  const { plugin } = loadPlugin();
  plugin.__test.toolActivity.apply({ active: {}, visitTools: true, controlToken: "token-xyz" });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 403 });
    visitToolsSwitch(plugin).props.onChange(false);
    await flushAsync();
    assert.equal(plugin.__test.toolActivity.getSnapshot().visitTools, true, "403 不能把宿主真相改成 false");
    const after403 = visitToolsSwitch(plugin);
    assert.equal(after403.props.checked, true, "下一次渲染必须回到原值 true");
    assert.equal(after403.props.disabled, false, "失败后要能再次点击，不能永久 busy");

    globalThis.fetch = () => Promise.reject(new Error("network down"));
    visitToolsSwitch(plugin).props.onChange(false);
    await flushAsync();
    assert.equal(plugin.__test.toolActivity.getSnapshot().visitTools, true, "网络失败同样不得写脏状态");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test("串门开关：未就绪时点击不发请求（不能拿空 token 去打宿主）", async () => {
  const { plugin } = loadPlugin();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => { calls.push(url); return Promise.resolve({ ok: true, status: 204 }); };
  try {
    const node = visitToolsSwitch(plugin);
    assert.equal(node.props.disabled, true);
    node.props.onChange(false);
    await flushAsync();
    assert.deepEqual(calls, [], "未拿到 controlToken 前不得发请求");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test("i18n：串门开关的 visitTools/visitToolsHint 在 zh/en 两份词典里都存在且非空", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  let dictionary = null;
  const ctx = {
    effect(run) { return run(); },
    locale: { register(namespace, dict) { dictionary = { namespace, dict }; return () => {}; } },
    slots: { inject() { return () => {}; }, register(options, component) { return { options, component }; } },
    sessions: { binding() { return undefined; } }
  };
  try {
    plugin.apply(ctx);
  } finally {
    delete globalThis.document;
  }
  assert.ok(dictionary, "apply 必须注册词典");
  assert.equal(
    Object.keys(dictionary.dict.zh).sort().join(","),
    Object.keys(dictionary.dict.en).sort().join(","),
    "中英文键集合必须一致"
  );
  for (const key of ["visitTools", "visitToolsHint"]) {
    for (const lang of ["zh", "en"]) {
      const value = dictionary.dict[lang][key];
      assert.equal(typeof value, "string", lang + "." + key + " 必须是字符串");
      assert.ok(value.length > 0, lang + "." + key + " 不得为空");
    }
  }
});
