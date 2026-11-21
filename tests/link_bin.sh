# shellcheck shell=bash
# Sourced by suites that run desk/bin scripts from a scratch bin. link_bin <from> <dir> links every
# <from>/*.mjs into <dir> that is not there already, so a module the scripts import or run needs no test
# edit. Call it after writing the suite's fakes and copies, which it leaves in place; a fake written into
# <dir> later must rm the link first, or it writes through the link to the real module.
link_bin(){
  local f
  for f in "$1"/*.mjs; do [ -e "$2/${f##*/}" ] || [ -L "$2/${f##*/}" ] || ln -s "$f" "$2/${f##*/}"; done
}
