// 组件工坊 P1：落盘与锁（设计方案 §5.1 / §5.2）。
//
// 三条纪律必测：① 先判锁再写文件（锁定时文件一个字节都不能变）；② 路径穿越一律拒；
// ③ 编译失败不落盘（半个文件比没有更糟）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	designEntityDir, designProjectDir, listEntities, readEntity, writeEntity, removeEntity,
	buildUsageMap, designSummary, readComments, writeComments, DESIGN_LIMITS, COMPONENT_NAME_RE, ARTBOARD_ID_RE
} from "../lib/design/store.js";

function withRoot(run) {
	const root = mkdtempSync(join(tmpdir(), "aw-design-store-"));
	try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const SOURCE = 'export default function StatCard() { return <div className="p-4">卡</div>; }';

test("落盘：组件与画板各有源码 / 编译产物 / meta；列举只认合法名字", () => withRoot((root) => {
	const pid = "project-1";
	writeEntity(root, pid, "component", "StatCard", { source: SOURCE, compiled: "module.exports={};", meta: { title: "指标卡", imports: [] } });
	writeEntity(root, pid, "artboard", "import-flow-1", { source: "<div/>", compiled: "x", meta: { title: "导入", imports: ["StatCard"] } });
	const dir = designEntityDir(root, pid, "component", "StatCard");
	for (const file of ["source.tsx", "compiled.js", "meta.json"]) assert.equal(existsSync(join(dir, file)), true, file);
	assert.equal(readFileSync(join(dir, "source.tsx"), "utf8"), SOURCE);

	assert.deepEqual(listEntities(root, pid, "component").map((row) => row.id), ["StatCard"]);
	assert.deepEqual(listEntities(root, pid, "artboard").map((row) => row.id), ["import-flow-1"]);
	const read = readEntity(root, pid, "component", "StatCard");
	assert.equal(read.meta.title, "指标卡");
	assert.equal(read.source, SOURCE);

	// 目录里塞一个不合规的名字：列举要跳过（不信任磁盘上的任何东西）
	mkdirSync(join(designProjectDir(root, pid), "components", "not-pascal"), { recursive: true });
	writeFileSync(join(designProjectDir(root, pid), "components", "not-pascal", "meta.json"), "{}", "utf8");
	assert.deepEqual(listEntities(root, pid, "component").map((row) => row.id), ["StatCard"], "非法名字一律忽略");
}));

test("锁：locked=true 时**不落盘**（文件内容逐字不变），并给 DESIGN_LOCKED 让人能识别", () => withRoot((root) => {
	const pid = "p2";
	writeEntity(root, pid, "component", "ApprovalTimeline", { source: "原版", compiled: "old", meta: { title: "审批" } });
	const file = join(designEntityDir(root, pid, "component", "ApprovalTimeline"), "source.tsx");
	const before = readFileSync(file, "utf8");
	assert.throws(
		() => writeEntity(root, pid, "component", "ApprovalTimeline", { locked: true, source: "被 agent 改写", compiled: "new" }),
		(error) => error.code === "DESIGN_LOCKED" && /人改过/.test(error.message)
	);
	assert.equal(readFileSync(file, "utf8"), before, "锁定后一个字节都不能变");
}));

test("路径穿越：组件名 / 画板 id / projectId 任何一项不合规都拒，且不产生越界路径", () => withRoot((root) => {
	for (const bad of ["../evil", "../../etc/passwd", "a/b", "lowercase", "", "A".repeat(50), "..\\..\\x", "Name With Space"]) {
		assert.throws(() => designEntityDir(root, "p", "component", bad), /PascalCase/, "组件名 " + JSON.stringify(bad));
	}
	for (const bad of ["../x", "UPPER", "", "a".repeat(40), "a/b", "with space"]) {
		assert.throws(() => designEntityDir(root, "p", "artboard", bad), /画板 id/, "画板 id " + JSON.stringify(bad));
	}
	for (const bad of ["../etc", "a/b", "", ".."]) {
		assert.throws(() => designEntityDir(root, bad, "component", "Ok"), /projectId/, "projectId " + JSON.stringify(bad));
	}
	const good = designEntityDir(root, "proj-1", "component", "StatCard");
	assert.ok(good.startsWith(designProjectDir(root, "proj-1")), "合法路径仍在项目目录下");
}));

test("上限：组件源码 / 编译产物超限拒；每项目组件数超限拒（改已有实体不受数量限制）", () => withRoot((root) => {
	const pid = "p3";
	assert.throws(() => writeEntity(root, pid, "component", "Big", { source: "x".repeat(DESIGN_LIMITS.sourceBytes + 1), compiled: "" }), /源码超过/);
	assert.throws(() => writeEntity(root, pid, "component", "Big", { source: "x", compiled: "y".repeat(DESIGN_LIMITS.compiledBytes + 1) }), /编译产物超过/);

	for (let i = 0; i < DESIGN_LIMITS.componentsPerProject; i += 1) {
		writeEntity(root, pid, "component", "C" + i, { source: "x", compiled: "y" });
	}
	assert.equal(listEntities(root, pid, "component").length, DESIGN_LIMITS.componentsPerProject);
	assert.throws(() => writeEntity(root, pid, "component", "OneMore", { source: "x", compiled: "y" }), /已经满了/);
	// 已有的还能改
	assert.doesNotThrow(() => writeEntity(root, pid, "component", "C0", { source: "x2", compiled: "y2" }));
}));

test("引用关系：buildUsageMap 给出「谁 import 了谁」；removeEntity 删目录（幂等）", () => withRoot((root) => {
	const pid = "p4";
	writeEntity(root, pid, "component", "StatCard", { source: "a", compiled: "b", meta: { imports: [] } });
	writeEntity(root, pid, "component", "ApprovalTimeline", { source: "a", compiled: "b", meta: { imports: ["StatCard"] } });
	writeEntity(root, pid, "artboard", "board-1", { source: "a", compiled: "b", meta: { imports: ["ApprovalTimeline", "StatCard"] } });
	const usage = buildUsageMap(root, pid);
	assert.deepEqual(usage.uses.StatCard.sort(), ["ApprovalTimeline", "board-1"]);
	assert.deepEqual(usage.uses.ApprovalTimeline, ["board-1"]);
	assert.deepEqual(usage.of.ApprovalTimeline, ["StatCard"]);

	assert.equal(removeEntity(root, pid, "artboard", "board-1"), true);
	assert.equal(removeEntity(root, pid, "artboard", "board-1"), false, "再删一次不报错");
	assert.equal(listEntities(root, pid, "artboard").length, 0);
}));

test("meta 里不放 undefined；writeEntity 写出来的 meta.json 一定是合法 JSON", () => withRoot((root) => {
	const pid = "p5";
	writeEntity(root, pid, "component", "Meta", { source: "x", compiled: "y", meta: { title: "t", description: undefined } });
	const meta = JSON.parse(readFileSync(join(designEntityDir(root, pid, "component", "Meta"), "meta.json"), "utf8"));
	assert.equal("description" in meta, false, "undefined 字段不能落盘");
	assert.equal(meta.name, "Meta");
	assert.equal(meta.title, "t");
	assert.ok(typeof meta.updatedAt === "string" && meta.updatedAt.length > 0);
}));

test("评论钉：整表读写，坏文件当空表（不让一处损坏毁掉整个功能）", () => withRoot((root) => {
	const pid = "p6";
	assert.deepEqual(readComments(root, pid), []);
	const written = writeComments(root, pid, [{ id: "c1", status: "open", body: "这里换个颜色" }]);
	assert.equal(written.length, 1);
	assert.deepEqual(readComments(root, pid).map((row) => row.id), ["c1"]);
	writeFileSync(join(designProjectDir(root, pid), "comments.json"), "{ not json", "utf8");
	assert.deepEqual(readComments(root, pid), [], "坏文件返回空表");
}));

test("统计：designSummary 给出组件数 / 画板数 / 最近更新时间", () => withRoot((root) => {
	const pid = "p7";
	assert.deepEqual(designSummary(root, pid), { components: 0, artboards: 0, latestUpdatedAt: "" });
	writeEntity(root, pid, "component", "Alpha", { source: "x", compiled: "y" });
	writeEntity(root, pid, "artboard", "b", { source: "x", compiled: "y" });
	const summary = designSummary(root, pid);
	assert.equal(summary.components, 1);
	assert.equal(summary.artboards, 1);
	assert.ok(summary.latestUpdatedAt.length > 0);
}));

test("名字规则与方案一致：PascalCase 2–40 / 画板 id 1–32 位小写字母数字连字符", () => {
	assert.equal(COMPONENT_NAME_RE.test("A"), false, "至少要 2 个字符");
	assert.equal(COMPONENT_NAME_RE.test("StatCard"), true);
	assert.equal(COMPONENT_NAME_RE.test("Stat_Card"), false, "不允许下划线");
	assert.equal(ARTBOARD_ID_RE.test("import-flow-1"), true);
	assert.equal(ARTBOARD_ID_RE.test("Import"), false);
});
