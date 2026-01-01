/**
 * VTID-01097: Guided Diary Templates Unit Tests
 *
 * Tests for:
 * - GET /api/v1/diary/templates - Template definitions
 * - POST /api/v1/diary/entry - Diary entry submission
 * - Extraction hooks - Name detection, tag auto-suggestion
 * - OASIS events - Event emission
 *
 * Platform invariant: Memory quality at the source through guided templates.
 */

import request from 'supertest';
import express, { Router } from 'express';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

// Mock the OASIS event service
const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

// Mock the Supabase user client
const mockRpc = jest.fn();
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn().mockReturnValue({
    rpc: mockRpc,
  }),
}));

// Import the diary router after mocks are set up
import diaryRouter from '../src/routes/diary';

describe('VTID-01097: Guided Diary Templates', () => {
  let app: express.Application;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Reset mock RPC to default success
    mockRpc.mockResolvedValue({
      data: { id: 'test-memory-id' },
      error: null,
    });

    // Create fresh Express app
    app = express();
    app.use(express.json());
    app.use('/api/v1/diary', diaryRouter);
  });

  describe('GET /templates', () => {
    it('should return all template definitions', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.templates).toBeDefined();
      expect(Array.isArray(response.body.templates)).toBe(true);
      expect(response.body.templates.length).toBeGreaterThan(0);
    });

    it('should include all required template types', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      const templateIds = response.body.templates.map((t: any) => t.id);
      expect(templateIds).toContain('daily_longevity');
      expect(templateIds).toContain('relationships_social');
      expect(templateIds).toContain('habits_routines');
      expect(templateIds).toContain('meaning_values');
      expect(templateIds).toContain('free');
    });

    it('should return metadata with version and VTID', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      expect(response.body.metadata).toBeDefined();
      expect(response.body.metadata.vtid).toBe('VTID-01097');
      expect(response.body.metadata.version).toBe('1.0.0');
    });

    it('should include available enum values in metadata', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      expect(response.body.metadata.available_moods).toContain('great');
      expect(response.body.metadata.available_moods).toContain('struggling');
      expect(response.body.metadata.available_movements).toContain('none');
      expect(response.body.metadata.available_movements).toContain('intense');
      expect(response.body.metadata.available_habit_types).toContain('sleep');
    });

    it('should emit diary.template.shown OASIS event', async () => {
      await request(app).get('/api/v1/diary/templates');

      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vtid: 'VTID-01097',
          type: 'diary.template.shown',
          source: 'diary-gateway',
          status: 'info',
        })
      );
    });

    it('should include longevity_hint in each template', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      for (const template of response.body.templates) {
        expect(template.longevity_hint).toBeDefined();
        expect(typeof template.longevity_hint).toBe('string');
        expect(template.longevity_hint.length).toBeGreaterThan(0);
      }
    });

    it('should include fields definition for each template', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      for (const template of response.body.templates) {
        expect(template.fields).toBeDefined();
        expect(Array.isArray(template.fields)).toBe(true);
        expect(template.fields.length).toBeGreaterThan(0);

        for (const field of template.fields) {
          expect(field.key).toBeDefined();
          expect(field.label).toBeDefined();
          expect(field.type).toBeDefined();
          expect(typeof field.required).toBe('boolean');
        }
      }
    });
  });

  describe('POST /entry', () => {
    it('should reject requests without authentication', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .send({ content: 'Test entry', template_type: 'free' });

      expect(response.status).toBe(401);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should reject requests without content', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({ template_type: 'free' });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain('Validation failed');
    });

    it('should accept free diary entry', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Today was a great day!',
          template_type: 'free',
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.id).toBeDefined();
      expect(response.body.entry_type).toBe('free');
      expect(response.body.template_type).toBe('free');
    });

    it('should accept daily longevity entry with all fields', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Feeling energetic after a good sleep',
          template_type: 'daily_longevity',
          mood: 'great',
          energy_level: 8,
          sleep_quality: 4,
          movement: 'moderate',
          tags: ['sleep', 'energy'],
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.entry_type).toBe('guided');
      expect(response.body.template_type).toBe('daily_longevity');
      expect(response.body.category_key).toBe('health');
    });

    it('should accept relationships entry', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Had coffee with Sarah today',
          template_type: 'relationships_social',
          people_mentioned: 'Sarah',
          interaction_feeling: 'energized',
          tags: ['friendship'],
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.template_type).toBe('relationships_social');
      expect(response.body.category_key).toBe('relationships');
    });

    it('should accept habits entry', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Stuck to my morning routine',
          template_type: 'habits_routines',
          habit_type: 'sleep',
          habit_followed: 'yes',
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.template_type).toBe('habits_routines');
      expect(response.body.category_key).toBe('goals');
    });

    it('should accept meaning entry', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Helping my colleague felt meaningful',
          template_type: 'meaning_values',
          misalignment: 'Spent too much time on emails',
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.template_type).toBe('meaning_values');
      expect(response.body.category_key).toBe('preferences');
    });

    it('should call memory_write_item RPC with source=diary', async () => {
      await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Test entry',
          template_type: 'free',
        });

      expect(mockRpc).toHaveBeenCalledWith(
        'memory_write_item',
        expect.objectContaining({
          p_source: 'diary',
          p_content: 'Test entry',
        })
      );
    });

    it('should emit diary.template.submitted OASIS event', async () => {
      await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Test entry',
          template_type: 'daily_longevity',
          mood: 'good',
        });

      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vtid: 'VTID-01097',
          type: 'diary.template.submitted',
          source: 'diary-gateway',
          status: 'success',
        })
      );
    });

    it('should return extraction result with relationship signals for relationships template', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Had lunch with John and Mary today',
          template_type: 'relationships_social',
          people_mentioned: 'John, Mary',
          interaction_feeling: 'energized',
        });

      expect(response.status).toBe(201);
      expect(response.body.extraction).toBeDefined();
      expect(response.body.extraction.garden_nodes_triggered).toBe(true);
      expect(response.body.extraction.relationship_signals).toContain('John');
      expect(response.body.extraction.relationship_signals).toContain('Mary');
    });

    it('should handle RPC errors gracefully', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'RPC failed' },
      });

      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Test entry',
          template_type: 'free',
        });

      expect(response.status).toBe(502);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain('RPC failed');
    });

    it('should reject invalid template type', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Test entry',
          template_type: 'invalid_template',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });

    it('should reject invalid mood value', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Test entry',
          template_type: 'daily_longevity',
          mood: 'invalid_mood',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });

    it('should reject energy_level out of range', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Test entry',
          template_type: 'daily_longevity',
          energy_level: 15, // Out of range
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });

    it('should auto-suggest tags when none provided', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'I slept well and exercised today',
          template_type: 'daily_longevity',
        });

      expect(response.status).toBe(201);
      expect(response.body.tags).toBeDefined();
      expect(response.body.tags.length).toBeGreaterThan(0);
      // Should detect sleep and movement keywords
      expect(response.body.tags).toContain('sleep');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/v1/diary/health');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('diary-gateway');
      expect(response.body.vtid).toBe('VTID-01097');
    });

    it('should include capabilities in health response', async () => {
      const response = await request(app).get('/api/v1/diary/health');

      expect(response.body.capabilities).toBeDefined();
      expect(response.body.capabilities.templates).toBe(true);
      expect(response.body.capabilities.extraction_hooks).toBe(true);
    });

    it('should list dependencies', async () => {
      const response = await request(app).get('/api/v1/diary/health');

      expect(response.body.dependencies).toBeDefined();
      expect(response.body.dependencies['VTID-01082']).toBe('diary_foundation');
      expect(response.body.dependencies['VTID-01104']).toBe('memory_rpc');
    });
  });

  describe('Template Structure Validation', () => {
    it('daily_longevity should have required fields', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      const longevityTemplate = response.body.templates.find(
        (t: any) => t.id === 'daily_longevity'
      );

      expect(longevityTemplate).toBeDefined();
      expect(longevityTemplate.fields.find((f: any) => f.key === 'mood')).toBeDefined();
      expect(longevityTemplate.fields.find((f: any) => f.key === 'energy_level')).toBeDefined();
      expect(longevityTemplate.fields.find((f: any) => f.key === 'sleep_quality')).toBeDefined();
      expect(longevityTemplate.fields.find((f: any) => f.key === 'movement')).toBeDefined();
    });

    it('relationships_social should have required fields', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      const relationshipsTemplate = response.body.templates.find(
        (t: any) => t.id === 'relationships_social'
      );

      expect(relationshipsTemplate).toBeDefined();
      expect(
        relationshipsTemplate.fields.find((f: any) => f.key === 'people_mentioned')
      ).toBeDefined();
      expect(
        relationshipsTemplate.fields.find((f: any) => f.key === 'interaction_feeling')
      ).toBeDefined();
    });

    it('habits_routines should have required fields', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      const habitsTemplate = response.body.templates.find(
        (t: any) => t.id === 'habits_routines'
      );

      expect(habitsTemplate).toBeDefined();
      expect(habitsTemplate.fields.find((f: any) => f.key === 'habit_type')).toBeDefined();
      expect(habitsTemplate.fields.find((f: any) => f.key === 'habit_followed')).toBeDefined();
    });

    it('meaning_values should have required fields', async () => {
      const response = await request(app).get('/api/v1/diary/templates');

      const meaningTemplate = response.body.templates.find(
        (t: any) => t.id === 'meaning_values'
      );

      expect(meaningTemplate).toBeDefined();
      expect(meaningTemplate.fields.find((f: any) => f.key === 'misalignment')).toBeDefined();
    });
  });

  describe('Extraction Hooks: Name Detection', () => {
    it('should detect capitalized names from content', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'I met with Alice and Bob today',
          template_type: 'relationships_social',
        });

      expect(response.body.extraction.relationship_signals).toContain('Alice');
      expect(response.body.extraction.relationship_signals).toContain('Bob');
    });

    it('should not detect common words as names', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'Today I went to The store',
          template_type: 'relationships_social',
        });

      // Should not include common words like "Today", "The", "I"
      expect(response.body.extraction.relationship_signals).not.toContain('Today');
      expect(response.body.extraction.relationship_signals).not.toContain('The');
      expect(response.body.extraction.relationship_signals).not.toContain('I');
    });

    it('should deduplicate detected names', async () => {
      const response = await request(app)
        .post('/api/v1/diary/entry')
        .set('Authorization', 'Bearer test-token')
        .send({
          content: 'I saw John at the cafe. John said hello.',
          template_type: 'relationships_social',
        });

      const johnCount = response.body.extraction.relationship_signals.filter(
        (n: string) => n === 'John'
      ).length;
      expect(johnCount).toBe(1); // Should only appear once
    });
  });
});
