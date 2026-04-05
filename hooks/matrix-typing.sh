#!/bin/bash
MATRIX_API="http://matrix:${MATRIX_API_PORT:-8793}"
curl -sf -X POST "$MATRIX_API/typing" \
  -H 'Content-Type: application/json' \
  -d "{\"typing\":${1:-true}}" > /dev/null 2>&1 || true
