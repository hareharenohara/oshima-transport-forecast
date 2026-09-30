-- The 10/1-8 official timetable has no regular Oshima-route 3000/2000.
-- Remove only the previously bundled, incorrect rows and their forecasts.
UPDATE services SET round_trip_id = NULL, paired_service_id = NULL
WHERE paired_service_id IN (
  SELECT id FROM services WHERE service_date BETWEEN '2026-10-01' AND '2026-10-08'
    AND service_number IN ('3000', '2000') AND source_version = 'official-timetable-2026-09-28'
);

UPDATE services SET round_trip_id = NULL, paired_service_id = NULL
WHERE ship_type = 'jet' AND paired_service_id IS NOT NULL
  AND substr(paired_service_id, 1, 10) <> service_date;

DELETE FROM ai_predictions WHERE service_id IN (
  SELECT id FROM services WHERE service_date BETWEEN '2026-10-01' AND '2026-10-08'
    AND service_number IN ('3000', '2000') AND source_version = 'official-timetable-2026-09-28'
);
DELETE FROM ml_predictions WHERE service_id IN (
  SELECT id FROM services WHERE service_date BETWEEN '2026-10-01' AND '2026-10-08'
    AND service_number IN ('3000', '2000') AND source_version = 'official-timetable-2026-09-28'
);
DELETE FROM service_forecast_series WHERE service_id IN (
  SELECT id FROM services WHERE service_date BETWEEN '2026-10-01' AND '2026-10-08'
    AND service_number IN ('3000', '2000') AND source_version = 'official-timetable-2026-09-28'
);
DELETE FROM official_service_statuses WHERE service_id IN (
  SELECT id FROM services WHERE service_date BETWEEN '2026-10-01' AND '2026-10-08'
    AND service_number IN ('3000', '2000') AND source_version = 'official-timetable-2026-09-28'
);
DELETE FROM services WHERE service_date BETWEEN '2026-10-01' AND '2026-10-08'
  AND service_number IN ('3000', '2000') AND source_version = 'official-timetable-2026-09-28';
