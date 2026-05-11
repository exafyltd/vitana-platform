import { buildSelfHealingAutonomyReadiness } from '../src/routes/dev-autopilot';

describe('dev autopilot self-healing autonomy readiness', () => {
  it('exposes completed reliability gates and the next blocked step toward full autonomy', () => {
    const readiness = buildSelfHealingAutonomyReadiness();

    expect(readiness.summary).toMatchObject({
      ready_gates: 2,
      total_gates: 8,
      autonomy_percent: 25,
      next_gate: {
        id: 'patch_artifacts',
        status: 'blocked',
      },
    });

    expect(readiness.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'spec_hydration',
        status: 'ready',
        evidence: expect.arrayContaining([
          'pending tasks include spec_content from vtid_specs',
          'self-healing workers fail closed without hydrated specs',
        ]),
      }),
      expect.objectContaining({
        id: 'completion_evidence',
        status: 'ready',
        evidence: expect.arrayContaining([
          'worker-runner removed unconditional skip_verification',
          'gateway rejects self-healing success without repair evidence',
        ]),
      }),
      expect.objectContaining({
        id: 'patch_artifacts',
        status: 'blocked',
        next_step: expect.stringContaining('patch-workspace-service'),
      }),
    ]));
  });
});
