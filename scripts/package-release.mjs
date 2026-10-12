import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.AGM_RELEASE_OUTPUT || path.join(root, 'dist', 'agm-plan-assistant-source.tar.gz'));
const files = [
  'README.md', 'LICENSE-ARCHITECTURE.md', 'auth.mjs', 'browser-cleanup.mjs',
  'licensing.mjs', 'package.json', 'package-lock.json', 'parse_xlsx.py',
  'reconcile.mjs', 'server.mjs', 'start.cmd', 'start.sh',
  'public', 'deploy', 'test',
  'scripts/measure-browsers.mjs', 'scripts/package-release.mjs', 'scripts/smoke-server.mjs', 'scripts/users.mjs'
];
const forbidden = /(?:^|\/)(?:data|node_modules|\.git|\.env(?:\.|$)|browser-profile|dist)(?:\/|$)|(?:^|\/)uploaded-plan\.xlsx$/i;

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`);
  return result.stdout.trim();
};

fs.mkdirSync(path.dirname(output), { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-release-'));
try {
  const packageDir = path.join(temp, 'agm-plan-assistant');
  fs.mkdirSync(packageDir);
  for (const relative of files) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) throw new Error(`Release input is missing: ${relative}`);
    fs.cpSync(source, path.join(packageDir, relative), { recursive: true, errorOnExist: true });
  }
  const entries = run('tar', ['-czf', output, '-C', temp, 'agm-plan-assistant'])
    .split(/\r?\n/).filter(Boolean);
  const listed = run('tar', ['-tzf', output]).split(/\r?\n/).filter(Boolean);
  const unsafe = listed.filter(entry => forbidden.test(entry.replaceAll('\\', '/')));
  if (unsafe.length) throw new Error(`Release archive contains private or generated files: ${unsafe.join(', ')}`);
  if (!listed.some(entry => entry.endsWith('/server.mjs')) || !listed.some(entry => entry.endsWith('/deploy/ubuntu-24.04.md')) || !listed.some(entry => entry.endsWith('/public/plan-rules.js'))) {
    throw new Error('Release archive is missing the app, plan rules, or Ubuntu deployment guide');
  }
  const stat = fs.statSync(output);
  console.log(`Created ${output} (${stat.size} bytes, ${listed.length} entries)`);
  if (entries.length) console.log(entries.join('\n'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
