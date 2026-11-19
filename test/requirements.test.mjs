// 需求主线 P0：纯逻辑层（lib/requirements.js）——输入清洗、阶段推导、未归类迁移、坏数据不炸。
import test from "node:test";
import assert from "node:assert/strict";
import {
  REQ_STAGES, UNASSIGNED_REQ_ID, REQ_LIMITS,
  cleanRequirementInput, newRequirementRecord, normalizeRequirement,
  isTaskDone, elementRequirementId, runOutcome, latestRunForVersion,
  deriveStage, requirementView, buildRequirementViews
} from "../lib/requirements.js";

const T0 = Date.parse("2026-11-19T10:00:00Z");
const T1 = Date.parse("2026-11-19T11:00:00Z");
const T2 = Date.parse("2026-11-19T12:00:00Z");

function req(overrides) {
  return Object.assign(
    newRequirementRecord({ reqId: "req-1", projectId: "p1", input: { title: "表单导入" }, now: T0 }),
    overrides || {}
  );
}
const task = (id, extra) => Object.assign({ taskId: id, projectId: "p1", status: "pending" }, extra || {});
const doneTask = (id) => task(id, { report: { status: "done" } });
const proto = (id, updatedAt) => ({ id, updatedAt });
const run = (extra) => Object.assign({ runId: "run-1", requirementId: "req-1", designVersion: 1, status: "passed", startedAt: T2, results: [] }, extra || {});

// ── 输入清洗 ───────────────────────────────────────────────────────────────────

test("cleanRequirementInput：标题必填、去空白；过长直接拒绝而不是悄悄截断", () => {
  assert.deepEqual(cleanRequirementInput({ title: "  表单导入  " }), { value: { title: "表单导入" } });
  assert.match(cleanRequirementInput({ title: "   " }).error, /title is required/);
  assert.match(cleanRequirementInput({}).error, /title is required/);
  assert.match(cleanRequirementInput({ title: "x".repeat(REQ_LIMITS.title + 1) }).error, /exceeds/);
  assert.match(cleanRequirementInput(null).error, /must be an object/);
  assert.match(cleanRequirementInput([]).error, /must be an object/);
});

test("cleanRequirementInput：partial 模式缺省字段不报错、也不出现在结果里", () => {
  assert.deepEqual(cleanRequirementInput({ goal: "目标" }, { partial: true }), { value: { goal: "目标" } });
  assert.deepEqual(cleanRequirementInput({}, { partial: true }), { value: {} });
  // partial 下显式给了空标题仍然拒绝
  assert.match(cleanRequirementInput({ title: "" }, { partial: true }).error, /title is required/);
});

test("cleanRequirementInput：验收点——去空、截断单条、超条数拒绝、类型错误拒绝", () => {
  const ok = cleanRequirementInput({ title: "t", acceptance: ["  a  ", "", "b"] });
  assert.deepEqual(ok.value.acceptance, ["a", "b"]);
  const long = cleanRequirementInput({ title: "t", acceptance: ["y".repeat(REQ_LIMITS.acceptanceLength + 50)] });
  assert.equal(long.value.acceptance[0].length, REQ_LIMITS.acceptanceLength);
  assert.match(cleanRequirementInput({ title: "t", acceptance: Array(REQ_LIMITS.acceptanceItems + 1).fill("x") }).error, /more than/);
  assert.match(cleanRequirementInput({ title: "t", acceptance: "a" }).error, /array of strings/);
  assert.match(cleanRequirementInput({ title: "t", acceptance: [1] }).error, /array of strings/);
});

test("cleanRequirementInput：reworkCap 必须是范围内整数", () => {
  assert.equal(cleanRequirementInput({ title: "t", reworkCap: 5 }).value.reworkCap, 5);
  for (const bad of [0, 11, 2.5, "3", null]) {
    assert.match(cleanRequirementInput({ title: "t", reworkCap: bad }).error, /reworkCap/, String(bad));
  }
});

// ── 记录 ───────────────────────────────────────────────────────────────────────

test("newRequirementRecord：默认值——未确认设计、返工上限 3、revision 1", () => {
  const record = req();
  assert.equal(record.designVersion, 0);
  assert.equal(record.designConfirmedAt, null);
  assert.deepEqual(record.designVersions, []);
  assert.equal(record.reworkCount, 0);
  assert.equal(record.reworkCap, REQ_LIMITS.reworkCapDefault);
  assert.equal(record.revision, 1);
  assert.equal(record.createdAt, T0);
});

