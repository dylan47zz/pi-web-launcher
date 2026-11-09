import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { PORT, URL, fail, run, checked, config, paths, safePath, autoState, serviceEnv, job, locked, sleep, nativeTools, domain, target, atomic, verifyJobProcess, plist, readJSON, isLauncherCommand } from './common.mjs';

export function portBusy() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Port probe timed out.')); });
    socket.once('connect', () => finish(true));
    socket.once('error', e => { if (e.code === 'ECONNREFUSED') finish(false); else reject(e); });
  });
}
// shortcut: status text and read-only run-record fields match pi-web 0.15.0; fail closed if upstream changes them.
export function ready(p, c, tools) {
  const output = checked(c.node, [c.cli, 'status'], { env: serviceEnv(c), cwd: p.home, timeout: 6000 }).trim();
  if (output === 'No pi-web server is running.') return null;
  if (!output.startsWith('Running pi-web servers:\n')) fail('Unrecognised pi-web status format; check version/reinstall.');
  const rows = output.split('\n').slice(1).map(line => {
    const m = /^\s*(http:\/\/\S+)\s+(?:pid (\d+)|Next\.js pid (\d+) \(launcher gone\))\s+v\S+\s+started .+$/.exec(line);
    if (!m) fail('Unrecognised pi-web status record; refusing unsafe reuse/stop.');
    return { url: m[1], pid: Number(m[2]), orphan: !!m[3] };
  });
  const matches = rows.filter(row => { try { return new globalThis.URL(row.url).port === String(PORT); } catch { return false; } });
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0].url !== URL || matches[0].orphan) fail(`Ambiguous/non-loopback/orphaned pi-web on port ${PORT}; resolve it with pi-web manually.`);
  const row = matches[0];
  const record = readJSON(path.join(c.agent, 'pi-web-run', `${row.pid}.json`));
  if (!record || record.pid !== row.pid || record.port !== PORT || record.hostname !== '127.0.0.1' || record.url !== URL || !Number.isSafeInteger(record.nextPid) || record.nextPid <= 0) fail('pi-web run record identity mismatch; refusing reuse/stop.');
  const processInfo = pid => checked(tools.ps, ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'args=']).trim();
  const launcher = /^(\d+)\s+(\d+)\s+(.+)$/.exec(processInfo(row.pid));
  const child = /^(\d+)\s+(\d+)\s+(.+)$/.exec(processInfo(record.nextPid));
  if (!launcher || !child || Number(launcher[1]) !== process.getuid() || Number(child[1]) !== process.getuid() || Number(child[2]) !== row.pid || !isLauncherCommand(launcher[3], c.entries) || !/next/.test(child[3])) fail('pi-web process identity mismatch; refusing reuse/stop.');
  const listeners = run(tools.lsof, ['-nP', '-t', `-iTCP:${PORT}`, '-sTCP:LISTEN']);
  if (listeners.status !== 0 || listeners.stdout.trim().split(/\s+/).some(pid => Number(pid) !== record.nextPid)) fail('Port listener does not match the verified pi-web child; no action taken.');
  return row;
}

