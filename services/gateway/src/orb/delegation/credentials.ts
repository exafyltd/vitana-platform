/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Load decrypted API key for an AI provider
 * from the existing ai_assistant_credentials table (VTID-02403).
 *
 * Safety:
 *   - Key never leaves this file as a string beyond the caller's immediate
 *     fetch call; callers must not log or persist it.
 *   - Returns null (with a reason log) rather than throwing on any failure,
 *     so the orb session can fall back gracefully to Gemini Live.
 */
import { getSupabase } from '../../lib/supabase';
import { decryptApiKey, toBuffer } from '../../lib/ai-credential-crypto';
import type { DelegationProviderId } from './types';
import * as repo from './credentials-repository';

const LOG_PREFIX = '[orb/delegation/credentials]';

/**
 * Map our internal delegation provider IDs to the connector_id values stored
 * in the `user_connections` / `ai_assistant_credentials` tables. Kept here
 * so the existing credential store schema doesn't need to learn our vocab.
 */
const CONNECTOR_ID_BY_PROVIDER: Record<DelegationProviderId, string> = {
  chatgpt: 'chatgpt',
  claude: 'claude',
  'google-ai': 'google-ai',
};

export interface LoadedCredential {
  readonly providerId: DelegationProviderId;
  readonly apiKey: string;
  readonly connectionId: string;
  readonly isActive: boolean;
}

export async function loadUserCredential(
  userId: string,
  providerId: DelegationProviderId,
): Promise<LoadedCredential | null> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn(`${LOG_PREFIX} supabase client unavailable`);
    return null;
  }

  const connectorId = CONNECTOR_ID_BY_PROVIDER[providerId];
  const { data: conn, error: connErr } = await repo.fetchLatestActiveUserConnection(supabase, userId, connectorId);

  if (connErr) {
    console.warn(`${LOG_PREFIX} user_connections query failed: ${connErr.message}`);
    return null;
  }
  if (!conn) return null;

  const { data: cred, error: credErr } = await repo.fetchAiAssistantCredentialByConnectionId(supabase, conn.id);

  if (credErr) {
    console.warn(`${LOG_PREFIX} credential fetch failed for ${providerId}: ${credErr.message}`);
    return null;
  }
  if (!cred) return null;

  const ct = toBuffer(cred.encrypted_key);
  const iv = toBuffer(cred.encryption_iv);
  const tag = toBuffer(cred.encryption_tag);
  if (!ct || !iv || !tag) {
    console.warn(`${LOG_PREFIX} credential row for ${providerId} is corrupt (missing buffer fields)`);
    return null;
  }

  const apiKey = decryptApiKey(ct, iv, tag);
  if (!apiKey) {
    console.warn(`${LOG_PREFIX} decrypt failed for ${providerId} connection=${conn.id}`);
    return null;
  }

  return {
    providerId,
    apiKey,
    connectionId: conn.id,
    isActive: conn.is_active !== false,
  };
}

/**
 * Returns the list of provider IDs the user currently has *active* credentials
 * for. Used by the router when no provider hint is given.
 */
export async function listActiveProviders(userId: string): Promise<DelegationProviderId[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await repo.fetchActiveAiAssistantConnectorIds(supabase, userId);

  if (error) {
    console.warn(`${LOG_PREFIX} listActiveProviders failed: ${error.message}`);
    return [];
  }

  const valid = new Set<DelegationProviderId>(
    Object.keys(CONNECTOR_ID_BY_PROVIDER) as DelegationProviderId[],
  );
  return (data ?? [])
    .map((row) => row.connector_id as DelegationProviderId)
    .filter((id) => valid.has(id));
}
