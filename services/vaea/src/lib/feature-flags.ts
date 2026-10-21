export interface FeatureFlags {
  vaeaEnabled: boolean;
  vaeaAutoExecuteEnabled: boolean;
  meshBoundedNetwork: boolean;
  observeEnabled: boolean;
  observeIntervalMs: number;
}

export function readFeatureFlags(): FeatureFlags {
  return {
    vaeaEnabled: process.env.VAEA_ENABLED === 'true',
    vaeaAutoExecuteEnabled: process.env.VAEA_AUTO_EXECUTE_ENABLED === 'true',
    meshBoundedNetwork: process.env.VAEA_MESH_BOUNDED_NETWORK !== 'false',
    observeEnabled: process.env.VAEA_PHASE_1_OBSERVE_ENABLED === 'true',
    observeIntervalMs: parseInt(process.env.VAEA_OBSERVE_INTERVAL_MS || '300000', 10),
  };
}
