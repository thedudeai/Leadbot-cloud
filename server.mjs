#!/usr/bin/env node
// LeadBot Cloud — the hosted, multi-user version of the Lead Bot dashboard for
// the zoho-lead-profiler skill. Zero dependencies. Node 20+.
//
// Same engine as the desktop build: every lead gets its own headless Claude Code
// session, Zoho listing and write-back go straight to the CRM REST API, and a
// human approves every write in Review. What this build adds is a login, users
// and roles, per-person lead scoping and run state, a server-wide cap on
// concurrent Claude sessions, and storage on a persistent volume.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR is the persistent volume in production (Railway mounts it at /data).
// Locally it falls back to ./storage so a dev run never touches the repo files.
const STORAGE = process.env.DATA_DIR || path.join(HERE, 'storage');
const DATA = path.join(STORAGE, 'data');
const RUNS = path.join(STORAGE, 'runs');
for (const d of [DATA, RUNS]) fs.mkdirSync(d, { recursive: true });

const CONFIG_PATH = path.join(DATA, 'config.json');
const SEGMENTS_PATH = path.join(DATA, 'segments.json');
const HISTORY_PATH = path.join(DATA, 'history.json');
const ZOHO_PATH = path.join(DATA, 'zoho.json');
const USERS_PATH = path.join(DATA, 'users.json');
const SESSIONS_PATH = path.join(DATA, 'sessions.json');

// ---------------------------------------------------------------- persistence

const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

const DEFAULT_CONFIG = {
  pepm: 20,
  concurrency: 3,               // per comprehensive run — how many of one person's leads go at once
  basicConcurrency: 20,         // per basic run — the light pass is cheap, so it fans out wide
  maxSessions: 6,               // server-wide — total comprehensive sessions alive at any moment
  basicTimeoutMin: 12,          // a basic session that runs longer than this is doing too much
  claudeCmd: 'claude',
  // The research model. An alias ('sonnet', 'opus', 'fable') or a full model name. Every
  // mode sends the same prompt and the server shapes the output the same way, so switching
  // this changes research depth and cost, never the shape of what lands in Zoho.
  model: 'sonnet',
  fallbackModel: '',            // used by the CLI only when `model` is overloaded or unavailable
  utilityModel: 'haiku',        // preflight and the fetch fallback — trivial JSON tasks
  permissionMode: 'bypassPermissions',
  perLeadTimeoutMin: 25,
  // Hard stops. Each one ends the session on its own; together they are what makes a
  // runaway lead impossible. A stopped comprehensive session falls back to a basic pass.
  maxCostFull: 6,               // dollars per comprehensive session (CLI --max-budget-usd)
  maxCostBasic: 0.75,           // dollars per basic session
  maxToolCallsFull: 100,        // the prompt budgets 80; this is the wall behind it
  maxToolCallsBasic: 16,        // the prompt budgets 12
  idleKillMin: 6,               // no output from the CLI for this long = hung, kill it
  fallbackToBasic: true,        // comprehensive fails or is stopped -> run the basic profile instead
  port: 8765,
};
// Settings that only exist since this version get their defaults even when an older
// config.json on the volume predates them. `model` gets one migration: the old default
// was '' (the CLI's own default, the most expensive tier) and the user chose Sonnet.
const CONFIG_VERSION = 3;

const DEFAULT_SEGMENTS = [
  {
    id: 'charter-schools',
    name: 'Charter schools — PA / NJ / NY',
    note: 'Flagged as a strong vertical in the 7 Aug run: hand-run back offices, multi-site payroll, state pension reporting (PSERS / TPAF / TRS), variable-hour after-school staff.',
    where: "((Industry like '%Education%' and State in ('PA','NJ','NY')) and Company like '%Charter%')",
    limit: 25,
  },
  {
    id: 'ny-care',
    name: 'NY home care & health agencies',
    note: 'Batch 1 of the 7 Aug run. Large headcounts, thin payroll vendor fingerprints.',
    where: "((State = 'NY' and Industry like '%Health%') and Company is not null)",
    limit: 25,
  },
  {
    id: 'unprofiled-newest',
    name: 'Never profiled — newest first',
    note: 'Anything without a Profiled_Date stamp, most recently added first.',
    where: "(Profiled_Date is null)",
    limit: 25,
  },
];

let config = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_PATH, {}) };
if ((config.configVersion || 0) < CONFIG_VERSION) {
  if (!config.model) config.model = DEFAULT_CONFIG.model;
  config.configVersion = CONFIG_VERSION;
}
let segments = readJSON(SEGMENTS_PATH, null) || readJSON(path.join(HERE, 'segments.default.json'), null) || DEFAULT_SEGMENTS;
let history = readJSON(HISTORY_PATH, null) || { runs: [] };
writeJSON(CONFIG_PATH, config);
writeJSON(SEGMENTS_PATH, segments);
writeJSON(HISTORY_PATH, history);

// ---------------------------------------------------------------- users & sessions
// Accounts are created by an admin. Passwords are scrypt-hashed with a per-user
// salt; nothing recoverable is stored. The very first admin comes from the
// ADMIN_EMAIL / ADMIN_PASSWORD environment variables when users.json is empty.

let users = readJSON(USERS_PATH, null) || [];
let sessions = readJSON(SESSIONS_PATH, null) || {};   // token -> { userId, createdAt, lastSeen }
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const saveUsers = () => writeJSON(USERS_PATH, users);
const saveSessions = () => writeJSON(SESSIONS_PATH, sessions);

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') });
const checkPassword = (user, password) => {
  if (!user || !user.hash || !user.salt) return false;
  const a = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const normEmail = (e) => String(e || '').trim().toLowerCase();
const findUser = (email) => users.find((u) => u.email === normEmail(email));
const publicUser = (u) => u && ({
  id: u.id, email: u.email, name: u.name, role: u.role, enabled: u.enabled !== false,
  zohoOwnerId: u.zohoOwnerId || null, zohoOwnerName: u.zohoOwnerName || null,
  seeAll: !!u.seeAll, createdAt: u.createdAt, lastLogin: u.lastLogin || null,
});

function createUser({ email, name, password, role = 'user', zohoOwnerId = null, zohoOwnerName = null, seeAll = false }) {
  const em = normEmail(email);
  if (!em || !em.includes('@')) throw new Error('A valid email address is required.');
  if (findUser(em)) throw new Error('There is already an account with that email.');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
  const u = {
    id: crypto.randomUUID(), email: em, name: String(name || em.split('@')[0]).trim(),
    role: role === 'admin' ? 'admin' : 'user', enabled: true,
    zohoOwnerId: zohoOwnerId || null, zohoOwnerName: zohoOwnerName || null, seeAll: !!seeAll,
    createdAt: Date.now(), ...hashPassword(password),
  };
  users.push(u); saveUsers();
  return u;
}

if (!users.length && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  createUser({ email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME || 'Admin',
    password: process.env.ADMIN_PASSWORD, role: 'admin', seeAll: true });
  console.log(`  Created the first admin account: ${normEmail(process.env.ADMIN_EMAIL)}`);
}

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[token] = { userId, createdAt: Date.now(), lastSeen: Date.now() };
  // Drop anything expired while we're here.
  for (const [t, s] of Object.entries(sessions)) if (Date.now() - s.lastSeen > SESSION_TTL_MS) delete sessions[t];
  saveSessions();
  return token;
}
function sessionUser(token) {
  const s = token && sessions[token];
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) { delete sessions[token]; saveSessions(); return null; }
  const u = users.find((x) => x.id === s.userId);
  if (!u || u.enabled === false) return null;
  // Throttle the write: once a minute per session is plenty for "last seen".
  if (Date.now() - s.lastSeen > 60_000) { s.lastSeen = Date.now(); saveSessions(); }
  return u;
}
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';')
  .map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

// Login throttle: 8 failures per email-or-IP per 15 minutes.
const loginFails = new Map();
function loginBlocked(key) {
  const f = loginFails.get(key);
  return !!(f && f.n >= 8 && Date.now() - f.at < 15 * 60_000);
}
function loginFailed(key) {
  const f = loginFails.get(key);
  if (f && Date.now() - f.at < 15 * 60_000) { f.n++; f.at = Date.now(); } else loginFails.set(key, { n: 1, at: Date.now() });
}

// ---------------------------------------------------------------- zoho direct api
// Browsing leads is a database read, not a research task, so it goes straight to
// the Zoho CRM REST API. No Claude session is involved anywhere below this line.
// Claude is still the only thing that profiles (Steps 2–5) and writes back (Step 6).

const DEFAULT_ZOHO = { dc: 'com', clientId: '', clientSecret: '', refreshToken: '', orgName: '' };
const ZOHO_DCS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa'];

// Credentials come from the environment in production (ZOHO_CLIENT_ID,
// ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_DC) and can be overridden by an
// admin saving them in Setup, which writes zoho.json on the volume. The file is
// never created at boot.
const envZoho = {
  ...(process.env.ZOHO_DC ? { dc: process.env.ZOHO_DC } : {}),
  ...(process.env.ZOHO_CLIENT_ID ? { clientId: process.env.ZOHO_CLIENT_ID } : {}),
  ...(process.env.ZOHO_CLIENT_SECRET ? { clientSecret: process.env.ZOHO_CLIENT_SECRET } : {}),
  ...(process.env.ZOHO_REFRESH_TOKEN ? { refreshToken: process.env.ZOHO_REFRESH_TOKEN } : {}),
};
let zoho = { ...DEFAULT_ZOHO, ...envZoho, ...readJSON(ZOHO_PATH, {}) };

const zohoConfigured = () => !!(zoho.clientId && zoho.clientSecret && zoho.refreshToken);
// The two hosts are derived from the data centre. zoho.json may optionally carry
// accountsBase / apiBase to point somewhere else; nothing in the UI writes them,
// they exist so the whole Zoho path can be exercised against a stand-in server.
const accountsHost = () => zoho.accountsBase || `https://accounts.zoho.${zoho.dc || 'com'}`;
const apiHost = () => zoho.apiBase || `https://www.zohoapis.${zoho.dc || 'com'}`;
const mask = (v) => !v ? '' : '••••••' + String(v).slice(-4);

let tokenCache = { token: null, expiresAt: 0, scope: '' };

