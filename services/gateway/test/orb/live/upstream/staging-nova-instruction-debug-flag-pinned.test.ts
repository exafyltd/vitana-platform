/**
 * VTID-03787 — diagnostic-only instrumentation, STAGING ONLY.
 *
 * VTID-03785/VTID-03786 both removed specific "risky phrase" patterns from
 * the guided-topic system-instruction path on the theory that Nova's
 * nova_validation content filter reacted to them. Both shipped correctly
 * (mutation-verified) and BOTH left the live block rate unchanged at 100%
 * across 6 real staging sessions post-deploy — falsifying that theory as
 * the sole cause. Rather than guess a fourth phrase pattern blind, this
 * VTID dumps the ACTUAL literal instruction text Nova receives to an
 * oasis_events diag stage, gated behind ORB_LOG_NOVA_INSTRUCTION_DEBUG, so
 * a real blocked guided-topic session can be diffed character-for-character
 * against a real succeeding ordinary session.
 *
 * The dumped text includes the user's memory/personalization context, so
 * this is deliberately never wired into AWS-PROD-DEPLOY-GATEWAY.yml.
 */

import * as fs from 'fs';
import * as path from 'path';

const STAGE_WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);
const PROD_WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
);
const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

const stageYml = fs.readFileSync(STAGE_WORKFLOW, 'utf8');
const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');
const orbLiveSource = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

describe('VTID-03787: staging pins ORB_LOG_NOVA_INSTRUCTION_DEBUG, prod never does', () => {
  it('upserts the flag as exact-"true" on staging', () => {
    expect(stageYml).toMatch(
      /\{name:"ORB_LOG_NOVA_INSTRUCTION_DEBUG", value:"true"\}/,
    );
  });

  it('strips the inherited value first, so a stale one cannot survive', () => {
    const stripBlock = stageYml.slice(
      stageYml.indexOf('.containerDefinitions[0].environment |='),
      stageYml.indexOf('.containerDefinitions[0].secrets |='),
    );
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"ORB_LOG_NOVA_INSTRUCTION_DEBUG"');
  });

  it('is NEVER set on the prod deploy workflow — the dumped text carries user context', () => {
    expect(prodYml).not.toMatch(/ORB_LOG_NOVA_INSTRUCTION_DEBUG/);
  });
});

describe('VTID-03787: orb-live.ts gates the instruction dump behind the exact-"true" env check', () => {
  it('reads process.env.ORB_LOG_NOVA_INSTRUCTION_DEBUG === \'true\' before emitting', () => {
    expect(orbLiveSource).toMatch(
      /process\.env\.ORB_LOG_NOVA_INSTRUCTION_DEBUG\s*===\s*'true'/,
    );
  });

  it('emits the literal novaSystemInstruction text on the diag stage nova_instruction_debug_dump', () => {
    expect(orbLiveSource).toMatch(/'nova_instruction_debug_dump'/);
    expect(orbLiveSource).toMatch(/instruction_text:\s*novaSystemInstruction/);
  });
});
