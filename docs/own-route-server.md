# Your own route server (on a computer at home)

By default Ride Forge asks the free public [Valhalla](https://github.com/valhalla/valhalla)
server in Germany. That server is shared with everyone, so each request takes
1–5 seconds, and a twisty loop needs several requests.

A server of your own with just Australia's roads answers in a fraction of a
second. There are two kinds to choose from:

- **GraphHopper (recommended).** The app sends your ride style with each
  request, and GraphHopper chooses roads by it: curvy, rural and sealed for
  Twisty, away from towns and motorways for Scenic. So routes come out
  twistier by design, instead of the app only comparing candidates
  afterwards. It runs without Docker or admin rights. See
  [GraphHopper](#graphhopper-recommended) below.
- **Valhalla.** The same engine as the public server, just faster. See
  [Valhalla](#valhalla) below.

The app always falls back to the public server. If your computer is off or
asleep, routes still plan, just more slowly.

## GraphHopper (recommended)

You need a Linux computer (or VM) that's on when you ride, with 12 GB of
memory or more and about 15 GB of free disk. The files are in this repo
under [`server/graphhopper`](../server/graphhopper).

1. **Build it.** In a terminal:
   ```sh
   git clone https://github.com/Crash1703/Forge-Starter.git
   ~/Forge-Starter/server/graphhopper/setup.sh
   ```
   This downloads Java, GraphHopper and Australia's map into
   `~/graphhopper`, then builds the routing graph. That takes 20–40
   minutes. For new roads, the monthly map refresh below does it again by
   itself (or run this again: the server keeps answering from the old graph
   until the new one is ready). Run it again
   too after an update changes `server/graphhopper/config.yml` (its
   profiles are built into the graph), then restart the server.
2. **Keep it running**, and start it whenever the computer starts:
   ```sh
   mkdir -p ~/.config/systemd/user
   cp ~/Forge-Starter/server/graphhopper/ride-forge-graphhopper.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now ride-forge-graphhopper
   sudo loginctl enable-linger $USER   # start at boot, even before you log in
   ```
   After a minute, this should list `motorcycle` and `car`:
   ```sh
   curl -s http://localhost:8989/info | head -c 300
   ```
3. **Reach it from your phone over https.** The quickest way is a
   Cloudflare quick tunnel (no account needed), run as a service too:
   ```sh
   curl -L -o ~/graphhopper/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
   chmod +x ~/graphhopper/cloudflared
   cp ~/Forge-Starter/server/graphhopper/ride-forge-tunnel.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now ride-forge-tunnel
   journalctl --user -u ride-forge-tunnel | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
   ```
   The last command prints the address. It changes whenever the tunnel
   restarts (say, after a reboot), and a quick tunnel can also die on its
   own after a network drop (the service keeps running, but the address
   stops working and the app quietly uses the public server instead): run
   that last line again and update it in the app.

   **For an address that never changes**, with a domain on Cloudflare, use a
   named tunnel. The same service runs it once `~/graphhopper/tunnel.yml`
   exists:
   ```sh
   ~/graphhopper/cloudflared tunnel login          # approve in the browser, pick the domain
   ~/graphhopper/cloudflared tunnel create ride-forge
   ~/graphhopper/cloudflared tunnel route dns ride-forge routes.example.com
   cat > ~/graphhopper/tunnel.yml <<YML
   tunnel: <the id "create" printed>
   credentials-file: $HOME/.cloudflared/<that id>.json
   ingress:
     - hostname: routes.example.com
       service: http://localhost:8989
     - service: http_status:404
   YML
   systemctl --user restart ride-forge-tunnel
   ```
   The address is then `https://routes.example.com`, through restarts and
   reboots. (Tailscale Funnel works too, as in
   [step 3 below](#3-reach-it-from-your-phone-over-https), with port **8989**.)
4. **In the app**, open **Settings → Route server**, paste the https
   address and tap **Check and use**. It should say
   `Working: GraphHopper 11.0, map from …`.

The server only listens on the computer itself (`localhost`); the tunnel is
what lets your phone in.

**Fuel prices through the same address (optional).** With a data-consumer
token from [fuelpricesqld.com.au](https://www.fuelpricesqld.com.au/), the
server can hand Queensland fuel prices to the app, so riders don't need a
token of their own:
```sh
mkdir -p ~/.config/ride-forge && (umask 077; echo YOUR-TOKEN > ~/.config/ride-forge/fuel-token)
cp ~/Forge-Starter/server/fuel/ride-forge-fuel.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-fuel
```
Then send `/fuel/` to it in `~/graphhopper/tunnel.yml`, above the route
server's rule, and restart the tunnel:
```yaml
  - hostname: routes.example.com
    path: ^/fuel/
    service: http://localhost:8995
```
It only passes on the three requests the app makes, and keeps each answer
for a while (prices for 5 minutes).

**Feedback and error reports.** The app sends Settings → Send feedback,
and errors it hits, to `/feedback/report` on the route server's address.
`server/feedback/feedback.mjs` keeps them in `~/ride-forge-feedback/`
(one JSON line each, no IP addresses; at most 10 messages and 30 errors an
hour per sender), and sends a phone notification for each message when
`NTFY_TOPIC` is set.
```sh
cp ~/Forge-Starter/server/feedback/ride-forge-feedback.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-feedback
~/Forge-Starter/server/feedback/show.sh        # the latest 20
```
Send `/feedback/` to it in `~/graphhopper/tunnel.yml`, as for `/fuel/`
(port 8996).

**Weather.** The app's forecasts come from MET Norway through the server
(`server/weather/weather.mjs`, port 8997, behind `/weather/`): it names the
app and a contact in each request, as MET Norway asks, keeps each answer
until it expires, and answers in the shape Open-Meteo uses. MET Norway is
free for commercial use with credit (CC BY 4.0), but gives no chance of rain
for Australia, so the app shows the expected rain in mm instead.
```sh
cp ~/Forge-Starter/server/weather/ride-forge-weather.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-weather
```

**Elevation.** Climb figures and elevation charts come from the Copernicus
90 m terrain model on the server (free for any use, including commercial).
Download Australia's tiles once (about 3 GB), then run the service
(`server/elevation/elevation.mjs`, port 8998, behind `/elevation`):
```sh
node ~/Forge-Starter/server/elevation/fetch-dem.mjs     # into ~/dem; can be re-run to resume
cp ~/Forge-Starter/server/elevation/ride-forge-elevation.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-elevation
```

**Places.** Fuel, cafés, food, pubs, toilets, lookouts, sights and passes
come from the server's own copy of the map: `server/places/build-places.sh`
cuts them from the Australia map (needs `sudo apt install osmium-tool`;
about 4 minutes), and `server/places/places.mjs` (port 8999, behind
`/places/`) answers the app's Overpass queries from memory. The monthly map
refresh rebuilds them.
```sh
~/Forge-Starter/server/places/build-places.sh
cp ~/Forge-Starter/server/places/ride-forge-places.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-places
```

**Place search.** Searches and pin names come from the server's own Photon
(the search engine the app always used) with Australia's places, from the
weekly export at download1.graphhopper.com. `server/photon/refresh.sh`
downloads it (about 530 MB) and builds the index (needs `zstd`); `start.sh`
serves it on port 2322, behind `/api` and `/reverse`. The monthly map
refresh runs refresh.sh too.
```sh
mkdir -p ~/photon && curl -fsSL -o ~/photon/photon-1.3.0.jar https://github.com/komoot/photon/releases/download/1.3.0/photon-1.3.0.jar
cp ~/Forge-Starter/server/photon/ride-forge-photon.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable ride-forge-photon
~/Forge-Starter/server/photon/refresh.sh     # builds the data and starts it
```

**Health check (recommended).** Every 5 minutes, `server/health/check.sh`
asks the route server for a real route, the fuel service for its fuel list,
and the public address for the server's info. Whatever is stuck gets
restarted: the route server (unless it started under 5 minutes ago and is
still loading the map), the fuel service (only if it doesn't answer at all;
the government's service being down is just noted), and the tunnel (when
the server works but the public address doesn't).
```sh
cp ~/Forge-Starter/server/health/ride-forge-health.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-health.timer
journalctl --user -u ride-forge-health        # what it found and did
```
**Monthly map refresh (recommended).** `server/graphhopper/refresh-map.sh`
downloads the latest Australia map and builds a new graph beside the old
one while the server keeps answering, then switches over (routes are down
for the minute the server takes to load it). If the new graph doesn't plan
a real route within 5 minutes, it switches back to the old one. The build
needs about 9 GB of memory and is the first thing Linux stops if memory
runs short; then it's built again with the server stopped (routes down for
about 20 minutes). The health check leaves the server alone meanwhile.
```sh
cp ~/Forge-Starter/server/graphhopper/ride-forge-map-refresh.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-map-refresh.timer
journalctl --user -u ride-forge-map-refresh     # what it did
```
It runs on the 1st of each month at 2 am Queensland time, an hour before
the nightly stress test (see `stress/README.md`), which then checks the
new map.

For a phone notification when something stays down (two checks in a row)
and when it's back, install the free [ntfy](https://ntfy.sh) app, subscribe
to a hard-to-guess topic name, and put it in
`~/.config/ride-forge/health.env` as `NTFY_TOPIC=that-name`.

## Valhalla

### What you need

- **A computer that's on when you ride.** Windows, Mac or Linux all work,
  and so does a spare PC or mini PC. It needs:
  - 8 GB of memory, or more.
  - About 15 GB of free disk space.
- **Docker.** On Windows or Mac, install
  [Docker Desktop](https://www.docker.com/products/docker-desktop/). On Linux,
  install Docker Engine.
- **A way for your phone to reach it from anywhere, over https.** Step 3
  covers this. A plain `http://192.168.x.x` address won't work, because the
  app only talks to https addresses.

### 1. Start Valhalla with Australia's roads

In a terminal, in a folder where you want the map data kept:

```sh
docker run -d --name valhalla --restart unless-stopped \
  -p 8002:8002 \
  -v "$PWD/valhalla_files:/custom_files" \
  -e tile_urls=https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf \
  -e serve_tiles=True -e build_admins=True -e build_time_zones=True -e build_elevation=False \
  ghcr.io/nilsnolde/docker-valhalla/valhalla:latest
```

The first start downloads Australia's map (about 1 GB) and builds the
routing data. That takes roughly half an hour to two hours, depending on the
computer. To watch progress:

```sh
docker logs -f valhalla
```

Once it's ready, this should print a version number:

```sh
curl http://localhost:8002/status
```

`--restart unless-stopped` starts Valhalla again whenever the computer
restarts.

### 2. Keep the map up to date (every month or two)

New roads appear in OpenStreetMap all the time. To rebuild with fresh data:

```sh
docker rm -f valhalla
rm -rf valhalla_files
```

Then run the command from step 1 again.

## 3. Reach it from your phone over https

Pick one of these. Both are free and don't need any router settings. The
commands use Valhalla's port, 8002; for GraphHopper use **8989**.

### Option A: Tailscale Funnel (a fixed address; recommended)

1. Install [Tailscale](https://tailscale.com/download) on the home computer
   and sign in.
2. In the Tailscale admin console, turn on **HTTPS certificates** and
   **Funnel**. Tailscale shows how, the first time you run the command below.
3. Run this on the home computer:
   ```sh
   tailscale funnel --bg 8002
   ```
   It prints an address like `https://my-pc.tail1234.ts.net`, and that
   address stays the same.

### Option B: Cloudflare quick tunnel (nothing to sign up for)

1. Install
   [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Run this on the home computer:
   ```sh
   cloudflared tunnel --url http://localhost:8002
   ```
   It prints an address like `https://random-words.trycloudflare.com`.

The quick-tunnel address changes every time cloudflared restarts, so you'd
need to update it in the app each time. If you own a domain on Cloudflare,
a named tunnel gives you a fixed address.

## 4. Point the app at it

In the app, open **Settings → Route server** and paste the https address.
Then tap **Check and use**. It should say
`Working: GraphHopper 11.0, map from …` or `Working: Valhalla 3.x`.

With your own server, the app sends four detour tries at once, not two, so
Twisty routes finish sooner as well.

To go back to the public server, clear the box and tap **Use the public
server**.

## Troubleshooting

- **"No answer from that address"**
  - Check the computer is awake.
  - Check the tunnel (Tailscale or cloudflared) is running.
  - On the computer itself, check `curl http://localhost:8989/info`
    (GraphHopper) or `curl http://localhost:8002/status` (Valhalla) works.
- **"The server answered, but not as a route server"**
  - The tunnel is up, but the server isn't running yet.
  - GraphHopper: `journalctl --user -u ride-forge-graphhopper`. Valhalla:
    `docker logs valhalla`. The first build takes a while.
- **Stop the computer sleeping.** Set its power options to never sleep, at
  least while you're out riding.
