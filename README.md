# Tesla MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for the Tesla Fleet API. Control your Tesla and get vehicle data (location, wake up, list cars) from any MCP-capable AI assistant or agent.

## Features

- **list_cars** — List your vehicles and get IDs for use with other tools
- **get_vehicle_location** — Current GPS location and Google Maps link (parking monitor style)
- **wake_up** — Wake a vehicle from sleep
- **refresh_vehicles** / **debug_vehicles** — Refresh list and debug info
- **HTTP/SSE mode** — Host as a web service; each user brings their own Tesla Developer credentials (no server-side secrets required)
- **Receive and respond to texts (optional)** — With Twilio configured, receive inbound SMS via webhook and use **get_recent_texts** / **send_text** so the agent can read and reply to messages

## Security

- **We never see or store your Tesla password.** Sign-in is via Tesla’s OAuth in your browser.
- **HTTP mode:** Credentials and tokens are stored in memory per session only; not written to disk.
- **No sensitive data in logs** — We do not log tokens, full session IDs, or API response bodies.
- **Before you commit:** Run `./check-secrets.sh` to catch accidental hardcoded secrets.

See **[SECURITY.md](SECURITY.md)** for details and how to report issues.

---

## Quick Start (Hosted — recommended)

Use the server without running anything locally. Each user connects with their own Tesla account.

### 1. Add the server in your MCP client

