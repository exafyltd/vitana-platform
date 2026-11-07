#!/bin/bash
# Nightly GitLab backup (cron 02:15 UTC) to the encrypted S3 bucket. The configuration archive holds
# gitlab-secrets.json, which a restore needs.
set -euo pipefail
. /etc/vitana/env
export AWS_DEFAULT_REGION="$REGION" HOME=/root
echo "== backup start $(date -u +%FT%TZ)"
gitlab-backup create CRON=1 STRATEGY=copy
latest="$(ls -1t /var/opt/gitlab/backups/*_gitlab_backup.tar | head -1)"
aws s3 cp "$latest" "s3://$BACKUP_BUCKET/backups/$(basename "$latest")"
d="$(date -u +%F)"
tar -czf "/tmp/gitlab-config-$d.tgz" -C / etc/gitlab
aws s3 cp "/tmp/gitlab-config-$d.tgz" "s3://$BACKUP_BUCKET/config/gitlab-config-$d.tgz"
rm -f "/tmp/gitlab-config-$d.tgz"
echo "== backup done $(date -u +%FT%TZ): $(basename "$latest")"
