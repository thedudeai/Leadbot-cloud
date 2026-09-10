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
  model: '',                    // '' = whatever the CLI defaults to
  permissionMode: 'bypassPermissions',
  perLeadTimeoutMin: 25,
  port: 8765,
};

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
    const r = await fetch(apiHost() + pathAndQuery, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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

// Findings first, icebreakers last. Any note the profile added beyond these keys is
// written after the known ones, in the order it was given.
const NOTE_ORDER = ['PAYROLL FINDINGS', 'COMPANY STRUCTURE', 'CONTACT', 'COMPANY BACKGROUND',
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
  const extras = Array.isArray(result.additionalContacts) ? result.additionalContacts.slice(0, 2) : [];
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
 * survive Windows shell quoting. Returns { ok, json, text, events, cost, turns }.
 */
async function runClaude(prompt, opts = {}) {
  const waitedFrom = Date.now();
  await acquireSession();
  if (Date.now() - waitedFrom > 2000) opts.onEvent?.({ kind: 'note', msg: `Waited ${Math.round((Date.now() - waitedFrom) / 1000)}s for a free Claude slot.` });
  try { return await runClaudeNow(prompt, opts); }
  finally { releaseSession(); }
}

function runClaudeNow(prompt, { label, timeoutMin, logFile, onEvent, cwd } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', config.permissionMode];
    if (config.model) args.push('--model', config.model);

    // Sessions run inside the run's own empty folder, never the app folder, so
    // there is nothing in the working directory for a curious session to read.
    const child = spawn(config.claudeCmd, args, {
      shell: true,
      cwd: cwd || RUNS,
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' },
    });

    let buf = '';
    let finalText = '';
    let cost = null, turns = 0, toolCalls = 0;
    const events = [];
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    let done = false;

    const note = (msg, kind = 'note') => {
      events.push({ kind, msg, at: Date.now() });
      onEvent?.({ kind, msg });
      log?.write(`[${new Date().toISOString()}] ${kind}: ${msg}\n`);
    };

    const timer = setTimeout(() => {
      if (done) return;
      note('timed out — killing session');
      try { child.kill(); } catch {}
    }, (timeoutMin || config.perLeadTimeoutMin) * 60_000);

    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
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
          for (const c of ev.message.content) {
            if (c.type === 'tool_use') {
              toolCalls++;
              note(`${c.name}${c.input?.query ? ` — ${String(c.input.query).slice(0, 90)}` : ''}`, 'tool');
            } else if (c.type === 'text' && c.text.trim()) {
              note(c.text.trim().slice(0, 300), 'say');
            }
          }
          turns++;
        } else if (ev.type === 'result') {
          finalText = ev.result || finalText;
          cost = ev.total_cost_usd ?? cost;
        }
      }
    });

    child.stderr.on('data', (c) => log?.write('STDERR ' + c.toString()));

    child.on('error', (err) => {
      if (done) return; done = true; clearTimeout(timer); log?.end();
      resolve({ ok: false, error: `Could not start "${config.claudeCmd}": ${err.message}`, events, toolCalls });
    });

    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer); log?.end();
      const json = extractJSON(finalText);
      resolve({
        ok: code === 0, code, json, text: finalText, events, cost, turns, toolCalls,
        error: code === 0 ? null : `${label || 'session'} exited with code ${code}`,
      });
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

const PREFLIGHT_PROMPT = `You are running a one-shot capability check for a local dashboard. Do not do any research.

Check, in order:
1. Whether the "zoho-lead-profiler" skill is available to you. List its name if you can see it.
2. Whether Zoho CRM MCP tools are available (tools named mcp__Zoho_CRM__*). If they are, make exactly ONE cheap call: mcp__Zoho_CRM__getModuleByApiName for module "Leads", and report whether it succeeded.
3. Whether ZoomInfo MCP tools are available (mcp__ZoomInfo__*). Do NOT call them — just report presence.
4. Whether WebSearch is available. Do not call it.

Then output ONLY a fenced json block, no prose:
\`\`\`json
{"skill": true, "zoho": true, "zohoLeadsReachable": true, "zoominfo": true, "websearch": true, "notes": "one short line on anything missing"}
\`\`\``;

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

