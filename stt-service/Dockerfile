# EasyFix STT sidecar image (CPU; builds for arm64 or amd64).
#
# SELF-CONTAINED: both the Python deps AND the STT model are baked at build time,
# so the container starts fast with NO runtime download and NO internet dependency
# on the host — it "auto-installs everything" at build and just runs on deploy.
# For GPU, base on an NVIDIA CUDA image and set STT_DEVICE=cuda STT_COMPUTE=float16.
FROM python:3.11-slim

WORKDIR /app

# ffmpeg/libgomp for faster-whisper (CTranslate2) runtime; curl for debugging.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Deps first (layer cache survives server.py edits). --only-binary keeps it to
# prebuilt wheels — the whole point of using python:3.11-slim (all deps have 3.11
# manylinux wheels for arm64 + amd64).
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir --only-binary=:all: -r requirements.txt

# Pre-bake the STT model into the image so there's NO model download at runtime.
# STT_MODEL is an ARG so `--build-arg STT_MODEL=base` (etc.) rebuilds with a
# different model; the ENV below inherits it so runtime matches the baked model.
ARG STT_MODEL=small
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${STT_MODEL}', device='cpu', compute_type='int8')"

COPY server.py healthcheck.py .

ENV STT_HOST=0.0.0.0 \
    STT_PORT=8300 \
    STT_MODEL=${STT_MODEL} \
    STT_DEVICE=cpu \
    STT_COMPUTE=int8

EXPOSE 8300

# The WS server only starts listening AFTER the model loads. This healthcheck
# performs a REAL WebSocket handshake (healthcheck.py) — so "healthy" means the
# server actually ACCEPTS WebSocket connections, not just that the TCP port is
# open. A bare TCP connect couldn't tell the difference and logged an "opening
# handshake failed" traceback on every probe. Docker/compose read this status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD python healthcheck.py

CMD ["python", "server.py"]
