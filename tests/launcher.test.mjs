import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ID, PORT, URL, paths, config, plist, locked, safePath, autoState } from '../src/common.mjs';
import { control, validateArgs } from '../src/control.mjs';
import { install, uninstall } from '../src/install.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = value => `'${value.replace(/'/g, "'\\''")}'`;
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-launcher-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "Home with spaces & 'quote'");
  fs.mkdirSync(home, { mode: 0o700 });
  const p = paths(home);
  const stateFile = path.join(base, 'state.json');
  const pkg = path.join(base, 'fake pi-web');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  const cli = path.join(pkg, 'bin/pi-web.js');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agegr/pi-web', version: '0.15.0' }));
  const initial = { job: null, ready: false, mode: 'good', conflict: false, events: [], cli, plist: p.plist, auto: p.auto, uid: process.getuid() };
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const save = patch => fs.writeFileSync(stateFile, JSON.stringify({ ...read(), ...patch }));
  fs.writeFileSync(stateFile, JSON.stringify(initial));
  fs.writeFileSync(cli, `const fs = require('fs');
const file = ${JSON.stringify(stateFile)};
const s = JSON.parse(fs.readFileSync(file));
const args = process.argv.slice(2);
if (args[0] === 'version') console.log('0.15.0');
else if (args[0] === 'status') {
  if (s.badFormat) console.log('new unsupported status format');
  else if (s.ready) console.log('Running pi-web servers:\\n  http://127.0.0.1:30141  pid 12000  v0.15.0  started 2026-11-09T00:00:00Z' + (s.ambiguous ? '\\n  http://[::1]:30141  pid 13000  v0.15.0  started now' : ''));
  else console.log('No pi-web server is running.');
} else if (args.join(' ') === 'stop --port 30141') {
  s.events.push('manual-stop'); s.ready = false;
  fs.writeFileSync(file, JSON.stringify(s));
} else { console.error('Fake pi-web refuses start/unknown command'); process.exit(2); }
`);
  const helper = path.join(base, 'fake-tools.cjs');
  fs.writeFileSync(helper, `const fs = require('fs');
const [file, tool, ...args] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file));
const save = () => fs.writeFileSync(file, JSON.stringify(s));
if (tool === 'launchctl') {
  if (args[0] === 'print') {
    if (!s.job) { console.error(s.printError || 'Could not find service "local.pi-web" in domain for user'); process.exit(113); }
    console.log('gui/501/local.pi-web = {\\n path = ' + (s.foreign ? '/foreign/job.plist' : s.loadedFromAuto ? s.auto : s.plist) + '\\n program = ' + ${JSON.stringify(process.execPath)} + '\\n arguments = {\\n ' + ${JSON.stringify(process.execPath)} + '\\n ' + s.cli + '\\n --hostname\\n 127.0.0.1\\n --port\\n 30141\\n --no-open\\n }\\n state = ' + (s.job.pid ? 'running' : 'not running') + (s.job.pid ? '\\n pid = ' + s.job.pid : '') + (s.job.exit === undefined ? '' : '\\n last exit code = ' + s.job.exit) + '\\n}');
  } else if (['bootstrap', 'kickstart'].includes(args[0])) {
    if (args.includes('-k')) throw Error('Never force restart');
    if (args[0] === 'bootstrap' && s.job) throw Error('duplicate bootstrap');
    s.events.push(args[0]);
    s.job = s.mode === 'exit' ? { exit: 1 } : { pid: 12000 };
    s.ready = s.mode === 'good'; save();
  } else if (args[0] === 'bootout') { s.events.push('bootout'); s.job = null; s.ready = false; save(); }
  else throw Error('unsupported launchctl');
} else if (tool === 'ps') {
  const pid = args[args.indexOf('-p') + 1];
  if (!s.job && !s.ready) process.exit(1);
  if (args.includes('args=')) console.log(s.uid + ' ' + (pid === '12000' ? 1 : 12000) + ' ' + (s.badIdentity ? '/foreign/program' : pid === '12000' ? 'node ' + s.cli + ' --hostname 127.0.0.1 --port 30141 --no-open' : 'next-server (v16)'));
  else console.log(s.uid);
} else if (tool === 'lsof') { if (!s.ready) process.exit(1); console.log(s.badListener ? '77777' : '12001'); }
else if (tool === 'open') { if (args.length !== 1 || args[0] !== 'http://127.0.0.1:30141') throw Error('unsafe browser URL'); s.events.push('open'); save(); }
else throw Error('unknown tool');
`);
  const tools = {};
  for (const tool of ['launchctl', 'ps', 'lsof', 'open']) {
    tools[tool] = path.join(base, `fake-${tool}`);
    fs.writeFileSync(tools[tool], `#!/bin/sh\nexec ${q(process.execPath)} ${q(helper)} ${q(stateFile)} ${q(tool)} "$@"\n`, { mode: 0o700 });
  }
  const c = { id: ID, home: p.home, node: process.execPath, cli, entries: [cli], agent: path.join(p.home, '.pi/agent'), path: '/usr/bin:/bin', proxy: {} };
  fs.mkdirSync(path.join(c.agent, 'pi-web-run'), { recursive: true });
  const record = { pid: 12000, nextPid: 12001, hostname: '127.0.0.1', port: PORT, url: URL };
  const recordFile = path.join(c.agent, 'pi-web-run/12000.json');
  fs.writeFileSync(recordFile, JSON.stringify(record));
  fs.writeFileSync(path.join(c.agent, 'sentinel'), 'user data');
  const seed = () => {
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(p.root, '.pi-web-launcher-owner'), `${ID}\n`);
    fs.writeFileSync(p.config, JSON.stringify(c), { mode: 0o600 });
    fs.writeFileSync(p.plist, plist(p, c), { mode: 0o600 });
  };
  const output = [];
  const runtime = { tools, busy: async () => read().conflict || read().ready, timeout: 200, poll: 10, log: text => output.push(text) };
  const ctl = args => control(p, c, args.split(' '), runtime);
  return { p, c, base, stateFile, tools, read, save, seed, runtime, ctl, output, record, recordFile };
}

