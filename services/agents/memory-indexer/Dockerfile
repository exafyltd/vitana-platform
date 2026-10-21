# VTID-01152: Mem0 OSS Local Memory Indexer (Anthropic version)
# Local-first fact memory for ORB using Anthropic + local embeddings

FROM python:3.11-slim

WORKDIR /app

# Set cache environment FIRST (before any downloads)
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface
ENV HF_HOME=/root/.cache/huggingface
ENV SENTENCE_TRANSFORMERS_HOME=/root/.cache/sentence_transformers

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the embedding model during build (with cache dirs set)
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Verify model is cached
RUN ls -la /root/.cache/

# Copy application code
COPY . .

# Create directories for local storage
RUN mkdir -p /tmp/qdrant /root/.mem0

# Expose port
EXPOSE 8080

# Set remaining environment variables
ENV PORT=8080
ENV PYTHONUNBUFFERED=1

# Run with gunicorn (fewer workers for faster startup)
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "2", "--timeout", "120", "main:app"]
