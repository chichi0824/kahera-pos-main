# Kahera Cloudflare Worker

This Worker serves the shared menu and securely commits administrator menu changes to `js/menu-sample.js`. The browser never receives the GitHub token or administrator password.

## 1. Install and deploy

Install Node.js, then from this folder run:

```bash
npm install --save-dev wrangler
npx wrangler login
```

Set the three secrets (do not put them in source files):

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_TOKEN
```

- `ADMIN_PASSWORD`: your single administrator password.
- `SESSION_SECRET`: a long random secret, at least 32 characters. Generate one with `openssl rand -hex 32`.
- `GITHUB_TOKEN`: a fine-grained GitHub Personal Access Token restricted to `chichi0824/kahera-pos-main`, with **Contents: Read and write** permission. No other repository permissions are needed.

Deploy:

```bash
npx wrangler deploy
```

Copy the deployed `https://...workers.dev` URL into `js/cloud.js`, replacing `https://YOUR-KAHERA-WORKER.workers.dev`. Commit and push the frontend update.

## 2. Allowed origin

`APP_ORIGINS` in `wrangler.toml` is the Pages origin `https://chichi0824.github.io`. If your Pages site uses a different custom domain, replace it with that exact origin (scheme + host, no path), then redeploy. For local testing, you may add `http://localhost:8000` as a comma-separated second origin.

## 3. GitHub Pages

The frontend repository must have GitHub Pages enabled from `main` / root. The Worker commits changes directly to `main`; Pages then publishes the new static files. A cashier refreshes after Pages finishes deploying.

## Security notes

- Keep `ADMIN_PASSWORD`, `SESSION_SECRET` and `GITHUB_TOKEN` only in Cloudflare Worker secrets.
- The admin session token is held in memory only and expires after 8 hours; refreshing the browser requires logging in again.
- The menu GET endpoint is public because cashiers need to read it. Only authenticated admin sessions can write it.
- Configure Cloudflare rate limiting for `POST /api/login` before public production use.
- This protects menu administration, not sales/order records; those remain local to each device as in the original Kahera app.
