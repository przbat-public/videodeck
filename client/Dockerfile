# Client image: static build served by nginx with /api proxied to the server.
FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci
COPY shared ./shared
COPY client ./client
RUN cd client && npm run build

FROM nginx:alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
