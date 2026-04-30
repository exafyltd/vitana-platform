---
chapter: 1.3
screen_id: COM-MAXINA_LOGIN
title: Maxina Portal Login
tenant: maxina
module: Public
tab: Maxina Portal Login
url_path: /maxina
sidebar_path: Public — /maxina
keywords: [maxina login, maxina portal, maxina sign in, maxina signup, login, anmelden, registrieren, maxina account, maxina einlogger, maxina portal login]
related_concepts: ["0.4", "0.11"]
related_screens: [COM-CONFIRM_MAXINA, COM-INTRO, COM-AUTH]
---

## What it is

The Maxina Portal Login is the dedicated entry point for the Maxina community on Vitanaland. It is where you sign in if you already have an account, or sign up if you don't. The screen has two tabs — Sign In and Sign Up — and switches between them via a query param (`?tab=signup` or `?tab=signin`). Authenticating here scopes your session to the Maxina tenant; that is what guarantees everything you see thereafter is Maxina-branded and Maxina-curated.

After a successful sign-up, the system sends a confirmation email; clicking the link lands you on Email Confirmation (Maxina) (chapter 1.5), which finalises the account.

## Why it matters

Vitana is multi-tenant. The same platform also runs Alkalma, Earthlinks, and other communities. The /maxina URL is what makes sure you land in the right place. Members who have signed up via a different portal won't see Maxina's events, knowledge, or curated content — and Maxina members who accidentally use the wrong portal will look for their data and not find it. The Maxina-branded login is the gate.

It is also the most-likely first impression. The visual identity, the welcome copy, and the call-to-action set the tone for what people expect from the rest of the experience.

## Where to find it

Direct URL: `/maxina`. There is also `/maxina?tab=signup` to land directly on the sign-up form, and `/maxina?tab=signin` for the sign-in form. Maxina-branded marketing emails and shareable links should always point here, never to the generic `/auth` route.

## What you see on this screen

- **Maxina branding header** — logo, tagline, subtle background
- **Tab switcher** — Sign In | Sign Up, with the active tab styled
- **Email field** — required for both sign-in and sign-up
- **Password field** — required for sign-in; for sign-up the rules are shown inline (length, complexity)
- **First name / last name** (sign-up only) — used to seed the Vitana ID suggestion
- **"Remember me" checkbox** (sign-in)
- **Forgot password link** (sign-in)
- **Magic link option** — request a single-use sign-in link sent to email
- **OAuth buttons** — sign in with Google, Apple (where enabled for Maxina)
- **Submit button** — Sign In or Create Account depending on tab
- **Privacy & terms link** at the bottom
- **Switch portal hint** — small text "On the wrong portal?" with links to other tenants if you arrived by mistake

## How to use it

1. **Sign up**: open `/maxina?tab=signup`, enter email, name, password, agree to terms, submit. A confirmation email goes out.
2. Open the confirmation email and click the link — this lands you on Email Confirmation (Maxina) and activates your account.
3. **Sign in**: open `/maxina?tab=signin`, enter email + password, tap Sign In.
4. If you forgot your password, tap **Forgot password** and follow the email link to reset.
5. For passwordless sign-in: tap **Magic link**, check your email, click the link.
6. After successful sign-in, you land on Home (`/home`) and a Maxina session is established.

## Related

- See concept 0.4 for the Vitana ID, which is created right after sign-up.
- See concept 0.11 for the Maxina community context.
- COM-CONFIRM_MAXINA (1.5) — the confirmation screen reached after the email link.
- COM-INTRO (1.4) — the intro experience that runs after first sign-in.
