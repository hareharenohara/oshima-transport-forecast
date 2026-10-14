import { PORT_RULES } from "./port-material.js";
export interface DailyAssessment { date: string; grade_scale?: string; evaluation_grade: "A" | "B" | "C" | "D"; assessment: string; port_prediction?: "元町" | "岡田"; port_confidence_level?: 1 | 2 | 3; port_reasons?: string[] }
export const DAILY_RULES = PORT_RULES + "同じ回答のdailyに日別評価を返す。evaluation_gradeはA/B/C/Dを返す。dateは指定日。一日の運航全体を航路・時間帯への悪条件の広がり、改善悪化、モデル差から判断する。便評価の最低値や単純平均は禁止。一部の便の懸念だけでも、一部の便の好条件だけでも日全体の方向を固定しない。主要航路・時間帯への影響と広がりを比較し、局所的な懸念も明記。A=全体が安定、B=おおむね就航、一部注意、C=複数便や主要時間帯で欠航寄り、D=広い範囲で強い欠航材料が一致。必ず就航側A/Bか欠航側C/Dを選ぶ。航路時間帯の差だけでB/Cに固定せず、全体の優勢な材料で判断。拮抗時も航路・時間帯の重要性と根拠の強さを比較して方向を決める。拮抗・情報不足だけでC/Bに固定しない。不確実性と方向を分け、決め手を説明する。判断保留・評価不能を結論にしない。assessmentに概況、そのランクの決め手、注意する航路時間帯を日本語で説明。日全体がBでも基準超過が残る便・航路・時間帯は明記し、全ての基準未満とは説明しない。入力外の数値・変化・確率は禁止。大島の出帆港はその日全便で共通としてdailyで一度だけ決める。便・グループごとの港予測は禁止。港別予報と登録済みの港経験則を比較し、port_predictionは元町/岡田の一方を選ぶ。port_confidence_levelは1=低、2=中、3=高。弱い根拠は確信度を下げ、port_reasonsに決め手を簡潔に書く。大型船の朝便の岡田傾向も一材料として扱い、便種や時間帯ごとに別の港を選ばない。";
export function validateDailyAssessment(value: unknown, date: string, requirePort = false): DailyAssessment {
  const row = value as Partial<DailyAssessment> | null;
  if (!row || row.date !== date || !["A","B","C","D"].includes(String(row.evaluation_grade)) ||
    typeof row.assessment !== "string")
    throw new Error("日別評価の日付・ランク・説明の形式が不正です。");
  const hasPort = row.port_prediction !== undefined || row.port_confidence_level !== undefined || row.port_reasons !== undefined;
  if ((hasPort || requirePort) && (!["元町", "岡田"].includes(String(row.port_prediction)) || !Number.isInteger(row.port_confidence_level) || row.port_confidence_level! < 1 || row.port_confidence_level! > 3 || !Array.isArray(row.port_reasons) || !row.port_reasons.every(reason => typeof reason === "string")))
    throw new Error("日別出帆港予測の形式が不正です。");
  return { ...(hasPort ? {port_prediction: row.port_prediction, port_confidence_level: row.port_confidence_level, port_reasons: row.port_reasons} : {}), date, grade_scale: "abcd-v1", evaluation_grade: row.evaluation_grade!, assessment: row.assessment };
}
