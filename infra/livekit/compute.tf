# LiveKit Server SFU — c2-standard-4 (compute-optimized, 4 vCPU / 16 GiB).
# LiveKit's benchmark page explicitly recommends compute-optimized infra
# with 10 Gbps networking. e2-* throttles UDP under load; n2-* has lower
# per-core media throughput.

locals {
  livekit_version = "v1.7.2" # track github.com/livekit/livekit releases — bump quarterly
  startup_script = <<-EOT
    #!/usr/bin/env bash
    set -euxo pipefail

    # Kernel UDP buffer tuning — COS defaults are too low for production WebRTC.
    # Per services/agents/orb-agent/docs/SELF_HOST_RUNBOOK.md (TODO).
    sysctl -w net.core.rmem_max=16777216
    sysctl -w net.core.wmem_max=16777216
    sysctl -w net.core.netdev_max_backlog=2500
    cat <<EOF >>/etc/sysctl.conf
    net.core.rmem_max=16777216
    net.core.wmem_max=16777216
    net.core.netdev_max_backlog=2500
    EOF

    # LiveKit configuration — populated from instance metadata at boot.
    mkdir -p /etc/livekit
    gcloud secrets versions access latest --secret=LIVEKIT_API_KEY     > /etc/livekit/api_key
    gcloud secrets versions access latest --secret=LIVEKIT_API_SECRET  > /etc/livekit/api_secret
    REDIS_HOST=$(gcloud secrets versions access latest --secret=LIVEKIT_REDIS_HOST 2>/dev/null || echo "")

    cat <<EOF >/etc/livekit/livekit.yaml
    port: 7880
    bind_addresses: ["0.0.0.0"]
    rtc:
      tcp_port: 7881
      port_range_start: 50000
      port_range_end: 60000
      use_external_ip: true
    redis:
      address: $REDIS_HOST:6379
    keys:
      $(cat /etc/livekit/api_key): $(cat /etc/livekit/api_secret)
    turn:
      enabled: true
      domain: ${var.domain_name}
      tls_port: 5349
      udp_port: 3478
      external_tls: true
    EOF

    # Run LiveKit Server in Docker.
    docker run -d --restart=always --network=host \
      -v /etc/livekit/livekit.yaml:/etc/livekit/livekit.yaml \
      --name livekit-server \
      livekit/livekit-server:${local.livekit_version} \
      --config /etc/livekit/livekit.yaml
  EOT
}

resource "google_compute_instance" "livekit_a" {
  name         = "livekit-sfu-a"
  machine_type = var.instance_size
  zone         = var.zone
  project      = var.project_id

  tags   = ["livekit-sfu"]
  labels = var.labels

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 30
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.livekit.id
    access_config {
      # Ephemeral public IP — the LB has the stable IP; this is for
      # outbound + ACME challenge.
    }
  }

  metadata = {
    enable-oslogin = "TRUE"
  }
  metadata_startup_script = local.startup_script

  service_account {
    email  = google_service_account.livekit.email
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true
}

resource "google_compute_instance" "livekit_b" {
  count = var.ha_enabled ? 1 : 0

  name         = "livekit-sfu-b"
  machine_type = var.instance_size
  zone         = var.zone_b
  project      = var.project_id

  tags   = ["livekit-sfu"]
  labels = var.labels

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 30
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.livekit.id
    access_config {}
  }

  metadata = {
    enable-oslogin = "TRUE"
  }
  metadata_startup_script = local.startup_script

  service_account {
    email  = google_service_account.livekit.email
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true
}

# Service account — needs Secret Manager accessor for the LiveKit API key/secret + Redis host.
resource "google_service_account" "livekit" {
  account_id   = "livekit-sfu"
  display_name = "LiveKit SFU"
  project      = var.project_id
}

resource "google_project_iam_member" "livekit_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.livekit.email}"
}

resource "google_project_iam_member" "livekit_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.livekit.email}"
}

resource "google_project_iam_member" "livekit_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.livekit.email}"
}
