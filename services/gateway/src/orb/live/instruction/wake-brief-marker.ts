/**
 * VTID-03167 — shared sentinel marker, extracted from live-session-controller
 * to break circular import chain (new-day-overview-prompt depended on the
 * marker, controller depended on new-day-return.ts via wake-brief-wiring).
 */

export const VERTEX_WAKE_BRIEF_OVERRIDE_MARKER =
  '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>';
