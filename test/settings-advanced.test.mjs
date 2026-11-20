// 重新规划 R5a：设置 › 高级（MCP 约束列表 + 快照导出），设置页只剩「外观」与「高级」。
// 宿主路由契约（lib/index.js，不变）：
//   GET    /projects/:id/mcp-links            → { projectId, available:[{server,toolCount}], links:[{server,sessionId}], members:[...], mainSessionId }
//   POST   /projects/:id/mcp-links {server, sessionId}
//   DELETE /projects/:id/mcp-links {server, sessionId}      DELETE ?all=1 → 一键全清
// 语义（lib/index.js mcpConstraintGuard）：会话只要连过任何 MCP 服务，就**只能**用连过的那些；一个都没连过 = 不受限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMount, installDocumentStub, loadPlugin } from "./harness.mjs";

const api = () => loadPlugin().plugin.__test;

function collect(node, out, match) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((child) => collect(child, out, match)); return; }
  if (node.props && match(node)) out.push(node);
  collect(node.props ? node.props.children : undefined, out, match);
}
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
const byClass = (tree, cls) => { const out = []; collect(tree, out, (n) => String(n.props.className || "").split(/\s+/).indexOf(cls) >= 0); return out; };
const byTag = (tree, tag) => { const out = []; collect(tree, out, (n) => n.type === tag); return out; };
const KEY = (key, vars) => "[" + key + "]" + (vars ? JSON.stringify(vars) : "");
const ok = (data) => ({ code: 200, msg: "success", data });
const tick = () => new Promise((resolve) => setImmediate(resolve));

const MCP = {
  projectId: "p1",
  available: [{ server: "github", toolCount: 12 }, { server: "notion", toolCount: 4 }],
  links: [{ server: "github", sessionId: "a" }, { server: "github", sessionId: "b" }, { server: "notion", sessionId: "a" }],
  members: [{ sessionId: "m", role: "main" }, { sessionId: "a", role: "member" }, { sessionId: "b", role: "member" }],
  mainSessionId: "m"
};

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test("wbMcpMatrix：每个成员一行，标出允许的服务与「受限 / 不受限」；服务列表带工具数；坏数据与未知成员不抛", () => {
  const { wbMcpMatrix } = api();
  const names = { m: "主线", a: "后端", b: "前端" };
  const view = wbMcpMatrix(MCP, names);
  assert.deepEqual(view.servers, [{ server: "github", toolCount: 12 }, { server: "notion", toolCount: 4 }]);
  assert.deepEqual(view.rows.map((r) => [r.sessionId, r.name, r.restricted, r.allowed]), [
    ["m", "主线", false, []],
    ["a", "后端", true, ["github", "notion"]],
    ["b", "前端", true, ["github"]]
  ], "m 没连过任何服务 = 不受限；a / b 连过 = 只能用连过的");
  assert.equal(view.restrictedCount, 2);
  assert.equal(view.linkCount, 3);
  // 主对话排第一，其余按成员顺序；没有名字用截断 id
  const noNames = wbMcpMatrix({ available: [], links: [], members: [{ sessionId: "session-1234567890abcdef" }], mainSessionId: "" }, {});
  assert.equal(noNames.rows[0].name, "session-1234");
  // 主对话永远排第一：即使它在成员表末尾，甚至不在成员表里
  const mainLast = wbMcpMatrix({ available: [], links: [], members: [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "m" }], mainSessionId: "m" }, names);
  assert.deepEqual(mainLast.rows.map((r) => r.sessionId), ["m", "a", "b"], "主对话在成员表末尾也要排第一，且不重复");
  const mainMissing = wbMcpMatrix({ available: [], links: [], members: [{ sessionId: "a" }], mainSessionId: "m" }, names);
  assert.deepEqual(mainMissing.rows.map((r) => r.sessionId), ["m", "a"], "主对话没登记进成员表也要有一行");
  // 指向已不是成员的会话的旧约束：不凭空多一行，但要计数出来（界面据此提示「有 N 条指向已离开项目的会话」）
  const stale = wbMcpMatrix({ available: MCP.available, links: [{ server: "github", sessionId: "gone" }], members: MCP.members, mainSessionId: "m" }, names);
  assert.deepEqual(stale.rows.map((r) => r.sessionId), ["m", "a", "b"]);
  assert.equal(stale.staleLinks, 1);
  // 指向「已不可用的服务」的旧约束：保留在 allowed 里（宿主仍然按它限制），否则界面会谎称不受限
  const gone = wbMcpMatrix({ available: [{ server: "github", toolCount: 1 }], links: [{ server: "removed-server", sessionId: "a" }], members: MCP.members, mainSessionId: "m" }, names);
  assert.deepEqual(gone.rows.find((r) => r.sessionId === "a").allowed, ["removed-server"]);
  assert.equal(gone.rows.find((r) => r.sessionId === "a").restricted, true, "连过一个已消失的服务：宿主仍按「只能用连过的」拦，所以仍是受限");
  assert.deepEqual(wbMcpMatrix(null, null), { servers: [], rows: [], restrictedCount: 0, linkCount: 0, staleLinks: 0 });
  assert.deepEqual(wbMcpMatrix({ available: "x", links: 5, members: {} }, {}).rows, []);
});