function profilePrompt(lead, pepm) {
  return `${SKILL_LINE}

${SKILL_FILES_BLOCK}

You are profiling ONE lead, already explicitly chosen by the user. Skip Step 1 of the skill entirely — the selection is done. Do NOT choose or add any other lead.

Lead — this is the complete relevant extract of the Zoho record, current as of this run. Do NOT call getRecord and do NOT re-read this lead from Zoho; start from what is below:
- Zoho record id: ${lead.id}
- Company: ${lead.company}
- On record: ${lead.contact || '(none)'} ${lead.title ? `— ${lead.title}` : ''}
- Location: ${[lead.city, lead.state].filter(Boolean).join(', ') || '(unknown)'}
- Industry: ${lead.industry || '(unknown)'}
- Website: ${lead.website || '(none on record)'}
- Email on record: ${lead.email || '(none)'}
- Phone on record: ${lead.phone || '(none)'} · Mobile on record: ${lead.mobile || '(none)'}
- Employee count on record (ZoomInfo import, unverified): ${lead.employees ?? '(none)'}
- Lead owner: ${(lead.owner && lead.owner.name) || '(unknown)'}

The client's PEPM for deal sizing is $${pepm} per employee per month. Do not ask for it.

Do Steps 2 through 5 of the skill: verify the contact and confirm they are the top decision-maker (priority 1 or 2), research the company per references/search-recipes.md, write the Description bullets, and build the icebreakers.

DO NOT SCORE THIS LEAD. No fit score, no tier, no temperature, no confidence rating, no priority grade, no estimated deal value. The user has said plainly they do not want leads rated. Report what you found — the facts, their sources and their dates — and let the rep judge. "verified" and "unverified" on a specific phone or email are check outcomes, not scores, and those stay.

CRITICAL — do NOT write anything to Zoho. No createRecords, no updateRecord, no note creation, no Profiled_Date stamp. A human reviews these results in a dashboard first and the write happens separately. Read-only Zoho calls are fine.

WORK EFFICIENTLY — these rules cut cost, never depth:
- Start with ONE ToolSearch call that loads every tool you will need at once: "select:WebSearch,WebFetch,mcp__claude_ai_Zoho_CRM__searchRecords,mcp__claude_ai_ZoomInfo__enrich_contacts,mcp__claude_ai_ZoomInfo__search_contacts_v2,mcp__claude_ai_ZoomInfo__search_scoops,mcp__claude_ai_ZoomInfo__enrich_intent". Never load tools one at a time.
- Fire each research round as ONE message containing ALL of that round's tool calls in parallel — the skill's four rounds are designed for exactly this. Never issue calls one at a time when they do not depend on each other's results.
- Write NO commentary between tool calls — no narration of what you are about to do, no summaries of what came back. Every extra turn re-reads the entire conversation and is the main cost of this run. Hold everything for the final JSON.

Dig properly. Your budget is EIGHTY tool calls for this lead and it is a ceiling, not a target — there is no stop-early rule. Work the completion bar in references/search-recipes.md before you finish: a verified decision-maker with a current title, a reachable direct or mobile phone somewhere on the record, a defensible email, a sourced headcount, a provider hypothesis or all five detection routes attempted, the public-record sweep, the mandatory social sweep, three or more icebreakers with at least one from the person's own social account, and the Description bullets. When a search comes back empty, work its escalation ladder before recording a gap.

If the decision-maker has no direct dial and no mobile, or no email you can stand behind, KEEP THEM as the primary contact and additionally find the most senior person at the company who does have a direct phone and an email. Put that person in "additionalContacts". Anyone displaced from the primary slot who is still at the company goes there too. Never substitute a more reachable person into the primary slot.

When done, output ONLY a fenced json block as your entire final message — no prose before or after. Prepare the note bodies exactly as you would write them to Zoho, using the format in references/zoho-writeback.md; the dashboard writes them on approval. Omit any note that would be empty.

\`\`\`json
{
  "leadId": "${lead.id}",
  "company": "${lead.company}",
  "disqualified": null,
  "employees": null,
  "employeesBasis": "estimate",
  "contactChanged": false,
  "contact": {
    "firstName": "", "lastName": "", "title": "",
    "priority": 1,
    "email": "", "emailVerified": false,
    "directPhone": "", "directPhoneVerified": false, "directPhoneDNC": false,
    "mobilePhone": "", "mobilePhoneVerified": false, "mobilePhoneDNC": false,
    "linkedin": "",
    "employmentVerifiedBy": "source + date",
    "replacesRecordContact": false,
    "reachable": true
  },
  "entities": [
    { "name": "", "ein": "", "state": "", "role": "operating | office | field staff | staffing arm | per-state entity | parent | subsidiary", "employees": null, "source": "", "date": "" }
  ],
  "additionalContacts": [
    { "firstName": "", "lastName": "", "title": "", "functionalRole": "", "email": "", "directPhone": "", "reason": "displaced | owner unreachable" }
  ],
  "fields": {
    "Website": "", "Street": "", "City": "", "State": "", "Zip_Code": "", "Company_Number": "",
    "Employee_Count": null, "Company_Size": null, "Employee_Growth": null, "Number_of_Locations": "",
    "Description": "", "Existing_Client": "", "Certified_Active_Company": null, "Certification_Date": "",
    "Current_PR_Provider_new": "", "Current_Payroll_Service": "", "Payroll_Frequency": "",
    "HCM": "", "HRM": "", "Benefits_Administration_Software": "", "Benefits_Carrier": "",
    "Healthcare_Providers": "", "Employee_Benefits_Broker": "", "K_Retirement_Plan": "",
    "WC_Carrier": "", "WC_Renewal_Date": "", "BN_Renewal_Date": "",
    "LinkedIn_Company_Profile_URL": "", "Facebook_Company_Profile_URL": "", "Email_Domain": ""
  },
  "notes": {
    "PAYROLL FINDINGS": "", "COMPANY STRUCTURE": "", "CONTACT": "", "COMPANY BACKGROUND": "",
    "TIMING": "", "COMPLIANCE": "", "ICEBREAKERS": ""
  },
  "needsHuman": null,
  "coverage": { "directPhone": false, "email": false, "provider": false, "headcount": false, "socialIcebreaker": false, "publicRecord": false }
}
\`\`\`

Field rules:
- "employeesBasis" is one of: stated, estimate.
- Date-type fields inside "fields" — Certification_Date, WC_Renewal_Date, BN_Renewal_Date — take ISO format YYYY-MM-DD (e.g. 2026-09-03). The US date rule (8/19/2026) applies to text in notes and the Description, never to these three fields; a US-format value here makes Zoho reject the whole record.
- "fields" keys are real Zoho API names on this org and the dashboard writes them straight through. Omit any key you have no value for — do not send an empty string to hold a place. Never add "Annual_Revenue", "No_of_Employees", "Secondary_Email", "Fax", "Twitter" or "Country": they do not exist here and they fail the whole record.
- "Description" is MANDATORY. Never return a profile without it. Open with ONE plain sentence saying what the company is — "Achieve Behavioral Therapy provides in-home and school-based therapy for children with autism, across six states." — then up to six bullets, one to two lines each. Never restate anything already in another field (headcount, city, state, website, provider). No sources, dates or links in the Description; they belong in the notes. Revenue may appear once, with its source, because this org has no revenue field.
- PLAIN ENGLISH IN EVERY FIELD AND EVERY NOTE. This is the feedback that keeps coming back, so treat it as a hard requirement. No source codes and no shorthand — never "LI 12Jul26", "FB", "ATS", "5500", "SchC", "SOS", "DOL WHD", "ZI accuracy 91", "NPI 1780029322", "taxonomy 103K00000X", "PEPM", "SUI", "W-2", "priority 1", "14Jul26". Write instead "on LinkedIn on 12 July 2026", "on their Facebook page", "their online job-application system", "their federal retirement-plan filing for 2024, which employers file each year", "the state business registry", "a US Department of Labor wage investigation", "ZoomInfo, last checked June 2026", "their federal healthcare provider registration, the public record that names the legal owner", "employees on payroll rather than contractors", "state unemployment insurance and payroll tax accounts". Dates always written out in full. Name sources in words inside the sentence, with the link after it.
- FIND EVERY LEGAL ENTITY, AND MAKE THE HEADCOUNT THE TOTAL ACROSS ALL OF THEM. Many of these companies are not one company. It is common to run one entity for the office and a separate one for field staff, or a separate entity per state, or a staffing arm alongside the operating business — each with its own federal employer ID number (EIN), each running its own payroll. ZoomInfo almost always reports only the headquarters shell: on a recent lead it said 8 employees while the company itself said 100-plus clinicians across four entities. Search deliberately for related entities — the state business registry for other companies at the same address or under the same officer, federal retirement-plan and nonprofit filings which list the EIN and participant counts per entity, industry licence registries, "doing business as" names, and near-identical company names with a state or a suffix attached. Put every entity you find in "entities" with its own headcount, and set "Employee_Count" to the SUM across all of them, never one entity's figure. If you cannot get a headcount for one entity, still list it and say so — a total that is a floor is honest and useful; a headquarters-only number is misleading.
- WRITE THE STRUCTURE UP in the "COMPANY STRUCTURE" note: one line per entity with its name, state, what it does, its headcount and its EIN if you found one, then the total. Say plainly why it matters — each separate employer ID is its own payroll registration, its own tax filings and its own set of W-2s, and companies running several often have payroll split across systems or people.
- EVERY POINT STARTS WITH A SHORT HEADLINE, THEN AN EM DASH, THEN THE DETAIL. The headline is a 2-8 word summary of the point in plain capitals, written in ordinary letters — the dashboard converts it to bold characters before writing, so do not try to bold it yourself and do not use asterisks, <b> tags or markdown anywhere. Zoho notes are plain text and any markup you write will show up literally as angle brackets and asterisks. Shape every bullet exactly like this, with the em dash separating headline from detail:
  "· ONE PERSON RUNS HR AND CLINICAL — Aurelie Benittah, the Operations Manager, covers both. One person carrying HR for a part-time, multi-state workforce is the clearest sign they have outgrown what they are using. (their team page) [8/18/2026]"
  Keep section headings as short lines in plain capitals on their own line; those get bolded too. Do not put a source, a date or a full sentence inside the headline — the headline is the summary, everything else goes after the dash.
- DATES AND SOURCES GO AT THE END OF THE LINE, IN BRACKETS. Dates are US numeric with no leading zeros — 8/19/2026, never "19 August 2026", never "14Jul26", never "2026-08-19". A month with no day is 8/2026. Put the SOURCE in round brackets and the DATE in square brackets, in that order, at the very end: "They now run offices in six states, so each one needs its own payroll tax account and unemployment insurance rate. (company website) [8/18/2026]". Never bury a date or a source mid-sentence. This applies to the notes and to the Description.
- EXPLAIN EVERY FINDING. Each item says three things in plain sentences — what you found, where it came from, and WHY IT MATTERS FOR PAYROLL. A fact with a source and no consequence is half a finding and is the most common complaint about this output. Give any technical term half a sentence of explanation the first time it appears. Keep it short, but understandable comes before short.
- "PAYROLL FINDINGS" is the most important note on the record and comes first. Everything bearing on how these people get paid goes here, most payroll-relevant first — how the workforce is shaped and what that does to payroll, who runs payroll and HR today and how thin that is, the provider and what makes you think so, retirement plan and benefits and workers comp and any renewal dates, open roles that reveal pain, and anything else with a payroll consequence such as new state registrations or rapid hiring.
- "ICEBREAKERS" IS OPENERS ONLY. Do not put research in it. A retirement plan, a state registration, an HR department of one, a benefits renewal date — all of those are payroll findings and belong in "PAYROLL FINDINGS". The last run put three such items in the icebreakers and it made the note unusable. The test is whether a rep could say the line out loud to a stranger in the first minute of a call. When something is genuinely both, put the detail in the findings note and one line in the icebreakers.
- Zoho accepts unlimited notes. Add extra plainly-titled notes when a topic earns one — "BENEFITS AND RETIREMENT", "OPEN ROLES", "LOCATIONS". Any key you add to "notes" is written as its own note.
- "Payroll_Frequency" must be one of: Bi-weekly, Monthly, Semi-Monthly, Weekly, Quarterly. "Benefits_Carrier" must be one of: Aetna, Anthem, BCBS, Cigna, United — any other carrier goes in "Healthcare_Providers". "Existing_Client" is Yes or No. Anything outside these is dropped before writing.
- "functionalRole" on an additional contact must be one of: CEO, Partner - Owner, President, CFO, Controller, Head of Finance, COO, Head of HR, HR Admin, HR Manager, Office Manager, Marketing, Payroll, Board Member, Sales Person, Unknown. Keep the person's real title in "title".
- NEVER write an absence anywhere — not in a field, not in a note, not in a bullet. No "no match", "not found", "none", "N/A", "unknown", "no violations", "clean". A field you could not establish is simply omitted, and a note with nothing real in it is omitted too. The dashboard strips these before writing, so anything you include here is wasted work.
- "COMPLIANCE" is written ONLY when an enforcement action, tax warrant or adverse filing actually surfaced. "TIMING" only when a dated, timely event surfaced. Leave them empty otherwise.
- "coverage" is a plain true/false record of what you managed to find, used only for the dashboard's own stats. It is not a rating of the lead.
- "needsHuman" is null unless something genuinely needs a person: an ambiguous name match, an unproven company identity, or a value you would be overriding without solid evidence.`;
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

// The BASIC profile. Six facts, one lookup method each, no skill files, no
// escalation ladders. It exists because the comprehensive pass is the right tool
// for a lead a rep is about to call and the wrong tool for sizing up two hundred
// leads at once. The whole point is the cost ceiling, so the prompt is
// self-contained: nothing is read from disk and the tool budget is a hard stop.
function basicPrompt(lead) {
  return `You are doing a BASIC PROFILE of one company for a payroll sales team. This is a light pass, not research. Six facts, one lookup method each, then stop.

Company — this is the Zoho lead record, current as of this run. Do NOT re-read it from Zoho:
- Zoho record id: ${lead.id}
- Company: ${lead.company}
- On record: ${lead.contact || '(none)'} ${lead.title ? `— ${lead.title}` : ''}
- Location: ${[lead.city, lead.state].filter(Boolean).join(', ') || '(unknown)'}
- Industry on record: ${lead.industry || '(unknown)'}
- Website: ${lead.website || '(none on record)'}
- Email on record: ${lead.email || '(none)'} · Phone on record: ${lead.phone || '(none)'} · Mobile: ${lead.mobile || '(none)'}
- Employee count on record (ZoomInfo import, unverified): ${lead.employees ?? '(none)'}

THE SIX FACTS AND THE ONE WAY TO GET EACH:
1. WHAT THEY ARE — nursing home, home care agency, manufacturer, charter school, etc. Method: the company website home page (WebFetch). No website on record: ONE WebSearch for "${lead.company}" ${lead.state || ''} and use the first result that is clearly them.
2. OWNERSHIP AND CEO — who owns it (a single owner, partners, a family, a private-equity group, a public company, a nonprofit board) and who the CEO or top person is. Method: ONE ZoomInfo contact search on the company for owners and C-level people (mcp__claude_ai_ZoomInfo__search_contacts_v2 with management level owner/C-level, up to 10 rows). If the website has an about or leadership page and you already fetched the site, read the names off that too, but do not go looking for more.
3. EMPLOYEE COUNT — Method: ONE ZoomInfo company enrichment (mcp__claude_ai_ZoomInfo__enrich_companies) for the headline count. Two special cases:
   - HOME CARE / HOME HEALTH / STAFFING: the ZoomInfo number is usually the office and the real workforce is in the field. Do ONE extra WebSearch: "${lead.company}" caregivers OR aides OR nurses OR employees — and if the company or a news item states a field-staff figure, report office and field separately.
   - NURSING HOME / ASSISTED LIVING / ANY MULTI-FACILITY GROUP: count the whole group. Do ONE extra WebSearch: "${lead.company}" facilities OR locations OR "skilled nursing" — and report the number of facilities and the group-wide headcount (sum the facilities if a per-facility figure is what you find, and say it is a sum).
4. HCM / HRIS / ATS — what system their job applications run on. Method: fetch the careers or jobs page (WebFetch the careers link from the home page, or {website}/careers) and read the host of the apply links. myworkdayjobs.com = Workday, greenhouse.io = Greenhouse, lever.co = Lever, icims.com = iCIMS, ultipro.com or ukg.com = UKG, paylocity.com = Paylocity, paycomonline.net = Paycom, paycor.com = Paycor, adp.com or workforcenow = ADP, bamboohr.com = BambooHR, applytojob.com = JazzHR, jobvite.com = Jobvite, smartrecruiters.com = SmartRecruiters, ashbyhq.com = Ashby, workable.com = Workable, isolvedhire or isolved = isolved, apploi.com = Apploi, hireology.com = Hireology, indeed-hosted or a plain email/web form = none. If there is no careers page, ONE WebSearch: site:indeed.com OR site:linkedin.com/jobs "${lead.company}" and read the apply destination of one posting. For a multi-facility group, check a second facility's posting if it is right there in the results; do not tour every facility.
5. HQ AND WHERE THE OWNERS SIT — the headquarters address (from the same ZoomInfo company enrichment as fact 3) and, if the owners or executives sit somewhere else (common with nursing home groups whose owners are in New York or New Jersey while the facilities are elsewhere), that city and state from the ZoomInfo contact rows in fact 2.
6. OWNER AND C-SUITE DIRECT CONTACT INFO — direct phone, mobile and email for the owner/CEO and up to two more C-suite or partner-level people. Method: ONE mcp__claude_ai_ZoomInfo__enrich_contacts call for the top three people from fact 2, in one batch. Take what it returns; do not go hunting elsewhere.

WORK EFFICIENTLY — the budget is the point of this mode:
- Start with ONE ToolSearch: "select:WebSearch,WebFetch,mcp__claude_ai_ZoomInfo__enrich_companies,mcp__claude_ai_ZoomInfo__search_contacts_v2,mcp__claude_ai_ZoomInfo__enrich_contacts". Never load tools one at a time.
- Round 1, all in ONE message: the website fetch, the ZoomInfo company enrichment, and the ZoomInfo contact search. Round 2, all in ONE message: the careers page fetch, the contact enrichment, and whichever single extra WebSearch fact 3 or fact 4 calls for. That is normally the whole job.
- HARD CEILING: TWELVE tool calls including the ToolSearch. If a method comes up empty, record the gap and move on. There is no escalation ladder in this mode and no second method for anything.
- No commentary between tool calls. No narration. Hold everything for the final JSON.
- Do NOT write anything to Zoho. A human reviews this first.

When done, output ONLY a fenced json block as your entire final message — no prose before or after:

\`\`\`json
{
  "leadId": "${lead.id}",
  "company": "${lead.company}",
  "basic": {
    "companyType": "",
    "ownership": "",
    "ceo": "",
    "employees": null,
    "employeesBasis": "stated | estimate | sum of facilities",
    "officeStaff": null,
    "fieldStaff": null,
    "facilities": null,
    "hcm": "",
    "hcmEvidence": "",
    "hq": "",
    "execLocation": "",
    "gaps": []
  },
  "employees": null,
  "employeesBasis": "estimate",
  "contactChanged": false,
  "contact": {
    "firstName": "", "lastName": "", "title": "",
    "email": "", "emailVerified": false,
    "directPhone": "", "directPhoneVerified": false,
    "mobilePhone": "", "mobilePhoneVerified": false,
    "linkedin": "",
    "employmentVerifiedBy": "ZoomInfo, checked ${todayUS()}",
    "replacesRecordContact": false
  },
  "additionalContacts": [
    { "firstName": "", "lastName": "", "title": "", "functionalRole": "", "email": "", "directPhone": "", "reason": "c-suite" }
  ],
  "fields": {
    "Website": "", "Street": "", "City": "", "State": "", "Zip_Code": "",
    "Employee_Count": null, "Number_of_Locations": "", "Description": "",
    "HCM": "", "LinkedIn_Company_Profile_URL": "", "Email_Domain": "",
    "Entity_Name_Ultimate_Parent": ""
  },
  "notes": { "BASIC PROFILE": "" },
  "needsHuman": null
}
\`\`\`

Field rules:
- "basic" is the six facts in plain words for the dashboard table. "gaps" lists which of the six you could not establish, e.g. ["hcm", "execLocation"]. An empty string or null elsewhere means not found; never write "not found", "N/A" or "unknown" as a value.
- "contact" is the OWNER or CEO — the top person from fact 2 with whatever fact 6 returned. If the person already on the record IS an owner or C-suite person, keep them in "contact" (update their title, phone and email from ZoomInfo) and set "replacesRecordContact": false. If the record's person is not at that level, the owner/CEO goes in "contact" with "replacesRecordContact": true and "contactChanged": true, and the record's person goes in "additionalContacts" with reason "displaced". The other C-suite people from fact 6 fill the rest of "additionalContacts" (two slots at most are written).
- "functionalRole" on an additional contact must be one of: CEO, Partner - Owner, President, CFO, Controller, Head of Finance, COO, Head of HR, HR Admin, HR Manager, Office Manager, Marketing, Payroll, Board Member, Sales Person, Unknown. Keep the real title in "title".
- "employees" (top level and in "fields".Employee_Count) is the TOTAL workforce — office plus field for home care, the whole group for a facility operator. "Number_of_Locations" is the facility count as a string when there is one. "Entity_Name_Ultimate_Parent" is the group or parent company name when the lead is one facility of a group.
- "fields".Street/City/State/Zip_Code are the HQ from fact 5. Omit any key you have no value for — do not send an empty string to hold a place.
- "Description" is MANDATORY: ONE plain sentence saying what the company is, from fact 1 — "Sunrise Care Group operates eleven skilled nursing facilities in Pennsylvania and Ohio." Nothing else in it.
- "HCM" is the platform name from fact 4 (e.g. "Paylocity"). If the ATS is one of ADP, Paycom, Paylocity, Paycor, UKG, isolved, Paychex or Rippling, say so plainly in the note — those are bundled suites, so the recruiting system is almost certainly their payroll provider too.
- The "BASIC PROFILE" note is the six facts written for a rep, one line each, in this exact shape: a 2-8 word headline in plain capitals, then an em dash, then the detail, then the source in round brackets and the date in square brackets at the very end. Example line: "· OWNED BY TWO PARTNERS — Moshe Klein and David Roth own the group; Klein is the CEO. Both sit in Lakewood, New Jersey, while every facility is in Ohio. (ZoomInfo) [${todayUS()}]". Dates are US numeric with no leading zeros. Plain English everywhere — never "LI", "ZI", "ATS", "HCM" without saying what it is, never an abbreviation a rep would not know. Leave out any line for a fact you did not find; the note only carries what you established.
- "needsHuman" is null unless the company identity is genuinely ambiguous (two companies with this name in this state, say) — then one short sentence.`;
}

// ---------------------------------------------------------------- job runner

// Preflight is server-wide (it is a property of the server's Claude account).
// Everything else — the browsed lead list, the active run — belongs to one user.
const state = {
  preflight: null,
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
        leadId: j.leadId, company: j.company, lead,
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
      await worker(item, i);
    }
  });
  await Promise.all(runners);
}

