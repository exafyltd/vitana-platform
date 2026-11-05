#!/usr/bin/env python3
"""Monthly cost estimate of the CI fleet of milestone 2 (plan eng-gitlab-m2 sections 3.2 and 7), region eu-central-1, USD.

PRICES are read from the AWS public price list files of the versions below
(https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/<version>/eu-central-1/index.json; "current" is the same URL with the word current)
and written here as constants so the arithmetic can be checked by hand. Everything else is an ASSUMPTION, stated as such, not a measurement.
Replace the assumptions with the first week's real numbers (acceptance A9) and run this again.

Not included: the machines and network of milestone 1 (see its own estimate), data transfer out to the internet, CloudWatch and the budget alarm
(lane monitoring), Secrets Manager API calls (a few per day), and the settings sync.
"""
H = 730                     # hours in an average month (24 * 365 / 12)
DAYS = 365 / 12             # days in an average month

PRICE = {
    # AmazonEC2 version 20261104210305, published 2026-11-04T21:03:05Z; Linux, shared tenancy, On-Demand
    "ec2 m6i.xlarge per h": 0.23,
    "ec2 m6a.xlarge per h": 0.207,
    "ec2 m5.xlarge per h": 0.23,
    "ec2 m5a.xlarge per h": 0.208,
    "ec2 m6i.large per h": 0.115,             # image build machine (same list; half of m6i.xlarge)
    "ec2 t3.medium per h": 0.048,             # the fleet manager
    "ebs gp3 per GB-month": 0.0952,           # 3000 IOPS and 125 MB/s are included in the base price
    "ebs snapshot per GB-month": 0.054,       # EUC1-EBS:SnapshotUsage
    "nat per GB processed": 0.052,            # EUC1-NatGateway-Bytes (the NAT gateway itself is counted in milestone 1)
    # awskms version 20261026201814
    "kms per request": 0.000003,              # eu-central-1-KMS-Requests ($0.03 per 10 000)
    # AWSSecretsManager version 20260911124610
    "secret per month": 0.40,
    # AmazonS3 version 20261104174445
    "s3 standard per GB-month": 0.0245,
    "s3 put/list per request": 0.0000054,     # EUC1-Requests-Tier1 ($0.0054 per 1 000)
    "s3 get per request": 0.00000043,         # EUC1-Requests-Tier2 ($0.0043 per 10 000)
}
P = PRICE

# ----------------------------------------------------------------- what Terraform creates
MANAGER_EBS_GB = 30                           # fleet.tf, aws_instance.fleet_manager root volume
JOB_EBS_GB = 100                              # fleet.tf, launch template volume
SECRETS = 1                                   # fleet-runner-token
# ----------------------------------------------------------------- ASSUMPTIONS (not measured)
ON_DEMAND_SHARE = 0.20                        # fleet_spot_percent = 80 (default)
OD_TYPE_PRICE = P["ec2 m6i.xlarge per h"]     # On-Demand machines follow the order of the overrides, so m6i.xlarge first; the dearest of the four is used
SPOT_PERCENT_OF_ON_DEMAND = 0.50              # ASSUMPTION: Spot pays 50 % of the On-Demand price. AWS markets savings "up to 90 %"; 50 % is deliberately pessimistic.
SPOT_PERCENT_LOW = 0.35                       # sensitivity: Spot at 35 % of On-Demand
JOB_MINUTES = 8.0                             # ASSUMPTION: average job length
BOOT_MINUTES = 1.5                            # ASSUMPTION: boot, Docker start, SSH connection before the job (the plan says about one minute)
NAT_GB_PER_JOB = 0.5                          # ASSUMPTION: git clone through the load balancer's public address, package downloads; S3 cache traffic uses the gateway endpoint (no NAT cost)
S3_PUT_PER_JOB, S3_GET_PER_JOB = 10, 30       # ASSUMPTION: cache requests per job
KMS_REQUESTS_PER_JOB = 10                     # ASSUMPTION: volume attach and SSE-KMS data keys
CACHE_STORED_GB = 30                          # ASSUMPTION: average cache size with 7-day expiry
AMI_SNAPSHOT_GB, AMIS_KEPT = 6, 2             # ASSUMPTION: used blocks of the image, current and previous image kept
IMAGE_BUILDS_PER_MONTH = 1                    # ASSUMPTION
IMAGE_BUILD_HOURS = 0.5 + 0.3                 # ASSUMPTION: build machine plus test machine, m6i.large
SCENARIOS = [("light", 100), ("medium", 400), ("heavy", 1200)]   # jobs per day

def blended_hour(spot_pct):
    return ON_DEMAND_SHARE * OD_TYPE_PRICE + (1 - ON_DEMAND_SHARE) * spot_pct * OD_TYPE_PRICE

