variable "project_id" {
  description = "GCP project ID (e.g. lovable-vitana-vers1)."
  type        = string
}

variable "region" {
  description = "Primary region for compute + Memorystore."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the primary SFU node."
  type        = string
  default     = "us-central1-a"
}

variable "zone_b" {
  description = "Zone for the HA SFU node (must differ from zone)."
  type        = string
  default     = "us-central1-b"
}

variable "ha_enabled" {
  description = "If true, provision the second c2-standard-4 SFU node in zone_b for HA. False during ramp-up to save ~$140/mo."
  type        = bool
  default     = true
}

variable "instance_size" {
  description = "GCE machine type for the SFU. c2-standard-4 is the recommended baseline; LiveKit's docs explicitly recommend compute-optimized."
  type        = string
  default     = "c2-standard-4"
}

variable "redis_memory_size_gb" {
  description = "Memorystore Redis size. 1 GB is sufficient at our concurrency."
  type        = number
  default     = 1
}

variable "redis_tier" {
  description = "Memorystore tier: BASIC (single-node, ~$36/mo) or STANDARD_HA (HA replica, ~$72/mo). STANDARD_HA recommended once voice uptime is contractual."
  type        = string
  default     = "BASIC"
}

variable "domain_name" {
  description = "Public hostname for the LiveKit SFU (e.g. livekit.vitana.dev)."
  type        = string
}

variable "labels" {
  description = "Resource labels — included on all resources for billing breakdown."
  type        = map(string)
  default = {
    vtid       = "vtid-livekit-foundation"
    vt_layer   = "aicor"
    vt_module  = "voice"
    managed_by = "terraform"
  }
}
