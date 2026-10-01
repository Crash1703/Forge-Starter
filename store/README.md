# Getting Ride Forge onto Google Play

Everything the listing needs is in this folder: the text (`listing.md`),
the data-safety and content answers (`data-safety.md`), the icon and
feature graphic (`graphics.py` makes them from `assets/`), and phone
screenshots (`screenshots/`, taken from the real app by
`npx playwright test -c store/playwright.config.ts`).

## In the Play Console (play.google.com/console)

1. **Create app.** Name *Ride Forge: Motorcycle Routes*, default language
   English (Australia), **App**, **Free**. Free is permanent on Google Play,
   but subscriptions inside a free app are fine: that's how Ride Forge will
   charge.
2. **App signing: use Ride Forge's own key.** When asked about app signing
   (Setup → App signing, before the first upload), choose to **use a
   different key / export and upload a key from Java keystore**. Download
   the *encryption public key* it offers (a small `.pem` file; it's public)
   and send it to Claude: the key is on the server, so the encrypted file
   for you to upload is made there with Google's PEPK tool. This keeps the
   Play app and the GitHub APK interchangeable: a tester can move between
   them without uninstalling.
3. **Store listing.** Paste from `listing.md`; upload `icon-512.png`,
   `feature-graphic.png` and the screenshots.
4. **App content.** Privacy policy URL, ads (none), app access (no login
   needed), content rating, target audience (18+), data safety, and the
   foreground-service declaration: answers in `data-safety.md`.
5. **Closed testing.** Testing → Closed testing → create a track, then a
   release: upload the newest **`RideForge-1.x.aab`** (GitHub → Actions →
   *Build Android app* → the latest run on main → Artifacts →
   `RideForge-1.x-play`). Add testers by email list or a Google Group, and
   share the opt-in link with them.
6. **The 14 days.** New personal developer accounts need **at least 12
   testers opted in for 14 days in a row** before applying for production.
   Keep them testing (and sending feedback); then apply for production
   access from the Dashboard.
