# Audrique — Contact Center E2E Testing Framework
# Base image: Playwright with Chromium pre-installed
FROM mcr.microsoft.com/playwright:v1.51.0-noble

# Install FFmpeg for video merge/evidence generation
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npx playwright install chromium --with-deps

# Copy application code
COPY . .

# Create directories for runtime artifacts
RUN mkdir -p .auth test-results playwright-report .cache

# Default environment variables
ENV NODE_ENV=production
ENV PW_HEADLESS=true
ENV PW_USE_FAKE_MEDIA=true

# Expose Scenario Studio port
EXPOSE 4200

# Health check for Studio mode
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:4200/api/suites || exit 1

# Default: start Scenario Studio
CMD ["node", "bin/audrique.mjs", "studio"]
