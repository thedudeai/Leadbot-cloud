# Search Recipes

Exact queries, and how far to keep going. This skill is not optimised for speed — it is optimised for
**coming back with something.** A thin profile costs a rep a wasted call, which is far more expensive
than twenty extra searches.

`{co}` = company name in quotes · `{st}` = state · `{domain}` = website domain · `{person}` = full name

---

## How deep to go

**Budget: eighty tool calls per lead** across Steps 2–4. That is a ceiling to stop one stubborn lead
eating an entire run — **it is not a target to avoid.** Most leads should use a real fraction of it.

**There is no "stop early" rule.** Earlier versions said to stop once the picture was clear, and the
result was consistently shallow records. Delete that instinct. You stop when the completion bar below
is met or the budget is gone, whichever comes first.

### The completion bar — what "done" means for one lead

Do not move to the next lead until each of these is either satisfied or has had its full escalation
ladder run:

| # | Requirement |
|---|---|
| 1 | A named priority-1 or priority-2 decision-maker, with employment confirmed against a rank 1–5 source |
| 2 | Their **actual current title**, from the company's own site or dated press |
| 3 | At least one **direct dial or mobile** — for the primary, or for the additional contact the owner-has-no-phone rule requires |
| 4 | An email that is either published or pattern-derived from two published examples |
| 5 | **Every related legal entity found, and a headcount that is the TOTAL across all of them** — not the headquarters figure |
| 6 | A payroll-provider hypothesis with its basis, **or** all five detection routes attempted |
| 7 | The public-record sweep run: DOL, Form 5500, state tax warrants, secretary of state |
| 8 | The social sweep run across every platform in the table below |
| 9 | **Three or more icebreakers, at least one from the person's own social account** — openers only, no research findings |
| 10 | **The `Description` written** — one plain sentence saying what the company is, then up to six bullets. Mandatory; a lead is not done without it |
| 11 | A `PAYROLL FINDINGS` note covering how the workforce is shaped, who runs payroll today, the provider, and retirement or benefits — each with what it means for payroll |
| 12 | Everything in plain English — no source codes, no abbreviations, dates as 8/19/2026, and every source and date at the END of its line in brackets (round for source, square for date) |

Falling short on one item after its ladder is exhausted is a legitimate outcome — it is what happens
with a genuinely quiet twelve-person company. Falling short because you stopped after seven searches
is the failure this bar exists to prevent.

**Track the count out loud to yourself.** If you are at call twenty and half the bar is unmet, you have
sixty calls left and no reason to wrap up.

---

## Round 1 — the opening batch, fired all at once

Send them in **one message with multiple tool calls.** Sequential calls are what makes this slow.

| # | Call | Looking for |
|---|---|---|
| 1 | `WebFetch {domain}` | what they actually do, in their words |
| 2 | `WebFetch {domain}/about` `/about-us` `/who-we-are` `/company` | founding, ownership, story |
| 3 | `WebFetch {domain}/team` `/leadership` `/staff` `/our-team` `/management` | the owner, titles, direct lines |
| 4 | `WebFetch {domain}/contact` | main line, address, sometimes direct emails |
| 5 | `WebFetch {domain}/careers` `/jobs` | open roles, ATS host, locations |
| 6 | `WebSearch: {co} {st} "payroll" OR "HR" job opening hiring` | the bullseye role |
| 7 | `WebSearch: {co} wage and hour division back wages investigation` | DOL enforcement |
| 8 | `WebSearch: {co} "form 5500" participants plan sponsor` | headcount + provider |
| 9 | `WebSearch: {co} {st} tax warrant OR lien withholding` | tax warrants |
| 10 | `WebSearch: {co} ADP OR Paychex OR Gusto OR Paylocity OR Paycom payroll` | incumbent provider |
| 11 | `WebSearch: {co} {st} expansion OR acquisition OR layoffs 2026` | news, disqualifiers |
| 12 | `WebSearch: {co} {st} owner OR founder OR president OR CEO` | the top seat |

