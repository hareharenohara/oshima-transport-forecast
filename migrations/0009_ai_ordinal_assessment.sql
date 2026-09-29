ALTER TABLE ai_predictions ADD COLUMN evaluation_grade TEXT CHECK (evaluation_grade IN ('A', 'B', 'C', 'D', 'E'));
ALTER TABLE ai_predictions ADD COLUMN confidence_level INTEGER CHECK (confidence_level BETWEEN 1 AND 5);
ALTER TABLE ai_predictions ADD COLUMN port_confidence_level INTEGER CHECK (port_confidence_level BETWEEN 1 AND 5);
