---
name: zoho-lead-profiler
description: Researches specific leads the user names in Zoho CRM for a payroll company — never auto-selecting them. Verifies purchased ZoomInfo data against better sources — still employed there, title current, phone and email right. Finds the top decision-maker — owner, founder, partner, else CEO or president — and makes them the primary contact; when they have no direct phone, keeps them primary and adds a reachable senior second in the additional-contact fields. Digs deep, with a completion bar per lead and escalation ladders when a search is empty. Writes every finding into its real Zoho field rather than a note, never writes "no match" or any other absence, and never a fit score or tier. Runs a mandatory social sweep — LinkedIn, Facebook, Instagram, X, YouTube, TikTok — then builds icebreakers from the person's own posts, quoted verbatim. Use for "profile this lead", "research Acme Corp", "is this person still there", "find the owner", "icebreakers for this call". Leads already in the CRM, not lead gen.
---

# Payroll Lead Profiler

Turn a thin Zoho lead into a record a rep can call from: the **verified** top decision-maker sitting in
the primary contact fields, a plain-English account of what the company actually does, what the
government has on record about them, and icebreakers in the person's own words.

**The client sells payroll.** That decides what matters. A funding round is mildly interesting. An
open Payroll Specialist role plus a Department of Labor overtime finding is a call to make this
morning. Read every fact through *does their payroll hurt?*

**Nine rules shape everything below.** The last five are the ones earlier versions kept breaking, so
they are stated as mechanics rather than as preferences.

*The user picks the leads.* Never select leads on your own — not the oldest, not a random sample, not
"the next five." Profiling a lead the rep did not ask for spends credits on somebody else's priority.
Step 1 exists to get an explicit list, and nothing happens before it does.

*Purchased data is a starting point, not a fact.* Almost everything on a Zoho lead arrived from
ZoomInfo, and it was true on the day it was collected. People leave, get promoted, change numbers.
Every contact fact gets checked against something more credible before it is written back or handed
to a rep. `references/verification.md` defines what "more credible" means and how to check.

*Report findings, never absences.* Every fact carries a source and a date. A field with nothing behind
it stays empty and goes unmentioned — no "not found," no "none," no "no issues," no inventory of
searches that came back dry. Silence is the correct output for a miss; a reader should never have to
wade through what you failed to find to reach what you found. When unsure, say unsure or write nothing.

This has been the single most persistent failure of this skill — records still arrive carrying a
`COMPLIANCE` note that reads "no match." Saying it more firmly has not worked, so it is now a
**mechanical pre-write filter** in `references/zoho-writeback.md`: a banned-phrase pass over the
payload, run between building it and calling the API, that deletes the offending line, then drops any
bullet, section, note or field key the deletion left empty. Run it every time. There is exactly one
place an empty search may be mentioned — out loud to the user in the Step 6 report, where a human can
react to it. Never in Zoho.

*Fields first, notes second.* Every finding that has a Zoho field goes in that field. The provider goes
in `Current_PR_Provider_new`, the headcount in `Employee_Count`, the person's LinkedIn in `Linkedin`,
the benefits carrier in `Benefits_Carrier`. Reps filter and sort on fields and they skim notes, so a
finding buried in a note is a finding half-delivered. Notes exist only for what a field genuinely
cannot hold: multi-line evidence, quoted language, dated narrative with a link. The field map in
`references/zoho-writeback.md` was verified against the live schema and it is the authority — several
fields the old version wrote to, `Annual_Revenue` and `No_of_Employees` among them, **do not exist on
this org**, and those writes were failing silently.

*Plain English, always.* A rep reads this record cold, sixty seconds before dialling, and they are
not an analyst. **No source codes, no shorthand, no unexplained jargon** — not `LI 12Jul26`, not
`ATS`, not `Form 5500 SchC PY24`, not `DOL WHD`, not `NPI 1780029322`, not `priority 1`. Write "on
LinkedIn", "their online job-application system", "their federal retirement-plan filing for 2024",
"a US Department of Labor wage investigation".

