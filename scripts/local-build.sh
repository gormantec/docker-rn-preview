#!/bin/bash
docker build -t ghcr.io/gormantec/docker-rn-preview:latest .
echo "$NODE_GITHUB_TOKEN" | docker login ghcr.io -u gormantec --password-stdin
docker push ghcr.io/gormantec/docker-rn-preview:latest