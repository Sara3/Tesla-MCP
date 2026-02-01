# Tesla MCP Server

A Model Context Protocol (MCP) server that connects to the Tesla Fleet API, allowing you to control your Tesla vehicle using Claude and other AI assistants that support MCP.

<a href="https://glama.ai/mcp/servers/t0ako8h64j">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/t0ako8h64j/badge" alt="Tesla Server MCP server" />
</a>

## Features

- **Wake up vehicles**: Wake up your Tesla from sleep mode
- **Vehicle information**: Get detailed information about your Tesla vehicles
- **Real-time updates**: Refresh vehicle data on demand
- **Debugging tools**: Access detailed vehicle information to help with troubleshooting

## Requirements

- Node.js 18+
- pnpm (preferred) or npm
- Tesla account with at least one vehicle
- Tesla API credentials (Client ID and Client Secret)
- Ngrok (for development and registration)

## Security Best Practices

This project handles sensitive Tesla API credentials. Please follow these security practices:

- **Never commit credentials**: The `.gitignore` file excludes `.env` and `keys/` but always double-check
- **Use the security checker**: Run `./check-secrets.sh` before committing to detect potentially leaked credentials
- **Protect your private keys**: Keep the contents of the `keys/` directory secure
- **Review code before sharing**: Make sure no credentials are hardcoded in any source files

When forking or sharing this project:

1. Make sure the `.env` file is not included
2. Check that no private keys are committed
3. Verify the `.gitignore` file is properly set up

## Quick Start

1. **Clone the repository**

   ```bash
   git clone https://github.com/yourusername/tesla-mcp.git
   cd tesla-mcp
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Set up environment variables**
   Create a `.env` file in the root directory:

   ```
   TESLA_CLIENT_ID=your_client_id
   TESLA_CLIENT_SECRET=your_client_secret
   TESLA_REFRESH_TOKEN=your_refresh_token
   ```

4. **Get a refresh token** (if you don't have one)

   ```bash
   pnpm get-token
   ```

5. **Register your application** with Tesla's API

   ```bash
   pnpm register
   ```

   Follow the instructions provided by the script

6. **Build the server**

   ```bash
   pnpm build
   ```

7. **Run the server**
   ```bash
   pnpm start
   ```

## Authentication & Registration

This project uses the official Tesla Fleet API OAuth 2.0 authentication flow to securely connect to your Tesla account. The full process involves two steps:

1. **Authentication**: Obtaining a refresh token through the OAuth 2.0 flow
2. **Registration**: Registering your application with Tesla via the Partner Accounts API

### Authentication

Authentication requires:

- Client ID and Client Secret from the [Tesla Developer Portal](https://developer.tesla.com/)
- A refresh token obtained through the OAuth 2.0 authorization code flow

The included `pnpm get-token` utility simplifies this process by:

- Opening a browser for you to log in with your Tesla account credentials
- Performing the OAuth PKCE (Proof Key for Code Exchange) flow
- Exchanging the authorization code for refresh and access tokens
- Storing the refresh token in your `.env` file

### Registration

The Tesla Fleet API requires applications to be registered before they can access vehicle data. The registration server (`pnpm register`) automates this process:

- Generates the required EC key pair
- Uses ngrok to create a temporary public URL for development
- Hosts the public key at the required path
- Handles the registration API call with Tesla

#### Ngrok Setup (Required for Registration)

1. Install ngrok from [ngrok.com/download](https://ngrok.com/download)
2. Create a free account at [ngrok.com](https://ngrok.com/)
3. Get your auth token from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken)
4. Authenticate ngrok:
   ```bash
   ngrok authtoken YOUR_AUTH_TOKEN
   ```

## Available MCP Tools

The server provides the following tools that Claude can use:

- **`wake_up`**: Wakes up a Tesla vehicle from sleep mode

  - Takes `vehicle_id` as a required parameter
  - Returns the current state of the vehicle

- **`refresh_vehicles`**: Refreshes the list of Tesla vehicles

  - No parameters required
  - Updates the internal cache of vehicles

- **`debug_vehicles`**: Shows detailed information about available vehicles
  - No parameters required
  - Returns ID, vehicle_id, VIN, and state information

- **`get_vehicle_location`**: Get your Tesla's current location (latitude, longitude)
  - Takes `vehicle_id` (id, vehicle_id, or vin)
  - Returns coordinates and a Google Maps link (like a parking monitor)

## Setting Up Claude to Use the MCP Server

1. Create the Claude configuration directory:

   ```bash
   mkdir -p ~/Library/Application\ Support/Claude
   ```

2. Create or edit the configuration file:

   ```bash
   nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

3. Add the following configuration (adjust the path as needed):

   ```json
   {
     "mcpServers": {
       "tesla-mcp-server": {
         "command": "/absolute/path/to/tesla-mcp/run-mcp.js"
       }
     }
   }
   ```

4. Make the run-mcp.js script executable:

   ```bash
   chmod +x run-mcp.js
   ```

5. Restart Claude completely

## Using the MCP Server with Claude

Once the server is running and Claude is configured, you can ask Claude to:

- "What Tesla vehicles do I have?"
- "Can you wake up my Tesla?"
- "Show me debug information about my Tesla vehicles"

## Troubleshooting

If you encounter issues:

### Environment Variables

- Ensure your `.env` file contains valid credentials
- Run `pnpm get-token` to refresh your token if needed

### Server Connection

