/**
 * VTID-ASSISTANT-ROLES — registry ↔ real-tool-name reconciliation tests.
 *
 * The scoped enforcement (shouldBlockToolRoleAware) may only go live for
 * roles whose registry allowlists match REAL ORB_TOOL_REGISTRY names.
 * These tests pin that contract:
 *   - every dev_* / admin_* registered tool passes its own lane's policy;
 *   - cross-lane and community-wellness tools are denied;
 *   - community role behavior is untouched (shadow-only path).
 */

import {
  getRoleProfile,
  isToolAllowed,
} from '../src/services/intelligence/assistant-role-registry';
import { DEVELOPER_TOOL_HANDLERS } from '../src/services/orb-tools/developer-tools';
import { DEVELOPER_ACTION_TOOL_HANDLERS } from '../src/services/orb-tools/developer-action-tools';
import { ADMIN_ACTION_TOOL_HANDLERS } from '../src/services/orb-tools/admin-action-tools';

const developer = getRoleProfile('developer')!;
const admin = getRoleProfile('admin')!;

describe('developer lane reconciliation', () => {
  const devToolNames = [
    ...Object.keys(DEVELOPER_TOOL_HANDLERS),
    ...Object.keys(DEVELOPER_ACTION_TOOL_HANDLERS),
  ];

  it('allows every registered dev_* tool', () => {
    for (const name of devToolNames) {
      expect({ name, allowed: isToolAllowed(developer, name) }).toEqual({ name, allowed: true });
    }
  });

  it('allows the shared platform-neutral read tools', () => {
    for (const name of ['search_memory', 'search_knowledge', 'navigate', 'get_current_screen']) {
      expect(isToolAllowed(developer, name)).toBe(true);
    }
  });

  it('denies the admin lane and community wellness tools', () => {
    for (const name of ['admin_get_briefing', 'admin_approve_content', 'ask_pillar_agent', 'save_diary_entry', 'find_match', 'play_music', 'send_chat_message']) {
      expect({ name, allowed: isToolAllowed(developer, name) }).toEqual({ name, allowed: false });
    }
  });
});

describe('admin lane reconciliation', () => {
  const adminToolNames = Object.keys(ADMIN_ACTION_TOOL_HANDLERS);

  it('allows every registered admin_* tool', () => {
    for (const name of adminToolNames) {
      expect({ name, allowed: isToolAllowed(admin, name) }).toEqual({ name, allowed: true });
    }
  });

  it('denies the developer publish/revert plane and wellness tools', () => {
    for (const name of ['dev_publish_to_prod', 'dev_revert_prod', 'ask_pillar_agent', 'save_diary_entry']) {
      expect({ name, allowed: isToolAllowed(admin, name) }).toEqual({ name, allowed: false });
    }
  });

  it('does not inherit community tools (closed world)', () => {
    expect(isToolAllowed(admin, 'find_match')).toBe(false);
    expect(isToolAllowed(admin, 'narrate_guided_session')).toBe(false);
  });
});

describe('cross-lane isolation', () => {
  it('developer and admin lanes do not overlap on action tools', () => {
    for (const name of Object.keys(ADMIN_ACTION_TOOL_HANDLERS)) {
      expect(isToolAllowed(developer, name)).toBe(false);
    }
    for (const name of Object.keys(DEVELOPER_ACTION_TOOL_HANDLERS)) {
      expect(isToolAllowed(admin, name)).toBe(false);
    }
  });
});
