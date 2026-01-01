/**
 * VTID-01097: Guided Diary Templates v1 (Longevity + Relationships First)
 *
 * Improves memory quality at the source by offering guided diary templates
 * that help users reflect on health, relationships, habits, and meaning.
 *
 * Endpoints:
 * - GET  /api/v1/diary/templates  - Returns static template definitions
 * - POST /api/v1/diary/entry      - Submit a diary entry (free or guided)
 *
 * Dependencies:
 * - VTID-01082 (Diary)
 * - VTID-01083 (Longevity)
 * - VTID-01087 (Relationships)
 * - VTID-01093 (Topics)
 * - VTID-01104 (Memory RPC)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01097: Template Type Definitions
// =============================================================================

/**
 * Template types available in v1
 */
const TEMPLATE_TYPES = [
  'daily_longevity',
  'relationships_social',
  'habits_routines',
  'meaning_values',
  'free'
] as const;

type TemplateType = typeof TEMPLATE_TYPES[number];

/**
 * Mood values for Daily Longevity Check-in
 */
const MOOD_VALUES = [
  'great',
  'good',
  'neutral',
  'low',
  'struggling'
] as const;

type MoodValue = typeof MOOD_VALUES[number];

/**
 * Movement intensity levels
 */
const MOVEMENT_VALUES = ['none', 'light', 'moderate', 'intense'] as const;
type MovementValue = typeof MOVEMENT_VALUES[number];

/**
 * Interaction feeling for Relationships template
 */
const INTERACTION_FEELING_VALUES = ['energized', 'neutral', 'drained'] as const;
type InteractionFeelingValue = typeof INTERACTION_FEELING_VALUES[number];

/**
 * Habit types for Habits & Routines template
 */
const HABIT_TYPES = ['sleep', 'food', 'movement', 'focus', 'recovery'] as const;
type HabitType = typeof HABIT_TYPES[number];

/**
 * Habit follow status
 */
const HABIT_FOLLOW_VALUES = ['yes', 'no', 'partial'] as const;
type HabitFollowValue = typeof HABIT_FOLLOW_VALUES[number];

/**
 * Available tag categories
 */
const TAG_CATEGORIES = {
  longevity: ['sleep', 'stress', 'movement', 'nutrition', 'recovery', 'energy'],
  relationships: ['friendship', 'family', 'community', 'work', 'intimacy', 'romance'],
  habits: ['routine', 'consistency', 'growth', 'challenge', 'success', 'setback'],
  meaning: ['purpose', 'learning', 'contribution', 'balance', 'gratitude', 'reflection']
} as const;

// =============================================================================
// VTID-01097: Template Definitions (Static)
// =============================================================================

interface TemplateField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'enum' | 'range' | 'boolean' | 'tags';
  required: boolean;
  placeholder?: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  default_tags?: readonly string[];
}

interface DiaryTemplate {
  id: TemplateType;
  name: string;
  description: string;
  purpose: string;
  longevity_hint: string;
  fields: TemplateField[];
  suggested_tags: readonly string[];
  category_key: string;
}

