# Forge Route Planner

A motorcycle-focused route planner in the spirit of Calimoto, built on Google Maps Platform.

- **Plan routes**: search for places or tap the map to add stops. Drag pins to move them, tap the route line to insert a stop, and drag the list (or use ↑/↓) to reorder.
- **Ride styles**: *Fastest* (motorways allowed), *Scenic* (no motorways) or *Twisty*, which looks for the curviest roads.
- **Motorcycle routing**: uses Google's two-wheeler mode where Google supports it, and falls back to car routing elsewhere.
- **Avoid** motorways, tolls and ferries.
- **Round trips**: pick a distance and get a loop from your start point. Press again for a different loop.
- **Route details**: distance, riding time, a curviness rating, total climb, an elevation profile (hover it to see the spot on the map) and turn-by-turn directions.
- **Save routes** in the browser, **share** them as a link, **import and export GPX** (for Garmin, TomTom, etc.) and hand off to Google Maps for live navigation.
- Works on phones: the map sits on top and the planner below it. Follows the system light or dark theme.

## Setup

1. Open the [Google Cloud console](https://console.cloud.google.com/), create a project and turn on billing. Google gives a monthly free usage allowance.
2. Enable these APIs:
   - Maps JavaScript API
   - Routes API
   - Places API (New)
   - Geocoding API
   - Elevation API
3. Create an API key under *APIs & Services → Credentials*. Restrict it to **HTTP referrers**, e.g. `http://localhost:5173/*` and your production domain. The key is visible to anyone who uses the site, so the referrer restriction is what protects it.
4. Install and run:

   ```bash
   npm install
   cp .env.example .env   # then paste your key into VITE_GOOGLE_MAPS_API_KEY
   npm run dev
   ```

   You can skip the `.env` step. The app then asks for a key on first load and stores it in that browser.

Optional: set `VITE_GOOGLE_MAPS_MAP_ID` to a Map ID from the Cloud console (*Map Management*) to use your own map style. Without it, the app uses Google's `DEMO_MAP_ID`, which is fine for development.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Typecheck and build static files into `dist/` (deploy to any static host) |
| `npm test` | Unit tests for the geometry, curviness scoring, GPX, polyline and share-link code |

## How "Twisty" works

Google has no "curvy roads" option, so the app searches for one:

1. It requests the route with motorways avoided, plus Google's alternatives.
2. It requests four more variants, each forced through an extra point 20% or 35% to either side of the longest leg. These show as small orange dots on the map.
3. It scores every candidate by **degrees of turning per km**. The line is resampled every 25 m first, so the score doesn't depend on how Google encodes the geometry. U-turns and junction hairpins are ignored.
4. It drops candidates that take more than 1.6× as long as the quickest one, then ranks the rest from curviest down.

Rough scale: under 25°/km is *Straight*, 60–110 is *Curvy*, 180+ is *Very twisty*.

## Project layout

```
src/
  App.tsx                 app shell, key setup, planner UI and state
  components/
    MapView.tsx           Google map: pins, route lines, clicks, dragging
    PlaceSearch.tsx       Places (New) autocomplete box
    ElevationChart.tsx    SVG elevation profile
    MapErrorBoundary.tsx  keeps the planner usable if the map fails
  lib/
    routes.ts             Routes API client and route planner (twisty search)
    geo.ts                distance, bearings, resampling, curviness, loop geometry
    places.ts             autocomplete, place details, reverse geocoding
    elevation.ts          elevation profile and climb totals
    gpx.ts                GPX import and export
    storage.ts            saved routes and share links
    polyline.ts           Google encoded-polyline decoder
```

## Limits to know about

- Google allows at most 25 stops between start and finish per route. GPX imports are cut to 27 points in total.
- Two-wheeler routing only exists in some countries. Elsewhere the app quietly routes as a car.
- The **Navigate** button opens Google Maps, which recalculates the route itself and supports only a few waypoints. For exact turn-by-turn on your planned line, export a GPX to a navigation device or app.
- Saved routes live in the browser's local storage. They don't sync between devices; use **Share** links or GPX for that.
