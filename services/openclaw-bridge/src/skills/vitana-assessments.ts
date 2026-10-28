/**
 * Vitana Assessments Skill for OpenClaw
 *
 * Life stage evaluations, health goals, and wellness assessments.
 * Integrates with the health domain for scoring and tracking.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ASSESSMENT_TYPES = [
  'life_stage', 'health_baseline', 'wellness_check',
  'nutrition', 'sleep', 'movement', 'stress', 'social',
] as const;

const StartAssessmentSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  assessment_type: z.enum(ASSESSMENT_TYPES),
  metadata: z.record(z.unknown()).optional(),
});

const SubmitResponseSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  assessment_id: z.string().uuid(),
  question_key: z.string().min(1).max(100),
  answer: z.unknown(),
});

const CompleteAssessmentSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  assessment_id: z.string().uuid(),
});

const GetResultsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  assessment_id: z.string().uuid(),
});

const ListAssessmentsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  assessment_type: z.enum(ASSESSMENT_TYPES).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

const SetGoalSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  domain: z.enum(['sleep', 'movement', 'nutrition', 'stress', 'social', 'energy', 'longevity']),
  target: z.string().min(1).max(500),
  deadline: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ListGoalsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  status: z.enum(['active', 'achieved', 'abandoned']).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Start a new assessment for a user.
   */
  async start_assessment(input: unknown) {
    const { tenant_id, user_id, assessment_type, metadata } =
      StartAssessmentSchema.parse(input);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('assessments')
      .insert({
        tenant_id,
        user_id,
        assessment_type,
        status: 'in_progress',
        metadata: metadata ?? {},
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`start_assessment failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'assessments.started',
      actor: 'openclaw-autopilot',
      details: { user_id, assessment_type, assessment_id: data.id },
      created_at: new Date().toISOString(),
    });

    return { success: true, assessment: data };
  },

  /**
   * Submit a response to an assessment question.
   */
  async submit_response(input: unknown) {
    const { tenant_id, user_id, assessment_id, question_key, answer } =
      SubmitResponseSchema.parse(input);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('assessment_responses')
      .upsert({
        tenant_id,
        user_id,
        assessment_id,
        question_key,
        answer,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'assessment_id,question_key' })
      .select()
      .single();

    if (error) throw new Error(`submit_response failed: ${error.message}`);
    return { success: true, response: data };
  },

  /**
   * Complete an assessment and trigger scoring.
   */
  async complete_assessment(input: unknown) {
    const { tenant_id, user_id, assessment_id } = CompleteAssessmentSchema.parse(input);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('assessments')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', assessment_id)
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .select()
      .single();

    if (error) throw new Error(`complete_assessment failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'assessments.completed',
      actor: 'openclaw-autopilot',
      details: { user_id, assessment_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, assessment: data };
  },

  /**
   * Get assessment results and scores.
   */
  async get_results(input: unknown) {
    const { tenant_id, user_id, assessment_id } = GetResultsSchema.parse(input);
    const supabase = getSupabase();

    const [assessmentResult, responsesResult] = await Promise.all([
      supabase
        .from('assessments')
        .select('*')
        .eq('id', assessment_id)
        .eq('tenant_id', tenant_id)
        .eq('user_id', user_id)
        .single(),
      supabase
        .from('assessment_responses')
        .select('question_key, answer, submitted_at')
        .eq('assessment_id', assessment_id)
        .order('submitted_at', { ascending: true }),
    ]);

    if (assessmentResult.error) throw new Error(`get_results failed: ${assessmentResult.error.message}`);

    return {
      success: true,
      assessment: assessmentResult.data,
      responses: responsesResult.data ?? [],
    };
  },

  /**
   * List assessments for a user.
   */
  async list_assessments(input: unknown) {
    const { tenant_id, user_id, assessment_type, limit } = ListAssessmentsSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('assessments')
      .select('id, assessment_type, status, created_at, completed_at')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (assessment_type) query = query.eq('assessment_type', assessment_type);

    const { data, error } = await query;
    if (error) throw new Error(`list_assessments failed: ${error.message}`);
    return { success: true, assessments: data, count: data?.length ?? 0 };
  },

  /**
   * Set a health/wellness goal for a user.
   */
  async set_goal(input: unknown) {
    const { tenant_id, user_id, domain, target, deadline, metadata } =
      SetGoalSchema.parse(input);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('user_goals')
      .insert({
        tenant_id,
        user_id,
        domain,
        target,
        deadline,
        status: 'active',
        metadata: metadata ?? {},
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`set_goal failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'assessments.goal_set',
      actor: 'openclaw-autopilot',
      details: { user_id, domain, target },
      created_at: new Date().toISOString(),
    });

    return { success: true, goal: data };
  },

  /**
   * List health/wellness goals for a user.
   */
  async list_goals(input: unknown) {
    const { tenant_id, user_id, status, limit } = ListGoalsSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('user_goals')
      .select('id, domain, target, status, deadline, created_at')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(`list_goals failed: ${error.message}`);
    return { success: true, goals: data, count: data?.length ?? 0 };
  },
};

export const SKILL_META = {
  name: 'vitana-assessments',
  description: 'Life stage evaluations, wellness assessments, health goals, and scoring',
  actions: Object.keys(actions),
};
