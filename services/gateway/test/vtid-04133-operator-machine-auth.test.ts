/**
 * VTID-04133: machine-to-machine auth for the Operator Console
 * (operator-machine-auth.ts). Pins the kill switch, the constant-time
 * token comparison (including every "no" path being indistinguishable —
 * length mismatch, missing config, empty candidate), the placeholder/
 * too-short-secret refusal, and resolveOperatorMachineIdentity's contract
 * (enabled+match only — never touched when disabled or on any mismatch).
 */

import {
  OPERATOR_MACHINE_AUTH_HEADER,
  OPERATOR_MACHINE_IDENTITY,
  isOperatorMachineAuthEnabled,
  resolveOperatorMachineIdentity,
  verifyOperatorMachineAuthToken,
} from '../src/services/operator-machine-auth';

const REAL_TOKEN = 'a'.repeat(64);

describe('VTID-04133 isOperatorMachineAuthEnabled', () => {
  it('is enabled only on the exact string "true"', () => {
    expect(isOperatorMachineAuthEnabled({ OPERATOR_MACHINE_AUTH_ENABLED: 'true' } as any)).toBe(true);
    for (const v of [undefined, '', 'True', 'TRUE', '1', 'yes', ' true ']) {
      expect(isOperatorMachineAuthEnabled({ OPERATOR_MACHINE_AUTH_ENABLED: v } as any)).toBe(false);
    }
  });
});

describe('VTID-04133 verifyOperatorMachineAuthToken', () => {
  const env = { OPERATOR_MACHINE_AUTH_TOKEN: REAL_TOKEN } as any;

  it('accepts the exact configured token', () => {
    expect(verifyOperatorMachineAuthToken(REAL_TOKEN, env)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = 'b'.repeat(64);
    expect(verifyOperatorMachineAuthToken(wrong, env)).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(verifyOperatorMachineAuthToken('short', env)).toBe(false);
    expect(verifyOperatorMachineAuthToken(REAL_TOKEN + 'x', env)).toBe(false);
  });

  it('rejects when no token is configured at all', () => {
    expect(verifyOperatorMachineAuthToken(REAL_TOKEN, {} as any)).toBe(false);
  });

  it('refuses a too-short configured secret as if it were unconfigured (placeholder guard)', () => {
    const shortEnv = { OPERATOR_MACHINE_AUTH_TOKEN: 'short-secret' } as any;
    expect(verifyOperatorMachineAuthToken('short-secret', shortEnv)).toBe(false);
  });

  it('rejects undefined/null/empty candidates', () => {
    expect(verifyOperatorMachineAuthToken(undefined, env)).toBe(false);
    expect(verifyOperatorMachineAuthToken(null as any, env)).toBe(false);
    expect(verifyOperatorMachineAuthToken('', env)).toBe(false);
  });
});

describe('VTID-04133 resolveOperatorMachineIdentity', () => {
  const enabledEnv = { OPERATOR_MACHINE_AUTH_ENABLED: 'true', OPERATOR_MACHINE_AUTH_TOKEN: REAL_TOKEN } as any;

  it('returns the synthetic identity when enabled and the token matches', () => {
    const identity = resolveOperatorMachineIdentity(REAL_TOKEN, enabledEnv);
    expect(identity).toEqual(OPERATOR_MACHINE_IDENTITY);
    expect(identity?.exafy_admin).toBe(true);
    expect(identity?.user_id).toBe('operator-machine-test-harness');
  });

  it('returns null when disabled, even with a correct token', () => {
    const disabledEnv = { OPERATOR_MACHINE_AUTH_TOKEN: REAL_TOKEN } as any;
    expect(resolveOperatorMachineIdentity(REAL_TOKEN, disabledEnv)).toBeNull();
  });

  it('returns null when the token is wrong, even while enabled', () => {
    expect(resolveOperatorMachineIdentity('wrong-token', enabledEnv)).toBeNull();
  });

  it('returns null when no header value is present at all', () => {
    expect(resolveOperatorMachineIdentity(undefined, enabledEnv)).toBeNull();
  });

  it('takes the first value when Express hands back an array (duplicate header)', () => {
    expect(resolveOperatorMachineIdentity([REAL_TOKEN, 'other'], enabledEnv)).toEqual(OPERATOR_MACHINE_IDENTITY);
  });

  it('never returns the same object reference mutated across calls', () => {
    const a = resolveOperatorMachineIdentity(REAL_TOKEN, enabledEnv)!;
    expect(() => {
      (a as any).exafy_admin = false;
    }).toThrow();
  });
});

describe('VTID-04133 header name convention', () => {
  it('uses a dedicated header, never Authorization', () => {
    expect(OPERATOR_MACHINE_AUTH_HEADER).toBe('x-operator-machine-token');
    expect(OPERATOR_MACHINE_AUTH_HEADER).not.toBe('authorization');
  });
});
