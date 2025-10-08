#!/usr/bin/env bash
set -euo pipefail

# run_server.sh [start|stop|restart|status] [web|worker]
# or run_server.sh web  -> run foreground (dev)
# run_server.sh logs cleanup [days]  -> delete logs older than DAYS (default 7)

# Load .env if present (simple parsing)

# parse minimal flags: --env-file, --host, --port
ENVFILE_DEFAULT='.env'
ENVFILE=""
HOST='127.0.0.1'
PORT='5000'
# New flags
PARALLEL=0
WAIT_VERIFY=1
WAIT_TIMEOUT=5
REQUIRE_REDIS=0

shift_args=()

# Collect raw args for later parsing
RAW_ARGS=("$@")

# Simple pass to extract known flags anywhere in the args
for ((i=0;i<${#RAW_ARGS[@]};i++)); do
  a=${RAW_ARGS[$i]}
  case "$a" in
    --env-file)
      ENVFILE=${RAW_ARGS[$((i+1))]:-}
      i=$((i+1))
      ;;
    --parallel)
      PARALLEL=1
      ;;
    --require-redis)
      REQUIRE_REDIS=1
      ;;
    --wait)
      WAIT_VERIFY=1
      ;;
    --no-wait)
      WAIT_VERIFY=0
      ;;
    --wait-timeout)
      WAIT_TIMEOUT=${RAW_ARGS[$((i+1))]:-}
      i=$((i+1))
      ;;
    --host)
      HOST=${RAW_ARGS[$((i+1))]:-}
      i=$((i+1))
      ;;
    --port)
      PORT=${RAW_ARGS[$((i+1))]:-}
      i=$((i+1))
      ;;
    *)
      shift_args+=("$a")
      ;;
  esac
done

# reassign positional params to cleaned args (action/service)
set -- "${shift_args[@]:-}"
ACTION=${1:-}
SERVICE=${2:-}
PYTHON=${PYTHON:-.venv/bin/python}

# load env file if present: prefer specified, then .env
# Use a safer sourcing approach so quoted values and spaces are handled.
if [ -n "$ENVFILE" ] && [ -f "$ENVFILE" ]; then
  echo "Loading env from $ENVFILE"
  # export all variables sourced from the file
  set -o allexport
  # shellcheck disable=SC1090
  source "$ENVFILE" || true
  set +o allexport
elif [ -f "$ENVFILE_DEFAULT" ]; then
  echo "Loading env from $ENVFILE_DEFAULT"
  set -o allexport
  # shellcheck disable=SC1090
  source "$ENVFILE_DEFAULT" || true
  set +o allexport
fi

# Honor environment override for requiring Redis
if [ "${REQUIRE_REDIS:-0}" = "1" ] || [ "${REQUIRE_REDIS}" = "true" ] || [ "${REQUIRE_REDIS}" = "True" ]; then
  REQUIRE_REDIS=1
else
  REQUIRE_REDIS=${REQUIRE_REDIS:-0}
fi

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)
RUNDIR="$ROOT_DIR/.run"
LOGDIR="$ROOT_DIR/logs"
mkdir -p "$RUNDIR" "$LOGDIR"

# special subcommands that don't require a service
if [ "$ACTION" = "logs" ]; then
  SUBACTION=${SERVICE:-}
  DAYS=${3:-7}
  case "$SUBACTION" in
    cleanup)
      echo "Cleaning logs older than $DAYS days in $LOGDIR"
      # find files older than DAYS and remove them; print what's removed
      find "$LOGDIR" -type f -mtime +"$DAYS" -print -exec rm -f {} \;
      exit 0
      ;;
    *)
      echo "Usage: $0 logs cleanup [days]"
      exit 1
      ;;
  esac
fi

pidfile_for() {
  case "$1" in
    web) echo "$RUNDIR/server_web.pid" ;;
    worker) echo "$RUNDIR/server_worker.pid" ;;
    redis) echo "$RUNDIR/server_redis.pid" ;;
    *) echo "$RUNDIR/server_${1}.pid" ;;
  esac
}

log_for() {
  case "$1" in
    web) echo "$LOGDIR/web.out" ;;
    worker) echo "$LOGDIR/worker.out" ;;
    redis) echo "$LOGDIR/redis.out" ;;
    *) echo "$LOGDIR/${1}.out" ;;
  esac
}

redis_container_file() {
  echo "$RUNDIR/redis.cid"
}

