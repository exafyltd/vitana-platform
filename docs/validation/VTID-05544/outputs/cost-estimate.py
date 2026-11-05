#!/usr/bin/env python3
"""Monthly cost estimate of milestone 1 (plan eng-gitlab-m1 section 7), from the AWS price list, region eu-central-1.

Prices are read from the AWS public price list files of the dates below (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/<version>/eu-central-1/index.json)
and written here as constants so the arithmetic can be checked by hand. Usage that depends on traffic is a stated assumption, not a measurement.
Excluded on purpose: data transfer out to the internet, EBS snapshots, CloudWatch, AWS Organizations (free), Terraform state (cents).
"""
H = 730  # hours in an average month (24 * 365 / 12)

PRICE = {  # USD, eu-central-1, on demand
    "ec2 m6i.xlarge per h": 0.23,        # AmazonEC2 20261104210305
    "ec2 m6i.large per h": 0.115,
    "nat gateway per h": 0.052,          # AmazonEC2 20261104210305, EUC1-NatGateway-Hours
    "nat per GB processed": 0.052,       # EUC1-NatGateway-Bytes
    "ebs gp3 per GB-month": 0.0952,      # AmazonEC2 20261104210305 (3000 IOPS and 125 MB/s are included in the gp3 base price)
    "alb per h": 0.027,                  # AWSELB 20261102102527, EUC1-LoadBalancerUsage
    "alb per LCU-h": 0.008,              # EUC1-LCUUsage
    "public ipv4 per h": 0.005,          # AmazonVPC 20261103000947, EUC1-PublicIPv4:InUseAddress
    "kms key per month": 1.00,           # awskms 20261026201814
    "kms per request": 0.000003,
    "secret per month": 0.40,            # AWSSecretsManager 20260911124610
    "secrets api per request": 0.000005,
    "s3 standard per GB-month": 0.0245,  # AmazonS3 20261104174445, first 50 TB
}
P = PRICE

def machines(gitlab, runner):
    return (P[gitlab] + P[runner]) * H

# what the Terraform creates (infra/gitlab-engineering/terraform/main.tf)
EBS_GB = 200 + 100                   # GitLab 200 GB + runner 100 GB root volumes (main.tf, root_block_device)
PUBLIC_IPV4 = 1 + 2                  # 1 Elastic IP of the NAT gateway + 1 public address per ALB node, 2 subnets -> 2 nodes (assumption: 2)
NAT_GB = 150                         # assumption: image pulls, apt, GitHub mirror fetch, package installs per month
ALB_LCU = 1.0                        # assumption: below one LCU on average (a handful of users)
SECRETS = 3                          # root-password, runner-token, github-mirror-token (main.tf)
KMS_REQUESTS = 300_000               # assumption: secret reads, backups and EBS use
SECRETS_API = 300_000                # assumption: the mirror reads its token every 5 minutes (8 640/month) plus status calls
BACKUP_GB = 40                       # assumption: nightly backups kept 30 days; a compressed backup of the two mirrored repositories and their data, order 1-2 GB each
                                     # (bucket lifecycle expires objects after 30 days, main.tf)

def total(gitlab, runner):
    rows = [
        ("EC2 GitLab + runner machines", machines(gitlab, runner)),
        ("NAT gateway hours (1)", P["nat gateway per h"] * H),
        ("NAT data processed", P["nat per GB processed"] * NAT_GB),
        ("EBS gp3 %d GB" % EBS_GB, P["ebs gp3 per GB-month"] * EBS_GB),
        ("Application load balancer hours", P["alb per h"] * H),
        ("Application load balancer LCU", P["alb per LCU-h"] * ALB_LCU * H),
        ("Public IPv4 addresses (%d)" % PUBLIC_IPV4, P["public ipv4 per h"] * PUBLIC_IPV4 * H),
        ("KMS key (1) + requests", P["kms key per month"] + P["kms per request"] * KMS_REQUESTS),
        ("Secrets Manager (%d secrets) + API" % SECRETS, P["secret per month"] * SECRETS + P["secrets api per request"] * SECRETS_API),
        ("S3 backups %d GB" % BACKUP_GB, P["s3 standard per GB-month"] * BACKUP_GB),
    ]
    return rows, sum(v for _, v in rows)

for label, g, r in (("full size: two m6i.xlarge (the default of setup.sh)", "ec2 m6i.xlarge per h", "ec2 m6i.xlarge per h"),
                    ("start size: two m6i.large (setup.sh falls back to it while the new account's vCPU limit is low)", "ec2 m6i.large per h", "ec2 m6i.large per h")):
    rows, t = total(g, r)
    print(f"== {label}")
    for name, v in rows:
        print(f"   {name:<44} ${v:>8.2f}")
    print(f"   {'TOTAL per month':<44} ${t:>8.2f}   (about ${t * 12:,.0f} per year)\n")
print("Not included: data transfer out to the internet, snapshots, CloudWatch, the autoscaling job machines of milestone 2.")
print("The two machines and the NAT gateway are 24 x 7 costs; EC2 and NAT are %.0f%% of the full-size total." % (100 * (machines('ec2 m6i.xlarge per h', 'ec2 m6i.xlarge per h') + P['nat gateway per h'] * H) / total('ec2 m6i.xlarge per h', 'ec2 m6i.xlarge per h')[1]))
