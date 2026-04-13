# AP-1600: Health Action Initiative

> Wave 9 — New Initiative (Day 14–90)
> Lab tests, screenings, exercise, supplements — proactive health actions.

| ID | Name | Status | Priority | Trigger | Target Roles | Description |
|----|------|--------|----------|---------|-------------|-------------|
| AP-1601 | Lab Test Kit Ordering | PLANNED | P1 | heartbeat (24h) | community, patient | "Let's make a blood test" — prompts and guides lab test ordering |
| AP-1602 | Health Screening Scheduler | PLANNED | P1 | cron: 1st of month 8 AM | community, patient | Proactive screening schedule based on age, gender, and health data |
| AP-1603 | Motivational Health Nudge | PLANNED | P1 | cron: daily 8 AM | community, patient | "Come on. Go. Start." — daily motivational push |
| AP-1604 | Exercise Initiation | PLANNED | P2 | heartbeat (24h) | community, patient | Suggests and schedules exercise based on user preferences |
| AP-1605 | Supplement Reorder Reminder | PLANNED | P2 | heartbeat (24h) | community, patient | Tracks supplement usage and prompts reorders |

## Cross-Domain Dependencies

- AP-1601 → AP-0607 (Health & Wellness: Lab Report Ingestion)
- AP-1602 → AP-0608 (Health & Wellness: Biomarker Trend Analysis)
- AP-1603 → AP-0611 (Health & Wellness: Vitana Index Calculator)
- AP-1604 → AP-0610 (Health & Wellness: Health Goal Tracking)