test("wbMcpHas：某成员是否被授权某服务；坏数据为假", () => {
  const { wbMcpHas } = api();
  assert.equal(wbMcpHas(MCP, "github", "a"), true);
  assert.equal(wbMcpHas(MCP, "notion", "b"), false);
  assert.equal(wbMcpHas(MCP, "github", "m"), false);
  assert.equal(wbMcpHas(null, "github", "a"), false);
});

// ── 设置页：只剩两个菜单 ─────────────────────────────────────────────────────

function mountSettings(fetchImpl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    const target = String(url).replace("/agent-whales/api", "");
    const method = (init && init.method) || "GET";
    calls.push({ target, method, body: init && init.body ? JSON.parse(init.body) : undefined });
    return fetchImpl(target, method, init, calls);
  };
  const { mount, shim } = createMount();
  const { plugin } = loadPlugin({ react: shim });
  installDocumentStub();
  const t = plugin.__test;
  const view = mount(t.WbSettingsPage, { t: (key, vars) => KEY(key, vars) });
  return { view, calls, t, restore: () => { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; } };
}
const json = (data, code = 200) => Promise.resolve({ ok: code === 200, status: code === 200 ? 200 : 400, json: () => Promise.resolve(code === 200 ? ok(data) : { code, msg: String(data), data: {} }) });

test("设置页：只有「外观」和「高级」两个菜单（通用 / 通知 / 关于 / 执行器说明这些只有一句话的占位页已删除）；默认进外观", async () => {
  const s = mountSettings(() => json({}));
  try {
    const menus = byTag(s.view.tree, "button").filter((b) => b.props["data-menu"] !== undefined);
    assert.deepEqual(menus.map((b) => b.props["data-menu"]), ["look", "advanced"]);
    assert.deepEqual(menus.map((b) => texts(b)), [KEY("set.menu.look"), KEY("set.menu.advanced")]);
    assert.equal(menus[0].props["data-on"], "true", "默认选中外观");
    assert.match(texts(s.view.tree), /\[set\.theme\]/, "外观里是真功能：主题");
    assert.doesNotMatch(texts(s.view.tree), /set\.menu\.(general|notify|about|worker)/);
  } finally { s.restore(); }
});

// ── 高级：MCP 约束 ──────────────────────────────────────────────────────────

