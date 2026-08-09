// VTID-03486 — unit tests for the migration-drift SQL parser.
//
// The parser decides what the repo *claims* should exist in the database. If it
// over-matches, the check emits false failures and gets disabled; if it
// under-matches, it misses the VTID-03480 bug it exists to catch. Both failure
// modes are worse than having no check, so the parsing rules are pinned here.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseMigrationSql, stripSqlComments } = require('../../../../scripts/ci/check-migration-drift.cjs');

describe('stripSqlComments', () => {
  it('removes line comments', () => {
    expect(stripSqlComments('CREATE TABLE a (); -- CREATE TABLE b ()')).not.toMatch(/\bb\b/);
  });

  it('removes block comments', () => {
    expect(stripSqlComments('/* CREATE TABLE b (); */ CREATE TABLE a ();')).not.toMatch(/\bb\b/);
  });
});

describe('parseMigrationSql — declarations', () => {
  it('finds a plain CREATE TABLE', () => {
    const { created } = parseMigrationSql('CREATE TABLE orb_session_state (id uuid);');
    expect([...created]).toEqual(['orb_session_state']);
  });

  it('finds IF NOT EXISTS and public-qualified forms', () => {
    const { created } = parseMigrationSql(
      'CREATE TABLE IF NOT EXISTS public.memory_facts (id uuid); CREATE TABLE public.memory_items (id uuid);',
    );
    expect([...created].sort()).toEqual(['memory_facts', 'memory_items']);
  });

  it('lowercases and unquotes identifiers', () => {
    const { created } = parseMigrationSql('CREATE TABLE "Mixed_Case" (id uuid);');
    expect([...created]).toEqual(['mixed_case']);
  });

  it('ignores non-public schemas', () => {
    const { created } = parseMigrationSql('CREATE TABLE auth.sessions (id uuid);');
    expect([...created]).toEqual([]);
  });

  it('does not match "create table" inside prose or mid-statement', () => {
    // This is the over-match that produced junk entries like "against", "foo",
    // "to" and "rolled" on the first pass — anchoring to a statement boundary
    // is what fixed it.
    const { created } = parseMigrationSql(
      "COMMENT ON TABLE x IS 'we create table against the old one';",
    );
    expect([...created]).toEqual([]);
  });

  it('ignores commented-out DDL', () => {
    const { created } = parseMigrationSql('-- CREATE TABLE ghost (id uuid);\nCREATE TABLE real (id uuid);');
    expect([...created]).toEqual(['real']);
  });
});

describe('parseMigrationSql — removals', () => {
  it('records DROP TABLE', () => {
    const { dropped } = parseMigrationSql('DROP TABLE IF EXISTS stale_table;');
    expect([...dropped]).toEqual(['stale_table']);
  });

  it('treats a rename as dropping the old name and creating the new', () => {
    const { created, dropped } = parseMigrationSql('ALTER TABLE old_name RENAME TO new_name;');
    expect([...dropped]).toEqual(['old_name']);
    expect([...created]).toEqual(['new_name']);
  });
});
