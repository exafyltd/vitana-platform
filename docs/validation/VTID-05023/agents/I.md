# VTID-05023 · Agent I · DMS review (read-only)

Status: **partly blocked**. AWS returned AccessDenied for every DMS read, so this review covers the repo and handover records only. Live task, endpoint and instance state is unknown. Nothing was started, stopped, created, modified or deleted.

## 1. Live AWS reads

Account 472838866351, role `kiro-1-dstevanovic`, region eu-central-1. Each call stopped at the first error. No workaround was attempted.

```
aws dms describe-replication-tasks --region eu-central-1
An error occurred (AccessDeniedException) when calling the DescribeReplicationTasks operation: User: arn:aws:sts::472838866351:assumed-role/kiro-1-dstevanovic/d-9066619bb4.f4f8d4c8-f011-704f-fd15-3c8866b65dbd is not authorized to perform: dms:DescribeReplicationTasks on resource: arn:aws:dms:eu-central-1:472838866351:*:* because no identity-based policy allows the dms:DescribeReplicationTasks action

aws dms describe-replication-instances --region eu-central-1
An error occurred (AccessDeniedException) when calling the DescribeReplicationInstances operation: User: arn:aws:sts::472838866351:assumed-role/kiro-1-dstevanovic/d-9066619bb4.f4f8d4c8-f011-704f-fd15-3c8866b65dbd is not authorized to perform: dms:DescribeReplicationInstances on resource: arn:aws:dms:eu-central-1:472838866351:*:* because no identity-based policy allows the dms:DescribeReplicationInstances action

aws dms describe-connections --region eu-central-1
An error occurred (AccessDeniedException) when calling the DescribeConnections operation: User: arn:aws:sts::472838866351:assumed-role/kiro-1-dstevanovic/d-9066619bb4.f4f8d4c8-f011-704f-fd15-3c8866b65dbd is not authorized to perform: dms:DescribeConnections on resource: arn:aws:dms:eu-central-1:472838866351:*:* because no identity-based policy allows the dms:DescribeConnections action
```

The role needs `dms:DescribeReplicationTasks`, `dms:DescribeReplicationInstances`, `dms:DescribeConnections` and `dms:DescribeEndpoints` for this review. The owner must grant these through their own IAM process. This agent does not grant them, and no IAM change was made.

## 2. The WAL failure on `vitana-supabase-to-aurora-v3`

Last failure message, as recorded on 2026-09-12 12:51:33 UTC in `docs/AURORA-MIGRATION-STATUS-2026-09-10.md` and `docs/validation/VTID-05023/`: `LastFailureMessage` "An internal WAL conversational protocol error has occurred", StopReason `FATAL_ERROR`, level `FATAL`. Status `failed`. This is a record from an earlier read. It was not re-read today.

The generic message hides the real error in the task's CloudWatch stream (`dms-tasks-vitana-dms-prod`). The recorded log lines are:

```
[SOURCE_CAPTURE]E: Failure in executing replication command "IDENTIFY_SYSTEM": ERROR: syntax error at or near "IDENTIFY_SYSTEM"
[SOURCE_CAPTURE]E: WAL reader terminated with irrecoverable error.
```

Cause, as the status doc states it: the source endpoint `vitana-src-supabase-v3` points at the Supabase session pooler (`aws-0-eu-north-1.pooler.supabase.com`, user `migrate.inmkhvwdcuyhnxkgfvsb`). The pooler proxies SQL only. `IDENTIFY_SYSTEM` is a replication-protocol command, so the pooler rejects it. Full-load traffic works over the pooler because it is plain SQL. CDC cannot work over the pooler.

