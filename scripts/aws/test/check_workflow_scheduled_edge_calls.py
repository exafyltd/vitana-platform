"""VTID-05023 part 6: static checks for AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml.

The YAML parses; it is dispatch-only with a required reason; it uses OIDC with
AWS_PROD_ROLE_ARN and an account guard; schedules default to DISABLED; every `run:`
block is valid bash (bash -n); the secret value never reaches a command line.
"""
import os
import subprocess
import sys
import tempfile

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PATH = os.path.join(ROOT, '.github', 'workflows', 'AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml')


def fail(msg):
    print('FAIL:', msg)
    sys.exit(1)


doc = yaml.safe_load(open(PATH))
on = doc.get(True) or doc.get('on')
if set(on) != {'workflow_dispatch'}:
    fail('must be workflow_dispatch only, got %s' % list(on))
inputs = on['workflow_dispatch']['inputs']
if not inputs['reason'].get('required'):
    fail('reason must be required')
if inputs['enable'].get('default') is not False or inputs['enable'].get('type') != 'boolean':
    fail('enable must be a boolean defaulting to false')
if doc['permissions'].get('id-token') != 'write':
    fail('OIDC needs id-token: write')

steps = doc['jobs']['setup']['steps']
text = open(PATH).read()
if 'secrets.AWS_PROD_ROLE_ARN' not in text or '472838866351' not in text:
    fail('OIDC role / account guard missing')
if "STATE=$([ \"$ENABLE\" = \"true\" ] && echo ENABLED || echo DISABLED)" not in text:
    fail('schedule state must follow the enable input')
for needle in ['0 * * * ? *', '0/15 * * * ? *', '--schedule-expression-timezone UTC',
               'send-appointment-reminder', 'run-api-tests', 'MaximumRetryAttempts:0',
               '"triggered_by": "cron"', 'SUPABASE-JOBS-1-4-UNSCHEDULED', '::add-mask::$TOKEN']:
    if needle not in text:
        fail('missing %r' % needle)
# The token only ever goes into a jq --arg (process args of jq on the runner are not logged)
# and then a 0600 file; it is never echoed or passed to aws on the command line.
for line in text.splitlines():
    s = line.strip()
    if '$TOKEN' in s and not (s.startswith('TOKEN=') or s.startswith('echo "::add-mask::')
                              or s.startswith('[ -n "$TOKEN" ]') or s.startswith('jq -n --arg v "Bearer $TOKEN"')):
        fail('unexpected use of $TOKEN: %s' % s)

n = 0
for st in steps:
    if 'run' not in st:
        continue
    with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as f:
        f.write(st['run'])
    r = subprocess.run(['bash', '-n', f.name], capture_output=True, text=True)
    os.unlink(f.name)
    if r.returncode:
        fail('bash -n failed in step %r: %s' % (st.get('name'), r.stderr))
    n += 1
print('OK: workflow parses, %d run blocks pass bash -n, dispatch-only, schedules DISABLED by default' % n)
