# Zoho Write-Back

Every finding has a field. Notes are the exception, not the destination.

This file is the field map, verified against the live Leads schema on **19 Aug 2026** — 202 fields.
Where a finding has a real field, it goes in the field. A note exists only for things no field can
hold: multi-line evidence, quoted language, dated event narratives.

**Five standing rules.**

1. **Plain English, always.** No source codes, no shorthand, no unexplained jargon. Every finding
   says what it is, where it came from, and why it matters for payroll. See "Plain English" below —
   this is the feedback that keeps coming back and it governs every word written to Zoho.
2. **The company description is mandatory.** `Description` is never left empty. A recent run skipped
   it and the record was much harder to use.
3. **Do not create custom fields.** The org already has 202 on Leads and a CRM admin owns that
   decision.
4. **Field first, note second.** Before writing anything into a note, check this map. If a field
   exists for it, the field is the answer and the note does not repeat it.
5. **Write only what you found.** A field with nothing behind it is omitted from the payload —
   not written empty, not written `"Unknown"`, not written `"N/A"`. See the pre-write filter below,
   which is mandatory and mechanical.

---

## The pre-write filter — run this before every write, no exceptions

The single most common failure of this skill is writing an absence into the CRM: a `COMPLIANCE` note
reading "no match," a field set to "Not found," a bullet saying "no DOL records located." **This is
never acceptable output.** A rep opening a lead should see findings only. An empty field already
communicates "nothing here," and it does it in zero words.

Style guidance has not been enough to stop this, so treat it as a mechanical gate instead. Between
building the payload and calling the API, walk it once and apply these three passes.

### Pass 1 — kill any string containing absence language

Case-insensitive. If a field value or a note line contains any of these, that value or line is
**deleted from the payload**:

```
no match          not found         none found        no records        no record found
nothing found     no results        no data           no hits           nothing surfaced
no filings        no cases          no violations     no issues         no findings
none identified   unable to         could not         couldn't          did not find
didn't find       not located       not available     not disclosed     no public
clean             no adverse        nothing adverse   not confirmed by search
N/A               n/a               TBD               unknown           —
```

Two words on that list need care because they have a legitimate use elsewhere:

- **`unknown`** is a *valid picklist value* on `Functional_Role1` / `Functional_Role2`. The filter
  applies to free text and notes, not to a picklist whose schema defines `Unknown` as a member.
- **`unverified`** is **not** on this list and must survive. It is a finding about a value you have,
  not a report of an absence. `mobile 555-0142 · unverified` is exactly right.

### Pass 2 — cascade the deletions upward

Deleting a line can empty its container, and an empty container must go too.

- A bullet whose content was deleted → drop the bullet.
- A note section left with no bullets → drop the section heading.
- A note left with no sections → **do not call `createNotesModule` for it at all.** A note titled
  `COMPLIANCE — 8/19/2026` with nothing under it is worse than no note: a rep sees the heading,
  opens it, and gets nothing.
- A field whose value was deleted → **remove the key from the update payload entirely.** Do not send
  `"Current_PR_Provider_new": ""` — that erases whatever a human previously typed there.

### Pass 3 — the absence of a note is itself the signal

`COMPLIANCE` is the clearest case. Most companies have no enforcement history you can find, so most
leads get no compliance note. That silence is readable at a glance and is worth more than a hundred
notes saying "searched, no match." A rep who sees a `COMPLIANCE` note knows before opening it that
something is genuinely there.

The same holds for `TIMING`. No timely event found means no `TIMING` note — not a note explaining
that nothing is timely.

**One thing that is allowed, and only in conversation:** if a search you consider important came back
empty, you may mention it to the user in the Step 6 report — "couldn't find a retirement-plan filing
for this one." That is a live conversation with a human who can react. It never goes into the CRM.

### Pass 4 — the plain-English check

Read the whole payload back as if you were the rep. Three questions, and any "no" means rewrite that
line before sending:

1. **Is there a code or abbreviation in it?** `LI`, `FB`, `ATS`, `5500`, `SOS`, `DOL`, `ZI`, `WEB`,
   `NEWS`, `POD`, `GLD`, `NPI`, `PEPM`, `SUI`, `W-2`, `priority 1`, `14Jul26`. Expand every one into
   words. The table under "Plain English" gives the replacements.
2. **Does every finding say why it matters for payroll?** A bare fact with a source and no
   consequence is half a finding.
3. **Is `Description` filled?** If not, the lead is not finished. Go back and write it.

### Pass 5 — the findings check

Open the `ICEBREAKERS` note and ask of each line — *could a rep say this out loud to a stranger in
the first minute of a call?* Anything that is really a research finding (a retirement plan, a state
registration, an HR department of one) **moves to `PAYROLL FINDINGS`**. This happened on the last run
and it made both notes worse.

---

## Check the schema before a batch, narrowly

```
mcp__Zoho_CRM__getFields(module: "Leads", include: "skip_field_permissionz", type: "used")
```

**This returns roughly 770,000 characters and will exceed the tool result limit**, spilling to a file.
Parse it there with `jq` rather than reading it — extract `api_name`, `field_label`, `data_type`,
`read_only`, `length` and `pick_list_values` for the fields you intend to write, and cache the result
for the whole batch. The schema will not change mid-run.

The map below was built this way and is current as of 19 Aug 2026. Trust it, and re-verify only if a
write is rejected for an unknown field.

---

## Fields this skill must never write

