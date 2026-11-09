import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ID, paths, config, plist, locked } from '../src/common.mjs';

// No service commands at all: these are filesystem trust-boundary checks.
test('reject symlinked logs/config/parents without modifying Pi data', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-safety-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const p = paths(base);
  fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(p.root, '.pi-web-launcher-owner'), `${ID}\n`);
  const c = { id: ID, home: p.home, node: process.execPath, cli: '/not/needed', entries: ['/not/needed'], agent: path.join(base, '.pi/agent'), path: '/usr/bin:/bin', proxy: {} };
  fs.writeFileSync(p.config, JSON.stringify(c), { mode: 0o600 });
  fs.writeFileSync(p.plist, plist(p, c), { mode: 0o600 });
  const data = path.join(base, 'private-data');
  fs.writeFileSync(data, 'must remain unchanged');
  const log = path.join(p.logs, 'stdout.log');
  fs.symlinkSync(data, log);
  assert.throws(() => config(p, false), /symlink/);
  assert.equal(fs.readFileSync(data, 'utf8'), 'must remain unchanged');
  fs.unlinkSync(log);
  fs.unlinkSync(p.config); fs.symlinkSync(data, p.config);
  assert.throws(() => config(p, false), /symlink/);
  fs.unlinkSync(p.config);
  const parent = path.dirname(p.root);
  fs.rmSync(parent, { recursive: true });
  fs.symlinkSync(data, parent);
  await assert.rejects(locked(p, () => assert.fail('must not enter')), /symlink/);
  assert.equal(fs.readFileSync(data, 'utf8'), 'must remain unchanged');
  fs.chmodSync(base, 0o770);
  assert.throws(() => paths(base), /non-group\/world-writable HOME/);
  fs.chmodSync(base, 0o700);
});
