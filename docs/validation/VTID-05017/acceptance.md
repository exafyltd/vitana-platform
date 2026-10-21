# VTID-05017 - Build the gateway and kiro-runner images from the ECR Public mirror

Owner approval 2026-10-09 (Gate 1: "Yes, build it and ship."). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (build-time change only; no route added or changed).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info (staging reports the merge commit once the image builds).

CURL_PROOF: staging build-info answers 200 application/json after the deploy of the merge commit.

OASIS_PROOF: none new (the deploy workflow's own deploy event records the build).

## Acceptance criteria

AC-1: Every FROM in services/gateway/Dockerfile, Dockerfile.job, Dockerfile.auto-logger and services/kiro-runner/Dockerfile uses public.ecr.aws/docker/library/ (same image, same tag) or an earlier build stage; none pulls from Docker Hub.
  TEST: services/gateway/test/vtid-05017-base-images-ecr-public.test.ts
AC-2: The staging gateway image builds and deploys for the merge commit (the build no longer depends on Docker Hub's anonymous rate limit).
  CURL: staging GET /api/v1/admin/build-info -> 200 application/json with the merge commit
