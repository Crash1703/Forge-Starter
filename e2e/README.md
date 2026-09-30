# Screen tests

The real app in a phone-sized browser (Chromium, as a Pixel 7), clicking
through the main flows, with every outside service faked (`fakes.ts`): a
plain map, a route server that rides nearly straight between the points,
and fixed answers for place search, place names, elevation and so on. So
they're quick, give the same result every time, and don't need the route
server.

```sh
npx playwright install --with-deps chromium   # once
npm run e2e
```

Each test saves screenshots in `e2e/screenshots/` (on GitHub: the
**Screen tests** run → Artifacts → screenshots), so changes to the screens
can be looked at, not just checked.

What's covered:
- `app.spec.ts`: the map's search pop-out, planning a route from searched
  places, setting home in Settings and starting from home on the map, a
  pin's Round trip, and a preview ride where a stop is added, its pin tapped,
  and the stop removed.
- `more.spec.ts`: the round-trip page and its three loops, saving a route and
  opening it from Saved, GPX export and import, recording a ride and finding
  it under Rides, fuel stations in view with prices (the cheapest marked), and
  the route server and fuel price settings.

Every test also fails if the app throws an error along the way
(`noErrors` in `helpers.ts`), so a crash can't hide behind a passing check.
Locally they run one at a time (the map is drawn without a graphics card, so
it's slow: about 10 minutes); on GitHub, in parallel in about a minute.
