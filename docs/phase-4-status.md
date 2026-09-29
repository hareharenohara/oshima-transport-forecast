# Phase 4 status

The mobile-first preview UI, “大島航路予報”, is served directly by the Worker root URL. It provides the three required levels: day summaries, expandable service lists, and a service detail sheet.

Day cards show average and minimum operation likelihood, service count, low-likelihood count, trend text, and the predicted port when available. Service cards show route, time, vessel type, voyage number, likelihood, and whether the value is the final AI assessment or an ML provisional value.

The detail sheet shows an operation progress ring, confidence bar, assessment summary, positive and negative factors, per-model cancellation risk, change from the previous prediction, official-information guidance, and update time. It also renders the append-only prediction history as an accessible SVG trend chart, using the AI operation probability when available and the explicitly labelled ML fallback basis otherwise. When Gemini is unavailable, the UI explicitly labels the averaged ML operation probability as provisional instead of inventing an AI assessment.

The UI has no runtime framework dependency. It includes responsive layouts, reduced-motion support, a web manifest, content-security headers, and a lightweight SVG icon. Light/dark presentation follows the operating-system preference by default, can be changed manually, and persists the explicit choice in local storage. Automated asset tests cover the trend and theme controls; local browser verification previously covered the day accordion, service detail loading, and a 390-pixel mobile viewport.

All Phase 4 completion conditions in the master specification are now implemented. Weather-variable time series are not yet persisted, so the wind, wave, and swell charts described as optional detail data remain a future increment and do not alter the completed prediction-history chart.
