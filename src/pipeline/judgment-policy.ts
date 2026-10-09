import itemEvidence from "../../artifacts/ai_evidence_model/item_evidence.json" with { type: "json" };
import { NAKAMURA_PUBLIC } from "../knowledge/nakamura-public.js";
import type { FinalAssessment } from "../gemini/client.js";

type Row = Record<string, any>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const phases = ["departure", "route", "arrival"];

/** Common evidence is sent once per request, never inferred from feature importance. */
export const JUDGMENT_KNOWLEDGE = {
  version: "judgment-policy-v1",
  experience: {
    source: "中村氏公開経験則（登録仕様）。公式基準とは別。",
    sagamiJet: [NAKAMURA_PUBLIC.jet.sagamiWindGuideMs, NAKAMURA_PUBLIC.jet.sagamiWaveGuideM],
    port: { windGuideMs:[7,8], rainFavors:"岡田", calmFavors:"元町", largeMorningPrior:"岡田" },
    patterns: ["南西風は大島西〜湾口の波を確認", "北東風は岡田へ入るうねりを確認", "強い西風は東京/熱海を別判断"],
    undefined: "高いうねり・穏やか・強い風の数値境界や方位範囲は未定義。独自閾値を作らない。台風情報は未取得。"
  },
  itemEvidence: itemEvidence.map(row => [row.item, row.assessment.includes("期間") ? 0 : 1]),
  itemEvidence_codes:["期間依存・未確定","候補・未確定"],
  evidenceLimit: "全項目review_required。実測・再解析の探索分析。欠航閾値・因果・A〜D境界への転用不可。公式/経験則の用途は別。",
  gradeCalibration: "A〜Dの実績校正と予報誤差感度は未検証。確信度4/5は出さない。"
};

export interface JudgmentBasis {
  assessable: boolean;
  complete: boolean;
  disagreement: boolean;
  nearBoundary: boolean;
  concerns: boolean;
  strongEvidence: boolean;
  confidenceCeiling: 1 | 2 | 3;
  reasons: string[];
  experienceComparisons: Array<{ criterion: string; model: string; forecast: number; threshold: number; reached: boolean }>;
  portSignals: { strongWindModels: string[]; rainModels: string[]; largeMorningPrior: boolean };
}

export function buildJudgmentBasis(input: unknown): JudgmentBasis | null {
  const source = object(input), forecasts = object(source.forecasts), service = object(source.service);
  // The raw-input contract is enforced for real forecast contexts; transport-only
  // callers without a service/weather context are validated by their own schema.
  if (!service.shipType || !Array.isArray(forecasts.weather) || !Array.isArray(forecasts.marine)) return null;
  const weather: Row[] = forecasts.weather, marine: Row[] = forecasts.marine;
  const has = (rows: Row[], phase: string, variable: string) => rows.some(row => numeric(row.phases?.[phase]?.[variable]));
  const assessable = phases.every(phase => has(weather, phase, "wind_speed_10m") && has(marine, phase, "wave_height"));
  const complete = weather.length === 3 && marine.length === 2 &&
    weather.every(row => phases.every(phase => numeric(row.phases?.[phase]?.wind_speed_10m))) &&
    marine.every(row => phases.every(phase => numeric(row.phases?.[phase]?.wave_height) && numeric(row.phases?.[phase]?.swell_wave_height)));
  const comparisons = new Map<string, Set<string>>();
  const official: Row[] = Array.isArray(source.officialCriteria) ? source.officialCriteria : [];
  for (const row of official) if (numeric(row.forecast)) {
    const statuses = comparisons.get(row.criterion) ?? new Set<string>();
    statuses.add(row.status); comparisons.set(row.criterion, statuses);
  }
  const disagreement = [...comparisons.values()].some(statuses => statuses.size > 1);
  const nearBoundary = official.some(row => row.status === "near_internal");
  const experienceComparisons: JudgmentBasis["experienceComparisons"] = Array.isArray(source.experienceCriteria) ? source.experienceCriteria : [];
  const concerns = official.some(row => row.status === "near_internal" || row.status === "reached") || experienceComparisons.some(row => row.reached);
  const strongEvidence = [...comparisons].some(([name, statuses]) => !name.includes("navigation_change") && statuses.size === 1 && statuses.has("reached") && official.filter(row => row.criterion === name && numeric(row.forecast)).length >= 2) ||
    ["nakamura_sagami_wind","nakamura_sagami_wave"].some(name => {
      const rows = experienceComparisons.filter(row => row.criterion === name);
      return rows.length >= 2 && rows.every(row => row.reached);
    });
  const oshimaPhase = service.direction === "from_oshima" ? "departure" : "arrival";
  const rawArrival = String(service.scheduledArrivalJst).replace(" ","T");
  const arrival = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(rawArrival) ? rawArrival : `${rawArrival}+09:00`);
  const hour = new Date(arrival + 9 * 3_600_000).getUTCHours();
  const portSignals = {
    strongWindModels: weather.filter(row => numeric(row.phases?.[oshimaPhase]?.wind_speed_10m) && row.phases[oshimaPhase].wind_speed_10m >= NAKAMURA_PUBLIC.port.okadaWindGuideMs.max).map(row => row.model),
    rainModels: weather.filter(row => numeric(row.phases?.[oshimaPhase]?.precipitation) && row.phases[oshimaPhase].precipitation > 0).map(row => row.model),
    largeMorningPrior: service.shipType === "large" && service.direction === "to_oshima" && hour < 12
  };
  const reasons: string[] = [];
  if (!assessable) reasons.push("出港・航路・入港の風速または波高が一部不足しています。取得済みの根拠から方向を判断しているため確信度を下げています。");
  else if (!complete) reasons.push("重要項目または予報モデルが一部不足しています。");
  if (disagreement) reasons.push("同じ基準に対する予報モデルの判断が分かれています。");
  if (nearBoundary) reasons.push("公式基準付近の予報があり、予報の変動で判断が変わり得ます。");
  // No arbitrary fixed penalty by lead time. Forecast sensitivity and calibration
  // do not exist yet, so 4/5 cannot claim demonstrated stability.
  reasons.push("予報誤差に対する判定の安定性と確信度の実績校正は未検証です。");
  return { assessable, complete, disagreement, nearBoundary, concerns, strongEvidence,
    confidenceCeiling: !assessable ? 1 : !complete || disagreement ? 2 : 3,
    reasons, experienceComparisons, portSignals };
}

