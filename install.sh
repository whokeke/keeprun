#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${KEEPRUN_REPO:-whokeke/keeprun}"
REF="${KEEPRUN_REF:-main}"
DEST="${KEEPRUN_DEST:-${HOME}/.config/opencode}"
RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}/${REF}"

FILES=(
  "agents/keeprun-plan.md"
  "agents/keeprun-worker.md"
  "plugins/keeprun.ts"
  "command/keeprun.md"
  "command/keepstop.md"
)

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

src_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "${candidate}/plugins/keeprun.ts" ]; then
    src_dir="$candidate"
  fi
fi

if [ -n "$src_dir" ]; then
  mode="local"
else
  mode="remote"
  command -v curl >/dev/null 2>&1 || fail "curl is required for remote install"
fi

say "keeprun installer (${mode} mode)"
say "  source: ${src_dir:-$RAW_BASE}"
say "  dest:   ${DEST}"

mkdir -p "${DEST}/agents" "${DEST}/plugins" "${DEST}/command"

tmpdir=""
if [ "$mode" = "remote" ]; then
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
fi

stamp="$(date +%Y%m%d%H%M%S)"

for rel in "${FILES[@]}"; do
  target="${DEST}/${rel}"
  mkdir -p "$(dirname "$target")"

  if [ "$mode" = "local" ]; then
    src="${src_dir}/${rel}"
  else
    src="${tmpdir}/${rel//\//_}"
    curl -fsSL "${RAW_BASE}/${rel}" -o "$src" || fail "download failed: ${RAW_BASE}/${rel}"
  fi

  if [ -f "$target" ] && cmp -s "$src" "$target"; then
    say "  unchanged: ${target}"
    continue
  fi
  if [ -f "$target" ]; then
    bak="${target}.keeprun-bak.${stamp}"
    cp -p "$target" "$bak"
    say "  backup:    ${bak}"
  fi
  cp -p "$src" "$target"
  say "  install:   ${target}"
done

say ""
say "keeprun installed successfully."
say "Restart opencode, then run: /keeprun <task>"
say "Stop any time with: /keepstop"
