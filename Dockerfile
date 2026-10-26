# Stage 1: build the static Next.js frontend
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Python API + static frontend, with ffmpeg for video/audio handling
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
# Bake the local Whisper fallback model into the image so the first review isn't slow
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"
COPY backend/ backend/
COPY --from=web /web/out frontend/out
# A persistent disk mounted at backend/data hides files shipped in the image, so keep a seed copy of the rulebook
RUN mkdir -p seed backend/data && cp backend/data/rulebook.json seed/ 2>/dev/null || true

ENV HOST=0.0.0.0 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["sh", "-c", "mkdir -p backend/data && cp -n seed/rulebook.json backend/data/ 2>/dev/null; python backend/main.py"]
