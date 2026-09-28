export interface ModelValue { model: string; value: number }
export interface ModelComparison { mean: number; min: number; max: number; range: number; stddev: number; agreement: "high" | "medium" | "low"; models: ModelValue[] }

export function compareModels(models: ModelValue[], mediumRange: number, lowRange: number): ModelComparison {
  if (models.length < 2 || models.some((x) => !Number.isFinite(x.value))) throw new Error("At least two finite model values are required");
  const values = models.map((x) => x.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values), max = Math.max(...values), range = max - min;
  const stddev = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { mean, min, max, range, stddev, agreement: range <= mediumRange ? "high" : range <= lowRange ? "medium" : "low", models };
}
