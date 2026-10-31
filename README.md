# While You Were AFK

**Back in chat. Back in the story.**

Submission materials: [demo video scenario](DEMO_VIDEO.md) and [hackathon readiness checklist](HACKATHON_CHECKLIST.md). The studio, OBS overlay, and submission use **While You Were AFK**.

A Twitch studio that keeps the story of a stream: the current goal, the latest milestone, the rules, and the joke everyone keeps repeating. Moderators publish context; viewers nominate moments; newcomers type `!catchup` to get the approved story so far.

## Run

Requires **Node.js 24.18.0 or newer**. No package installation or AI API key is required.

```powershell
cd D:\Projects\Twitch\supra
npm start
```

Open **http://localhost:3001**. Boss can keep running on port 3000. Use `localhost`, not `127.0.0.1`, because the origin must match the OAuth redirect.

Click **Load demo stream** to explore a populated timeline, catch-up card, and moderation queue. The demo is private to your browser session and stays in memory. It does not overwrite your real streams or send anything to Twitch. Connect your broadcaster account to open its studio and save real streams in this browser.

## Try the full flow locally

1. Load the demo. Read the mission and the catch-up card.
2. In the demo command box below the timeline, send `!moment The spoon saved the run` with Moderator unchecked.
3. The nomination appears in the community queue, but not in the catch-up card.
4. Choose **Inside joke**, then **Keep**. The approved moment enters the timeline and catch-up with its original timestamp and contributor credit.
5. Send `!catchup`. The request activity updates; no Twitch message is sent in the demo.
6. Click a timestamp in the catch-up card to jump to the original timeline entry.
7. Open **OBS overlay** and approve another nomination. Both views update live.
8. Start a **New stream**. Previous demo streams remain in this browser session. Reload to verify the active session; demo workspaces reset on server restart. Connected channel streams are saved in browser localStorage and restored after verified Twitch login.

## Connect real Twitch chat

