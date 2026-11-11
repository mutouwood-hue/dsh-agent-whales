/**
 * W2 浏览器半边：「提案带入输入框」+「目标条（input.dock 叠加）」。
 *
 * 依据：PRD §48.2（草稿插入 API 官方契约）、§49.1（目标定义 / 带入只服务改提案）、
 * §49.4（提案状态行）、§47.3 D2（先叠 input.dock 目标条，不影子 composer）、
 * 设计图pen.pen M6-5 帧（带入成功 / 带入降级 / 带入边界三态）。
 *
 * 这一组不碰真浏览器：inputActions 用替身（契约已在宿主实现里逐字核实：
 * insertText 被拒返回 false），剪贴板走 navigator / document 的临时替身。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createReactShim, findByClass, installDocumentStub, loadPlugin, render, walk } from "./harness.mjs";

/** 与 client.js 同一个 React 垫片：只支持 createElement + 4 个 hook。 */
const h = createReactShim().createElement;

function testApi() {
  return loadPlugin().plugin.__test;
}

/** 工作台中文文案解析器（与 workbench.test.mjs 同一套口径）。 */
function wbZhT(api) {
  return (key, vars) => {
    const raw = api.WB_TEXT.zh[key];
    if (raw === undefined) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  };
}

function collectText(node, out) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return; }
  if (Array.isArray(node)) { node.forEach((item) => collectText(item, out)); return; }
  if (typeof node !== "object") return;
  if (typeof node.type === "string") {
    for (const key of Object.keys(node.props || {})) {
      if (key === "children") continue;
      if (typeof node.props[key] === "string") out.push(node.props[key]);
    }
  }
  collectText(node.props ? node.props.children : undefined, out);
}

function buttonsOf(tree) {
  const found = [];
  walk(tree, (node) => { if (node.type === "button") found.push(node); });
  return found;
}

/** 给只读缓存灌一份数据（垫片的 useSyncExternalStore 不订阅，必须手动读）。 */
async function prime(api, fixtures) {
  api.wbCache.reset();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const path = String(url).replace("/agent-whales/api", "");
    for (const key of Object.keys(fixtures)) {
      if (path === key) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: fixtures[key] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: {} }) });
  };
  try {
    for (const key of Object.keys(fixtures)) await api.wbCache.read(key);
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
}

/** 临时替换全局 navigator / document，用完还原（剪贴板降级是全插件唯一 DOM 触碰）。 */
function withGlobals(navigatorValue, documentValue, run) {
  const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hadDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  if (navigatorValue !== undefined) Object.defineProperty(globalThis, "navigator", { value: navigatorValue, configurable: true, writable: true });
  if (documentValue !== undefined) Object.defineProperty(globalThis, "document", { value: documentValue, configurable: true, writable: true });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (navigatorValue !== undefined) {
        if (navDescriptor === undefined) delete globalThis.navigator;
        else Object.defineProperty(globalThis, "navigator", navDescriptor);
      }
      if (documentValue !== undefined) {
        if (hadDocument === undefined) delete globalThis.document;
        else Object.defineProperty(globalThis, "document", hadDocument);
      }
    });
}

const PROPOSAL = {
  proposalId: "prop-9f3c",
  version: 2,
  leadSessionId: "s-main",
  sourceMessageId: "msg-goal-1",
  createdAt: 1,
  items: [
    { key: "T1", title: "体检宿主半边", description: "前置：— · 预期产出：路由/工具自检报告" },
    { key: "T2", title: "体检浏览器半边", blockedBy: ["T1"] }
  ]
};

// ── 1. 文案：新键必须中英各一份且都非空 ────────────────────────────────────