test("normalizeRequirement：缺 reqId 丢弃；类型不对的字段回默认；不炸", () => {
  assert.equal(normalizeRequirement(null), undefined);
  assert.equal(normalizeRequirement({ title: "x" }), undefined);
  assert.equal(normalizeRequirement({ reqId: "" }), undefined);
  const dirty = normalizeRequirement({ reqId: "r", title: 5, acceptance: [1, "ok"], reworkCap: 99, designVersion: -1, revision: 0, designVersions: "x" });
  assert.equal(dirty.title, "");
  assert.deepEqual(dirty.acceptance, ["ok"]);
  assert.equal(dirty.reworkCap, REQ_LIMITS.reworkCapDefault);
  assert.equal(dirty.designVersion, 0);
  assert.equal(dirty.revision, 1);
  assert.deepEqual(dirty.designVersions, []);
});

// ── 事实读取 ───────────────────────────────────────────────────────────────────

test("isTaskDone：已报完工或 completed 才算；已删除不算；坏数据不炸", () => {
  assert.equal(isTaskDone(doneTask("a")), true);
  assert.equal(isTaskDone(task("a", { status: "completed" })), true);
  assert.equal(isTaskDone(task("a", { report: { status: "draft" } })), false);
  assert.equal(isTaskDone(task("a", { status: "deleted", report: { status: "done" } })), false);
  assert.equal(isTaskDone(null), false);
  assert.equal(isTaskDone("x"), false);
});

test("elementRequirementId：顶层优先，其次 data；都没有返回空串", () => {
  assert.equal(elementRequirementId({ requirementId: "r1", data: { requirementId: "r2" } }), "r1");
  assert.equal(elementRequirementId({ data: { requirementId: "r2" } }), "r2");
  assert.equal(elementRequirementId({ data: {} }), "");
  assert.equal(elementRequirementId(null), "");
});

test("runOutcome：运行中 / 通过 / 失败 / 出错；「可接受」算通过；有失败项压过其它", () => {
  assert.equal(runOutcome(undefined), "none");
  assert.equal(runOutcome({ status: "queued" }), "pending");
  assert.equal(runOutcome({ status: "running" }), "pending");
  assert.equal(runOutcome({ status: "error" }), "error");
  assert.equal(runOutcome({ status: "passed", results: [{ status: "passed" }, { status: "accepted" }] }), "passed");
  assert.equal(runOutcome({ status: "failed", results: [{ status: "passed" }, { status: "failed" }] }), "failed");
  // 已结束但还有没出结论的用例 → 仍算进行中，不能提前判通过
  assert.equal(runOutcome({ status: "passed", results: [{ status: "passed" }, { status: "running" }] }), "pending");
  // 没有逐条结果时回退到运行自身的状态
  assert.equal(runOutcome({ status: "passed", results: [] }), "passed");
  assert.equal(runOutcome({ status: "failed", results: [] }), "failed");
});

test("latestRunForVersion：只认指定设计版本，取最近一次", () => {
  const runs = [run({ runId: "a", designVersion: 1, startedAt: T0 }), run({ runId: "b", designVersion: 1, startedAt: T2 }), run({ runId: "c", designVersion: 2, startedAt: T2 })];
  assert.equal(latestRunForVersion(runs, 1).runId, "b");
  assert.equal(latestRunForVersion(runs, 2).runId, "c");
  assert.equal(latestRunForVersion(runs, 3), undefined);
  assert.equal(latestRunForVersion(undefined, 1), undefined);
});

// ── 阶段推导：六个阶段 ──────────────────────────────────────────────────────────

test("阶段：澄清——什么都没有", () => {
  const d = deriveStage({ requirement: req(), prototypes: [], tasks: [], runs: [] });
  assert.equal(d.stage, "clarify");
  assert.equal(d.attention, null);
});

test("阶段：设计——有原型帧但从没确认过", () => {
  const d = deriveStage({ requirement: req(), prototypes: [proto("p", T1)], tasks: [], runs: [] });
  assert.equal(d.stage, "design");
  assert.equal(d.attention, "confirm-design");
  assert.equal(d.evidence.dirtyPrototypeCount, 1);
});

test("阶段：设计——确认之后原型又被改过，回到设计并要求确认新版本", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const untouched = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [], runs: [] });
  assert.notEqual(untouched.stage, "design", "确认后没动过，不应回到设计");
  const edited = deriveStage({ requirement: record, prototypes: [proto("p", T2)], tasks: [doneTask("t")], runs: [] });
  assert.equal(edited.stage, "design");
  assert.match(edited.next, /v1/);
  assert.equal(edited.evidence.dirtyPrototypeCount, 1);
});

test("阶段：设计优先于开发——设计没定，任务全完工也不进验收", () => {
  const d = deriveStage({ requirement: req(), prototypes: [proto("p", T1)], tasks: [doneTask("t")], runs: [] });
  assert.equal(d.stage, "design");
});

test("阶段：开发——已确认设计，任务没全部完工", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("t1"), task("t2")], runs: [] });
  assert.equal(d.stage, "develop");
  assert.equal(d.evidence.taskDone, 1);
  assert.equal(d.evidence.taskTotal, 2);
});

