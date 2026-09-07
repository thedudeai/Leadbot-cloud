# Verification — Treating Purchased Data as a Lead, Not a Fact

Everything that arrived from ZoomInfo — the person, the title, the phone, the email, the headcount —
is a **hypothesis with a timestamp on it.** It was true when someone collected it. People change jobs,
get promoted, get laid off, change their cell number, and companies rebrand their email domains. A rep
who dials a number for someone who left eighteen months ago loses the call and some of their faith in
the CRM.

So the job in Step 2 is not "look up the contact." It is **prove the contact.** Four questions, in
this order, because each one makes the next one worth asking:

1. **Is this person still at this company?**
2. **Is this their current title — and does it make them the top decision-maker?**
3. **Is the phone still theirs?**
4. **Is the email still theirs?**

If question 1 fails, questions 2–4 are wasted effort. Go find the right person instead
(see "Finding the right person" below).

**Establish what the person on the record is before spending effort on them.** Look them up by name,
read their title and management level, and place them against the priority table in SKILL.md Step 2.
If they are the owner, founder, partner, CEO or president, they are the right person — go deeper on
them and prove the four questions above. If they are a Controller, an HR lead or an office manager,
they are still worth keeping as an additional contact, and the company search for the top seat starts
there. Either way the level check comes first, because it decides where the remaining calls go.

---

## The credibility ladder

When two sources disagree, this is the order that decides it. The principle underneath the ranking:
**how close is the source to the person, and how recently did the person or their employer choose to
publish it?** A company's own leadership page is written by the company about itself. An aggregator
site is a copy of a copy.

| Rank | Source | Beats ZoomInfo? | Why |
|---|---|---|---|
| 1 | **The person's own LinkedIn profile** — current position, dates, headline | **Yes** | They maintain it themselves and update it the week they change jobs. This is the single best answer to "do they still work there." |
| 2 | **The company's own website** — team, leadership, staff, about, contact pages; and their press releases | **Yes** | The employer publishing its own people. Also the best source for direct dial numbers. |
| 3 | **Dated press coverage or a press release naming the person in the role** (last 12 months) | **Yes** | Somebody with a reputation to lose printed it on a date you can see. |
| 4 | **Regulatory / licensing filings** — SEC, state licensure, Form 5500 signatory, secretary-of-state officer listings, professional registries | **Yes** | Filed under penalty. Slow to update, so strong on *existence*, weaker on *current*. |
| 5 | **A conference bio, podcast page, panel listing, or bylined article** from the last 12 months | **Yes if fresher than the ZoomInfo record** | They or an organiser wrote it recently, but bios go stale on event pages. |
| 6 | **ZoomInfo with `contactAccuracyScore` ≥ 85 and `lastUpdatedDate` under 12 months** | — | The baseline. Licensed and reasonably fresh. |
| 7 | **A value a human typed into Zoho** | On company fields, no | A rep may have confirmed it on a live call, or typed it off a business card in 2021 — unknowable, so leave human-entered *company* values (description, revenue, address) alone and put your finding in a note. **Contact fields are the exception**: the decision-maker replaces whoever is there, because a record nobody can dial is the problem this skill exists to fix. |
| 8 | **ZoomInfo with low accuracy or over 12 months old** | — | Aging. Fine as a starting point, not as an answer. |
| 9 | **Aggregators and directory sites** — RocketReach, Signalhire, scraped contact databases, Crunchbase profiles, Yellow-Pages-style listings | No | Mostly recycled scrapes with no date you can trust. Corroborating only — never the sole basis for a change. |

**Ranks 1–5 beat ZoomInfo. Rank 9 never does.** When something in ranks 1–5 contradicts ZoomInfo,
ZoomInfo is wrong: update the value and record which source overruled it and on what date.

Two things override raw rank:

- **Corroboration.** The same value from two independent sources beats one higher-ranked source
  standing alone. Independent means genuinely separate — three aggregators reprinting the same scrape
  is one source, not three.
- **Recency, when the fact is time-bound.** Titles and employers change; company founding dates do
  not. For anything that can change, a rank-3 source from last month beats a rank-2 page whose
  copyright footer says 2021.

---

## Question 1 — Is the person still there?

The cheapest reliable check is their LinkedIn current position. Search for it rather than fetching
linkedin.com (see the LinkedIn note in `search-recipes.md`) — the search snippet usually shows the
headline, which is the answer.

