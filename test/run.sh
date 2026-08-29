#!/bin/sh
# There is no node on the host, so everything runs in a container.
#   *.test.mjs — geometry, detection, tracking and the pipeline, on synthetic
#                camera frames with known ground truth
#   smoke.mjs  — the real index.html and app.js in jsdom, with a fake camera
#                and a fake WebGL context
#
# --unit skips the jsdom pass (it installs jsdom over the network).
set -e
cd "$(dirname "$0")/.."

echo "== geometry and tracking (node --test) =="
docker run --rm -v "$PWD:/app:ro" -w /app node:22-alpine node --test test/*.test.mjs

[ "$1" = "--unit" ] && exit 0

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -r index.html styles.css js test "$work/"
echo '{"type":"module"}' > "$work/package.json"

echo "== app in jsdom =="
# --user so the node_modules it writes can be cleaned up from the host afterwards.
docker run --rm -v "$work:/w" -w /w -e HOME=/w --user "$(id -u):$(id -g)" \
	node:22-alpine sh -c 'npm install --silent --no-fund --no-audit jsdom >/dev/null 2>&1 && node test/smoke.mjs'
