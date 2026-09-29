ALTER TABLE ai_predictions ADD COLUMN official_criteria_status_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_predictions ADD COLUMN port_confidence INTEGER CHECK (port_confidence BETWEEN 0 AND 100);
ALTER TABLE ai_predictions ADD COLUMN port_reasons_json TEXT NOT NULL DEFAULT '[]';

