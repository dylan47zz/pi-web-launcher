import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID, LABEL, paths, exists, fail, safePath, owned, requireOwned, config, checked, run, job, autoState, locked, atomic, plist, nativeTools, verifyJobProcess, sleep, safeLogs, readJSON } from './common.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = '.pi-web-launcher-owner';
const files = [marker, 'config.json', 'common.mjs', 'control.mjs', 'pi-webctl', `${LABEL}.plist`];
const quote = s => `'${s.replace(/'/g, "'\\''")}'`;
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--node', '--pi-web', '--agent-dir', '--proxy'].includes(args[i]) || !args[i + 1] || result[args[i]]) fail('Usage: install.sh [--node /absolute/node] [--pi-web /absolute/pi-web] [--agent-dir /absolute/agent] [--proxy http://host:port]');
    result[args[i]] = args[i + 1];
  }
  return result;
}
function find(name) {
  for (const dir of (process.env.PATH || '').split(':').filter(path.isAbsolute)) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* try next PATH entry */ }
  }
  fail(`Missing dependency: ${name}; install it or pass an absolute path.`);
}
function absolute(file) {
  if (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) fail(`Invalid absolute path: ${file}`);
  return path.normalize(file);
}
export function preflight(p) {
  for (const dir of [p.root, ...p.apps, p.legacyApp]) {
    safePath(dir, p.home);
    if (exists(dir) && (!exists(dir).isDirectory() || !owned(dir))) fail(`Foreign installation/app; refusing overwrite/delete: ${dir}`);
  }
  for (const file of files.map(name => path.join(p.root, name))) {
    safePath(file, p.home);
    if (exists(file) && !exists(file).isFile()) fail(`Not a regular owned file: ${file}`);
  }
  safePath(p.plist, p.home);
  safeLogs(p);
  safePath(p.auto, p.home);
}
export async function install(p, args, tools = nativeTools) {
  const opts = options(args);
  preflight(p);
  const old = exists(p.root) ? config(p, false) : null;
  if (old) autoState(p); else if (exists(p.auto)) fail(`Foreign autostart file: ${p.auto}`);
  const node = absolute(opts['--node'] || old?.node || find('node'));
  const entry = absolute(opts['--pi-web'] || old?.entries[0] || find('pi-web'));
  fs.accessSync(node, fs.constants.X_OK);
  const cli = fs.realpathSync(entry);
  const pkg = readJSON(path.join(path.dirname(cli), '../package.json'));
  if (!pkg || pkg.name !== '@agegr/pi-web' || path.basename(cli) !== 'pi-web.js') fail('Expected the installed @agegr/pi-web/bin/pi-web.js entry.');
  const version = checked(node, [cli, 'version']).trim(); // Upstream performs its own Node version check.
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) fail('Unexpected pi-web version output.');
  const agent = absolute(opts['--agent-dir'] || old?.agent || path.join(p.home, '.pi/agent'));
  let proxy = old?.proxy || {};
  if (opts['--proxy'] === 'off') proxy = {};
  else if (opts['--proxy']) {
    let u;
    try { u = new URL(opts['--proxy']); }
    catch { fail('Invalid HTTP(S) proxy URL.'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') fail('Proxy must be an HTTP(S) origin without credentials/path/query.');
    proxy = { HTTP_PROXY: u.origin, HTTPS_PROXY: u.origin, NO_PROXY: 'localhost,127.0.0.1,::1' };
  }
  const toolPath = [...new Set([path.join(agent, 'bin'), path.join(p.home, '.local/bin'), path.dirname(node), path.dirname(entry), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(process.env.PATH || '').split(':').filter(x => path.isAbsolute(x) && !/[\x00-\x1f]/.test(x))])].join(':');
  const c = { id: ID, home: p.home, node, cli, entries: [...new Set([entry, cli])], agent, path: old?.path || toolPath, proxy };
  let currentJob;
  if (old) currentJob = job(p, old, tools);
  else {
    const result = run(tools.launchctl, ['print', `gui/${process.getuid()}/${LABEL}`]);
    if (result.status === 0) fail(`Existing job ${LABEL} is not ours; refusing install.`);
    if (!/Could not find service|service not found/i.test(result.stderr + result.stdout)) fail(`Cannot inspect launchd domain: ${result.stderr || result.stdout}`);
  }
  if (currentJob && JSON.stringify(old) !== JSON.stringify(c)) fail('Stop the managed job before changing dependency paths/environment. Existing service left untouched.');
  for (const app of p.apps) {
    const built = path.join(source, 'dist.noindex', path.basename(app));
    if (!owned(built)) fail('Build apps first: ./scripts/build.sh');
  }
  const wasOn = old ? autoState(p) : false;
  fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(p.apps[0]), { recursive: true, mode: 0o700 });
  atomic(path.join(p.root, marker), `${ID}\n`);
  for (const name of ['common.mjs', 'control.mjs']) atomic(path.join(p.root, name), fs.readFileSync(path.join(source, 'src', name)));
  atomic(p.config, `${JSON.stringify(c, null, 2)}\n`);
  atomic(p.plist, plist(p, c));
  checked('/usr/bin/plutil', ['-lint', p.plist]);
  atomic(path.join(p.root, 'pi-webctl'), `#!/bin/sh\nif [ ! -x ${quote(node)} ]; then echo 'Missing installed Node; repair Node or reinstall launcher.' >&2; exit 1; fi\nexec ${quote(node)} ${quote(path.join(p.root, 'control.mjs'))} "$@"\n`, 0o700);
  if (wasOn) atomic(p.auto, fs.readFileSync(p.plist));
  for (const app of p.apps) {
    if (exists(app)) fs.rmSync(app, { recursive: true });
    fs.cpSync(path.join(source, 'dist.noindex', path.basename(app)), app, { recursive: true, dereference: false });
  }
  if (exists(p.legacyApp)) fs.rmSync(p.legacyApp, { recursive: true });
  console.log(`Installed for pi-web ${version}. Service/autostart unchanged (${wasOn ? 'on' : 'off'}).\nControl: ${p.root}/pi-webctl\nApp: ${p.apps[0]}`);
}
export async function uninstall(p, tools = nativeTools) {
  safePath(p.root, p.home);
  const residue = exists(p.root)?.isDirectory() && !owned(p.root) && files.every(name => !exists(path.join(p.root, name)));
  if (!exists(p.root) || residue) {
    if ([...p.apps, p.legacyApp].some(exists) || exists(p.auto)) fail('Partial installation: ownership/config cannot be verified; nothing removed.');
    const r = run(tools.launchctl, ['print', `gui/${process.getuid()}/${LABEL}`]);
    if (r.status === 0 || !/Could not find service|service not found/i.test(r.stderr + r.stdout)) fail('Cannot verify absence of owned launchd job; nothing removed.');
    console.log(`Already uninstalled.${residue ? ` Unrecognised files left untouched: ${p.root}` : ''}`); return;
  }
  preflight(p);
  requireOwned(p);
  const c = config(p, false);
  if (fs.readFileSync(p.plist, 'utf8') !== plist(p, c)) fail('Changed service plist; refusing uninstall.');
  const on = autoState(p);
  const j = job(p, c, tools);
  if (j) {
    verifyJobProcess(j, c, tools);
    checked(tools.launchctl, ['bootout', `gui/${process.getuid()}/${LABEL}`], { timeout: 35000 });
    const deadline = Date.now() + 30000;
    while (job(p, c, tools) || (j.pid && run(tools.ps, ['-p', String(j.pid), '-o', 'uid=']).status === 0)) {
      if (Date.now() >= deadline) fail('Job/process still present; uninstall aborted without deleting installation.');
      await sleep(250);
    }
  }
  if (on) fs.unlinkSync(p.auto);
  for (const app of [...p.apps, p.legacyApp]) if (exists(app)) fs.rmSync(app, { recursive: true });
  for (const name of files) fs.rmSync(path.join(p.root, name), { force: true });
  try { fs.rmdirSync(p.root); } catch (e) { if (e.code !== 'ENOTEMPTY') throw e; console.log(`Unrecognised extra files preserved: ${p.root}`); }
  console.log(`Uninstalled. Logs retained: ${p.logs}. Pi data/npm installation/manual servers untouched.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command !== 'install' && !(command === 'uninstall' && args.length === 1 && args[0] === '--yes')) fail('Use scripts/install.sh or scripts/uninstall.sh --yes (interrupts managed active tasks).');
    const p = paths(process.env.HOME);
    await locked(p, () => command === 'install' ? install(p, args) : uninstall(p));
  } catch (e) { console.error(`pi-web-launcher: ${e.message}`); process.exitCode = 1; }
}