**Dates are US numeric with no leading zeros — 8/19/2026.** Never `19 August 2026`, never `14Jul26`,
never `2026-08-19`. A month with no day is `8/2026`.

**Sources and dates go at the very end of the line, in two kinds of brackets** — round for the
source, square for the date, source first:

```
· They now run offices in six states, so each one needs its own payroll tax account and
  unemployment insurance rate. (company website) [8/18/2026]
```

Never bury a date or a source mid-sentence. This applies to the notes and to the `Description`.

And **explain every finding.** Each item says three things in plain sentences — what you found, where
it came from, and **why it matters for payroll.** That third part is the one that keeps getting
dropped, and it is the whole reason the record exists. A technical term gets half a sentence of
explanation the first time it appears. Short is good; understandable comes first. The replacement
table and worked examples are in `references/zoho-writeback.md` under "Plain English".

*One company on paper is often several.* Check every lead for related legal entities — an office
company and a separate field-staff company, one entity per state, a staffing arm, a holding company.
Each is a separate employer with its own federal employer ID number, its own payroll registration and
its own W-2s.

**The headcount written to Zoho is the total across all of them**, never the headquarters figure.
ZoomInfo reports the shell: on a recent lead it said 8 employees while the company itself said
100-plus clinicians across four entities. Total what you can count, list what you cannot, and say the
total is a floor when one entity is unmeasured. Write the breakdown into a `COMPANY STRUCTURE` note —
name, state, what it does, headcount, employer ID if published — and never guess an ID.

*The company description is mandatory, and payroll findings come first.* `Description` is never left
empty — a recent run skipped it and the record was much harder to use. It opens with one plain
sentence saying what the company is, then up to six bullets.

And the most important note on any record is `PAYROLL FINDINGS`, written first: everything bearing on
how these people get paid, in priority order. **Payroll-relevant material does not go in the
icebreakers.** A retirement plan, a benefits renewal, an HR department of one, a workforce spread over
six states — those are findings. Icebreakers are conversation openers and nothing else. Zoho takes as
many notes as you want, so split a topic into its own note rather than overloading one.

*Every point gets a bold headline.* Zoho notes are a plain-text field — tested on 8/23/2026 by
posting `<b>`, `<strong>` and `**markdown**` and reading them back byte-for-byte, so **never write
HTML tags, asterisks or markdown into a note.** They show up literally. The only thing that renders
heavy is Unicode mathematical sans-serif bold, so headlines are written in those characters:

```
𝗛𝗥 𝗜𝗦 𝗢𝗡𝗘 𝗣𝗘𝗥𝗦𝗢𝗡, 𝗣𝗔𝗥𝗧-𝗧𝗜𝗠𝗘 — Aurelie Benittah, the Operations Manager, covers both HR and the
clinical side. (their team page) [8/18/2026]
```

Headline, em dash, detail. The headline is a two-to-eight word summary — what a rep takes away if
they read nothing else. Section headings get the same treatment.

**Only the headline is bolded.** Zoho's search cannot match bold characters against ordinary typing,
so every fact, name, number, date and source stays in normal characters where search can find it.
`references/zoho-writeback.md` has the alphabet and the full rule.

*No scoring.* The user has said plainly they are not interested in it. Do not produce a fit score, a
tier, a temperature, a priority grade, a confidence percentage or a letter rating — not in a field, not
in a note, not in the run report, not in conversation. `Lead_Rating` and `Lead_Rate` are never written.
The product of this skill is information: what you found, where, when, and what it means for a payroll
conversation. Whether the lead is worth calling is the rep's judgement, and they make it better from
facts than from a number you invented.

`verified` and `unverified` are **not** scores and must survive. They record whether a specific check
passed on a specific value, which changes how a rep dials.

## Required connectors

