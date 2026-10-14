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
.grade-segments{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding:8px 0 0}
.grade-segment{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-height:52px;padding:0 0 19px;color:var(--muted);font-size:13px;font-weight:400;line-height:1.4;white-space:nowrap}
.grade-segment:after{content:'';position:absolute;left:0;right:0;bottom:0;height:3px;border-radius:3px;background:var(--line)}
.grade-segment.active{color:var(--grade-color);font-size:21px;font-weight:600}
.grade-segment.active:after{background:var(--grade-color)}
.grade-segment.active:before{content:'';position:absolute;left:50%;bottom:8px;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid var(--grade-color)}
:root[data-theme="dark"] .grade-segment.active[data-grade="D"]{--grade-color:#ef9292}
:root[data-theme="dark"] .grade-segment.active[data-grade="C"]{--grade-color:#edb568}
:root[data-theme="dark"] .grade-segment.active[data-grade="B"]{--grade-color:#56c697}
:root[data-theme="dark"] .grade-segment.active[data-grade="A"]{--grade-color:#89b5ff}
.day-summary{gap:10px}
.day-summary .grade-gauge{padding:0}
.service-list{border-top:0}
.daily-overview{grid-column:1/-1;margin:12px 0 18px;padding:0;text-align:left}
.assessment-overview{margin:13px 0 0;padding:0;text-align:left}
.detail-overview .assessment-overview{grid-column:1/-1;margin-top:0}
.daily-overview .grade-status,.assessment-overview .grade-status{align-items:flex-start;margin:0}
.daily-overview .grade-status{display:block}
.daily-overview .grade-comment{width:100%}
.assessment-overview .grade-badge{margin-top:2px}
.grade-comment{font-size:13px;font-weight:400;line-height:1.8}
.grade-comment small{font-size:11px;color:var(--muted)}
.service .grade-badge{width:46px;height:32px;min-width:46px;border-radius:9px;font-size:16px;color:var(--grade-on-color)}
:root[data-theme="dark"] .grade-status{color:var(--ink)}
@media(max-width:420px){.grade-status{padding:12px;gap:10px}.grade-description{font-size:13px}}
`;
