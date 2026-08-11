const ACTIONS = {
  awaiting_review: ['approve', 'reject'],
  approved: ['execute'],
  verifying: ['execute'],
  completed: ['rollback'],
};

export function deriveOperationState({ taskStatus, writeStatus, rollbackAvailable }) {
  let state;
  if (taskStatus === 'rolled_back') state = 'rolled_back';
  else if (taskStatus === 'stale' || writeStatus === 'stale') state = 'stale';
  else if (writeStatus === 'rejected') state = 'rejected';
  else if (taskStatus === 'completed') state = 'completed';
  else if (writeStatus === 'executed') state = 'verifying';
  else if (writeStatus === 'approved') state = 'approved';
  else if (writeStatus === 'prepared') state = 'awaiting_review';
  else if (taskStatus === 'ready') state = 'candidate_required';
  else state = taskStatus;
  const allowed = [...(ACTIONS[state] ?? [])];
  if (state === 'completed' && !rollbackAvailable) allowed.length = 0;
  return { state, allowed_actions: allowed };
}
