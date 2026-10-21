/**
 * Observe loop — Phase 1.
 *
 * Pulls messages from each active listener channel, classifies them,
 * writes detected questions to DB, and (if the score is high enough)
 * matches against the user's catalog + composes a shadow draft.
 *
 * ZERO external posting. ZERO mesh. Drafts stay in `shadow` status until
 * Phase 2 introduces one-tap approval.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getListenerAdapter, type ListenerChannelRecord, type IncomingMessage } from '../listeners';
import { classifyIntent } from '../classifier/intent-classifier';
import { matchCatalog } from '../matcher/catalog-matcher';
import { composeDraft } from '../composer/draft-composer';

const SCORE_THRESHOLD = 0.5;

interface UserVaeaConfig {
  user_id: string;
  tenant_id: string;
  give_recommendations: boolean;
  expertise_zones: string[];
  disclosure_text: string;
  excluded_categories: string[];
}

interface LoopMetrics {
  channels_scanned: number;
  messages_ingested: number;
  questions_scored: number;
  drafts_created: number;
  errors: number;
  last_run_at: string | null;
}

const metrics: LoopMetrics = {
  channels_scanned: 0,
  messages_ingested: 0,
  questions_scored: 0,
  drafts_created: 0,
  errors: 0,
  last_run_at: null,
};

export function getObserveMetrics(): LoopMetrics {
  return { ...metrics };
}

export async function runObservePass(supabase: SupabaseClient): Promise<LoopMetrics> {
  metrics.last_run_at = new Date().toISOString();

  const { data: channels, error } = await supabase
    .from('vaea_listener_channels')
    .select('id, tenant_id, user_id, platform, channel_key, config, last_ingest_cursor, dry_run')
    .eq('active', true);

  if (error) {
    console.error('[vaea-observe] channel fetch failed:', error.message);
    metrics.errors += 1;
    return metrics;
  }

  for (const channel of (channels || []) as ListenerChannelRecord[]) {
    metrics.channels_scanned += 1;
    try {
      await processChannel(supabase, channel);
    } catch (err) {
      metrics.errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[vaea-observe] channel ${channel.id} failed: ${msg}`);
      await supabase
        .from('vaea_listener_channels')
        .update({ last_error: msg.slice(0, 500) })
        .eq('id', channel.id);
    }
  }

  return metrics;
}

async function processChannel(
  supabase: SupabaseClient,
  channel: ListenerChannelRecord,
): Promise<void> {
  const adapter = getListenerAdapter(channel.platform);
  if (!adapter) {
    console.warn(`[vaea-observe] no adapter for platform '${channel.platform}'`);
    return;
  }

  const result = await adapter.ingest(channel);
  if (result.messages.length === 0) {
    await supabase
      .from('vaea_listener_channels')
      .update({ last_ingested_at: new Date().toISOString(), last_error: null })
      .eq('id', channel.id);
    return;
  }

  metrics.messages_ingested += result.messages.length;

  const userConfig = await loadUserConfig(supabase, channel.tenant_id, channel.user_id);
  if (!userConfig) {
    console.warn(`[vaea-observe] no vaea_config for user ${channel.user_id}, skipping`);
    return;
  }

  for (const msg of result.messages) {
    await processMessage(supabase, channel, msg, userConfig);
  }

  await supabase
    .from('vaea_listener_channels')
    .update({
      last_ingested_at: new Date().toISOString(),
      last_ingest_cursor: result.next_cursor ?? channel.last_ingest_cursor,
      last_error: null,
    })
    .eq('id', channel.id);
}

async function processMessage(
  supabase: SupabaseClient,
  channel: ListenerChannelRecord,
  msg: IncomingMessage,
  userConfig: UserVaeaConfig,
): Promise<void> {
  const scoring = classifyIntent({
    body: msg.body,
    author_external_id: msg.author_external_id,
    expertise_zones: userConfig.expertise_zones,
  });

  metrics.questions_scored += 1;

  const shouldDraft =
    scoring.combined_score >= SCORE_THRESHOLD && userConfig.give_recommendations;

  const { data: detected, error: detectErr } = await supabase
    .from('vaea_detected_questions')
    .insert({
      tenant_id: channel.tenant_id,
      user_id: channel.user_id,
      channel_id: channel.id,
      external_message_id: msg.external_message_id,
      platform: msg.platform,
      author_handle: msg.author_handle,
      author_external_id: msg.author_external_id,
      message_body: msg.body,
      message_url: msg.url,
      posted_at: msg.posted_at,
      is_purchase_intent: scoring.is_purchase_intent,
      topic_match: scoring.topic_match,
      urgency: scoring.urgency,
      already_answered: scoring.already_answered,
      poster_fit: scoring.poster_fit,
      combined_score: scoring.combined_score,
      classifier_version: scoring.classifier_version,
      extracted_topics: scoring.extracted_topics,
      disposition: shouldDraft ? 'drafted' : 'below_threshold',
      disposition_reason: shouldDraft
        ? null
        : !userConfig.give_recommendations
          ? 'give_recommendations=false'
          : `score ${scoring.combined_score} < threshold ${SCORE_THRESHOLD}`,
    })
    .select('id')
    .single();

  if (detectErr) {
    if (detectErr.code === '23505') return; // duplicate external_message_id, already processed
    throw new Error(`insert detected_question: ${detectErr.message}`);
  }

  if (!shouldDraft || !detected) return;

  const matches = await matchCatalog(supabase, {
    tenant_id: channel.tenant_id,
    user_id: channel.user_id,
    topics: scoring.extracted_topics,
  });

  if (matches.length === 0) {
    await supabase
      .from('vaea_detected_questions')
      .update({ disposition: 'skipped', disposition_reason: 'no catalog match' })
      .eq('id', detected.id);
    return;
  }

  const top = matches[0];
  const draft = composeDraft({
    question_body: msg.body,
    match: top.item,
    user_disclosure: userConfig.disclosure_text,
  });

  const { error: draftErr } = await supabase.from('vaea_reply_drafts').insert({
    tenant_id: channel.tenant_id,
    user_id: channel.user_id,
    detected_question_id: detected.id,
    catalog_item_id: top.item.id,
    reply_body: draft.reply_body,
    reply_includes_disclosure: draft.includes_disclosure,
    reply_includes_non_affiliate_alt: draft.includes_non_affiliate_alt,
    match_reason: top.reason,
    match_score: top.score,
    match_tier: top.item.tier,
    status: 'shadow',
    composer_version: draft.composer_version,
  });

  if (draftErr) {
    throw new Error(`insert reply_draft: ${draftErr.message}`);
  }

  metrics.drafts_created += 1;
}

async function loadUserConfig(
  supabase: SupabaseClient,
  tenant_id: string,
  user_id: string,
): Promise<UserVaeaConfig | null> {
  const { data, error } = await supabase
    .from('vaea_config')
    .select('user_id, tenant_id, give_recommendations, expertise_zones, disclosure_text, excluded_categories')
    .eq('tenant_id', tenant_id)
    .eq('user_id', user_id)
    .maybeSingle();

  if (error || !data) return null;
  return data as UserVaeaConfig;
}
