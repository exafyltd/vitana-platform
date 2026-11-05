# Autoscaling CI fleet, milestone 2 (plan eng-gitlab-m2, section 3.2, lane fleet).
# Lives next to main.tf of milestone 1 and uses its VPC, private subnets, KMS key, NAT gateway, naming and data sources by reference.
# main.tf is not edited. Every variable here has a default, so `setup.sh` applies this file with no new -var flag.
#
# What this builds: an Auto Scaling group that is 0 machines until the runner manager asks for one, one throw-away machine per CI job,
# the manager machine that runs the GitLab Runner, the cache bucket, and the empty secret that will hold the runner's token.
# The job machines hold no AWS permission and no secret: their instance profile has no policy.

variable "fleet_max_instances" {
  type        = number
  default     = 24
  description = "Most job machines at the same time. Also `concurrent` and `max_instances` of the runner. Needs fleet_max_instances x 4 vCPUs in both Standard quotas."
  validation {
    condition     = var.fleet_max_instances >= 1 && var.fleet_max_instances <= 500 && var.fleet_max_instances == floor(var.fleet_max_instances)
    error_message = "fleet_max_instances must be a whole number from 1 to 500."
  }
}

variable "fleet_idle_count" {
  type        = number
  default     = 0
  description = "Machines kept ready for the next job. 0 means every job waits about a minute for its machine to boot, and nothing is paid while idle."
  validation {
    condition     = var.fleet_idle_count >= 0 && var.fleet_idle_count <= var.fleet_max_instances && var.fleet_idle_count == floor(var.fleet_idle_count)
    error_message = "fleet_idle_count must be a whole number from 0 up to fleet_max_instances."
  }
}

variable "fleet_spot_percent" {
  type        = number
  default     = 80
  description = "Share of job machines bought as Spot capacity. The rest is On-Demand."
  validation {
    condition     = var.fleet_spot_percent >= 0 && var.fleet_spot_percent <= 100 && var.fleet_spot_percent == floor(var.fleet_spot_percent)
    error_message = "fleet_spot_percent must be a whole number from 0 to 100."
  }
}

variable "fleet_create_spot_service_role" {
  type        = bool
  default     = true
  description = "Create the AWSServiceRoleForEC2Spot service-linked role. Set to false only when the account already has it (the apply says 'has been taken')."
}

locals {
  fleet_asg_name       = "vitana-eng-fleet"
  fleet_cache_bucket   = "vitana-engineering-ci-cache-${data.aws_caller_identity.me.account_id}"
  fleet_instance_types = ["m6i.xlarge", "m6a.xlarge", "m5.xlarge", "m5a.xlarge"]
  fleet_required_vcpus = var.fleet_max_instances * 4
  fleet_spot_role_arn  = "arn:aws:iam::${data.aws_caller_identity.me.account_id}:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot"
  fleet_tags           = { Plan = "eng-gitlab-m2", Lane = "fleet" }

  fleet_manager_userdata = join("\n", [
    "#!/bin/bash",
    "mkdir -p /opt/vitana /etc/vitana",
    "cat > /etc/vitana/env <<'__ENV__'",
    "DOMAIN=${var.domain}",
    "REGION=${var.region}",
    "RUNNER_VERSION=${var.runner_version}",
    "FLEET_ASG_NAME=${local.fleet_asg_name}",
    "FLEET_MAX_INSTANCES=${var.fleet_max_instances}",
    "FLEET_IDLE_COUNT=${var.fleet_idle_count}",
    "FLEET_CACHE_BUCKET=${local.fleet_cache_bucket}",
    "FLEET_CACHE_KMS_KEY_ARN=${aws_kms_key.main.arn}",
    "FLEET_TOKEN_SECRET=${aws_secretsmanager_secret.fleet_runner_token.name}",
    "__ENV__",
    "cat > /opt/vitana/fleet-manager-install.sh <<'__EOF_fleet_manager__'",
    file("${path.module}/../host/fleet-manager-install.sh"),
    "__EOF_fleet_manager__",
    "bash /opt/vitana/fleet-manager-install.sh >> /var/log/vitana-bootstrap.log 2>&1",
    "",
  ])
}

# ---------------------------------------------------------------------- quota
# A new AWS account starts with low vCPU limits. The fleet needs fleet_max_instances x 4 vCPUs in both the On-Demand and the Spot
# "Standard" quotas. This stops the apply, before anything of the fleet exists, and prints the exact commands for the owner.
# The On-Demand quota is read by its code (documented with its name in the AWS CLI documentation). The Spot quota is read by the name
# the EC2 documentation gives it; the code in the message is the one AWS returns.
data "aws_servicequotas_service_quota" "fleet_ondemand" {
  service_code = "ec2"
  quota_code   = "L-1216C47A"
}

