ALTER TABLE ai_predictions ADD COLUMN evaluation_rating TEXT CHECK (evaluation_rating IN ('S', 'A', 'B', 'C', 'D'));