test('start/open repeat, loaded stopped kickstart, status is not exit-code based', async t => {
  const f = fixture(t); f.seed();
  await f.ctl('status');
  assert.match(f.output.join('\n'), /Service: stopped/);
  await f.ctl('start'); await f.ctl('open'); await f.ctl('start');
  assert.deepEqual(f.read().events, ['bootstrap', 'open']);
  await f.ctl('stop');
  f.save({ job: { exit: 0 }, ready: false });
  await f.ctl('start');
  assert.equal(f.read().events.at(-1), 'kickstart');
});

test('manual instance reuse; stop refuses unmanaged servers without signalling', async t => {
  const f = fixture(t); f.seed(); f.save({ ready: true });
  await f.ctl('open');
  assert.match(f.output.join('\n'), /manual\/unmanaged/);
  assert.deepEqual(f.read().events, ['open']);
  await assert.rejects(f.ctl('stop'), /manual\/unmanaged pi-web left running/);
  assert.equal(f.read().ready, true);
  assert.deepEqual(f.read().events, ['open']);
});

test('autostart on/off independent, idempotent, copied plist passes plutil', async t => {
  const f = fixture(t); f.seed();
  await f.ctl('start'); await f.ctl('autostart on'); await f.ctl('autostart on');
  assert.equal(autoState(f.p), true);
  assert.equal(f.read().job.pid, 12000);
  await f.ctl('stop');
  assert.equal(autoState(f.p), true);
  f.save({ job: { pid: 12000 }, ready: true, loadedFromAuto: true });
  await f.ctl('autostart off'); await f.ctl('autostart off');
  assert.equal(f.read().job.pid, 12000);
  assert.equal(autoState(f.p), false);
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', f.p.plist]).status, 0);
  const xml = fs.readFileSync(f.p.plist, 'utf8');
  assert.ok(!xml.includes('KeepAlive'));
  assert.ok(xml.includes('&amp;') && xml.includes('&apos;'));
});

test('conflict, failed exit, timeout, status fault; no force-kill/cleanup', async t => {
  const f = fixture(t); f.seed();
  f.save({ conflict: true });
  await assert.rejects(f.ctl('start'), /occupied.*\nLogs:/);
  await assert.rejects(f.ctl('stop'), /unverified service/);
  assert.deepEqual(f.read().events, []);
  f.save({ conflict: false, mode: 'exit' });
  await assert.rejects(f.ctl('start'), /exited before readiness \(exit 1\)/);
  f.save({ job: null, mode: 'timeout' });
  await assert.rejects(f.ctl('start'), /Readiness timeout/);
  assert.equal(f.read().job.pid, 12000);
  await assert.rejects(f.ctl('status'), /not serving verified/);
  assert.ok(!f.read().events.includes('bootout'));
});

