/** DSH 右侧栏画布入口保留；只去掉画布内容内部的侧栏。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDocumentStub, loadPlugin } from "./harness.mjs";

function setup({ deferredTabs = false } = {}) {
  const { plugin } = loadPlugin();
  installDocumentStub();
  const registrations = [];
  const tabTypes = [];
  const opened = [];
  const selected = [];
  const registry = { register(type) { tabTypes.push(type); return () => {}; } };
  let registerTabs;
  plugin.apply({
    effect(run) { return run(); },
    slots: {
      inject(key, register) { registrations.push(register()); return () => {}; },
      register(options, component) { return { options, component }; }
    },
    locale: { register() { return () => {}; } },
    sessions: { binding: () => undefined },
    ...(deferredTabs && { inject(deps, register) {
      if (deps.includes("sidebarRightTabs")) registerTabs = register;
    } }),
    get(name) {
      if (name === "sidebarRightTabs" && !deferredTabs) return registry;
      if (name === "sidebarRight") return { openTab(kind) { opened.push(kind); } };
      if (name === "layout") return { selectPanel(panel) { selected.push(panel); return true; } };
      return undefined;
    }
  });
  return { api: plugin.__test, registrations, tabTypes, opened, selected, provideTabs: () => registerTabs({ sidebarRightTabs: registry }) };
}

test("保留 DSH 右侧栏画布 body 与 guide 注册", () => {
  const { registrations, tabTypes } = setup();
  const seat = registrations.find((row) => row.options.name === "sidebar.right.pane.tab");
  assert.ok(seat, "右侧栏画布 body 要注册");
  assert.equal(seat.options.key, "agent-whales-canvas");
  assert.equal(tabTypes.length, 1);
  assert.equal(tabTypes[0].kind, "whales-canvas");
  assert.ok(tabTypes[0].guide.some((entry) => entry.id === "whales-canvas"));
});

test("宿主晚于插件提供右侧栏注册表时仍注册画布", () => {
  const { tabTypes, provideTabs } = setup({ deferredTabs: true });
  assert.equal(tabTypes.length, 0);
  provideTabs();
  assert.equal(tabTypes[0]?.kind, "whales-canvas");
});

test("打开画布优先走 DSH 右侧栏，不切主面板", () => {
  const { api, opened, selected } = setup();
  assert.equal(api.wbOpenCanvasInRightSidebar("proj-side"), true);
  assert.deepEqual(opened, ["whales-canvas"]);
  assert.deepEqual(selected, []);
  assert.deepEqual(api.wbRoute.get(), { kind: "workbench", projectId: "proj-side", tab: "canvas" });
});
