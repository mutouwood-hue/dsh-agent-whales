// 组件工坊 P3：导出 / 导入自包含 HTML（设计方案 §12，安全约束见 §13）。
//
// 三条硬约束必测：
//   ① 受控组件包（UNLICENSED）**默认不内嵌**代码，只有人显式 includeCode 才带；
//   ② 导入**只解析 JSON 段，绝不执行文件里的脚本**；
//   ③ 未知 formatVersion 直接拒（不做「尽力而为」的兼容）。
import test from "node:test";
import assert from "node:assert/strict";
import { buildExportHtml, parseExportHtml, planImport, uniqueImportName, EXPORT_FORMAT, EXPORT_FORMAT_VERSION, isKnownFormatVersion } from "../lib/design/transfer.js";

const COMPONENT = { name: "ApprovalTimeline", title: "审批时间线", source: 'import { Badge } from "@cds";\nexport default function ApprovalTimeline(){ return <div/>; }', imports: [] };
const BOARD = { artboardId: "approval-page", title: "审批页", width: "desktop", source: "export default function Board(){ return <div/>; }", links: ["next-page"] };

function baseInput(overrides) {
	return Object.assign({
		components: [COMPONENT],
		artboards: [BOARD],
		entry: { kind: "component", id: "ApprovalTimeline", title: "审批时间线" },
		pack: { id: "shadcn", version: "", license: "MIT", controlled: false, bundle: "BUILTIN_BUNDLE", styles: ".x{}", includeCode: false },
		runtime: "RUNTIME_TEXT",
		srcdoc: "<!doctype html><html></html>",
		compiled: { ApprovalTimeline: "module.exports={default:function(){}}", "approval-page": "module.exports={default:function(){}}" },
		pluginVersion: "0.25.0"
	}, overrides || {});
}

test("导出：产物是一个自包含 HTML，带 format / formatVersion / entry / 组件与画板清单", () => {
	const html = buildExportHtml(baseInput());
	assert.match(html, /^<!doctype html>/i);
	assert.match(html, /<script type="application\/vnd\.whales\.design\+json" id="whales-design">/);
	const parsed = parseExportHtml(html);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.payload.format, EXPORT_FORMAT);
	assert.equal(parsed.payload.formatVersion, EXPORT_FORMAT_VERSION);
	assert.deepEqual(parsed.payload.entry, { kind: "component", id: "ApprovalTimeline", title: "审批时间线" });
	assert.deepEqual(parsed.payload.components.map((row) => row.name), ["ApprovalTimeline"]);
	assert.deepEqual(parsed.payload.artboards.map((row) => row.artboardId), ["approval-page"]);
	assert.equal(parsed.payload.components[0].source, COMPONENT.source, "源码要原样带上（这是交给开发的真实 TSX）");
});

test("导出：受控组件包（UNLICENSED）**默认不内嵌代码**；人显式 includeCode 才带", () => {
	const controlled = baseInput({ pack: { id: "cds", version: "3.0.8", license: "UNLICENSED", controlled: true, bundle: "SECRET_CDS_BUNDLE", styles: "", includeCode: false } });
	const html = buildExportHtml(controlled);
	assert.equal(html.includes("SECRET_CDS_BUNDLE"), false, "默认绝不能把受控包代码写进文件");
	const parsed = parseExportHtml(html);
	assert.equal(parsed.payload.pack.controlled, true);
	assert.equal(parsed.payload.pack.embedded, false);

	const withCode = buildExportHtml(baseInput({ pack: { id: "cds", version: "3.0.8", license: "UNLICENSED", controlled: true, bundle: "SECRET_CDS_BUNDLE", styles: "", includeCode: true } }));
	assert.equal(withCode.includes("SECRET_CDS_BUNDLE"), true, "人明确要求时才可以带");
	assert.equal(parseExportHtml(withCode).payload.pack.embedded, true);
});

test("导出：宽松许可的包（内置 shadcn，MIT）总能带代码，不受 includeCode 影响", () => {
	const html = buildExportHtml(baseInput());
	assert.equal(html.includes("BUILTIN_BUNDLE"), true);
	assert.equal(parseExportHtml(html).payload.pack.embedded, true);
});

