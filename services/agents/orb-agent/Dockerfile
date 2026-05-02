# LiveKit ORB Voice Agent — Dockerfile for Cloud Run deployment.
# Standby alternative to the Vertex Live pipeline (services/gateway/src/routes/orb-live.ts).
#
# Build: docker build -t orb-agent:dev .
# Run:   docker run --rm -p 8080:8080 \
#          -e LIVEKIT_URL=wss://livekit.your-domain \
#          -e LIVEKIT_API_KEY=... -e LIVEKIT_API_SECRET=... \
#          -e GATEWAY_URL=https://gateway-q74ibpv6ia-uc.a.run.app \
#          orb-agent:dev

FROM python:3.11-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir --target /install -r requirements.txt

# ---- runtime ----
FROM python:3.11-slim AS runtime

WORKDIR /app

# libstdc++ is sometimes needed by silero VAD wheels; ffmpeg is needed for
# audio resampling on the small number of providers that don't ship native.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local/lib/python3.11/site-packages

COPY src/ ./src/
COPY main.py manifest.json ./

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    AGENT_LOG_LEVEL=INFO

EXPOSE 8080

# Cloud Run sends SIGTERM and gives 10s to drain. The agent gracefully closes
# in-flight LiveKit rooms before exit.
STOPSIGNAL SIGTERM

# Cloud Run health probe targets /health on $PORT — exposed by main.py's
# embedded FastAPI health server. The actual livekit-agents worker connects
# outbound to LIVEKIT_URL and runs in-process.
CMD ["python", "main.py"]