const DIARY_TEMPLATES: readonly DiaryTemplate[] = [
  {
    id: 'daily_longevity',
    name: 'Daily Longevity Check-in',
    description: 'Track your health, energy, and body awareness',
    purpose: 'health + body awareness',
    longevity_hint: 'Regular check-ins help identify patterns that affect your healthspan and vitality.',
    fields: [
      {
        key: 'content',
        label: 'How was your day?',
        type: 'textarea',
        required: true,
        placeholder: 'Share how you felt today...'
      },
      {
        key: 'mood',
        label: 'Mood',
        type: 'enum',
        required: true,
        options: MOOD_VALUES
      },
      {
        key: 'energy_level',
        label: 'Energy Level',
        type: 'range',
        required: true,
        min: 1,
        max: 10
      },
      {
        key: 'sleep_quality',
        label: 'Sleep Quality',
        type: 'range',
        required: false,
        min: 1,
        max: 5
      },
      {
        key: 'movement',
        label: 'Movement Today?',
        type: 'enum',
        required: false,
        options: MOVEMENT_VALUES
      }
    ],
    suggested_tags: TAG_CATEGORIES.longevity,
    category_key: 'health'
  },
  {
    id: 'relationships_social',
    name: 'Relationships & Social Life',
    description: 'Reflect on your connections and social interactions',
    purpose: 'people memory and relationship awareness',
    longevity_hint: 'Strong social bonds are one of the top predictors of longevity and wellbeing.',
    fields: [
      {
        key: 'content',
        label: 'Who did you connect with today?',
        type: 'textarea',
        required: true,
        placeholder: 'Share about your interactions...'
      },
      {
        key: 'people_mentioned',
        label: 'People (optional)',
        type: 'text',
        required: false,
        placeholder: 'Names of people you connected with'
      },
      {
        key: 'interaction_feeling',
        label: 'How did the interaction(s) make you feel?',
        type: 'enum',
        required: false,
        options: INTERACTION_FEELING_VALUES
      }
    ],
    suggested_tags: TAG_CATEGORIES.relationships,
    category_key: 'relationships'
  },
  {
    id: 'habits_routines',
    name: 'Habits & Routines',
    description: 'Track your patterns and habit formation',
    purpose: 'pattern formation and consistency',
    longevity_hint: 'Sustainable habits compound over time to create lasting health benefits.',
    fields: [
      {
        key: 'habit_type',
        label: 'Habit Type',
        type: 'enum',
        required: true,
        options: HABIT_TYPES
      },
      {
        key: 'habit_followed',
        label: 'Did you follow it today?',
        type: 'enum',
        required: true,
        options: HABIT_FOLLOW_VALUES
      },
      {
        key: 'content',
        label: 'Why / Why not?',
        type: 'textarea',
        required: false,
        placeholder: 'Reflect on what helped or got in the way...'
      }
    ],
    suggested_tags: TAG_CATEGORIES.habits,
    category_key: 'goals'
  },
  {
    id: 'meaning_values',
    name: 'Meaning & Values',
    description: 'Reflect on what gives your life meaning',
    purpose: 'long-term quality of life and purpose',
    longevity_hint: 'A sense of purpose is strongly linked to cognitive health and longevity.',
    fields: [
      {
        key: 'content',
        label: 'What felt meaningful today?',
        type: 'textarea',
        required: true,
        placeholder: 'Share a moment or activity that felt meaningful...'
      },
      {
        key: 'misalignment',
        label: 'Did anything feel misaligned?',
        type: 'textarea',
        required: false,
        placeholder: 'Optional: anything that felt off or contrary to your values'
      }
    ],
    suggested_tags: TAG_CATEGORIES.meaning,
    category_key: 'preferences'
  },
  {
    id: 'free',
    name: 'Free Diary',
    description: 'Write freely without structure',
    purpose: 'open expression and reflection',
    longevity_hint: 'Regular journaling supports mental clarity and emotional processing.',
    fields: [
      {
        key: 'content',
        label: 'What\'s on your mind?',
        type: 'textarea',
        required: true,
        placeholder: 'Write freely...'
      }
    ],
    suggested_tags: [...TAG_CATEGORIES.longevity, ...TAG_CATEGORIES.meaning],
    category_key: 'notes'
  }
] as const;

// =============================================================================
// VTID-01097: Request Validation Schemas
// =============================================================================

/**
 * Common fields for all diary entries
 */
const DiaryEntryBaseSchema = z.object({
  template_type: z.enum(TEMPLATE_TYPES).default('free'),
  content: z.string().min(1, 'Content is required'),
  tags: z.array(z.string()).optional().default([]),
  occurred_at: z.string().datetime().optional()
});

/**
 * Daily Longevity specific fields
 */
const DailyLongevityFieldsSchema = z.object({
  mood: z.enum(MOOD_VALUES).optional(),
  energy_level: z.number().int().min(1).max(10).optional(),
  sleep_quality: z.number().int().min(1).max(5).optional(),
  movement: z.enum(MOVEMENT_VALUES).optional()
});

/**
 * Relationships specific fields
 */
const RelationshipsFieldsSchema = z.object({
  people_mentioned: z.string().optional(),
  interaction_feeling: z.enum(INTERACTION_FEELING_VALUES).optional()
});

/**
 * Habits specific fields
 */
