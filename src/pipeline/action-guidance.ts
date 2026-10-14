export const GRADE_SCALE = "abcd-v1";
export type ActionGrade = "A" | "B" | "C" | "D";
/** Read-time conversion only. Stored historical grades and AI success flags stay intact. */
export function actionGuidance(grade: unknown, version?: unknown, gradeScale?: unknown) {
  // Explicit saved metadata takes precedence over the prompt's name.
  // Versions from v25 onward use ABCD even when the name omits "abcd".
  const promptRevision = typeof version === "string" ? /^assessment-v(\d+)-/.exec(version) : null;
  const current = gradeScale != null ? gradeScale === GRADE_SCALE : typeof version === "string" &&
    (version.includes("abcd") || (promptRevision != null && Number(promptRevision[1]) >= 25));
  const legacy: Record<string, ActionGrade> = { S: "A", A: "B", C: "C", D: "D" };
  const valid = current && ["A", "B", "C", "D"].includes(String(grade));
  const converted = valid ? grade as ActionGrade : current ? undefined : legacy[String(grade)];
  return { grade: converted ?? null, grade_scale: GRADE_SCALE,
    basis: !converted ? "no_direction" : current ? "forecast" : "legacy",
    reason: !current && grade === "B" ? "旧5段階のBです。4段階の判定は次回更新で生成します。" : null };
}
