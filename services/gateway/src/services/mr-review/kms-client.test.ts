// MOCK-ONLY: the AWS SDK module is replaced by a fake. No AWS call is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKmsSend, type KmsModuleLike } from './kms-client';

test('the SDK client is built for the configured region and each command is the matching SDK class', async () => {
  const seen: unknown[] = [];
  class FakeClient {
    constructor(cfg: { region: string }) { seen.push(['client', cfg.region]); }
    async send(c: unknown) { seen.push(['send', c]); return { ok: true }; }
  }
  class FakeSign { input: unknown; constructor(input: unknown) { this.input = input; } }
  class FakeGet { input: unknown; constructor(input: unknown) { this.input = input; } }
  const load = async (): Promise<KmsModuleLike> => ({ KMSClient: FakeClient as never, SignCommand: FakeSign as never, GetPublicKeyCommand: FakeGet as never });
  const kms = await createKmsSend({ region: 'eu-central-1', load });
  await kms.send({ name: 'SignCommand', input: { KeyId: 'k' } });
  await kms.send({ name: 'GetPublicKeyCommand', input: { KeyId: 'k' } });
  assert.deepEqual(seen[0], ['client', 'eu-central-1']);
  assert.ok((seen[1] as unknown[])[1] instanceof FakeSign);
  assert.ok((seen[2] as unknown[])[1] instanceof FakeGet);
});

test('a missing AWS SDK surfaces as an error when the client is created, not at startup', async () => {
  await assert.rejects(() => createKmsSend({ region: 'eu-central-1', load: async () => { throw new Error('Cannot find module @aws-sdk/client-kms'); } }), /Cannot find module/);
});
