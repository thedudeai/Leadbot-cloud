import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startZohoStub } from './zoho-stub.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const STORE = path.join(ROOT, 'storage-test');
fs.rmSync(STORE, { recursive: true, force: true });
const PORT = 8971;
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, DATA_DIR: STORE, PORT: String(PORT), ADMIN_EMAIL: 'boss@chs.test', ADMIN_PASSWORD: 'adminpass123', ADMIN_NAME: 'Boss' };
// Zoho is a stand-in on localhost: the server reads its hosts from zoho.json, so the
// whole direct path — token, org, fields, writes — runs against it, and the
// readiness gate has something real to lose.
const zohoStub = await startZohoStub(8973);
fs.mkdirSync(path.join(STORE, 'data'), { recursive: true });
fs.writeFileSync(path.join(STORE, 'data', 'zoho.json'), JSON.stringify(zohoStub.zohoJson));
const zoomInfo = (mode) => { const f = path.join(STORE, 'mcp-stub.txt'); if (mode) fs.writeFileSync(f, mode); else fs.rmSync(f, { force: true }); };

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
r = await call('admin', '/api/config', { claudeCmd: `node ${path.join(ROOT, 'test', 'claude-stub.mjs')}`, maxSessions: 2, concurrency: 3, maxToolCallsFull: 25, idleKillMin: 2 }); assert.equal(r.json.config.maxSessions, 2); assert.equal(r.json.config.maxToolCallsFull, 25); ok('admin saves settings incl. maxSessions and the tool-call wall');
assert.equal(r.json.config.model, 'sonnet'); assert.equal(r.json.config.maxCostFull, 6); assert.equal(r.json.config.fallbackToBasic, true); ok('defaults: Sonnet, $6 cap, fallback on');

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

// 5. Run + write for the rep (stub CLI, stub Zoho; the write goes straight to the stub CRM)
r = await call('rep', '/api/run', { leads: [{ id: '5001', company: 'Alpha Care', owner: { id: '999' } }, { id: '5002', company: 'Beta School', owner: { id: '999' } }] });
assert.equal(r.status, 200); const runId = r.json.runId; ok('rep starts a 2-lead run ' + runId);
r = await call('rep', '/api/run', { leads: [{ id: '5003', company: 'C', owner: { id: '999' } }] }); assert.equal(r.status, 409); ok('second concurrent run refused');
let s = await pollRun('rep', (x) => x.run && x.run.finishedAt && x.run.jobs.every((j) => j.status === 'done'));
assert.equal(s.run.jobs[0].result.contact.firstName, 'Pat'); assert.equal(s.run.jobs[0].cost, 0.42); ok('both leads profiled by the stub, cost captured');
{
  const r0 = s.run.jobs[0].result;
  assert.equal(r0.employees, 40); assert.equal(r0.contactChanged, false); assert.equal(r0.contact.email, 'pat@x.com'); ok('normalizer: numbers and booleans coerced, email cleaned');
  assert.equal(r0.fields.HCM, undefined); assert.equal(r0.fields.Website, undefined); assert.equal(r0.fields.Employee_Count, 40); ok('normalizer: absence values and empty fields dropped');
  assert.equal(r0.leadership.length, 5); assert.equal(r0.leadershipPhones, 4); assert.equal(r0.coverage.leadershipPhones, true); ok('normalizer: leadership roster kept (nameless entry dropped), phones counted');
  assert.equal(s.run.jobs[0].mode, 'full'); assert.equal(s.run.jobs[0].attempts.length, 1); ok('job carries its mode and one attempt');
}
assert.ok(fs.existsSync(path.join(STORE, 'runs', runId, '5001.json'))); ok('result JSON persisted on the volume');
r = await call('admin', '/api/state'); assert.equal(r.json.run, null); ok("admin's own run state is untouched by the rep's run");
r = await call('rep', '/api/write', { leadIds: ['5001'] }); assert.equal(r.json.queued, 1); ok('rep queues one write');
s = await pollRun('rep', (x) => x.run.jobs.find((j) => j.leadId === '5001').written);
assert.equal(s.run.jobs.find((j) => j.leadId === '5002').written, false); ok('only the approved lead was written');
assert.equal(zohoStub.state.writes.length, 1); assert.equal(zohoStub.state.writes[0].id, '5001'); assert.equal(zohoStub.state.writes[0].First_Name, 'Pat');
assert.ok(zohoStub.state.notes.some((n) => n.leadId === '5001' && n.Note_Title === 'PAYROLL FINDINGS')); ok('…and it landed in the CRM as a field update plus notes');
const reviewIds = (st) => st.review.map((j) => j.leadId).sort();
assert.deepEqual(reviewIds(s), ['5001', '5002']); assert.equal(s.review.find((j) => j.leadId === '5001').written, true); ok('review queue: the written lead still shows its tick, the other waits');