If `{domain}` is missing from the Zoho record, replace calls 1–5 with
`WebSearch: {co} {st} official website` and fetch whatever it returns.

**Read everything that comes back before firing round 2.** Round 2 is shaped by round 1 — that is the
point of splitting them.

## Round 2 — the person, fired all at once

Once you know who the decision-maker is:

| # | Call | Looking for |
|---|---|---|
| 13 | `WebSearch: "{person}" linkedin {co}` | current employer and title, from them |
| 14 | `WebSearch: "{person}" linkedin` | a move to a new employer |
| 15 | `WebSearch: "{person}" "{co}" email OR phone OR contact` | published contact details |
| 16 | `WebSearch: "{person}" "{co}" appointed OR promoted OR named OR "joined"` | title and start date from press |
| 17 | `WebSearch: "{co}" "@{domain}" email` | the org's email pattern |
| 18 | `WebSearch: "{person}" "{co}" interview OR podcast OR panel OR speaker OR bio` | bios carry titles and tenure |

## Round 3 — the social sweep, fired all at once

**Mandatory. This round is not optional and it is not a fallback.** The user's clearest complaint
about the previous version is that it never used social media, which is where the best icebreakers
live. See the icebreaker section below for the full query set — run it in one batch.

## Round 4 — escalation, driven by what is still missing

Now look at the completion bar and fire what the gaps call for. This is where the depth comes from.
Sections below give the ladder for each gap.

**Follow-ups are not capped any more.** Open the job posting. Open the news article. Open the podcast
page. Fetch the second and third pages of a state registry. The old "at most two follow-ups" rule is
gone — it was the main cause of shallow output.

---

## What each source gives you

### Job postings (highest yield, always do these)

If the careers page links to an ATS, hit its public endpoint directly:

| Host seen | Endpoint |
|---|---|
| `boards.greenhouse.io` | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` |
| `jobs.lever.co` | `https://api.lever.co/v0/postings/{company}?mode=json` |
| `jobs.ashbyhq.com` | `https://api.ashbyhq.com/posting-api/job-board/{token}` |
| `apply.workable.com` | `https://apply.workable.com/api/v1/widget/accounts/{token}?details=true` |
| `{co}.recruitee.com` | `https://{company}.recruitee.com/api/offers/` |

**The ATS is itself a signal.** If the careers page runs on **ADP, Paycom, Paylocity, Paycor, UKG or
isolved** recruiting, you have identified their payroll provider — those are bundled suites, nobody
buys the recruiting module alone. A hand-built HTML careers page means low sophistication and an easy
win. Greenhouse / Ashby / Lever means a modern stack and a harder displacement.

**Escalate when the careers page is empty:**

```
WebSearch: site:indeed.com {co}
WebSearch: site:linkedin.com/jobs {co}
WebSearch: site:ziprecruiter.com {co}
WebSearch: "{co}" "now hiring" OR "join our team" {st}
```

**Extract:**

- Payroll Specialist / Manager / Administrator / Coordinator open → the bullseye
- "implementing", "migrating to", "transitioning from" + a system → a switch is live now
- Requirements naming a system → the incumbent
- "certified payroll", "Davis-Bacon", "prevailing wage" → federal contractor
- New CFO / Controller / VP Finance posting → 90-day vendor-review window
- First HR hire, or "Head of People" at 50+ staff with no prior HR → outgrowing founder-run HR
- Volume of hourly/shift roles → overtime and timekeeping pain
- Multi-state or remote postings, union/CBA language, tipped roles, contractor-heavy language

**System names:** ADP (also "Workforce Now", "RUN powered by ADP"), Paychex ("Paychex Flex"), Gusto,
Paylocity, Paycom, Paycor, UKG ("UltiPro", "Kronos"), Workday, TriNet, Insperity, Justworks,
Rippling, BambooHR, isolved, Namely, QuickBooks/Intuit Payroll.

