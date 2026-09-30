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

What's covered (`app.spec.ts`): the map's search pop-out, planning a route
from searched places, setting home in Settings and starting from home on
the map, a pin's Round trip, and a preview ride where a stop is added, its
pin tapped, and the stop removed.
