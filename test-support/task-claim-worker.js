import { Ledger } from '../src/ledger.js';

const [stateDir, taskId, claimToken, holdMilliseconds = '0'] = process.argv.slice(2);
const ledger = new Ledger(stateDir);
try {
  const claimed = ledger.claimTaskFulfillment(taskId, claimToken, process.pid, new Date().toISOString());
  process.stdout.write(`${JSON.stringify(claimed)}\n`);
  if (claimed.status === 'acquired') {
    await new Promise((resolve) => setTimeout(resolve, Number(holdMilliseconds)));
    ledger.recordTaskUnderlyingRun(taskId, taskId, new Date().toISOString(), claimToken);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error.message, code: error.code })}\n`);
  process.exitCode = 2;
} finally {
  ledger.close();
}
