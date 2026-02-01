#!/usr/bin/env node

/**
 * Tesla MCP Server - HTTP/SSE Transport
 * A Model Context Protocol server that connects to the Tesla Fleet API
 * and allows controlling Tesla vehicles through AI assistants.
 * 
 * This version serves MCP over HTTP with SSE transport and provides
 * web-based OAuth authentication for multi-user support.
 * 
 * Users bring their own Tesla Developer App credentials.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { sessionManager } from './sessionManager.js';
import { createUserTeslaService, Vehicle } from './userTeslaService.js';

// For ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

// Configuration
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// OAuth constants
const AUTH_URL = 'https://auth.tesla.com/oauth2/v3';
const SCOPES = 'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds';

const app = express();
app.use(cors());
// Skip body parsing for POST /messages so the MCP transport can read the raw stream
app.use((req, res, next) => {
    if (req.path === '/messages' && req.method === 'POST') {
        return next();
    }
    express.json()(req, res, next);
});
app.use((req, res, next) => {
    if (req.path === '/messages' && req.method === 'POST') {
        return next();
    }
    express.urlencoded({ extended: true })(req, res, next);
});

// Store active transports and their sessions
const activeTransports: Map<string, { transport: SSEServerTransport; server: Server }> = new Map();

// Vehicle cache per session
const vehiclesCache: Map<string, { vehicles: Vehicle[]; lastFetch: number }> = new Map();
const CACHE_TTL = 60000; // 1 minute

/**
 * Get vehicles for a session with caching
 */
async function getVehiclesForSession(sessionId: string, forceRefresh = false): Promise<Vehicle[]> {
    const cache = vehiclesCache.get(sessionId);
    const now = Date.now();

    if (!forceRefresh && cache && (now - cache.lastFetch) < CACHE_TTL) {
        return cache.vehicles;
    }

    const teslaService = createUserTeslaService(sessionId);
    
    if (!teslaService.isAuthenticated()) {
        return [];
    }

    try {
        const vehicles = await teslaService.getVehicles();
        vehiclesCache.set(sessionId, { vehicles, lastFetch: now });
        return vehicles;
    } catch (error) {
        console.error('Error fetching vehicles:', error);
        return cache?.vehicles || [];
    }
}

/**
 * Create an MCP server instance for a user session
 */
