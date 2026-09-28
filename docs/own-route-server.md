# Your own route server (on a computer at home)

Ride Forge plans routes with [Valhalla](https://github.com/valhalla/valhalla).
By default it asks the free public server in Germany. That server is shared
with everyone, so each request takes 1–5 seconds, and a twisty loop needs
several requests. Your own Valhalla server with just Australia's roads
answers in a fraction of a second.

The app always falls back to the public server. If your computer is off or
asleep, routes still plan, just more slowly.

## What you need

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

## 1. Start Valhalla with Australia's roads

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

## 2. Keep the map up to date (every month or two)

New roads appear in OpenStreetMap all the time. To rebuild with fresh data:

```sh
docker rm -f valhalla
rm -rf valhalla_files
```

Then run the command from step 1 again.

## 3. Reach it from your phone, over https

Pick one of these. Both are free and don't need any router settings.

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
`Working: Valhalla 3.x`.

With your own server, the app sends four detour tries at once, not two, so
Twisty routes finish sooner as well.

To go back to the public server, clear the box and tap **Use the public
server**.

## Troubleshooting

- **"No answer from that address"**
  - Check the computer is awake.
  - Check the tunnel (Tailscale or cloudflared) is running.
  - Check `curl http://localhost:8002/status` works on the computer itself.
- **"The server answered, but not as a route server"**
  - The tunnel is up, but Valhalla isn't running yet.
  - Look at `docker logs valhalla`. The first build takes a while.
- **Stop the computer sleeping.** Set its power options to never sleep, at
  least while you're out riding.
