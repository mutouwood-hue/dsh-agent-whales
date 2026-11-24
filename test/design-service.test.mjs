// 组件工坊 P1：设计服务（设计方案 §5.2 / §8.1 / §8.3 / §11）。
//
// 服务把「落盘 + 编译 + 画布元素同步 + 渲染回报」收成一套规则，工具与 HTTP 路由共用——这组用例守的就是
// 「两条入口不会各写一份校验」以及几条只有真跑才看得出的边界（锁先于写、unverified 不许假装渲染过）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignService, normalizePropsSchema, normalizeExamples } from "../lib/design/service.js";

/** 假画布：内存元素表 + rev CAS（与宿主的 applyCanvasElements 同口径）。 */
function fakeCanvas() {
	const pages = new Map();
	const readPage = (projectId) => pages.get(projectId) || { rev: 0, elements: {} };
	const apply = async (projectId, change) => {
		const page = readPage(projectId);
		if (change.expectedRevision !== page.rev) {
			const error = new Error("canvas revision conflict");
			error.canvasCode = 40902;
			throw error;
		}
		const elements = Object.assign({}, page.elements);
		for (const element of change.upsert || []) elements[element.id] = element;
		for (const id of change.remove || []) delete elements[id];
		pages.set(projectId, { rev: page.rev + 1, elements: elements });
		return { rev: page.rev + 1, elements: Object.values(elements), locked: [], rejected: [] };
	};
	return { readPage, apply, pages };
}

async function withService(run) {
	const root = mkdtempSync(join(tmpdir(), "aw-design-svc-"));
	const canvas = fakeCanvas();
	const service = createDesignService({ designRoot: () => root, canvas: canvas });
	try { return await run({ root, canvas, service }); } finally { rmSync(root, { recursive: true, force: true }); }
}

const SOURCE = `import { Button } from "@cds";
export const examples = [{ label: "同意" }, { label: "退回" }];
export default function ApprovalTimeline({ label }: { label?: string }) {
  return (<div className="flex flex-col gap-4 p-5"><h2>{label || "审批时间线"}</h2><Button variant="primary">确定</Button></div>);
}
`;

test("写组件：编译成功 → 落盘 + 画布元素（元素只存引用，不存源码）", async () => withService(async ({ canvas, service }) => {
	const out = await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", title: "审批时间线", source: SOURCE, by: "agent", sessionId: "s1", hasPack: true });
	assert.equal(out.written, true);
	assert.equal(out.id, "ApprovalTimeline");
	assert.equal(out.elementId, "comp:ApprovalTimeline");
	assert.equal(out.compile.ok, true);
	assert.ok(out.compile.jsxCount >= 3);

	const element = canvas.readPage("p1").elements["comp:ApprovalTimeline"];
	assert.equal(element.kind, "component");
	assert.equal(element.data.name, "ApprovalTimeline");
	assert.equal(element.data.title, "审批时间线");
	assert.equal(element.data.examplesCount, 2, "源码里的 export const examples 要被识别");
	assert.equal("source" in element.data, false, "元素里绝不能放源码（16KB 上限与泄露面）");
	assert.ok(typeof element.data.sourceHash === "string" && element.data.sourceHash.length > 0);
}));

test("写组件：编译失败 → **不落盘、不动画布**（半个文件比没有更糟）", async () => withService(async ({ canvas, service }) => {
	const out = await service.writeDesign("p1", { kind: "component", name: "Broken", source: "export default function Broken() { return <div><span></div>; }", by: "agent", hasPack: true });
	assert.equal(out.written, false);
	assert.equal(out.compile.ok, false);
	assert.ok(out.compile.errors.length >= 1);
	assert.equal(canvas.readPage("p1").elements["comp:Broken"], undefined, "画布上不能出现半个组件");
	assert.deepEqual(service.componentNames("p1"), [], "磁盘上也不能有");
}));