- **Zoho CRM** (`mcp__Zoho_CRM__*`) — where leads live and findings land
- **ZoomInfo** (`mcp__ZoomInfo__*`) — the contact search, plus company scoops and intent
- **WebSearch / WebFetch** — verification, public records, the About write-up and icebreakers

ZoomInfo is used **on people, not to re-pull firmographics** — those already came from ZoomInfo and
re-querying burns credits to return what is already on the record. Its job here is to open Step 2:
find the right person at the company, fill obvious gaps, and surface scoops worth mentioning on a
call. Whatever it proposes is then verified elsewhere.

---

## Step 1 — Get an explicit list of leads from the user

**Do not choose leads.** The user names them. Three ways that arrives:

**They named leads outright** — "profile Acme Corp and Bellweather LLC", a pasted list of company
names, or Zoho record IDs. Resolve each to a record and go. If a name matches more than one lead, ask
which one before researching; picking for them is how the wrong record gets written.

```
mcp__Zoho_CRM__searchRecords(module: "Leads", criteria: "(Company:starts_with:Acme)")
mcp__Zoho_CRM__getRecord(module: "Leads", id: "<id>")
```

**They asked vaguely** — "profile some leads", "work my pipeline", "run the next batch". Do not
interpret this as permission to choose. Show them candidates and wait.

Ask what should narrow the list if nothing was given — owner, state, industry, date range, lead status
— then pull a page and present it as a numbered table:

```
mcp__Zoho_CRM__executeCOQLQuery(query:
  "select id, Company, City, State, Industry, First_Name, Last_Name, Designation, Owner, Created_Time
   from Leads
   where <the user's filter>
   order by Created_Time desc limit 25")
```

| # | Company | City, ST | Contact on record | Industry | Added |
|---|---|---|---|---|---|

Then: *"Which of these should I profile? Give me the numbers."* Accept any subset in any order.
Nothing is researched until they answer — and if they reply with something like "all of them," that is
an explicit choice and it counts.

**They gave a lead already in the conversation** — a record open from earlier, a name they just
mentioned. Confirm which record you resolved it to in one line, then proceed.

**Two things not to do.** Do not add leads the user did not name because they look promising — offer
them at the end instead. Do not silently cap a long list; if they hand you thirty, say that thirty
will take a while and ask whether to run all or start with the first ten.

If a lead the user named turns out to be missing, dissolved, or already a customer, say so and ask
whether to continue with the rest rather than substituting a different lead.

## Step 2 — Find and verify the right decision-maker

Read `references/verification.md` before this step. It has the credibility ladder, the exact checks,
and how to find the right person when the record has the wrong one.

### Who we are actually trying to reach

**The top decision-maker.** One person per company: whoever can say yes to changing payroll providers
without asking anyone. They belong in the lead's **primary contact fields**.

| Priority | Titles | Verdict |
|---|---|---|
| **1** | Owner, Co-owner, Founder, Co-founder, Proprietor, Partner, Managing Partner, Managing Member | **the primary** — preferred over everyone below, including a hired CEO |
| **2** | CEO, President, Chief Executive, Managing Director | **the primary** when no owner, founder or partner is reachable |
| — | CFO, Controller, VP Finance, Treasurer, COO, CIO, HR Director, VP People, Office Manager | not the primary. If one of them was the contact on the lead, they move to an **additional contact** |
| — | Executive Director, Administrator, General Manager | primary **only** in licensed operators (healthcare, education, non-profits) where the title genuinely is the top seat and no owner or CEO exists |
| — | Assistant, Executive Assistant, Chief of Staff, Secretary | a route in, never the buyer. Additional contact if they were already on the lead |

This is a deliberate narrowing. A CFO owns the payroll budget and knows the pain, which is why they
look tempting as the primary — but this client's sale closes with the person whose name is on the
business, and reps who open with finance and HR spend weeks getting handed sideways. When both an
owner and a CEO exist, take the owner: at closely-held companies the hired CEO still asks them.

