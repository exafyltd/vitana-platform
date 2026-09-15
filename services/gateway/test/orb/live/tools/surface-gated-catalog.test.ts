/** VTID-03848 — the tool catalog is gated per surface: community/developer tools are ABSENT on admin and backoffice. */
import { buildLiveApiTools, applySurfaceGate } from '../../../../src/orb/live/tools/live-tool-catalog';
import { BACKOFFICE_TOOL_NAMES } from '../../../../src/services/backoffice-voice-tools';

function names(catalog: object[]): string[] {
  const out: string[] = [];
  for (const g of catalog as Array<Record<string, unknown>>) {
    if (Array.isArray(g.function_declarations)) for (const d of g.function_declarations as Array<{ name: string }>) out.push(d.name);
    else if ('google_search' in g) out.push('__google_search__');
  }
  return out;
}
const COMMUNITY_ONLY = ['search_memory', 'save_diary_entry', 'search_events', 'set_reminder', 'send_chat_message'];

describe('surface gating', () => {
  test('community surface is unchanged (admin role on /health still gets community + admin tools)', () => {
    const n = names(buildLiveApiTools('authenticated', '/health', 'admin'));
    expect(n).toEqual(expect.arrayContaining(['search_memory', 'admin_briefing', 'get_current_screen', 'navigate']));
    expect(n).not.toEqual(expect.arrayContaining(BACKOFFICE_TOOL_NAMES));
  });
  test('backoffice surface: navigation + knowledge + the four backoffice tools, nothing community or admin', () => {
    const n = names(buildLiveApiTools('authenticated', '/backoffice/sales/leads', 'backoffice'));
    expect(n).toEqual(expect.arrayContaining(['get_current_screen', 'navigate', 'end_conversation', 'search_knowledge', ...BACKOFFICE_TOOL_NAMES, '__google_search__']));
    for (const c of COMMUNITY_ONLY) expect(n).not.toContain(c);
    expect(n).not.toContain('admin_briefing');
    expect(n.filter((x) => x.startsWith('developer_') || x.startsWith('dev_'))).toEqual([]);
  });
  test('backoffice tools appear even for an admin role on the backoffice surface; admin tools do not', () => {
    const n = names(buildLiveApiTools('authenticated', '/backoffice/dashboard', 'admin'));
    expect(n).toEqual(expect.arrayContaining(BACKOFFICE_TOOL_NAMES));
    expect(n).not.toContain('admin_briefing');
    expect(n).not.toContain('search_memory');
  });
  test('admin surface: navigation + admin tools, no community tools, no backoffice tools', () => {
    const n = names(buildLiveApiTools('authenticated', '/admin/dashboard', 'admin'));
    expect(n).toEqual(expect.arrayContaining(['get_current_screen', 'navigate', 'end_conversation', 'search_knowledge', 'admin_briefing', 'admin_kpi_snapshot']));
    for (const c of COMMUNITY_ONLY) expect(n).not.toContain(c);
    expect(n).not.toEqual(expect.arrayContaining(BACKOFFICE_TOOL_NAMES));
  });
  test('explicit surface parameter overrides the route heuristic', () => {
    expect(names(buildLiveApiTools('authenticated', '/health', 'admin', 'backoffice'))).toEqual(expect.arrayContaining(BACKOFFICE_TOOL_NAMES));
  });
  test('anonymous sessions are not widened by the gate', () => {
    const anon = buildLiveApiTools('anonymous', '/backoffice', undefined);
    expect(names(anon)).not.toEqual(expect.arrayContaining(BACKOFFICE_TOOL_NAMES));
    expect(applySurfaceGate([], 'backoffice', 'authenticated')).toEqual([]);
  });
  test('command-hub surface is untouched by this VTID', () => {
    const before = names(buildLiveApiTools('authenticated', '/command-hub', 'developer'));
    expect(before).not.toEqual(expect.arrayContaining(BACKOFFICE_TOOL_NAMES));
    expect(before).toContain('search_memory'); // existing behaviour: developer surface keeps the community catalog (prose steers it)
  });
});
