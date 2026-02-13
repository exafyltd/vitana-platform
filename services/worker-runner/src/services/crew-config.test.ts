/**
 * VTID-01230: Tests for Crew Config Loader
 */

import { loadCrewConfig, resolveModelForRole, CrewConfig } from './crew-config';

describe('loadCrewConfig', () => {
  it('should load crew.yaml and return config', () => {
    const config = loadCrewConfig();

    expect(config).toBeDefined();
    expect(config.version).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.roles).toBeDefined();
  });

  it('should have models section with required providers', () => {
    const config = loadCrewConfig();

    // crew.yaml v2.0 defines these models
    expect(config.models.gemini).toBeDefined();
    expect(config.models.claude).toBeDefined();

    expect(config.models.gemini.provider).toBe('vertex_ai');
    expect(config.models.claude.provider).toBe('anthropic');
  });

  it('should have roles section with primary/fallback', () => {
    const config = loadCrewConfig();

    expect(config.roles.worker).toBeDefined();
    expect(config.roles.worker.primary).toBeDefined();
    expect(config.roles.worker.fallback).toBeDefined();

    expect(config.roles.planner).toBeDefined();
    expect(config.roles.planner.primary).toBeDefined();

    expect(config.roles.validator).toBeDefined();
    expect(config.roles.validator.primary).toBeDefined();
  });

  it('should return same cached instance on repeated calls', () => {
    const config1 = loadCrewConfig();
    const config2 = loadCrewConfig();
    expect(config1).toBe(config2);
  });
});

describe('resolveModelForRole', () => {
  it('should resolve worker role to concrete model IDs', () => {
    const resolved = resolveModelForRole('worker');

    expect(resolved.provider).toBeDefined();
    expect(resolved.modelId).toBeDefined();
    expect(resolved.fallbackProvider).toBeDefined();
    expect(resolved.fallbackModelId).toBeDefined();

    // Worker primary is gemini per crew.yaml v2.0
    expect(resolved.provider).toBe('vertex_ai');
    expect(resolved.modelId).toContain('gemini');
  });

  it('should resolve planner role', () => {
    const resolved = resolveModelForRole('planner');

    // Planner primary is claude per crew.yaml v2.0
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.modelId).toContain('claude');
  });

  it('should resolve validator role', () => {
    const resolved = resolveModelForRole('validator');

    // Validator primary is claude per crew.yaml v2.0
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.modelId).toContain('claude');
  });

  it('should fallback gracefully for unknown role', () => {
    const resolved = resolveModelForRole('unknown_role');

    // Should fall back to worker defaults
    expect(resolved.provider).toBeDefined();
    expect(resolved.modelId).toBeDefined();
  });

  it('should have different primary and fallback providers for worker', () => {
    const resolved = resolveModelForRole('worker');

    // Worker: primary=gemini (vertex_ai), fallback=claude (anthropic)
    expect(resolved.provider).not.toBe(resolved.fallbackProvider);
  });
});
