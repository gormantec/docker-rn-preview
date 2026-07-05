#!/bin/bash
echo "[rn-preview] Starting File API + Expo Preview"
echo "[rn-preview] File API port: ${FILE_API_PORT:-9091}"
echo "[rn-preview] Expo port: ${PORT:-19006}"
exec node /usr/src/app/src/file-server.mjs
