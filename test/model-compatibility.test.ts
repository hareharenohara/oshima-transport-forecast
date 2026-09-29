import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertCompatible127Model, assertCompatibleEnsembleModel, predictEnsembleRisk, predictRisk, type EnsembleModelBundle, type ModelBundle } from "../src/ml/inference.js";

test("audited 127-feature model is accepted", async () => {
  const bundle = JSON.parse(await readFile(new URL("models/cloudflare_portable_model.json", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8")) as ModelBundle;
  assert.doesNotThrow(() => assertCompatible127Model(bundle));
});

test("legacy 131-feature model is rejected", async () => {
  const bundle = JSON.parse(await readFile(new URL("models/cloudflare_portable_model.legacy-131.json", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8")) as ModelBundle;
  assert.throws(() => assertCompatible127Model(bundle), /expected audited 127-feature model, received 131/);
});

test("TypeScript inference matches the Python golden probability", async () => {
  const bundle = JSON.parse(await readFile(new URL("models/cloudflare_portable_model.json", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8")) as ModelBundle;
  const prep = bundle.models.all.preprocessor;
  const raw: Record<string, string | number> = {
    ...prep.medians,
    ship_type: "jet", direction: "to_oshima", counterpart_terminal: "東京", voyage_number: "1100"
  };
  const result = predictRisk(raw, bundle);
  assert.ok(Math.abs(result.cancellationProbability - 0.015387042824677089) < 1e-15);
});

test("V1 85% + V2 15% ensemble matches the Python golden probability", async () => {
  const bundle = JSON.parse(await readFile(new URL("models/cloudflare_portable_model.v2.json", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8")) as EnsembleModelBundle;
  assert.doesNotThrow(() => assertCompatibleEnsembleModel(bundle));
  assert.equal(bundle.blend.v1_weight, 0.85);
  assert.ok(Math.abs(bundle.blend.v2_weight - 0.15) < 1e-15);
  const categories = { ship_type: "jet", direction: "to_oshima", counterpart_terminal: "東京", voyage_number: "1100" };
  const rawV1: Record<string, string | number> = { ...bundle.v1_component.preprocessor.medians, ...categories };
  const rawV2: Record<string, string | number> = { ...bundle.v2_component.preprocessor.medians, ...categories };
  const result = predictEnsembleRisk(rawV1, rawV2, bundle);
  assert.ok(Math.abs(result.cancellationProbability - 0.014399903639843207) < 1e-15);
  assert.equal(result.modelVersion, "v2-ensemble-1");
});
