/**
 * VTID-04821: Jev P3 E1 — Exafy company document search (Exafy Google Drive /
 * OneDrive, exafy.io accounts only) and Jev's relevance check in shadow.
 */
const rows: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
const connections: Record<string, any> = {};
jest.mock('../src/services/company-docs/company-docs-repository', () => ({
  fetchCompanyDocsConnection: jest.fn(async (_sb: unknown, _u: string, provider: string) => ({ data: connections[provider] ?? null, error: null })),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  COMPANY_DOCS_SCOPES, GOOGLE_DRIVE_SCOPE, companyDocsConnectUrl, companyDocsDomains, driveQuery, hasFilesScope, isCompanyAccount, oneDriveSearchPath, searchCompanyDocs, type CompanyDoc,
} from '../src/services/company-docs/company-docs';
import { docKind, isCompanyDocRelevanceOn, relevanceInput, runCompanyDocRelevance } from '../src/services/jev/gates/company-doc-relevance-gate';
import { TOOL_LANES } from '../src/services/jev/gates/operator-route-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_COMPANY_DOC_RELEVANCE_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const TENANT = '11111111-1111-4111-8111-111111111111';

const DOCS: CompanyDoc[] = [
  { provider: 'google', id: 'a', name: 'Partner agreement DRAFT old', mime: 'application/vnd.google-apps.document', modified: '2024-02-01T10:00:00Z', url: 'https://docs.google.com/a' },
  { provider: 'google', id: 'b', name: 'Partner agreement signed.pdf', mime: 'application/pdf', modified: '2026-09-01T10:00:00Z', url: 'https://drive.google.com/b' },
  { provider: 'microsoft', id: 'c', name: 'Agreements', mime: 'folder', modified: null, url: 'https://onedrive/c' },
];

function answer(best: string) {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { best: { type: 'choice', choice: best, probabilities: { [best]: 0.85 }, confidence: 0.85 } },
    usage: { input_tokens: 200, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
}

beforeEach(() => {
  rows.length = 0;
  for (const k of Object.keys(connections)) delete connections[k];
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04821 company accounts only', () => {
  test('default domain is exafy.io; COMPANY_DOCS_DOMAINS overrides', () => {
    expect(companyDocsDomains({} as any)).toEqual(['exafy.io']);
    expect(companyDocsDomains({ COMPANY_DOCS_DOMAINS: ' @Exafy.io, exafy.de ' } as any)).toEqual(['exafy.io', 'exafy.de']);
  });
  test.each([
    ['d.stevanovic@exafy.io', true],
    ['J.Tadic@EXAFY.IO', true],
    ['someone@gmail.com', false],
    ['x@mail.exafy.io', false],
    ['x@exafy.io.evil.com', false],
    ['exafy.io', false],
    [null, false],
  ])('%s → %s', (email, ok) => {
    expect(isCompanyAccount(email as any, ['exafy.io'])).toBe(ok);
  });
  test('read-only files scopes; the granted list must cover them', () => {
    expect(COMPANY_DOCS_SCOPES.google).toEqual(['openid', 'email', 'profile', GOOGLE_DRIVE_SCOPE]);
    expect(COMPANY_DOCS_SCOPES.microsoft).toContain('Files.Read.All');
    expect(COMPANY_DOCS_SCOPES.microsoft.some((s) => /write/i.test(s))).toBe(false);
    expect(hasFilesScope('google', `openid ${GOOGLE_DRIVE_SCOPE}`)).toBe(true);
    expect(hasFilesScope('google', ['https://www.googleapis.com/auth/gmail.readonly'])).toBe(false);
    expect(hasFilesScope('microsoft', ['https://graph.microsoft.com/files.read.all', 'User.Read'])).toBe(true);
    expect(hasFilesScope('microsoft', ['Mail.Read'])).toBe(false);
  });
  test('search terms are escaped for Drive and Graph', () => {
    expect(driveQuery("O'Neil \\ deck")).toBe("fullText contains 'O\\'Neil \\\\ deck' and trashed = false");
    expect(oneDriveSearchPath("O'Neil plan")).toBe("/me/drive/root/search(q='O''Neil%20plan')");
  });
});

describe('VTID-04821 search', () => {
  const company = (scopes: string[]) => ({ id: 'conn', provider_username: 'd.stevanovic@exafy.io', scopes });

  test('searches the Exafy Drive and OneDrive; names, kinds, dates and links only', async () => {
    connections.google = company([GOOGLE_DRIVE_SCOPE]);
    connections.microsoft = company(['Files.Read.All']);
    const f = jest.fn(async (url: string) => url.startsWith('https://www.googleapis.com/drive/v3/files?')
      ? jsonResponse(200, { files: [{ id: 'a', name: 'Deck', mimeType: 'application/pdf', modifiedTime: '2026-01-01T00:00:00Z', webViewLink: 'https://d/a', owners: [{ emailAddress: 'x@exafy.io' }] }] })
      : jsonResponse(200, { value: [{ id: 'c', name: 'Plan.docx', webUrl: 'https://o/c', lastModifiedDateTime: '2026-02-01T00:00:00Z', file: { mimeType: 'application/msword' } }] }));
    const r = await searchCompanyDocs('u1', 'deck', { sb, fetch: f as any, token: async (p) => `tok-${p}` });
    expect(r.sources).toEqual([
      { provider: 'google', status: 'searched', account: 'd.stevanovic@exafy.io' },
      { provider: 'microsoft', status: 'searched', account: 'd.stevanovic@exafy.io' },
    ]);
    expect(r.docs).toEqual([
      { provider: 'google', id: 'a', name: 'Deck', mime: 'application/pdf', modified: '2026-01-01T00:00:00Z', url: 'https://d/a' },
      { provider: 'microsoft', id: 'c', name: 'Plan.docx', mime: 'application/msword', modified: '2026-02-01T00:00:00Z', url: 'https://o/c' },
    ]);
    const [gUrl, gInit] = f.mock.calls[0] as any[];
    expect(gUrl).toContain('includeItemsFromAllDrives=true');
    expect(gInit.headers.Authorization).toBe('Bearer tok-google');
    expect(f.mock.calls[1][0]).toContain("/me/drive/root/search(q='deck')");
  });

  test('a private account, a missing scope or no connection is never searched', async () => {
    connections.google = { id: 'g', provider_username: 'dragan@gmail.com', scopes: [GOOGLE_DRIVE_SCOPE] };
    connections.microsoft = company(['Mail.Read']);
    const f = jest.fn();
    const token = jest.fn();
    const r = await searchCompanyDocs('u1', 'deck', { sb, fetch: f as any, token });
    expect(r.sources).toEqual([
      { provider: 'google', status: 'not_company_account' },
      { provider: 'microsoft', status: 'scope_missing', account: 'd.stevanovic@exafy.io' },
    ]);
    expect(f).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    delete connections.google;
    expect((await searchCompanyDocs('u1', 'deck', { sb, fetch: f as any, token })).sources[0]).toEqual({ provider: 'google', status: 'not_connected' });
  });

  test('one provider failing never hides the other', async () => {
    connections.google = company([GOOGLE_DRIVE_SCOPE]);
    connections.microsoft = company(['Files.Read.All']);
    const f = jest.fn(async (url: string) => url.includes('googleapis') ? jsonResponse(403, { error: { message: 'Drive API disabled' } }) : jsonResponse(200, { value: [{ id: 'c', name: 'Plan', folder: {} }] }));
    const r = await searchCompanyDocs('u1', 'plan', { sb, fetch: f as any, token: async () => 't' });
    expect(r.sources[0]).toEqual({ provider: 'google', status: 'provider_error', account: 'd.stevanovic@exafy.io', error: 'Drive API disabled' });
    expect(r.docs).toEqual([{ provider: 'microsoft', id: 'c', name: 'Plan', mime: 'folder', modified: null, url: null }]);
  });

  test('connect keeps the scopes the connection already has', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-state-secret-0123456789abcdef';
    connections.google = company(['https://www.googleapis.com/auth/gmail.readonly']);
    const r = await companyDocsConnectUrl({ userId: 'u1', tenantId: TENANT, provider: 'google', sb });
    expect(r.ok).toBe(true);
    const url = new URL((r as any).auth_url);
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual(expect.arrayContaining([GOOGLE_DRIVE_SCOPE, 'email', 'https://www.googleapis.com/auth/gmail.readonly']));
  });
});

describe('VTID-04821 Jev relevance gate', () => {
  test('company_doc_relevance: business data, internal plane, redacted, one choice question', () => {
    const d = getJevDecision('company_doc_relevance')!;
    expect(d.data).toBe('business');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal']);
    expect(Object.keys(d.questions)).toEqual(['best']);
  });
  test('input: numbered in provider order, short kinds, dates; never ids or links', () => {
    const i = relevanceInput('  partner agreement ', DOCS);
    expect(i).toEqual({
      query: 'partner agreement',
      candidates: [
        { n: 1, name: 'Partner agreement DRAFT old', kind: 'document', modified: '2024-02-01', source: 'drive' },
        { n: 2, name: 'Partner agreement signed.pdf', kind: 'pdf', modified: '2026-09-01', source: 'drive' },
        { n: 3, name: 'Agreements', kind: 'folder', modified: undefined, source: 'onedrive' },
      ],
    });
    expect(JSON.stringify(i)).not.toContain('https://');
    expect(docKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(docKind(null)).toBe('unknown');
  });
  test('off (default, typo), no tenant or no results: nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_COMPANY_DOC_RELEVANCE_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isCompanyDocRelevanceOn(env)).toBe(false);
      expect(await runCompanyDocRelevance({ query: 'x', docs: DOCS, tenantId: TENANT, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(await runCompanyDocRelevance({ query: 'x', docs: DOCS, tenantId: null, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runCompanyDocRelevance({ query: 'x', docs: [], tenantId: TENANT, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
  test.each([['d1', true], ['d2', false], ['none', false]])('Jev picks %s → agreed with provider rank 1: %s', async (best, agreed) => {
    expect(await runCompanyDocRelevance({ query: 'Partner agreement', docs: DOCS, tenantId: TENANT, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(best)) } })).toBe('s1');
    expect(rows[0]).toMatchObject({
      gate: 'company_doc_relevance', decision: 'company_doc_relevance', tenant_id: TENANT, subject_type: 'company_doc_search',
      system_action: 'provider_rank_1', jev_verdict: { best, results: 3, sources: ['drive', 'onedrive'] }, agreed, outcome: 'compared_with_provider_ranking',
    });
    expect(rows[0].subject_ref).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rows[0])).not.toContain('Partner agreement');
  });
  test('Jev down → fallback row; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runCompanyDocRelevance({ query: 'x', docs: DOCS, tenantId: TENANT, env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0 });
    await expect(runCompanyDocRelevance({ query: 'x', docs: [null as any], tenantId: TENANT, env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04821 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const op = fs.readFileSync(path.join(__dirname, '../src/services/gemini-operator.ts'), 'utf8');
  test('both tools are declared, dispatched, staff-only and in a router lane', () => {
    for (const name of ['dev_company_docs_search', 'dev_company_docs_connect']) {
      expect(op).toContain(`name: '${name}'`);
      expect(op).toContain(`case '${name}':`);
      expect(TOOL_LANES[name]).toBe('code_lookup');
    }
    const fn = op.slice(op.indexOf('export async function executeCompanyDocsTool('), op.indexOf('export async function executeTool('));
    expect(fn).toContain('if (!auth || !auth.user_id || !auth.exafy_admin) return');
    expect(fn).toContain('if (isCompanyDocRelevanceOn()) void runCompanyDocRelevance({ query, docs: found, tenantId });');
  });
  test('never on the member Connected Apps screen', () => {
    const cat = fs.readFileSync(path.join(__dirname, '../src/services/connected-apps/catalogue.ts'), 'utf8');
    expect(cat).not.toMatch(/drive\.readonly|Files\.Read/);
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_COMPANY_DOC_RELEVANCE_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_COMPANY_DOC_RELEVANCE_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_COMPANY_DOC_RELEVANCE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
