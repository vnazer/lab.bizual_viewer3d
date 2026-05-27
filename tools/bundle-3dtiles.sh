#!/usr/bin/env bash
# Regenera los bundles locales de 3d-tiles-renderer en /libs/3dtiles/.
# Se sirven localmente (en vez de esm.sh) para no depender de un CDN en runtime.
# `three` y `three/*` quedan externos: los resuelve el importmap de index.html.
# Uso: bash tools/bundle-3dtiles.sh [version]

set -e
VERSION="${1:-0.4.7}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/libs/3dtiles"
WORK="$(mktemp -d)"

echo "Instalando 3d-tiles-renderer@$VERSION + esbuild en $WORK ..."
cd "$WORK"
npm init -y >/dev/null 2>&1
npm install "3d-tiles-renderer@$VERSION" esbuild --no-audit --no-fund --loglevel=error

mkdir -p "$OUT"
for pair in "index:3d-tiles-renderer" "plugins:3d-tiles-renderer/plugins"; do
  name="${pair%%:*}"; pkg="${pair##*:}"
  echo "Bundling $pkg -> libs/3dtiles/$name.js"
  ./node_modules/.bin/esbuild "$pkg" \
    --bundle --format=esm --platform=browser \
    --external:three --external:three/* \
    --legal-comments=none \
    --outfile="$OUT/$name.js"
done

rm -rf "$WORK"
echo "Listo. Bundles regenerados en $OUT (version $VERSION)."
