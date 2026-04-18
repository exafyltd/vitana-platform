export interface FeatureFlags {
  vaeaEnabled: boolean;
  vaeaAutoExecuteEnabled: boolean;
  meshBoundedNetwork: boolean;
}

export function readFeatureFlags(): FeatureFlags {
  return {
    vaeaEnabled: process.env.VAEA_ENABLED === 'true',
    vaeaAutoExecuteEnabled: process.env.VAEA_AUTO_EXECUTE_ENABLED === 'true',
    meshBoundedNetwork: process.env.VAEA_MESH_BOUNDED_NETWORK !== 'false',
  };
}
