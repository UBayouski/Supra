# Deploy While You Were AFK

This demo runs as one Node process without a database or persistent server disk. Archives are saved in the operator's browser, keyed by the verified Twitch broadcaster ID. This repository is separate from Bossforge; leave Render's Root Directory empty.

## Render setup

1. Push this repository to GitHub and create a Render Blueprint from `render.yaml`, or create a Node Web Service manually with the Free plan.
2. Use build command `npm test && npm run check` and start command `node server.mjs`. The Node version is pinned in `.node-version`; `/health` is the health check.
3. Set `TWITCH_CLIENT_ID` to the separate While You Were AFK Twitch application's Client ID. No client secret, database, disk, or `SUPRA_DATA_DIR` setting is needed.
4. Render supplies `RENDER_EXTERNAL_URL`; the server uses it for its public origin and OAuth redirect. For a custom domain, set `PUBLIC_URL` to that HTTPS origin, with no path, query, or trailing slash.
5. Register that exact service origin (for example `https://your-service.onrender.com`) as an OAuth redirect in the Twitch developer console. Match the studio's connection dialog, without a trailing slash.
6. Open the hosted studio in the browser you will use for recording. Connect your broadcaster account, then verify commands, nominations, approval, optional replies, and the overlay.
7. Click **Copy OBS URL** and paste it into an OBS Browser Source. It displays only approved recap content and does not grant studio access.

Render's free service can sleep after 15 minutes without inbound traffic. After a server restart, sleep/wake cycle, or redeploy, open the studio in the browser holding the saved archive and reconnect Twitch. The studio restores its archive before starting chat; the overlay waits and reconnects using its saved URL. See [Render's free service documentation](https://render.com/docs/free).

## Browser storage and isolation

- A secure browser session isolates studio controls. Twitch token validation supplies the broadcaster ID; a client cannot choose another channel by supplying an ID.
- Real-channel archives and the read-only overlay key are saved under `supra:channel:<Twitch ID>` in `localStorage`. Tokens, OAuth responses, browser cookies, and reply permission switches are not included.
- Guest/demo workspaces remain temporary and are never copied into real channels.
- While the server is running, authenticated browsers using the same Twitch account share its active studio and one chat connection. Each open studio saves the current archive in its own browser. A stale browser backup cannot replace a channel that has already been restored on the current server.
- After a restart, reconnect from the browser that has the archive. Another browser/device does not automatically have that backup. Browser profiles, private windows, localhost, hosted domains, and different ports have separate storage. Clearing site data or closing an incognito session removes its saved archives. Use a regular browser profile for the demo.
- If browser storage is blocked, corrupt, or full, the studio reports that saving is unavailable and keeps the previous backup untouched. Use **Export your streams** to preserve the current in-memory archive. The app needs no server disk and writes no stream files.
- The copied OBS URL contains a random read-only key. The browser saves it with the archive and restores it on verified login. OBS can show a waiting card before the studio reconnects; it cannot edit, approve, or export anything. Keep the studio open during capture so incoming moments are saved in the browser.
- For local migration only, first restore uses the matching old `.data/channels/<Twitch ID>/state.json`, or matching real sessions in `.data/state.json`, if this browser has no backup. Legacy files remain untouched. Hosted deployments do not read these files, and local archives do not automatically transfer to the hosted origin.
- Use one process/instance. Different server instances would have separate live state and overlay links. **Disconnect** signs only that browser out; its local archive remains for the next verified login.

## Hosted acceptance checks

1. Connect Twitch in a regular browser profile, add a goal, and receive a viewer nomination. Confirm the sidebar says **Saved in this browser for your channel**.
2. Open a different browser/profile without connecting: it sees none of the channel's data. A different Twitch account also sees none of it.
3. Open the copied OBS URL without the studio's cookie. Approved context appears; pending nominations remain hidden.
4. Approve the nomination. The studio and overlay update together.
5. Refresh the studio. The archive remains, with its contributor credit and timestamps.
6. Restart/redeploy the service. The overlay waits. In the original browser, connect Twitch again: the saved archive and the same OBS URL recover.
7. Verify that another browser with no backup has no archive after a fresh server restart. Reconnect the original browser first to restore it.
8. Enable replies again and verify `!catchup` in Twitch. Wait 15 seconds between requests.

No service has been provisioned by adding this configuration. Deployment and a real hosted Twitch rehearsal remain pending.
