# Runner classes main and deploy (plan agentic-delivery §3.2, §5; VTID-05546, lane deploy-path), next to M1's main.tf
# and M2's fleet.tf in the same account, region, VPC and private subnets. M1 and M2 files are not edited here.
#
#   main   (tag vitana-eng-main, a protected runner: protected refs only, main and assist/*): full suites after
#          landing, image builds, STAGING-VERIFY, nightly, assist jobs. Max 12 single-use machines.
#   build  (tag vitana-eng-build, a protected runner like main): only .build-image. The one class whose service containers
#          run without seccomp and AppArmor (the rootless BuildKit daemon), so no other job's services lose them. Max 4.
#   deploy (tag vitana-eng-deploy): only central-script jobs (push image, staging deploy and rollback, previews,
#          record, VTID close, notify). Max 6 single-use machines, On-Demand only (a deploy never loses its machine).
#
# Both classes: min 0 and desired 0 (the runner sets the desired capacity; Terraform ignores it), scale-in protection,
# AZRebalance suspended, IMDSv2 required with hop limit 1, no public IP, no instance profile (so no instance policy: jobs
# get AWS access only through their per-job ID tokens, plan §7), encrypted gp3 with the M1 key, the M2 job image,
# egress tcp 80, tcp 443 and DNS only, and SSH in only from the M2 fleet manager. The manager scales both groups with
# one runner block per class (host/fleet-manager-install.sh, single use, privileged = false); this file gives its role
# the two groups, their machines and their two runner tokens.

variable "fleet_main_max_instances" {
  type    = number
  default = 12
}

variable "fleet_deploy_max_instances" {
  type    = number
  default = 6
}

variable "fleet_build_max_instances" {
  type    = number
  default = 4
}

variable "fleet_main_spot_percent" {
  type    = number
  default = 80
}

# vCPUs the account already needs besides these two classes at the plan's targets: the untrusted class at 96
# machines of 4 vCPUs, the GitLab host at m6i.2xlarge (8), the M1 runner (4) and the fleet manager (2).
variable "fleet_quota_reserved_on_demand_vcpus" {
  type    = number
  default = 398
}

variable "fleet_quota_reserved_spot_vcpus" {
  type    = number
  default = 384
}

locals {
  fleet_class_instance_types = ["m6i.xlarge", "m6a.xlarge", "m5.xlarge", "m5a.xlarge"]
  fleet_class_vcpus          = 4
  fleet_classes = {
    main = {
      name           = "vitana-eng-fleet-main"
      tag            = "vitana-eng-main"
      max_instances  = var.fleet_main_max_instances
      on_demand_base = 0
      spot_percent   = var.fleet_main_spot_percent
    }
    build = {
      name           = "vitana-eng-fleet-build"
      tag            = "vitana-eng-build"
      max_instances  = var.fleet_build_max_instances
      on_demand_base = 0
      spot_percent   = var.fleet_main_spot_percent
    }
    deploy = {
      name           = "vitana-eng-fleet-deploy"
      tag            = "vitana-eng-deploy"
      max_instances  = var.fleet_deploy_max_instances
      on_demand_base = 0
      spot_percent   = 0
    }
  }
  fleet_classes_on_demand_vcpus = sum([for c in local.fleet_classes : c.max_instances * local.fleet_class_vcpus])
  fleet_classes_spot_vcpus      = sum([for c in local.fleet_classes : ceil(c.max_instances * c.spot_percent / 100) * local.fleet_class_vcpus])
}

# ---------------------------------------------------------------- network: egress 80, 443 and DNS; SSH in from the manager
resource "aws_security_group" "fleet_class" {
  for_each    = local.fleet_classes
  name        = "${each.value.name}-job"
  description = "${each.value.tag} job machines: SSH from the fleet manager only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${each.value.name}-job" }
}

