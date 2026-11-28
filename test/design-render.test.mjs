import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMount, walk, loadPlugin } from "./harness.mjs";

const built = readFileSync(new URL("../lib/client.design.js", import.meta.url), "utf8");
function loadDesign(react = {}) {
	let chunk;
	const listeners = new Set();
	const win = {
		__ModuleLoader__: { load(value) { chunk = value; } },
		addEventListener(_type, fn) { listeners.add(fn); },
		removeEventListener(_type, fn) { listeners.delete(fn); }
	};
	new Function("window", built)(win);
	const lib = chunk.factory((spec) => spec === "react" ? react : {});
	return { lib, listeners, send(data, origin = "null") { for (const fn of listeners) fn({ origin, data }); } };
}
function fakeFrame() {
	const attrs = {};
	const messages = [];
	return { attrs, messages, setAttribute(name, value) { attrs[name] = value; }, contentWindow: { postMessage(data) { messages.push(data); } } };
}
async function initialized() {
	const context = loadDesign();
	const frame = fakeFrame();
	const host = context.lib.createSandboxHost(frame, { timeoutMs: 30 });
	const init = host.init({ runtime: "runtime" });
	const bootId = /name="whales-boot-id" content="([^"]+)"/.exec(frame.attrs.srcdoc)[1];
	context.send({ type: "booted", bootId });
	await Promise.resolve();
	const nonce = frame.messages.at(-1).nonce;
	context.send({ type: "ready", nonce, info: { hasRuntime: true } });
	assert.equal((await init).hasRuntime, true);
	return { ...context, frame, host };
}

test("沙箱初始化报错立即返回真实错误，销毁能取消启动等待", async () => {
	const context = loadDesign();
	const frame = fakeFrame();
	const host = context.lib.createSandboxHost(frame, { timeoutMs: 100 });
	const init = host.init({ runtime: "bad runtime" });
	context.send({ type: "booted", bootId: /name="whales-boot-id" content="([^"]+)"/.exec(frame.attrs.srcdoc)[1] });
	await Promise.resolve();
	context.send({ type: "error", nonce: frame.messages.at(-1).nonce, message: "runtime syntax error" });
	assert.equal((await init).error, "runtime syntax error");
	host.destroy();
	assert.equal(context.listeners.size, 0);
	const other = context.lib.createSandboxHost(fakeFrame());
	const cancelled = other.init({});
	other.destroy();
	assert.equal((await cancelled).cancelled, true);
});

test("渲染超时后仍可重试，旧 nonce 和错误来源不能完成新渲染", async () => {
	const context = await initialized();
	const { host, frame, send } = context;
	const first = await host.render({ name: "Board", code: "module.exports = () => null" });
	assert.equal(first.timeout, true);
	const oldNonce = frame.messages.at(-1).nonce;
	const second = host.render({ name: "Board", code: "new code" });
	const nonce = frame.messages.at(-1).nonce;
	send({ type: "rendered", nonce: oldNonce, ok: false });
	send({ type: "rendered", nonce, ok: false }, "https://invalid.example");
	send({ type: "rendered", nonce, ok: true, nodeCount: 12 });
	assert.equal((await second).nodeCount, 12);
	const pending = host.render({ name: "Board" });
	host.destroy();
	assert.equal((await pending).cancelled, true);
	assert.equal(context.listeners.size, 0);
});

test("画布在 50% 缩放下拖拽外框，按正确距离更新并回传尺寸", () => {
	const { mount, shim } = createMount();
	const { lib } = loadDesign(shim);
	const saved = [];
	const view = mount(lib.DesignArtboardNode, { data: { original: { artboardId: "board" }, frameSize: { w: 460, h: 320 }, onFrameResize: (w, h) => saved.push({ w, h }) } });
	const root = view.tree;
	root.props.ref.current = { offsetWidth: 460, offsetHeight: 320, getBoundingClientRect: () => ({ width: 230 }) };
	let handle;
	walk(root, (node) => { if (node.props?.["aria-label"] === "调整设计图外框大小") handle = node; });
	const event = { button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } };
	handle.props.onPointerDown(event);
	handle.props.onPointerMove({ ...event, clientX: 200, clientY: 150 });
	handle.props.onPointerUp(event);
	view.rerender();
	assert.deepEqual(saved, [{ w: 660, h: 420 }]);
	assert.equal(view.tree.props.style.width, 660);
	assert.equal(view.tree.props.style.height, 420);
});

test("外框尺寸通过现有画布位置表持久化，后续移动保留尺寸", async () => {
	const calls = [];
	const { plugin } = loadPlugin({ fetch: (url, init) => { calls.push({ url, init }); return { code: 200, data: { rev: 2 } }; } });
	const positions = plugin.__test.wbNodePositions;
	positions.hydrate("project", { rev: 1, nodes: {} });
	positions.set("project", "board:a", 20, 30, { w: 660, h: 420 });
	positions.set("project", "board:a", 40, 50);
	positions.flushNow("project");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const body = JSON.parse(calls[0].init.body);
	assert.deepEqual(body.nodes["board:a"], { x: 40, y: 50, w: 660, h: 420 });
});
