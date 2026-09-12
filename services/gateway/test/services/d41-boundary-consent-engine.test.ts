/**
 * services/d41-boundary-consent-engine.ts — previously zero test coverage.
 *
 * Focused on one fix (docs/AURORA-B3-DEAD-RPC-CALLSITE-AUDIT.md finding #2):
 * getPersonalBoundaries()/getConsentBundle() already degrade safely on a
 * real get_boundaries/get_consent RPC failure (a protective default, never
 * permissive) — but the only trace was a bare console.warn, two layers
 * below the ORB voice bridge that calls this, with nothing aggregated or
 * alerted on. A user's real boundaries/consent could go silently inert
 * inside ORB indefinitely with nobody monitoring ever finding out. This
 * pins that a real RPC error now also emits an OASIS warning event.
 */
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

const mockFetchPersonalBoundaries = jest.fn();
const mockFetchConsentBundle = jest.fn();
jest.mock('../../src/services/d41-boundary-consent-engine-repository', () => ({
  fetchPersonalBoundaries: (...args: unknown[]) => mockFetchPersonalBoundaries(...args),
  fetchConsentBundle: (...args: unknown[]) => mockFetchConsentBundle(...args),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

import { getPersonalBoundaries, getConsentBundle } from '../../src/services/d41-boundary-consent-engine';

describe('d41-boundary-consent-engine — RPC-error visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockReturnValue({});
  });

  it('getPersonalBoundaries emits an OASIS warning (not just a console.warn) when get_boundaries RPC errors, keeping the safe DEFAULT_BOUNDARIES fallback', async () => {
    mockFetchPersonalBoundaries.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const result = await getPersonalBoundaries('user-jwt');

    expect(result.ok).toBe(true);
    expect(result.boundaries).toBeDefined();
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'd41.boundary.rpc_error_default', status: 'warning' }),
    );
  });

  it('getConsentBundle emits an OASIS warning when get_consent RPC errors, keeping the safe empty protective-stance fallback', async () => {
    mockFetchConsentBundle.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const result = await getConsentBundle('user-jwt');

    expect(result.ok).toBe(true);
    expect(result.consent_bundle?.default_stance).toBe('protective');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'd41.consent.rpc_error_default', status: 'warning' }),
    );
  });
});
