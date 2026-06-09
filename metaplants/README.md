# MetaPlants

MetaPlants is a Home Assistant add-on designed to manage household plants: watering, fertilizing, repotting, pruning, and health issue history.


## Project Idea

MetaPlants started as a **vibe coding** experiment: a quick prototype to turn manual plant care tracking into something simple, visual, and integrated with Home Assistant.

The project proved useful in real life, so it evolved into a manually maintained project: stronger structure, local data persistence, MQTT Discovery integration, and a UI optimized for daily use.

## How It Works in Home Assistant

MetaPlants exposes each plant as an **MQTT device** in Home Assistant through MQTT Discovery.

For each plant, it automatically creates:

- 5 sensors:
  - watering
  - fertilizing
  - repotting
  - pruning
  - health
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
- JSON attributes:
  - `metaplants/plant/<slug>/attributes`
  - `metaplants/plant/<slug>/health_attributes`
- Commands from Home Assistant to MetaPlants:
  - `metaplants/<slug>/water/set`
  - `metaplants/<slug>/fertilize/set`
  - `metaplants/<slug>/repot/set`
  - `metaplants/<slug>/prune/set`

Discovery is published under a configurable prefix (default: `homeassistant`).


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