test("锁：人改过（userEdited）→ 返回 locked 且**不落盘**", async () => withService(async ({ canvas, service }) => {
	await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", source: SOURCE, by: "agent", hasPack: true });
	canvas.readPage("p1").elements["comp:ApprovalTimeline"].userEdited = true;
	const before = service.getDesign("p1", "component", "ApprovalTimeline").source;

	const out = await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", source: SOURCE.replace("同意", "换个字"), by: "agent", hasPack: true });
	assert.equal(out.written, false);
	assert.equal(out.locked, true);
	assert.match(out.reason, /锁定/);
	assert.equal(service.getDesign("p1", "component", "ApprovalTimeline").source, before, "锁定时源码一个字都不能变");

	// 人自己改（by=user）不受锁影响
	const human = await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", source: SOURCE, by: "user", hasPack: true });
	assert.equal(human.written, true, "人改自己锁住的组件是允许的");
}));

test("propsSchema / examples 校验：类型不在白名单、select 没 options、例子太多都拒", () => {
	assert.throws(() => normalizePropsSchema({ a: { type: "color" } }), /只能是/);
	assert.throws(() => normalizePropsSchema({ a: { type: "select" } }), /必须给非空 options/);
	assert.throws(() => normalizePropsSchema({ "bad key": { type: "text" } }), /合法标识符/);
	assert.deepEqual(normalizePropsSchema({ a: { type: "text", label: "标题" } }), { a: { type: "text", label: "标题" } });
	assert.equal(normalizePropsSchema(undefined), undefined);
	assert.throws(() => normalizeExamples(new Array(9).fill({})), /最多/);
	assert.deepEqual(normalizeExamples([{ a: 1 }]), [{ a: 1 }]);
});

test("画板：带 requirementId / width / links；元素 data 里是需求归属与跳转关系", async () => withService(async ({ canvas, service }) => {
	const out = await service.writeDesign("p1", {
		kind: "artboard",
		artboardId: "import-flow-1",
		title: "导入 · 上传",
		source: 'export default function Board({ navigate }) { return <div className="p-5"><button onClick={() => navigate("import-flow-2")}>下一步</button></div>; }',
		width: "mobile",
		requirementId: "req-a",
		links: ["import-flow-2"],
		by: "agent",
		hasPack: true
	});
	assert.equal(out.written, true);
	assert.equal(out.elementId, "board:import-flow-1");
	const element = canvas.readPage("p1").elements["board:import-flow-1"];
	assert.equal(element.kind, "artboard");
	assert.equal(element.data.width, "mobile");
	assert.equal(element.data.requirementId, "req-a");
	assert.deepEqual(element.data.links, ["import-flow-2"]);
}));

test("@project 依赖：写 A 后能写引用 A 的 B；B 记下 uses=[A]，A 记下 usedBy=[B]；删被引用的 A 被拒", async () => withService(async ({ service }) => {
	await service.writeDesign("p1", { kind: "component", name: "StatCard", source: 'export default function StatCard() { return <div className="p-4">卡</div>; }', by: "agent", hasPack: true });
	const b = await service.writeDesign("p1", {
		kind: "component",
		name: "ApprovalTimeline",
		source: 'import StatCard from "@project/StatCard"; export default function ApprovalTimeline() { return <div><StatCard /></div>; }',
		by: "agent",
		hasPack: true
	});
	assert.equal(b.written, true, JSON.stringify(b.compile));
	assert.deepEqual(b.uses, ["StatCard"]);
	const listed = service.listDesign("p1");
	const stat = listed.components.find((row) => row.name === "StatCard");
	assert.deepEqual(stat.usedBy, ["ApprovalTimeline"], "被引用关系要能列出来（删之前要提示）");

	await assert.rejects(() => service.removeDesign("p1", "component", "StatCard"), /被 ApprovalTimeline 用到/);
	const forced = await service.removeDesign("p1", "component", "StatCard", { force: true });
	assert.equal(forced.removed, true);
}));

