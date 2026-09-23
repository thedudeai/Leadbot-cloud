import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startZohoStub } from './zoho-stub.mjs';

// Playwright is installed globally, wherever this machine keeps its global modules.
const globalRoot = process.env.PLAYWRIGHT_ROOT || execSync('npm root -g').toString().trim();
const { chromium } = await import(path.join(globalRoot, 'playwright', 'index.mjs'));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const STORE = path.join(ROOT, 'storage-ui');
fs.rmSync(STORE, { recursive: true, force: true });
const PORT = 8972, BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, DATA_DIR: STORE, PORT: String(PORT), ADMIN_EMAIL: 'boss@chs.test', ADMIN_PASSWORD: 'adminpass123', ADMIN_NAME: 'Boss' };
// Zoho is a stand-in on localhost, so the Run screen browses directly and writes land.
const zohoStub = await startZohoStub(8974);
fs.mkdirSync(path.join(STORE, 'data'), { recursive: true });
fs.writeFileSync(path.join(STORE, 'data', 'zoho.json'), JSON.stringify(zohoStub.zohoJson));
const zoomInfo = (mode) => { const f = path.join(STORE, 'mcp-stub.txt'); if (mode) fs.writeFileSync(f, mode); else fs.rmSync(f, { force: true }); };
const child = spawn('node', ['server.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await wait(150); }

const browser = await chromium.launch();
const errors = [];
async function page(who) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(`[${who}] pageerror ${e.message}`));
  pg.on('response', (rs) => { if (rs.status() >= 400) { console.log('  HTTP', rs.status(), rs.request().method(), rs.url(), rs.request().postData(), rs.request().resourceType()); rs.text().then((t) => console.log('    body:', t)).catch(() => {}); } });
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(`[${who}] console ${m.text()}`); });
  return pg;
}

// admin: log in through the real form, set stub CLI, add a rep, walk every screen
const a = await page('admin');
await a.goto(BASE + '/'); if (!a.url().endsWith('/login')) throw new Error('expected redirect to /login, got ' + a.url());
await a.fill('#email', 'boss@chs.test'); await a.fill('#password', 'adminpass123'); await a.click('#go');
await a.waitForURL(BASE + '/'); await a.waitForSelector('#who b');
console.log('  admin who:', await a.textContent('#who b'));
for (const v of ['run', 'review', 'stats', 'segments', 'team', 'setup']) {
  const btn = a.locator(`nav button[data-v="${v}"]`); if (await btn.isHidden()) throw new Error('admin nav hidden: ' + v);
  await btn.click(); await wait(200);
}
await a.click('nav button[data-v="setup"]');
await a.fill('#c-cmd', `node ${path.join(ROOT, 'test', 'claude-stub.mjs')}`); await a.fill('#c-max', '2'); await a.click('#c-save'); await wait(300);
await a.click('#conn-check'); await wait(1500);
await a.click('#pre-run'); await a.waitForSelector('#pre-body .pill.ok', { timeout: 15000 });
console.log('  preflight rows:', await a.locator('#pre-body .pill.ok').count());
await a.click('nav button[data-v="team"]'); await a.waitForSelector('#t-add');
await a.fill('#t-name', 'Rep One'); await a.fill('#t-email', 'rep@chs.test'); await a.fill('#t-pw', 'reppass123'); await a.click('#t-add');
await a.waitForSelector('#team-body tbody tr:nth-child(2)');
console.log('  team rows:', await a.locator('#team-body tbody tr').count());
await a.screenshot({ path: path.join(ROOT, 'test', 'shot-admin-team.png') });

// mark rep as sees-all so they browse the whole stub org rather than one owner's leads
const repRow = a.locator('#team-body tbody tr').nth(1);
await repRow.locator('[data-k=seeAll]').check(); await wait(400);

