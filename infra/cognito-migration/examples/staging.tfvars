# Example only — copy to a non-committed staging.auto.tfvars (or pass
# -var-file) and fill in real values. Never commit real secret ARNs/keys
# alongside this example file.

name_prefix = "vitana-staging"
region      = "eu-central-1"

supabase_url      = "https://inmkhvwdcuyhnxkgfvsb.supabase.co"
supabase_anon_key = "REPLACE_ME" # same anon key AWS-STAGE-DEPLOY-GATEWAY.yml's task def already carries

# Provision this secret first (aws secretsmanager create-secret), then
# paste its ARN here — never the raw service_role key.
supabase_service_role_secret_arn = "arn:aws:secretsmanager:eu-central-1:472838866351:secret:REPLACE_ME"

tags = {
  Environment = "staging"
  Project     = "vitana-auth-cognito-migration"
  Vtid        = "VTID-03827"
}
