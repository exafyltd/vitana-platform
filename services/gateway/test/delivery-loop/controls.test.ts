/**
 * Delivery loop controls (services/delivery-loop/controls.ts): every control fails closed.
 *
 * The cases that matter: a typo never raises the autonomy level, an unreadable kill switch is "not armed", the loop is off unless
 * the switch is the exact string 'true', and `act` needs both L3 and an armed execution plane.
 */
import {
  DEFAULT_BRANCH_PREFIXES,
  DEFAULT_HEAL_MAX_ATTEMPTS,
  DEFAULT_MAX_ACTIONS,
  DEFAULT_REWORK_MAX_ROUNDS,
  allows,
  autonomyFrom,
  branchPrefixesFrom,
  healMainFrom,
  healMaxAttemptsFrom,
  isLoopEnabled,
  maxActionsFrom,
  mayDo,
  ownsBranch,
  projectsFrom,
  readControls,
  reworkMaxRoundsFrom,
  type Controls,
} from '../../src/services/delivery-loop/controls';
import type { Autonomy, LoopAction } from '../../src/services/delivery-loop/types';

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

describe('the loop switch', () => {
  it('is on only for the exact string "true"', () => {
    expect(isLoopEnabled(env({ DELIVERY_LOOP_ENABLED: 'true' }))).toBe(true);
    for (const v of [undefined, '', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'false']) {
      expect({ v, on: isLoopEnabled(env({ DELIVERY_LOOP_ENABLED: v })) }).toEqual({ v, on: false });
    }
  });
});

describe('the autonomy level', () => {
  it('is L1 (recommend) when unset or empty', () => {
    expect(autonomyFrom(env({}))).toBe('L1');
    expect(autonomyFrom(env({ DELIVERY_LOOP_AUTONOMY: '' }))).toBe('L1');
  });

  it('accepts exactly L0 to L3, ignoring surrounding space', () => {
    for (const l of ['L0', 'L1', 'L2', 'L3'] as Autonomy[]) expect(autonomyFrom(env({ DELIVERY_LOOP_AUTONOMY: l }))).toBe(l);
    expect(autonomyFrom(env({ DELIVERY_LOOP_AUTONOMY: ' L2 ' }))).toBe('L2');
  });

  it('a value that is not one of the four is L0, never a higher level: a typo cannot raise it', () => {
    for (const v of ['l2', 'l3', 'L4', 'L-1', '2', '3', 'L 3', 'LL3', 'full', 'FULL_AUTO', 'act', 'true', '0']) {
      expect({ v, level: autonomyFrom(env({ DELIVERY_LOOP_AUTONOMY: v })) }).toEqual({ v, level: 'L0' });
    }
  });
});

describe('what each level allows', () => {
  const matrix: Array<[Autonomy, Record<LoopAction, boolean>]> = [
    ['L0', { record: false, learn: false, prepare: false, act: false }],
    ['L1', { record: true, learn: true, prepare: false, act: false }],
    ['L2', { record: true, learn: true, prepare: true, act: false }],
    ['L3', { record: true, learn: true, prepare: true, act: true }],
  ];
  it.each(matrix)('%s', (level, expected) => {
    for (const action of ['record', 'learn', 'prepare', 'act'] as LoopAction[]) {
      expect({ level, action, allowed: allows(level, action) }).toEqual({ level, action, allowed: expected[action] });
    }
  });
});

describe('the projects the loop may touch', () => {
  it('is the list of group/name paths, trimmed; none when unset', () => {
    expect(projectsFrom(env({}))).toEqual([]);
    expect(projectsFrom(env({ DELIVERY_LOOP_PROJECTS: 'vitana/vitana-platform, vitana/rehearsal ,vitana/vitana-v1' }))).toEqual([
      'vitana/vitana-platform',
      'vitana/rehearsal',
      'vitana/vitana-v1',
    ]);
    expect(projectsFrom(env({ DELIVERY_LOOP_PROJECTS: 'group/sub/project' }))).toEqual(['group/sub/project']);
  });

  it('drops anything that is not a plain project path: no traversal, query, space or scheme', () => {
    const bad = ['', 'vitana', '/vitana/x', 'vitana/', 'vitana/../x', '../x/y', 'a b/c', 'a/b?x=1', 'a/b#f', 'https://h/a/b', 'a//b', '-a/b', 'a/.b', 'a/b c'];
    expect(projectsFrom(env({ DELIVERY_LOOP_PROJECTS: bad.join(',') }))).toEqual([]);
    expect(projectsFrom(env({ DELIVERY_LOOP_PROJECTS: 'ok/one,not ok,ok/two' }))).toEqual(['ok/one', 'ok/two']);
  });
});

