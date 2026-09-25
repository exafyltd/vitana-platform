/**
 * VTID-04525 (Conversation hub B7) — the flag registry reports what the code
 * does, and its workflow pins are current.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONVERSATION_FLAGS,
  resolveConversationFlags,
  isInvalidRaw,
} from '../../../src/services/conversation/conversation-flag-registry';

const SRC = join(__dirname, '../../../src');
const ROOT = join(__dirname, '../../../../..');

describe('VTID-04525 B7 — conversation flag registry', () => {
  test('names are unique and every entry is read somewhere in the gateway source', () => {
    const seen = new Set<string>();
    const grepAll = (name: string) => {
      const { execSync } = require('child_process');
      const out = execSync(`grep -rl --include=*.ts "${name}" "${SRC}"`, { encoding: 'utf8' }) as string;
      return out.split('\n').filter((f: string) => f && !f.endsWith('conversation-flag-registry.ts') && !f.endsWith('.generated.ts'));
    };
    for (const f of CONVERSATION_FLAGS) {
      expect(seen.has(f.name)).toBe(false);
      seen.add(f.name);
      const probe = f.parse === 'feature_env' ? f.name.replace(/^FEATURE_/, '').replace(/_ENV$/, '') : f.name;
      expect({ name: f.name, files: grepAll(probe).length > 0 }).toEqual({ name: f.name, files: true });
    }
  });

  test('exact-true flags: only the string `true` enables', () => {
    for (const f of CONVERSATION_FLAGS.filter((x) => x.parse === 'exact_true')) {
      expect({ f: f.name, v: f.read({}) }).toEqual({ f: f.name, v: false });
      expect({ f: f.name, v: f.read({ [f.name]: 'true' }) }).toEqual({ f: f.name, v: true });
      expect({ f: f.name, v: f.read({ [f.name]: 'TRUE' }) }).toEqual({ f: f.name, v: false });
      expect({ f: f.name, v: f.read({ [f.name]: '1' }) }).toEqual({ f: f.name, v: false });
    }
  });

  test('not-false flags: on unless exactly `false`', () => {
    for (const f of CONVERSATION_FLAGS.filter((x) => x.parse === 'not_false')) {
      expect({ f: f.name, v: f.read({}) }).toEqual({ f: f.name, v: true });
      expect({ f: f.name, v: f.read({ [f.name]: 'false' }) }).toEqual({ f: f.name, v: false });
      expect({ f: f.name, v: f.read({ [f.name]: 'no' }) }).toEqual({ f: f.name, v: true });
    }
  });

  test('number flags resolve to a finite number whatever the raw value', () => {
    for (const f of CONVERSATION_FLAGS.filter((x) => x.parse === 'number')) {
      const unset = f.read({});
      expect({ f: f.name, finite: typeof unset === 'number' && Number.isFinite(unset) }).toEqual({ f: f.name, finite: true });
    }
  });

  test('inline-read mirrors match the source expression they mirror', () => {
    const orbLive = readFileSync(join(SRC, 'routes/orb-live.ts'), 'utf8');
    expect(orbLive).toContain("setNewdayOverviewRungEnabled(process.env.ORB_NEWDAY_OVERVIEW_RUNG_ENABLED !== 'false')");
    expect(orbLive).toContain("setDayCloseRungEnabled(process.env.ORB_DAY_CLOSE_RUNG_ENABLED === 'true')");
    expect(orbLive).toContain("process.env.ORB_GREETING_SILENCE_ON_SKIP_ENABLED !== 'false'");
    expect(orbLive).toContain('Number(process.env.ORB_CONTEXT_READY_GATE_TIMEOUT_MS || 4000)');
    expect(orbLive).toContain('Number(process.env.ORB_IDLE_NO_ENGAGEMENT_MS || 5 * 60 * 1000)');
    expect(orbLive).toContain('Number(process.env.ORB_IDLE_AFTER_ENGAGEMENT_MS || 10 * 60 * 1000)');
    expect(orbLive).toContain("process.env.PROFILER_IN_ORB_INSTRUCTION !== 'false'");
    expect(readFileSync(join(SRC, 'orb/live/instruction/live-system-instruction.ts'), 'utf8')).toContain("process.env.BRAIN_CONTEXT_PACKER !== 'false'");
    expect(readFileSync(join(SRC, 'orb/live/upstream/cascaded-config.ts'), 'utf8')).toContain("(process.env.ORB_CASCADED_VOICE_ENABLED || '').trim() === 'true'");
    expect(readFileSync(join(SRC, 'orb/live/upstream/vertex-serbian-bridge.ts'), 'utf8')).toContain("(process.env.VERTEX_SERBIAN_BRIDGE_ENABLED || '').trim() === 'true'");
    expect(readFileSync(join(SRC, 'orb/live/duplex/full-duplex-gate.ts'), 'utf8')).toContain("process.env[FULL_DUPLEX_ENV_VAR] === 'true'");
    expect(readFileSync(join(SRC, 'orb/live/upstream/nova-sonic-config.ts'), 'utf8')).toContain("env.NOVA_SONIC_GLOBAL_ENABLED === 'true'");
    expect(readFileSync(join(SRC, 'orb/live/session/upstream-message-handler.ts'), 'utf8')).toContain("process.env.NAV_CONTINUATION_BIND === 'true'");
    expect(readFileSync(join(SRC, 'orb/live/tools/live-tool-catalog.ts'), 'utf8')).toContain("process.env.NAV_V2_ENABLED === 'true'");
  });

  test('invalid raw values are flagged per parse rule', () => {
    expect(isInvalidRaw('feature_env', 'production')).toBe(true);
    expect(isInvalidRaw('feature_env', 'staging+prod')).toBe(false);
    expect(isInvalidRaw('exact_true', '1')).toBe(true);
    expect(isInvalidRaw('exact_true', 'true')).toBe(false);
    expect(isInvalidRaw('number', 'abc')).toBe(true);
    expect(isInvalidRaw('number', undefined)).toBe(false);
  });

  test('resolve reports raw, effective, validity and both workflow pins', () => {
    const rows = resolveConversationFlags({ BRAIN_SCORED_OPENING: 'yes', FEATURE_ORB_FAST_START_ENV: 'production' });
    const scored = rows.find((r) => r.name === 'BRAIN_SCORED_OPENING')!;
    expect(scored).toMatchObject({ raw: 'yes', effective: false, invalid: true, staging_pin: 'true' });
    const fast = rows.find((r) => r.name === 'FEATURE_ORB_FAST_START_ENV')!;
    expect(fast).toMatchObject({ raw: 'production', effective: 'off', invalid: true, staging_pin: 'staging+prod', prod_pin: 'staging+prod' });
    expect(rows).toHaveLength(CONVERSATION_FLAGS.length);
  });

  test('VTIDs are either a real id or null — the registry never invents one', () => {
    for (const f of CONVERSATION_FLAGS) {
      if (f.vtid !== null) expect(f.vtid).toMatch(/^(VTID-\d{4,5}|BOOTSTRAP-[A-Z0-9-]+|DEV-COMHU-\d+)$/);
    }
  });

  test('the generated workflow pins file is current (run the generator if this fails)', () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/conversation/generate-flag-pins.mjs'), '--check'], { encoding: 'utf8' });
    expect({ status: r.status, stderr: r.stderr.trim() }).toEqual({ status: 0, stderr: '' });
  });

  // VTID-04473: the Jev switch is a workflow pin, not a conversation flag. The
  // generated pins must show both staging values (true with the TypeSafe key,
  // false without) and no production pin — prod is deliberately not wired.
  test('JEV_DECISIONS_ENABLED is pinned on staging only, and is not a conversation flag', () => {
    const { GATEWAY_WORKFLOW_PINS } = require('../../../src/services/conversation/conversation-flag-pins.generated');
    const pin = GATEWAY_WORKFLOW_PINS.JEV_DECISIONS_ENABLED;
    expect(pin).toBeDefined();
    expect(String(pin.staging).split(' | ').sort()).toEqual(['false', 'true']);
    expect(pin.prod).toBeNull();
    expect(CONVERSATION_FLAGS.some((f) => f.name === 'JEV_DECISIONS_ENABLED')).toBe(false);
  });
});