data "aws_servicequotas_service_quota" "fleet_spot" {
  service_code = "ec2"
  quota_name   = "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests"
}

# The command lines in the messages start with spaces on purpose: Terraform wraps a message line to the terminal width unless it starts
# with a space, and a wrapped command cannot be pasted.
resource "terraform_data" "fleet_quota_check" {
  lifecycle {
    precondition {
      condition     = data.aws_servicequotas_service_quota.fleet_ondemand.value >= local.fleet_required_vcpus
      error_message = <<-EOT
        The On-Demand Standard vCPU quota in ${var.region} is ${data.aws_servicequotas_service_quota.fleet_ondemand.value}; the fleet needs ${local.fleet_required_vcpus} (fleet_max_instances ${var.fleet_max_instances} x 4 vCPUs).
        Ask AWS to raise it, wait for the approval, then run the apply again:
          aws service-quotas request-service-quota-increase --service-code ec2 --quota-code ${data.aws_servicequotas_service_quota.fleet_ondemand.quota_code} --desired-value ${local.fleet_required_vcpus} --region ${var.region}
      EOT
    }
    precondition {
      condition     = data.aws_servicequotas_service_quota.fleet_spot.value >= local.fleet_required_vcpus
      error_message = <<-EOT
        The Spot Standard vCPU quota in ${var.region} is ${data.aws_servicequotas_service_quota.fleet_spot.value}; the fleet needs ${local.fleet_required_vcpus} (fleet_max_instances ${var.fleet_max_instances} x 4 vCPUs).
        Ask AWS to raise it, wait for the approval, then run the apply again:
          aws service-quotas request-service-quota-increase --service-code ec2 --quota-code ${data.aws_servicequotas_service_quota.fleet_spot.quota_code} --desired-value ${local.fleet_required_vcpus} --region ${var.region}
      EOT
    }
    precondition {
      condition     = data.aws_servicequotas_service_quota.fleet_ondemand.quota_name == "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances"
      error_message = "Quota code L-1216C47A is no longer the On-Demand Standard vCPU quota (AWS returned '${data.aws_servicequotas_service_quota.fleet_ondemand.quota_name}'). Look the code up again with: aws service-quotas list-service-quotas --service-code ec2"
    }
  }
}

# ------------------------------------------------------------ key access (KMS)
# The job machines' volumes are encrypted with the engineering key of milestone 1, whose key policy is the default one. The service-linked
# roles of Auto Scaling and of Spot have no access to a customer managed key, so without these grants the first scale-up fails with
# Client.InternalError. A custom-suffix Auto Scaling role is used (AWS recommends it for a key that not everyone may use), so the grant
# does not depend on the default role, which only exists after the first group is created.
resource "aws_iam_service_linked_role" "fleet_autoscaling" {
  aws_service_name = "autoscaling.amazonaws.com"
  custom_suffix    = "vitana-eng-fleet"
  description      = "Auto Scaling role of the CI fleet (holds the grant on the engineering key)"
}

resource "aws_iam_service_linked_role" "fleet_spot" {
  count            = var.fleet_create_spot_service_role ? 1 : 0
  aws_service_name = "spot.amazonaws.com"
}

resource "aws_kms_grant" "fleet_autoscaling" {
  name              = "vitana-eng-fleet-autoscaling"
  key_id            = aws_kms_key.main.arn
  grantee_principal = aws_iam_service_linked_role.fleet_autoscaling.arn
  operations        = ["Encrypt", "Decrypt", "ReEncryptFrom", "ReEncryptTo", "GenerateDataKey", "GenerateDataKeyWithoutPlaintext", "DescribeKey", "CreateGrant"]
}

resource "aws_kms_grant" "fleet_spot" {
  name              = "vitana-eng-fleet-spot"
  key_id            = aws_kms_key.main.arn
  grantee_principal = local.fleet_spot_role_arn
  operations        = ["Encrypt", "Decrypt", "ReEncryptFrom", "ReEncryptTo", "GenerateDataKey", "GenerateDataKeyWithoutPlaintext", "DescribeKey", "CreateGrant"]
  depends_on        = [aws_iam_service_linked_role.fleet_spot]
}

# ------------------------------------------------------------ security groups
# Job machines: the manager may open SSH (the runner's Docker connection runs through it), nothing else comes in. Out: web (80, 443)
# and DNS inside the VPC. The GitLab host accepts traffic from its load balancer only (main.tf), so its private address is unreachable.
resource "aws_security_group" "fleet_job" {
  name        = "vitana-eng-fleet-job"
  description = "CI job machines: SSH from the fleet manager only"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.fleet_tags, { Name = "vitana-eng-fleet-job" })
}

resource "aws_security_group" "fleet_manager" {
  name        = "vitana-eng-fleet-manager"
  description = "CI fleet manager: no inbound access"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.fleet_tags, { Name = "vitana-eng-fleet-manager" })
}

