#!/usr/bin/env bash

# Read-only diagnostics for the Docker transparent Gateway path to Baidu.
set -u

URL="https://www.baidu.com/"
CONNECT_TIMEOUT="10"
MAX_TIME="25"
GATEWAY=""
EXECUTOR=""
RUN_REF=""
OUTPUT=""
START_EXECUTOR=0
EXECUTOR_IMAGE="${LUANNIAO_EXECUTOR_IMAGE:-luanniao-executor:latest}"
TEMP_EXECUTOR=""
TEMP_DIR=""
TASK_NETWORK=""
TASK_GATEWAY_IP=""
CA_FILE=""

usage() {
  cat <<'EOF'
Usage: diagnose-baidu-gateway.sh [options]

Options:
  --gateway NAME       Gateway container name or ID
  --executor NAME      Executor container name or ID
  --start-executor     Start a temporary Executor on the selected Gateway network
  --executor-image IMG Temporary Executor image (default: luanniao-executor:latest)
  --run-ref REF        Select containers from one Luanniao run
  --output PATH        Report path (default: .agent-runtime/diagnostics/...log)
  --connect-timeout N  curl and broker probe timeout (default: 10)
  --max-time N         curl total timeout (default: 25)
  -h, --help           Show this help

The default mode is read-only. --start-executor creates and removes one
temporary diagnostic container, but does not change existing Docker networks,
firewall rules, images, or host proxy settings.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway)
      [[ $# -ge 2 ]] || { echo "--gateway requires a value" >&2; exit 2; }
      GATEWAY="$2"
      shift 2
      ;;
    --executor)
      [[ $# -ge 2 ]] || { echo "--executor requires a value" >&2; exit 2; }
      EXECUTOR="$2"
      shift 2
      ;;
    --start-executor)
      START_EXECUTOR=1
      shift
      ;;
    --executor-image)
      [[ $# -ge 2 ]] || { echo "--executor-image requires a value" >&2; exit 2; }
      EXECUTOR_IMAGE="$2"
      shift 2
      ;;
    --run-ref)
      [[ $# -ge 2 ]] || { echo "--run-ref requires a value" >&2; exit 2; }
      RUN_REF="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "--output requires a value" >&2; exit 2; }
      OUTPUT="$2"
      shift 2
      ;;
    --connect-timeout)
      [[ $# -ge 2 ]] || { echo "--connect-timeout requires a value" >&2; exit 2; }
      CONNECT_TIMEOUT="$2"
      shift 2
      ;;
    --max-time)
      [[ $# -ge 2 ]] || { echo "--max-time requires a value" >&2; exit 2; }
      MAX_TIME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v docker >/dev/null 2>&1 || {
  echo "docker command is required" >&2
  exit 2
}

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$OUTPUT" ]]; then
  mkdir -p .agent-runtime/diagnostics
  OUTPUT=".agent-runtime/diagnostics/baidu-gateway-${timestamp}.log"
else
  mkdir -p "$(dirname "$OUTPUT")"
fi

umask 077
exec > >(tee "$OUTPUT") 2>&1

cleanup() {
  if [[ -n "$TEMP_EXECUTOR" ]]; then
    docker rm -f "$TEMP_EXECUTOR" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

section() {
  printf '\n===== %s =====\n' "$1"
}

run_cmd() {
  printf '\n$'
  printf ' %q' "$@"
  printf '\n'
  "$@" 2>&1
  local status=$?
  printf '[exit=%s]\n' "$status"
  return 0
}

run_shell() {
  printf '\n$ bash -lc %q\n' "$1"
  bash -lc "$1" 2>&1
  local status=$?
  printf '[exit=%s]\n' "$status"
  return 0
}

container_shell() {
  local container="$1"
  local command="$2"
  printf '\n$ docker exec %q sh -c %q\n' "$container" "$command"
  docker exec "$container" sh -c "$command" 2>&1
  local status=$?
  printf '[exit=%s]\n' "$status"
  return 0
}

select_container() {
  local role="$1"
  local current="$2"
  if [[ -n "$current" ]]; then
    if ! docker inspect "$current" >/dev/null 2>&1; then
      echo "container not found: $current" >&2
      return 2
    fi
    printf '%s' "$current"
    return
  fi

  local filter="label=luanniao.role=$role"
  local run_filter=""
  if [[ -n "$RUN_REF" ]]; then
    run_filter="--filter label=luanniao.run_ref=$RUN_REF"
  fi
  # Docker lists the newest running container first. The report prints all
  # candidates so an ambiguous selection is visible to the operator.
  local candidates
  # shellcheck disable=SC2086
  candidates="$(docker ps -q --filter "$filter" $run_filter 2>/dev/null)"
  if [[ -z "$candidates" ]]; then
    echo "no running $role container found" >&2
    return 2
  fi
  printf '%s\n' "$candidates" | head -n 1
}

prepare_temporary_executor() {
  if [[ -n "$EXECUTOR" ]]; then
    echo "--start-executor cannot be combined with --executor" >&2
    exit 2
  fi
  if ! docker image inspect "$EXECUTOR_IMAGE" >/dev/null 2>&1; then
    echo "Executor image not found: $EXECUTOR_IMAGE" >&2
    echo "Build it with: npm run build:executor-image" >&2
    exit 2
  fi

  local networks network_name network_ip network_role
  networks="$(docker inspect "$GATEWAY" \
    --format '{{range $name, $network := .NetworkSettings.Networks}}{{println $name $network.IPAddress}}{{end}}')"
  while read -r network_name network_ip; do
    [[ -n "$network_name" && -n "$network_ip" ]] || continue
    network_role="$(docker network inspect "$network_name" \
      --format '{{index .Labels "luanniao.role"}}' 2>/dev/null || true)"
    if [[ "$network_role" == "task-network" ]]; then
      TASK_NETWORK="$network_name"
      TASK_GATEWAY_IP="$network_ip"
      break
    fi
  done <<< "$networks"
  if [[ -z "$TASK_NETWORK" || -z "$TASK_GATEWAY_IP" ]]; then
    echo "Could not find the Gateway task network" >&2
    exit 2
  fi

  CA_FILE="$(docker inspect "$GATEWAY" \
    --format '{{range .Mounts}}{{if eq .Destination "/traffic/ca"}}{{.Source}}/mitmproxy-ca-cert.pem{{end}}{{end}}' \
    | head -n 1)"
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/luanniao-baidu-diagnostic.XXXXXX")"
  printf 'nameserver %s\noptions ndots:0\n' "$TASK_GATEWAY_IP" > "$TEMP_DIR/resolv.conf"
  chmod 0444 "$TEMP_DIR/resolv.conf"
  TEMP_EXECUTOR="luanniao-baidu-diagnostic-${BASHPID}-${RANDOM}"

  local run_args=(
    run -d --name "$TEMP_EXECUTOR"
    --label luanniao.managed=false
    --label luanniao.role=diagnostic-executor
    --user 1000:1000
    --cap-drop ALL
    --security-opt no-new-privileges
    --read-only
    --tmpfs /tmp:rw,exec,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=1777
    --pids-limit 128
    --memory 512m
    --cpus 1
    --network "$TASK_NETWORK"
    --dns "$TASK_GATEWAY_IP"
    --mount "type=bind,src=$TEMP_DIR/resolv.conf,dst=/etc/resolv.conf,readonly"
    --workdir /tmp
  )
  if [[ -f "$CA_FILE" ]]; then
    run_args+=(
      --mount "type=bind,src=$CA_FILE,dst=/etc/luanniao/traffic-proxy-ca.crt,readonly"
      --env SSL_CERT_FILE=/etc/luanniao/traffic-proxy-ca.crt
      --env CURL_CA_BUNDLE=/etc/luanniao/traffic-proxy-ca.crt
      --env REQUESTS_CA_BUNDLE=/etc/luanniao/traffic-proxy-ca.crt
      --env NODE_EXTRA_CA_CERTS=/etc/luanniao/traffic-proxy-ca.crt
    )
  fi
  run_args+=("$EXECUTOR_IMAGE" sleep infinity)

  section "Temporary Executor startup"
  run_cmd docker "${run_args[@]}"
  if [[ "$(docker inspect --format '{{.State.Running}}' "$TEMP_EXECUTOR" 2>/dev/null || true)" != "true" ]]; then
    echo "Temporary Executor did not start: $TEMP_EXECUTOR" >&2
    exit 2
  fi

  local init_command
  init_command="set -eu; ip route replace default via $TASK_GATEWAY_IP; iptables -t raw -C OUTPUT -d 127.0.0.11 -p udp --dport 53 -j DROP 2>/dev/null || iptables -t raw -I OUTPUT -d 127.0.0.11 -p udp --dport 53 -j DROP; iptables -t raw -C OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j DROP 2>/dev/null || iptables -t raw -I OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j DROP; ip route get $TASK_GATEWAY_IP"
  section "Temporary Executor network initialization"
  printf '\n$'
  printf ' %q' docker run --rm --network none --pid "container:$TEMP_EXECUTOR" \
    --user 0 --privileged --read-only --pids-limit 32 --memory 128m --cpus 0.25 \
    "$EXECUTOR_IMAGE" nsenter --target 1 --net sh -c "$init_command"
  printf '\n'
  docker run --rm --network none --pid "container:$TEMP_EXECUTOR" \
    --user 0 --privileged --read-only --pids-limit 32 --memory 128m --cpus 0.25 \
    "$EXECUTOR_IMAGE" nsenter --target 1 --net sh -c "$init_command" 2>&1
  local init_status=$?
  printf '[exit=%s]\n' "$init_status"
  if (( init_status != 0 )); then
    echo "Temporary Executor network initialization failed" >&2
    exit 2
  fi
  EXECUTOR="$TEMP_EXECUTOR"
  echo "temporary_executor=$EXECUTOR"
  echo "task_network=$TASK_NETWORK gateway_task_ip=$TASK_GATEWAY_IP"
}

section "Host and Docker"
run_cmd date -u
run_cmd uname -a
run_cmd docker context show
run_cmd docker version --format 'client={{.Client.Version}} server={{.Server.Version}}'
run_cmd docker info --format 'os={{.OperatingSystem}} kernel={{.KernelVersion}} rootless={{json .SecurityOptions}}'
run_shell 'command -v systemd-detect-virt >/dev/null && systemd-detect-virt || true'
run_shell 'ip -4 route || true'

if ! GATEWAY="$(select_container gateway "$GATEWAY")"; then
  echo "Cannot continue without a running Gateway container." >&2
  exit 2
fi
if [[ "$START_EXECUTOR" == "1" ]]; then
  prepare_temporary_executor
else
  if ! EXECUTOR="$(select_container executor "$EXECUTOR")"; then
    echo "Cannot continue without a running Executor container." >&2
    exit 2
  fi
fi

section "Selected containers"
echo "gateway=$GATEWAY"
echo "executor=$EXECUTOR"
run_cmd docker ps --no-trunc --filter "id=$GATEWAY" \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
run_cmd docker ps --no-trunc --filter "id=$EXECUTOR" \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
run_cmd docker inspect "$GATEWAY" --format \
  'gateway networks={{json .NetworkSettings.Networks}} extra_hosts={{json .HostConfig.ExtraHosts}} image={{.Image}}'
run_cmd docker inspect "$EXECUTOR" --format \
  'executor networks={{json .NetworkSettings.Networks}} image={{.Image}}'

BROKER="$(docker inspect "$GATEWAY" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^LUANNIAO_DIRECT_BROKER=//p' | head -n 1)"
BROKER_PORT=""
if [[ "$BROKER" == *:* ]]; then
  BROKER_PORT="${BROKER##*:}"
fi

section "Gateway configuration"
if [[ -n "$BROKER" ]]; then
  echo "direct_broker=$BROKER"
else
  echo "direct_broker=<missing>"
fi
run_cmd docker inspect "$GATEWAY" --format \
  '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(LUANNIAO_TASK_NETWORK_CIDR|LUANNIAO_CONTROL_NETWORK_CIDR|LUANNIAO_AUTHORIZED_CIDRS|LUANNIAO_AUTHORIZED_DOMAINS)=' || true
run_cmd docker inspect "$GATEWAY" --format \
  '{{json .HostConfig.ExtraHosts}}'
container_shell "$GATEWAY" 'cat /etc/hosts; echo; ip -4 addr; echo; ip -4 route; echo; ip rule; echo; ip route show table 4242 || true'
container_shell "$GATEWAY" 'gatewayctl health "{}"'

section "Gateway to host broker"
if [[ -n "$BROKER_PORT" ]]; then
  container_shell "$GATEWAY" \
    "getent hosts host.docker.internal; echo; nc -vz -w 3 host.docker.internal $BROKER_PORT"
  run_shell "ss -ltnp 2>/dev/null | grep ':$BROKER_PORT' || true"
else
  echo "Cannot probe broker because LUANNIAO_DIRECT_BROKER is missing."
fi

section "Kali host to Baidu without proxy"
run_shell "env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy curl -q -4 -v --proxy '' --noproxy '*' --connect-timeout '$CONNECT_TIMEOUT' --max-time '$MAX_TIME' '$URL'"
run_shell 'getent ahostsv4 www.baidu.com 2>/dev/null | awk "{print \$1}" | sort -u | head -n 8 || true'

section "Executor network and DNS"
container_shell "$EXECUTOR" 'id; echo; env | grep -i proxy || true; echo; ip -4 addr; echo; ip -4 route; echo; cat /etc/resolv.conf; echo; getent ahostsv4 www.baidu.com || true'
container_shell "$EXECUTOR" 'for ip in $(getent ahostsv4 www.baidu.com 2>/dev/null | awk "{print \$1}" | sort -u | head -n 8); do echo "route to $ip"; ip route get "$ip" || true; done'

section "Executor to Baidu: explicit no-proxy path"
container_shell "$EXECUTOR" \
  "env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy curl -q -4 -v --proxy '' --noproxy '*' --connect-timeout '$CONNECT_TIMEOUT' --max-time '$MAX_TIME' '$URL'"

section "Executor to Baidu: normal curl path"
container_shell "$EXECUTOR" \
  "curl -q -4 -v --connect-timeout '$CONNECT_TIMEOUT' --max-time '$MAX_TIME' '$URL'"

section "Gateway logs"
run_cmd docker logs --tail 200 "$GATEWAY"

section "Interpretation"
cat <<'EOF'
The report separates four boundaries:
  1. Kali host -> Baidu: proves the VM's own no-proxy egress.
  2. Gateway -> host.docker.internal:<broker-port>: proves the broker first hop.
  3. Executor route/DNS: proves task network initialization and scoped DNS.
  4. Executor -> Baidu: proves the complete transparent path.

--noproxy '*' only changes curl's explicit proxy selection. It does not bypass
the Gateway TUN, policy routing, Scope firewall, or host egress broker.

The script does not print LUANNIAO_DIRECT_BROKER_TOKEN or other secrets.
EOF

echo
echo "Report saved to: $OUTPUT"
