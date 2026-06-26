/**
 * NAV_GUIDED_JOURNEY — "My Journey has two views" knowledge block.
 *
 * Teaches Vitana the DECLARATIVE distinction between the two presentations of
 * the user's longevity journey (the /autopilot "My Journey" screen):
 *   • GUIDED JOURNEY  — German "Einführung" / "geführte Journey"
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

=== MY JOURNEY — ZWEI ANSICHTEN (Geführt vs. Vollversion) ===
Die "Longevity Journey" des Nutzers (der Bildschirm "My Journey" / Autopilot)
kann in ZWEI Ansichten angezeigt werden. Es ist DIESELBE Journey in zwei
Darstellungen — KEINE zwei verschiedenen Funktionen. Der Nutzer kann jederzeit
zwischen ihnen wechseln:
  • GEFÜHRTE JOURNEY ("Einführung") — die Schritt-für-Schritt geführte Ansicht,
    die den Nutzer durch EINEN fokussierten Schritt nach dem anderen führt. Ideal
    zum Einstieg und für alle, die geführt werden möchten.
  • VOLLVERSION (die volle App) — die komplette Ansicht mit allem auf einmal
    verfügbar. Ideal für erfahrene Nutzer, die volle Kontrolle wollen.
Gewechselt wird über den Einführung/Vollversion-Umschalter oben auf dem
My-Journey-Bildschirm — ODER indem der Nutzer dich einfach bittet ("wechsle zur
geführten Journey", "zeig mir die Vollversion"); dann navigierst du und die
Ansicht klappt um.
WENN DER NUTZER NACH DEM UNTERSCHIED FRAGT ("was ist der Unterschied zwischen
geführter Journey und Vollversion?"), ERKLÄRE ihn mit den obigen Punkten in
seiner Sprache. Sage NIEMALS, dass du den Unterschied nicht kennst.`;
  }
  return `

=== MY JOURNEY — TWO VIEWS (Guided vs Full App) ===
The user's longevity journey (the "My Journey" / Autopilot screen) can be shown
in TWO views. It is the SAME journey in two presentations — NOT two different
features. The user can switch between them at any time:
  • GUIDED JOURNEY (German: "Einführung" / "geführte Journey") — the
    step-by-step guided view that walks the user through ONE focused move at a
    time. Best for getting started and for anyone who wants to be led.
  • FULL APP (German: "Vollversion") — the complete view with everything
    available at once. Best for established users who want full control.
Switching is done with the Einführung/Vollversion toggle at the top of the
My Journey screen — OR by the user simply asking you ("switch me to the guided
journey", "show me the full version"); you then navigate and the view flips.
WHEN THE USER ASKS WHAT THE DIFFERENCE IS ("what's the difference between the
guided journey and the full app?"), EXPLAIN it in their language using the
points above. NEVER say you don't know the difference.`;
}
