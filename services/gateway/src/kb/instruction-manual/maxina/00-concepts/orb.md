---
chapter: 0.5
screen_id: null
title: ORB — your AI voice assistant
tenant: maxina
host_screens: [COM-ORB_OVERLAY, COM-ASSISTANT_CHAT]
keywords: [orb, vitana orb, voice assistant, voice, ki sprachassistent, sprachassistent, vitana ai, voice mode, talk to vitana, mit vitana sprechen, mikrofon]
related_concepts: ["0.6", "0.9"]
related_screens: [COM-ORB_OVERLAY, COM-ASSISTANT_CHAT]
---

## What it is

ORB is the floating sphere you see at the bottom-right of every screen. Tap it, and Vitana listens. It is a voice-first AI assistant that runs on Gemini Live, hears you in real time, can answer questions, log to your Diary, set reminders, navigate to screens, send messages on your behalf, and explain what anything in the system means. ORB is multimodal — it sees the screen you're on, knows your Index, your Compass, your recent activity, and the people and places you've talked to it about.

The same ORB is also available as a chat surface (typing instead of speaking) at `/assistant`. Voice and chat share memory; what you tell one, the other knows next time.

## Why it matters

Vitana's whole design assumes the friction of typing is the enemy of habit. A glass of water you have to type into a form is a glass of water you don't log. A meeting with Anna you have to find a screen for is a meeting you forget. ORB collapses every interaction into "say it." The system handles routing, parsing, and storage.

ORB is also the teacher. When you ask "what is X?" or "how does X work?", ORB consults the Maxina Instruction Manual (this document set) and explains the feature in five sections: what it is, why it matters, where to find it, what's on the screen, and how to use it. After it explains, you can say "take me there" and ORB navigates.

## Where to find it

- **Floating sphere (bottom-right of every screen)** — the persistent ORB overlay (`COM-ORB_OVERLAY`)
- **AI Assistant chat (`/assistant`)** — the typed-conversation alternative
- **Diary screens** — the dedicated diary-orb captures voice memories with one tap

Direct URL for the chat surface: `/assistant`.

## How to use it

1. Tap the ORB sphere. The microphone activates and the sphere pulses to show it's listening.
2. Speak in natural language. English or German both work; Vitana picks up the language from your first sentence.
3. Wait for a brief moment — ORB replies with voice. If your question has a multi-step answer, ORB streams it sentence by sentence so you can interrupt at any time.
4. To stop speaking mid-reply, just talk over it. ORB respects barge-in.
5. If ORB's reply ends with an offer ("Want me to open Diary for you?"), say yes/no/later. Confirming triggers the action.
6. To end the session, tap the sphere again or stop speaking for a few seconds.

## Related

- See concept 0.6 for the Autopilot, which is what ORB activates when you say "yes" to a recommendation.
- See concept 0.9 for Memory — what ORB remembers about you.
- ORB Overlay (chapter 13.1) is the screen-level documentation.
