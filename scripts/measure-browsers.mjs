import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AGM_PLAYWRIGHT_MODULE || 'playwright');
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = new URL('../test/fixtures/dom-smoke.html', import.meta.url).href;
const processSnapshot = () => {
  if (process.platform === 'win32') {
    try {
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 5000 });
      const rows = JSON.parse(raw);
      return new Map((Array.isArray(rows) ? rows : [rows]).map(row => [Number(row.ProcessId), { ppid: Number(row.ParentProcessId), rss: Number(row.WorkingSetSize), cpu: Number(row.KernelModeTime || 0) + Number(row.UserModeTime || 0), commandLine: String(row.CommandLine || '') }]));
    } catch { return new Map(); }
  }
  if (process.platform !== 'linux') return new Map();
  const processes = new Map();
  for (const dir of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const status = fs.readFileSync(`/proc/${dir}/status`, 'utf8');
      const stat = fs.readFileSync(`/proc/${dir}/stat`, 'utf8');
      const commandLine = fs.readFileSync(`/proc/${dir}/cmdline`, 'utf8').replaceAll('\0', ' ');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const ppid = Number(fields[1] || 0);
      const cpu = (Number(fields[11] || 0) + Number(fields[12] || 0)) * 10_000_000 / 100;
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024;
      processes.set(Number(dir), { ppid, rss, cpu, commandLine });
    } catch { /* process ended during sampling */ }
  }
  return processes;
};
function treeMetrics(rootPids) {
  const processes = processSnapshot(), selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, item] of processes) if (!selected.has(pid) && selected.has(item.ppid)) { selected.add(pid); changed = true; }
  }
  return [...selected].reduce((total, pid) => { const item = processes.get(pid); if (item) { total.rss += item.rss; total.cpu += item.cpu; } return total; }, { rss: 0, cpu: 0 });
}

for (const count of [1, 2, 3]) {
  const contexts = [];
  try {
    for (let index = 0; index < count; index++) {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), `agm-browser-${count}-${index}-`));
      const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1440, height: 1000 } });
      context._agmTempProfile = profile;
      contexts.push(context);
      const page = context.pages()[0] || await context.newPage();
      await page.goto(fixture);
    }
    let browserPids = contexts.map(context => context.browser?.()?.process?.()?.pid).filter(Number.isInteger);
    if (browserPids.length < contexts.length) {
      const processes = processSnapshot();
      for (const context of contexts) {
        const needle = path.resolve(context._agmTempProfile).replaceAll('\\', '/').toLowerCase();
        const match = [...processes].find(([, item]) => item.commandLine.replaceAll('\\', '/').toLowerCase().includes(needle));
        if (match && !browserPids.includes(match[0])) browserPids.push(match[0]);
      }
    }
    await delay(1500);
    const before = treeMetrics(browserPids);
    const startedAt = Date.now();
    const stopAt = startedAt + 5000;
    while (Date.now() < stopAt) {
      await Promise.all(contexts.map(async context => {
        const page = context.pages()[0];
        await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => {});
        await page.locator('#title').innerText().catch(() => '');
      }));
      await delay(500);
    }
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const after = treeMetrics(browserPids);
    const cpuCores = Number(((after.cpu - before.cpu) / (10_000_000 * elapsedSeconds)).toFixed(3));
    console.log(JSON.stringify({ concurrentBrowsers: count, browserRootPids: browserPids, chromiumTreeRssMiB: Number((after.rss / 1024 / 1024).toFixed(1)), chromiumTreeRssGrowthMiB: Number(((after.rss - before.rss) / 1024 / 1024).toFixed(1)), measuredSeconds: elapsedSeconds, chromiumTreeCpuCoresApprox: cpuCores, metricCollection: process.platform === 'linux' ? '/proc process tree' : process.platform === 'win32' ? 'Win32_Process tree' : 'not supported on this platform', note: 'Approximate resource use while taking a screenshot and reading a DOM element every 0.5 seconds in each context.' }));
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    for (const context of contexts) if (context._agmTempProfile) fs.rmSync(context._agmTempProfile, { recursive: true, force: true });
  }
}
