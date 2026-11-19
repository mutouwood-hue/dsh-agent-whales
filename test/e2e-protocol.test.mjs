// 需求主线 P4：E2E 协议与状态机（lib/e2e.js 纯函数）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  E2E_LIMITS, isSafeShotName, shotMime, shotByteLimit, sanitizeShotName, uniqueShotName,
  shotContentMatches, cleanRunInput, newRunRecord, cleanResultInput, applyResult, appendShots, finishRun, unfinishedCases, runSummary, normalizeRun, isRunOpen
} from "../lib/e2e.js";
import { runOutcome } from "../lib/requirements.js";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const req = { title: "表单导入", acceptance: ["上传 xlsx 并识别表头", "未匹配字段给出建议"] };
const mkRun = (cases) => newRunRecord({ runId: "run-1", projectId: "p1", requirementId: "r1", designVersion: 1, taskIds: ["t1"], driver: "manual", cases: cases || [{ caseId: "c1", title: "A" }, { caseId: "c2", title: "B" }], now: NOW });

test("证据文件名：只允许安全的 ASCII 名 + 白名单扩展名；路径、隐藏文件、.. 一律拒绝", () => {
  for (const ok of ["step3.png", "run-0431.webm", "a_b-c.JPG", "x.jpeg", "s.webp"]) assert.equal(isSafeShotName(ok), true, ok);
  for (const bad of ["../a.png", "a/b.png", "a\\b.png", ".hidden.png", "a.exe", "a.png.exe", "a..png", "", "x".repeat(70) + ".png", "中文.png", null, 5]) assert.equal(isSafeShotName(bad), false, String(bad));
  assert.equal(shotMime("a.png"), "image/png");
  assert.equal(shotMime("a.JPG"), "image/jpeg");
  assert.equal(shotMime("a.webm"), "video/webm");
  assert.equal(shotMime("a.bin"), "application/octet-stream");
  assert.equal(shotByteLimit("a.webm"), E2E_LIMITS.videoBytes);
  assert.equal(shotByteLimit("a.png"), E2E_LIMITS.shotBytes);
});

test("sanitizeShotName：取 basename、收敛字符；收敛后仍不合法返回空串；uniqueShotName 去重", () => {
  assert.equal(sanitizeShotName("C:\\Users\\me\\Desktop\\Step 3 Actual.PNG"), "step-3-actual.png");
  assert.equal(sanitizeShotName("/tmp/../etc/passwd"), "", "没有合法扩展名");
  assert.equal(sanitizeShotName("截图.png"), "", "全是非 ASCII 收敛后为空");
  assert.equal(sanitizeShotName(undefined), "");
  assert.equal(sanitizeShotName("a..b.png"), "a.b.png", "连续的点收敛成一个，不会因为名字里带 .. 就整个被拒");
  assert.equal(sanitizeShotName("..\\..\\evil.png"), "evil.png", "路径部分被丢掉，只留文件名");
  assert.equal(uniqueShotName("a.png", []), "a.png");
  assert.equal(uniqueShotName("a.png", ["a.png"]), "a-2.png");
  assert.equal(uniqueShotName("a.png", ["a.png", "a-2.png"]), "a-3.png");
});

test("cleanRunInput：缺省用需求验收点；没有验收点给一条总用例；自定义用例清洗；非法驱动 / 过多 / 空标题拒绝", () => {
  const byAcceptance = cleanRunInput({}, req);
  assert.equal(byAcceptance.value.driver, "manual");
  assert.deepEqual(byAcceptance.value.cases, [{ caseId: "c1", title: "上传 xlsx 并识别表头" }, { caseId: "c2", title: "未匹配字段给出建议" }]);
  assert.deepEqual(cleanRunInput(undefined, { title: "对账", acceptance: [] }).value.cases, [{ caseId: "c1", title: "对账 · 整体验收" }]);
  assert.deepEqual(cleanRunInput({ driver: "tabbit-cli", cases: ["x", { title: " y " }] }, req).value.cases.map((c) => c.title), ["x", "y"]);
  assert.match(cleanRunInput({ driver: "selenium" }, req).error, /driver/);
  assert.match(cleanRunInput({ cases: [] }, req).error, /at least one/);
  assert.match(cleanRunInput({ cases: ["  "] }, req).error, /must not be empty/);
  assert.match(cleanRunInput({ cases: [1] }, req).error, /string or/);
  assert.match(cleanRunInput({ cases: "x" }, req).error, /array/);
  assert.match(cleanRunInput({ cases: Array(E2E_LIMITS.cases + 1).fill("x") }, req).error, /exceeds/);
  assert.match(cleanRunInput({ cases: ["x".repeat(E2E_LIMITS.caseTitle + 1)] }, req).error, /exceeds/);
  assert.equal(cleanRunInput({ note: " 备注 " }, req).value.note, "备注");
  assert.match(cleanRunInput({ note: 5 }, req).error, /note/);
});

