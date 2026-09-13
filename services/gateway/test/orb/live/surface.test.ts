/** VTID-03848 — one resolver for every ORB surface decision. */
import { resolveOrbSurface, isWorkSurface, SURFACE_PERSONA_KEY, navigatorRoleForSurface } from '../../../src/orb/live/surface';

describe('resolveOrbSurface', () => {
  test.each([
    ['/', 'vitanaland'], ['/health', 'vitanaland'], ['/maxina', 'vitanaland'], [undefined, 'vitanaland'], ['', 'vitanaland'],
    ['/command-hub', 'command-hub'], ['/command-hub/cockpit', 'command-hub'],
    ['/admin', 'admin'], ['/admin/dashboard', 'admin'], ['/administration', 'vitanaland'],
    ['/backoffice', 'backoffice'], ['/backoffice/sales/leads', 'backoffice'], ['/BackOffice/Dashboard', 'backoffice'], ['/backofficex', 'vitanaland'],
  ])('route %s → %s', (route, expected) => {
    expect(resolveOrbSurface({ currentRoute: route as string })).toBe(expected);
  });
  test('mobile is always the community surface, whatever the route', () => {
    expect(resolveOrbSurface({ currentRoute: '/backoffice/dashboard', isMobile: true })).toBe('vitanaland');
    expect(resolveOrbSurface({ currentRoute: '/admin', isMobile: true })).toBe('vitanaland');
  });
  test('an explicit valid surface wins; an invalid one is ignored', () => {
    expect(resolveOrbSurface({ currentRoute: '/health', explicit: 'backoffice' })).toBe('backoffice');
    expect(resolveOrbSurface({ currentRoute: '/backoffice', explicit: 'nope' })).toBe('backoffice');
  });
  test('work surfaces, persona keys and navigator roles', () => {
    expect(isWorkSurface('vitanaland')).toBe(false);
    expect(['command-hub', 'admin', 'backoffice'].every((s) => isWorkSurface(s as any))).toBe(true);
    expect(SURFACE_PERSONA_KEY).toEqual({ vitanaland: null, 'command-hub': 'dev_orb', admin: 'admin_orb', backoffice: 'backoffice_orb' });
    expect(navigatorRoleForSurface('backoffice')).toBe('backoffice');
    expect(navigatorRoleForSurface('admin')).toBe('admin');
    expect(navigatorRoleForSurface('command-hub')).toBe('developer');
    expect(navigatorRoleForSurface('vitanaland')).toBe('community');
  });
});
