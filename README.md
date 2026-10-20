# Gary Is Hungry

A one-button chase game in a single HTML file. Flip gravity, keep running, and don't let Gary eat you. He gets faster the further you go.

- Daily course that is the same for everyone, with a leaderboard
- Challenge links and leaderboard ghosts you can race
- Online parties: share a 5-letter code, hang out in one lobby, flip at each other and race live
- Party mode for 2 to 4 players on one screen

Play it at https://anonymoesje.github.io/gary-is-hungry/

## How it fits together

`index.html` is the source. Run `node build.js` to rebuild `docs/index.html` (served by GitHub Pages) and `worker/src/sim.js` (the game's physics, copied for the leaderboard).

The leaderboard and online parties run on one Cloudflare Worker in `worker/`.

- Scores live in D1. Runs are deterministic, so the Worker replays every submitted ghost and only stores it when the replay reaches the claimed distance. Copied ghosts are refused.
- Each party is a Durable Object (`worker/src/room.js`) that relays players' state over a WebSocket. It only accepts the game's own page, holds at most 8 players, caps message size and rate, drops any field it doesn't know, and forgets everything once the party is empty.
- Score submits and party connections are counted exactly per visitor (`worker/src/limiter.js`), with Cloudflare's built-in limiter as a second layer.

To work on the Worker locally, put `ALLOW_LOCAL=1` in `worker/.dev.vars`, then:

```
npx wrangler@4 d1 execute gary-board --local --file=schema.sql
npx wrangler@4 dev --port 8787
```

Deploy with `npx wrangler@4 deploy` from `worker/`.