describe('the bounds of a cycle', () => {
  it('max actions: default 5, 0 is allowed (record only), the ceiling is 50, anything else is the default', () => {
    expect(maxActionsFrom(env({}))).toBe(DEFAULT_MAX_ACTIONS);
    expect(maxActionsFrom(env({ DELIVERY_LOOP_MAX_ACTIONS: '0' }))).toBe(0);
    expect(maxActionsFrom(env({ DELIVERY_LOOP_MAX_ACTIONS: '50' }))).toBe(50);
    for (const v of ['51', '-1', '2.5', 'abc', '', ' ', '1e2', 'Infinity']) {
      expect({ v, n: maxActionsFrom(env({ DELIVERY_LOOP_MAX_ACTIONS: v })) }).toEqual({ v, n: DEFAULT_MAX_ACTIONS });
    }
  });

  it('heal attempts: default 3, between 1 and 5, anything else is the default', () => {
    expect(healMaxAttemptsFrom(env({}))).toBe(DEFAULT_HEAL_MAX_ATTEMPTS);
    expect(healMaxAttemptsFrom(env({ DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '1' }))).toBe(1);
    expect(healMaxAttemptsFrom(env({ DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '5' }))).toBe(5);
    for (const v of ['0', '6', '-2', '3.5', 'many', '']) {
      expect({ v, n: healMaxAttemptsFrom(env({ DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: v })) }).toEqual({ v, n: DEFAULT_HEAL_MAX_ATTEMPTS });
    }
  });
});

describe('readControls', () => {
  it('reads the execution plane switch; a switch that cannot be read is not armed', async () => {
    const on = env({ DELIVERY_LOOP_ENABLED: 'true', DELIVERY_LOOP_AUTONOMY: 'L3' });
    expect((await readControls(on, async () => true)).armed).toBe(true);
    expect((await readControls(on, async () => false)).armed).toBe(false);
    expect((await readControls(on, async () => { throw new Error('db down'); })).armed).toBe(false);
    expect((await readControls(on, async () => 'yes' as unknown as boolean)).armed).toBe(false);
  });

  it('carries the other controls through', async () => {
    const c = await readControls(env({ DELIVERY_LOOP_ENABLED: 'true', DELIVERY_LOOP_AUTONOMY: 'L2', DELIVERY_LOOP_PROJECTS: 'a/b', DELIVERY_LOOP_MAX_ACTIONS: '7', DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '2' }), async () => true);
    expect(c).toEqual({ enabled: true, autonomy: 'L2', armed: true, projects: ['a/b'], maxActions: 7, healMaxAttempts: 2, branchPrefixes: ['dev-autopilot/', 'delivery-loop/'], healMain: false, reworkMaxRounds: 2 });
  });
});

