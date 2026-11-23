# Kahera shared menu setup

This release keeps the existing POS interface and moves only the official menu and store settings to a GitHub-backed API. Orders, cart, shift history and theme remain local to each browser, as they did in the original app.

## What happens when the admin changes the menu

1. The administrator signs in using the single password configured as a Cloudflare Worker secret.
2. Add, edit, delete, price and availability changes are sent to the Worker.
3. The Worker validates the menu, reads the current `js/menu-sample.js`, and commits the updated file to the `main` branch.
4. GitHub Pages publishes the commit.
5. Cashier devices refresh Kahera and load the shared menu from the Worker.

## Setup sequence

1. Deploy the frontend repository to GitHub Pages from `main` / root if it is not already enabled. The expected site origin is `https://chichi0824.github.io`.
2. Follow `cloudflare-worker/README.md` to create and deploy the Cloudflare Worker. Create a fine-grained GitHub token restricted to `chichi0824/kahera-pos-main` with **Contents: Read and write** only. Store it as the Worker secret `GITHUB_TOKEN`. Also set `ADMIN_PASSWORD` and `SESSION_SECRET` as Worker secrets.
3. After deployment, copy the Worker URL (for example `https://kahera-menu-api.<your-subdomain>.workers.dev`) into `API_URL` in `js/cloud.js`, replacing the placeholder.
4. Commit and push the frontend files to `main`.
5. Open the Pages URL, confirm the shared menu loads, then use **Admin login** to test the password and a harmless menu edit.

## Important behavior

- Cashiers can read the menu without signing in. The Menu tab is hidden from them.
- Only a valid administrator session can write menu changes. The session token stays in memory and expires after 8 hours; a browser refresh requires signing in again.
- A successful save commits the actual `js/menu-sample.js` file in GitHub. GitHub Pages may take a short time to publish; cashiers should refresh after deployment completes.
- The service worker now uses network-first behavior for current app files, with cache fallback when offline.
- A browser's old locally saved menu/settings are ignored and removed on startup so they cannot override the central menu. Existing orders, cart, shift data and theme remain local.
- The sample order seed is filtered against the current menu so deleting starter items will not break a new device's first launch.

## Before using with real sales

Test on a non-production copy first. Configure Cloudflare rate limiting for `POST /api/login`. Keep the GitHub token and admin password only in Cloudflare Worker secrets. Never paste either secret into `js/cloud.js`, GitHub source files, or a public chat.
