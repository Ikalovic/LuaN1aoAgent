FROM golang:1.24-bookworm AS gateway-builder

ARG TARGETARCH
WORKDIR /src
COPY gateway-tun/go.mod gateway-tun/go.sum ./
RUN go mod download
COPY gateway-tun/*.go ./
RUN arch="${TARGETARCH:-amd64}" \
    && CGO_ENABLED=0 GOOS=linux GOARCH="${arch}" go build -trimpath -ldflags="-s -w" -o /out/gateway-tun .

FROM golang:1.24-bookworm AS socks-connector-builder

ARG TARGETARCH
WORKDIR /src
COPY socks-connector/go.mod ./
COPY socks-connector/*.go ./
RUN arch="${TARGETARCH:-amd64}" \
    && CGO_ENABLED=0 GOOS=linux GOARCH="${arch}" go build -trimpath -ldflags="-s -w" -o /out/socks-connector .

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1

ARG MITMPROXY_VERSION=12.2.1
ARG CHISEL_VERSION=1.10.1
ARG TARGETARCH

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates conntrack curl iproute2 iptables jq netcat-openbsd nftables openssh-client procps sshpass util-linux \
    && pip install --no-cache-dir "mitmproxy==${MITMPROXY_VERSION}" "httpx==0.28.1" \
    && arch="${TARGETARCH:-amd64}" \
    && case "${arch}" in amd64|arm64) ;; *) echo "unsupported architecture: ${arch}" >&2; exit 65 ;; esac \
    && mkdir -p /opt/luanniao/chisel \
    && curl -fsSL "https://github.com/jpillora/chisel/releases/download/v${CHISEL_VERSION}/chisel_${CHISEL_VERSION}_linux_amd64.gz" -o "/opt/luanniao/chisel/chisel_${CHISEL_VERSION}_linux_amd64.gz" \
    && curl -fsSL "https://github.com/jpillora/chisel/releases/download/v${CHISEL_VERSION}/chisel_${CHISEL_VERSION}_linux_arm64.gz" -o "/opt/luanniao/chisel/chisel_${CHISEL_VERSION}_linux_arm64.gz" \
    && printf '%s  %s\n%s  %s\n' \
      "0525aa3c5d457f2a4075e66221d5125d434bedf15006d3271c213f5cd6ff2230" "/opt/luanniao/chisel/chisel_${CHISEL_VERSION}_linux_amd64.gz" \
      "f55beb68fb99b69903df1adcff4197fbfdb82cb0ee596848c0f055dc219da983" "/opt/luanniao/chisel/chisel_${CHISEL_VERSION}_linux_arm64.gz" \
      | sha256sum -c - \
    && gzip -dc "/opt/luanniao/chisel/chisel_${CHISEL_VERSION}_linux_${arch}.gz" > /usr/local/bin/chisel \
    && chmod 0755 /usr/local/bin/chisel \
    && useradd --system --uid 101 --no-create-home --shell /usr/sbin/nologin mitm \
    && useradd --system --uid 102 --no-create-home --shell /usr/sbin/nologin relay \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 entrypoint.sh gatewayctl /usr/local/bin/
COPY --from=gateway-builder --chmod=0755 /out/gateway-tun /usr/local/bin/gateway-tun
COPY --from=socks-connector-builder --chmod=0755 /out/socks-connector /usr/local/bin/socks-connector
COPY flow_capture.py index_server.py replay_client.py conntrack_telemetry.py segmented_capture.py scope_dns.py /opt/luanniao/

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
