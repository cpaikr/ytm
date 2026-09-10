import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.PYO3_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function run(script) {
const result = spawnSync(python, [script, '--cli',
  resolve('target/debug', process.platform === 'win32' ? 'ytm.exe' : 'ytm'), '--node', process.execPath],
  { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
}
run('judge/retrieval-recovery.py');
run('judge/bulk-retrieval-controls.py');