async function zohoAccessToken(force = false) {
  if (!zohoConfigured()) throw new Error('Zoho is not configured yet.');
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const body = new URLSearchParams({
    refresh_token: zoho.refreshToken,
    client_id: zoho.clientId,
    client_secret: zoho.clientSecret,
    grant_type: 'refresh_token',
  });
  const r = await fetch(`${accountsHost()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    tokenCache = { token: null, expiresAt: 0, scope: '' };
    throw new Error(`Token refresh failed: ${j.error || j.message || `HTTP ${r.status}`}`);
  }
  // Refresh a minute early so a long request can't run out mid-flight.
  // Zoho hands back the granted scopes here; that string is the only way to tell
  // whether this token may write without actually writing something.
  tokenCache = {
    token: j.access_token,
    expiresAt: Date.now() + ((j.expires_in || 3600) - 60) * 1000,
    scope: j.scope || '',
  };
  return tokenCache.token;
}

/**
 * One authenticated CRM call. A 401 forces exactly one token refresh and one retry.
 * Returns { status, json } — 204 comes back as { status: 204, json: null }.
 */
async function zohoApi(pathAndQuery, { method = 'GET', body = null } = {}) {
  const call = async (token) => {
    // A Zoho call that never answers used to hang the write (and the run behind it)
    // for good. Thirty seconds is generous for a single record.
    const r = await fetch(apiHost() + pathAndQuery, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 204) return { status: 204, json: null };
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    return { status: r.status, json };
  };

  let res = await call(await zohoAccessToken());
  if (res.status === 401) res = await call(await zohoAccessToken(true));
  return res;
}

const zohoErrText = (res) => {
  const j = res.json || {};
  const d = Array.isArray(j.data) ? j.data[0] : null;
  return (d && (d.message || d.code)) || j.message || j.code || j.error || `Zoho returned HTTP ${res.status}`;
};

// -- COQL builders ------------------------------------------------------------
// This org rejects aggregates and needs three-or-more criteria explicitly
// left-nested: where ((a and b) and c). Everything goes through foldCriteria so
// that shape is never up to whoever is editing the query.

const qEsc = (v) => String(v == null ? '' : v).replace(/'/g, "''");
// The user's own % would silently turn an exact search into a wildcard sweep.
const likeTerm = (v) => qEsc(String(v == null ? '' : v).replace(/%/g, '')).trim();

function foldCriteria(list) {
  const c = (list || []).filter((x) => x && String(x).trim());
  if (!c.length) return null;
  let out = c[0];
  for (let i = 1; i < c.length; i++) out = `(${out} and ${c[i]})`;
  return out;
}

const LEAD_COLUMNS = [
  'id', 'Company', 'First_Name', 'Last_Name', 'Designation', 'Email', 'Phone', 'Mobile',
  'City', 'State', 'Industry', 'Employee_Count', 'Website',
  'Lead_Status', 'Owner', 'Created_Time', 'Modified_Time', 'Profiled_Date', 'Profile_Type',
];

const SORT_FIELDS = {
  created: 'Created_Time',
  modified: 'Modified_Time',
  company: 'Company',
  employees: 'Employee_Count',
};

function buildLeadsCOQL(params = {}) {
  const per = Math.max(1, Math.min(200, Number(params.per) || 50));
  const page = Math.max(1, Number(params.page) || 1);
  const offset = (page - 1) * per;

  const criteria = [];
  if (params.where && String(params.where).trim()) {
    // A saved segment's raw clause is used verbatim, as its own sole criterion.
    criteria.push(String(params.where).trim());
  } else {
    const q = likeTerm(params.q);
    if (q) {
      criteria.push(
        `((Company like '%${q}%' or Last_Name like '%${q}%')` +
        ` or (Email like '%${q}%' or City like '%${q}%'))`
      );
    }
    if (params.state) criteria.push(`State = '${qEsc(params.state)}'`);
    if (params.industry) criteria.push(`Industry = '${qEsc(params.industry)}'`);
    if (params.owner) criteria.push(`Owner = '${qEsc(params.owner)}'`);   // Owner.id does not work here
    if (params.status) criteria.push(`Lead_Status = '${qEsc(params.status)}'`);
    if (params.profiled === 'never') criteria.push('Profiled_Date is null');
    else if (params.profiled === 'done') criteria.push('Profiled_Date is not null');
  }
  // A non-admin's view is pinned to the leads they own in Zoho. This is applied
  // after everything else, on top of a saved segment's raw clause too, so no
  // filter or hand-edited segment can widen it.
  if (params.lockOwner) criteria.push(`Owner = '${qEsc(params.lockOwner)}'`);
  // COQL insists on at least one criterion.
  const where = foldCriteria(criteria) || 'Company is not null';

  const sortField = SORT_FIELDS[params.sort] || SORT_FIELDS.created;
  const order = String(params.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const coql =
    `select ${LEAD_COLUMNS.join(', ')} from Leads` +
    ` where ${where}` +
    ` order by ${sortField} ${order}` +
    ` limit ${offset}, ${per}`;

  return { coql, per, page, offset };
}

function mapLeadRow(row) {
  const owner = row.Owner || null;
  return {
    id: String(row.id),
    company: row.Company || '(no name)',
    city: row.City || '',
    state: row.State || '',
    industry: row.Industry || '',
    contact: [row.First_Name, row.Last_Name].filter(Boolean).join(' '),
    title: row.Designation || '',
    email: row.Email || '',
    phone: row.Phone || '',
    mobile: row.Mobile || '',
    website: row.Website || '',
    // This org has no revenue field at all, so the column is always null and the
    // UI simply has nothing to show for it.
    revenue: null,
    employees: row.Employee_Count == null ? null : row.Employee_Count,
    created: row.Created_Time || '',
    modified: row.Modified_Time || '',
    profiledDate: row.Profiled_Date || null,
    profileType: row.Profile_Type || null,
    owner: owner ? { id: String(owner.id), name: owner.name || owner.full_name || '' } : null,
    status: row.Lead_Status || '',
  };
}

async function zohoCoql(coql) {
  return zohoApi('/crm/v8/coql', { method: 'POST', body: { select_query: coql } });
}

async function zohoStatus() {
  const base = { configured: zohoConfigured(), ok: false, dc: zoho.dc || 'com', org: null, error: null,
    clientId: zoho.clientId || '', clientSecretMasked: mask(zoho.clientSecret), refreshTokenMasked: mask(zoho.refreshToken) };
  if (!base.configured) return base;
  try {
    const res = await zohoApi('/crm/v8/org');
    if (res.status >= 400) { base.error = zohoErrText(res); return base; }
    const org = (res.json && res.json.org && res.json.org[0]) || null;
    base.ok = true;
    base.org = org;
    if (org && org.company_name && org.company_name !== zoho.orgName) {
      zoho = { ...zoho, orgName: org.company_name };
      writeJSON(ZOHO_PATH, zoho);
    }
    return base;
  } catch (err) {
    base.error = err.message;
    return base;
  }
}

// Picklists barely change; re-reading them on every keystroke would be silly.
let metaCache = { at: 0, value: null };
const META_TTL_MS = 10 * 60 * 1000;

async function zohoMeta() {
  if (metaCache.value && Date.now() - metaCache.at < META_TTL_MS) return metaCache.value;

  const out = { states: [], industries: [], owners: [], leadStatuses: [], error: null };

  const users = await zohoApi('/crm/v8/users?type=ActiveUsers');
  if (users.status < 400 && users.json && Array.isArray(users.json.users)) {
    out.owners = users.json.users
      .map((u) => ({ id: String(u.id), name: u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || String(u.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const fields = await zohoApi('/crm/v8/settings/fields?module=Leads');
  let statePicklist = null;
  if (fields.status < 400 && fields.json && Array.isArray(fields.json.fields)) {
    const pick = (apiName) => {
      const f = fields.json.fields.find((x) => x.api_name === apiName);
      if (!f || !Array.isArray(f.pick_list_values)) return null;
      const vals = f.pick_list_values
        .map((p) => p.actual_value || p.display_value)
        .filter((v) => v && String(v).trim() && v !== '-None-');
      return vals.length ? Array.from(new Set(vals)) : null;
    };
    statePicklist = pick('State');
    out.industries = pick('Industry') || [];
    out.leadStatuses = pick('Lead_Status') || [];
  }

  if (statePicklist) {
    out.states = statePicklist.sort();
  } else {
    // State is a plain text field in this org — sample it and dedupe here.
    const res = await zohoCoql('select State from Leads where State is not null order by State asc limit 0, 2000');
    if (res.status < 400 && res.json && Array.isArray(res.json.data)) {
      out.states = Array.from(new Set(res.json.data.map((r) => r.State).filter(Boolean).map((s) => String(s).trim()))).sort();
    }
  }

  metaCache = { at: Date.now(), value: out };
  return out;
}

// ---------------------------------------------------------------- zoho write-back
// Step 6 used to be a second Claude session driving the Zoho MCP connector. That
// only ever worked if the user's Claude CLI had a Zoho connector attached, and on
// a plain install it does not — the session cheerfully reported success having
// touched nothing. When the direct connection above is configured we write here
// instead: same field map, same notes, no session, no credits, no guessing.

// --- the absence filter ------------------------------------------------------
// The complaint that will not go away: records arrive carrying "no match", a
// COMPLIANCE note that says nothing was found, a field reading "N/A". Telling the
// model not to do it has been tried and it keeps happening, so the rule lives here
// in code, on the last line before the API call, where nothing can talk past it.
//
// An empty field already says "nothing here" in zero words. That is the output we
// want for a miss.
const ABSENCE_PATTERNS = [
  'no match', 'not found', 'none found', 'no records?\\b', 'no record found',
  'nothing found', 'no results?\\b', 'no data\\b', 'no hits', 'nothing surfaced',
  'no filings?\\b', 'no cases?\\b', 'no violations?\\b', 'no issues', 'no findings',
  'none identified', 'unable to ', 'could not ', "couldn'?t ", 'did not find',
  "didn'?t find", 'not located', 'not available', 'not disclosed', 'no public ',
  'no adverse', 'nothing adverse', 'not confirmed by search', 'no evidence of',
  'nothing on record', 'no enforcement', 'searched.{0,20}(?:nothing|empty)',
  // "clean" and "unknown" only when they are reporting an absence, not describing a
  // cleaning company or filling the Functional Role picklist.
  '(?:is|are|was|were|appears?|seems?|looks?|came back)\\s+clean\\b',
  '\\bclean\\s+(?:record|history|slate|bill)\\b',
  '\\b(?:n/a|tbd|unknown|undetermined|indeterminate)\\b',
];
const ABSENCE_RE = new RegExp(ABSENCE_PATTERNS.join('|'), 'i');
const isAbsence = (v) => typeof v === 'string' && ABSENCE_RE.test(v);

// A heading is a short all-caps line with no bullet marker — the "SIZE AND GROWTH"
// style section labels the skill's note formats use.
const isBullet = (s) => /^\s*(?:[·•*\u2013\u2014-]|\d+[.)])\s+/.test(s);
const isHeading = (s) => {
  const t = s.trim();
  return t !== '' && !isBullet(s) && t.length <= 60 && t === t.toUpperCase() && /[A-Z]/.test(t);
};

/**
 * Strip absence lines from a note body, then let the emptiness cascade upward:
 * a heading whose block is now empty goes too. Returns '' when nothing real is
 * left, and the caller then skips the note entirely rather than posting a title
 * with nothing under it.
 */
function scrubNote(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  const kept = lines.filter((line) => !isAbsence(line));

  const out = [];
  for (let i = 0; i < kept.length; i++) {
    if (isHeading(kept[i])) {
      let hasBody = false;
      for (let j = i + 1; j < kept.length; j++) {
        if (isHeading(kept[j])) break;
        if (kept[j].trim() !== '') { hasBody = true; break; }
      }
      if (!hasBody) continue;               // the heading lost its whole block
    }
    out.push(kept[i].replace(/\s+$/, ''));
  }

  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Nothing but headings left means nothing was actually found.
  const meaningful = body.split('\n').filter((l) => l.trim() !== '' && !isHeading(l));
  return meaningful.length ? body : '';
}

// --- plain English -----------------------------------------------------------
// A rep reads these records cold and is not an analyst. The model still slips
// source codes and shorthand into notes, so two things happen here: a fixed
// dictionary expands the codes we know, and anything suspicious left over is
// reported to the user rather than written silently.

const CODE_EXPANSIONS = [
  // Source-code prefixes, as they appear at the head of a bullet: "· LI 12Jul26 — ..."
  [/(^|[·•\-*]\s*)LI\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1On LinkedIn, '],
  [/(^|[·•\-*]\s*)FB\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1On Facebook, '],
  [/(^|[·•\-*]\s*)IG\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1On Instagram, '],
  [/(^|[·•\-*]\s*)YT\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1On YouTube, '],
  [/(^|[·•\-*]\s*)TT\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1On TikTok, '],
  [/(^|[·•\-*]\s*)WEB\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1On the company website, '],
  [/(^|[·•\-*]\s*)NEWS\s+/gm, '$1In press coverage, '],
  [/(^|[·•\-*]\s*)PR\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1In a press release, '],
  [/(^|[·•\-*]\s*)POD\s+/gm, '$1On a podcast, '],
  [/(^|[·•\-*]\s*)ATS\s+(?=\d{1,2}[A-Z][a-z]{2}\d{2})/gm, '$1In a job posting, '],
  [/(^|[·•\-*]\s*)GLD\s+/gm, '$1On Glassdoor or Indeed, '],
  [/(^|[·•\-*]\s*)SOS\s+/gm, '$1In the state business registry, '],
  [/(^|[·•\-*]\s*)ZI\s+intent/gm, '$1ZoomInfo buying-intent data'],
  // Inline shorthand
  [/\bZI accuracy (\d+)/g, 'ZoomInfo, whose confidence in this value is $1 out of 100'],
  [/\bZI\b(?!\w)/g, 'ZoomInfo'],
  [/\bDOL WHD\b/g, 'US Department of Labor wage and hour'],
  [/\bWHD\b/g, 'the Department of Labor wage and hour division'],
  // Longest forms first — a shorter rule firing early strands the rest of the code.
  [/\b(?:Form )?5500 Sch\s?C,? PY(\d{2})\b/gi, 'the service-provider schedule of their 20$1 federal retirement-plan filing'],
  [/\b(?:Form )?5500 Sch\s?C\b/gi, 'the service-provider schedule of their federal retirement-plan filing'],
  [/\bSch\s?C PY(\d{2})\b/g, 'the service-provider schedule of their 20$1 retirement-plan filing'],
  [/\b(?:Form )?5500 PY(\d{2})\b/gi, 'their federal retirement-plan filing for 20$1'],
  [/\bForm 5500\b/g, 'their federal retirement-plan filing, which employers file each year'],
  [/\b5500\b/g, 'their federal retirement-plan filing'],
  [/\bPY(\d{2})\b/g, 'plan year 20$1'],
  [/\bSUI\b/g, 'state unemployment insurance'],
  [/\bPEPM\b/g, 'per employee per month'],
  [/\bNPPES\b/g, 'the federal healthcare provider registry'],
  [/\bNPI (\d{10})\b/g, 'federal healthcare provider registration $1'],
  [/\bW-?2 (staff|employees|workforce)\b/gi, 'employees on payroll rather than contractors'],
  [/\bpriority[- ]([12])\b/gi, (m, n) => (n === '1' ? 'the person who can say yes' : 'a good second door in')],
];

// --- dates ---------------------------------------------------------------
// One format everywhere, the way the user reads a date: 8/19/2026. No leading
// zeros, no "19 August 2026", no "14Jul26", no ISO. Sources and dates then sit at
// the end of the line in brackets — round for the source, square for the date.
const MONTH_NUM = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9,
  oct:10, nov:11, dec:12, january:1, february:2, march:3, april:4, june:6, july:7,
  august:8, september:9, october:10, november:11, december:12 };

const us = (m, d, y) => `${Number(m)}/${Number(d)}/${y}`;

function normalizeDates(text) {
  let t = String(text == null ? '' : text);
  // 14Jul26
  t = t.replace(/\b(\d{1,2})([A-Z][a-z]{2})(\d{2})\b/g,
    (s, d, mon, y) => { const n = MONTH_NUM[mon.toLowerCase()]; return n ? us(n, d, '20' + y) : s; });
  // 2026-07-14  (ISO, including the note-title style)
  t = t.replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, (s, y, m, d) => us(m, d, y));
  // 14 July 2026 / 14 Jul 2026
  t = t.replace(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/g,
    (s, d, mon, y) => { const n = MONTH_NUM[mon.toLowerCase()]; return n ? us(n, d, y) : s; });
  // July 14, 2026 / Jul 14 2026
  t = t.replace(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g,
    (s, mon, d, y) => { const n = MONTH_NUM[mon.toLowerCase()]; return n ? us(n, d, y) : s; });
  // July 2026 -> 7/2026, for month-only facts
  t = t.replace(/\b([A-Za-z]{3,9})\.?\s+(20\d{2})\b/g,
    (s, mon, y) => { const n = MONTH_NUM[mon.toLowerCase()]; return n ? `${n}/${y}` : s; });
  return t;
}

// A date at the end of a line should be in square brackets. This wraps a bare one
// rather than leaving the record inconsistent; anything mid-sentence is reported
// instead, because moving it safely needs a human's judgement about the sentence.
const TRAILING_DATE = /(?:\s|\()(\d{1,2}\/\d{1,2}\/20\d{2}|\d{1,2}\/20\d{2})\)?\s*$/;

function bracketTrailingDates(text) {
  return String(text == null ? '' : text).split('\n').map((line) => {
    if (/\[\d{1,2}\/\d{1,2}\/20\d{2}\]\s*$/.test(line) || /\[\d{1,2}\/20\d{2}\]\s*$/.test(line)) return line;
    const m = line.match(TRAILING_DATE);
    if (!m) return line;
    return line.replace(TRAILING_DATE, ` [${m[1]}]`);
  }).join('\n');
}

// Dates buried mid-sentence, which the bracket convention says belong at the end.
function looseDates(text) {
  return String(text == null ? '' : text).split('\n').filter((line) => {
    const d = line.match(/\d{1,2}\/\d{1,2}\/20\d{2}/g);
    if (!d) return false;
    const bracketed = (line.match(/\[\d{1,2}\/\d{1,2}\/20\d{2}\]/g) || []).length;
    return d.length > bracketed;
  }).length;
}

function expandCodes(text) {
  let t = String(text == null ? '' : text);
  for (const [re, to] of CODE_EXPANSIONS) t = t.replace(re, to);
  t = normalizeDates(t);
  t = bracketTrailingDates(t);
  return t.replace(/[ \t]{2,}/g, ' ');
}

// What is left that still reads like machine output. Reported, never silently kept
// or silently deleted — a human decides, because some of these are legitimate in
// context (a company genuinely called "ACI", say).
const JARGON_RE = /(^|[\s(·•\-*])(LI|FB|IG|YT|TT|ATS|SOS|ZI|WHD|DOL|NPI|NPPES|PEPM|ACV|SUI|SchC|GLD|POD)([\s.,:;)]|$)/g;
const DATECODE_RE = /\b\d{1,2}(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d{2}\b/;

function jargonLeft(text) {
  const hits = new Set();
  const t = String(text == null ? '' : text);
  let m;
  JARGON_RE.lastIndex = 0;
  while ((m = JARGON_RE.exec(t)) !== null) hits.add(m[2]);
  if (DATECODE_RE.test(t)) hits.add('short date codes such as 14Jul26');
  return [...hits];
}

// --- bold headlines ----------------------------------------------------------
// Zoho notes are a plain-text field. Verified on 8/23/2026 by posting a note
// containing <b>, <strong> and **markdown** and reading it back — every one came
// back byte-for-byte, so markup is stored and shown literally, never rendered.
//
// The only thing that actually appears bold in a plain-text field is Unicode
// mathematical sans-serif bold, which is a separate set of characters that most
// fonts render heavy. So headlines are transliterated into those characters.
//
// The cost, and it is real: Zoho's search will not match these against ordinary
// typing. Searching "payroll" will not find a bold "PAYROLL" headline. That is why
// ONLY the headline is bolded — every fact, name, number and date stays in normal
// characters and stays searchable.
const BOLD_A = 0x1D5D4;   // Mathematical Sans-Serif Bold Capital A
const BOLD_a = 0x1D5EE;   // small a
const BOLD_0 = 0x1D7EC;   // digit zero

function toBold(str) {
  let out = '';
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) out += String.fromCodePoint(BOLD_A + (c - 65));
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(BOLD_a + (c - 97));
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(BOLD_0 + (c - 48));
    else out += ch;                      // punctuation and spaces pass through
  }
  return out;
}

const alreadyBold = (s) => /[\u{1D5D4}-\u{1D607}\u{1D7EC}-\u{1D7F5}]/u.test(s);
const BULLET_HEAD = /^(\s*[\u00b7\u2022*\u2013\u2014-]\s*)([^\u2014\n]{2,70}?)(\s+\u2014\s+)(.*)$/;

/**
 * Give every point a bold headline.
 *
 * Two shapes get bolded and nothing else:
 *   bullet HEADLINE - the detail...   the part before the em dash
 *   A STANDALONE ALL-CAPS LINE        the whole line
 *
 * Runs LAST, after the absence filter and the plain-English checks. Those match on
 * ordinary letters, and bolding first would make every one of them silently miss.
 */
function boldHeadlines(text) {
  return String(text == null ? '' : text).split('\n').map((line) => {
    if (!line.trim() || alreadyBold(line)) return line;
    if (/^\s*https?:\/\//i.test(line)) return line;          // bare links stay plain

    const m = line.match(BULLET_HEAD);
    if (m) {
      const head = m[2];
      // Not a headline if it is really a sentence, or carries a source or date.
      if (/[.!?]\s/.test(head) || /[()\[\]]/.test(head)) return line;
      return m[1] + toBold(head) + m[3] + m[4];
    }

    if (isHeading(line)) return toBold(line);
    return line;
  }).join('\n');
}

// --- multiple legal entities, one headcount ----------------------------------
// A lot of these companies are not one company. An office entity and a field
// entity, a separate LLC per state, a staffing arm — each with its own federal
// employer ID number, each filing its own payroll. ZoomInfo almost always reports
// the headquarters shell: on one recent lead it said 8 employees while the company
// itself said 100-plus clinicians across four entities.
//
// So the number written to Zoho is the TOTAL across every related entity, and the
// breakdown is written out so a rep can see where it came from.

// Number(null) and Number('') are both 0, so a missing headcount would quietly
// count as an entity with zero staff and drag the total down. An absent value has
// to be absent, not zero — a real 0 is still a value and survives.
const hasCount = (v) => v !== null && v !== undefined && v !== ''
  && Number.isFinite(Number(v)) && Number(v) >= 0;

function rollupHeadcount(entities) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const withCount = list.filter((e) => hasCount(e.employees));
  const missing = list.filter((e) => !withCount.includes(e));
  const total = withCount.reduce((sum, e) => sum + Number(e.employees), 0);
  return {
    entityCount: list.length,
    counted: withCount.length,
    missingNames: missing.map((e) => e.name).filter(Boolean),
    total: withCount.length ? total : null,
  };
}

// One line per entity, plain English, source and date in brackets at the end.
function entityLines(entities) {
  return (Array.isArray(entities) ? entities : []).filter(Boolean).map((e) => {
    const bits = [];
    if (e.name) bits.push(e.name);
    if (e.state) bits.push(e.state);
    if (e.role) bits.push(e.role);
    const head = bits.join(' \u00b7 ');
    const emp = hasCount(e.employees) ? `${Number(e.employees)} employees` : 'headcount not established';
    const ein = e.ein ? `federal employer ID ${e.ein}` : '';
    const tail = [e.source ? `(${e.source})` : '', e.date ? `[${e.date}]` : ''].filter(Boolean).join(' ');
    return `\u00b7 ${head} — ${[emp, ein].filter(Boolean).join(', ')}.${tail ? ' ' + tail : ''}`;
  });
}

// --- the leadership roster ----------------------------------------------------
// The strongest thing this product delivers is phone numbers for the people who can
// say yes. Every profile returns `leadership`: every owner, partner and C-level
// person the research could name, with the best numbers and email for each. The
// note built from it is written by the server, so it reads the same whether the
// research ran on Sonnet, Opus or Fable.
const cleanStr = (v) => (v == null ? '' : String(v).trim());
const cleanPhone = (v) => { const s = cleanStr(v); return s && /\d{7}/.test(s.replace(/\D/g, '')) && !isAbsence(s) ? s : ''; };
const cleanEmail = (v) => { const s = cleanStr(v).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''; };

function personName(p) { return [cleanStr(p.firstName), cleanStr(p.lastName)].filter(Boolean).join(' '); }

// Owners and C-level first, then the rest; within a tier, people with a phone first.
const TITLE_RANK = [
  [/\b(owner|founder|co-founder|proprietor|partner|managing member|principal)\b/i, 1],
  [/\b(ceo|chief executive|president|managing director|executive director|administrator)\b/i, 2],
  [/\b(cfo|coo|cio|cto|chro|chief|controller|treasurer)\b/i, 3],
  [/\b(vp|vice president|head of|director)\b/i, 4],
];
const titleRank = (t) => { const s = cleanStr(t); for (const [re, r] of TITLE_RANK) if (re.test(s)) return r; return 5; };

function leadershipRoster(result) {
  const seen = new Set();
  const out = [];
  const add = (p, extra = {}) => {
    if (!p || typeof p !== 'object') return;
    const name = personName(p);
    if (!name || isAbsence(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) {
      // Same person twice (the primary is usually on the roster too): keep the first
      // entry and fill in anything it was missing from the second.
      const cur = out.find((x) => x.name.toLowerCase() === key);
      const fill = { title: cleanStr(p.title), directPhone: cleanPhone(p.directPhone || p.phone), mobilePhone: cleanPhone(p.mobilePhone || p.mobile),
        email: cleanEmail(p.email), linkedin: cleanStr(p.linkedin), source: cleanStr(p.source || p.phoneSource), date: cleanStr(p.date), functionalRole: cleanStr(p.functionalRole) };
      for (const [k, v] of Object.entries(fill)) if (!cur[k] && v && !isAbsence(v)) cur[k] = v;
      return;
    }
    seen.add(key);
    out.push({
      firstName: cleanStr(p.firstName), lastName: cleanStr(p.lastName), name,
      title: isAbsence(cleanStr(p.title)) ? '' : cleanStr(p.title),
      directPhone: cleanPhone(p.directPhone || p.phone), mobilePhone: cleanPhone(p.mobilePhone || p.mobile),
      email: cleanEmail(p.email), linkedin: cleanStr(p.linkedin),
      directPhoneDNC: !!p.directPhoneDNC, mobilePhoneDNC: !!p.mobilePhoneDNC,
      source: isAbsence(cleanStr(p.source || p.phoneSource)) ? '' : cleanStr(p.source || p.phoneSource),
      date: cleanStr(p.date), functionalRole: cleanStr(p.functionalRole), ...extra,
    });
  };
  // The primary is on the roster too — a rep wants one list of everyone who can pick up.
  if (result.contact) add(result.contact, { primary: true });
  for (const p of Array.isArray(result.leadership) ? result.leadership : []) add(p);
  for (const p of Array.isArray(result.additionalContacts) ? result.additionalContacts : []) add(p);
  return out.sort((a, b) => (a.primary ? -1 : b.primary ? 1 : 0)
    || titleRank(a.title) - titleRank(b.title)
    || ((b.directPhone || b.mobilePhone) ? 1 : 0) - ((a.directPhone || a.mobilePhone) ? 1 : 0));
}

// One line per person: headline is the name, then title and every way to reach them.
function leadershipNote(roster) {
  const lines = roster.map((p) => {
    const bits = [];
    if (p.title) bits.push(p.title);
    if (p.directPhone) bits.push(`direct ${p.directPhone}${p.directPhoneDNC ? ' (flagged Do Not Call — do not dial)' : ''}`);
    if (p.mobilePhone) bits.push(`mobile ${p.mobilePhone}${p.mobilePhoneDNC ? ' (flagged Do Not Call — do not dial)' : ''}`);
    if (p.email) bits.push(p.email);
    if (p.linkedin) bits.push(p.linkedin);
    if (p.primary) bits.push('the primary contact on this record');
    const tail = [p.source ? `(${p.source})` : '', p.date ? `[${p.date}]` : ''].filter(Boolean).join(' ');
    return `· ${p.name.toUpperCase()} — ${bits.join(' · ')}.${tail ? ' ' + tail : ''}`;
  });
  if (!lines.length) return '';
  const withPhone = roster.filter((p) => p.directPhone || p.mobilePhone).length;
  return `Everyone at the top of this company the research could name, with a phone number on ${withPhone} of ${roster.length}. Owners and C-level first.\n\n${lines.join('\n')}`;
}

// Findings first, icebreakers last. Any note the profile added beyond these keys is
// written after the known ones, in the order it was given.
const NOTE_ORDER = ['PAYROLL FINDINGS', 'COMPANY STRUCTURE', 'CONTACT', 'LEADERSHIP CONTACTS', 'COMPANY BACKGROUND',
  'RESEARCH', 'TIMING', 'COMPLIANCE', 'ICEBREAKERS'];

function orderedNotes(notes) {
  const keys = Object.keys(notes || {});
  const known = NOTE_ORDER.filter((k) => keys.includes(k));
  const extra = keys.filter((k) => !NOTE_ORDER.includes(k));
  return [...known, ...extra];
}

// --- fields this bot must never send -----------------------------------------
// Four groups, and the reason differs for each. Anything in here is dropped from
// the payload before it is built, so a stray value in a profile JSON cannot reach
// the CRM by accident.
const BLOCKED_FIELDS = new Set([
  // 1. Created 2026-08-07 by earlier work on this project. Retired at the user's
  //    request. Profiled_Date is deliberately NOT in this list — see writeLeadDirect.
  'Payroll_Fit_Score', 'Fit_Tier', 'Why_Now', 'Likely_Payroll_Provider', 'Provider_Confidence',
  'Verified_Employees', 'Employee_Count_Source', 'Headcount_Trend_Pct', 'State_Count',
  'Has_DOL_Case', 'DOL_Backwages', 'Estimated_ACV', 'Profiled_By_Bot', 'Profile_Confidence',
  'Requires_Review', 'Disqualify_Reason', 'Contact_Seniority', 'Is_Decision_Maker',
  'Better_Contact_Found', 'DNC_Flag', 'LinkedIn_URL', 'Buying_Intent_Topics', 'Lead_Provider',
  // 2. Placeholder picklists — the org defined only "Option 1" and "Option 2", so
  //    every real value is rejected and takes the whole record down with it.
  'Company_Name', 'Company_City', 'Company_State', 'Company_Street_Address', 'Company_Country',
  'Company_HQ_Phone', 'Revenue_Range', 'Employee_Range', 'Middle_Name', 'Department', 'Ticker',
  'SIC_Codes', 'NAICS_Codes', 'Primary_Industry', 'Primary_SubIndustry', 'All_Industries',
  'All_SubIndustries', 'Ownership_Type', 'Business_Model', 'Recent_Funding_Round',
  'Industry_Hierarchical_Category', 'Secondary_Industry_Hierarchical_Category',
  // 3. Scores, pipeline stage and ownership. The user does not want leads rated,
  //    and stage and owner are human decisions a research pass is not entitled to make.
  'Lead_Rating', 'Lead_Rate', 'Lead_Status', 'Lead_Stage',
  'Strategic_Category', 'Strategic_Role_Category', 'Owner',
  // 4. Not on this org at all. The old build sent No_of_Employees and Annual_Revenue
  //    on every write and Zoho rejected the record every time, silently, which is a
  //    large part of why everything ended up in notes instead of fields.
  'Annual_Revenue', 'No_of_Employees', 'Number_of_Employees', 'Secondary_Email',
  'Fax', 'Twitter', 'Country', 'Rating',
]);

const CONTACT_FIELDS = [
  ['First_Name', (c) => c.firstName],
  ['Last_Name', (c) => c.lastName],
  ['Designation', (c) => c.title],
  ['Email', (c) => c.email],
  ['Phone', (c) => c.directPhone],
  ['Mobile', (c) => c.mobilePhone],
  ['Linkedin', (c) => c.linkedin],
];

// Verified against the live Leads schema on 19 Aug 2026. Every finding that has a
// home goes in that home — a populated field beats a note nobody opens.
const COMPANY_FIELDS = [
  'Website', 'Street', 'City', 'State', 'Zip_Code', 'Full_Address', 'Company_Number',
  'Employee_Count', 'Company_Size', 'Employee_Growth', 'Number_of_Locations', 'Description',
  'Existing_Client', 'Certified_Active_Company', 'Certification_Date', 'Industry',
  'Current_PR_Provider_new', 'Current_Payroll_Service', 'Payroll', 'Payroll_Frequency',
  'HCM', 'HRM', 'Benefits_Administration_Software', 'Benefits_Carrier', 'Healthcare_Providers',
  'Employee_Benefits_Broker', 'Self_Funded_Health_Plans', 'Life_Insurance', 'K_Retirement_Plan',
  'Pension_Retirement_Plans', 'Defined_Contribution_Plans',
  'WC_Carrier', 'WC_Renewal_Date', 'BN_Renewal_Date',
  'LinkedIn_Company_Profile_URL', 'Facebook_Company_Profile_URL', 'Twitter_Company_Profile_URL',
  'ZoomInfo_Company_Profile_URL', 'ZoomInfo_Contact_Profile_URL', 'Email_Domain',
  'Entity_Name_Ultimate_Parent', 'Entity_Name_Immediate_Parent', 'Relationship_Immediate_Parent',
  'Company_Is_Acquired', 'Recent_Investors', 'All_Investors', 'Recent_Funding_Date',
];

// The two additional-contact blocks. Their API names are inverted relative to their
// labels — only the first-name fields read the way you would guess — so writing by
// intuition splits one person across both blocks and produces two half-people.
const ADDITIONAL_BLOCKS = [
  { slot: 1, first: 'First_Name1', last: 'Last_Name2', email: 'Email2', phone: 'Phone2', title: 'Title2', role: 'Functional_Role2' },
  { slot: 2, first: 'First_Name2', last: 'Last_Name1', email: 'Email1', phone: 'Phone1', title: 'Title1', role: 'Functional_Role1' },
];

// Zoho rejects any value outside a picklist, and one bad value fails the whole
// record, so every picklist we write is checked against the org's real values.
const FUNCTIONAL_ROLE_VALUES = ['CEO', 'Partner - Owner', 'President', 'CFO', 'Controller',
  'Head of Finance', 'COO', 'Head of HR', 'HR Admin', 'HR Manager', 'Office Manager',
  'Marketing', 'Payroll', 'Board Member', 'Sales Person', 'Unknown'];

const PICKLISTS = {
  Functional_Role1: FUNCTIONAL_ROLE_VALUES,
  Functional_Role2: FUNCTIONAL_ROLE_VALUES,
  Payroll_Frequency: ['Bi-weekly', 'Monthly', 'Semi-Monthly', 'Weekly', 'Quarterly'],
  Benefits_Carrier: ['Aetna', 'Anthem', 'BCBS', 'Cigna', 'United'],
  Existing_Client: ['Yes', 'No'],
  Profile_Type: ['Basic', 'Comprehensive'],
  Salutation: ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Mr', 'Ms', 'Dr'],
};

// Returns the canonical picklist spelling, or null when the value is not a member.
function picklistValue(api, v) {
  const allowed = PICKLISTS[api];
  if (!allowed) return v;
  const hit = allowed.find((a) => a.toLowerCase() === String(v).trim().toLowerCase());
  return hit || null;
}

// A blank must never land on top of something a human typed, so anything empty is
// dropped before the payload is built. A real 0 is a value and survives.
const filled = (v) => {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  return String(v).trim() !== '';
};
// Every field write funnels through here, which makes this the one place the three
// rules can be enforced: never a blocked field, never an absence report, never a
// picklist value the org does not define. A rejected value removes the key rather
// than blanking it — sending "" would erase whatever a human typed there.
const put = (obj, key, v) => {
  if (!filled(v)) return;
  if (BLOCKED_FIELDS.has(key)) return;
  let val = typeof v === 'string' ? v.trim() : v;
  if (typeof val === 'string' && isAbsence(val)) return;
  if (PICKLISTS[key]) {
    val = picklistValue(key, val);
    if (!val) return;
  }
  if (DATE_FIELDS.has(key)) {
    val = toISODate(val);
    if (!val) return;
  }
  obj[key] = val;
};

// Zoho date FIELDS accept only ISO yyyy-MM-dd. The model writes every date in US
// format because the notes demand it — and on 9/3/2026 a "9/3/2026" sitting in
// Certification_Date made Zoho reject the ENTIRE field update while the notes
// still wrote, leaving a record with full notes and every field empty. So date
// fields are converted here mechanically, and a value that cannot be converted
// (a month-only "9/2026", junk) is dropped instead of taking the whole record down.
const DATE_FIELDS = new Set(['Certification_Date', 'WC_Renewal_Date', 'BN_Renewal_Date',
  'Recent_Funding_Date', 'Profiled_Date']);

function toISODate(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;                        // already ISO
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);                 // 9/3/2026
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);                       // 2026-9-3
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return null;
}

const todayISO = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;   // Zoho date fields only
};

// What a person reads: 8/19/2026.
const todayUS = () => {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
};

// The schema is read once per write batch. Leads carries hundreds of fields, so
// only the api_name set is kept.
let fieldNameCache = { at: 0, names: null };
const FIELDS_TTL_MS = 10 * 60 * 1000;

async function leadFieldNames() {
  if (fieldNameCache.names && Date.now() - fieldNameCache.at < FIELDS_TTL_MS) return fieldNameCache.names;
  const r = await zohoApi('/crm/v8/settings/fields?module=Leads');
  if (r.status >= 400 || !r.json || !Array.isArray(r.json.fields)) return null;
  const names = new Set(r.json.fields.map((f) => f.api_name).filter(Boolean));
  fieldNameCache = { at: Date.now(), names };
  return names;
}

// Zoho answers per record, not per request: HTTP 200 with a row whose status is
// "error" is a failed write. The api_name in details is the whole point of the
// message — "invalid data" alone tells the user nothing they can act on.
function rowOutcome(res) {
  const row = res.json && Array.isArray(res.json.data) ? res.json.data[0] : null;
  if (row && row.status === 'success') return { ok: true, id: row.details && row.details.id ? String(row.details.id) : null };
  if (row) {
    const api = (row.details && row.details.api_name) || null;
    return { ok: false, error: `${row.code || 'ERROR'}${api ? ` on ${api}` : ''} — ${row.message || 'Zoho rejected the write.'}` };
  }
  if (res.status >= 400) return { ok: false, error: zohoErrText(res) };
  return { ok: false, error: `Zoho returned HTTP ${res.status} with no per-record status.` };
}

async function writeNote(leadId, title, content) {
  const res = await zohoApi(`/crm/v8/Leads/${encodeURIComponent(leadId)}/Notes`, {
    method: 'POST',
    body: { data: [{ Note_Title: String(title), Note_Content: String(content) }] },
  });
  return rowOutcome(res);
}

/**
 * Write one approved profile straight to the CRM.
 * Returns { ok, partial, leadId, fieldsWritten, notesWritten, newLeadId, skipped, error }.
 * ok is true only when every part landed; anything less reports as partial with the
 * pieces that did succeed still listed, because "failed" on a half-written record
 * sends the user looking for changes that are actually there.
 */
async function writeLeadDirect(result, mode = 'full') {
  const basic = mode === 'basic';
  const leadId = String(result.leadId || '');
  const out = { ok: false, partial: false, leadId, fieldsWritten: [], notesWritten: [], newLeadId: null, skipped: [], warnings: [], error: null };
  if (!leadId) { out.error = 'This result has no Zoho record id.'; return out; }

  const c = result.contact || {};

  let names;
  try { names = await leadFieldNames(); }
  catch (err) { out.error = err.message; return out; }
  const has = (api) => (names ? names.has(api) : true);
  if (!names) out.skipped.push('Could not read the Leads schema, so field names could not be confirmed before writing.');

  // -- the update payload ------------------------------------------------------
  const payload = { id: leadId };

  // The decision-maker replaces whoever is in the contact fields, in place. There
  // is no second lead and no cross-reference note: one company, one record, the
  // person who can say yes sitting in the fields a rep dials from. Anyone displaced
  // is not deleted, they move into an additional-contact block below.
  for (const [api, pick] of CONTACT_FIELDS) {
    if (has(api)) put(payload, api, pick(c));
  }

  const fields = { ...(result.fields || {}) };

  // --- headcount across every related legal entity ---------------------------
  // The count that reaches Zoho is the sum over all entities, never the one the
  // headquarters record happens to report. If the profile found entities and gave
  // per-entity numbers, that sum wins outright — a single-entity figure sitting in
  // Employee_Count on a multi-entity company is the exact error this fixes.
  const roll = rollupHeadcount(result.entities);
  if (roll.entityCount > 1) {
    if (roll.total != null) {
      const single = Number(fields.Employee_Count);
      if (hasCount(fields.Employee_Count) && single !== roll.total) {
        out.warnings.push(`Headcount corrected from ${single} to ${roll.total}: the profile reported one entity's staff, but this company runs ${roll.entityCount} related legal entities and the total across them is ${roll.total}.`);
      }
      fields.Employee_Count = roll.total;
      fields.Company_Size = roll.total;
    } else {
      out.warnings.push(`${roll.entityCount} related legal entities were found but none carried a headcount, so no total could be built. The employee count on this record covers one entity at best.`);
    }
    if (roll.missingNames.length) {
      out.warnings.push(`No headcount for ${roll.missingNames.join(', ')}, so the total of ${roll.total} is a floor rather than a full count.`);
    }
  }

  // The company description is mandatory. It was left off a recent run and the
  // record was much harder to use, so a missing one is a loud warning rather than a
  // silent omission — the rest of the record still writes, and the dashboard shows
  // the flag so a human can send the lead back.
  if (!filled(fields.Description)) {
    out.warnings.push('NO COMPANY DESCRIPTION. The Description field is required on every lead and this profile did not produce one. Re-run this lead or write it by hand.');
  } else {
    fields.Description = expandCodes(fields.Description);
    const j = jargonLeft(fields.Description);
    if (j.length) out.warnings.push(`The description still contains shorthand a rep will not understand — ${j.join(', ')}. It was written as-is; consider rewording.`);
  }

  for (const api of COMPANY_FIELDS) {
    if (!has(api)) { out.skipped.push(`${api} — not on this org's Leads layout.`); continue; }
    put(payload, api, fields[api]);
  }

  // -- additional contacts ------------------------------------------------------
  // Two situations fill these: someone displaced from the primary slot, and — the
  // case the user asked for — a reachable senior second when the decision-maker has
  // no direct phone or email. The owner stays primary either way.
  const roster = leadershipRoster(result);
  const extras = (Array.isArray(result.additionalContacts) ? result.additionalContacts : [])
    .filter((p) => p && filled(p.lastName)).slice(0, 2);
  // Any slot the profile left empty is filled from the leadership roster: the most
  // senior person, not already on the record, who has a phone number. Two named
  // executives with direct dials on every record is the point of the roster.
  if (extras.length < 2) {
    const primaryKey = personName(result.contact || {}).toLowerCase();
    const used = new Set([primaryKey, ...extras.map((p) => personName(p).toLowerCase())]);
    for (const p of roster) {
      if (extras.length >= 2) break;
      if (used.has(p.name.toLowerCase()) || !(p.directPhone || p.mobilePhone)) continue;
      used.add(p.name.toLowerCase());
      extras.push({ firstName: p.firstName, lastName: p.lastName, title: p.title, email: p.email,
        directPhone: p.directPhone || p.mobilePhone, functionalRole: p.functionalRole, reason: 'leadership roster' });
    }
  }
  extras.forEach((p, i) => {
    if (!p || !filled(p.lastName)) return;
    const b = ADDITIONAL_BLOCKS[i];
    if (!has(b.first) || !has(b.last)) {
      out.skipped.push(`Additional contact ${b.slot} — those fields are not on this org's Leads layout.`);
      return;
    }
    put(payload, b.first, p.firstName);
    put(payload, b.last, p.lastName);
    put(payload, b.email, p.email);
    put(payload, b.phone, p.directPhone || p.phone);
    put(payload, b.title, p.title);
    // Free text keeps the real title; the picklist takes the nearest defined value.
    put(payload, b.role, p.functionalRole);
  });

  // Profiled_Date is the one field from the 2026-08-07 batch still in use. It is
  // bookkeeping for this app rather than content for a rep — the "Never profiled"
  // segment is a query against it — so it stays. Nothing else from that batch does.
  if (has('Profiled_Date')) payload.Profiled_Date = todayISO();
  else out.skipped.push('Profiled_Date — not on this org\'s Leads layout, so the "never profiled" segment will not exclude this lead.');
  // Two kinds of profile now write to the same record, and a rep needs to know
  // which one they are looking at: a Basic pass is six facts, not a research file.
  if (has('Profile_Type')) put(payload, 'Profile_Type', basic ? 'Basic' : 'Comprehensive');
  else out.skipped.push('Profile_Type — not on this org\'s Leads layout, so this record is not labelled Basic or Comprehensive.');

  const failures = [];

  const updateKeys = Object.keys(payload).filter((k) => k !== 'id');
  if (updateKeys.length) {
    // Zoho rejects the ENTIRE record over one bad value while the notes still
    // write — the exact "everything in notes, every field empty" failure of
    // 9/3/2026. So when the rejection names the offending field, drop that one
    // field, say so, and retry with the rest instead of losing everything.
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await zohoApi('/crm/v8/Leads', { method: 'PUT', body: { data: [payload] } });
      const o = rowOutcome(res);
      if (o.ok) { out.fieldsWritten = Object.keys(payload).filter((k) => k !== 'id'); break; }
      const bad = o.error && o.error.match(/ on (\w+)/);
      const remaining = Object.keys(payload).filter((k) => k !== 'id');
      if (bad && bad[1] !== 'id' && payload[bad[1]] !== undefined && remaining.length > 1 && attempt < 3) {
        out.warnings.push(`Zoho rejected the ${bad[1]} value (${o.error}). That one field was dropped and the rest of the record was written — check that field by hand.`);
        delete payload[bad[1]];
        continue;
      }
      failures.push(`Field update failed: ${o.error}`);
      break;
    }
  } else {
    out.skipped.push('No field had a value worth writing, so the record was left alone.');
  }

  // -- the notes ---------------------------------------------------------------
  // Notes are for evidence a field cannot hold. Each one is scrubbed first, and a
  // note that scrubs down to nothing is never posted — a COMPLIANCE heading with
  // "no match" under it is exactly the output this whole pass exists to prevent,
  // and an absent note is itself the signal that nothing turned up.
  const notes = { ...(result.notes || {}) };

  // The leadership roster is always written by the server from the structured list,
  // never taken from a note the model wrote, so it reads identically on every model.
  // Only worth a note when there is more than the primary on it.
  if (roster.length > 1) notes['LEADERSHIP CONTACTS'] = leadershipNote(roster);
  else delete notes['LEADERSHIP CONTACTS'];

  // If the profile found several entities but wrote no structure note, build one —
  // the breakdown behind a rolled-up headcount must be visible, or the number looks
  // invented.
  if (roll.entityCount > 1 && !filled(notes['COMPANY STRUCTURE'])) {
    const lines = entityLines(result.entities);
    const totalLine = roll.total != null
      ? `\nTotal across all ${roll.entityCount} entities: ${roll.total} employees.${roll.missingNames.length ? ' This is a floor — no headcount was established for ' + roll.missingNames.join(', ') + '.' : ''}`
      : '';
    notes['COMPANY STRUCTURE'] =
      `This company operates as ${roll.entityCount} related legal entities. Each one is a separate `
      + `employer with its own federal employer ID number, which means its own payroll registration, `
      + `its own tax filings and its own set of W-2s at year end.\n\n`
      + lines.join('\n') + totalLine;   // boldHeadlines runs on it in the write loop below
  }

  for (const title of orderedNotes(notes)) {
    const bodyText = notes[title];
    if (!filled(bodyText)) continue;
    // Expand the source codes first, then strip absences — running it the other way
    // round lets "no match" hide inside an unexpanded code and survive the filter.
    const clean = scrubNote(expandCodes(bodyText));
    if (!clean) { out.skipped.push(`${title} note — nothing left after the absence filter, so it was not written.`); continue; }
    const j = jargonLeft(clean);
    if (j.length) out.warnings.push(`The ${title} note still contains shorthand a rep will not understand — ${j.join(', ')}.`);
    const loose = looseDates(clean);
    if (loose) out.warnings.push(`${loose} line${loose === 1 ? '' : 's'} in the ${title} note carry a date mid-sentence. Dates belong at the end of the line in square brackets.`);
    // Bold last — the filters above match ordinary letters and would miss on bold ones.
    const o = await writeNote(leadId, title, boldHeadlines(clean));
    if (o.ok) out.notesWritten.push(title);
    else failures.push(`Note ${title} failed: ${o.error}`);
  }

  if (!basic && !Object.keys(notes).some((k) => k.toUpperCase().includes('FINDING'))) {
    out.warnings.push('No PAYROLL FINDINGS note. That is the most important note on the record — everything about how these people get paid should be in it.');
  }

  if (failures.length) {
    out.error = failures.join(' · ');
    const landed = out.fieldsWritten.length || out.notesWritten.length || out.newLeadId;
    out.partial = !!landed;
  } else {
    out.ok = true;
  }
  return out;
}

