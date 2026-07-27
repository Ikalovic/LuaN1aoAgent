#!/bin/sh
set -eu

role="${1:-}"
shift || true

case "$role" in
  gateway)
    : "${LUANNIAO_TASK_FLOW_ROOT:?LUANNIAO_TASK_FLOW_ROOT is required}"
    mkdir -p /run/luanniao/capture /traffic/ca "$LUANNIAO_TASK_FLOW_ROOT"
    chgrp -R 101 /run/luanniao/capture /traffic/ca "$LUANNIAO_TASK_FLOW_ROOT"
    find /traffic/ca "$LUANNIAO_TASK_FLOW_ROOT" -type d -exec chmod 2770 {} +
    find /traffic/ca "$LUANNIAO_TASK_FLOW_ROOT" -type f -exec chmod g+rw {} +
    chmod 2770 /run/luanniao/capture
    exec setpriv --groups=101 --bounding-set=-chown,-fowner,-setpcap \
      python3 /opt/luanniao/index_server.py gateway "$@"
    ;;
  index)
    exec python3 /opt/luanniao/index_server.py index "$@"
    ;;
  connector)
    mkdir -p /run/luanniao/credentials /run/luanniao/connectors
    chmod 0700 /run/luanniao/credentials /run/luanniao/connectors
    exec sleep infinity
    ;;
  *)
    echo "usage: entrypoint.sh gateway|index|connector" >&2
    exit 64
    ;;
esac
