WITH ranked AS (
  SELECT
    event_id,
    run_id,
    recorded_at,
    operation,
    outcome,
    reason_code,
    attempt_id,
    COUNT(*) OVER (PARTITION BY attempt_id) AS event_count,
    ROW_NUMBER() OVER (
      PARTITION BY attempt_id
      ORDER BY
        recorded_at DESC,
        CASE outcome
          WHEN 'completed' THEN 4
          WHEN 'conflict_safe_stop' THEN 3
          WHEN 'failed' THEN 2
          WHEN 'cancelled' THEN 1
          ELSE 0
        END DESC,
        event_id DESC
    ) AS latest
  FROM recovery_fact
  WHERE operation = 'rollback'
    AND outcome IN ('completed', 'conflict_safe_stop', 'failed', 'cancelled')
    AND reason_code IS NOT NULL
    AND reason_code <> ''
    AND attempt_id IS NOT NULL
    AND attempt_id <> ''
)
SELECT
  event_id,
  run_id,
  recorded_at,
  outcome,
  reason_code,
  attempt_id,
  event_count
FROM ranked
WHERE latest = 1
ORDER BY attempt_id;