resource "aws_vpc_security_group_egress_rule" "fleet_class_http" {
  for_each          = local.fleet_classes
  security_group_id = aws_security_group.fleet_class[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "fleet_class_https" {
  for_each          = local.fleet_classes
  security_group_id = aws_security_group.fleet_class[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "fleet_class_dns_udp" {
  for_each          = local.fleet_classes
  security_group_id = aws_security_group.fleet_class[each.key].id
  cidr_ipv4         = aws_vpc.main.cidr_block
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "fleet_class_dns_tcp" {
  for_each          = local.fleet_classes
  security_group_id = aws_security_group.fleet_class[each.key].id
  cidr_ipv4         = aws_vpc.main.cidr_block
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

# The runner's Docker connection to a class machine runs through SSH from the M2 fleet manager (a one-time key sent
# through EC2 Instance Connect, as for the untrusted fleet). Nothing else comes in.
resource "aws_vpc_security_group_ingress_rule" "fleet_class_ssh_from_manager" {
  for_each                     = local.fleet_classes
  security_group_id            = aws_security_group.fleet_class[each.key].id
  referenced_security_group_id = aws_security_group.fleet_manager.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "fleet_manager_ssh_to_class" {
  for_each                     = local.fleet_classes
  security_group_id            = aws_security_group.fleet_manager.id
  referenced_security_group_id = aws_security_group.fleet_class[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

# ---------------------------------------------------------------- machines
resource "aws_launch_template" "fleet_class" {
  for_each               = local.fleet_classes
  name                   = each.value.name
  image_id               = one(aws_imagebuilder_image.fleet.output_resources[0].amis).image
  update_default_version = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  network_interfaces {
    associate_public_ip_address = false
    delete_on_termination       = true
    security_groups             = [aws_security_group.fleet_class[each.key].id]
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 100
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = aws_kms_key.main.arn
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = each.value.name, RunnerClass = each.value.tag }
  }
}

# The volumes use the M1 key, whose key policy is the default one: the groups launch through M2's custom-suffix Auto
# Scaling role, which holds the grant on it (fleet.tf); Spot launches use the Spot role's grant.
resource "aws_autoscaling_group" "fleet_class" {
  for_each                = local.fleet_classes
  name                    = each.value.name
  min_size                = 0
  desired_capacity        = 0
  max_size                = each.value.max_instances
  vpc_zone_identifier     = aws_subnet.private[*].id
  protect_from_scale_in   = true
  capacity_rebalance      = false
  suspended_processes     = ["AZRebalance"]
  force_delete            = true
  service_linked_role_arn = aws_iam_service_linked_role.fleet_autoscaling.arn

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = each.value.on_demand_base
      on_demand_percentage_above_base_capacity = 100 - each.value.spot_percent
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.fleet_class[each.key].id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = local.fleet_class_instance_types
        content {
          instance_type = override.value
        }
      }
    }
  }

  tag {
    key                 = "Name"
    value               = each.value.name
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }

  depends_on = [aws_kms_grant.fleet_autoscaling, aws_kms_grant.fleet_spot]
}

# Runner authentication tokens: the settings sync creates the runners (main as a protected runner, ref_protected) and
# stores their glrt- tokens here; the fleet manager reads them (policy below) and renders one runner block per class.
resource "aws_secretsmanager_secret" "fleet_class_runner_token" {
  for_each                = local.fleet_classes
  name                    = "vitana/engineering/gitlab/${each.value.name}-runner-token"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0
}

# ---------------------------------------------------------------- the fleet manager's part (M2 role, not edited)
# The fleeting plugin scales each class group and opens SSH to its machines; the installer reads the two class
# tokens. Describing groups and machines and decrypting with the M1 key are already in the M2 manager policy.
data "aws_iam_policy_document" "fleet_manager_classes" {
  statement {
    sid       = "ScaleClassGroups"
    actions   = ["autoscaling:SetDesiredCapacity", "autoscaling:SetInstanceProtection", "autoscaling:TerminateInstanceInAutoScalingGroup"]
    resources = [for g in aws_autoscaling_group.fleet_class : g.arn]
  }
  statement {
    sid       = "ConnectToClassMachines"
    actions   = ["ec2-instance-connect:SendSSHPublicKey"]
    resources = ["arn:aws:ec2:${var.region}:${data.aws_caller_identity.me.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/aws:autoscaling:groupName"
      values   = [for c in local.fleet_classes : c.name]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:osuser"
      values   = ["ubuntu"]
    }
  }
  statement {
    sid       = "ReadClassRunnerTokens"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.fleet_class_runner_token : s.arn]
  }
}

resource "aws_iam_role_policy" "fleet_manager_classes" {
  name   = "fleet-manager-classes"
  role   = aws_iam_role.fleet_manager.id
  policy = data.aws_iam_policy_document.fleet_manager_classes.json
}

# ---------------------------------------------------------------- quota: the check prints the request
data "aws_servicequotas_service_quota" "fleet_on_demand_standard" {
  service_code = "ec2"
  quota_code   = "L-1216C47A"
}

data "aws_servicequotas_service_quota" "fleet_spot_standard" {
  service_code = "ec2"
  quota_code   = "L-34B43A08"
}

check "fleet_classes_vcpu_quota" {
  assert {
    condition     = data.aws_servicequotas_service_quota.fleet_on_demand_standard.value >= local.fleet_classes_on_demand_vcpus + var.fleet_quota_reserved_on_demand_vcpus
    error_message = "On-Demand Standard vCPU quota ${data.aws_servicequotas_service_quota.fleet_on_demand_standard.value} is below ${local.fleet_classes_on_demand_vcpus + var.fleet_quota_reserved_on_demand_vcpus}. Request it: aws service-quotas request-service-quota-increase --region ${var.region} --service-code ec2 --quota-code L-1216C47A --desired-value ${local.fleet_classes_on_demand_vcpus + var.fleet_quota_reserved_on_demand_vcpus}"
  }
  assert {
    condition     = data.aws_servicequotas_service_quota.fleet_spot_standard.value >= local.fleet_classes_spot_vcpus + var.fleet_quota_reserved_spot_vcpus
    error_message = "Spot Standard vCPU quota ${data.aws_servicequotas_service_quota.fleet_spot_standard.value} is below ${local.fleet_classes_spot_vcpus + var.fleet_quota_reserved_spot_vcpus}. Request it: aws service-quotas request-service-quota-increase --region ${var.region} --service-code ec2 --quota-code L-34B43A08 --desired-value ${local.fleet_classes_spot_vcpus + var.fleet_quota_reserved_spot_vcpus}"
  }
}

output "fleet_class_groups" {
  value = { for k, g in aws_autoscaling_group.fleet_class : k => g.name }
}
