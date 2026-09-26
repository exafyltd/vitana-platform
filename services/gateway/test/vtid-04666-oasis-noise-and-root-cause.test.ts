/**
 * VTID-04666 — OASIS analyzer: noise topics never become "recurring error"
 * cards, and a provider outage is ONE card (clustered by provider + error
 * class) instead of one per calling service.
 */

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  analyzeOasisEvents,
  classifyProviderErrorClass,
  clusterErrorEvents,
  generateOasisFingerprint,
  providerOfFailure,
  OasisErrorEventRow,
} from '../src/services/recommendation-engine/analyzers/oasis-analyzer';
import { isRecommendationNoiseTopic, isVerificationNoiseTopic } from '../src/services/oasis-noise-topics';
import { isVerificationNoiseTopic as watcherNoise } from '../src/services/dev-autopilot-watcher';

const many = (n: number, e: OasisErrorEventRow): OasisErrorEventRow[] =>
  Array.from({ length: n }, (_, i) => ({ ...e, id: `${e.topic}-${e.service}-${i}` }));

describe('shared noise-topic list', () => {
  it('the watcher still exports the same function, unchanged in behaviour', () => {
    expect(watcherNoise).toBe(isVerificationNoiseTopic);
    for (const t of ['dev_autopilot.x', 'self_healing.x', 'cicd.x', 'vtid.lifecycle.failed', 'operator.execution_onramp.x', 'deploy.gateway.failed', 'staging.deploy.completed', 'prod.deploy.x', 'voice.latency.measured', 'assistant.turn']) {
      expect(watcherNoise(t)).toBe(true);
    }
    expect(watcherNoise('orb.live.connection_failed')).toBe(false);
    expect(watcherNoise(undefined)).toBe(false);
  });

  it('recommendation noise covers the verification list plus telemetry', () => {
    expect(isRecommendationNoiseTopic('voice.latency.measured')).toBe(true);
    expect(isRecommendationNoiseTopic('telemetry.heartbeat')).toBe(true);
    expect(isRecommendationNoiseTopic('dev_autopilot.execution.failed')).toBe(true);
    expect(isRecommendationNoiseTopic('llm.call.failed')).toBe(false);
    expect(isRecommendationNoiseTopic('orb.live.connection_failed')).toBe(false);
  });
});

describe('classifyProviderErrorClass', () => {
  it('prefers an explicit error code', () => {
    expect(classifyProviderErrorClass({ metadata: { error_code: 'invoke_failed' } })).toBe('invoke_failed');
  });
  it('uses an HTTP status field, then a status in the message', () => {
    expect(classifyProviderErrorClass({ metadata: { status_code: 402 } })).toBe('402');
    expect(classifyProviderErrorClass({ message: 'LLM call failed: worker - DeepSeek API error 402 Insufficient Balance' })).toBe('402');
  });
  it('falls back to a known token, then unknown', () => {
    expect(classifyProviderErrorClass({ metadata: { error_message: 'AccessDeniedException: not subscribed' } })).toBe('accessdeniedexception');
    expect(classifyProviderErrorClass({ message: 'socket hang up' })).toBe('unknown');
  });
});

describe('providerOfFailure', () => {
  it('recognises llm.* and *failed* topics that carry a provider', () => {
    expect(providerOfFailure({ topic: 'llm.call.failed', metadata: { provider: 'DeepSeek' } })).toBe('deepseek');
    expect(providerOfFailure({ topic: 'orb.tts.failed', metadata: { provider: 'polly' } })).toBe('polly');
  });
  it('ignores events without a provider, and non-failure topics', () => {
    expect(providerOfFailure({ topic: 'llm.call.failed', metadata: {} })).toBeNull();
    expect(providerOfFailure({ topic: 'orb.live.diag', metadata: { provider: 'nova_sonic' } })).toBeNull();
  });
});

describe('clusterErrorEvents', () => {
  it('drops noise topics entirely, even above the threshold', () => {
    const events = [
      ...many(40, { topic: 'voice.latency.measured', service: 'gateway', metadata: { provider: 'nova_sonic' } }),
      ...many(15, { topic: 'dev_autopilot.execution.failed', service: 'gateway' }),
    ];
    expect(clusterErrorEvents(events, 10)).toEqual([]);
  });

  it('one provider outage across four services is one cluster keyed on the root cause', () => {
    const events = ['operator', 'worker', 'memory', 'triage'].flatMap((svc) =>
      many(5, {
        topic: 'llm.call.failed',
        service: svc,
        message: `LLM call failed: ${svc} - DeepSeek API error 402`,
        metadata: { provider: 'deepseek', error_message: 'Insufficient Balance (402)' },
      }),
    );
    const clusters = clusterErrorEvents(events, 10);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].key).toBe('provider:deepseek:402');
    expect(clusters[0].count).toBe(20);
    expect(clusters[0].root_cause?.services.sort()).toEqual(['memory', 'operator', 'triage', 'worker']);
  });

  it('different error classes of one provider stay separate; ordinary errors still cluster per topic+service', () => {
    const events = [
      ...many(12, { topic: 'llm.call.failed', service: 'a', metadata: { provider: 'bedrock', error_code: 'invoke_failed' } }),
      ...many(11, { topic: 'llm.call.failed', service: 'b', metadata: { provider: 'bedrock', error_code: 'throttlingexception' } }),
      ...many(10, { topic: 'orb.live.connection_failed', service: 'gateway' }),
      ...many(9, { topic: 'orb.live.connection_failed', service: 'other' }),
    ];
    const keys = clusterErrorEvents(events, 10).map((c) => c.key);
    expect(keys).toEqual(['provider:bedrock:invoke_failed', 'provider:bedrock:throttlingexception', 'orb.live.connection_failed:gateway']);
  });
});

describe('analyzeOasisEvents — end to end over mocked oasis_events', () => {
  const fetchMock = global.fetch as jest.Mock;
  beforeEach(() => fetchMock.mockReset());

  it('excludes voice.latency.* server-side and emits one provider-outage signal with a root-cause fingerprint', async () => {
    const errorUrls: string[] = [];
    const outage = ['operator', 'worker'].flatMap((svc) =>
      many(6, { topic: 'llm.call.failed', service: svc, metadata: { provider: 'deepseek', error_code: '402' } }),
    );
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      const data = u.includes('status=eq.error') ? (errorUrls.push(u), [
        ...outage,
        ...many(30, { topic: 'voice.latency.measured', service: 'gateway' }),
      ]) : [];
      return Promise.resolve({ ok: true, status: 200, json: async () => data, text: async () => '' });
    });

    const result = await analyzeOasisEvents({});
    expect(result.ok).toBe(true);
    expect(errorUrls[0]).toContain('topic=not.like.voice.latency.*');

    const patterns = result.signals.filter((s) => s.type === 'error_pattern');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].source).toBe('provider:deepseek:402');
    expect(patterns[0].message).toContain('operator');
    expect(patterns[0].message).toContain('worker');

    // Same root cause → same fingerprint, whichever services failed this time.
    const again = { ...patterns[0], message: 'different services' };
    expect(generateOasisFingerprint(again)).toBe(generateOasisFingerprint(patterns[0]));
  });
});
