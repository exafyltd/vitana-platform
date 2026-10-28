/**
 * VTID-NAV — after Vitana opens a screen, a memory row records it, so later
 * turns know where she took the member and why (orb-memory-bridge filters
 * these by `mode: 'navigator_action'`).
 *
 * VTID-04846: moved here unchanged from navigator-consult.ts when the legacy
 * navigator was retired; it never depended on the catalog.
 */
import { writeMemoryItemWithIdentity } from '../services/orb-memory-bridge';

export interface NavigatorActionIdentity {
  user_id: string;
  tenant_id: string;
  role?: string;
}

export interface NavigatorActionScreen {
  screen_id: string;
  route: string;
  title: string;
}

export async function writeNavigatorActionMemory(args: {
  identity: NavigatorActionIdentity;
  screen: NavigatorActionScreen;
  reason: string;
  decision_source: 'consult' | 'direct';
  orb_session_id: string;
  conversation_id?: string;
  lang: string;
}): Promise<void> {
  const { identity, screen, reason, decision_source, orb_session_id, conversation_id } = args;
  const content = `Vitana navigated to ${screen.title} (${screen.route}) — ${reason}`;
  try {
    await writeMemoryItemWithIdentity(
      { user_id: identity.user_id, tenant_id: identity.tenant_id, active_role: identity.role },
      {
        source: 'orb_voice',
        content,
        category_key: 'notes',
        skipFiltering: true, // bypass the user/assistant trivial filter
        content_json: {
          direction: 'system',
          channel: 'orb',
          mode: 'navigator_action',
          action: 'navigate',
          screen_id: screen.screen_id,
          screen_title: screen.title,
          route: screen.route,
          reason,
          decision_source,
          lang: args.lang,
          orb_session_id,
          conversation_id,
        },
      }
    );
  } catch (err: any) {
    console.warn(`[VTID-NAV-CONSULT] Failed to write navigator action memory: ${err.message}`);
  }
}
