---
chapter: 12.2
screen_id: COM-CALENDAR
title: Calendar
tenant: maxina
module: Utility
tab: Calendar
url_path: /calendar
sidebar_path: Utility → Calendar
keywords: [calendar, calendar, calendar, utility]
related_concepts: []
related_screens: []
---

## What it is

Calendar is the managed schedule for events, reminders, health plans, business sessions, bookings, and Autopilot actions.

Utility screens are everyday tools: assistant chat, calendar, search, profile editing, and public profile preview.

## Why it matters

Longevity habits and economic opportunities both need timing. Calendar lets Vitana plan around real life instead of suggesting actions at random.

## Where to find it

Direct URL: `/calendar`.

Sidebar path: **Utility → Calendar**.

Module: **Utility**.

## What you see on this screen

- Agenda, day, week, or month view
- Events, reminders, bookings, and plan tasks
- Create, edit, complete, reschedule, and delete controls
- Share to feed: post an upcoming community event or live room you take part in to your community feed, with the event card
- Invite: send an entry to someone as an invite card in a direct chat or group; they answer yes, maybe or no
- Your daily Audiobook time, with a Listen button that opens the player
- Join and open buttons for events and live rooms
- External calendar sync state and conflict hints

## How to use it

1. Check current schedule before adding new commitments.
2. Create reminders from natural language when possible.
3. Add community events after RSVP or ticket purchase.
4. Reschedule useful tasks that are badly timed.
5. Use Calendar Popup for quick availability checks.
6. Open an event or live room and choose Share to feed to tell the community you are going.
7. Choose Invite to send an entry to a friend or a group chat. A free event is joined when they say yes; a paid event or a live room opens its page; your own plan lands in their calendar.
8. Set the Audiobook reminder time on the Audiobook screen; the daily slot then appears in the calendar.

## What you can ask Vitana

- "Open my calendar."
- "What is on today?"
- "Set a reminder for water at 3 PM."
- "Move this event to tomorrow."
- "Put the yoga meetup on my feed."
- "Invite Maria to my run on Saturday."
- "When is my audiobook time?"

## Guidance for Vitana Assistant

Utility screens are everyday tools: assistant chat, calendar, search, profile editing, and public profile preview. Explain the screen in plain language first, then offer the next safe action. Ask for confirmation before sending messages, making purchases, booking services, changing privacy, sharing data, altering subscriptions, or deleting anything.

Calendar tools: create_calendar_event, reschedule_event and cancel_event change the member's own calendar; share_calendar_entry_to_feed posts an event or live room to the feed; invite_to_calendar_entry sends an invite card to a person (resolve them with resolve_recipient first). Each one acts only after the member has asked and confirmed the read-back (confirmed=true), and never for something already over. Write the post text in the member's language. Join an event with rsvp_event and a live room with join_live_room.

## Related

Related references from the manual front matter: [].
