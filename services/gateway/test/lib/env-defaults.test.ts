/**
 * VTID-04287 — defensive-default tests for src/lib/env-defaults.ts.
 *
 * The harness scripts read HARNESS_URL / OUT_DIR / TABS with no workflow
 * binding, so every accessor is pinned both ways: env var set -> live value,
 * env var unset -> documented default. No crash, no silent `undefined`.
 */
import {
  DEFAULT_OUT_DIR,
  DEFAULT_TABS,
  getHarnessUrl,
  getOutDir,
  getTabs,
  getTabsNum,
} from '../../src/lib/env-defaults';

const ENV_KEYS = ['HARNESS_URL', 'OUT_DIR', 'TABS'] as const;

describe('env-defaults', () => {
  const originalEnv = process.env;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    process.env = originalEnv;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('getHarnessUrl', () => {
    it('returns an empty string when HARNESS_URL is unset', () => {
      expect(getHarnessUrl()).toBe('');
    });

    it('returns the env value when HARNESS_URL is set', () => {
      process.env.HARNESS_URL = 'http://test-harness:8080';
      expect(getHarnessUrl()).toBe('http://test-harness:8080');
    });

    it('reflects a value changed after import (never captured at module load)', () => {
      process.env.HARNESS_URL = 'http://127.0.0.1:18482';
      expect(getHarnessUrl()).toBe('http://127.0.0.1:18482');
      process.env.HARNESS_URL = 'http://127.0.0.1:18499';
      expect(getHarnessUrl()).toBe('http://127.0.0.1:18499');
    });
  });

  describe('getOutDir', () => {
    it('returns the documented default when OUT_DIR is unset', () => {
      expect(getOutDir()).toBe('./out');
      expect(getOutDir()).toBe(DEFAULT_OUT_DIR);
    });

    it('returns the env value when OUT_DIR is set', () => {
      process.env.OUT_DIR = '/custom/output';
      expect(getOutDir()).toBe('/custom/output');
    });
  });

  describe('getTabs', () => {
    it('returns the documented default when TABS is unset', () => {
      expect(getTabs()).toBe('2');
      expect(getTabs()).toBe(DEFAULT_TABS);
    });

    it('returns the env value when TABS is set to a width', () => {
      process.env.TABS = '4';
      expect(getTabs()).toBe('4');
    });

    it('returns the raw list form when TABS is a comma-separated tab list', () => {
      process.env.TABS = 'live,scanners,impact-rules';
      expect(getTabs()).toBe('live,scanners,impact-rules');
    });
  });

  describe('getTabsNum', () => {
    it('returns 2 when TABS is unset', () => {
      expect(getTabsNum()).toBe(2);
    });

    it('returns the parsed number when TABS is set', () => {
      process.env.TABS = '4';
      expect(getTabsNum()).toBe(4);
    });

    it('returns 2 when TABS is non-numeric', () => {
      process.env.TABS = 'invalid';
      expect(getTabsNum()).toBe(2);
    });

    it('returns 2 when TABS is empty or blank', () => {
      process.env.TABS = '';
      expect(getTabsNum()).toBe(2);
      process.env.TABS = '   ';
      expect(getTabsNum()).toBe(2);
    });

    it('accepts padded numeric input', () => {
      process.env.TABS = ' 8 ';
      expect(getTabsNum()).toBe(8);
    });
  });

  it('never throws for any of the three vars being unbound', () => {
    expect(() => {
      getHarnessUrl();
      getOutDir();
      getTabs();
      getTabsNum();
    }).not.toThrow();
  });
});
