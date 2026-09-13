# VTID-03840: erp-bridge — private HTTP facade over the vendored ERPClaw CLI.
# Runs on ECS (AWS eu-central-1), port 8080, health /alive.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080 \
    ERPCLAW_ROOT=/opt/erpclaw ERPCLAW_HOME=/var/lib/erpclaw

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Vendor the pinned ERPClaw trees (build-time only; git is not needed after).
COPY vendor/ /app/vendor/
RUN bash /app/vendor/vendor.sh && apt-get purge -y git && apt-get autoremove -y

COPY app/ /app/app/

# Non-root; the install home must be writable for module install-state markers.
RUN useradd -r -u 10001 erpbridge && chown -R erpbridge:erpbridge /var/lib/erpclaw
USER erpbridge

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/alive',timeout=3).status==200 else 1)"

EXPOSE 8080
CMD ["uvicorn", "app.main:build", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-server-header"]
