# LuaN1aoAgent executor task container image.
# Build: npm run build:executor-image
FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      chromium \
      curl \
      wget \
      dnsutils \
      iputils-ping \
      netcat-openbsd \
      nmap \
      nodejs \
      python3 \
      python3-pip \
      python3-venv \
      python3-pil \
      imagemagick \
      tesseract-ocr \
      jq \
      git \
      openssl \
      file \
      less \
      util-linux \
      openssh-client \
      sshpass \
    && rm -rf /var/lib/apt/lists/* \
    && install -m 0755 /usr/bin/ping /usr/local/bin/ping \
    && useradd --uid 1000 --create-home --shell /bin/bash agent

USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