test("newRunRecord：queued、每条用例 pending、记录设计版本与任务；视图不会把 pending 当通过", () => {
  const run = mkRun();
  assert.equal(run.status, "queued");
  assert.deepEqual(run.results.map((r) => [r.caseId, r.status]), [["c1", "pending"], ["c2", "pending"]]);
  assert.equal(run.designVersion, 1);
  assert.deepEqual(run.taskIds, ["t1"]);
  assert.equal(run.finishedAt, null);
  assert.equal(runOutcome(run), "pending", "刚建的运行对阶段推导来说是「进行中」");
  assert.equal(isRunOpen(run), true);
});

test("cleanResultInput：状态词表、备注、诊断（kind 词表 / 通过不能带诊断）", () => {
  assert.deepEqual(cleanResultInput({ status: "passed" }).value, { status: "passed", note: "" });
  assert.equal(cleanResultInput({ status: "failed", note: " 找不到 ", diagnosis: { kind: "code", reason: " 实现问题 " } }).value.diagnosis.reason, "实现问题");
  for (const bad of ["accepted", "pending", "oops", undefined]) assert.match(cleanResultInput({ status: bad }).error, /status must be/, String(bad));
  assert.match(cleanResultInput({ status: "failed", diagnosis: { kind: "weather" } }).error, /diagnosis.kind/);
  assert.match(cleanResultInput({ status: "passed", diagnosis: { kind: "code" } }).error, /passed case cannot/);
  assert.match(cleanResultInput({ status: "failed", diagnosis: "x" }).error, /diagnosis must be/);
  assert.match(cleanResultInput({ status: "failed", note: "n".repeat(E2E_LIMITS.note + 1) }).error, /note exceeds/);
  assert.match(cleanResultInput(null).error, /object/);
  assert.equal(cleanResultInput({ status: "failed", diagnosis: null }).value.diagnosis, undefined);
});

test("applyResult：第一次上报推进 queued→running；诊断 by 区分 ai / user；运行结束后不能再写；用例不存在拒绝；不改入参", () => {
  const run = mkRun();
  const frozen = JSON.stringify(run);
  const out = applyResult(run, "c1", { status: "failed", note: "断言失败", diagnosis: { kind: "code", reason: "映射建议缺失" } }, { now: NOW + 1, by: "session-exec", addShots: ["s1.png"] });
  assert.equal(JSON.stringify(run), frozen, "纯函数");
  assert.equal(out.run.status, "running");
  assert.deepEqual(out.run.results[0].shots, ["s1.png"]);
  assert.equal(out.run.results[0].diagnosis.by, "ai");
  assert.equal(out.run.results[0].by, "session-exec");
  assert.equal(out.run.results[1].status, "pending", "别的用例不受影响");
  const byUser = applyResult(run, "c1", { status: "failed", note: "", diagnosis: { kind: "design", reason: "x" } }, { now: NOW, by: "user" });
  assert.equal(byUser.run.results[0].diagnosis.by, "user");
  assert.match(applyResult(run, "c9", { status: "passed", note: "" }, { now: NOW }).error, /case not found/);
  const done = finishRun(applyResult(applyResult(run, "c1", { status: "passed", note: "" }, { now: NOW }).run, "c2", { status: "passed", note: "" }, { now: NOW }).run, { now: NOW }).run;
  assert.match(applyResult(done, "c1", { status: "failed", note: "" }, { now: NOW }).error, /already finished/);
});

test("applyResult：重复上报同一条覆盖旧结论但保留已有附件；附件总数超限拒绝", () => {
  let run = mkRun();
  run = applyResult(run, "c1", { status: "running", note: "" }, { now: NOW, addShots: ["a.png"] }).run;
  run = applyResult(run, "c1", { status: "failed", note: "x" }, { now: NOW + 1, addShots: ["b.png"] }).run;
  assert.equal(run.results[0].status, "failed");
  assert.deepEqual(run.results[0].shots, ["a.png", "b.png"]);
  const many = Array.from({ length: E2E_LIMITS.shotsPerResult }, (_, i) => "s" + i + ".png");
  assert.match(applyResult(run, "c1", { status: "failed", note: "" }, { now: NOW, addShots: many }).error, /at most/);
});

