# Memory Garden (Product Feature)

> The persistent personal knowledge repository inside Vitanaland that stores, organizes, and makes searchable everything the ORB learns about a user -- enabling "infinite memory" across years of interaction.

## Feature Overview

The Memory Garden is a structured data store organized into thirteen categories that capture every dimension of a user's life relevant to longevity. It receives data from two sources: automatic extraction during ORB conversations and manual user entries. It powers the ORB's ability to provide personalized guidance that builds on months and years of accumulated understanding rather than treating each session as a blank slate.

## Product Components

### Memory Categories (13)
Personal Identity, Health and Wellness, Lifestyle and Routines, Network and Relationships, Learning and Knowledge, Business and Projects, Finance and Assets, Location and Environment, Digital Footprint, Values and Aspirations, Autopilot and Context, Future Plans, Uncategorized.

See [[memory-garden|Memory Garden (concept)]] for detailed category breakdown.

### Memory Entry Types
- **Automatic facts** -- Extracted from ORB conversations with confidence levels (high/moderate/lower)
- **Manual entries** -- User-created facts, observations, goals, reflections
- **Diary entries** -- Personal journal/reflection entries with timestamps
- **Superseded entries** -- Old facts replaced by newer information

### User Interface Features
- **Browse** -- Navigate thirteen categories, view entries with timestamps and source indicators
- **Search** -- Natural language search across all memories ("When did I start feeling better about my sleep?")
- **Timeline** -- Chronological view of all memories
- **Diary** -- Dedicated journaling feature (create via Memory Garden UI or via ORB conversation)
- **Add** -- Manual entry to any category
- **Edit** -- Modify any stored memory
- **Delete** -- Remove individual memories, clear entire categories, or ask the ORB to forget via natural language
- **Export** -- Download full Memory Garden data

### Privacy Controls
- View all stored memories at any time
- Edit or correct any entry
- Delete individual memories or entire categories (permanent, complete deletion)
- Tell the ORB not to remember specific conversations
- Set category preferences to stop collection in specific areas
- Request review-before-saving for sensitive conversations
- Tenant-level data isolation (database-level enforcement)
- No cross-user data sharing
- Full data export

## Technical Characteristics

- **Confidence system** -- Facts tagged with high/moderate/lower confidence based on source (direct statement vs. inference vs. observed pattern)
- **Supersession** -- New facts automatically replace contradictory old facts; users can clarify exceptions
- **Relationship mapping** -- Builds a social graph of people mentioned, tracking relationship dynamics over time
- **Cross-category connections** -- Changes in one category (e.g., career) can be connected to impacts in others (e.g., stress, sleep)

## How It Feeds Other Systems

- **Autopilot** -- Memory Garden data is the primary input for personalization decisions
- **[[vitana-index-entity|Vitana Index]]** -- Health and wellness memories contribute to pillar scoring
- **[[matchmaking-system|Matchmaking]]** -- Relationship and interest data inform match suggestions
- **[[home-dashboard|Home Dashboard]]** -- Memories shape daily priorities and AI feed content
- **[[discover-marketplace|Discover]]** -- Goals and health data drive product/service personalization

## Status

- **Tenant**: all (available across all Vitanaland tenants)
- **Status**: live

## Related Pages

- [[memory-garden]] -- Conceptual deep-dive on the Memory Garden system
- [[maxina]] -- The ORB/Autopilot powered by Memory Garden data
- [[vitana-index-entity]] -- The scoring system that uses Memory Garden health data
- [[home-dashboard]] -- Where Memory Garden insights surface daily

## Sources

- `raw/knowledge-base/knowledge-base/en/10-memory-garden/01-what-is-memory-garden.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/02-thirteen-memory-categories.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/03-adding-memories.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/04-diary-entries.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/05-timeline-view.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/06-recall-and-search.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/07-privacy-controls.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/08-how-i-learn-about-you.md`
- `raw/knowledge-base/knowledge-base/en/10-memory-garden/09-exporting-your-data.md`

## Last Updated

2026-04-12
