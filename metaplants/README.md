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
and see their live values on the plant card. In the plant form, paste the
sensor's `entity_id` (e.g. `sensor.living_room_temperature`) — fill in either,
both, or neither.

MetaPlants reads the states through the Supervisor proxy, so you don't need a
token or URL; the add-on just needs `homeassistant_api: true` (already set).
Values refresh every 60 seconds, plus an immediate read when you save a plant
and once when you reload the page. Unavailable sensors or wrong entity IDs are
quietly skipped.

Readings are display-only: they aren't saved to disk or pushed to MQTT, since a
stale temperature is worse than none. Only the entity ID you pick is stored
with the plant.

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