test("阶段：开发——不需要设计的需求（没有原型帧）直接有任务也是开发", () => {
  const d = deriveStage({ requirement: req(), prototypes: [], tasks: [task("t")], runs: [] });
  assert.equal(d.stage, "develop");
});

test("阶段：开发——已确认设计但还没建任务，提示去确认提案", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [], runs: [] });
  assert.equal(d.stage, "develop");
  assert.match(d.next, /提案/);
});

test("阶段：验收——任务全部完工、还没有对当前版本的 E2E", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a"), doneTask("b")], runs: [] });
  assert.equal(d.stage, "accept");
  assert.equal(d.evidence.staleRun, false);
});

test("阶段：验收——只有旧设计版本的运行，要求对新版本重跑（不能拿旧结果充数）", () => {
  const record = req({ designVersion: 2, designConfirmedAt: T1 });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a")], runs: [run({ designVersion: 1, status: "passed" })] });
  assert.equal(d.stage, "accept");
  assert.equal(d.evidence.staleRun, true);
  assert.match(d.next, /重新运行/);
});

test("阶段：验收——E2E 运行中 / 运行出错", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const base = { requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a")] };
  assert.equal(deriveStage(Object.assign({}, base, { runs: [run({ status: "running", results: [] })] })).stage, "accept");
  const errored = deriveStage(Object.assign({}, base, { runs: [run({ status: "error" })] }));
  assert.equal(errored.stage, "accept");
  assert.match(errored.next, /出错/);
});

test("阶段：不符——最近一次 E2E 有失败，进「需要我处理」", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const failedRun = run({ status: "failed", results: [{ status: "passed" }, { status: "failed" }] });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a")], runs: [failedRun] });
  assert.equal(d.stage, "mismatch");
  assert.equal(d.attention, "e2e-mismatch");
  assert.equal(d.evidence.needsHuman, false);
  assert.match(d.next, /1 项不符/);
});

test("阶段：不符——返工次数到达上限转人工，建议回到需求重评", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1, reworkCount: 3, reworkCap: 3 });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a")], runs: [run({ status: "failed", results: [{ status: "failed" }] })] });
  assert.equal(d.stage, "mismatch");
  assert.equal(d.attention, "rework-limit");
  assert.equal(d.evidence.needsHuman, true);
  assert.match(d.next, /重新评审/);
});

test("阶段：通过——最近一次 E2E 对当前设计版本全部通过", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a")], runs: [run({ results: [{ status: "passed" }, { status: "accepted" }] })] });
  assert.equal(d.stage, "passed");
  assert.equal(d.attention, null);
});

test("阶段：失败的运行被新一轮通过的运行取代", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const runs = [run({ runId: "old", startedAt: T1, status: "failed", results: [{ status: "failed" }] }), run({ runId: "new", startedAt: T2, results: [{ status: "passed" }] })];
  assert.equal(deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a")], runs }).stage, "passed");
});

test("阶段：已删除的任务不计入完工统计", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const d = deriveStage({ requirement: record, prototypes: [proto("p", T0)], tasks: [doneTask("a"), task("gone", { status: "deleted" })], runs: [] });
  assert.equal(d.evidence.taskTotal, 1);
  assert.equal(d.stage, "accept");
});

test("阶段：所有阶段值都在 REQ_STAGES 里，输入缺省 / 坏数据不炸", () => {
  assert.deepEqual(REQ_STAGES, ["clarify", "design", "develop", "accept", "mismatch", "passed"]);
  assert.equal(deriveStage({}).stage, "clarify");
  assert.equal(deriveStage({ requirement: req(), prototypes: [null, "x"], tasks: [null, 3], runs: [null] }).stage, "design");
});

// ── 视图与「未归类」迁移 ────────────────────────────────────────────────────────

test("requirementView：带推导阶段、中文标签、计数与证据", () => {
  const record = req({ designVersion: 1, designConfirmedAt: T1 });
  const view = requirementView(record, { prototypes: [proto("p", T0)], flows: [proto("f", T0)], tasks: [doneTask("a"), task("b")], runs: [] });
  assert.equal(view.stage, "develop");
  assert.equal(view.stageLabel, "开发");
  assert.equal(view.tone, "info");
  assert.deepEqual(view.counts, { prototypes: 1, flows: 1, tasks: 2, tasksDone: 1, runs: 0 });
  assert.deepEqual(view.taskIds, ["a", "b"]);
  assert.equal(view.virtual, false);
});

