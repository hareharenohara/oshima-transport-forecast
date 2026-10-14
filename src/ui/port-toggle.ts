export const PORT_TOGGLE_CSS = `
.day{border-radius:20px}
.day-summary{padding:18px;gap:16px}
.day-heading{grid-template-columns:minmax(0,1fr) auto;align-items:start}
.day-heading strong{font-size:18px;font-weight:700}
.day-date-block{min-width:0}
.day-update-footer{grid-column:1/-1;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.day-update-footer>.card-updates{display:flex;flex-direction:column;gap:4px;width:100%;font-size:11px;line-height:1.5}
.day-update-footer>.card-updates>.update-last,.day-update-footer>.card-updates>.update-next{display:grid;grid-template-columns:14px auto auto minmax(0,1fr);align-items:center;gap:5px;padding:5px 0;background:transparent;border-radius:0;width:100%;min-width:0}
.day-update-footer .update-label{color:var(--muted);font-size:11px;font-weight:400;white-space:nowrap}
.day-update-footer .update-next .update-label{color:var(--muted)}
.day-update-footer .update-value{color:var(--ink);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.day-update-footer .update-clock{color:var(--muted);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right}
.day-update-footer .update-icon{width:14px;height:14px;color:var(--muted);flex-shrink:0}
.day-update-footer .update-next .update-icon{color:var(--muted)}
.day-update-footer>.card-updates>span:not(.update-last):not(.update-next){order:1}
.day-summary .grade-segments{padding-top:0}
.day-summary .grade-segment{min-height:42px;font-size:12px}
.day-summary .grade-segment.active{font-size:18px;font-weight:700}
.day-heading .day-port{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:10px;background:color-mix(in srgb,var(--sea) 10%,var(--card));color:var(--ink);font-size:12px;font-weight:500;line-height:1.5;align-self:start}
.day-heading .day-port .port-icon{color:var(--sea);font-size:14px;font-weight:400;line-height:1}
.day-heading .day-port .port-name{color:var(--ink);font-size:12px;font-weight:500;line-height:1.5}
.day-heading .day-port.port-pending{background:var(--paper);color:var(--muted);font-size:12px}
.day .daily-overview .grade-status,.day .daily-overview .panel{border-radius:10px}
@media(max-width:380px){.day-heading .day-port{font-size:12px}}
`;
