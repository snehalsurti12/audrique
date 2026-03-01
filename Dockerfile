# Audrique — Contact Center E2E Testing Framework
# Base image: Playwright with Chromium pre-installed
FROM mcr.microsoft.com/playwright:v1.51.0-noble

# Install FFmpeg (with drawtext/freetype support) and HashiCorp Vault
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libfreetype6 fonts-dejavu-core gpg lsb-release wget && \
    wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends vault && \
    rm -rf /var/lib/apt/lists/*

# Install whisper.cpp for real-time IVR transcription
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential cmake && \
    cd /tmp && \
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git && \
    cd whisper.cpp && \
    cmake -B build && cmake --build build --config Release && \
    cp build/bin/whisper-cli /usr/local/bin/whisper-cpp && \
    cp build/src/libwhisper.so* /usr/local/lib/ && \
    find build/ggml -name 'libggml*.so*' -exec cp {} /usr/local/lib/ \; && \
    ldconfig && \
    cd / && rm -rf /tmp/whisper.cpp && \
    apt-get purge -y build-essential cmake && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Download Whisper small multilingual model (466MB, supports 99 languages)
# Stored at /opt/whisper-models so it's not overwritten by volume mounts on /app/.models
RUN mkdir -p /opt/whisper-models && \
    wget -q -O /opt/whisper-models/ggml-small.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

WORKDIR /app

# Copy package files and install all dependencies (including Playwright)
COPY package.json package-lock.json ./
RUN npm ci && \
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
