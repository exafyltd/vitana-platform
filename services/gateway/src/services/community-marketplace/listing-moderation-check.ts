/**
 * BOOTSTRAP-COMMUNITY-MARKETPLACE: v1 auto-moderation for peer-to-peer
 * listings. Deliberately simple (keyword-based) — this is a first line of
 * defense, not a replacement for the admin review queue (Chunk 7). Anything
 * this can't confidently pass gets routed to a human via requires_admin_review.
 *
 * Two outcomes are distinct:
 *   - `blocked` (thrown as ModerationBlockedError): the listing is never
 *     created. Reserved for categories flagged is_prohibited and for a
 *     small hard-block keyword list (weapons, drugs, counterfeit goods) —
 *     things that should never exist as a row, not just be hidden pending
 *     review.
 *   - `flagged` / requires_admin_review: the listing IS created, but with
 *     status forced to 'draft' (invisible in browse/search) until an admin
 *     clears it via PATCH /api/v1/admin/community-marketplace/listings/:id.
 */

export interface ModerationCategoryInfo {
  key: string;
  is_prohibited: boolean;
  requires_verified_provider: boolean;
  requires_admin_review_always: boolean;
}

export interface ModerationCheckInput {
  title: string;
  description: string;
  category: ModerationCategoryInfo;
  sellerVerificationStatus: string | null;
}

export interface ModerationCheckResult {
  auto_check_result: 'passed' | 'flagged';
  auto_check_reasons: string[];
  requires_admin_review: boolean;
  requires_admin_review_reason: string | null;
  requires_verified_provider: boolean;
  initial_status: 'active' | 'draft';
}

export class ModerationBlockedError extends Error {
  constructor(public reasonCode: string, message: string) {
    super(message);
    this.name = 'ModerationBlockedError';
  }
}

// Intentionally small and generic — not a substitute for human review, just
// enough to catch the most obvious hard-blocks without a human in the loop.
const HARD_BLOCK_PATTERNS: RegExp[] = [
  /\bweapon(s)?\b/i,
  /\bfirearm(s)?\b/i,
  /\bammunition\b/i,
  /\bnarcotic(s)?\b/i,
  /\bcounterfeit\b/i,
  /\breplica\s+(designer|luxury)\b/i,
];

const SOFT_FLAG_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bwire\s+transfer\s+only\b/i, reason: 'payment_pressure_wording' },
  { pattern: /\bguaranteed\s+profit\b/i, reason: 'scam_wording' },
  { pattern: /\bclick\s+(this|here)\s+link\b/i, reason: 'external_link_wording' },
  { pattern: /\bwhatsapp\s+me\b/i, reason: 'off_platform_contact_wording' },
];

export function runModerationCheck(input: ModerationCheckInput): ModerationCheckResult {
  const { title, description, category, sellerVerificationStatus } = input;
  const text = `${title}\n${description}`;

  if (category.is_prohibited) {
    throw new ModerationBlockedError('category_prohibited', `Category "${category.key}" is not allowed for listings.`);
  }
  for (const pattern of HARD_BLOCK_PATTERNS) {
    if (pattern.test(text)) {
      throw new ModerationBlockedError('prohibited_content', 'Listing content matches a prohibited-item pattern.');
    }
  }

  const reasons: string[] = [];
  for (const { pattern, reason } of SOFT_FLAG_PATTERNS) {
    if (pattern.test(text)) reasons.push(reason);
  }

  const requiresVerifiedProvider = category.requires_verified_provider;
  const isVerified = sellerVerificationStatus === 'verified';
  if (requiresVerifiedProvider && !isVerified) {
    reasons.push('unverified_provider_for_gated_category');
  }
  if (category.requires_admin_review_always) {
    reasons.push('category_requires_admin_review');
  }

  const requiresAdminReview = reasons.length > 0;

  return {
    auto_check_result: requiresAdminReview ? 'flagged' : 'passed',
    auto_check_reasons: reasons,
    requires_admin_review: requiresAdminReview,
    requires_admin_review_reason: requiresAdminReview ? reasons.join('; ') : null,
    requires_verified_provider: requiresVerifiedProvider,
    initial_status: requiresAdminReview ? 'draft' : 'active',
  };
}