```
WebSearch: "{person}" linkedin {co}
WebSearch: "{person}" linkedin                     // catches a move to a new employer
WebSearch: "{person}" "{co}" 2026 OR 2025          // recent mentions in the role
WebFetch  {domain}/team  /leadership  /about  /our-team  /contact
```

**Read the LinkedIn headline carefully.** "CEO at Acme" confirms it. "Former CEO at Acme" or
"CEO at Beta Corp" tells you they are gone — and, usefully, where they went. A profile whose most
recent role ended with no new one may mean a departure that has not been publicly explained.

**Verdicts and what each one means:**

| Verdict | Basis | Do this |
|---|---|---|
| `confirmed_current` | LinkedIn shows the role as current, **or** the company's own site lists them, **or** press from the last 12 months names them in the role | Proceed to question 2 |
| `probably_current` | Only ZoomInfo and stale sources agree, nothing contradicts, nothing corroborates | Proceed, but mark the title `unverified` in the note |
| `departed` | LinkedIn shows a different current employer, the company site lists someone else in the seat, or press reports the change | Stop. Find the current top decision-maker |
| `person_not_found` | No trace of this person at this company anywhere outside ZoomInfo | Treat as departed and find the right person. Also suspect a conflated record — check the company identity |

**Watch for company identity confusion.** Before concluding somebody left, make sure you are looking
at the same company. Two firms sharing a name in different states is the most common way this goes
wrong. Match on domain, city, or state — not name alone.

---

## Question 2 — Is the title current, and are they the top decision-maker?

Two separate questions that fail differently.

**Current?** A title from the company's own site or a dated press release beats ZoomInfo's. If the
company's leadership page says "President" and ZoomInfo says "VP Operations," they were promoted and
ZoomInfo has not caught up. Take the company's version and note the source and date.

Watch specifically for **promotions into the top seat** — an interim CEO made permanent, a VP made
President, a founder's child moving from GM to Owner. These are exactly the records ZoomInfo is
slowest on, and exactly the people this skill is looking for.

**Top decision-maker?** The targeting rules are in SKILL.md Step 2. Briefly: owner, founder, or
partner first; CEO or president second; nobody else. If the verified person is neither, they are not
the target regardless of how good the contact data is — go find who is.

---

## Question 3 — Is the phone still theirs?

Phone numbers rot quietly. There is no free way to prove a cell number belongs to a person today, so
the goal is not certainty — it is **catching the obviously wrong ones** and being honest about the
rest.

| Check | What it catches |
|---|---|
| Area code against the company's city, or the person's known metro | A number attached to a conflated record from another state |
| Format — valid NANP, right digit count, not a placeholder sequence | Corrupt or dummy data |
| Does the company's own site publish a direct line, or a main line plus extension, for them? | The best phone you can get, and it beats whatever ZoomInfo has |
| Does a second independent source show the same number? | Corroboration |
| ZoomInfo `lastUpdatedDate` | A mobile last touched three years ago is a coin flip; say so |

**Label the outcome honestly:** `verified` only when a rank 1–5 source published it or two independent
sources agree. Otherwise `unverified`, with the reason. "Mobile 555-0142 — ZI accuracy 91 but last
updated Feb23, unverified" is far more useful to a rep than a bare number, because it tells them what
to expect when it rings.

**Carry Do Not Call flags through, always.** If `mobilePhoneDoNotCall` or `directPhoneDoNotCall` is
true, that goes at the top of the contact note. Compliance matters and it costs nothing to preserve.

---

## Question 4 — Is the email still theirs?

```
WebSearch: "{person}" "@{domain}"
WebSearch: "{co}" "@{domain}" email contact
WebFetch  {domain}/contact  /team
```

Three failure modes worth catching:

- **The domain changed.** Companies rebrand and migrate mail. If the website is now `acme-group.com`
  and ZoomInfo has `@acmecorp.com`, the old address may bounce. Prefer the live domain.
- **The pattern changed.** An org that used `first.last@` in 2020 may use `flast@` now. Two or more
  currently-published addresses tell you the live pattern.
- **The person changed.** A departed person's mailbox is often forwarded or dead. If question 1
  returned `departed`, the email is worthless regardless of how well-formed it looks.

**Infer a pattern; never invent an address.** With two published addresses at the domain agreeing on
a shape, a derived address is legitimate — write it and label it `pattern-derived`. With one example,
or examples that disagree, the pattern is unproven: leave the field empty and move on without
comment. A guessed address that bounces damages sender reputation and tells the rep nothing.

