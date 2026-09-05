# syntax=docker/dockerfile:1.7

# ============================================================
# JRD — Dockerfile
# Single runtime base: Playwright (Node 20 + Chromium + libs).
# Builds native deps (better-sqlite3) INSIDE the final image
# to guarantee ABI compatibility with the runtime glibc.
# ============================================================

# ---------- Stage 1: build frontend (small, fast) ----------
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: final runtime ----------
FROM mcr.microsoft.com/playwright:v1.47.0-jammy AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3001 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Build tools for better-sqlite3 native compile
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend deps (native compile happens here against runtime libc)
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev && npm cache clean --force

# Install scraper deps
COPY scraper/package*.json ./scraper/
RUN cd scraper && npm install --omit=dev && npm cache clean --force

# Install bot deps
COPY bot/package*.json ./bot/
RUN cd bot && npm install --omit=dev && npm cache clean --force

# Install messages-scraper deps (Google Messages Web — البند 3.5)
COPY messages-scraper/package*.json ./messages-scraper/
RUN cd messages-scraper && npm install --omit=dev && npm cache clean --force

# Ensure Chromium browser is present at PLAYWRIGHT_BROWSERS_PATH (in case
# the scraper's playwright version differs from the base image's bundled one).
RUN cd scraper && npx playwright install chromium

# Install real Chrome (not Chromium) for messages-scraper — Google's sign-in
# rejects automated Chromium ("Couldn't sign you in / browser may not be secure").
RUN cd messages-scraper && npx playwright install chrome --with-deps || true

# Copy app source
COPY backend/ ./backend/
COPY scraper/ ./scraper/
COPY bot/ ./bot/
COPY messages-scraper/ ./messages-scraper/
COPY start.sh ./start.sh
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN chmod +x /app/start.sh

# Persistent data dir (mounted as a Volume in Railway)
RUN mkdir -p /data/uploads /data/browser-data /data/auth_sessions /data/gmsg-browser-data

# Note: we run as root because Railway-mounted volumes are root-owned.
# Chromium is launched with --no-sandbox (see scraper/src/fetch.js).
# This is acceptable for a single-tenant internal app.

EXPOSE 3001
EXPOSE 3100
EXPOSE 3101

CMD ["/bin/sh", "/app/start.sh"]