async function startRun(user, leads, pepm, mode = 'full') {
  const basic = mode === 'basic';
  const id = newRunId();
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  const us = userState(user.id);

  const run = us.run = {
    id, userId: user.id, userName: user.name, startedAt: Date.now(), finishedAt: null, pepm, mode,
    jobs: leads.map((l) => ({
      leadId: l.id, company: l.company, lead: l,
      status: 'queued', progress: [], result: null,
      error: null, cost: null, toolCalls: 0,
      startedAt: null, finishedAt: null,
      written: false, writeResult: null,
    })),
  };
  // Written to history straight away so a restart mid-run still knows the run
  // existed and who it belonged to.
  persistRun(run);
  emit('run:start', { run: publicRun(run) }, user.id);

  // A basic run fans out wide and skips the server-wide semaphore: those sessions
  // are a dozen tool calls each, and the semaphore exists to stop six deep
  // research sessions from starving one another, not to serialise a quick sweep.
  const limit = basic ? Math.max(1, Number(config.basicConcurrency) || 20) : config.concurrency;
  const runOne = basic
    ? (prompt, opts) => runClaudeNow(prompt, { ...opts, timeoutMin: Number(config.basicTimeoutMin) || 12 })
    : runClaude;
  pool(run.jobs, limit, async (job) => {
    job.status = 'running';
    job.startedAt = Date.now();
    emit('job', { job: publicJob(job) }, user.id);

    const res = await runOne(basic ? basicPrompt(job.lead) : profilePrompt(job.lead, pepm), {
      label: job.company,
      cwd: dir,
      logFile: path.join(dir, `${job.leadId}.log.jsonl`),
      onEvent: ({ kind, msg }) => {
        job.progress.push({ kind, msg, at: Date.now() });
        if (job.progress.length > 400) job.progress.shift();
        emit('progress', { leadId: job.leadId, kind, msg }, user.id);
      },
    });

    job.finishedAt = Date.now();
    job.cost = res.cost;
    job.toolCalls = res.toolCalls;
    if (res.json) {
      job.result = res.json;
      job.status = 'done';
      fs.writeFileSync(path.join(dir, `${job.leadId}.json`), JSON.stringify(res.json, null, 2));
    } else {
      job.status = 'failed';
      job.error = res.error || 'Session finished but returned no parseable JSON. Check this lead’s log.';
    }
    persistRun(run);
    emit('job', { job: publicJob(job) }, user.id);
  }).catch((err) => {
    emit('status', { msg: `Run stopped unexpectedly: ${err.message}` }, user.id);
  }).then(() => {
    run.finishedAt = Date.now();
    persistRun(run);
    emit('run:done', { run: publicRun(run) }, user.id);
  });

  return id;
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
    jobs: run.jobs.map((j) => ({
      leadId: j.leadId, company: j.company, status: j.status,
      // The browsed row is kept so a restored run can re-render the picker
      // columns and re-run a lead without another Zoho read.
      lead: j.lead ? { id: j.lead.id, company: j.lead.company, city: j.lead.city, state: j.lead.state,
        industry: j.lead.industry, contact: j.lead.contact, title: j.lead.title, owner: j.lead.owner || null } : null,
      cost: j.cost, toolCalls: j.toolCalls,
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
        company: j.company,
      } : null,
    })),
  };
  if (idx >= 0) history.runs[idx] = record; else history.runs.push(record);
  writeJSON(HISTORY_PATH, history);
}

