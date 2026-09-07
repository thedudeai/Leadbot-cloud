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
  else {
    const id = (prompt.match(/Zoho record id: (\d+)/) || [])[1];
    const company = (prompt.match(/- Company: (.*)/) || [])[1];
    json = { leadId: id, company, disqualified: null, employees: 40, employeesBasis: 'stated', contactChanged: false,
      contact: { firstName: 'Pat', lastName: 'Lee', title: 'CEO', priority: 1, email: 'pat@x.com', emailVerified: true, directPhone: '2125551212', directPhoneVerified: true, employmentVerifiedBy: 'LinkedIn 9/1/2026', reachable: true },
      entities: [], additionalContacts: [], fields: { Description: `${company} does things.\n· ONE — two (site) [9/1/2026]`, Employee_Count: 40 },
      notes: { 'PAYROLL FINDINGS': 'STAFF — forty people on payroll. (site) [9/1/2026]' }, needsHuman: null,
      coverage: { directPhone: true, email: true, provider: false, headcount: true, socialIcebreaker: false, publicRecord: false } };
  }
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'stub search' } }] } });
  setTimeout(() => {
    say({ type: 'result', result: '```json\n' + JSON.stringify(json) + '\n```', total_cost_usd: 0.42 });
    process.exit(0);
  }, 300);
});