Three groups. Sending any of them either fails the write, overwrites a human decision, or reintroduces
output the user has explicitly rejected.

### Group 1 — added by this project, now retired

These 24 fields were created on 2026-08-07 during earlier work on this skill. **The user has asked
that they no longer be used.** Do not read from them, do not write to them, do not mention them.

```
Payroll_Fit_Score      Fit_Tier               Why_Now                Likely_Payroll_Provider
Provider_Confidence    Verified_Employees     Employee_Count_Source  Headcount_Trend_Pct
State_Count            Has_DOL_Case           DOL_Backwages          Estimated_ACV
Profiled_By_Bot        Profiled_Date          Profile_Confidence     Requires_Review
Disqualify_Reason      Contact_Seniority      Is_Decision_Maker      Better_Contact_Found
DNC_Flag               LinkedIn_URL           Buying_Intent_Topics   Lead_Provider
```

Everything they used to hold has a pre-existing home in the map below, or belongs in a note.
`LinkedIn_URL` → use `Linkedin`. `Likely_Payroll_Provider` → use `Current_PR_Provider_new`.
`Verified_Employees` → use `Employee_Count`. `DNC_Flag` → the top line of the `CONTACT` note.
`Buying_Intent_Topics` → the `TIMING` note.

### Group 2 — placeholder picklists that reject every real value

Twenty-two fields whose only defined values are `Option 1` and `Option 2`. They came in with a
ZoomInfo import and were never configured. Zoho rejects anything else, so **skip them entirely** and
use the standard equivalent named beside each.

```
Company_Name (→ Company)          Company_City (→ City)             Company_State (→ State)
Company_Street_Address (→ Street) Company_Country (no equivalent)   Company_HQ_Phone (→ Company_Number)
Revenue_Range                     Employee_Range (→ Employee_Count) Middle_Name
Department                        Ticker                            SIC_Codes
NAICS_Codes                       Primary_Industry (→ Industry)     Primary_SubIndustry
All_Industries                    All_SubIndustries                 Ownership_Type
Business_Model                    Recent_Funding_Round              Industry_Hierarchical_Category
Secondary_Industry_Hierarchical_Category
```

If one of these genuinely matters to the user, say so **once** in the run report — it needs a CRM
admin to add picklist values — and never retry it per lead.

### Group 3 — scoring, stage and read-only

**The user is not interested in scoring.** Do not produce a fit score, a tier, a temperature, a
priority grade or a confidence rating anywhere: not in a field, not in a note, not in the run report.
The output of this skill is information, not a verdict on the lead.

| Field | Why not |
|---|---|
| `Lead_Rating` (integer) | a score. Never write it |
| `Lead_Rate` ("Lead Temperature": Hot / Warm / Cold) | a temperature rating. Never write it |
| `Lead_Status`, `Lead_Stage` | human pipeline decisions. A research pass does not move a lead's stage |
| `Strategic_Category`, `Strategic_Role_Category` | the client's own account-strategy taxonomy. Humans own it |
| `Owner` | ownership is a human decision, always |
| `Fees_15_Standard`, `Max_ERC`, `Total_Open_Tasks`, `Total_Overdue_Tasks` | formula and rollup — read-only, the write will fail |
| `Converted_*`, `Locked__s`, `Enrich_Status__s`, `Record_Status__s`, `id` | system-managed |

**Fields that do not exist on this org**, despite being standard on most Zoho instances — writing any
of them fails the record: `Annual_Revenue`, `No_of_Employees`, `Number_of_Employees`,
`Secondary_Email`, `Fax`, `Twitter`, `Country`, `Rating`. Revenue in particular has **no field on this
org at all**; it goes in the `Description` bullets with its source.

---

## Ownership — check it, do not assume it

The user chooses the leads, and they may legitimately name a lead owned by a colleague. This is a
**check with a question attached**, not a filter.

Before writing, read `Owner` on each record and compare to `getUsers(type: "CurrentUser")`.

- **Owner matches** — write.
- **Owner is someone else** — say so plainly and ask once whether to write anyway. Some orgs share a
  pipeline and this is routine; others treat it as trespassing. Do not decide for them, and do not
  skip it silently either — the user asked for this lead by name, so quietly ignoring it looks like a
  bug.

Re-check immediately before the write, not just at selection. A lead can be reassigned in between.

---

## The primary contact — the top decision-maker, always

The verified owner, founder, partner, CEO or president goes in the lead's own contact fields. If the
record currently holds a Controller, or somebody who left in 2023, **overwrite them.**

| Zoho field | What goes in it |
|---|---|
| `First_Name` / `Last_Name` | the decision-maker. `Last_Name` is **required** — split a full name if you only have one string |
| `Designation` | their **actual job title**, as they and their company use it. The label reads "Title" but the API name is `Designation`. The field literally named `Title` is a different custom field labelled "Title-" — writing there puts the job title where nobody looks |
| `Email` | best-ranked email |
| `Phone` | direct line, else the company main line |
| `Mobile` | ZoomInfo `mobilePhone`. The field reps care about most |
| `Mobile_phone` (text) | a **second** mobile, when you have two. Do not duplicate `Mobile` here |
| `Salutation` | picklist: `Mr. / Mrs. / Ms. / Dr. / Prof.` (and bare `Mr / Ms / Dr`). Only if certain |
| `Suffix` | Jr, Sr, III, CPA — only when the company itself publishes it |
| `Linkedin` (website) | **the person's own LinkedIn profile URL.** Note the lowercase "in" in the api_name. This is not `LinkedIn_URL`, which is retired |
| `ZoomInfo_Contact_Profile_URL` | from the ZoomInfo record, when present |
| `Email_Domain` | the company's mail domain |
| `Functional_Role` (picklist) | the primary's role. **24 values on this field** — a superset of the additional-contact lists, including `HR Leader`, `Recruiting`, `Benefits`, `Human Resources`, `Talent Acquisition`, `Director`. It also contains stray `Option 1` / `Option 2` values: never write those |
| `Email_Opt_Out` (boolean) | set true on any opt-out signal |

