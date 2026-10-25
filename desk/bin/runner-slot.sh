#!/usr/bin/env bash
# One single-use GitHub Actions runner per slot, inside the desk-runner VM; run as root there.
# desk-runner copies it in and calls it; nothing on the Mac runs it.
#   start <id> <repo> <runner-id> <slot image> <dind image>   the runner's JIT config on stdin
#   list                                                     <id> <repo> <runner-id> <state>, one per slot
#   reap <id>                                                remove the slot's containers, volumes and network
#
# A slot is ARC's dind pattern: its own Docker daemon (dind) on a network of its own, and the runner
# sharing dind's network, so a service container mapped to 5432 is on the runner's localhost:5432.
# The workspace and the runner's externals are volumes at the same path in both, so a container job
# sees the workspace. Slots share no daemon, volume or network. dind runs under sysbox, not
# --privileged: a job's own containers, privileged ones included, stay inside the slot's user
# namespace and cannot reach the VM's disk, another slot's volumes or the slot image.
set -euo pipefail
P=desk-slot
SOCK=/var/run/dind/docker.sock

reap() {
  local n="$P-$1" v
  docker rm -f -v "$n-runner" "$n-dind" >/dev/null 2>&1 || true
  for v in work ext sock; do docker volume rm "$n-$v" >/dev/null 2>&1 || true; done
  docker network rm "$n" >/dev/null 2>&1 || true
}

start() {
  local id=$1 repo=$2 rid=$3 image=$4 dind=$5 n="$P-$1" jit i
  read -r jit || true
  [ -n "${jit:-}" ] || { echo "runner-slot: no JIT config on stdin" >&2; exit 2; }
  # A start that fails part-way leaves nothing behind for reap to miss.
  trap 'reap "$id"' ERR
  docker network create --label desk.slot="$id" "$n" >/dev/null
  for i in work ext sock; do docker volume create --label desk.slot="$id" "$n-$i" >/dev/null; done
  # An empty named volume takes the image's files on first mount: this fills externals from the runner image.
  docker run --rm --entrypoint true -v "$n-ext:/home/runner/externals" -v "$n-work:/home/runner/_work" "$image"
  docker run -d --name "$n-dind" --label desk.slot="$id" --runtime sysbox-runc --network "$n" \
    -v "$n-work:/home/runner/_work" -v "$n-ext:/home/runner/externals" -v "$n-sock:/var/run/dind" \
    -e DOCKER_TLS_CERTDIR= "$dind" dockerd --host="unix://$SOCK" >/dev/null
  for i in $(seq 60); do
    docker exec "$n-dind" docker -H "unix://$SOCK" info >/dev/null 2>&1 && break
    [ "$i" -eq 60 ] && { echo "runner-slot: the slot's Docker daemon did not start within 60s" >&2; false; }
    sleep 1
  done
  docker exec "$n-dind" chmod 666 "$SOCK"
  # The JIT config goes in through the environment, so it is never on a command line in the VM. The
  # runner itself is started with it as an argument, so a job step on this slot can read it; it
  # registers only this single-use runner.
  DESK_JITCONFIG=$jit docker run -d --name "$n-runner" --label desk.slot="$id" --label desk.repo="$repo" \
    --label desk.runner-id="$rid" --network "container:$n-dind" \
    -v "$n-work:/home/runner/_work" -v "$n-ext:/home/runner/externals" -v "$n-sock:/var/run/dind" \
    -e DOCKER_HOST="unix://$SOCK" -e DESK_JITCONFIG "$image" >/dev/null
  trap - ERR
}

case "${1:-}" in
  start) shift; [ $# -eq 5 ] || { echo "usage: runner-slot.sh start <id> <repo> <runner-id> <slot image> <dind image>" >&2; exit 2; }; start "$@" ;;
  list) docker ps -a --filter label=desk.repo --format '{{.Label "desk.slot"}} {{.Label "desk.repo"}} {{.Label "desk.runner-id"}} {{.State}}' ;;
  reap) [ $# -eq 2 ] || { echo "usage: runner-slot.sh reap <id>" >&2; exit 2; }; reap "$2" ;;
  *) sed -n '4,6p' "$0" | sed 's/^# //' >&2; exit 2 ;;
esac
