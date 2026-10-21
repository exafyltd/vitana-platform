/**
 * VTID-04840 — Vitana sets up a supplier's business by voice (Commerce AI
 * setup, slice 3; owner decisions 2026-10-02).
 *
 * The supplier taps "Talk to Vitana" in the commerce portal's AI setup
 * sheet. Vitana asks for their website and calls `draft_business_setup`.
 * The draft is read and composed in the background (it takes longer than a
 * voice tool may block), then handed to the screen as an `orb_directive`
 * (`commerce_setup_draft`), which opens the review card. **Voice only
 * drafts:** nothing is written here. The business is created only by the
 * supplier's own tap on "Create my business" (POST /commerce/ai-setup/apply).
 *
 * Declared on the commerce surface only, and only when
 * COMMERCE_AI_SETUP_ENABLED is 'true'. Off: the catalog is unchanged.
 */
import { isCommerceAiSetupEnabled } from '../../../services/commerce-ai-setup-flag';
import type { DraftResult } from '../../../services/commerce-ai-setup';
import type { OrbSurface } from '../surface';

export const DRAFT_BUSINESS_SETUP_TOOL_NAME = 'draft_business_setup';

export const DRAFT_BUSINESS_SETUP_TOOL = {
  name: DRAFT_BUSINESS_SETUP_TOOL_NAME,
  description: [
    "Prepare the user's business on Vitanaland from their website: reads the site and drafts the business name, category, country and its products or services.",
    'It writes nothing. The draft opens on the screen as a review card; the user checks it there and taps to create the business.',
    'Call it as soon as the user gives a website address. It returns at once while the site is read in the background (about 10 to 30 seconds).',
    'Never say the business is created; it is only created when the user taps on the screen.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      website: { type: 'string', description: 'The website address the user gave, for example kraeuterhaus.de.' },
    },
    required: ['website'],
  },
};

/** The commerce-surface setup tool, or none when AI setup is off. */
export function commerceSetupTools(env: NodeJS.ProcessEnv = process.env): object[] {
  return isCommerceAiSetupEnabled(env) ? [DRAFT_BUSINESS_SETUP_TOOL] : [];
}

export interface CommerceSetupSession {
  sessionId: string;
  lang?: string | null;
  identity?: { user_id?: string | null } | null;
  assistantProfile?: { surface: OrbSurface } | null;
  /** In-flight / last draft of this session (set by this module). */
  commerceSetupDraft?: { status: 'reading' | 'ready' | 'failed'; website: string; error?: string } | null;
}

export interface ToolResult { success: boolean; result: string; error?: string }

export interface CommerceSetupDeps {
  /** Writes one message to the session's client (SSE and/or WebSocket). */
  send: (message: Record<string, unknown>) => void;
  draft?: (url: string, lang: string | null) => Promise<DraftResult>;
  allow?: (userId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * The tool handler. Returns within milliseconds; the draft lands on the
 * screen later as `orb_directive: commerce_setup_draft` (or
 * `commerce_setup_draft_failed` with an error code the screen translates).
 */
export async function runDraftBusinessSetup(
  session: CommerceSetupSession,
  args: Record<string, unknown>,
  deps: CommerceSetupDeps,
): Promise<ToolResult> {
  if (!isCommerceAiSetupEnabled(deps.env ?? process.env)) {
    return { success: false, result: '', error: 'Setting up a business by voice is not switched on.' };
  }
  if (session.assistantProfile?.surface !== 'commerce') {
    return { success: false, result: '', error: 'draft_business_setup is only available in the commerce portal.' };
  }
  const userId = session.identity?.user_id ?? null;
  if (!userId) return { success: false, result: '', error: 'The user is not signed in.' };

  // Loaded on first use only: the catalog imports this module for the declaration.
  const setup = await import('../../../services/commerce-ai-setup');
  const url = setup.normalizeWebsiteUrl(args.website);
  if (!url) {
    return {
      success: false,
      result: '',
      error: 'invalid_url: that is not a website address. Ask the user to say or spell the address again, or to fill it in on the screen.',
    };
  }
  if (session.commerceSetupDraft?.status === 'reading') {
    return { success: true, result: `Still reading ${session.commerceSetupDraft.website}. The review card opens on the screen as soon as it is ready.` };
  }
  if (!(deps.allow ?? setup.allowDraft)(userId)) {
    return {
      success: false,
      result: '',
      error: 'RATE_LIMITED: too many drafts this hour. Tell the user they can fill the business in on the screen, or try again later.',
    };
  }

  session.commerceSetupDraft = { status: 'reading', website: url };
  deps.send({ type: 'orb_directive', directive: 'commerce_setup_reading', website: url, vtid: 'VTID-04840' });

  const draft = deps.draft ?? setup.draftFromWebsite;
  void draft(url, session.lang ?? null)
    .catch((): DraftResult => ({ ok: false, error: 'llm_unavailable' }))
    .then((result) => {
      if (result.ok) {
        session.commerceSetupDraft = { status: 'ready', website: url };
        deps.send({ type: 'orb_directive', directive: 'commerce_setup_draft', draft: result.draft, vtid: 'VTID-04840' });
      } else {
        session.commerceSetupDraft = { status: 'failed', website: url, error: result.error };
        deps.send({ type: 'orb_directive', directive: 'commerce_setup_draft_failed', error: result.error, website: url, vtid: 'VTID-04840' });
      }
    });

  return {
    success: true,
    result:
      `Reading ${url} now; nothing is saved. In one short sentence of your own, tell the user you are reading their site ` +
      'and that the draft will open on the screen in a moment for them to check and confirm with one tap; ' +
      'this voice conversation closes by itself when the draft is there. ' +
      'Do not describe products you have not seen, and do not say the business is created.',
  };
}