**Clinical and departmental "Chief" titles are not executives.** Chief of Psychiatry runs a
department. Same for Chief Engineer, Chief Steward. Ignore them.

**Small companies are the normal case, not the exception.** A twenty-person firm usually has an owner
listed on the homepage and no ZoomInfo executive record at all. Look at the website before concluding
there is nobody to call.

### Start with the name on the record, and find out what they are

Look the person up by name first. Often they are already the right person, and when they are, the
whole job becomes deepening their record rather than replacing it.

```
mcp__ZoomInfo__enrich_contacts(contacts: [{personId} or {firstName,lastName,companyName}],
  requiredFields: ["firstName","lastName","jobTitle","managementLevel","email","phone",
                   "mobilePhone","directPhoneDoNotCall","mobilePhoneDoNotCall",
                   "contactAccuracyScore","companyName","externalUrls","lastUpdatedDate"])
```

Read `jobTitle` and `managementLevel` against the priority table above. That answers the only question
that matters here — **what level of decision-maker is this?** Two paths follow.

**They are priority 1 or 2 — keep them and go deeper.** This is the good case. Spend the effort on
making this record callable — direct dial from the company's own site, mobile, best email, LinkedIn
profile URL from `externalUrls`, and anything the company publishes about their role. Then run them
through the four checks below. Their name stays exactly where it is.

Whether the additional-contact fields stay empty now depends on one thing: **can a rep actually reach
this person?** See the rule immediately below.

**They are anything else — find who does hold the top seat.** A Controller or an office manager is a
real person worth keeping, just not the primary. Search the company for the owner or CEO:

```
mcp__ZoomInfo__search_contacts_v2(companyIdList: [...],
  managementLevelList: ["C Level Exec", "Owner"],      // owners file separately from C-suite
  requiredFieldsList: ["mobilePhone"], sort: "-contactAccuracyScore", pageSize: 25)
```

**Ask for owners explicitly.** ZoomInfo files owners, founders and partners separately from C-level
executives, so a C-level-only filter returns the hired CEO and silently hides the person we actually
want. **Never combine `jobTitleList` with `managementLevelList`** — they intersect to zero and fail
silently, which reads as "this company has no executives" when it means "you asked wrong."

Rank what comes back by the priority table and make the top person the primary. **The person who was
on the record moves into an additional-contact block** (Step 5) — they are not deleted, just demoted,
because a Controller or an office manager is often exactly who a rep ends up speaking to first. That
displaced contact is the only thing those fields are for; there is no separate hunt for extra people
to fill them.

**Run the company search anyway when the name check comes back empty or stale** — a contact ZoomInfo
cannot find, or last touched years ago, is a good sign the seat has changed hands.

### When the owner has no direct phone — keep them, and add somebody reachable

A missing phone number **does not demote the owner.** They can still say yes, they are still the
person the pitch is for, and they stay in the primary contact fields. What it means is that the rep
needs a second door into the building, and finding one is now part of the job rather than an optional
extra.

**The rule fires when the primary decision-maker has no direct dial and no mobile** — a switchboard
number does not count as a direct line here — **or when you have a phone for them but no email you can
stand behind.**

When it fires, go and find one more person on purpose: the most senior person at the company who has
**both a direct phone and a defensible email**. Walk down co-owner and partner, then president or CEO,
then COO and general manager, then CFO, VP Finance and Controller, then HR leadership, and only then
an office manager or executive assistant. Stop at the first person who is genuinely reachable.

That person goes into **additional contact block 1**, with their real title and the nearest picklist
value for their functional role. `references/zoho-writeback.md` has the exact field map and the full
ranking — and the API names in those blocks are inverted relative to their labels, so read it rather
than guessing.

This overrides the old instruction not to hunt for extra people. Both blocks can be in use at once: a
displaced Controller in one, a reachable executive in the other, ordered by who the rep should try
second. Say in the `CONTACT` note which is which and why there are two.