test("W2 文案：带入 / 目标条新键中英键集合一致且都非空", () => {
  const { WB_TEXT } = testApi();
  const keys = [
    "draft.prefix", "draft.insert", "draft.insert.title", "draft.insert.locked", "draft.insert.clipboard",
    "draft.state.inserted", "draft.state.copied", "draft.state.failed", "draft.boundary",
    "goal.label", "goal.from.session", "goal.status", "goal.status.locked", "goal.view", "goal.view.none"
  ];
  for (const key of keys) {
    assert.ok(typeof WB_TEXT.zh[key] === "string" && WB_TEXT.zh[key] !== "", "zh." + key + " 必须存在且非空");
    assert.ok(typeof WB_TEXT.en[key] === "string" && WB_TEXT.en[key] !== "", "en." + key + " 必须存在且非空");
  }
  // 成功态绝不出现"已发送"（§48.2 硬约束）
  for (const lang of ["zh", "en"]) {
    assert.ok(!WB_TEXT[lang]["draft.state.inserted"].includes("已发送"), lang + " 成功态不得显示「已发送」");
    assert.ok(!WB_TEXT[lang]["draft.state.inserted"].toLowerCase().includes("sent"), lang + " success copy must not say sent");
  }
  // 模板变量齐全：前缀带 version + proposalId，状态行带 version
  assert.match(WB_TEXT.zh["draft.prefix"], /\{version\}/);
  assert.match(WB_TEXT.zh["draft.prefix"], /\{proposalId\}/);
  assert.match(WB_TEXT.zh["goal.status"], /\{version\}/);
  assert.match(WB_TEXT.en["draft.prefix"], /\{version\}/);
  assert.match(WB_TEXT.en["goal.status"], /\{version\}/);
});

// ── 2. wbDraftPrefix：引用前缀，不是指令模板 ──────────────────────────────

test("引用前缀：未锁定 / 锁定同形，含 proposalId 与 version，不带指令性措辞", () => {
  const { wbDraftPrefix, WB_TEXT } = testApi();
  const unlocked = wbDraftPrefix(PROPOSAL);
  assert.equal(unlocked, "关于提案 v2（prop-9f3c）：");
  assert.ok(unlocked.includes("prop-9f3c"), "前缀必须带提案编号");
  assert.ok(unlocked.includes("v2"), "前缀必须带版本");
  // 锁定后前缀仍然可用（改提案的入口照旧，只是按钮 title 多一句说明）
  assert.equal(wbDraftPrefix(Object.assign({}, PROPOSAL, { locked: true })), unlocked, "锁定不改变前缀形状");
  // 是引用，不是指令模板：不得出现指令性措辞
  for (const word of ["请", "修改", "改成", "应该", "必须", "帮我"]) {
    assert.ok(!unlocked.includes(word), "前缀不得包含指令性措辞「" + word + "」");
  }
  // 坏输入不炸：没有提案就没有前缀
  assert.equal(wbDraftPrefix(null), "");
  assert.equal(wbDraftPrefix(undefined), "");
  assert.equal(wbDraftPrefix("nope"), "");
  // 版本缺省按 1，编号缺省留空（形状仍然稳定）
  assert.equal(wbDraftPrefix({}), "关于提案 v1（）：");
  assert.equal(wbDraftPrefix({ version: 0, proposalId: "" }), "关于提案 v1（）：");
  assert.equal(wbDraftPrefix({ version: 7.5, proposalId: "p" }), "关于提案 v7（p）：", "小数版本按整数取");
  // 传入组件级 t 时走注册表文案（这里用内置中文表演练一遍注入路径）
  const injected = wbDraftPrefix(PROPOSAL, (key, vars) => WB_TEXT.zh[key].replace("{version}", vars.version).replace("{proposalId}", vars.proposalId));
  assert.equal(injected, unlocked);
});

// ── 3. wbInsertDraft 三态 ─────────────────────────────────────────────────

function inputActionsThat(insertResult) {
  const calls = { insert: [], spans: [] };
  return {
    calls,
    actions: {
      captureInsertion() { calls.spans.push({ start: 0, end: 0, draftRev: 1 }); return calls.spans[calls.spans.length - 1]; },
      insertText(text, span) { calls.insert.push([text, span]); return insertResult; }
    }
  };
}

test("带入：insertText 成功 → inserted，且插入的就是引用前缀", async () => {
  const { wbInsertDraft, wbDraftPrefix } = testApi();
  const harness = inputActionsThat(true);
  const result = await wbInsertDraft(wbDraftPrefix(PROPOSAL), harness.actions);
  assert.deepEqual(result, { state: "inserted", text: "关于提案 v2（prop-9f3c）：" });
  assert.equal(harness.calls.insert.length, 1, "只插入一次");
  assert.equal(harness.calls.insert[0][0], "关于提案 v2（prop-9f3c）：");
  assert.equal(harness.calls.spans.length, 1, "先捕获选区再插入");
  assert.equal(harness.calls.insert[0][1], harness.calls.spans[0], "span 来自 captureInsertion");
});

