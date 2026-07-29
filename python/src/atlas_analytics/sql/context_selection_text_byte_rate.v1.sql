SELECT
  COUNT(*) AS eligible_rows,
  COALESCE(SUM(selected_text_bytes), 0) AS numerator,
  COALESCE(SUM(input_text_bytes), 0) AS denominator
FROM task_fact
WHERE input_text_bytes IS NOT NULL
  AND input_text_bytes > 0
  AND selected_text_bytes IS NOT NULL
  AND selected_text_bytes >= 0
  AND selected_text_bytes <= input_text_bytes;