test("buildRequirementViews：任务与原型帧按 requirementId 归组", () => {
  const views = buildRequirementViews({
    projectId: "p1",
    requirements: [req({ reqId: "r1", title: "A" }), req({ reqId: "r2", title: "B" })],
    tasks: [task("t1", { requirementId: "r1" }), task("t2", { requirementId: "r2" }), task("t3", { requirementId: "r2" })],
    elements: [{ id: "e1", kind: "prototype", requirementId: "r1", updatedAt: T1 }, { id: "e2", kind: "group", data: { kind: "flow", requirementId: "r2" }, updatedAt: T1 }, { id: "e2:node", kind: "flow", data: { flowId: "main" }, updatedAt: T1 }],
    runs: []
  });
  assert.equal(views.length, 2, "没有孤儿数据就不出现「未归类」");
  const a = views.find((v) => v.reqId === "r1");
  const b = views.find((v) => v.reqId === "r2");
  assert.deepEqual(a.taskIds, ["t1"]);
  assert.deepEqual(a.prototypeIds, ["e1"]);
  assert.deepEqual(b.taskIds, ["t2", "t3"]);
  assert.deepEqual(b.flowIds, ["e2"]);
});

test("buildRequirementViews：老数据（没有 requirementId）并入虚拟「未归类」，且排在最后", () => {
  const views = buildRequirementViews({
    projectId: "p1",
    requirements: [req({ reqId: "r1", title: "A" })],
    tasks: [task("old1"), task("old2", { requirementId: "r-已被删的需求" }), task("t1", { requirementId: "r1" })],
    elements: [{ id: "oldproto", kind: "prototype", updatedAt: T0 }, { id: "note1", kind: "note" }, { id: "flow:old", kind: "group", data: { kind: "flow" }, updatedAt: T0 }, { id: "flow:old:s", kind: "flow", data: { flowId: "old" }, updatedAt: T0 }],
    runs: []
  });
  assert.equal(views.length, 2);
  const last = views[views.length - 1];
  assert.equal(last.reqId, UNASSIGNED_REQ_ID);
  assert.equal(last.virtual, true);
  assert.equal(last.title, "未归类");
  assert.deepEqual(last.taskIds.sort(), ["old1", "old2"]);
  assert.deepEqual(last.prototypeIds, ["oldproto"], "便签等非原型 / 流程图元素不进需求");
  assert.deepEqual(last.flowIds, ["flow:old"], "一张流程图按分组框算一张，不按节点数");
  assert.equal(last.stage, "develop", "未归类只按任务判断，不要求设计版本");
});

test("buildRequirementViews：未归类的任务全部完工不会冒出「验收 / 不符」，也不要求确认设计", () => {
  const views = buildRequirementViews({ projectId: "p1", requirements: [], tasks: [doneTask("a"), doneTask("b")], elements: [{ id: "p", kind: "prototype", updatedAt: T2 }], runs: [] });
  assert.equal(views.length, 1);
  assert.equal(views[0].virtual, true);
  assert.equal(views[0].stage, "passed");
  assert.equal(views[0].attention, null);
});

test("buildRequirementViews：只取本项目的需求；别的项目的记录与已删除任务不混入", () => {
  const views = buildRequirementViews({
    projectId: "p1",
    requirements: [req({ reqId: "mine" }), req({ reqId: "other", projectId: "p2" }), { notARecord: true }],
    tasks: [task("gone", { status: "deleted", requirementId: "mine" })],
    elements: [],
    runs: []
  });
  assert.deepEqual(views.map((v) => v.reqId), ["mine"]);
  assert.equal(views[0].counts.tasks, 0);
});

test("buildRequirementViews：运行只归属自己的需求；非数组输入不炸", () => {
  const record = req({ reqId: "r1", designVersion: 1, designConfirmedAt: T1 });
  const views = buildRequirementViews({
    projectId: "p1",
    requirements: [record],
    tasks: [task("t", { requirementId: "r1", report: { status: "done" } })],
    elements: [{ id: "p", kind: "prototype", requirementId: "r1", updatedAt: T0 }],
    runs: [run({ requirementId: "r1" }), run({ runId: "x", requirementId: "别人的", status: "failed", results: [{ status: "failed" }] })]
  });
  assert.equal(views[0].stage, "passed", "别的需求的失败运行不能把本需求拖成「不符」");
  assert.equal(views[0].counts.runs, 1);
  assert.deepEqual(buildRequirementViews({ projectId: "p1" }), []);
  assert.deepEqual(buildRequirementViews({ projectId: "p1", requirements: "x", tasks: 1, elements: {}, runs: null }), []);
});

test("requirementView：updatedAt 取记录、任务、原型帧里最新的一个", () => {
  const record = req({ updatedAt: T0 });
  const view = requirementView(record, { prototypes: [proto("p", T2)], flows: [], tasks: [task("t", { updatedAt: T1 })], runs: [] });
  assert.equal(view.updatedAt, T2);
});