const HabitsFieldsSchema = z.object({
  habit_type: z.enum(HABIT_TYPES).optional(),
  habit_followed: z.enum(HABIT_FOLLOW_VALUES).optional()
});

/**
 * Meaning & Values specific fields
 */
const MeaningFieldsSchema = z.object({
  misalignment: z.string().optional()
});

/**
 * Combined diary entry schema (accepts all possible fields)
 */
const DiaryEntryRequestSchema = DiaryEntryBaseSchema
  .merge(DailyLongevityFieldsSchema)
  .merge(RelationshipsFieldsSchema)
  .merge(HabitsFieldsSchema)
  .merge(MeaningFieldsSchema);

type DiaryEntryRequest = z.infer<typeof DiaryEntryRequestSchema>;

// =============================================================================
// VTID-01097: Helper Functions
// =============================================================================

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Emit a diary-related OASIS event
 */
async function emitDiaryEvent(
  type: 'diary.template.shown' | 'diary.template.submitted' | 'memory.garden.extract.triggered',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01097',
    type: type as any,
    source: 'diary-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01097] Failed to emit ${type}:`, err.message));
}

/**
 * Deterministic name detection from text (for relationship signals)
 * Returns array of potential names mentioned in text
 */
function detectPeopleNames(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  const names: string[] = [];

  // Simple heuristic: look for capitalized words that might be names
  // This is deterministic - no AI/inference involved
  const words = text.split(/[\s,;.!?]+/);

  for (const word of words) {
    // Skip common words and single characters
    if (word.length < 2) continue;

    // Check if word starts with capital letter and rest is lowercase
    const isCapitalized = /^[A-Z][a-z]+$/.test(word);

    // Skip common non-name capitalized words
    const commonWords = ['I', 'The', 'A', 'An', 'My', 'We', 'They', 'He', 'She', 'It', 'Today', 'Yesterday', 'Tomorrow'];
    if (isCapitalized && !commonWords.includes(word)) {
      names.push(word);
    }
  }

  // Deduplicate
  return [...new Set(names)];
}

/**
 * Auto-generate tags based on content
 */
function autoSuggestTags(content: string, templateType: TemplateType): string[] {
  const lowerContent = content.toLowerCase();
  const tags: string[] = [];

  // Template-specific tag suggestions
  const tagPool = templateType === 'daily_longevity' ? TAG_CATEGORIES.longevity
    : templateType === 'relationships_social' ? TAG_CATEGORIES.relationships
    : templateType === 'habits_routines' ? TAG_CATEGORIES.habits
    : templateType === 'meaning_values' ? TAG_CATEGORIES.meaning
    : [...TAG_CATEGORIES.longevity, ...TAG_CATEGORIES.meaning];

  // Simple keyword matching for tags
  const tagKeywords: Record<string, string[]> = {
    sleep: ['sleep', 'slept', 'rest', 'nap', 'bed', 'insomnia', 'tired'],
    stress: ['stress', 'anxious', 'worried', 'overwhelmed', 'pressure'],
    movement: ['walk', 'run', 'exercise', 'gym', 'workout', 'yoga', 'swim'],
    nutrition: ['eat', 'food', 'meal', 'diet', 'healthy', 'vegetable', 'fruit'],
    recovery: ['recover', 'healing', 'relax', 'restore'],
    energy: ['energy', 'energetic', 'vibrant', 'alive', 'exhausted'],
    friendship: ['friend', 'buddy', 'pal', 'mate'],
    family: ['family', 'parent', 'sibling', 'child', 'mom', 'dad', 'brother', 'sister'],
    community: ['community', 'group', 'team', 'club', 'organization'],
    work: ['work', 'colleague', 'coworker', 'boss', 'office', 'meeting'],
    intimacy: ['intimate', 'partner', 'spouse', 'relationship'],
    purpose: ['purpose', 'meaningful', 'mission', 'calling'],
    learning: ['learn', 'study', 'read', 'discover', 'curious'],
    contribution: ['help', 'contribute', 'give', 'volunteer', 'support'],
    balance: ['balance', 'harmony', 'equilibrium'],
    gratitude: ['grateful', 'thankful', 'appreciate', 'blessed'],
    reflection: ['reflect', 'think', 'ponder', 'consider']
  };

  for (const tag of tagPool) {
    const keywords = tagKeywords[tag] || [];
    for (const keyword of keywords) {
      if (lowerContent.includes(keyword)) {
        tags.push(tag);
        break;
      }
    }
  }

  return [...new Set(tags)];
}

