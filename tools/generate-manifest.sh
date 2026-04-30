#!/usr/bin/env bash
# Genera manifest.json escaneando /models/ — usar si tu hosting NO ejecuta PHP.
# Uso: bash tools/generate-manifest.sh

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="$ROOT/models"
OUT="$MODELS_DIR/manifest.json"

cd "$MODELS_DIR"
echo "[" > "$OUT"
first=1
for f in *.glb *.gltf; do
  [ -e "$f" ] || continue
  size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  if [ $first -eq 0 ]; then echo "," >> "$OUT"; fi
  echo -n "  {\"name\":\"$f\",\"url\":\"/models/$f\",\"size\":$size}" >> "$OUT"
  first=0
done
echo "" >> "$OUT"
echo "]" >> "$OUT"
echo "manifest.json regenerado en $OUT"
