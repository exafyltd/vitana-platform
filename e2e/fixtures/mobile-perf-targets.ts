import type { MobilePerfTarget } from './smoke-helper';

/**
 * Load-time budgets for the 9 mobile screens users complained were slow.
 * Budgets mirror the synthetic-load-probe routine
 * (`routines/mobile-synthetic-load-probe.md`). Media Lab and Live Rooms carry
 * media players, so they get a slightly looser ceiling — tighten as those
 * routes are optimized.
 */
export const MOBILE_PERF_TARGETS: MobilePerfTarget[] = [
  { name: 'Events',       route: '/comm/events-meetups', lcp: 4000, load: 6000 },
  { name: 'Find a Match', route: '/comm/find-partner',   lcp: 4000, load: 6000 },
  { name: 'Chat History', route: '/inbox',               lcp: 4000, load: 6000 },
  { name: 'My Journey',   route: '/autopilot',           lcp: 4000, load: 6000 },
  { name: 'Settings',     route: '/settings',            lcp: 4000, load: 6000 },
  { name: 'Memory',       route: '/memory',              lcp: 4000, load: 6000 },
  { name: 'Media Lab',    route: '/comm/media-hub',      lcp: 4500, load: 7000 },
  { name: 'Live Rooms',   route: '/comm/live-rooms',     lcp: 4500, load: 7000 },
  { name: 'User Profile', route: '/me/profile',          lcp: 4000, load: 6000 },
];
