# GeoTag IRL

Real-life GPS tag / manhunt on a map. Static PWA: host it free on GitHub Pages, install it from the browser, play with friends. No paid server.

## Deploy (one command)

1. Install [git](https://git-scm.com) and the [GitHub CLI](https://cli.github.com), then run `gh auth login` once.
2. In this folder run: `bash deploy.sh` (Windows: use Git Bash).
3. After about a minute the game is live at `https://<your-username>.github.io/geotag-irl/`.

Run `bash deploy.sh` again after any change. It bumps the service-worker version so phones pick up the update.

Manual route: push these files to a public repo, then Settings > Pages > Deploy from branch `main`, folder `/ (root)`.

Test locally: `npx serve .` (geolocation works on `localhost`; elsewhere it needs HTTPS, which GitHub Pages provides).

## Install on phones

- Android (Chrome): open the URL, tap Install app (or menu > Add to Home screen).
- iPhone (Safari): Share > Add to Home Screen.

## How to play

1. Host opens the app > Host a match. A 4-character room code appears.
2. Host draws a circle (tap centre, drag the radius slider) or a polygon (tap 3+ corners), sets match length, how often hunters see runners, catch range and the shrinking storm, then taps Start match once players have joined.
3. Players open the URL (or the installed app) > Join a match > enter name, room code and role.
4. Runners show their 6-digit catch code (changes every 60 s). A hunter who physically tags a runner types that code in the Catch tab. The runner becomes a hunter.
5. Hunters win when every runner is caught. Runners win if the timer ends with someone still free.

What each person sees:
- Host: every runner (green) and hunter (red), live, plus out-of-bounds flags.
- Hunters: teammates live; runners only at the ping interval you chose.
- Runners: teammates live; hunters are hidden.

## Architecture

- `index.html`, `styles.css`, `app.js`: the app. Leaflet + OpenStreetMap tiles for the map.
- PeerJS (WebRTC) links players to the host phone, which acts as the game server. The free public PeerJS cloud only does the handshake; game data flows device to device.
- `sw.js`: caches the app shell and libraries so it loads fast on weak data, plus a small tile cache.
- `manifest.json` + `icons/`: installable standalone app.

## Limits worth knowing

- The host must keep the app open and the screen on. If the host closes it, the match ends.
- Browsers pause GPS and timers when the app is in the background or the screen is locked. The Wake Lock button keeps the screen on where the browser supports it; otherwise turn off auto-lock.
- Some mobile carriers block peer-to-peer connections. If players cannot join, add a TURN server in `PEER_OPTS` at the top of `app.js`.
- Anti-cheat is best-effort: codes rotate, wrong guesses are rate-limited and the host checks hunter/runner distance, but a modified client can fake GPS.
- OpenStreetMap tiles are fine for small groups. For large public events use a tile provider with its own free tier and update the URL in `app.js` and `sw.js`.
