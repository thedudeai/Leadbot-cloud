#!/usr/bin/env node
// Stand-in for the Claude Code CLI: reads the prompt from stdin, answers with the
// same stream-json shape the real CLI emits, choosing the payload by prompt type.
let prompt = '';
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', () => {
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let json;
  if (prompt.includes('one-shot capability check')) json = { skill: true, zoho: true, zohoLeadsReachable: true, zoominfo: true, websearch: true, notes: 'stub' };
  else if (prompt.includes('fetching a candidate list')) json = { error: null, leads: [{ id: '111', company: 'Stub Co', city: 'Brooklyn', state: 'NY', industry: 'Health', contact: 'A B', title: 'CEO', email: '', phone: '', mobile: '', website: '', employees: 12, created: '2026-09-01T00:00:00', profiledDate: null }] };
  else if (prompt.includes('Execute Step 6')) json = { ok: true, leadId: (prompt.match(/"leadId": "(\d+)"/) || [])[1], fieldsWritten: ['Description'], notesWritten: ['PAYROLL FINDINGS'], newLeadId: null, overrides: [], error: null };
  else if (prompt.includes('BASIC PROFILE of one company')) {
    const id = (prompt.match(/Zoho record id: (\d+)/) || [])[1];
    const company = (prompt.match(/- Company: (.*)/) || [])[1];
    json = { leadId: id, company, employees: 310, employeesBasis: 'sum of facilities', contactChanged: false,
      basic: { companyType: 'Skilled nursing group', ownership: 'Two partners', ceo: 'Sam Roth', employees: 310, employeesBasis: 'sum of facilities', facilities: 4, hcm: 'Paylocity', hcmEvidence: 'apply links go to recruiting.paylocity.com', hq: 'Lakewood, NJ', execLocation: 'Lakewood, NJ', gaps: ['fieldStaff'] },
      contact: { firstName: 'Sam', lastName: 'Roth', title: 'CEO', email: 'sam@x.com', emailVerified: true, directPhone: '7325551212', directPhoneVerified: true, employmentVerifiedBy: 'ZoomInfo 9/10/2026', replacesRecordContact: false },
      additionalContacts: [{ firstName: 'Dina', lastName: 'Klein', title: 'CFO', functionalRole: 'CFO', email: 'dina@x.com', directPhone: '', reason: 'c-suite' }],
      fields: { Description: `${company} operates four skilled nursing facilities in Ohio.`, Employee_Count: 310, Number_of_Locations: '4', HCM: 'Paylocity', City: 'Lakewood', State: 'NJ' },
      notes: { 'BASIC PROFILE': '· OWNED BY TWO PARTNERS — Sam Roth and Dina Klein. (ZoomInfo) [9/10/2026]' }, needsHuman: null };
  }
  else if (prompt.includes('- Company: Runaway Inc')) {
    // A session that never converges: one tool call every 50ms, forever. The
    // server's tool-call wall has to end it, and the basic fallback has to run.
    const tick = () => { say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'again' } }] } }); setTimeout(tick, 50); };
    tick();
    return;
  }
  else if (prompt.includes('- Company: Hung Inc')) {
    // A session that goes silent: prints one line, then nothing, ever. The idle
    // watchdog (or a Stop from the dashboard) has to end it.
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'then silence' } }] } });
    setInterval(() => {}, 1 << 30);
    return;
  }
  else {
    const id = (prompt.match(/Zoho record id: (\d+)/) || [])[1];
    const company = (prompt.match(/- Company: (.*)/) || [])[1];
    json = { leadId: id, company, disqualified: null, employees: '40', employeesBasis: 'stated', contactChanged: 'false',
      contact: { firstName: 'Pat', lastName: 'Lee', title: 'CEO', priority: 1, email: 'PAT@x.com ', emailVerified: true, directPhone: '2125551212', directPhoneVerified: true, employmentVerifiedBy: 'LinkedIn 9/1/2026', reachable: true },
      leadership: [
        { firstName: 'Pat', lastName: 'Lee', title: 'CEO', directPhone: '2125551212', source: 'ZoomInfo', date: '9/1/2026' },
        { firstName: 'Ana', lastName: 'Cruz', title: 'CFO', functionalRole: 'CFO', directPhone: '212-555-3434', email: 'ana@x.com', source: 'company website', date: '9/1/2026' },
        { firstName: 'Bo', lastName: 'Kim', title: 'COO', mobilePhone: '917-555-0101', source: 'ZoomInfo', date: '9/1/2026' },
        { firstName: 'No', lastName: 'Phone', title: 'CIO', email: 'no@x.com' },
        { firstName: 'Dee', lastName: 'Ennsee', title: 'President', directPhone: '212-555-9999', directPhoneDNC: true, source: 'ZoomInfo', date: '9/1/2026' },
        { firstName: 'Ghost', lastName: '', title: 'CEO' },
      ],
      entities: [], additionalContacts: [], fields: { Description: `${company} does things.\n· ONE — two (site) [9/1/2026]`, Employee_Count: 40, HCM: 'not found', Website: '' },
      notes: { 'PAYROLL FINDINGS': 'STAFF — forty people on payroll. (site) [9/1/2026]', 'COMPLIANCE': 'No violations found.' }, needsHuman: null,
      coverage: { directPhone: true, email: true, provider: false, headcount: true, socialIcebreaker: false, publicRecord: false } };
  }
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'stub search' } }] } });
  setTimeout(() => {
    const structured = prompt.includes('the structured output') ? json : undefined;
    say({ type: 'result', subtype: 'success', result: structured ? JSON.stringify(json) : '```json\n' + JSON.stringify(json) + '\n```', structured_output: structured, total_cost_usd: prompt.includes('BASIC PROFILE of one company') ? 0.05 : 0.42 });
    process.exit(0);
  }, 300);
});
