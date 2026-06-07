#!/usr/bin/env bash
set -euo pipefail

mkdir -p .trigger/tmp/store
npx trigger.dev@latest dev
