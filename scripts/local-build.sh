#!/usr/bin/env bash
set -euo pipefail

TOKEN="${NODE_GITHUB_TOKEN:-${NODE_AUTH_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
	echo "ERROR: NODE_GITHUB_TOKEN or NODE_AUTH_TOKEN must be set" >&2
	exit 1
fi

docker build -t ghcr.io/gormantec/docker-rn-preview:latest .
echo "$TOKEN" | docker login ghcr.io -u gormantec --password-stdin
docker push ghcr.io/gormantec/docker-rn-preview:latest