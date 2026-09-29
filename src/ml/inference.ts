import { MODEL_FEATURE_NAMES } from "./feature-names.js";

interface BundleModel {
  selected_model: string;
  threshold: number;
  preprocessor: { feature_names: string[]; numeric_cols: string[]; category_cols: string[]; medians: Record<string, number>; means: Record<string, number>; stds: Record<string, number>; levels: Record<string, string[]> };
  model: { type: string; coef: number[]; intercept: number };
  calibrator: { a: number; b: number };
}
export interface ModelBundle { schema_version: string; models: { all: BundleModel } }

interface PortablePreprocessor {
  feature_names: string[];
  numeric_cols: string[];
  category_cols: string[];
  medians: Record<string, number>;
  means: Record<string, number>;
  stds: Record<string, number>;
  levels: Record<string, string[]>;
}

type PortableModel =
  | { type: "logistic_regression"; coef: number[]; intercept: number }
  | { type: "gradient_boosted_stumps"; initial_logit: number; learning_rate: number; stumps: Array<{ feature_index: number; threshold: number; left_value: number; right_value: number }> };

interface PortableComponent {
  schema_version: string;
  preprocessor: PortablePreprocessor;
  model: PortableModel;
  calibrator: { type?: string; a: number; b: number };
}

export interface EnsembleModelBundle {
  schema_version: "v2-ensemble-1";
  status: string;
  probability_meaning: string;
  blend: { v1_weight: number; v2_weight: number; decision_threshold: number };
  v1_component: PortableComponent;
  v2_component: PortableComponent;
}

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

function componentProbability(raw: Record<string, string | number>, component: PortableComponent): number {
  const vector: number[] = [];
  for (const name of component.preprocessor.numeric_cols) {
    const parsed = Number(raw[name]);
    const value = Number.isFinite(parsed) ? parsed : component.preprocessor.medians[name];
    if (!Number.isFinite(value)) throw new Error(`MODEL_INPUT_MISSING: ${name}`);
    vector.push((value! - component.preprocessor.means[name]!) / component.preprocessor.stds[name]!);
  }
  for (const category of component.preprocessor.category_cols) {
    const rawValue = raw[category] == null ? "__MISSING__" : String(raw[category]);
    for (const level of component.preprocessor.levels[category]!) vector.push(rawValue === level ? 1 : 0);
  }
  let score: number;
  if (component.model.type === "logistic_regression") {
    const model = component.model;
    score = model.intercept + vector.reduce((sum, value, index) => sum + value * model.coef[index]!, 0);
  } else {
    score = component.model.initial_logit;
    for (const stump of component.model.stumps) {
      score += component.model.learning_rate * (vector[stump.feature_index]! <= stump.threshold ? stump.left_value : stump.right_value);
    }
  }
  const calibrated = Math.max(-35, Math.min(35, component.calibrator.a * score + component.calibrator.b));
  return 1 / (1 + Math.exp(-calibrated));
}

export function assertCompatibleEnsembleModel(bundle: EnsembleModelBundle): void {
  const v1Names = bundle.v1_component?.preprocessor?.feature_names;
  const v2Names = bundle.v2_component?.preprocessor?.feature_names;
  const weightsTotal = bundle.blend?.v1_weight + bundle.blend?.v2_weight;
  if (bundle.schema_version !== "v2-ensemble-1"
    || !v1Names || v1Names.length !== 127 || v1Names.some((name, index) => name !== MODEL_FEATURE_NAMES[index])
    || !v2Names || v2Names.length !== 192
    || Math.abs(weightsTotal - 1) > 1e-12
    || bundle.blend.v1_weight < 0 || bundle.blend.v2_weight < 0) {
    throw new Error("MODEL_INCOMPATIBLE: expected v1-127 + v2-hybrid-1 ensemble");
  }
}

export function predictEnsembleRisk(
  rawV1: Record<string, string | number>,
  rawV2: Record<string, string | number>,
  bundle: EnsembleModelBundle
) {
  assertCompatibleEnsembleModel(bundle);
  const v1CancellationProbability = componentProbability(rawV1, bundle.v1_component);
  const v2CancellationProbability = componentProbability(rawV2, bundle.v2_component);
  const cancellationProbability = bundle.blend.v1_weight * v1CancellationProbability + bundle.blend.v2_weight * v2CancellationProbability;
  return {
    cancellationProbability,
    operationProbability: 1 - cancellationProbability,
    threshold: bundle.blend.decision_threshold,
    modelVersion: bundle.schema_version,
    featuresVersion: "v1-127+v2-hybrid-1",
    components: { v1CancellationProbability, v2CancellationProbability, v1Weight: bundle.blend.v1_weight, v2Weight: bundle.blend.v2_weight }
  };
}
