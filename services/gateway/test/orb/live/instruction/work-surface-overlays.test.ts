/** VTID-03848 — admin and backoffice persona overlays + memory scoping in the system instruction. */
import { buildLiveSystemInstruction } from '../../../../src/routes/orb-live';

const BOOTSTRAP = '## USER CONTEXT PROFILE\n[FACTS] Display name: Test30User. Birthday: 1990-04-12. Sleep score 71. Diary: felt anxious yesterday.\n[ACTIVITY_14D] 3 events, 2 diary entries.\n';
const build = (route: string, role: string, bootstrap = BOOTSTRAP, isMobile = false) =>
  buildLiveSystemInstruction('en', 'conversational', bootstrap, role, '', '', false, null, route, [], isMobile ? ({ isMobile: true } as any) : undefined, '@x');

describe('backoffice surface', () => {
  const bo = build('/backoffice/sales/leads', 'backoffice');
  test('speaks as the BackOffice operations assistant, not the community companion', () => {
    expect(bo).toContain('BackOffice operations assistant');
    expect(bo).toContain("the BackOffice operations assistant for the tenant's ERP and CRM work");
    expect(bo).not.toContain("the user's life companion and instruction manual");
  });
  test('advertises only backoffice tools in the prose directory', () => {
    expect(bo).toContain('### backoffice_command');
    expect(bo).toContain('### backoffice_pending_approvals');
    expect(bo).not.toContain('### search_memory');
    expect(bo).not.toContain('### admin_briefing');
    expect(bo).not.toContain('### save_diary_entry');
  });
  test('community brain context is NOT injected (memory scoping)', () => {
    expect(bo).not.toContain('Sleep score 71');
    expect(bo).not.toContain('felt anxious');
    expect(bo).not.toContain('ACTIVITY AWARENESS OVERRIDE');
  });
  test('states the voice ceiling', () => {
    expect(bo).toMatch(/Draft ceiling/);
  });
});

describe('admin surface', () => {
  const ad = build('/admin/dashboard', 'admin');
  test('speaks as the tenant administration assistant and drops community context', () => {
    expect(ad).toContain('tenant administration assistant');
    expect(ad).toContain("the tenant administrator's assistant for running their Vitanaland tenant");
    expect(ad).not.toContain('Sleep score 71');
    expect(ad).toContain('### admin_briefing');
    expect(ad).not.toContain('### search_memory');
    expect(ad).not.toContain('### backoffice_command');
  });
});

describe('unchanged surfaces', () => {
  test('community route keeps the companion identity and its context', () => {
    const c = build('/health', 'community');
    expect(c).toContain("the user's life companion and instruction manual");
    expect(c).toContain('Sleep score 71');
    expect(c).toContain('### search_memory');
    expect(c).not.toContain('### backoffice_command');
  });
  test('mobile on a backoffice route is still the community surface', () => {
    const m = build('/backoffice/dashboard', 'backoffice', BOOTSTRAP, true);
    expect(m).toContain("the user's life companion and instruction manual");
    expect(m).not.toContain('### backoffice_command');
  });
  test('command hub keeps the engineering co-pilot overlay', () => {
    expect(build('/command-hub', 'developer')).toContain("the developer's engineering co-pilot for the Vitana platform team");
  });
});
