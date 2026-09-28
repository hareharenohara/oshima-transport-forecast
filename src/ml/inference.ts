import { MODEL_FEATURE_NAMES } from "./feature-names.js";

interface BundleModel {
  selected_model: string;
  threshold: number;
  preprocessor: { feature_names: string[]; numeric_cols: string[]; category_cols: string[]; medians: Record<string, number>; means: Record<string, number>; stds: Record<string, number>; levels: Record<string, string[]> };
  model: { type: string; coef: number[]; intercept: number };
  calibrator: { a: number; b: number };
}
export interface ModelBundle { schema_version: string; models: { all: BundleModel } }

export function assertCompatible127Model(bundle: ModelBundle): void {
  const names = bundle.models?.all?.preprocessor?.feature_names;
  if (!names || names.length !== 127 || names.some((name, i) => name !== MODEL_FEATURE_NAMES[i])) {
    throw new Error(`MODEL_INCOMPATIBLE: expected audited 127-feature model, received ${names?.length ?? 0} features`);
  }
}

export function predictRisk(raw: Record<string, string | number>, bundle: ModelBundle) {
  assertCompatible127Model(bundle);
  const spec = bundle.models.all;
  const vector: number[] = [];
  for (const name of spec.preprocessor.numeric_cols) vector.push((Number(raw[name]) - spec.preprocessor.means[name]!) / spec.preprocessor.stds[name]!);
  for (const category of spec.preprocessor.category_cols) {
    const rawValue = raw[category] == null ? "__MISSING__" : String(raw[category]);
    for (const level of spec.preprocessor.levels[category]!) vector.push(rawValue === level ? 1 : 0);
  }
  const score = spec.model.intercept + vector.reduce((sum, value, index) => sum + value * spec.model.coef[index]!, 0);
  const z = Math.max(-35, Math.min(35, spec.calibrator.a * score + spec.calibrator.b));
  const cancellationProbability = 1 / (1 + Math.exp(-z));
  return { cancellationProbability, operationProbability: 1 - cancellationProbability, threshold: spec.threshold, modelVersion: bundle.schema_version, featuresVersion: "v1-127" };
}
