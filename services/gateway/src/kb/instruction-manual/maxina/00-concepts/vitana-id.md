---
chapter: 0.4
screen_id: null
title: Your Vitana ID
tenant: maxina
host_screens: [COM-PROFILE_EDIT, COM-PUBLIC_PROFILE, COM-SETTINGS, COM-COMMUNITY]
keywords: [vitana id, handle, username, @handle, alex3700, vitana-id, benutzername, profilname, public profile, your handle]
related_concepts: ["0.11"]
related_screens: [COM-PROFILE_EDIT, COM-PUBLIC_PROFILE]
---

## What it is

Your Vitana ID is your permanent, globally unique handle on Vitana — written like `@alex3700`. It is the single identifier other users see, the thing message recipients are addressed by, and the key that ties together your activity across screens, devices, and tenants. Once set, your Vitana ID does not change; the rest of your profile (name, avatar, bio, role) is editable, but the ID is the stable address.

## Why it matters

Names and email addresses change. Your Vitana ID doesn't. That stability is what makes things like marketplace transactions, voice intents ("send a note to @anna"), and cross-tenant reputation possible. When the Intent Engine matches you with a buyer or a coach, the match is between two Vitana IDs — not between two phone numbers that may have rotated.

It's also how the AI assistant addresses you back. The first time you authenticate, Vitana picks a handle suggestion based on your name; you can claim it, edit the handle suffix, or pick a different one before it locks in.

## Where to find it

- **Settings → Profile / Tenant & Role** — your handle is displayed at the top of your profile card
- **Profile Edit (`/profile/edit`)** — the place to claim or change a handle (subject to availability and one-rename window)
- **Public Profile (`/u/:username`)** — the public page anyone can land on by typing your handle, e.g. `vitanaland.com/u/alex3700`

Direct URL for your own profile editor: `/profile/edit`.

## How to use it

1. Open Profile Edit. The first time you see this screen, Vitana suggests a handle — usually `firstname` plus a 3-4 digit suffix.
2. Edit the handle if you want something more memorable. Letters, numbers, and underscores only; no spaces.
3. Vitana checks availability live as you type. Green check = available, red X = taken.
4. Tap **Claim** to lock in. Once locked, you have a single rename window (typically 30 days) before the handle becomes immutable.
5. After claiming, your public profile lives at `/u/<your-handle>` and other users can address you in voice and chat as `@<your-handle>`.

## Related

- See concept 0.11 for how your Vitana ID relates to your tenant (Maxina) and your role (community).
- Profile Edit (chapter 12.4) and Public Profile (chapter 12.5) are the screen-level documentation.
