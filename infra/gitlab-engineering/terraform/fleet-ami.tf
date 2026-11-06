# Machine image of the CI job machines (plan eng-gitlab-m2, section 3.2, lane fleet), built by EC2 Image Builder.
# Ubuntu 24.04 (the image milestone 1 already uses), Docker Engine, EC2 Instance Connect, user `ubuntu` in group `docker`, the Node 20 job
# image and the runner helper image for runner_version pre-pulled. No runner binary, no key, no secret.
#
# The apply waits for the build. If the build or its test phase fails, aws_imagebuilder_image fails, so the launch template, the group
# and the manager (which depend on it) are never created: no half-built fleet.

variable "fleet_image_revision" {
  type        = string
  default     = "1"
  description = "Change this value to build a new machine image (for example to pick up newer Ubuntu packages). The group uses the new image for the next machine it starts."
}

locals {
  fleet_job_image           = "public.ecr.aws/docker/library/node:20-bookworm"
  fleet_runner_semver       = regex("^[0-9]+\\.[0-9]+\\.[0-9]+", var.runner_version)
  fleet_runner_helper_image = "registry.gitlab.com/gitlab-org/gitlab-runner/gitlab-runner-helper:x86_64-v${local.fleet_runner_semver}"
  # Components and recipes are immutable, so their names carry a hash of everything that goes into the image.
  fleet_image_hash = substr(sha256(join("|", [
    file("${path.module}/../host/fleet-image/component.yml"),
    local.fleet_job_image,
    local.fleet_runner_helper_image,
    var.fleet_image_revision,
  ])), 0, 10)
}

# ------------------------------------------------------------ build machine
resource "aws_iam_role" "fleet_image" {
  name               = "vitana-eng-fleet-image"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.fleet_tags
}

# The two policies AWS documents as the prerequisite of an Image Builder instance profile. The role is used by the build machine only.
resource "aws_iam_role_policy_attachment" "fleet_image_builder" {
  role       = aws_iam_role.fleet_image.name
  policy_arn = "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder"
}

resource "aws_iam_role_policy_attachment" "fleet_image_ssm" {
  role       = aws_iam_role.fleet_image.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "fleet_image" {
  name = "vitana-eng-fleet-image"
  role = aws_iam_role.fleet_image.name
}

resource "aws_imagebuilder_infrastructure_configuration" "fleet" {
  name                          = "vitana-eng-fleet"
  instance_profile_name         = aws_iam_instance_profile.fleet_image.name
  instance_types                = ["m6i.large", "m5.large"]
  subnet_id                     = aws_subnet.private[0].id
  security_group_ids            = [aws_security_group.fleet_job.id]
  terminate_instance_on_failure = true

  instance_metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = local.fleet_tags

  # The profile policies must exist before Image Builder checks them.
  depends_on = [
    aws_iam_role_policy_attachment.fleet_image_builder,
    aws_iam_role_policy_attachment.fleet_image_ssm,
    aws_nat_gateway.nat,
    aws_route_table_association.private,
  ]
}

# --------------------------------------------------------------------- image
resource "aws_imagebuilder_component" "fleet" {
  name               = "vitana-eng-fleet-${local.fleet_image_hash}"
  version            = "1.0.0"
  platform           = "Linux"
  change_description = "Docker Engine, EC2 Instance Connect and the pre-pulled job images for the CI fleet"
  data               = file("${path.module}/../host/fleet-image/component.yml")
  tags               = local.fleet_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_imagebuilder_image_recipe" "fleet" {
  name         = "vitana-eng-fleet-${local.fleet_image_hash}"
  version      = "1.0.0"
  parent_image = data.aws_ssm_parameter.ubuntu.value
  description  = "Ubuntu 24.04 with Docker Engine for the Vitana engineering CI fleet"

  component {
    component_arn = aws_imagebuilder_component.fleet.arn
    parameter {
      name  = "JobImage"
      value = local.fleet_job_image
    }
    parameter {
      name  = "RunnerHelperImage"
      value = local.fleet_runner_helper_image
    }
  }

  # The image snapshot is encrypted with the default EBS key; each job machine's volume is encrypted again with the engineering key by the
  # launch template. The image holds public software only.
  block_device_mapping {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  tags = local.fleet_tags

  lifecycle {
    create_before_destroy = true
    # A newer Canonical image never starts a rebuild by itself; change fleet_image_revision to do that on purpose.
    ignore_changes = [parent_image]
  }
}

resource "aws_imagebuilder_image" "fleet" {
  image_recipe_arn                 = aws_imagebuilder_image_recipe.fleet.arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.fleet.arn
  tags                             = local.fleet_tags

  image_tests_configuration {
    image_tests_enabled = true
    timeout_minutes     = 60
  }

  # The apply waits for the build (about 20 to 30 minutes) and fails if it fails.
  timeouts {
    create = "90m"
  }

  lifecycle {
    create_before_destroy = true
  }
}
