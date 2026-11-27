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
# nginx answers /health/live by itself (see the template), so this probe says
# nothing about the server: the UI stays healthy to show the banner when the
# server is not. busybox wget ships with the alpine base. 127.0.0.1, not
# localhost: the server block listens on IPv4 only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/health/live || exit 1
