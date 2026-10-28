# L4 HTTPS load balancer fronting the SFU pair, with a managed TLS certificate.
# WebRTC media flows directly from clients to the SFU via the firewall above —
# the LB is for signaling (443) only.

resource "google_compute_global_address" "livekit" {
  name    = "livekit-public-ip"
  project = var.project_id
}

resource "google_compute_managed_ssl_certificate" "livekit" {
  provider = google-beta
  name     = "livekit-managed-cert"
  project  = var.project_id

  managed {
    domains = [var.domain_name]
  }
}

resource "google_compute_instance_group" "livekit_a" {
  name      = "livekit-sfu-a-ig"
  zone      = var.zone
  project   = var.project_id
  instances = [google_compute_instance.livekit_a.self_link]

  named_port {
    name = "signaling"
    port = 7880
  }
}

resource "google_compute_instance_group" "livekit_b" {
  count = var.ha_enabled ? 1 : 0

  name      = "livekit-sfu-b-ig"
  zone      = var.zone_b
  project   = var.project_id
  instances = [google_compute_instance.livekit_b[0].self_link]

  named_port {
    name = "signaling"
    port = 7880
  }
}

resource "google_compute_health_check" "livekit" {
  name    = "livekit-health"
  project = var.project_id

  timeout_sec        = 5
  check_interval_sec = 10
  http_health_check {
    port         = 7880
    request_path = "/"
  }
}

resource "google_compute_backend_service" "livekit" {
  name                  = "livekit-backend"
  project               = var.project_id
  protocol              = "HTTP"
  port_name             = "signaling"
  health_checks         = [google_compute_health_check.livekit.id]
  load_balancing_scheme = "EXTERNAL_MANAGED"

  backend {
    group           = google_compute_instance_group.livekit_a.id
    balancing_mode  = "UTILIZATION"
    max_utilization = 0.8
  }

  dynamic "backend" {
    for_each = var.ha_enabled ? [google_compute_instance_group.livekit_b[0].id] : []
    content {
      group           = backend.value
      balancing_mode  = "UTILIZATION"
      max_utilization = 0.8
    }
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "livekit" {
  name            = "livekit-urlmap"
  project         = var.project_id
  default_service = google_compute_backend_service.livekit.id
}

resource "google_compute_target_https_proxy" "livekit" {
  name             = "livekit-https-proxy"
  project          = var.project_id
  url_map          = google_compute_url_map.livekit.id
  ssl_certificates = [google_compute_managed_ssl_certificate.livekit.id]
}

resource "google_compute_global_forwarding_rule" "livekit" {
  name                  = "livekit-https"
  project               = var.project_id
  target                = google_compute_target_https_proxy.livekit.id
  port_range            = "443"
  ip_address            = google_compute_global_address.livekit.address
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
