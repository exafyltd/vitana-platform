#!/bin/bash
# VTID-05555 (eng-gitlab-m1/gitlab-verify): the owner's CloudShell evidence script. Read only, except "restore",
# which starts and later removes one scratch machine exactly as RUNBOOK section 8 does.
#   bash glv.sh read      backup listing + latest GitLab main pipelines + ci-config file hashes   (2 minutes, read only)
#   bash glv.sh restore   restore test on a scratch machine, compare with live, remove the machine (30-60 minutes)
#   bash glv.sh fleet     read only: fleet runner token present?, settings sync journal, fleet manager log
#   bash glv.sh resume    after CloudShell closed during "restore": read step B from the scratch machine, run step C, remove the machine
#   bash glv.sh cleanup   remove a scratch machine left behind (if CloudShell closed during "restore")
# Each run writes ~/glv-<word>-<time>.txt. Paste that file's content back into the Kiro session.
set -uo pipefail
WORD="${1:-}"; case "$WORD" in read|fleet|restore|resume|cleanup) ;; *) echo "usage: bash glv.sh read | fleet | restore | resume | cleanup"; exit 2 ;; esac
OUTF=~/glv-$WORD-$(date -u +%Y%m%dT%H%MZ).txt
exec > >(sed -u -E 's/(glpat-|glrt-|glptt-|whsec_)[A-Za-z0-9_+\/=-]+/\1<removed>/g' | tee "$OUTF") 2>&1
echo "== glv.sh $WORD $(date -u +%FT%TZ)"

# engineering-account credentials (RUNBOOK section 2); start from CloudShell's own sign-in even if this tab holds others
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
ACCOUNT_ID=$(grep '^ACCOUNT_ID=' ~/vitana-eng/state.env | cut -d= -f2)
[ -n "$ACCOUNT_ID" ] || { echo "no ~/vitana-eng/state.env with ACCOUNT_ID"; exit 1; }
C=$(aws sts assume-role --role-arn arn:aws:iam::$ACCOUNT_ID:role/OrganizationAccountAccessRole --role-session-name vitana-eng --query Credentials --output json) || exit 1
export AWS_ACCESS_KEY_ID=$(jq -r .AccessKeyId <<<"$C") AWS_SECRET_ACCESS_KEY=$(jq -r .SecretAccessKey <<<"$C") AWS_SESSION_TOKEN=$(jq -r .SessionToken <<<"$C")
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1
BUCKET=vitana-engineering-gitlab-backups-$ACCOUNT_ID
LIVE=$(aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-gitlab Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
echo "account $ACCOUNT_ID  bucket $BUCKET  gitlab machine $LIVE"

ssm_run() {   # ssm_run <instance> <shell command> [timeout seconds]: runs it, waits, prints its output
  local cmd cid s
  cmd=$(jq -nc --arg c "$2" --arg t "${3:-600}" '{commands:[$c],executionTimeout:[$t]}')
  cid=$(aws ssm send-command --instance-ids "$1" --document-name AWS-RunShellScript --parameters "$cmd" --query Command.CommandId --output text) || return 1
  while :; do
    s=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$1" --query Status --output text 2>/dev/null)
    case "$s" in Pending|InProgress|Delayed|"") printf . >&2; sleep 10 ;; *) break ;; esac
  done
  echo >&2; echo "(ssm status: $s, command $cid)"
  aws ssm get-command-invocation --command-id "$cid" --instance-id "$1" --query StandardOutputContent --output text
  aws ssm get-command-invocation --command-id "$cid" --instance-id "$1" --query StandardErrorContent --output text | tail -5
}

if [ "$WORD" = read ]; then
  echo; echo "== A03: backup bucket (RUNBOOK section 7)"
  aws s3 ls s3://$BUCKET/backups/ --human-readable
  aws s3 ls s3://$BUCKET/config/ --human-readable

  echo; echo "== A05 + pipelines: latest main pipelines on GitLab (read only rails runner)"
  cat > /tmp/glv-read.rb <<'RB'
