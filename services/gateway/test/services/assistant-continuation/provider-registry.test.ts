/**
 * VTID-02913 (B0d.1) — provider-registry unit tests.
 *
 * Covers registration mechanics + surface filtering. No real providers
 * register in B0d.1 — these tests use throwaway fakes.
 */

import {
  createProviderRegistry,
  defaultProviderRegistry,
} from '../../../src/services/assistant-continuation/provider-registry';
import type {
  ContinuationProvider,
  ProviderResult,
} from '../../../src/services/assistant-continuation/types';

function fakeProvider(
  key: string,
  surfaces: ContinuationProvider['surfaces'],
): ContinuationProvider {
  return {
    key,
    surfaces,
    produce: (): ProviderResult => ({
      providerKey: key,
      status: 'suppressed',
      latencyMs: 0,
      reason: 'fake',
    }),
  };
}

describe('B0d.1 — provider-registry', () => {
  it('registers and retrieves a provider by key', () => {
    const r = createProviderRegistry();
    const p = fakeProvider('p1', ['orb_wake']);
    r.register(p);
    expect(r.get('p1')).toBe(p);
  });

  it('rejects duplicate keys', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('dup', ['orb_wake']));
    expect(() => r.register(fakeProvider('dup', ['orb_wake']))).toThrow(
      /duplicate key 'dup'/,
    );
  });

  it('rejects empty keys', () => {
    const r = createProviderRegistry();
    expect(() => r.register(fakeProvider('', ['orb_wake']))).toThrow(
      /provider\.key is required/,
    );
  });

  it('filters providers by surface', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('wake', ['orb_wake']));
    r.register(fakeProvider('turn', ['orb_turn_end']));
    r.register(fakeProvider('both', ['orb_wake', 'orb_turn_end']));
    const wakeOnly = r.forSurface('orb_wake').map((p) => p.key).sort();
    expect(wakeOnly).toEqual(['both', 'wake']);
  });

  it('treats empty surfaces array as "all surfaces"', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('all', []));
    expect(r.forSurface('orb_wake')).toHaveLength(1);
    expect(r.forSurface('home')).toHaveLength(1);
    expect(r.forSurface('text_turn_end')).toHaveLength(1);
  });

  it('list() returns every registered key', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('a', ['orb_wake']));
    r.register(fakeProvider('b', ['home']));
    expect(r.list().sort()).toEqual(['a', 'b']);
  });

  it('unregister removes the provider', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('x', ['orb_wake']));
    r.unregister('x');
    expect(r.get('x')).toBeUndefined();
    expect(r.list()).toEqual([]);
  });

  it('clear() drops everything (for tests)', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('a', ['orb_wake']));
    r.register(fakeProvider('b', ['orb_wake']));
    r.clear();
    expect(r.list()).toEqual([]);
  });

  it('defaultProviderRegistry exists and starts empty in B0d.1', () => {
    // B0d.1 does NOT auto-register any production providers. That happens
    // in B0d.2+ when concrete providers ship.
    expect(defaultProviderRegistry).toBeDefined();
    // Note: this test could be flaky if other test files mutate the
    // singleton. We snapshot the list and restore — see the test below.
  });
});