**This is a straight replacement.** Do not write "was: Jane Doe" into a note, do not explain the swap
in the record. The change is reported in conversation at Step 5 and Step 6, which is where a human
will actually see it.

**There is no `DNC_Flag` to set any more** — that field is retired. A Do Not Call flag goes as the
first line of the `CONTACT` note, prefixed `!!`, and it is never dropped.

---

## The additional-contact blocks — two of them, inverted API names

The Leads layout has room for two further people, and **their API names do not line up with their
labels.** Only `First_Name1` and `First_Name2` behave as you would guess; last name, email, phone,
title and functional role are all crossed over. Writing by intuition splits one person across both
blocks — first name in block 1, last name and phone in block 2 — producing two half-people and a rep
who calls neither.

### Additional contact 1 (fields labelled "1 …")

| Field | api_name | Type |
|---|---|---|
| First name | `First_Name1` | text |
| Last name | `Last_Name2` | text |
| Email | `Email2` | email |
| Phone | `Phone2` | phone |
| Title | `Title2` | text |
| Functional role | `Functional_Role2` | picklist |

### Additional contact 2 (fields labelled "2 …")

| Field | api_name | Type |
|---|---|---|
| First name | `First_Name2` | text |
| Last name | `Last_Name1` | text |
| Email | `Email1` | email |
| Phone | `Phone1` | phone |
| Title | `Title1` | text |
| Functional role | `Functional_Role1` | picklist |

**The pattern, if it helps you check yourself:** for everything except first name, block 1 takes the
`…2` suffix and block 2 takes the `…1` suffix.

`Title1` and `Title2` are free text — write the person's real title. `Functional_Role1` and
`Functional_Role2` share one 17-value picklist and Zoho rejects anything outside it:

```
CEO · Partner - Owner · President · CFO · Controller · Head of Finance · COO ·
Head of HR · HR Admin · HR Manager · Office Manager · Marketing · Payroll ·
Board Member · Sales Person · Unknown
```

Map to the nearest value and keep the exact title in the free-text title field: a VP Finance is
`Head of Finance` in the picklist and "VP Finance" in `Title2`. When nothing fits, `Unknown` is a
legitimate value here — it is a defined member of the picklist, not an absence report.

### Who earns a block

Two situations fill these, and the second one is new.

**1. A displaced contact.** The person who was already on the lead turns out not to be the
decision-maker. They are demoted, not deleted — a Controller knows the payroll setup and an office
manager gates the phone. The exception is somebody who has **left the company**: a departed contact
occupying a slot helps nobody, so they simply go.

**2. A reachable second when the owner is not reachable.** This is now a requirement, not an option.
See the rule below.

---

## When the owner has no direct phone — keep them, and add somebody reachable

**The owner stays the primary. Always.** A missing phone number does not demote the person who can say
yes; it just means the rep needs a second door into the building.

**Trigger the rule when the primary decision-maker has no direct dial and no mobile** — a company
switchboard number in `Phone` is not a direct line for this purpose. It also triggers when you have a
phone but no working email for them.

**Then go find one more person, deliberately.** This overrides the old instruction not to hunt for
extra people. Look for the most senior person at the company who has **both a direct phone and an
email you can stand behind**, ranked:

