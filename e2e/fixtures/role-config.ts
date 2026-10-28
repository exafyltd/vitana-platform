import type { UserRole } from './test-users';

/** Which UIs each role can access */
export const ROLE_UI_ACCESS: Record<UserRole, ('desktop' | 'mobile' | 'hub')[]> = {
  community:    ['desktop', 'mobile'],
  patient:      ['desktop', 'mobile'],
  professional: ['desktop', 'mobile'],
  staff:        ['desktop', 'mobile', 'hub'],
  admin:        ['desktop', 'mobile', 'hub'],
  developer:    ['hub'],
};

/** Expected key UI elements per role on Lovable frontend */
export const ROLE_EXPECTED_ELEMENTS: Record<string, string[]> = {
  community:    ['header', 'nav', '[data-testid="autopilot"]'],
  patient:      ['header', 'nav'],
  professional: ['header', 'nav'],
  staff:        ['header', 'nav'],
  admin:        ['header', 'nav'],
};

/** Expected elements on Command Hub per role */
export const HUB_EXPECTED_ELEMENTS: Record<string, string[]> = {
  developer: ['.sidebar', '.header', '#root'],
  admin:     ['.sidebar', '.header', '#root'],
  staff:     ['.sidebar', '.header', '#root'],
};
