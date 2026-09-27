#!/usr/bin/env node
// Avvia wargame-server e il frontend della variante wargame; Ctrl+C li chiude entrambi.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (!existsSync('wargame-server/node_modules')) spawn(npm, ['--prefix', 'wargame-server', 'install'], { stdio: 'inherit' }).on('exit', start);
else start();

function start() {
  const procs = [spawn(npm, ['run', 'wargame:server'], { stdio: 'inherit' }), spawn(npm, ['run', 'dev:wargame'], { stdio: 'inherit' })];
  const stop = () => procs.forEach((p) => p.kill());
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  procs.forEach((p) => p.on('exit', stop));
}
