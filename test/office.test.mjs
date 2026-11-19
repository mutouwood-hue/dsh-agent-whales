/**
 * 第二期 X4：项目工作台的「办公室」页——一间卡通办公室（墙、书架、盆栽、地砖，
 * 每个成员一个工位：办公椅 + 坐着的鲸鱼娘 + 桌子前半截）。素材由 AI 生成，见 NOTICE.md。
 *
 * 只测浏览器侧的折叠逻辑与渲染契约，不测像素：
 *   - 姿势优先级：离线 > 出错 > 等你 > 刚收工 > 思考 > 读 / 改 / 命令 > 在跑 > 空闲，且与鲸鱼头顶的 faceOf 同源；
 *   - 名牌：写对话的中文名（/sessions → 宿主会话表 → 登记的角色名），拿不到就写「主对话 / 未命名对话」，绝不摆整串 id；
 *   - 成员颜色按顺序轮，主对话保持原色；
 *   - 客户端写死的尺寸 / 对位 / 装饰件必须与 assets/office/manifest.json 一致（换图时两边会对不上）；
 *   - 页面：房间 + 每个成员一个可点的工位，主对话排第一，点工位打开对话；
 *   - 路由：office 是合法 tab，坏 tab 仍回落 canvas；
 *   - 素材加载失败时退回纯文字状态，不留裂图。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

function collect(node, out, match) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) { node.forEach((item) => collect(item, out, match)); return; }
  if (typeof node !== "object") return;
  if (node.props && match(node)) out.push(node);
  collect(node.props ? node.props.children : undefined, out, match);
}
function find(tree, match) { const out = []; collect(tree, out, match); return out; }
function texts(node) {
  const out = [];
  const walk = (n) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== "object") return;
    walk(n.props ? n.props.children : undefined);
  };
  walk(node);
  return out.join("");
}
const KEY = (key, vars) => "[" + key + (vars ? " " + JSON.stringify(vars) : "") + "]";
const ok = (data) => ({ code: 200, msg: "success", data });
const manifest = () => JSON.parse(readFileSync(new URL("../assets/office/manifest.json", import.meta.url), "utf8"));

function load() {
  const { shim, mount } = createMount({ effects: true });
  const t = loadPlugin({ react: shim }).plugin.__test;
  installDocumentStub();
  return { t, mount };
}

function fakeHost({ project, sessions, active, state }) {
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    let data = ok({});
    if (target === "/projects/p1") data = ok({ project });
    else if (target === "/sessions") data = ok({ sessions });
    // 真机的 /activity 是裸 JSON、没有 {code,msg,data} 信封；假宿主必须一样，否则测不出解包的 bug。
    else if (target === "/activity") data = { at: Date.now(), active: active || {}, state: state || {}, visitTools: true, ultra: false, controlToken: "t" };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  return { restore() { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}

const statusOf = (rows) => new Map(Object.entries(rows));

test("姿势优先级：离线 > 出错 > 等你 > 刚收工 > 思考 > 读 / 改 / 命令 > 在跑 > 空闲", () => {
  const { t } = load();
  const now = 1_000_000;
  const waiting = { kind: "approval" };
  const fresh = (extra) => Object.assign({ running: true }, extra);

  assert.equal(t.wbOfficePose({ offline: true, row: fresh({ lastErrorAt: now - 1000 }), pending: waiting, now }), "sleep", "离线压过一切");
  assert.equal(t.wbOfficePose({ row: fresh({ lastErrorAt: now - 1000 }), pending: waiting, now }), "oops", "刚出错压过等你");
  assert.equal(t.wbOfficePose({ row: fresh({ lastErrorAt: now - 9000 }), now }), "type", "错误过了 8 秒不再显示出错，回到在跑");
  assert.equal(t.wbOfficePose({ row: fresh(), pending: waiting, tool: "bash", now }), "wait", "卡在审批上的会话是在等人，不是在忙");
  assert.equal(t.wbOfficePose({ row: { lastTurnEndAt: now - 1000, lastRunMs: 20000 }, now }), "done", "刚跑完一轮：收工");
  assert.equal(t.wbOfficePose({ row: { lastTurnEndAt: now - 1000, lastRunMs: 1000 }, now }), "idle", "太短的一轮不庆祝");
  assert.equal(t.wbOfficePose({ row: fresh({ streaming: true }), tool: "edit", now }), "think", "模型在输出时是思考");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "read", now }), "read");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "grep", now }), "read");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "edit", now }), "type");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "pwsh", now }), "run");
  assert.equal(t.wbOfficePose({ row: fresh(), tool: "mcp__x__y", now }), "type", "MCP 工具名不猜，用最通用的打字");
  assert.equal(t.wbOfficePose({ row: fresh(), now }), "type", "在跑但没有工具信息");
  assert.equal(t.wbOfficePose({ row: { running: false }, tool: "read", now }), "idle", "没在跑就不看工具");
  assert.equal(t.wbOfficePose({ row: {}, pending: { kind: "something-new" }, now }), "idle", "未知 kind 不举手");
  assert.equal(t.wbOfficePose(undefined), "idle");
  assert.equal(t.wbOfficePose({}), "idle");
});

test("名牌取值：/sessions → 宿主会话表 → 登记的角色名；空串、纯空白、等于 id 的都不算", () => {
  const { t } = load();
  const id = "session-99f56a30-16f1-4237-b613-e52576912061";
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: "第二轮验证", storeTitle: "别的", memberTitle: "后端" }), { text: "第二轮验证", named: true });
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: "", storeTitle: "宿主侧栏里的名字", memberTitle: "后端" }), { text: "宿主侧栏里的名字", named: true });
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: id, storeTitle: id, memberTitle: "后端" }), { text: "后端", named: true }, "wbSessionRows 会把空标题填成 id，要当作没有");
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: "   ", memberTitle: "  前端  " }), { text: "前端", named: true }, "去首尾空白");
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: id }), { text: "", named: false });
  assert.deepEqual(t.wbOfficeTitle({ sessionId: id, routeTitle: 42, storeTitle: null, memberTitle: {} }), { text: "", named: false }, "脏值不当名字");
  assert.deepEqual(t.wbOfficeTitle(undefined), { text: "", named: false });
  assert.equal(t.wbOfficeShortId(id), "99f56a", "没名字时只给 6 位短后缀");
  assert.equal(t.wbOfficeShortId(undefined), "");
});

test("颜色：主对话原色，其余按顺序轮 4 个色相（肤色不偏绿的那几个），非法下标回到原色", () => {
  const { t } = load();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(t.wbOfficeHue), [0, 30, 325, 295, 0, 30, 325, 295]);
  // 真机教训：hue-rotate 是整张图一起转，转到 90° 左右脸和腿会变绿。可用角度（折算到 −180..180）必须落在实测过的安全区间
  for (const index of [0, 1, 2, 3]) {
    const deg = ((t.wbOfficeHue(index) + 180) % 360 + 360) % 360 - 180;
    assert.ok(deg >= -65 && deg <= 30, "色相 " + t.wbOfficeHue(index) + "° 会让肤色偏绿或偏黄绿，实测安全区间是 −65° 到 +30°");
  }
  assert.equal(t.wbOfficeHue(-1), 0);
  assert.equal(t.wbOfficeHue(NaN), 0);
  assert.equal(t.wbOfficeHue("x"), 0);
  assert.equal(new Set([0, 1, 2, 3].map(t.wbOfficeHue)).size, 4, "4 人以内不撞色");
});

test("素材契约：客户端写死的姿势、尺寸、对位与装饰件必须等于 assets/office/manifest.json", () => {
  const { t } = load();
  const file = manifest();
  const poses = Object.keys(t.WB_OFFICE_POSES);
  const expected = poses.map((pose) => "o-sit-" + pose).concat(["o-walk-side", "o-station-back", "o-station-front", "o-plant", "o-shelf", "o-floor", "o-wall"]);
  assert.deepEqual(Object.keys(file.keys).sort(), expected.sort(), "清单里的素材集合必须正好是页面用到的那些，不多不少");
  for (const pose of poses) {
    const entry = file.keys["o-sit-" + pose];
    assert.equal(entry.frames, t.WB_OFFICE_POSES[pose], pose + " 的帧数");
    assert.equal(entry.h, t.WB_OFFICE_LAYOUT.frame.h, pose + " 的高度");
    assert.equal(entry.w, t.WB_OFFICE_LAYOUT.frame.w * entry.frames, pose + " 的横条宽度 = 单帧宽 × 帧数");
  }
  assert.deepEqual(t.WB_OFFICE_LAYOUT, file.layout, "对位数据必须与清单里的 layout 完全一致");
  for (const layer of ["o-station-back", "o-station-front"]) {
    assert.equal(file.keys[layer].w, file.layout.station.w, layer + " 的宽");
    assert.equal(file.keys[layer].h, file.layout.station.h, layer + " 的高");
  }
  for (const item of t.WB_OFFICE_DECOR) {
    assert.equal(file.keys[item.key].w, item.w, item.key + " 的宽");
    assert.equal(file.keys[item.key].h, item.h, item.key + " 的高");
  }
  // 行走帧：侧面两帧循环，尺寸等于清单里的 walker 对位（页面按它摆位和翻帧）
  assert.equal(file.keys["o-walk-side"].frames, 2);
  assert.equal(file.keys["o-walk-side"].h, file.layout.walker.h);
  assert.equal(file.keys["o-walk-side"].w, file.layout.walker.w * 2, "横条宽度 = 单帧宽 × 2");
  // 人物帧必须完整落在工位画布里，不然会被裁掉
  const { frame, station } = file.layout;
  assert.ok(station.girlX >= 0 && station.girlX + frame.w <= station.w, "人物水平方向在工位内");
  assert.ok(station.girlY >= 0 && station.girlY + frame.h <= station.h, "人物垂直方向在工位内");
});

const MEMBERS = [{ sessionId: "s-main" }, { sessionId: "s-a", title: "前端" }, { sessionId: "s-b", title: "后端" }, { sessionId: "s-c" }, { sessionId: "s-d" }];

test("页面：一间办公室，每个成员一个可点的工位，主对话第一；姿势 / 徽标 / 颜色 / 工具来自状态表、会话名单、活动快照", async () => {
  const now = Date.now();
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: "s-main", members: MEMBERS },
    sessions: [
      { sessionId: "s-main", title: "项目主线", live: true },
      { sessionId: "s-a", title: "", live: true },
      { sessionId: "s-b", title: "", live: true },
      { sessionId: "s-c", title: "旧对话", live: false },
      { sessionId: "s-d", title: "测试", live: true }
    ],
    active: { "s-a": { tool: "edit" } },
    state: { "s-d": { lastErrorAt: now - 1000, lastErrorKind: "tool" } }
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    await t.wbCache.read("/activity").catch(() => {});
    const view = mount(t.WbOfficePage, {
      t: KEY,
      projectId: "p1",
      useSessionStatus: (selector) => selector(statusOf({ "s-b": { running: true, pendingInteraction: { kind: "approval" } } }))
    });
    await view.settle();

    // 房间：墙 + 装饰 + 地面 + 网格
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-room").length, 1);
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-wall").length, 1);
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-floor").length, 1);
    assert.deepEqual(find(view.tree, (n) => typeof n.props["data-decor"] === "string").map((n) => n.props["data-decor"]), t.WB_OFFICE_DECOR.map((d) => d.key));
    const wall = find(view.tree, (n) => n.props.className === "daw-office-wall")[0];
    assert.match(wall.props.style.backgroundImage, /\/agent-whales\/api\/office\/o-wall\.webp/);
    const floor = find(view.tree, (n) => n.props.className === "daw-office-floor")[0];
    assert.match(floor.props.style.backgroundImage, /^linear-gradient\(.*\), url\(\/agent-whales\/api\/office\/o-floor\.webp\)$/, "地砖上盖一层半透明浅色，压成底纹");

    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    assert.deepEqual(desks.map((n) => n.props["data-session"]), ["s-main", "s-a", "s-b", "s-c", "s-d"], "主对话排第一");
    assert.ok(desks.every((n) => n.type === "button"), "每个工位是一个可点、可键盘聚焦的按钮");
    const deskOf = (id) => desks.find((n) => n.props["data-session"] === id);
    assert.equal(deskOf("s-main").props["data-pose"], "idle");
    assert.equal(deskOf("s-a").props["data-pose"], "type", "活动快照里有 edit 工具");
    assert.equal(deskOf("s-b").props["data-pose"], "wait", "又在跑又有待审批：举手等你");
    assert.equal(deskOf("s-c").props["data-pose"], "sleep", "离线睡觉");
    assert.equal(deskOf("s-d").props["data-pose"], "oops", "活动快照里刚出错");

    const plateOf = (id) => texts(find(deskOf(id), (n) => n.props.className === "daw-office-plate")[0]);
    assert.equal(plateOf("s-main"), "项目主线", "/sessions 有标题就用它");
    assert.equal(plateOf("s-a"), "前端", "/sessions 标题是空串 → 用加入项目时登记的角色名");
    assert.equal(plateOf("s-b"), "后端");
    assert.equal(plateOf("s-c"), "旧对话");

    const badgeOf = (id) => find(deskOf(id), (n) => typeof n.props["data-badge"] === "string").map((n) => n.props["data-badge"]);
    assert.deepEqual(badgeOf("s-main"), []);
    assert.deepEqual(badgeOf("s-a"), [], "工作姿势本身就表达了在干什么，不再叠徽标");
    assert.deepEqual(badgeOf("s-b"), ["?"]);
    assert.deepEqual(badgeOf("s-c"), ["zZ"]);
    assert.deepEqual(badgeOf("s-d"), ["!"]);
    assert.match(texts(deskOf("s-a")), /office\.tool/, "显示在用的工具");
    assert.match(texts(deskOf("s-b")), /office\.pose\.wait/);
    assert.match(texts(deskOf("s-main")), /office\.main/, "有名字的主对话再贴一枚「主对话」标签");

    // 每个工位三层：椅子 → 人 → 桌子前半截（顺序决定遮挡关系）
    const layers = (id) => find(deskOf(id), (n) => n.props.className === "daw-office-layer" || n.props.className === "daw-office-sprite").map((n) => n.props["data-layer"] || "sprite");
    assert.deepEqual(layers("s-a"), ["back", "sprite", "front"]);
    const stage = find(deskOf("s-a"), (n) => n.props.className === "daw-office-stage")[0];
    assert.equal(stage.props.style.width, t.WB_OFFICE_LAYOUT.station.w * t.WB_OFFICE_SCALE + "px");
    assert.equal(stage.props.style.height, t.WB_OFFICE_LAYOUT.station.h * t.WB_OFFICE_SCALE + "px");

    const sprites = find(view.tree, (n) => n.props.className === "daw-office-sprite");
    assert.equal(sprites.length, 5);
    assert.match(sprites[1].props.style.backgroundImage, /\/agent-whales\/api\/office\/o-sit-type\.webp/);
    assert.equal(sprites[1].props["data-frames"], "2", "打字是两帧循环");
    assert.equal(sprites[0].props["data-frames"], "1", "空闲是单帧");
    assert.equal(sprites[0].props.style.filter, undefined, "主对话保持原色");
    assert.equal(sprites[1].props.style.filter, "hue-rotate(30deg)");
    assert.equal(sprites[2].props.style.filter, "hue-rotate(325deg)");
    assert.match(sprites[3].props.style.backgroundImage, /o-sit-sleep\.webp/);
    assert.match(sprites[4].props.style.backgroundImage, /o-sit-oops\.webp/);
    const { frame, station } = t.WB_OFFICE_LAYOUT;
    assert.equal(sprites[1].props.style.left, station.girlX * t.WB_OFFICE_SCALE + "px", "人物按清单里的对位放进工位");
    assert.equal(sprites[1].props.style.top, station.girlY * t.WB_OFFICE_SCALE + "px");
    assert.equal(sprites[1].props.style.width, frame.w * t.WB_OFFICE_SCALE + "px");
    assert.equal(sprites[1].props.style.backgroundSize, 2 * frame.w * t.WB_OFFICE_SCALE + "px " + frame.h * t.WB_OFFICE_SCALE + "px");
  } finally { host.restore(); }
});

test("踱步：只有空闲的成员离开椅子走动；干活 / 等你 / 出错 / 睡觉的都坐着，椅子留在原处", async () => {
  const now = Date.now();
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-a" }, { sessionId: "s-b" }, { sessionId: "s-c" }, { sessionId: "s-d" }] },
    sessions: [
      { sessionId: "s-main", title: "主", live: true },
      { sessionId: "s-a", title: "甲", live: true },
      { sessionId: "s-b", title: "乙", live: true },
      { sessionId: "s-c", title: "丙", live: false },
      { sessionId: "s-d", title: "丁", live: true }
    ],
    active: { "s-a": { tool: "edit" } },
    state: { "s-d": { lastErrorAt: now - 1000, lastErrorKind: "tool" } }
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    await t.wbCache.read("/activity").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1", useSessionStatus: (selector) => selector(statusOf({ "s-b": { running: true, pendingInteraction: { kind: "approval" } } })) });
    await view.settle();
    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    const walkersIn = (id) => find(desks.find((n) => n.props["data-session"] === id), (n) => n.props.className === "daw-office-walker").length;
    assert.equal(walkersIn("s-main"), 1, "空闲 → 走动");
    for (const id of ["s-a", "s-b", "s-c", "s-d"]) assert.equal(walkersIn(id), 0, id + " 不是空闲，不能走动");
    // 空闲的人：坐着的那张图留在 DOM 里（带 data-alt，平时由样式藏起来，「减少动态效果」时顶上），其它姿势没有 data-alt
    const spriteOf = (id) => find(desks.find((n) => n.props["data-session"] === id), (n) => n.props.className === "daw-office-sprite")[0];
    assert.equal(spriteOf("s-main").props["data-alt"], "1");
    assert.equal(spriteOf("s-a").props["data-alt"], undefined);
    // 走动的人用侧面行走横条，两帧
    const walker = find(desks[0], (n) => n.props.className === "daw-office-walker")[0];
    const body = find(walker, (n) => n.props.className === "daw-office-walker-body")[0];
    assert.match(body.props.style.backgroundImage, /\/agent-whales\/api\/office\/o-walk-side\.webp/);
    const { walker: size, station } = t.WB_OFFICE_LAYOUT;
    const w = size.w * t.WB_OFFICE_SCALE;
    assert.equal(body.props.style.backgroundSize, 2 * w + "px " + size.h * t.WB_OFFICE_SCALE + "px");
    // 走动范围 = 工位宽 − 人宽：走到头刚好贴着工位边，不会跑出工位
    assert.equal(walker.props.style["--daw-office-range"], (station.w - size.w) * t.WB_OFFICE_SCALE + "px");
    // 脚落在工位底部
    assert.equal(walker.props.style.top, (station.h - size.h) * t.WB_OFFICE_SCALE + "px");
    // 层叠顺序：椅子 → 坐着的人 → 桌子前半截 → 走动的人（人走在桌子前面）
    const order = find(desks[0], (n) => n.props.className === "daw-office-layer" || n.props.className === "daw-office-sprite" || n.props.className === "daw-office-walker")
      .map((n) => n.props["data-layer"] || (n.props.className === "daw-office-walker" ? "walker" : "sprite"));
    assert.deepEqual(order, ["back", "sprite", "front", "walker"]);
  } finally { host.restore(); }
});

test("踱步：起始错位按成员序号错开，6 人以内互不相同；样式里的动画时长与常量一致；动画只用 transform 与 steps()", () => {
  const { t } = load();
  const delays = [0, 1, 2, 3, 4, 5].map(t.wbOfficeWalkDelay);
  assert.equal(new Set(delays).size, 6, "6 人以内不齐步走");
  for (const delay of delays) {
    const seconds = Math.abs(parseFloat(delay));
    assert.ok(delay.startsWith("-") || delay === "-0.0s", "负延迟 = 一开始就在半路：" + delay);
    assert.ok(seconds >= 0 && seconds < t.WB_OFFICE_WALK_SECONDS, "延迟必须落在一个来回之内：" + delay);
  }
  assert.equal(t.wbOfficeWalkDelay(-1), t.wbOfficeWalkDelay(0), "非法下标当 0");
  assert.equal(t.wbOfficeWalkDelay(NaN), t.wbOfficeWalkDelay(0));
  const css = (Array.isArray(t.WB_CSS) ? t.WB_CSS : [String(t.WB_CSS)]).join("\n");
  assert.match(css, new RegExp("\\.daw-office-walker\\{[^}]*animation:daw-office-pace " + t.WB_OFFICE_WALK_SECONDS + "s linear infinite"), "平移动画时长必须等于 WB_OFFICE_WALK_SECONDS");
  assert.match(css, new RegExp("daw-office-face " + t.WB_OFFICE_WALK_SECONDS + "s step-end infinite"), "转身动画与平移同一个周期，不然人会倒着走");
  assert.match(css, /\.daw-office-walker-body\{[^}]*daw-office-flip \.6s steps\(2\) infinite/, "走路翻帧用 steps(2)");
  const pace = /@keyframes daw-office-pace\{(.*?)\}\}/.exec(css);
  assert.ok(pace, "找得到平移关键帧");
  assert.equal(/\b(left|top|margin|width|height)\s*:/.test(pace[1]), false, "平移只用 transform，不触发布局");
  // 走到右头（45%~50%）那一段正好转身：平移在 45% 到位，朝向在 50% 翻面，中间站定一会儿
  assert.match(css, /45%\{transform:translateX\(var\(--daw-office-range\)\)\}50%\{transform:translateX\(var\(--daw-office-range\)\)\}/);
  assert.match(css, /@keyframes daw-office-face\{0%\{transform:scaleX\(-1\)\}45%\{transform:scaleX\(-1\)\}50%\{transform:scaleX\(1\)\}/, "素材面朝左：向右走时才镜像回去");
  // 「减少动态效果」：不走动、不翻帧，坐着的空闲图与椅子恢复显示
  const reduced = /@media \(prefers-reduced-motion:reduce\)\{(.*)\}$/m.exec(css);
  assert.ok(reduced, "要有 reduce-motion 分支");
  assert.match(reduced[1], /\.daw-office-walker\{display:none\}/);
  assert.match(reduced[1], /\.daw-office-sprite\[data-alt="1"\]\{visibility:visible\}/);
  assert.match(reduced[1], /\.daw-office-layer\[data-layer=back\]\{visibility:visible\}/);
});

test("踱步：素材加载失败时不渲染走动的人（和坐姿一样退回纯文字）", async () => {
  const originalImage = globalThis.Image;
  globalThis.Image = class { set src(_) { queueMicrotask(() => this.onerror && this.onerror()); } };
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s-main", members: [] }, sessions: [{ sessionId: "s-main", title: "主", live: true }], active: {} });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-walker").length, 0);
  } finally {
    host.restore();
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage;
  }
});

// 2026-11-18 真机：宿主的 /sessions 只列「已挂载」的会话，离线成员压根不在里面。原先只认 live:false，
// 离线的成员显示「空闲」还在踱步。下面三条用真实宿主的形状（离线成员不出现在列表里）。
test("离线：成员不在已加载的 /sessions 里 → 睡觉（真实宿主的形状，不是 live:false）", async () => {
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-gone" }] },
    sessions: [{ sessionId: "s-main", title: "主", live: true }],
    active: {}
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    const deskOf = (id) => desks.find((n) => n.props["data-session"] === id);
    assert.equal(deskOf("s-main").props["data-pose"], "idle", "在列表里、没事干 → 空闲");
    assert.equal(deskOf("s-gone").props["data-pose"], "sleep", "不在列表里 = 没挂载 = 离线");
    assert.equal(find(deskOf("s-gone"), (n) => n.props["data-badge"] === "zZ").length, 1);
    assert.equal(find(deskOf("s-gone"), (n) => n.props.className === "daw-office-walker").length, 0, "离线的人不踱步");
  } finally { host.restore(); }
});

test("离线：/sessions 没加载出来（读不到）时不判离线——网络抖一下不能让全屋子的人集体睡着", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const target = String(url).replace("/agent-whales/api", "");
    if (target === "/sessions") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const data = target === "/projects/p1"
      ? ok({ project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-a" }] } })
      : { at: Date.now(), active: {}, state: {}, controlToken: "t" };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    await t.wbCache.read("/activity").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    const poses = find(view.tree, (n) => typeof n.props["data-session"] === "string").map((n) => n.props["data-pose"]);
    assert.deepEqual(poses, ["idle", "idle"], "拿不到名单就不知道谁离线，保守按没事干显示");
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

test("离线：不在列表里但有在跑的迹象（工具 / running）→ 不判离线（列表被截断或有短暂空窗时的保险）", async () => {
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-busy" }, { sessionId: "s-run" }] },
    sessions: [{ sessionId: "s-main", title: "主", live: true }],
    active: { "s-busy": { tool: "edit" } },
    state: { "s-run": { running: true } }
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    await t.wbCache.read("/activity").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    const poseOf = (id) => find(view.tree, (n) => n.props["data-session"] === id)[0].props["data-pose"];
    assert.equal(poseOf("s-busy"), "type", "有工具在跑");
    assert.equal(poseOf("s-run"), "type", "宿主说它在跑");
  } finally { host.restore(); }
});

test("名字：宿主会话表（useSessions）里的标题能补上；都没有时写「主对话 / 未命名对话」，页面上不出现整串 id", async () => {
  const mainId = "session-5e8fdc4b-cacb-47e2-b7eb-e238323af1bf";
  const aId = "session-99f56a30-16f1-4237-b613-e52576912061";
  const bId = "session-5474a70b-6c5c-4b2d-9455-cdfc151e0482";
  const host = fakeHost({
    project: { projectId: "p1", mainSessionId: mainId, members: [{ sessionId: mainId }, { sessionId: aId }, { sessionId: bId }] },
    sessions: [{ sessionId: mainId, title: "" }, { sessionId: aId, title: "" }, { sessionId: bId, title: "" }],
    active: {}
  });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const view = mount(t.WbOfficePage, {
      t: KEY,
      projectId: "p1",
      useSessions: (selector) => selector({ byId: { [aId]: { title: "宿主侧栏里的中文名" } } })
    });
    await view.settle();
    const plates = find(view.tree, (n) => n.props.className === "daw-office-plate").map((n) => texts(n));
    assert.deepEqual(plates, [KEY("office.main"), "宿主侧栏里的中文名", KEY("office.untitled", { id: "5474a7" })]);
    const everything = texts(view.tree);
    for (const id of [mainId, aId, bId]) assert.equal(everything.includes(id), false, "页面上不能出现整串会话 id");
    assert.equal(find(view.tree, (n) => n.props["aria-label"] && String(n.props["aria-label"]).includes("session-")).length, 0, "无障碍名称里也不能有整串 id");
    // 主对话没有名字时名牌本身就是「主对话」，不再重复贴一枚标签
    const mainDesk = find(view.tree, (n) => n.props["data-session"] === mainId)[0];
    assert.equal((texts(mainDesk).match(/office\.main/g) || []).length, 1);
  } finally { host.restore(); }
});

test("页面：没有成员时给空态，不渲染房间与工位", async () => {
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "", members: [] }, sessions: [], active: {} });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1" });
    await view.settle();
    assert.equal(find(view.tree, (n) => typeof n.props["data-session"] === "string").length, 0);
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-room").length, 0);
    assert.match(texts(view.tree), /office\.empty/);
  } finally { host.restore(); }
});

test("点工位把对应会话 id 交给 onOpenSession；按钮带「打开对话」提示", async () => {
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s-main", members: [{ sessionId: "s-main" }, { sessionId: "s-a" }] }, sessions: [{ sessionId: "s-main", title: "主", live: true }, { sessionId: "s-a", title: "甲", live: true }], active: {} });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const opened = [];
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1", onOpenSession: (id) => opened.push(id) });
    await view.settle();
    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    assert.equal(desks[1].props.title, KEY("office.open"));
    desks[1].props.onClick();
    desks[0].props.onClick();
    assert.deepEqual(opened, ["s-a", "s-main"]);
  } finally { host.restore(); }
});

test("素材加载失败：提示一句并退回纯文字状态（没有墙、装饰、小人），工位还能点，探针探的是空闲姿势", async () => {
  const originalImage = globalThis.Image;
  const probed = [];
  globalThis.Image = class { set src(value) { probed.push(String(value)); queueMicrotask(() => this.onerror && this.onerror()); } };
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s-main", members: [] }, sessions: [{ sessionId: "s-main", title: "主", live: true }], active: {} });
  try {
    const { t, mount } = load();
    await t.wbCache.read("/projects/p1").catch(() => {});
    await t.wbCache.read("/sessions").catch(() => {});
    const opened = [];
    const view = mount(t.WbOfficePage, { t: KEY, projectId: "p1", onOpenSession: (id) => opened.push(id) });
    await view.settle();
    assert.deepEqual(probed, ["/agent-whales/api/office/o-sit-idle.webp"]);
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-sprite").length, 0);
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-stage").length, 0);
    assert.equal(find(view.tree, (n) => typeof n.props["data-decor"] === "string").length, 0);
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-room")[0].props["data-art"], "off");
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-wall")[0].props.style, undefined, "不再引用墙的图片");
    assert.equal(find(view.tree, (n) => n.props.className === "daw-office-floor")[0].props.style, undefined, "不再引用地砖的图片");
    assert.match(texts(view.tree), /office\.art\.missing/);
    const desks = find(view.tree, (n) => typeof n.props["data-session"] === "string");
    assert.equal(desks.length, 1, "工位与文字状态还在");
    desks[0].props.onClick();
    assert.deepEqual(opened, ["s-main"]);
  } finally {
    host.restore();
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage;
  }
});

test("路由：office 是合法 tab；坏 tab 仍回落 canvas", () => {
  const { t } = load();
  assert.deepEqual(t.wbRouteOf("/p/p1/office"), { kind: "workbench", projectId: "p1", tab: "office" });
  assert.deepEqual(t.wbRouteOf("/p/p1/nope"), { kind: "workbench", projectId: "p1", tab: "canvas" });
  assert.equal(t.wbPathOf({ kind: "workbench", projectId: "p1", tab: "office" }), "/p/p1/office");
});

test("文案：中英两份都有全部 office 键，且不再提 MetroCity", async () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const poses = ["idle", "type", "read", "run", "think", "wait", "done", "oops", "sleep"].map((pose) => "office.pose." + pose);
  const keys = ["tab.office", "tab.note.office", "office.empty", "office.tool", "office.open", "office.main", "office.untitled", "office.legend", "office.art.missing"].concat(poses);
  for (const key of keys) {
    const hits = source.split('"' + key + '":').length - 1;
    assert.equal(hits, 2, key + " 必须在中文与英文各出现一次");
  }
  assert.equal(/"office\.state\./.test(source), false, "旧的 office.state.* 键必须清掉");
  assert.equal(/MetroCity/.test(source), false, "客户端不再提 MetroCity");
});

test("回归：/activity 是宿主的裸 JSON（没有信封），wbCache 必须原样读到，不能报 code 0", async () => {
  const { t } = load();
  assert.equal(t.wbIsRawPath("/activity"), true);
  assert.equal(t.wbIsRawPath("/activity?x=1"), true);
  assert.equal(t.wbIsRawPath("/sessions"), false, "只有白名单里的路径放行裸 JSON");
  assert.equal(t.wbIsRawPath("/activity-foo"), false);
  const host = fakeHost({ project: { projectId: "p1", mainSessionId: "s", members: [] }, sessions: [], active: { s1: { tool: "edit" } }, state: { s1: { running: true } } });
  try {
    t.wbCache.reset();
    const data = await t.wbCache.read("/activity");
    assert.deepEqual(data.active, { s1: { tool: "edit" } });
    assert.deepEqual(data.state, { s1: { running: true } });
    // 反证：其它路径照旧要求信封，缺 code 就是失败
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
    try {
      t.wbCache.reset();
      await assert.rejects(() => t.wbCache.read("/sessions"), /code 0/);
    } finally { globalThis.fetch = original; }
  } finally { host.restore(); }
});
