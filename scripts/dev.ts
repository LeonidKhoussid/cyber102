import { spawn } from 'node:child_process';

const apiPort = process.env.API_PORT ?? '3001';
const webPort = process.env.WEB_PORT ?? '3000';
const environment = { ...process.env, API_ORIGIN: process.env.API_ORIGIN ?? `http://127.0.0.1:${apiPort}` };
const api = spawn(process.execPath, ['--watch', 'apps/api/src/main.ts'], { stdio: 'inherit', env: environment });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', '--port', webPort, '--strictPort'],
  { stdio: 'inherit', env: environment });
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  api.kill();
  web.kill();
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
api.once('exit', code => stop(code ?? 1));
web.once('exit', code => stop(code ?? 1));
