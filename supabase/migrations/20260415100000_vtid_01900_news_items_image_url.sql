-- VTID-01900: Add image_url column to news_items
-- Stores the featured image extracted from RSS feed items
-- (enclosure, media:content, media:thumbnail, or first <img> in content)

ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_url TEXT;