test("带入：insertText 被拒（revision 过期 / 不可编辑）→ 剪贴板降级", async () => {
  const { wbInsertDraft } = testApi();
  const copied = [];
  const harness = inputActionsThat(false);
  const result = await withGlobals({ clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } }, undefined, () => wbInsertDraft("关于提案 v2（prop-9f3c）：", harness.actions));
  assert.deepEqual(result, { state: "copied", text: "关于提案 v2（prop-9f3c）：" });
  assert.deepEqual(copied, ["关于提案 v2（prop-9f3c）："], "被拒必须真的写剪贴板");
  assert.equal(harness.calls.insert.length, 1, "仍然先试过一次官方 API");
});

test("带入：insertText 形状说不清（undefined / 空对象）也当被拒，文本不丢", async () => {
  const { wbInsertDraft } = testApi();
  for (const shape of [undefined, null, {}, "ok", 1]) {
    const harness = inputActionsThat(shape);
    const copied = [];
    const result = await withGlobals({ clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } }, undefined, () => wbInsertDraft("前缀", harness.actions));
    assert.equal(result.state, "copied", "形状 " + JSON.stringify(shape) + " 必须降级");
    assert.deepEqual(copied, ["前缀"]);
  }
});

test("带入：insertText 抛错（span 失效等）→ 剪贴板降级，不把异常抛给调用方", async () => {
  const { wbInsertDraft } = testApi();
  const copied = [];
  const actions = {
    captureInsertion() { return { start: 0, end: 0, draftRev: 1 }; },
    insertText() { throw new Error("editor gone"); }
  };
  const result = await withGlobals({ clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } }, undefined, () => wbInsertDraft("前缀", actions));
  assert.equal(result.state, "copied");
  assert.deepEqual(copied, ["前缀"]);
});

test("带入：insertText 返回 Promise（未来宿主形状）也按结果分三态", async () => {
  const { wbInsertDraft } = testApi();
  const okHarness = inputActionsThat(Promise.resolve(true));
  assert.deepEqual(await wbInsertDraft("前缀", okHarness.actions), { state: "inserted", text: "前缀" });
  const noHarness = inputActionsThat(Promise.resolve(false));
  const copied = [];
  const result = await withGlobals({ clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } }, undefined, () => wbInsertDraft("前缀", noHarness.actions));
  assert.equal(result.state, "copied");
  assert.deepEqual(copied, ["前缀"]);
  const boomHarness = inputActionsThat(Promise.reject(new Error("nope")));
  const copied2 = [];
  const rejected = await withGlobals({ clipboard: { writeText: (text) => { copied2.push(text); return Promise.resolve(); } } }, undefined, () => wbInsertDraft("前缀", boomHarness.actions));
  assert.equal(rejected.state, "copied");
  assert.deepEqual(copied2, ["前缀"]);
});

test("带入：没有 inputActions（main 面板）→ 直接剪贴板降级，不试官方 API", async () => {
  const { wbInsertDraft } = testApi();
  const copied = [];
  const missingShapes = [undefined, null, {}, { captureInsertion: () => ({}) }, "nope", 42];
  for (const missing of missingShapes) {
    const result = await withGlobals({ clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } }, undefined, () => wbInsertDraft("前缀", missing));
    assert.equal(result.state, "copied", JSON.stringify(missing) + " 必须降级");
  }
  assert.deepEqual(copied, missingShapes.map(() => "前缀"), "每种坏形状都真的写剪贴板");
});

test("带入：剪贴板也失败 → failed 并返回原文（让用户手动复制）", async () => {
  const { wbInsertDraft } = testApi();
  // navigator.clipboard.writeText 拒绝；document 是 harness 的桩（没有 body）→ execCommand 路径也走不通
  installDocumentStub();
  const result = await withGlobals({ clipboard: { writeText: () => Promise.reject(new Error("denied")) } }, undefined, () => wbInsertDraft("关于提案 v2（prop-9f3c）：", undefined));
  assert.deepEqual(result, { state: "failed", text: "关于提案 v2（prop-9f3c）：" }, "原文必须随结果返回");
});

