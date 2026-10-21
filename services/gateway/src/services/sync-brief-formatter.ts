/**
 * VTID-01221: Sync Brief Formatter
 *
 * Enforces the "Sync Brief" conversation behavior contract for DEV-mode ORB and Operator.
 * When Autopilot has recommendations, responses must follow this format:
 *
 * 1. Where you are (screen + selection + VTID if present)
 * 2. What Autopilot recommends (top 1-3 recommendations)
 * 3. Why (one-line evidence)
 * 4. Copy/paste commands (if available)
 * 5. Verification checklist (short)
 *
 * ORB should never invent next steps while Autopilot has an opinion.
 */

import { recommendationSyncEvents } from './oasis-event-service';

// =============================================================================
// Types
// =============================================================================

export interface Recommendation {
  id: string;
  title: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  rationale: string;
  suggested_commands?: string[];
  verification?: string[];
  related_vtids?: string[];
  requires_approval?: boolean;
  source?: string;
}

export interface UIContext {
  surface?: string;
  screen?: string;
  selection?: string;
}

export interface SyncBriefContext {
  vtid?: string | null;
  uiContext?: UIContext;
  recommendations: Recommendation[];
  isFallback?: boolean;
  fallbackReason?: string;
}

export interface SyncBriefResult {
  formatted: string;
  recommendationIds: string[];
  hasSuggestions: boolean;
  format: 'sync-brief' | 'fallback' | 'empty';
}

// =============================================================================
// Priority Ordering
// =============================================================================

const PRIORITY_ORDER: Record<string, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

function sortByPriority(recommendations: Recommendation[]): Recommendation[] {
  return [...recommendations].sort((a, b) => {
    const priorityA = PRIORITY_ORDER[a.priority] || 5;
    const priorityB = PRIORITY_ORDER[b.priority] || 5;
    return priorityA - priorityB;
  });
}

// =============================================================================
// Sync Brief Formatter
// =============================================================================

/**
 * Format recommendations into the Sync Brief format
 *
 * @param context - Current context including VTID, UI state, and recommendations
 * @param maxRecommendations - Max recommendations to show (default: 3)
 * @returns Formatted sync brief string and metadata
 */
export function formatSyncBrief(
  context: SyncBriefContext,
  maxRecommendations: number = 3
): SyncBriefResult {
  const { vtid, uiContext, recommendations, isFallback, fallbackReason } = context;

  // Handle empty recommendations
  if (!recommendations || recommendations.length === 0) {
    return {
      formatted: formatEmptyState(vtid, uiContext),
      recommendationIds: [],
      hasSuggestions: false,
      format: 'empty',
    };
  }

  // Sort and limit recommendations
  const sorted = sortByPriority(recommendations);
  const topRecs = sorted.slice(0, maxRecommendations);

  const lines: string[] = [];

  // Section 1: Where You Are
  lines.push('## Where You Are');
  if (uiContext?.surface || uiContext?.screen) {
    const location = [uiContext.surface, uiContext.screen].filter(Boolean).join(' > ');
    lines.push(location || 'Unknown location');
  } else {
    lines.push('Developer Console');
  }
  if (uiContext?.selection) {
    lines.push(`Selection: ${uiContext.selection}`);
  }
  if (vtid) {
    lines.push(`Working on: **${vtid}**`);
  }
  lines.push('');

  // Fallback warning if applicable
  if (isFallback) {
    lines.push('> **Note:** Autopilot unavailable. Showing fallback analysis.');
    if (fallbackReason) {
      lines.push(`> Reason: ${fallbackReason}`);
    }
    lines.push('');
  }

  // Section 2: What Autopilot Recommends
  lines.push('## What Autopilot Recommends');
  topRecs.forEach((rec, index) => {
    const priorityBadge = rec.priority === 'critical' || rec.priority === 'high'
      ? ` [${rec.priority.toUpperCase()}]`
      : '';
    const approvalBadge = rec.requires_approval ? ' (requires approval)' : '';
    lines.push(`${index + 1}. **${rec.title}**${priorityBadge}${approvalBadge}`);

    // Section 3: Why (rationale)
    if (rec.rationale) {
      lines.push(`   _${rec.rationale}_`);
    }

    // Related VTIDs
    if (rec.related_vtids && rec.related_vtids.length > 0) {
      lines.push(`   Related: ${rec.related_vtids.join(', ')}`);
    }
  });
  lines.push('');

  // Section 4: Commands (from top recommendation)
  const topRec = topRecs[0];
  if (topRec.suggested_commands && topRec.suggested_commands.length > 0) {
    lines.push('## Commands');
    lines.push('```');
    topRec.suggested_commands.forEach(cmd => {
      lines.push(cmd);
    });
    lines.push('```');
    lines.push('');
  }

  // Section 5: Verification (from top recommendation)
  if (topRec.verification && topRec.verification.length > 0) {
    lines.push('## Verification');
    topRec.verification.forEach(step => {
      lines.push(`- [ ] ${step}`);
    });
    lines.push('');
  }

  // Additional recommendations summary
  if (recommendations.length > maxRecommendations) {
    lines.push(`_${recommendations.length - maxRecommendations} more recommendation(s) available._`);
    lines.push('');
  }

  return {
    formatted: lines.join('\n'),
    recommendationIds: topRecs.map(r => r.id),
    hasSuggestions: true,
    format: isFallback ? 'fallback' : 'sync-brief',
  };
}