The documented fix is the direct connection `db.inmkhvwdcuyhnxkgfvsb.supabase.co`. That hostname resolves IPv6-only. The DMS VPC `vpc-05958f035e596fe64` has only `10.0.0.0/16` and no IPv6 association. The two options recorded are a Supabase IPv4 add-on for the direct connection, or IPv6 egress on the DMS VPC (NAT64/DNS64 or an IPv6 CIDR with routes). Both need an owner decision or `ec2` permissions. Status of either: not done, per the latest record.

Two earlier failures, recorded in the same doc: `vitana-supabase-to-aurora-v3` failed on 2026-08-20 after 9 recoverable retries, and a dropped replication slot (`Can't resume task after replication slot was dropped`). The 2026-09-12 failure is the WAL protocol error above.

## 3. Task inventory (from records, not live)

| Task | Type | Source | Target | Last recorded state |
|---|---|---|---|---|
| `vitana-supabase-to-aurora-v3` | full-load-and-cdc | `vitana-src-supabase-v3` (pooler) | `vitana-tgt-aurora-v2` | failed, WAL protocol error (2026-09-12) |
| `vitana-fullload-only` | full-load | live endpoints, names not in repo | production Aurora | proven run, 15.5 to 16 min for the full set |
| `vitana-fullload-rehearsal-v2` | full-load | same shape as rehearsal task | production Aurora | stopped, recorded as 594 of 594 tables (status doc, Sept 2026) |
| `vitana-fullload-rehearsal` | full-load | defined in `scripts/aws/aurora-cutover-rehearsal-task.sh` | production Aurora (HYKKF...) | not verified to exist. The brief says "ready"; no record confirms it |
| Reverse CDC `vitana-cdc-aurora-to-supabase-*` | cdc | Aurora clone or prod (`vitana-src-aurora-reverse`) | Supabase (`vitana-tgt-supabase-reverse`) | defined in `scripts/aws/aurora-to-supabase-cdc.sh`. Created only on `--apply`. No record shows that it was run |

Other `vitana-*` DMS endpoints named in the records: `vitana-source-supabase` (direct, `migrate`), `vitana-supabase-source-autopilot` and `vitana-supabase-source-fullload` (direct, `migrate`), `vitana-target-aurora-prod` (older tasks). Each existence and state is unknown. Earlier records say CDC has been down since 2026-08-20 and no working CDC task exists.

## 4. Settings the rehearsal needs

Status key: **set** means the repo has the value and the live value is either matched or unverified. **missing** means no value exists anywhere. **unknown** means the value cannot be checked without DMS read access.