test("带入：没有 navigator.clipboard 时退隐藏 textarea + execCommand", async () => {
  const { wbInsertDraft } = testApi();
  const appended = [];
  const removed = [];
  const execCalls = [];
  const body = {
    appendChild(node) { appended.push(node); node.parentNode = body; return node; },
    removeChild(node) { removed.push(node); node.parentNode = null; return node; }
  };
  const doc = {
    body,
    createElement(tag) {
      return {
        tagName: tag, value: "", style: {}, attrs: {}, parentNode: null, selected: false,
        setAttribute(key, value) { this.attrs[key] = value; },
        select() { this.selected = true; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
      };
    },
    execCommand(command) { execCalls.push(command); return true; }
  };
  const result = await withGlobals({}, doc, () => wbInsertDraft("关于提案 v2（prop-9f3c）：", undefined));
  assert.equal(result.state, "copied", "execCommand 成功也算复制成功");
  assert.deepEqual(execCalls, ["copy"]);
  assert.equal(appended.length, 1, "建了一个隐藏 textarea");
  assert.equal(appended[0].tagName, "textarea");
  assert.equal(appended[0].value, "关于提案 v2（prop-9f3c）：");
  assert.equal(appended[0].selected, true, "复制前要 select");
  assert.equal(appended[0].style.position, "fixed");
  assert.equal(appended[0].attrs["aria-hidden"], "true", "隐藏节点要对辅助技术隐身");
  assert.equal(removed.length, 1, "用完摘掉，不留 DOM 垃圾");
});

// ── 4. 目标与项目归属的纯函数 ─────────────────────────────────────────────

test("目标标题：消息首行优先，拿不到退回会话标题并注明来源，不编造", () => {
  const { wbGoalTitle } = testApi();
  assert.deepEqual(wbGoalTitle("把上线前体检做完\n第二行不重要", "素材替换方案"), { text: "把上线前体检做完", from: "message" }, "首行直接截取，不另造标题");
  assert.deepEqual(wbGoalTitle("  带空白的首行  \n第二行", "会话名"), { text: "带空白的首行", from: "message" });
  assert.deepEqual(wbGoalTitle(undefined, "素材替换方案"), { text: "素材替换方案", from: "session" }, "读不到消息首行 → 会话标题兜底");
  assert.deepEqual(wbGoalTitle("", "素材替换方案"), { text: "素材替换方案", from: "session" });
  assert.deepEqual(wbGoalTitle(undefined, "  会话名  "), { text: "会话名", from: "session" });
  assert.deepEqual(wbGoalTitle(undefined, undefined), { text: "", from: "none" }, "两手都空就明说没有，不编造");
  assert.deepEqual(wbGoalTitle(42, 42), { text: "", from: "none" }, "非字符串不能炸");
});

test("项目归属：收件箱精确匹配优先，项目列表按主会话兜底，推断不出返回空串", () => {
  const { wbGoalProjectId } = testApi();
  const inbox = { groups: [{ key: "proposals", label: "提案待确认", items: [{ proposalId: "prop-9f3c", version: 2, projectId: "proj-inbox" }] }, { key: "worker", items: [] }] };
  assert.equal(wbGoalProjectId("prop-9f3c", "s-main", inbox, { projects: [{ projectId: "proj-other", mainSessionId: "s-main" }] }), "proj-inbox", "收件箱带精确 projectId，优先");
  assert.equal(wbGoalProjectId("prop-other", "s-main", inbox, { projects: [{ projectId: "proj-other", mainSessionId: "s-main" }] }), "proj-other", "按主会话兜底");
  assert.equal(wbGoalProjectId("prop-other", "s-main", inbox, { projects: [{ projectId: "proj-x", mainSessionId: "s-another" }] }), "", "匹配不上就不猜");
  assert.equal(wbGoalProjectId("prop-other", "s-main", undefined, undefined), "");
  assert.equal(wbGoalProjectId("prop-other", "s-main", {}, []), "");
  assert.equal(wbGoalProjectId("", "s-main", inbox, { projects: [] }), "", "没有提案编号就没有归属");
  assert.equal(wbGoalProjectId(undefined, "s-main", inbox, { projects: [] }), "");
  assert.equal(wbGoalProjectId("prop-9f3c", "s-main", { groups: [{ items: [{ proposalId: "prop-9f3c", projectId: "" }] }] }, { projects: [] }), "", "空 projectId 不算归属");
});

// ── 5. 目标条组件渲染 ─────────────────────────────────────────────────────

const LEAD_SESSIONS = { ids: ["s-main"], byId: { "s-main": { title: "素材替换方案", running: true } } };

function goalProps(api, extra) {
  return Object.assign({
    t: wbZhT(api),
    sessionId: "s-main",
    leadIdOf: (id) => id,
    useSessions: () => LEAD_SESSIONS,
    inputActions: undefined
  }, extra || {});
}

test("目标条：没有提案时整个条不渲染——不占传统对话的输入区", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  const tree = render(h(api.WhaleGoalBar, goalProps(api)));
  assert.equal(tree, null, "没有提案就必须返回 null：一个空引导条不该占着每个官方对话的输入框上方");
  assert.equal(findByClass(tree, "daw-goalbar").length, 0, "不该留下空壳");
  assert.equal(buttonsOf(tree).length, 0, "更不该放按钮");
});