test('foreign jobs, PID/listener mismatch, wildcard records, ambiguity fail closed', async t => {
  const f = fixture(t); f.seed();
  f.save({ job: { pid: 12000 }, ready: true, foreign: true });
  for (const action of ['start', 'stop', 'status']) await assert.rejects(f.ctl(action), /Foreign or unrecognised/);
  f.save({ foreign: false, badIdentity: true });
  await assert.rejects(f.ctl('stop'), /process identity mismatch/);
  f.save({ badIdentity: false, badListener: true });
  await assert.rejects(f.ctl('open'), /listener does not match/);
  f.save({ badListener: false, ambiguous: true });
  await assert.rejects(f.ctl('stop'), /Ambiguous/);
  f.save({ ambiguous: false });
  fs.writeFileSync(f.recordFile, JSON.stringify({ ...f.record, hostname: '0.0.0.0' }));
  await assert.rejects(f.ctl('open'), /record identity mismatch/);
  f.save({ badIdentity: true });
  await assert.rejects(uninstall(f.p, f.tools), /process identity mismatch/);
  assert.deepEqual(f.read().events, []);
});

test('malformed CLI and launchctl errors never mean absence', async t => {
  const f = fixture(t); f.seed();
  for (const args of [[], ['start', '--port', '99'], ['autostart', 'yes'], ['stop', 'extra'], ['status;rm']]) assert.throws(() => validateArgs(args), /Usage:/);
  f.save({ printError: 'Permission denied' });
  await assert.rejects(f.ctl('start'), /Cannot inspect/);
  f.save({ printError: null, badFormat: true });
  await assert.rejects(f.ctl('start'), /Unrecognised/);
  assert.deepEqual(f.read().events, []);
});

test('parallel controller processes serialize; a stale lock times out safely', async t => {
  const f = fixture(t); f.seed();
  const runner = path.join(f.base, 'runner.mjs');
  fs.writeFileSync(runner, `import fs from 'node:fs';
import { paths, config, locked } from ${JSON.stringify(pathToFileURL(path.join(project, 'src/common.mjs')).href)};
import { control } from ${JSON.stringify(pathToFileURL(path.join(project, 'src/control.mjs')).href)};
const p = paths(${JSON.stringify(f.p.home)});
await locked(p, () => control(p, config(p), [process.argv[2]], { tools: ${JSON.stringify(f.tools)}, busy: async () => JSON.parse(fs.readFileSync(${JSON.stringify(f.stateFile)})).ready, timeout: 1000, poll: 10, log: () => {} }), 5000);
`);
  const children = Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, i % 2 ? 'open' : 'start'], { env: { HOME: f.p.home, PATH: '/usr/bin:/bin' } });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker timeout')); }, 10000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(errors)); });
  }));
  await Promise.all(children);
  assert.equal(f.read().events.filter(x => x === 'bootstrap').length, 1);
  assert.equal(f.read().events.filter(x => x === 'open').length, 3);
  assert.ok(!fs.existsSync(f.p.lock));
  fs.mkdirSync(f.p.lock, { mode: 0o700 });
  await assert.rejects(locked(f.p, () => assert.fail('must not enter'), 50), /Control lock timeout/);
  assert.ok(fs.existsSync(f.p.lock));
});