%w[vitana/vitana-platform vitana/vitana-v1].each do |path|
  p = Project.find_by_full_path(path)
  puts "PROJECT #{path} ci_config_path=#{p&.ci_config_path.inspect}"
  next unless p
  Ci::Pipeline.where(project_id: p.id, ref: 'main').order(id: :desc).limit(3).each do |pl|
    puts "PIPELINE #{pl.id} sha=#{pl.sha} status=#{pl.status} source=#{pl.source} created=#{pl.created_at.utc.iso8601} #{Gitlab.config.gitlab.url}/#{path}/-/pipelines/#{pl.id}"
    pl.builds.order(:id).each { |b| puts "  JOB #{b.name} status=#{b.status} duration=#{b.duration ? b.duration.round : '-'}s runner=#{b.runner&.description}" }
  end
end
cc = Project.find_by_full_path('vitana/ci-config')
puts "CI-CONFIG main=#{cc&.repository&.commit('main')&.id} at #{cc&.repository&.commit('main')&.committed_date&.utc&.iso8601}"
%w[platform.gitlab-ci.yml v1.gitlab-ci.yml].each do |f|
  blob = cc&.repository&.blob_at('main', f)
  puts "CI-CONFIG #{f} sha256=#{blob ? Digest::SHA256.hexdigest(blob.data) : 'missing'}"
end
Ci::Runner.all.each do |r|
  f = ->(&b) { begin; b.call; rescue StandardError => e; "?(#{e.class})"; end }
  puts "RUNNER id=#{r.id} #{f.call { r.description }} tags=#{f.call { r.tags.map(&:name).join(',') }} active=#{f.call { r.active }} contacted=#{f.call { r.contacted_at&.utc&.iso8601 }} online=#{f.call { r.online? }}"
end
RB
  ssm_run "$LIVE" "echo $(base64 -w0 /tmp/glv-read.rb) | base64 -d > /tmp/glv-read.rb && gitlab-rails runner /tmp/glv-read.rb 2>/tmp/glv-read.err | grep -E '^(PROJECT|PIPELINE|  JOB|CI-CONFIG|RUNNER)'; tail -3 /tmp/glv-read.err; rm -f /tmp/glv-read.rb /tmp/glv-read.err" 900
  echo; echo "== done. Paste the content of $OUTF into the Kiro session."
  exit 0
fi

if [ "$WORD" = fleet ]; then
  T=$(aws secretsmanager get-secret-value --secret-id vitana/engineering/gitlab/fleet-runner-token --query SecretString --output text 2>&1)
  case "$T" in glrt-*) echo "== fleet runner token: present (glrt-...)";; "") echo "== fleet runner token: EMPTY";; *) echo "== fleet runner token: not a runner token: $(cut -c1-80 <<<"$T")";; esac
  unset T
  echo; echo "== settings sync journal (GitLab machine $LIVE)"
  ssm_run "$LIVE" "journalctl -u vitana-settings -n 20 --no-pager; systemctl list-timers 'vitana-*' --no-pager" 120
  MGR=$(aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-fleet-manager Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
  echo; echo "== fleet manager ($MGR)"
  if [ -n "$MGR" ] && [ "$MGR" != None ]; then ssm_run "$MGR" "tail -n 20 /var/log/vitana-bootstrap.log; systemctl is-active gitlab-runner" 120; else echo "no running fleet manager machine"; fi
  echo; echo "== done. Paste the content of $OUTF into the Kiro session."
  exit 0
fi

if [ "$WORD" = cleanup ]; then
  LEFT=$(aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-restore-test Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
  if [ -z "$LEFT" ]; then echo "no scratch machine left"; else aws ec2 terminate-instances --instance-ids $LEFT --query 'TerminatingInstances[].CurrentState.Name' --output text; fi
  exit 0
fi

# ---- restore (RUNBOOK section 8, steps A to D) ----
cleanup() {
  [ -n "${SCRATCH:-}" ] || return
  echo; echo "== D: remove the scratch machine $SCRATCH"
  aws ec2 terminate-instances --instance-ids "$SCRATCH" --query 'TerminatingInstances[0].CurrentState.Name' --output text
  aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-restore-test Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text
  echo "== done. Paste the content of $OUTF into the Kiro session."
}
if [ "$WORD" = resume ]; then
  SCRATCH=$(aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-restore-test Name=instance-state-name,Values=pending,running --query 'Reservations[0].Instances[0].InstanceId' --output text)
  if [ -z "$SCRATCH" ] || [ "$SCRATCH" = None ]; then echo "no running scratch machine: run 'bash glv.sh restore' again"; exit 1; fi
  echo "scratch machine: $SCRATCH"
  CID=$(aws ssm list-command-invocations --instance-id "$SCRATCH" --query 'sort_by(CommandInvocations,&RequestedDateTime)[-1].CommandId' --output text)
  echo "restore command: $CID"
  while :; do
    S=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$SCRATCH" --query Status --output text 2>/dev/null)
    case "$S" in Pending|InProgress|Delayed|"") printf . >&2; sleep 20 ;; *) break ;; esac
  done
  echo >&2; echo "== B (read back): status $S"
  OUT=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$SCRATCH" --query StandardOutputContent --output text); echo "$OUT"
  aws ssm get-command-invocation --command-id "$CID" --instance-id "$SCRATCH" --query StandardErrorContent --output text | tail -5
  TIP=$(sed -n 's/^RESULT-MAIN-TIP: //p' <<<"$OUT" | head -1)
  trap cleanup EXIT
  echo; echo "== C: compare with the live GitLab (read only)"
