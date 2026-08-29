# Founder OS

Local-only web app (no backend, no accounts) — HTML5, CSS3, vanilla JS.

## One-time setup: push this repo to GitHub and connect Netlify

### 1. Create the GitHub repo
On github.com: New repository → name it → don't initialize with a
README → Create.

### 2. Push this folder to it
```
git remote add origin https://github.com/<username>/<repo-name>.git
git branch -M main
git add -A
git commit -m "Initial commit"
git push -u origin main
```

### 3. Connect Netlify to the repo
Add new site → Import an existing project → GitHub → pick the repo →
Build command: blank → Publish directory: . → Deploy.

## Shipping an update after that
```
./scripts/release.sh 1.1.0 "Describe what changed"
```

This bumps `version.json`, commits, tags, and pushes in one step —
Netlify picks up the push and redeploys automatically.

## Project structure

- `index.html` — the entire app (HTML, CSS, and JS are all inline in
  this one file; there's no separate build step).
- `assets/fonts/` — self-hosted Poppins/Inter `.woff2` files (falls
  back to the system font stack if these aren't present yet).
- `version.json` — bumped by `release.sh` on every release; reserved
  for a future in-app "update available" check once Founder OS has a
  separate app.js to hold that logic. Not wired to anything yet.
- `netlify.toml` — deploy config: no build step, plus cache headers
  (index.html/version.json always revalidate, assets cached 24h).
