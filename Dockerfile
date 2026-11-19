FROM node:22-alpine

# tzdata 让 TZ 生效（alpine 默认没时区库，日志时间会是 UTC）
# curl 给 healthcheck 用，su-exec 用来在 entrypoint 里降权
RUN apk add --no-cache tzdata curl su-exec

WORKDIR /app

# 无第三方依赖：不需要 npm install，也就没有 node_modules 和 native 编译
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Windows 上编辑过的脚本可能带 CRLF，/bin/sh 遇到 "\r" 会直接报错，这里统一成 LF；
# 同时预建 /data 并交给 node，正常启动时就不用再动属主。
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data

ENV NODE_ENV=production \
    PORT=15551 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

VOLUME ["/data"]
EXPOSE 15551

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/state" > /dev/null || exit 1

# 这里不能写 USER node：entrypoint 需要 root 才能修正 $DATA_DIR 属主，改完自己降权。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
