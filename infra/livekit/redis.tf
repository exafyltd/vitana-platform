# Memorystore Redis — required for distributed state across the SFU pair.
# BASIC tier (single-node) costs ~$36/mo. STANDARD_HA (HA replica) ~$72/mo —
# upgrade once voice uptime is contractual.

resource "google_redis_instance" "livekit" {
  name           = "livekit-redis"
  display_name   = "LiveKit SFU state"
  tier           = var.redis_tier
  memory_size_gb = var.redis_memory_size_gb
  region         = var.region
  project        = var.project_id

  authorized_network = google_compute_network.livekit.id
  redis_version      = "REDIS_7_0"
  labels             = var.labels

  # Disable AUTH for simplicity in BASIC tier — VPC isolation is sufficient.
  # Enable AUTH on STANDARD_HA upgrade.
  auth_enabled = var.redis_tier == "STANDARD_HA"
}

# Push the Redis host into Secret Manager so the SFU startup script can read it.
resource "google_secret_manager_secret" "redis_host" {
  secret_id = "LIVEKIT_REDIS_HOST"
  project   = var.project_id

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "redis_host" {
  secret      = google_secret_manager_secret.redis_host.id
  secret_data = google_redis_instance.livekit.host
}
