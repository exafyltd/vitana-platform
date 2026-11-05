#!/usr/bin/env bash
# Renders the two policy documents of terraform/monitoring.tf with the AWS provider (no AWS call: fake credentials, every check
# skipped, the account id a variable) and checks the e-mail address test of the subscription in `terraform console`.
# A policy document is only a data source, so `terraform validate` cannot show what JSON it makes; this does.
# usage: render-policies.sh <worktree>        env: TERRAFORM (default terraform), TMPDIR
set -euo pipefail
WT="$(cd "${1:?worktree}" && pwd)"
TF="${TERRAFORM:-terraform}"
P="$(mktemp -d "${TMPDIR:-/tmp}/policycheck-XXXXXX")"
trap 'rm -rf "$P"' EXIT
cd "$P"

echo "# \$ terraform console   (can(regex(\"^[^@[:space:]]+@[^@[:space:]]+\$\", <address>)), the precondition of aws_sns_topic_subscription.owner_email)"
for a in 'someone@example.test' 'a@b' 'no-at-sign' 'two@@signs.test' 'has space@x.test' ''; do
  printf '%-26s ' "[$a]"; echo "can(regex(\"^[^@[:space:]]+@[^@[:space:]]+\$\", \"$a\"))" | "$TF" console 2>&1 | tail -1
done

python3 - "$WT/infra/gitlab-engineering/terraform/monitoring.tf" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf8').read()
def block(kind, *labels):
    m = re.search(r'^%s\s+%s\s*\{' % (kind, r'\s+'.join('"%s"' % l for l in labels)), src, re.M)
    depth = 0; i = m.end() - 1
    while True:
        c = src[i]
        if c == '"':
            i += 1
            while src[i] != '"':
                if src[i] == '\\': i += 1
                i += 1
        elif c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: break
        i += 1
    return src[m.start(): i + 1]
body = block('data', 'aws_iam_policy_document', 'alerts_key') + '\n\n' + block('data', 'aws_iam_policy_document', 'monitoring')
body = body.replace('data.aws_caller_identity.me.account_id', 'var.account_id')
open('main.tf', 'w').write('''terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0, < 6.0.0"
    }
  }
}
provider "aws" {
  region                      = "eu-central-1"
  access_key                  = "fake"
  secret_key                  = "fake"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}
variable "account_id" { default = "123456789012" }
variable "region" { default = "eu-central-1" }
locals { monitoring_namespace = "Vitana/Engineering" }
''' + body + '''
output "alerts_key_policy" { value = data.aws_iam_policy_document.alerts_key.json }
output "monitoring_policy" { value = data.aws_iam_policy_document.monitoring.json }
''')
PY
echo
echo "# \$ terraform init -input=false && terraform plan -input=false   (scratch configuration holding only the two policy documents)"
"$TF" init -input=false -no-color > init.log 2>&1 && tail -1 init.log
"$TF" plan -input=false -no-color -out=plan.bin > plan.log 2>&1 && grep -E '^(No changes|Plan:|Changes to Outputs)' plan.log | head -3
"$TF" show -json plan.bin | python3 -c '
import json, sys
d = json.load(sys.stdin)
for name in ("alerts_key_policy", "monitoring_policy"):
    print("\n== output", name)
    print(json.dumps(json.loads(d["planned_values"]["outputs"][name]["value"]), indent=2))
'
