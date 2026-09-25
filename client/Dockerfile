# Client image: static build served by nginx with /api proxied to the server.
FROM node:24-slim AS build

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY client/package.json ./client/
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY chrome-extension/package.json ./chrome-extension/
COPY test-infra/package.json ./test-infra/
RUN pnpm install --frozen-lockfile
COPY shared ./shared
COPY client ./client
RUN cd client && pnpm run build

FROM nginx:alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
# A template, not a config: the entrypoint substitutes ${API_TOKEN} into the
# proxy header at container start, so the token never lands in the image.
COPY client/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