- **Server URL:** `https://tesla-mcp.onrender.com/sse`  
  (Or use your own deployed URL; see [Deploy](#deploy) below.)

### 2. First time: connect your Tesla

1. Use a tool (e.g. **get_setup_url**) — the agent will return a link.
2. Open the link and enter your **Tesla Developer** Client ID and Client Secret.
3. Log in with your Tesla account when redirected.
4. On the **success page**, copy the **connection URL** (e.g. `https://.../sse?token=...`). **Use that URL as your MCP server URL** in your client so reconnects keep you logged in. Keep it private.
5. If you don’t add that URL, your client may get a new session on each reconnect and ask you to set up again.

**Getting Tesla Developer credentials:** Create an app at [developer.tesla.com](https://developer.tesla.com). Set the redirect URI to `https://YOUR_SERVER_URL/auth/callback` (e.g. `https://tesla-mcp.onrender.com/auth/callback`).

**Render:** Set **Instance count to 1** (Dashboard → your service → Settings) so all requests hit the same server and your session isn’t lost.

---

## Quick Start (Local)

### Option A: HTTP server (multi-user, browser auth)

```bash
git clone https://github.com/Sara3/Tesla-MCP.git
cd Tesla-MCP
npm install
npm run build
npm run start:http
```

- Open `http://localhost:3000` and follow the setup link to add your Tesla Developer credentials and sign in.
- In your MCP client, use Server URL: `http://localhost:3000/sse` (for production use HTTPS and set `BASE_URL`).

### Option B: Stdio (single user, .env only)

For a single user with credentials in `.env`:

```bash
# .env
TESLA_CLIENT_ID=...
TESLA_CLIENT_SECRET=...
TESLA_REFRESH_TOKEN=...
```

```bash
npm run build
npm start
```

Configure your MCP client to run the server command (e.g. `node run-mcp.js`). Get a refresh token with `npm run get-token`.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| **HTTP mode** | | |
| `BASE_URL` | Yes (production) | Public HTTPS URL of your server (e.g. `https://tesla-mcp.onrender.com`) |
| `TESLA_CLIENT_ID` | Optional | If set with `TESLA_CLIENT_SECRET`, users go **straight to the Tesla login page** (no setup page) |
| `TESLA_CLIENT_SECRET` | Optional | Server Tesla app secret; use with `TESLA_CLIENT_ID` |
| `PORT` | No | Port (default `3000`) |
| `HOST` | No | Bind address (default `0.0.0.0`) |
| **Stdio mode** | | |
| `TESLA_CLIENT_ID` | Yes | From [developer.tesla.com](https://developer.tesla.com) |
| `TESLA_CLIENT_SECRET` | Yes | From developer portal |
| `TESLA_REFRESH_TOKEN` | Yes | From `npm run get-token` |
| **SMS (Twilio, HTTP mode only)** | | |
| `TWILIO_ACCOUNT_SID` | Optional | Twilio account SID (enables get_recent_texts / send_text) |
| `TWILIO_AUTH_TOKEN` | Optional | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Optional | Your Twilio phone number (E.164, e.g. +15551234567) |

**SMS setup:** In the Twilio console, set your phone number’s “A message comes in” webhook to `https://YOUR_BASE_URL/webhooks/twilio/sms` (e.g. `https://tesla-mcp.onrender.com/webhooks/twilio/sms`). Inbound messages are stored in memory and returned by **get_recent_texts**; use **send_text** to reply.

**Never commit** `.env` or `keys/`. Run `./check-secrets.sh` before pushing.

---

## Tools (MCP)

| Tool | Description |
|------|-------------|
| **get_setup_url** | Get the URL to set up Tesla Developer credentials |
| **get_auth_url** | Get the URL to connect your Tesla account (after setup) |
| **list_vehicles** | List vehicles and their IDs (use with other tools) |
| **get_vehicle_location** | Current location (lat/long + Google Maps link); takes `vehicle_id` |
| **wake_up** | Wake a vehicle; takes `vehicle_id` |
| **refresh_vehicles** | Refresh the vehicle list from the API |
| **debug_vehicles** | Debug info (ids, vins, state) |
| **get_recent_texts** | List recent inbound SMS (optional; requires Twilio env vars) |
| **send_text** | Send an SMS to a number (optional; requires Twilio; args: `to`, `body`) |

For **vehicle_id** you can use `id`, `vehicle_id`, or `vin` from **list_cars**. For **send_text**, use E.164 phone numbers (e.g. `+15551234567`).

---

## Deploy

### Render

1. Connect your GitHub repo at [render.com](https://render.com) → New → Web Service.
2. **Build command:** `npm install && npm run build`  
   **Start command:** `npm run start:http`
3. Add env var: **BASE_URL** = `https://YOUR-SERVICE.onrender.com`
4. Users set their Tesla app redirect URI to `https://YOUR-SERVICE.onrender.com/auth/callback`.

### Docker

```bash
docker build -t tesla-mcp .
docker run -p 3000:3000 -e BASE_URL=https://your-domain.com tesla-mcp
```

**Production:** Use HTTPS and set `BASE_URL` to your public URL. On Render, set **Instance count to 1** so sessions persist. See [SECURITY.md](SECURITY.md).

---

## Troubleshooting

**Session keeps resetting / setup keeps asking**

1. **Confirm credentials were saved** — After submitting the setup form, you should see a green **"Credentials saved successfully"** message. If you see that, your Client ID and Secret were saved for that session.
2. **If setup keeps appearing**, double-check in your [Tesla Developer App](https://developer.tesla.com):
   - **Client ID** and **Client Secret** are correct (copy from the app page).
   - **Redirect URI** is set **exactly** to your server’s callback URL, for example:
     - Render: `https://tesla-mcp.onrender.com/auth/callback`
     - Local: `http://localhost:3000/auth/callback`
   Any typo or extra slash will cause Tesla to reject the auth and the session will not persist.

**“Authenticating your account” spinner never stops**

Tesla should redirect you back to this app; if the spinner never finishes, the redirect may be failing. Check that your Tesla app’s **Redirect URI** is exactly `https://tesla-mcp.onrender.com/auth/callback` (or your `BASE_URL` + `/auth/callback`). Try in a **normal browser window** with extensions disabled so nothing blocks the redirect.

**Session “doesn’t save” in incognito / have to log in again**

Sessions are stored on the **server**, not in the browser. Incognito doesn’t keep cookies, but we don’t use cookies for your session—we use the **connection URL** with the token. After you log in, you must **copy the connection URL** (e.g. `https://.../sse?token=...`) from the **success page** and use that URL as your MCP server URL. If you use the plain `/sse` URL without the token, each new connection gets a new session and you’ll be asked to set up or log in again.

**Tesla login page shows errors or won’t load (CSP, “inline script”, fingerprint, etc.)**

Those errors come from **Tesla’s** login site (`auth.tesla.com`), not from this server. Browsers or extensions (e.g. ad blockers, Cursor, or other injectors) can block scripts on Tesla’s page and break login.

- **Try in a private/incognito window** with extensions disabled.
- **Try another browser** or a clean profile without extensions.
- **Temporarily allow** `auth.tesla.com` in your ad/tracking blocker so Tesla’s scripts (and reCAPTCHA) can load.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript |
| `npm run start` | Run stdio MCP server |
| `npm run start:http` | Run HTTP/SSE server |
| `npm run dev:http` | Run HTTP server (dev, with ts-node) |
| `npm run get-token` | Get Tesla refresh token (local browser flow) |
| `npm run test-api` | Test Tesla API connection |
| `npm run register` | Register app with Tesla (uses ngrok) |
| `./check-secrets.sh` | Check for accidental secrets in code |

---

## License

[MIT](LICENSE)
