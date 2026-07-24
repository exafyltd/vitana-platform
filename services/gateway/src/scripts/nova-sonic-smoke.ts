/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 8): Nova 2 Sonic runtime smoke test.
 *
 * Runs INSIDE the AWS runtime (one-off Fargate task using the staging
 * service's task definition/subnets/task role) to prove the RUNTIME
 * credential path — not the GitHub deployment user's keys — can open the
 * Bedrock bidirectional stream:
 *
 *   1. Requires NOVA_SONIC_REGION=eu-north-1.
 *   2. Opens amazon.nova-2-sonic-v1:0 via InvokeModelWithBidirectionalStream.
 *   3. Sends sessionStart, promptStart, a short system prompt, and a short
 *      text input.
 *   4. Requires at least one completionStart, then cleanly sends
 *      promptEnd/sessionEnd.
 *   5. Exits non-zero on access, protocol, timeout, or model errors.
 *   6. Prints ONLY model, region, event names, latency, and outcome —
 *      never payload content, transcripts, or credential material.
 *
 * Compiled to dist/scripts/nova-sonic-smoke.js by the normal gateway build.
 */

import { randomUUID } from 'crypto';
import {
  buildContentEnd,
  buildPromptEnd,
  buildPromptStart,
  buildSessionEnd,
  buildSessionStart,
  buildTextContentStart,
  buildTextInput,
  type NovaInputEvent,
} from '../orb/live/upstream/nova-sonic-protocol';
import {
  NOVA_SONIC_MODEL_ID,
  NOVA_SONIC_REGION,
} from '../orb/live/upstream/nova-sonic-config';

const SMOKE_TIMEOUT_MS = 45_000;

class SmokeQueue implements AsyncIterable<{ chunk: { bytes: Uint8Array } }> {
  private buffer: Array<{ chunk: { bytes: Uint8Array } }> = [];
  private waiting: Array<(r: IteratorResult<{ chunk: { bytes: Uint8Array } }>) => void> = [];
  private closed = false;

  push(event: NovaInputEvent): void {
    const item = { chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) } };
    const w = this.waiting.shift();
    if (w) w({ value: item, done: false });
    else this.buffer.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<{ chunk: { bytes: Uint8Array } }> {
    return {
      next: () => {
        const item = this.buffer.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

async function main(): Promise<void> {
  const region = process.env.NOVA_SONIC_REGION;
  if (region !== NOVA_SONIC_REGION) {
    console.error(`[nova-smoke] FAIL: NOVA_SONIC_REGION must be ${NOVA_SONIC_REGION} (got '${region ?? 'unset'}')`);
    process.exit(2);
  }

  console.log(`[nova-smoke] model=${NOVA_SONIC_MODEL_ID} region=${NOVA_SONIC_REGION}`);
  const t0 = Date.now();

  const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = await import(
    '@aws-sdk/client-bedrock-runtime'
  );
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');

  const bedrock = new BedrockRuntimeClient({
    region: NOVA_SONIC_REGION,
    requestHandler: new NodeHttp2Handler({ requestTimeout: SMOKE_TIMEOUT_MS, sessionTimeout: 120_000 }),
  });

  const queue = new SmokeQueue();
  const promptName = randomUUID();
  const sysName = randomUUID();
  const userName = randomUUID();

  queue.push(buildSessionStart());
  queue.push(buildPromptStart({ promptName, voiceId: 'tiffany' }));
  queue.push(buildTextContentStart({ promptName, contentName: sysName, role: 'SYSTEM' }));
  queue.push(buildTextInput({ promptName, contentName: sysName, content: 'You are a health-check probe. Reply with one short sentence.' }));
  queue.push(buildContentEnd({ promptName, contentName: sysName }));
  queue.push(buildTextContentStart({ promptName, contentName: userName, role: 'USER' }));
  queue.push(buildTextInput({ promptName, contentName: userName, content: 'Say OK.' }));
  queue.push(buildContentEnd({ promptName, contentName: userName }));

  const timeout = setTimeout(() => {
    console.error(`[nova-smoke] FAIL: timeout after ${SMOKE_TIMEOUT_MS}ms without completionStart`);
    process.exit(4);
  }, SMOKE_TIMEOUT_MS);

  try {
    const response = await bedrock.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: NOVA_SONIC_MODEL_ID, body: queue }),
    );
    if (!response.body) throw new Error('response stream absent');
    console.log(`[nova-smoke] stream open in ${Date.now() - t0}ms`);

    let sawCompletionStart = false;
    let closed = false;
    for await (const item of response.body) {
      const bytes = (item as { chunk?: { bytes?: Uint8Array } })?.chunk?.bytes;
      if (!bytes) continue;
      let name = 'unknown';
      try {
        const evt = JSON.parse(new TextDecoder().decode(bytes)) as { event?: Record<string, unknown> };
        name = Object.keys(evt.event ?? {})[0] ?? 'unknown';
      } catch {
        console.error('[nova-smoke] FAIL: non-JSON chunk from stream (protocol error)');
        process.exit(5);
      }
      console.log(`[nova-smoke] event=${name} t=${Date.now() - t0}ms`);
      if (name === 'completionStart') sawCompletionStart = true;
      if ((name === 'completionEnd' || name === 'contentEnd') && sawCompletionStart && !closed) {
        closed = true;
        queue.push(buildPromptEnd(promptName));
        queue.push(buildSessionEnd());
        queue.close();
      }
      if (name === 'completionEnd' && sawCompletionStart) break;
    }

    clearTimeout(timeout);
    if (!sawCompletionStart) {
      console.error('[nova-smoke] FAIL: stream ended without completionStart');
      process.exit(6);
    }
    console.log(`[nova-smoke] OK: completionStart observed; total=${Date.now() - t0}ms`);
    bedrock.destroy();
    process.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    const name = (err as { name?: string })?.name ?? 'Error';
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 'n/a';
    // Error NAME + status only — AWS exception text can embed ARNs/identities.
    console.error(`[nova-smoke] FAIL: ${name} (http=${status}) after ${Date.now() - t0}ms`);
    process.exit(3);
  }
}

void main();