// A read-only look at what this token is allowed to do. Nothing here mutates a
// record: the granted scopes come back with the access token, and the module
// metadata call is a GET.
const WRITE_SCOPE_RE = /ZohoCRM\.modules\.(ALL|leads\.(ALL|CREATE|UPDATE|WRITE))/i;

async function zohoWriteCheck() {
  const out = { ok: false, checked: false, scope: '', canWrite: null, moduleEditable: null,
    required: 'ZohoCRM.modules.ALL (or ZohoCRM.modules.leads.ALL)', customFields: { present: [], missing: [] }, error: null };
  if (!zohoConfigured()) { out.error = 'Zoho is not connected yet.'; return out; }
  try {
    await zohoAccessToken(true);          // forces a refresh so the scope string is current
    out.scope = tokenCache.scope || '';
    out.checked = true;
    if (out.scope) out.canWrite = WRITE_SCOPE_RE.test(out.scope);

    const mod = await zohoApi('/crm/v8/settings/modules/Leads');
    const m = mod.json && Array.isArray(mod.json.modules) ? mod.json.modules[0] : null;
    if (m && typeof m.editable === 'boolean') out.moduleEditable = m.editable;

    const names = await leadFieldNames();
    if (names) {
      // The fields a run actually depends on. The 2026-08-07 profiler block is gone,
      // so what matters now is that the real destinations exist.
      const REQUIRED = ['Profiled_Date', 'Employee_Count', 'Current_PR_Provider_new', 'Description',
        'Linkedin', 'First_Name1', 'Last_Name2', 'Email2', 'Phone2', 'Title2', 'Functional_Role2'];
      for (const f of REQUIRED) {
        (names.has(f) ? out.customFields.present : out.customFields.missing).push(f);
      }
    }
    out.ok = out.canWrite !== false && out.moduleEditable !== false;
    if (out.canWrite === null && out.moduleEditable === null) {
      out.error = 'Zoho did not report the granted scopes for this token. The only certain test is a real write.';
      out.ok = false;
    }
    return out;
  } catch (err) {
    out.error = err.message;
    return out;
  }
}