test("目标条：提案接口报错时也不渲染（拿不到数据就不表态）", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  api.wbCache.reset();
  // 让 /proposals 这条请求失败（5xx），模拟宿主侧报错
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  try {
    await api.wbCache.read("/proposals?leadSessionId=s-main").catch(() => {});
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
  const tree = render(h(api.WhaleGoalBar, goalProps(api)));
  assert.equal(tree, null, "读不到提案时不渲染，避免传统对话里出现一条无意义的状态条");
});

test("目标条：有提案时有目标行、提案状态行与查看/带入", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  await prime(api, { "/proposals?leadSessionId=s-main": { proposal: PROPOSAL } });
  const tree = render(h(api.WhaleGoalBar, goalProps(api)));
  const texts = [];
  collectText(tree, texts);
  const joined = texts.join("|");
  assert.ok(joined.includes("目标"), "要标出这是目标");
  assert.ok(joined.includes("素材替换方案"), "目标首行拿不到 → 退回会话标题");
  assert.ok(joined.includes("提案 v2 待确认"), "提案状态行（§49.4）");
  assert.ok(joined.includes("来源：会话标题"), "降级来源要注明，不装作消息首行");
  const buttons = buttonsOf(tree);
  assert.equal(buttons.length, 2, "查看 + 带入");
  assert.equal(buttons[0].props.children, "查看");
  assert.equal(buttons[1].props.children, "带入");
  // 会话标题来源要写进 title 属性（任务口径：title 里注明来源）
  const goalText = findByClass(tree, "daw-goalbar-text")[0];
  assert.ok(String(goalText.props.title).includes("会话标题"));
});

test("目标条：锁定后状态行显示已确认、已锁定，带入按钮 title 说明改提案请提交新提案", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  const locked = Object.assign({}, PROPOSAL, { locked: true, confirmed: { version: 2, created: [] } });
  await prime(api, { "/proposals?leadSessionId=s-main": { proposal: locked } });
  const tree = render(h(api.WhaleGoalBar, goalProps(api)));
  const texts = [];
  collectText(tree, texts);
  const joined = texts.join("|");
  assert.ok(joined.includes("已确认、已锁定"), "锁定态（§49.2）");
  assert.ok(!joined.includes("待确认"), "锁定后不再说待确认");
  const bring = buttonsOf(tree)[1];
  assert.ok(String(bring.props.title).includes("已锁定的提案，改提案请提交新提案"), "锁定提案的带入 title 要说明");
  assert.equal(bring.props.children, "带入", "锁定后前缀仍可用，按钮照旧");
});

test("目标条：没有 inputActions 时带入按钮 title 说明走剪贴板", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  await prime(api, { "/proposals?leadSessionId=s-main": { proposal: PROPOSAL } });
  const tree = render(h(api.WhaleGoalBar, goalProps(api, { inputActions: undefined })));
  const bring = buttonsOf(tree)[1];
  assert.ok(String(bring.props.title).includes("当前面板拿不到输入框，将复制到剪贴板"));
});

test("目标条：点击带入把引用前缀交给官方 inputActions（接线验证）", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  await prime(api, { "/proposals?leadSessionId=s-main": { proposal: PROPOSAL } });
  const harness = inputActionsThat(true);
  const tree = render(h(api.WhaleGoalBar, goalProps(api, { inputActions: harness.actions })));
  const bring = buttonsOf(tree)[1];
  assert.doesNotThrow(() => bring.props.onClick());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.calls.insert.length, 1, "点一次带入 = 插一次");
  assert.equal(harness.calls.insert[0][0], "关于提案 v2（prop-9f3c）：", "带进去的是引用前缀");
});

