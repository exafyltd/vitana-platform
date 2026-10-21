/**
 * VTID-04749: a correction is a save. Production live-11ec418b (2026-09-29):
 * the member asked Vitana to correct the company name to "Exify" with its seat
 * in Abu Dhabi; she answered "ich korrigiere den Namen deiner Firma. Deine
 * Firma heißt jetzt Exify …", called no tool, and "Exafile Limited" stayed.
 * Neither the request nor the claim was recognised, so the backstop never ran.
 */
import { detectRememberClaim, detectRememberIntent } from '../../../src/services/memory/remember-backstop';

describe('VTID-04749: correction requests and claims', () => {
  it.each([
    'nee warte warte nein ich möchte dass du den namen meiner firma korrigierst',
    'bitte ändere den Namen meiner Firma auf Exify',
    'aktualisiere bitte meinen Wohnort',
    'please update the name of my company',
  ])('request: %s', (t) => expect(detectRememberIntent(t)).toBe(true));

  it.each([
    'Alles klar, ich korrigiere den Namen deiner Firma. Deine Firma heißt jetzt Exify.',
    'Ich habe den Namen deiner Firma auf Exify geändert.',
    "I've updated your company name to Exify.",
  ])('claim: %s', (t) => expect(detectRememberClaim(t)).toBe(true));

  it.each([
    'Soll ich den Namen deiner Firma korrigieren?',
    'Ich habe den Namen nicht geändert.',
    'Kannst du mich korrigieren, wenn ich falsch liege?',
  ])('not a claim: %s', (t) => expect(detectRememberClaim(t)).toBe(false));

  it('ordinary talk is no request', () => {
    expect(detectRememberIntent('Ich ändere gerade meine Ernährung')).toBe(false);
  });
});
