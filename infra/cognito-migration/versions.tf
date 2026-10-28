terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # infra/livekit (this repo's other Terraform) backs its state with GCS —
  # not an option here, GCP is fully decommissioned (CLAUDE.md §1). Wire an
  # S3 backend once a state bucket exists for this repo's Terraform; the
  # bucket below is a placeholder name, not a confirmed resource.
  # backend "s3" {
  #   bucket = "vitana-terraform-state"
  #   key    = "cognito-migration/terraform.tfstate"
  #   region = "eu-central-1"
  # }
}

provider "aws" {
  region = var.region
}
