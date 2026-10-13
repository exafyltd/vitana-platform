# Switching phone verification on (VTID-05095 / VTID-05127)

Phone verification ships **off** in staging and production. These are the
owner's steps, in order. Claude Code sessions cannot do 1–3 (no IAM / Secrets
Manager / support-case rights).

1. **Provision** (AWS CloudShell, admin credentials, account 472838866351,
   eu-central-1):

   ```bash
   scripts/aws/setup-phone-verify-sms.sh --env prod                       # dry run: prints the IAM policy
   scripts/aws/setup-phone-verify-sms.sh --env prod --apply \
     --monthly-limit-usd 50 --sender-id Vitana
   ```

   Creates `vitana/gateway/prod/phone-verify-hmac`, puts the inline policy
   `vitana-phone-verify-sms-VTID-05127` (`sms-voice:SendTextMessage`) on
   `vitana-ecs-task-role`, sets the monthly SMS spend limit (account-wide) and
   requests the sender ID for DE/AT/CH. Safe to re-run. Optional for staging:
   `--env staging --apply` — the next staging deploy then switches staging on
   by itself (the staging secret's presence is the switch). Do not delete a
   staging secret to switch staging off; ask for an off-switch change instead.

2. **Leave the SMS sandbox**: AWS Support → "Service limit increase" →
   End User Messaging SMS → production access, region eu-central-1, use case
   "one-time verification codes for members of our app, DE/AT/CH, about
   200/day". Until then codes reach only verified destination numbers.

3. **Check**: `scripts/aws/setup-phone-verify-sms.sh --env prod status`
   must show `SMS account tier: PRODUCTION`, the secret present, the policy
   present, and prints the secret ARN.

4. **Set two repository variables** (GitHub → exafyltd/vitana-platform →
   Settings → Secrets and variables → Actions → Variables):
   - `PHONE_VERIFY_HMAC_SECRET_PROD_ARN` = the ARN from step 3
   - `PHONE_VERIFY_PROD_ENABLED` = `true`

5. **Publish**: the next production gateway deploy (PUBLISH, or an
   `env-only` dispatch of AWS-PROD-DEPLOY-GATEWAY.yml) wires the secret and
   sets `PHONE_VERIFY_ENABLED=true`. Its log says
   `Phone verification: PHONE_VERIFY_ENABLED=true, secret wired`.
   Then verify your own number in the app (Settings → Privacy).

6. **What's New**: tell Claude; it opens the What's New PR (vitana-v1
   `src/whats-new/entries/`) — a card only once the feature is really on.

**Off-switch**: set `PHONE_VERIFY_PROD_ENABLED` to anything but `true` and
publish, or dispatch with `env_overrides` `{"PHONE_VERIFY_ENABLED":"false"}`.
`PHONE_VERIFY_PROD_ENABLED=true` with an empty ARN fails the deploy on
purpose (the feature would answer 503 on every route).
