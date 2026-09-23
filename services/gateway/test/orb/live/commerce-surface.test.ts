/**
 * VTID-04326 — commerce is its own ORB surface (Orchestrator plan §8.3,
 * owner decision 2026-09-23). A partner organisation's voice session gets
 * the commerce persona and navigation/knowledge tools only: no community,
 * health, diary, memory or developer tools, and no personal brain context.
 */
import { resolveOrbSurface, isCommerceRoute, SURFACE_PERSONA_KEY } from '../../../src/orb/live/surface';
import { buildLiveApiTools, applySurfaceGate } from '../../../src/orb/live/tools/live-tool-catalog';
import { PERSONALITY_DEFAULTS, VALID_SURFACE_KEYS } from '../../../src/services/ai-personality-service';
import * as fs from 'fs';
import * as path from 'path';

function names(catalog: object[]): string[] {
  const out: string[] = [];
  for (const g of catalog as Array<Record<string, unknown>>) {
    if (Array.isArray(g.function_declarations)) for (const d of g.function_declarations as Array<{ name: string }>) out.push(d.name);
    else if ('google_search' in g) out.push('__google_search__');
  }
  return out;
}

describe('commerce surface resolution', () => {
  test.each([
    ['/commerce', 'commerce'], ['/commerce/health-orders/inbox', 'commerce'], ['/commerce/team', 'commerce'],
    ['/partner/connections', 'commerce'], ['/partner/connections/abc', 'commerce'], ['/Commerce/Team', 'commerce'],
    ['/commerce-login', 'vitanaland'], ['/commercex', 'vitanaland'], ['/partners', 'vitanaland'],
    ['/business', 'vitanaland'], ['/business/listings', 'vitanaland'],
  ])('route %s → %s', (route, expected) => {
    expect(resolveOrbSurface({ currentRoute: route })).toBe(expected);
  });

  test('commerce wins over the mobile rule; every other route on mobile stays community', () => {
    expect(resolveOrbSurface({ currentRoute: '/commerce/health-orders', isMobile: true })).toBe('commerce');
    expect(resolveOrbSurface({ currentRoute: '/backoffice', isMobile: true })).toBe('vitanaland');
    expect(resolveOrbSurface({ currentRoute: '/health', isMobile: true })).toBe('vitanaland');
  });

  test('isCommerceRoute matches only the commerce and partner trees', () => {
    expect(isCommerceRoute('/commerce')).toBe(true);
    expect(isCommerceRoute('/partner/connections')).toBe(true);
    expect(isCommerceRoute('/commerce-login')).toBe(false);
  });
});

describe('commerce tool catalog', () => {
  test('authenticated: navigation + knowledge only, nothing personal, admin, backoffice or developer', () => {
    const n = names(buildLiveApiTools('authenticated', '/commerce/health-orders', 'community'));
    expect(n).toEqual(expect.arrayContaining(['get_current_screen', 'navigate', 'end_conversation']));
    for (const banned of ['search_memory', 'save_diary_entry', 'search_events', 'set_reminder', 'send_chat_message', 'admin_briefing', 'operator_delegate', '__google_search__']) {
      expect(n).not.toContain(banned);
    }
    expect(n.filter((x) => x.startsWith('backoffice_') || x.startsWith('dev_') || x.startsWith('developer_'))).toEqual([]);
    const allowed = new Set(['get_current_screen', 'navigate', 'end_conversation', 'search_knowledge']);
    expect(n.every((x) => allowed.has(x))).toBe(true);
  });

  test('an admin or developer role on a commerce route gets the same narrow set', () => {
    for (const role of ['admin', 'developer']) {
      const n = names(buildLiveApiTools('authenticated', '/commerce', role));
      expect(n).not.toContain('admin_briefing');
      expect(n).not.toContain('search_memory');
    }
  });

  test('anonymous sessions are not widened', () => {
    expect(applySurfaceGate([], 'commerce', 'authenticated')).toEqual([]);
    const anon = names(buildLiveApiTools('anonymous', '/commerce/join', undefined));
    expect(anon).not.toContain('search_memory');
  });
});

describe('commerce persona and context', () => {
  test('commerce_orb is a valid persona key with voice-only intent fields', () => {
    expect(SURFACE_PERSONA_KEY.commerce).toBe('commerce_orb');
    expect(VALID_SURFACE_KEYS).toContain('commerce_orb');
    const p = PERSONALITY_DEFAULTS.commerce_orb as Record<string, string>;
    for (const k of ['voice_base_identity', 'voice_general_behavior', 'voice_greeting_rules', 'voice_tools_section', 'voice_important_section', 'voice_identity_lock_role']) {
      expect(typeof p[k]).toBe('string');
      expect(p[k].length).toBeGreaterThan(20);
    }
    // NEVER rule 41: intent, not a scripted spoken line.
    expect(JSON.stringify(p)).not.toMatch(/Say exactly/i);
  });

  test('the personal brain context is withheld on the commerce surface', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/orb/live/instruction/live-system-instruction.ts'), 'utf8');
    expect(src).toMatch(/resolvedSurface === 'commerce'\) \? '' : bootstrapContext/);
  });
});
