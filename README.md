# Forge Route Planner

A motorcycle-focused route planner in the spirit of Calimoto, built entirely on free OpenStreetMap services. No API keys, no account and no card.

- **Plan routes**: search for places or tap the map to add stops. A pin you tap onto the map or drag lands on the nearest road (within 1 km), like Calimoto's; hold your finger on the map (or right-click) to place one exactly where you want, off-road or not, and it stays put when dragged. Pins the app places for loops and round trips move onto the road the route uses. Drag pins to move them, tap the route line to insert a stop, and drag the list (or use ↑/↓) to reorder. Tap a pin for its card: rename it (a name you give stays when you drag the pin), choose the ride style to it, see how far it is from you and from the start, and make it the destination, a round-trip start or home, move it earlier or later, or delete it.
- **Ride styles**: *Fastest* (motorways allowed), *Scenic* (no motorways) or *Twisty*, which looks for the curviest roads.
- **Motorcycle routing**: uses Valhalla's motorcycle profile, which prefers smaller roads as motorways are avoided and stays on paved roads.
- **Avoid** motorways, tolls, ferries and **dirt roads**. Dirt roads are avoided unless you turn it off: the router keeps to sealed roads, then the route is checked for any dirt left; if there is some, it's planned once more steering off those stretches, and if there's no sealed way round the summary says how much dirt is left. Turn it off to let the router take gravel where that's the natural way.
- **Round trips**: tap the orange ↻ button on the map (or **Plan a round trip** in the planner) for the round trip page: pick a length or riding time, start from where you are or from stop A, a routing profile, and a direction or a place to ride via, then **Create a round trip**. The app tries 6 loop shapes (8 on your own route server). First it puts each shape's points on proper through roads (one request for all of them): a point that lands in the sea or deep in a forest (say, from a coastal start like Caloundra) moves in towards the loop's middle until there's a road. Then it plans each shape with one quick request and tidies up the best four with one more each: a point that led the route up a dead end moves to the foot of it, and a loop well off the asked length is resized. It scores them on bends, how close they come to the asked length, and riding the same road twice (home, or up a dead end) or crossing over, then plans the best properly and offers two more: **Best balance**, **Most curvy** and **Another way** (tap one to switch). **Recalculate** tries a fresh set. A loop has just two pins; hidden shaping points between them keep its shape, and the route only has to pass within 2 km of each, so it follows real through roads instead of hunting for exact spots. You can point the loop in a compass direction (N, NE, E…) or send it through a place you name (a café, a pass). A loop planned by time is resized once, in the same direction, if it comes out more than about 30% off; close enough is left alone. The points the app places itself only snap to proper roads (not housing-estate streets or service roads), and if the route still rides up a dead end and back near one (even when the road stops short of the point), a pin is moved back to the junction at the foot of the dead end (a shaping point is just dropped) and the loop is re-planned, so generated loops don't ride up side streets and back. Or place your own pins and tick **Loop back to the start** under the stop list. On a loop the route may not turn around at any stop, so it doesn't ride up dead ends and back. It also comes home a different way: any leg that would ride back along road already used on an earlier leg is re-planned to stay off that road, except near stops and home. If there's no other road, it keeps the original. A loop shouldn't cross over itself either: if one leg crosses another (a figure of eight, or riding home across the way out), that leg is re-planned using the router's other ways between its ends, or told to stay off the road at the crossing, and the version that crosses least wins unless it's much slower. Twisty options that cross are ranked below ones that don't. If a pin can only be reached by turning around (say, at the end of a dead-end road), the route still works and the app tells you which situation you're in.
- **Ride mode**: turn-by-turn navigation along *your* route. It shows the next turn in big type with a countdown, speaks the turns (Android's voice in the app, the browser's voice on the website), and shows your speed, the speed limit where the map has one, and your arrival time. Leave the route and it finds a way back onto it ahead, starting in the direction you're riding, instead of re-planning the whole ride. In the Android app, GPS keeps running with the screen locked (you'll see a "navigating" notification) and the screen stays on while riding. Navigation also shows on the **lock screen**: waking the phone mid-ride shows the ride straight away without unlocking (as Google Maps does), until the ride ends. On the website it needs the screen on. **Preview ride** plays the route at 4× speed. **＋ Stop** adds a stop mid-ride: search for any place, or pick fuel, cafés, food, pubs, toilets or lookouts from a list of what's along the next 60 km (nearest first). Anything already found with the **On the way** buttons before the ride shows straight away, even without signal. Then **Stop on the way** (ride there, then back onto your route where it passes closest) or **Finish here** (end the ride there). **⏸** pauses the ride (a café stop): directions, voice, rerouting and recording hold until **▶ Resume**, and the screen may sleep.
- **Map-first design**: on phones the map fills the screen and the planner slides up from the bottom. A 0–10 twistiness gauge and bend count sit on the summary card, and the route line is coloured by twistiness (orange → red → purple). The route summary shows distance, time and bends, with **Customise** (edit the stops), **Recalculate** (on a generated loop), an **Avoid** menu (motorways, tolls, ferries, dirt roads), **Ride**, **Save**, and **⋯** for Share, GPX, a preview and **Discard ride**, which asks "Would you like to save your ride?" (**Save** keeps it in Saved, **Discard ride** clears it, **Back to planning** cancels) so you can start again. The **◇ layers** button switches between an automatic map (dark after sunset), day, night and a **Terrain** map with contours and hill shading.
- **Ride recording and logbook**: tap the red button on the map to record any ride. Rides in Ride mode record automatically. The **Rides** tab lists every ride with distance, riding time, average and top speed (a 5-second average, so GPS spikes don't count), bends, climb, an estimated lean angle (from speed and bend radius) and the twistiest 5 km, plus speed and elevation charts. You can export a ride as GPX, plan it again, or show all your rides as faint lines on the map. Rides are kept in the device's IndexedDB. The ride in progress is saved as a draft, so a crash or a killed app doesn't lose it.
- **Weather on the way**: the forecast for when you'll actually reach each part of the route (leaving now, in 1–3 hours or tomorrow morning), with temperature, rain chance and wind, and a warning if rain is likely somewhere along the ride.
- **Stop timeline**: the planner lists the route as a timeline: start, each leg with its ride style (tap to change it for that leg), distance and time, and a **+** to add a stop right there, then the stops and the finish. Each stop's **⋯** menu can show it on the map, make it the destination, start a round trip from it, move it or remove it. Longer lists fold into "N via points".
- **Settings** (gear next to the title): kilometres or miles, 24 h or 12 h clock, light/dark/system theme, **Set via points intelligently** (new stops go where they add the least riding), energy-saving mode (the screen may sleep while navigating), and recent searches with **Delete search history**.
- **Sights**: tap **Sights** on the map to show lookouts, waterfalls, attractions, landmarks and more in view, as photo bubbles where Wikipedia has a picture. Tap one to add it as a stop, open its Wikipedia page, or **Loop via here**: pick where to start (home, your location or your current start) and you get a loop out to the place and back a different way, just big enough to reach it (**Set a length or time…** for a longer one). **Passes** shows mountain passes (with their height) the same way. The search button beside them jumps to the planner's search box, and the layers menu can hide your rides or home on the map.
- **On the way**: buttons for **Fuel, Cafés, Food, Pubs, Toilets and Lookouts** look up that kind of place along the route (each is its own quick lookup), mark them on the map and list them by distance. With Fuel on, set your tank range and it warns about any stretch with no fuel for longer than that. **Fuel prices (Queensland, in the app):** add your free token from [fuelpricesqld.com.au](https://www.fuelpricesqld.com.au/) (sign up as a data consumer) and pick your fuel in Settings. Fuel stations then show today's price from the Queensland Government's price reporting scheme, in the list, on the map and in Ride mode's ＋ Stop, with the cheapest highlighted and how long ago it was updated. The token stays on the phone.
- **Per-section ride styles**: give each leg its own style (say, fast to the hills, twisty through them, then fast home) from the menu next to each stop. Styles are kept in share links.
- **Backup and restore**: the **Saved** tab can download all saved routes and recorded rides as one file and restore it, so you can move them between the website and the app, or to a new phone. Restoring merges; it doesn't delete anything.
- **Route details**: distance, riding time, a curviness rating, total climb, an elevation profile (hover it to see the spot on the map) and turn-by-turn directions.
- **Home**: set your home in the **Saved** tab (from stop A, where you are now, or an address search). It shows as a ⌂ on the map; the round trip page offers it as a start, and the planner's **⌂ From home** / **⌂ Ride home** button adds it in one tap. Backups include it.
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
| Routing | [Valhalla](https://github.com/valhalla/valhalla) on the FOSSGIS public server, or your own (Settings → Route server; see [docs/own-route-server.md](docs/own-route-server.md)) | Fair use, about 1 request per second |
| Place search | [Photon](https://photon.komoot.io) by Komoot | Fair use |
| Elevation and weather | [Open-Meteo](https://open-meteo.com) elevation and forecast APIs | 10,000 calls/day, non-commercial |
| Places on the way and sights | [Overpass API](https://overpass-api.de) (OpenStreetMap data), asked together with the [maps.mail.ru](https://maps.mail.ru/osm/tools/overpass/) server (first answer wins, one retry, answers kept for 30 min) | Fair use; looked up only when you ask |
| Fuel prices (Qld) | [Fuel Prices Queensland](https://www.fuelpricesqld.com.au/) API, called natively from the app | Free; needs your own data-consumer token |
| Terrain map | [OpenTopoMap](https://opentopomap.org) tiles | Light personal use; don't hammer it |
| Sight photos | [Wikidata](https://www.wikidata.org) and [Wikimedia Commons](https://commons.wikimedia.org) | Free; photos are credited on Commons |

The public servers are run by volunteers and non-profits. That's fine for personal use. For a public app with real traffic, run your own Valhalla and Photon (both have Docker images) or use a paid host, then point the app at them in `.env` (see `.env.example`). A route server on a computer at home can also be set in the app itself: [docs/own-route-server.md](docs/own-route-server.md).

Map styles are kept on the phone and refreshed in the background, and downloaded map tiles (only dated OpenFreeMap tiles, which never change) are kept too, up to about 4,000; Settings → Delete saved map data clears them.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Typecheck and build static files into `dist/` (deploy to any static host) |
| `npm test` | Unit tests for geometry, curviness scoring, routing and search parsing, GPX, polyline and share links |

## Android app (Ride Forge)

The same app, wrapped for Android with [Capacitor](https://capacitorjs.com) as **Ride Forge**.

**Install:** on your phone, open the [latest release](../../releases/latest) and download `RideForge-1.N.apk`. Open it, and if Android asks, allow your browser to install unknown apps. To update, install the newer APK over the top; your saved routes are kept.

**How it's built:** every push to `main` runs `.github/workflows/android.yml`, which tests and builds the web app, copies it into `android/` (`npx cap sync android`), builds a signed APK with Gradle, and publishes it as a release. The version is `1.<build number>`, so each APK installs as an update over the last.

**Signing:** APKs are signed with `android/app/ride-forge.keystore`, committed to the repo so every build can update the installed app (Android refuses updates signed with a different key). That's fine for sideloading. Before publishing on the Play Store, move the key into a GitHub secret and use a fresh key.

**Local build** (needs the Android SDK and JDK 21): `npm run android`, then open `android/` in Android Studio or run `./gradlew assembleRelease` there.

In the app, **Share** sends a link to the public website, and **GPX** opens Android's share sheet (Save to Files, OsmAnd, …) because apps can't download files the way a browser does.

## How "Twisty" works

No router offers a "curvy roads" button, so the app searches for one:

1. It requests the route with motorways avoided, plus the router's alternatives.
2. It requests four more variants, each forced through an extra point 20% or 35% to either side of the longest leg (further out towards **Adventure** on the Detours slider, closer in towards **Direct**). These show as small orange dots on the map. The requests go two at a time to respect the public server's limits.
3. It scores every candidate by **degrees of turning per km**. The line is resampled every 25 m first, so the score doesn't depend on how the router encodes the geometry. Each turn counts up to 120°, so mountain hairpins score high but a single U-turn at a roundabout does not dominate. Turns at junctions and street corners (a 70–110° turn within 50 m, with straight road either side) don't count, so a suburban grid can't pass for a twisty road.
4. It drops candidates that take much longer than the quickest one (1.15× at Direct, 1.6× in the middle, 2.05× at Adventure), then ranks the rest from curviest down.

Rough scale: under 25°/km is *Straight*, 60–110 is *Curvy*, 180+ is *Very twisty*.

### Bends and RideScore

The **Bends** count and the **RideScore** use the same bend analysis: each run of turning one way that adds up to 30° or more is a bend, and its radius comes from its length and angle. Bends of 30–250 m radius count fully, hairpins nearly as much, long sweepers less; junction corners not at all.

**RideScore** (0–100) says how good the route is to ride and why:

| Part | What it measures |
| --- | --- |
| Curves (40%) | Good bends per km |
| Flow (20%) | Few turns, junction corners and towns |
| Rural (15%) | The share out of towns, from the router's road density (country 0–3, suburbs 4–8, city 9+) |
| Hills (15%) | Climbing per km (40 m/km scores full marks) |
| Sealed (10%) | The share on sealed roads |

Town and surface come from one extra request to the route server per route shown; until it answers (or if it doesn't), the score is made of the parts that are known.

## Project layout

```
src/
  App.tsx                 app shell, key setup, planner UI and state
  components/
    MapView.tsx           MapLibre map: pins, route lines, clicks, dragging
    PlaceSearch.tsx       Photon search-as-you-type box
    ElevationChart.tsx    SVG elevation profile
    LineChart.tsx         SVG line chart (ride speed)
    RideView.tsx          Ride mode: turn-by-turn navigation screen
    RideAddStop.tsx       Ride mode's add-a-stop panel
    RidesPanel.tsx        ride logbook and ride details
    RoundTripScreen.tsx   the round trip page
    StopList.tsx          the stop timeline in the planner
    SettingsScreen.tsx    the settings page
    Icon.tsx              line icons
    WeatherStrip.tsx      forecast along the route
    StopsAlong.tsx        fuel and cafés along the route, fuel-gap warnings
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
    navigation.ts         route matching and spoken-turn timing
    recorder.ts           GPS track recording and ride statistics
    rideStore.ts          IndexedDB storage for rides and the ride draft
    useRecording.ts       React hook for recording rides
    device.ts             GPS, voice, keep-awake (native in the app)
    weather.ts            Open-Meteo forecast along the route
    pois.ts               Overpass fuel/café lookup and fuel gaps
    sights.ts             sights in view (Overpass) with photos (Wikidata/Commons)
    rideStops.ts          fuel, food, lookouts and toilets along the road ahead
    fuelPrices.ts         Queensland fuel prices (government API, native HTTP)
    overpass.ts           Overpass queries: two servers at once, one retry, 30-minute memory
    settings.ts           the rider's settings
```

## Limits to know about

- A route can have at most 25 stops. GPX imports are cut to the first 25 points.
- **Navigate** opens the Google Maps app (a plain link, no API use). Google recalculates the route itself and supports only a few waypoints. For exact turn-by-turn on your planned line, export a GPX to a navigation device or an app such as OsmAnd.
- Saved routes and rides live on the device (browser storage, or the app's). They don't sync between devices; use **Back up** / **Restore**, **Share** links or GPX for that.
- Weather is a forecast, up to about a week ahead. Fuel and café data comes from OpenStreetMap, so a station may be missing or closed; carry a margin.
- The public routing server may say it's busy at peak times. Wait a moment and try again.