test("getDesign：不给 jsxTable 全文（meta 太大），但定位表可用；contextOf 把 wsrc 换成行列 + 源码片段", async () => withService(async ({ service }) => {
	await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", source: SOURCE, by: "agent", hasPack: true });
	const got = service.getDesign("p1", "component", "ApprovalTimeline");
	assert.equal("jsxTable" in got.meta, false, "meta 里不带 jsxTable（避免每次读写都塞一遍）");
	assert.ok(Array.isArray(got.jsxTable) && got.jsxTable.length > 0, "但定位表要单独给");
	const h2 = got.jsxTable.find((row) => row.tag === "h2");
	const context = service.contextOf("p1", "component", "ApprovalTimeline", h2.wsrc);
	assert.equal(context.line, h2.line);
	assert.equal(context.tag, "h2");
	assert.match(context.snippet, /<h2/);
	assert.throws(() => service.contextOf("p1", "component", "ApprovalTimeline", "e999"), /找不到了/);
}));

test("渲染回报：没有在线画布 → unverified + visual=unavailable（绝不假装渲染过）", async () => withService(async ({ service }) => {
	await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", source: SOURCE, by: "agent", hasPack: true });
	const report = await service.renderReport("p1", "component", "ApprovalTimeline");
	assert.equal(report.status, "unverified");
	assert.equal(report.visual, "unavailable");
	assert.match(report.note, /未在浏览器里渲染验证/);
}));

test("渲染回报：有在线画布时按回报给 ok / error / timeout 三种状态", async () => {
	const root = mkdtempSync(join(tmpdir(), "aw-design-live-"));
	const canvas = fakeCanvas();
	let mode = "ok";
	const service = createDesignService({
		designRoot: () => root,
		canvas: canvas,
		live: {
			request: async () => {
				if (mode === "ok") return { timeout: false, ok: true, ms: 12, width: 1024, height: 640, nodeCount: 20, textLength: 30, textSample: "审批时间线", buttons: 1, inputs: 0, tables: 0, empty: false };
				if (mode === "error") return { timeout: false, ok: false, error: "Cannot read properties of undefined", consoleErrors: ["x"] };
				return { timeout: true };
			}
		}
	});
	try {
		await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", source: SOURCE, by: "agent", hasPack: true });
		const ok = await service.renderReport("p1", "component", "ApprovalTimeline");
		assert.equal(ok.status, "ok");
		assert.equal(ok.dom.nodeCount, 20);
		assert.equal(ok.visual, "unavailable", "状态 ok 也要说清拿不到图");

		mode = "error";
		const bad = await service.renderReport("p1", "component", "ApprovalTimeline");
		assert.equal(bad.status, "error");
		assert.match(bad.error, /undefined/);

		mode = "timeout";
		const slow = await service.renderReport("p1", "component", "ApprovalTimeline", { timeoutMs: 100 });
		assert.equal(slow.status, "unverified");
		assert.equal(slow.reason, "timeout");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("落盘内容与源码一致（服务层不偷偷改写源码）", async () => withService(async ({ service }) => {
	await service.writeDesign("p1", { kind: "component", name: "ApprovalTimeline", source: SOURCE, by: "agent", hasPack: true });
	const got = service.getDesign("p1", "component", "ApprovalTimeline");
	assert.equal(got.source, SOURCE);
	// 源码里不带 data-wsrc（那是编译期注入的，改了源码会污染人的编辑体验）
	assert.doesNotMatch(got.source, /data-wsrc/);
}));

test("组件包判定：摆了组件库节点就用它，没有就是内置 shadcn；manifest.raw=false 时 @cds 要被拒", async () => withService(async ({ canvas, service }) => {
	assert.equal(service.packSupportsRaw("p1"), false, "没有组件库节点时按「不支持 raw」保守处理");
	assert.equal(service.packIdOf("p1"), "", "没有组件库节点时用内置包");

	canvas.pages.set("p1", { rev: 1, elements: { "lib:1": { id: "lib:1", kind: "library", data: { packId: "cds" } } } });
	assert.equal(service.packIdOf("p1"), "cds");
	assert.equal(service.packSupportsRaw("p1"), true, "摆了非内置组件库就认为支持 raw（真实 raw 由调用方从 manifest 传进来）");
}));
