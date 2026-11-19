#!/bin/sh
set -e

# bind mount 上来的宿主机目录，属主通常是 root；容器里进程跑的是 node(1000)，
# 直接写会 EACCES。这里以 root 起一次、把 $DATA_DIR 属主改对，然后立刻降权执行，
# 省掉部署时手动 mkdir + chown（postgres/redis 官方镜像同款做法）。
if [ "$(id -u)" = "0" ]; then
  : "${DATA_DIR:=/data}"
  export DATA_DIR

  mkdir -p "$DATA_DIR"
  # rootless docker / podman 下 bind mount 可能不允许 chown（EPERM）。
  # 这种情况不该让容器起不来，只告警；真写不进去时日志里会有 EACCES。
  if ! chown -R node:node "$DATA_DIR" 2>/dev/null; then
    echo "[entrypoint] 警告：改不了 $DATA_DIR 的属主，若写库报 EACCES 请手动 chown 1000:1000" >&2
  fi

  exec su-exec node "$@"
fi

# 已经降权（或 compose 里指定了 user:）就直接跑
exec "$@"
