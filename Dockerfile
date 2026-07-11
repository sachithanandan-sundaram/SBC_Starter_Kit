# =============================================================================
# Stage 1 — Build React frontend
# =============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend

# Copy dependency manifests first for layer caching
COPY frontend/package*.json ./
RUN npm install --legacy-peer-deps

# Copy source and build
COPY frontend/ ./
RUN npm run build

# =============================================================================
# Stage 2 — Python runtime (FastAPI serves API + built React)
# =============================================================================
FROM python:3.11-slim AS production

WORKDIR /app

# System packages — ffmpeg for hardware decode/HLS transcode
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    v4l-utils \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend application code
COPY backend/app ./app

# Compiled React app from stage 1
COPY --from=frontend-builder /build/frontend/dist ./dist

# Persistent data directories (mount as volumes in production)
RUN mkdir -p data/models data/recordings data/events data/hls

# Non-root user for security
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Uvicorn with 1 worker on Pi (resource-constrained device)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