test("appendShots：只追加证据、不改结论；queued 推进到 running；超限拒绝；已结束拒绝", () => {
  const run = mkRun();
  const out = appendShots(run, "c2", ["a.png"]);
  assert.equal(out.run.status, "running");
  assert.equal(out.run.results[1].status, "pending", "上传截图不等于出结论");
  assert.deepEqual(out.run.results[1].shots, ["a.png"]);
  assert.match(appendShots(run, "c9", ["a.png"]).error, /case not found/);
  assert.match(appendShots(run, "c1", Array(E2E_LIMITS.shotsPerResult + 1).fill("a.png")).error, /at most/);
  assert.match(appendShots(Object.assign({}, run, { status: "passed" }), "c1", ["a.png"]).error, /already finished/);
});

test("finishRun：还有用例没出结论不能结束；强制结束把没报的记 error；结果折算 passed / failed / error", () => {
  let run = mkRun();
  assert.deepEqual(unfinishedCases(run), ["c1", "c2"]);
  const blocked = finishRun(run, { now: NOW });
  assert.match(blocked.error, /without a result: c1, c2/);
  assert.deepEqual(blocked.missing, ["c1", "c2"]);

  const forced = finishRun(run, { now: NOW, force: true }).run;
  assert.equal(forced.status, "error");
  assert.equal(forced.results[0].status, "error");
  assert.match(forced.results[0].note, /强制结束/);
  assert.equal(forced.finishedAt, NOW);

  run = applyResult(run, "c1", { status: "passed", note: "" }, { now: NOW }).run;
  run = applyResult(run, "c2", { status: "failed", note: "" }, { now: NOW }).run;
  const failed = finishRun(run, { now: NOW }).run;
  assert.equal(failed.status, "failed");
  assert.equal(runOutcome(failed), "failed", "与阶段推导口径一致");

  const passedRun = finishRun(applyResult(applyResult(mkRun(), "c1", { status: "passed", note: "" }, { now: NOW }).run, "c2", { status: "passed", note: "" }, { now: NOW }).run, { now: NOW }).run;
  assert.equal(passedRun.status, "passed");
  assert.equal(runOutcome(passedRun), "passed");

  const errored = finishRun(applyResult(applyResult(mkRun(), "c1", { status: "error", note: "浏览器崩了" }, { now: NOW }).run, "c2", { status: "failed", note: "" }, { now: NOW }).run, { now: NOW }).run;
  assert.equal(errored.status, "error", "有 error 压过 failed");
  assert.match(finishRun(passedRun, { now: NOW }).error, /already finished/);
});

test("runSummary：计数口径（accepted 算通过；pending / running 算未完成）", () => {
  const run = Object.assign(mkRun(), { results: [{ caseId: "c1", status: "passed" }, { caseId: "c2", status: "accepted" }, { caseId: "c3", status: "failed" }, { caseId: "c4", status: "error" }, { caseId: "c5", status: "running" }, { caseId: "c6", status: "pending" }] });
  const s = runSummary(run);
  assert.deepEqual([s.total, s.passed, s.failed, s.errored, s.pending], [6, 2, 1, 1, 2]);
  assert.equal(s.runId, "run-1");
  assert.equal(s.finishedAt, null);
});

test("normalizeRun：坏数据回默认；证据文件名不合法的被丢掉；缺 runId 丢弃", () => {
  assert.equal(normalizeRun(null), undefined);
  assert.equal(normalizeRun({}), undefined);
  const dirty = normalizeRun({ runId: "r", status: "weird", driver: "x", designVersion: -3, results: [null, { caseId: "c1", shots: ["ok.png", "../evil.png", 5] }], cases: "x", annotations: 1, createdAt: "x" });
  assert.equal(dirty.status, "error");
  assert.equal(dirty.driver, "manual");
  assert.equal(dirty.designVersion, 0);
  assert.deepEqual(dirty.results[0].shots, ["ok.png"]);
  assert.deepEqual(dirty.cases, []);
  assert.equal(dirty.createdAt, 0);
  assert.equal(dirty.finishedAt, null);
});

test("shotContentMatches：文件头魔数必须和扩展名相符；改个扩展名的任意内容 / 太短的 / 非 Buffer 都不行", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);
  assert.equal(shotContentMatches("a.png", png), true);
  assert.equal(shotContentMatches("a.jpg", jpg), true);
  assert.equal(shotContentMatches("a.JPEG", jpg), true);
  assert.equal(shotContentMatches("a.webp", webp), true);
  assert.equal(shotContentMatches("a.webm", webm), true);
  assert.equal(shotContentMatches("a.png", jpg), false, "jpeg 内容不能叫 png");
  assert.equal(shotContentMatches("a.png", Buffer.from("<script>alert(1)</script>")), false, "任意文本改扩展名不行");
  assert.equal(shotContentMatches("a.png", Buffer.from([0x89, 0x50])), false, "太短");
  assert.equal(shotContentMatches("a.exe", png), false);
  assert.equal(shotContentMatches("a.png", "not a buffer"), false);
});