cat > live-check.rb <<'EOF'
tip = ENV['TIP'].to_s
p = Project.find_by_full_path('vitana/vitana-platform')
puts "LIVE-COUNTS: #{[Project.count, Group.count, User.count].join(' ')}"
puts "LIVE-HAS-TIP: #{(tip.empty? || tip == 'none') ? 'no tip to check (step B gave no RESULT-MAIN-TIP)' : (!p.nil? && !p.repository.commit(tip).nil?)}"
EOF
ssm_run "$LIVE" "echo $(base64 -w0 live-check.rb) | base64 -d > /tmp/live-check.rb && TIP=$TIP gitlab-rails runner /tmp/live-check.rb 2>/tmp/live-check.err | grep '^LIVE-' || tail -5 /tmp/live-check.err; rm -f /tmp/live-check.rb /tmp/live-check.err" 600
  exit 0
fi

trap cleanup EXIT
LEFT=$(aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-restore-test Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
[ -z "$LEFT" ] || { echo "a scratch machine already exists: $LEFT (remove it first: aws ec2 terminate-instances --instance-ids $LEFT)"; trap - EXIT; exit 1; }

echo; echo "== A: launch the scratch machine"
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=vitana-eng-private-1 --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=vitana-eng-runner --query 'SecurityGroups[0].GroupId' --output text)
for ITYPE in m6i.xlarge m6i.large; do   # m6i.large when the account vCPU limit refuses xlarge (RUNBOOK section 8)
  SCRATCH=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$ITYPE" --subnet-id "$SUBNET" --security-group-ids "$SG" \
    --iam-instance-profile Name=vitana-eng-gitlab \
    --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=1 \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3,Encrypted=true,KmsKeyId=alias/vitana-engineering}' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=vitana-eng-restore-test}]' \
    --query 'Instances[0].InstanceId' --output text)
  [ -n "$SCRATCH" ] && [ "$SCRATCH" != None ] && break
