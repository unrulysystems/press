#!/bin/sh
set -eu

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"

volume_name="${COMPOSE_PROJECT_NAME}_postgres-data"
if docker volume inspect "$volume_name" >/dev/null 2>&1; then
  docker volume rm "$volume_name"
fi
