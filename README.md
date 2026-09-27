# Forge Route Planner

A motorcycle-focused route planner in the spirit of Calimoto, built entirely on free OpenStreetMap services. No API keys, no account and no card.

- **Plan routes**: search for places or tap the map to add stops. Drag pins to move them, tap the route line to insert a stop, and drag the list (or use ↑/↓) to reorder.
- **Ride styles**: *Fastest* (motorways allowed), *Scenic* (no motorways) or *Twisty*, which looks for the curviest roads.
- **Motorcycle routing**: uses Valhalla's motorcycle profile, which prefers smaller roads as motorways are avoided and stays on paved roads.
- **Avoid** motorways, tolls and ferries.
- **Round trips**: pick a distance and get a loop from your start point. Press again for a different loop.
- **Route details**: distance, riding time, a curviness rating, total climb, an elevation profile (hover it to see the spot on the map) and turn-by-turn directions.
- **Save routes** in the browser, **share** them as a link, **import and export GPX** (for Garmin, TomTom, etc.) and hand off to the Google Maps app for live navigation.
- Works on phones: the map sits on top and the planner below it. Follows the system light or dark theme.

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:5173. That's it: no keys needed.

### Services used

| Job | Service | Limits |
| --- | --- | --- |
| Map | [MapLibre GL](https://maplibre.org) with [OpenFreeMap](https://openfreemap.org) tiles | None for normal use |
| Routing | [Valhalla](https://github.com/valhalla/valhalla) on the FOSSGIS public server | Fair use, about 1 request per second |
| Place search | [Photon](https://photon.komoot.io) by Komoot | Fair use |
| Elevation | [Open-Meteo](https://open-meteo.com/en/docs/elevation-api) | 10,000 calls/day, non-commercial |

The public servers are run by volunteers and non-profits. That's fine for personal use. For a public app with real traffic, run your own Valhalla and Photon (both have Docker images) or use a paid host, then point the app at them in `.env` (see `.env.example`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Typecheck and build static files into `dist/` (deploy to any static host) |
| `npm test` | Unit tests for geometry, curviness scoring, routing and search parsing, GPX, polyline and share links |

## How "Twisty" works

No router offers a "curvy roads" button, so the app searches for one:

1. It requests the route with motorways avoided, plus the router's alternatives.
2. It requests four more variants, each forced through an extra point 20% or 35% to either side of the longest leg. These show as small orange dots on the map. The requests go one at a time to respect the public server's limits.
3. It scores every candidate by **degrees of turning per km**. The line is resampled every 25 m first, so the score doesn't depend on how the router encodes the geometry. Each turn counts up to 120°, so mountain hairpins score high but a single U-turn at a roundabout does not dominate.
4. It drops candidates that take more than 1.6× as long as the quickest one, then ranks the rest from curviest down.

Rough scale: under 25°/km is *Straight*, 60–110 is *Curvy*, 180+ is *Very twisty*.

## Project layout

```
src/
  App.tsx                 app shell, key setup, planner UI and state
  components/
    MapView.tsx           MapLibre map: pins, route lines, clicks, dragging
    PlaceSearch.tsx       Photon search-as-you-type box
    ElevationChart.tsx    SVG elevation profile
    MapErrorBoundary.tsx  keeps the planner usable if the map fails
  lib/
    config.ts             service URLs (overridable in .env)
    routes.ts             Valhalla client and route planner (twisty search)
    geo.ts                distance, bearings, resampling, curviness, loop geometry
    places.ts             Photon search and reverse geocoding
    elevation.ts          elevation profile and climb totals
    gpx.ts                GPX import and export
    storage.ts            saved routes and share links
    polyline.ts           encoded-polyline decoder (precision 5 and 6)
```

## Limits to know about

- A route can have at most 25 stops. GPX imports are cut to the first 25 points.
- **Navigate** opens the Google Maps app (a plain link, no API use). Google recalculates the route itself and supports only a few waypoints. For exact turn-by-turn on your planned line, export a GPX to a navigation device or an app such as OsmAnd.
- Saved routes live in the browser's local storage. They don't sync between devices; use **Share** links or GPX for that.
- The public routing server may say it's busy at peak times. Wait a moment and try again.