// 5a. Hard stops and the fallback ladder
r = await call('rep', '/api/run', { leads: [{ id: '5501', company: 'Runaway Inc', owner: { id: '999' } }, { id: '5502', company: 'Gamma LLC', owner: { id: '999' } }] });
assert.equal(r.status, 200); const runawayRun = r.json.runId; ok('run with a never-converging session started ' + runawayRun);
s = await pollRun('rep', (x) => x.run && x.run.id === runawayRun && x.run.finishedAt, 200);
{
  const j = s.run.jobs.find((x) => x.leadId === '5501');
  assert.equal(j.status, 'done'); assert.ok(j.fallback && /25 tool calls/.test(j.fallback.reason), JSON.stringify(j.fallback)); ok('runaway session was killed at the tool-call wall');
  assert.equal(j.mode, 'basic'); assert.equal(j.result.basic.hcm, 'Paylocity'); assert.equal(j.attempts.length, 2); assert.equal(j.attempts[0].stopped, 'used more than 25 tool calls'); ok('…and the lead came back as a basic-profile fallback');
  assert.equal(s.run.jobs.find((x) => x.leadId === '5502').status, 'done'); ok('the other lead in the run was unaffected');
  const h = await fetch(BASE + '/healthz').then((x) => x.json()); assert.equal(h.liveSessions, 0); assert.equal(h.liveProcesses, 0); ok('no session slot or process leaked after the kill');
  // The queue: the unwritten lead from the first run is still in Review, the written one is not.
  assert.deepEqual(reviewIds(s), ['5002', '5501', '5502']); ok('review queue keeps the earlier run\'s unwritten lead alongside the new run');
  assert.equal(s.review[0].runId, runawayRun); assert.equal(s.review.find((x) => x.leadId === '5002').runId, runId); ok('…newest run first, each row tagged with its run');
}
// 5a'. Re-profiling a queued lead replaces its older waiting result; removing a lead takes it out without a write.
r = await call('rep', '/api/run', { leads: [{ id: '5002', company: 'Beta School', owner: { id: '999' } }] }); assert.equal(r.status, 200); const againRun = r.json.runId;
s = await pollRun('rep', (x) => x.run && x.run.id === againRun && x.run.finishedAt, 100);
assert.deepEqual(reviewIds(s), ['5002', '5501', '5502']); assert.equal(s.review.find((x) => x.leadId === '5002').runId, againRun); ok('a lead profiled again appears once, from the newer run');
assert.equal(JSON.parse(fs.readFileSync(path.join(STORE, 'data', 'history.json'))).runs.find((x) => x.id === runId).jobs.find((j) => j.leadId === '5002').discarded, 'superseded'); ok('…and the older result is marked superseded in history');
r = await call('rep', '/api/review/discard', { leadIds: ['5501'] }); assert.equal(r.json.removed, 1); assert.deepEqual(r.json.review.map((j) => j.leadId).sort(), ['5002', '5502']); ok('remove takes a result out of the queue');
r = await call('rep', '/api/write', { leadIds: ['5501'] }); assert.equal(r.status, 400); ok('…and it can no longer be written');
r = await call('rep', '/api/run', { leads: [{ id: '5601', company: 'Hung Inc', owner: { id: '999' } }, { id: '5602', company: 'Hung Inc', owner: { id: '999' } }, { id: '5603', company: 'Hung Inc', owner: { id: '999' } }, { id: '5604', company: 'Hung Inc', owner: { id: '999' } }] });
assert.equal(r.status, 200); const hungRun = r.json.runId; ok('run with hung sessions started ' + hungRun);
await wait(800);
r = await call('rep', '/api/run/cancel', {}); assert.equal(r.status, 200); assert.ok(r.json.killed >= 1); ok('Stop this run killed ' + r.json.killed + ' live sessions');
s = await pollRun('rep', (x) => x.run && x.run.id === hungRun && x.run.finishedAt, 200);
assert.equal(s.run.cancelled, 'Rep One'); assert.ok(s.run.jobs.every((j) => j.status === 'failed')); assert.ok(s.run.jobs.some((j) => /stopped by Rep One/.test(j.error))); ok('cancelled run finished with every lead failed and the reason recorded');
{ const h = await fetch(BASE + '/healthz').then((x) => x.json()); assert.equal(h.liveSessions, 0); assert.equal(h.liveProcesses, 0); ok('nothing leaked after the cancel'); }
r = await call('rep', '/api/run', { leads: [{ id: '5701', company: 'Recent Co', owner: { id: '999' }, profiledDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) }] });
assert.equal(r.status, 409); assert.equal(r.json.error, 'recent'); assert.equal(r.json.recent[0].id, '5701'); ok('a lead profiled two days ago is refused without force');
r = await call('rep', '/api/run', { force: true, leads: [{ id: '5701', company: 'Recent Co', owner: { id: '999' }, profiledDate: '2026-09-14' }] });
assert.equal(r.status, 200); s = await pollRun('rep', (x) => x.run && x.run.finishedAt, 100); ok('…and accepted with force');
assert.deepEqual(reviewIds(s), ['5002', '5502', '5701']); ok('review queue now spans three runs');

