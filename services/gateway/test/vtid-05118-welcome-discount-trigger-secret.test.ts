/**
 * VTID-05118 — notify_welcome_discount() read the vault names supabase_url and
 * service_role_key, which do not exist, so every welcome-discount post had a
 * NULL URL and was swallowed as a WARNING. The migration moves it onto the
 * working email_trigger_secret pattern. Pins the parts a later edit could
 * silently break.
 */
import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20261012235118_vtid_05118_welcome_discount_trigger_secret.sql',
  ),
  'utf8',
);

// The function body between the dollar quotes.
const body = (() => {
  const open = sql.indexOf('$$');
  expect(open).toBeGreaterThan(-1);
  return sql.slice(open + 2, sql.indexOf('$$', open + 2));
})();

describe('VTID-05118: welcome-discount trigger uses the email trigger secret', () => {
  it('redefines notify_welcome_discount() only, keeping SECURITY DEFINER and search_path', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.notify_welcome_discount()');
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
    expect(sql).not.toMatch(/CREATE\s+(OR REPLACE\s+)?TRIGGER/i);
    expect(sql).not.toMatch(/DROP\s+(TRIGGER|FUNCTION)/i);
  });

  it('reads vault email_trigger_secret and sends it as X-Trigger-Secret', () => {
    expect(body).toContain("name = 'email_trigger_secret'");
    expect(body).toMatch(/'X-Trigger-Secret',\s*trigger_secret/);
  });

  it('no longer references the missing vault names or a bearer header', () => {
    expect(sql).not.toContain("'supabase_url'");
    expect(sql).not.toContain("'service_role_key'");
    expect(sql).not.toMatch(/Bearer/);
    expect(body).not.toMatch(/'Authorization'/);
  });

  it('posts to the send-welcome-discount edge function with discount_code_id only', () => {
    expect(body).toContain('/functions/v1/send-welcome-discount');
    expect(body).toMatch(/body\s*:=\s*jsonb_build_object\('discount_code_id', NEW\.id\)/);
  });

  it('skips with a WARNING and RETURN NEW when the vault secret is missing, before posting', () => {
    const guard = body.search(/IF trigger_secret IS NULL THEN\s+RAISE WARNING[\s\S]*?RETURN NEW;\s+END IF;/);
    const post = body.indexOf('net.http_post(');
    expect(guard).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(guard);
  });

  it('keeps the outer WHEN OTHERS handler so a signup is never blocked', () => {
    expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN\s+[\s\S]*?RAISE WARNING[\s\S]*?RETURN NEW;\s+END;\s*$/);
  });

  it('revokes EXECUTE from PUBLIC, anon and authenticated (VTID-05041 definer lockdown)', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.notify_welcome_discount\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });

  it('carries no secret value', () => {
    expect(sql).not.toContain('eyJ');
    expect(sql).not.toMatch(/sb_secret_/);
  });
});
