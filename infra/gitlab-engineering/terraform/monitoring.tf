# Monitoring of the self-hosted GitLab CI, milestone 2 (plan eng-gitlab-m2, lane monitoring, plan section 3.6).
#
# A second file of the same Terraform module as main.tf (milestone 1): same provider, state, region, account, GitLab machine, load
# balancer and role, used by reference. Nothing in main.tf is edited. Every variable here has a default, so the owner's existing
# setup.sh apply (which passes only the milestone 1 variables) keeps working without a new -var flag.
#
# What the owner gets: an e-mail when CI is down, stuck, not backed up or over budget, and nothing while it is healthy.
# The alarms send a mail when they go into ALARM and send nothing when they clear (no ok_actions): a quiet inbox is the signal that
# all is well. A heartbeat that goes quiet is an alarm (treat_missing_data = breaching); a queue number that is missing is not
# (notBreaching), because the metrics job publishes the failure metric GitLabReadFailed instead of a zero when GitLab cannot be read.
#
# On the first apply the heartbeat alarms (backup age and the two ticks) have no data until the metrics job runs on the GitLab host,
# which starts after the owner's `m2.sh install`. Up to three mails ("no completed tick", "no backup") in the first quarter of an
# hour are expected and clear by themselves once the timers have run.

locals {
  monitoring_namespace = "Vitana/Engineering"
  # The owner's address: alert_email when it is given, else the admin_email that setup.sh already passes for the GitLab root user.
  monitoring_alert_email = trimspace(var.alert_email != "" ? var.alert_email : var.admin_email)
}

variable "alert_email" {
  type        = string
  default     = ""
  description = "Address that receives every alarm and budget mail. Empty (the default) means the admin_email that setup.sh already passes. AWS sends a confirmation mail to it once; alarms reach it only after that link is clicked (m2.sh status shows an unconfirmed subscription)."
}

# Default 1000 dollars a month. The always-on cost of milestone 1 is 452.20 dollars at full size and 284.30 at the start size
# (docs/validation/VTID-05544/outputs/cost-estimate.txt, AWS price list of 2026-11-04); milestone 2 adds the fleet manager (a t3.medium,
# 35.04 dollars at 0.048 an hour), about 12 more secrets and this lane (5.66 dollars, docs/validation/VTID-05539/outputs/cost-estimate.txt),
# so the floor is 497.70 dollars at full size. The job machines are billed only while jobs run and come on top. 1000 is twice
# the floor: the 50 percent mail (500) marks the floor plus the first job machines, expect it late in most months once jobs run at
# full size; 80 percent (800) means jobs cost 300 dollars or more and is the one to look at; 100 percent is the stop sign. At the start
# size (floor about 330) the 50 percent mark needs 170 dollars of job machines. Raise or lower it with monthly_budget_usd.
variable "monthly_budget_usd" {
  type        = number
  default     = 1000
  description = "Monthly AWS budget in US dollars for the whole engineering account. Mails go out at 50, 80 and 100 percent of the actual cost."

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be more than 0."
  }
}

variable "fleet_alarm_running_jobs" {
  type        = number
  default     = 24
  description = "Number of running fleet jobs at which the fleet counts as at its maximum. Keep it equal to fleet_max_instances (default 24, plan section 3.2): one job runs on one machine."

  validation {
    condition     = var.fleet_alarm_running_jobs >= 1
    error_message = "fleet_alarm_running_jobs must be at least 1."
  }
}

# ------------------------------------------------------------------- the topic
# The topic has its own key. CloudWatch can publish to an encrypted topic only when the key policy names cloudwatch.amazonaws.com,
# and the key of milestone 1 has the default policy, which names no AWS service; its policy lives in main.tf, which this lane may
# not edit. The AWS managed key for SNS cannot be used either, because its policy cannot be changed.
data "aws_iam_policy_document" "alerts_key" {
  statement {
    sid       = "EnableIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.me.account_id}:root"]
    }
  }
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.me.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:${var.region}:${data.aws_caller_identity.me.account_id}:alarm:*"]
    }
  }
}

