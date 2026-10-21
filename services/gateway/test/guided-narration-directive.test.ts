/**
 * buildGuidedNarrationDirective — pins the language behaviour of the
 * narrate_guided_session tool's spoken directive.
 *
 * Regression (BOOTSTRAP-ORB-GUIDE-MODE-LANG): the guided-session voice scripts
 * are authored in German, and the tool told the live model to "speak it word for
 * word". For an English (or any non-German) user that flipped the whole session
 * into German the moment narration started ("let's continue" → German). The
 * directive must now tell the model to TRANSLATE for non-German users, while
 * keeping verbatim for German users.
 */

process.env.NODE_ENV = 'test';

import { buildGuidedNarrationDirective } from '../src/services/orb-tools-shared';

const SCRIPT = 'Willkommen zu deiner heutigen Sitzung über Schlaf und Regeneration.';

describe('buildGuidedNarrationDirective', () => {
  it('German user → speak the German script verbatim', () => {
    const d = buildGuidedNarrationDirective(SCRIPT, 'de');
    expect(d).toMatch(/word for word/i);
    expect(d).toContain(SCRIPT);
    expect(d).not.toMatch(/translate/i);
  });

  it('defaults to German verbatim when lang is absent (preserves prior behaviour)', () => {
    for (const lang of [null, undefined, '']) {
      const d = buildGuidedNarrationDirective(SCRIPT, lang as any);
      expect(d).toMatch(/word for word/i);
      expect(d).not.toMatch(/translate/i);
    }
  });

  it('REGRESSION: English user → translate the German script into English, never speak German', () => {
    const d = buildGuidedNarrationDirective(SCRIPT, 'en');
    expect(d).toMatch(/translate/i);
    expect(d).toMatch(/SPOKEN IN English/);
    expect(d).toMatch(/do NOT speak any German/i);
    expect(d).not.toMatch(/word for word/i);
    expect(d).toContain(SCRIPT); // the source script is still included for the model to translate from
  });

  it('names the concrete target language for other non-German locales', () => {
    expect(buildGuidedNarrationDirective(SCRIPT, 'es')).toMatch(/SPOKEN IN Spanish/);
    expect(buildGuidedNarrationDirective(SCRIPT, 'sr')).toMatch(/SPOKEN IN Serbian/);
    expect(buildGuidedNarrationDirective(SCRIPT, 'en-US')).toMatch(/SPOKEN IN English/);
    expect(buildGuidedNarrationDirective(SCRIPT, 'de-AT')).toMatch(/word for word/i); // de-* stays verbatim
  });
});