Word boundaries matter — "must adapt quickly" is not ADP.

### DOL wage & hour enforcement (strongest pain signal)

Portals: <https://enforcedata.dol.gov/> · <https://data.dol.gov/>

**Both are JavaScript apps and will not render through WebFetch.** That is why this is a search, not a
fetch — going straight to the portal wastes a call and returns nothing.

**Escalation ladder when the first search is empty:**

```
WebSearch: "{co}" OSHA citation OR violation
WebSearch: "{co}" "unpaid overtime" OR "class action" OR "collective action" lawsuit
WebSearch: "{co}" NLRB OR "unfair labor practice"
WebSearch: "{co}" EEOC charge OR settlement
WebSearch: site:courtlistener.com "{co}"
WebSearch: "{co}" {st} "labor commissioner" OR "wage claim"
```

When something surfaces, capture: case ID, findings date, back wages, employees affected, violation
type, source URL. An FLSA **overtime** finding is the single best opening for this pitch.

### Form 5500

Search UI: <https://www.efast.dol.gov/5500Search/> — a JavaScript app, so use the query rather than
fetching it.

**Escalation ladder** — this one is genuinely worth several calls, because the participant count is
the best headcount you can get and Schedule C names the providers:

```
WebSearch: "{co}" "form 5500" participants plan sponsor
WebSearch: "{co}" 401k plan "plan year" participants
WebSearch: site:efast.dol.gov "{co}"
WebSearch: site:freeerisa.com "{co}"
WebSearch: site:form5500.com "{co}"
WebSearch: "{co}" EIN "employee benefit plan"
```

When it hits, capture participant count, plan year, prior-year count (for `Employee_Growth`), and any
named service provider from Schedule C or the broker from Schedule A.

**Headcount sources, best first** — and the answer is always the total across every related entity,
built by applying this ladder to each one: the retirement-plan participant count for the most recent
plan year (government-filed, strongest), then the count already on the Zoho record, then a headcount
stated on the company's own site, then a range implied by job-posting volume — weakest, and label it
an estimate. Record which source you used for each entity.

**A participant count is per filing, and each entity files separately.** Finding one filing does not
mean you have found the company's staff — check whether the sibling entities file too.

Two facts worth knowing: Schedule C provider disclosure is only required of large plans (~100+
participants), and an employer with no ERISA plan never files at all. Neither absence means anything —
and neither absence gets written into the CRM.

### Tax warrants and state registration (highest value, highest care)

A **withholding-tax** warrant means they collected tax from employees and did not remit it. A payroll
failure by definition.

NY has a clean public search:
<https://appext20.dos.ny.gov/stwarrants_public/stwarrants_app.st_search>

**Also run the secretary-of-state check** — it gives active/dissolved status for
`Certified_Active_Company`, the officer names (often the owner you are looking for), and the count of
states they are registered in:

```
WebSearch: "{co}" {st} secretary of state business entity search
WebSearch: "{co}" registered agent officers {st}
WebSearch: "{co}" "certificate of authority" OR "foreign entity" registration
```

**Stricter bar than anywhere else on warrants.** Require an exact name match plus matching state or
address. Anything less: record as unconfirmed and route to a human. If several debtors share the name,
write nothing.

### Related legal entities — how many companies is this actually?

**Assume it is more than one until you have checked.** It is normal for these businesses to run an
office entity and a separate field-staff entity, or one entity per state, or a staffing arm beside the
operating company. Each is a separate employer with its own federal employer ID number (EIN), its own
payroll registration and its own W-2s at year end.

**This is also the single biggest source of wrong headcounts.** ZoomInfo reports the headquarters
shell. On a recent lead it said 8 employees while the company's own site said 100-plus clinicians
across four entities — a number that would have sent a rep into the wrong conversation entirely.