/**
 * Get category key based on template type
 */
function getCategoryKey(templateType: TemplateType): string {
  const template = DIARY_TEMPLATES.find(t => t.id === templateType);
  return template?.category_key || 'notes';
}

// =============================================================================
// VTID-01097: Extraction Hooks
// =============================================================================

interface ExtractionResult {
  garden_nodes_triggered: boolean;
  relationship_signals: string[];
  topic_profile_updated: boolean;
}

/**
 * Trigger extraction hooks after diary entry submission
 * - Always call memory_extract_garden_nodes
 * - If relationships template: attempt name detection for relationship signals
 * - Update user_topic_profile
 */
async function triggerExtractionHooks(
  token: string,
  entryId: string,
  entry: DiaryEntryRequest,
  userId?: string,
  tenantId?: string
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    garden_nodes_triggered: false,
    relationship_signals: [],
    topic_profile_updated: false
  };

  try {
    const supabase = createUserSupabaseClient(token);

    // 1. Trigger memory garden node extraction
    // This is a placeholder - actual RPC would be memory_extract_garden_nodes
    // For now, we emit an OASIS event to track when extraction should happen
    await emitDiaryEvent(
      'memory.garden.extract.triggered',
      'info',
      `Garden node extraction triggered for diary entry ${entryId}`,
      {
        entry_id: entryId,
        template_type: entry.template_type,
        content_length: entry.content.length,
        user_id: userId,
        tenant_id: tenantId
      }
    );
    result.garden_nodes_triggered = true;

    // 2. If relationships template, detect names for relationship signals
    if (entry.template_type === 'relationships_social') {
      const textToAnalyze = entry.content + ' ' + (entry.people_mentioned || '');
      const detectedNames = detectPeopleNames(textToAnalyze);

      if (detectedNames.length > 0) {
        result.relationship_signals = detectedNames;

        // Log relationship signals (actual edge creation would be handled by a separate service)
        console.log(`[VTID-01097] Relationship signals detected: ${detectedNames.join(', ')}`);
      }
    }

    // 3. Update user_topic_profile (placeholder - would call actual RPC)
    // For now, we track the tags used for future topic profile updates
    if (entry.tags && entry.tags.length > 0) {
      result.topic_profile_updated = true;
      console.log(`[VTID-01097] Topic profile update: ${entry.tags.join(', ')}`);
    }

  } catch (err: any) {
    console.error('[VTID-01097] Extraction hooks error:', err.message);
  }

  return result;
}

// =============================================================================
// VTID-01097: Routes
// =============================================================================

/**
 * GET /templates -> GET /api/v1/diary/templates
 *
 * Returns static template definitions (JSON).
 * Templates are optional - users can always choose free diary.
 */
router.get('/templates', async (req: Request, res: Response) => {
  console.log('[VTID-01097] GET /diary/templates');

  // Emit template shown event (for analytics)
  await emitDiaryEvent(
    'diary.template.shown',
    'info',
    'Diary templates fetched',
    {
      template_count: DIARY_TEMPLATES.length,
      template_types: DIARY_TEMPLATES.map(t => t.id)
    }
  );

  return res.status(200).json({
    ok: true,
    templates: DIARY_TEMPLATES,
    metadata: {
      version: '1.0.0',
      vtid: 'VTID-01097',
      template_count: DIARY_TEMPLATES.length,
      available_moods: MOOD_VALUES,
      available_movements: MOVEMENT_VALUES,
      available_interaction_feelings: INTERACTION_FEELING_VALUES,
      available_habit_types: HABIT_TYPES,
      available_habit_follows: HABIT_FOLLOW_VALUES,
      tag_categories: TAG_CATEGORIES
    }
  });
});

/**
 * POST /entry -> POST /api/v1/diary/entry
 *
 * Submit a diary entry (free or guided template).
 * Creates entry in memory_items with source='diary' and entry_type='guided' or 'free'.
 */