**Do not lower the verification bar to fill the slot.** An additional contact written in with a guessed
email is the same failure as a wrong primary. If nobody at the company publishes contact details,
leave the blocks empty and put the main switchboard line in `Company_Number` — that is a real finding,
and a rep can work a switchboard.

Batch contacts into as few enrich calls as possible — up to 10 per call. `externalUrls` usually
carries the LinkedIn profile URL; keep it, both the verification check and Step 4 need it.

### Then verify, in this order

1. **Still employed there?** LinkedIn current position first, then the company's own team or
   leadership page, then dated press. This is the check that matters most — everything else is
   worthless if it fails.
2. **Title current, and is it priority 1 or 2?** The company's own site and recent press outrank
   ZoomInfo. Watch for promotions ZoomInfo missed. **Write their actual title** — the specific one
   they use, not a category you assigned them.
3. **Phone still theirs?** Area code against the company's city, direct line on their own site,
   corroboration, `lastUpdatedDate`. Label `verified` or `unverified` — never leave it ambiguous.
4. **Email still theirs?** Live domain, current published pattern. Infer a pattern from two examples;
   never invent an address.

**When a more credible, more recent source disagrees with ZoomInfo, the other source wins.** Take the
better value.

**Cross-check company identity.** ZoomInfo sometimes conflates similarly-named companies. Does the
email domain match the company website, and does the area code fit the location? Failing both means
the record is conflated — drop it rather than writing it in.

Then pull company scoops and intent — cheap, and both feed the About write-up and icebreakers:

```
mcp__ZoomInfo__search_scoops(...)     // recent company events
mcp__ZoomInfo__enrich_intent(...)     // topics they are actively researching
```

**Intent on payroll, HR, benefits or workforce topics is a strong buying signal.** It belongs in the
TIMING note.

## Step 3 — Research the company, one parallel batch per lead

Follow `references/search-recipes.md` exactly. It now runs in **four rounds**, each fired as a single
message with many parallel tool calls: the company batch, the person batch, the mandatory social
sweep, and then escalation aimed at whatever is still missing.

**Budget: eighty tool calls per lead** across Steps 2–4. That is a ceiling so one stubborn lead cannot
eat the whole run — **it is not a target to stay under.** Most leads should use a real fraction of it.

**There is no stop-early rule any more, and the two-follow-up cap is gone.** Both were in the previous
version and both produced records that were too thin to call from. Open the job posting. Open the news
article. Fetch the second page of the registry. Depth is the point.

**A lead is done when the completion bar in `search-recipes.md` is met** — a verified decision-maker
with a current title, a reachable phone somewhere on the record, a defensible email, a sourced
headcount, a provider hypothesis or all five detection routes attempted, the public-record sweep run,
the social sweep run, three or more icebreakers with at least one from the person's own social, and the
`Description` bullets written. Falling short on an item after its escalation ladder is exhausted is a
legitimate outcome; falling short because you stopped after seven searches is not.

**Keep digging when a search comes back empty.** Every gap has an escalation ladder in
`search-recipes.md` — alternative job boards when the careers page is bare, court and OSHA records
when the DOL search misses, FreeERISA and form5500.com when EFAST does not surface, Glassdoor and
employee-portal fingerprints when no posting names the provider, licence registries and BBB when no
phone is published. Work the ladder before recording a gap.

**Disqualify as you go**, not in a separate pass. A lead is worth stopping on when it is:

- **Dissolved or delinquent** per the state registry, or publicly closing (a WARN notice)
- **Already a customer** — check the company's domain against Zoho Accounts and Contacts before
  spending research on them, since nothing else will surface it
- **Below the client's minimum headcount.** Ask once what that floor is and reuse the answer
- **Locked into a PEO** — TriNet, Insperity, Justworks. Not a dead lead, but a PEO unwind is a much
  longer and different pitch, so it routes to whoever handles those rather than into the normal queue

Record what you saw and where, tell the user, move on to the next lead.

## Step 4 — About the company, then icebreakers

