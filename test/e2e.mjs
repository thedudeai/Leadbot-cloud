import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const STORE = path.join(ROOT, 'storage-test');
fs.rmSync(STORE, { recursive: true, force: true });
const PORT = 8971;
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, DATA_DIR: STORE, PORT: String(PORT), ADMIN_EMAIL: 'boss@chs.test', ADMIN_PASSWORD: 'adminpass123', ADMIN_NAME: 'Boss' };

function boot() {
  const child = spawn('node', ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() { for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch {} await wait(150); } throw new Error('server never came up'); }

const jars = {};
async function call(who, p, body, method) {
  const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, location: r.headers.get('location') };
}
async function pollRun(who, pred, tries = 60) { for (let i = 0; i < tries; i++) { const s = (await call(who, '/api/state')).json; if (pred(s)) return s; await wait(250); } throw new Error('run did not reach expected state'); }

let child = boot(); await up();
let pass = 0; const ok = (name) => { pass++; console.log('  ok  ' + name); };

// 1. Signed out
let r = await call('anon', '/'); assert.equal(r.status, 302); assert.equal(r.location, '/login'); ok('unauthenticated / redirects to /login');
r = await call('anon', '/api/state'); assert.equal(r.status, 401); ok('unauthenticated API is 401');
r = await call('anon', '/login'); assert.equal(r.status, 200); assert.match(r.text, /Sign in/); ok('login page served');
r = await call('anon', '/api/login', { email: 'boss@chs.test', password: 'wrong' }); assert.equal(r.status, 401); ok('bad password rejected');

// 2. Admin login + state
r = await call('admin', '/api/login', { email: 'BOSS@chs.test', password: 'adminpass123' }); assert.equal(r.status, 200); assert.equal(r.json.user.role, 'admin'); ok('admin login (case-insensitive email)');
r = await call('admin', '/api/state'); assert.equal(r.json.admin, true); assert.equal(r.json.config.claudeCmd, 'claude'); ok('admin sees full config');
r = await call('admin', '/api/config', { claudeCmd: `node ${path.join(ROOT, 'test', 'claude-stub.mjs')}`, maxSessions: 2, concurrency: 3 }); assert.equal(r.json.config.maxSessions, 2); ok('admin saves settings incl. maxSessions');

// 3. Team
r = await call('admin', '/api/users', { name: 'Rep One', email: 'rep@chs.test', password: 'reppass123' }); assert.equal(r.status, 200); const rep = r.json.user; assert.equal(rep.role, 'user'); ok('admin creates a rep');
r = await call('admin', '/api/users', { name: 'Dup', email: 'rep@chs.test', password: 'reppass123' }); assert.equal(r.status, 400); ok('duplicate email rejected');
r = await call('admin', '/api/users', { name: 'Short', email: 's@chs.test', password: 'abc' }); assert.equal(r.status, 400); ok('short password rejected');

// 4. Rep scoping
r = await call('rep', '/api/login', { email: 'rep@chs.test', password: 'reppass123' }); assert.equal(r.status, 200); ok('rep login');
r = await call('rep', '/api/state'); assert.equal(r.json.admin, false); assert.equal(r.json.config.claudeCmd, undefined); assert.equal(r.json.scope.mapped, false); ok('rep gets trimmed config and unmapped scope');
r = await call('rep', '/api/config', { claudeCmd: 'evil' }); r = await call('admin', '/api/state'); assert.notEqual(r.json.config.claudeCmd, 'evil'); ok('rep cannot change server settings');
r = await call('rep', '/api/users'); assert.equal(r.status, 403); ok('rep cannot list users');
r = await call('rep', '/api/segments', { segments: [] }); assert.equal(r.status, 403); ok('rep cannot edit segments');
r = await call('rep', '/api/run', { leads: [{ id: '5', company: 'X' }] }); assert.equal(r.status, 403); ok('unmapped rep cannot start a run');
r = await call('admin', '/api/users/' + rep.id, { zohoOwnerId: '999', zohoOwnerName: 'Rep One (Zoho)' }); assert.equal(r.status, 200); ok('admin maps rep to a Zoho owner');
r = await call('rep', '/api/state'); assert.equal(r.json.scope.lockOwner, '999'); ok('rep scope now pinned to owner 999');
r = await call('rep', '/api/run', { leads: [{ id: '5', company: 'X', owner: { id: '123' } }] }); assert.equal(r.status, 403); ok('rep cannot profile a lead owned by someone else');

