import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ID = 'local.pi-web-launcher';
export const LABEL = 'local.pi-web';
export const PORT = 30141;
export const URL = `http://127.0.0.1:${PORT}`;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const fail = message => { throw new Error(message); };
export const exists = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function paths(home) {
  if (!home || !path.isAbsolute(home) || /[\x00-\x1f]/.test(home)) fail('HOME must be an absolute path without control characters.');
  home = fs.realpathSync(home);
  const homeStat = fs.statSync(home);
  if (process.getuid() === 0 || homeStat.uid !== process.getuid() || (homeStat.mode & 0o022)) fail('Use your own non-group/world-writable HOME, without root/sudo.');
  const root = path.join(home, 'Library/Application Support/pi-web-launcher');
  return { home, root, config: path.join(root, 'config.json'), plist: path.join(root, `${LABEL}.plist`),
    auto: path.join(home, `Library/LaunchAgents/${LABEL}.plist`), logs: path.join(home, 'Library/Logs/pi-web'),
    apps: [path.join(home, 'Applications/Pi Web.app')],
    legacyApp: path.join(home, 'Applications/Pi Web Autostart.app'),
    lock: path.join(home, 'Library/Application Support/.pi-web-launcher.lock') };
}
export function safePath(file, home) {
  if (!file.startsWith(`${home}/`)) fail(`Unsafe path: ${file}`);
  let current = home;
  for (const part of path.relative(home, file).split(path.sep)) {
    current = path.join(current, part);
    const st = exists(current);
    if (st && (st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022))) fail(`Unsafe owner, permissions or symlink: ${current}`);
  }
}
export function owned(dir) {
  if (dir.endsWith('.app') && ['Contents', 'Contents/Resources'].some(subdir => {
    const st = exists(path.join(dir, subdir));
    return !st?.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o022);
  })) return false;
  const marker = path.join(dir, ...(dir.endsWith('.app') ? ['Contents', 'Resources'] : []), '.pi-web-launcher-owner');
  return exists(marker)?.isFile() && fs.readFileSync(marker, 'utf8') === `${ID}\n`;
}
export function requireOwned(p) {
  safePath(p.root, p.home);
  if (!owned(p.root)) fail(`Not an owned installation: ${p.root}`);
}
export function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024, ...options });
  if (result.error) fail(`${file}: ${result.error.message}`);
  return result;
}
export function checked(file, args, options) {
  const result = run(file, args, options);
  if (result.status !== 0) fail(`${path.basename(file)} ${args.join(' ')}: ${(result.stderr || result.stdout).trim()} (exit ${result.status})`);
  return result.stdout;
}
export function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail(`Cannot read JSON ${file}: ${e.message}`); }
}
export const isLauncherCommand = (command, entries) => entries.some(entry => ` ${command} `.includes(` ${entry} `));
export function safeLogs(p) {
  for (const file of [p.logs, path.join(p.logs, 'stdout.log'), path.join(p.logs, 'stderr.log')]) safePath(file, p.home);
}
export function config(p, checkDependencies = true) {
  requireOwned(p);
  safeLogs(p);
  safePath(p.config, p.home);
  const c = readJSON(p.config);
  if (!c || c.id !== ID || c.home !== p.home || !Array.isArray(c.entries) || !c.entries.includes(c.cli)) fail('Invalid installation config; reinstall.');
  for (const key of ['node', 'cli', 'agent']) {
    if (!path.isAbsolute(c[key] || '') || /[\x00-\x1f]/.test(c[key])) fail(`Invalid ${key} path.`);
  }
  if (typeof c.path !== 'string' || !c.path || !c.proxy || Object.entries(c.proxy).some(([key, value]) => !['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(key) || typeof value !== 'string') || c.entries.some(entry => typeof entry !== 'string' || !path.isAbsolute(entry))) fail('Invalid environment/entry config; reinstall.');
  for (const file of checkDependencies ? [c.node, c.cli] : []) {
    if (!exists(file)?.isFile() && !exists(file)?.isSymbolicLink()) fail(`Missing dependency: ${file}; reinstall after repairing Node/pi-web.`);
    fs.accessSync(file, file === c.node ? fs.constants.X_OK : fs.constants.R_OK);
  }
  return c;
}
export const serviceArgs = c => [c.node, c.cli, '--hostname', '127.0.0.1', '--port', String(PORT), '--no-open'];
export const serviceEnv = c => ({ HOME: c.home, PATH: c.path, PI_CODING_AGENT_DIR: c.agent, ...c.proxy });
export function autoState(p) {
  safePath(p.auto, p.home);
  if (!exists(p.auto)) return false;
  if (!exists(p.auto).isFile() || !fs.readFileSync(p.auto).equals(fs.readFileSync(p.plist))) fail(`Foreign/changed autostart file, refusing to touch: ${p.auto}`);
  return true;
}
export const domain = () => `gui/${process.getuid()}`;
export const target = () => `${domain()}/${LABEL}`;
export function job(p, c, tools) {
  const result = run(tools.launchctl, ['print', target()]);
  if (result.status !== 0) {
    // Only a missing service is absence; permission/domain failures must not trigger bootstrap.
    if (/Could not find service|service not found/i.test(result.stderr + result.stdout)) return null;
    fail(`Cannot inspect ${target()}: ${(result.stderr || result.stdout).trim()}`);
  }
  const text = result.stdout;
  const lines = text.split('\n').map(line => line.trim());
  const field = name => lines.find(line => line.startsWith(`${name} = `))?.slice(name.length + 3);
  const args = /\barguments = \{\n([\s\S]*?)\n\s*\}/.exec(text)?.[1].split('\n').map(x => x.trim()).filter(Boolean);
  if (![p.plist, p.auto].includes(field('path')) || field('program') !== c.node || JSON.stringify(args) !== JSON.stringify(serviceArgs(c))) {
    fail(`Foreign or unrecognised launchd job ${target()}; no action taken.`);
  }
  const pid = field('pid') === undefined ? null : Number(field('pid'));
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) fail('Invalid launchd PID; no action taken.');
  return { pid, state: field('state'), exit: field('last exit code') };
}
export function verifyJobProcess(j, c, tools) {
  if (!j?.pid) return;
  const result = run(tools.ps, ['-ww', '-p', String(j.pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'args=']);
  if (result.status === 1 && !result.stdout.trim()) return; // Job may have exited between print and ps.
  const info = /^(\d+)\s+(\d+)\s+(.+)$/.exec(result.stdout.trim());
  if (result.status !== 0 || !info || Number(info[1]) !== process.getuid() || !isLauncherCommand(info[3], c.entries)) fail('Managed pi-web process identity mismatch; refusing stop/uninstall.');
}
export async function locked(p, fn, waitMs = 45000) {
  safePath(p.lock, p.home);
  fs.mkdirSync(path.dirname(p.lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  while (true) {
    try { fs.mkdirSync(p.lock, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) fail(`Control lock timeout: ${p.lock}. If a crashed controller left it, verify no installer/pi-webctl is running before removing this directory.`);
      await sleep(100);
    }
  }
  fs.writeFileSync(path.join(p.lock, 'pid'), `${process.pid}\n`, { mode: 0o600 });
  try { return await fn(); }
  finally { fs.rmSync(p.lock, { recursive: true }); }
}
export const nativeTools = { launchctl: '/bin/launchctl', ps: '/bin/ps', lsof: '/usr/sbin/lsof', open: '/usr/bin/open' };
export function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}
export function plist(p, c) {
  const string = value => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${string(LABEL)}
<key>ProgramArguments</key><array>${serviceArgs(c).map(string).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(serviceEnv(c)).map(([k, v]) => `<key>${xml(k)}</key>${string(v)}`).join('')}</dict>
<key>WorkingDirectory</key>${string(p.home)}
<key>RunAtLoad</key><true/>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key>${string(path.join(p.logs, 'stdout.log'))}
<key>StandardErrorPath</key>${string(path.join(p.logs, 'stderr.log'))}
</dict></plist>\n`;
}
export function atomic(file, data, mode = 0o600) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data, { mode, flag: 'wx' });
  try { fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
}
