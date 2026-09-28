# Phase 2 status

Weather models are requested from JMA MSM, ECMWF IFS, and GFS. Marine models are requested from ECMWF WAM and GFS Wave. Each request batches all 11 audited points.

Live validation on 2026-09-28 found that JMA MSM returned missing `wind_gusts_10m` values at required points and ECMWF WAM returned missing wind-wave components. They cannot reproduce all 127 audited features and are excluded from ML inference with explicit failure records. ECMWF/GFS weather combined with GFS Wave produced complete features and model probabilities. No missing value was filled or approximated.

The comparison output includes mean, min, max, range, population standard deviation, configurable agreement class, per-model values, and source failures.
