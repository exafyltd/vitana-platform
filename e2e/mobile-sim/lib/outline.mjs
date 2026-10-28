/**
 * Parsers for the sim-use text outline — the stable, documented surface:
 *
 *   App: Safari  402x874
 *   [Top  y<120]
 *     @1  StaticText  "Vitana"
 *   [Content  y=120..754]
 *     @5  TextField  "E-Mail"
 *   [Bottom  y>754]
 *     @43 TabBar
 *     @44 Button  "Startseite"
 *
 * We parse this text rather than the --json envelope for flow logic: the
 * outline format is documented and versioned in the sim-use README, while
 * envelope field shapes are easier to get subtly wrong. The raw envelope is
 * still captured to artifacts for diagnostics (see flows/smoke.mjs).
 */

const ENTRY_RE = /^\s*@(\d+)\s+(?:#\S+\s+)?([A-Za-z]\w*)(?:\s+"(.*)")?\s*$/;

/** Parse every aliased entry line: { alias: '@N', role, label } */
export function parseEntries(outline) {
  const entries = [];
  for (const line of outline.split('\n')) {
    const m = line.match(ENTRY_RE);
    if (m) entries.push({ alias: `@${m[1]}`, role: m[2], label: m[3] ?? '' });
  }
  return entries;
}

/** Entries inside a named region band, e.g. section(outline, 'Bottom'). */
export function sectionEntries(outline, sectionName) {
  const lines = outline.split('\n');
  const start = lines.findIndex(l => new RegExp(`^\\[${sectionName}\\b`).test(l.trim()));
  if (start === -1) return [];
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i].trim())) break;
    const m = lines[i].match(ENTRY_RE);
    if (m) entries.push({ alias: `@${m[1]}`, role: m[2], label: m[3] ?? '' });
  }
  return entries;
}

/** Text-input entries anywhere on screen (login forms etc.). */
export function textFieldEntries(outline) {
  return parseEntries(outline).filter(e =>
    /TextField|TextInput|EditText|SecureField|TextArea/i.test(e.role),
  );
}

export function isSecureField(entry) {
  return /Secure|Password/i.test(entry.role) || /passwor|kennwort/i.test(entry.label);
}