1. Register a separate Twitch application for **While You Were AFK** at [Twitch's developer console](https://dev.twitch.tv/console/apps). The account needs verified email and two-factor authentication. Twitch requires each application to have its own Client ID; keep Boss by Chat's registration separate.
2. Add this exact OAuth redirect URL: **http://localhost:3001**.
3. Copy `.env.example` to `.env` and set `TWITCH_CLIENT_ID` to your app's Client ID. No client secret is used.
4. Restart the app, click **Connect Twitch**, then **Continue to Twitch**. Authorize the broadcaster account whose channel you want to use. This version supports that account's own channel.
5. Reading chat is enough for the timeline and overlay. To support replies, select the optional chat reply permission before authorizing. This requests `user:write:chat` in addition to `user:read:chat`.
6. After connecting, add a goal locally or through a moderator chat command. Connecting opens the verified broadcaster's studio and restores this browser's saved archive before chat starts. Demo content never enters the real catch-up. Another browser can share the live studio while the server is running, but needs its own browser backup after a server restart.
7. A viewer sends `!moment ...`; approve it in the studio or using a moderator command. Any viewer can then send `!catchup`.
8. To actually send the catch-up back into Twitch, explicitly enable **Reply to !catchup in Twitch**. Responses are sent as the connected broadcaster, with a channel-wide 15-second cooldown. The default is off; it resets on reconnect, stream changes, or server restart.

Tokens stay in memory and disappear on server restart. No token is stored in stream exports or localStorage. After expiry or revoked authorization, reconnect manually; automatic token renewal is not implemented. The adapter handles WebSocket reconnect requests and deduplicates chat message IDs. Twitch cannot replay events missed during an outage. Chat from other channels in a shared-chat session is excluded.

Switching an archived stream pauses live Twitch chat to protect the archive. Use **Reconnect Twitch** to resume. **Disconnect** signs this browser out of the channel and opens a blank private workspace; other signed-in browsers remain connected. To begin a fresh real stream, use **New stream**. Load the demo only while disconnected.

## Commands

| Command | Who | Result |
| --- | --- | --- |
| `!catchup` | Anyone | Updates catch-up activity; sends an approved recap into Twitch only when replies are enabled. |
| `!moment A memorable thing happened` | Anyone | Creates a pending nomination. |
| `!goal Beat the summit without checkpoints` | Broadcaster / moderators | Sets the latest goal. |
| `!milestone Attempt 12 reached the final ridge` | Broadcaster / moderators | Publishes a milestone. |
| `!joke Trust the spoon means chat believes in our lucky charm` | Broadcaster / moderators | Explains an inside joke. |
| `!rule Every fall means a fresh run` | Broadcaster / moderators | Publishes a rule. |
| `!approve 1234abcd joke` | Broadcaster / moderators | Approves a nomination using its eight-character ID. Type defaults to `milestone`. |
| `!reject 1234abcd` | Broadcaster / moderators | Dismisses a pending nomination. |

Moderation is determined from Twitch's broadcaster identity and moderator badges. VIP/subscriber badges do not grant publishing permission. The local studio is an operator interface: anyone with access to your computer can publish or approve locally.

Each viewer can have three pending nominations; duplicate pending text from the same viewer is rejected. The pending queue allows 100 items. A stream supports 1,000 approved moments, and the archive supports 100 sessions. Export before manually managing a full archive; this version has no bulk archive deletion UI.

## Catch-up and provenance

The catch-up uses the latest approved goal, milestone, rule, and inside joke. It is a deterministic recap, not an AI-generated summary or a transcript of the stream. It does not guess what happened in audio or video. Pending and rejected nominations never appear in it.

Timestamps are relative to when the local stream session was created, not a Twitch VOD timecode. Approving a nomination keeps its original time. Source links in the studio jump to those moments; OBS shows their elapsed times. Removing the latest approved entry restores the previous entry of that type in the recap.

## OBS

Connect your broadcaster account, click **Copy OBS URL**, and paste the copied URL into an OBS **Browser Source**. The URL looks like `http://localhost:3001/overlay/<random-key>` and works without the studio's browser cookie. The unkeyed `/overlay` is only a preview of the requesting browser's workspace. Suggested source size: **500 × 1100**; resize it in OBS as needed. The page background is transparent, with an opaque catch-up card. This is a persistent story card, not a timed popup.

The overlay receives only approved recap content. Pending nominations remain in the operator studio. Keep the local server running for live updates. If the connection drops, the overlay shows a reconnection notice and retains the last received recap.

## Data and local access

Real-channel archives are saved in `localStorage` under `supra:channel:<verified Twitch ID>`. The browser saves streams, moments, nominations, and the read-only OBS key after updates. The server keeps live state only in memory and writes no stream files. A newly connected channel waits for browser restoration before starting chat; stale backups cannot overwrite a studio already active on that server.

After a server restart or redeploy, open the studio in the same browser and reconnect Twitch. Your browser restores the archive and the same OBS URL; replies stay off until enabled again. Keep the studio open during capture so incoming moments are saved. Another browser/device does not automatically have that backup. Different domains, ports, profiles, and private windows have separate storage. Use a regular browser profile for the demo; clearing site data or closing an incognito session deletes its saved archives.

**Export your streams** downloads the current archive without tokens or the overlay key. Use it as an additional backup. If browser storage is blocked, corrupt, or full, the studio shows a save warning and preserves existing browser data. The current live session can still be exported.

For local migration only, a browser with no saved archive can import matching real sessions from the old `.data/channels/<Twitch ID>/state.json` or `.data/state.json` after verified login. Those files remain untouched; demo and unbound sessions are excluded. Hosted deployments do not load legacy files. Local browser data does not automatically move to the hosted origin.

Browser sessions use opaque HttpOnly, SameSite cookies (Secure on HTTPS). Different Twitch accounts have separate live studios, archives, events, exports, and reply settings. Browsers signed into the same account share its currently active studio, and each open studio saves a browser copy. Guest workspaces are temporary. Idle browser sessions expire after six hours.

The server listens on loopback by default and checks Host and Origin headers. Hosting enables network binding with a configured HTTPS origin. Use one server process; no database or persistent disk is required. See [deployment instructions](DEPLOYMENT.md) and the [free-plan Render Blueprint](render.yaml). No resources have been provisioned by this configuration.

Fonts optionally load from Google Fonts and fall back to system fonts. There are no external image assets. No runtime AI service, hosting, or paid service is required.

## Validation

```powershell
npm test
npm run check
```

Automated tests cover role enforcement, moderation, nomination limits, original timestamps, recap provenance, browser/channel isolation, browser backups, verified restoration after restart, stale-backup protection, local legacy migration, public-origin checks, read-only overlays, live event isolation, and mocked Twitch authorization/subscriptions/replies/deduplication. The user verified the original real-channel command, nomination, approval, overlay, catch-up reply, and refresh flow. Rehearse the new channel-session flow locally and on the hosted service before recording.

## Codex build record

This project was implemented with Codex in session `01a18fbd-49b8-7c81-891e-7a45a6670565`. Codex implemented the local studio, persistent event model, role checks, moderation flow, deterministic recap, OBS overlay, Twitch adapter, and automated tests. This is also the follow-up thread for Boss by Chat; the two applications have separate source folders and run on separate ports.

Twitch references: [receiving and sending messages](https://dev.twitch.tv/docs/chat/send-receive-messages/), [EventSub chat messages](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage), and [OAuth scopes](https://dev.twitch.tv/docs/authentication/scopes/).
