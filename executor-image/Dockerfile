# LuaN1aoAgent executor task container image.
# Build: npm run build:executor-image
#
# This image *is* the Executor's tool surface. Two rules keep it honest:
#
#  1. The LABEL below is the authoritative list the Runtime reports to agents
#     (see src/executor-environment.ts). A tool that is advertised but missing
#     makes the Planner write plans that cannot run, so the build asserts every
#     advertised name resolves on PATH for the agent user. The build fails
#     rather than shipping an image that lies about itself.
#  2. The agent user's home is /workspace/home — the bind-mounted, writable task
#     workspace — not /home/agent. Programs that resolve their state directory
#     through getpwuid() instead of $HOME (hashcat is one) would otherwise write
#     into the read-only root filesystem and abort before doing any work.
#
# Deliberately absent, so nobody re-adds them without reading this:
#  * john — Debian ships the non-jumbo 1.9.0 build: no raw-md5/NTLM/zip formats
#    and none of the *2john extractors that are jumbo's main value. hashcat
#    covers the same crypt(3) formats with far more modes.
#  * wfuzz — its Debian build warns "Pycurl is not compiled against Openssl",
#    i.e. it is broken against HTTPS targets, which is most of them. ffuf and
#    gobuster cover the same ground.
#  * patator, ncrack — redundant with hydra/medusa.
#  * seclists — not packaged in Debian, and unbounded attempt budgets are not
#    how this system works; the aggregated top-N lists below are the right size.
FROM debian:bookworm-slim

# The agent user's home is created here (owned by 1000) and registered as
# /workspace/home; at runtime the task workspace is bind-mounted over /workspace,
# where the sandbox already prepares a world-writable `home` subdirectory.
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
      ncat \
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
      hydra \
      medusa \
      hashcat \
      ocl-icd-libopencl1 \
      pocl-opencl-icd \
      sqlmap \
      ffuf \
      gobuster \
      dirb \
      crunch \
      gcc \
      make \
      libc6-dev \
      binutils \
      xxd \
      unzip \
      whois \
    && rm -rf /var/lib/apt/lists/* \
    && install -m 0755 /usr/bin/ping /usr/local/bin/ping \
    && install -d -o 1000 -g 1000 -m 0755 /workspace/home \
    && useradd --uid 1000 --home-dir /workspace/home --shell /bin/bash agent \
    && chown 1000:1000 /workspace

# Wordlists are assembled at build time from lists that already ship inside the
# installed packages, plus the small curated sets in executor-image/wordlists/.
# Nothing third-party is vendored into the repository; see PROVENANCE.txt.
COPY wordlists/ /tmp/wordlists-src/
RUN set -eu; \
    dir=/opt/luanniao/wordlists; \
    install -d -m 0755 "$dir"; \
    clean() { sed -e 's/\r$//' -e 's/[[:space:]]*$//' "$@" | grep -v '^#' | grep -v '^$'; }; \
    clean /usr/share/nmap/nselib/data/passwords.lst /tmp/wordlists-src/passwords-extra.txt \
      | sort -u > "$dir/passwords-common.txt"; \
    clean /usr/share/nmap/nselib/data/usernames.lst /tmp/wordlists-src/usernames-extra.txt \
      | sort -u > "$dir/usernames-common.txt"; \
    clean /tmp/wordlists-src/default-credentials.txt \
      | sort -u > "$dir/default-credentials.txt"; \
    clean /usr/share/dirb/wordlists/common.txt \
      > "$dir/directories-common.txt"; \
    install -m 0644 /tmp/wordlists-src/PROVENANCE.txt "$dir/PROVENANCE.txt"; \
    rm -rf /tmp/wordlists-src

# The assertion list must stay identical to the LABEL's "tools" array; the
# static test in test/executor-image-contract.test.ts fails if they drift. Note
# `convert`/`identify`, not `imagemagick`: Debian's imagemagick package ships the
# ImageMagick 6 binaries and no command named after the package.
RUN set -eu; \
    for t in bash chromium curl dig git convert identify ip iptables jq nc ncat nmap node \
             openssl python3 tesseract wget ssh sshpass hydra medusa hashcat sqlmap \
             ffuf gobuster dirb crunch gcc make strings objdump xxd unzip whois; do \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin command -v "$t" >/dev/null \
        || { echo "executor image advertises $t but it is not on PATH" >&2; exit 1; }; \
    done; \
    for f in /opt/luanniao/wordlists/passwords-common.txt \
             /opt/luanniao/wordlists/usernames-common.txt \
             /opt/luanniao/wordlists/default-credentials.txt \
             /opt/luanniao/wordlists/directories-common.txt; do \
      test -s "$f" || { echo "missing or empty wordlist: $f" >&2; exit 1; }; \
    done; \
    python3 -c 'import urllib.request, http.cookiejar, ssl, json, hashlib, socket' \
      || { echo "python3 stdlib is incomplete" >&2; exit 1; }

LABEL io.luanniao.executor.facts='{"version":2,"uid":1000,"rawSockets":false,"platform":"linux-container","tools":["bash","chromium","curl","dig","git","convert","identify","ip","iptables","jq","nc","ncat","nmap","node","openssl","python3","tesseract","wget","ssh","sshpass","hydra","medusa","hashcat","sqlmap","ffuf","gobuster","dirb","crunch","gcc","make","strings","objdump","xxd","unzip","whois"],"wordlists":["/opt/luanniao/wordlists/passwords-common.txt","/opt/luanniao/wordlists/usernames-common.txt","/opt/luanniao/wordlists/default-credentials.txt","/opt/luanniao/wordlists/directories-common.txt"]}'

USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
