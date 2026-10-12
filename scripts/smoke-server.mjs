import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = net.createServer();
await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-'));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, AGM_HOST: '127.0.0.1', AGM_PORT: String(port), AGM_DATA_DIR: dataDir, AGM_USERS_FILE: path.join(dataDir, 'users.json') },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => logs += chunk.toString());
child.stderr.on('data', chunk => logs += chunk.toString());
let status = null;
let csrfToken = '';
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      const html = await response.text();
      const token = html.match(/name="agm-token" content="([^"]+)"/)?.[1];
      if (response.status === 200 && html.includes('id="feedback-form"') && token) { status = response.status; csrfToken = token; break; }
      throw new Error(`Server returned HTTP ${response.status} or the page is missing its UI marker`);
    } catch (error) {
      if (error.message.includes('Server returned HTTP')) throw error;
      await delay(250);
    }
  }
  if (status !== 200) throw new Error(`Server did not become ready. ${logs}`);
  const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-AGM-Token': csrfToken }, signal: AbortSignal.timeout(2000) });
  if (!stateResponse.ok) throw new Error(`State endpoint returned HTTP ${stateResponse.status}`);
  console.log(`Server smoke check passed: HTTP ${status}, UI loaded, state endpoint HTTP ${stateResponse.status}, loopback port ${port}.`);
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
