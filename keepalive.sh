#!/usr/bin/env bash
cd "$(dirname "$0")"
while true; do
  if ! pgrep -f "bun run index.ts" > /dev/null 2>&1; then
    echo "[$(date)] Бот упал — перезапуск..."
    nohup bun run index.ts >> bot.log 2>&1 &
    sleep 5
  fi
  curl -s http://localhost:3011/health > /dev/null 2>&1
  sleep 15
done
