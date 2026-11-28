import test from "node:test";
import assert from "node:assert/strict";
import { createMount, installDocumentStub, loadPlugin, walk } from "./harness.mjs";
import { flowLoadPlugin, flowMount } from "./flow-harness.mjs";
const ok = (data) => ({ code: 200, data });
const file = (name, at, sessions = { main: { read: 1, at } }) => ({ key: name, path: "C:/project/" + name, at, sessions });

test("文件分类：代码与配置、MD 与需求文档、图片和数据；大小写与 Windows 路径兼容", () => {
  const { wbFileCategory: category } = loadPlugin().plugin.__test;
  for (const name of ["a.PY", "src\\main.TSX", "package.json", "Dockerfile", "requirements-dev.txt", "Makefile", ".env.local", "需求.py"]) assert.equal(category(name), "code", name);
  for (const name of ["PRD.MD", "notes.markdown", "需求说明.docx", "review.PDF", "README", "验收标准.txt", "需求表.xlsx"]) assert.equal(category(name), "documents", name);
  for (const name of ["mockup.png", "data.csv", "weights.bin", "unknown", ""]) assert.equal(category(name), "other", name);
});

test("分类配额分别计算，代码多时不会挤掉 MD；共享文件计数不重复", () => {
  const { wbReferenceNodes } = loadPlugin().plugin.__test;
  const refs = { files: [...Array.from({ length: 6 }, (_, i) => file("script" + i + ".py", 100 - i)), file("PRD.md", 2, { main: { read: 1, at: 2 }, child: { ref: 1, at: 1 } }), file("验收.md", 1), file("外部.py", 200, { other: { read: 1 } })] };
  const graph = wbReferenceNodes(refs, ["main", "child"]);
  const headers = graph.nodes.filter((node) => node.kind === "file-group");
  assert.deepEqual(headers.map((node) => [node.category, node.count]), [["code", 6], ["documents", 2]]);
  assert.equal(graph.nodes.filter((node) => node.kind === "file" && !node.fold && node.category === "code").length, 4);
  assert.deepEqual(graph.nodes.filter((node) => node.category === "documents" && node.kind === "file").map((node) => node.title), ["PRD.md", "验收.md"]);
  assert.equal(graph.nodes.find((node) => node.fold).count, 2);
  assert.equal(graph.nodes.filter((node) => node.id === "file:PRD.md").length, 1);
  assert.equal(graph.edges.filter((edge) => edge.a === "file:PRD.md").length, 2);
  assert.ok(!graph.nodes.some((node) => node.id === "file:外部.py"));
});

test("单独收起分类和展开较早文件，其他类别和文件连线保持一致", () => {
  const { wbReferenceNodes } = loadPlugin().plugin.__test;
  const refs = { files: [...Array.from({ length: 6 }, (_, i) => file("code" + i + ".py", 100 - i)), file("需求.md", 1)] };
  const collapsed = wbReferenceNodes(refs, ["main"], { collapsed: { code: true } });
  assert.equal(collapsed.nodes.filter((node) => node.kind === "file" && node.category === "code").length, 0);
  assert.equal(collapsed.nodes.find((node) => node.id === "files:code").count, 6);
  assert.ok(collapsed.nodes.some((node) => node.id === "file:需求.md"));
  assert.ok(!collapsed.edges.some((edge) => edge.a.startsWith("file:code")));
  const expanded = wbReferenceNodes(refs, ["main"], { expanded: { code: true } });
  assert.equal(expanded.nodes.filter((node) => node.kind === "file" && node.category === "code").length, 6);
  assert.ok(!expanded.nodes.some((node) => node.fold));
});

