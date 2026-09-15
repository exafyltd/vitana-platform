variable "name_prefix" {
  description = "Prefix for every resource this module creates, e.g. \"vitana-staging\" or \"vitana-prod\". Keep staging and prod in separate applies/state (separate name_prefix + separate tfvars) — never share one User Pool across environments."
  type        = string
}

variable "region" {
  description = "AWS region. Must stay eu-central-1 — this repo's sole AWS region for every other service (CLAUDE.md §1b)."
  type        = string
  default     = "eu-central-1"
}

variable "supabase_url" {
  description = "Supabase project URL (e.g. https://inmkhvwdcuyhnxkgfvsb.supabase.co) — the GoTrue instance the User Migration Lambda's Authentication trigger verifies legacy credentials against, by calling its own password-grant endpoint (the same one services/gateway/src/routes/auth.ts already proxies to)."
  type        = string
}

variable "supabase_anon_key" {
  description = "Supabase anon/publishable key, used only for the GoTrue password-grant call the Authentication trigger makes on a user's first Cognito sign-in attempt. This is the same key already shipped to every frontend client (not a privileged secret), but is still passed as a Terraform variable rather than hardcoded so it can be rotated without a code change."
  type        = string
  sensitive   = true
}

variable "supabase_service_role_secret_arn" {
  description = "Secrets Manager ARN holding the Supabase service_role key. Used only by the ForgotPassword trigger, which has no password to verify and instead must ask GoTrue's Admin API whether a user with the given email exists at all. Deliberately a Secrets Manager ARN, not the key itself — the service_role key bypasses RLS entirely and must never appear as a plain Terraform variable, tfvars file, or Lambda environment variable value; the Lambda resolves it at runtime via secretsmanager:GetSecretValue, scoped to only this one secret."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default     = {}
}
