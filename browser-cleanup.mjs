import fs from 'node:fs';
import { spawn } from 'node:child_process';

export async function forceKillChromium(profileDir) {
  let pids = [];
  if (process.platform === 'linux') {
    try {
      const processes = new Map();
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const commandLine = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ');
          const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
          const parentId = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1] || 0);
          processes.set(Number(entry), { parentId, commandLine });
        } catch { /* process ended while scanning */ }
      }
      const roots = [...processes].filter(([, item]) => item.commandLine.includes(profileDir) && !/\s--type=/.test(item.commandLine)).map(([pid]) => pid);
      const selected = new Set(roots);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, item] of processes) if (!selected.has(pid) && selected.has(item.parentId)) { selected.add(pid); changed = true; }
      }
      pids = [...selected].filter(pid => !roots.includes(pid)).concat(roots);
    } catch (error) { console.warn(`Cannot inspect Chromium processes: ${error.message}`); }
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
    return pids.length;
  }
  if (process.platform === 'win32') {
    const needle = Buffer.from(profileDir, 'utf8').toString('base64');
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${needle}')); $ids=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chrome-headless-shell|chromium).*\\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains($p) -and $_.CommandLine -notmatch '\\s--type=' } | Select-Object -ExpandProperty ProcessId); foreach($id in $ids){ & taskkill.exe /PID $id /T /F | Out-Null }; Write-Output ($ids -join ',')`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const output = await new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', data => stdout += data.toString('utf8'));
      const timer = setTimeout(() => { child.kill(); resolve(''); }, 5000);
      child.once('error', () => { clearTimeout(timer); resolve(''); });
      child.once('close', () => { clearTimeout(timer); resolve(stdout); });
    });
    return output.trim().split(/[\s,]+/).filter(value => /^\d+$/.test(value)).length;
  }
  return 0;
}

\n