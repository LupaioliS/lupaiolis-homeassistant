# Changelog

## 1.10.2

Soil moisture sensors drift. A sensor that peaked at 68% right after watering can peak at 48% a few weeks later for the same soak, and until now the learned scale kept the old value alive: the 100% reference was the 75th percentile of *every* watering still in the 14-day history, so a genuinely decalibrated sensor read as a half-empty plant right after being watered. This release makes the calibration describe the sensor as it is now.

- The calibration window is limited to the last 3 observed waterings instead of every watering in the 14-day history, so a drifting sensor is retracked in three cycles rather than two weeks. This applies to the 0% reference too, which matters more: it is what the estimate divides by, so a stale one pushes the countdown towards "water now" even on freshly watered soil
- The 100% reference now moves asymmetrically. It rises immediately when the current cycle reads higher — including when the watering was never confirmed through the prompt, since a reading the sensor actually reached is evidence in itself — but only drops after 2 consecutive cycles stay below the reference. A single stingy top-up must not collapse the scale, a drifting sensor should; they are told apart by whether it persists. The reference never falls below a peak actually observed in the recent cycles
- Both reference points are now searched up to 12h before the logged watering, instead of 3h. A watering logged through the "did you water it?" prompt can be confirmed hours after the fact — at the end of the day, typically — and in that case the previous window missed the real peak entirely and took the 0% point from a reading that was already wet

A sensor that has just started reading low keeps its old 100% for one more cycle, by design: the second low reading is what distinguishes drift from a shallow watering. Nothing is persisted, so the new scale applies as soon as the add-on restarts.

## 1.10.1

- The details behind the status pills (estimate, calibration reference points, seasonal due date) are now reachable on a phone: `title` tooltips only appear on mouse hover, so on touch that information was simply unreachable. Pills carrying details show a small dot and open a panel below the card when tapped; hovering with a mouse still shows the tooltip as before
- Fix the watering estimate calibrating "full soil" against a value lower than the peak actually reached. Two causes: history buckets kept only the last reading of each 15-minute window, so the post-watering spike — which often lasts a few minutes — was overwritten by the value it settled at; and the peak was only looked for *after* the logged watering time, while a watering logged through the "did you water it?" prompt is recorded once the sensor has already risen. Buckets now keep the highest value seen alongside the last one, and the peak is searched in a window spanning from before the logged action to 4h after it
- Fix the 0% point of the calibrated scale possibly being a wet reading, for the same reason: it was taken from the last reading before the logged watering, which through the prompt flow can already be post-watering. It is now the lowest reading in the hours preceding it
- The 100% point is now the 75th percentile of recent peaks rather than their median, so a generous soak counts for more than a top-up while a single freak reading still can't define the scale on its own

Peaks already lost to the previous bucketing can't be recovered; affected plants recalibrate on their next watering. Existing `history.json` files load unchanged.

## 1.10.0

### Countdown

- Fix the "in X days" countdown overstating the wait by up to a full day: remaining time was rounded up (`ceil`) on fractional days, so a plant due tomorrow morning was shown as "in 2d". It now counts calendar days ("tomorrow" when it's due the next day), matching what you'd count on a calendar. Same fix applied to the MQTT sensor states, and the day math now lives in one shared module (`src/shared/schedule.ts`) used by client, MQTT and API instead of three near-copies
- Hover (or long press) on the watering/fertilizing pill to see the exact due date

### Photos

- Photos are resized to max 1600px and recompressed in the browser before uploading: uploads from a phone are much faster and the served image is no longer the multi-megabyte original
- Uploaded images are now served with immutable long-lived cache headers, so they aren't re-downloaded on every visit
- Card photos and thumbnails load lazily and asynchronously
- All plant actions are fetched in a single request instead of one per card

### Soil humidity and watering prompt

- Sensor polling defaults to every 20s (was 60s) and all plants are read in parallel instead of sequentially. Configurable with the new `sensor_poll_seconds` option
- Watering detection no longer requires the previous reading to be below the configured threshold — that made it miss every watering done before the soil got fully dry, which is most of them. It now triggers on a marked rise (default 10 points, per-plant override available) versus the lowest reading in the last 45 minutes, threshold or not
- A 12h cooldown after a detected jump or a logged watering prevents the same watering being asked about twice
- Sensor history moved out of `plants.json` into `history.json`, sampled into time buckets and persisted every 15 minutes: polling no longer rewrites the plant file on every read (SD card wear) and the history now spans ~14 days instead of 10 samples
- Fix editing a plant wiping the server-managed sensor state (humidity baseline, pending prompt)

### Watering estimate

- New internal estimate of when each plant will need water, computed from the data already collected: a linear fit over the soil dry-down curve gives a % per day rate, and the intervals between past waterings give the plant's rhythm. No dependencies, a few hundred operations per plant
- The soil percentage is calibrated to each plant: if you always water at 30%, that 30% is shown as 0% on a learned scale, displayed next to the raw reading
- The estimate is advisory at first and only takes over the displayed watering status once it has learned enough (3+ watering cycles with a clean fit). The seasonal schedule stays as the reference, shown on hover
- The estimate is also published in the MQTT attributes (`prediction`) for automations

### Sensor selection

- Sensors are now picked from a dropdown instead of typing the entity_id: the list comes from the Home Assistant entities labelled `metaplants`. Without that label the list falls back to every compatible sensor, and manual entry is always available

## 1.9.3

- Keep a rolling history of the last 10 readings per sensor (temperature, ambient humidity, soil humidity) in `plants.json`, for future use such as trend charts

## 1.9.2

- Fix soil jump prompt reappearing on every poll after confirming: acknowledging now re-baselines the reference reading to the current (wet) value instead of leaving it at the old dry one
- Soil jump prompt is skipped (and auto-acknowledged) for plants already watered today, matching the existing "done today" lock on the water button
- Swap the force-action button icon from a refresh-like ⟳ to 🔓, since it read as "undo" rather than "override"

## 1.9.1

- Fix soil jump detection missing gradual sensor rises (e.g. 30%→35%→60%→99%): the reference reading is now only updated while the soil is at or below the threshold, so any eventual rise above threshold+20% is correctly detected regardless of how many intermediate readings occur

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
