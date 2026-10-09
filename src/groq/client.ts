import { DAILY_RULES, validateDailyAssessment, type DailyAssessment } from "../pipeline/daily-assessment.js";
import { ASSESSMENT_LIMIT_RULES, validateAssessmentLimits } from "../pipeline/assessment-limits.js";
import { JUDGMENT_KNOWLEDGE, buildJudgmentBasis, enforceJudgmentPolicy, allowedJudgmentGrades, validateJudgmentComment } from "../pipeline/judgment-policy.js";
import { validateAssessment, validateGrounding, type FinalAssessment, type ForecastSummary } from "../gemini/client.js";
import { packJudgmentInputs } from "./packed-input.js";
import type { GroupJudgmentMaterial } from "../pipeline/group-judgment.js";


export const GROQ_MODELS = { summary: "none", final: "openai/gpt-oss-120b" } as const;

export const GROQ_PROMPT_VERSION = "assessment-v24-abcd-japanese-labels";

const stringList = { type: "array", items: { type: "string" } };
const finalProperties = {
  evaluation_grade: { type: "string", enum: ["A", "B", "C", "D"] },
  assessment: { type: "string" }, positive_factors: stringList, negative_factors: stringList,
  port_prediction: { type: "string", enum: ["元町", "岡田"] },
  port_confidence_level: { type: "integer", minimum: 1, maximum: 5 }, port_reasons: stringList
};
const batchFinalSchema = strictObject({ services: { type: "array", items: strictObject({ service_id: { type: "string" }, ...finalProperties }) } });
const outputAliases:Record<string,string>={service_id:"id",evaluation_grade:"g",assessment:"a",positive_factors:"p",negative_factors:"n",port_prediction:"o",port_confidence_level:"c",port_reasons:"r"};
const compactServiceSchema={type:"array",items:strictObject(Object.fromEntries(Object.entries({service_id:{type:"string"},...finalProperties,port_reasons:{type:"string"}}).map(([key,value])=>[outputAliases[key]!,value])))};
const DAILY_FINAL_RULES=`Return every serviceId once. All prose Japanese. Judge departure/route/arrival wind, wave and swell against applicable official criteria and registered experience; preserve route/time/model differences. ML is only a cross-check. Never invent values, thresholds, causality, probabilities, typhoon information or improvement/worsening. Item-level ML evidence is unconfirmed. Use allowedGrades: A strong operation (complete, agreeing models, no concerns), B operation favored, C cancellation favored, D consistent strong cancellation evidence. Reaching a criterion alone does not force D. Always select operation A/B or cancellation C/D. Model disagreement alone does not force C: use B if operation evidence prevails, with lower confidence. For balanced evidence choose B or C by the strongest route/time-specific weather evidence. Never default to either side because of uncertainty or missingness; reduce confidence instead. Missing flags affect confidence, never force a direction or an abstention. Never present insufficient information as actual cancellation evidence. Program adds operation confidence and criterion comparisons. Choose one port 元町/岡田 using supplied experience and rain/wind signals, with low port confidence if weak. Explain decisive weather values, criterion comparisons and grade reason, plus port reason; do not repeat whole comments in factors. Resolve responseCorrection. Short trips use enclosing hourly forecasts conservatively; peaks within one hour outside the interval are boundary samples, not actual operating times. Output keys: id=service_id,g=evaluation_grade,a=assessment,p=positive_factors,n=negative_factors,o=port_prediction,c=port_confidence_level,r=one port reason string. p/n are string arrays (at most 2 each), r is a single string. daily keeps date/evaluation_grade/assessment.`;

function strictObject(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function validateBatch<T>(value: unknown, validate: (value: unknown) => T): Array<{ serviceId: string; value: T }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Groq batch is not an object");
  const services = (value as Record<string, unknown>).services;
  if (!Array.isArray(services)) throw new Error("Groq batch services is not an array");
  const seen = new Set<string>();
  return services.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid Groq batch item");
    const serviceId = (item as Record<string, unknown>).service_id;
    if (typeof serviceId !== "string" || !serviceId || seen.has(serviceId)) throw new Error("Invalid or duplicate Groq service_id");
    seen.add(serviceId);
    return { serviceId, value: validate(item) };
  });
}

