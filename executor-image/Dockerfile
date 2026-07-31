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
      iproute2 \
      iptables \
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

LABEL io.luanniao.executor.facts='{"version":1,"uid":1000,"rawSockets":false,"platform":"linux-container","tools":["bash","chromium","curl","dig","git","imagemagick","ip","iptables","jq","nc","nmap","node","openssl","python3","tesseract","wget"]}'

USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
