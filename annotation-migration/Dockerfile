FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# 仅先拷依赖清单，利用构建缓存
COPY package.json ./
RUN npm install --omit=dev

# 拷贝应用代码
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 数据目录（挂载卷后数据持久化到宿主机）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
