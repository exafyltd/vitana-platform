# Memory Garden

> A persistent, structured personal knowledge repository that gives the ORB AI "infinite memory" -- enabling continuity across years of interaction, long-term pattern detection, and deeply personalized longevity guidance.

## What It Is

The Memory Garden is the user's personal knowledge store inside Vitanaland. Unlike conventional digital tools that treat every session as a blank slate, the Memory Garden accumulates and organizes everything the ORB learns about the user -- from conversations, manual entries, diary reflections, and observed patterns. It is described as "a garden in the most literal sense" where knowledge seeds grow, connections form, and patterns emerge over time.

## The Thirteen Memory Categories

Each category captures a different dimension of life relevant to longevity:

| # | Category | What It Stores | Longevity Relevance |
|---|----------|---------------|-------------------|
| 1 | **Personal Identity** | Name, birthday, core identity facts | Age/life stage shapes health risks and recommendations |
| 2 | **Health and Wellness** | Medical history, conditions, biomarker trends, pillar scores | Most direct longevity dimension; enables preventive intelligence |
| 3 | **Lifestyle and Routines** | Sleep schedule, exercise habits, nutrition patterns, work rhythms | Blue Zones research: daily routines are the architecture of longevity |
| 4 | **Network and Relationships** | Family, friends, community connections, relationship dynamics | Social bonds are among the strongest longevity predictors |
| 5 | **Learning and Knowledge** | Curiosities, studies, skills, books, intellectual interests | Cognitive stimulation reduces risk of cognitive decline |
| 6 | **Business and Projects** | Professional work, projects, career context | Purpose-driven work extends life; overwork erodes it |
| 7 | **Finance and Assets** | Financial goals, concerns, stability context | Financial stress directly undermines all health pillars |
| 8 | **Location and Environment** | Where user lives/travels, climate, air quality, urban/rural | Environment shapes biology (air, walkability, nature access) |
| 9 | **Digital Footprint** | Digital habits, screen time patterns, tech preferences | Screen time disrupts sleep; digital tools can support tracking |
| 10 | **Values and Aspirations** | Core values, long-term vision, meaning sources | Purpose (Ikigai) is a longevity superpower |
| 11 | **Autopilot and Context** | Response patterns, preferred guidance timing, effective approaches | Personalization makes guidance effective vs. generic |
| 12 | **Future Plans** | Goals, milestones, upcoming events, life transitions | Forward-looking behavior predicts better present health choices |
| 13 | **Uncategorized** | Conversation notes, casual observations, passing thoughts | Often connects to patterns in other categories over time |

These categories are deeply interconnected. A change in health often connects to routines; career changes affect stress, which affects sleep, which affects nutrition.

## How Memories Are Created

### Automatic Extraction
During every ORB conversation, the system listens for meaningful signals: personal facts, health information, preferences, relationships, goals, emotional signals, and plans. Facts are extracted and categorized automatically. Example: "My partner Elena and I are trying to eat better -- she is doing keto and I am just cutting out processed sugar" yields four distinct facts stored across multiple categories.

### Manual Entry
Users can open the Memory Garden and directly add entries to any category -- facts, observations, goals, or reflections.

### Confidence Levels
Each fact carries a confidence level:
- **High** -- Directly stated by the user ("My birthday is September 9th")
- **Moderate** -- Inferred from context ("preparing for the kids' school break" implies children)
- **Lower** -- Observed patterns (tends to exercise in morning, more stressed on Mondays)

Confidence level affects how the ORB uses information: high-confidence facts are referenced confidently; lower-confidence observations are raised tentatively for confirmation.

### Supersession
When new information contradicts older facts, the new information replaces the old automatically ("I stopped being vegetarian" updates dietary preference). Users can clarify exceptions to prevent incorrect updates.

## Diary Entries

The diary is a dedicated journaling feature within the Memory Garden, backed by longevity research:

- **Stress reduction** -- Expressive writing lowers cortisol
- **Emotional clarity** -- Reveals inner patterns over time
- **Cognitive health** -- Writing engages multiple cognitive processes
- **Immune function** -- James Pennebaker's research shows expressive writing improves immune markers
- **Self-compassion** -- Looking back reveals growth and progress

Diary entries feed into the Mental Health pillar of the [[vitana-index|Vitana Index]] and are fully searchable using natural language.

## Timeline View

Memories are displayed chronologically, allowing users to watch their journey unfold over weeks, months, and years, spot patterns, and celebrate progress.

## Privacy Controls

Users have comprehensive control over their memories:

- **View** -- Browse by category, view individual entries, ask the ORB what it remembers
- **Edit** -- Update content directly or correct via conversation; supersession handles automatic updates
- **Delete** -- Remove individual memories, clear entire categories, or ask the ORB to forget via natural language. Deletion is permanent and complete.
- **Control capture** -- Tell the ORB not to remember specific conversations; set category preferences to stop collection; request review-before-saving for sensitive topics
- **Data isolation** -- Tenant-level isolation enforced at the database level (structural guarantee, not software rule). No cross-user data sharing. Memories never leave personal space.
- **Export** -- Full data export available at any time

## How Memory Powers the ORB

The Memory Garden transforms the ORB from a generic tool into a personalized partner. The compounding effect over time:
- First conversation: name, preferences, a health goal
- After one month: routines, relationships, daily challenges, deeper aspirations
- After six months: patterns connecting different life areas
- After one year+: long-term trends, seasonal patterns, connections between past experiences and current events

This continuity enables detection of slow-moving health changes (e.g., three-week sleep decline), recall of effective past interventions, and anticipation of needs before they are voiced.

## Related Pages

- [[memory-garden-entity]] -- Memory Garden as a product feature
- [[vitana-index]] -- How Memory Garden data feeds the scoring system
- [[health-tracking]] -- Health and wellness data within the Memory Garden
- [[maxina]] -- The ORB personality powered by Memory Garden knowledge

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
- `raw/knowledge-base/knowledge-base/en/07-maxina-experience/02-role-of-infinite-memory.md`

## Last Updated

2026-04-12
