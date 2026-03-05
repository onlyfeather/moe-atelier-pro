FROM node:20-alpine AS build

WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5173

COPY --from=build /app ./
RUN apk add --no-cache sqlite-libs
RUN mkdir -p saved-images server-data
EXPOSE 5173

CMD ["node", "server.mjs", "--prod"]
