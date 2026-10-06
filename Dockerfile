FROM node:22-alpine

WORKDIR /app

# 拷贝项目文件
COPY package.json ./
COPY api/ ./api/
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "server.js"]
