export const SERVICE_TIMELINE_CSS = `
.service.service-timeline{grid-template-columns:43px 10px auto minmax(0,1fr) auto 32px;gap:7px;min-height:46px;padding:0!important;margin:0;border:0;border-radius:0;background:transparent}
.service.service-timeline:hover{background:color-mix(in srgb,var(--sea) 5%,var(--card))}
.service.service-timeline:focus-visible{outline:2px solid var(--sea);outline-offset:2px}
.service-timeline .time{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.service-timeline .service-rail{position:relative;align-self:stretch}
.service-timeline .service-rail:before{content:'';position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--line)}
.service-timeline .service-rail:after{content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:5px;height:5px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 3px var(--card)}
.service-timeline:first-of-type .service-rail:before{top:50%}
.service-timeline:last-of-type .service-rail:before{bottom:50%}
.service-timeline .route{font-size:13px;font-weight:500;line-height:1.4}
.service-timeline .service-ship{font-size:11px;font-weight:400;color:var(--muted)}
.service-timeline .official-badge{display:block;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0;margin:0;background:transparent;font-size:11px;font-weight:400;line-height:1.4;color:var(--muted)}
.service-timeline .official-badge.stop{color:var(--risk)}
.service-timeline .official-badge.pending{color:#9a6508}
.service-timeline .service-grade{grid-column:6;width:auto;min-width:0;height:auto;padding:0;border-radius:0;background:transparent;color:var(--grade-color);font-size:16px;font-weight:500;line-height:1.4;text-align:right}
:root[data-theme="dark"] .service-timeline .service-grade[data-grade="D"]{--grade-color:#ef9292}
:root[data-theme="dark"] .service-timeline .service-grade[data-grade="C"]{--grade-color:#edb568}
:root[data-theme="dark"] .service-timeline .service-grade[data-grade="B"]{--grade-color:#56c697}
:root[data-theme="dark"] .service-timeline .service-grade[data-grade="A"]{--grade-color:#89b5ff}
:root[data-theme="dark"] .service-timeline .official-badge.pending{color:var(--sun)}
@media(max-width:420px){.service.service-timeline{gap:5px}}
@media(max-width:360px){.service.service-timeline{grid-template-columns:41px 8px auto minmax(0,1fr) auto 32px;gap:3px}.service-timeline .route{font-size:12px}}
`;
