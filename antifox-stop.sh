#!/usr/bin/env bash
# antifox-stop.sh — stop the local AntiFox stack (app container + recording proxy).
# Postgres is left running (holds task state, restarts fast); stop it too with:
#   podman compose -p antifox stop
set -u
cd /home/line/Hack/antifox || exit 1

if podman compose stop antifox 2>/dev/null; then
  notify-send -u normal -i utilities-terminal "AntiFox stopped" \
    "App + traffic proxy stopped. Postgres kept running (state is safe)." 2>/dev/null || true
else
  notify-send -u critical -i utilities-terminal "AntiFox stop failed" \
    "podman compose stop failed — check podman ps." 2>/dev/null || true
  exit 1
fi