export function judgmentBases(input: unknown): JudgmentBasis[] {
  const source = object(input);
  if (Array.isArray(source.members)) return source.members.flatMap((member: Row) => judgmentBases(member.input));
  const basis = buildJudgmentBasis(source);
  return basis ? [basis] : [];
}

/** Partial forecasts remain usable; missingness does not imply cancellation. */
export function hasJudgmentEvidence(input: unknown): boolean {
  const source = object(input);
  if (Array.isArray(source.members)) return source.members.some((member: Row) => hasJudgmentEvidence(member.input));
  if (!buildJudgmentBasis(input)) return true; // transport-only callers
  const forecasts = object(source.forecasts);
  return [...forecasts.weather, ...forecasts.marine].some((row: Row) =>
    phases.some(phase => Object.values(object(row.phases?.[phase])).some(numeric))) ||
    (Array.isArray(source.officialCriteria) && source.officialCriteria.some((row: Row) => numeric(row.forecast)));
}

export function allowedJudgmentGrades(input:unknown):string[] {
 const bases=judgmentBases(input);
 return ['A','B','C','D'].filter(grade=>grade==='A'?!bases.some(b=>b.concerns||!b.complete||b.disagreement):grade==='D'?!bases.some(b=>!b.strongEvidence):true);
}

export function validateJudgmentComment(assessment:FinalAssessment,input:unknown):void {
 if(!judgmentBases(input).length)return;
 const text=assessment.assessment.trim();
 if(!text||/(?:評価|判断)(?:保留|不能|できません)/.test(text)||/^(?:保留|未定|不明|評価待ち)[。\s]*$/.test(text)||
   !/(風|波|うねり|基準|予報|モデル)/.test(text)||
   !assessment.port_reasons.some(reason=>reason.trim().length>0))
   throw new Error('Judgment comment requires weather evidence, assessment reasoning and a port reason; placeholders are not an assessment');
}

export function enforceJudgmentPolicy(assessment: FinalAssessment, input: unknown): FinalAssessment {
  const bases = judgmentBases(input);
  if (!hasJudgmentEvidence(input)) throw new Error("No forecast evidence was retrieved; preserve the previous forecast rather than inventing a direction");
  if (assessment.evaluation_grade === "A" && bases.some(basis => basis.concerns || !basis.complete || basis.disagreement))
    throw new Error("A is not supported: concerns, missing data or model disagreement");
  if (assessment.evaluation_grade === "D" && bases.some(basis => !basis.strongEvidence))
    throw new Error("D is not supported: no consistent strong cancellation evidence");
  if (assessment.port_prediction !== "元町" && assessment.port_prediction !== "岡田")
    throw new Error("Port judgment must select 元町 or 岡田");
  if (!bases.length) return assessment;
  const source = object(input);
  const changed = (Array.isArray(source.members) ? source.members.map((member: Row) => object(member.input)) : [source])
    .some((member: Row) => member.previousPrediction?.evaluationGrade && member.previousPrediction.evaluationGrade !== assessment.evaluation_grade) ||
    Boolean(source.previousPrediction?.evaluationGrade && source.previousPrediction.evaluationGrade !== assessment.evaluation_grade);
  const level = Math.min(changed ? 2 : 3, ...bases.map(basis => basis.confidenceCeiling)) as 1 | 2 | 3;
  const reasons = [...new Set(bases.flatMap(basis => basis.reasons))];
  if (changed) reasons.unshift("前回評価から判断が変わっており、更新間の安定性が不足しています。");
  return { ...assessment, confidence_level: level, confidence_reasons: reasons,
    port_confidence_level: Math.min(assessment.port_confidence_level, level) as 1 | 2 | 3 };
}
