# MetaPlants

MetaPlants is a Home Assistant add-on designed to manage household plants: watering, fertilizing, repotting, pruning, and health issue history.


## Project Idea

MetaPlants started as a **vibe coding** experiment: a quick prototype to turn manual plant care tracking into something simple, visual, and integrated with Home Assistant.

The project proved useful in real life, so it evolved into a manually maintained project: stronger structure, local data persistence, MQTT Discovery integration, and a UI optimized for daily use.

## How It Works in Home Assistant

MetaPlants exposes each plant as an **MQTT device** in Home Assistant through MQTT Discovery.

For each plant, it automatically creates:

- 9 sensors:
  - watering (text status, e.g. "in 3d")
  - fertilizing (text status)
  - repotting (text status)
  - pruning (text status)
  - health
  - next watering date (timestamp, for automations)
  - next fertilizing date (timestamp, for automations)
  - last repotted date (timestamp, for automations)
  - last pruned date (timestamp, for automations)
- 4 command buttons:
  - water
  - fertilize
  - repot
  - prune

When you press a button in Home Assistant, MetaPlants receives the MQTT command, stores the action in its internal database, and immediately updates sensor states.

## MQTT: Main Topics

Base project topics:

- Add-on status:
  - `metaplants/status`
- Plant states:
  - `metaplants/plant/<slug>/watering`
  - `metaplants/plant/<slug>/fertilizing`
  - `metaplants/plant/<slug>/repotting`
  - `metaplants/plant/<slug>/pruning`
  - `metaplants/plant/<slug>/health`
  - `metaplants/plant/<slug>/watering_next` (ISO 8601 timestamp)
  - `metaplants/plant/<slug>/fertilizing_next` (ISO 8601 timestamp)
  - `metaplants/plant/<slug>/repotting_last` (ISO 8601 timestamp)
  - `metaplants/plant/<slug>/pruning_last` (ISO 8601 timestamp)
- JSON attributes:
  - `metaplants/plant/<slug>/attributes`
  - `metaplants/plant/<slug>/health_attributes`
- Commands from Home Assistant to MetaPlants:
  - `metaplants/<slug>/water/set`
  - `metaplants/<slug>/fertilize/set`
  - `metaplants/<slug>/repot/set`
  - `metaplants/<slug>/prune/set`

Discovery is published under a configurable prefix (default: `homeassistant`).

## Environmental Readings

You can link each plant to Home Assistant temperature and/or humidity sensors
and see their live values on the plant card. In the plant form, pick them from
the sensor dropdowns — see [Picking Sensors](#picking-sensors) below — fill in
either, both, or neither.

MetaPlants reads the states through the Supervisor proxy, so you don't need a
token or URL; the add-on just needs `homeassistant_api: true` (already set).
Values refresh every 20 seconds by default (`sensor_poll_seconds` option), plus
an immediate read when you save a plant and once when you reload the page.
Unavailable sensors or wrong entity IDs are quietly skipped.

## Picking Sensors

Rather than typing entity IDs by hand, the sensor fields in the plant form are
dropdowns fed by Home Assistant.

To get a short, relevant list, **add the `metaplants` label** to the entities
you use for your plants (Settings → Devices & Services → Entities → select →
Add label). MetaPlants reads that label through the `label_entities()` template
function and offers only those entities.

If no entity carries the label — or your Home Assistant predates
`label_entities()` — the list falls back to every sensor with a
`temperature`, `humidity` or `moisture` device class, and the form tells you so.
There's always a "type entity_id manually" option, which is also what you get
when running outside the add-on without HA credentials.

Readings are display-only: they aren't saved to disk or pushed to MQTT, since a
stale temperature is worse than none. Only the entity ID you pick is stored
with the plant.

## Soil Moisture Sensor

If you've got a soil moisture probe on a plant (Zigbee, Wi-Fi, whatever — as
long as it shows up as a Home Assistant sensor with a percentage state),
MetaPlants can use it to override the watering schedule instead of just
guessing from elapsed days.

