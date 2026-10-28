/**
 * VTID-05177 — native app remote config: the checked-in source of truth.
 *
 * Served by GET /api/v1/app-config (routes/app-config.ts). Every flag ships
 * OFF and the minimum supported version is 0.0.0. Turning a flag ON, or
 * raising a minimum version, is a reviewed change to THIS file that goes
 * through Gate 2 — never a runtime control. system_controls rows
 * `native_app.kill.<ios|android|all>.<flag>` can only force a flag OFF
 * (services/app-config/app-config-service.ts).
 *
 * Adding a flag is additive. Removing or renaming one bumps
 * APP_CONFIG_SCHEMA_VERSION. N5 (Health Sync) and N6 (ORB native) own their
 * flags' meaning; this file only names them.
 */

export const APP_CONFIG_SCHEMA_VERSION = 1;

/** How long the app may keep a fetched config before re-fetching. */
export const APP_CONFIG_TTL_SECONDS = 300;

export const APP_CONFIG_PLATFORMS = ['ios', 'android'] as const;
export type AppConfigPlatform = (typeof APP_CONFIG_PLATFORMS)[number];

export const APP_CONFIG_FLAGS = ['push_enabled', 'health_sync_enabled', 'orb_native_enabled'] as const;
export type AppConfigFlag = (typeof APP_CONFIG_FLAGS)[number];

export interface PlatformConfig {
  min_supported_version: string;
  recommended_version: string | null;
  update_url: string | null;
  flags: Record<AppConfigFlag, boolean>;
}

export const APP_CONFIG_DEFAULTS: Readonly<Record<AppConfigPlatform, PlatformConfig>> = {
  ios: {
    min_supported_version: '0.0.0',
    recommended_version: null,
    update_url: null,
    flags: {
      push_enabled: false,
      health_sync_enabled: false,
      orb_native_enabled: false,
    },
  },
  android: {
    min_supported_version: '0.0.0',
    recommended_version: null,
    update_url: null,
    flags: {
      push_enabled: false,
      health_sync_enabled: false,
      orb_native_enabled: false,
    },
  },
};