```
WebSearch: "{co}" {st} secretary of state entity search
WebSearch: "{co}" LLC OR Inc OR Corp {st} -site:{domain}          // sibling names
WebSearch: "{co}" "doing business as" OR "d/b/a" OR "formerly known as"
WebSearch: "{co}" staffing OR "field services" OR "management company" OR holdings LLC
WebSearch: "{co}" EIN OR "employer identification number"
WebSearch: site:freeerisa.com "{co}"                              // 5500s list EIN + participants per entity
WebSearch: site:projects.propublica.org/nonprofits "{co}"         // 990s carry EIN and employee counts
WebSearch: "{address}" registered agent OR "principal office"     // other entities at the same address
WebSearch: "{owner}" officer OR "registered agent" {st}           // other entities under the same person
```

**Where an EIN actually shows up:** a federal retirement-plan filing, a nonprofit's Form 990, an SEC
filing, some state registrations, and healthcare provider registrations. It is often not findable at
all — that is fine, list the entity without one. **Never guess or construct an EIN.**

**Signals that a second entity exists even when you cannot name it yet:**

- Job postings under a slightly different company name, or a careers page whose application form
  names a different legal entity
- Benefits or retirement filings whose plan sponsor name is not the trading name
- A licence held by one entity and the website run by another
- The owner listed as officer of several companies at the same address
- Field staff described as employed by a name the marketing site never uses

**For each entity, capture:** name, state, what it does (office, field staff, per-state operating
entity, staffing arm, parent), headcount, EIN if published, and where you found it.

**Then total the headcounts.** The number that goes in `Employee_Count` is the sum across every
entity, never one entity's figure. If one entity has no headcount, still list it and say the total is
a floor. A total marked as a floor is honest and useful; a headquarters-only number is misleading.

### Provider detection — all five routes, not the first one that works

Ranked by hit rate, but **attempt every one** before recording the provider as unestablished:

1. Job posting naming the system
2. ATS fingerprint (above)
3. Employee/benefits portal link on their site — `workforcenow.adp.com`, `paychexflex.com`,
   `gusto.com`, `paylocity.com`, `ultipro.com`, `myisolved.com`, `paycomonline.net`
4. Form 5500 Schedule C
5. Glassdoor and Indeed reviews, which mention the payroll system constantly:
   `WebSearch: site:glassdoor.com "{co}" payroll` · `WebSearch: site:indeed.com/cmp "{co}" reviews`

Plus:

```
WebSearch: "{co}" "employee portal" OR "paystub" OR "timeclock" login
WebSearch: "{co}" W-2 OR paystub employee login
```

Write it as *"likely ADP — named in a Jul 2026 job posting"* with the link, into
`Current_PR_Provider_new`. Never as a bare confident name.

### News, growth and disqualifiers

```
WebSearch: {co} {st} expansion OR acquisition OR layoffs 2026
WebSearch: "{co}" WARN notice {st}
WebSearch: "{co}" news 2026
WebSearch: "{co}" {st} chamber of commerce OR "business journal"
WebSearch: "{co}" award OR "best places to work" OR anniversary
```

Expansion, new locations, acquisitions → growth. Layoffs, closures, dissolution → disqualifiers. Also
catches publicly announced PEO relationships.

---

## Contact digging — filling gaps and proving what ZoomInfo gave you

ZoomInfo is the first pass, not the last. Two jobs: fill what is missing, and **check what is already
there**, because a wrong-but-present value is more damaging than a blank one.

**`verification.md` is the authority** — credibility ladder, the four checks in order, and the ladder
for finding a replacement when the person has left. Read it.