test("目标条：点查看切到工作台并定位提案卡；推断不出就不跳转、只显示状态", async () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  const fixtures = {
    "/proposals?leadSessionId=s-main": { proposal: PROPOSAL },
    "/inbox": { source: "project", projectId: null, groups: [{ key: "proposals", label: "提案待确认", items: [{ proposalId: "prop-9f3c", version: 2, projectId: "proj-whales" }] }] },
    "/projects": { projects: [{ projectId: "proj-whales", name: "鲸鱼插件上线", mainSessionId: "s-main" }] }
  };
  await prime(api, fixtures);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const path = String(url).replace("/agent-whales/api", "");
    const data = fixtures[path];
    if (data !== undefined) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: {} }) });
  };
  try {
    const tree = render(h(api.WhaleGoalBar, goalProps(api)));
    buttonsOf(tree)[0].props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(api.wbRoute.get(), { kind: "workbench", projectId: "proj-whales", tab: "canvas" }, "查看要定位到提案卡所在项目的画布");

    // 推断不出：收件箱里没有这条提案、项目列表也没有匹配主会话
    api.wbRoute.set({ kind: "list" });
    const bare = {
      "/proposals?leadSessionId=s-main": { proposal: PROPOSAL },
      "/inbox": { source: "project", projectId: null, groups: [] },
      "/projects": { projects: [{ projectId: "proj-x", mainSessionId: "s-another" }] }
    };
    await prime(api, bare);
    globalThis.fetch = (url) => {
      const path = String(url).replace("/agent-whales/api", "");
      const data = bare[path];
      if (data !== undefined) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 200, msg: "success", data: {} }) });
    };
    const tree2 = render(h(api.WhaleGoalBar, goalProps(api)));
    buttonsOf(tree2)[0].props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(api.wbRoute.get(), { kind: "list" }, "推断不出就不跳转");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    api.wbRoute.set({ kind: "list" });
  }
});

test("目标条：读不到提案（请求失败）就整个不渲染，不炸官方输入区", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  // 不灌数据：快照是初始态（error 也没有），等价于「还没有提案」
  const tree = render(h(api.WhaleGoalBar, goalProps(api)));
  assert.equal(tree, null, "读不到提案就不渲染，而不是退化成一条占地方的引导语");
  assert.equal(buttonsOf(tree).length, 0);
});

test("目标条：什么 props 都不给也能渲染（宿主没送标准 props 时不白屏）", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const api = plugin.__test;
  assert.doesNotThrow(() => render(h(api.WhaleGoalBar, {})));
  assert.doesNotThrow(() => render(h(api.WhaleGoalBar, { t: (key) => key })));
  assert.doesNotThrow(() => render(h(api.WhaleGoalBar, { useSessions: () => undefined, sessionId: "s-x" })));
});

// ── 6. apply() 注册：input.dock 叠加，不影子官方 composer ──────────────────

test("apply：注册 conversation.input.dock 目标条座位，且没有 priority", () => {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const injections = [];
  const registrations = [];
  const ctx = {
    effect(run) { return run(); },
    slots: {
      inject(key, register) { injections.push(key); registrations.push(register()); return () => {}; },
      register(options, component) { return { options, component }; }
    },
    sessions: { binding: () => undefined },
    locale: { register() { return () => {}; } }
  };
  plugin.apply(ctx);

  assert.ok(injections.includes("conversation.input.dock"), "目标条必须注册到 conversation.input.dock");
  const seat = registrations.filter((entry) => entry.options.name === "conversation.input.dock")[0];
  assert.ok(seat, "要有 input.dock 的注册记录");
  assert.equal(seat.options.id, "whales-goal", "用自己的 id，不占官方的 queue / todo");
  assert.equal(seat.options.order, 40, "排官方 QueueDock(order 20) 之后");
  assert.equal(seat.options.priority, undefined, "D2 硬约束：叠加不影子官方 composer，不得设 priority");
  assert.equal(seat.options.key, undefined, "input.dock 是 list 槽，不用 keyed 槽的 key");
  assert.equal(seat.options.locale, "agent-whales-workbench", "目标条文案走工作台命名空间");
  assert.equal(typeof seat.options.inject, "function");
  assert.equal(typeof seat.options.inject().leadIdOf, "function", "组件里要能解析 Lead");
  assert.equal(typeof seat.component, "function");
});