start_service() {
  svc=$1
  pidfile=$(pidfile_for "$svc")
  logfile=$(log_for "$svc")
  # Delegate redis to its helper
  if [ "$svc" = "redis" ]; then
    start_redis
    return
  fi
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "$svc already running (pid $pid)"
      return 0
    else
      echo "Removing stale pidfile $pidfile"
      rm -f "$pidfile"
    fi
  fi

  if [ "$svc" = "web" ]; then
    echo "Starting web server (background). Logs: $logfile"
    FLASK_HOST="$HOST" FLASK_PORT="$PORT" nohup "$PYTHON" backend.py >"$logfile" 2>&1 &
    echo $! >"$pidfile"
    sleep 0.5
    echo "web pid $(cat "$pidfile")"
    # optional verification: wait until port is bound
    if [ "$WAIT_VERIFY" -eq 1 ]; then
      wait_for_port "$HOST" "$PORT" "$WAIT_TIMEOUT" && echo "web appears to be listening on $HOST:$PORT" || echo "Warning: web did not bind within timeout"
    fi
  else
    echo "Starting worker (background). Logs: $logfile"
    nohup "$PYTHON" -m celery -A tasks.celery_app worker --loglevel=info >"$logfile" 2>&1 &
    echo $! >"$pidfile"
    sleep 0.5
    echo "worker pid $(cat "$pidfile")"
    if [ "$WAIT_VERIFY" -eq 1 ]; then
      wait_for_worker_start "$logfile" "$WAIT_TIMEOUT" && echo "worker started (log verified)" || echo "Warning: worker did not appear to start within timeout"
    fi
  fi
}

# Redis helpers: try redis-server, brew services, or Docker fallback
start_redis() {
  pidfile=$(pidfile_for redis)
  logfile=$(log_for redis)
  cidfile=$(redis_container_file)
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "redis already running (pid $pid)"
      return 0
    else
      echo "Removing stale redis pidfile $pidfile"
      rm -f "$pidfile"
    fi
  fi

  # Prefer local redis-server if available
  if command -v redis-server >/dev/null 2>&1; then
    echo "Starting redis-server (background). Logs: $logfile"
    # run with minimal persistence disabled for dev
    nohup redis-server --save "" --appendonly no >"$logfile" 2>&1 &
    echo $! >"$pidfile"
    sleep 0.5
    echo "redis pid $(cat "$pidfile")"
    return 0
  fi

  # macOS: try brew services
  if command -v brew >/dev/null 2>&1; then
    echo "Attempting to start redis via 'brew services'"
    if brew services start redis >/dev/null 2>&1; then
      echo "Started redis via brew services"
      # brew runs as a service; we can't easily capture pid — create marker
      echo "brew" >"$pidfile"
      return 0
    fi
  fi

  # Docker fallback
  if command -v docker >/dev/null 2>&1; then
    echo "Starting redis via docker (fallback). Logs: $logfile"
    # run docker but don't allow failures to abort the script (set -e is enabled)
    cid=$(docker run -d --rm -p 6379:6379 redis:7.0-alpine 2>/dev/null) || cid=""
    if [ -n "$cid" ]; then
      echo "$cid" >"$cidfile"
      echo "docker redis cid $cid"
      return 0
    fi
  fi

  echo "Could not start redis: no redis-server, brew, or docker available. Please install Redis or run 'redis-server' manually."
  # fallback: enable Celery eager mode by writing a marker file so tasks run synchronously
  echo "Falling back to CELERY_EAGER=1 (tasks will run synchronously)"
  echo "1" >"$RUNDIR/.celery_eager"
  export CELERY_EAGER=1
  return 1
}

stop_redis() {
  pidfile=$(pidfile_for redis)
  cidfile=$(redis_container_file)
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if [ "$pid" = "brew" ]; then
      echo "Stopping redis via brew services"
      brew services stop redis || true
    else
      if kill -0 "$pid" >/dev/null 2>&1; then
        echo "Stopping redis (pid $pid)"
        kill "$pid" || true
      fi
      rm -f "$pidfile"
    fi
  fi
  if [ -f "$cidfile" ]; then
    cid=$(cat "$cidfile")
    echo "Stopping docker redis container $cid"
    docker stop "$cid" || true
    rm -f "$cidfile"
  fi
  # remove eager marker if present
  if [ -f "$RUNDIR/.celery_eager" ]; then
    rm -f "$RUNDIR/.celery_eager" || true
  fi
}

status_redis() {
  pidfile=$(pidfile_for redis)
  cidfile=$(redis_container_file)
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if [ "$pid" = "brew" ]; then
      echo "redis running (brew service)"
      return 0
    fi
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "redis running (pid $pid)"
      return 0
    fi
  fi
  if [ -f "$cidfile" ]; then
    cid=$(cat "$cidfile")
    # check docker container state
    if command -v docker >/dev/null 2>&1; then
      state=$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)
      if [ "$state" = "true" ]; then
        echo "redis running (docker cid $cid)"
        return 0
      fi
    fi
  fi
  echo "redis not running"
  return 1
}

# Wait for a TCP port to be listening. Returns 0 if success, non-zero on timeout.
wait_for_port() {
  host=$1
  port=$2
  timeout=${3:-5}
  start=$(date +%s)
  while :; do
    # use nc (netcat) if available, otherwise try python socket
    if command -v nc >/dev/null 2>&1; then
      nc -z "$host" "$port" >/dev/null 2>&1 && return 0 || true
    else
      python - <<PY >/dev/null 2>&1
import socket,sys
s=socket.socket()
try:
  s.connect(("%s", %s))
  s.close()
  sys.exit(0)
except Exception:
  sys.exit(1)
PY
      if [ $? -eq 0 ]; then
        return 0
      fi
    fi
    now=$(date +%s)
    if [ $((now-start)) -ge $timeout ]; then
      return 1
    fi
    sleep 0.5
  done
}