// ---------------------------------------------------------------- event bus

// Each open dashboard tab is one SSE client tagged with its user. An event is
// delivered to that user's tabs only, unless userId is null (server-wide notice).
const clients = new Map();   // res -> userId
function emit(type, payload, userId = null) {
  const line = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const [res, uid] of clients) {
    if (userId && uid !== userId) continue;
    try { res.write(line); } catch {}
  }
}

// Server-wide cap on live Claude sessions. Per-run concurrency still applies on
// top; this is the number the company's Claude bill actually depends on.
let liveSessions = 0;
const sessionWaiters = [];
function acquireSession() {
  if (liveSessions < Math.max(1, Number(config.maxSessions) || 1)) { liveSessions++; return Promise.resolve(); }
  return new Promise((resolve) => sessionWaiters.push(resolve));
}
function releaseSession() {
  liveSessions = Math.max(0, liveSessions - 1);
  if (sessionWaiters.length && liveSessions < Math.max(1, Number(config.maxSessions) || 1)) {
    liveSessions++;
    sessionWaiters.shift()();
  }
}

// ---------------------------------------------------------------- claude bridge

function stripFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (!m) return text;
  return m[m.length - 1].replace(/```(?:json)?/g, '').replace(/```/g, '');
}

function extractJSON(text) {
  const candidates = [];
  const fenced = text.match(/```json\s*([\s\S]*?)```/g) || [];
  for (const f of fenced) candidates.push(f.replace(/```json/g, '').replace(/```/g, ''));
  candidates.push(stripFence(text));
  candidates.push(text);
  for (const c of candidates) {
    const t = c.trim();
    for (const start of ['{', '[']) {
      const i = t.indexOf(start);
      if (i === -1) continue;
      const end = start === '{' ? t.lastIndexOf('}') : t.lastIndexOf(']');
      if (end <= i) continue;
      try { return JSON.parse(t.slice(i, end + 1)); } catch {}
    }
  }
  return null;
}

/**
 * Run one headless Claude session. Prompt goes in over stdin so nothing has to
 * survive shell quoting. Returns { ok, json, text, events, cost, turns, stopped }.
 */
async function runClaude(prompt, opts = {}) {
  const waitedFrom = Date.now();
  await acquireSession();
  if (Date.now() - waitedFrom > 2000) opts.onEvent?.({ kind: 'note', msg: `Waited ${Math.round((Date.now() - waitedFrom) / 1000)}s for a free Claude slot.` });
  try {
    // The run may have been stopped while this job was queued for a slot.
    if (opts.cancelled && opts.cancelled()) return { ok: false, stopped: 'cancelled', error: `${opts.label || 'session'} was not started: the run was stopped`, events: [], toolCalls: 0, cost: null };
    return await runClaudeNow(prompt, opts);
  }
  finally { releaseSession(); }
}

// `claudeCmd` is a program plus optional arguments ("claude", or "node stub.mjs" in
// the tests). It is split here rather than handed to a shell: with `shell: true`
// the process we held was /bin/sh, and killing it on a timeout left the real CLI
// running as an orphan with its stdout pipe open. That orphan kept spending money
// for hours, the 'close' event never fired, the job never finished and the server-
// wide session slot was never released. That was the "circling for hours" bug.
const parseCmd = (s) => String(s || 'claude').trim().match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, ''));

// Every live CLI process, keyed by a group tag (the run id), so a run can be stopped.
const liveChildren = new Map();   // child -> { group, stop }
function stopGroup(group, reason) {
  let n = 0;
  for (const [, v] of liveChildren) if (v.group === group) { v.stop(reason); n++; }
  return n;
}

// Tools a research session has no business using. It reads nothing from disk any
// more (the brief is inlined in the prompt) and it never runs code.
const RESEARCH_DISALLOWED = 'Bash,Edit,Write,MultiEdit,NotebookEdit,Glob,Grep,Task,TodoWrite,KillShell,BashOutput,Read';

// A session the server kills never sends its final result event, which is the only
// place the CLI reports cost. Token usage arrives on every assistant message, so
// it is summed as it goes and priced here when the real number never comes. These
// are list prices per million tokens and are an ESTIMATE — good enough for the
// stats page to stop under-counting stopped sessions, not an invoice.
const PRICE_PER_MTOK = {
  haiku:  { in: 1,  out: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
  sonnet: { in: 3,  out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  opus:   { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};
function estimateCost(model, u) {
  const key = Object.keys(PRICE_PER_MTOK).find((k) => String(model || '').toLowerCase().includes(k)) || 'opus';
  const p = PRICE_PER_MTOK[key];
  return Math.round(((u.in * p.in) + (u.out * p.out) + (u.cacheRead * p.cacheRead) + (u.cacheWrite * p.cacheWrite)) / 1e6 * 1000) / 1000;
}

function runClaudeNow(prompt, { label, timeoutMin, logFile, onEvent, cwd, model, maxCost, maxToolCalls, schema, disallowed, group } = {}) {
  return new Promise((resolve) => {
    const [cmd, ...cmdArgs] = parseCmd(config.claudeCmd);
    const args = [...cmdArgs, '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', config.permissionMode];
    const m = model === undefined ? config.model : model;
    if (m) args.push('--model', m);
    if (config.fallbackModel && m !== config.fallbackModel) args.push('--fallback-model', config.fallbackModel);
    // The CLI's own dollar ceiling: the session ends with subtype error_max_budget_usd
    // the moment it is crossed, whatever the model was in the middle of.
    if (maxCost) args.push('--max-budget-usd', String(maxCost));
    // Structured output: the CLI makes the model return the JSON through a typed
    // tool, so every model hands back the same shape and nothing depends on how
    // well it formats a fenced block.
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (disallowed) args.push('--disallowed-tools', disallowed);

    // Sessions run inside the run's own empty folder, never the app folder, so
    // there is nothing in the working directory for a curious session to read.
    // `detached` puts the CLI in its own process group so the whole tree —
    // the CLI plus anything it spawned — can be killed in one call.
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: cwd || RUNS, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' },
      });
    } catch (err) {
      return resolve({ ok: false, error: `Could not start "${config.claudeCmd}": ${err.message}`, events: [], toolCalls: 0 });
    }

    let buf = '';
    let finalText = '';
    let structured = null;
    let subtype = null;
    let cost = null, turns = 0, toolCalls = 0, costEstimated = false;
    const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    const events = [];
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    let done = false;
    let stopped = null;          // why the server ended the session, if it did

    const note = (msg, kind = 'note') => {
      if (events.length < 600) events.push({ kind, msg, at: Date.now() });
      onEvent?.({ kind, msg });
      log?.write(`[${new Date().toISOString()}] ${kind}: ${msg}\n`);
    };

    const killTree = (sig) => {
      try { process.kill(-child.pid, sig); return; } catch {}
      try { child.kill(sig); } catch {}
    };

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer); clearInterval(idleTimer); clearTimeout(forceTimer);
      liveChildren.delete(child);
      log?.end();
      const json = structured || extractJSON(finalText);
      const budgetHit = subtype === 'error_max_budget_usd';
      if (cost == null && (usage.in || usage.out || usage.cacheRead)) { cost = estimateCost(m, usage); costEstimated = true; }
      const ok = !stopped && !budgetHit && code === 0 && !!json;
      resolve({
        ok, code, json, text: finalText, events, cost, costEstimated, usage, turns, toolCalls, stopped: stopped || (budgetHit ? 'budget' : null),
        error: ok ? null
          : stopped ? `${label || 'session'} was stopped by the server: ${stopped}`
          : budgetHit ? `${label || 'session'} hit its cost ceiling ($${maxCost}) before finishing`
          : subtype && subtype !== 'success' ? `${label || 'session'} ended with ${subtype}`
          : code !== 0 ? `${label || 'session'} exited with code ${code}`
          : `${label || 'session'} finished but returned no parseable JSON`,
      });
    };

    let forceTimer = null;
    const stop = (reason) => {
      if (done || stopped) return;
      stopped = reason;
      note(`stopping session — ${reason}`);
      killTree('SIGTERM');
      // Give it ten seconds to die politely, then SIGKILL the group, then stop
      // waiting for it at all: the job must finish even if the process will not.
      forceTimer = setTimeout(() => {
        killTree('SIGKILL');
        setTimeout(() => finish(null), 3000);
      }, 10_000);
    };
    liveChildren.set(child, { group: group || null, stop });

    const hardTimer = setTimeout(() => stop(`ran longer than ${timeoutMin || config.perLeadTimeoutMin} minutes`),
      (timeoutMin || config.perLeadTimeoutMin) * 60_000);
    // A session that has printed nothing for a while is hung — a stuck tool call,
    // a dead connector, a network stall. It is killed rather than waited on.
    let lastOutput = Date.now();
    const idleMs = Math.max(2, Number(config.idleKillMin) || 6) * 60_000;
    const idleTimer = setInterval(() => { if (Date.now() - lastOutput > idleMs) stop(`no output for ${Math.round(idleMs / 60_000)} minutes`); }, 15_000);

    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
      lastOutput = Date.now();
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        log?.write(line + '\n');
        if (ev.type === 'assistant' && ev.message?.content) {
          const u = ev.message.usage;
          if (u) { usage.in += u.input_tokens || 0; usage.out += u.output_tokens || 0; usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0; }
          for (const c of ev.message.content) {
            if (c.type === 'tool_use') {
              toolCalls++;
              if (c.name !== 'StructuredOutput') note(`${c.name}${c.input?.query ? ` — ${String(c.input.query).slice(0, 90)}` : ''}`, 'tool');
              // The wall behind the prompt's budget. The prompt says eighty; a
              // session that blows through a hundred is not going to converge.
              if (maxToolCalls && toolCalls > maxToolCalls) stop(`used more than ${maxToolCalls} tool calls`);
            } else if (c.type === 'text' && c.text.trim()) {
              note(c.text.trim().slice(0, 300), 'say');
            }
          }
          turns++;
        } else if (ev.type === 'result') {
          finalText = ev.result || finalText;
          if (ev.structured_output && typeof ev.structured_output === 'object') structured = ev.structured_output;
          subtype = ev.subtype || null;
          cost = ev.total_cost_usd ?? cost;
        }
      }
    });

    child.stderr.on('data', (c) => { lastOutput = Date.now(); log?.write('STDERR ' + c.toString()); });

    child.on('error', (err) => {
      if (done) return;
      stopped = null;
      done = true; clearTimeout(hardTimer); clearInterval(idleTimer); clearTimeout(forceTimer); liveChildren.delete(child); log?.end();
      resolve({ ok: false, error: `Could not start "${config.claudeCmd}": ${err.message}`, events, toolCalls });
    });

    // 'exit' rather than 'close': close waits for every stdio pipe to drain, and an
    // orphaned grandchild holding the pipe open is exactly the failure this guards.
    // The last stdout lines (the result event) can land just after exit, so finish
    // when stdout ends or two seconds after exit, whichever comes first.
    let exitCode = null, exited = false, outEnded = false;
    child.stdout.on('end', () => { outEnded = true; if (exited) finish(exitCode); });
    child.on('exit', (code) => {
      exited = true; exitCode = code;
      if (outEnded) finish(code); else setTimeout(() => finish(code), 2000);
    });
  });
}

// ---------------------------------------------------------------- prompts

// The skill is bundled inside this folder so headless sessions never hunt for it.
// The run logs showed every session spending its first 20-46 turns searching the
// machine for these four files — and sometimes finding stale extracts that still
// carry the retired scoring rules — so the prompts give the exact paths and forbid
// the search outright.
const SKILL_DIR = path.join(HERE, 'skill', 'zoho-lead-profiler');
const skillPath = (...parts) => path.join(SKILL_DIR, ...parts);

// The headless brief: the four skill files condensed into one, inlined into the
// prompt so a session reads nothing from disk. ~9k tokens instead of the ~32k the
// four files cost, and it is present from the first turn, so no Read calls, no
// hunting, and no chance of a stale copy. The style section is shared verbatim by
// both modes — that is what makes a basic and a comprehensive note read alike, and
// what makes Sonnet, Opus and Fable write alike.
const PROFILE_BRIEF = (() => { try { return fs.readFileSync(skillPath('HEADLESS.md'), 'utf8'); } catch { return ''; } })();
const STYLE_SECTION = (() => {
  const i = PROFILE_BRIEF.indexOf('## How everything is written');
  const j = PROFILE_BRIEF.indexOf('## The notes');
  return i >= 0 && j > i ? PROFILE_BRIEF.slice(i, j).trim() : '';
})();

// MCP tool names as the desktop logs showed them. Preflight can overwrite these
// with what the server's CLI actually exposes (see PREFLIGHT_PROMPT), and every
// prompt is rewritten through toolName() so a renamed connector costs zero turns.
const DEFAULT_TOOL_PREFIX = { zoominfo: 'mcp__claude_ai_ZoomInfo__', zoho: 'mcp__claude_ai_Zoho_CRM__' };
function toolPrefixes() {
  const t = (state.preflight && state.preflight.toolPrefixes) || {};
  return { zoominfo: t.zoominfo || DEFAULT_TOOL_PREFIX.zoominfo, zoho: t.zoho || DEFAULT_TOOL_PREFIX.zoho };
}
function applyToolNames(text) {
  const p = toolPrefixes();
  return String(text).split(DEFAULT_TOOL_PREFIX.zoominfo).join(p.zoominfo).split(DEFAULT_TOOL_PREFIX.zoho).join(p.zoho);
}

