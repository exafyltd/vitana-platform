---
chapter: 13.1
screen_id: COM-ORB_OVERLAY
title: VITANA Orb Overlay
tenant: maxina
module: Overlays
tab: VITANA Orb Overlay
url_path: (global overlay)
sidebar_path: Overlays — VITANA Orb (opens over any screen)
keywords: [orb overlay, vitana orb, voice button, orb sphere, microphone, orb floating, orb voice button, sprachsphäre, mikrofon, voice mode]
related_concepts: ["0.5"]
related_screens: [COM-ASSISTANT_CHAT, COM-DIARY]
---

## What it is

The VITANA Orb Overlay is the floating sphere you see at the bottom-right of every Maxina screen. It is the visual handle for ORB voice — tap it to start a session, tap again to stop. The sphere pulses softly when it is listening, animates more vividly when it is speaking, and shows a subtle ring when it is processing. It is the single, consistent entry point for voice across the entire app.

The overlay sits above the page content (z-index high enough to never get covered) and is draggable on touch devices so you can move it out of the way of whatever you are reading.

## Why it matters

Voice is Vitana's core interaction model — the thing that makes "infinite memory" feel natural and "every screen has a teacher" feel real. The Orb Overlay is what makes voice always-available. Without a persistent overlay, you'd have to navigate to a dedicated voice screen, breaking flow. With it, voice is one tap away from any context — including mid-Diary, mid-purchase, or mid-conversation.

The overlay is also the visible signal that ORB is *listening* (or not). If the sphere is dark, ORB is not active; if it is pulsing, audio is flowing; if it has a red ring, microphone access is blocked.

## Where to find it

It is a global overlay — it appears on every screen except the few that intentionally hide it (e.g. Live Rooms, where the room's own audio takes precedence). There is no URL; you do not navigate to it. To suppress it temporarily, drag it to the corner; to turn it off entirely, use Settings → Preferences → Voice.

## What you see on this screen

- **The Orb sphere** — a circular animated element, ~64px on desktop, ~56px on mobile
- **Pulse animation** when listening
- **Speech animation** (more vivid colour transitions) when ORB is talking
- **Processing ring** (a thin spinner) when ORB is generating a reply
- **Red microphone-blocked ring** when browser mic permission is denied
- **Drag handle** behaviour — touch and hold to drag to a different corner
- **Optional caption bubble** (when enabled in Settings) — shows the live transcript next to the sphere
- **Mute toggle** — long-press the sphere to mute the mic without ending the session

## How to use it

1. Tap the sphere once to start a session. The pulse animation confirms the mic is open.
2. Speak in natural language — English or German. Don't preface ("hey Vitana" is unnecessary); just talk.
3. Wait briefly; ORB streams its reply by voice.
4. To interrupt mid-reply, just talk over it — barge-in is supported.
5. To end the session, tap the sphere again or stop talking for ~5 seconds.
6. To move the sphere: drag it (touch) or right-click drag (desktop).
7. If the sphere has a red ring: open the browser permissions and grant microphone access; reload.
8. To disable the overlay entirely: Settings → Preferences → Voice → toggle off. You can re-enable it anytime; the chat surface at `/assistant` remains available regardless.

## Related

- See concept 0.5 for ORB itself — what it can do, how memory and persona work.
- COM-ASSISTANT_CHAT (12.1) — the typed-conversation alternative.
- COM-DIARY (10.3) — uses a dedicated Diary Orb (a separate sphere) for capture.
