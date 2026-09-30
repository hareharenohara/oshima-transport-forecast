/** Presentation only: the stored S/A/B/C/D assessment is not recalculated here. */
export const GRADE_GAUGE_CSS = `
.grade-gauge,.service-grade{--grade-color:#64777d}
[data-grade="D"]{--grade-color:#c52828}
[data-grade="C"]{--grade-color:#b75b08}
[data-grade="B"]{--grade-color:#2563c7}
[data-grade="A"]{--grade-color:#168252}
[data-grade="S"]{--grade-color:#09623e}
.grade-gauge{width:100%;padding:2px 0 4px;text-align:center}
.grade-status{display:flex;justify-content:center;align-items:center;gap:10px;min-height:42px;margin-bottom:8px;color:var(--grade-color);font-size:17px;font-weight:800}
.grade-badge{display:inline-grid;place-items:center;flex:none;width:40px;height:40px;border-radius:12px;background:var(--grade-color);color:#fff;font-size:25px;line-height:1}
.grade-axis{position:relative;height:42px;margin:0 10%}
.grade-track{position:absolute;left:0;right:0;top:28px;height:8px;border-radius:99px;background:linear-gradient(90deg,#ef4444 0%,#f59e0b 25%,#3b82f6 50%,#10b981 75%,#059669 100%)}
.grade-node{position:absolute;top:32px;width:15px;height:15px;transform:translate(-50%,-50%);border:3px solid var(--line);border-radius:50%;background:var(--card)}
.grade-node.active{width:21px;height:21px;border:4px solid var(--grade-color);box-shadow:0 0 0 3px var(--card)}
.grade-pointer{position:absolute;top:2px;width:12px;height:12px;border-radius:50%;background:var(--grade-color);transform:translateX(-50%)}
.grade-pointer:after{content:"";position:absolute;left:3px;top:10px;border-left:3px solid transparent;border-right:3px solid transparent;border-top:5px solid var(--grade-color)}
.grade-labels{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;margin-top:4px;color:var(--muted)}
.grade-labels b{display:block;font-size:15px;line-height:1.5}
.grade-labels small{display:block;font-size:10px;font-weight:600;white-space:nowrap;line-height:1.6}
.grade-labels .active{color:var(--grade-color);font-weight:800}
.grade-gauge[data-grade="pending"] .grade-track{background:var(--line)}
.grade-gauge[data-grade="pending"] .grade-status{color:var(--muted)}
.service .grade-badge{width:32px;height:32px;min-width:32px;border-radius:9px;font-size:19px;color:#fff}
:root[data-theme="dark"] .grade-status,:root[data-theme="dark"] .grade-labels .active{color:var(--ink)}
@media(max-width:420px){.service{grid-template-columns:52px 64px minmax(0,1fr) 32px}.grade-status{font-size:16px}.grade-labels small{font-size:9px}}
`;