| # | Where | What it gives |
|---|---|---|
| 0 | `WebSearch: "{person}" linkedin {co}` and `WebSearch: "{person}" linkedin` | **current employer and title, straight from them.** Everything else is moot if they left |
| 1 | `WebFetch {domain}/team` `/about` `/leadership` `/staff` `/contact` | titles, direct lines, sometimes emails. Highest-trust source the company controls |
| 2 | `WebSearch: "{person}" "{co}" email OR contact OR phone` | published contact details |
| 3 | `WebSearch: "{person}" "{co}" appointed OR promoted OR joined OR named` | current title and start date from a press release |
| 4 | `WebSearch: "{co}" "@{domain}" email` | the org's email pattern |
| 5 | `WebSearch: "{person}" "{co}" speaker OR conference OR bio` | bios carry titles and tenure |
| 6 | State licence registries, for licensed operators | the named administrator of record |
| 7 | `WebSearch: "{co}" {st} secretary of state officers` | the officer of record — often the owner, with an address |
| 8 | `WebSearch: "{person}" "{co}" site:youtube.com` | a conference talk or company video with a title card |
| 9 | Trade association and chamber directories | member listings carry direct lines surprisingly often |

**Escalate when the phone is still missing** — this is the gap that most often ends a lead, so it earns
extra calls:

```
WebFetch  {domain}/locations  /offices  /branches
WebSearch: "{co}" "{st}" phone directory OR "call us"
WebSearch: "{person}" "{co}" "direct" OR "ext" OR "extension"
WebSearch: site:bbb.org "{co}"
WebSearch: "{co}" google business profile {st}
WebSearch: "{co}" {st} "contractor license" OR "business license"
```

**Infer the email pattern, don't guess the email.** If two published addresses at the domain both read
`firstinitial.lastname@`, then `j.doe@acme.com` is a *pattern-derived* address — write it and say so.
With one example, or examples that disagree, the pattern is unproven: leave the field empty rather
than writing a guess.

### Verify before writing

Every contact value gets one cheap check, and the result of that check goes in the note.

| Value | Check |
|---|---|
| Mobile / direct | Does the area code fit the company's city? Does it match a published main line plus extension? |
| Email | Does the domain match the company website? Does it fit a pattern seen in two or more published addresses? |
| Title | Confirmed by the company's own site or a dated press release, not ZoomInfo alone? |
| Any value | Does a second independent source agree? |

**Say "verified" only when a check actually passed.** Otherwise write the value with `unverified`
beside it. Never present an unchecked value as confirmed. Neither label is a score.

### When the owner has no direct phone

This now triggers a deliberate second search rather than a shrug. The owner **stays** the primary; you
go find the most senior reachable person and put them in an additional-contact block. The ranking and
the field map are in `zoho-writeback.md`. The queries:

```
WebFetch  {domain}/team  /leadership  /contact
WebSearch: "{co}" CFO OR controller OR "vice president" OR "general manager" {st}
WebSearch: "{co}" "director of operations" OR "office manager" contact
mcp__ZoomInfo__search_contacts_v2(companyIdList: [...],
  managementLevelList: ["C Level Exec", "VP Level Exec", "Director"],
  requiredFieldsList: ["phone"], sort: "-contactAccuracyScore", pageSize: 25)
```

Note `requiredFieldsList: ["phone"]` rather than `["mobilePhone"]` — the whole point is a working
number, and a direct line is better than a cell you cannot verify.

---

## The `Description` bullets — Step 4, first half

Short. Bullets. **Nothing that is already in a field.**

The full rules and worked examples are in `zoho-writeback.md` under "`Description` — the About, in
bullets." The searches that feed it are round 1 and the news queries above; you almost never need
dedicated calls for it.

The test is whether a rep could read it in fifteen seconds and sound like they had looked. Six bullets
maximum, one to two lines each, and nothing repeating `Employee_Count`, `City`, `State`, `Website`,
`Current_PR_Provider_new` or the LinkedIn URL fields.

---

## The icebreakers — Step 4, second half

**Social media is the primary source, not a supplement.** The previous version of this skill produced
icebreakers from press releases and awards, and the user's verdict was that the social ones are the
best and were missing entirely. Fix that by making the social sweep a required round, fired as one
batch, before anything else is considered.

### The social sweep — run every line

Person first, company second. Send them together.