router.post('/entry', async (req: Request, res: Response) => {
  console.log('[VTID-01097] POST /diary/entry');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = DiaryEntryRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01097] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const entry = validation.data;

  // Validate template type exists
  const template = DIARY_TEMPLATES.find(t => t.id === entry.template_type);
  if (!template) {
    return res.status(400).json({
      ok: false,
      error: `Invalid template_type: ${entry.template_type}`
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const entryId = randomUUID();
    const occurredAt = entry.occurred_at || new Date().toISOString();
    const categoryKey = getCategoryKey(entry.template_type);
    const entryType = entry.template_type === 'free' ? 'free' : 'guided';

    // Auto-suggest tags if none provided
    const autoTags = autoSuggestTags(entry.content, entry.template_type);
    const finalTags = entry.tags.length > 0 ? entry.tags : autoTags;

    // Build content_json with structured fields
    const contentJson: Record<string, unknown> = {
      entry_type: entryType,
      template_type: entry.template_type,
      tags: finalTags,
      version: '1.0.0',
      vtid: 'VTID-01097'
    };

    // Add template-specific fields to content_json
    if (entry.mood) contentJson.mood = entry.mood;
    if (entry.energy_level) contentJson.energy_level = entry.energy_level;
    if (entry.sleep_quality) contentJson.sleep_quality = entry.sleep_quality;
    if (entry.movement) contentJson.movement = entry.movement;
    if (entry.people_mentioned) contentJson.people_mentioned = entry.people_mentioned;
    if (entry.interaction_feeling) contentJson.interaction_feeling = entry.interaction_feeling;
    if (entry.habit_type) contentJson.habit_type = entry.habit_type;
    if (entry.habit_followed) contentJson.habit_followed = entry.habit_followed;
    if (entry.misalignment) contentJson.misalignment = entry.misalignment;

    // Call memory_write_item RPC with source='diary'
    const { data, error } = await supabase.rpc('memory_write_item', {
      p_category_key: categoryKey,
      p_source: 'diary',
      p_content: entry.content,
      p_content_json: contentJson,
      p_importance: 20, // Diary entries have moderate importance
      p_occurred_at: occurredAt
    });

    if (error) {
      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01097] memory_write_item RPC not found (VTID-01104 not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Memory RPC not available (VTID-01104 dependency)'
        });
      }
      console.error('[VTID-01097] memory_write_item RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    const memoryId = data?.id || entryId;

    // Trigger extraction hooks
    const extractionResult = await triggerExtractionHooks(token, memoryId, entry);

    // Emit OASIS event
    await emitDiaryEvent(
      'diary.template.submitted',
      'success',
      `Diary entry submitted: ${entry.template_type}`,
      {
        entry_id: memoryId,
        template_type: entry.template_type,
        entry_type: entryType,
        category_key: categoryKey,
        content_length: entry.content.length,
        tags: finalTags,
        has_mood: !!entry.mood,
        has_energy: !!entry.energy_level,
        extraction_result: extractionResult
      }
    );

    console.log(`[VTID-01097] Diary entry created: ${memoryId} (${entry.template_type})`);

    return res.status(201).json({
      ok: true,
      id: memoryId,
      entry_type: entryType,
      template_type: entry.template_type,
      category_key: categoryKey,
      tags: finalTags,
      occurred_at: occurredAt,
      extraction: {
        garden_nodes_triggered: extractionResult.garden_nodes_triggered,
        relationship_signals: extractionResult.relationship_signals,
        topic_profile_updated: extractionResult.topic_profile_updated
      }
    });
  } catch (err: any) {
    console.error('[VTID-01097] diary entry error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /health -> GET /api/v1/diary/health
 *
 * Health check for diary service.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'diary-gateway',
    version: '1.0.0',
    vtid: 'VTID-01097',
    timestamp: new Date().toISOString(),
    capabilities: {
      templates: true,
      guided_entries: hasSupabaseUrl && hasSupabaseKey,
      free_entries: hasSupabaseUrl && hasSupabaseKey,
      extraction_hooks: true,
      template_count: DIARY_TEMPLATES.length
    },
    dependencies: {
      'VTID-01082': 'diary_foundation',
      'VTID-01083': 'longevity',
      'VTID-01087': 'relationships',
      'VTID-01093': 'topics',
      'VTID-01104': 'memory_rpc'
    }
  });
});

export default router;
