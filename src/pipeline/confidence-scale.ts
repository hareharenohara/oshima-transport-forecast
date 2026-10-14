export const CONFIDENCE_SCALE = "three-level-v1";
export type ConfidenceLevel = 1 | 2 | 3;
export function confidenceLevel(value: unknown, source?: { confidence_scale?: unknown; prompt_version?: unknown }): ConfidenceLevel | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  const current = source?.confidence_scale === CONFIDENCE_SCALE || String(source?.prompt_version ?? "").includes("confidence-three-level");
  if (current) return value >= 1 && value <= 3 ? value as ConfidenceLevel : null;
  return value >= 1 && value <= 5 ? value <= 2 ? 1 : value === 3 ? 2 : 3 : null;
}