async function generateStrict<T>(model: string, prompt: string, schema: object, validate: (value: unknown) => T, apiKey: string, fetchFn: typeof fetch, maxCompletionTokens: number): Promise<T> {
  const stage = model === GROQ_MODELS.summary ? "summary" : "final";
  const response = await fetchFn("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: "与えられた根拠のみで日本語JSONを返す。文章は自然な日本語。モデル名・単位・正式な識別子以外に英語を使わない。" }, { role: "user", content: prompt }],
      temperature: 0.1,
      reasoning_effort: "low",
      max_completion_tokens: maxCompletionTokens,
      response_format: { type: "json_schema", json_schema: { name: "oshima_forecast", strict: true, schema } }
    })
  });
  if (!response.ok) {
    // Groq can reject a generated JSON on container shape (e.g. one reason
    // returned as a string). Preserve that answer and run our full local
    // validators; only lossless string/array normalization is permitted.
    const rejected=await response.clone().json().catch(()=>null) as any;
    if(response.status===400&&rejected?.error?.code==='json_validate_failed'&&typeof rejected.error.failed_generation==='string') {
      try{return validate(JSON.parse(rejected.error.failed_generation));}
      catch(error){throw new Error(`Groq ${model} [stage=${stage}, phase=output_validation]: ${error instanceof Error?error.message:String(error)}`);}
    }
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`Groq ${model} HTTP ${response.status} [stage=${stage}, phase=api_response]${detail ? `: ${detail}` : ""}`);
  }
  const payload = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
  // Even syntactically valid JSON can be an incomplete answer at the limit.
  if(payload.choices?.[0]?.finish_reason === "length")throw new Error(`Groq ${model} [stage=${stage}, phase=completion_limit]: response truncated`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Groq ${model} returned no structured output`);
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (error) { throw new Error(`Groq ${model} [stage=${stage}, phase=json_parse]: ${error instanceof Error ? error.message : String(error)}`); }
  try { return validate(parsed); }
  catch (error) { throw new Error(`Groq ${model} [stage=${stage}, phase=output_validation]: ${error instanceof Error ? error.message : String(error)}`); }
}

function compactNumber(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 1000) / 1000;
  if (Array.isArray(value)) return value.map(compactNumber);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => [key, compactNumber(item)]));
  return value;
}

export function compactJudgmentInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const ml = source.ml && typeof source.ml === "object" ? (source.ml as Record<string, unknown>).result : undefined;
  const mlResult = ml && typeof ml === "object" ? ml as Record<string, unknown> : {};
  const comparison = mlResult.comparison && typeof mlResult.comparison === "object" ? mlResult.comparison as Record<string, unknown> : {};
  const forecasts = source.forecasts && typeof source.forecasts === "object" ? source.forecasts as Record<string, unknown> : {};
  const phaseSignals = (items: unknown, variables: string[]) => Array.isArray(items) ? items.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const phases = row.phases && typeof row.phases === "object" ? row.phases as Record<string, unknown> : {};
    const select = (name: string) => {
      const values = phases[name] && typeof phases[name] === "object" ? phases[name] as Record<string, unknown> : {};
      return Object.fromEntries(variables.filter((key) => typeof values[key] === "number").map((key) => [key, values[key]]));
    };
    return { m: row.model, d: select("departure"), r: select("route"), a: select("arrival"), c3: select("change3h"), c6: select("change6h") };
  }) : [];
  const criteria = Array.isArray(source.officialCriteria) ? source.officialCriteria.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  const selectedCriteria = [...criteria.filter((item) => item.status === "near_internal" || item.status === "reached")];
  for (const criterion of new Set(criteria.map((item) => String(item.criterion)))) {
    const below = criteria.filter((item) => item.criterion === criterion && item.status === "below")
      .sort((a, b) => Number(b.ratio ?? -1) - Number(a.ratio ?? -1))[0];
    if (below) selectedCriteria.push(below);
  }
  return compactNumber({
    s: source.service,
    t: source.timing,
    w: phaseSignals(forecasts.weather, ["wind_speed_10m", "wind_direction_10m"]),
    sea: phaseSignals(forecasts.marine, ["wave_height", "wave_direction", "swell_wave_height", "swell_wave_direction"]),
    officialCriteria: selectedCriteria,
    prev: source.previousPrediction,
    quality: source.dataQuality,
    judgment: buildJudgmentBasis(source),
    mlReference: { mean: comparison.mean, min: comparison.min, max: comparison.max, range: comparison.range, agreement: comparison.agreement }
  });
}

const FINAL_RULES = `全件serviceIdをservice_idへ一致で返す。出港/航路/入港の風・波・うねりと基準・モデル差を先に判断しMLは照合のみ。ML転記、独自閾値、入力外の数値/因果は禁止。公式criteriaと中村氏experienceを区別し船種/区間を守る。項目別MLは全て未確定、危険点にしない。A=強い就航、B=就航寄り、C=欠航寄り、D=強い欠航。Aは懸念なし/モデル一致、Dは強い欠航材料の一致が必要。基準到達だけでDに固定しない。必ずA/BかC/Dに振る。モデル差だけでCに固定せず、優勢な材料が就航を支持すればBとする。拮抗時も航路・時間帯ごとの判断材料を比較し、最も判断力のある根拠でB/Cを選ぶ。拮抗・欠損・モデル差だけを理由にC又はBへ固定しない。不確実性は確信度を下げ、選択した方向の決め手を説明する。部分欠損でも取得済み根拠で判断し、評価不能・判断保留を結論にしない。情報不足を欠航の気象根拠と偽らない。就航確信度と公式比較一覧はプログラムが付ける。港は元町/岡田の一方を根拠で選び不明/併記禁止。経験則の優勢な材料で選び、根拠が弱い時は港確信度を下げる。jのrainModelsは大島側降水>0のモデル番号で港材料。未定義の高いうねり等の境界や未取得の台風情報を作らない。総合コメントは判断に影響した気象の具体値・基準比較・そのランクを選んだ決め手を、必要十分な文章で説明する。モデル差や懸念が結論を左右した場合は理由を示す。港の選択理由も示す。長文化のための説明は加えない。要因欄で全文を重複しない。集約は航路/時間帯の条件差を明記する。AI確率禁止。`;

const GROUP_RULES = "scope=groupはmembers全体の評価。条件差を平均で消さず、groupIDだけ返す。nullは欠損で0ではない。w/sea=[モデル番号,matrix番号]、matrixはmatrixRowsの行番号。列はweather/marine、行順はphases。q=qualities番号、j=judgments番号、judgment_columnsのflagsはビット和。officialCriteriaはcomparisonSets番号、各setはcomparisonRows番号の配列、行=[基準番号,モデル番号,状態番号,任意の予報値]。状態0=below/1=near_internal/2=reached/3=missing。criteria=[名称,単位,閾値,参照]、参照=[wまたはsea,phase番号,列番号]なら予報値は必ずその便の該当モデル表を参照。参照nullなら比較行の予報値。比率=予報値÷閾値。sの各セルはserviceValues番号、列はservice_columns、mlReferenceはml_columns順。experienceの比較0=相模灘風速17m/s、1=波高4m、ジェットのみ。";
const GROUP_WEATHER_RULES="group-weather-v1: judge the whole group, return group ID only. null=missing. Refs: regions->groupRegions[area,locations,period,wind,sea,rain], locations->groupLocations, period->groupPeriods[[start,end],...]. Times are minutes from date JST00 (>1440 allowed); gaps are excluded. Models->models. Event->groupEvents[value,time,location,direction-at-that-time]. Wind=[model,maxEvent,missing], sea=[model,waveMaxEvent,swellMin,swellMaxEvent,missing], rain=[model,wetForecastTimes,missing]. Wind m/s, wave/swell m. Different peak times/places are NOT concurrent; peak direction is not the whole-period direction. Min alone gives no improvement time. officialCriteria/experienceCriteria->groupComparisons[criterion,conditions,worstEvent], criteria=[name,unit,threshold,...], conditions->groupConditions rows[model,bounds,stateBits,period,optional[[state,period],...]] for different window states. Bounds=[min,max] of applicable-window peaks; [v] means min=max=v. WorstEvent retains the highest model peak place/time/direction; other models keep their numeric bounds and coverage periods. State bits:1 below,2 internal90%-near,4 reached,8 missing. A window containing a reach is NOT continuously over threshold. policy=[judgment_columns flags,confidence cap,large-morning Okada prior:0 none/1 some/2 all]; flags 1/2/32 require every member, 4/8/16 any member. ML=[route,min/max of service ML means,agreements], reference only. Keep route/time/model differences; do not infer missing values or unrepresented changes. All output prose Japanese.";


export function packDirectJudgments(items: Array<{ serviceId: string; input: unknown }>) {
  const aggregate=(input:unknown)=>(input as {aggregateJudgment?:GroupJudgmentMaterial}|null)?.aggregateJudgment;
  const members = items.filter(item=>!aggregate(item.input)).flatMap(item => {
    const source = item.input as { members?: Array<{ serviceId: string; input: unknown }> } | null;
    return source && Array.isArray(source.members) ? source.members : [item];
  });
  const packed = packJudgmentInputs(members.map(item => ({ serviceId: item.serviceId, input: compactJudgmentInput(item.input) })));
  const matrices: unknown[] = [], criteria: unknown[] = [], qualities: unknown[] = [], judgments: unknown[] = [], matrixRows: unknown[] = [], comparisonRows: unknown[] = [], comparisonSets: unknown[] = [], serviceValues: unknown[] = [];
  const intern = (pool: unknown[], value: unknown) => {
    const encoded = JSON.stringify(value);
    let index = pool.findIndex(item => JSON.stringify(item) === encoded);
    if (index < 0) { index = pool.length; pool.push(value); }
    return index;
  };
  for (const item of packed.services) {
    const input = item.input as Record<string, any>;
    if (!input || typeof input !== "object") continue;
    if (input.judgment) {
      const j=input.judgment;
      const modelIndex=(name:string)=>{if(!packed.definitions.models.includes(name))packed.definitions.models.push(name);return packed.definitions.models.indexOf(name);};
      const flags=Number(j.assessable)+2*Number(j.complete)+4*Number(j.disagreement)+8*Number(j.nearBoundary)+16*Number(j.concerns)+32*Number(j.strongEvidence);
      input.j=intern(judgments,[flags,j.confidenceCeiling,j.experienceComparisons.map((row:any)=>[row.criterion.endsWith("wind")?0:1,modelIndex(row.model),row.forecast]),j.portSignals.strongWindModels.map(modelIndex),j.portSignals.rainModels.map(modelIndex),Number(j.portSignals.largeMorningPrior)]);
      delete input.judgment;
    }
    {
      const s = input.s;
      input.s = [s?.shipType,s?.direction,s?.counterpartTerminal,s?.scheduledDepartureJst,s?.scheduledArrivalJst,s?.voyageNumber].map(value=>value==null?null:intern(serviceValues,value));
      input.q = intern(qualities,input.quality);
      delete input.quality;
      const ml = input.mlReference;
      input.mlReference = [ml?.mean,ml?.min,ml?.max,ml?.range,ml?.agreement];
    }
    for (const field of ["w", "sea"]) if (Array.isArray(input[field])) {
      input[field] = input[field].map(([model, matrix]: [number, number[][]]) => {
        // Only established operational signals for AI judgment: wind/total
        // wave and swell context. The complete ML/weather records are retained.
        const columns = field === "w" ? [0,1] : [0,1,6,7];
        // No adopted judgment rule uses the blanket 3h/6h deltas. Retain raw
        // records for ML/audit, send the three operational phases only.
        const values = matrix.slice(0,3).map(row=>columns.map(column=>row[column]));
        return [model, intern(matrices, values.map(row => intern(matrixRows,row)))];
      });
    }
    if (Array.isArray(input.officialCriteria)) input.officialCriteria = input.officialCriteria.map((criterion: any) => {
      if (!packed.definitions.models.includes(criterion.model)) packed.definitions.models.push(criterion.model);
      const model=packed.definitions.models.indexOf(criterion.model);
      const name=String(criterion.criterion);
      const phase=name.includes("_route_")?1:name.includes("_oshima_entry_")?2:name.includes("_departure_port_")?0:null;
      const field=criterion.unit==="m/s"?"w":criterion.unit==="m"?"sea":null;
      const matrix=field?(input[field] as Array<[number,number]>).find(([m])=>m===model)?.[1]:undefined;
      const rows=matrix===undefined?undefined:matrices[matrix] as number[];
      const row=phase===null?undefined:rows?.[phase];
      const forecast=row===undefined?undefined:(matrixRows[row] as Array<number|null>)[0];
      // Only reuse a phase value when it matches exactly. Unknown/custom rules
      // and distinct comparison windows retain their explicit forecast value.
      const shared=phase!==null&&field!==null&&forecast!==undefined&&forecast===criterion.forecast;
      const definition=[criterion.criterion,criterion.unit,criterion.threshold,shared?[field,phase,0]:null];
      const comparison=[intern(criteria,definition),model,["below","near_internal","reached","missing"].indexOf(criterion.status)];
      if(!shared)comparison.push(criterion.forecast);
      return intern(comparisonRows,comparison);
    });
    if(Array.isArray(input.officialCriteria))input.officialCriteria=intern(comparisonSets,input.officialCriteria);
  }
  const groupWeather = packed.definitions.weather.filter((_,i)=>[0,1].includes(i));
  const groupMarine = packed.definitions.marine.filter((_,i)=>[0,1,6,7].includes(i));
  const byId = new Map(packed.services.map(item => [item.serviceId, item.input]));
  const groupRegions:unknown[]=[],groupEvents:unknown[]=[],groupPeriods:unknown[]=[],groupComparisons:unknown[]=[],groupConditions:unknown[]=[],groupLocations:string[]=[];
  const modelIndex=(name:string)=>{if(!packed.definitions.models.includes(name))packed.definitions.models.push(name);return packed.definitions.models.indexOf(name);};
  const locationIndex=(name:string)=>{if(!groupLocations.includes(name))groupLocations.push(name);return groupLocations.indexOf(name);};
  const rounded=(value:number|null)=>value===null?null:Math.round(value*1000)/1000;
  const event=(value:GroupJudgmentMaterial["regions"][number]["wind"][number]["low"])=>value===null?null:intern(groupEvents,[rounded(value[0]),value[1],locationIndex(value[2]),rounded(value[3])]);
  const comparisons=(rows:GroupJudgmentMaterial["official"])=>{
    const byCriterion=new Map<string,typeof rows>();
    for(const row of rows){const key=JSON.stringify([row.criterion,row.unit,row.threshold]);byCriterion.set(key,[...(byCriterion.get(key)??[]),row]);}
    return [...byCriterion.values()].map(values=>{
      const first=values[0]!;
      const conditions=values.map(row=>{
        const [min,max]=row.range.map(rounded);
        const state=(status:string)=>({below:1,near_internal:2,reached:4,missing:8}[status]??0);
        const condition:unknown[]=[modelIndex(row.model),min===max?[max]:[min,max],row.states.reduce((flags,status)=>flags|state(status),0),intern(groupPeriods,row.periods)];
        if(row.statePeriods.length)condition.push(row.statePeriods.map(([status,periods])=>[state(status),intern(groupPeriods,periods)]));
        return condition;
      });
      const worst=values.filter(row=>row.range[1]!==null).sort((a,b)=>b.range[1]!-a.range[1]!)[0];
      return intern(groupComparisons,[intern(criteria,[first.criterion,first.unit,first.threshold,null]),intern(groupConditions,conditions),event(worst?.peak??null)]);
    });
  };
  const aggregateInputs=new Map<string,unknown>();
  const onlyAggregate=items.length>0&&items.every(item=>aggregate(item.input));
  for(const item of items){
    const material=aggregate(item.input);if(!material)continue;
    const regions=material.regions.map(row=>intern(groupRegions,[row.area,row.points.map(locationIndex),intern(groupPeriods,row.periods),
      // Wind/wave variation relevant to a rule is in applicable-window peak
      // ranges below, rather than unrelated instantaneous minima across sites.
      row.wind.map(w=>[modelIndex(w.model),event(w.high),Number(w.missing)]),
      row.sea.map(s=>[modelIndex(s.model),event(s.wave[1]),rounded(s.swell[0]?.[0]??null),event(s.swell[1]),Number(s.missing)]),
      row.rain.map(r=>[modelIndex(r.model),r.wetHours,Number(r.missing)])]));
    const source=item.input as {label?:string;previousPrediction?:unknown};
    aggregateInputs.set(item.serviceId,{scope:"group",format:material.version,label:source.label,date:material.date,shipType:material.shipType,coveredServices:material.count,
      regions,officialCriteria:comparisons(material.official),experienceCriteria:comparisons(material.experience),
      policy:[material.policy.flags,material.policy.confidenceCeiling,{none:0,some:1,all:2}[material.policy.largeMorningPrior]],mlReference:material.ml.map(([route,min,max,agreement])=>[route,rounded(min),rounded(max),agreement]),
      ...(source.previousPrediction?{prev:source.previousPrediction}:{})});
  }
  return { definitions: { phases:onlyAggregate?[]:["d","r","a"], models:packed.definitions.models, weather:onlyAggregate?[]:groupWeather, marine:onlyAggregate?[]:groupMarine,
    // Item-by-item research labels have no adopted effect on judgment. Retain
    // their uncertainty restriction, rather than repeating the unused table.
    knowledge:{experience:JUDGMENT_KNOWLEDGE.experience,evidenceLimit:JUDGMENT_KNOWLEDGE.evidenceLimit,gradeCalibration:"A〜D校正/予報誤差感度は未検証。確信度4/5不可。"}, judgments, judgment_columns:["flags:1=all-phase-wind-wave-present,2=complete,4=disagreement,8=near,16=concerns,32=strongEvidence","confidenceCeiling","experience:[0=wind/1=wave,model,value]","okadaWindModels","rainModels","largeMorningPrior"], service_columns:onlyAggregate?[]:["shipType","direction","counterpartTerminal","scheduledDepartureJst","scheduledArrivalJst","voyageNumber"],
    qualities,ml_columns:onlyAggregate?[]:["mean","min","max","range","agreement"], matrixRows, matrices, comparisonRows, comparisonSets, serviceValues, criteria,
    ...(aggregateInputs.size?{groupRegions,groupEvents,groupPeriods,groupComparisons,groupConditions,groupLocations}:{} )}, services: items.map(item => {
    const constraints={allowedGrades:allowedJudgmentGrades(item.input),...((item.input as any)?.responseCorrection?{responseCorrection:(item.input as any).responseCorrection}:{})};
    if(aggregateInputs.has(item.serviceId))return{serviceId:item.serviceId,input:{...(aggregateInputs.get(item.serviceId) as object),...constraints}};
    const input = item.input as { scope?: string; label?: string; previousPrediction?: unknown; members?: Array<{ serviceId: string }> } | null;
    return input && Array.isArray(input.members)
      ? { serviceId: item.serviceId, input: { scope: "group", label: input.label, ...constraints,...(input.previousPrediction?{prev:input.previousPrediction}:{}), members: input.members.map(member => ({ serviceId: member.serviceId, input: byId.get(member.serviceId) })) } }
      : { serviceId: item.serviceId, input: {...(byId.get(item.serviceId) as object),...constraints} };
  }) };
}

function materialCriteria(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const source = input as Record<string, unknown>;
  const criteria = Array.isArray(source.members) ? source.members.flatMap((m: any) => m.input?.officialCriteria ?? []) : source.officialCriteria;
  if (!Array.isArray(criteria)) return [];
  return criteria.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (row.status !== "near_internal" && row.status !== "reached") return [];
    if (typeof row.criterion !== "string" || typeof row.forecast !== "number" || typeof row.threshold !== "number" || typeof row.unit !== "string") return [];
    return [{ criterion: row.criterion, forecast: row.forecast, threshold: row.threshold, unit: row.unit, status: row.status === "near_internal" ? "near" as const : "reached" as const }];
  });
}

export async function assessGroqBatch<T>(items: Array<{ serviceId: string; input: unknown; ml: T }>, apiKey: string, fetchFn: typeof fetch = fetch, maxCompletionTokens=1600, dailyDate?: string) {
  const inputs = packDirectJudgments(items);
  const transport=items.every(item=>(item.input as any)?.aggregateJudgment)?{...inputs,definitions:Object.fromEntries(Object.entries(inputs.definitions).filter(([,value])=>!Array.isArray(value)||value.length>0))}:inputs;
  const inputMap = new Map(items.map((item) => [item.serviceId, item.input]));
  let daily: DailyAssessment | null = null;
  let dailyError: string | undefined;
  const schema = dailyDate ? strictObject({ services: compactServiceSchema, daily: strictObject({ date: {type:"string",enum:[dailyDate]}, evaluation_grade:{type:"string",enum:["A","B","C","D"]}, assessment:{type:"string"} }) }) : batchFinalSchema;
  const finals = await generateStrict(GROQ_MODELS.final,
    `${dailyDate?DAILY_FINAL_RULES:FINAL_RULES}\n${ASSESSMENT_LIMIT_RULES}\n説明文内の評価名は良好・見込・注意・困難を使う。evaluation_gradeは対応するA/B/C/Dのまま返す。\n${dailyDate ? DAILY_RULES + " 指定日=" + dailyDate : "allowedGradesを守りresponseCorrectionを解消する。"}\n${items.every(item=>(item.input as any)?.aggregateJudgment)?GROUP_WEATHER_RULES:GROUP_RULES+(items.some(item=>(item.input as any)?.aggregateJudgment)?"\n"+GROUP_WEATHER_RULES:"")}\n判断材料:\n${JSON.stringify(transport)}`,
    schema,
    (value) => {
      if (dailyDate) { try { daily = validateDailyAssessment((value as any)?.daily, dailyDate); } catch(error) { dailyError = String(error); } }
      const decoded=dailyDate?{...(value as object),services:((value as any)?.services??[]).map((source:Record<string,unknown>)=>{
        const row=Object.fromEntries(Object.keys(outputAliases).map(key=>[key,source[outputAliases[key]!]??source[key]]));
        if(typeof row.port_reasons==='string')row.port_reasons=[row.port_reasons];
        return row;
      })}:value;
      return validateBatch(decoded, (item) => {
      const source=item as Record<string,unknown>;
      const row=dailyDate?Object.fromEntries(Object.keys(outputAliases).map(key=>[key,source[outputAliases[key]!]??source[key]])):source;
      for(const field of ['positive_factors','negative_factors','port_reasons'])if(typeof row[field]==='string')row[field]=[row[field]];
      // These fields are owned by the program; the API need not generate them.
      return validateAssessment({...row,confidence_level:1,confidence_reasons:[],official_criteria_status:[],summary:row.assessment});
    }).map((row) => {
      const input = inputMap.get(row.serviceId);
      if (!inputMap.has(row.serviceId)) throw new Error(`Unexpected Groq service_id: ${row.serviceId}`);
      const grounded = { ...row.value, official_criteria_status: materialCriteria(input) };
      try { const validated = validateGrounding(grounded, input && typeof input === "object" && "members" in input ? { officialCriteria: materialCriteria(input) } : input);validateAssessmentLimits(validated);validateJudgmentComment(validated,input);return { ...row, value: enforceJudgmentPolicy(validated,input), policyError:undefined }; }
      catch(error) { return { ...row, value:null, policyError:error instanceof Error?error.message:String(error) }; }
    }); },
    apiKey, fetchFn, maxCompletionTokens);
  const finalMap = new Map(finals.map((row) => [row.serviceId, row]));
  if (items.some((item) => !finalMap.has(item.serviceId))) throw new Error(`Groq batch final omitted a service [stage=final, phase=service_coverage, missing=${items.filter(item => !finalMap.has(item.serviceId)).map(item => item.serviceId).join(",")}, returned=${[...finalMap.keys()].join(",")}]`);
  return items.map((item) => ({
    ...(dailyDate ? {dailyDate, daily, dailyError} : {}),
    ml: item.ml, forecastSummary: null, ai: finalMap.get(item.serviceId)!.value, aiStatus: finalMap.get(item.serviceId)!.value ? "generated" as const : "unavailable" as const,
    ...(finalMap.get(item.serviceId)!.policyError ? {error:finalMap.get(item.serviceId)!.policyError} : {}),
    geminiModels: { summary: GROQ_MODELS.summary, final: GROQ_MODELS.final },
    aiProviders: { summary: "none", final: "groq" }, promptVersion: GROQ_PROMPT_VERSION
  }));
}

// Recovery only: all targets for the date, never a partial split's daily grade.
// Validated target comments supply outlook; unavailable targets retain weather
// material and an explicit missing assessment. The AI still chooses the grade.
export async function assessGroqDaily<T>(items:Array<{serviceId:string;input:unknown}>,results:Array<{ai:FinalAssessment|null;error?:string}>,date:string,apiKey:string,fetchFn:typeof fetch) {
  const services=items.map((item,index)=>({serviceId:item.serviceId,input:{
    service:(item.input as any)?.service,label:(item.input as any)?.label,
    ...(results[index]?.ai?{assessment:results[index]!.ai}:{weather:(item.input as any)?.aggregateJudgment??compactJudgmentInput(item.input),assessmentUnavailable:results[index]?.error??"評価未取得"})
  }}));
  return generateStrict(GROQ_MODELS.final,`${DAILY_RULES} 指定日=${date}。総評は200文字以内。全対象の根拠から評価し、便の評価を平均したり最低値を取ったりしない。未取得の評価を推測で補わない。\n判断材料:\n${JSON.stringify({services})}`,
    strictObject({daily:strictObject({date:{type:"string",enum:[date]},evaluation_grade:{type:"string",enum:["A","B","C","D"]},assessment:{type:"string"}})}),
    value=>validateDailyAssessment((value as any)?.daily,date),apiKey,fetchFn,1000);
}

export async function assessGroqSingle<T>(input: unknown, ml: T, apiKey: string, fetchFn: typeof fetch = fetch) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const service = source.service && typeof source.service === "object" && !Array.isArray(source.service) ? source.service as Record<string, unknown> : {};
  const serviceId = typeof service.serviceId === "string" && service.serviceId ? service.serviceId : "single";
  const [result] = await assessGroqBatch([{ serviceId, input, ml }], apiKey, fetchFn);
  return result!;
}