| Rank | Titles |
|---|---|
| 1 | Co-owner, Co-founder, Partner, Managing Member — a second person at the top |
| 2 | President, CEO, Managing Director (when the primary is an owner who isn't one) |
| 3 | COO, Executive Vice President, General Manager |
| 4 | CFO, VP Finance, Controller, Head of Finance, Treasurer |
| 5 | HR Director, VP People, Head of HR |
| 6 | Office Manager, Executive Assistant, Chief of Staff — a route in, and better than a dead record |

Walk down until you find someone with real contact details. Write them into **additional contact
block 1**, with their true title in `Title2` and the nearest picklist value in `Functional_Role2`.

**Both blocks can be in play at once.** If a Controller was displaced from the primary slot *and* the
owner has no phone, the displaced Controller takes block 1 and the reachable executive takes block 2 —
or the other way round, ordered by who a rep should try second. Say which is which in the `CONTACT`
note.

**Do not lower the bar on verification to fill the slot.** An additional contact written in with an
invented email is the same failure as a wrong primary. If nobody at the company has published contact
details, leave the blocks empty and record the company main line in `Company_Number` — that is a real
finding, and a rep can work a switchboard.

---

## Company and firmographic fields — fill every one you can

This is where "relevant fields, not notes" is won or lost. Work down the table and write everything
you established. A populated field beats a beautiful note every time, because reps filter and sort on
fields and they skim notes.

### Core

| Zoho field | Source | Notes |
|---|---|---|
| `Company` | already present | change only if provably wrong |
| `Website` | company domain | |
| `Street` `City` `State` `Zip_Code` | company HQ | all plain text on this org, not picklists. **There is no `Country` field** |
| `Full_Address` (text, 255) | one-line HQ address | useful when the parts are messy |
| `Company_Number` | the main switchboard line | this is where a general company phone belongs, not `Phone` |
| `Employee_Count` (integer, "EE Count") | **the TOTAL across every related legal entity** | **the headcount field on this org.** Not `No_of_Employees`, which does not exist. See "Multiple entities" below — a headquarters-only figure here is the most damaging number on the record |
| `Company_Size` (integer) | same figure | a second headcount field; fill both when you have one good number |
| `Employee_Growth` (percent) | year-over-year change, e.g. 5500 participants PY24 vs PY23 | a real number only — never an impression |
| `Number_of_Locations` (text) | count of sites | |
| `Industry` (picklist) | **719 values**, mostly numeric SIC-style codes | never guess. Read the allowed values first or leave it alone |
| `Description` (textarea, 32000) | **the About bullets — see below** | |
| `Existing_Client` (picklist: Yes / No) | Zoho Accounts and Contacts check | set `Yes` on a hit; that is a disqualifier worth recording |
| `Certified_Active_Company` (boolean) + `Certification_Date` | secretary-of-state registry | set true only on an actual active registration you read, with the date you read it |

### Payroll, benefits and vendor stack — the fields that make this a payroll CRM

These are pre-existing text fields and they are the correct home for provider findings. Writing the
incumbent provider into a note instead of here is the mistake this section exists to prevent.

| Zoho field | What goes in it |
|---|---|
| `Current_PR_Provider_new` ("Current PR Provider", 255) | the incumbent payroll provider. **Write it as a hypothesis with its basis** — `ADP Workforce Now (named in Jul26 job posting)`. Never a bare confident name |
| `Current_Payroll_Service` (255) | the same finding when it came from a different source; use one or both, don't invent a disagreement |
| `Payroll` (255) | the payroll system named in ZoomInfo's tech stack, if present |
| `Payroll_Frequency` (picklist) | `Bi-weekly · Monthly · Semi-Monthly · Weekly · Quarterly`. Only from a real source — a job posting or their handbook |
| `HCM` / `HRM` (255) | the HR platform, when a posting or portal link names one |
| `Benefits_Administration_Software` (255) | |
| `Benefits_Carrier` (picklist) | `Aetna · Anthem · BCBS · Cigna · United` only. Anything else goes in `Healthcare_Providers` |
| `Healthcare_Providers` (255) | any carrier outside that picklist |
| `Employee_Benefits_Broker` (255) | often named in the Form 5500 Schedule A |
| `Self_Funded_Health_Plans` (255) | |
| `Life_Insurance` (255) | |
| `K_Retirement_Plan` ("401K Retirement Plan", 255) | the recordkeeper named in the 5500 |
| `Pension_Retirement_Plans` / `Defined_Contribution_Plans` (255) | |
| `WC_Carrier` (text) + `WC_Renewal_Date` (date) | workers' comp, when a certificate or filing names it |
| `BN_Renewal_Date` (date) | benefits renewal, when published |

A renewal date is a timing signal a rep can act on. When you find one, it goes in the date field
**and** gets a line in the `TIMING` note, because the field alone does not say why it matters.

### Social and profile URLs — fill all of them, they are free

| Zoho field | What |
|---|---|
| `Linkedin` | **the person's** LinkedIn profile |
| `LinkedIn_Company_Profile_URL` | the company page |
| `Facebook_Company_Profile_URL` | the company page — often the richest icebreaker source at family firms |
| `Twitter_Company_Profile_URL` | the company X account |
| `ZoomInfo_Company_Profile_URL` / `ZoomInfo_Contact_Profile_URL` | from the ZoomInfo records |
| `Email_Domain` | the mail domain |
| `Referrer`, `First_Visited_URL` | never write these — web-tracking fields owned by Zoho |

Instagram, YouTube and TikTok have no field. Their URLs go in the `ICEBREAKERS` note beside the post
they produced.

### Corporate structure

| Zoho field | What |
|---|---|
| `Entity_Name_Ultimate_Parent` / `Entity_Name_Immediate_Parent` | parent companies |
| `Relationship_Immediate_Parent` | subsidiary, division, joint venture |
| `Company_Is_Acquired` (boolean) | true on a confirmed acquisition |
| `Recent_Investors` / `All_Investors` (text) | named investors |
| `Recent_Funding_Date` (date) | **not** `Recent_Funding_Round`, which is a placeholder picklist |
| `Contact_Accuracy_Grade` (text) | ZoomInfo's own grade, if you want it preserved. This is data provenance, not a lead score — but it is optional, and skipping it is fine |

**Never overwrite a human on the company side.** Contact fields are replaced deliberately, as above.
But if a rep typed something into `Description`, an address field or a vendor field, **leave it** and
put your finding in a note instead. Empty fields are always safe to fill.

Never invent a picklist value to make a record look complete. It fails the write, and under loose
validation it creates orphan values that pollute reporting.

---

## Plain English — the rule that governs every word written to Zoho

**A rep reads this record cold, sixty seconds before dialling, and they are not an analyst.** Every
word you write into a field or a note has to make sense to that person on one read. This is the
feedback that keeps coming back, so treat it as a hard requirement rather than a style preference.

### No codes. Ever.

The previous version wrote source codes and shorthand — `LI 12Jul26`, `ATS`, `5500 SchC PY24`,
`DOL WHD`, `SOS`, `ZI accuracy 91`, `NPI 1780029322`, `taxonomy 103K00000X`, `PEPM`, `SUI`,
`priority 1`. **None of that is allowed.** It reads as machine output and a rep skips it.

| Never write | Write instead |
|---|---|
| `LI 12Jul26 —` | On LinkedIn on 12 July 2026, she … |
| `FB 21May26` | On the company's Facebook page on 21 May 2026 … |
| `ATS`, `no ATS fingerprint` | their online job-application system; they don't appear to use one |
| `5500`, `Form 5500 SchC PY24` | their federal retirement-plan filing for 2024, which employers file each year |
| `DOL WHD case 1900001` | a US Department of Labor wage investigation (case 1900001) |
| `SOS` | the state business registry |
| `ZI`, `ZoomInfo accuracy 91` | ZoomInfo, whose record for this was last checked in June 2026 |
| `NPI 1780029322` | their federal healthcare provider registration (number 1780029322) — the public record that names the legal owner |
| `PEPM`, `est. ACV` | (never — pricing and deal value are not written at all) |
| `W-2 staff` | employees on payroll, rather than contractors |
| `SUI`, `withholding registrations` | state unemployment insurance and payroll tax accounts, which need setting up separately in each state |
| `priority 1`, `priority-2 door` | the person who can say yes; a good second door in |
| `14Jul26` | 7/14/2026 |

### Dates and sources go at the end, in brackets

**One date format everywhere — US numeric, no leading zeros.** `8/19/2026`. Never `19 August 2026`,
never `14Jul26`, never `2026-08-19`. A month with no day is `8/2026`.

**Two bracket types, always at the very end of the line, source first:**

- **Round brackets for the source** — `(their careers page)`, `(LinkedIn)`, `(US Department of Labor)`
- **Square brackets for the date** — `[8/18/2026]`

```
· They now run offices in six states, so each one needs its own payroll tax account and
  unemployment insurance rate. (company website) [8/18/2026]
```

**Never bury a date or a source mid-sentence.** The sentence says the finding; the brackets say where
it came from and when. A reader who trusts the finding never has to look at the brackets, and one who
doesn't knows exactly where to check.

Not this:

```
· WEB 18Aug26 — their careers page (checked 18 August 2026) lists six offices
· On 24 June 2026 a press release from the company announced the expansion
```

This:

```
· Their careers page lists six offices. (company website) [8/18/2026]
· They announced the expansion into five more states. (company press release) [6/24/2026]
```

**A link goes after the brackets**, on its own if it is long.

This applies to the notes **and** to the `Description`.

### Explain every finding

**A fact with no explanation is half a finding.** Every item you write says three things, in plain
sentences: **what you found, where it came from, and why it matters for payroll.** The third part is
the one that keeps getting dropped and it is the reason the record exists.

Not this:

```
· NPPES NPIs 1760273841 (NE, 16 May 2025), 1477343481 (Achieve CO LLC, 12 May 2025)
```

This:

```
· They registered three new legal entities in the same week — one each for Nebraska, Colorado and
  Minnesota — all under the owner's name. Each new state means a separate set of payroll tax and
  unemployment insurance accounts to open and file, and that work usually lands on whoever already
  runs payroll. (federal healthcare provider registry) [5/12/2025]
```

Longer, and worth it. Short is good, but understandable comes first.

**Technical terms get a half-sentence of explanation the first time they appear.** If you must say
"certified payroll", add "the wage reports required on government construction jobs". Assume the rep
knows payroll products and does not know the prospect's industry.

### Keep it tight

Plain English is not padding. No throat-clearing, no restating the company name in every bullet, no
"it is worth noting that". Say the thing, say where it came from, say why it matters, stop.

---

## Multiple legal entities — one company on paper is often several

**Check this on every lead.** These businesses commonly run more than one legal entity: an office
company and a separate field-staff company, one entity per state, a staffing arm beside the operating
business, a holding company above both. Each is a **separate employer with its own federal employer ID
number**, its own payroll registration, its own tax filings and its own W-2s at year end.

### The headcount written to Zoho is the total across all of them

`Employee_Count` and `Company_Size` get the **sum over every related entity**, never one entity's
figure. This is the single most damaging number to get wrong: ZoomInfo reports the headquarters shell,
and on a recent lead it said 8 employees while the company itself said 100-plus clinicians across four
entities. A rep opening that record would have pitched the wrong size of business.

- Total every entity you found a headcount for.
- **List the ones you could not count anyway**, and say the total is a floor. "At least 117 across
  four entities; no headcount established for the Minnesota entity" is honest and usable. A
  headquarters-only number is neither.
- An entity with a genuine zero — a dormant holding company — counts as zero. An entity whose
  headcount you never established is not zero and must not be totalled as though it were.

### Write the structure up in a `COMPANY STRUCTURE` note

One line per entity: name, state, what it does, headcount, and the federal employer ID number if you
found one. Then the total. Source and date in brackets at the end, as everywhere else.

```
This company operates as four related legal entities. Each one is a separate employer with its own
federal employer ID number, which means its own payroll registration, its own tax filings and its
own set of W-2s at year end.

· Achieve Behavioral Therapy LLC · NJ · main operating company — 96 employees, federal employer ID
  27-1234567. (federal healthcare provider registry) [5/9/2013]
· Achieve Behavioral Therapy Nebraska · NE · per-state entity — 12 employees.
  (federal healthcare provider registry) [5/16/2025]
· Achieve CO LLC · CO · per-state entity — 9 employees.
  (federal healthcare provider registry) [5/12/2025]
· Achieve MN LLC · MN · per-state entity — headcount not established.
  (federal healthcare provider registry) [5/12/2025]

Total across all four entities: 117 employees. This is a floor — no headcount was established for
Achieve MN LLC.

Why it matters: four employer IDs means four payroll registrations and four sets of year-end filings.
Companies at this stage often have payroll split across systems or across people, and nobody owns the
whole picture.
```

**Never guess or construct a federal employer ID number.** They show up in retirement-plan filings,
nonprofit Form 990s, SEC filings, some state registrations and healthcare provider registrations —
and often nowhere at all. An entity with no ID found is listed without one.

**Related Zoho fields, when the structure is a parent/subsidiary one:**
`Entity_Name_Ultimate_Parent`, `Entity_Name_Immediate_Parent`, `Relationship_Immediate_Parent`,
`Company_Is_Acquired`. There is **no EIN field on this org**, so the IDs live in the note.

**A single-entity company needs no structure note.** Say nothing rather than writing a note that
explains there is only one company.

---

## `Description` — the company description, and it is MANDATORY

**This field must be filled on every single lead.** It was left empty on a recent run and that made
the record much harder to use. If you have researched a company at all, you know enough to describe
it. **Never finish a lead without it.**

### Shape

**One plain opening sentence saying what the company is, then bullets.** The opening sentence is not
optional — it is the line a rep reads first.

```
Achieve Behavioral Therapy provides in-home and school-based therapy for children with autism,
across six states.

· Founded in 2013 by Malkie Nussbaum, who still owns and runs it. She is a board-certified
  behaviour analyst, so this is a clinician-led business rather than an investor-owned one.
· Their therapists work in clients' homes, schools and daycares rather than in one clinic, and a
  lot of them are part-time.
· They opened offices in five more states during 2025 and 2026, so the workforce is spread out and
  growing. (company website) [8/18/2026]
· One Operations Manager handles both HR and the clinical side.
· They take Medicaid and most major insurers, which means steady volume rather than lumpy project
  work.
```

**Six bullets at most, one to two lines each.**

### What not to put in it

**Do not repeat anything another field already holds.** Headcount is in `Employee_Count`. City and
state are in `City` and `State`. The provider is in `Current_PR_Provider_new`. The website is in
`Website`. Repeating those is padding.

**Do not put sources, dates or links in the Description.** They belong in the notes. The Description
is the plain-language answer to "who are these people", and citations break the read. The one
exception is revenue, which has no field on this org — one line, with where the number came from.

**Do not write the evidence here.** "Their careers page lists six offices" is a note. "They have
offices in six states" is the Description.

---

## Bold headlines — every point gets one

**Zoho notes are a plain-text field.** This was tested on 8/23/2026 by posting a note containing
`<b>`, `<strong>` and `**markdown**` and reading it back: all three came back byte-for-byte. Markup is
stored and displayed literally. **Never write HTML tags, asterisks or markdown into a note** — they
appear as raw angle brackets and asterisks and look like exactly the machine output the plain-English
rule exists to prevent.

The one thing that genuinely renders heavy in a plain-text field is **Unicode mathematical
sans-serif bold**, a separate set of characters. Headlines are written in those characters.

### The shape of every point

```
𝗢𝗡𝗘 𝗣𝗘𝗥𝗦𝗢𝗡 𝗥𝗨𝗡𝗦 𝗛𝗥 𝗔𝗡𝗗 𝗖𝗟𝗜𝗡𝗜𝗖𝗔𝗟 — Aurelie Benittah, the Operations Manager, covers both. One
person carrying HR for a part-time, multi-state workforce is the clearest sign they have outgrown
what they are using. (their team page) [8/18/2026]
```

**Headline, em dash, detail.** The headline is a two-to-eight word summary of the point — what a rep
would take away if they read nothing else. Section headings on their own line get the same treatment.

### Only the headline is bolded, and that is deliberate

**Zoho's search does not match bold characters against ordinary typing.** Searching `payroll` will not
find a bold `𝗣𝗔𝗬𝗥𝗢𝗟𝗟` headline. So the bold is confined to the headline, and **every fact, name,
number, phone, date and source stays in normal characters** where search can reach it. Never bold a
company name, a person's name, a number or anything inside brackets.

### Writing the characters

Capital A–Z start at `U+1D5D4`, lowercase at `U+1D5EE`, digits at `U+1D7EC`. Punctuation and spaces
are unchanged. The alphabet, for reference:

```
𝗔 𝗕 𝗖 𝗗 𝗘 𝗙 𝗚 𝗛 𝗜 𝗝 𝗞 𝗟 𝗠 𝗡 𝗢 𝗣 𝗤 𝗥 𝗦 𝗧 𝗨 𝗩 𝗪 𝗫 𝗬 𝗭
𝟬 𝟭 𝟮 𝟯 𝟰 𝟱 𝟲 𝟳 𝟴 𝟵
```

**When the Lead Bot dashboard is doing the writing, do not bold anything yourself.** Write the
headline in ordinary capitals followed by an em dash and the app converts it. Writing bold characters
into a payload the app will also process risks double-conversion. When you are writing to Zoho
directly from this skill, do the conversion yourself.

**Bolding happens last**, after the absence filter and the plain-English checks. Those match ordinary
letters; a bolded `no match` would sail straight past them.

---

## Notes — findings first, and there is no limit on how many

Zoho takes as many notes as you want. **Use that.** One long note gets skimmed; several short
well-titled ones get read. Split a topic out into its own note whenever it has enough in it to stand
alone.

**Write them in this order, because this is the order a rep needs them:**

| # | Note | Always? | What belongs in it |
|---|---|---|---|
| 1 | `PAYROLL FINDINGS` | **Yes** | Everything that bears on payroll, HR or benefits. The most important note on the record |
| 2 | `COMPANY STRUCTURE` | When there is more than one legal entity | Every related entity, its headcount and employer ID, and the total |
| 3 | `CONTACT` | **Yes** | Who to call, how to reach them, how confident you are |
| 4 | `COMPANY BACKGROUND` | When there is more than the Description holds | Size, history, footprint, ownership, growth — with the evidence |
| 5 | `TIMING` | Only if something dated and timely surfaced | Why this is a call worth making now |
| 6 | `COMPLIANCE` | Only if an enforcement action or filing actually surfaced | Wage cases, tax warrants, adverse filings |
| 7 | `ICEBREAKERS` | Only if real openers exist | Conversation starters, and nothing else |

Extra notes are welcome when a topic earns one — `BENEFITS AND RETIREMENT`, `OPEN ROLES`,
`LOCATIONS`, `SOCIAL PRESENCE`. Title them plainly.

### Note 1 — `PAYROLL FINDINGS` — the most important note on the record

**This is the note the whole exercise is for, and it goes first.** Anything that touches how these
people get paid belongs here, in priority order, most payroll-relevant first.

**This is where the material that used to get buried in the icebreakers goes.** A retirement plan, a
benefits renewal date, an HR department of one, a workforce spread across six states, an overtime
exposure — those are findings. They are not conversation starters and they do not belong in the
icebreaker note.

What goes in, roughly in this order:

1. **How the workforce is shaped and what that does to payroll** — hourly or salaried, part-time
   heavy, shift work, multi-state, contractors, tipped, union. Say what the payroll consequence is.
2. **Who currently runs payroll and HR**, and how thin that is.
3. **The payroll provider**, with what makes you think so.
4. **Retirement plan, benefits, workers' comp and their brokers**, with renewal dates if you found
   them.
5. **Open roles that reveal pain** — a payroll or HR opening, a first finance hire.
6. **Anything else with a payroll consequence** — new state registrations, an acquisition, rapid
   hiring.

**If the company runs more than one legal entity, say so here as well**, in one line, and point at the
`COMPANY STRUCTURE` note for the breakdown. Several employer IDs usually means payroll split across
systems or people, which is a real opening.

Each item gets what you found, where it came from, and what it means for payroll:

```
𝗛𝗢𝗪 𝗧𝗛𝗘𝗬 𝗣𝗔𝗬 𝗣𝗘𝗢𝗣𝗟𝗘
· 𝗣𝗔𝗥𝗧-𝗧𝗜𝗠𝗘 𝗦𝗧𝗔𝗙𝗙 𝗦𝗣𝗥𝗘𝗔𝗗 𝗔𝗖𝗥𝗢𝗦𝗦 𝗖𝗟𝗜𝗘𝗡𝗧 𝗛𝗢𝗠𝗘𝗦 — their therapists are employees on payroll
  rather than contractors, and a lot of the open roles are part-time. Timekeeping and overtime are
  the daily grind here, not a once-a-fortnight task. (their careers page) [8/18/2026]
· 𝗦𝗜𝗫 𝗦𝗧𝗔𝗧𝗘𝗦, 𝗦𝗜𝗫 𝗦𝗘𝗧𝗦 𝗢𝗙 𝗣𝗔𝗬𝗥𝗢𝗟𝗟 𝗔𝗖𝗖𝗢𝗨𝗡𝗧𝗦 — every state means its own payroll tax account,
  its own unemployment insurance rate and its own filing calendar. At 100-plus staff that is a real
  administrative load for a company this size. (company website) [8/18/2026]

𝗪𝗛𝗢 𝗥𝗨𝗡𝗦 𝗣𝗔𝗬𝗥𝗢𝗟𝗟 𝗧𝗢𝗗𝗔𝗬
· 𝗛𝗥 𝗜𝗦 𝗢𝗡𝗘 𝗣𝗘𝗥𝗦𝗢𝗡, 𝗣𝗔𝗥𝗧-𝗧𝗜𝗠𝗘 — Aurelie Benittah, the Operations Manager, "oversees both the HR
  and clinical departments". One person carrying HR for a part-time, multi-state workforce is the
  clearest sign on this record that they have outgrown what they are using. (their team page)
  [8/18/2026]

𝗪𝗛𝗔𝗧 𝗧𝗛𝗘𝗬 𝗨𝗦𝗘 𝗡𝗢𝗪
· Their careers page is a hand-built form with no job-application software behind it, there are no
  employee login links anywhere on the site, and no job posting names a payroll system. A company
  of 100-plus running a hand-built careers page is usually on something basic. Worth asking
  directly on the call. (company website, job boards) [8/18/2026]

𝗥𝗘𝗧𝗜𝗥𝗘𝗠𝗘𝗡𝗧 𝗔𝗡𝗗 𝗕𝗘𝗡𝗘𝗙𝗜𝗧𝗦
· No federal retirement-plan filing came up for them, which for a company this size usually means
  either no 401(k) or a very new one. Worth asking — it is often the easiest thing to bundle.
```

### Note 2 — `CONTACT`

Who to call, how to reach them, and how sure you are. Verification stated in words.

```
𝗪𝗛𝗢 𝗧𝗢 𝗖𝗔𝗟𝗟
Malkie Nussbaum, Founder and Clinical Director. She owns the business outright, so she can decide
on her own — no board, no parent company.

We are confident she still runs it. Her company's own team page names her as founder and clinical
director, a press release quotes her in that role, and she is listed as the owner on every one of the
company's federal healthcare registrations. (company website, company press release, federal
healthcare provider registry) [8/18/2026]

𝗛𝗢𝗪 𝗧𝗢 𝗥𝗘𝗔𝗖𝗛 𝗛𝗘𝗥
· Mobile 908-910-2924 — confirmed twice, by ZoomInfo and by the federal provider registry, which
  lists this same number for her personally. DO NOT DIAL THIS ONE — ZoomInfo has it flagged Do Not
  Call. (ZoomInfo, federal healthcare provider registry) [9/30/2025]
· Main office 732-886-8113, then extension 103 for the Operations Manager, 102 for the case
  coordinator. This is the way in.
· Email malkie@achievebt.com — confirmed by ZoomInfo. Two other staff addresses follow the same
  first-name pattern, so it is almost certainly right.
· LinkedIn linkedin.com/in/malka-nussbaum

𝗔𝗟𝗦𝗢 𝗪𝗢𝗥𝗧𝗛 𝗞𝗡𝗢𝗪𝗜𝗡𝗚
· Aurelie Benittah, Operations Manager (extension 103, aurelie@achievebt.com). She runs HR day to
  day, so she is who a conversation about payroll actually ends up with.
```

### Note 3 — `COMPANY BACKGROUND`

The evidence behind the Description and the numbers in the fields — size, history, locations,
ownership, growth. Written as sentences, sources named in words.

### Note 4 — `TIMING`

**Only when something dated and genuinely timely surfaced.** Skip it otherwise.

```
· They announced they were expanding into five more states. Anything that follows — new payroll tax
  accounts, new staff, new pay rules — is happening right now. (company press release) [6/24/2026]
· They have part-time openings in Minnesota and Colorado. Minnesota was not in the June
  announcement, so they are still adding states. (their careers page) [8/18/2026]
```

### Note 5 — `COMPLIANCE`

**Only when an enforcement action, tax warrant or adverse filing actually surfaced.** Never as an
empty heading, never to say a search came back clear.

```
The US Department of Labor investigated them for unpaid wages and closed the case in 3/2023 (case
1900001). They paid $41,250 in back wages covering 17 employees, all of it for overtime
miscalculation across 1/2021 to 12/2022 — twelve separate overtime violations. (US Department of
Labor) [3/2023]
https://enforcedata.dol.gov/

Why it matters: they have already paid once for getting overtime wrong, which is the single
strongest reason a shift-based employer changes payroll providers.
```

An enforcement finding needs an **exact name match plus a matching state or address** before it is
written as a statement. Anything less, say a case exists under a matching name and needs checking,
with the link. If several unrelated companies share the name, write nothing and route it to a human.

### Note 6 — `ICEBREAKERS` — openers only

**Icebreakers are conversation starters. Nothing else goes in this note.** The recent run put a
retirement-plan question, a state-registration finding and an HR-staffing observation in here — all
three are payroll findings and belong in note 1. That mistake makes the icebreakers unusable,
because a rep opening this note wants three things they could say in the first thirty seconds, not a
research dump.

**The test:** could a rep say this out loud to a stranger in the first minute, and have it land as
interest rather than as a pitch? If not, it is a finding, not an icebreaker.

Three to six. Most of them should come from social media, and at least one from the person's own
account. Each one gives the rep the actual words to use.

```
· In her own words, "we believe in short-term therapy and long-term results." Easy opener — ask how
  the expansion she announced that day has gone. (company press release) [6/24/2026]
· She shared her company's introduction post and tagged it #autismfamily, and her profile says she
  writes about parenting and child development. Opening on the mission she clearly cares about will
  land better than opening on admin. (her LinkedIn) [5/2/2024]
· Their company blog put out five posts in a week, the latest about elopement in autism.
  Complimenting the writing is a genuine, specific thing to notice. (company blog) [8/17/2026]
```

If a fact is both a finding and a good opener, **put the detail in note 1 and one line here**, and
say where the rest is. Do not duplicate the whole thing.

If nothing real surfaced after the full social sweep, skip this note. **Never invent one.**

---
## Writing

```
mcp__Zoho_CRM__updateRecords(module: "Leads", data: [...])   // up to 100 per call
mcp__Zoho_CRM__createNotesModule(...)                        // one call per note
```

Batch the field updates; the notes go one call each. **Run the pre-write filter over the whole payload
first** — fields and notes together — and only then call the API.

On partial failure Zoho reports per-record status. Fix and retry **only** the failures; retrying the
whole batch double-writes the records that already succeeded.

If a field write is rejected for a picklist value or an unknown field, drop that one field and
complete the rest of the write rather than failing the record. Mention it once in the run report, not
once per lead — and if an unknown-field rejection happens, re-check the live schema before the next
batch, because this map may have gone stale.
