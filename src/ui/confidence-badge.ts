export const CONFIDENCE_BADGE_CSS = `
.confidence-header{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.confidence-header h3{margin:0}
.confidence-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:600;line-height:16px;border:1px solid;white-space:nowrap}
.confidence-dot{width:6px;height:6px;border-radius:50%;flex:none}
.confidence-badge[data-level="3"]{background:#ecfdf5;color:#047857;border-color:rgba(167,243,208,.8)}
.confidence-badge[data-level="3"] .confidence-dot{background:#10b981}
.confidence-badge[data-level="2"]{background:#fffbeb;color:#b45309;border-color:rgba(253,230,138,.8)}
.confidence-badge[data-level="2"] .confidence-dot{background:#f59e0b}
.confidence-badge[data-level="1"],.confidence-badge[data-level="unknown"]{background:#f1f5f9;color:#475569;border-color:#e2e8f0}
.confidence-badge[data-level="1"] .confidence-dot,.confidence-badge[data-level="unknown"] .confidence-dot{background:#94a3b8}
:root[data-theme="dark"] .confidence-badge[data-level="3"]{background:rgba(2,44,34,.4);color:#34d399;border-color:rgba(6,95,70,.5)}
:root[data-theme="dark"] .confidence-badge[data-level="2"]{background:rgba(69,26,3,.4);color:#fbbf24;border-color:rgba(146,64,14,.5)}
:root[data-theme="dark"] .confidence-badge[data-level="1"],:root[data-theme="dark"] .confidence-badge[data-level="unknown"]{background:#1e293b;color:#94a3b8;border-color:#334155}
:root[data-theme="dark"] .confidence-badge[data-level="1"] .confidence-dot,:root[data-theme="dark"] .confidence-badge[data-level="unknown"] .confidence-dot{background:#64748b}
`;