---

## Finding the right person

A departed or wrong-seat contact is not a dead lead — the company still runs payroll, and the seat
still has somebody in it. Find them.

```
WebFetch  {domain}/team  /leadership  /about  /management
WebSearch: "{co}" owner OR founder OR "managing partner" OR CEO OR president
WebSearch: "{co}" "named" OR "appointed" OR "promoted to" president OR CEO 2026 OR 2025
WebSearch: "{co}" {st} secretary of state officers OR registered agent
```

```
mcp__ZoomInfo__search_contacts_v2(companyIdList: [...],
  managementLevelList: ["C Level Exec", "Owner"],       // owners are their own level, not C-suite
  requiredFieldsList: ["mobilePhone"], sort: "-contactAccuracyScore", pageSize: 25)
```

**Ask for owners explicitly.** ZoomInfo files owners, founders and partners separately from C-level
executives, so a C-level-only filter returns the hired CEO and silently hides the person we actually
want. If the org's allowed values differ, pull one page per level rather than narrowing to C-suite.

**Never combine `jobTitleList` with `managementLevelList`** — they intersect to zero and fail
silently, which reads as "this company has no executives." Filter by level, then rank by title
yourself: owner, founder or partner first, then CEO or president.

Small and family-owned companies frequently have no ZoomInfo executive record at all while naming the
owner plainly on their own homepage. **Check the website before concluding nobody is there.**

Then run the replacement person through questions 1–4 from the top. A replacement found in a hurry
and written in unverified is the same problem you just fixed.

**The verified decision-maker becomes the lead's primary contact** — name, title, email, phone and
mobile are replaced with theirs. Do not narrate the swap in the notes; the record should read as
though it always held the right person. The change is surfaced to the user in conversation before the
write, which is where a human can actually object to it.

**Displaced people are not deleted, they are demoted.** If the person who was on the record is still
there and still useful — a Controller who runs payroll day to day, an office manager who gates the
phone — put them in one of the two additional-contact blocks (`zoho-writeback.md` has the field map,
including the inverted API names). If they have left the company, they simply go; a departed person
occupying a contact slot helps nobody.

**A decision-maker with no phone is still the decision-maker.** When question 3 and question 4 both
come back empty for the owner — no direct dial, no mobile, no defensible email — **do not replace them
with someone more reachable.** They stay the primary. Instead, run the ladder in `zoho-writeback.md`
under "When the owner has no direct phone" and find the most senior person at the company who does
have a direct line and an email, then write that person into an additional-contact block.

This is the case where the temptation to substitute is strongest and most wrong. A record whose primary
is a Controller because the owner's cell was hard to find sends the rep into the wrong conversation. A
record whose primary is the owner, with a reachable CFO in block 1, sends them into the right one by a
slightly longer route.

Hold the same verification bar on that second person. An additional contact written in with a guessed
email is the same failure as a wrong primary, just further down the record.

---

## Recording verification, briefly

Every contact value written back carries three things: the value, where it came from with a date, and
whether a check passed.

```
Employment CONFIRMED CURRENT · LI headline "President at Acme" · checked 12Aug26
Designation President · WEB leadership page 04Aug26 · title as the company itself publishes it
Direct 555-0100 x214 · WEB leadership page 04Aug26 · VERIFIED — published by the company
Mobile 555-0142 · ZI 92 Jun26 · unverified — area code fits Newark HQ, but nothing corroborates it
Email r.alvarez@acme.com · pattern-derived from two published @acme.com addresses · unverified
```

The mobile line is the one to imitate. An area code that fits is a **sanity check that failed to
disqualify the number** — it is not corroboration, and calling it `VERIFIED` would be exactly the kind
of false confidence this whole step exists to prevent.

Write the check, not just the value. A rep reading `unverified` dials differently than one reading
`VERIFIED` — and that difference is most of what this step is for.

**`verified` and `unverified` are not scores.** They are the outcome of a named check on a named value,
and they stay. What does not appear anywhere is a fit score, a tier, a temperature or a confidence
percentage on the lead as a whole — the user has said plainly they are not interested in being told how
good a lead is, only in what is true about it.

**And never record a failed check as content.** If no source corroborated the mobile, the line reads
`mobile 555-0142 · unverified` — not `mobile 555-0142 · no corroborating source found`. The first is a
finding about a value you have; the second is an absence report, and the pre-write filter in
`zoho-writeback.md` deletes it.
