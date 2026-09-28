// Dependency-free inference helper for Cloudflare Workers.
// Load cloudflare_portable_model.json and pass one feature record to predictRisk().

function sigmoid(x) {
  const z = Math.max(-35, Math.min(35, x));
  return 1 / (1 + Math.exp(-z));
}

function derivedTimeFeatures(record) {
  const d = new Date(record.scheduled_departure_jst);
  const month = d.getMonth();
  const hour = d.getHours() + d.getMinutes() / 60;
  const day = d.getDay();
  return {
    departure_month_sin: Math.sin(2 * Math.PI * month / 12),
    departure_month_cos: Math.cos(2 * Math.PI * month / 12),
    departure_hour_sin: Math.sin(2 * Math.PI * hour / 24),
    departure_hour_cos: Math.cos(2 * Math.PI * hour / 24),
    departure_weekend: day === 0 || day === 6 ? 1 : 0,
  };
}

function buildVector(record, prep) {
  const enriched = { ...record, ...derivedTimeFeatures(record) };
  const vector = [];
  for (const name of prep.numeric_cols) {
    const raw = Number(enriched[name]);
    const value = Number.isFinite(raw) ? raw : prep.medians[name];
    vector.push((value - prep.means[name]) / prep.stds[name]);
  }
  for (const name of prep.category_cols) {
    const value = enriched[name] == null ? "__MISSING__" : String(enriched[name]);
    for (const level of prep.levels[name]) vector.push(value === level ? 1 : 0);
  }
  return vector;
}

function rawScore(vector, model) {
  if (model.type === "logistic_regression") {
    let score = model.intercept;
    for (let i = 0; i < vector.length; i++) score += vector[i] * model.coef[i];
    return score;
  }
  if (model.type === "gradient_boosted_stumps") {
    let score = model.initial_logit;
    for (const stump of model.stumps) {
      score += model.learning_rate *
        (vector[stump.feature_index] <= stump.threshold ? stump.left_value : stump.right_value);
    }
    return score;
  }
  throw new Error(`Unsupported model type: ${model.type}`);
}

export function predictRisk(record, bundle, scope = "all") {
  const spec = bundle.models[scope];
  if (!spec) throw new Error(`Unknown model scope: ${scope}`);
  const vector = buildVector(record, spec.preprocessor);
  const score = rawScore(vector, spec.model);
  const probability = sigmoid(spec.calibrator.a * score + spec.calibrator.b);
  return {
    probability,
    highRisk: probability >= spec.threshold,
    threshold: spec.threshold,
    model: spec.selected_model,
    scope,
  };
}
