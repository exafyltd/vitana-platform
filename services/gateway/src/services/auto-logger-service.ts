import { supabase } from '../lib/supabase';
import { syncVtidFromEvent } from './eventSync';
import { sseService } from './sseService';

interface AutoLogEvent {
  vtid?: string;
  layer?: string;
  module?: string;
  source: string;
  kind: string;
  status: string;
  title: string;
  ref?: string;
  link?: string;
  meta?: Record<string, any>;
}

async function notifyGoogleChat(event: AutoLogEvent): Promise<void> {
  const webhookUrl = process.env.GCHAT_COMMANDHUB_WEBHOOK;
  
  if (!webhookUrl) {
    return;
  }

  const shouldNotify = ['completed', 'failed', 'cancelled'].includes(event.status);
  if (!shouldNotify) {
    return;
  }

  try {
    const message = {
      text: `*${event.vtid || 'UNSET'}*: ${event.title}\nStatus: ${event.status}\n${event.link || ''}`
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });

    if (response.ok) {
      console.log('[AutoLogger] Google Chat notification sent');
    }
  } catch (error) {
    console.error('[AutoLogger] Error sending Google Chat notification:', error);
  }
}

export async function processEvent(event: AutoLogEvent): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('OasisEvent')
      .insert({
        vtid: event.vtid,
        layer: event.layer,
        module: event.module,
        source: event.source,
        kind: event.kind,
        status: event.status,
        title: event.title,
        ref: event.ref,
        link: event.link,
        meta: event.meta,
        timestamp: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('[AutoLogger] Error logging event:', error);
      return;
    }

    console.log('[AutoLogger] Event logged:', data.id);

    if (event.vtid && event.status) {
      await syncVtidFromEvent(event);
    }

    sseService.broadcast({
      type: 'vtid_update',
      vtid: event.vtid,
      status: event.status,
      timestamp: new Date().toISOString()
    });

    await notifyGoogleChat(event);

  } catch (error) {
    console.error('[AutoLogger] Unexpected error:', error);
  }
}

export const autoLoggerService = {
  processEvent
};
