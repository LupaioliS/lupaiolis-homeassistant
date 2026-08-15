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
plant isn't technically due for water yet, dropping below the threshold marks
it as needing water right away, and the watering pill on the card switches to
a dedicated "soil sensor" message instead of the usual "in N days". The pill
itself also fades smoothly between a dry (tan) and wet (blue) tint as the
reading approaches the threshold, so you get a sense of how close it is
without staring at the raw percentage. A dry plant also surfaces in the
"needs attention" banner just like an overdue one.

Readings are polled from Home Assistant every 20 seconds by default (plus right
after you save the plant), the same mechanism used for temperature/humidity —
see [Environmental Readings](#environmental-readings) below for the polling
details and caveats.

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
  this plant's "empty", not 30% of anything meaningful. MetaPlants takes the
  0% point from the driest reading in the hours before each watering, and the
  100% point from the peak actually reached just after it, then shows the
  recalibrated value next to the raw one on the card (🧠 pill). Tap it — or
  hover it with a mouse — to see both reference points. "Full" is treated as an extreme rather than an
  average — a generous soak counts for more than a top-up — while still
  ignoring a single freak reading once there are several cycles to compare.
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

The estimate is also published on MQTT inside the plant attributes, under
`prediction` (`next_watering`, `days_left`, `confidence`, `dry_rate_per_day`,
`soil_dry_point`, `soil_wet_point`, `soil_humidity_calibrated`), so automations
can use it directly.

### What this means on MQTT

Soil moisture isn't just a UI nicety — it's exposed as its own entity so you
can build automations on it directly, separate from the time-based watering
sensor:

- A binary sensor is published per plant: `metaplants/plant/<slug>/soil_needs_water`
  (`ON` when the reading is at or below the threshold, `OFF` otherwise), with
  discovery config under `{discoveryPrefix}/binary_sensor/<device>/soil_needs_water/config`.
  It shows up in Home Assistant as a "problem" sensor, so it lights up red
  when something needs attention.
- The regular watering text sensor (`metaplants/plant/<slug>/watering`) also
  reflects the override — while the soil sensor says dry, it reports a
  soil-specific message instead of the usual day count.
- The raw soil percentage itself is **not** published to MQTT; it's a live
  Home Assistant value already, so MetaPlants just reads it rather than
  re-publishing a copy.
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
