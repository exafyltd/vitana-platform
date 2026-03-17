/**
 * Skill Registry - Central registry for all Vitana OpenClaw skills.
 *
 * Skills are loaded at startup and made available to the bridge
 * for routing incoming OpenClaw tasks to the correct handler.
 */

import * as supabaseSkill from './vitana-supabase';
import * as stripeSkill from './vitana-stripe';
import * as dailySkill from './vitana-daily';
import * as healthSkill from './vitana-health';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillAction {
  (input: unknown): Promise<unknown>;
}

export interface SkillModule {
  actions: Record<string, SkillAction>;
  SKILL_META: {
    name: string;
    description: string;
    actions: string[];
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const SKILLS: Record<string, SkillModule> = {
  'vitana-supabase': supabaseSkill,
  'vitana-stripe': stripeSkill,
  'vitana-daily': dailySkill,
  'vitana-health': healthSkill,
};

/**
 * Get a registered skill by name.
 */
export function getSkill(name: string): SkillModule | undefined {
  return SKILLS[name];
}

/**
 * Execute a skill action by skill name and action name.
 */
export async function executeSkillAction(
  skillName: string,
  actionName: string,
  input: unknown,
): Promise<unknown> {
  const skill = SKILLS[skillName];
  if (!skill) {
    throw new Error(`Skill not found: ${skillName}. Available: ${Object.keys(SKILLS).join(', ')}`);
  }

  const action = skill.actions[actionName];
  if (!action) {
    throw new Error(
      `Action "${actionName}" not found in skill "${skillName}". Available: ${skill.SKILL_META.actions.join(', ')}`,
    );
  }

  return action(input);
}

/**
 * List all registered skills and their actions.
 */
export function listSkills(): Array<{ name: string; description: string; actions: string[] }> {
  return Object.values(SKILLS).map((s) => ({
    name: s.SKILL_META.name,
    description: s.SKILL_META.description,
    actions: s.SKILL_META.actions,
  }));
}

/**
 * Check if a skill+action combination exists.
 */
export function hasSkillAction(skillName: string, actionName: string): boolean {
  const skill = SKILLS[skillName];
  return skill !== undefined && actionName in skill.actions;
}
