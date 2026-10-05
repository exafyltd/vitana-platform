# Google sign-in on ECS through the task role (VTID-04893)

Phase 0 of the sparred Audiobook voice plan (`plan-sparring.md`). The gateway's
Workload Identity config reads AWS credentials from the EC2 instance metadata
endpoint, which ECS Fargate does not serve, so every Google token request fails.
CloudWatch: the bridge's own token prewarm fails on staging (`/vitana/gateway`,
2026-10-02 09:32 and 10:18 UTC) and production (`/vitana/gateway-awsdr`,
2026-09-28 16:23 UTC) with `connect EINVAL`.

AC-1: A shared module supplies the AWS region and credentials to google-auth-library programmatically (AwsSecurityCredentialsSupplier on the AWS SDK default provider chain), replacing the config's credential source and keeping its audience, token URL and impersonation.
TEST: services/gateway/test/vtid-04893-google-aws-supplier.test.ts

AC-2: The signed AWS request is built from the supplier's credentials with no network call to a metadata endpoint.
TEST: services/gateway/test/vtid-04893-google-aws-supplier.test.ts ("signs the AWS request from the supplier, with no metadata call")

AC-3: orb-live uses the module only when GOOGLE_AUTH_AWS_SUPPLIER_ENABLED is exactly true; otherwise the existing GoogleAuth path runs unchanged. The flag is registered for the voice-flag tooling, pinned on in staging only.
TEST: services/gateway/test/vtid-04893-google-aws-supplier.test.ts ("wiring")
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-4: The staging deploy step stays under GitHub's 20,000-character run-step limit.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Live proof (2026-10-05, from this Claude Code session)

With the `claude-code-aws-agent` IAM user's keys and the staging `GCP_CRED_CONFIG`, the module obtained a Google access token on the first call, and `texttospeech.googleapis.com/v1/voices` answered for `ru-RU` (10 female voices, 4 Chirp 3 HD) and `sr-RS` (15 female voices, 14 Chirp 3 HD). So the token exchange and the Text-to-Speech API both work. On ECS the Google side must additionally trust the task role (owner-side binding by `aws_role` attribute).

## Routes

No route added or changed.

## OASIS

No new OASIS event.
