# Self-hosted LiveKit infrastructure

Terraform that provisions the **self-hosted LiveKit Server (open source)** on GCP Compute Engine. This is the deployment target for the LiveKit standby pipeline — **not** LiveKit Cloud.

> See `.claude/plans/here-is-what-our-valiant-stearns.md` for why self-hosted (cost: ~$449/mo HA pair vs LiveKit Cloud's per-minute fees that would be $32K+/mo at our 150K voice-min/mo workload).

## What this provisions

| Component | Spec | Monthly cost (us-central1) |
|---|---|---|
| LiveKit Server SFU node A | `c2-standard-4` (4 vCPU / 16 GiB) 24/7 | ~$140 |
| LiveKit Server SFU node B (HA) | `c2-standard-4` 24/7 | ~$140 |
| Redis | Memorystore Basic 1 GB | ~$36 |
| L4 HTTPS Load Balancer | forwarding rules + first 5 backends | ~$22 |
| Managed TLS cert | included with LB | $0 |
| Static IPs (2) | regional | ~$7 |
| Egress (media) | 150K min × 64 kbps ≈ 72 GB | ~$9 |
| Egress (signaling) | cushion | ~$10 |
| Cloud Ops baseline | logging + monitoring | ~$15 |
| **Subtotal (HA pair)** | | **~$449/mo** |
| Single-node ramp option | drop node B → save $140 | **~$309/mo** |

The Cloud Run agent worker (`vitana-orb-agent`) is provisioned separately by `services/agents/orb-agent/service.yaml` (`min-instances=0` scale-to-zero standby).

## Status

**Skeleton — NOT YET APPLIED.** The Terraform compiles and `plan` works, but the real apply requires:

1. Operator confirmation of the cost (this is a non-engineering gate per the approved plan).
2. GCP billing approval for the new compute line items.
3. DNS for `livekit.vitana.dev` (or chosen subdomain) pointed at the LB's IP.
4. Service account with the IAM roles listed in `iam.tf` (TODO).

Once the prerequisites land, run:

```bash
cd infra/livekit
terraform init -backend-config=backend.hcl   # wires GCS state backend
terraform plan -var-file=dev.tfvars          # review proposed changes
terraform apply -var-file=dev.tfvars         # NOT YET — gated on operator OK
```

## File layout

```
infra/livekit/
  README.md           — this file
  versions.tf         — provider + Terraform version pins
  variables.tf        — inputs (project_id, region, instance_size, ha_enabled, …)
  network.tf          — VPC + firewall rules for SFU ports
  compute.tf          — 2x c2-standard-4 SFU instances (HA flag toggles second node)
  redis.tf            — Memorystore Basic instance
  loadbalancer.tf     — L4 LB + managed TLS cert
  outputs.tf          — public IP, LiveKit URL, Redis host
  examples/
    dev.tfvars        — example values for dev
    prod.tfvars       — example values for prod (HA=true)
```

## Operational caveats (must address before apply)

Per `services/agents/orb-agent/docs/SELF_HOST_RUNBOOK.md` (TODO):

- **TLS cert renewal**: bundled Caddy on the SFU auto-renews via ACME but only if port 80 stays open. Test on day 60 of 90.
- **Redis HA**: Memorystore Basic is single-node — a maintenance failover interrupts active calls. Standard tier (HA replica) costs +$36/mo.
- **Kernel UDP tuning**: COS defaults are too low for production WebRTC. Startup script in `compute.tf` bumps `net.core.{r,w}mem_max` to 16 MB.
- **External IP setting**: `rtc.use_external_ip: true` in the LiveKit YAML — verify with `livekit-cli load-test` from outside GCP before cutover.
- **Patching**: track [livekit/livekit releases](https://github.com/livekit/livekit), upgrade the SFU container quarterly.

## What's NOT in this PR

- Actual `terraform apply` execution.
- DNS configuration (assumes `livekit.vitana.dev` exists; commented out by default).
- Secret Manager bootstrap for `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (use `gcloud secrets create` separately).
- The Cloud Run service for the agent worker (lives in `services/agents/orb-agent/service.yaml`).
- Monitoring dashboards (separate ops PR).
