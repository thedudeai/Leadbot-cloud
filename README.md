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
| Zoho label | `Profile_Type = Comprehensive` | `Profile_Type = Basic` |

Both buttons sit under the lead table and take the same selection. A basic run writes the contact,
the additional contacts, the HQ address, headcount, location count, HCM, the one-sentence
Description and a single **BASIC PROFILE** note. `Profile_Type` is a picklist on Leads (created
10 Sep 2026); the picker shows it next to "Last profiled" so a rep can see which leads have only
had the light pass.

The profile prompt, the skill files, the review gate, the scrub/date/picklist enforcement in the
write path and the Zoho REST calls are unchanged. `runClaude` still spawns
`claude -p --output-format stream-json --permission-mode bypassPermissions`.

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

## Security notes

Passwords are scrypt-hashed with per-user salts. Sessions are HttpOnly, SameSite=Lax cookies
(Secure behind HTTPS), 30-day rolling. Login is throttled to 8 failures per email/IP per 15
minutes. Reps cannot reach Setup, Team, Segments, the connection check, preflight, the write
check, or company-wide stats, and every run request is re-checked server-side against the rep's
Zoho owner — the browser's row data is not trusted for that.

`storage/` (and `/data` on the server) holds users, sessions, history, run results and, if an
admin saved credentials in Setup, `zoho.json`. Treat the volume like a password store.
