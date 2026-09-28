import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertCompatible127Model, predictRisk, type ModelBundle } from "../src/ml/inference.js";

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
