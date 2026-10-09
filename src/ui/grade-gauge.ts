/** Presentation only: the stored A/B/C/D assessment is not recalculated here. */
export const GRADE_GAUGE_CSS = `
.grade-gauge,.service-grade{--grade-color:#64777d;--grade-on-color:#fff;--grade-text-color:var(--grade-color)}
[data-grade="D"]{--grade-color:#a92323}
[data-grade="C"]{--grade-color:#b75b08}
[data-grade="B"]{--grade-color:#168252}
[data-grade="A"]{--grade-color:#2563c7}
.grade-gauge{width:100%;padding:2px 0 4px;text-align:center}
.grade-status{display:flex;align-items:center;gap:12px;padding:14px;border-radius:12px;margin-bottom:14px;text-align:left;color:var(--grade-text-color);background:color-mix(in srgb,var(--grade-color) 12%,var(--card));border:1px solid color-mix(in srgb,var(--grade-color) 35%,var(--line))}
.grade-badge{display:inline-grid;place-items:center;flex:none;width:64px;height:40px;border-radius:8px;background:var(--grade-color);color:var(--grade-on-color);font-size:20px;font-weight:800;line-height:1;white-space:nowrap}
.grade-description{min-width:0;flex:1;font-size:14px;font-weight:700;line-height:1.6;overflow-wrap:anywhere}
.grade-segments{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:4px;border-radius:12px;background:var(--paper);border:1px solid var(--line)}
.grade-segment{display:grid;place-items:center;min-height:42px;border-radius:8px;color:var(--muted);font-size:15px;font-weight:800;line-height:1.4;white-space:nowrap}
.grade-segment.active{background:var(--grade-color);color:var(--grade-on-color);box-shadow:0 2px 8px color-mix(in srgb,var(--grade-color) 35%,transparent)}
.day-summary{gap:10px}
.day-summary .grade-gauge{padding:0}
.daily-overview{margin:12px 0 18px;padding:0;text-align:left}
.assessment-overview{margin:13px 0 0;padding:0;text-align:left}
.detail-overview .assessment-overview{grid-column:1/-1;margin-top:0}
.daily-overview .grade-status,.assessment-overview .grade-status{align-items:flex-start;margin:0}
.daily-overview .grade-badge,.assessment-overview .grade-badge{margin-top:2px}
.grade-comment{font-size:13px;font-weight:400;line-height:1.8}
.grade-comment small{font-size:11px;color:var(--muted)}
.service .grade-badge{width:46px;height:32px;min-width:46px;border-radius:9px;font-size:16px;color:var(--grade-on-color)}
:root[data-theme="dark"] .grade-status{color:var(--ink)}
@media(max-width:420px){.grade-status{padding:12px;gap:10px}.grade-description{font-size:13px}.grade-segment{font-size:14px;min-height:40px}}
`;
