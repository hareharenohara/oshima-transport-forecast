import test from "node:test";
import assert from "node:assert/strict";
import { actionGuidance } from "../src/pipeline/action-guidance.js";
import { validateAssessment } from "../src/gemini/client.js";
import { validateDailyAssessment } from "../src/pipeline/daily-assessment.js";
import { assessBatchWithProviderFallback } from "../src/ai/provider.js";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { readService, readHistory, readPreviousPredictionContexts } from "../src/storage/d1.js";

test("old neutral B is never relabeled cancellation while new B stays operation favored", () => {
  assert.equal(actionGuidance("S", "assessment-v21-reliable-daily").grade, "A");
  assert.equal(actionGuidance("A", "assessment-v21-reliable-daily").grade, "B");
  const old = actionGuidance("B", "assessment-v21-reliable-daily");
  assert.equal(old.grade, null);
  assert.match(old.reason!, /旧5段階/);
  assert.equal(actionGuidance("B", "assessment-v22-abcd").grade, "B");
});

test("all four grades keep their meaning; missing and invalid grades never invent a direction", () => {
  for (const grade of ["A", "B", "C", "D"]) assert.equal(actionGuidance(grade, "abcd-v1").grade, grade);
  for (const grade of [null, undefined, "S", "?"]) {
    const result = actionGuidance(grade, "abcd-v1");
    assert.equal(result.grade, null);
    assert.equal(result.basis, "no_direction");
    assert.equal(result.reason, null);

  }
});

test("new AI and daily schemas reject old S and retain explicit scale metadata", () => {
  assert.throws(() => validateAssessment({evaluation_grade:"S"}), /evaluation_grade/);
  assert.throws(() => validateDailyAssessment({date:"2026-10-09",evaluation_grade:"S",assessment:"風の予報を確認"},"2026-10-09"));
  assert.equal(validateDailyAssessment({date:"2026-10-09",evaluation_grade:"B",assessment:"風の予報を確認し就航寄り"},"2026-10-09").grade_scale,"abcd-v1");
});

test("AI failure never turns into a fabricated cancellation forecast", async () => {
  const [result] = await assessBatchWithProviderFallback([{serviceId:"test",input:{},ml:{}}],{});
  assert.equal(result!.aiStatus,"unavailable");
  assert.equal(result!.ai,null);
  assert.equal(result!.action_guidance.grade,null);
  assert.equal(result!.action_guidance.basis,"no_direction");
});

test("stored legacy and new grades coexist without changing history or creating a false grade change", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync("migrations").filter(name=>name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`migrations/${name}`,"utf8"));
    const db={prepare(sql:string){let args:unknown[]=[];return{bind(...values:unknown[]){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args as [])??null;},async all(){return{results:sqlite.prepare(sql).all(...args as [])};}};}} as unknown as D1Database;
    sqlite.exec(`INSERT INTO services(id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,created_at,updated_at)
      VALUES('test','2026-10-09','1','jet','東京','大島','東京','2026-10-09T08:00:00+09:00','2026-10-09T10:00:00+09:00',120,'old','old');
      INSERT INTO forecast_runs(id,run_slot,run_at,status,created_at) VALUES('old','2000-01-01','old','completed','old'),('new','2000-01-02','new','completed','new');
      INSERT INTO ai_predictions(id,forecast_run_id,service_id,evaluation_rating,ai_status,prompt_version,created_at)
      VALUES('old-ai','old','test','A','generated','assessment-v21-reliable-daily','2000-01-01'),('new-ai','new','test','B','generated','assessment-v22-abcd','2000-01-02');`);
    const service=await readService(db,"test") as any;
    assert.equal(service.action_guidance.grade,"B");
    assert.equal(service.change.evaluation_changed,false);
    const history=await readHistory(db,"test") as any[];
    assert.deepEqual(history.map(row=>row.evaluation_rating),["B","A"]);
    assert.deepEqual(history.map(row=>row.action_guidance.grade),["B","B"]);
    assert.equal((await readPreviousPredictionContexts(db,["test"])).get("test")!.evaluationGrade,"B");
    sqlite.exec("UPDATE ai_predictions SET evaluation_rating='B' WHERE id='old-ai'");
    assert.equal((await readHistory(db,"test") as any[])[1].action_guidance.grade,null);
  } finally { sqlite.close(); }
});