async function openAdvanced(handlers) {
  const s = mountSettings((target, method, init, calls) => {
    if (target === "/projects") return json({ projects: [{ projectId: "p1", name: "项目一", mainSessionId: "m" }, { projectId: "p2", name: "项目二", mainSessionId: "x" }] });
    if (target === "/sessions") return json({ sessions: [{ sessionId: "a", title: "后端对话" }, { sessionId: "b", title: "前端对话" }, { sessionId: "m", title: "主线" }] });
    const custom = handlers && handlers(target, method, init, calls);
    if (custom) return custom;
    if (target === "/projects/p1/mcp-links") return json(MCP);
    if (target === "/projects/p2/mcp-links") return json({ projectId: "p2", available: [], links: [], members: [{ sessionId: "x", role: "main" }], mainSessionId: "x" });
    return json({});
  });
  for (const url of ["/projects", "/sessions", "/projects/p1/mcp-links", "/projects/p2/mcp-links"]) await s.t.wbCache.read(url).catch(() => {});
  s.calls.length = 0;
  const menu = () => byTag(s.view.tree, "button").find((b) => b.props["data-menu"] === "advanced");
  menu().props.onClick();
  await tick(); await tick();
  return s;
}
const mcpPanel = (tree) => byClass(tree, "daw-wb-mcp")[0];
const toggles = (tree) => byTag(tree, "input").filter((i) => i.props["data-mcp-toggle"] !== undefined);
const projectSelect = (tree) => byTag(tree, "select").find((sel) => sel.props["data-mcp-project"] !== undefined);

test("高级 · MCP 约束：先选项目；每个服务一组、每个成员一个开关，开关反映真实约束；说明里讲清「连过才受限，一个都没连 = 不受限」", async () => {
  const s = await openAdvanced();
  try {
    const sel = projectSelect(s.view.rerender());
    assert.ok(sel, "有项目选择");
    assert.equal(sel.props.value, "p1", "默认第一个项目");
    assert.deepEqual(byTag(sel, "option").map((o) => [o.props.value, texts(o)]), [["p1", "项目一"], ["p2", "项目二"]]);
    const panel = mcpPanel(s.view.rerender());
    assert.ok(panel, "MCP 约束面板在高级里");
    const all = toggles(s.view.rerender());
    // 2 个服务 × 3 个成员
    assert.equal(all.length, 6);
    const state = Object.fromEntries(all.map((i) => [i.props["data-mcp-toggle"], i.props.checked]));
    assert.deepEqual(state, { "github|m": false, "github|a": true, "github|b": true, "notion|m": false, "notion|a": true, "notion|b": false });
    const text = texts(panel);
    assert.match(text, /\[set\.mcp\.rule\]/, "有一句话讲规则");
    assert.match(text, /\[set\.mcp\.restricted\]\{"count":2\}/, "显示有几个会话受限");
    assert.match(text, /后端对话.*前端对话|前端对话.*后端对话/s, "成员显示名字");
    assert.match(text, /github.*12|12.*github/s, "服务带工具数");
  } finally { s.restore(); }
});