# Watch worker log for a start indicator within timeout. Returns 0 if found.
wait_for_worker_start() {
  logfile=$1
  timeout=${2:-5}
  start=$(date +%s)
  while :; do
    if [ -f "$logfile" ]; then
      if grep -E "\b(worker\b|ready|Running|Booting)" "$logfile" >/dev/null 2>&1; then
        return 0
      fi
    fi
    now=$(date +%s)
    if [ $((now-start)) -ge $timeout ]; then
      return 1
    fi
    sleep 0.5
  done
}

stop_service() {
  svc=$1
  # Delegate redis stop to its helper
  if [ "$svc" = "redis" ]; then
    stop_redis
    return
  fi
  pidfile=$(pidfile_for "$svc")
  if [ ! -f "$pidfile" ]; then
    echo "No pidfile for $svc; not running? ($pidfile)"
    return 0
  fi
  pid=$(cat "$pidfile")
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "Stopping $svc (pid $pid)"
    kill "$pid"
    # wait a bit
    for i in {1..10}; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        sleep 0.2
      else
        break
      fi
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "Force killing $pid"
      kill -9 "$pid" || true
    fi
  else
    echo "Process $pid not running, removing pidfile"
  fi
  rm -f "$pidfile"
}

status_service() {
  svc=$1
  # Delegate redis status to its helper
  if [ "$svc" = "redis" ]; then
    status_redis
    return
  fi
  pidfile=$(pidfile_for "$svc")
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "$svc running (pid $pid)"
      return 0
    else
      echo "$svc pidfile exists but process not running"
      return 1
    fi
  else
    echo "$svc not running"
    return 3
  fi
}

if [ -z "$ACTION" ]; then
  # No action provided — print a concise help message
  cat <<EOF
Usage: $0 [start|stop|restart|status] [web|worker|all]
  $0 web|worker               # run in foreground (dev)
       $0 --env-file <file> [start|stop] ...   # accepts --env-file, --host, --port anywhere
       $0 logs cleanup [days]      # remove logs older than DAYS (default 7)
      $0 start all --parallel      # start web, worker and redis (attempts; falls back to eager mode)

Common flags (can appear anywhere):
  --env-file <file>   Load environment variables from <file> (defaults to .env if present)
  --host <host>       Host to bind the web server (default: 127.0.0.1)
  --port <port>       Port for the web server (default: 5000)

Examples:
  $0 start web --env-file .env --host 127.0.0.1 --port 5100
  $0 web --env-file .env
  $0 logs cleanup 30

EOF
  exit 0
fi

if [ -z "$SERVICE" ]; then
  echo "Service required: web or worker"
  echo "Usage: $0 [start|stop|restart|status] [web|worker]"
  exit 1
fi

case "$ACTION" in
  start)
    if [ "$SERVICE" = "all" ] || [ "$SERVICE" = "both" ]; then
      # ensure redis is running before starting worker; capture success without
      # letting 'set -e' abort the script on non-zero exit.
      if start_redis; then
        redis_ok=0
      else
        redis_ok=$?
      fi
      if [ "$REQUIRE_REDIS" -eq 1 ] && [ "$redis_ok" -ne 0 ]; then
        echo "ERROR: Redis is required but could not be started. Aborting start all."
        exit 1
      fi
      if [ "$PARALLEL" -eq 1 ]; then
        start_service web &
        start_service worker &
        wait
      else
        start_service web
        start_service worker
      fi
    else
      start_service "$SERVICE"
    fi
    ;;
  stop)
    if [ "$SERVICE" = "all" ] || [ "$SERVICE" = "both" ]; then
      if [ "$PARALLEL" -eq 1 ]; then
        stop_service web &
        stop_service worker &
        wait
      else
        stop_service web
        stop_service worker
      fi
      # stop redis after both services are stopped
      stop_redis || true
    else
      stop_service "$SERVICE"
    fi
    ;;
  restart)
    if [ "$SERVICE" = "all" ] || [ "$SERVICE" = "both" ]; then
      # restart both: ensure redis is restarted around worker
      stop_service web || true
      stop_service worker || true
      stop_redis || true
      start_redis || true
      if [ "$PARALLEL" -eq 1 ]; then
        start_service web &
        start_service worker &
        wait
      else
        start_service web
        start_service worker
      fi
    else
      stop_service "$SERVICE" || true
      start_service "$SERVICE"
    fi
    ;;
  status)
    if [ "$SERVICE" = "all" ] || [ "$SERVICE" = "both" ]; then
      status_service web
      status_service worker
    else
      status_service "$SERVICE"
    fi
    ;;
  *)
    echo "Unknown action: $ACTION"
    echo "Usage: $0 [start|stop|restart|status] [web|worker]"
    exit 1
    ;;
esac