resource "aws_kms_key" "alerts" {
  description             = "vitana-engineering: the alerts topic (a key CloudWatch alarms may use)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.alerts_key.json
}

resource "aws_kms_alias" "alerts" {
  name          = "alias/vitana-engineering-alerts"
  target_key_id = aws_kms_key.alerts.key_id
}

resource "aws_sns_topic" "alerts" {
  name              = "vitana-eng-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn
}

# An e-mail subscription starts as PendingConfirmation: AWS mails a link, and nothing is delivered until it is clicked.
resource "aws_sns_topic_subscription" "owner_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = local.monitoring_alert_email

  lifecycle {
    precondition {
      condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", local.monitoring_alert_email))
      error_message = "alert_email (or, when it is empty, admin_email) must be an e-mail address, because every alarm and budget mail goes to it."
    }
  }
}

# ------------------------------------------------------------------- the host role
# The GitLab host (the metrics job and the CloudWatch agent run on it) may publish metrics to one namespace. PutMetricData has no
# resource-level permission, so the resource is * and the namespace condition is the limit. Reading the backup bucket needs nothing new:
# the role of main.tf already lists it.
data "aws_iam_policy_document" "monitoring" {
  statement {
    sid       = "PublishEngineeringMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.monitoring_namespace]
    }
  }
}

resource "aws_iam_role_policy" "monitoring" {
  name   = "monitoring"
  role   = aws_iam_role.gitlab.id
  policy = data.aws_iam_policy_document.monitoring.json
}