// 5b. Basic run — wide fan-out, own mode label, own review shape
r = await call('rep', '/api/run', { mode: 'basic', leads: Array.from({ length: 25 }, (_, i) => ({ id: String(6000 + i), company: 'Basic Co ' + i, owner: { id: '999' } })) });
assert.equal(r.status, 200); const basicRunId = r.json.runId; ok('rep starts a 25-lead basic run ' + basicRunId);
s = await pollRun('rep', (x) => x.run && x.run.id === basicRunId && x.run.finishedAt && x.run.jobs.every((j) => j.status === 'done'), 120);
assert.equal(s.run.mode, 'basic'); assert.equal(s.run.jobs.length, 25); ok('basic run carries mode=basic and finished all 25');
assert.equal(s.run.jobs[0].result.basic.hcm, 'Paylocity'); assert.equal(s.run.jobs[0].cost, 0.05); ok('basic result shape and cost captured');
assert.equal(s.review.length, 28); assert.equal(s.review.filter((j) => j.mode === 'full').length, 3); ok('review queue holds the 25 basic results plus the three full ones still waiting');
assert.equal(JSON.parse(fs.readFileSync(path.join(STORE, 'data', 'history.json'))).runs.find((x) => x.id === basicRunId).mode, 'basic'); ok('mode persisted to history');
r = await call('rep', '/api/write', { leadIds: ['6000', '6001'] }); assert.equal(r.json.queued, 2); ok('basic results queue for write');
s = await pollRun('rep', (x) => x.run.jobs.filter((j) => j.written).length === 2);
assert.ok(zohoStub.state.writes.some((w) => w.id === '6000' && w.Profile_Type === 'Basic')); ok('basic writes land directly, stamped Profile_Type = Basic');
r = await call('rep', '/api/run', { leads: Array.from({ length: 51 }, (_, i) => ({ id: String(7000 + i), company: 'X', owner: { id: '999' } })) });
assert.equal(r.status, 400); assert.match(r.json.error, /Basic profile/); ok('51-lead full run refused and pointed at basic');

