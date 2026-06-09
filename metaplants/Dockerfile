FROM node:24-alpine AS builder

WORKDIR /usr/src/app

COPY app/package*.json ./
RUN npm install

COPY app/ .
RUN npm run build

# Production stage
FROM node:24-alpine

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./

EXPOSE 3000

ENV DATA_DIR=/data
ENV MQTT_URL=mqtt://localhost:1883
ENV MQTT_USER=
ENV MQTT_PASS=
ENV HA_DISCOVERY_PREFIX=homeassistant
ENV METAPLANTS_LANG=it

CMD [ "node", "dist/server/index.js" ]