# ------------------------------------------------------------------- queue alarms: a missing number is not an incident
# The metrics job publishes these once a minute while it can read GitLab. When it cannot, it publishes GitLabReadFailed instead and
# these metrics have no datapoint, which must not raise an alarm of its own.
resource "aws_cloudwatch_metric_alarm" "oldest_pending_job" {
  alarm_name          = "vitana-eng-oldest-pending-job"
  alarm_description   = "A CI job has waited more than 10 minutes for a machine. The fleet is not starting machines, is out of quota or capacity, or the runner manager is down. Metric OldestPendingJobAgeSeconds, published once a minute by the metrics job on the GitLab host."
  namespace           = local.monitoring_namespace
  metric_name         = "OldestPendingJobAgeSeconds"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 600
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "fleet_at_maximum" {
  alarm_name          = "vitana-eng-fleet-at-maximum"
  alarm_description   = "The CI fleet has been running as many jobs as it may for 30 minutes, so new jobs wait. Raise fleet_max_instances (and fleet_alarm_running_jobs) if this is the normal load. Metric FleetRunningJobs."
  namespace           = local.monitoring_namespace
  metric_name         = "FleetRunningJobs"
  statistic           = "Minimum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.fleet_alarm_running_jobs
  period              = 60
  evaluation_periods  = 30
  datapoints_to_alarm = 30
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ------------------------------------------------------------------- the GitLab host
resource "aws_cloudwatch_metric_alarm" "gitlab_host_status" {
  alarm_name        = "vitana-eng-gitlab-host-status"
  alarm_description = "The GitLab machine fails its EC2 status check, or it has stopped reporting. GitLab and every CI job are down or about to be. Check the instance in the EC2 console."
  namespace         = "AWS/EC2"
  metric_name       = "StatusCheckFailed"
  dimensions = {
    InstanceId = aws_instance.gitlab.id
  }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# disk_used_percent comes from the CloudWatch agent that host/ops.d/20-cwagent.sh installs; it is rolled up to the InstanceId dimension.
resource "aws_cloudwatch_metric_alarm" "gitlab_disk_used" {
  alarm_name        = "vitana-eng-gitlab-disk-used"
  alarm_description = "The root volume of the GitLab machine is more than 80 percent full. GitLab stops working when it is full: free space or grow the volume. Metric disk_used_percent from the CloudWatch agent."
  namespace         = local.monitoring_namespace
  metric_name       = "disk_used_percent"
  dimensions = {
    InstanceId = aws_instance.gitlab.id
  }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "gitlab_lb_unhealthy_target" {
  alarm_name        = "vitana-eng-gitlab-lb-unhealthy-target"
  alarm_description = "The load balancer reports GitLab as unhealthy (its sign-in page does not answer), so nobody can reach GitLab. GitLab may be restarting after an upgrade; if it stays like this, look at the machine."
  namespace         = "AWS/ApplicationELB"
  metric_name       = "UnHealthyHostCount"
  dimensions = {
    LoadBalancer = aws_lb.gitlab.arn_suffix
    TargetGroup  = aws_lb_target_group.gitlab.arn_suffix
  }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ------------------------------------------------------------------- heartbeats: silence is an alarm
# BackupAgeSeconds and TickAgeSeconds are published by the metrics job from what it can see on the host. If the number is above the
# limit, or there is no number at all (the job, the host or the listing is down), the alarm goes off.
resource "aws_cloudwatch_metric_alarm" "backup_age" {
  alarm_name          = "vitana-eng-backup-age"
  alarm_description   = "No GitLab backup newer than 30 hours is in the backup bucket, or the metrics job cannot see the bucket. The nightly backup runs at 02:15 UTC (host/backup.sh, log /var/log/vitana-backup.log). Metric BackupAgeSeconds."
  namespace           = local.monitoring_namespace
  metric_name         = "BackupAgeSeconds"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 108000
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "merge_bot_tick" {
  alarm_name        = "vitana-eng-merge-bot-tick"
  alarm_description = "The merge bot (vitana-land.timer, every minute) has not completed a tick for 15 minutes, so no merge request lands. Look at journalctl -u vitana-land on the GitLab machine. Metric TickAgeSeconds for the unit vitana-land."
  namespace         = local.monitoring_namespace
  metric_name       = "TickAgeSeconds"
  dimensions = {
    Unit = "vitana-land"
  }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "settings_sync_tick" {
  alarm_name        = "vitana-eng-settings-sync-tick"
  alarm_description = "The settings sync (vitana-settings.timer, every 10 minutes) has not completed a tick for 15 minutes, so GitLab is no longer corrected to match gitlab-settings.json. Look at journalctl -u vitana-settings on the GitLab machine. Metric TickAgeSeconds for the unit vitana-settings."
  namespace         = local.monitoring_namespace
  metric_name       = "TickAgeSeconds"
  dimensions = {
    Unit = "vitana-settings"
  }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ------------------------------------------------------------------- the budget
# AWS Budgets mails the owner directly. A budget notification to an SNS topic needs the topic to accept the budgets service, and AWS's
# own pages disagree on whether an encrypted topic is allowed; a refusal would stop the whole apply, which takes half an hour. A direct
# mail needs no confirmation and no key policy.
resource "aws_budgets_budget" "monthly" {
  name         = "vitana-eng-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [local.monitoring_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [local.monitoring_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [local.monitoring_alert_email]
  }
}

# ------------------------------------------------------------------- outputs for m2.sh status
output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "alerts_email" {
  value = local.monitoring_alert_email
}

output "alarm_names" {
  value = [
    aws_cloudwatch_metric_alarm.oldest_pending_job.alarm_name,
    aws_cloudwatch_metric_alarm.fleet_at_maximum.alarm_name,
    aws_cloudwatch_metric_alarm.gitlab_host_status.alarm_name,
    aws_cloudwatch_metric_alarm.gitlab_disk_used.alarm_name,
    aws_cloudwatch_metric_alarm.gitlab_lb_unhealthy_target.alarm_name,
    aws_cloudwatch_metric_alarm.backup_age.alarm_name,
    aws_cloudwatch_metric_alarm.merge_bot_tick.alarm_name,
    aws_cloudwatch_metric_alarm.settings_sync_tick.alarm_name,
  ]
}

output "budget_name" {
  value = aws_budgets_budget.monthly.name
}

output "metrics_namespace" {
  value = local.monitoring_namespace
}
