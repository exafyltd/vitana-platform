// BOOTSTRAP-SOCIAL-MEMORY — anti-regression walls for the ORB voice social
// wiring. The mobile assistant is the ORB voice surface; these walls pin the
// three pieces that make social questions answerable there, so a refactor
// can't silently disconnect them again:
//   1. get_social_context is in the shared ORB tool registry (Vertex,
//      LiveKit, and /api/v1/orb/tool reachability).
//   2. The Vertex live catalog DECLARES the tool with the question param
//      and the DE+EN "ALWAYS CALL THIS" contract.
//   3. The Vertex dispatcher has a case arm for it (source-level wall,
//      same style as the b2/b3 walls suites).
//   4. buildBrainSystemInstruction passes force_social so voice sessions
//      start with the social pack (source-level wall).

import * as fs from 'fs';
import * as path from 'path';
import { ORB_TOOL_REGISTRY } from '../../src/services/orb-tools-shared';
import { buildLiveApiTools } from '../../src/orb/live/tools/live-tool-catalog';

const SRC = path.join(__dirname, '..', '..', 'src');

describe('get_social_context — shared registry', () => {
  it('is registered in ORB_TOOL_REGISTRY', () => {
    expect(typeof ORB_TOOL_REGISTRY.get_social_context).toBe('function');
  });
});

describe('get_social_context — Vertex live catalog declaration', () => {
  function collectDeclarations(): any[] {
    const out: any[] = [];
    for (const t of buildLiveApiTools() as any[]) {
      if (t?.name) out.push(t);
      // Vertex BidiGenerate uses snake_case function_declarations.
      for (const fd of t?.function_declarations || t?.functionDeclarations || []) out.push(fd);
    }
    return out;
  }

  it('declares the tool with a required question parameter', () => {
    const decl = collectDeclarations().find((d) => d.name === 'get_social_context');
    expect(decl).toBeDefined();
    expect(decl.parameters?.properties?.question?.type).toBe('string');
    expect(decl.parameters?.required).toContain('question');
  });

  it('the description carries the ALWAYS-CALL contract in EN and DE', () => {
    const decl = collectDeclarations().find((d) => d.name === 'get_social_context');
    expect(decl.description).toContain('ALWAYS CALL THIS');
    expect(decl.description).toContain('Wem folge ich?');
    expect(decl.description).toContain('Welche Matches habe ich?');
    expect(decl.description).toContain('NEVER answer these questions from');
  });
});

describe('voice wiring — source-level walls', () => {
  it('orb-live.ts routes the get_social_context case to the shared dispatcher', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes', 'orb-live.ts'), 'utf8');
    expect(src).toContain("case 'get_social_context':");
    const caseIdx = src.indexOf("case 'get_social_context':");
    const window = src.slice(caseIdx, caseIdx + 2500);
    expect(window).toContain('dispatchOrbToolForVertex');
  });

  it('buildBrainSystemInstruction forces the social pack at voice session start', () => {
    const src = fs.readFileSync(path.join(SRC, 'services', 'vitana-brain.ts'), 'utf8');
    expect(src).toMatch(/force_social:\s*isCommunitySurface/);
  });
});
