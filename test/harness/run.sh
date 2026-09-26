#!/usr/bin/env bash
# Safe entry point for the harness.
#
#   test/harness/run.sh gate-7000
#   test/harness/run.sh --list
#   test/harness/run.sh --all
#
# It scrubs the DSH_* variables a DSH-hosted shell exports (DSH_HOME,
# DSH_PROFILE_DIR, ...) and then delegates to run.ts, which refuses to start at
# all when those point into a live ~/.dsh. run.ts itself never inherits them:
# the child always gets .runs/<case>/home.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=("$@")
if [ "${#ARGS[@]}" -eq 0 ]; then
  ARGS=(--list)
else
  case "${ARGS[0]}" in
    -*) ;;
    *) ARGS=(--case "${ARGS[0]}" "${ARGS[@]:1}") ;;
  esac
fi

exec env \
  -u DSH_HOME \
  -u DSH_PROFILE_DIR \
  -u DSH_PERMISSION_MODE \
  -u DSH_TELEMETRY_DISABLED \
  -u DSH_APPROVAL_POLICY \
  -u DSH_LOG_LEVEL \
  node "$HERE/run.ts" "${ARGS[@]}"
