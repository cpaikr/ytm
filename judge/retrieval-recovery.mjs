import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.PYO3_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['judge/retrieval-recovery.py', '--cli',
  resolve('target/debug', process.platform === 'win32' ? 'ytm.exe' : 'ytm'), '--node', process.execPath],
  { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
