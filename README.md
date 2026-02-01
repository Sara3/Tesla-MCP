# Tesla MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for the Tesla Fleet API. Control your Tesla and get vehicle data (location, wake up, list cars) from any MCP-capable AI assistant or agent.

## Features

- **list_cars** — List your vehicles and get IDs for use with other tools
- **get_vehicle_location** — Current GPS location and Google Maps link (parking monitor style)
- **wake_up** — Wake a vehicle from sleep
- **refresh_vehicles** / **debug_vehicles** — Refresh list and debug info
- **HTTP/SSE mode** — Host as a web service; each user brings their own Tesla Developer credentials (no server-side secrets required)

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
4. After that, tools like **list_cars** and **get_vehicle_location** work for your vehicles.

**Getting Tesla Developer credentials:** Create an app at [developer.tesla.com](https://developer.tesla.com). Set the redirect URI to `https://YOUR_SERVER_URL/auth/callback` (e.g. `https://tesla-mcp.onrender.com/auth/callback`).

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
| `PORT` | No | Port (default `3000`) |
| `HOST` | No | Bind address (default `0.0.0.0`) |
| **Stdio mode** | | |
| `TESLA_CLIENT_ID` | Yes | From [developer.tesla.com](https://developer.tesla.com) |
| `TESLA_CLIENT_SECRET` | Yes | From developer portal |
| `TESLA_REFRESH_TOKEN` | Yes | From `npm run get-token` |

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

For **vehicle_id** you can use `id`, `vehicle_id`, or `vin` from **list_cars**.

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

**Production:** Use HTTPS and set `BASE_URL` to your public URL. See [SECURITY.md](SECURITY.md).

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