describe('mayDo', () => {
  const c = (over: Partial<Controls>): Controls => ({ enabled: true, autonomy: 'L1', armed: true, projects: [], maxActions: 5, healMaxAttempts: 3, branchPrefixes: ['dev-autopilot/'], healMain: false, reworkMaxRounds: 2, ...over });

  it('nothing is allowed when the loop is off, at any level, armed or not', () => {
    for (const autonomy of ['L0', 'L1', 'L2', 'L3'] as Autonomy[]) {
      for (const action of ['record', 'learn', 'prepare', 'act'] as LoopAction[]) {
        expect(mayDo(c({ enabled: false, autonomy, armed: true }), action)).toBe(false);
      }
    }
  });

  it('acting needs L3 and an armed execution plane; the other actions do not look at the switch', () => {
    expect(mayDo(c({ autonomy: 'L3', armed: true }), 'act')).toBe(true);
    expect(mayDo(c({ autonomy: 'L3', armed: false }), 'act')).toBe(false);
    expect(mayDo(c({ autonomy: 'L2', armed: true }), 'act')).toBe(false);
    expect(mayDo(c({ autonomy: 'L3', armed: false }), 'prepare')).toBe(true);
    expect(mayDo(c({ autonomy: 'L3', armed: false }), 'record')).toBe(true);
  });

  it('the default level records and learns, and prepares and acts on nothing', () => {
    const d = c({ autonomy: autonomyFrom(env({})) });
    expect(['record', 'learn', 'prepare', 'act'].map((a) => mayDo(d, a as LoopAction))).toEqual([true, true, false, false]);
  });
});

describe('the branches the loop owns', () => {
  it('default to dev-autopilot/ and delivery-loop/; a set value replaces them and an empty one means none', () => {
    expect(branchPrefixesFrom(env({}))).toEqual([...DEFAULT_BRANCH_PREFIXES]);
    expect(branchPrefixesFrom(env({ DELIVERY_LOOP_BRANCH_PREFIXES: 'bot/, fixes/auto/' }))).toEqual(['bot/', 'fixes/auto/']);
    expect(branchPrefixesFrom(env({ DELIVERY_LOOP_BRANCH_PREFIXES: '' }))).toEqual([]);
  });

  it('a value that is not a plain prefix is dropped: no pattern, no empty prefix, no traversal, so it cannot widen to "every branch"', () => {
    const bad = ['', '/', '*', '*/', '.*', 'a', 'a/..//', '../', 'a/../b/', 'a//', ' ', 'a b/', 'kiro'];
    expect(branchPrefixesFrom(env({ DELIVERY_LOOP_BRANCH_PREFIXES: bad.join(',') }))).toEqual([]);
    expect(branchPrefixesFrom(env({ DELIVERY_LOOP_BRANCH_PREFIXES: '*,ok/,.*' }))).toEqual(['ok/']);
  });

  it('ownsBranch: the prefixes for heal and review; main only for heal and only when the owner asked', () => {
    const c = { branchPrefixes: ['dev-autopilot/'], healMain: false };
    expect(ownsBranch(c, 'dev-autopilot/ab12', 'heal')).toBe(true);
    expect(ownsBranch(c, 'dev-autopilot/ab12', 'review')).toBe(true);
    expect(ownsBranch(c, 'kiro/plan/lane', 'heal')).toBe(false);
    expect(ownsBranch(c, 'dev-autopilot', 'heal')).toBe(false);
    expect(ownsBranch(c, 'main', 'heal')).toBe(false);
    expect(ownsBranch(c, null, 'heal')).toBe(false);
    const main = { branchPrefixes: [], healMain: true };
    expect(ownsBranch(main, 'main', 'heal')).toBe(true);
    expect(ownsBranch(main, 'main', 'review')).toBe(false);
    expect(ownsBranch(main, 'mainline', 'heal')).toBe(false);
  });

  it('healing main is on only for the exact string "true"', () => {
    expect(healMainFrom(env({ DELIVERY_LOOP_HEAL_MAIN: 'true' }))).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'yes', ' true']) expect(healMainFrom(env({ DELIVERY_LOOP_HEAL_MAIN: v }))).toBe(false);
  });

  it('rework rounds: default 2, between 1 and 3, anything else is the default', () => {
    expect(reworkMaxRoundsFrom(env({}))).toBe(DEFAULT_REWORK_MAX_ROUNDS);
    expect(reworkMaxRoundsFrom(env({ DELIVERY_LOOP_REWORK_MAX_ROUNDS: '3' }))).toBe(3);
    for (const v of ['0', '4', '-1', '1.5', 'x']) expect(reworkMaxRoundsFrom(env({ DELIVERY_LOOP_REWORK_MAX_ROUNDS: v }))).toBe(DEFAULT_REWORK_MAX_ROUNDS);
  });
});
