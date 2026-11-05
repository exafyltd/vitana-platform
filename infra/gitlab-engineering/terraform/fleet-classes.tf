# Runner classes main and deploy (plan agentic-delivery §3.2, §5; VTID-05546, lane deploy-path), next to M1's main.tf
# and M2's fleet.tf in the same account, region, VPC and private subnets. M1 and M2 files are not edited here.
#
#   main   (tag vitana-eng-main, a protected runner: protected refs only, main and assist/*): full suites after
#          landing, image builds, STAGING-VERIFY, nightly, assist jobs. Max 12 single-use machines.
#   deploy (tag vitana-eng-deploy): only central-script jobs (push image, staging deploy and rollback, previews,
#          record, VTID close, notify). Max 6 single-use machines, On-Demand only (a deploy never loses its machine).
#
# Both classes: min 0 and desired 0 (the runner sets the desired capacity; Terraform ignores it), scale-in protection,
# AZRebalance suspended, IMDSv2 required with hop limit 1, no public IP, no instance profile (so no instance policy: jobs
# get AWS access only through their per-job ID tokens, plan §7), encrypted gp3 with the M1 key, egress tcp 80, tcp 443
# and DNS only. Single use (max_use_count = 1), privileged = false and the per-class runner blocks are rendered by
# host/fleet-manager-install.sh (M2 lane fleet), which also gets the SSH ingress from the fleet manager and the
# manager's permissions on these two groups: that edit waits until M2's fleet.tf is on main.

variable "fleet_class_ami_id" {
  description = "AMI of the job machines: the M2 job image (EC2 Image Builder output of fleet.tf)."
  type        = string
  default     = ""
}

variable "fleet_main_max_instances" {
  type    = number
  default = 12
}

variable "fleet_deploy_max_instances" {
  type    = number
  default = 6
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

# ---------------------------------------------------------------- network: egress 80, 443 and DNS only
resource "aws_security_group" "fleet_class" {
  for_each    = local.fleet_classes
  name        = "${each.value.name}-job"
  description = "${each.value.tag} job machines: egress 80, 443 and DNS only"
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

# ---------------------------------------------------------------- machines
resource "aws_launch_template" "fleet_class" {
  for_each               = local.fleet_classes
  name                   = each.value.name
  image_id               = var.fleet_class_ami_id
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

  lifecycle {
    precondition {
      condition     = var.fleet_class_ami_id != ""
      error_message = "Set fleet_class_ami_id to the M2 job image (fleet.tf) before applying the runner classes."
    }
  }
}

resource "aws_autoscaling_group" "fleet_class" {
  for_each              = local.fleet_classes
  name                  = each.value.name
  min_size              = 0
  desired_capacity      = 0
  max_size              = each.value.max_instances
  vpc_zone_identifier   = aws_subnet.private[*].id
  protect_from_scale_in = true
  capacity_rebalance    = false
  suspended_processes   = ["AZRebalance"]

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
}

# Runner authentication tokens: the settings sync creates the runners (main as a protected runner, ref_protected) and
# stores their glrt- tokens here; the fleet manager reads them (M2 lane fleet grants that read).
resource "aws_secretsmanager_secret" "fleet_class_runner_token" {
  for_each   = local.fleet_classes
  name       = "vitana/engineering/gitlab/${each.value.name}-runner-token"
  kms_key_id = aws_kms_key.main.arn
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
