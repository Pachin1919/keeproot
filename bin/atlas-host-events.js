#!/usr/bin/env node
import { runHostEvent } from '../src/host-events.js';
import { successEnvelope, errorEnvelope } from '../src/protocol.js';

const jsonMode = process.argv.slice(2).includes('--json');

async function main() {
  const started = performance.now();
  const args = process.argv.slice(2).filter(arg => arg !== '--json');
  if (args.length !== 2 || args[0] !== '--binding') throw new Error('Use node <Runtime>/bin/atlas-host-events.js --binding <trusted absolute binding JSON> [--json]; one bounded JSON event comes from stdin. No hook is installed.');
  let bytes = 0; const chunks = [];
  const timer = setTimeout(() => process.stdin.destroy(new Error('Host event stdin exceeded 15 seconds.')), 15000); timer.unref();
  try { for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 65536) throw new Error('Host event stdin exceeds 64 KiB.'); chunks.push(chunk); } }
  finally { clearTimeout(timer); }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = await runHostEvent({ bindingFile: args[1], event, budgetMs: Math.floor(15000 - (performance.now() - started)) });
  console.log(JSON.stringify(jsonMode ? successEnvelope('host_event.run', result) : { systemMessage: `Atlas Host event: ${result.status}${result.reason ? ` (${result.reason})` : ''}.` }));
}
main().catch(error => { error.message = String(error.message).slice(0, 2000); console.log(JSON.stringify(jsonMode ? errorEnvelope('host_event.run', error) : { systemMessage: `Atlas Host event failed: ${error.message}` })); process.exitCode = 1; });
