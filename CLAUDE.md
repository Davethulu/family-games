# Family Arcade

Dave's family game site. Kids play these, mostly on phones and tablets.

- Repo: https://github.com/Davethulu/family-games (branch `main`)
- Live site (GitHub Pages, redeploys on every push): https://davethulu.github.io/family-games/
- Also embedded on Dave's Squarespace site via an iframe of the live URL, so pushing is all it takes to update it there too.

## Layout
- `index.html` — the menu. Games open in a full-screen iframe; the URL hash (`#game-id`) picks the game.
- `games/<id>/index.html` — one folder per game. `<id>` must match the entry in the `GAMES` list in `index.html`.

## Building a new game
1. Make `games/<id>/index.html`. Keep it self-contained: inline CSS/JS, no build step. If it needs a library, put the file in the game's folder (like `games/math-hopper-3d/three.min.js`) rather than loading from a CDN.
2. Add an entry to `GAMES` in `index.html` (id, title, emoji, color gradient, one-line description, tag).
3. Add a row to the games table in `README.md`.
4. It must work on touch screens, not just keyboard. When reading touch positions, copy `clientX`/`clientY` out of the Touch object at touchstart (an earlier bug read `.x`/`.y` and broke all touch input).
5. Wrap `localStorage` in try/catch and prefix keys with the game id, since all games share one origin.
6. Test locally with the `family-games` preview server (`.claude/launch.json` in the parent folder), both from the menu and with simulated touch input.
7. Commit and push to `main` — Dave has asked for games to go live this way.
