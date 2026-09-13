#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/sla-isolated-build.XXXXXX")
trap 'rm -rf -- "$TMP"' EXIT

mkdir -p "$TMP/packages/wasm-core"
cp "$HERE/build.sh" "$HERE/probe_sla_source_group.sh" \
  "$HERE/slasupport_bridge.h" "$HERE/slasupport_bridge.cpp" \
  "$HERE/slasupport_bridge_validate.cpp" "$TMP/packages/wasm-core/"
cp -R "$HERE/slasupport_port" "$TMP/packages/wasm-core/"

if test -e "$TMP/slicers"; then
  echo 'isolated_build: unexpected slicers checkout copied' >&2
  exit 1
fi

output=$(bash "$TMP/packages/wasm-core/probe_sla_source_group.sh")
printf '%s\n' "$output"
case "$output" in
  *'sla_source_probe: 9 translation units; dependencies isolated; relocatable link passed'*) ;;
  *) echo 'isolated_build: source probe did not pass' >&2; exit 1 ;;
esac

if rg -n --glob '*.cpp' --glob '*.hpp' --glob '*.h' \
  'slicers/|web3d_slicer' \
  "$TMP/packages" >/dev/null; then
  echo 'isolated_build: copied package contains a checkout-relative slicers dependency' >&2
  exit 1
fi

test -s "$TMP/packages/wasm-core/slasupport_port/SOURCE_MANIFEST.json"
echo 'isolated_build: temporary packages copy passed with slicers unavailable'
