#!/usr/bin/env python3
"""Monthly cost of the monitoring lane (plan eng-gitlab-m2 section 3.6), and the reasoning behind the default of monthly_budget_usd.

Prices are read from the AWS public price list, region eu-central-1, files of the dates below, and written here as constants so the
arithmetic can be checked by hand. Nothing here depends on traffic except the one stated assumption (one metric request a minute).
Excluded on purpose: data transfer, the job machines of lane fleet (billed only while jobs run, plan section 7).
"""
H = 730  # hours in an average month (24 * 365 / 12)

PRICE = {  # USD, eu-central-1
    "cloudwatch alarm per month (standard resolution)": 0.10,      # AmazonCloudWatch 20261104213532, EUC1-CW:AlarmMonitorUsage
    "cloudwatch custom metric per month (first 10 000)": 0.30,     # EUC1-CW:MetricMonitorUsage
    "cloudwatch API requests per 1 000": 0.01,                     # EUC1-CW:Requests
    "kms key per month": 1.00,                                     # awskms 20261026201814 (cost-estimate.txt of VTID-05544)
    "ec2 t3.medium per h": 0.048,                                  # AmazonEC2 20261104210305, BoxUsage:t3.medium, Linux, shared
    "secret per month": 0.40,                                      # AWSSecretsManager 20260911124610
}
P = PRICE

# --- this lane
ALARMS = 8                       # monitoring.tf
# one metric series per name and dimension set: PendingJobs, OldestPendingJobAgeSeconds, RunningJobs, FleetRunningJobs, GitLabReadFailed,
# BackupAgeSeconds = 6; TickAgeSeconds{Unit=vitana-land} and {Unit=vitana-settings} = 2; disk_used_percent from the agent: the series with
# fstype and path, and the rolled-up series with InstanceId only = 2
METRICS = 6 + 2 + 2
REQUESTS = 2 * 60 * 24 * 30      # assumption: the metrics job and the CloudWatch agent each call PutMetricData once a minute
rows = [
    ("CloudWatch alarms (%d)" % ALARMS, P["cloudwatch alarm per month (standard resolution)"] * ALARMS),
    ("CloudWatch custom metrics (%d)" % METRICS, P["cloudwatch custom metric per month (first 10 000)"] * METRICS),
    ("CloudWatch API requests (%d), none counted as free" % REQUESTS, P["cloudwatch API requests per 1 000"] * REQUESTS / 1000),
    ("KMS key of the alerts topic (1)", P["kms key per month"]),
    ("SNS e-mail notifications, AWS Budgets (first two budgets), the budget mails", 0.0),
]
lane = sum(v for _, v in rows)
print("== this lane, per month")
for name, v in rows:
    print(f"   {name:<80} $ {v:7.2f}")
print(f"   {'TOTAL':<80} $ {lane:7.2f}   (about ${lane * 12:,.0f} per year)")
print("   The monthly free allowance of CloudWatch (10 metrics, 10 alarms, 1 000 000 requests) would take most of this away; it is not counted.")

# --- the default of monthly_budget_usd
M1_FULL = 452.20                 # docs/validation/VTID-05544/outputs/cost-estimate.txt, "full size", always on
M1_START = 284.30                # the same file, "start size"
MANAGER = P["ec2 t3.medium per h"] * H            # lane fleet: the runner manager (plan section 3.2), always on
SECRETS = 12 * P["secret per month"]              # assumption: fleet-runner-token, webhook-signing-token and about ten agent logins (plan section 3.3)
print()
print("== the floor the budget must clear (always-on cost; job machines come on top, plan section 7)")
floor_full = M1_FULL + MANAGER + SECRETS + lane
floor_start = M1_START + MANAGER + SECRETS + lane
print(f"   milestone 1, full size                                                          $ {M1_FULL:7.2f}")
print(f"   fleet manager, one t3.medium ({P['ec2 t3.medium per h']} an hour x {H} h)                                  $ {MANAGER:7.2f}")
print(f"   about 12 more secrets                                                           $ {SECRETS:7.2f}   (assumption, lanes fleet and settings)")
print(f"   this lane                                                                       $ {lane:7.2f}")
print(f"   FLOOR at full size                                                              $ {floor_full:7.2f}")
print(f"   FLOOR at the start size (m6i.large machines)                                    $ {floor_start:7.2f}")

DEFAULT = 1000
print()
print(f"== default monthly_budget_usd = {DEFAULT}: twice the full-size floor, rounded")
for pct in (50, 80, 100):
    mark = DEFAULT * pct / 100
    print(f"   {pct:>3} percent = $ {mark:7.2f}   job machines and NAT traffic needed to reach it: full size $ {max(0.0, mark - floor_full):7.2f}, start size $ {max(0.0, mark - floor_start):7.2f}")
print(f"   twice the full-size floor is $ {2 * floor_full:7.2f}; {DEFAULT} keeps the 50 percent mail at about the floor, so it arrives late in most months once jobs run")
print("   (a checkpoint), the 80 percent mail means job machines cost about $300 or more (look at it), and 100 percent is the stop sign.")
print(f"   A fleet stuck at its maximum of 24 m6i.xlarge on demand (0.23 an hour, as in VTID-05544) costs about $ {24 * 0.23 * 24:7.2f} a day, so 80 percent is reached within days, not weeks.")
