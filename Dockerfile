# Simple Dockerfile for ChessPuzzle
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install system deps required for building some Python wheels and for tiny init/healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       libssl-dev \
       libffi-dev \
       gcc \
         curl \
        tini \
        netcat-openbsd \
         postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps from the locked requirements
COPY requirements-lock.txt ./
RUN pip install --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r requirements-lock.txt

# Copy application
COPY . /app

# Create an unprivileged user and use it
RUN useradd -m appuser \
    && chown -R appuser:appuser /app
# ensure our entrypoint script (if present) is executable
RUN chmod 755 /app/entrypoint.sh || true
# convenience: make top-level shortcuts for commonly-run admin scripts so
# callers can run /app/clear_puzzles.py inside the container. This is a
# non-fatal operation if the script isn't present.
RUN ln -s /app/scripts/clear_puzzles.py /app/clear_puzzles.py || true \
    && chmod a+x /app/clear_puzzles.py || true
USER appuser

ENV FLASK_APP=backend.py \
    FLASK_ENV=production \
    GUNICORN_WORKERS=2

EXPOSE 5000

# Minimal healthcheck to ensure the server is ready (requires curl in the image)
# Use /ready which performs lightweight dependency checks (DB, Redis when configured)
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD curl -f http://localhost:5000/ready || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# If an entrypoint script exists in the image, use it; otherwise fall back to
# launching gunicorn directly. Tini is PID 1 and will forward signals.
CMD ["sh", "/app/entrypoint.sh"]
