output "livekit_url" {
  description = "WSS URL for the orb-agent worker + frontend client to connect to."
  value       = "wss://${var.domain_name}"
}

output "livekit_public_ip" {
  description = "Static IP fronting the SFU pair. Point a DNS A-record from var.domain_name at this."
  value       = google_compute_global_address.livekit.address
}

output "redis_host" {
  description = "Memorystore Redis host the SFU nodes auth-less-connect to."
  value       = google_redis_instance.livekit.host
  sensitive   = true
}

output "ha_node_count" {
  description = "Number of SFU instances actually provisioned (1 for ramp, 2 for HA)."
  value       = var.ha_enabled ? 2 : 1
}

output "estimated_monthly_cost_usd" {
  description = "Rough ballpark — for operator review, not invoicing."
  value = format(
    "$%d (compute) + $%d (Redis) + ~$30 (LB+IP) + ~$20 (egress) = ~$%d/mo",
    var.ha_enabled ? 280 : 140,
    var.redis_tier == "STANDARD_HA" ? 72 : 36,
    (var.ha_enabled ? 280 : 140) + (var.redis_tier == "STANDARD_HA" ? 72 : 36) + 50
  )
}
