-- Harness variant (VTID-05498): unrelated baseline knowledge_docs rows, as main's migrations seed on the real stack.
-- Loaded BEFORE the migration, so they are pre-existing rows. Proves the pgTAP file is independent of baseline data.
INSERT INTO public.knowledge_docs (title, path, content) VALUES
  ('Seed 1', 'kb/instruction-manual/maxina/00-existing.md', 'seed'),
  ('Seed 2', 'kb/instruction-manual/maxina/01-seed.md', 'seed'),
  ('Seed 3', 'kb/seed/03.md', 'seed'),
  ('Seed 4', 'kb/seed/04.md', 'seed'),
  ('Seed 5', 'kb/seed/05.md', 'seed');
