#!/bin/sh
# Copies the app into public/, which Caddy mounts. No build step - these are
# plain static files.
#
# Never delete the public/ directory itself (`rm -rf public`): the bind mount
# holds the inode from the moment the container started, so once it is gone the
# proxy sees an empty directory and serves 404 until it restarts. Clear the
# contents instead.
set -e
cd "$(dirname "$0")"
mkdir -p public
find public -mindepth 1 -delete
cp index.html styles.css public/
cp -r js public/
echo "public/: $(find public -type f | wc -l) files, $(du -sh public | cut -f1)"
