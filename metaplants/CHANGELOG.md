# Changelog

## 1.4.0

- Link plants to Home Assistant temperature and/or humidity sensors and see their live values on the plant card; readings refresh every minute, immediately on save, and on page load (requires `homeassistant_api`, already enabled)
- Readings are display-only and kept in memory: not persisted to disk or published to MQTT

## 1.3.0

- Seasonal schedules are now the single source of truth for watering and fertilizing intervals; the old generic interval fields have been deprecated and are kept only as a backward-compatible fallback for existing data
- Status labels in the plant card now show hours instead of days when less than 24 hours remain before the next action is due
- Scheduler changed from daily-at-midnight to every hour so MQTT state stays fresh throughout the day
- The form no longer shows redundant interval inputs; everything is controlled by the seasonal schedule grid

## 1.2.1
- Added a daily scheduler that publishes updated plant data to MQTT at midnight, enabling Home Assistant automations to run without manual user interaction.

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
