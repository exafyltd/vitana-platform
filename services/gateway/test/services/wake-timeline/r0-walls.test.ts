/**
 * VTID-02927 (R0) — wall-integrity tests.
 *
 * R0 is measurement only. Asserts:
 *   - The new analysis route is mounted.
 *   - The Command Hub Reliability Analysis panel exists, is wired
 *     into the loader, fetches the analysis endpoint, and has NO
 *     mutation surface (no buttons, no POST/PUT/PATCH/DELETE).
 *   - The R0 report scaffold exists at the documented path with the
 *     7 required sections (telemetry completeness, latency,
 *     drop-off, unknown disconnects, sample reconstructions,
 *     conclusions, acceptance checks).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROUTE_PATH = join(__dirname, '../../../src/routes/voice-wake-timeline.ts');
const APP_JS_PATH = join(__dirname, '../../../src/frontend/command-hub/app.js');
const REPORT_PATH = join(__dirname, '../../../../../docs/reliability/R0-wake-timeline-validation.md');

describe('R0 — wall integrity', () => {
  let routeSrc: string;
  let appJs: string;
  let reportMd: string;
  beforeAll(() => {
    routeSrc = readFileSync(ROUTE_PATH, 'utf8');
    appJs = readFileSync(APP_JS_PATH, 'utf8');
    reportMd = readFileSync(REPORT_PATH, 'utf8');
  });

  describe('analysis route', () => {
    it('mounts GET /voice/wake-timeline/analysis', () => {
      expect(routeSrc).toMatch(/router\.get\(\s*['"]\/voice\/wake-timeline\/analysis['"]/);
    });

    it('requires exafy_admin auth', () => {
      // The analysis route handler should be sandwiched between
      // requireAuthWithTenant + requireExafyAdmin. Match from the
      // route registration through to the next `\n);` end marker.
      const startIdx = routeSrc.indexOf("'/voice/wake-timeline/analysis'");
      expect(startIdx).toBeGreaterThan(-1);
      const after = routeSrc.slice(startIdx, startIdx + 3000);
      expect(after).toContain('requireAuthWithTenant');
      expect(after).toContain('requireExafyAdmin');
    });

    it('calls analyzeReliabilityCohort (no inline tuning)', () => {
      expect(routeSrc).toContain('analyzeReliabilityCohort');
    });

    it('analysis handler has NO mutation calls', () => {
      const startIdx = routeSrc.indexOf("'/voice/wake-timeline/analysis'");
      const handler = routeSrc.slice(startIdx, startIdx + 3000);
      expect(handler).not.toMatch(/\.insert\(/);
      expect(handler).not.toMatch(/\.update\(/);
      expect(handler).not.toMatch(/\.upsert\(/);
      expect(handler).not.toMatch(/\.delete\(/);
      expect(handler).not.toMatch(/\.rpc\(/);
    });
  });

  describe('Command Hub Wake Reliability Analysis panel', () => {
    it('defines renderJourneyContextReliabilityAnalysisPanel', () => {
      expect(appJs).toContain('function renderJourneyContextReliabilityAnalysisPanel');
    });

    it('is wired into the journey-context render grid', () => {
      expect(appJs).toContain(
        'renderJourneyContextReliabilityAnalysisPanel(jc.reliabilityAnalysis)',
      );
    });

    it('loader fetches /api/v1/voice/wake-timeline/analysis', () => {
      expect(appJs).toMatch(/\/api\/v1\/voice\/wake-timeline\/analysis/);
    });

    it('stashes reliabilityAnalysis on state.journeyContext', () => {
      expect(appJs).toMatch(/jc\.reliabilityAnalysis\s*=/);
    });

    it('panel has NO mutation surface', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextReliabilityAnalysisPanel\(analysis\)\s*\{[\s\S]*?\n\}/,
      );
      expect(fnMatch).toBeTruthy();
      const body = fnMatch![0];
      expect(body).not.toMatch(/createElement\(['"]button['"]\)/);
      expect(body).not.toMatch(/\.onclick\s*=/);
      expect(body).not.toMatch(/addEventListener\(['"]click['"]/);
      expect(body).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    });

    it('panel renders the documented sub-sections', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextReliabilityAnalysisPanel\(analysis\)\s*\{[\s\S]*?\n\}/,
      );
      const body = fnMatch![0];
      // Five documented rollups.
      expect(body).toMatch(/sessions analyzed/);
      expect(body).toMatch(/time_to_first_audio_ms/);
      expect(body).toMatch(/Stage breakdown/);
      expect(body).toMatch(/Milestone reach/);
      expect(body).toMatch(/Disconnects/);
      expect(body).toMatch(/Continuation outcomes/);
      expect(body).toMatch(/Sample reconstructions/);
    });
  });

  describe('R0 report scaffold', () => {
    it('lives at docs/reliability/R0-wake-timeline-validation.md', () => {
      expect(reportMd.length).toBeGreaterThan(0);
    });

    it('declares the measurement-only discipline', () => {
      expect(reportMd).toMatch(/measurement only/);
      expect(reportMd).toMatch(/No tuning|no tuning|do not propose fixes/i);
    });

    it('has the 7 required sections', () => {
      const sections = [
        '## 1. Telemetry completeness',
        '## 2. Where the latency lives',
        '## 3. Which stage drops sessions',
        '## 4. Unknown disconnects',
        '## 5. Sample reconstructions',
        '## 6. Conclusions',
        '## 7. Acceptance checks',
      ];
      for (const s of sections) {
        expect(reportMd).toContain(s);
      }
    });

    it('enumerates every locked event in the telemetry completeness table', () => {
      const events = [
        'wake_clicked',
        'client_context_received',
        'ws_opened',
        'session_start_received',
        'session_context_built',
        'continuation_decision_started',
        'continuation_decision_finished',
        'wake_brief_selected',
        'upstream_live_connect_started',
        'upstream_live_connected',
        'first_model_output',
        'first_audio_output',
        'disconnect',
        'reconnect_attempt',
        'reconnect_success',
        'manual_restart_required',
      ];
      for (const e of events) {
        expect(reportMd).toContain(e);
      }
    });

    it('locks the 4 stage names matching the aggregator', () => {
      expect(reportMd).toContain('wake_clicked → gateway');
      expect(reportMd).toContain('gateway → continuation_decision_finished');
      expect(reportMd).toContain('decision → upstream_live_connected');
      expect(reportMd).toContain('upstream → first_audio_output');
    });

    it('declares R1/R2 as the follow-up slices (not part of R0)', () => {
      // [\s\S] for multiline; the report uses line breaks inside the
      // R1 / R2 bullet bodies.
      expect(reportMd).toMatch(/R1[\s\S]*?instrumentation/i);
      expect(reportMd).toMatch(/R2[\s\S]*?tuning/i);
    });
  });
});
