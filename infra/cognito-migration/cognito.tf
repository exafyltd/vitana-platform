# AWS Cognito User Pool for the Supabase Auth (GoTrue) → Cognito migration
# (VTID-03827, following the platform-owner decision recorded in
# docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md's "Option B / B4 — Identity"
# section, deadline 20 September 2026).
#
# Migration strategy: LAZY, per-user, via the User Migration Lambda trigger
# wired below (lambda.tf). Cognito's bulk CSV CreateUserImportJob does NOT
# accept bcrypt password hashes directly — the only way to move 209 real
# users off Supabase Auth without forcing every one of them to reset their
# password is to let Cognito call this Lambda the first time each user
# actually tries to sign in (or use Forgot Password), verify their old
# credential against GoTrue right then, and let Cognito silently create the
# account at that moment. There is no bulk-import shortcut for this case.

resource "aws_cognito_user_pool" "vitana" {
  name = "${var.name_prefix}-user-pool"

  # Users sign in with email today (Supabase Auth, email/password) — keep
  # that unchanged so the frontend rewrite doesn't also have to teach users
  # a new username.
  username_attributes     = ["email"]
  auto_verified_attributes = ["email"]

  # Matches Supabase Auth's default password policy shape closely enough
  # that an existing valid password won't suddenly be rejected on the
  # Cognito side after a successful legacy-credential verification.
  password_policy {
    minimum_length                  = 8
    require_lowercase               = true
    require_numbers                 = true
    require_symbols                 = false
    require_uppercase               = true
    temporary_password_validity_days = 7
  }

  # The whole point of this User Pool: route both first-sign-in and
  # forgot-password through the legacy-verification Lambda instead of
  # requiring a bulk import or a forced reset for all 209 users.
  lambda_config {
    user_migration = aws_lambda_function.user_migration.arn
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    mutable             = true
    required            = true
    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  # VTID-03827: carries the ORIGINAL Supabase auth.users.id through to every
  # token this pool issues (as the custom:legacy_user_id claim). Cognito
  # assigns its own random `sub` per user, but every FK, RLS policy, and
  # app_users/user_tenants row in this platform is keyed on the Supabase
  # user id — without this attribute, a migrated user's Cognito identity
  # would be unlinkable from all of their existing data. Populated once, at
  # migration time, by lambda/index.js; immutable afterward — nothing should
  # ever need to change a user's legacy id post-migration.
  schema {
    name                     = "legacy_user_id"
    attribute_data_type     = "String"
    mutable                  = false
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    # Only the migration Lambda (and, later, an explicit admin action)
    # creates users — no public self-registration through this pool while
    # the migration is in flight, to avoid a genuinely-new signup racing a
    # not-yet-migrated legacy account for the same email.
    allow_admin_create_user_only = true
  }

  tags = var.tags
}

resource "aws_cognito_user_pool_client" "vitana" {
  name         = "${var.name_prefix}-app-client"
  user_pool_id = aws_cognito_user_pool.vitana.id

  # No client secret — this is consumed by public clients (the SPA in
  # exafyltd/vitana-v1) and by the gateway's own server-side token
  # exchange, mirroring how the existing Supabase anon-key model works.
  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH", # required for the migration trigger to ever fire
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Don't leak whether an email exists via a different error shape —
  # matches GoTrue's own behavior, which the frontend already assumes.
  prevent_user_existence_errors = "ENABLED"

  # custom:legacy_user_id MUST be explicitly listed here to appear in the ID
  # token this client receives — it's how the gateway's Cognito JWT
  # verification path (services/gateway/src/middleware/auth-supabase-jwt.ts,
  # extractCognitoIdentity()) recovers the real Supabase user id. It's
  # deliberately absent from write_attributes (and couldn't be included even
  # if listed — it's `mutable = false` on the pool schema above): nothing
  # should ever let a user or client change their own legacy id.
  read_attributes  = ["email", "email_verified", "custom:legacy_user_id"]
  write_attributes = ["email"]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
