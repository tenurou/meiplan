import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = [];
function collect(directory, recursive) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) collect(file, true);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) scripts.push(file);
  }
}
collect(root, false);
for (const directory of ['public', 'scripts', 'test']) collect(path.join(root, directory), true);
for (const file of scripts.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || result.stderr || `Syntax check failed: ${file}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`Syntax checked ${scripts.length} JavaScript files.`);
