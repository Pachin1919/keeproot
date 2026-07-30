WITH normalized AS (
  SELECT
    event_id,
    task_id,
    recorded_at,
    evaluated_at,
    status,
    actor,
    tool,
    eligible_rule_ids,
    applied_rule_ids,
    rule_version_ids,
    corrected,
    eligible_count,
    applied_eligible_count,
    ROW_NUMBER() OVER (
      PARTITION BY task_id
      ORDER BY evaluated_at DESC, recorded_at DESC, event_id DESC
    ) AS latest
  FROM rule_application_fact
),
classified AS (
  SELECT
    *,
    CASE
      WHEN actor = 'test' OR tool = 'atlas-test' THEN 'test'
      WHEN status IN ('cancelled', 'aborted') THEN 'cancelled'
      WHEN status NOT IN ('completed', 'rolled_back') THEN 'incomplete'
      WHEN eligible_count = 0 THEN 'first_scenario'
      ELSE 'eligible'
    END AS population,
    CASE
      WHEN applied_eligible_count > 0 THEN 1
      ELSE 0
    END AS matched
  FROM normalized
  WHERE latest = 1
)
SELECT
  event_id,
  task_id,
  recorded_at,
  evaluated_at,
  status,
  actor,
  tool,
  eligible_rule_ids,
  applied_rule_ids,
  rule_version_ids,
  corrected,
  population,
  matched
FROM classified
ORDER BY task_id;
