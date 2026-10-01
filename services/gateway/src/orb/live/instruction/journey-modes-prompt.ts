/**
 * NAV_GUIDED_JOURNEY — "My Journey has two views" knowledge block.
 *
 * Teaches Vitana the DECLARATIVE distinction between the two presentations of
 * the user's longevity journey (the /autopilot "My Journey" screen):
 *   • AUDIOBOOK (the guided journey) — German "Hörbuch" (VTID-04760; was
 *     "Einführung" / "geführte Journey")
 *   • FULL APP        — German "Vollversion"
 *
 * Why this exists: the guided-journey *content* system (narrate_guided_session,
 * journey-guide openers, 254 topics) teaches Vitana how to RUN the journey, but
 * nothing told it WHAT the two views are. So on a plain "what's the difference
 * between the guided journey and the full app?" Vitana had no answer — it could
 * switch modes (via the navigate tool's MODE_SWITCH hint) but couldn't explain
 * the distinction in open conversation. This block fills that gap.
 *
 * Injected for the whole session, gated by NAV_GUIDED_JOURNEY (same flag that
 * powers the navigate-path mode switch), so knowledge and capability stay in
 * lockstep. English block for EN sessions, German for DE (the user base) — the
 * German labels Einführung/Vollversion appear in BOTH because they are the
 * exact words the UI toggle and the user use.
 */
export function buildJourneyModesSection(lang: string): string {
  const isDe = lang.startsWith('de');
  if (isDe) {
    return `

=== MY JOURNEY — ZWEI ANSICHTEN (Hörbuch vs. Vollversion) ===
Die "Longevity Journey" des Nutzers (der Bildschirm "My Journey" / Autopilot)
kann in ZWEI Ansichten angezeigt werden. Es ist DIESELBE Journey in zwei
Darstellungen — KEINE zwei verschiedenen Funktionen. Der Nutzer kann jederzeit
zwischen ihnen wechseln:
  • HÖRBUCH (die GEFÜHRTE JOURNEY, früher "Einführung") — kurze Folgen, in
    denen du Schritt für Schritt erklärst, wie Maxina hilft. Der Nutzer muss
    nur zuhören; er drückt einmal auf Abspielen und die Folgen laufen
    nacheinander. Ideal zum Einstieg und für alle, die lieber zuhören.
  • VOLLVERSION (die volle App) — die komplette Ansicht mit allem auf einmal
    verfügbar. Ideal für erfahrene Nutzer, die volle Kontrolle wollen.
Gewechselt wird über den Hörbuch/Vollversion-Umschalter oben auf dem
My-Journey-Bildschirm — ODER indem der Nutzer dich einfach bittet ("öffne mein
Hörbuch", "zeig mir die Vollversion"); dann navigierst du und die Ansicht
klappt um. Nennt der Nutzer noch "Einführung" oder "geführte Journey", meint er
das Hörbuch.
WENN DER NUTZER NACH DEM UNTERSCHIED FRAGT ("was ist der Unterschied zwischen
Hörbuch und Vollversion?"), ERKLÄRE ihn mit den obigen Punkten in seiner
Sprache. Sage NIEMALS, dass du den Unterschied nicht kennst.`;
  }
  return `

=== MY JOURNEY — TWO VIEWS (Audiobook vs Full App) ===
The user's longevity journey (the "My Journey" / Autopilot screen) can be shown
in TWO views. It is the SAME journey in two presentations — NOT two different
features. The user can switch between them at any time:
  • AUDIOBOOK (the GUIDED JOURNEY; German: "Hörbuch", formerly "Einführung") —
    short episodes in which you explain, step by step, how Maxina helps. The
    user only has to listen: one press of play and the episodes run one after
    another. Best for getting started and for anyone who prefers to listen.
  • FULL APP (German: "Vollversion") — the complete view with everything
    available at once. Best for established users who want full control.
Switching is done with the Hörbuch/Vollversion (Audiobook/Full App) toggle at
the top of the My Journey screen — OR by the user simply asking you ("open my
audiobook", "show me the full version"); you then navigate and the view flips.
A user who still says "guided journey" or "Einführung" means the Audiobook.
WHEN THE USER ASKS WHAT THE DIFFERENCE IS ("what's the difference between the
audiobook and the full app?"), EXPLAIN it in their language using the points
above. NEVER say you don't know the difference.`;
}

/**
 * VTID-04578 — remove every copy of the two-views block (either language) from
 * a text. The voice brain context embeds the block (vitana-brain.ts) and the
 * voice instruction builder appends it again to the scaffold; the builder
 * strips the brain's copy so the block is sent once. Exact-string removal: any
 * text around the block is left untouched.
 */
export function stripJourneyModesCopies(text: string): string {
  let out = text;
  for (const lang of ['de', 'en']) {
    const block = buildJourneyModesSection(lang);
    if (out.includes(block)) out = out.split(block).join('');
  }
  return out;
}