| # | Query | Platform |
|---|---|---|
| S1 | `WebSearch: "{person}" "{co}" linkedin post` | LinkedIn — the person |
| S2 | `WebSearch: site:linkedin.com/posts "{person}"` | LinkedIn — posts specifically |
| S3 | `WebSearch: site:linkedin.com/posts "{co}"` | LinkedIn — company page posts |
| S4 | `WebSearch: site:facebook.com "{co}" {st}` | Facebook — the company page |
| S5 | `WebSearch: "{person}" facebook {co}` | Facebook — the person |
| S6 | `WebSearch: site:instagram.com "{co}"` | Instagram — often the best material at trades and hospitality |
| S7 | `WebSearch: site:x.com "{co}" OR site:twitter.com "{co}"` | X |
| S8 | `WebSearch: site:youtube.com "{co}"` | YouTube — company videos, owner interviews |
| S9 | `WebSearch: site:tiktok.com "{co}"` | TikTok — real for trades, restaurants, retail, home services |
| S10 | `WebSearch: "{person}" OR "{co}" reddit OR "industry forum"` | candid mentions |

**Fetch the ones that look alive.** Facebook, Instagram, YouTube and X company pages are publicly
readable and `WebFetch` works on them often enough to be worth one call each when a search suggests
recent activity. Read the two or three most recent posts and take the exact wording.

**LinkedIn is the exception: do not fetch or scrape linkedin.com.** It blocks unauthenticated
requests, and a blocked fetch wastes a call. Use search snippets — the snippet usually contains the
quotable sentence, which is all you need. Take the profile URL from ZoomInfo's `externalUrls` and put
it in the `Linkedin` field.

**When the person's own accounts are quiet, work the company accounts.** At a family-owned firm the
company Facebook page is frequently written by the owner personally, and it reads that way. That
counts as their own words if the post is signed or clearly first-person; say which it is.

### Then the non-social ladder, after the sweep

Not instead of it:

| # | Query | Looking for |
|---|---|---|
| A | `WebSearch: "{person}" "{co}" interview OR podcast OR panel` | speaking, long-form quotes |
| B | `WebSearch: "{co}" anniversary OR award OR "named" OR charity OR sponsor 2026` | milestone worth congratulating |
| C | `WebSearch: "{person}" alumni OR volunteer OR "board of" OR coach OR marathon` | shared ground |
| D | `WebSearch: "{co}" {st} local news OR "business journal" 2026` | local trade press |
| E | ZoomInfo scoops from Step 2, and the news search from round 1 | free, already in hand |

### What makes a usable icebreaker

The test is **comment-worthy**: could a stranger raise this on a cold call and have it land as interest
rather than as a script? Specific, recent, public, and flattering-or-neutral.

Ranked by how well they actually work:

1. **A post or comment the person wrote themselves** — LinkedIn, Facebook, Instagram, X. Best of all,
   because it invites a personal reply
2. **A company social post in the owner's voice** — common at small firms, nearly as good
3. **A quote from them in an article, podcast or video**
4. **A company milestone with their fingerprints on it** — new location, anniversary, acquisition,
   award, a big hire
5. **A shared affiliation** — alma mater, industry association, board seat, charity
6. **A visible personal interest** — a sport, a cause, a hobby they post about

**Every icebreaker carries four things.** Without all four the rep has a fact, not an opening:

- **What** was said or done, **in their own words, quoted verbatim** where you have them
- **When** — an actual date, never "recently"
- **Where** — the platform and the surrounding context, so the rep is not blindsided
- **The angle** — the natural line from this into a conversation about payroll

Compare:

> ✗ Posted about the Newark opening.

> ✓ She posted photos from the Newark facility opening, wrote "took us three years and I still can't
> believe it," and said they are hiring 40 in the next quarter. Congratulate the opening, then ask
> how payroll is handling forty new people across a second location. (her LinkedIn) [7/12/2026]

The second one a rep can read once and dial. The first they have to go research themselves, which
means they will not use it.