// 6. Stats
r = await call('rep', '/api/stats?scope=all'); assert.equal(r.status, 403); ok('rep cannot see everyone stats');
r = await call('admin', '/api/stats?scope=all'); assert.equal(r.json.totalLeads, 31); assert.equal(r.json.fallbacks, 1); assert.equal(r.json.byPerson[0].name, 'Rep One'); assert.equal(r.json.byPerson[0].written, 3);
assert.equal(r.json.byMode.basic.leads, 26); assert.equal(r.json.byMode.full.leads, 5); assert.ok(r.json.byMode.basic.avgCost < r.json.byMode.full.avgCost); ok('admin sees company stats by person and by profile type');
r = await call('admin', '/api/stats'); assert.equal(r.json.totalLeads, 0); ok("admin's own stats are separate");

// 6a. The readiness gate: nothing runs while Zoho cannot take the write-back or
//     ZoomInfo is not signed in, and the reason is reported instead.
r = await call('rep', '/api/readiness'); assert.equal(r.json.readiness.ok, true); assert.equal(r.json.readiness.checks.zoho.ok, true); assert.equal(r.json.readiness.checks.zoominfo.ok, true);
assert.match(r.json.readiness.checks.zoominfo.status, /Connected/); assert.equal(r.json.readiness.checks.zoho.org, 'Stub Payroll Co'); ok('readiness: Zoho writable and ZoomInfo connected');
r = await call('rep', '/api/state'); assert.equal(r.json.readiness.ok, true); ok('readiness travels with /api/state');
zoomInfo('needs-auth');
r = await call('rep', '/api/readiness?fresh=1'); assert.equal(r.json.readiness.ok, false); assert.equal(r.json.readiness.issues.length, 1); assert.equal(r.json.readiness.issues[0].key, 'zoominfo');
assert.match(r.json.readiness.issues[0].detail, /sign-in on the server has expired/); assert.match(r.json.readiness.issues[0].fix, /claude mcp login zoominfo/); ok('ZoomInfo needing sign-in is reported with the fix');
r = await call('rep', '/api/run', { leads: [{ id: '8001', company: 'Blocked Co', owner: { id: '999' } }] });
assert.equal(r.status, 503); assert.equal(r.json.error, 'blocked'); assert.match(r.json.message, /ZoomInfo/); assert.equal(r.json.readiness.ok, false); ok('a run is refused while ZoomInfo is down, with the reason');
r = await call('rep', '/api/run', { mode: 'basic', leads: [{ id: '8002', company: 'Blocked Co', owner: { id: '999' } }] }); assert.equal(r.status, 503); ok('…a basic run too');
r = await call('rep', '/api/state'); assert.equal(r.json.run.id, basicRunId); assert.equal(r.json.run.jobs.length, 25); ok('…and no run was started');
{ const h = await fetch(BASE + '/healthz').then((x) => x.json()); assert.equal(h.liveSessions, 0); assert.equal(h.liveProcesses, 0); ok('no session was spent on the refused run'); }
r = await call('rep', '/api/write', { leadIds: ['6003'] }); assert.equal(r.json.queued, 1); ok('a write of finished results still goes through when only ZoomInfo is down');
s = await pollRun('rep', (x) => x.run.jobs.find((j) => j.leadId === '6003').written);
zoomInfo('down');
r = await call('rep', '/api/readiness?fresh=1'); assert.match(r.json.readiness.issues[0].detail, /cannot reach ZoomInfo right now: Failed to connect/); ok('an unreachable ZoomInfo server is reported as such');
zoomInfo('missing');
r = await call('rep', '/api/readiness?fresh=1'); assert.match(r.json.readiness.issues[0].detail, /not registered as an MCP server/); assert.match(r.json.readiness.issues[0].fix, /claude mcp add/); ok('an unregistered ZoomInfo server is reported with the add command');
zoomInfo(null);
zohoStub.state.tokenOk = false;
r = await call('rep', '/api/readiness?fresh=1'); assert.equal(r.json.readiness.ok, false); assert.equal(r.json.readiness.issues.length, 1); assert.equal(r.json.readiness.issues[0].key, 'zoho');
assert.match(r.json.readiness.issues[0].detail, /Zoho refused the connection: Token refresh failed: invalid_code/); ok('a revoked Zoho token is reported');
r = await call('rep', '/api/run', { leads: [{ id: '8003', company: 'Blocked Co', owner: { id: '999' } }] }); assert.equal(r.status, 503); assert.match(r.json.message, /Zoho refused/); ok('a run is refused while Zoho is down');
r = await call('rep', '/api/write', { leadIds: ['6004'] }); assert.equal(r.status, 503); assert.match(r.json.error, /Nothing was written\. Zoho refused/); ok('a write is refused while Zoho is down');
assert.equal((await call('rep', '/api/state')).json.run.jobs.find((j) => j.leadId === '6004').written, false); ok('…and the lead stays unwritten');
zohoStub.state.tokenOk = true; zohoStub.state.scope = 'ZohoCRM.modules.READ ZohoCRM.org.READ';
r = await call('rep', '/api/readiness?fresh=1'); assert.equal(r.json.readiness.ok, false); assert.match(r.json.readiness.issues[0].detail, /cannot write to Leads/); assert.match(r.json.readiness.issues[0].fix, /ZohoCRM\.modules\.ALL/); ok('a read-only Zoho token is reported as unable to write back');
r = await call('rep', '/api/run', { leads: [{ id: '8004', company: 'Blocked Co', owner: { id: '999' } }] }); assert.equal(r.status, 503); ok('…and blocks the run');
zohoStub.state.scope = 'ZohoCRM.modules.ALL ZohoCRM.settings.READ ZohoCRM.users.READ ZohoCRM.org.READ';
r = await call('admin', '/api/zoho/config', { dc: 'com', clientId: 'stub-client' }); assert.equal(r.json.ok, true); ok('admin re-saves Zoho, which drops the old token');
r = await call('rep', '/api/readiness?fresh=1'); assert.equal(r.json.readiness.ok, true); ok('readiness recovers once both connections are back');
r = await call('rep', '/api/write', { leadIds: ['6004'] }); assert.equal(r.json.queued, 1); s = await pollRun('rep', (x) => x.run.jobs.find((j) => j.leadId === '6004').written); ok('…and the held write goes through');

