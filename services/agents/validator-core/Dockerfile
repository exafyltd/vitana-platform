# services/validator-core/Dockerfile
FROM python:3.11-slim

# --- Runtime sanity & perf
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# Install Python deps first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir gunicorn uvicorn

# Copy your app code
COPY . .

# Run as non-root (Cloud Run best practice)
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Cloud Run listens on 0.0.0.0:$PORT
EXPOSE 8080

# Use Gunicorn with Uvicorn worker for FastAPI
CMD ["sh","-c","exec gunicorn -k uvicorn.workers.UvicornWorker -b 0.0.0.0:${PORT:-8080} --workers 1 --threads 8 --timeout 0 main:app"]
