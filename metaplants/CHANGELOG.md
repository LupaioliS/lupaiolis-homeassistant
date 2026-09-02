# Changelog

## 1.12.0

A **history page** (📋 next to "Add plant") lists every logged action in a table you can edit: date and time, amount, provenance, notes — plus delete, plus adding a row after the fact. Inside the add-on container the JSON files aren't reachable, so until now a watering logged at the wrong time was permanent.

- It isn't only convenience. The scale the add-on learns is anchored to the rise in the soil curve *within a window around the logged timestamp* (see 1.11.1), so a watering logged a day late doesn't teach a wrong dry point — it teaches nothing, or worse, it teaches from the wrong cycle. Correcting the timestamp is the difference between a calibration built on three cycles and one built on two
- Deleting a row is the answer to "this watering shouldn't count": a top-up before a trip, a pot moved under a tap. It's the missing counterpart to `rain`, which already contributes only the wet point
- Adding a row backdated is the answer to the opposite case — you watered and never told the add-on
- `lastWatered` & co. are a denormalised copy of the most recent action, so they are recomputed from the history after every edit; only the type touched by the change is recomputed, since repotting and pruning dates can also be set by hand on the plant form
- Every edit republishes MQTT and re-runs the estimate immediately, exactly as pressing the button does

## 1.11.4

The seasonal schedule suggestion ("water every N days") now comes from the **soil curve** instead of the average gap between your waterings, and rain no longer teaches the plant that wet soil means it's thirsty.

- The suggested interval is `(wet point − dry point) / dry-down rate`: how long the soil takes to go from full to the level you water at, at the speed it is drying right now. The old average measured *you* — it counted the week you were away, the days you forgot, and the rain. Measured on the same plant with the same soil: watering every 5 days regularly, both methods agree (5 vs 5.3); with one 12-day gap from a holiday the average jumps to 7 while the curve stays at 5.3. It needs a soil sensor and a calibration learned from real waterings; without those the historical average is still used, and the button says which one you're looking at
- **Rain no longer contributes the 0% point.** It still contributes the 100% one — a storm genuinely fills the pot — but "this is the level at which the plant should get water" is a decision, not weather. Logging rain on soil that was still damp taught exactly the opposite, and since 1.10.3 that point is what raises the alert: two such rains in the last three cycles moved the learned dry point from 40% to 52%, i.e. the plant would start asking for water while wet. This corrects the claim made when sources were introduced in 1.11.3 that all three were interchangeable for calibration; they are not
- The historical fallback now skips any gap that starts or ends with rain, rather than dropping rain events from the series — removing them would merge two short gaps into one long one and make the suggestion wrong in the other direction
- `full_cycle_days` is published in the MQTT prediction attributes

Plants whose calibration was already pulled by logged rain recover on their next two decided waterings.

## 1.11.3

Watering now records **who gave the water**: by hand 💧, rain 🌧️, or an irrigation system 🚿. The picker sits at the top of the water dialog, and — where it matters most — in the "did you water it?" prompt, which until now could only be answered "yes, I did" or dismissed. A pot on a balcony that got soaked by a storm has an answer now.

- The choice is **provenance, not behaviour**: all three recalibrate the scale exactly the same way. The sensor measures the water that reached the pot, not who poured it, and rain that a sheltered balcony never let through simply produces no rise — the curve already handles that case, so there's nothing to special-case
- Rain records **no amount**: there's no telling how many ml of a shower actually landed in the pot, and a made-up number would feed the seasonal amount suggestions. The slider is replaced by a note when rain is selected
- The chart marks each logged watering with its own symbol, so a cycle that looks odd explains itself at a glance ("ah, that one was rain"). The same symbols appear in the calibration cycle list
- The MQTT water button accepts a provenance as its payload: publish `irrigation` to `metaplants/<slug>/water/set` and the watering is recorded as automatic. Groundwork for driving a valve from Home Assistant and having MetaPlants record it correctly
- Existing actions are untouched and read as "by hand"; the field is optional, so nothing needs migrating. A source that isn't one of the three is dropped rather than stored, and a source on a non-watering action is ignored

## 1.11.2

The soil pill details now tell you, **before** you press anything, what logging a watering right now would teach the scale: *"Log water now and I learn: dry = 38.7%"* — or that it would teach nothing at all, when there aren't yet 30 minutes of readings before the rise. 1.11.1 made the add-on refuse bad dry points; this makes that refusal visible in advance instead of leaving you to wonder afterwards.

- The preview runs through the *same* function that observes real waterings, with "now" in place of the action timestamp, so it cannot drift from what actually gets recorded — it is literally the same calculation, not a reimplementation of it
- It lives on the readings rather than inside the estimate, because the estimate doesn't exist until a plant has enough history — which is exactly when knowing whether a watering will teach anything matters most. A plant whose sensor was configured eight minutes ago now says so, instead of showing nothing
- Also published on MQTT as `soil_next_dry_point` in the plant attributes

## 1.11.1