// rep: log in, confirm admin screens are hidden, browse the stub CRM directly and profile a lead
const r = await page('rep');
await r.goto(BASE + '/login'); await r.fill('#email', 'rep@chs.test'); await r.fill('#password', 'reppass123'); await r.click('#go');
await r.waitForURL(BASE + '/'); await r.waitForSelector('#who b');
for (const v of ['segments', 'team', 'setup']) if (!(await r.locator(`nav button[data-v="${v}"]`).isHidden())) throw new Error('rep can see ' + v);
console.log('  rep nav ok; banner:', (await r.textContent('#run-banner')).slice(0, 60).trim());
if (await r.locator('#load').isVisible()) throw new Error('Load-via-Claude button shown although Zoho is connected');
await r.click('.seg'); await r.waitForSelector('#picker tbody tr', { timeout: 15000 });
await r.waitForSelector('#ready-banner', { state: 'attached' });
if (await r.locator('#ready-banner [data-ready="blocked"]').count()) throw new Error('blocked notice shown while both connections are up');
await r.click('#picker tbody tr input'); await r.click('#start');
await r.waitForSelector('#live .pill.ok', { timeout: 20000 });
await r.waitForSelector('#nb-review:text-is("1")', { timeout: 10000 });
await r.click('nav button[data-v="review"]'); await r.waitForSelector('#review-body tbody tr');
await r.click('#review-body .toggle'); await wait(200);
await r.screenshot({ path: path.join(ROOT, 'test', 'shot-rep-review.png'), fullPage: true });
await r.click('#approve-all'); await r.click('#write'); await r.waitForSelector('#review-body .pill.ok:text-is("✓")', { timeout: 15000 });
// basic profile: second button, basic review table, basic detail, write
await r.click('nav button[data-v="run"]'); await r.waitForSelector('#picker tbody tr', { timeout: 15000 });
await r.click('#picker tbody tr input');
if (!(await r.textContent('#start-basic')).includes('Basic profile 1 lead')) throw new Error('basic button label wrong: ' + await r.textContent('#start-basic'));
await r.click('#start-basic');
await r.waitForSelector('#live .pill.cool:text-is("basic")', { timeout: 20000 });
await r.waitForSelector('#live .pill.ok:text-is("done")', { timeout: 20000 });
await r.click('nav button[data-v="review"]'); await r.waitForSelector('#review-body tbody tr');
const hdr = await r.textContent('#review-body thead');
if (!hdr.includes('HR / applicant system') || !hdr.includes('Owner contact')) throw new Error('basic review table not shown: ' + hdr);
if (!(await r.textContent('#review-body tbody')).includes('Paylocity')) throw new Error('basic row missing HCM');
await r.click('#review-body .toggle'); await wait(200);
// the same stub lead was opened during the full run, so the first click may have closed it
if (!(await r.locator('#review-body .detail').count())) { await r.click('#review-body .toggle'); await wait(200); }
if (!(await r.textContent('#review-body .detail')).includes('Where the owners sit')) throw new Error('basic detail missing');
await r.screenshot({ path: path.join(ROOT, 'test', 'shot-rep-review-basic.png'), fullPage: true });
await r.click('#approve-all'); await r.click('#write'); await r.waitForSelector('#review-body .pill.ok:text-is("✓")', { timeout: 15000 });
console.log('  basic run reviewed and written');
await r.click('nav button[data-v="stats"]'); await wait(300);
console.log('  rep stats tile:', (await r.textContent('#stats-body .tile .n')));
if (!(await r.textContent('#stats-body')).includes('basic profiles')) throw new Error('stats missing basic tile');
await r.click('#pw').catch(() => {});

// a full run where one session runs away: the live screen shows the Stop button
// while it runs, the lead comes back as a basic fallback, and Review renders it
// inside the comprehensive table with the leadership column and its detail panel.
{
  const cfg = await r.evaluate(async () => (await (await fetch('/api/state')).json()).config);
  await a.click('nav button[data-v="setup"]'); await a.fill('#c-callsfull', '25'); await a.click('#c-save'); await wait(300);
  await r.evaluate(() => fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leads: [{ id: '9001', company: 'Runaway Inc' }, { id: '9002', company: 'Delta Co' }] }) }));
  await r.click('nav button[data-v="run"]');
  await r.waitForSelector('#stop-run', { timeout: 10000 });
  await r.waitForSelector('#live .pill.flag:text-is("fell back to basic")', { timeout: 60000 });
  await r.waitForSelector('#nb-review:text-is("2")', { timeout: 30000 });
  await r.click('nav button[data-v="review"]'); await r.waitForSelector('#review-body tbody tr');
  const body = await r.textContent('#review-body');
  if (!body.includes('basic fallback') || !body.includes('came back as a basic profile')) throw new Error('fallback row/banner missing');
  if (!(await r.textContent('#review-body thead')).includes('Leadership')) throw new Error('leadership column missing');
  if (!body.includes('with a number')) throw new Error('leadership cell missing');
  for (const t of await r.locator('#review-body .toggle').all()) { await t.click(); await wait(150); }
  const det = await r.textContent('#review-body');
  if (!det.includes('Leadership roster') || !det.includes('Why this is a basic profile')) throw new Error('detail panels missing roster/fallback rows');
  await r.screenshot({ path: path.join(ROOT, 'test', 'shot-rep-review-fallback.png'), fullPage: true });
  console.log('  fallback lead rendered in review with the leadership column');
  await a.click('nav button[data-v="setup"]'); await wait(200);
  if ((await a.inputValue('#c-model')) !== 'sonnet' || (await a.inputValue('#c-costfull')) !== '6') throw new Error('setup hard-stop fields not populated');
  console.log('  setup shows model + hard stops');
  void cfg;
}

