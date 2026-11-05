# Engineering Platform: components and their licences

Read on 2026-11-05 for plan `eng-gitlab-m2`, lane `settings` (VTID-05542). Owner decision 2026-11-03: GitLab runs on the Free tier and the only cost is AWS usage (see the [change log in the platform plan](ENGINEERING-PLATFORM-PLAN.md#9-change-log-free-tier-amendment)).

This list names every component the self-hosted GitLab CI uses and the licence found in that component's own repository or vendor page. Every URL below was fetched and read on the date above; no licence was written from memory. Where a page could not be read, the row says so and [section 4](#4-what-could-not-be-read) repeats it. The list is built from `infra/gitlab-engineering/` (`setup.sh`, `terraform/main.tf`, `host/*.sh`, `host/*.yml`, `RUNBOOK.md`), `.github/workflows/UNIT.yml` and plan `eng-gitlab-m2` (§3.2 fleet, §3.3 settings, §3.6 monitoring). Rows marked "plan" belong to M2 lanes whose files are not in this tree yet.

## 1. Result
- No component needs a paid GitLab licence. GitLab runs without a licence key, which GitLab documents as the Free tier. No subscription and no seat is bought.
- The cost to us is AWS usage only ([section 3.4](#34-aws-and-other-services)).
- Two licences are not open source and need a plain reading: GitLab's EE licence for the `ee/` code ([2.1](#21-gitlab-enterprise-edition-the-package-we-install)) and Terraform's Business Source License ([2.2](#22-terraform)). Neither charges us.
- Everything else read is a permissive or copyleft free-software licence, or an AWS service billed by usage. A few pages could not be read and a few components are not itemised (section 4).

## 2. The licences that are not open source, read plainly

### 2.1 GitLab Enterprise Edition (the package we install)
**What the licence files say.** GitLab's root `LICENSE` puts the code outside `doc/`, `ee/` and `jh/` under the MIT Expat licence, `doc/` under CC BY-SA 4.0, and everything under `ee/` under the licence in `ee/LICENSE`. The EE licence is not open source. It allows production use only for someone who has agreed to GitLab's subscription terms (or another agreement with GitLab) and holds "a valid GitLab Enterprise Edition subscription for the correct number of user seats". It forbids copying, merging, publishing, distributing, sublicensing and selling the software.

**What GitLab says about running EE without a key.** GitLab's documentation says a new instance installed without a licence has only Free features enabled. GitLab's CE-or-EE page says the EE package can run with Free features without a paid subscription, and advises EE for a new self-managed instance even if it stays on Free. The Subscription Agreement defines "Free Software" as the free, feature-limited version including the lowest tier, provides it as-is without indemnification, and lets GitLab update the terms for customers who use only Free Software by posting them at <https://about.gitlab.com/terms/>.

**What it means for us.** We install GitLab's unmodified package on our own machines and run it with no licence key. GitLab's published position is that this is the Free tier and costs nothing; our use is under GitLab's terms, not under an open-source licence. In practice: no fee and no seat count; we do not copy or redistribute the package or its `ee/` code; paid features stay off because no key is present, and the settings sync stops with a loud message if a licence ever appears (plan `eng-gitlab-m2` §3.3); GitLab can change the Free terms by posting them. The exit is the Community Edition package (MIT licence, read in the GitLab FOSS repository: <https://gitlab.com/gitlab-org/gitlab-foss/-/raw/master/LICENSE>), which has the Free feature set; the move from EE to CE was not checked. This is a reading of the texts above, not legal advice, and no lawyer was asked.

### 2.2 Terraform
**What the licence file says.** `LICENSE` of Terraform v1.17.1 is the Business Source License 1.1 (licensor: International Business Machines Corporation; licensed work: Terraform 1.6.0 or later). It grants copying, modification, redistribution and non-production use, plus an Additional Use Grant for production use that does not offer Terraform to third parties, hosted or embedded, to compete with IBM's paid versions. The grant says hosting or using it for internal purposes within an organisation is not a competitive offering. Each version converts to MPL 2.0 on its Change Date, four years after publication. MariaDB, which wrote the BSL text, states that the BSL is not an Open Source licence.

**What it means for us.** The owner runs `terraform plan` and `apply` against Vitana's own AWS account. That is internal use, so production use is allowed and costs nothing. It would stop being allowed if Vitana offered Terraform, hosted or embedded, to others as a product that competes with IBM's. The licence names HashiCorp's licence FAQ as its binding interpretation; that page could not be read (HTTP 429), so we rely on the licence text alone. Exits: Terraform up to 1.5.x is MPL 2.0 (<https://raw.githubusercontent.com/hashicorp/terraform/v1.5.7/LICENSE> read) but `main.tf` needs 1.10 or newer (`required_version`); OpenTofu is MPL 2.0 (<https://raw.githubusercontent.com/opentofu/opentofu/main/LICENSE> read), and whether it runs this configuration with `use_lockfile` was not checked. The AWS provider is MPL 2.0, so the BUSL covers the Terraform program only.

### 2.3 Redis inside the GitLab package
GitLab 19.5.3 builds Redis 7.2.16 into its package (the Omnibus recipe at tag `19.5.3+ee.0` says `license 'BSD-3-Clause'`), and the BSD text was read in the Redis repository (branch 7.2). Redis's own licence page says 7.2.x and earlier stay under BSD-3-Clause, 7.4 to 7.8 use RSALv2 or SSPLv1, and Redis 8 adds AGPLv3; it calls RSALv2 and SSPLv1 not open source licences. The pinned GitLab therefore has the BSD one. When GitLab is upgraded, read the recipe again: if it moves past Redis 7.2, this row changes.

### 2.4 Docker
Docker Engine (Moby, in the `docker.io` package) and its runtime parts (Docker CLI, containerd, runc) are Apache-2.0, read in their repositories. Docker Desktop is a different product under the Docker Subscription Service Agreement: free for small businesses (fewer than 250 employees and under US$10 million annual revenue), personal use, education and non-commercial open source, and a paid subscription for professional use in larger organisations (<https://docs.docker.com/subscription/desktop-license/>, read). The platform does not use Docker Desktop. If a company laptop runs it for this work, read that page first.

### 2.5 Ubuntu
Ubuntu is an aggregate of packages, each under its own licence. Canonical's IP rights policy (<https://canonical.com/legal/intellectual-property-policy>) lets anyone download, install and update Ubuntu for free, modify it for personal or internal use, and redistribute it only unmodified. We use Canonical's standard AMI, found through the SSM parameter in `terraform/main.tf`, with no Ubuntu Pro (there is no `pro attach` and no Ubuntu Pro AMI in `infra/gitlab-engineering/`, `scripts/eng/` or `UNIT.yml`). The fleet AMI that EC2 Image Builder makes (plan §3.2) is a modified Ubuntu used only inside Vitana's AWS account, which the policy allows. Do not share that AMI outside the company without reading the policy again.

### 2.6 GPL packages
git is GPL-2.0 only, GnuPG is GPL-3.0 or later, Perl is GPL or Artistic, and the `ca-certificates` scripts are GPL-2.0 or later. We install the distribution's unmodified packages and do not distribute them, so no source-offer obligation arises. The GPL-2.0 text says running a program is not restricted (section 0, read in git's `COPYING`).


## 3. Components

Columns: the pin is the version fixed in our files (`file:line`), or "none" when the file does not pin one. "Paid GitLab licence?" asks whether this component needs a GitLab subscription. "Cost to us" is the fee for the software itself. The last column is the exact URL read.

### 3.1 GitLab, runner and autoscaling

| Component | Where we use it and pin | Licence found | Paid GitLab licence? | Cost to us | URL read |
|---|---|---|---|---|---|
| GitLab EE package `gitlab-ee` | `setup.sh:27` `GITLAB_VERSION=19.5.3-ee.0`; installed at `host/gitlab-install.sh:60`, held at `:61` | Outside `doc/`, `ee/`, `jh/`: MIT Expat. `ee/`: GitLab Enterprise Edition (EE) License, not open source. `doc/`: CC BY-SA 4.0. Run with no licence key = Free tier ([2.1](#21-gitlab-enterprise-edition-the-package-we-install)) | No. Free tier, no key | None | <https://gitlab.com/gitlab-org/gitlab/-/raw/v19.5.3-ee/LICENSE>, <https://gitlab.com/gitlab-org/gitlab/-/raw/v19.5.3-ee/ee/LICENSE>; Free-tier statements <https://about.gitlab.com/gitlab-community-edition/>, <https://docs.gitlab.com/administration/license/>; terms <https://handbook.gitlab.com/handbook/legal/subscription-agreement/> |
| PostgreSQL 17.11, built into the GitLab package (D4 as built in M1) | no pin of ours; the package carries it | PostgreSQL License | No | None | <https://gitlab.com/gitlab-org/omnibus-gitlab/-/raw/19.5.3%2Bee.0/config/software/postgresql.rb> (names the licence and 17.11), <https://raw.githubusercontent.com/postgres/postgres/REL_17_STABLE/COPYRIGHT> |
| Redis 7.2.16, built into the GitLab package | no pin of ours; the package carries it | BSD-3-Clause ([2.3](#23-redis-inside-the-gitlab-package)) | No | None | <https://gitlab.com/gitlab-org/omnibus-gitlab/-/raw/19.5.3%2Bee.0/config/software/redis.rb>, <https://raw.githubusercontent.com/redis/redis/7.2/COPYING>, <https://redis.io/legal/licenses/> |
| GitLab Runner `gitlab-runner` | `setup.sh:28` `RUNNER_VERSION=19.5.2-1`; `host/runner-install.sh:26-27` | MIT | No. GitLab's runner pages show Free, Premium, Ultimate | None | <https://gitlab.com/gitlab-org/gitlab-runner/-/raw/v19.5.2/LICENSE>, <https://docs.gitlab.com/ci/runners/configure_runners/> |
| Runner executors: Docker (M1, `host/runner-install.sh:43`) and Docker Autoscaler (M2 plan §3.2) | part of the Runner binary, same pin | MIT, same repository as the row above | No. Autoscaling page shows Free, Premium, Ultimate | None | <https://docs.gitlab.com/runner/runner_autoscale/>, <https://docs.gitlab.com/runner/executors/docker_autoscaler/> |
| fleeting and taskscaler, GitLab's autoscaler libraries (plan §3.2) | none; whether the Runner links taskscaler was not checked in its `go.mod` | MIT (both) | No | None | <https://gitlab.com/gitlab-org/fleeting/fleeting/-/raw/main/LICENSE>, <https://gitlab.com/gitlab-org/fleeting/taskscaler/-/raw/main/LICENSE> |
| fleeting-plugin-aws, the `aws` plugin (plan §3.2, installed with `gitlab-runner fleeting install`) | none yet | MIT, "Copyright (c) 2015-present GitLab B.V." | No | None. It calls AWS APIs; its recommended IAM policy is in its README | <https://gitlab.com/gitlab-org/fleeting/plugins/aws/-/raw/main/LICENSE>, <https://gitlab.com/gitlab-org/fleeting/plugins/aws/-/raw/main/README.md> |

### 3.2 Build and CI tools

| Component | Where we use it and pin | Licence found | Paid GitLab licence? | Cost to us | URL read |
|---|---|---|---|---|---|
| Terraform CLI | `setup.sh:26` `TF_VERSION=1.17.1`, downloaded at `setup.sh:264`; `terraform/main.tf:5` `required_version = ">= 1.10.0"` | Business Source License 1.1; change licence MPL 2.0 ([2.2](#22-terraform)). The `LICENSE.txt` inside the downloaded zip is byte-identical to the tag's file (checked with `cmp`) | No | None. Internal use is permitted | <https://raw.githubusercontent.com/hashicorp/terraform/v1.17.1/LICENSE>; BSL not open source: <https://mariadb.com/bsl-faq-adopting/> |
| Terraform provider `hashicorp/aws` | `terraform/main.tf:9` `>= 5.60.0, < 6.0.0`; resolved to v5.100.0 at `docs/validation/VTID-05544/outputs/terraform-checks.txt:10-11` | Mozilla Public License 2.0 | No | None | <https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v5.100.0/LICENSE> |
| AWS CLI v2 | `host/gitlab-install.sh:14-16`, `host/runner-install.sh:14-16`; none (always the latest zip) | Apache License 2.0 | No | None | <https://raw.githubusercontent.com/aws/aws-cli/v2/LICENSE.txt> |
| Docker Engine (`docker.io`, built from Moby), with the Docker CLI, containerd and runc ([2.4](#24-docker)) | `host/runner-install.sh:11`; none (Ubuntu 24.04 archive carried `29.1.3-0ubuntu3~24.04.2` when read); also in the M2 fleet AMI (plan §3.2) | Apache License 2.0 (all four) | No | None | <https://raw.githubusercontent.com/moby/moby/master/LICENSE>, <https://raw.githubusercontent.com/docker/cli/master/LICENSE>, <https://raw.githubusercontent.com/containerd/containerd/main/LICENSE>, <https://raw.githubusercontent.com/opencontainers/runc/main/LICENSE>; packaging: <https://sources.debian.org/src/docker.io/latest/debian/copyright/>, <https://packages.ubuntu.com/noble/docker.io>, <https://packages.ubuntu.com/noble/containerd> |
| Node.js 20 | CI job image `public.ecr.aws/docker/library/node:20-bookworm` at `host/ci-platform.yml:11`, `host/ci-v1.yml:11`, `host/runner-install.sh:44`, `host/runner-fix.sh:21`; `.github/workflows/UNIT.yml:20` `node-version: 20`; the tag floats within 20.x | MIT, plus the separate licences of the libraries bundled in the same file | No | None | <https://raw.githubusercontent.com/nodejs/node/v20.x/LICENSE> |
| Docker `node` image packaging (Debian bookworm base, Yarn 1 bundled) | same lines as above | MIT for the packaging repository. Yarn 1: BSD 2-Clause. The image's base is Debian, per its README | No | None. Pulling from public ECR to AWS compute is free ([3.4](#34-aws-and-other-services)). The registry path itself was not read | <https://raw.githubusercontent.com/nodejs/docker-node/main/LICENSE>, <https://raw.githubusercontent.com/nodejs/docker-node/main/README.md>, <https://raw.githubusercontent.com/yarnpkg/yarn/master/LICENSE> |
| npm (bundled with Node) | `npm ci` at `host/ci-v1.yml:27`, `host/ci-platform.yml:40` | Artistic License 2.0. The public registry is free under the npm Open Source Terms | No | None. No `.npmrc` is tracked in vitana-platform; vitana-v1 was not scanned | <https://raw.githubusercontent.com/npm/cli/latest/LICENSE>, <https://docs.npmjs.com/policies/terms> |
| pnpm 9.0.0 | `host/ci-platform.yml:27` `npm install -g pnpm@9.0.0` | MIT | No | None | <https://raw.githubusercontent.com/pnpm/pnpm/v9.0.0/LICENSE> |
| PyYAML 6.0.3 (lane checks only, not deployed) | `/projects/sandbox/tools/pylib` in the agent sandbox, used to parse YAML in lane evidence | MIT | No | None | <https://raw.githubusercontent.com/yaml/pyyaml/main/LICENSE> |

### 3.3 Operating system and agents

None of these is pinned by us; they are the versions in the Ubuntu 24.04 archive (or the vendor's current download) on the day a machine is built. Base tools that ship with the Ubuntu image (bash, coreutils, util-linux, systemd) are covered by the Ubuntu row.

| Component | Where we use it | Licence found | Paid GitLab licence? | Cost to us | URL read |
|---|---|---|---|---|---|
| Ubuntu 24.04 LTS (both hosts, and the M2 fleet AMI per plan §3.2) | `terraform/main.tf:70-72` reads the AMI id from the Canonical SSM parameter; `setup.sh:138` | Aggregate of packages, each under its own licence; Canonical's IP rights policy governs the images ([2.5](#25-ubuntu)) | No | None. No Ubuntu Pro | <https://canonical.com/legal/intellectual-property-policy> |
| curl | `host/gitlab-install.sh:11`, `host/runner-install.sh:11` | curl licence (permissive: use, copy, modify and distribute for any purpose, with or without fee) | No | None | <https://raw.githubusercontent.com/curl/curl/master/COPYING> |
| ca-certificates | `host/gitlab-install.sh:11`, `host/runner-install.sh:11` | GPL-2.0 or later for the Debian scripts; MPL-2.0 for Mozilla's certificate data | No | None | <https://sources.debian.org/src/ca-certificates/latest/debian/copyright/> |
| unzip | `host/gitlab-install.sh:11` and `:15`, `host/runner-install.sh:11` and `:15` | Info-ZIP licence (permission to use for any purpose, including commercial, with conditions on redistribution) | No | None | <https://infozip.sourceforge.net/license.html>, <https://sources.debian.org/src/unzip/latest/debian/copyright/> |
| jq | `host/gitlab-install.sh:11`, `host/runner-install.sh:11` | MIT; documentation under CC BY 3.0; some bundled code under its own notices | No | None | <https://raw.githubusercontent.com/jqlang/jq/master/COPYING> |
| git | `host/gitlab-install.sh:11` | GNU GPL version 2 only ([2.6](#26-gpl-packages)) | No | None | <https://raw.githubusercontent.com/git/git/master/COPYING> |
| openssh-server | `host/gitlab-install.sh:11` | BSD-style licences (2-clause, 3-clause and others, itemised in the file) | No | None | <https://raw.githubusercontent.com/openssh/openssh-portable/master/LICENCE> |
| perl | `host/gitlab-install.sh:11` | GPL-1.0 or later, or the Artistic License | No | None | <https://raw.githubusercontent.com/Perl/perl5/blead/README> (section LICENSING), <https://sources.debian.org/src/perl/latest/debian/copyright/> |
| tzdata | `host/gitlab-install.sh:11` | Public domain | No | None | <https://raw.githubusercontent.com/eggert/tz/main/LICENSE>, <https://sources.debian.org/src/tzdata/latest/debian/copyright/> |
| gnupg | `host/gitlab-install.sh:11` | GPL-3.0 or later | No | None | <https://raw.githubusercontent.com/gpg/gnupg/master/COPYING>, <https://sources.debian.org/src/gnupg2/latest/debian/copyright/> |
| openssl | called at `host/gitlab-install.sh:34` and `host/gitlab-configure.sh:27` (`openssl rand`) | Apache License 2.0 (as read in the current `master` branch; the version in the Ubuntu archive was not checked) | No | None | <https://raw.githubusercontent.com/openssl/openssl/master/LICENSE.txt> |
| Python 3 (inside AWS CloudShell, where the owner runs `setup.sh`) | `setup.sh:265` unpacks the Terraform zip with `zipfile` | Python Software Foundation License Version 2 | No | None | <https://raw.githubusercontent.com/python/cpython/main/LICENSE> |
| Amazon SSM Agent (preinstalled on Ubuntu AMIs; the hosts are reached only through SSM) | `terraform/main.tf`, policy attachments `gitlab_ssm` and `runner_ssm` (`AmazonSSMManagedInstanceCore`) | Apache License 2.0 | No | None | <https://raw.githubusercontent.com/aws/amazon-ssm-agent/mainline/LICENSE>, <https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-startup-security-baseline/wkld-06.html> |
| EC2 Instance Connect guest package `ec2-instance-connect` (plan §3.2, fleet AMI) | none yet | Apache License 2.0 | No | None | <https://raw.githubusercontent.com/aws/aws-ec2-instance-connect-config/master/LICENSE> |
| Amazon CloudWatch agent (plan, lane `monitoring`, disk metric) | none yet | MIT | No | None | <https://raw.githubusercontent.com/aws/amazon-cloudwatch-agent/main/LICENSE> |

### 3.4 AWS and other services

These are services, not software. Their terms are the AWS Customer Agreement (<https://aws.amazon.com/agreement/>, read in part) and the service terms behind it. The cost is usage, with no licence fee to GitLab or anyone else.

| Service | Where we use it | Cost basis, from the page read | URL read |
|---|---|---|---|
| EC2 | GitLab host, runner host, M2 fleet manager and job machines (Spot for most jobs, plan §3.2) | Per hour or second, no commitment; Elastic IP addresses are charged | <https://aws.amazon.com/ec2/pricing/on-demand/>, <https://aws.amazon.com/ec2/spot/pricing/> |
| EBS (gp3 volumes, KMS encrypted) | `terraform/main.tf` root volumes of 200 GB and 100 GB | Per GB-month provisioned | <https://aws.amazon.com/ebs/pricing/> |
| VPC: NAT gateway and S3 gateway endpoint | `terraform/main.tf` `aws_nat_gateway.nat`, `aws_vpc_endpoint.s3` | NAT: per hour plus per GB processed. Gateway endpoints: no hourly or processing charge | <https://aws.amazon.com/vpc/pricing/> |
| Application Load Balancer | `terraform/main.tf` `aws_lb.gitlab` | Per hour plus LCUs | <https://aws.amazon.com/elasticloadbalancing/pricing/> |
| ACM public certificate | `setup.sh` `ensure_cert` | Free for ACM-integrated services such as Elastic Load Balancing | <https://aws.amazon.com/certificate-manager/faqs/> |
| S3 | backup bucket, state bucket (M1); cache bucket (plan §3.2) | Storage, requests and data transfer | <https://aws.amazon.com/s3/pricing/> |
| KMS | key `alias/vitana-engineering` | Per key per month plus requests above the free tier | <https://aws.amazon.com/kms/pricing/> |
| Secrets Manager | `vitana/engineering/gitlab/*` secrets | Per secret per month plus API calls | <https://aws.amazon.com/secrets-manager/pricing/> |
| IAM and STS | roles and instance profiles | No additional charge | <https://docs.aws.amazon.com/IAM/latest/UserGuide/introduction.html> |
| Systems Manager: Session Manager, Run Command | access to both hosts; `RUNBOOK.md` sections 2 and 8 | No additional cost on EC2 instances (interface VPC endpoints would be charged; we use none) | <https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html>, <https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-startup-security-baseline/wkld-06.html> |
| AWS CloudShell | where the owner runs `setup.sh` | No additional charge | <https://aws.amazon.com/cloudshell/pricing/> |
| EC2 Image Builder (plan §3.2) | builds the fleet AMI | No cost to use; the services it uses are billed | <https://docs.aws.amazon.com/imagebuilder/latest/userguide/what-is-image-builder.html> |
| EC2 Auto Scaling (plan §3.2) | the `vitana-eng-fleet` group | No additional fee beyond EC2 and CloudWatch | <https://aws.amazon.com/ec2/autoscaling/pricing/> |
| EC2 Instance Connect (plan §3.2) | one-time SSH key for job machines | No additional cost | <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Connect-using-EC2-Instance-Connect.html> |
| CloudWatch, SNS, AWS Budgets (plan §3.6) | alarms, alert topic, monthly budget | CloudWatch and SNS: pay for use. Monitoring budgets: free | <https://aws.amazon.com/cloudwatch/pricing/>, <https://aws.amazon.com/sns/pricing/>, <https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/> |
| Amazon ECR Public (source of the `node` job image) | `public.ecr.aws/docker/library/node` | Transfer from a public repository to AWS compute in any Region is free | <https://aws.amazon.com/ecr/pricing/> |
| Cloudflare DNS (zone `vitanaland.com`, existing) | two records written by `setup.sh` (certificate validation and `gitlab`) | DNS is listed in every Cloudflare plan including Free; our zone's plan was not checked. Cloudflare's terms page returned no text | <https://www.cloudflare.com/plans/> |

## 4. What could not be read
Pages that failed or returned no text on 2026-11-05, and what that leaves open:
- HashiCorp's licence FAQ, `https://www.hashicorp.com/license-faq` (HTTP 429 on two attempts). The Terraform licence text names it as the binding interpretation of the Additional Use Grant. Our internal use rests on the licence text alone ([2.2](#22-terraform)).
- AWS Organizations pricing, `https://aws.amazon.com/organizations/pricing/` (HTTP 404). The engineering account is a member account created by `setup.sh`; no cost for Organizations is assumed or claimed.
- EC2 Image Builder's pricing page, `https://aws.amazon.com/image-builder/pricing/` (HTTP 404). Its user guide page was read instead (section 3.4).
- Cloudflare's terms, `https://www.cloudflare.com/terms/` (no text returned), and the plan of the existing `vitanaland.com` zone.
- The Redis `COPYING` at tag `7.2.16` returned no text; the file on branch `7.2` was read (section 3.1).

Not itemised, or not checked:
- The other components inside the GitLab package (nginx, Git, Ruby, Gitaly and more). GitLab's root `LICENSE` says each keeps its own licence. The package's licence manifest was not read. Only PostgreSQL and Redis, which the platform relies on directly (decision D4), were read.
- Terms of services we download from: the GitLab apt repository (`packages.gitlab.com`), the Terraform Registry, the npm registry beyond its Terms of Use page, and Docker's own apt repository. The last is not used; if the `fleet` lane picks `docker-ce` from it, add a row.
- GitHub, the source of the mirror, is an existing service of the organisation. The mirror uses a read-only token and git over HTTPS. No GitHub page was read.
- vitana-v1 was not scanned for npm configuration or private registries.
- Not tested: whether OpenTofu runs our configuration, whether moving from EE to CE works, and whether the Runner links `taskscaler`.

## 5. Keeping this list current
Read the rows again when a pin changes (`setup.sh:26-28`, the provider constraint at `terraform/main.tf:9`), when a new `apt install` line or container image appears, when the `fleet` and `monitoring` lanes add their files (their rows say "none yet"), or when a GitLab upgrade changes the Redis version in its recipe. The settings sync (plan `eng-gitlab-m2` §3.3) also stops with a loud message if `GET /license` ever returns a licence, so a paid licence cannot appear without anyone noticing.
