# While You Were AFK

**Back in chat. Back in the story.**

While You Were AFK helps late arrivals catch up with a Twitch stream. Broadcasters and moderators save the current goal, milestones, rules, and inside jokes. Viewers nominate moments for review, and newcomers type `!catchup` to get the approved story so far.

[Open While You Were AFK](https://supra-syrd.onrender.com/)

## Features

- **A live stream timeline.** Keep important context in one place, with timestamps and contributor credit.
- **Community nominations.** Viewers suggest moments through Twitch chat; the broadcaster or a moderator decides what becomes part of the recap.
- **An approved catch-up.** The recap selects the latest approved goal, milestone, rule, and inside joke. Pending and rejected suggestions stay out.
- **Optional Twitch replies.** Send the recap back into chat when a viewer asks for `!catchup`.
- **An OBS overlay.** Display approved context through a read-only Browser Source URL, separate from studio controls.
- **Browser-saved archives.** Save real-channel streams in the browser and restore them after verified Twitch login.
- **A standalone demo.** Explore a populated stream and simulate commands without connecting Twitch.

## Run locally

Requires **Node.js 24.18.0 or newer**. No package installation, database, or runtime AI API key is required.

From the repository root:

```sh
npm start
```

Open **http://localhost:3001**. Select **Load demo stream** to explore the timeline, recap, and moderation queue.

To try the review flow, send `!moment The spoon saved the run` in the demo command box with **Moderator** unchecked. Find it in the queue, choose **Inside joke**, and select **Keep**. The timeline and recap update together. Demo commands never send Twitch messages, and demo data stays separate from real channels.

## Connect Twitch

The hosted app provides **Connect Twitch** for your broadcaster account. To configure your own local instance:

1. Register a Twitch application in the [Twitch developer console](https://dev.twitch.tv/console/apps).
2. Register the exact OAuth redirect **http://localhost:3001**, without a trailing slash.
3. Copy `.env.example` to `.env` and set your application's Client ID:

   ```dotenv
   TWITCH_CLIENT_ID=your_twitch_client_id
   PORT=3001
   ```

4. Restart the server, open **http://localhost:3001**, and select **Connect Twitch**. Authorize the broadcaster whose channel you want to use.
5. To send catch-up replies, request the optional reply permission during authorization, then enable **Reply to !catchup in Twitch** in the studio.

Reading chat requires `user:read:chat`; optional replies also require `user:write:chat`. Replies are sent as the connected broadcaster, with a channel-wide 15-second cooldown. Replies default to off and reset on reconnect, stream changes, or server restart. No client secret is used.

## Chat commands

| Command | Who can use it | Result |
| --- | --- | --- |
| `!catchup` | Anyone | Requests the approved recap; posts a Twitch reply when replies are enabled. |
| `!moment A memorable thing happened` | Anyone | Adds a nomination to the review queue. |
| `!goal Beat the summit without checkpoints` | Broadcaster or moderators | Publishes the current goal. |
| `!milestone We reached the final ridge` | Broadcaster or moderators | Publishes a milestone. |
| `!rule Every fall means a fresh run` | Broadcaster or moderators | Publishes a stream rule. |
| `!joke Trust the spoon is our lucky charm` | Broadcaster or moderators | Explains an inside joke. |
| `!approve 1234abcd joke` | Broadcaster or moderators | Approves a nomination using its eight-character ID and an optional type. |
| `!reject 1234abcd` | Broadcaster or moderators | Rejects a pending nomination. |

Approval types are `goal`, `milestone`, `rule`, and `joke`; the default is `milestone`. Broadcasters can also add and review moments directly in the studio. VIP and subscriber badges do not grant moderator privileges.

Each viewer can have up to three pending nominations. Duplicate pending suggestions from the same viewer are rejected, and unreviewed suggestions never appear in the catch-up or OBS overlay.

## Use with OBS

Connect your broadcaster account and select **Copy OBS URL**. Paste the URL into an OBS **Browser Source**; a suggested source size is **500 x 1100**, resized to suit your layout.

The URL contains a random read-only key, so OBS can display the recap without sharing the studio's login cookie. It shows approved text and elapsed times, with a transparent page background. It cannot edit streams, approve nominations, or export data.

Keep the studio open while streaming so incoming moments are saved in the browser. After a server restart, reconnect Twitch in that browser to restore the archive and the same OBS URL. The overlay waits and reconnects while the studio is unavailable.

## Storage and privacy

Real-channel archives are saved in `localStorage`, keyed by the verified Twitch broadcaster ID. Saved data includes streams, moments, nominations, and the read-only overlay key. Twitch tokens and browser login cookies are never included in that archive.

Use the same regular browser profile to recover an archive after a restart. Different browsers, profiles, domains, and ports have separate storage. Clearing site data or closing an incognito session removes its saved archives. **Export your streams** downloads an additional archive copy without tokens or the overlay key.

The server keeps live state only in memory. While it is running, browsers authenticated to the same Twitch account share the active studio; each open studio saves its own browser copy. Different Twitch accounts have separate studios, exports, chat connections, and reply settings. A stale browser backup cannot overwrite a studio already restored on the current server.

Guest workspaces are temporary. **Disconnect** signs that browser out of the channel without deleting its saved archive. Switching to an archived stream pauses live chat; use **Reconnect Twitch** to resume.

## How it works

The studio uses vanilla JavaScript and CSS, with a dependency-free Node.js server for Twitch authorization, EventSub chat, and live updates to the studio and overlay.

Catch-up is deterministic: it selects approved facts rather than generating an AI summary or transcribing the stream. Approval preserves a nomination's original timestamp and contributor credit. Recap source links jump to timeline entries; timestamps are relative to the app's stream session, not Twitch VOD timecodes.

## Limitations

- Archives are browser-local and do not automatically sync between devices or between localhost and a hosted domain.
- Keep the studio open to save incoming chat updates. If browser storage is blocked or full, use the export action to preserve the live archive.
- Reconnect Twitch after a server restart or expired authorization. Automatic OAuth token renewal and replay of missed chat messages are not implemented.
- Remote moderators use Twitch commands; moderator access to the broadcaster's web studio is not implemented.
- The server runs as one process/instance because live channels and overlay access are held in memory.

## Development

```sh
npm test
npm run check
```

Tests cover chat roles, moderation, recap provenance, browser storage, verified restoration, stale-backup protection, channel isolation, overlays, and the Twitch adapter.

## Deployment

The repository includes a free-plan Render Blueprint, runtime pin, and `/health` endpoint. Deploy it as a Node Web Service, set `TWITCH_CLIENT_ID`, and register the hosted HTTPS origin as the Twitch OAuth redirect. No database or persistent disk is required.

See [DEPLOYMENT.md](DEPLOYMENT.md) for configuration and hosting details.