export async function control(p, c, args, runtime = {}) {
  validateArgs(args);
  const tools = runtime.tools || nativeTools;
  const busy = runtime.busy || portBusy;
  const getReady = () => ready(p, c, tools);
  const getJob = () => job(p, c, tools);
  const timeout = runtime.timeout ?? 30000;
  const poll = runtime.poll ?? 250;
  const log = runtime.log || console.log;
  const fault = message => fail(`${message}\nLogs: ${p.logs}/stdout.log and ${p.logs}/stderr.log`);
  const start = async () => {
    let j = getJob();
    const reuse = getReady();
    if (reuse) {
      if (j?.pid && j.pid !== reuse.pid) fault('A manual pi-web and the job disagree; resolve the conflict manually.');
      log(`Running ${URL} (${j?.pid === reuse.pid ? 'launchd managed' : 'manual/unmanaged; reused'}).`);
      return;
    }
    if (!j?.pid) {
      if (await busy()) fault(`Port ${PORT} is occupied by an unverified service; nothing was killed or changed.`);
      if (!j) checked(tools.launchctl, ['bootstrap', domain(), p.plist]);
      else checked(tools.launchctl, ['kickstart', target()]);
    }
    const deadline = Date.now() + timeout;
    const settle = Date.now() + Math.min(1000, timeout / 2);
    while (Date.now() < deadline) {
      j = getJob();
      if (!j) fault('launchd job disappeared during startup.');
      const running = getReady();
      if (running) {
        if (!j.pid || j.pid !== running.pid) fault('Ready server does not belong to the launched job; refusing reuse.');
        log(`Running ${URL} (launchd managed).`);
        return;
      }
      if (!j.pid && Date.now() >= settle && j.exit !== undefined) fault(`pi-web exited before readiness (exit ${j.exit}).`);
      await sleep(poll);
    }
    fault(`Readiness timeout after ${timeout} ms; job left unchanged (use status/stop to inspect/clean up).`);
  };
  const command = args[0];
  if (command === 'start' || command === 'open') {
    await start();
    if (command === 'open') checked(tools.open, [URL]);
  } else if (command === 'status') {
    const j = getJob();
    const r = getReady();
    log(`Autostart: ${autoState(p) ? 'on' : 'off'}`);
    if (r && j?.pid && r.pid !== j.pid) fault('Job/server PID mismatch.');
    if (r) log(`Service: running ${URL} (${r.pid === j?.pid ? 'launchd managed' : 'manual/unmanaged'}; pid ${r.pid})`);
    else if (j?.pid) { log(`Service: not ready (job pid ${j.pid}, state ${j.state})`); fault('Loaded job is not serving verified pi-web.'); }
    else if (await busy()) fault(`Service: port conflict on ${PORT}.`);
    else log(`Service: stopped${j ? ` (loaded, last exit ${j.exit ?? 'unknown'})` : ''}`);
  } else if (command === 'autostart') {
    const on = autoState(p);
    if (args[1] === 'on' && !on) {
      fs.mkdirSync(path.dirname(p.auto), { recursive: true, mode: 0o700 });
      safePath(p.auto, p.home);
      atomic(p.auto, fs.readFileSync(p.plist));
    } else if (args[1] === 'off' && on) fs.unlinkSync(p.auto);
    log(`Autostart: ${args[1]} (current service unchanged).`);
  } else if (command === 'stop') {
    const j = getJob();
    if (j) {
      const r = getReady();
      if (r && j.pid !== r.pid) fault('Job/server PID mismatch; refusing stop.');
      verifyJobProcess(j, c, tools);
      checked(tools.launchctl, ['bootout', target()], { timeout: 35000 });
    }
    else {
      const r = getReady();
      // A manual launcher can replace its port selection outside our lock; never signal it indirectly.
      if (r) fault(`Verified manual/unmanaged pi-web left running. Stop it explicitly with: pi-web stop --port ${PORT}`);
      if (await busy()) fault(`Port ${PORT} belongs to an unverified service; nothing was stopped.`);
    }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!getJob() && !(await busy())) { log('Service: stopped (autostart unchanged).'); return; }
      await sleep(poll);
    }
    fault('Stop timeout; no force-kill attempted.');
  }
}
export function validateArgs(args) {
  if (!((args.length === 1 && ['start', 'open', 'stop', 'status'].includes(args[0])) || (args.length === 2 && args[0] === 'autostart' && ['on', 'off'].includes(args[1])))) fail('Usage: pi-webctl start|open|stop|status|autostart on|autostart off');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    validateArgs(process.argv.slice(2));
    const p = paths(process.env.HOME);
    await locked(p, async () => {
      const c = config(p);
      safePath(p.plist, p.home);
      if (fs.readFileSync(p.plist, 'utf8') !== plist(p, c)) fail('Changed service plist; reinstall before running.');
      try { await control(p, c, process.argv.slice(2)); }
      catch (e) { fail(`${e.message}\nDiagnostic logs: ${p.logs}/stdout.log and ${p.logs}/stderr.log`); }
    });
  } catch (e) { console.error(`pi-webctl: ${e.message}`); process.exitCode = 1; }
}
