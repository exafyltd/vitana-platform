'use strict';

// Cognito User Migration Lambda trigger (VTID-03827).
//
// WHY THIS EXISTS: Cognito's bulk CSV CreateUserImportJob does not accept
// bcrypt password hashes, so there is no way to bulk-migrate 209 existing
// Supabase Auth (GoTrue) users without either forcing every one of them to
// reset their password, or migrating them lazily, one at a time, the first
// time they actually try to log in. This Lambda implements the lazy path:
// Cognito calls it whenever someone attempts to authenticate (or reset a
// password) with an email Cognito doesn't have a user record for yet.
//
// DELIBERATE DESIGN CHOICE — verify via GoTrue's own API, not by
// re-implementing bcrypt comparison against auth.users.encrypted_password
// directly:
//   1. It defers entirely to GoTrue's own hashing/verification/lockout
//      logic instead of duplicating it in a second codebase that could
//      silently drift (different bcrypt cost factor, different normalization
//      of the email, etc.).
//   2. It needs no direct Postgres credential in this Lambda at all for the
//      Authentication trigger — only the same Supabase anon key the
//      frontend already ships (SUPABASE_ANON_KEY), hitting the exact same
//      `/auth/v1/token?grant_type=password` endpoint
//      services/gateway/src/routes/auth.ts already proxies to.
//   3. GoTrue's rate limiting / lockout on repeated bad attempts keeps
//      working for free, instead of needing to be reimplemented here.
//
// The ForgotPassword trigger has no password to verify — it only needs to
// know whether an account with that email exists at all, which requires
// GoTrue's Admin API and the service_role key (fetched from Secrets Manager
// at runtime, never baked into a plain env var value).
//
// NOT YET EXERCISED AGAINST A LIVE TRIGGER. This has not been invoked by a
// real Cognito User Pool — this session's AWS credentials are denied all
// cognito-idp:* actions by an IAM permissions boundary (see ../README.md).
// Treat this as a reviewed but unverified first implementation; the first
// real sign-in attempt against a real pool is the actual test.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_SECRET_ARN = process.env.SUPABASE_SERVICE_ROLE_SECRET_ARN;

let cachedServiceRoleKey = null;

async function getServiceRoleKey() {
  if (cachedServiceRoleKey) return cachedServiceRoleKey;
  // Lazy import — the AWS SDK v3 client is only needed on the
  // ForgotPassword path, not on every Authentication attempt.
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: SUPABASE_SERVICE_ROLE_SECRET_ARN })
  );
  cachedServiceRoleKey = result.SecretString;
  return cachedServiceRoleKey;
}

// Verifies email+password against GoTrue's password grant. Returns the
// GoTrue user object on success, or null on any authentication failure
// (wrong password, unknown user, unconfirmed email, etc.) — the caller
// treats all of those identically, matching Cognito's own
// "don't reveal which part was wrong" posture (prevent_user_existence_errors).
async function verifyLegacyPassword(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.user || null;
}

// Looks up whether a Supabase Auth user exists for this email, via the
// Admin API (service_role only — this is the one call site in this Lambda
// that needs the privileged key, and it never sees or forwards a password).
async function lookupLegacyUserByEmail(email) {
  const serviceRoleKey = await getServiceRoleKey();
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }
  );
  if (!res.ok) return null;
  const body = await res.json();
  const users = Array.isArray(body) ? body : body.users || [];
  return users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

function buildUserAttributes(legacyUser) {
  return [
    { Name: 'email', Value: legacyUser.email },
    { Name: 'email_verified', Value: legacyUser.email_confirmed_at ? 'true' : 'false' },
    // Carries the original Supabase auth.users.id through to every token
    // Cognito issues for this user (as the custom:legacy_user_id claim) —
    // see cognito.tf's schema block and the gateway's
    // auth-supabase-jwt.ts::extractCognitoIdentity() for why this, not
    // Cognito's own freshly-assigned `sub`, is what the rest of the
    // platform must key on.
    { Name: 'custom:legacy_user_id', Value: legacyUser.id },
  ];
}

exports.handler = async (event) => {
  const email = event.userName;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Fail loudly (CLAUDE.md ALWAYS 10 / NEVER 19) rather than silently
    // rejecting every migration attempt with an opaque auth failure.
    throw new Error('user-migration Lambda misconfigured: SUPABASE_URL/SUPABASE_ANON_KEY unset');
  }

  if (event.triggerSource === 'UserMigration_Authentication') {
    const password = event.request.password;
    const legacyUser = await verifyLegacyPassword(email, password);
    if (!legacyUser) {
      // Any thrown error here becomes a generic auth failure to the caller
      // (Cognito does not leak the reason) — correct legacy credentials
      // fail identically to a nonexistent user, matching GoTrue's own
      // behavior and this pool's prevent_user_existence_errors setting.
      throw new Error('Bad credentials');
    }

    event.response.userAttributes = buildUserAttributes(legacyUser);
    event.response.finalUserStatus = 'CONFIRMED';
    event.response.messageAction = 'SUPPRESS'; // no welcome email — this user already has an account
    return event;
  }

  if (event.triggerSource === 'UserMigration_ForgotPassword') {
    const legacyUser = await lookupLegacyUserByEmail(email);
    if (!legacyUser) {
      throw new Error('Bad credentials');
    }

    event.response.userAttributes = buildUserAttributes(legacyUser);
    event.response.finalUserStatus = 'RESET_REQUIRED';
    event.response.messageAction = 'SUPPRESS';
    return event;
  }

  throw new Error(`Unsupported triggerSource: ${event.triggerSource}`);
};