// ZoomInfo loses its sign-in: the notice appears on the rep's Run screen without a
// reload, the Start buttons go off, the server refuses a run, and it all clears
// again once the connection is back and someone presses "check again".
{
  await r.click('nav button[data-v="run"]'); await r.waitForSelector('#picker tbody tr', { timeout: 15000 });
  await r.click('#picker tbody tr input');
  if (await r.locator('#start').isDisabled()) throw new Error('start disabled before the outage');
  zoomInfo('needs-auth');
  await a.click('nav button[data-v="setup"]'); await a.click('#ready-setup .ready-recheck');
  await r.waitForSelector('#ready-banner [data-ready="blocked"]', { timeout: 60000 });
  const notice = await r.textContent('#ready-banner');
  if (!notice.includes('Profiling is paused') || !notice.includes('ZoomInfo')) throw new Error('blocked notice wrong: ' + notice);
  if (notice.includes('claude mcp login')) throw new Error('rep was shown the admin fix');
  if (!notice.includes('Ask your admin')) throw new Error('rep notice lacks the ask-your-admin line');
  if (!(await r.locator('#start').isDisabled()) || !(await r.locator('#start-basic').isDisabled())) throw new Error('start buttons still enabled while blocked');
  // Through the context's request API rather than an in-page fetch: the refusal is
  // the point, and Chromium would log the 503 as a console error otherwise.
  const refused = await r.request.post(BASE + '/api/run', { data: { leads: [{ id: '111', company: 'Stub Co' }] } });
  if (refused.status() !== 503) throw new Error('server did not refuse the run: ' + refused.status());
  if ((await refused.json()).error !== 'blocked') throw new Error('refusal body wrong');
  await a.waitForSelector('#ready-setup [data-ready="blocked"]', { timeout: 10000 });
  if (!(await a.textContent('#ready-setup')).includes('claude mcp login zoominfo')) throw new Error('admin notice lacks the fix');
  if ((await a.textContent('#nb-setup')) !== '!') throw new Error('setup badge not flagged');
  await r.screenshot({ path: path.join(ROOT, 'test', 'shot-rep-blocked.png'), fullPage: true });
  zoomInfo(null);
  await r.click('#ready-banner .ready-recheck');
  await r.waitForSelector('#ready-banner [data-ready="blocked"]', { state: 'detached', timeout: 60000 });
  if (await r.locator('#start').isDisabled()) throw new Error('start still disabled after recovery');
  await a.waitForSelector('#ready-setup [data-ready="ok"], #ready-setup [data-ready="warn"]', { timeout: 10000 });
  console.log('  outage notice shown, run refused, buttons off; cleared on recovery');
}

// admin sees rep's run in Everyone stats
await a.click('nav button[data-v="stats"]'); await a.click('#stats-scope button[data-scope="all"]'); await wait(500);
console.log('  admin everyone-stats has by-person:', (await a.textContent('#stats-body')).includes('Rep One'));
await a.screenshot({ path: path.join(ROOT, 'test', 'shot-admin-stats.png'), fullPage: true });

await browser.close(); child.kill(); zohoStub.close(); fs.rmSync(STORE, { recursive: true, force: true });
if (errors.length) { console.log('BROWSER ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('\n  UI pass clean — no page or console errors.');
