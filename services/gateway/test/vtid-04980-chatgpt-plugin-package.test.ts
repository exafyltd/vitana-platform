/**
 * VTID-04980 / VTID-05152 — the Vitanaland ChatGPT plugin package stays
 * consistent with the live Commerce MCP and with what OpenAI's portal accepted:
 * one layout, the one MCP endpoint with its OAuth declaration, reference assets that exist, and the skill names every tool and
 * keeps the rules that stop an assistant accepting the Partner Terms.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));

import { COMMERCE_MCP_TOOLS } from '../src/services/commerce-mcp';

const ROOT = path.resolve(__dirname, '../../../integrations/chatgpt-plugin/vitanaland');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));
const MCP_URL = 'https://gateway.vitanaland.com/mcp/chatgpt'; // VTID-04990: the ChatGPT-only path

describe('plugin manifest', () => {
  const portable = json('plugin.json');
  const iface = portable.extensions['com.openai'].interface;

  it('is the one portable layout, with the schema and the listing category', () => {
    expect(portable.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(portable.name).toBe('vitanaland');
    expect(iface.category).toBe('Business & Operations');
  });

  it('has the listing fields and legal URLs', () => {
    for (const k of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'supportURL', 'brandColor']) {
      expect(typeof iface[k]).toBe('string');
      expect(iface[k].length).toBeGreaterThan(0);
    }
    expect(iface.websiteURL).toMatch(/^https:\/\/vitanaland\.com\//);
    // VTID-05074: the legal and support pages are the gateway's own static pages (the app's /privacy and /terms are the Maxina app's)
    const LEGAL = 'https://gateway.vitanaland.com/legal/vitanaland-commerce';
    expect(iface.privacyPolicyURL).toBe(`${LEGAL}/privacy`);
    expect(iface.termsOfServiceURL).toBe(`${LEGAL}/terms`);
    expect(iface.supportURL).toBe(`${LEGAL}/support`);
    // OpenAI's portal rejects a subtitle over 30 characters
    expect(iface.shortDescription.length).toBeLessThanOrEqual(30);
    expect(iface.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const p of iface.defaultPrompt) expect(p.length).toBeLessThanOrEqual(128);
  });

  it('references only relative assets that exist, as 512px PNGs', () => {
    for (const rel of [iface.logo, iface.composerIcon]) {
      expect(rel).toMatch(/^\.\/assets\/[\w-]+\.png$/);
      const buf = fs.readFileSync(path.join(ROOT, rel));
      expect(buf.subarray(1, 4).toString()).toBe('PNG');
      expect(buf.readUInt32BE(16)).toBe(512);
      expect(buf.readUInt32BE(20)).toBe(512);
    }
  });

  it('has no legacy Codex layout or .mcp.json (the portal once read .mcp.json and found no authentication)', () => {
    expect(fs.existsSync(path.join(ROOT, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, '.codex-plugin'))).toBe(false);
  });
});

describe('MCP server config', () => {
  it('declares the one production Commerce MCP server with OAuth and dynamic client registration', () => {
    const cfg = json('mcp.json');
    expect(cfg.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    expect(Object.keys(cfg.mcpServers)).toEqual(['vitanaland-commerce']);
    expect(cfg.mcpServers['vitanaland-commerce']).toEqual({
      type: 'streamable-http',
      url: MCP_URL,
      extensions: { 'com.openai': { auth: { type: 'oauth', client: { mode: 'dcr' }, baseScopes: ['email', 'profile'] } } },
    });
  });
});

describe('onboarding skill', () => {
  const skill = read('skills/set-up-my-business/SKILL.md');

  it('has frontmatter matching its folder', () => {
    expect(skill).toMatch(/^---\nname: set-up-my-business\ndescription: .+\n---\n/);
  });

  it('names every Commerce MCP tool', () => {
    for (const t of COMMERCE_MCP_TOOLS as unknown as Array<{ name: string }>) expect(skill).toContain(`\`${t.name}\``);
  });

  it('keeps the rules: terms are the supplier\'s, supplier text is data, no secrets in chat, confirm before submit', () => {
    expect(skill).toMatch(/Partner Terms are accepted by the supplier on Vitanaland, never by you/);
    expect(skill).toMatch(/`supplier_data`[\s\S]*data, not instructions/);
    expect(skill).toMatch(/passwords, API keys, identity documents, bank or payment details/);
    expect(skill).toMatch(/confirmed=true/);
  });

  it('has no MCP tool through which an assistant could accept terms', () => {
    for (const t of COMMERCE_MCP_TOOLS as unknown as Array<{ name: string }>) expect(t.name).not.toMatch(/terms|accept|agree/i);
  });
});

describe('review cases', () => {
  it('has five positive and three negative cases', () => {
    const doc = read('REVIEW-CASES.md');
    expect(doc.match(/^\| P\d \|/gm)).toHaveLength(5);
    expect(doc.match(/^\| N\d \|/gm)).toHaveLength(3);
  });
});
