WITH eligible AS (
  SELECT task_id, input_text_bytes, selected_text_bytes
  FROM task_fact
  WHERE input_text_bytes IS NOT NULL
    AND input_text_bytes > 0
    AND selected_text_bytes IS NOT NULL
    AND selected_text_bytes >= 0
    AND selected_text_bytes <= input_text_bytes
  ORDER BY task_id
)
SELECT
  COUNT(*) AS eligible_rows,
  SUM(selected_text_bytes) AS numerator,
  SUM(input_text_bytes) AS denominator,
  GROUP_CONCAT(task_id, '|') AS eligible_task_ids
FROM eligible;
