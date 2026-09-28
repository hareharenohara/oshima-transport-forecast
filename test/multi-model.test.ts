import test from "node:test"; import assert from "node:assert/strict";
import { WEATHER_MODELS, MARINE_MODELS } from "../src/forecast/multi-model.js";
test("phase 2 uses the audited forecast model set",()=>{assert.deepEqual(WEATHER_MODELS.map(x=>x.id),["jma_msm","ecmwf_ifs025","gfs_seamless"]);assert.deepEqual(MARINE_MODELS.map(x=>x.id),["ecmwf_wam","ncep_gfswave025"])});
