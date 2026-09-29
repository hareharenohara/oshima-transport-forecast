# Phase 4 status

The mobile-first preview UI, “大島航路予報”, is served directly by the Worker root URL. It provides the three required levels: day summaries, expandable service lists, and a service detail sheet.

Day cards show average and minimum operation likelihood, service count, low-likelihood count, trend text, and the predicted port when available. Service cards show route, time, vessel type, voyage number, likelihood, and whether the value is the final AI assessment or an ML provisional value.

The detail sheet shows the AI operation assessment on an `E D C B A` scale and confidence on a `1 2 3 4 5` scale, with text and a marker so meaning does not depend on color. It also shows the assessment summary, positive and negative factors, per-model cancellation risk, change from the previous prediction, official-information guidance, and update time. The append-only trend chart uses only averaged ML operation probability and labels it as an ML reference value. Model-separated wind, gust, wave-height, wave-period, and swell-height charts use the same Open-Meteo data already fetched by Cron.

The UI has no runtime framework dependency. It includes responsive layouts, reduced-motion support, a web manifest, content-security headers, and a lightweight SVG icon. Light/dark presentation follows the operating-system preference by default, can be changed manually, and persists the explicit choice in local storage. Automated asset tests cover the trend and theme controls; local browser verification previously covered the day accordion, service detail loading, and a 390-pixel mobile viewport.

All Phase 4 completion conditions in the master specification are now implemented. Weather and marine time series are persisted per forecast run and service for 30 days. Route aggregation preserves the audited units: wind and gust are route maxima in `m/s`, wave and swell height are route maxima in `m`, and wave period is the route mean in `s`. This presentation data does not change the 127-feature model input.
