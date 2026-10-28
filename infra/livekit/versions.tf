terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.20"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.20"
    }
  }
  # Backend state lives in GCS — wire via `terraform init -backend-config=backend.hcl`.
  # backend "gcs" {} — uncomment when the state bucket is provisioned.
}
