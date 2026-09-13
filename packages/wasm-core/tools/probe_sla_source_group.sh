#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MANIFEST="$HERE/slasupport_port/SOURCE_MANIFEST.json"
BUILD="$HERE/build.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/sla-source-probe.XXXXXX")
trap 'rm -rf -- "$TMP"' EXIT

node - "$MANIFEST" "$BUILD" <<'NODE'
const fs = require('node:fs')
const [manifestPath, buildPath] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const build = fs.readFileSync(buildPath, 'utf8')
const match = build.match(/^SLA_SRC="([^"]+)"/m)
if (!match) throw new Error('build.sh does not declare SLA_SRC')
const order = match[1].trim().split(/\s+/)
if (order.length !== 27) throw new Error(`expected 27 SLA translation units, got ${order.length}`)
if (JSON.stringify(order) !== JSON.stringify(manifest.build.sourceOrder))
  throw new Error('build.sh SLA_SRC order differs from SOURCE_MANIFEST.json')
if (manifest.translationUnits.length !== order.length)
  throw new Error('manifest translation-unit count differs from SLA_SRC')
for (const [index, localPath] of order.entries()) {
  const unit = manifest.translationUnits[index]
  if (!unit || unit.localPath !== localPath || unit.dependencyProbe.sourceOrder !== index)
    throw new Error(`manifest dependency probe mismatch at source order ${index}`)
}
console.log(order.join('\n'))
NODE

mkdir -p "$TMP/slasupport_port"
cp "$HERE/slasupport_bridge.h" "$HERE/slasupport_bridge.cpp" \
  "$HERE/slasupport_bridge_validate.cpp" "$HERE/slasupport_slicer_fallback.cpp" "$TMP/"
cp -R "$HERE/slasupport_port/." "$TMP/slasupport_port/"

if rg -n --glob '*.cpp' --glob '*.hpp' --glob '*.h' \
  'slicers/|web3d_slicer' \
  "$TMP" >/dev/null; then
  echo 'sla_source_probe: copied source contains a checkout-relative slicers dependency' >&2
  exit 1
fi

CXX=${CXX:-c++}
"$CXX" -std=c++17 -Wall -Wextra -Werror -I"$TMP" \
  -c "$TMP/slasupport_bridge_validate.cpp" -o "$TMP/slasupport_bridge_validate.o"
ld -r "$TMP/slasupport_bridge_validate.o" -o "$TMP/sla_group_probe.o"
test -s "$TMP/sla_group_probe.o"

echo 'sla_source_probe: 27 translation units; dependencies isolated; relocatable link passed'
