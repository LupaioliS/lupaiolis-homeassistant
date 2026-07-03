# Changelog

## 1.9.0

- When the soil humidity sensor jumps significantly above the configured threshold (e.g. after rain or someone else watering), the server detects the change during its polling cycle and flags the plant as having a pending prompt
- On app load (or SSE reconnect), a sequential dialog appears for each affected plant asking whether it was watered, with the usual ml slider to log the amount
- Confirming logs the water action; skipping or cancelling dismisses the dialog without recording anything
- The pending flag is stored server-side in `plants.json` so it survives browser cache clears, device switches, and server restarts — no reliance on localStorage

## 1.8.1

- Fix the "overdue by X days/hours" label still counting from the last action instead of from when the item actually became overdue

## 1.8.0

- Add an optional soil moisture sensor per plant: set its entity_id and a dry threshold, and a reading at or below that threshold overrides the time-based schedule and marks the plant as needing water right away
- Publish a dedicated `soil_needs_water` binary sensor per plant over MQTT (problem device class) so automations can react to soil dryness independently of the watering schedule
- Skip republishing an MQTT topic when its value hasn't changed, to cut down on retained-message churn on every refresh
- Republish MQTT state immediately after sensor readings update, instead of waiting for the next hourly cycle
- Resync the frontend after an SSE reconnect and add a keepalive heartbeat, so the UI doesn't drift out of sync after the connection drops and comes back
- Fix the "overdue by X hours" label showing the full elapsed time instead of a small number
- Add a watering/fertilizing animation: a few drops fall and fill the watering pill and button, and fertilizing pours a little bag with crumbs that sprout into a couple of small plants

## 1.7.0

- Added a "needs attention" banner above the plant list showing pills with icons for each plant that's overdue on watering/fertilizing or has an active health issue
- Clicking a pill in the banner filters the plant list down to that plant
- Added a search box to filter plants by name, nickname, species, or active health problem, and a sort dropdown (by name, species, or needs attention)
- Added a clear (×) button on the search box to reset the filter and show all plants again

## 1.6.0

- Add an optional nickname field so plants can have a cute pet name in addition to their regular name, shown next to the name on the plant card

## 1.5.0

- Watering, fertilizing and repotting now open a dialog asking how much before logging the action: a droplet-shaped slider for water (ml), a fertilizer-bag-shaped slider (g), and a pot-size slider (cm) that visibly grows as you drag it
- Each dialog defaults to the last amount used for that plant instead of a generic value
- Repotting now stores the new pot size on the plant

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
