// Stand-in for Zoho's accounts and CRM hosts, just enough of the v8 API for the
// server's read, write and readiness paths. `state` is live: flip tokenOk to
// revoke the connection (the token endpoint fails and every old token is 401),
// or change scope to hand out a token that cannot write.
import http from 'node:http';

const FIELDS = ['id', 'Company', 'First_Name', 'Last_Name', 'Designation', 'Email', 'Phone', 'Mobile', 'Linkedin',
  'City', 'State', 'Industry', 'Employee_Count', 'Website', 'Lead_Status', 'Owner', 'Created_Time', 'Modified_Time',
  'Profiled_Date', 'Profile_Type', 'Description', 'Current_PR_Provider_new', 'HCM', 'Number_of_Locations',
  'First_Name1', 'Last_Name2', 'Email2', 'Phone2', 'Title2', 'Functional_Role2'];

const WRITE_SCOPES = 'ZohoCRM.modules.ALL ZohoCRM.settings.READ ZohoCRM.users.READ ZohoCRM.org.READ';

export function startZohoStub(port) {
  const state = { tokenOk: true, scope: WRITE_SCOPES, issued: 0, writes: [], notes: [], noteSeq: 0, noteUpdates: [], noteDeletes: [], coql: [], recordReads: [] };
  const leads = [{
    id: '111', Company: 'Stub Co', First_Name: 'A', Last_Name: 'B', Designation: 'CEO', Email: 'a@stub.test', Phone: '', Mobile: '',
    City: 'Brooklyn', State: 'NY', Industry: 'Health', Employee_Count: 12, Website: '', Lead_Status: 'New',
    Owner: { id: '999', name: 'Rep One' }, Created_Time: '2026-09-01T00:00:00-04:00', Modified_Time: '2026-09-02T00:00:00-04:00',
    Profiled_Date: null, Profile_Type: null,
  }];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      const p = url.pathname;
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (p === '/oauth/v2/token') {
        if (!state.tokenOk) return json(400, { error: 'invalid_code' });
        state.issued++;
        return json(200, { access_token: `stub-${state.issued}`, expires_in: 3600, scope: state.scope, token_type: 'Bearer' });
      }
      const auth = req.headers.authorization || '';
      if (!state.tokenOk || !/^Zoho-oauthtoken stub-\d+$/.test(auth)) return json(401, { code: 'INVALID_TOKEN', message: 'invalid oauth token', status: 'error' });
      if (p === '/crm/v8/org') return json(200, { org: [{ company_name: 'Stub Payroll Co', primary_email: 'boss@chs.test' }] });
      // The full record of any lead: the identity fields the picker row never carries.
      const one = p.match(/^\/crm\/v8\/Leads\/(\d+)$/);
      if (one && req.method === 'GET') {
        state.recordReads.push(one[1]);
        return json(200, { data: [{ id: one[1], First_Name: 'Pat', Last_Name: 'Lee', Designation: 'CEO', Website: 'https://www.alpha-care.example/', Email: 'pat@alpha-care.example',
          Phone: '(718) 555-0101', Mobile: '', Street: '1 Main St', City: 'Brooklyn', State: 'NY', Zip_Code: '11201', Company_Number: '(718) 555-0100', Industry: 'Health',
          Employee_Count: 40, ZoomInfo_Company_Profile_URL: 'https://www.zoominfo.com/c/alpha-care/1', LinkedIn_Company_Profile_URL: 'https://www.linkedin.com/company/alpha-care',
          Entity_Name_Ultimate_Parent: 'Alpha Holdings LLC', Lead_Source: 'ZoomInfo', Description: 'Home care agency in Brooklyn.', Owner: { id: '999', name: 'Rep One' } }] });
      }
      if (p === '/crm/v8/settings/modules/Leads') return json(200, { modules: [{ api_name: 'Leads', editable: true }] });
      if (p === '/crm/v8/settings/fields') return json(200, { fields: FIELDS.map((n) => ({ api_name: n, data_type: 'text' })) });
      if (p === '/crm/v8/users' && url.searchParams.get('type') === 'CurrentUser') return json(200, { users: [{ id: '1', full_name: 'Boss', email: 'boss@zoho.test' }] });
      if (p === '/crm/v8/users') return json(200, { users: [
        { id: '1', full_name: 'Boss', email: 'boss@zoho.test', status: 'active' },
        { id: '999', full_name: 'Rep One', email: 'rep.one@zoho.test', status: 'active' }], info: { more_records: false } });
      if (p === '/crm/v8/coql' && req.method === 'POST') {
        const q = JSON.parse(body || '{}').select_query || '';
        state.coql.push(q);
        if (/select State from Leads/.test(q)) return json(200, { data: [{ State: 'NY' }, { State: 'NJ' }], info: { more_records: false } });
        return json(200, { data: leads, info: { count: leads.length, more_records: false } });
      }
      if (p === '/crm/v8/Leads' && req.method === 'PUT') {
        const d = JSON.parse(body).data[0];
        state.writes.push(d);
        return json(200, { data: [{ code: 'SUCCESS', status: 'success', message: 'record updated', details: { id: d.id } }] });
      }
      // Notes: list, add, update in place, delete. Every note carries who wrote it, so
      // the server can tell its own sections from a rep's.
      const m = p.match(/^\/crm\/v8\/Leads\/(\d+)\/Notes$/);
      if (m && req.method === 'GET') {
        const mine = state.notes.filter((n) => n.leadId === m[1]);
        if (!mine.length) { res.writeHead(204); return res.end(); }
        return json(200, { data: mine.map((n) => ({ id: n.id, Note_Title: n.Note_Title, Note_Content: n.Note_Content, Created_Time: n.Created_Time, Modified_Time: n.Modified_Time, Created_By: n.Created_By })), info: { more_records: false } });
      }
      if (m && req.method === 'POST') {
        const d = JSON.parse(body).data[0];
        const id = `n${++state.noteSeq}`, now = new Date().toISOString();
        state.notes.push({ leadId: m[1], id, Note_Title: d.Note_Title, Note_Content: d.Note_Content, Created_Time: now, Modified_Time: now, Created_By: { id: '1', name: 'Boss' } });
        return json(200, { data: [{ code: 'SUCCESS', status: 'success', details: { id } }] });
      }
      const one2 = p.match(/^\/crm\/v8\/Leads\/(\d+)\/Notes\/(\w+)$/);
      if (one2 && (req.method === 'PUT' || req.method === 'DELETE')) {
        const n = state.notes.find((x) => x.leadId === one2[1] && x.id === one2[2]);
        if (!n) return json(404, { data: [{ code: 'INVALID_DATA', status: 'error', message: 'no such note' }] });
        if (req.method === 'DELETE') { state.notes = state.notes.filter((x) => x !== n); state.noteDeletes.push(n.id); }
        else { const d = JSON.parse(body).data[0]; Object.assign(n, { Note_Title: d.Note_Title, Note_Content: d.Note_Content, Modified_Time: new Date().toISOString() }); state.noteUpdates.push(n.id); }
        return json(200, { data: [{ code: 'SUCCESS', status: 'success', details: { id: n.id } }] });
      }
      json(404, { code: 'INVALID_URL_PATTERN', message: `the stub has no route for ${req.method} ${p}` });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    state, base: `http://127.0.0.1:${port}`,
    // What the server reads from DATA_DIR/data/zoho.json to point at this stub.
    zohoJson: { dc: 'com', clientId: 'stub-client', clientSecret: 'stub-secret', refreshToken: 'stub-refresh', accountsBase: `http://127.0.0.1:${port}`, apiBase: `http://127.0.0.1:${port}` },
    close: () => server.close(),
  })));
}
