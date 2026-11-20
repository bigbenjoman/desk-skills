# shellcheck shell=bash
# Template git repos for suites that build throwaway repos: each template is built once per run
# and copied for every case. Written for bash 3.2 as well as 4+.
#   repo_template <name> <builder>  builds template <name> unless it is already built
#   repo_copy <name> <dest>         copies it into <dest> (made if missing), remotes pointed there
# Templates live under $REPO_TPL_ROOT, which tests/run.sh sets once per run; a suite run on its own
# sets it to a directory of its own first. A name is one builder's: suites share a template only
# under the same name and builder.
# The builder is called with an empty directory to build in, and its exit status is the build's.
# Its git identity and dates are pinned, so a template's SHAs are the same on every run. A remote
# URL under that directory is stored relative to it, so no copy holds the template's path; a build
# that leaves the path anywhere else fails.
# Only one process builds a name: the others wait for its lock, and a template appears by rename
# once it is whole. A lock whose builder has died is taken over.
REPO_TPL_DATE="2020-01-01T00:00:00Z"
REPO_TPL_MARK="@REPO_TPL@"

# repo_tpl_remotes <dir> <from> <to>: every repo directly under <dir> (a checkout or a bare repo)
# with a remote URL beginning <from> has that start replaced by <to>.
repo_tpl_remotes(){
  local g key url
  for g in "$1"/*/.git "$1"/*.git; do
    [ -f "$g/config" ] || continue
    git --git-dir="$g" config --get-regexp '^remote\..*\.url$' 2>/dev/null | while read -r key url; do
      case "$url" in "$2"*) git --git-dir="$g" config "$key" "$3${url#"$2"}" ;; esac
    done
  done
}

repo_template(){
  local name=$1 builder=$2 root dir lock build pid
  root=${REPO_TPL_ROOT:-}
  [ -n "$root" ] || { echo "repo_template: REPO_TPL_ROOT is not set" >&2; return 2; }
  mkdir -p "$root" || return 2
  dir="$root/$name"; lock="$root/$name.lock"
  while [ ! -d "$dir" ]; do
    if mkdir "$lock" 2>/dev/null; then
      echo "$$" > "$lock/pid"
      if [ ! -d "$dir" ]; then
        build="$root/$name.build.$$"; rm -rf "$build"; mkdir "$build"
        if (export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t \
              GIT_COMMITTER_EMAIL=t@example.com GIT_AUTHOR_DATE="$REPO_TPL_DATE" GIT_COMMITTER_DATE="$REPO_TPL_DATE"
            "$builder" "$build"); then
          repo_tpl_remotes "$build" "$build/" "$REPO_TPL_MARK/"
          # Only remote URLs are rewritten, so a path anywhere else (a worktree's gitdir, a nested
          # repo, an alternate) would reach every copy: such a build fails instead.
          if grep -rqF "$build" "$build"; then
            rm -rf "$build" "$lock"; echo "repo_template: building $name left its own path in the template" >&2; return 1
          fi
          mv "$build" "$dir"
        else
          rm -rf "$build" "$lock"; echo "repo_template: building $name failed" >&2; return 1
        fi
      fi
      rm -rf "$lock"
    else
      pid=$(cat "$lock/pid" 2>/dev/null)
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
      sleep 0.1
    fi
  done
}

repo_copy(){
  local dir="${REPO_TPL_ROOT:-}/$1" dest=$2
  [ -d "$dir" ] || { echo "repo_copy: no template $1 (repo_template builds it)" >&2; return 2; }
  mkdir -p "$dest" && cp -a "$dir/." "$dest/" || return 1
  repo_tpl_remotes "$dest" "$REPO_TPL_MARK/" "$dest/"
}