// 7. Restart → restore
child.kill(); await wait(500); child = boot(); await up();
r = await call('rep', '/api/state'); assert.equal(r.status, 200); ok('session cookie survives a restart');
assert.equal(r.json.run.id, basicRunId); assert.equal(r.json.run.restored, true); assert.equal(r.json.run.mode, 'basic');
assert.equal(r.json.run.jobs.find((j) => j.leadId === '6002').result.basic.ceo, 'Sam Roth');
assert.equal(r.json.run.jobs.find((j) => j.leadId === '6000').written, true); ok('latest (basic) run restored from disk with mode, results and written flags');
{
  const waiting = r.json.review.filter((j) => !j.written).map((j) => j.leadId).sort();
  assert.equal(waiting.length, 24); assert.ok(['5002', '5502', '5701', '6002', '6024'].every((id) => waiting.includes(id))); assert.ok(!waiting.includes('5501'));
  assert.equal(r.json.review.filter((j) => j.written).length, 4); ok('review queue restored across every run: 24 waiting from four runs, the latest run\'s 4 written rows, the removed one gone');
}
r = await call('rep', '/api/write', { leadIds: ['6002', '5502'] }); assert.equal(r.json.queued, 2); ok('unwritten leads from two restored runs can still be written together');
s = await pollRun('rep', (x) => x.review.filter((j) => j.written).length === 5 || x.review.filter((j) => j.leadId === '5502').length === 0);
assert.ok(zohoStub.state.writes.some((w) => w.id === '5502')); assert.deepEqual(reviewIds(s).filter((id) => id === '5502'), []); ok('…the older run\'s lead landed in Zoho and left the queue');

// 8. Disable / logout
r = await call('admin', '/api/users/' + rep.id, { enabled: false }); r = await call('rep', '/api/state'); assert.equal(r.status, 401); ok('disabling a user kills their session');
r = await call('admin', '/api/logout', {}); r = await call('admin', '/api/state'); assert.equal(r.status, 401); ok('logout clears session');

child.kill(); zohoStub.close();
fs.rmSync(STORE, { recursive: true, force: true });
console.log(`\n${pass} checks passed`);
