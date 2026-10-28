resource "google_compute_network" "livekit" {
  name                    = "livekit-vpc"
  auto_create_subnetworks = false
  project                 = var.project_id
}

resource "google_compute_subnetwork" "livekit" {
  name          = "livekit-subnet"
  ip_cidr_range = "10.20.0.0/24"
  region        = var.region
  network       = google_compute_network.livekit.id
  project       = var.project_id

  private_ip_google_access = true
}

# LiveKit SFU port requirements — see docs.livekit.io/home/self-hosting/deployment/
# 443/tcp   — signaling (terminated at LB)
# 80/tcp    — ACME HTTP-01 challenge for the bundled Caddy (auto TLS renewal)
# 7881/tcp  — ICE/TCP fallback
# 3478/udp  — bundled TURN/UDP
# 50000-60000/udp — RTC media
resource "google_compute_firewall" "livekit_signaling" {
  name    = "livekit-signaling"
  network = google_compute_network.livekit.id
  project = var.project_id

  direction = "INGRESS"
  allow {
    protocol = "tcp"
    ports    = ["80", "443", "7881"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["livekit-sfu"]
}

resource "google_compute_firewall" "livekit_media" {
  name    = "livekit-media"
  network = google_compute_network.livekit.id
  project = var.project_id

  direction = "INGRESS"
  allow {
    protocol = "udp"
    ports    = ["3478", "50000-60000"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["livekit-sfu"]
}

# Internal: SFU nodes <-> Redis (Memorystore VPC peering uses the auto-created
# servicenetworking range so we don't need an explicit firewall here, but we
# allow internal SFU<->SFU + SFU<->agent-worker on standard ports.)
resource "google_compute_firewall" "livekit_internal" {
  name    = "livekit-internal"
  network = google_compute_network.livekit.id
  project = var.project_id

  direction = "INGRESS"
  allow {
    protocol = "tcp"
    ports    = ["6379", "8080"] # Redis + agent worker health
  }
  source_ranges = [google_compute_subnetwork.livekit.ip_cidr_range]
  target_tags   = ["livekit-sfu"]
}
