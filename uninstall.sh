#!/usr/bin/env bash
set -euo pipefail

DEST="${KEEPRUN_DEST:-${HOME}/.config/opencode}"

FILES=(
  "agents/keeprun-plan.md"
  "plugins/keeprun.ts"
  "command/keeprun.md"
  "command/keepstop.md"
)

say() { printf '%s\n' "$*"; }

for rel in "${FILES[@]}"; do
  target="${DEST}/${rel}"
  latest=""
  for b in "${target}".keeprun-bak.*; do
    [ -e "$b" ] || continue
    if [ -z "$latest" ] || [ "$b" -nt "$latest" ]; then
      latest="$b"
    fi
  done
  if [ -n "$latest" ]; then
    cp -p "$latest" "$target"
    rm -f "$latest"
    say "restored: ${target} <- ${latest}"
  elif [ -e "$target" ]; then
    rm -f "$target"
    say "removed:  ${target}"
  else
    say "absent:   ${target}"
  fi
done

say ""
say "keeprun uninstalled. Restart opencode to unload the plugin."