// The output contracts. Loose on purpose (additionalProperties stays open, almost
// nothing is required) — the schema exists to force the shape and the types, and
// the server's normalizer does the rest. A strict schema on a weaker model produces
// refusals, not better JSON.
const PERSON = {
  type: 'object',
  properties: {
    firstName: { type: 'string' }, lastName: { type: 'string' }, title: { type: 'string' },
    functionalRole: { type: 'string' }, email: { type: 'string' }, emailVerified: { type: 'boolean' },
    directPhone: { type: 'string' }, directPhoneVerified: { type: 'boolean' }, directPhoneDNC: { type: 'boolean' },
    mobilePhone: { type: 'string' }, mobilePhoneVerified: { type: 'boolean' }, mobilePhoneDNC: { type: 'boolean' },
    linkedin: { type: 'string' }, source: { type: 'string' }, date: { type: 'string' }, reason: { type: 'string' },
  },
};
const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    leadId: { type: 'string' }, company: { type: 'string' },
    disqualified: { type: ['string', 'null'] },
    employees: { type: ['number', 'null'] }, employeesBasis: { type: 'string', enum: ['stated', 'estimate'] },
    contactChanged: { type: 'boolean' },
    contact: { ...PERSON, properties: { ...PERSON.properties, priority: { type: ['number', 'null'] }, employmentVerifiedBy: { type: 'string' }, replacesRecordContact: { type: 'boolean' }, reachable: { type: 'boolean' } } },
    leadership: { type: 'array', items: PERSON },
    additionalContacts: { type: 'array', items: PERSON },
    entities: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, ein: { type: 'string' }, state: { type: 'string' }, role: { type: 'string' }, employees: { type: ['number', 'null'] }, source: { type: 'string' }, date: { type: 'string' } } } },
    fields: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
    notes: { type: 'object', additionalProperties: { type: 'string' } },
    needsHuman: { type: ['string', 'null'] },
    coverage: { type: 'object', additionalProperties: { type: 'boolean' } },
  },
  required: ['leadId', 'contact', 'fields', 'notes'],
};
const BASIC_SCHEMA = {
  type: 'object',
  properties: {
    leadId: { type: 'string' }, company: { type: 'string' },
    basic: { type: 'object', properties: {
      companyType: { type: 'string' }, ownership: { type: 'string' }, ceo: { type: 'string' },
      employees: { type: ['number', 'null'] }, employeesBasis: { type: 'string' },
      officeStaff: { type: ['number', 'null'] }, fieldStaff: { type: ['number', 'null'] }, facilities: { type: ['number', 'null'] },
      hcm: { type: 'string' }, hcmEvidence: { type: 'string' }, hq: { type: 'string' }, execLocation: { type: 'string' },
      gaps: { type: 'array', items: { type: 'string' } },
    } },
    employees: { type: ['number', 'null'] }, employeesBasis: { type: 'string' },
    contactChanged: { type: 'boolean' },
    contact: { ...PERSON, properties: { ...PERSON.properties, employmentVerifiedBy: { type: 'string' }, replacesRecordContact: { type: 'boolean' } } },
    leadership: { type: 'array', items: PERSON },
    additionalContacts: { type: 'array', items: PERSON },
    fields: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
    notes: { type: 'object', additionalProperties: { type: 'string' } },
    needsHuman: { type: ['string', 'null'] },
  },
  required: ['leadId', 'basic', 'contact', 'fields', 'notes'],
};

const SKILL_LINE =
  'Use the zoho-lead-profiler skill. ' +
  'Follow its rules exactly, including its verification ladder, search recipes, and its rule that no claim is written without a source and a date.';

const SKILL_FILES_BLOCK =
  `The skill lives at these EXACT paths. Read them with the Read tool and nothing else:
- ${skillPath('SKILL.md')} — read this first
- ${skillPath('references', 'verification.md')} — read before Step 2
- ${skillPath('references', 'search-recipes.md')} — read before Step 3
- ${skillPath('references', 'zoho-writeback.md')} — read before preparing the notes
Do NOT search for skill files — no Glob, no Grep, no find, no directory listings, no unzipping anything. Any other copy of this skill on this machine is stale and carries retired rules (including a scoring rubric this skill no longer has); never read one. Do not read anything else in the working directory either — no README, no logs, no prior results.`;

const PREFLIGHT_PROMPT = `You are running a one-shot capability check for a dashboard. Do not do any research.

Do exactly this, in one or two messages:
1. Call ToolSearch twice, in one message: once with the query "zoominfo" and once with the query "zoho". Read the EXACT full tool names that come back (they look like mcp__<server>__<tool>).
2. From those names, work out the prefix for the ZoomInfo tools (everything up to and including the second "__", e.g. "mcp__claude_ai_ZoomInfo__") and the prefix for the Zoho CRM tools. If a family is absent, use null.
3. Do not call any Zoho or ZoomInfo tool. Do not call WebSearch. Report whether WebSearch and WebFetch are in your tool list.

Output ONLY a fenced json block, no prose:
\`\`\`json
{"zoho": true, "zoominfo": true, "websearch": true, "webfetch": true, "toolPrefixes": {"zoominfo": "mcp__claude_ai_ZoomInfo__", "zoho": "mcp__claude_ai_Zoho_CRM__"}, "zoominfoTools": ["enrich_contacts", "search_contacts_v2"], "notes": "one short line on anything missing"}
\`\`\``;
const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    zoho: { type: 'boolean' }, zoominfo: { type: 'boolean' }, websearch: { type: 'boolean' }, webfetch: { type: 'boolean' },
    toolPrefixes: { type: 'object', properties: { zoominfo: { type: ['string', 'null'] }, zoho: { type: ['string', 'null'] } } },
    zoominfoTools: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
  required: ['zoho', 'zoominfo', 'websearch'],
};

function fetchPrompt(seg) {
  return `You are fetching a candidate list for a human to choose from. Do NOT profile anything, do NOT research, do NOT write to Zoho. This is a read-only listing task.

Run this Zoho COQL query and return the rows:

select id, Company, City, State, Industry, First_Name, Last_Name, Designation, Email, Phone, Mobile, Website, Employee_Count, Created_Time, Profiled_Date
from Leads
where ${seg.where}
order by Created_Time desc
limit ${Math.max(1, Math.min(200, seg.limit || 25))}

Zoho COQL quirks confirmed in this org — respect them:
- Aggregates (count, group by) are rejected. Do not use them.
- Three or more WHERE criteria need explicit parentheses: where ((a and b) and c).
- Pagination is: limit <offset>, <count>.
- Owner = '<id>' works; Owner.id does not.
If the query errors, fix it and retry up to twice, then report the error in the "error" field.

Output ONLY a fenced json block, no prose:
\`\`\`json
{"error": null, "leads": [{"id": "", "company": "", "city": "", "state": "", "industry": "", "contact": "", "title": "", "email": "", "phone": "", "mobile": "", "website": "", "employees": null, "created": "", "profiledDate": null}]}
\`\`\``;
}

// The lead extract every mode gets. Everything the picker already pulled from Zoho
// goes in, so a session never spends a call re-reading the record.
function leadBlock(lead) {
  return `- Zoho record id: ${lead.id}
- Company: ${lead.company}
- On record: ${lead.contact || '(none)'} ${lead.title ? `— ${lead.title}` : ''}
- Location: ${[lead.city, lead.state].filter(Boolean).join(', ') || '(unknown)'}
- Industry on record: ${lead.industry || '(unknown)'}
- Website: ${lead.website || '(none on record)'}
- Email on record: ${lead.email || '(none)'} · Phone on record: ${lead.phone || '(none)'} · Mobile on record: ${lead.mobile || '(none)'}
- Employee count on record (ZoomInfo import, unverified): ${lead.employees ?? '(none)'}
- Lead owner: ${(lead.owner && lead.owner.name) || '(unknown)'}`;
}

// The output shape, described once for the model in words the rulebook uses. The
// CLI's structured output enforces the types; this says what each thing means.
const PROFILE_SHAPE = `{
  "leadId": "<the Zoho record id, unchanged>", "company": "<company name>",
  "disqualified": null | "<why, in one sentence>",
  "employees": <total across every legal entity, or null>, "employeesBasis": "stated" | "estimate",
  "contactChanged": <true when the primary is not the person who was on the record>,
  "contact": { "firstName", "lastName", "title", "priority": 1 | 2 | null, "email", "emailVerified", "directPhone", "directPhoneVerified", "directPhoneDNC", "mobilePhone", "mobilePhoneVerified", "mobilePhoneDNC", "linkedin", "employmentVerifiedBy": "<source + date in words>", "replacesRecordContact", "reachable" },
  "leadership": [ { "firstName", "lastName", "title", "functionalRole", "email", "directPhone", "directPhoneDNC", "mobilePhone", "mobilePhoneDNC", "linkedin", "source": "<where the numbers came from>", "date": "<US date>" } ],
  "additionalContacts": [ { "firstName", "lastName", "title", "functionalRole", "email", "directPhone", "reason": "displaced" | "owner unreachable" } ],
  "entities": [ { "name", "ein", "state", "role": "operating | office | field staff | staffing arm | per-state entity | parent | subsidiary", "employees", "source", "date" } ],
  "fields": { "Website", "Street", "City", "State", "Zip_Code", "Company_Number", "Employee_Count", "Company_Size", "Employee_Growth", "Number_of_Locations", "Description", "Existing_Client", "Certified_Active_Company", "Certification_Date", "Current_PR_Provider_new", "Current_Payroll_Service", "Payroll_Frequency", "HCM", "HRM", "Benefits_Administration_Software", "Benefits_Carrier", "Healthcare_Providers", "Employee_Benefits_Broker", "K_Retirement_Plan", "WC_Carrier", "WC_Renewal_Date", "BN_Renewal_Date", "LinkedIn_Company_Profile_URL", "Facebook_Company_Profile_URL", "Email_Domain", "Entity_Name_Ultimate_Parent" },
  "notes": { "PAYROLL FINDINGS", "COMPANY STRUCTURE", "CONTACT", "COMPANY BACKGROUND", "TIMING", "COMPLIANCE", "ICEBREAKERS", "<any other plainly-titled note>" },
  "needsHuman": null | "<one sentence on what a person must decide>",
  "coverage": { "directPhone", "email", "provider", "headcount", "socialIcebreaker", "publicRecord", "leadershipPhones" }
}`;

const FIELD_RULES = `- "leadership" is REQUIRED and is where the phone-number effort goes: every owner, partner, founder and C-level person you could name, with every direct dial, mobile and email you could establish and where each came from. Include the primary too. Order: owners, then CEO/President, then CFO/COO/other chiefs. The dashboard writes this list to the record as its own note and fills the two additional-contact slots from it.
- "contact" is the primary — the top decision-maker per the rulebook. Keep the record's person if they are priority 1 or 2; otherwise the owner or CEO goes here with "replacesRecordContact": true and "contactChanged": true, and the record's person goes in "additionalContacts" with reason "displaced". A missing phone never demotes the owner.
- "fields" keys are real Zoho API names and are written straight through. Omit any key you have no value for — never send "" to hold a place. "Payroll_Frequency" is one of Bi-weekly, Monthly, Semi-Monthly, Weekly, Quarterly. "Benefits_Carrier" is one of Aetna, Anthem, BCBS, Cigna, United — any other carrier goes in "Healthcare_Providers". "Existing_Client" is Yes or No. "Certification_Date", "WC_Renewal_Date" and "BN_Renewal_Date" take ISO YYYY-MM-DD. "functionalRole" on any person is one of: CEO, Partner - Owner, President, CFO, Controller, Head of Finance, COO, Head of HR, HR Admin, HR Manager, Office Manager, Marketing, Payroll, Board Member, Sales Person, Unknown — keep the real title in "title".
- "Description" is MANDATORY: one plain sentence saying what the company is, then up to six bullets. Never return a profile without it.
- "Employee_Count" is the TOTAL across every entity in "entities", never one entity's figure.
- "coverage" is a plain true/false record of what you managed to find, for the dashboard's stats. It is not a rating.
- "needsHuman" is null unless something genuinely needs a person: an ambiguous name match, an unproven company identity, or a value you would be overriding without solid evidence.`;

function profilePrompt(lead, opts = {}) {
  const budget = 80;
  const wall = Number(opts.maxToolCalls) || config.maxToolCallsFull;
  return applyToolNames(`You are profiling ONE lead for a payroll sales team, headless, inside a dashboard. The complete rulebook is at the end of this message under RULEBOOK — follow it exactly. You never write to Zoho: a human reviews the JSON you return and the dashboard writes it. Read-only Zoho calls are fine.

LEAD — this is the complete relevant extract of the Zoho record, current as of this run. Do NOT call getRecord and do NOT re-read this lead from Zoho; start from what is below:
${leadBlock(lead)}

THE JOB: verify the contact and settle who the top decision-maker is; build the leadership roster with phone numbers; research the company through the four rounds; write the Description, the notes and the icebreakers. No scoring of any kind — no fit score, tier, temperature, confidence rating or deal value. Report facts, sources and dates and let the rep judge.

WORK EFFICIENTLY — these rules cut cost, never depth:
- Start with ONE ToolSearch call that loads every tool you will need at once: "select:WebSearch,WebFetch,mcp__claude_ai_ZoomInfo__enrich_contacts,mcp__claude_ai_ZoomInfo__search_contacts_v2,mcp__claude_ai_ZoomInfo__search_scoops,mcp__claude_ai_ZoomInfo__enrich_intent,mcp__claude_ai_Zoho_CRM__searchRecords". Never load tools one at a time. Do not read any file, run any command or list any directory — everything you need is in this message.
- Fire each research round as ONE message containing ALL of that round's tool calls in parallel. Never issue calls one at a time when they do not depend on each other's results.
- Write NO commentary between tool calls — no narration, no summaries of what came back. Every extra turn re-reads the whole conversation and is the main cost of this run. Hold everything for the final JSON.
- A met completion-bar item never earns another call. When the bar is met, return the JSON immediately.

BUDGET: ${budget} tool calls is the ceiling, not a target — most leads need a real fraction of it. The server hard-stops this session at ${wall} tool calls, at $${config.maxCostFull} of spend, and at ${config.perLeadTimeoutMin} minutes, and a stopped session returns NOTHING — so at call ${budget - 10}, or whenever the ladders you still have open are unlikely to change the record, stop researching and return the JSON you have. A complete JSON with a gap beats a killed session.

OUTPUT: your final answer is the JSON object below and nothing else (the structured output). Every note body is written exactly as it should appear in Zoho, per the rulebook's style rules. Omit any note that would be empty.
${PROFILE_SHAPE}

Field rules:
${FIELD_RULES}

RULEBOOK
${PROFILE_BRIEF}`);
}

function writePrompt(result, pepm, mode = 'full') {
  return `${SKILL_LINE}

${SKILL_FILES_BLOCK}
${mode === 'basic' ? `
THIS IS A BASIC PROFILE, not a full research profile: six facts and one "BASIC PROFILE" note. Write the fields it carries, the contact, the additional contacts and that one note, and set Profile_Type to "Basic". Do not expect or invent a PAYROLL FINDINGS note or icebreakers; the rules below about those notes do not apply here.
` : ''}
A human has reviewed and approved this profile. Execute Step 6 of the skill — the write-back — for this one lead, exactly per references/zoho-writeback.md. Do NOT re-research anything and do NOT ask any questions; the approval already happened.

PEPM in use: $${pepm}.

Approved profile JSON:
${JSON.stringify(result, null, 2)}

Apply the skill's write rules:
- Fields first, notes second. Fill every field in "fields" that has a value — provider, headcount, benefits stack, social URLs, address. A populated field beats a note nobody opens.
- The decision-maker replaces the primary contact ON THIS RECORD, in place. Do NOT create a second lead and do NOT write a cross-reference note. Anyone displaced who is still at the company goes into an additional-contact block, as does the reachable senior second when the decision-maker had no direct phone or email.
- The additional-contact API names are inverted relative to their labels. Block 1 is First_Name1 / Last_Name2 / Email2 / Phone2 / Title2 / Functional_Role2. Block 2 is First_Name2 / Last_Name1 / Email1 / Phone1 / Title1 / Functional_Role1. Getting this wrong splits one person across both blocks.
- NEVER write these fields: they were retired or do not exist here, and each one fails the record — Payroll_Fit_Score, Fit_Tier, Why_Now, Likely_Payroll_Provider, Provider_Confidence, Verified_Employees, Employee_Count_Source, Headcount_Trend_Pct, State_Count, Has_DOL_Case, DOL_Backwages, Estimated_ACV, Profiled_By_Bot, Profile_Confidence, Requires_Review, Disqualify_Reason, Contact_Seniority, Is_Decision_Maker, Better_Contact_Found, DNC_Flag, LinkedIn_URL, Buying_Intent_Topics, Lead_Provider, Annual_Revenue, No_of_Employees, Secondary_Email, Fax, Twitter, Country, Rating, Lead_Rating, Lead_Rate, Lead_Status, Lead_Stage.
- No scoring in any field or note. No fit score, tier, temperature or confidence rating.
- Plain English everywhere. Expand every code and abbreviation into words, and end every finding with what it means for payroll.
- Dates are US numeric — 8/19/2026. Source in round brackets and date in square brackets, both at the END of the line: "... (their careers page) [8/18/2026]". Never mid-sentence, never "19 August 2026" or "14Jul26". Never write "LI", "FB", "ATS", "5500", "SOS", "DOL WHD", "ZI", "NPI", "PEPM", "SUI", "priority 1" or a date like "14Jul26".
- The Description field is mandatory — one plain sentence saying what the company is, then up to six bullets. Do not complete a write without it.
- The employee count must be the TOTAL across every related legal entity, not the headquarters figure. If the profile lists several entities, sum them and write the breakdown in the "COMPANY STRUCTURE" note.
- Every point starts with a short summary headline in plain capitals, then an em dash, then the detail. Do not use asterisks, <b> tags or markdown — notes are plain text and markup shows literally. The headline is converted to bold characters automatically.
- Write "PAYROLL FINDINGS" first. Icebreakers are conversation openers only; anything that is really a research finding belongs in the findings note.
- Write the notes provided above, one note per non-empty key, titled with that key. Before writing each one, delete any line reporting an absence — "no match", "not found", "none", "N/A", "unknown", "no violations", "clean" — then drop any heading left with nothing under it. If a note ends up with nothing real in it, DO NOT WRITE THAT NOTE AT ALL. A COMPLIANCE note saying nothing was found is the exact failure this rule exists to stop.
- Do not carry "was: <old value>" into any note. The record should read as though it always held the right person.
- Stamp Profiled_Date on every record touched, including disqualified ones.
- Never delete data.

Output ONLY a fenced json block:
\`\`\`json
{"ok": true, "leadId": "${result.leadId}", "fieldsWritten": [], "notesWritten": [], "newLeadId": null, "overrides": [], "error": null}
\`\`\`
Each entry in "overrides" is {"field": "", "was": "", "now": ""}.`;
}

