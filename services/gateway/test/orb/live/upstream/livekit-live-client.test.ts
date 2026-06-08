/**
 * Session B (orb-live-refactor): tests for the `LiveKitLiveClient`
 * skeleton.
 *
 * Two purposes:
 *   1. Interface conformance — the skeleton must satisfy every method on
 *      `UpstreamLiveClient` with the right signature, lifecycle, and
 *      idempotency rules. This locks in the contract so when the real
 *      implementation lands, behavior cannot regress silently.
 *   2. Skeleton honesty — `connect()` must reject (with a typed error)
 *      so a misconfigured rollout cannot produce silent no-audio
 *      sessions. No production call site is allowed to rely on this
 *      client succeeding.
 *
 * The "no production call site uses LiveKit yet" assertion lives in
 * `provider-selection-no-production-wiring.test.ts`.
 */

import {
  LiveKitLiveClient,
  defaultValidateConfig,
  type LiveKitClientConfig,
} from '../../../../src/orb/live/upstream/livekit-live-client';
import type { UpstreamConnectOptions } from '../../../../src/orb/live/upstream/types';

const VALID_CONFIG: LiveKitClientConfig = {
  url: 'wss://livekit.example.com',
  apiKey: 'test-key',
  apiSecret: 'test-secret',
};

function baseConnectOptions(
  overrides: Partial<UpstreamConnectOptions> = {},
): UpstreamConnectOptions {
  return {
    model: 'gemini-live-2.5-flash-native-audio',
    projectId: 'lovable-vitana-vers1',
    location: 'us-central1',
    voiceName: 'Aoede',
    responseModalities: ['audio'],
    vadSilenceMs: 1200,
    systemInstruction: 'You are Vitana.',
    getAccessToken: async () => 'unused-by-skeleton',
    connectTimeoutMs: 1000,
    ...overrides,
  };
}

describe('LiveKitLiveClient — interface conformance', () => {
  it('implements every method on UpstreamLiveClient', () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    const required = [
      'connect',
      'sendAudioChunk',
      'sendTextTurn',
      'sendEndOfTurn',
      'onAudioOutput',
      'onTranscript',
      'onToolCall',
      'onTurnComplete',
      'onInterrupted',
      'onError',
      'onClose',
      'close',
      'getState',
    ];
    for (const method of required) {
      expect(typeof (client as any)[method]).toBe('function');
    }
  });

  it('starts in the idle lifecycle state', () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    expect(client.getState()).toBe('idle');
  });

  it('send* methods return false before connect (per UpstreamLiveClient contract)', () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    expect(client.sendAudioChunk('AAAA')).toBe(false);
    expect(client.sendTextTurn('hello')).toBe(false);
    expect(client.sendEndOfTurn()).toBe(false);
  });

  it('on* registration accepts handlers without throwing', () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    expect(() => {
      client.onAudioOutput(() => {});
      client.onTranscript(() => {});
      client.onToolCall(() => {});
      client.onTurnComplete(() => {});
      client.onInterrupted(() => {});
      client.onError(() => {});
      client.onClose(() => {});
    }).not.toThrow();
  });
});

describe('LiveKitLiveClient — connect() (skeleton refusal)', () => {
  it('rejects with a typed not_implemented error when config is valid', async () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    const errors: any[] = [];
    client.onError((e) => errors.push(e));

    await expect(client.connect(baseConnectOptions())).rejects.toThrow(/not_implemented/);
    expect(client.getState()).toBe('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('not_implemented');
    expect(errors[0].message).toMatch(/skeleton/i);
  });

  it('rejects with invalid_config (not not_implemented) when url is missing', async () => {
    const client = new LiveKitLiveClient({ ...VALID_CONFIG, url: '' });
    const errors: any[] = [];
    client.onError((e) => errors.push(e));

    await expect(client.connect(baseConnectOptions())).rejects.toThrow(/invalid_config/);
    expect(client.getState()).toBe('error');
    expect(errors[0].code).toBe('invalid_config');
    expect(errors[0].message).toContain('url');
  });

  it('rejects with invalid_config when apiKey or apiSecret is missing', async () => {
    const noKey = new LiveKitLiveClient({ ...VALID_CONFIG, apiKey: '' });
    await expect(noKey.connect(baseConnectOptions())).rejects.toThrow(/invalid_config/);

    const noSecret = new LiveKitLiveClient({ ...VALID_CONFIG, apiSecret: '' });
    await expect(noSecret.connect(baseConnectOptions())).rejects.toThrow(/invalid_config/);
  });

  it('rejects with invalid_config when url uses a non-ws scheme', async () => {
    const client = new LiveKitLiveClient({
      ...VALID_CONFIG,
      url: 'https://livekit.example.com',
    });
    await expect(client.connect(baseConnectOptions())).rejects.toThrow(/invalid_config/);
  });

  it('refuses a second connect() from a non-idle state', async () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    await expect(client.connect(baseConnectOptions())).rejects.toThrow();
    // Now in 'error' state — second connect must be refused with invalid_state.
    await expect(client.connect(baseConnectOptions())).rejects.toThrow(/invalid_state/);
  });
});

describe('LiveKitLiveClient — close() lifecycle', () => {
  it('transitions to closed and fires onClose exactly once', async () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    const closes: any[] = [];
    client.onClose((e) => closes.push(e));

    await client.close();
    expect(client.getState()).toBe('closed');
    expect(closes).toHaveLength(1);
    expect(closes[0].initiatedLocally).toBe(true);
  });

  it('is idempotent — repeated close() does not re-fire onClose', async () => {
    const client = new LiveKitLiveClient(VALID_CONFIG);
    const closes: any[] = [];
    client.onClose((e) => closes.push(e));

    await client.close();
    await client.close();
    await client.close();

    expect(closes).toHaveLength(1);
    expect(client.getState()).toBe('closed');
  });
});

describe('defaultValidateConfig', () => {
  it('returns null for a fully populated config', () => {
    expect(defaultValidateConfig(VALID_CONFIG)).toBeNull();
  });

  it('lists every missing required field', () => {
    const err = defaultValidateConfig({ url: '', apiKey: '', apiSecret: '' });
    expect(err).not.toBeNull();
    expect(err!.code).toBe('invalid_config');
    expect(err!.message).toContain('url');
    expect(err!.message).toContain('apiKey');
    expect(err!.message).toContain('apiSecret');
  });

  it('rejects URLs that are not ws:// or wss://', () => {
    const err = defaultValidateConfig({
      ...VALID_CONFIG,
      url: 'http://livekit.example.com',
    });
    expect(err!.code).toBe('invalid_config');
    expect(err!.message).toMatch(/ws:\/\/.*wss:\/\//);
  });

  it('accepts ws:// (insecure) for local/dev', () => {
    expect(
      defaultValidateConfig({ ...VALID_CONFIG, url: 'ws://localhost:7880' }),
    ).toBeNull();
  });
});