In the plant form, pick the sensor in the soil humidity field, then set a
threshold percentage — the value below which the plant is considered dry.
Leave the entity blank and MetaPlants falls back to the seasonal time-based
schedule like before.

Once configured, the soil reading **wins over the calendar**: even if the
plant isn't technically due for water yet, dry soil marks it as needing water
right away, the watering pill on the card switches to a dedicated message
instead of the usual "in N days", and the plant surfaces in the "needs
attention" banner just like an overdue one.

**What counts as "dry" is the recalibrated percentage, not the raw one.**
Capacitive probes drift: the same dry soil that read 28% in spring can read
36% a month later, and a threshold you typed once ages along with it — the
alert stops arriving, or never stops. So the trigger is the plant's own scale
(see [Watering Estimate](#watering-estimate)), where **0% means "you're at the
level you normally water at"**, whatever raw number happens to correspond to
it today. That scale is re-derived from your last waterings, so it follows the
sensor as it drifts instead of aging with it.

The manual threshold is still what gets things going: until the first watering
has been logged with the sensor watching, the scale starts from it and the
alert fires exactly where it used to. From the first logged watering onwards
the learned scale takes over and the threshold stops driving the alert (the
card says so if you tap the raw reading). Both percentages stay visible on the
card — the calibrated one first, with the dry (tan) to wet (blue) tint, and the
raw one next to it in grey.

Readings are polled from Home Assistant every 20 seconds by default (plus right
after you save the plant), the same mechanism used for temperature/humidity —
see [Environmental Readings](#environmental-readings) below for the polling
details and caveats.

### The soil curve

The 📈 button next to the soil percentages opens a chart of the raw reading over
the last 3, 7 or 14 days — the same history the estimate is built from, which
until now only the server could see. Drawn on top of it:

- the learned **0%** and **100%** points as dashed lines (or the manual
  threshold, while there's no learned scale yet)
- 💧 at every **logged watering** — the moments where the scale was recalibrated
- a dashed **`?`** at every marked rise that was never confirmed: water the
  model couldn't learn from. If the calibration looks wrong, this is usually why
- brief peaks within a 15-minute bucket as small ticks above the line — that's
  where the 100% point comes from

Gaps break the line rather than being bridged across, so a sensor that dropped
offline looks offline instead of looking like a smooth reading. The history is
only fetched when you open the chart, so it costs nothing on plants you don't
open. It's served by `GET /api/plants/<id>/history?days=<n>&series=soil|temp|hum`
(temperature and ambient humidity keep ~2 days, soil ~14).

### Who gave the water

Every logged watering can say where the water came from: **by hand** 💧, **rain**
🌧️ or an **irrigation system** 🚿. The picker is at the top of the water dialog
and in the "did you water it?" prompt, which is where it earns its keep — an
outdoor pot that a storm soaked can now be answered honestly instead of being
recorded as something you did.

Rain is treated differently in one specific way: it can raise the **100%** point
of the learned scale — a storm genuinely fills the pot — but it never sets the
**0%** point. That point means "this is the level at which this plant should get
water", which is a decision you make, not something the weather decides; rain
falling on soil that was still damp would otherwise teach the plant to ask for
water while wet. Rain also records no amount, since there's no way to know how
much of a shower landed in the pot.

Manual and irrigation waterings contribute both points, and all three reset the
seasonal schedule — the plant did get water, whoever gave it.

The chart and the calibration cycle list both use those symbols, so a cycle that
looks odd tends to explain itself. Waterings logged before this existed read as
"by hand".

On MQTT, the water button accepts a provenance as its payload: publishing
`irrigation` to `metaplants/<slug>/water/set` records the watering as automatic
rather than manual — which is what an automation driving a valve should send.

### "Did you water it?" prompt

When the soil reading jumps up sharply, someone probably watered the plant
without logging it. MetaPlants notices and asks: a dialog appears (immediately
if the app is open, otherwise next time you open it) offering to log the
watering with the usual ml slider.

Detection compares the current reading against the **lowest reading of the last
45 minutes**: a rise of 10 percentage points or more (adjustable per plant in
the form) triggers the prompt. It deliberately does not require the soil to
have been below the watering threshold first — that would miss every watering
done before the plant got fully dry. After a prompt, or after any logged
watering, detection pauses for 12 hours so the same watering isn't flagged
twice while the soil is still wet.

## Watering Estimate

Alongside the seasonal schedule, MetaPlants builds a small per-plant model of
when water will actually be needed. It's plain arithmetic over data the add-on
already collects — no libraries, no training, a few hundred operations per
plant per poll.

It learns two things from the soil sensor plus your watering history:

- **The plant's own scale.** If you consistently water at 30% raw, then 30% is
  this plant's "empty", not 30% of anything meaningful. Both reference points are
  anchored to the **rise in the curve** — the moment the water actually reached
  the soil — not to the moment you pressed the button: the 0% point is the lowest
  reading before that rise, the 100% point the peak from there on. So logging the
  watering ten minutes or ten hours late doesn't change what gets learned, and if
  there isn't at least half an hour of readings before the rise, that watering
  contributes no 0% point at all rather than a wrong one. MetaPlants then shows the
  recalibrated value on the card (🧠 pill) with the raw one beside it. Tap it —
  or hover it with a mouse — to see both reference points *and the individual
  waterings they're built from*: date, the low seen before each one, the peak
  seen around it. The 0% point is the median of those lows, so that list is
  where you'd spot a cycle whose low came from a sensor dropout rather than
  from dry soil. The same panel also previews what logging a watering *right
  now* would teach ("dry = 38.7%"), or warns that it would teach nothing yet —
  so you know before pressing, not after. "Full" is treated as an extreme
  rather than an average — a generous soak counts for more than a top-up — while
  still ignoring a single freak reading once there are several cycles to compare.

  The scale only moves on **logged waterings**: the "water" button (in the app,
  from the Home Assistant button entity, or a manually added action) or a
  confirmed "did you water it?" prompt. A detected jump you dismiss, or a
  sensor wandering upwards on its own, changes nothing. That's deliberate now
  that the scale is what raises the alert — it should only be redrawn around
  moments where you know water actually went in. The flip side: water without
  ever confirming it and the calibrated reading stays at 0% and keeps asking,
  which is what the prompt is there to catch.
- **How fast it dries.** A linear fit over the readings since the last watering
  gives a dry-down rate in percentage points per day, which combined with the
  0% point yields the time left. The average interval between past waterings in
  the current season acts as a second opinion, blended in proportion to how
  clean the fit is.

The estimate starts out **advisory**: it shows up as a separate pill next to
the status while it's still learning. Once it has at least 3 watering cycles, a
clean dry-down fit and a calibration from real waterings, it's promoted to
"high confidence" and becomes the watering status shown on the card and in the
"needs attention" banner. The seasonal schedule stays as the fallback and is
always one tap (or hover) away on the pill itself.

### Where the "water every N days" suggestion comes from

The card offers a seasonal frequency when it thinks the configured one is off.
Once the estimate is mature it is measured from the curve — `(100% point − 0%
point) / dry-down rate`, i.e. how long the soil takes to dry down to the level
you water at, at the speed it is drying now — and the button says so with a 🧠.
That is a property of the plant; the previous method, the average gap between
your waterings, was a property of *you*: it counted holidays, forgotten days and
rain alike. Without a soil sensor or a learned calibration that average is still
the fallback, now ignoring any gap that starts or ends with rain.

Both are only suggestions: nothing changes until you tap the button.

The estimate is also published on MQTT inside the plant attributes, under
`prediction` (`next_watering`, `days_left`, `confidence`, `dry_rate_per_day`,
`full_cycle_days`,
`soil_dry_point`, `soil_wet_point`, `soil_humidity_calibrated`,
`soil_calibrated_from`, `soil_calibrated_at`), so automations can use it
directly.

### What this means on MQTT

Soil moisture isn't just a UI nicety — it's exposed as its own entity so you
can build automations on it directly, separate from the time-based watering
sensor:

- A binary sensor is published per plant: `metaplants/plant/<slug>/soil_needs_water`
  (`ON` when the soil is dry, `OFF` otherwise), with discovery config under
  `{discoveryPrefix}/binary_sensor/<device>/soil_needs_water/config`. It shows
  up in Home Assistant as a "problem" sensor, so it lights up red when
  something needs attention. Same rule as the card: it follows the calibrated
  percentage hitting 0%, falling back to the manual threshold only until the
  scale has been learned.
- The calibrated percentage has its own sensor,
  `metaplants/plant/<slug>/soil_humidity_ai` (device class `humidity`, `%`).
  This is the one worth building automations on: it means the same thing next
  month as it does today, which the raw reading doesn't.
- The regular watering text sensor (`metaplants/plant/<slug>/watering`) also
  reflects the override — while the soil says dry, it reports a soil-specific
  message instead of the usual day count.
- The raw soil percentage is **not** published as its own entity; it's a live
  Home Assistant value already, so MetaPlants just reads it rather than
  re-publishing a copy. It's in the plant attributes as `soil_humidity_raw`
  alongside `soil_alert_source` (`ai` / `raw` / `none`), for when you need to
  see which of the two raised the alert.
- Like the other plant sensors, MetaPlants skips republishing a topic if the
  value hasn't actually changed since the last publish, so you won't see the
  retained message churn on every hourly refresh — just real state changes.

## Seasonal Schedules & Suggestions

Watering and fertilizing intervals are set per season, since a plant in July
rarely wants the same schedule it does in January. The card uses the current
season's interval to decide when a plant is due.

If you've been logging actions, MetaPlants can suggest a frequency for each
season from that history: it measures the gaps between consecutive waterings
(or feedings), groups them by season, and averages. A 💡 button next to each
field shows the suggestion — tap to apply it, or ignore it. You need at least
two logged actions before anything shows up.

![Seasonal Schedules & Suggestions](https://github.com/LupaioliS/lupaiolis-homeassistant/blob/feature/homeassistant-sensor/metaplants/app/projectimages/suggestion.png "Seasonal Schedules & Suggestions")

## Entities for Automation

Because each plant generates entities in Home Assistant, you can use them in automations, dashboards, and notifications.

Practical example: send a notification when a plant is overdue for watering.

```yaml
alias: Plant watering alert
trigger:
  - platform: state
    entity_id: sensor.ficus_watering
    to: "Overdue"
action:
  - service: notify.mobile_app_your_phone
    data:
      title: "MetaPlants"
      message: "Your ficus needs water."
mode: single
```

The text sensors above are convenient to read but hard to trigger automations
on reliably (e.g. matching the exact string "Overdue" is locale-dependent and
breaks if the phrasing changes). For date-based logic, use the `_next`/`_last`
timestamp sensors instead — e.g. notify the day before a plant is due for
water:

```yaml
alias: Plant watering reminder
trigger:
  - platform: time
    at: "09:00:00"
condition:
  - condition: template
    value_template: >
      {{ (states('sensor.ficus_watering_next') | as_datetime | as_local).date()
         == (now() + timedelta(days=1)).date() }}
action:
  - service: notify.mobile_app_your_phone
    data:
      title: "MetaPlants"
      message: "Your ficus needs water tomorrow."
mode: single
```


## Internal Database: Structure and Stored Data

MetaPlants uses local JSON file storage (no external database):

- `/data/plants.json`
- `/data/actions.json`
- `/data/uploads/` (images)


## Installation in Home Assistant (Custom Repository)

1. Open Home Assistant.
2. Go to **Settings** -> **Add-ons**.
3. Open the **Add-on Store**.
4. Click the top-right menu (three dots) and select **Repositories**.
5. Add this URL:
   - `https://github.com/LupaioliS/lupaiolis-homeassistant`
6. Confirm and refresh the store.
7. Search for and install the **MetaPlants** add-on.
8. Configure MQTT parameters in the add-on options.
9. Start the add-on and enable:
   - Auto start (optional)
   - Watchdog (recommended)
10. Open the add-on Web UI from Home Assistant (ingress).

After startup, Home Assistant should automatically discover plant devices via MQTT Discovery.


## Changelog

For version history, see [CHANGELOG.md](./CHANGELOG.md).
