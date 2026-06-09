# Changelog

## 1.2.0

- Add seasonal banner above the plant list showing the current season
- Auto-suggest seasonal watering/fertilizing frequencies based on each plant's action history; a 💡 button next to each seasonal field lets you apply the suggestion without overwriting your values automatically

## 1.1.3

- Fix: white page under Home Assistant ingress. Assets are now referenced with relative paths and API/SSE/upload/image URLs are prefixed with the ingress base path so the app works behind `/api/hassio_ingress/<token>/`

## 1.1.2

- Fix: read Home Assistant add-on options from `/data/options.json` instead of relying on environment variables, so the configured MQTT URL/credentials are actually used
- Add detailed MQTT logging (URL, user, error code/syscall) to diagnose connection issues

## 1.1.1

- Version bump for Home Assistant update

## 1.1.0

- Previous version
