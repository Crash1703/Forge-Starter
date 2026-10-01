# Google Play: Data safety, content rating and declarations

Answers for **Policy → App content** in the Play Console, matching what the
app does (see the privacy policy). When in doubt, Google prefers declaring
more rather than less.

## Data safety

**Does your app collect or share any of the required user data types?** Yes.

**Is all of the user data collected by your app encrypted in transit?** Yes (HTTPS everywhere).

**Do you provide a way for users to request that their data is deleted?** Yes: by email to support@mbcgaming.net (there are no accounts; on-phone data is deleted in the app or by uninstalling).

| Data type | Collected | Shared | Optional? | Purposes | Notes |
|---|---|---|---|---|---|
| Location → Precise location | Yes | Yes | Yes (the app works without location, from searched places) | App functionality | Route points go to Ride Forge's server to plan routes, look up weather, elevation and places; map images come from OpenFreeMap for the area on screen; the fallback route server (FOSSGIS) may get route points |
| Location → Approximate location | Yes | Yes | Yes | App functionality | As above |
| App info and performance → Crash logs | Yes | No | No | App functionality (fixing problems) | Automatic error reports: the error, app version, phone model |
| App info and performance → Diagnostics | Yes | No | No | App functionality | Same reports |
| Messages / Other user-generated content | Yes | No | Yes | App functionality | Feedback typed in Settings |

Not collected: name, email, contacts, photos, files, calendar, health, financial info, web history, device or other IDs, app interactions, search history (searches are sent to look places up, not kept).

**Is data processed ephemerally?** Leave "No" for location (technical logs keep request details up to 30 days).

## Content rating

Questionnaire category: **Reference, news or educational / Utility** (navigation). Answer **No** to violence, sexual content, language, controlled substances, gambling, user interaction / sharing of user content between users, and sharing of the user's location *with other users* (it's not shared with other users). Expect **Everyone / PEGI 3**.

## Target audience

**18 and over** (it's for motorcycle riders). Not designed for children.

## Ads

**No**, the app has no ads.

## Foreground service (location)

Ride Forge uses a foreground service of type **location** (FOREGROUND_SERVICE_LOCATION) for turn-by-turn navigation and ride recording with the screen off, shown by a "navigating" notification.

- **Feature:** Navigation, and recording a ride.
- **Description to paste:** "While the rider follows a route (Ride) or records a ride, Ride Forge keeps receiving GPS positions with the screen off or the phone in a pocket, to give spoken turn-by-turn directions and to record the track. A persistent notification shows while it runs, and it stops when the ride or recording ends."
- **Video:** a short screen recording (YouTube unlisted link is fine): start a route with **Ride**, lock the phone, show the notification and that directions continue, then end the ride.

## News, health, financial, government, COVID: not applicable.