// The BASIC profile. Six facts, one lookup method each, no escalation ladders.
// It exists because the comprehensive pass is the right tool for a lead a rep is
// about to call and the wrong tool for sizing up two hundred leads at once — and,
// since this version, it is also the FALLBACK when a comprehensive session is
// stopped or fails, so a lead never comes back with nothing. The style section is
// the same text the comprehensive prompt carries, so the note reads the same.
function basicPrompt(lead, opts = {}) {
  const wall = Number(opts.maxToolCalls) || config.maxToolCallsBasic;
  const why = opts.fallbackReason ? `\nThis is a FALLBACK: the full research pass on this lead was stopped (${opts.fallbackReason}). Do the light pass properly and return it — this is what the rep will get.\n` : '';
  return applyToolNames(`You are doing a BASIC PROFILE of one company for a payroll sales team, headless, inside a dashboard. This is a light pass, not research: six facts, one lookup method each, then stop. You never write to Zoho; a human reviews the JSON first.
${why}
COMPANY — this is the Zoho lead record, current as of this run. Do NOT re-read it from Zoho:
${leadBlock(lead)}

THE SIX FACTS AND THE ONE WAY TO GET EACH:
1. WHAT THEY ARE — nursing home, home care agency, manufacturer, charter school, etc. Method: the company website home page (WebFetch). No website on record: ONE WebSearch for "${lead.company}" ${lead.state || ''} and use the first result that is clearly them.
2. OWNERSHIP AND THE LEADERSHIP ROSTER — who owns it (a single owner, partners, a family, a private-equity group, a public company, a nonprofit board) and every owner and C-level person you can name: CEO, President, CFO, COO, other chiefs. Method: ONE ZoomInfo contact search on the company (mcp__claude_ai_ZoomInfo__search_contacts_v2 with managementLevelList ["Owner", "C Level Exec"], up to 10 rows). If the website has an about or leadership page and you already fetched the site, read the names off that too, but do not go looking for more.
3. EMPLOYEE COUNT — Method: ONE ZoomInfo company enrichment (mcp__claude_ai_ZoomInfo__enrich_companies) for the headline count. Two special cases:
   - HOME CARE / HOME HEALTH / STAFFING: the ZoomInfo number is usually the office and the real workforce is in the field. Do ONE extra WebSearch: "${lead.company}" caregivers OR aides OR nurses OR employees — and if the company or a news item states a field-staff figure, report office and field separately.
   - NURSING HOME / ASSISTED LIVING / ANY MULTI-FACILITY GROUP: count the whole group. Do ONE extra WebSearch: "${lead.company}" facilities OR locations OR "skilled nursing" — and report the number of facilities and the group-wide headcount (sum the facilities if a per-facility figure is what you find, and say it is a sum).
4. HCM / HRIS / ATS — what system their job applications run on. Method: fetch the careers or jobs page (WebFetch the careers link from the home page, or {website}/careers) and read the host of the apply links. myworkdayjobs.com = Workday, greenhouse.io = Greenhouse, lever.co = Lever, icims.com = iCIMS, ultipro.com or ukg.com = UKG, paylocity.com = Paylocity, paycomonline.net = Paycom, paycor.com = Paycor, adp.com or workforcenow = ADP, bamboohr.com = BambooHR, applytojob.com = JazzHR, jobvite.com = Jobvite, smartrecruiters.com = SmartRecruiters, ashbyhq.com = Ashby, workable.com = Workable, isolvedhire or isolved = isolved, apploi.com = Apploi, hireology.com = Hireology, indeed-hosted or a plain email/web form = none. If there is no careers page, ONE WebSearch: site:indeed.com OR site:linkedin.com/jobs "${lead.company}" and read the apply destination of one posting. For a multi-facility group, check a second facility's posting if it is right there in the results; do not tour every facility.
5. HQ AND WHERE THE OWNERS SIT — the headquarters address (from the same ZoomInfo company enrichment as fact 3) and, if the owners or executives sit somewhere else (common with nursing home groups whose owners are in New York or New Jersey while the facilities are elsewhere), that city and state from the ZoomInfo contact rows in fact 2.
6. PHONE NUMBERS AND EMAIL FOR THE LEADERSHIP — direct phone, mobile and email for the owner/CEO and every other owner or C-level person from fact 2, up to ten people. Method: ONE mcp__claude_ai_ZoomInfo__enrich_contacts call for all of them in one batch, requesting firstName, lastName, jobTitle, email, phone, mobilePhone, directPhoneDoNotCall, mobilePhoneDoNotCall, externalUrls. Take what it returns; do not go hunting elsewhere. Phone numbers are the strongest part of this product: a roster with numbers is the point of this pass.

WORK EFFICIENTLY — the budget is the point of this mode:
- Start with ONE ToolSearch: "select:WebSearch,WebFetch,mcp__claude_ai_ZoomInfo__enrich_companies,mcp__claude_ai_ZoomInfo__search_contacts_v2,mcp__claude_ai_ZoomInfo__enrich_contacts". Never load tools one at a time. Do not read any file, run any command or list any directory.
- Round 1, all in ONE message: the website fetch, the ZoomInfo company enrichment, and the ZoomInfo contact search. Round 2, all in ONE message: the careers page fetch, the contact enrichment batch, and whichever single extra WebSearch fact 3 or fact 4 calls for. That is normally the whole job.
- HARD CEILING: TWELVE tool calls including the ToolSearch. The server kills the session at ${wall} calls or $${config.maxCostBasic}, and a killed session returns nothing. If a method comes up empty, record the gap and move on. There is no escalation ladder in this mode and no second method for anything.
- No commentary between tool calls. No narration. Hold everything for the final JSON.

OUTPUT: your final answer is the JSON object below and nothing else (the structured output):
{
  "leadId": "${lead.id}", "company": "${lead.company}",
  "basic": { "companyType": "", "ownership": "", "ceo": "", "employees": null, "employeesBasis": "stated | estimate | sum of facilities", "officeStaff": null, "fieldStaff": null, "facilities": null, "hcm": "", "hcmEvidence": "", "hq": "", "execLocation": "", "gaps": [] },
  "employees": null, "employeesBasis": "estimate", "contactChanged": false,
  "contact": { "firstName": "", "lastName": "", "title": "", "email": "", "emailVerified": false, "directPhone": "", "directPhoneVerified": false, "directPhoneDNC": false, "mobilePhone": "", "mobilePhoneVerified": false, "mobilePhoneDNC": false, "linkedin": "", "employmentVerifiedBy": "ZoomInfo, checked ${todayUS()}", "replacesRecordContact": false },
  "leadership": [ { "firstName": "", "lastName": "", "title": "", "functionalRole": "", "email": "", "directPhone": "", "directPhoneDNC": false, "mobilePhone": "", "mobilePhoneDNC": false, "linkedin": "", "source": "ZoomInfo", "date": "${todayUS()}" } ],
  "additionalContacts": [ { "firstName": "", "lastName": "", "title": "", "functionalRole": "", "email": "", "directPhone": "", "reason": "displaced | c-suite" } ],
  "fields": { "Website": "", "Street": "", "City": "", "State": "", "Zip_Code": "", "Employee_Count": null, "Number_of_Locations": "", "Description": "", "HCM": "", "LinkedIn_Company_Profile_URL": "", "Email_Domain": "", "Entity_Name_Ultimate_Parent": "" },
  "notes": { "BASIC PROFILE": "" },
  "needsHuman": null
}

Field rules:
- "basic" is the six facts in plain words for the dashboard table. "gaps" lists which of the six you could not establish, e.g. ["hcm", "execLocation"]. An empty string or null elsewhere means not found; never write "not found", "N/A" or "unknown" as a value. Omit any "fields" key you have no value for.
- "leadership" is REQUIRED: everyone from fact 2 with whatever fact 6 returned, owners first, then CEO/President, then the other chiefs. Include the primary too. The dashboard writes this list to the record as its own note and fills the two additional-contact slots from it.
- "contact" is the OWNER or CEO — the top person from fact 2. If the person already on the record IS an owner or C-suite person, keep them in "contact" (update their title, phone and email from ZoomInfo) and set "replacesRecordContact": false. If the record's person is not at that level, the owner/CEO goes in "contact" with "replacesRecordContact": true and "contactChanged": true, and the record's person goes in "additionalContacts" with reason "displaced".
- "functionalRole" on any person is one of: CEO, Partner - Owner, President, CFO, Controller, Head of Finance, COO, Head of HR, HR Admin, HR Manager, Office Manager, Marketing, Payroll, Board Member, Sales Person, Unknown. Keep the real title in "title".
- "employees" (top level and in "fields".Employee_Count) is the TOTAL workforce — office plus field for home care, the whole group for a facility operator. "Number_of_Locations" is the facility count as a string when there is one. "Entity_Name_Ultimate_Parent" is the group or parent company name when the lead is one facility of a group. "fields".Street/City/State/Zip_Code are the HQ from fact 5.
- "Description" is MANDATORY: ONE plain sentence saying what the company is, from fact 1 — "Sunrise Care Group operates eleven skilled nursing facilities in Pennsylvania and Ohio." Nothing else in it.
- "HCM" is the platform name from fact 4 (e.g. "Paylocity"). If the ATS is one of ADP, Paycom, Paylocity, Paycor, UKG, isolved, Paychex or Rippling, say so plainly in the note — those are bundled suites, so the recruiting system is almost certainly their payroll provider too.
- The "BASIC PROFILE" note is the six facts written for a rep, one bullet each, in the style below. Example line: "· OWNED BY TWO PARTNERS — Moshe Klein and David Roth own the group; Klein is the CEO. Both sit in Lakewood, New Jersey, while every facility is in Ohio. (ZoomInfo) [${todayUS()}]". Leave out any line for a fact you did not find; the note only carries what you established. Do not list the roster in the note — the dashboard writes it separately from "leadership".
- "needsHuman" is null unless the company identity is genuinely ambiguous (two companies with this name in this state, say) — then one short sentence.

STYLE — identical to the comprehensive profile:
${STYLE_SECTION}`);
}

// ---------------------------------------------------------------- job runner

// Preflight is server-wide (it is a property of the server's Claude account).
// Everything else — the browsed lead list, the active run — belongs to one user.
const state = {
  preflight: readJSON(path.join(DATA, 'preflight.json'), null),
  perUser: new Map(),   // userId -> { leads, activeSegment, run }
};
function userState(userId) {
  if (!state.perUser.has(userId)) state.perUser.set(userId, { leads: [], activeSegment: null, run: null });
  return state.perUser.get(userId);
}

function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

// After a restart (deploys, sleeps) nobody's Review should come up empty. The
// user's most recent run is rebuilt from history plus the result files on the
// volume, so anything profiled but not yet written is still there to approve.
function loadRunFromDisk(userId) {
  const rec = [...history.runs].reverse().find((r) => r.userId === userId);
  if (!rec) return null;
  const dir = path.join(RUNS, rec.id);
  return {
    id: rec.id, userId, startedAt: rec.startedAt, finishedAt: rec.finishedAt || rec.startedAt, pepm: rec.pepm,
    mode: rec.mode || 'full',
    restored: true,
    jobs: rec.jobs.map((j) => {
      const result = readJSON(path.join(dir, `${j.leadId}.json`), null);
      const lead = j.lead || { id: j.leadId, company: j.company, industry: j.result?.industry, state: j.result?.state };
      return {
        leadId: j.leadId, company: j.company, lead, mode: j.mode || rec.mode || 'full',
        fallback: j.fallback || (result && result.fallback) || null, attempts: j.attempts || [],
        status: j.status === 'running' || j.status === 'queued' ? 'failed' : j.status,
        progress: [], result, error: j.error || (j.status === 'running' || j.status === 'queued' ? 'The server restarted while this lead was in progress.' : null),
        cost: j.cost, toolCalls: j.toolCalls, startedAt: null, finishedAt: null,
        written: !!j.written, writeResult: j.writeResult || null,
      };
    }),
  };
}

