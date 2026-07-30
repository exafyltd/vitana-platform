/**
 * Session B (orb-live-refactor): tests for the upstream provider-selection
 * seam.
 *
 * Covers:
 *   - default = vertex (no env flag)
 *   - explicit ORB_LIVE_PROVIDER=vertex
 *   - explicit ORB_LIVE_PROVIDER=livekit selects LiveKit only when the
 *     credential triple is present
 *   - missing credentials → safe fallback to vertex with a typed warning
 *   - unknown provider name → safe fallback to vertex with a typed warning
 *   - createUpstreamLiveClient returns the right concrete class for each
 *     selection
 */

import {
  selectUpstreamProvider,
  createUpstreamLiveClient,
  readLiveKitConfigFromEnv,
  type UpstreamProviderEnv,
} from '../../../../src/orb/live/upstream/provider-selection';
import { VertexLiveClient } from '../../../../src/orb/live/upstream/vertex-live-client';
import { LiveKitLiveClient } from '../../../../src/orb/live/upstream/livekit-live-client';

const FULL_LIVEKIT_ENV: UpstreamProviderEnv = {
  ORB_LIVE_PROVIDER: 'livekit',
  LIVEKIT_URL: 'wss://livekit.example.com',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret',
};

describe('selectUpstreamProvider', () => {
  it('defaults to vertex when no env flag is set', () => {
    const sel = selectUpstreamProvider({});
    expect(sel.provider).toBe('vertex');
    expect(sel.source).toBe('default');
    expect(sel.warnings).toEqual([]);
  });

  it('defaults to vertex when ORB_LIVE_PROVIDER is empty/whitespace', () => {
    const sel = selectUpstreamProvider({ ORB_LIVE_PROVIDER: '   ' });
    expect(sel.provider).toBe('vertex');
    expect(sel.source).toBe('default');
    expect(sel.warnings).toEqual([]);
  });

  it('selects vertex when ORB_LIVE_PROVIDER=vertex (explicit opt-in)', () => {
    const sel = selectUpstreamProvider({ ORB_LIVE_PROVIDER: 'vertex' });
    expect(sel.provider).toBe('vertex');
    expect(sel.source).toBe('env');
    expect(sel.warnings).toEqual([]);
  });

  it('is case-insensitive on the provider name', () => {
    const sel = selectUpstreamProvider({ ORB_LIVE_PROVIDER: 'Vertex' });
    expect(sel.provider).toBe('vertex');

    const sel2 = selectUpstreamProvider({
      ...FULL_LIVEKIT_ENV,
      ORB_LIVE_PROVIDER: 'LiveKit',
    });
    expect(sel2.provider).toBe('livekit');
  });

  it('selects livekit only when ORB_LIVE_PROVIDER=livekit AND all creds are set', () => {
    const sel = selectUpstreamProvider(FULL_LIVEKIT_ENV);
    expect(sel.provider).toBe('livekit');
    expect(sel.source).toBe('env');
    expect(sel.warnings).toEqual([]);
  });

  it('falls back to vertex with a typed warning when LIVEKIT_URL is missing', () => {
    const sel = selectUpstreamProvider({
      ...FULL_LIVEKIT_ENV,
      LIVEKIT_URL: undefined,
    });
    expect(sel.provider).toBe('vertex');
    expect(sel.source).toBe('fallback');
    expect(sel.warnings).toHaveLength(1);
    expect(sel.warnings[0]).toContain('LIVEKIT_URL');
    expect(sel.warnings[0]).toContain('falling back to vertex');
  });

  it('lists every missing credential in the warning', () => {
    const sel = selectUpstreamProvider({ ORB_LIVE_PROVIDER: 'livekit' });
    expect(sel.provider).toBe('vertex');
    expect(sel.source).toBe('fallback');
    expect(sel.warnings[0]).toContain('LIVEKIT_URL');
    expect(sel.warnings[0]).toContain('LIVEKIT_API_KEY');
    expect(sel.warnings[0]).toContain('LIVEKIT_API_SECRET');
  });

  it('treats blank-string credentials as missing', () => {
    const sel = selectUpstreamProvider({
      ...FULL_LIVEKIT_ENV,
      LIVEKIT_API_SECRET: '   ',
    });
    expect(sel.provider).toBe('vertex');
    expect(sel.source).toBe('fallback');
    expect(sel.warnings[0]).toContain('LIVEKIT_API_SECRET');
  });

  it('falls back to vertex with a warning naming the unknown value', () => {
    const sel = selectUpstreamProvider({ ORB_LIVE_PROVIDER: 'openai' });
    expect(sel.provider).toBe('vertex');
    expect(sel.source).toBe('fallback');
    expect(sel.warnings).toHaveLength(1);
    expect(sel.warnings[0]).toContain('openai');
    expect(sel.warnings[0]).toContain('not a recognized provider');
  });
});

describe('readLiveKitConfigFromEnv', () => {
  it('maps env vars onto the LiveKitClientConfig shape', () => {
    expect(readLiveKitConfigFromEnv(FULL_LIVEKIT_ENV)).toEqual({
      url: 'wss://livekit.example.com',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
    });
  });

  it('substitutes empty strings for missing env vars', () => {
    expect(readLiveKitConfigFromEnv({})).toEqual({
      url: '',
      apiKey: '',
      apiSecret: '',
    });
  });
});

describe('createUpstreamLiveClient', () => {
  it('returns a VertexLiveClient instance for the vertex selection', () => {
    const client = createUpstreamLiveClient(
      { provider: 'vertex', source: 'default', warnings: [] },
      {},
    );
    expect(client).toBeInstanceOf(VertexLiveClient);
  });

  it('returns a LiveKitLiveClient instance for the livekit selection', () => {
    const client = createUpstreamLiveClient(
      { provider: 'livekit', source: 'env', warnings: [] },
      FULL_LIVEKIT_ENV,
    );
    expect(client).toBeInstanceOf(LiveKitLiveClient);
  });
});
