-- VTID-01900: Add language column to news_items
-- Enables language-filtered news feeds (user sees news in their preferred language)

ALTER TABLE news_items ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';

-- Index for language filtering
CREATE INDEX IF NOT EXISTS idx_news_items_language ON news_items(language);

-- Update composite index for common query: language + published_at
CREATE INDEX IF NOT EXISTS idx_news_items_lang_published ON news_items(language, published_at DESC);