resource "aws_vpc_security_group_ingress_rule" "fleet_job_ssh_from_manager" {
  security_group_id            = aws_security_group.fleet_job.id
  referenced_security_group_id = aws_security_group.fleet_manager.id
  from_port                    = 22
  to_port                      = 22
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_job_http" {
  security_group_id = aws_security_group.fleet_job.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_job_https" {
  security_group_id = aws_security_group.fleet_job.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_job_dns_udp" {
  security_group_id = aws_security_group.fleet_job.id
  cidr_ipv4         = local.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_job_dns_tcp" {
  security_group_id = aws_security_group.fleet_job.id
  cidr_ipv4         = local.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_manager_ssh_to_jobs" {
  security_group_id            = aws_security_group.fleet_manager.id
  referenced_security_group_id = aws_security_group.fleet_job.id
  from_port                    = 22
  to_port                      = 22
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_manager_http" {
  security_group_id = aws_security_group.fleet_manager.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_manager_https" {
  security_group_id = aws_security_group.fleet_manager.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_manager_dns_udp" {
  security_group_id = aws_security_group.fleet_manager.id
  cidr_ipv4         = local.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "fleet_manager_dns_tcp" {
  security_group_id = aws_security_group.fleet_manager.id
  cidr_ipv4         = local.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

# ------------------------------------------------------------------------ IAM
# Job machines: a role with NO policy. Nothing on a job machine can call AWS, and the metadata service is closed to job containers
# (IMDSv2 required, hop limit 1).
resource "aws_iam_role" "fleet_job" {
  name               = "vitana-eng-fleet-job"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.fleet_tags
}

resource "aws_iam_instance_profile" "fleet_job" {
  name = "vitana-eng-fleet-job"
  role = aws_iam_role.fleet_job.name
}

# Manager: exactly what the fleeting plugin and the S3 cache need (plan 3.2). The cache URLs are signed here, so the job machines need
# no storage permission. No stored SSH key: the plugin sends a one-time key through EC2 Instance Connect.
resource "aws_iam_role" "fleet_manager" {
  name               = "vitana-eng-fleet-manager"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.fleet_tags
}

resource "aws_iam_role_policy_attachment" "fleet_manager_ssm" {
  role       = aws_iam_role.fleet_manager.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "fleet_manager" {
  statement {
    sid       = "ScaleThisGroup"
    actions   = ["autoscaling:SetDesiredCapacity", "autoscaling:SetInstanceProtection", "autoscaling:TerminateInstanceInAutoScalingGroup"]
    resources = [aws_autoscaling_group.fleet.arn]
  }
  statement {
    sid       = "DescribeGroupAndMachines"
    actions   = ["autoscaling:DescribeAutoScalingGroups", "ec2:DescribeInstances", "ec2:DescribeSpotInstanceRequests"]
    resources = ["*"]
  }
  statement {
    sid       = "ConnectToJobMachines"
    actions   = ["ec2-instance-connect:SendSSHPublicKey"]
    resources = ["arn:aws:ec2:${var.region}:${data.aws_caller_identity.me.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/aws:autoscaling:groupName"
      values   = [local.fleet_asg_name]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:osuser"
      values   = ["ubuntu"]
    }
  }
  statement {
    sid       = "ReadRunnerToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.fleet_runner_token.arn]
  }
  statement {
    sid       = "CacheBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.fleet_cache.arn, "${aws_s3_bucket.fleet_cache.arn}/*"]
  }
  statement {
    sid       = "UseKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "fleet_manager" {
  name   = "fleet-manager"
  role   = aws_iam_role.fleet_manager.id
  policy = data.aws_iam_policy_document.fleet_manager.json
}

resource "aws_iam_instance_profile" "fleet_manager" {
  name = "vitana-eng-fleet-manager"
  role = aws_iam_role.fleet_manager.name
}

# -------------------------------------------------------------------- secrets
# Created empty. The settings sync creates the runner in GitLab and writes its authentication token here; the manager waits for it.
resource "aws_secretsmanager_secret" "fleet_runner_token" {
  name                    = "vitana/engineering/gitlab/fleet-runner-token"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0
  tags                    = local.fleet_tags
}

# ---------------------------------------------------------------------- cache
resource "aws_s3_bucket" "fleet_cache" {
  bucket = local.fleet_cache_bucket
  tags   = local.fleet_tags
}

resource "aws_s3_bucket_public_access_block" "fleet_cache" {
  bucket                  = aws_s3_bucket.fleet_cache.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "fleet_cache" {
  bucket = aws_s3_bucket.fleet_cache.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "fleet_cache" {
  bucket = aws_s3_bucket.fleet_cache.id
  rule {
    id     = "expire-after-7-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

data "aws_iam_policy_document" "fleet_cache_tls_only" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.fleet_cache.arn, "${aws_s3_bucket.fleet_cache.arn}/*"]
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

resource "aws_s3_bucket_policy" "fleet_cache" {
  bucket     = aws_s3_bucket.fleet_cache.id
  policy     = data.aws_iam_policy_document.fleet_cache_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.fleet_cache]
}

# --------------------------------------------------------------------- group
resource "aws_launch_template" "fleet" {
  name_prefix            = "vitana-eng-fleet-"
  image_id               = one(aws_imagebuilder_image.fleet.output_resources[0].amis).image
  update_default_version = true

  iam_instance_profile {
    name = aws_iam_instance_profile.fleet_job.name
  }

  network_interfaces {
    associate_public_ip_address = false
    delete_on_termination       = true
    security_groups             = [aws_security_group.fleet_job.id]
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = 100
      encrypted             = true
      kms_key_id            = aws_kms_key.main.arn
      delete_on_termination = true
    }
  }

  # default_tags do not reach machines the group launches, so the tags are set here.
  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.fleet_tags, { Name = "vitana-eng-fleet-job", Project = "vitana-engineering", ManagedBy = "terraform" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(local.fleet_tags, { Name = "vitana-eng-fleet-job", Project = "vitana-engineering", ManagedBy = "terraform" })
  }

  tags = local.fleet_tags

  lifecycle {
    create_before_destroy = true
  }
}

# min 0 / desired 0: the runner manager sets the desired size, one machine per job, and deletes each machine after its job.
# Scaling policy none, AZRebalance suspended and scale-in protection on are what the fleeting plugin requires.
resource "aws_autoscaling_group" "fleet" {
  name                    = local.fleet_asg_name
  min_size                = 0
  desired_capacity        = 0
  max_size                = var.fleet_max_instances
  vpc_zone_identifier     = aws_subnet.private[*].id
  protect_from_scale_in   = true
  capacity_rebalance      = false
  suspended_processes     = ["AZRebalance"]
  force_delete            = true
  health_check_type       = "EC2"
  service_linked_role_arn = aws_iam_service_linked_role.fleet_autoscaling.arn

  wait_for_capacity_timeout = "0"

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 100 - var.fleet_spot_percent
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.fleet.id
        version            = aws_launch_template.fleet.latest_version
      }
      dynamic "override" {
        for_each = local.fleet_instance_types
        content {
          instance_type = override.value
        }
      }
    }
  }

  tag {
    key                 = "Name"
    value               = "vitana-eng-fleet-job"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }

  depends_on = [
    terraform_data.fleet_quota_check,
    aws_kms_grant.fleet_autoscaling,
    aws_kms_grant.fleet_spot,
  ]
}

# ------------------------------------------------------------------- manager
# Runs the GitLab Runner and the fleeting plugin. No Docker, no job runs here. It starts after the group exists, so a failed image build
# (which stops the apply before the launch template) leaves neither a group nor a manager.
resource "aws_instance" "fleet_manager" {
  ami                         = data.aws_ssm_parameter.ubuntu.value
  instance_type               = "t3.medium"
  subnet_id                   = aws_subnet.private[1].id
  vpc_security_group_ids      = [aws_security_group.fleet_manager.id]
  iam_instance_profile        = aws_iam_instance_profile.fleet_manager.name
  associate_public_ip_address = false
  user_data_base64            = sensitive(base64gzip(local.fleet_manager_userdata))

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    kms_key_id            = aws_kms_key.main.arn
    delete_on_termination = true
  }

  tags = merge(local.fleet_tags, { Name = "vitana-eng-fleet-manager" })

  lifecycle {
    ignore_changes = [ami, user_data_base64]
  }

  depends_on = [
    aws_nat_gateway.nat,
    aws_route_table_association.private,
    aws_iam_role_policy.fleet_manager,
    aws_iam_role_policy_attachment.fleet_manager_ssm,
    aws_secretsmanager_secret.fleet_runner_token,
    aws_s3_bucket_policy.fleet_cache,
    aws_autoscaling_group.fleet,
  ]
}

# ------------------------------------------------------------------- outputs
output "fleet_asg_name" {
  value = aws_autoscaling_group.fleet.name
}

output "fleet_manager_instance_id" {
  value = aws_instance.fleet_manager.id
}

output "fleet_cache_bucket" {
  value = aws_s3_bucket.fleet_cache.bucket
}

output "fleet_runner_token_secret" {
  description = "Name (not value) of the secret the settings sync writes the runner token to."
  value       = aws_secretsmanager_secret.fleet_runner_token.name
}

output "fleet_ami_id" {
  value = one(aws_imagebuilder_image.fleet.output_resources[0].amis).image
}