function createMCPServer(sessionId: string): Server {
    const server = new Server(
        {
            name: "tesla-mcp-server",
            version: "0.1.0",
        },
        {
            capabilities: {
                resources: {},
                tools: {},
                prompts: {},
            },
        }
    );

    // Handler for listing available vehicles as resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const vehicles = await getVehiclesForSession(sessionId);

        return {
            resources: vehicles.map((vehicle) => ({
                uri: `tesla://${vehicle.id}`,
                mimeType: "application/json",
                name: vehicle.display_name || `Tesla (${vehicle.vin})`,
                description: `Tesla vehicle: ${vehicle.display_name || 'Unknown'} (VIN: ${vehicle.vin})`
            }))
        };
    });

    // Handler for reading the details of a specific vehicle
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const url = new URL(request.params.uri);
        const vehicleId = url.hostname;
        const vehicles = await getVehiclesForSession(sessionId);

        const vehicle = vehicles.find(v => v.id === vehicleId);

        if (!vehicle) {
            throw new Error(`Vehicle ${vehicleId} not found`);
        }

        return {
            contents: [{
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(vehicle, null, 2)
            }]
        };
    });

    // Handler that lists available tools - always show all tools so the UI shows full capability
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = [
            {
                name: "get_setup_url",
                description: "Get the URL to set up your Tesla Developer App credentials (Client ID and Secret). Open this link first if you haven't connected Tesla yet.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "get_auth_url",
                description: "Get the URL to connect your Tesla account (log in with your Tesla email and password). Use this after you've set up credentials.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "wake_up",
                description: "Wake up your Tesla vehicle from sleep mode. Requires vehicle_id (id, vehicle_id, or vin).",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: {
                            type: "string",
                            description: "Vehicle to wake up (id, vehicle_id, or vin)"
                        }
                    },
                    required: ["vehicle_id"]
                }
            },
            {
                name: "refresh_vehicles",
                description: "Refresh the list of Tesla vehicles from the API.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "debug_vehicles",
                description: "Show debug information about your Tesla vehicles (ids, vins, state).",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }
        ];
        return { tools };
    });

    // Handler for the vehicle control tools
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const teslaService = createUserTeslaService(sessionId);

        switch (request.params.name) {
            case "get_setup_url": {
                return {
                    content: [{
                        type: "text",
                        text: `Set up your Tesla Developer App credentials:\n\n**Open this link:** ${BASE_URL}/setup?session=${sessionId}\n\n1. Create an app at https://developer.tesla.com\n2. Set redirect URI to: ${BASE_URL}/auth/callback\n3. Enter your Client ID and Client Secret on the setup page`
                    }]
                };
            }

            case "get_auth_url": {
                if (!teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                return {
                    content: [{
                        type: "text",
                        text: `Connect your Tesla account:\n\n**Open this link:** ${BASE_URL}/auth/login?session=${sessionId}`
                    }]
                };
            }

            case "wake_up": {
                if (!teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Please set up your credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Not authenticated. Please visit: ${BASE_URL}/auth/login?session=${sessionId}`
                        }]
                    };
                }

                const vehicleId = String(request.params.arguments?.vehicle_id);
                if (!vehicleId) {
                    throw new Error("Vehicle ID is required");
                }

                const vehicles = await getVehiclesForSession(sessionId);
                const vehicle = vehicles.find(v =>
                    String(v.id) === vehicleId ||
                    String(v.vehicle_id) === vehicleId ||
                    String(v.vin) === vehicleId
                );

                if (!vehicle) {
                    throw new Error(`Vehicle ${vehicleId} not found`);
                }

                try {
                    const result = await teslaService.wakeUp(vehicleId);
                    return {
                        content: [{
                            type: "text",
                            text: result
                                ? `Successfully woke up ${vehicle.display_name || 'your Tesla'} (state: ${result.state})`
                                : `Failed to wake up ${vehicle.display_name || 'your Tesla'}`
                        }]
                    };
                } catch (error) {
                    throw new Error(`Failed to wake up vehicle: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            case "refresh_vehicles": {
                if (!teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Please set up your credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Not authenticated. Please visit: ${BASE_URL}/auth/login?session=${sessionId}`
                        }]
                    };
                }

                const vehicles = await getVehiclesForSession(sessionId, true);
                return {
                    content: [{
                        type: "text",
                        text: `Successfully refreshed the vehicle list. Found ${vehicles.length} vehicles.`
                    }]
                };
            }

            case "debug_vehicles": {
                if (!teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Please set up your credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Not authenticated. Please visit: ${BASE_URL}/auth/login?session=${sessionId}`
                        }]
                    };
                }

                const vehicles = await getVehiclesForSession(sessionId);

                if (vehicles.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: "No vehicles found. Make sure your Tesla account is properly connected."
                        }]
                    };
                }

                const debugInfo = vehicles.map(v => {
                    return `Vehicle: ${v.display_name || 'Tesla'}\n` +
                        `- id: ${v.id}\n` +
                        `- vehicle_id: ${v.vehicle_id}\n` +
                        `- vin: ${v.vin}\n` +
                        `- state: ${v.state}`;
                }).join('\n\n');

                return {
                    content: [{
                        type: "text",
                        text: `Found ${vehicles.length} vehicles:\n\n${debugInfo}`
                    }]
                };
            }

            default:
                throw new Error("Unknown tool");
        }
    });

    // Handler that lists available prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
        return {
            prompts: [
                {
                    name: "summarize_vehicles",
                    description: "Get information about your Tesla vehicles",
                }
            ]
        };
    });

    // Handler for the summarize_vehicles prompt
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        if (request.params.name !== "summarize_vehicles") {
            throw new Error("Unknown prompt");
        }

        const teslaService = createUserTeslaService(sessionId);

        if (!teslaService.hasCredentials()) {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Please set up your Tesla Developer credentials first by visiting: ${BASE_URL}/setup?session=${sessionId}`
                        }
                    }
                ]
            };
        }

        if (!teslaService.isAuthenticated()) {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Please authenticate with Tesla first by visiting: ${BASE_URL}/auth/login?session=${sessionId}`
                        }
                    }
                ]
            };
        }

        const vehicles = await getVehiclesForSession(sessionId);

        if (vehicles.length === 0) {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: "No Tesla vehicles found connected to your account."
                        }
                    }
                ]
            };
        }

        const embeddedVehicles = vehicles.map(vehicle => ({
            type: "resource" as const,
            resource: {
                uri: `tesla://${vehicle.id}`,
                mimeType: "application/json",
                text: JSON.stringify(vehicle, null, 2)
            }
        }));

        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: "Here is the information about my Tesla vehicles:"
                    }
                },
                ...embeddedVehicles.map(vehicle => ({
                    role: "user" as const,
                    content: vehicle
                })),
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: "Please provide a summary of all my Tesla vehicles including their names, battery levels, and current state (online/offline/asleep)."
                    }
                }
            ]
        };
    });

    return server;
}