The purpose here is a **cold call.** The rep has ten seconds to sound like someone who knows this
business, and then needs something specific enough that the person on the other end wants to respond.
Those are two different jobs, so produce two things.

### The company description — mandatory, plain English, in the `Description` field

**This is no longer a paragraph and no longer a note.** The previous version wrote four to six
sentences of prose into an `ABOUT` note, and the user's verdict was that it is far too long and mostly
restates things already on the record. Both problems have the same fix.

**This field is mandatory. Never finish a lead without it** — it was left empty on a recent run and
that made the whole record harder to use. If you researched the company at all, you know enough.

**One plain opening sentence saying what the company is, then up to six bullets**, one to two lines
each, written into `Description`, where it sits at the top of the record and a rep reads it without
opening anything. The opening sentence is not optional — "Achieve Behavioral Therapy provides in-home
and school-based therapy for children with autism, across six states." is the line a rep reads first.

**Keep sources and dates out of the Description unless a line genuinely needs attribution** — the
Description is the plain answer to "who are these people", and citations break the read. When one is
needed, it follows the same convention as everywhere else: source in round brackets, date in square
brackets, at the end of the line.

**The hard rule: never write anything a field already holds.** The headcount is in `Employee_Count`.
The city and state are in `City` and `State`. The provider is in `Current_PR_Provider_new`. The website
is in `Website`. The LinkedIn page is in `LinkedIn_Company_Profile_URL`. Repeating any of those here is
padding, and padding is what made the last version unreadable. Revenue is the single exception, because
this org has no revenue field at all — it may appear once, with its source.

What is left is the thing no field can hold:

- **What they actually do**, concretely — the work, not a category. "Commercial HVAC installer doing
  hospital and data-centre work" passes. "Provider of building services solutions" is a label that
  tells a rep nothing.
- **How the workforce is shaped** — shift-based hourly crews, seasonal spikes, union agreements, tipped
  staff, 1099-heavy, multi-state. This is the payroll-relevant part and it is usually the most useful
  line on the record.
- **Ownership or history**, one line, only when genuinely distinguishing.
- **What changed recently**, one line, dated.

No elaboration, no scene-setting, no restating the obvious. If you could not establish the founding
year, the bullets simply do not mention a founding year — writing "founded date unknown" spends the
reader's attention on your search history and gets deleted by the pre-write filter anyway.

Most of the material is already in hand from Step 3 and the ZoomInfo record. Worked examples of good
and bad bullets are in `references/zoho-writeback.md`.

### The icebreakers — so the call has somewhere to go

Three to six, each **genuinely comment-worthy**: something the person or company said or did that a
stranger could plausibly bring up without it sounding like a script. Follow the icebreaker section of
`references/search-recipes.md`.

**Social media is the primary source, not a supplement.** The last version leaned on press releases and
awards and produced no social material at all, which the user has called out as the biggest miss —
those are the best icebreakers there are, because they are the person speaking in their own voice about
something they chose to talk about.