const publicJob = (j) => ({
  leadId: j.leadId, company: j.company, status: j.status,
  progress: j.progress.slice(-40), result: j.result, error: j.error,
  cost: j.cost, toolCalls: j.toolCalls, startedAt: j.startedAt,
  finishedAt: j.finishedAt, written: j.written, writeResult: j.writeResult,
  lead: j.lead,
});
const publicRun = (run) => run && ({
  id: run.id, userId: run.userId, userName: run.userName, restored: !!run.restored,
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
      if (j.result) leads.push({ ...j.result, run: run.id, mode: run.mode || 'full', at: run.startedAt, cost: j.cost, durationMs: j.durationMs, written: j.written, userId: run.userId, userName: run.userName });
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
      written: r.jobs.filter((j) => j.written).length,
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
    if (p === '/healthz') return send(res, 200, { ok: true, users: users.length, liveSessions });

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
      const allowed = ['pepm', 'concurrency', 'basicConcurrency', 'basicTimeoutMin', 'maxSessions', 'claudeCmd', 'model', 'perLeadTimeoutMin'];
      for (const k of allowed) if (body[k] !== undefined) config[k] = body[k];
      config.concurrency = Math.max(1, Math.min(8, Number(config.concurrency) || 3));
      config.basicConcurrency = Math.max(1, Math.min(40, Number(config.basicConcurrency) || 20));
      config.basicTimeoutMin = Math.max(3, Math.min(30, Number(config.basicTimeoutMin) || 12));
      config.maxSessions = Math.max(1, Math.min(24, Number(config.maxSessions) || 6));
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
        label: 'preflight', timeoutMin: 5,
        logFile: path.join(RUNS, 'preflight.log.jsonl'),
        onEvent: ({ msg }) => emit('status', { msg }, user.id),
      });
      state.preflight = r.json || { error: r.error || 'Preflight returned nothing parseable.', raw: (r.text || '').slice(0, 800) };
      state.preflight.at = Date.now();
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
        label: 'fetch', timeoutMin: 6,
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
      const pepm = body.pepm || config.pepm;
      if (pepm !== config.pepm) { config.pepm = pepm; writeJSON(CONFIG_PATH, config); }
      const id = await startRun(user, chosen, pepm, mode);
      return send(res, 200, { runId: id });
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
            job.writeResult = await writeLeadDirect(job.result, run.mode || 'full');
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
          const r = await runClaude(writePrompt(job.result, run.pepm, run.mode || 'full'), {
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
  if (!fs.existsSync(skillPath('SKILL.md'))) {
    console.warn(`  WARNING: skill files not found at ${SKILL_DIR}\n  Profile sessions are told to read them from that exact path and will fail without them.\n`);
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn('  WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set. Profiling sessions will not be able to sign in.\n');
  }
});
