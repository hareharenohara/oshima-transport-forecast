import type { FinalAssessment } from "../gemini/client.js";

export const ASSESSMENT_LIMITS = {
  assessment: 120,
  dailyAssessment: 200,
  factorCount: 2,
  factorLength: 30,
  portReasonCount: 1,
  portReasonLength: 60,
} as const;

// Count Unicode code points, so one supplementary character counts as one.
export const characterCount = (text: string) => Array.from(text).length;
export const ASSESSMENT_LIMIT_RULES =
  "便・集約コメントは120文字以内、日別総評は200文字以内。プラス・注意要因は各2件以内、各30文字以内。港理由は1件、60文字以内。上限まで埋める必要はない。主要な気象値・基準比較・評価の決め手を優先し、日別総評には全体の見通しと注意する航路・時間帯を含める。各欄で同じ説明を重複しない。簡潔でも根拠を省略しない。";

export function validateTextLength(text: string, limit: number, field: string): void {
  const length = characterCount(text);
  if (length > limit) throw new Error(`Assessment length limit: ${field} is ${length} characters; maximum ${limit}. Rewrite concisely with evidence; do not truncate.`);
}

export function validateAssessmentLimits(assessment: FinalAssessment): void {
  validateTextLength(assessment.assessment, ASSESSMENT_LIMITS.assessment, "assessment");
  for (const field of ["positive_factors", "negative_factors", "port_reasons"] as const) {
    const port = field === "port_reasons";
    const count = port ? ASSESSMENT_LIMITS.portReasonCount : ASSESSMENT_LIMITS.factorCount;
    if (assessment[field].length > count) throw new Error(`Assessment length limit: ${field} has ${assessment[field].length} items; maximum ${count}. Combine duplicate explanations and preserve decisive evidence.`);
    for (const text of assessment[field]) validateTextLength(text, port ? ASSESSMENT_LIMITS.portReasonLength : ASSESSMENT_LIMITS.factorLength, field);
  }
}
