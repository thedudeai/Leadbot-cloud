# Lead Bot Cloud

The hosted, multi-user version of the Lead Bot dashboard for the `zoho-lead-profiler` skill.
Same engine as the desktop build — one headless Claude Code session per lead, Zoho listing and
write-back straight through the CRM REST API, a human approving every write in Review — with
a login in front of it so the whole payroll team can use one deployment.

## What is different from the desktop build

| | Desktop (`Start Lead Bot.cmd`) | Cloud |
|---|---|---|
| Who can use it | whoever sits at that PC | anyone with an account; admin creates accounts under **Team** |
| Which leads a person sees | everything | reps are pinned to the leads they own in Zoho; admins (or anyone marked "sees all") browse the whole org |
| Runs and Review | one global run | each person has their own run, live feed and Review; restored from disk after a restart |
| Claude sessions | 3 at a time | per-person cap (default 3) **and** a company-wide cap (default 6) so five reps can't fire off fifteen sessions |
| Stats | one machine | "My runs" for everyone, "Everyone" with a by-person table for admins |
| Claude sign-in | the PC's `claude login` | `CLAUDE_CODE_OAUTH_TOKEN` in the server environment — one shared company account |
| Zoho credentials | `data/zoho.json` on the desktop | `ZOHO_*` environment variables (an admin can still override them in Setup) |
| Storage | the app folder | a persistent volume at `DATA_DIR` (`/data` on Railway) |

## Two profile types

| | Comprehensive (**Profile**) | Basic (**Basic profile**) |
|---|---|---|
| What it does | the full skill: verification ladder, four research rounds, entity roll-up, payroll findings, icebreakers | six facts, one lookup method each, hard ceiling of 12 tool calls |
| The six facts | — | what they are · ownership and CEO · headcount (office vs field for home care, group-wide plus facility count for nursing groups) · HCM/HRIS/ATS from the apply links on their job postings · HQ and where the owners sit · owner and C-suite direct phone and email |
| Leads at once | `concurrency` (default 3) under the company-wide `maxSessions` cap | `basicConcurrency` (default 20), outside the company-wide cap |
| Per run | up to 50 | up to 300 |
| Timeout | `perLeadTimeoutMin` (25) | `basicTimeoutMin` (12) |
| Cost cap / tool-call wall | `maxCostFull` ($6) / `maxToolCallsFull` (100) | `maxCostBasic` ($0.75) / `maxToolCallsBasic` (16) |
| Zoho label | `Profile_Type = Comprehensive` | `Profile_Type = Basic` |

Both buttons sit under the lead table and take the same selection. A basic run writes the contact,
the additional contacts, the HQ address, headcount, location count, HCM, the one-sentence
Description and a single **BASIC PROFILE** note. `Profile_Type` is a picklist on Leads (created
10 Sep 2026); the picker shows it next to "Last profiled" so a rep can see which leads have only
had the light pass.

The review gate, the scrub/date/picklist enforcement in the write path and the Zoho REST calls
are unchanged. `runClaude` spawns `claude -p --output-format stream-json --permission-mode
bypassPermissions --model <model> --max-budget-usd <cap> --json-schema <shape> --disallowed-tools
<file and shell tools>` directly (no shell), in its own process group.

## Hard stops, the fallback ladder, and the leadership roster (16 Sep 2026)

**Every session has four independent hard stops** (Setup → Hard stops): a dollar cap enforced by
the CLI itself (`maxCostFull` $6, `maxCostBasic` $0.75), a tool-call wall counted by the server
(`maxToolCallsFull` 100, `maxToolCallsBasic` 16), the per-lead timeout, and an idle watchdog
(`idleKillMin` 6 — no output from the CLI for that long means it is hung). A stop kills the whole
process group and resolves the job whether or not the process obliges — the old build held a
shell, killed the shell, and left the real CLI running as an orphan for hours with its session
slot never released. **Stop this run** on the live screen kills every session in the run.

**Fallback:** a comprehensive session that is stopped or comes back empty is followed by one
basic pass (`fallbackToBasic`), so the lead still gets six facts, a description and a leadership
roster. Such a lead is marked *fell back to basic* in the live feed and Review, writes as
`Profile_Type = Basic`, and can be re-run later. No lead ever runs more than two sessions.

**The leadership roster:** every profile returns `leadership` — every owner, partner and C-level
person the research could name, with direct dial, mobile and email. The server writes it to the
record as a **LEADERSHIP CONTACTS** note (one bold-headlined line per person) and fills any empty
additional-contact slot from it, most senior person with a phone first. The Review table shows
"N of M with a number" per lead; Stats shows leadership phones per lead.

**One prompt, every model.** The four skill files are no longer read by sessions. Their content is
condensed into `skill/zoho-lead-profiler/HEADLESS.md` (~9k tokens instead of ~32k) and inlined
into the prompt, and the basic prompt carries the same style section verbatim. Output shape is
forced by a JSON schema and then normalized server-side (`normalizeProfile`), and every note is
shaped by the same write pipeline. Switching `model` (Setup → Research model; default `sonnet`)
changes research depth and cost, never what a record looks like. Preflight and the fetch fallback run on
`utilityModel` (`haiku`). Preflight also discovers the real MCP tool names on
the server and rewrites the prompts to match — **run it once after deploying.**