test("导出：源码里的 </script> 不能把 JSON 段提前闭合（防注入）", () => {
	const evil = buildExportHtml(baseInput({ components: [{ name: "EvilCard", source: 'const x = "</script><script>alert(1)</script>";' }] }));
	assert.equal(/<\/script><script>alert/.test(evil), false, "必须被转义");
	// 而且解析回来仍然是原文
	const parsed = parseExportHtml(evil);
	assert.equal(parsed.ok, true);
	assert.match(parsed.payload.components[0].source, /<\/script><script>alert\(1\)<\/script>/);
});

test("导入：只解析 JSON 段——文件里的脚本一律不执行（这里没有执行环境，验的是「解析结果里没有任何副作用字段」）", () => {
	const html = '<!doctype html><html><body><script>globalThis.__PWNED = true;<\/script>'
		+ '<script type="application/vnd.whales.design+json" id="whales-design">' + JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1, components: [COMPONENT], artboards: [] }) + "<\/script>"
		+ "</body></html>";
	const parsed = parseExportHtml(html);
	assert.equal(parsed.ok, true);
	assert.equal(globalThis.__PWNED, undefined, "导入绝不能执行文件里的脚本");
});

test("导入：不是导出文件 / JSON 坏 / format 不认识 / 版本不认识 / 空内容 都明确拒", () => {
	assert.match(parseExportHtml("<html><body>hello</body></html>").reason, /不是组件工坊导出的文件/);
	assert.match(parseExportHtml('<script id="whales-design">{bad json</script>').reason, /不是合法 JSON/);
	assert.match(parseExportHtml('<script id="whales-design">{"format":"other"}</script>').reason, /不是 whales-design 格式/);
	const wrongVersion = '<script id="whales-design">' + JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 99, components: [COMPONENT] }) + "</script>";
	assert.match(parseExportHtml(wrongVersion).reason, /不认识的格式版本 99/);
	const empty = '<script id="whales-design">' + JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1, components: [], artboards: [] }) + "</script>";
	assert.match(parseExportHtml(empty).reason, /没有组件也没有画板/);
	assert.equal(isKnownFormatVersion(1), true);
	assert.equal(isKnownFormatVersion("1"), true, "字符串 '1' 也认（JSON 里可能被写成字符串）");
	assert.equal(isKnownFormatVersion(2), false);
});

test("导入计划：重名给 rename 建议；用了 @cds 但组件包不一致 / 未内嵌 都算缺口", () => {
	const payload = parseExportHtml(buildExportHtml(baseInput({ pack: { id: "cds", version: "3.0.8", license: "UNLICENSED", controlled: true, bundle: "", styles: "", includeCode: false } }))).payload;
	const plan = planImport(payload, { existingNames: ["ApprovalTimeline", "approval-page"], packId: "shadcn" });
	assert.deepEqual(plan.conflicts, [
		{ kind: "component", id: "ApprovalTimeline", action: "rename" },
		{ kind: "artboard", id: "approval-page", action: "rename" }
	]);
	assert.ok(plan.gaps.some((text) => /用的是组件包「cds」/.test(text)), "包不一致要提示");
	assert.ok(plan.gaps.some((text) => /不含组件包代码/.test(text)), "未内嵌要提示");
	// 没有冲突时不报
	const clean = planImport(payload, { existingNames: [], packId: "cds" });
	assert.deepEqual(clean.conflicts, []);
});

test("导入计划：非法条目进 warnings，不静默吞", () => {
	const payload = { format: EXPORT_FORMAT, formatVersion: 1, components: [{ name: "" }, { name: "OkCard", source: "x" }], artboards: [{ artboardId: "" }] };
	const plan = planImport(payload, {});
	assert.equal(plan.warnings.length, 2);
	assert.deepEqual(plan.conflicts, []);
});

test("重名改名：保持 PascalCase，且不会撞到已有名字", () => {
	assert.equal(uniqueImportName("ApprovalTimeline", []), "ApprovalTimeline");
	assert.equal(uniqueImportName("ApprovalTimeline", ["ApprovalTimeline"]), "ApprovalTimeline2");
	assert.equal(uniqueImportName("ApprovalTimeline", ["ApprovalTimeline", "ApprovalTimeline2"]), "ApprovalTimeline3");
	assert.equal(uniqueImportName("bad-name!", []), "Badname", "非字母数字要去掉");
	assert.equal(uniqueImportName("", []), "Component");
});
