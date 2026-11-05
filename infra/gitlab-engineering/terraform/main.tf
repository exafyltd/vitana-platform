# Self-hosted GitLab CI, milestone 1 (plan eng-gitlab-m1) in the AWS account vitana-engineering.
# Applied from AWS CloudShell by setup.sh. State: S3 bucket created by setup.sh, locking with use_lockfile.

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0, < 6.0.0"
    }
  }
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "vitana-engineering"
      Plan      = "eng-gitlab-m1"
      ManagedBy = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "domain" {
  type    = string
  default = "gitlab.vitanaland.com"
}

variable "certificate_arn" {
  type = string
}

variable "gitlab_version" {
  type = string
}

variable "runner_version" {
  type = string
}

variable "admin_email" {
  type = string
}

# setup.sh starts with smaller machines when a brand-new AWS account still has a low vCPU limit, and grows them
# (in place, a few minutes of downtime) when it is run again after AWS has raised the limit.
variable "gitlab_instance_type" {
  type    = string
  default = "m6i.xlarge"
}

variable "runner_instance_type" {
  type    = string
  default = "m6i.xlarge"
}

data "aws_caller_identity" "me" {}

data "aws_availability_zones" "az" {
  state = "available"
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

locals {
  azs           = slice(data.aws_availability_zones.az.names, 0, 2)
  backup_bucket = "vitana-engineering-gitlab-backups-${data.aws_caller_identity.me.account_id}"
  vpc_cidr      = "10.20.0.0/16"
  host_files    = ["gitlab-install.sh", "gitlab-configure.sh", "mirror.sh", "backup.sh", "ci-platform.yml", "ci-v1.yml"]

  gitlab_userdata = join("\n", concat(
    [
      "#!/bin/bash",
      "mkdir -p /opt/vitana /etc/vitana",
      "cat > /etc/vitana/env <<'__ENV__'",
      "DOMAIN=${var.domain}",
      "REGION=${var.region}",
      "BACKUP_BUCKET=${local.backup_bucket}",
      "ADMIN_EMAIL=${var.admin_email}",
      "GITLAB_VERSION=${var.gitlab_version}",
      "__ENV__",
    ],
    [for f in local.host_files : "cat > /opt/vitana/${f} <<'__EOF_${replace(f, ".", "_")}__'\n${file("${path.module}/../host/${f}")}\n__EOF_${replace(f, ".", "_")}__"],
    [
      "chmod 0755 /opt/vitana/*.sh",
      "bash /opt/vitana/gitlab-install.sh >> /var/log/vitana-bootstrap.log 2>&1 && bash /opt/vitana/gitlab-configure.sh >> /var/log/vitana-bootstrap.log 2>&1",
      "",
    ],
  ))

  runner_userdata = join("\n", [
    "#!/bin/bash",
    "mkdir -p /opt/vitana /etc/vitana",
    "cat > /etc/vitana/env <<'__ENV__'",
    "DOMAIN=${var.domain}",
    "REGION=${var.region}",
    "RUNNER_VERSION=${var.runner_version}",
    "__ENV__",
    "cat > /opt/vitana/runner-install.sh <<'__EOF_runner__'",
    file("${path.module}/../host/runner-install.sh"),
    "__EOF_runner__",
    "bash /opt/vitana/runner-install.sh >> /var/log/vitana-bootstrap.log 2>&1",
    "",
  ])
}

# ---------------------------------------------------------------- encryption
resource "aws_kms_key" "main" {
  description             = "vitana-engineering: EBS volumes, S3 backups, Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "main" {
  name          = "alias/vitana-engineering"
  target_key_id = aws_kms_key.main.key_id
}

# ------------------------------------------------------------------- network
resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vitana-eng" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "vitana-eng" }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(local.vpc_cidr, 8, count.index)
  availability_zone = local.azs[count.index]
  tags              = { Name = "vitana-eng-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(local.vpc_cidr, 8, count.index + 10)
  availability_zone = local.azs[count.index]
  tags              = { Name = "vitana-eng-private-${count.index}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "vitana-eng-nat" }
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "vitana-eng" }
  depends_on    = [aws_internet_gateway.igw]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = { Name = "vitana-eng-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat.id
  }
  tags = { Name = "vitana-eng-private" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}

# ----------------------------------------------------------- security groups
resource "aws_security_group" "alb" {
  name        = "vitana-eng-alb"
  description = "HTTPS from the internet to the GitLab load balancer"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "gitlab" {
  name        = "vitana-eng-gitlab"
  description = "GitLab host: HTTP from the load balancer only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "runner" {
  name        = "vitana-eng-runner"
  description = "CI runner: no inbound access"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_gitlab" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.gitlab.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "gitlab_from_alb" {
  security_group_id            = aws_security_group.gitlab.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "gitlab_all" {
  security_group_id = aws_security_group.gitlab.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "runner_all" {
  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ------------------------------------------------------------------- storage
resource "aws_s3_bucket" "backups" {
  bucket = local.backup_bucket
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-after-30-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}

data "aws_iam_policy_document" "backups_tls_only" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket     = aws_s3_bucket.backups.id
  policy     = data.aws_iam_policy_document.backups_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.backups]
}

# ------------------------------------------------------------------- secrets
resource "aws_secretsmanager_secret" "root_password" {
  name                    = "vitana/engineering/gitlab/root-password"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "runner_token" {
  name                    = "vitana/engineering/gitlab/runner-token"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "github_token" {
  name                    = "vitana/engineering/gitlab/github-mirror-token"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0
}

# ----------------------------------------------------------------------- IAM
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "gitlab" {
  name               = "vitana-eng-gitlab"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "gitlab_ssm" {
  role       = aws_iam_role.gitlab.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "gitlab" {
  statement {
    sid       = "BackupBucket"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:AbortMultipartUpload"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    sid       = "WriteGeneratedSecrets"
    actions   = ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.root_password.arn, aws_secretsmanager_secret.runner_token.arn]
  }
  statement {
    sid       = "ReadMirrorToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.github_token.arn]
  }
  statement {
    sid       = "UseKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "gitlab" {
  name   = "gitlab"
  role   = aws_iam_role.gitlab.id
  policy = data.aws_iam_policy_document.gitlab.json
}

resource "aws_iam_instance_profile" "gitlab" {
  name = "vitana-eng-gitlab"
  role = aws_iam_role.gitlab.name
}

resource "aws_iam_role" "runner" {
  name               = "vitana-eng-runner"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "runner_ssm" {
  role       = aws_iam_role.runner.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The runner machine may read only its own registration token. CI job containers cannot reach these
# credentials: IMDSv2 is required and the hop limit is 1.
data "aws_iam_policy_document" "runner" {
  statement {
    sid       = "ReadOwnRunnerToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runner_token.arn]
  }
  statement {
    sid       = "UseKey"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "runner" {
  name   = "runner"
  role   = aws_iam_role.runner.id
  policy = data.aws_iam_policy_document.runner.json
}

resource "aws_iam_instance_profile" "runner" {
  name = "vitana-eng-runner"
  role = aws_iam_role.runner.name
}

# ------------------------------------------------------------------ machines
resource "aws_instance" "gitlab" {
  ami                         = data.aws_ssm_parameter.ubuntu.value
  instance_type               = var.gitlab_instance_type
  subnet_id                   = aws_subnet.private[0].id
  vpc_security_group_ids      = [aws_security_group.gitlab.id]
  iam_instance_profile        = aws_iam_instance_profile.gitlab.name
  associate_public_ip_address = false
  user_data_base64            = sensitive(base64gzip(local.gitlab_userdata))

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 200
    encrypted             = true
    kms_key_id            = aws_kms_key.main.arn
    delete_on_termination = true
  }

  tags = { Name = "vitana-eng-gitlab" }

  lifecycle {
    ignore_changes = [ami, user_data_base64]
  }

  depends_on = [
    aws_nat_gateway.nat,
    aws_route_table_association.private,
    aws_iam_role_policy.gitlab,
    aws_iam_role_policy_attachment.gitlab_ssm,
    aws_secretsmanager_secret.root_password,
    aws_secretsmanager_secret.runner_token,
    aws_secretsmanager_secret.github_token,
    aws_s3_bucket_policy.backups,
  ]
}

resource "aws_instance" "runner" {
  ami                         = data.aws_ssm_parameter.ubuntu.value
  instance_type               = var.runner_instance_type
  subnet_id                   = aws_subnet.private[1].id
  vpc_security_group_ids      = [aws_security_group.runner.id]
  iam_instance_profile        = aws_iam_instance_profile.runner.name
  associate_public_ip_address = false
  user_data_base64            = sensitive(base64gzip(local.runner_userdata))

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 100
    encrypted             = true
    kms_key_id            = aws_kms_key.main.arn
    delete_on_termination = true
  }

  tags = { Name = "vitana-eng-runner" }

  lifecycle {
    ignore_changes = [ami, user_data_base64]
  }

  depends_on = [
    aws_nat_gateway.nat,
    aws_route_table_association.private,
    aws_iam_role_policy.runner,
    aws_iam_role_policy_attachment.runner_ssm,
  ]
}

# ------------------------------------------------------------- load balancer
resource "aws_lb" "gitlab" {
  name                       = "vitana-eng-gitlab"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 300
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "gitlab" {
  name     = "vitana-eng-gitlab"
  port     = 80
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
  health_check {
    path                = "/users/sign_in"
    matcher             = "200-399"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}

resource "aws_lb_target_group_attachment" "gitlab" {
  target_group_arn = aws_lb_target_group.gitlab.arn
  target_id        = aws_instance.gitlab.id
  port             = 80
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.gitlab.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gitlab.arn
  }
}

# ------------------------------------------------------------------- outputs
output "alb_dns" {
  value = aws_lb.gitlab.dns_name
}

output "gitlab_instance_id" {
  value = aws_instance.gitlab.id
}

output "runner_instance_id" {
  value = aws_instance.runner.id
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.bucket
}
