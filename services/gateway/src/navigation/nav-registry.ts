/**
 * VTID-04517 — the screen registry as the gateway sees it.
 *
 * The registry is owned by exafyltd/vitana-v1 (src/navigation/registry/) and
 * published by every frontend build as /nav-registry.json. The gateway reads
 * that file, so what Vitana can open is exactly what the deployed frontend
 * can render. A copy is bundled (data/nav-registry.snapshot.json) so the
 * gateway always has a registry even when the frontend is unreachable;
 * NAV_REGISTRY_URL points at the live file (staging:
 * https://preview-aws.vitanaland.com/nav-registry.json).
 *
 * The Command Hub navigator is not a second registry: it may only switch
 * screens off or adjust them per tenant (decision 2026-09-24).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface NavScreenText {
  title: string;
  shows?: string;
  hint?: string;
  phrasings?: string[];
}

export interface NavScreenOverlay {
  event: string;
  marker?: string;
  param?: string;
}

export interface NavScreen {
  id: string;
  route: string;
  mobileRoute?: string;
  viewport?: 'mobile' | 'desktop';
  overlay?: NavScreenOverlay;
  params?: string[];
  category: string;
  access: 'public' | 'member';
  aliases?: string[];
  formerIds?: string[];
  disabled?: string;
  /** Every shipped language, merged by the frontend build. */
  i18n: Record<string, NavScreenText>;
}

export interface NavRegistry {
  version: number;
  generated_at?: string;
  commit?: string | null;
  screens: NavScreen[];
}

export interface LoadedNavRegistry {
  registry: NavRegistry;
  /** Content hash of the screens; keys the embedding index. */
  signature: string;
  source: 'snapshot' | 'remote';
  loaded_at: number;
}

export const SNAPSHOT_PATH = path.join(__dirname, 'data', 'nav-registry.snapshot.json');
const REFRESH_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

/** Screens a spoken request alone can reach: not disabled, no entity needed. */
export function isVoiceTarget(s: NavScreen): boolean {
  return !s.disabled && !(s.params && s.params.length) && !s.overlay?.param;
}

/** The page a route belongs to (tabs and sections of one page share it). */
export function pageOf(route: string): string {
  return route.split('?')[0].replace(/\/+$/, '') || '/';
}

/** Returns a list of problems; empty means the registry is usable. */
export function validateNavRegistry(value: unknown): string[] {
  const problems: string[] = [];
  const reg = value as NavRegistry;
  if (!reg || typeof reg !== 'object' || !Array.isArray(reg.screens)) return ['screens is not an array'];
  if (reg.screens.length === 0) return ['screens is empty'];
  const seen = new Set<string>();
  for (const s of reg.screens) {
    if (!s || typeof s.id !== 'string' || !s.id) { problems.push('screen without id'); continue; }
    if (seen.has(s.id)) problems.push(`duplicate id ${s.id}`);
    seen.add(s.id);
    if (typeof s.route !== 'string' || !s.route.startsWith('/')) problems.push(`${s.id}: bad route`);
    if (!s.i18n || typeof s.i18n.en?.title !== 'string') problems.push(`${s.id}: no English title`);
  }
  return problems;
}

export function registrySignature(reg: NavRegistry): string {
  return createHash('sha256').update(JSON.stringify(reg.screens)).digest('hex').slice(0, 16);
}

function wrap(registry: NavRegistry, source: LoadedNavRegistry['source']): LoadedNavRegistry {
  return { registry, signature: registrySignature(registry), source, loaded_at: Date.now() };
}

let snapshotCache: LoadedNavRegistry | null = null;

export function loadSnapshotRegistry(): LoadedNavRegistry {
  if (!snapshotCache) {
    const reg = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as NavRegistry;
    const problems = validateNavRegistry(reg);
    if (problems.length) throw new Error(`bundled nav registry is invalid: ${problems.slice(0, 3).join('; ')}`);
    snapshotCache = wrap(reg, 'snapshot');
  }
  return snapshotCache;
}

let current: LoadedNavRegistry | null = null;
let lastAttempt = 0;
let inflight: Promise<LoadedNavRegistry> | null = null;

async function fetchRemote(url: string): Promise<NavRegistry> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as NavRegistry;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch NAV_REGISTRY_URL and adopt it when valid. Never throws: a failure
 * keeps whatever registry is already in use (the snapshot at worst) and
 * logs why.
 */
export async function refreshNavRegistry(): Promise<LoadedNavRegistry> {
  const url = process.env.NAV_REGISTRY_URL;
  lastAttempt = Date.now();
  if (!url) {
    current = current || loadSnapshotRegistry();
    return current;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const reg = await fetchRemote(url);
      const problems = validateNavRegistry(reg);
      if (problems.length) throw new Error(`invalid: ${problems.slice(0, 3).join('; ')}`);
      const next = wrap(reg, 'remote');
      if (!current || current.signature !== next.signature) {
        console.log(`[nav-registry] using ${url}: ${reg.screens.length} screens, signature ${next.signature}`);
      }
      current = next;
    } catch (err) {
      console.warn(`[nav-registry] could not load ${url} (${(err as Error).message}); keeping ${current ? current.source : 'snapshot'}`);
      current = current || loadSnapshotRegistry();
    } finally {
      inflight = null;
    }
    return current as LoadedNavRegistry;
  })();
  return inflight;
}

/** The registry in use now; starts a background refresh when it is stale. */
export function getNavRegistry(): LoadedNavRegistry {
  if (!current) current = loadSnapshotRegistry();
  if (Date.now() - lastAttempt > REFRESH_MS) void refreshNavRegistry();
  return current;
}

/** Test seam. */
export function __setNavRegistryForTests(reg: LoadedNavRegistry | null): void {
  current = reg;
  lastAttempt = reg ? Date.now() : 0;
}