async function pool(items, limit, worker) {
  const queue = items.map((item, i) => [i, item]);
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      const [i, item] = queue.shift();
      // One job blowing up must not take the other runners — or the run's
      // "finished" mark — down with it.
      try { await worker(item, i); } catch (err) { try { worker.onError?.(item, err); } catch {} }
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------- normalizing a profile
// Whatever model produced it, a result reaches the dashboard and the write path in
// one shape: strings trimmed, absences dropped, numbers as numbers, people as
// people, empty keys gone. The prompts ask for this; the server guarantees it.

const boolish = (v) => v === true || v === 'true' || v === 1;
const numish = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const strOrEmpty = (v) => { const s = cleanStr(v); return s && !isAbsence(s) ? s : ''; };

function cleanPerson(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {
    firstName: strOrEmpty(p.firstName), lastName: strOrEmpty(p.lastName), title: strOrEmpty(p.title),
    functionalRole: strOrEmpty(p.functionalRole), email: cleanEmail(p.email), emailVerified: boolish(p.emailVerified),
    directPhone: cleanPhone(p.directPhone || p.phone), directPhoneVerified: boolish(p.directPhoneVerified), directPhoneDNC: boolish(p.directPhoneDNC),
    mobilePhone: cleanPhone(p.mobilePhone || p.mobile), mobilePhoneVerified: boolish(p.mobilePhoneVerified), mobilePhoneDNC: boolish(p.mobilePhoneDNC),
    linkedin: strOrEmpty(p.linkedin), source: strOrEmpty(p.source || p.phoneSource), date: strOrEmpty(p.date), reason: strOrEmpty(p.reason),
  };
  if (p.priority != null) out.priority = numish(p.priority);
  if (p.employmentVerifiedBy != null) out.employmentVerifiedBy = strOrEmpty(p.employmentVerifiedBy);
  if (p.replacesRecordContact != null) out.replacesRecordContact = boolish(p.replacesRecordContact);
  if (p.reachable != null) out.reachable = boolish(p.reachable);
  return out;
}

function normalizeProfile(raw, lead, mode) {
  const j = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {
    leadId: String(lead.id),
    company: strOrEmpty(j.company) || lead.company,
    disqualified: strOrEmpty(j.disqualified) || null,
    contactChanged: boolish(j.contactChanged),
    contact: cleanPerson(j.contact) || cleanPerson({}),
    leadership: (Array.isArray(j.leadership) ? j.leadership : []).map(cleanPerson).filter((p) => p && p.lastName),
    additionalContacts: (Array.isArray(j.additionalContacts) ? j.additionalContacts : []).map(cleanPerson).filter((p) => p && p.lastName),
    entities: (Array.isArray(j.entities) ? j.entities : []).filter((e) => e && typeof e === 'object' && strOrEmpty(e.name)).map((e) => ({
      name: strOrEmpty(e.name), ein: strOrEmpty(e.ein), state: strOrEmpty(e.state), role: strOrEmpty(e.role),
      employees: numish(e.employees), source: strOrEmpty(e.source), date: strOrEmpty(e.date),
    })),
    fields: {}, notes: {},
    needsHuman: strOrEmpty(j.needsHuman) || null,
  };
  if (out.contact.replacesRecordContact) out.contactChanged = true;

  const NUMERIC_FIELDS = new Set(['Employee_Count', 'Company_Size', 'Employee_Growth']);
  for (const [k, v] of Object.entries(j.fields && typeof j.fields === 'object' ? j.fields : {})) {
    const key = String(k).trim();
    if (!key) continue;
    if (NUMERIC_FIELDS.has(key)) { const n = numish(v); if (n != null) out.fields[key] = n; continue; }
    if (typeof v === 'boolean') { out.fields[key] = v; continue; }
    if (typeof v === 'number') { if (Number.isFinite(v)) out.fields[key] = v; continue; }
    const s = strOrEmpty(v);
    if (s) out.fields[key] = s;
  }
  for (const [k, v] of Object.entries(j.notes && typeof j.notes === 'object' ? j.notes : {})) {
    const key = String(k).trim().toUpperCase();
    const body = typeof v === 'string' ? v.trim() : (v && typeof v === 'object' ? JSON.stringify(v) : '');
    if (key && body && !isAbsence(key)) out.notes[key] = body;
  }

  out.employees = numish(j.employees);
  if (out.employees == null && out.fields.Employee_Count != null) out.employees = out.fields.Employee_Count;
  if (out.employees != null && out.fields.Employee_Count == null) out.fields.Employee_Count = out.employees;
  out.employeesBasis = strOrEmpty(j.employeesBasis) || 'estimate';

  if (mode === 'basic') {
    const b = j.basic && typeof j.basic === 'object' ? j.basic : {};
    out.basic = {
      companyType: strOrEmpty(b.companyType), ownership: strOrEmpty(b.ownership), ceo: strOrEmpty(b.ceo),
      employees: numish(b.employees), employeesBasis: strOrEmpty(b.employeesBasis),
      officeStaff: numish(b.officeStaff), fieldStaff: numish(b.fieldStaff), facilities: numish(b.facilities),
      hcm: strOrEmpty(b.hcm), hcmEvidence: strOrEmpty(b.hcmEvidence), hq: strOrEmpty(b.hq), execLocation: strOrEmpty(b.execLocation),
      gaps: (Array.isArray(b.gaps) ? b.gaps : []).map(cleanStr).filter(Boolean),
    };
    if (out.employees == null) out.employees = out.basic.employees;
  } else {
    const cov = j.coverage && typeof j.coverage === 'object' ? j.coverage : {};
    out.coverage = {};
    for (const k of ['directPhone', 'email', 'provider', 'headcount', 'socialIcebreaker', 'publicRecord']) out.coverage[k] = boolish(cov[k]);
    // The dashboard's own facts beat the model's self-report where it can tell.
    if (out.contact.directPhone || out.contact.mobilePhone) out.coverage.directPhone = true;
    if (out.contact.email) out.coverage.email = true;
    if (out.fields.Current_PR_Provider_new) out.coverage.provider = true;
    if (out.employees != null) out.coverage.headcount = true;
  }
  const roster = leadershipRoster(out);
  out.leadershipPhones = roster.filter((p) => p.directPhone || p.mobilePhone).length;
  out.leadershipCount = roster.length;
  if (out.coverage) out.coverage.leadershipPhones = out.leadershipPhones >= 2;
  return out;
}

// ---------------------------------------------------------------- the profile ladder
// One lead, start to finish, whatever happens to the session:
//   1. the pass the run asked for (comprehensive or basic), with every hard stop on;
//   2. if a comprehensive pass was stopped or came back empty and fallback is on,
//      a basic pass — so the rep gets six facts and a roster instead of nothing;
//   3. failed, with the reason, and the run moves on.
// There is no path that runs a session more than twice, and no path that waits on
// a session past its timeout.
async function profileLead(job, run, user, dir) {
  const wantBasic = run.mode === 'basic';
  const onEvent = ({ kind, msg }) => {
    job.progress.push({ kind, msg, at: Date.now() });
    if (job.progress.length > 400) job.progress.shift();
    emit('progress', { leadId: job.leadId, kind, msg }, user.id);
  };
  const common = { label: job.company, cwd: dir, onEvent, group: run.id, disallowed: RESEARCH_DISALLOWED, cancelled: () => !!run.cancelled };
  const basicOpts = (attempt, fallbackReason) => [basicPrompt(job.lead, { fallbackReason }), {
    ...common, timeoutMin: Number(config.basicTimeoutMin) || 12, maxCost: Number(config.maxCostBasic) || 0.75,
    maxToolCalls: Number(config.maxToolCallsBasic) || 16, schema: BASIC_SCHEMA,
    logFile: path.join(dir, `${job.leadId}.${attempt}.log.jsonl`),
  }];
  const fullOpts = (attempt) => [profilePrompt(job.lead), {
    ...common, timeoutMin: Number(config.perLeadTimeoutMin) || 25, maxCost: Number(config.maxCostFull) || 6,
    maxToolCalls: Number(config.maxToolCallsFull) || 100, schema: PROFILE_SCHEMA,
    logFile: path.join(dir, `${job.leadId}.${attempt}.log.jsonl`),
  }];

  job.attempts = [];
  const record = (mode, res) => {
    job.attempts.push({ mode, ok: res.ok, stopped: res.stopped || null, error: res.error || null, cost: res.cost, costEstimated: !!res.costEstimated, tokens: res.usage || null, toolCalls: res.toolCalls, turns: res.turns });
    if (res.costEstimated) job.costEstimated = true;
    job.cost = (job.cost || 0) + (res.cost || 0);
    job.toolCalls = (job.toolCalls || 0) + (res.toolCalls || 0);
  };

  // A basic run fans out wide and skips the server-wide semaphore: those sessions
  // are a dozen tool calls each, and the semaphore exists to stop six deep
  // research sessions from starving one another, not to serialise a quick sweep.
  let res;
  if (run.cancelled) return { error: `Run stopped by ${run.cancelled} before this lead started.` };
  if (wantBasic) {
    res = await runClaudeNow(...basicOpts('basic'));
    record('basic', res);
    if (res.ok) return { result: normalizeProfile(res.json, job.lead, 'basic'), mode: 'basic' };
    return { error: res.error };
  }

  res = await runClaude(...fullOpts('full'));
  record('full', res);
  if (res.ok) return { result: normalizeProfile(res.json, job.lead, 'full'), mode: 'full' };
  if (run.cancelled) return { error: res.error };

  const reason = res.stopped === 'budget' ? `hit the $${config.maxCostFull} cost ceiling`
    : res.stopped ? res.stopped : (res.error || 'returned nothing usable');
  if (!config.fallbackToBasic) return { error: `Full profile failed — ${reason}.` };

  onEvent({ kind: 'note', msg: `Full profile ${reason}. Falling back to a basic profile so this lead still comes back with something.` });
  const res2 = await runClaudeNow(...basicOpts('fallback', reason));
  record('basic', res2);
  if (res2.ok) {
    const result = normalizeProfile(res2.json, job.lead, 'basic');
    result.fallback = { from: 'full', reason };
    return { result, mode: 'basic', fallback: result.fallback };
  }
  return { error: `Full profile ${reason}; the basic fallback then ${res2.stopped || res2.error || 'failed'} too.` };
}

async function startRun(user, leads, pepm, mode = 'full') {
  const basic = mode === 'basic';
  const id = newRunId();
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  const us = userState(user.id);

  const run = us.run = {
    id, userId: user.id, userName: user.name, startedAt: Date.now(), finishedAt: null, pepm, mode,
    cancelled: null,
    jobs: leads.map((l) => ({
      leadId: l.id, company: l.company, lead: l, mode,
      status: 'queued', progress: [], result: null, fallback: null, attempts: [],
      error: null, cost: null, toolCalls: 0,
      startedAt: null, finishedAt: null,
      written: false, writeResult: null,
    })),
  };
  // Written to history straight away so a restart mid-run still knows the run
  // existed and who it belonged to.
  persistRun(run);
  emit('run:start', { run: publicRun(run) }, user.id);

  const limit = basic ? Math.max(1, Number(config.basicConcurrency) || 20) : config.concurrency;
  const worker = async (job) => {
    if (run.cancelled) {
      job.status = 'failed'; job.error = `Run stopped by ${run.cancelled} before this lead started.`;
      emit('job', { job: publicJob(job) }, user.id);
      return;
    }
    job.status = 'running';
    job.startedAt = Date.now();
    emit('job', { job: publicJob(job) }, user.id);

    let outcome;
    try { outcome = await profileLead(job, run, user, dir); }
    catch (err) { outcome = { error: `Profiling crashed: ${err.message}` }; }

    job.finishedAt = Date.now();
    if (outcome.result) {
      job.result = outcome.result;
      job.mode = outcome.mode;
      job.fallback = outcome.fallback || null;
      job.status = 'done';
      try { fs.writeFileSync(path.join(dir, `${job.leadId}.json`), JSON.stringify(outcome.result, null, 2)); } catch {}
    } else {
      job.status = 'failed';
      job.error = outcome.error || 'Session finished but returned no parseable JSON. Check this lead’s log.';
    }
    persistRun(run);
    emit('job', { job: publicJob(job) }, user.id);
  };
  worker.onError = (job, err) => { job.status = 'failed'; job.error = `Profiling crashed: ${err.message}`; job.finishedAt = Date.now(); persistRun(run); emit('job', { job: publicJob(job) }, user.id); };

  pool(run.jobs, limit, worker).catch((err) => {
    emit('status', { msg: `Run stopped unexpectedly: ${err.message}` }, user.id);
  }).then(() => {
    run.finishedAt = Date.now();
    persistRun(run);
    emit('run:done', { run: publicRun(run) }, user.id);
  });

  return id;
}

// Stop a run: every live session in it is killed, queued leads are skipped, and
// whatever already finished stays in Review. This is the button that did not exist
// when a lead circled for hours.
function cancelRun(run, who) {
  if (!run || run.finishedAt) return 0;
  run.cancelled = who;
  const killed = stopGroup(run.id, `stopped by ${who}`);
  for (const j of run.jobs) {
    if (j.status === 'queued') { j.status = 'failed'; j.error = `Run stopped by ${who} before this lead started.`; }
  }
  persistRun(run);
  return killed;
}

function persistRun(run) {
  const idx = history.runs.findIndex((r) => r.id === run.id);
  const record = {
    id: run.id,
    userId: run.userId || null,
    userName: run.userName || null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    pepm: run.pepm,
    mode: run.mode || 'full',
    cancelled: run.cancelled || null,
    jobs: run.jobs.map((j) => ({
      leadId: j.leadId, company: j.company, status: j.status, mode: j.mode || run.mode || 'full',
      fallback: j.fallback || null, attempts: j.attempts || [],
      // The browsed row is kept so a restored run can re-render the picker
      // columns and re-run a lead without another Zoho read.
      lead: j.lead ? { id: j.lead.id, company: j.lead.company, city: j.lead.city, state: j.lead.state,
        industry: j.lead.industry, contact: j.lead.contact, title: j.lead.title, owner: j.lead.owner || null } : null,
      cost: j.cost, costEstimated: !!j.costEstimated, toolCalls: j.toolCalls,
      durationMs: j.finishedAt && j.startedAt ? j.finishedAt - j.startedAt : null,
      written: j.written, writeResult: j.writeResult || null, error: j.error,
      // No score, tier, confidence or estimated value is kept: the bot does not
      // rate leads any more, so there is nothing of that kind to persist. What is
      // kept instead is coverage — what the research actually managed to find —
      // which is a measure of the bot, not a verdict on the lead.
      result: j.result ? {
        employees: j.result.employees,
        disqualified: j.result.disqualified || null,
        contactChanged: !!j.result.contactChanged,
        additionalContacts: (j.result.additionalContacts || []).length,
        industry: j.lead?.industry || null, state: j.lead?.state || null,
        coverage: j.result.coverage || {},
        provider: (j.result.fields && j.result.fields.Current_PR_Provider_new) || null,
        leadershipCount: j.result.leadershipCount || 0, leadershipPhones: j.result.leadershipPhones || 0,
        fallback: j.result.fallback || null,
        company: j.company,
      } : null,
    })),
  };
  if (idx >= 0) history.runs[idx] = record; else history.runs.push(record);
  writeJSON(HISTORY_PATH, history);
}

const publicJob = (j) => ({
  leadId: j.leadId, company: j.company, status: j.status, mode: j.mode || 'full', costEstimated: !!j.costEstimated,
  fallback: j.fallback || null, attempts: j.attempts || [],
  progress: j.progress.slice(-40), result: j.result, error: j.error,
  cost: j.cost, toolCalls: j.toolCalls, startedAt: j.startedAt,
  finishedAt: j.finishedAt, written: j.written, writeResult: j.writeResult,
  lead: j.lead,
});
const publicRun = (run) => run && ({
  id: run.id, userId: run.userId, userName: run.userName, restored: !!run.restored, cancelled: run.cancelled || null,
  startedAt: run.startedAt, finishedAt: run.finishedAt,
  pepm: run.pepm, mode: run.mode || 'full', jobs: run.jobs.map(publicJob),
});

// ---------------------------------------------------------------- stats

// scope: { userId } limits to one person's runs; omitted = the whole company.
function computeStats(scope = {}) {
  const leads = [];
  const runs = history.runs.filter((r) => !scope.userId || r.userId === scope.userId);
  for (const run of runs) {
    for (const j of run.jobs) {
      if (j.result) leads.push({ ...j.result, run: run.id, mode: j.mode || run.mode || 'full', at: run.startedAt, cost: j.cost, durationMs: j.durationMs, written: j.written, userId: run.userId, userName: run.userName });
    }
  }
  // Who has been profiling what — the question a manager asks of a shared tool.
  const byPerson = {};
  for (const run of runs) {
    const k = run.userId || 'unknown';
    byPerson[k] = byPerson[k] || { userId: run.userId, name: run.userName || (users.find((u) => u.id === run.userId)?.name) || 'Unknown', runs: 0, leads: 0, written: 0, cost: 0, lastRun: 0 };
    byPerson[k].runs++;
    byPerson[k].lastRun = Math.max(byPerson[k].lastRun, run.startedAt || 0);
    for (const j of run.jobs) {
      if (j.result) byPerson[k].leads++;
      if (j.written) byPerson[k].written++;
      byPerson[k].cost += j.cost || 0;
    }
  }
  const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
  const rate = (n) => (leads.length ? n / leads.length : 0);

  // The two profile types cost an order of magnitude apart, so a blended average
  // would say nothing. Each gets its own line.
  const byMode = {};
  for (const m of ['full', 'basic']) {
    const ls = leads.filter((l) => l.mode === m);
    byMode[m] = { leads: ls.length, written: ls.filter((l) => l.written).length,
      avgCost: ls.length ? sum(ls.map((l) => l.cost)) / ls.length : 0, totalCost: sum(ls.map((l) => l.cost)),
      avgMinutes: ls.length ? sum(ls.map((l) => l.durationMs)) / ls.length / 60000 : 0 };
  }

  // Coverage replaces the old scoring rubric. The question these answer is "is the
  // research working", not "is this lead good" — the second question is the rep's,
  // and the numbers that tried to answer it are gone.
  const cov = (k) => leads.filter((l) => l.coverage && l.coverage[k]).length;
  const coverage = {
    directPhone:      { n: cov('directPhone'),      rate: rate(cov('directPhone')) },
    email:            { n: cov('email'),            rate: rate(cov('email')) },
    provider:         { n: cov('provider'),         rate: rate(cov('provider')) },
    headcount:        { n: cov('headcount'),        rate: rate(cov('headcount')) },
    socialIcebreaker: { n: cov('socialIcebreaker'), rate: rate(cov('socialIcebreaker')) },
    publicRecord:     { n: cov('publicRecord'),     rate: rate(cov('publicRecord')) },
  };

  const byVertical = {};
  for (const l of leads) {
    const k = l.industry || 'Unknown';
    byVertical[k] = byVertical[k] || { n: 0, withPhone: 0, withProvider: 0, withSocial: 0 };
    byVertical[k].n++;
    if (l.coverage?.directPhone) byVertical[k].withPhone++;
    if (l.coverage?.provider) byVertical[k].withProvider++;
    if (l.coverage?.socialIcebreaker) byVertical[k].withSocial++;
  }

  const providerCounts = {};
  for (const l of leads) {
    if (!l.provider) continue;
    // "ADP Workforce Now (named in Jul26 job posting)" tallies as ADP Workforce Now.
    const name = String(l.provider).split('(')[0].trim();
    if (name) providerCounts[name] = (providerCounts[name] || 0) + 1;
  }

  return {
    scope: scope.userId ? 'mine' : 'all',
    totalRuns: runs.length,
    totalLeads: leads.length,
    byPerson: Object.values(byPerson).sort((a, b) => b.leads - a.leads),
    byMode,
    coverage,
    providerCounts,
    writtenCount: leads.filter((l) => l.written).length,
    fallbacks: leads.filter((l) => l.fallback).length,
    leadershipPhones: sum(leads.map((l) => l.leadershipPhones)),
    avgLeadershipPhones: leads.length ? sum(leads.map((l) => l.leadershipPhones)) / leads.length : 0,
    contactChanged: leads.filter((l) => l.contactChanged).length,
    secondContactAdded: leads.filter((l) => (l.additionalContacts || 0) > 0).length,
    disqualified: leads.filter((l) => l.disqualified).length,
    avgCost: leads.length ? sum(leads.map((l) => l.cost)) / leads.length : 0,
    totalCost: sum(leads.map((l) => l.cost)),
    avgMinutes: leads.length ? sum(leads.map((l) => l.durationMs)) / leads.length / 60000 : 0,
    byVertical,
    recentRuns: runs.slice(-12).reverse().map((r) => ({
      id: r.id, at: r.startedAt, n: r.jobs.length, userName: r.userName || null, mode: r.mode || 'full',
      done: r.jobs.filter((j) => j.status === 'done' || j.status === 'written').length,
      failed: r.jobs.filter((j) => j.status === 'failed').length,
      fallbacks: r.jobs.filter((j) => j.fallback).length,
      written: r.jobs.filter((j) => j.written).length,
      cost: r.jobs.reduce((n, j) => n + (j.cost || 0), 0),
    })),
  };
}

// ---------------------------------------------------------------- http

const send = (res, code, body, type = 'application/json') => {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

// -- auth helpers ---------------------------------------------------------------

const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.socket.encrypted;
const setSessionCookie = (req, res, token, clear = false) => {
  const parts = [`lb_session=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
};
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

const loginPage = () => fs.readFileSync(path.join(HERE, 'login.html'), 'utf8');

// What the browser may read or filter by, given who is asking. An admin, or a
// user explicitly marked "see all", browses the whole org; everyone else is
// pinned to their mapped Zoho owner and sees nothing until an admin maps one.
const leadScope = (user) => {
  if (user.role === 'admin' || user.seeAll) return { lockOwner: null, mapped: true };
  return { lockOwner: user.zohoOwnerId || null, mapped: !!user.zohoOwnerId };
};

// Zoho's user list is the source of truth for the owner mapping. Cached like
// the other metadata so the Team screen does not hammer the API.
let zohoUsersCache = { at: 0, value: null };
async function zohoUsers() {
  if (zohoUsersCache.value && Date.now() - zohoUsersCache.at < 10 * 60_000) return zohoUsersCache.value;
  if (!zohoConfigured()) return [];
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await zohoApi(`/crm/v8/users?type=AllUsers&page=${page}&per_page=200`);
    if (r.status === 204 || !r.json || !Array.isArray(r.json.users)) break;
    for (const u of r.json.users) out.push({ id: String(u.id), name: u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' '), email: normEmail(u.email), status: u.status || '' });
    if (!(r.json.info && r.json.info.more_records)) break;
  }
  zohoUsersCache = { at: Date.now(), value: out };
  return out;
}

// -- http ------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // Anything below is fine to reach signed out.
    if (p === '/healthz') return send(res, 200, { ok: true, users: users.length, liveSessions, liveProcesses: liveChildren.size });

    if (p === '/login' && req.method === 'GET') {
      return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    }

    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = normEmail(body.email);
      const key = `${email}|${clientIp(req)}`;
      if (loginBlocked(key)) return send(res, 429, { error: 'Too many attempts. Wait fifteen minutes and try again.' });
      const u = findUser(email);
      if (!u || !checkPassword(u, body.password || '')) { loginFailed(key); return send(res, 401, { error: 'That email and password do not match.' }); }
      if (u.enabled === false) return send(res, 403, { error: 'This account has been disabled. Ask your admin.' });
      u.lastLogin = Date.now(); saveUsers();
      setSessionCookie(req, res, newSession(u.id));
      return send(res, 200, { ok: true, user: publicUser(u) });
    }

    if (!users.length) {
      // Fresh install with no admin configured — say so rather than 401 forever.
      return send(res, 503, '<h2 style="font-family:sans-serif">Lead Bot has no accounts yet.</h2><p style="font-family:sans-serif">Set <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code> in the server environment and restart.</p>', 'text/html; charset=utf-8');
    }

    const user = sessionUser(parseCookies(req).lb_session);
    if (!user) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Sign in first.' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
    const admin = user.role === 'admin';
    const forbidden = () => send(res, 403, { error: 'Admins only.' });
    const us = userState(user.id);
    // Restore the last run from the volume the first time this person shows up
    // after a restart, so their Review is where they left it.
    if (!us.run && !us.restoredOnce) { us.restoredOnce = true; us.run = loadRunFromDisk(user.id); }

    if (p === '/api/logout' && req.method === 'POST') {
      const tok = parseCookies(req).lb_session;
      if (tok) { delete sessions[tok]; saveSessions(); }
      setSessionCookie(req, res, '', true);
      return send(res, 200, { ok: true });
    }

    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'ui.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (p === '/login') { res.writeHead(302, { Location: '/' }); return res.end(); }

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.set(res, user.id);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (p === '/api/me') return send(res, 200, { user: publicUser(user), scope: leadScope(user) });

    if (p === '/api/me/password' && req.method === 'POST') {
      const body = await readBody(req);
      if (!checkPassword(user, body.current || '')) return send(res, 400, { error: 'Your current password is wrong.' });
      if (!body.password || String(body.password).length < 8) return send(res, 400, { error: 'New password must be at least 8 characters.' });
      Object.assign(user, hashPassword(body.password)); saveUsers();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/state') {
      // Non-admins get the config fields the Run screen needs and nothing that
      // could reveal or change how the server is wired.
      const cfg = admin ? config : { pepm: config.pepm, concurrency: config.concurrency, basicConcurrency: config.basicConcurrency, maxSessions: config.maxSessions };
      return send(res, 200, {
        user: publicUser(user), scope: leadScope(user), admin,
        config: cfg, segments, preflight: state.preflight,
        leads: us.leads, activeSegment: us.activeSegment,
        run: publicRun(us.run), stats: computeStats({ userId: user.id }),
        liveSessions,
      });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      if (!admin) {
        // A rep may set their own PEPM box; that is the one shared setting they touch.
        if (body.pepm) { config.pepm = Number(body.pepm) || config.pepm; writeJSON(CONFIG_PATH, config); }
        return send(res, 200, { config: { pepm: config.pepm, concurrency: config.concurrency, basicConcurrency: config.basicConcurrency, maxSessions: config.maxSessions } });
      }
      const allowed = ['pepm', 'concurrency', 'basicConcurrency', 'basicTimeoutMin', 'maxSessions', 'claudeCmd', 'model',
        'fallbackModel', 'utilityModel', 'perLeadTimeoutMin', 'maxCostFull', 'maxCostBasic', 'maxToolCallsFull', 'maxToolCallsBasic',
        'idleKillMin', 'fallbackToBasic'];
      for (const k of allowed) if (body[k] !== undefined) config[k] = body[k];
      config.concurrency = Math.max(1, Math.min(8, Number(config.concurrency) || 3));
      config.basicConcurrency = Math.max(1, Math.min(40, Number(config.basicConcurrency) || 20));
      config.basicTimeoutMin = Math.max(3, Math.min(30, Number(config.basicTimeoutMin) || 12));
      config.maxSessions = Math.max(1, Math.min(24, Number(config.maxSessions) || 6));
      config.perLeadTimeoutMin = Math.max(5, Math.min(60, Number(config.perLeadTimeoutMin) || 25));
      config.maxCostFull = Math.max(0.5, Math.min(50, Number(config.maxCostFull) || 6));
      config.maxCostBasic = Math.max(0.1, Math.min(5, Number(config.maxCostBasic) || 0.75));
      config.maxToolCallsFull = Math.max(20, Math.min(300, Number(config.maxToolCallsFull) || 100));
      config.maxToolCallsBasic = Math.max(6, Math.min(40, Number(config.maxToolCallsBasic) || 16));
      config.idleKillMin = Math.max(2, Math.min(20, Number(config.idleKillMin) || 6));
      config.fallbackToBasic = config.fallbackToBasic !== false && config.fallbackToBasic !== 'false';
      for (const k of ['model', 'fallbackModel', 'utilityModel', 'claudeCmd']) config[k] = String(config[k] || '').trim();
      if (!config.claudeCmd) config.claudeCmd = 'claude';
      writeJSON(CONFIG_PATH, config);
      // Let anyone queued behind an old cap through if it just went up.
      while (sessionWaiters.length && liveSessions < config.maxSessions) { liveSessions++; sessionWaiters.shift()(); }
      return send(res, 200, { config });
    }

    if (p === '/api/segments' && req.method === 'POST') {
      if (!admin) return forbidden();
      const body = await readBody(req);
      segments = body.segments || segments;
      writeJSON(SEGMENTS_PATH, segments);
      return send(res, 200, { segments });
    }

    // -- team (admin) --
    if (p === '/api/users' && req.method === 'GET') {
      if (!admin) return forbidden();
      let zusers = [];
      try { zusers = await zohoUsers(); } catch {}
      return send(res, 200, { users: users.map(publicUser), zohoUsers: zusers });
    }
    if (p === '/api/users' && req.method === 'POST') {
      if (!admin) return forbidden();
      const body = await readBody(req);
      try {
        let ownerId = body.zohoOwnerId || null, ownerName = body.zohoOwnerName || null;
        // Default the Zoho mapping by matching the email against the CRM's users.
        if (!ownerId) {
          try {
            const m = (await zohoUsers()).find((z) => z.email === normEmail(body.email));
            if (m) { ownerId = m.id; ownerName = m.name; }
          } catch {}
        }
        const u = createUser({ ...body, zohoOwnerId: ownerId, zohoOwnerName: ownerName });
        return send(res, 200, { user: publicUser(u), users: users.map(publicUser) });
      } catch (err) { return send(res, 400, { error: err.message }); }
    }
    if (p.startsWith('/api/users/') && req.method === 'POST') {
      if (!admin) return forbidden();
      const id = p.slice('/api/users/'.length);
      const target = users.find((u) => u.id === id);
      if (!target) return send(res, 404, { error: 'No such user.' });
      const body = await readBody(req);
      if (body.name !== undefined) target.name = String(body.name).trim() || target.name;
      if (body.role !== undefined) {
        if (target.id === user.id && body.role !== 'admin') return send(res, 400, { error: 'You cannot remove your own admin role.' });
        target.role = body.role === 'admin' ? 'admin' : 'user';
      }
      if (body.enabled !== undefined) {
        if (target.id === user.id && !body.enabled) return send(res, 400, { error: 'You cannot disable your own account.' });
        target.enabled = !!body.enabled;
        if (!target.enabled) { for (const [t, s] of Object.entries(sessions)) if (s.userId === target.id) delete sessions[t]; saveSessions(); }
      }
      if (body.seeAll !== undefined) target.seeAll = !!body.seeAll;
      if (body.zohoOwnerId !== undefined) { target.zohoOwnerId = body.zohoOwnerId || null; target.zohoOwnerName = body.zohoOwnerName || null; }
      if (body.password) {
        if (String(body.password).length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
        Object.assign(target, hashPassword(body.password));
      }
      if (body.delete === true) {
        if (target.id === user.id) return send(res, 400, { error: 'You cannot delete your own account.' });
        users = users.filter((u) => u.id !== id);
        for (const [t, s] of Object.entries(sessions)) if (s.userId === id) delete sessions[t];
        saveSessions();
      }
      saveUsers();
      return send(res, 200, { users: users.map(publicUser) });
    }

    // -- zoho --
    if (p === '/api/zoho/status') {
      const s = await zohoStatus();
      if (!admin) return send(res, 200, { configured: s.configured, ok: s.ok, org: s.org, error: s.error, dc: s.dc });
      return send(res, 200, { ...s, fromEnv: !!(envZoho.clientId && envZoho.refreshToken) });
    }

    if (p === '/api/zoho/config' && req.method === 'POST') {
      if (!admin) return forbidden();
      const body = await readBody(req);
      const dc = ZOHO_DCS.includes(body.dc) ? body.dc : 'com';
      zoho = {
        ...zoho,
        dc,
        clientId: (body.clientId ?? zoho.clientId).trim(),
        clientSecret: (body.clientSecret || '').trim() || zoho.clientSecret,
        refreshToken: (body.refreshToken || '').trim() || zoho.refreshToken,
      };
      writeJSON(ZOHO_PATH, zoho);
      tokenCache = { token: null, expiresAt: 0 };
      metaCache = { at: 0, value: null };
      zohoUsersCache = { at: 0, value: null };
      return send(res, 200, await zohoStatus());
    }

    if (p === '/api/zoho/write-check') {
      if (!admin) return forbidden();
      return send(res, 200, await zohoWriteCheck());
    }

    if (p === '/api/zoho/meta') {
      if (!zohoConfigured()) return send(res, 200, { states: [], industries: [], owners: [], leadStatuses: [], error: 'Zoho is not configured.' });
      try {
        const m = await zohoMeta();
        const sc = leadScope(user);
        // A pinned user's owner dropdown is just themselves.
        if (sc.lockOwner) m.owners = (m.owners || []).filter((o) => String(o.id) === String(sc.lockOwner));
        return send(res, 200, m);
      }
      catch (err) { return send(res, 200, { states: [], industries: [], owners: [], leadStatuses: [], error: err.message }); }
    }

    if (p === '/api/zoho/leads') {
      const empty = (error, extra = {}) => send(res, 200, { error, leads: [], page: 1, per: 50, hasMore: false, total: null, coql: null, ...extra });
      if (!zohoConfigured()) return empty('Zoho is not configured.');
      const sc = leadScope(user);
      if (!sc.mapped) return empty('Your account is not linked to a Zoho user yet, so there are no leads to show. Ask your admin to map you under Team.', { unmapped: true });
      const g = (k) => url.searchParams.get(k) || '';
      const built = buildLeadsCOQL({
        where: g('where'), q: g('q'), state: g('state'), industry: g('industry'),
        owner: sc.lockOwner ? '' : g('owner'), status: g('status'), profiled: g('profiled'),
        sort: g('sort'), order: g('order'), page: g('page'), per: g('per'),
        lockOwner: sc.lockOwner,
      });
      try {
        const r = await zohoCoql(built.coql);
        if (r.status === 204) {
          return send(res, 200, { leads: [], page: built.page, per: built.per, hasMore: false, total: 0, coql: built.coql, error: null });
        }
        if (r.status >= 400) {
          return send(res, 200, { error: zohoErrText(r), leads: [], page: built.page, per: built.per, hasMore: false, total: null, coql: built.coql });
        }
        const rows = (r.json && r.json.data) || [];
        const info = (r.json && r.json.info) || {};
        const leads = rows.map(mapLeadRow);
        us.leads = leads;
        return send(res, 200, {
          leads, page: built.page, per: built.per,
          hasMore: !!info.more_records,
          total: typeof info.count === 'number' ? info.count : null,
          coql: built.coql, error: null,
        });
      } catch (err) {
        return send(res, 200, { error: err.message, leads: [], page: built.page, per: built.per, hasMore: false, total: null, coql: built.coql });
      }
    }

    // -- claude side --
    if (p === '/api/connection') {
      if (!admin) return forbidden();
      const sh = (cmd) => new Promise((r) => {
        const c = spawn(cmd, { shell: true, cwd: RUNS });
        let o = '';
        c.stdout.on('data', (d) => (o += d));
        c.stderr.on('data', (d) => (o += d));
        c.on('error', (e) => r({ ok: false, out: e.message }));
        c.on('close', (code) => r({ ok: code === 0, out: o.trim().slice(0, 4000) }));
        setTimeout(() => { try { c.kill(); } catch {} }, 20000);
      });
      const cli = await sh(`${config.claudeCmd} --version`);
      const mcp = cli.ok ? await sh(`${config.claudeCmd} mcp list`) : { ok: false, out: '' };
      return send(res, 200, { cli, mcp, tokenSet: !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY, liveSessions, maxSessions: config.maxSessions });
    }

    if (p === '/api/preflight' && req.method === 'POST') {
      if (!admin) return forbidden();
      emit('status', { msg: 'Running preflight…' }, user.id);
      const r = await runClaude(PREFLIGHT_PROMPT, {
        label: 'preflight', timeoutMin: 5, model: config.utilityModel || undefined, maxCost: 0.5, maxToolCalls: 6,
        schema: PREFLIGHT_SCHEMA, disallowed: RESEARCH_DISALLOWED,
        logFile: path.join(RUNS, 'preflight.log.jsonl'),
        onEvent: ({ msg }) => emit('status', { msg }, user.id),
      });
      const prev = (state.preflight && state.preflight.toolPrefixes) || null;
      state.preflight = r.json || { error: r.error || 'Preflight returned nothing parseable.', raw: (r.text || '').slice(0, 800) };
      // Only a prefix that looks like one is trusted; anything else keeps the last
      // known good value (or the desktop default).
      const tp = state.preflight.toolPrefixes && typeof state.preflight.toolPrefixes === 'object' ? state.preflight.toolPrefixes : {};
      const okPrefix = (s) => typeof s === 'string' && /^mcp__[A-Za-z0-9_]+__$/.test(s);
      state.preflight.toolPrefixes = {
        zoominfo: okPrefix(tp.zoominfo) ? tp.zoominfo : (prev && prev.zoominfo) || null,
        zoho: okPrefix(tp.zoho) ? tp.zoho : (prev && prev.zoho) || null,
      };
      state.preflight.at = Date.now();
      writeJSON(path.join(DATA, 'preflight.json'), state.preflight);
      emit('preflight', { preflight: state.preflight });
      return send(res, 200, { preflight: state.preflight });
    }

    if (p === '/api/fetch-leads' && req.method === 'POST') {
      const body = await readBody(req);
      const sc = leadScope(user);
      if (!sc.mapped) return send(res, 200, { error: 'Your account is not linked to a Zoho user yet. Ask your admin.', leads: [] });
      const seg0 = segments.find((s) => s.id === body.segmentId) ||
        { id: 'adhoc', name: 'Ad hoc', where: body.where, limit: body.limit || 25 };
      const seg = sc.lockOwner ? { ...seg0, where: `(${seg0.where} and Owner = '${qEsc(sc.lockOwner)}')` } : seg0;
      emit('status', { msg: `Fetching leads — ${seg.name}…` }, user.id);
      const r = await runClaude(fetchPrompt(seg), {
        label: 'fetch', timeoutMin: 6, model: config.utilityModel || undefined, maxCost: 1,
        logFile: path.join(RUNS, 'fetch.log.jsonl'),
        onEvent: ({ kind, msg }) => emit('status', { msg: kind === 'tool' ? msg : msg.slice(0, 120) }, user.id),
      });
      if (!r.json || r.json.error) {
        return send(res, 200, { error: r.json?.error || r.error || 'No rows returned. Check this segment’s query.', leads: [] });
      }
      us.leads = (r.json.leads || []).map((l) => ({ ...l, company: l.company || '(no name)' }));
      us.activeSegment = seg.id;
      emit('leads', { leads: us.leads, segmentId: seg.id }, user.id);
      return send(res, 200, { leads: us.leads });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const chosen = Array.isArray(body.leads) && body.leads.length
        ? body.leads.filter((l) => l && l.id).map((l) => ({ ...l, company: l.company || '(no name)' }))
        : us.leads.filter((l) => (body.leadIds || []).includes(l.id));
      if (!chosen.length) return send(res, 400, { error: 'No leads selected.' });
      if (us.run && !us.run.finishedAt) return send(res, 409, { error: 'You already have a run going. Wait for it to finish.' });
      const sc = leadScope(user);
      if (!sc.mapped) return send(res, 403, { error: 'Your account is not linked to a Zoho user yet.' });
      // The rows come from the browser, so the ownership pin is re-checked here
      // against what the browser actually sent, not trusted.
      if (sc.lockOwner && chosen.some((l) => !l.owner || String(l.owner.id) !== String(sc.lockOwner))) {
        return send(res, 403, { error: 'One or more of those leads is not owned by you in Zoho.' });
      }
      const mode = body.mode === 'basic' ? 'basic' : 'full';
      if (mode === 'full' && chosen.length > 50) return send(res, 400, { error: 'Fifty leads per comprehensive run at most. Use Basic profile for a larger sweep.' });
      if (mode === 'basic' && chosen.length > 300) return send(res, 400, { error: 'Three hundred leads per basic run at most.' });
      // A lead profiled in the last week costs a full lead's worth of credits to do
      // again. Say so once and let the person insist.
      if (!body.force) {
        const week = 7 * 24 * 3600 * 1000;
        const recent = chosen.filter((l) => l.profiledDate && Date.now() - new Date(l.profiledDate).getTime() < week);
        if (recent.length) return send(res, 409, { error: 'recent', recent: recent.map((l) => ({ id: l.id, company: l.company, profiledDate: l.profiledDate, profileType: l.profileType || null })) });
      }
      const pepm = body.pepm || config.pepm;
      if (pepm !== config.pepm) { config.pepm = pepm; writeJSON(CONFIG_PATH, config); }
      const id = await startRun(user, chosen, pepm, mode);
      return send(res, 200, { runId: id });
    }

    if (p === '/api/run/cancel' && req.method === 'POST') {
      const run = us.run;
      if (!run || run.finishedAt) return send(res, 400, { error: 'No run is going.' });
      const killed = cancelRun(run, user.name);
      emit('status', { msg: `Run stopped — ${killed} live session${killed === 1 ? '' : 's'} killed.` }, user.id);
      emit('run:start', { run: publicRun(run) }, user.id);
      return send(res, 200, { ok: true, killed });
    }

    if (p === '/api/write' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = body.leadIds || [];
      const run = us.run;
      const jobs = (run?.jobs || []).filter((j) => ids.includes(j.leadId) && j.result && !j.written);
      if (!jobs.length) return send(res, 400, { error: 'Nothing approved to write.' });
      send(res, 200, { queued: jobs.length });

      const direct = zohoConfigured();
      const writeLimit = direct ? (run.mode === 'basic' ? 6 : config.concurrency) : Math.min(2, config.concurrency);
      pool(jobs, writeLimit, async (job) => {
        job.status = 'writing';
        emit('job', { job: publicJob(job) }, user.id);
        if (direct) {
          emit('progress', { leadId: job.leadId, kind: 'note', msg: 'Writing to Zoho directly…' }, user.id);
          try {
            job.writeResult = await writeLeadDirect(job.result, job.mode || run.mode || 'full');
          } catch (err) {
            job.writeResult = { ok: false, partial: false, leadId: job.leadId, fieldsWritten: [], notesWritten: [], newLeadId: null, skipped: [], error: err.message };
          }
          emit('progress', {
            leadId: job.leadId, kind: 'note',
            msg: job.writeResult.ok
              ? `Wrote ${job.writeResult.fieldsWritten.length} fields and ${job.writeResult.notesWritten.length} notes.`
              : job.writeResult.error || 'Write failed.',
          }, user.id);
        } else {
          const r = await runClaude(writePrompt(job.result, run.pepm, job.mode || run.mode || 'full'), {
            label: `write ${job.company}`, timeoutMin: 10,
            cwd: path.join(RUNS, run.id),
            logFile: path.join(RUNS, run.id, `${job.leadId}.write.jsonl`),
            onEvent: ({ kind, msg }) => emit('progress', { leadId: job.leadId, kind, msg }, user.id),
          });
          job.writeResult = r.json || { ok: false, error: r.error || 'Write session returned nothing parseable.' };
        }
        job.written = !!job.writeResult.ok;
        job.writtenBy = user.name;
        job.status = job.written ? 'written' : 'done';
        persistRun(run);
        emit('job', { job: publicJob(job) }, user.id);
      }).catch((err) => {
        emit('status', { msg: `Write-back stopped unexpectedly: ${err.message}` }, user.id);
      });
      return;
    }

    if (p === '/api/stats') {
      const all = url.searchParams.get('scope') === 'all';
      if (all && !admin) return forbidden();
      return send(res, 200, computeStats(all ? {} : { userId: user.id }));
    }

    if (p === '/api/run-log') {
      const run = history.runs.find((r) => r.id === url.searchParams.get('id'));
      if (!run) return send(res, 404, { error: 'not found' });
      if (!admin && run.userId !== user.id) return forbidden();
      return send(res, 200, run);
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

const PORT = Number(process.env.PORT) || config.port;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Lead Bot Cloud is listening on ${PORT}.\n  Storage: ${STORAGE}\n  Accounts: ${users.length}\n`);
  if (!PROFILE_BRIEF || !STYLE_SECTION) {
    console.warn(`  WARNING: ${skillPath('HEADLESS.md')} is missing or has lost its style section.\n  Profile prompts embed that file; sessions will run without the rulebook until it is restored.\n`);
  }
  console.log(`  Model: ${config.model || '(CLI default)'} · caps: $${config.maxCostFull}/full, $${config.maxCostBasic}/basic, ${config.maxToolCallsFull}/${config.maxToolCallsBasic} tool calls, ${config.perLeadTimeoutMin}/${config.basicTimeoutMin} min, idle ${config.idleKillMin} min · fallback to basic: ${config.fallbackToBasic ? 'on' : 'off'}\n`);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn('  WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set. Profiling sessions will not be able to sign in.\n');
  }
});
