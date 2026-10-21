-- VTID-01900: Longevity News Feed — news_items table
-- Stores RSS-ingested articles from 15 curated longevity sources.
-- No RLS — public news items; accessed via service-role in background job
-- and authenticated API routes.

CREATE TABLE IF NOT EXISTS news_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name   TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  title         TEXT NOT NULL,
  link          TEXT NOT NULL,
  summary       TEXT,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tags          TEXT[] DEFAULT '{}',
  source_type   TEXT NOT NULL DEFAULT 'alternative',
  content_hash  TEXT NOT NULL UNIQUE,  -- SHA-256 of title+link for dedup
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query: newest articles first
CREATE INDEX idx_news_items_published ON news_items(published_at DESC);

-- Tag filtering
CREATE INDEX idx_news_items_tags ON news_items USING GIN(tags);

-- Source filtering
CREATE INDEX idx_news_items_source ON news_items(source_name);

-- Dedup lookups
CREATE INDEX idx_news_items_hash ON news_items(content_hash);