def always_on():
    rows = [
        ("Fleet manager t3.medium, 24 x 7", P["ec2 t3.medium per h"] * H),
        ("Fleet manager root volume %d GB gp3" % MANAGER_EBS_GB, P["ebs gp3 per GB-month"] * MANAGER_EBS_GB),
        ("Runner-token secret (%d)" % SECRETS, P["secret per month"] * SECRETS),
        ("Cache bucket storage, ~%d GB (7-day expiry)" % CACHE_STORED_GB, P["s3 standard per GB-month"] * CACHE_STORED_GB),
        ("Machine image snapshots, %d x %d GB" % (AMIS_KEPT, AMI_SNAPSHOT_GB), P["ebs snapshot per GB-month"] * AMI_SNAPSHOT_GB * AMIS_KEPT),
        ("Image builds, %d a month (Image Builder is free; the build machines are not)" % IMAGE_BUILDS_PER_MONTH,
         IMAGE_BUILDS_PER_MONTH * IMAGE_BUILD_HOURS * P["ec2 m6i.large per h"]),
    ]
    return rows, sum(v for _, v in rows)

def variable(jobs_per_day, spot_pct):
    jobs = jobs_per_day * DAYS
    hours_per_job = (JOB_MINUTES + BOOT_MINUTES) / 60
    inst_hours = jobs * hours_per_job
    rows = [
        ("Job machines: %.0f jobs x %.1f min = %.0f machine-hours at $%.4f/h" % (jobs, JOB_MINUTES + BOOT_MINUTES, inst_hours, blended_hour(spot_pct)), inst_hours * blended_hour(spot_pct)),
        ("Job machine volumes %d GB gp3, same hours" % JOB_EBS_GB, inst_hours * JOB_EBS_GB * P["ebs gp3 per GB-month"] / H),
        ("NAT data processed: %.1f GB per job" % NAT_GB_PER_JOB, jobs * NAT_GB_PER_JOB * P["nat per GB processed"]),
        ("S3 cache requests (%d PUT, %d GET per job)" % (S3_PUT_PER_JOB, S3_GET_PER_JOB), jobs * (S3_PUT_PER_JOB * P["s3 put/list per request"] + S3_GET_PER_JOB * P["s3 get per request"])),
        ("KMS requests (%d per job)" % KMS_REQUESTS_PER_JOB, jobs * KMS_REQUESTS_PER_JOB * P["kms per request"]),
    ]
    return rows, sum(v for _, v in rows)

print(__doc__.split("PRICES")[0].strip())
print()
print("Machine prices per hour, On-Demand (AmazonEC2 20261104210305): m6i.xlarge $0.23, m6a.xlarge $0.207, m5.xlarge $0.23, m5a.xlarge $0.208, t3.medium $0.048")
print("Blended job machine: %d %% On-Demand at $%.3f (m6i.xlarge, the dearest) + %d %% Spot at %d %% of that = $%.4f per hour (Spot at %d %%: $%.4f)" % (
    ON_DEMAND_SHARE * 100, OD_TYPE_PRICE, (1 - ON_DEMAND_SHARE) * 100, SPOT_PERCENT_OF_ON_DEMAND * 100, blended_hour(SPOT_PERCENT_OF_ON_DEMAND), SPOT_PERCENT_LOW * 100, blended_hour(SPOT_PERCENT_LOW)))
print()
rows, fixed = always_on()
print("== Always on (even when no job runs)")
for name, v in rows:
    print("   %-96s $%8.2f" % (name, v))
print("   %-96s $%8.2f" % ("SUBTOTAL always on", fixed))
for label, jpd in SCENARIOS:
    print()
    print("== Scenario %s: %d jobs a day, average job %.0f min, Spot at %d %% of On-Demand" % (label, jpd, JOB_MINUTES, SPOT_PERCENT_OF_ON_DEMAND * 100))
    vrows, var_total = variable(jpd, SPOT_PERCENT_OF_ON_DEMAND)
    for name, v in vrows:
        print("   %-96s $%8.2f" % (name, v))
    print("   %-96s $%8.2f" % ("SUBTOTAL per job", var_total))
    print("   %-96s $%8.2f   (about $%s per year)" % ("TOTAL per month (always on + per job)", fixed + var_total, format(round((fixed + var_total) * 12), ",")))
    _, low = variable(jpd, SPOT_PERCENT_LOW)
    print("   %-96s $%8.2f" % ("  if Spot pays %d %% instead: total" % (SPOT_PERCENT_LOW * 100), fixed + low))
print()
print("Per job (medium scenario): $%.3f (machine, volume, NAT, requests)." % (variable(400, SPOT_PERCENT_OF_ON_DEMAND)[1] / (400 * DAYS)))
print("What moves the number, biggest first: jobs per day; NAT data per job (%.1f GB assumed; each extra 0.1 GB per job costs $%.2f a month at 400 jobs a day);" % (NAT_GB_PER_JOB, 0.1 * 400 * DAYS * P["nat per GB processed"]))
print("the Spot share and price; job length. Levers in this order (plan section 7): fleet_spot_percent, fleet_max_instances, capacity_per_instance above 1, fleet_idle_count above 0.")
print("An idle fleet costs the always-on subtotal only: the group is 0 machines when no job waits and idle_count is 0.")
print()
print("First week's real AWS cost (acceptance A9): ______ (the owner or the next session writes it here beside the estimate above)")
