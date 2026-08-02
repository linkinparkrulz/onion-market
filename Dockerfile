FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY client client
COPY shared shared
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server server
COPY shared shared
COPY public public
COPY peers.json .
COPY room.json .
COPY --from=build /app/public/engine.js public/engine.js
EXPOSE 3000
CMD ["node", "server/index.ts"]