- Check that the server is running (`pnpm start`)
- Verify Claude's configuration points to the correct file path

### Vehicle Connectivity

- Vehicle might be offline or asleep
- Try waking up the vehicle first with the `wake_up` command

### Debug Mode

- Use the `debug_vehicles` command to get detailed information about your vehicles
- Check the server logs in the terminal where you're running the MCP server

## HTTP/SSE Mode (Multi-User Hosted Server)

The server can also run in HTTP/SSE mode, allowing you to host it as a web service that supports multiple users. **Each user brings their own Tesla Developer App credentials** - no pre-configuration required!

### Running in HTTP Mode

```bash
# Build first
npm run build

# Run the HTTP server
npm run start:http
```

Or for development:

```bash
npm run dev:http
```

### Environment Variables for HTTP Mode

```env
PORT=3000                           # Optional, default 3000
HOST=0.0.0.0                        # Optional, default 0.0.0.0
BASE_URL=https://your-domain.com    # Required for production (for OAuth redirect)
```

**Note:** No Tesla credentials are needed to start the server. Each user provides their own credentials through the web UI.

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info and documentation |
| `/health` | GET | Health check endpoint |
| `/sse?session=SESSION_ID` | GET | SSE endpoint for MCP client connection |
| `/messages?sessionId=SESSION_ID` | POST | Message endpoint for MCP requests |
| `/auth/login?session=SESSION_ID` | GET | Start Tesla OAuth flow |
| `/auth/callback` | GET | OAuth callback (internal) |
| `/auth/session` | POST | Create a new session and get auth URL |

### How Multi-User Auth Works

1. **Client Connects**: MCP client connects to `/sse` endpoint
2. **Session Created**: Server creates a session and returns session ID
3. **Setup Required**: User visits `/setup` to enter their Tesla Developer App credentials (Client ID & Secret)
4. **User Authenticates**: User is redirected to Tesla's OAuth login page
5. **Tokens Stored**: Server stores tokens for that session
6. **Tools Available**: MCP tools now work with user's Tesla account

Each user needs to:
1. Create an app at [developer.tesla.com](https://developer.tesla.com)
2. Set the redirect URI to `YOUR_SERVER_URL/auth/callback`
3. Enter their Client ID and Client Secret in the setup page

### Connecting MCP Clients

**Tool box / custom tool (e.g. v.app, agent UIs):**

1. **Server URL:** Use `https://tesla-mcp.onrender.com/sse` (no session ID needed).
2. **Enable the tool** – the connection will be established.
3. **First time:** When you use a Tesla action, the agent will return a link. Open that link to:
   - Enter your Tesla Developer App credentials (Client ID & Secret from [developer.tesla.com](https://developer.tesla.com)),
   - Then log in with your Tesla account.
4. Each user logs in to their own Tesla account; credentials are stored per session.

**Optional (persistent session):** You can use a session in the URL so the same session is reused:

```
SSE URL: https://your-domain.com/sse?session=YOUR_SESSION_ID
```

Get a session by visiting `https://your-domain.com/setup` or `https://your-domain.com/auth/session`.

### Deploy to Render (Recommended)

The easiest way to deploy is using Render:

1. **Push to GitHub** (if not already):
   ```bash
   git add .
   git commit -m "Add HTTP server with user auth"
   git push origin main
   ```

2. **Deploy on Render**:
   - Go to [render.com](https://render.com) and sign up/login
   - Click **New** → **Web Service**
   - Connect your GitHub repo
   - Configure:
     - **Build Command**: `npm install && npm run build`
     - **Start Command**: `npm run start:http`
   - Add environment variable:
     - `BASE_URL` = `https://your-app-name.onrender.com` (use your actual Render URL)
   - Click **Create Web Service**

3. **Get your public URL**: Render will give you a URL like `https://tesla-mcp-xxxx.onrender.com`

4. **Tell users** to set their Tesla Developer App redirect URI to:
   ```
   https://your-app-name.onrender.com/auth/callback
   ```

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Alternative: Docker Deployment

```bash
# Build the image
docker build -t tesla-mcp .

# Run with your public URL
docker run -p 3000:3000 \
  -e BASE_URL=https://your-domain.com \
  tesla-mcp
```

### Production Considerations

- **HTTPS Required**: Tesla OAuth requires HTTPS (Render provides this automatically)
- **BASE_URL**: Must be set to your public URL for OAuth redirects to work
- **No credentials needed**: Users provide their own Tesla Developer credentials

## Command Line Tools

The server includes several helpful scripts:

- `npm run build`: Compile the TypeScript code
- `npm run start`: Run the stdio MCP server
- `npm run start:http`: Run the HTTP/SSE MCP server
- `npm run dev:http`: Run HTTP server in development mode
- `npm run register`: Register your app with Tesla's API
- `npm run get-token`: Get a refresh token from Tesla
- `npm run test-api`: Test your connection to the Tesla API
- `npm run inspector`: Run the server with the MCP Inspector for debugging

## API Limitations

As of 2023-10-09, Tesla has deprecated many vehicle command endpoints in their REST API. Commands like honking the horn now require the [Tesla Vehicle Command Protocol](https://github.com/teslamotors/vehicle-command) instead of the REST API. This MCP server currently supports only REST API endpoints that remain functional.

## Future Enhancements

Possible future improvements include:

- Integration with Tesla's Vehicle Command Protocol for additional commands
- Support for more vehicle information endpoints
- User interface for configuration and monitoring

## License

[MIT License](LICENSE)