**Quote, never paraphrase.** A rep repeating someone's own phrasing back to them lands completely
differently. The quoted sentence is the entire product of this step.

**Three to six per lead, with at least one from the person's own social account.** If the whole sweep
plus the non-social ladder produces nothing real, skip the note and say so **to the user in
conversation** — never in the CRM.

**Openers only.** Anything that is really a research finding — a retirement plan, a state
registration, an HR department of one, a benefits renewal date — belongs in the `PAYROLL FINDINGS`
note, not here. The last run put three such items in the icebreakers and it made the note unusable.
The test is whether a rep could say the line out loud to a stranger in the first minute of a call.

**And write them in plain English, with the source and date at the end in brackets.** Not
`LI 12Jul26 — posted "..."` but `She posted "..." (her LinkedIn) [7/12/2026]`. Dates are US numeric —
8/19/2026 — round brackets for the source, square brackets for the date, both at the very end.

Avoid: family and children, health, politics, religion, personal finances. Anything behind a login.
Anything you inferred rather than read. **A fabricated icebreaker is worse than none** — it collapses
in the first sentence of the call.

---

## Optional — only when something triggers them

| Trigger | Extra check |
|---|---|
| Union language in postings | `WebSearch: {co} NLRB case unfair labor practice` |
| Nonprofit | `https://projects.propublica.org/nonprofits/api/v2/search.json?q={co}` — the 990 gives headcount, payroll spend and officer names |
| Government-contract language | `https://api.usaspending.gov/` — Davis-Bacon obligations |
| Funding mentioned | `WebSearch: {co} SEC Form D filing` |
| Restaurant, retail, hospitality | `WebSearch: site:yelp.com "{co}"` — location count and staffing complaints |
| Healthcare, education, licensed trades | the state licence registry — the administrator of record is often the owner |
| Construction | `WebSearch: "{co}" building permits {st}` — active project volume |

---

## Crossing signals — where the value is

Single facts are mildly interesting. Combinations are the sale.

| Combination | Meaning |
|---|---|
| Payroll role open **+** DOL overtime violation | got burned, fixing it — call today |
| Hiring surge **+** 5500 participant growth | real growth, confirmed twice |
| Multi-state postings **+** few registrations | compliance gap they may not know about |
| Contractor-heavy postings **+** misclassification case | live, quantified risk |
| New CFO **+** legacy provider named | a review is likely underway and the incumbent is known — still call the owner, and mention it |
| Growth **+** payroll-vendor ATS | outgrowing a bundled SMB suite |
| Benefits renewal date **+** open HR role | the whole stack is in play at once |

Look for the first row deliberately. No purchased list will surface it.

**Report the combination, not a rating.** "Payroll Specialist opening Jul26 alongside a Mar23 DOL
overtime finding" is the finding. Do not compress it into a score — the user has said plainly they do
not want one.

---

## Disqualifiers — record them as you go

A lead is worth stopping on when it is:

- **Dissolved or delinquent** per the state registry, or publicly closing (a WARN notice)
- **Already a customer** — check the domain against Zoho Accounts and Contacts, and set
  `Existing_Client` to `Yes`
- **Below the client's minimum headcount.** Ask once what that floor is and reuse the answer
- **Locked into a PEO** — TriNet, Insperity, Justworks. Not dead, but a PEO unwind is a longer and
  different pitch, so it routes to whoever handles those

Record what you saw and where, tell the user, move on. There is no `Disqualify_Reason` field any more —
that field is retired. Say it in conversation and put the evidence in the `RESEARCH` note.

---

## Name matching

"Acme Corp" in Zoho versus "ACME CORPORATION" in a federal record. Strip punctuation and legal
suffixes (Inc, LLC, Corp, Ltd, LP, PLLC) before comparing; use state and city to disambiguate.

If several unrelated companies share the name and none is clearly right, **do not pick one.** Record it
as ambiguous, write nothing to the CRM, route to a human.
