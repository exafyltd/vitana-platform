---
chapter: 0.9
screen_id: null
title: Memory — what Vitana remembers about you
tenant: maxina
host_screens: [COM-MEMORY, COM-TIMELINE, COM-DIARY, COM-MEMORY_RECALL, COM-MEMORY_PERMISSIONS]
keywords: [memory, infinite memory, vitana memory, what vitana knows, recall, gedächtnis, erinnerungen, was weiss vitana, memory garden, persistent memory]
related_concepts: ["0.5", "0.10"]
related_screens: [COM-MEMORY, COM-TIMELINE, COM-DIARY, COM-MEMORY_RECALL]
---

## What it is

Memory is the persistent record of everything you've shared with Vitana — directly via the Diary, indirectly via what you've said to ORB, and through trackers and apps you've connected. It is organised into categories (personal identity, health, relationships, learning, business, finance, location, digital, values, autopilot, future plans) and a single chronological timeline. Vitana uses memory to ground every answer it gives — when you ask "what did I do last Tuesday?" or "remind me of that supplement Anna recommended", the recall comes from here.

Memory is **not** a chat log. It's structured: facts (your birthday, your fiancée's name, your active goal) live in a fact store with provenance and confidence; events (sleep last night, hydration today, who you met at brunch) live in the timeline; relationships (who knows whom) live in a graph.

## Why it matters

The single biggest difference between Vitana and a generic chatbot is memory. Vitana remembers across sessions, across devices, across months. The promise is that you say something once and it sticks — your trainer's name, your sleep target, the exact note you took on Sunday. Without memory, every conversation starts cold. With memory, conversations build.

Memory is also the substrate that the Autopilot, Recommendations, Did You Know tour, and Daily Summary all read from. The richer your memory, the smarter every other surface becomes.

## Where to find it

- **Memory → Memory Overview (`/memory`)** — the dashboard with "What Vitana Knows" widget and category grid
- **Memory → Timeline (`/memory/timeline`)** — chronological view of events
- **Memory → Diary (`/memory/diary`)** — where you add new memories
- **Memory → Recall (`/memory/recall`)** — the AI-powered search surface
- **Memory → Permissions (`/memory/permissions`)** — what you allow Vitana to remember and share

## How to use it

1. Open Memory Overview. The "What Vitana Knows" widget gives you a quick read-back of the high-level facts Vitana has on file.
2. Scroll through the category grid to see what's been captured under each domain (Health, Relationships, Career, etc.).
3. To add a new memory: open Diary and dictate, or use ORB voice on any screen ("remember that I prefer late-afternoon runs").
4. To search: open Recall, type a question, and Vitana surfaces matching memories with the original date and context.
5. To control what Vitana remembers: open Permissions and toggle categories on/off. Disabling a category stops new captures *and* hides existing memories from retrieval (they aren't deleted; they're paused).
6. To delete a specific memory: tap it on the Timeline → three-dot menu → Forget. Vitana removes it from active retrieval and audits the deletion.

## Related

- See concept 0.5 for ORB, the primary capture surface.
- See concept 0.10 for permissions, which gate what Vitana can remember.
- Memory Overview (chapter 10.1) is the screen-level documentation.
