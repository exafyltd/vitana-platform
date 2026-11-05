#!/usr/bin/env bash
# Control-flow test of the restore script in RUNBOOK.md section 8 step B: run the real text with stub commands.
# Paths are rewritten to a temp directory; every external command is a stub that records its call.
set -u
RUNBOOK="${1:?path to RUNBOOK.md}"
T="$(mktemp -d "${TMPDIR:-/tmp}/rt-XXXXXX")"; trap 'rm -rf "$T"' EXIT
python3 - "$RUNBOOK" "$T" <<'EOF'
import re,sys
md=open(sys.argv[1]).read(); T=sys.argv[2]
m=re.search(r"cat > restore-inner\.sh <<'EOF'\n(.*?)\nEOF\nbash -n",md,re.S)
s=m.group(1)
s=s.replace("/var/log/restore-test.log",f"{T}/restore-test.log").replace("/root/restore",f"{T}/restore")
s=s.replace("/var/opt/gitlab/backups/",f"{T}/backups/").replace("/root/result.rb",f"{T}/result.rb")
s=s.replace("tar -xzf","tar -xzf").replace(' -C /     #',f' -C {T}/rootfs     #')
s=s.replace("/tmp/awscliv2.zip",f"{T}/awscliv2.zip").replace("/tmp/aws/install",f"{T}/aws-install").replace("-d /tmp","-d "+T)
open(f"{T}/inner.sh","w").write(s)
EOF
mkdir -p "$T/bin" "$T/backups" "$T/rootfs/etc/gitlab" "$T/s3"
cat > "$T/bin/stub" <<'EOF'
#!/bin/bash
echo "$(basename "$0") $*" >> "$STUBLOG"
case "$(basename "$0")" in
  aws)
    case "$1 $2" in
      "s3api list-objects-v2")
        [ "${NOBACKUP:-0}" = 1 ] && exit 0
        case "$*" in *backups/*) echo "backups/1730000000_2026_11_04_19.5.3-ee_gitlab_backup.tar" ;; *config/*) echo "config/gitlab-config-2026-11-04.tgz" ;; esac ;;
      "s3 cp")
        case "$3" in s3://*gitlab_backup.tar) : > "$4/$(basename "$3")" ;; s3://*.tgz) (cd "$T/mk" && tar -czf "$4/$(basename "$3")" etc/gitlab) ;; esac ;;
    esac ;;
  curl) echo "echo curl-script-ran" ;;
  gitlab-backup) [ "${RESTOREFAIL:-0}" = 1 ] && exit 3 ;;
  gitlab-rake) echo "I, Checking encrypted values in the database"; echo "I, Total: 12"; echo "I, Failed: 0" ;;
  gitlab-rails) echo "noise line"; echo "RESULT-COUNTS: 3 1 6"; echo "RESULT-MAIN-TIP: 0123456789abcdef0123456789abcdef01234567" ;;
  apt-get) [ "${INSTALLFAIL:-0}" = 1 ] && [[ "$*" == *gitlab-ee=* ]] && exit 100 ;;
esac
exit 0
EOF
chmod +x "$T/bin/stub"
for c in aws curl gitlab-ctl gitlab-backup gitlab-rake gitlab-rails apt-get chown unzip jq git; do ln -s stub "$T/bin/$c"; done
mkdir -p "$T/mk/etc/gitlab"; echo '{}' > "$T/mk/etc/gitlab/gitlab-secrets.json"; echo "external_url 'https://x'" > "$T/mk/etc/gitlab/gitlab.rb"
export STUBLOG="$T/calls.log" T
fail=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=$((fail+1)); fi; }

run() { : > "$STUBLOG"; rm -f "$T"/restore-test.log; rm -rf "$T/restore" "$T/backups"/*; mkdir -p "$T/restore" "$T/backups"
        env PATH="$T/bin:$PATH" BUCKET=testbucket "$@" bash "$T/inner.sh" > "$T/out.txt" 2> "$T/err.txt"; echo $? > "$T/rc.txt"; }

# 1 happy path
run env
check "happy: exit 0"                    '[ "$(cat $T/rc.txt)" = 0 ]'
check "happy: shows the backup chosen"   'grep -q "^backup: backups/1730000000_2026_11_04_19.5.3-ee_gitlab_backup.tar   config: config/gitlab-config-2026-11-04.tgz" $T/out.txt'
check "happy: shows doctor result"       'grep -q "^doctor:secrets: I, Checking" $T/out.txt'
check "happy: shows counts"              'grep -q "^RESULT-COUNTS: 3 1 6$" $T/out.txt'
check "happy: shows main tip"            'grep -q "^RESULT-MAIN-TIP: 0123456789abcdef0123456789abcdef01234567$" $T/out.txt'
check "happy: ends with DONE and the id" 'tail -1 $T/out.txt | grep -q "^RESULT: DONE 1730000000_2026_11_04_19.5.3-ee$"'
check "happy: noise stays out of stdout" '! grep -q "noise line\|curl-script-ran" $T/out.txt'
check "happy: noise is in the log"       'grep -q "curl-script-ran\|== restore test start" $T/restore-test.log'
check "happy: stop puma then sidekiq, restore, in order" 'a=$(grep -n "gitlab-ctl stop puma" $STUBLOG | cut -d: -f1); b=$(grep -n "gitlab-ctl stop sidekiq" $STUBLOG | cut -d: -f1); c=$(grep -n "^gitlab-backup restore" $STUBLOG | cut -d: -f1); [ -n "$a" ] && [ "$a" -lt "$b" ] && [ "$b" -lt "$c" ]'
check "happy: restore got BACKUP=<id> without the suffix" 'grep -q "^gitlab-backup restore BACKUP=1730000000_2026_11_04_19.5.3-ee$" $STUBLOG'
check "happy: /etc/gitlab (secrets) extracted" 'test -f $T/rootfs/etc/gitlab/gitlab-secrets.json'
check "script order: secrets extracted before the package install and before the restore" 'x=$(grep -n "tar -xzf" $T/inner.sh | head -1 | cut -d: -f1); y=$(grep -n "install -y \"gitlab-ee=" $T/inner.sh | head -1 | cut -d: -f1); z=$(grep -n "gitlab-backup restore" $T/inner.sh | head -1 | cut -d: -f1); [ -n "$x" ] && [ "$x" -lt "$y" ] && [ "$y" -lt "$z" ]'
check "happy: backup file placed in the backup dir" 'test -f $T/backups/1730000000_2026_11_04_19.5.3-ee_gitlab_backup.tar'

# 2 empty bucket
run env NOBACKUP=1
check "empty bucket: exit 1"             '[ "$(cat $T/rc.txt)" = 1 ]'
check "empty bucket: FAIL line is shown" 'grep -q "^RESULT: FAIL no backup or no config archive in the bucket$" $T/out.txt'
check "empty bucket: nothing installed or restored" '! grep -q "gitlab-ee=\|gitlab-backup restore" $STUBLOG'

# 3 package install fails
run env INSTALLFAIL=1
check "install fail: exit 1 and named"   '[ "$(cat $T/rc.txt)" = 1 ] && grep -q "^RESULT: FAIL install of gitlab-ee=19.5.3-ee.0$" $T/out.txt'
check "install fail: restore not attempted" '! grep -q "gitlab-backup restore" $STUBLOG'

# 4 restore fails
run env RESTOREFAIL=1
check "restore fail: exit 1 and named"   '[ "$(cat $T/rc.txt)" = 1 ] && grep -q "^RESULT: FAIL gitlab-backup restore 1730000000_2026_11_04_19.5.3-ee$" $T/out.txt'
check "restore fail: no DONE line"       '! grep -q "RESULT: DONE" $T/out.txt'
check "restore fail: nothing restarted afterwards" '! grep -q "gitlab-ctl restart" $STUBLOG'

echo; echo "failures: $fail"; [ "$fail" -eq 0 ]