test("画布节点合并实时子 agent，不重复登记成员，并保留运行态和父子地址", () => {
  const { wbCanvasNodes } = loadPlugin().plugin.__test;
  const project = { mainSessionId: "main", members: [{ sessionId: "main" }, { sessionId: "child" }], dismissed: ["removed"] };
  const rows = [{ sessionId: "main" }, { sessionId: "child", parentSessionId: "main", running: true }, { sessionId: "grand", parentSessionId: "child", running: true }, { sessionId: "removed", parentSessionId: "main", running: true }];
  const before = JSON.stringify(project);
  const nodes = wbCanvasNodes(project, [], rows, rows);
  assert.equal(nodes.filter((node) => node.id === "child").length, 1);
  assert.ok(!nodes.some((node) => node.id === "removed"));
  const grand = nodes.find((node) => node.id === "grand");
  assert.equal(grand.parentSessionId, "child");
  assert.equal(grand.online, true);
  assert.equal(grand.transient, true);
  assert.equal(JSON.stringify(project), before);
});

test("画布实时补齐子 agent、孙 agent，父子线只读，文件分类可点击收起和展开", async () => {
  installDocumentStub();
  const { shim, mount } = createMount({ effects: true });
  let roster = [{ sessionId: "main", title: "主线", live: true }];
  const opened = [], calls = [];
  const loaded = flowLoadPlugin(shim, { fetch: (url, init) => {
    const path = url.replace("/agent-whales/api", ""); calls.push({ path, init });
    if (path === "/projects/p1") return ok({ project: { projectId: "p1", mainSessionId: "main", members: [{ sessionId: "main" }], links: [] } });
    if (path === "/sessions") return ok({ sessions: [{ sessionId: "main", live: true }] });
    if (path === "/projects/p1/agents") return ok({ sessions: roster });
    if (path === "/projects/p1/references") return ok({ files: [...Array.from({ length: 6 }, (_, i) => file("code" + i + ".py", 100 - i)), file("PRD.md", 1)] });
    return ok({ nodes: {}, elements: [], tasks: [], members: [] });
  } });
  const api = loaded.plugin.__test;
  const realInterval = globalThis.setInterval, realClear = globalThis.clearInterval;
  const timers = new Map(); let timerId = 0;
  globalThis.setInterval = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => timers.delete(id);
  try {
    const view = await flowMount(mount, api, { projectId: "p1", onOpenSession: (...args) => opened.push(args) }, loaded);
    assert.ok(!view.flow().nodes.some((node) => node.id === "child"));
    roster = [...roster, { sessionId: "child", title: "子代理", parentSessionId: "main", running: true, live: true }, { sessionId: "grand", title: "孙代理", parentSessionId: "child", running: true, live: true }];
    for (const timer of timers.values()) if (timer.ms === 5000) timer.fn();
    await view.settle(10);
    const child = view.flow().nodes.find((node) => node.id === "child");
    assert.ok(child);
    assert.ok(view.flow().nodes.some((node) => node.id === "grand"));
    child.data.el.props.onDoubleClick();
    assert.deepEqual(opened, [["child", "main"]]);
    assert.equal(child.data.canConnect, false);
    assert.equal(view.flow().edges.filter((edge) => edge.data?.kind === "subagent" && edge.selectable === false).length, 2);
    const header = view.flow().nodes.find((node) => node.id === "files:code");
    header.data.el.props.children[0].props.onClick({ stopPropagation() {} });
    await view.settle();
    assert.ok(!view.flow().nodes.some((node) => node.id === "file:code0.py"));
    assert.ok(view.flow().nodes.some((node) => node.id === "file:PRD.md"));
    view.flow().nodes.find((node) => node.id === "files:code").data.el.props.children[0].props.onClick({ stopPropagation() {} });
    await view.settle();
    const folded = view.flow().nodes.find((node) => node.id === "file:+code");
    let expand;
    walk(folded.data.el, (node) => { if (node.props?.children === "展开其余 2 个文件") expand = node; });
    assert.ok(expand); expand.props.onClick({ stopPropagation() {} }); await view.settle();
    assert.ok(view.flow().nodes.some((node) => node.id === "file:code5.py"));
    assert.ok(!calls.some((call) => call.init?.method && call.init.method !== "GET"), "实时名册和分组操作不写项目");
    roster = [roster[0]];
    for (const timer of timers.values()) if (timer.ms === 5000) timer.fn();
    await view.settle(10);
    assert.ok(!view.flow().nodes.some((node) => node.id === "child"));
  } finally { api.wbCache.reset(); globalThis.setInterval = realInterval; globalThis.clearInterval = realClear; }
});
