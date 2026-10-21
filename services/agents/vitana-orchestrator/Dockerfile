FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# Copy and install dependencies
COPY pyproject.toml .
COPY src/ src/

# Install the package
RUN pip install --no-cache-dir -e . && \
    pip install --no-cache-dir gunicorn uvicorn fastapi

# Copy server entry point
COPY server.py .

# Run as non-root
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

CMD ["sh", "-c", "exec gunicorn -k uvicorn.workers.UvicornWorker -b 0.0.0.0:${PORT:-8080} --workers 1 --threads 8 --timeout 0 server:app"]