Fix the 0% point of the learned scale being taken from a reading that was already wet. Water a plant at 38.7%, watch the sensor shoot up to 53%, press "water" — and the scale would record 53% as "this is where the plant gets watered", which is the one number it must never get wrong now that it raises the alert.

Two independent causes, both fixed:

- **History buckets kept the maximum of each 15 minutes but not the minimum.** `peak` was added in 1.10.1 so the brief post-watering spike would survive its bucket; the mirror case was never covered, so the last dry reading before watering — which lands in the same quarter of an hour as the rise that follows it — was simply overwritten. Samples now carry `trough` alongside `peak`, and the dry point reads from it. The stored format grows a fourth optional field; existing `history.json` files load unchanged, and older versions of the add-on can still read files written by this one
- **The dry point was searched relative to when you pressed the button, not to when the water arrived.** It's now anchored to the rise in the curve itself: within the window around the logged watering, the add-on finds where the soil jumped and takes the low from strictly before that point, the peak from there onwards. Pressing "water" ten minutes or ten hours after the fact no longer changes what gets learned

Added with them, a refusal rule: if there isn't at least half an hour of readings *before* the rise, that watering no longer contributes a dry point at all, instead of contributing a wrong one. A plant whose sensor was only just configured now keeps the manual threshold until it has seen a real dry-down — no calibration beats a calibration invented from the splash.

The rise detection is now one shared implementation (`src/shared/soil.ts`) used by the estimate, the chart's `?` markers and the prompt, instead of three copies that could disagree about what counts as a watering.

Nothing is persisted from the model, so the corrected scale applies as soon as the add-on restarts — but troughs can only be recorded from now on: cycles already in `history.json` keep whatever their buckets saved. Affected plants recalibrate on their next two waterings.

## 1.11.0

1.10.3 made the calibrated percentage the thing that raises the watering alert. This one makes that percentage inspectable: the two numbers behind it were previously something you either believed or didn't, with nothing to check them against.

- **The soil curve is now on the card.** `history.json` has held two weeks of readings since 1.10.0, but only the server could see them. The 📈 button next to the soil pills draws the raw curve over 3/7/14 days with, on top of it, everything the add-on inferred from it — the learned 0% and 100% as dashed lines, 💧 at every logged watering, and a dashed `?` at every marked rise nobody ever confirmed. A sensor dropout and genuinely dry soil produce the same number but look nothing alike here: one is a spike, the other lasts hours. Gaps in the data break the line instead of being bridged across, so a sensor that went offline reads as offline. Served by the new `GET /api/plants/<id>/history`, fetched only when you open the chart, so cards cost nothing extra to load
- Tapping (or hovering) the calibrated percentage now lists **the individual waterings the scale is built from** — date, the low seen before each one, the peak seen around it. The 0% point is the *median* of those lows, so until now a single bad cycle could pull the whole scale down with no way to see it: a dropout to 9% in the hours before a watering reads exactly like soil that was genuinely at 9%. The list replaces the single "last recalibrated" line 1.10.3 added — the same information, with the cycles it came from. Also published on MQTT as `soil_calibration_cycles` in the plant attributes

Nothing changes in how the alert is decided; this release only shows you the evidence for it.

## 1.10.3

The watering alert now fires on the **calibrated** soil percentage instead of the raw one. A capacitive probe that read 28% on dry soil in spring reads 36% a month later; the threshold you typed once doesn't move with it, so the alert either stops arriving or never stops. The learned scale does move — it is re-derived from your recent waterings — so that is what decides now: 0% on it means "you are at the level you normally water at", whatever raw number corresponds to it today.

- `soil_needs_water`, the watering pill, the "needs attention" banner and the MQTT watering state all switch to the calibrated percentage hitting 0%. The manual threshold is still the bootstrap — until the first watering has been logged with the sensor watching, the scale starts from it and the alert fires exactly where it did before — but from the first logged watering onwards it no longer drives anything, and the card says so when you tap the raw reading
- The calibrated percentage is published as its own entity, `metaplants/plant/<slug>/soil_humidity_ai` (device class `humidity`). It's the one worth automating on: unlike the raw reading, it means the same thing next month. The raw value and which of the two raised the alert are in the attributes as `soil_humidity_raw` and `soil_alert_source`
- The scale now moves **only** on logged waterings — the "water" button (app, Home Assistant, or a manually added action) or a confirmed "did you water it?" prompt. This reverts the part of 1.10.2 that also let the 100% reference rise on its own whenever the open cycle read higher. That was reasonable while the calibration only affected a displayed number; it isn't now that it raises the alert, because an unconfirmed jump — or a sensor drifting upwards — would silently move the point at which your plants ask for water
- Card layout follows: the 🧠 percentage comes first with the dry-to-wet tint, the raw one sits beside it in grey. Its details now also say how many waterings the scale comes from and when it last moved

The consequence of calibrating only on confirmations: water a plant and dismiss the prompt, and the calibrated reading stays at 0% and keeps asking until a watering is logged. That's what the prompt is for, and it still fires on a 10-point rise. Nothing is persisted, so the new behavior applies as soon as the add-on restarts; plants without a logged watering yet behave exactly as they did in 1.10.2.

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