**Other fixes in the same pass:** a lead profiled in the last seven days is refused unless you
confirm; Zoho API calls time out at 30 s instead of hanging a write forever; a crash in one lead
no longer takes the run down; stopped sessions get an estimated cost from their token usage
(marked *est.*) so Stats stops under-counting them; `config.json` from an earlier version gets the
new defaults and `model` is migrated from '' (the CLI's priciest default) to `sonnet`.

## Files

| File | Role |
|---|---|
| `server.mjs` | the whole server: auth, users, Zoho API, prompts, job runner, stats, HTTP |
| `ui.html` | the dashboard (Run, Review, Stats; admins also get Segments, Team, Setup) |
| `login.html` | the sign-in page |
| `skill/zoho-lead-profiler/` | the skill, read by every profiling session at its exact path |
| `segments.default.json` | seeds `segments.json` on first boot |
| `Dockerfile`, `railway.json` | the image (Node 22 + Claude Code CLI, non-root) and Railway config |
| `test/e2e.mjs`, `test/ui.mjs` | API and headless-browser tests against a stubbed `claude` |

## Environment variables

See `.env.example`. Required: `ADMIN_EMAIL` + `ADMIN_PASSWORD` (creates the first admin when
there are no accounts), `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on a machine signed
in to the company's Claude account), and the three `ZOHO_*` credentials.

## Running locally

```
DATA_DIR=./storage ADMIN_EMAIL=you@x.com ADMIN_PASSWORD=something-long node server.mjs
```

then open `http://localhost:8765`. `npm test` runs both test suites (they use a stub CLI and
need no credentials; `test/ui.mjs` needs Playwright available globally).

## Deploying

Railway builds the Dockerfile. Attach a volume at `/data`, set the variables above, and expose the
service. The first thing to do on a fresh deploy is **Setup → Run preflight** as the admin: it
confirms the server's Claude account can see the skill files, the Zoho and ZoomInfo connectors, and
WebSearch. Then **Team** to add people and map each one to their Zoho user (matched by email
automatically when the emails line up).

### ZoomInfo on the server (one-time)

The server signs into Claude with `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. That token
can only make model requests: it cannot fetch the claude.ai connectors, so the ZoomInfo connector
on the company's Claude account never reaches the headless CLI, and every profile reports that
ZoomInfo was unavailable. MCP servers configured locally on the box do work, so ZoomInfo is
registered as a local HTTP MCP server and signed into once.

Claude Code keeps its MCP server list and those OAuth logins in `CLAUDE_CONFIG_DIR`, which the
Dockerfile points at `/data/claude` on the volume, so the login survives redeploys. Run these once
from a shell in the running container (`railway ssh`), as the app user with the same home and
config dir the server uses:

```
setpriv --reuid=leadbot --regid=leadbot --init-groups env HOME=/home/leadbot CLAUDE_CONFIG_DIR=/data/claude \
  claude mcp add --transport http -s user zoominfo https://mcp.zoominfo.com/mcp

setpriv --reuid=leadbot --regid=leadbot --init-groups env HOME=/home/leadbot CLAUDE_CONFIG_DIR=/data/claude \
  claude mcp login zoominfo --no-browser
```

The login prints an authorization URL. Open it in a browser, sign in to ZoomInfo, and paste the
final redirect URL (it starts with `http://localhost` and will not load in the browser; the code is
in the address) back into the waiting prompt. Then check it took:

```
setpriv --reuid=leadbot --regid=leadbot --init-groups env HOME=/home/leadbot CLAUDE_CONFIG_DIR=/data/claude \
  claude mcp list
ls -la /data/claude
```

`zoominfo` should show as connected and `/data/claude` should hold `.claude.json` and
`.credentials.json` owned by `leadbot`. Finish with **Setup → Run preflight**: `zoominfo` should be
true, the ZoomInfo prefix `mcp__zoominfo__` (the local server's name, not the desktop's
`mcp__claude_ai_ZoomInfo__`), and the tool list should include `search_contacts`,
`enrich_contacts` and `enrich_companies`.

## Security notes

Passwords are scrypt-hashed with per-user salts. Sessions are HttpOnly, SameSite=Lax cookies
(Secure behind HTTPS), 30-day rolling. Login is throttled to 8 failures per email/IP per 15
minutes. Reps cannot reach Setup, Team, Segments, the connection check, preflight, the write
check, or company-wide stats, and every run request is re-checked server-side against the rep's
Zoho owner — the browser's row data is not trusted for that.

`storage/` (and `/data` on the server) holds users, sessions, history, run results and, if an
admin saved credentials in Setup, `zoho.json`. Treat the volume like a password store.
