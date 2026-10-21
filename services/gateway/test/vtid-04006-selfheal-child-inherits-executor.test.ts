/**
 * VTID-04006: a self-heal child inherits its parent's executor mode, and
 * (VTID-04005) carries the parent's failure evidence on its own row.
 */

import { inheritedOnRampMetadata } from '../src/services/dev-autopilot-bridge';

describe('VTID-04006 inheritedOnRampMetadata — executor', () => {
  it('copies executor=agent from the parent', () => {
    expect(inheritedOnRampMetadata({ executor: 'agent', llm_on_ramp: 'deepseek' })).toEqual({ executor: 'agent', llm_on_ramp: 'deepseek' });
  });
  it('copies executor=single-shot and ignores anything else', () => {
    expect(inheritedOnRampMetadata({ executor: 'single-shot' })).toEqual({ executor: 'single-shot' });
    expect(inheritedOnRampMetadata({ executor: 'weird' })).toEqual({});
    expect(inheritedOnRampMetadata({ executor: 42 })).toEqual({});
    expect(inheritedOnRampMetadata(null)).toEqual({});
  });
});
