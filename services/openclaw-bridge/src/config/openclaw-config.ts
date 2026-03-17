/**
 * OpenClaw Configuration for Vitana Autopilot
 *
 * Privacy-hardened configuration that enforces:
 * - Local LLM for health data (no PHI sent to external providers)
 * - Tenant namespace isolation
 * - Disabled risky skills (shell, browser, file)
 * - OASIS governance integration
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const OpenClawConfigSchema = z.object({
  /** OpenClaw installation home directory */
  home: z.string().default('/opt/vitana-autopilot'),

  /** LLM provider configuration */
  llm: z.object({
    /** Provider for non-health tasks (anthropic allowed) */
    defaultProvider: z.enum(['ollama', 'anthropic', 'openai']).default('anthropic'),
    defaultModel: z.string().default('claude-sonnet-4-6'),

    /** Provider for health/PHI tasks (must be local) */
    healthProvider: z.literal('ollama').default('ollama'),
    healthModel: z.string().default('llama3.1:8b'),

    /** Ollama endpoint for local inference */
    ollamaUrl: z.string().url().default('http://localhost:11434'),
  }),

  /** Workspace isolation */
  workspace: z.object({
    isolation: z.enum(['tenant_namespaces', 'shared']).default('tenant_namespaces'),
  }),

  /** Disabled skills for security */
  disabledSkills: z.array(z.string()).default(['shell', 'browser', 'file']),

  /** HTTP channel (webhook) config */
  channel: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1024).max(65535).default(8080),
    path: z.string().default('/vitana-webhook'),
  }),

  /** Heartbeat / autonomous loop config */
  heartbeat: z.object({
    enabled: z.boolean().default(true),
    intervalMs: z.number().int().min(60_000).max(3_600_000).default(900_000), // 15 min
  }),

  /** OASIS bridge settings */
  oasis: z.object({
    /** Gateway URL for OASIS event emission */
    gatewayUrl: z.string().url().default('http://localhost:8080'),
    /** Whether to enforce governance checks before OpenClaw actions */
    enforceGovernance: z.boolean().default(true),
  }),
});

export type OpenClawConfig = z.infer<typeof OpenClawConfigSchema>;

// ---------------------------------------------------------------------------
// Load from environment
// ---------------------------------------------------------------------------

export function loadConfig(): OpenClawConfig {
  return OpenClawConfigSchema.parse({
    home: process.env.OPENCLAW_HOME,
    llm: {
      defaultProvider: process.env.OPENCLAW_LLM_PROVIDER,
      defaultModel: process.env.OPENCLAW_LLM_MODEL,
      healthProvider: 'ollama', // always local for PHI
      healthModel: process.env.OPENCLAW_HEALTH_MODEL,
      ollamaUrl: process.env.OLLAMA_URL,
    },
    workspace: {
      isolation: process.env.OPENCLAW_WORKSPACE_ISOLATION,
    },
    disabledSkills: process.env.OPENCLAW_DISABLED_SKILLS?.split(','),
    channel: {
      enabled: process.env.OPENCLAW_CHANNEL_ENABLED !== 'false',
      port: process.env.OPENCLAW_CHANNEL_PORT
        ? parseInt(process.env.OPENCLAW_CHANNEL_PORT, 10)
        : undefined,
      path: process.env.OPENCLAW_CHANNEL_PATH,
    },
    heartbeat: {
      enabled: process.env.OPENCLAW_HEARTBEAT_ENABLED !== 'false',
      intervalMs: process.env.OPENCLAW_HEARTBEAT_INTERVAL_MS
        ? parseInt(process.env.OPENCLAW_HEARTBEAT_INTERVAL_MS, 10)
        : undefined,
    },
    oasis: {
      gatewayUrl: process.env.GATEWAY_URL,
      enforceGovernance: process.env.OPENCLAW_ENFORCE_GOVERNANCE !== 'false',
    },
  });
}