// ============================================
// Common Styles
// ============================================

const commonStyles = `
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
    }
    .container {
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        border-radius: 20px;
        padding: 40px;
        max-width: 500px;
        width: 90%;
        text-align: center;
        box-shadow: 0 25px 45px rgba(0, 0, 0, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .logo {
        width: 80px;
        height: 80px;
        margin-bottom: 20px;
    }
    h1 {
        font-size: 24px;
        margin-bottom: 10px;
        font-weight: 600;
    }
    p {
        color: rgba(255, 255, 255, 0.7);
        margin-bottom: 20px;
        line-height: 1.6;
    }
    .btn {
        display: inline-block;
        background: linear-gradient(135deg, #e82127 0%, #cc1c21 100%);
        color: white;
        padding: 15px 40px;
        border-radius: 30px;
        text-decoration: none;
        font-weight: 600;
        font-size: 16px;
        transition: transform 0.2s, box-shadow 0.2s;
        box-shadow: 0 10px 30px rgba(232, 33, 39, 0.3);
        border: none;
        cursor: pointer;
    }
    .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 15px 40px rgba(232, 33, 39, 0.4);
    }
    .form-group {
        margin-bottom: 20px;
        text-align: left;
    }
    .form-group label {
        display: block;
        margin-bottom: 8px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.9);
    }
    .form-group input {
        width: 100%;
        padding: 12px 16px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(0, 0, 0, 0.3);
        color: #fff;
        font-size: 14px;
    }
    .form-group input:focus {
        outline: none;
        border-color: #e82127;
    }
    .form-group input::placeholder {
        color: rgba(255, 255, 255, 0.4);
    }
    .secure-note {
        margin-top: 20px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.5);
    }
    .secure-note svg {
        width: 14px;
        height: 14px;
        vertical-align: middle;
        margin-right: 5px;
    }
    .success-icon {
        width: 80px;
        height: 80px;
        margin-bottom: 20px;
    }
    .session-id {
        background: rgba(0,0,0,0.3);
        padding: 10px 20px;
        border-radius: 10px;
        font-family: monospace;
        margin: 20px 0;
        word-break: break-all;
        font-size: 12px;
    }
    .error { color: #e82127; }
    .steps {
        text-align: left;
        margin: 20px 0;
    }
    .steps li {
        margin-bottom: 10px;
        padding-left: 10px;
    }
    .steps a {
        color: #4fc3f7;
    }
`;