test('installation is explicit, repeatable, independent of source; uninstall preserves data/logs/extras', async t => {
  const f = fixture(t);
  await install(f.p, ['--node', process.execPath, '--pi-web', f.c.cli, '--proxy', 'http://127.0.0.1:7890'], f.tools);
  assert.deepEqual(f.read().events, []);
  assert.equal(fs.existsSync(f.p.auto), false);
  assert.equal(config(f.p).proxy.HTTP_PROXY, 'http://127.0.0.1:7890');
  const wrapper = fs.readFileSync(path.join(f.p.root, 'pi-webctl'), 'utf8');
  assert.ok(!wrapper.includes(project));
  const { spawnSync } = await import('node:child_process');
  const badCommand = spawnSync(path.join(f.p.root, 'pi-webctl'), ['bogus'], { env: { HOME: f.p.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(badCommand.status, 1);
  assert.match(badCommand.stderr, /Usage: pi-webctl/);
  assert.ok(fs.existsSync(path.join(f.p.apps[0], 'Contents/MacOS/applet')));
  for (const app of f.p.apps) {
    const seal = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8', timeout: 5000 });
    assert.equal(seal.status, 0, seal.stderr);
  }
  await install(f.p, [], f.tools);
  await install(f.p, ['--proxy', 'off'], f.tools);
  assert.deepEqual(config(f.p).proxy, {});
  const installed = config(f.p);
  await control(f.p, installed, ['autostart', 'on'], f.runtime);
  await install(f.p, [], f.tools);
  assert.equal(autoState(f.p), true);
  fs.writeFileSync(path.join(f.p.logs, 'stdout.log'), 'retained');
  fs.writeFileSync(path.join(f.p.root, 'extra-user-file'), 'keep');
  f.save({ job: { pid: 12000 }, ready: true });
  await uninstall(f.p, f.tools);
  assert.equal(fs.readFileSync(path.join(f.c.agent, 'sentinel'), 'utf8'), 'user data');
  assert.equal(fs.readFileSync(path.join(f.p.logs, 'stdout.log'), 'utf8'), 'retained');
  assert.equal(fs.readFileSync(path.join(f.p.root, 'extra-user-file'), 'utf8'), 'keep');
  assert.ok(!fs.existsSync(f.p.apps[0]) && !fs.existsSync(f.p.auto));
  assert.deepEqual(f.read().events, ['bootout']);
  await uninstall(f.p, f.tools);
  assert.equal(fs.readFileSync(path.join(f.p.root, 'extra-user-file'), 'utf8'), 'keep');
  fs.unlinkSync(path.join(f.p.root, 'extra-user-file')); fs.rmdirSync(f.p.root);
  await uninstall(f.p, f.tools);
});

test('one App has a stable identifier; native actions use only the selected command', async t => {
  const f = fixture(t);
  const { spawnSync } = await import('node:child_process');
  const built = path.join(project, 'dist.noindex/Pi Web.app');
  assert.equal(fs.existsSync(path.join(project, 'dist')), false);
  assert.deepEqual(fs.readdirSync(path.dirname(built)).filter(name => name.endsWith('.app')), ['Pi Web.app']);
  const identifier = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(built, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(identifier.status, 0, identifier.stderr);
  assert.equal(identifier.stdout.trim(), ID);
  const compiled = spawnSync('/usr/bin/osadecompile', [path.join(built, 'Contents/Resources/Scripts/main.scpt')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.match(compiled.stdout, /activate\s+set choice to button returned of \(display dialog currentStatus with title "Pi Web"/);
  assert.match(compiled.stdout, /on reopen\s+activate\s+end reopen/);
  const events = path.join(f.base, 'app-events');
  const ctl = path.join(f.base, "fake app ctl 'quote'");
  fs.writeFileSync(ctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${q(events)}\nprintf 'OK\\n'\n`, { mode: 0o700 });
  const invoke = choice => spawnSync('/usr/bin/osascript', ['-e', `set controller to load script POSIX file ${JSON.stringify(path.join(built, 'Contents/Resources/Scripts/main.scpt'))}\ntell controller to performAction(${JSON.stringify(choice)}, ${JSON.stringify(ctl)})`], { encoding: 'utf8', timeout: 5000, env: { HOME: f.p.home, PATH: '/usr/bin:/bin' } });
  for (const choice of ['打开网页', '开启自启', '关闭自启']) {
    const result = invoke(choice);
    assert.equal(result.status, 0, result.stderr);
  }
  const invalid = invoke('unknown');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /未知操作/);
  assert.equal(fs.readFileSync(events, 'utf8'), 'open\nautostart on\nautostart off\n');
});

test('legacy companion migration preserves running service/autostart; uninstall cleans owned legacy App', async t => {
  const f = fixture(t);
  await install(f.p, ['--node', process.execPath, '--pi-web', f.c.cli], f.tools);
  fs.cpSync(f.p.apps[0], f.p.legacyApp, { recursive: true });
  await control(f.p, config(f.p), ['autostart', 'on'], f.runtime);
  f.save({ job: { pid: 12000 }, ready: true });
  await install(f.p, [], f.tools);
  assert.equal(f.p.apps.length, 1);
  assert.equal(fs.existsSync(f.p.legacyApp), false);
  assert.equal(f.read().job.pid, 12000);
  assert.equal(autoState(f.p), true);
  assert.deepEqual(f.read().events, []);
  fs.cpSync(f.p.apps[0], f.p.legacyApp, { recursive: true });
  await uninstall(f.p, f.tools);
  assert.equal(fs.existsSync(f.p.legacyApp), false);
  assert.deepEqual(f.read().events, ['bootout']);
});

test('foreign/symlinked legacy companion aborts before installation changes or job stop', async t => {
  const f = fixture(t);
  await install(f.p, ['--node', process.execPath, '--pi-web', f.c.cli], f.tools);
  const before = fs.readFileSync(f.p.config, 'utf8');
  fs.mkdirSync(f.p.legacyApp);
  fs.writeFileSync(path.join(f.p.legacyApp, 'sentinel'), 'foreign');
  f.save({ job: { pid: 12000 }, ready: true });
  await assert.rejects(install(f.p, [], f.tools), /Foreign installation/);
  await assert.rejects(uninstall(f.p, f.tools), /Foreign installation/);
  assert.equal(fs.readFileSync(path.join(f.p.legacyApp, 'sentinel'), 'utf8'), 'foreign');
  fs.rmSync(f.p.legacyApp, { recursive: true });
  fs.mkdirSync(path.join(f.p.legacyApp, 'Contents'), { recursive: true });
  fs.symlinkSync(path.join(f.p.apps[0], 'Contents/Resources'), path.join(f.p.legacyApp, 'Contents/Resources'));
  await assert.rejects(install(f.p, [], f.tools), /Foreign installation/);
  await assert.rejects(uninstall(f.p, f.tools), /Foreign installation/);
  assert.equal(fs.readFileSync(f.p.config, 'utf8'), before);
  assert.equal(f.read().job.pid, 12000);
  assert.deepEqual(f.read().events, []);
});

test('build refuses foreign or symlinked old/new output without deleting user files', async t => {
  const f = fixture(t);
  const { spawnSync } = await import('node:child_process');
  const sandbox = path.join(f.base, 'build sandbox');
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  const script = path.join(sandbox, 'scripts/build.sh');
  fs.copyFileSync(path.join(project, 'scripts/build.sh'), script);
  for (const name of ['dist', 'dist.noindex']) {
    const output = path.join(sandbox, name);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'sentinel'), 'foreign');
    const result = spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Refusing to overwrite unowned/);
    assert.equal(fs.readFileSync(path.join(output, 'sentinel'), 'utf8'), 'foreign');
    fs.rmSync(output, { recursive: true });
    fs.symlinkSync(f.p.home, output);
    assert.equal(spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 5000 }).status, 1);
    fs.unlinkSync(output);
    assert.equal(fs.readFileSync(path.join(f.c.agent, 'sentinel'), 'utf8'), 'user data');
  }
});

test('missing dependency install/control and dependency-less uninstall', async t => {
  const f = fixture(t);
  await assert.rejects(install(f.p, ['--node', '/not/a/node', '--pi-web', f.c.cli], f.tools), /ENOENT/);
  assert.equal(fs.existsSync(f.p.root), false);
  await assert.rejects(install(f.p, ['--node', process.execPath, '--pi-web', '/not/a/pi-web'], f.tools), /ENOENT/);
  f.seed();
  fs.writeFileSync(f.p.config, JSON.stringify({ ...f.c, cli: '/not/a/pi-web', entries: ['/not/a/pi-web'] }));
  assert.throws(() => config(f.p), /Missing dependency/);
  const bad = { ...f.c, node: '/not/a/node' };
  fs.writeFileSync(f.p.config, JSON.stringify(bad)); fs.writeFileSync(f.p.plist, plist(f.p, bad));
  assert.throws(() => config(f.p), /Missing dependency/);
  await uninstall(f.p, f.tools);
  assert.ok(!fs.existsSync(f.p.root));
});

test('foreign app/files, symlink parent, group-write, proxy credentials, upgrade running guard', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.p.apps[0], { recursive: true });
  fs.writeFileSync(path.join(f.p.apps[0], 'sentinel'), 'foreign');
  await assert.rejects(install(f.p, ['--pi-web', f.c.cli], f.tools), /Foreign installation/);
  assert.equal(fs.readFileSync(path.join(f.p.apps[0], 'sentinel'), 'utf8'), 'foreign');
  fs.rmSync(f.p.apps[0], { recursive: true });
  f.seed();
  fs.mkdirSync(path.dirname(f.p.auto), { recursive: true });
  fs.writeFileSync(f.p.auto, 'foreign');
  await assert.rejects(f.ctl('autostart off'), /Foreign\/changed/);
  await assert.rejects(uninstall(f.p, f.tools), /Foreign\/changed/);
  assert.equal(fs.readFileSync(f.p.auto, 'utf8'), 'foreign');
  fs.unlinkSync(f.p.auto);
  fs.symlinkSync(f.p.config, f.p.auto);
  await assert.rejects(f.ctl('autostart on'), /symlink/);
  fs.unlinkSync(f.p.auto);
  fs.chmodSync(f.p.root, 0o770);
  assert.throws(() => safePath(f.p.root, f.p.home), /permissions/);
  fs.chmodSync(f.p.root, 0o700);
  await assert.rejects(install(f.p, ['--pi-web', f.c.cli, '--proxy', 'http://user:secret@localhost:7890'], f.tools), /without credentials/);
  f.save({ job: { pid: 12000 } });
  await assert.rejects(install(f.p, ['--pi-web', f.c.cli, '--proxy', 'http://127.0.0.1:7890'], f.tools), /Stop the managed job/);
  assert.deepEqual(f.read().events, []);
});