| Setting | Needed for the rehearsal | Status | Evidence |
|---|---|---|---|
| Source endpoint | Supabase, read via a full-load-capable endpoint. Full load works over the pooler. | **unknown** (ARN `...endpoint:M5KXPHGSEZHMDBXFLV5WVH3MAU` is in the script, name not recorded) | rehearsal task script lines 65 |
| Target endpoint | The rehearsal clone `vitana-aurora-rehearsal`. Not production. | **missing**. The script targets ARN `...endpoint:HYKKFCTTVRAYDNYH7MMUHOCUPI`, which is production Aurora. | `docs/validation/VTID-05023/rehearsal.md`, DMS bullet: "DMS targets production Aurora; a clone-targeted load needs its own target endpoint" |
| Replication instance | `PHZCRFHVT5ENVI4H4NMGWBXSEI` | **unknown** (describe denied) | rehearsal task script line 67 |
| CDC start position | Not used for full-load. For CDC runs, the repo has no start-position setting. The runbook uses `start-replication-task-type reload-target` (full reload) or `resume-processing`. | **missing** for CDC (no working slot, no direct endpoint). **unknown** for full-load. | `AURORA-CUTOVER-RUNBOOK-2026-09-20.md` steps 4 and 5 |
| Logical replication | Supabase must have `wal_level=logical` for CDC from Supabase. Aurora needs `rds.logical_replication=1` only when Aurora is the CDC source (reverse CDC, Realtime). A full-load does not need either. | Aurora prod: **off** (last recorded, `docs/AURORA-B5-REALTIME-INVENTORY.md`). Clone: **missing** (set only with `rehearsal-clone.sh --logical-replication`, rehearsal.md section H). Supabase `wal_level`: **unknown**. | `docs/AURORA-B5-REALTIME-INVENTORY.md`, `scripts/aws/rehearsal-clone.sh` |
| Task type | `full-load` for the rehearsal. `full-load-and-cdc` only when CDC is rehearsed. | **set** in repo (`MIGRATION_TYPE="full-load"`). Live: **unknown** | rehearsal task script line 68 |
| Target table prep | `TRUNCATE_BEFORE_LOAD`. Never `DROP_AND_CREATE`, which destroys RLS. | **set** in repo. Live: **unknown** | rehearsal task script, `TaskSettings.FullLoadSettings` |
| Table mapping scope | `include public.%`, exclude `awsdms_%`, exclude 13 tables (`memory_audit_log`, `products`, `knowledge_docs`, `ai_memory`, `memory_items`, `memory_facts`, `mem_episodes`, `user_intents`, `memory_embeddings`, `community_listings`, `calendar_events`, `mem_facts`, `feedback_tickets`), lowercase schema transform. 16 rules. | **set** in repo. Live: **unknown**. Decision needed: `products` and `knowledge_docs` are excluded as "known broken". | rehearsal task script `TABLE_MAPPINGS` |
| Start action | `reload-target` for a fresh full load. Only start after the target is confirmed to be the clone. | **set** in runbook. Not started by this agent. | runbook step 4 |
| Replication task settings | Error policy and LOB settings as in the script. | **set** in repo. Live: **unknown** | rehearsal task script `TASK_SETTINGS` |

## 5. Blockers and risks

1. **The repo rehearsal task targets production Aurora.** `scripts/aws/aurora-cutover-rehearsal-task.sh` (its header and endpoint ARNs) says it "targets the SAME Aurora database the real cutover run will use". Full-load with `TRUNCATE_BEFORE_LOAD` empties and reloads every included table. Running it as written would rewrite production Aurora. It must not run. The rehearsal needs a new target endpoint for the clone, which does not exist.
2. **Clone-based rehearsal and the rehearsal task disagree.** `rehearsal.md` section E says nothing replicates into the clone. The owner must decide how the clone gets its data: a new target endpoint, or a restore only.
3. **CDC is not fixable from the repo.** The WAL error needs either the Supabase IPv4 add-on or IPv6 egress on the DMS VPC. Neither is in place per the latest record.
4. **Live state is unverified.** The brief calls `vitana-fullload-rehearsal` ready. No record confirms that, and the rest of the family is also unverified.

## 6. Owner commands needed

Grant these four read actions to the role `kiro-1-dstevanovic` through the owner's IAM process: `dms:DescribeReplicationTasks`, `dms:DescribeReplicationInstances`, `dms:DescribeConnections`, `dms:DescribeEndpoints`. The role is an assumed-role session, so the grant may belong on its permission set rather than the role itself.

Then re-run this review with:

```
aws dms describe-replication-tasks --region eu-central-1 --query 'ReplicationTasks[].{id:ReplicationTaskIdentifier,status:Status,type:MigrationType,reason:LastFailureMessage,stop:StopReason}'
aws dms describe-endpoints --region eu-central-1 --query 'Endpoints[].{id:EndpointIdentifier,arn:EndpointArn,server:ServerName,user:Username,engine:EngineName}'
```

Owner decisions needed before any rehearsal DMS run: the clone target endpoint, the IPv4 or IPv6 path for CDC, and whether `products` and `knowledge_docs` stay excluded.

## 7. Responses to the brief

- The WAL error is explained from the recorded CloudWatch lines and the documented root cause. The live status has not been read.
- The rehearsal settings are listed with their repo values and live status. Live status is unknown for most rows.
- Nothing was started, stopped, created or deleted.