const logoSvg = `
    <svg class="logo" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="48" stroke="#e82127" stroke-width="4"/>
        <path d="M50 20L50 80M30 35L50 20L70 35M30 50H70" stroke="#e82127" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
`;

const successSvg = `
    <svg class="success-icon" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="48" stroke="#4CAF50" stroke-width="4"/>
        <path d="M30 50L45 65L70 35" stroke="#4CAF50" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
`;

// ============================================
// SSE/MCP Endpoints
// ============================================

// SSE endpoint - client connects here to receive messages
// The MCP SDK sends its own sessionId to the client in the "endpoint" event,
// so we must store the transport under that ID for POST /messages to find it.
app.get('/sse', async (req: Request, res: Response) => {
    // Get or create user session (for Tesla auth / credentials)
    let userSessionId = req.query.session as string;
    
    if (!userSessionId || !sessionManager.getSession(userSessionId)) {
        const session = sessionManager.createSession();
        userSessionId = session.sessionId;
    }

    // Create SSE transport first - it generates the sessionId the client will use for POSTs
    const transport = new SSEServerTransport('/messages', res);
    const transportSessionId = transport.sessionId;

    console.log(`SSE connection: userSession=${userSessionId}, transportSession=${transportSessionId}`);

    // Create MCP server with user's session (Tesla credentials live there)
    const server = createMCPServer(userSessionId);
    
    // Store under transport's sessionId so client POSTs to /messages?sessionId=X find us
    activeTransports.set(transportSessionId, { transport, server });

    // Clean up on disconnect
    res.on('close', () => {
        console.log(`SSE connection closed for transport ${transportSessionId}`);
        activeTransports.delete(transportSessionId);
    });

    // Connect server to transport
    await server.connect(transport);
});

// Messages endpoint - client sends messages here
app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID required' });
    }

    const transportData = activeTransports.get(sessionId);
    
    if (!transportData) {
        return res.status(404).json({ error: 'Session not found. Please reconnect to /sse' });
    }

    await transportData.transport.handlePostMessage(req, res);
});

// ============================================
// Setup Page (for entering credentials)
// ============================================