done
echo "scratch machine: ${SCRATCH:-none} ($ITYPE)"; [ -n "$SCRATCH" ] && [ "$SCRATCH" != None ] || { echo "RESULT: FAIL no scratch machine"; exit 1; }
aws ec2 wait instance-running --instance-ids "$SCRATCH"
for i in $(seq 1 60); do
  P=$(aws ssm describe-instance-information --filters Key=InstanceIds,Values=$SCRATCH --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
  [ "$P" = Online ] && break; printf . >&2; sleep 10
done
echo; echo "ssm: $P"; [ "$P" = Online ] || { echo "RESULT: FAIL the scratch machine never answered Systems Manager"; exit 1; }

echo; echo "== B: restore on the scratch machine (20-40 minutes; keep this tab open and press a key now and then)"
cat > restore-inner.sh <<'EOF'
#!/bin/bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root AWS_DEFAULT_REGION=eu-central-1
GITLAB_VERSION=19.5.3-ee.0
exec 3>&1                                     # fd 3 is what Run Command shows
exec >>/var/log/restore-test.log 2>&1         # everything else goes to the log on this machine
say() { echo "$*"; echo "$*" >&3; }
fail() { say "RESULT: FAIL $*"; exit 1; }
say "== restore test start $(date -u +%FT%TZ)"
apt-get -o DPkg::Lock::Timeout=900 update -y
apt-get -o DPkg::Lock::Timeout=900 install -y curl ca-certificates unzip jq git openssh-server perl tzdata gnupg
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip && unzip -q -o /tmp/awscliv2.zip -d /tmp && /tmp/aws/install
fi
BK=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix backups/ --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
CF=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix config/ --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
say "backup: $BK   config: $CF"
{ [ -n "$BK" ] && [ "$BK" != None ] && [ -n "$CF" ] && [ "$CF" != None ]; } || fail "no backup or no config archive in the bucket"
mkdir -p /root/restore
aws s3 cp "s3://$BUCKET/$BK" /root/restore/ && aws s3 cp "s3://$BUCKET/$CF" /root/restore/ || fail "download"
tar -xzf "/root/restore/$(basename "$CF")" -C /     # /etc/gitlab first: gitlab.rb and gitlab-secrets.json (GitLab asks for the secrets before the restore)
curl -fsSL https://packages.gitlab.com/install/repositories/gitlab/gitlab-ee/script.deb.sh | bash
apt-get -o DPkg::Lock::Timeout=900 install -y "gitlab-ee=$GITLAB_VERSION" || fail "install of gitlab-ee=$GITLAB_VERSION"
gitlab-ctl reconfigure || fail "first reconfigure"
FILE="$(basename "$BK")"; ID="${FILE%_gitlab_backup.tar}"
cp "/root/restore/$FILE" /var/opt/gitlab/backups/ && chown git:git "/var/opt/gitlab/backups/$FILE" || fail "backup file placement"
gitlab-ctl stop puma; gitlab-ctl stop sidekiq
GITLAB_ASSUME_YES=1 gitlab-backup restore BACKUP="$ID" || fail "gitlab-backup restore $ID"
gitlab-ctl reconfigure && gitlab-ctl restart || fail "reconfigure or restart after the restore"
sleep 60
say "doctor:secrets: $(gitlab-rake gitlab:doctor:secrets 2>&1 | tail -3 | tr '\n' ' ')"
cat > /tmp/result.rb <<'RB'   # /tmp: gitlab-rails runner runs as user git, which cannot read /root
p = Project.find_by_full_path('vitana/vitana-platform')
puts "RESULT-COUNTS: #{[Project.count, Group.count, User.count].join(' ')}"
puts "RESULT-MAIN-TIP: #{p ? (p.repository.commit('main')&.id || 'none') : 'none'}"
RB
for n in 1 2 3; do   # the first runner after a restore can fail while GitLab finishes starting; keep its error, never hide it
  chmod 644 /tmp/result.rb; gitlab-rails runner /tmp/result.rb >/root/result.out 2>/root/result.err && grep -q '^RESULT-COUNTS:' /root/result.out && break
  sleep 60
done
grep '^RESULT-' /root/result.out | while IFS= read -r l; do say "$l"; done
grep -q '^RESULT-COUNTS:' /root/result.out || fail "result query: $(tail -5 /root/result.err | tr '\n' ' ')"
say "RESULT: DONE $ID"
EOF
bash -n restore-inner.sh || exit 1
OUT=$(ssm_run "$SCRATCH" "echo $(base64 -w0 restore-inner.sh) | base64 -d > /root/restore-inner.sh && BUCKET=$BUCKET bash /root/restore-inner.sh" 7200)
echo "$OUT"
TIP=$(sed -n 's/^RESULT-MAIN-TIP: //p' <<<"$OUT" | head -1)
echo; echo "== nginx lines of the restored /etc/gitlab/gitlab.rb (gitlab-infra review note)"
ssm_run "$SCRATCH" "grep -n nginx /etc/gitlab/gitlab.rb | grep -viE 'password|token|secret'" 120

echo; echo "== C: compare with the live GitLab (read only)"
cat > live-check.rb <<'EOF'
tip = ENV['TIP'].to_s
p = Project.find_by_full_path('vitana/vitana-platform')
puts "LIVE-COUNTS: #{[Project.count, Group.count, User.count].join(' ')}"
puts "LIVE-HAS-TIP: #{(tip.empty? || tip == 'none') ? 'no tip to check (step B gave no RESULT-MAIN-TIP)' : (!p.nil? && !p.repository.commit(tip).nil?)}"
EOF
ssm_run "$LIVE" "echo $(base64 -w0 live-check.rb) | base64 -d > /tmp/live-check.rb && TIP=$TIP gitlab-rails runner /tmp/live-check.rb 2>/tmp/live-check.err | grep '^LIVE-' || tail -5 /tmp/live-check.err; rm -f /tmp/live-check.rb /tmp/live-check.err" 600
