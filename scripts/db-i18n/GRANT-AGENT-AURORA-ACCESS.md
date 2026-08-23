# Giving the Claude agent enough access to seed Aurora itself

Two options. **Option A needs no new grants and works today.** Option B is what
you asked for — full autonomy — and it is a real privilege expansion, so the
tradeoff is spelled out rather than buried.

Neither option makes Aurora publicly accessible. That would put a production
database holding 495 tables of member data on the public internet to save a
bastion hop, and there is no version of this task that justifies it.

---

## First: why the obvious shortcut doesn't work

`ecs:ExecuteCommand` into a running `vitana-gateway-awsdr` task looks like the
cheap answer — the task is already in the VPC with credentials injected. It
does not work. The production image cannot run the seeder:

```dockerfile
# services/gateway/Dockerfile — runtime stage
RUN apk add --no-cache ffmpeg && npm install --production   # tsx is a devDependency → absent
COPY --from=builder /app/dist ./dist                        # src/ is NOT copied
COPY --from=builder /app/config ./config
COPY --from=builder /app/specs ./specs
```

The seeder is `src/scripts/seed-db-i18n.ts`, run through `tsx`. Neither the
script nor its runner is in the image, and `data/db-i18n/` artifacts are not
either. Granting exec access would buy a shell that cannot do the job.

---

## Option A — you run it, no grants (recommended)

From any host inside the VPC (bastion, EC2, VPC-networked CloudShell) with the
repo checked out and permission to read the secret:

```bash
git clone https://github.com/exafyltd/vitana-platform.git
cd vitana-platform
scripts/db-i18n/seed-aurora.sh --check     # read-only coverage report first
scripts/db-i18n/seed-aurora.sh --apply     # then write
scripts/db-i18n/seed-aurora.sh --verify    # reconcile
```

Five minutes, no IAM changes, no standing expansion of an automated principal.

---

## Option B — grant the agent end-to-end autonomy

### The thing that makes this awkward

`claude-code-aws-agent` carries the permissions boundary
`arn:aws:iam::472838866351:policy/claude-code-aws-agent-boundary`.

**A boundary is a ceiling, not a grant.** Attaching an allow policy to the user
changes nothing: effective permissions are the *intersection* of the identity
policy and the boundary. The boundary currently produces an explicit deny on
`secretsmanager:GetSecretValue`, `ecs:RunTask` and `ecs:ExecuteCommand`, so the
boundary itself has to change.

**Look before you overwrite.** The agent cannot read the boundary
(`iam:GetPolicyVersion` is denied), so nothing below generates a replacement
document — that would silently strip guardrails neither of us can see. Dump it
first:

```bash
BOUNDARY=arn:aws:iam::472838866351:policy/claude-code-aws-agent-boundary
VER=$(aws iam get-policy --policy-arn "$BOUNDARY" --query 'Policy.DefaultVersionId' --output text)
aws iam get-policy-version --policy-arn "$BOUNDARY" --version-id "$VER" \
  --query 'PolicyVersion.Document' --output json | tee /tmp/boundary-current.json
```

Read it, then widen it by hand with the statements below, and publish:

```bash
aws iam create-policy-version --policy-arn "$BOUNDARY" \
  --policy-document file:///tmp/boundary-new.json --set-as-default
```

(IAM keeps 5 versions; delete an old one if that errors.)

### The statements to add — scoped, not blanket

```json
{
  "Sid": "AuroraI18nSeedSecrets",
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": [
    "arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/prod/database-url-*",
    "arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/staging/database-url-*"
  ]
},
{
  "Sid": "AuroraI18nSeedRunTask",
  "Effect": "Allow",
  "Action": ["ecs:RunTask", "ecs:DescribeTasks", "ecs:StopTask"],
  "Resource": "*",
  "Condition": {
    "ArnEquals": { "ecs:cluster": "arn:aws:ecs:eu-central-1:472838866351:cluster/Vitana-ECS-Cluster" }
  }
},
{
  "Sid": "AuroraI18nSeedPassRole",
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": [
    "arn:aws:iam::472838866351:role/vitana-ecs-task-role",
    "arn:aws:iam::472838866351:role/ecsTaskExecutionRole"
  ],
  "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
}
```

Two scoping notes that matter: the secret ARNs end `-*` because Secrets Manager
appends a six-character random suffix and an exact ARN will not match (the same
trap that broke AWS staging for four days under VTID-03513). And `iam:PassRole`
is the grant to read twice — it is what lets the principal launch a task *as*
another role, so the condition pinning it to `ecs-tasks.amazonaws.com` is doing
real work.

### Still not sufficient on its own

RunTask needs something to run, and no current task definition contains the
seeder (see the Dockerfile note above). Something must also build and register
a seeder image — which means ECR push rights and `ecs:RegisterTaskDefinition`
on top of the above. At that point the principal can build an arbitrary image
and run it in your production VPC with a production database role attached.

That is the honest end state of "full authorization": not a bigger key for one
job, but a standing ability to execute arbitrary code inside the VPC. It is
your account and your call — I would rather you make it with that stated
plainly than discover it later.

---

## Recommendation

Take Option A for this task. It is one bastion session, and the seeding is a
handful of runs, not an ongoing workload.

Revisit Option B if seeding becomes routine and you want it fully automated —
and if you do, scope it to a dedicated `vitana-db-i18n-seeder` role assumed for
the job, rather than widening a general-purpose agent's standing boundary.

---

## The thing to settle before either option

Aurora is **not currently receiving updates from Supabase**. Measured live on
2026-08-10:

| task | status |
|---|---|
| `vitana-supabase-to-aurora` | stopped (`NORMAL`, since 2026-07-21) |
| `vitana-supabase-to-aurora-v3` | **failed** — `FATAL_ERROR` after 7 recovery attempts, 2026-07-27 |
| `vitana-reload-39-tables` | stopped, 1 table errored |

Seeding Aurora today writes correct translations into a database roughly two
weeks divergent from live Supabase. Decide first whether Aurora is the primary
(stop DMS deliberately, run a final verified delta, then seed) or still a
replica (repair the FATAL task, reconcile, seed Supabase and let DMS carry it).
Writing to both is the dual-writer hazard `SUPABASE-TO-AURORA-MIGRATION-PLAN.md`
rejects as "Option C".
