import { ASSESSMENT_LIMITS, validateTextLength } from "./assessment-limits.js";
export interface DailyAssessment { date: string; grade_scale?: string; evaluation_grade: "A" | "B" | "C" | "D"; assessment: string }
export const DAILY_RULES = "同じ回答のdailyに日別評価を返す。説明文内の評価名は良好・見込・注意・困難を使う。evaluation_gradeは対応するA/B/C/Dのまま返す。dateは指定日。一日の運航全体を航路・時間帯への悪条件の広がり、改善悪化、モデル差から判断する。便評価の最低値や単純平均は禁止。一部の便だけの懸念で日全体をC/Dにしないが、その懸念は明記。A=全体が安定、B=おおむね就航、一部注意、C=複数便や主要時間帯で欠航寄り、D=広い範囲で強い欠航材料が一致。必ず就航側A/Bか欠航側C/Dを選ぶ。航路時間帯の差だけでCにせず、全体の優勢な材料で判断。拮抗時も航路・時間帯の重要性と根拠の強さを比較して方向を決める。拮抗・情報不足だけでC/Bに固定しない。不確実性と方向を分け、決め手を説明する。判断保留・評価不能を結論にしない。assessmentに概況、そのランクの決め手、注意する航路時間帯を日本語で説明。入力外の数値・変化・確率は禁止。";
export function validateDailyAssessment(value: unknown, date: string): DailyAssessment {
  const row = value as Partial<DailyAssessment> | null;
  if (!row || row.date !== date || !["A","B","C","D"].includes(String(row.evaluation_grade)) ||
    typeof row.assessment !== "string" || !row.assessment.trim() ||
    !/(風|波|うねり|基準|予報|モデル)/.test(row.assessment))
    throw new Error("日別評価の日付・ランク・気象根拠・評価理由が不足しています。");
  validateTextLength(row.assessment, ASSESSMENT_LIMITS.dailyAssessment, "daily.assessment");
  return { date, grade_scale: "abcd-v1", evaluation_grade: row.evaluation_grade!, assessment: row.assessment.trim() };
}