So the social sweep is a **required round**, fired as one parallel batch before anything else is
considered: LinkedIn (the person's posts and comments, and the company page), Facebook, Instagram, X,
YouTube, TikTok, plus Reddit and industry forums. The full query list is in `search-recipes.md`, and it
runs even when the earlier rounds already turned up something usable.

**Icebreakers are conversation openers and nothing else.** The last run filled this note with
research — a retirement-plan question, a state-registration finding, an observation about HR being one
person. All three are payroll findings and belong in the `PAYROLL FINDINGS` note. The test is whether
a rep could say the line out loud to a stranger in the first minute and have it land as interest. If
not, it is a finding. When something is genuinely both, put the detail in the findings note and one
line here.

**At least one icebreaker must come from the person's own social account, and social should be the
majority of the list.** When their personal accounts are quiet, work the company accounts — at a
family-owned firm the company Facebook page is often written by the owner personally and reads that
way; say which it is. Only after the sweep do you fall back to podcasts, panels, local and trade press,
awards, charity and alumni involvement, and ZoomInfo scoops.

**Quote what they wrote, word for word.** This is the single most important thing about an icebreaker.
When someone posted on LinkedIn or Facebook, reproduce their actual sentence in quotation marks, name
the platform, and date it — because a rep who repeats a person's own phrasing back to them lands
completely differently from one working off a paraphrase. Paraphrasing throws away the only part that
was worth finding.

**Every icebreaker carries four things**, because without them a rep has a fact rather than an opening:

- **What** was said or done — their actual words, quoted, whenever you have them
- **When** — a date, not "recently"
- **Where** — the platform and the surrounding context, so the rep is not blindsided by details
- **The angle** — the natural line from this into a conversation about payroll

"Posted about the Newark opening" is a fact, and useless. "LinkedIn 12Jul26 — posted photos from the
Newark facility opening and wrote 'took us three years and I still can't believe it,' adding that
they're hiring 40 in the next quarter. Congratulate the opening, then ask how payroll is handling
forty new people across a second location" is an icebreaker.

**Personal beats corporate.** A post the owner wrote themselves outperforms a company press release
every time, because it invites a reply from them personally.

**About LinkedIn.** Use the profile URL from ZoomInfo's `externalUrls`, and find public posts via web
search. **Do not attempt to scrape LinkedIn** — it blocks unauthenticated fetches, and LinkedIn sued
the largest LinkedIn data API out of existence in 2026. Search results and snippets are fine, and the
snippet usually contains the quotable sentence; automated scraping behind the auth wall is not. If
nothing surfaces, move on — local press and trade publications are often more fruitful anyway.

Avoid family, health, politics, religion, and personal finances. If nothing real surfaces, skip the
note entirely. A fabricated icebreaker is worse than none, because it collapses in the first sentence
of the call.

## Step 5 — Confirm and write

Show a compact table, one row per lead:

| # | Company | Primary contact (verified?) | Title | Additional contacts | Emp | Likely provider | What's timely |
|---|---|---|---|---|---|---|---|

Call out in one line any lead where the person on the record is being replaced as primary — that is
the change the user most needs to see before it happens.

Then ask exactly one question — **"Write these to Zoho?"** with **Yes** and **No**. Use
`AskUserQuestion` so it renders as a choice. Nothing else: no per-lead confirmations, no follow-up
questions about fields or picklists. One decision, then act.

On **No**, write nothing and stop. On **Yes**, write per `references/zoho-writeback.md`. What matters
most:

- **Run the pre-write filter over the whole payload first.** Fields and notes together, before any API
  call. Banned-phrase pass, then cascade the deletions upward: an emptied bullet is dropped, an
  emptied section is dropped, an emptied note is never created, an emptied field key is removed from
  the payload rather than sent as `""`. This is the step that stops "no match" reaching the CRM, and
  it is not optional.
- **The verified decision-maker becomes the primary contact.** Replace `First_Name`, `Last_Name`,
  `Designation`, `Email`, `Phone`, `Mobile` with theirs. A straight replacement — no commentary about
  what used to be there. The rep wants a record they can dial, not an archaeology report.
- **The additional-contact blocks now have two jobs**: a displaced contact who was on the lead but is
  not the decision-maker, and — new — a reachable senior second when the owner has no direct phone or
  email. Both can be in use at once. **Their API names are inverted relative to their labels**; get
  this wrong and one person ends up split across both blocks. Read the map, do not guess.
- **Fields first, notes second — this is where the last version went wrong.** Work the field map top
  to bottom and write everything you established: `Employee_Count`, `Company_Size`, `Employee_Growth`,
  `Current_PR_Provider_new`, `Payroll_Frequency`, `Benefits_Carrier`, `WC_Carrier`, the 401(k) and
  benefits-stack text fields, `Linkedin`, `LinkedIn_Company_Profile_URL`,
  `Facebook_Company_Profile_URL`, `Company_Number`, `Full_Address`, `Existing_Client`,
  `Certified_Active_Company`. A populated field beats a beautiful note.
- **Check the field actually exists before writing it.** `Annual_Revenue`, `No_of_Employees`,
  `Secondary_Email`, `Fax`, `Twitter` and `Country` are **not on this org** and writing them fails the
  record. So does anything in the retired 2026-08-07 project block or the placeholder `Option 1 /
  Option 2` picklists. All three lists are in `zoho-writeback.md`.
- **Do not create custom fields.** Work with what the org has.
- **The company description goes in `Description`, and it is mandatory.** One plain opening sentence,
  then up to six bullets. No `ABOUT` note any more, and never an empty `Description`.
- **Notes, in this order** — `PAYROLL FINDINGS` first and always, then `CONTACT`, then
  `COMPANY BACKGROUND`, then `TIMING` and `COMPLIANCE` only when something real turned up, then
  `ICEBREAKERS`. Zoho takes as many notes as you want, so split a big topic into its own note
  (`BENEFITS AND RETIREMENT`, `OPEN ROLES`) rather than overloading one. **If a note's content is
  already fully captured in fields, do not write the note.**
- **Everything payroll-relevant goes in `PAYROLL FINDINGS`, not the icebreakers.** Icebreakers are
  conversation openers only.
- **Plain English in every field and every note.** Expand every code and abbreviation, and end each
  finding with what it means for payroll.
- **Dates as 8/19/2026, sources and dates at the end of the line in brackets** — round for the
  source, square for the date. Never mid-sentence.
- **Detail on what you found; silence on what you didn't.** Bullets, not paragraphs — but a bullet
  earns two sentences when the detail matters. Numbers, dates, quoted language, source link. No "not
  found" sections, no empty-search inventories, and never "clean" or "no violations" — you searched an
  index and got no match, which is a different claim.
- **No scores.** No fit rating, tier, temperature or confidence figure in any field or note.
  `Lead_Rating`, `Lead_Rate`, `Lead_Status` and `Lead_Stage` are never written.

## Step 6 — Report

Short, not a wall:

- What was profiled, by name — these were the user's picks, so report on them by name
- Which leads got a new primary contact, and who
- Which leads got a second contact because the owner had no reachable number, and who that is
- What each company actually does, in a line
- Anything timely worth acting on this week
- Anything that genuinely needs a human: an ambiguous company-name match, or a picklist that needs an
  admin before a field can be written

**Keep it factual and unranked.** No fit score, no tier, no hot/warm/cold, no "strong lead" or "worth
prioritising." Say what you found and let the rep decide what to do with it.

**Do not list what you could not find** as an inventory — no empty-field tally, no coverage report. The
one exception is conversational and deliberate: if a search you consider important came back empty
after its full escalation ladder, you may say so here in a sentence, because the user is a human who
can react to it. That sentence never goes into Zoho.

Ask which leads they want next — do not propose a batch and start on it.

---

## Reference files

- `references/verification.md` — credibility ladder and the four contact checks. **Read before Step 2.**
- `references/search-recipes.md` — the queries, the four rounds, the completion bar, the escalation
  ladders and the social sweep. **Read before Step 3.**
- `references/zoho-writeback.md` — the pre-write filter, the live field map, the fields that must never
  be written, the additional-contact blocks, the `Description` bullets and the note formats.
  **Read before Step 5.**

## Responsible use

Public government records and companies' own published pages only. **Do not scrape LinkedIn** — the
signal you want is upstream in the applicant tracking system anyway. Never defeat a login, paywall or
bot block. Business research on business people in their professional capacity only.

Enforcement actions and tax warrants are public record, but attaching one to the wrong company is
genuinely damaging. When a name match is not certain, say so and route to a human rather than writing
it in. The same care applies to saying somebody left a job: report what a source actually showed, with
its date, rather than concluding a departure from silence.
