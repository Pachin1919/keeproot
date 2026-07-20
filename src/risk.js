export const RISK_RULE_VERSION_ID = 'RULE-RISK-1';

const OPERATIONS = new Set(['update', 'create', 'overwrite', 'delete', 'move', 'rename', 'bulk', 'rule_change']);
const DESTRUCTIVE_OPERATIONS = new Set(['overwrite', 'delete', 'move', 'rename', 'bulk', 'rule_change']);

function normalizedConfidence(value) {
  if (value == null) return 1;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error('predictionConfidence must be a number between 0 and 1.');
  }
  return number;
}

export function evaluateRisk({
  operation,
  paths = [],
  fileCount = paths.length,
  targetImportance = 'normal',
  linkImpact = 0,
  modifiesRules = false,
  recoveryAvailable = false,
  predictionConfidence = 1,
  requestedMode = null,
} = {}) {
  if (!OPERATIONS.has(operation)) {
    throw new Error(`Unsupported risk operation: ${operation ?? '(missing)'}`);
  }
  if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string' || !item)) {
    throw new Error('Risk paths must be a list of non-empty strings.');
  }
  if (!Number.isInteger(fileCount) || fileCount < 1) {
    throw new Error('fileCount must be a positive integer.');
  }
  if (!Number.isInteger(linkImpact) || linkImpact < 0) {
    throw new Error('linkImpact must be a non-negative integer.');
  }
  if (requestedMode != null && !['tracked_direct', 'guarded'].includes(requestedMode)) {
    throw new Error('requestedMode must be tracked_direct or guarded.');
  }

  const confidence = normalizedConfidence(predictionConfidence);
  const reasons = [];
  let mode = 'tracked_direct';

  if (DESTRUCTIVE_OPERATIONS.has(operation) && !recoveryAvailable) {
    mode = 'deny';
    reasons.push('A destructive operation has no verified recovery material.');
  } else {
    if (DESTRUCTIVE_OPERATIONS.has(operation)) reasons.push(`Operation ${operation} is structurally destructive.`);
    if (fileCount > 10) reasons.push(`${fileCount} files may be affected, which is treated as a batch operation.`);
    if (['high', 'core'].includes(targetImportance)) reasons.push(`Target importance is ${targetImportance}.`);
    if (linkImpact > 0) reasons.push(`${linkImpact} known link(s) may be affected.`);
    if (modifiesRules) reasons.push('The operation modifies governance or agent rules.');
    if (confidence < 0.8) reasons.push(`Prediction confidence is only ${confidence}.`);
    if (reasons.length) mode = 'guarded';
    if (requestedMode === 'guarded' && mode === 'tracked_direct') {
      mode = 'guarded';
      reasons.push('The caller explicitly requested stronger protection.');
    }
  }

  if (!reasons.length) reasons.push('One recoverable file update has no elevated risk signal.');
  return {
    mode,
    risk: mode === 'deny' ? 'blocked' : mode === 'guarded' ? 'elevated' : 'low',
    rule_version_id: RISK_RULE_VERSION_ID,
    reasons,
    evidence: {
      operation,
      paths: [...paths],
      file_count: fileCount,
      target_importance: targetImportance,
      link_impact: linkImpact,
      modifies_rules: Boolean(modifiesRules),
      recovery_available: Boolean(recoveryAvailable),
      prediction_confidence: confidence,
      requested_mode: requestedMode,
    },
  };
}
