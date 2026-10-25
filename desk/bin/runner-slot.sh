#!/usr/bin/env bash
# One single-use GitHub Actions runner per slot, inside the desk-runner VM; run as root there.
# desk-runner copies it in and calls it; nothing on the Mac runs it.
#   start <id> <repo> <runner-id> <slot image> <dind image> <cpus> <memory-gb>   the runner's JIT config on stdin
#   list                     <id> <repo> <runner-id> <state> <cpus> <memory-gb>, one per slot (both empty without limits)
#   reap <id>                remove the slot's containers, volumes, network and slice
#
# A slot is ARC's dind pattern: its own Docker daemon (dind) on a network of its own, and the runner
# sharing dind's network, so a service container mapped to 5432 is on the runner's localhost:5432.
# The workspace and the runner's externals are volumes at the same path in both, so a container job
# sees the workspace. Slots share no daemon, volume or network, so one job cannot see another's.
#
# A slot's limits: both containers get its CPU set (<cpus>, e.g. 0-1) and its memory, so nproc and
# Node's os.availableParallelism() show the slot's CPUs in a step and in a container job, and
# /sys/fs/cgroup/memory.max shows its memory in a step. Both containers also sit in one systemd slice
# capped at that memory, so the runner, dind and every container dind starts (a container job, whose
# own memory.max reads max) share one limit rather than each having its own.
set -euo pipefail
P=desk-slot
SOCK=/var/run/dind/docker.sock

# A dash in a slice name nests it under another slice, so the id's dashes become underscores.
slice() { echo "deskslot_${1//-/_}.slice"; }

reap() {
  local n="$P-$1" v s
  s=$(slice "$1")
  docker rm -f "$n-runner" "$n-dind" >/dev/null 2>&1 || true
  for v in work ext sock; do docker volume rm "$n-$v" >/dev/null 2>&1 || true; done
  docker network rm "$n" >/dev/null 2>&1 || true
  systemctl stop "$s" >/dev/null 2>&1 || true
  systemctl revert "$s" >/dev/null 2>&1 || true
}

start() {
  local id=$1 repo=$2 rid=$3 image=$4 dind=$5 cpus=$6 mem=$7 n="$P-$1" s jit i
  local limits=()
  s=$(slice "$id")
  limits=(--cgroup-parent "$s" --cpuset-cpus "$cpus" --memory "${mem}g" --label desk.cpus="$cpus" --label desk.memory="$mem")
  read -r jit || true
  [ -n "${jit:-}" ] || { echo "runner-slot: no JIT config on stdin" >&2; exit 2; }
  # A start that fails part-way leaves nothing behind for reap to miss.
  trap 'reap "$id"' ERR
  systemctl start "$s"
  systemctl set-property --runtime "$s" MemoryMax="${mem}G" MemorySwapMax=0
  docker network create --label desk.slot="$id" "$n" >/dev/null
  for i in work ext sock; do docker volume create --label desk.slot="$id" "$n-$i" >/dev/null; done
  # An empty named volume takes the image's files on first mount: this fills externals from the runner image.
  docker run --rm --entrypoint true -v "$n-ext:/home/runner/externals" -v "$n-work:/home/runner/_work" "$image"
  docker run -d --name "$n-dind" --label desk.slot="$id" "${limits[@]}" --privileged --network "$n" \
    -v "$n-work:/home/runner/_work" -v "$n-ext:/home/runner/externals" -v "$n-sock:/var/run/dind" \
    -e DOCKER_TLS_CERTDIR= "$dind" dockerd --host="unix://$SOCK" >/dev/null
  for i in $(seq 60); do
    docker exec "$n-dind" docker -H "unix://$SOCK" info >/dev/null 2>&1 && break
    [ "$i" -eq 60 ] && { echo "runner-slot: the slot's Docker daemon did not start within 60s" >&2; false; }
    sleep 1
  done
  docker exec "$n-dind" chmod 666 "$SOCK"
  # The JIT config goes in through the environment, never the command line, and the image's entrypoint
  # unsets it before the runner starts, so no job step can read it.
  DESK_JITCONFIG=$jit docker run -d --name "$n-runner" --label desk.slot="$id" --label desk.repo="$repo" \
    --label desk.runner-id="$rid" "${limits[@]}" --network "container:$n-dind" \
    -v "$n-work:/home/runner/_work" -v "$n-ext:/home/runner/externals" -v "$n-sock:/var/run/dind" \
    -e DOCKER_HOST="unix://$SOCK" -e DESK_JITCONFIG "$image" >/dev/null
  trap - ERR
}

case "${1:-}" in
  start) shift; [ $# -eq 7 ] || { echo "usage: runner-slot.sh start <id> <repo> <runner-id> <slot image> <dind image> <cpus> <memory-gb>" >&2; exit 2; }; start "$@" ;;
  list) docker ps -a --filter label=desk.repo --format '{{.Label "desk.slot"}} {{.Label "desk.repo"}} {{.Label "desk.runner-id"}} {{.State}} {{.Label "desk.cpus"}} {{.Label "desk.memory"}}' ;;
  reap) [ $# -eq 2 ] || { echo "usage: runner-slot.sh reap <id>" >&2; exit 2; }; reap "$2" ;;
  *) sed -n '4,6p' "$0" | sed 's/^# //' >&2; exit 2 ;;
esac