/**
 * Format empty state when no recommendations are available
 */
function formatEmptyState(vtid?: string | null, uiContext?: UIContext): string {
  const lines: string[] = [];

  lines.push('## Where You Are');
  if (uiContext?.surface || uiContext?.screen) {
    const location = [uiContext.surface, uiContext.screen].filter(Boolean).join(' > ');
    lines.push(location || 'Developer Console');
  } else {
    lines.push('Developer Console');
  }
  if (vtid) {
    lines.push(`Working on: **${vtid}**`);
  }
  lines.push('');

  lines.push('## Status');
  lines.push('No recommendations available at this time.');
  lines.push('');
  lines.push('_Tip: Ask about a specific VTID or check the task queue._');

  return lines.join('\n');
}

// =============================================================================
// Intent Detection for "What Next" Queries
// =============================================================================

/**
 * Patterns that trigger the "what next" intent
 * When matched, ORB/Operator should call autopilot_get_recommendations
 */
export const WHAT_NEXT_PATTERNS = [
  /what.*next/i,
  /what.*should.*do/i,
  /what.*do.*now/i,
  /what.*should.*we.*do/i,
  /recommend/i,
  /suggestion/i,
  /advise/i,
  /what's.*the.*plan/i,
  /next.*step/i,
  /what.*action/i,
  /what.*to.*do/i,
];

/**
 * Check if user message matches "what next" intent
 */
export function isWhatNextIntent(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  return WHAT_NEXT_PATTERNS.some(pattern => pattern.test(trimmed));
}

// =============================================================================
// Debounce State (for rate limiting)
// =============================================================================

interface DebounceState {
  lastCallTime: number;
  sessionId: string;
}

const debounceMap = new Map<string, DebounceState>();
const DEBOUNCE_MS = 5000; // 5 seconds between calls per session

/**
 * Check if a recommendations request should be allowed (rate limiting)
 *
 * @param sessionId - User session ID
 * @returns true if request should proceed, false if debounced
 */
export function shouldFetchRecommendations(sessionId: string): boolean {
  const now = Date.now();
  const state = debounceMap.get(sessionId);

  if (!state) {
    debounceMap.set(sessionId, { lastCallTime: now, sessionId });
    return true;
  }

  if (now - state.lastCallTime >= DEBOUNCE_MS) {
    state.lastCallTime = now;
    return true;
  }

  return false;
}

/**
 * Reset debounce state for a session
 */
export function resetDebounce(sessionId: string): void {
  debounceMap.delete(sessionId);
}

// =============================================================================
// Emit Presentation Event
// =============================================================================

/**
 * Map internal format types to telemetry format types
 */
function mapFormatToTelemetry(format: SyncBriefResult['format']): 'sync-brief' | 'list' | 'inline' {
  switch (format) {
    case 'sync-brief':
      return 'sync-brief';
    case 'fallback':
      return 'list';  // Fallback is presented as a list
    case 'empty':
      return 'inline';  // Empty state is inline
    default:
      return 'sync-brief';
  }
}

/**
 * Emit telemetry when recommendations are presented via Sync Brief
 */
export async function emitSyncBriefPresented(
  vtid: string | null,
  result: SyncBriefResult,
  channel: 'orb' | 'operator' | 'panel'
): Promise<void> {
  if (result.recommendationIds.length > 0) {
    const telemetryFormat = mapFormatToTelemetry(result.format);
    await recommendationSyncEvents.recommendationPresented(
      vtid,
      result.recommendationIds,
      channel,
      telemetryFormat
    ).catch(err => {
      console.warn(`[VTID-01221] Failed to emit presentation event: ${err.message}`);
    });
  }
}
