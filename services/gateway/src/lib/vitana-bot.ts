/**
 * Vitana Bot User — well-known system user ID for Vitana DM conversations.
 *
 * This UUID is deterministic and seeded via migration 20260315000001.
 * It appears as a DM contact in the chat list. Voice transcripts and
 * text replies use this as sender_id / receiver_id in chat_messages.
 */

export const VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001';

export function isVitanaBot(userId: string): boolean {
  return userId === VITANA_BOT_USER_ID;
}