test("高级 · MCP 约束：打开开关 = POST {server, sessionId}；关闭 = DELETE 同样的体；成功后刷新；失败显示宿主的真原因且不改界面状态", async () => {
  const s = await openAdvanced((target, method) => {
    if (target === "/projects/p1/mcp-links" && method === "POST") return json("MCP 只能连到项目成员会话", 40710);
  });
  try {
    const on = toggles(s.view.rerender()).find((i) => i.props["data-mcp-toggle"] === "notion|b");
    on.props.onChange({ target: { checked: true } });
    await tick(); await tick();
    const post = s.calls.find((c) => c.method === "POST");
    assert.deepEqual(post, { target: "/projects/p1/mcp-links", method: "POST", body: { server: "notion", sessionId: "b" } });
    assert.match(texts(mcpPanel(s.view.rerender())), /MCP 只能连到项目成员会话/, "宿主的真原因原样显示");
    assert.equal(toggles(s.view.rerender()).find((i) => i.props["data-mcp-toggle"] === "notion|b").props.checked, false, "失败了开关不能显示成已打开（界面不撒谎）");
  } finally { s.restore(); }
  const s2 = await openAdvanced();
  try {
    // 夹具里的 useSyncExternalStore 不订阅（真 React 会），而 wbCache.invalidate 只刷新有订阅者的条目——所以手动订阅一次来模拟真 React。
    s2.t.wbCache.subscribe("/projects/p1/mcp-links", () => {});
    await tick(); await tick();
    s2.calls.length = 0; // 订阅本身会触发一次读取；清掉，才能证明「写之后」确实又读了一次
    toggles(s2.view.rerender()).find((i) => i.props["data-mcp-toggle"] === "github|a").props.onChange({ target: { checked: false } });
    await tick(); await tick();
    const delAt = s2.calls.findIndex((c) => c.method === "DELETE");
    assert.deepEqual(s2.calls[delAt], { target: "/projects/p1/mcp-links", method: "DELETE", body: { server: "github", sessionId: "a" } });
    const getAfter = s2.calls.findIndex((c, i) => i > delAt && c.method === "GET" && c.target === "/projects/p1/mcp-links");
    assert.ok(delAt >= 0 && getAfter > delAt, "写成功之后重新取一遍真相（GET 必须出现在 DELETE 之后）");
  } finally { s2.restore(); }
});

test("高级 · MCP 约束：一键全清要二次确认（点一次只进入确认态，再点才 DELETE ?all=1）；没有任何约束时不显示；切换项目读该项目的约束", async () => {
  const s = await openAdvanced();
  try {
    const clear = () => byTag(s.view.rerender(), "button").find((b) => b.props["data-mcp-clear"] !== undefined);
    assert.ok(clear(), "有约束时才有一键全清");
    clear().props.onClick();
    await tick();
    assert.equal(s.calls.filter((c) => c.method === "DELETE").length, 0, "第一次点击只是确认态，不删");
    assert.match(texts(clear()), /\[set\.mcp\.clear\.confirm\]/);
    clear().props.onClick();
    await tick(); await tick();
    const del = s.calls.find((c) => c.method === "DELETE");
    assert.equal(del.target, "/projects/p1/mcp-links?all=1");
    // 切换项目：p2 没有可用服务、没有约束
    projectSelect(s.view.rerender()).props.onChange({ target: { value: "p2" } });
    await tick(); await tick();
    const panel = texts(mcpPanel(s.view.rerender()));
    assert.match(panel, /\[set\.mcp\.empty\]/, "没有可用的 MCP 服务：说清先去 DSH 里连");
    assert.equal(toggles(s.view.rerender()).length, 0);
    assert.equal(byTag(s.view.rerender(), "button").filter((b) => b.props["data-mcp-clear"] !== undefined).length, 0, "没有约束就没有一键全清");
  } finally { s.restore(); }
});

test("高级 · MCP 约束：没有任何项目时给空态而不是空白；旧宿主没有该路由（读失败）时显示错误与重试，不白屏", async () => {
  const s = mountSettings((target) => {
    if (target === "/projects") return json({ projects: [] });
    if (target === "/sessions") return json({ sessions: [] });
    return json({});
  });
  try {
    for (const url of ["/projects", "/sessions"]) await s.t.wbCache.read(url).catch(() => {});
    byTag(s.view.tree, "button").find((b) => b.props["data-menu"] === "advanced").props.onClick();
    await tick(); await tick();
    assert.match(texts(s.view.rerender()), /\[set\.mcp\.noProject\]/);
  } finally { s.restore(); }
  const broken = await openAdvanced((target) => {
    if (target === "/projects/p1/mcp-links") return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: 404, msg: "not found" }) });
  });
  try {
    const text = texts(broken.view.rerender());
    assert.doesNotMatch(text, /undefined|NaN/);
    assert.ok(byTag(broken.view.rerender(), "button").length > 0, "页面还在，没有白屏");
  } finally { broken.restore(); }
});

