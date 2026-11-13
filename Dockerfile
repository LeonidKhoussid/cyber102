FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/bot/package.json ./apps/bot/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci

FROM dependencies AS api
COPY packages/contracts ./packages/contracts
COPY apps/api/src ./apps/api/src
RUN mkdir data && chown node:node data
USER node
CMD ["node", "apps/api/src/main.ts"]

FROM dependencies AS bot
COPY packages/contracts ./packages/contracts
COPY apps/bot/src ./apps/bot/src
USER node
CMD ["node", "apps/bot/src/main.ts"]

FROM dependencies AS web-build
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
RUN npm run build

FROM nginx:alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