// 5. Run + write for the rep (stub CLI; Zoho unconfigured so write goes through the CLI path too)
r = await call('rep', '/api/run', { leads: [{ id: '5001', company: 'Alpha Care', owner: { id: '999' } }, { id: '5002', company: 'Beta School', owner: { id: '999' } }] });
assert.equal(r.status, 200); const runId = r.json.runId; ok('rep starts a 2-lead run ' + runId);
r = await call('rep', '/api/run', { leads: [{ id: '5003', company: 'C', owner: { id: '999' } }] }); assert.equal(r.status, 409); ok('second concurrent run refused');
let s = await pollRun('rep', (x) => x.run && x.run.finishedAt && x.run.jobs.every((j) => j.status === 'done'));
assert.equal(s.run.jobs[0].result.contact.firstName, 'Pat'); assert.equal(s.run.jobs[0].cost, 0.42); ok('both leads profiled by the stub, cost captured');
assert.ok(fs.existsSync(path.join(STORE, 'runs', runId, '5001.json'))); ok('result JSON persisted on the volume');
r = await call('admin', '/api/state'); assert.equal(r.json.run, null); ok("admin's own run state is untouched by the rep's run");
r = await call('rep', '/api/write', { leadIds: ['5001'] }); assert.equal(r.json.queued, 1); ok('rep queues one write');
s = await pollRun('rep', (x) => x.run.jobs.find((j) => j.leadId === '5001').written);
assert.equal(s.run.jobs.find((j) => j.leadId === '5002').written, false); ok('only the approved lead was written');

// 5b. Basic run — wide fan-out, own mode label, own review shape
r = await call('rep', '/api/run', { mode: 'basic', leads: Array.from({ length: 25 }, (_, i) => ({ id: String(6000 + i), company: 'Basic Co ' + i, owner: { id: '999' } })) });
assert.equal(r.status, 200); const basicRunId = r.json.runId; ok('rep starts a 25-lead basic run ' + basicRunId);
s = await pollRun('rep', (x) => x.run && x.run.id === basicRunId && x.run.finishedAt && x.run.jobs.every((j) => j.status === 'done'), 120);
assert.equal(s.run.mode, 'basic'); assert.equal(s.run.jobs.length, 25); ok('basic run carries mode=basic and finished all 25');
assert.equal(s.run.jobs[0].result.basic.hcm, 'Paylocity'); assert.equal(s.run.jobs[0].cost, 0.05); ok('basic result shape and cost captured');
assert.equal(JSON.parse(fs.readFileSync(path.join(STORE, 'data', 'history.json'))).runs.find((x) => x.id === basicRunId).mode, 'basic'); ok('mode persisted to history');
r = await call('rep', '/api/write', { leadIds: ['6000', '6001'] }); assert.equal(r.json.queued, 2); ok('basic results queue for write');
s = await pollRun('rep', (x) => x.run.jobs.filter((j) => j.written).length === 2);
ok('basic writes complete through the CLI fallback');
r = await call('rep', '/api/run', { leads: Array.from({ length: 51 }, (_, i) => ({ id: String(7000 + i), company: 'X', owner: { id: '999' } })) });
assert.equal(r.status, 400); assert.match(r.json.error, /Basic profile/); ok('51-lead full run refused and pointed at basic');

// 6. Stats
r = await call('rep', '/api/stats?scope=all'); assert.equal(r.status, 403); ok('rep cannot see everyone stats');
r = await call('admin', '/api/stats?scope=all'); assert.equal(r.json.totalLeads, 27); assert.equal(r.json.byPerson[0].name, 'Rep One'); assert.equal(r.json.byPerson[0].written, 3);
assert.equal(r.json.byMode.basic.leads, 25); assert.equal(r.json.byMode.full.leads, 2); assert.ok(r.json.byMode.basic.avgCost < r.json.byMode.full.avgCost); ok('admin sees company stats by person and by profile type');
r = await call('admin', '/api/stats'); assert.equal(r.json.totalLeads, 0); ok("admin's own stats are separate");

// 7. Restart → restore
child.kill(); await wait(500); child = boot(); await up();
r = await call('rep', '/api/state'); assert.equal(r.status, 200); ok('session cookie survives a restart');
assert.equal(r.json.run.id, basicRunId); assert.equal(r.json.run.restored, true); assert.equal(r.json.run.mode, 'basic');
assert.equal(r.json.run.jobs.find((j) => j.leadId === '6002').result.basic.ceo, 'Sam Roth');
assert.equal(r.json.run.jobs.find((j) => j.leadId === '6000').written, true); ok('latest (basic) run restored from disk with mode, results and written flags');
r = await call('rep', '/api/write', { leadIds: ['6002'] }); assert.equal(r.json.queued, 1); ok('unwritten lead from the restored run can still be written');

// 8. Disable / logout
r = await call('admin', '/api/users/' + rep.id, { enabled: false }); r = await call('rep', '/api/state'); assert.equal(r.status, 401); ok('disabling a user kills their session');
r = await call('admin', '/api/logout', {}); r = await call('admin', '/api/state'); assert.equal(r.status, 401); ok('logout clears session');

child.kill();
fs.rmSync(STORE, { recursive: true, force: true });
console.log(`\n${pass} checks passed`);