app.get('/setup', (req: Request, res: Response) => {
    let sessionId = req.query.session as string;
    
    // Create session if not provided
    if (!sessionId || !sessionManager.getSession(sessionId)) {
        const session = sessionManager.createSession();
        sessionId = session.sessionId;
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tesla MCP - Setup</title>
    <style>${commonStyles}</style>
</head>
<body>
    <div class="container">
        ${logoSvg}
        <h1>Setup Tesla Developer Credentials</h1>
        <p>To use Tesla MCP, you need to create a Tesla Developer App and enter your credentials below.</p>
        
        <ol class="steps">
            <li>Go to <a href="https://developer.tesla.com" target="_blank">developer.tesla.com</a></li>
            <li>Create a new application</li>
            <li>Set the Redirect URI to: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">${BASE_URL}/auth/callback</code></li>
            <li>Copy your Client ID and Client Secret below</li>
        </ol>
        
        <form method="POST" action="/setup">
            <input type="hidden" name="session" value="${sessionId}">
            
            <div class="form-group">
                <label for="client_id">Client ID</label>
                <input type="text" id="client_id" name="client_id" placeholder="Enter your Tesla Client ID" required>
            </div>
            
            <div class="form-group">
                <label for="client_secret">Client Secret</label>
                <input type="password" id="client_secret" name="client_secret" placeholder="Enter your Tesla Client Secret" required>
            </div>
            
            <button type="submit" class="btn">Save & Continue</button>
        </form>
        
        <p class="secure-note">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
            Your credentials are stored in your session only and never shared
        </p>
    </div>
</body>
</html>
    `);
});

app.post('/setup', (req: Request, res: Response) => {
    const { session, client_id, client_secret } = req.body;
    
    if (!session || !client_id || !client_secret) {
        return res.status(400).send('Missing required fields');
    }

    // Validate session exists
    if (!sessionManager.getSession(session)) {
        return res.status(400).send('Invalid session');
    }

    // Store credentials in session
    sessionManager.updateSession(session, {
        clientId: client_id,
        clientSecret: client_secret,
    });

    // Redirect to auth login
    res.redirect(`/auth/login?session=${session}`);
});

// ============================================
// Authentication Endpoints
// ============================================

// Login page - redirects to Tesla OAuth
app.get('/auth/login', (req: Request, res: Response) => {
    let sessionId = req.query.session as string;
    
    // Create session if not provided
    if (!sessionId || !sessionManager.getSession(sessionId)) {
        const session = sessionManager.createSession();
        sessionId = session.sessionId;
        // Redirect to setup since no credentials
        return res.redirect(`/setup?session=${sessionId}`);
    }

    const session = sessionManager.getSession(sessionId);
    
    // Check if credentials are set
    if (!session?.clientId || !session?.clientSecret) {
        return res.redirect(`/setup?session=${sessionId}`);
    }

    // Generate OAuth state and PKCE
    const state = sessionManager.generateOAuthState(sessionId);
    const { challenge } = sessionManager.generatePKCE(sessionId);
    
    const redirectUri = `${BASE_URL}/auth/callback`;
    
    // Build Tesla OAuth URL
    const authUrl = new URL(`${AUTH_URL}/authorize`);
    authUrl.searchParams.set('client_id', session.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', `${sessionId}:${state}`);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Send login page that redirects to Tesla
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tesla MCP - Connect Your Tesla</title>
    <style>${commonStyles}</style>
</head>
<body>
    <div class="container">
        ${logoSvg}
        <h1>Connect Your Tesla</h1>
        <p>You'll be redirected to Tesla's secure login page to connect your Tesla account.</p>
        <a href="${authUrl.toString()}" class="btn">Connect with Tesla</a>
        <p class="secure-note">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
            Your Tesla login is handled securely by Tesla
        </p>
    </div>
</body>
</html>
    `);
});

