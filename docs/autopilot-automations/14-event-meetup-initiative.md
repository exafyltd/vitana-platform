# AP-1400: Event & Meetup Initiative

> Wave 7 — New Initiative (Day 14–90)
> Let Vitana create events, check calendars, send invitations, and organize meetups.

| ID | Name | Status | Priority | Trigger | Target Roles | Description |
|----|------|--------|----------|---------|-------------|-------------|
| AP-1401 | Smart Event Creation | PLANNED | P1 | heartbeat (24h) | community, patient, professional | Creates events on user's behalf based on interests and social graph |
| AP-1402 | Calendar Availability Check | PLANNED | P1 | event: `event.suggestion.created` | community, patient, professional | Checks calendar before suggesting events to avoid conflicts |
| AP-1403 | Auto-Invitation Sender | PLANNED | P1 | event: `event.created` | community, patient, professional | Sends invitations to relevant members when an event is created |
| AP-1404 | Event Discovery Recommendation | PLANNED | P1 | cron: daily 9 AM | community, patient, professional | "Hey, I got something you will like" — personalized event suggestions |
| AP-1405 | Social Meetup Organizer | PLANNED | P2 | heartbeat (24h) | community, patient, professional | Organizes meetups for people with shared interests |

## Cross-Domain Dependencies

- AP-1401 → AP-0303 (Events & Live Rooms: Event Engagement Activator)
- AP-1404 → AP-0101 (Connect People: Daily Match Delivery — shared interest data)
- AP-1405 → AP-0105 (Connect People: Group Recommendation Push)
