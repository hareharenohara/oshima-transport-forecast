import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertCompatible127Model, type ModelBundle } from "../src/ml/inference.js";

test("provided legacy 131-feature model is rejected", async () => {
  const bundle = JSON.parse(await readFile(new URL("models/cloudflare_portable_model.json", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8")) as ModelBundle;
  assert.throws(() => assertCompatible127Model(bundle), /expected audited 127-feature model, received 131/);
});