// OAuth callback - receives authorization code from Tesla
app.get('/auth/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const stateParam = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
        return res.status(400).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Error</title>
    <style>${commonStyles}</style>
</head>
<body>
    <div class="container">
        <h1 class="error">Authentication Failed</h1>
        <p>Error: ${error}</p>
        <p>Please close this window and try again.</p>
    </div>
</body>
</html>
        `);
    }

    if (!code || !stateParam) {
        return res.status(400).send('Missing authorization code or state');
    }

    // Parse state (format: sessionId:state)
    const [sessionId, state] = stateParam.split(':');
    
    if (!sessionId || !sessionManager.validateState(sessionId, state)) {
        return res.status(400).send('Invalid state parameter');
    }

    const session = sessionManager.getSession(sessionId);
    if (!session?.clientId || !session?.clientSecret) {
        return res.status(400).send('Session credentials not found');
    }

    const codeVerifier = sessionManager.getCodeVerifier(sessionId);
    if (!codeVerifier) {
        return res.status(400).send('Missing code verifier');
    }

    try {
        // Exchange authorization code for tokens
        const params = new URLSearchParams();
        params.append('grant_type', 'authorization_code');
        params.append('client_id', session.clientId);
        params.append('client_secret', session.clientSecret);
        params.append('code', code);
        params.append('code_verifier', codeVerifier);
        params.append('redirect_uri', `${BASE_URL}/auth/callback`);

        const tokenResponse = await axios.post(`${AUTH_URL}/token`, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        // Store tokens in session
        sessionManager.updateSession(sessionId, {
            accessToken: access_token,
            refreshToken: refresh_token,
            tokenExpiration: Date.now() + (expires_in * 1000),
        });

        // Success page
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tesla Connected!</title>
    <style>${commonStyles}</style>
</head>
<body>
    <div class="container">
        ${successSvg}
        <h1 style="color: #4CAF50;">Tesla Connected!</h1>
        <p>Your Tesla account has been successfully connected. You can now close this window and return to your AI assistant.</p>
        <p>Your session ID (save this to reconnect):</p>
        <div class="session-id">${sessionId}</div>
        <p style="font-size: 12px; margin-top: 20px;">This window will close automatically in 5 seconds...</p>
    </div>
    <script>
        setTimeout(() => window.close(), 5000);
    </script>
</body>
</html>
        `);

    } catch (error: any) {
        console.error('Token exchange error:', error.response?.data || error.message);
        res.status(500).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Error</title>
    <style>${commonStyles}</style>
</head>
<body>
    <div class="container">
        <h1 class="error">Authentication Failed</h1>
        <p>Failed to exchange authorization code for tokens.</p>
        <p>Please close this window and try again.</p>
    </div>
</body>
</html>
        `);
    }
});

// ============================================
// Status and Health Endpoints
// ============================================

app.get('/', (req: Request, res: Response) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tesla MCP Server</title>
    <style>
        ${commonStyles}
        .container { max-width: 650px; text-align: left; }
        h1 { text-align: center; }
        .status { color: #4CAF50; }
        .endpoint {
            background: rgba(0,0,0,0.3);
            padding: 15px;
            border-radius: 10px;
            margin: 10px 0;
        }
        .endpoint code {
            color: #ffd700;
        }
        .endpoint p {
            margin-top: 5px;
            color: rgba(255,255,255,0.7);
            font-size: 14px;
        }
        .start-btn {
            display: block;
            text-align: center;
            margin: 30px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Tesla MCP Server <span class="status">● Running</span></h1>
        <p style="text-align: center;">Control your Tesla through AI assistants using the Model Context Protocol.</p>
        
        <div class="start-btn">
            <a href="/setup" class="btn">Get Started</a>
        </div>
        
        <h2 style="margin-top: 30px;">How It Works</h2>
        <ol class="steps">
            <li>Create a Tesla Developer App at <a href="https://developer.tesla.com" target="_blank">developer.tesla.com</a></li>
            <li>Enter your Client ID and Client Secret</li>
            <li>Connect your Tesla account</li>
            <li>Use your AI assistant to control your Tesla!</li>
        </ol>
        
        <h2 style="margin-top: 30px;">Endpoints</h2>
        
        <div class="endpoint">
            <code>GET /sse?session=YOUR_SESSION_ID</code>
            <p>SSE endpoint for MCP client connection</p>
        </div>
        
        <div class="endpoint">
            <code>POST /messages?sessionId=YOUR_SESSION_ID</code>
            <p>Message endpoint for MCP client requests</p>
        </div>
        
        <div class="endpoint">
            <code>GET /setup?session=YOUR_SESSION_ID</code>
            <p>Set up your Tesla Developer credentials</p>
        </div>
        
        <div class="endpoint">
            <code>GET /auth/login?session=YOUR_SESSION_ID</code>
            <p>Start Tesla OAuth authentication flow</p>
        </div>
    </div>
</body>
</html>
    `);
});

app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'healthy',
        activeSessions: sessionManager.getSessionCount(),
        activeConnections: activeTransports.size,
    });
});

// Create a new session and return URLs
app.post('/auth/session', (req: Request, res: Response) => {
    const session = sessionManager.createSession();
    res.json({
        sessionId: session.sessionId,
        setupUrl: `${BASE_URL}/setup?session=${session.sessionId}`,
        sseUrl: `${BASE_URL}/sse?session=${session.sessionId}`,
    });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, HOST, () => {
    console.log(`Tesla MCP Server running at http://${HOST}:${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  - Home:  http://${HOST}:${PORT}/`);
    console.log(`  - Setup: http://${HOST}:${PORT}/setup`);
    console.log(`  - SSE:   http://${HOST}:${PORT}/sse`);
    console.log(`\nUsers can set up their own Tesla Developer credentials.`);
    console.log(`Set BASE_URL environment variable for production deployment.`);
});