// ── 高级：快照导出（从项目列表页迁来）──────────────────────────────────────────

test("高级 · 快照导出：按钮在设置里；点击走 GET /snapshot 并报告结果；项目列表页不再有导出按钮", async () => {
  const s = await openAdvanced((target) => {
    if (target === "/snapshot") return json({ files: [{ name: "projects.json", present: true, data: { a: 1 } }, { name: "canvas.json", present: false, data: null }] });
  });
  try {
    const exportBtn = () => byTag(s.view.rerender(), "button").find((b) => b.props["data-export-snapshot"] !== undefined);
    assert.ok(exportBtn(), "高级里有导出快照按钮");
    assert.equal(texts(exportBtn()), KEY("list.export"));
    exportBtn().props.onClick();
    await tick(); await tick();
    assert.ok(s.calls.some((c) => c.target === "/snapshot"), "走 GET /snapshot");
    // 导出结果的提示（在无 DOM 下载环境里 wbDownloadFile 会失败，界面必须如实报失败而不是假装成功）
    const results = byClass(s.view.rerender(), "daw-wb-note").map(texts).filter((x) => /list\.export\.(busy|done|failed)/.test(x));
    assert.equal(results.length, 1, "导出结果提示恰好出现一次（说明文字 list.export.desc 不算）");
    assert.match(results[0], /list\.export\.(done|failed)/, "已经不是「正在打包」，必须落到成功或失败之一");
  } finally { s.restore(); }
  // 项目列表页：不再有导出按钮
  const original = globalThis.fetch;
  globalThis.fetch = () => json({ projects: [], inbox: {} });
  try {
    const { mount, shim } = createMount();
    const { plugin } = loadPlugin({ react: shim });
    installDocumentStub();
    const list = mount(plugin.__test.WbProjectList, { t: (key, vars) => KEY(key, vars) });
    const labels = byTag(list.tree, "button").map(texts);
    assert.ok(!labels.includes(KEY("list.export")), "项目列表页不再有导出快照按钮（已迁到 设置 › 高级）");
  } finally { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; }
});

test("设置 · 文案键中英都有", () => {
  const t = api();
  for (const key of ["set.menu.advanced", "set.mcp.title", "set.mcp.rule", "set.mcp.restricted", "set.mcp.unrestricted", "set.mcp.empty", "set.mcp.noProject", "set.mcp.project", "set.mcp.clear", "set.mcp.clear.confirm", "set.mcp.cleared", "set.mcp.stale", "set.snapshot.title"]) {
    assert.ok(t.WB_TEXT.zh[key] && t.WB_TEXT.en[key], key);
  }
  assert.match(t.WB_TEXT.zh["set.mcp.rule"], /只能用|只能使用/, "规则文案要讲清「连过就只能用连过的」");
  assert.match(t.WB_TEXT.zh["set.mcp.rule"], /没有连过|一个都没连|不受限/, "也要讲清「一个都没连 = 不受限」");
  assert.match(t.WB_TEXT.en["set.mcp.rule"], /only/i);
  assert.match(t.WB_TEXT.en["set.mcp.rule"], /unrestricted|no restriction|not restricted/i);
});

test("设置页文案是纯文本：任何新增文案都不能带 Markdown 记号（真机截图发现 **加粗** 被原样显示成星号）", () => {
  const t = api();
  const keys = Object.keys(t.WB_TEXT.zh).filter((k) => /^set\./.test(k) || /^req\.owner/.test(k));
  assert.ok(keys.length >= 20, "要真的扫到一批文案，而不是空转");
  for (const lang of ["zh", "en"]) {
    for (const key of keys) {
      const text = t.WB_TEXT[lang][key];
      if (typeof text !== "string") continue;
      assert.doesNotMatch(text, /\*\*|__[A-Za-z]|`/, lang + " " + key + " 含 Markdown 记号，界面不渲染 Markdown，会原样显示：" + text);
    }
  }
});