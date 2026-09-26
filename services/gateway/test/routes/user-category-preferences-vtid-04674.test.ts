/**
 * VTID-04674: Settings › Notifications shows only categories that hold a type
 * the admin has switched on, and a category members may not switch off stays on.
 */
import request from 'supertest';
import express from 'express';

const TENANT = '11111111-1111-1111-1111-111111111111';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'u1', tenant_id: TENANT };
    next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({})) }));
jest.mock('../../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('en') }));

const mockRepo = {
  fetchActiveNotificationCategories: jest.fn(),
  fetchUserCategoryPreferences: jest.fn(),
  fetchActiveNotificationCategoryById: jest.fn(),
  upsertUserCategoryPreference: jest.fn(),
  fetchEnabledNotificationTypes: jest.fn(),
};
jest.mock('../../src/routes/user-category-preferences-repository', () => mockRepo);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../src/routes/user-category-preferences').default;
const app = express();
app.use(express.json());
app.use('/prefs', router);

const CATS = [
  { id: 'c-dm', type: 'chat', slug: 'direct_messages', display_name: 'Direct Messages', default_enabled: true, mapped_types: ['new_chat_message', 'message_reaction'], member_can_disable: true },
  { id: 'c-live', type: 'community', slug: 'live_rooms', display_name: 'Live Rooms', default_enabled: true, mapped_types: ['live_room_starting'], member_can_disable: true },
  { id: 'c-posts', type: 'community', slug: 'posts_reactions', display_name: 'Posts & reactions', default_enabled: true, mapped_types: ['community_post_published', 'post_like'], member_can_disable: true },
  { id: 'c-acct', type: 'community', slug: 'account', display_name: 'Account', default_enabled: true, mapped_types: ['welcome_to_vitana'], member_can_disable: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.fetchActiveNotificationCategories.mockResolvedValue({ data: CATS, error: null });
  mockRepo.fetchUserCategoryPreferences.mockResolvedValue({
    data: [{ category_id: 'c-posts', enabled: false }, { category_id: 'c-acct', enabled: false }],
    error: null,
  });
  mockRepo.fetchEnabledNotificationTypes.mockResolvedValue({
    data: [{ type: 'new_chat_message' }, { type: 'post_like' }, { type: 'welcome_to_vitana' }],
    error: null,
  });
  mockRepo.upsertUserCategoryPreference.mockResolvedValue({ data: {}, error: null });
});

test('only categories holding an admin-enabled type are listed, with those types', async () => {
  const r = await request(app).get('/prefs');
  expect(r.status).toBe(200);
  const slugs = [...r.body.data.chat, ...r.body.data.community].map((c: any) => c.slug);
  expect(slugs).toEqual(['direct_messages', 'posts_reactions', 'account']);
  expect(r.body.data.chat[0].types).toEqual(['new_chat_message']);
  expect(r.body.data.community.find((c: any) => c.slug === 'posts_reactions')).toMatchObject({ enabled: false, locked: false });
});

test('a locked category is on even when an old preference row says off', async () => {
  const r = await request(app).get('/prefs');
  expect(r.body.data.community.find((c: any) => c.slug === 'account')).toMatchObject({ enabled: true, locked: true });
});

test('the switch list unreadable → every category is shown', async () => {
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockRepo.fetchEnabledNotificationTypes.mockResolvedValue({ data: null, error: { message: 'boom' } });
  const r = await request(app).get('/prefs');
  expect([...r.body.data.chat, ...r.body.data.community]).toHaveLength(4);
  err.mockRestore();
});

test('switching off a locked category → 409, nothing written', async () => {
  mockRepo.fetchActiveNotificationCategoryById.mockResolvedValue({ data: { id: 'c-acct', member_can_disable: false }, error: null });
  const r = await request(app).put('/prefs/c-acct').send({ enabled: false });
  expect(r.status).toBe(409);
  expect(mockRepo.upsertUserCategoryPreference).not.toHaveBeenCalled();
});

test('switching off a normal category is saved', async () => {
  mockRepo.fetchActiveNotificationCategoryById.mockResolvedValue({ data: { id: 'c-posts', member_can_disable: true }, error: null });
  const r = await request(app).put('/prefs/c-posts').send({ enabled: false });
  expect(r.status).toBe(200);
  expect(mockRepo.upsertUserCategoryPreference).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ category_id: 'c-posts', enabled: false }));
});
