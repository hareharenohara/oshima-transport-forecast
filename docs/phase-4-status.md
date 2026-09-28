# Phase 4 status

The mobile-first preview UI, “島ゆき予報”, is served directly by the Worker root URL. It provides the three required levels: day summaries, expandable service lists, and a service detail sheet.

Day cards show average and minimum operation likelihood, service count, low-likelihood count, trend text, and the predicted port when available. Service cards show route, time, vessel type, voyage number, likelihood, and whether the value is the final AI assessment or an ML provisional value.

The detail sheet shows an operation progress ring, confidence bar, assessment summary, positive and negative factors, per-model cancellation risk, change from the previous prediction, official-information guidance, and update time. When Gemini is unavailable, the UI explicitly labels the averaged ML operation probability as provisional instead of inventing an AI assessment.

The UI has no runtime framework dependency. It includes responsive layouts, reduced-motion support, a web manifest, content-security headers, and a lightweight SVG icon. Local browser verification covered the day accordion, service detail loading, and a 390-pixel mobile viewport. Weather-variable time series are not yet persisted, so wind, wave, and swell charts remain the next Phase 4 increment.
