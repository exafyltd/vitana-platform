/**
 * VTID-NAV-02: SPA Routes Fallback List
 *
 * Hard-coded inventory of vitana-v1 React Router paths, used by the Admin
 * Navigator coverage + route-picker endpoints until CI wires in the
 * build-time extract (vitana-v1/scripts/extract-routes.ts →
 * src/generated/spa-routes.json shipped with the gateway deploy).
 *
 * Keep this list in sync with the routes mounted in vitana-v1/src/App.tsx.
 * When the generated JSON is available, the admin route handler should
 * prefer it over this fallback.
 *
 * `requires_auth` reflects whether the route is behind <AuthGuard> or
 * <ProtectedRoute> in App.tsx. `requires_role` is the specific role (when
 * ProtectedRoute narrows further, e.g. "community" or "admin").
 */

export interface SpaRoute {
  path: string;
  requires_auth: boolean;
  requires_role?: string;
  notes?: string;
}

export const SPA_ROUTES_FALLBACK: ReadonlyArray<SpaRoute> = [
  // ── Public / landing / auth ─────────────────────────────────────────────
  { path: '/', requires_auth: false, notes: 'Index / ShareEntry' },
  { path: '/_intro/:tenantSlug', requires_auth: false },
  { path: '/auth', requires_auth: false },
  { path: '/login', requires_auth: false, notes: 'redirect → /auth' },
  { path: '/register', requires_auth: false, notes: 'redirect → /auth' },
  { path: '/reset-password', requires_auth: false },
  { path: '/auth/confirmed', requires_auth: false },
  { path: '/maxina', requires_auth: false },
  { path: '/maxina/confirmed', requires_auth: false },
  { path: '/alkalma', requires_auth: false },
  { path: '/alkalma/confirmed', requires_auth: false },
  { path: '/earthlinks', requires_auth: false },
  { path: '/earthlinks/confirmed', requires_auth: false },
  { path: '/community', requires_auth: false },
  { path: '/community/confirmed', requires_auth: false },
  { path: '/exafy-admin', requires_auth: false },
  { path: '/privacy', requires_auth: false },
  { path: '/terms', requires_auth: false },
  { path: '/delete-account', requires_auth: false },
  { path: '/maxina_support', requires_auth: false },
  { path: '/redeem', requires_auth: false },
  { path: '/logout', requires_auth: false },
  { path: '/e/:slug', requires_auth: false },
  { path: '/pub/events/:id', requires_auth: false },
  { path: '/pub/campaigns/:id', requires_auth: false },

  // ── Home ────────────────────────────────────────────────────────────────
  { path: '/home', requires_auth: true, requires_role: 'community' },
  { path: '/home/context', requires_auth: true },
  { path: '/home/actions', requires_auth: true },
  { path: '/home/matches', requires_auth: true },
  { path: '/home/aifeed', requires_auth: true },

  // ── Discover / commerce ────────────────────────────────────────────────
  { path: '/discover', requires_auth: true },
  { path: '/discover/ai-picks', requires_auth: true },
  { path: '/discover/supplements', requires_auth: true },
  { path: '/discover/wellness-services', requires_auth: true },
  { path: '/discover/doctors-coaches', requires_auth: true },
  { path: '/discover/provider/:id', requires_auth: true },
  { path: '/discover/deals-offers', requires_auth: true },
  { path: '/discover/orders', requires_auth: true },
  { path: '/discover/product/:id', requires_auth: true },
  { path: '/cart', requires_auth: true },
  { path: '/checkout/success', requires_auth: true },
  { path: '/tickets/success', requires_auth: false },
  { path: '/packages/success', requires_auth: false },
  { path: '/my-tickets', requires_auth: true },
  { path: '/daily-diary', requires_auth: true },
  { path: '/creator/onboarded', requires_auth: true },

  // ── Health ──────────────────────────────────────────────────────────────
  { path: '/health', requires_auth: true },
  { path: '/health/my-biology', requires_auth: true },
  { path: '/health/plans', requires_auth: true },
  { path: '/health/conditions-risks', requires_auth: true },
  { path: '/health/education', requires_auth: true, notes: 'EducationResources' },
  { path: '/health/pillars', requires_auth: true },
  { path: '/health/wellness-services', requires_auth: true },

  // ── Community ───────────────────────────────────────────────────────────
  // NOTE: catalog currently uses /comm/* but SPA uses /community/*. This is
  // one of the known "wrong redirect" bugs the admin UI surfaces in coverage.
  { path: '/community/events-meetups', requires_auth: true },
  { path: '/community/groups', requires_auth: true },
  { path: '/community/groups/:id', requires_auth: true },
  { path: '/community/media-hub', requires_auth: true },
  { path: '/community/live-rooms', requires_auth: true },
  { path: '/community/live-rooms/:id', requires_auth: true },

  // ── AI ──────────────────────────────────────────────────────────────────
  { path: '/ai/insights', requires_auth: true },
  { path: '/ai/recommendations', requires_auth: true },
  { path: '/ai/daily-summary', requires_auth: true },
  { path: '/ai/companion', requires_auth: true },

  // ── Messages / inbox ────────────────────────────────────────────────────
  { path: '/messages', requires_auth: true },
  { path: '/messages/archived', requires_auth: true },
  { path: '/messages/reminder', requires_auth: true },
  { path: '/messages/inspiration', requires_auth: true },

  // ── Settings ────────────────────────────────────────────────────────────
  { path: '/settings', requires_auth: true },
  { path: '/settings/privacy', requires_auth: true },
  { path: '/settings/notifications', requires_auth: true },
  { path: '/settings/preferences', requires_auth: true },
  { path: '/settings/connected-apps', requires_auth: true },
  { path: '/settings/billing', requires_auth: true },
  { path: '/settings/support', requires_auth: true },
  { path: '/settings/tenant-role', requires_auth: true },
  { path: '/settings/social', requires_auth: true },

  // ── Wallet ──────────────────────────────────────────────────────────────
  { path: '/wallet', requires_auth: true },
  { path: '/wallet/balance', requires_auth: true },
  { path: '/wallet/subscriptions', requires_auth: true },
  { path: '/wallet/rewards', requires_auth: true },

  // ── Memory ──────────────────────────────────────────────────────────────
  { path: '/memory', requires_auth: true },
  { path: '/memory/timeline', requires_auth: true },
  { path: '/memory/recall', requires_auth: true },
  { path: '/memory/permissions', requires_auth: true },
  { path: '/memory/diary', requires_auth: true },

  // ── Profile / sharing ───────────────────────────────────────────────────
  { path: '/profile', requires_auth: true },
  { path: '/profile/edit', requires_auth: true },
  { path: '/u/:id', requires_auth: false },
  { path: '/sharing', requires_auth: true },
  { path: '/sharing/distribution', requires_auth: true },
  { path: '/sharing/data-consent', requires_auth: true },
  { path: '/sharing/campaigns', requires_auth: true },
  { path: '/sharing/campaigns/:id', requires_auth: true },

  // ── Admin (community-side) ──────────────────────────────────────────────
  { path: '/admin', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/dashboard', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/dashboard/health', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/dashboard/activity', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/users', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/users/signup-funnel', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/users/invitations', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/users/roles-access', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/notifications/compose', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/notifications/sent-log', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/notifications/preferences', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/live/sessions', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/live/attendance', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/intelligence/memory', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/intelligence/embeddings', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/intelligence/signals', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/intelligence/relationships', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/system/configuration', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/system/creators', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/audit/events', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/audit/user-activity', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/audit/api-monitor', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/audit/security', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/community/events', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/community/groups', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/community/reported-content', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/media', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/media/videos', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/media/podcasts', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/media/music', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/live-stream', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/community-rooms', requires_auth: true, requires_role: 'admin' },

  // ── Navigator admin (this feature) ──────────────────────────────────────
  { path: '/admin/navigator', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/navigator/coverage', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/navigator/telemetry', requires_auth: true, requires_role: 'admin' },
  { path: '/admin/navigator/history', requires_auth: true, requires_role: 'admin' },
];
