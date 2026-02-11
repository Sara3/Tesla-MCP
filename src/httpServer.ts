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
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

// Optional: server Tesla app (if set, users go straight to Tesla login — no setup page)
const SERVER_CLIENT_ID = process.env.TESLA_CLIENT_ID;
const SERVER_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const HAS_SERVER_CREDENTIALS = !!(SERVER_CLIENT_ID && SERVER_CLIENT_SECRET);

// OAuth constants
const AUTH_URL = 'https://auth.tesla.com/oauth2/v3';
const SCOPES = 'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds';

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

// Store active SSE transports and their sessions
const activeTransports: Map<string, { transport: SSEServerTransport; server: Server }> = new Map();

// Store active Streamable HTTP transports (for /mcp endpoint)
const mcpHttpTransports: Map<string, { transport: StreamableHTTPServerTransport; server: Server; userSessionId: string }> = new Map();

// ============================================
// MCP OAuth 2.1 Authorization Server stores
// ============================================

// Registered OAuth clients (dynamic client registration)
const oauthClients: Map<string, { client_id: string; client_secret: string; redirect_uris: string[] }> = new Map();

// Auth codes (short-lived, maps code → session info for token exchange)
const oauthAuthCodes: Map<string, {
    userSessionId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    expiresAt: number;
}> = new Map();

// MCP bearer tokens (maps token → user session)
const mcpBearerTokens: Map<string, { userSessionId: string; expiresAt: number }> = new Map();

// MCP refresh tokens (maps token → user session + client)
const mcpRefreshTokens: Map<string, { userSessionId: string; clientId: string }> = new Map();

// Vehicle cache per session
const vehiclesCache: Map<string, { vehicles: Vehicle[]; lastFetch: number }> = new Map();
const CACHE_TTL = 60000; // 1 minute

// Optional SMS (Twilio): inbound messages stored here for get_recent_texts
export interface InboundSms {
    from: string;
    to: string;
    body: string;
    receivedAt: number;
}
const SMS_INBOX_MAX = 100;
const smsInbox: InboundSms[] = [];

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const HAS_TWILIO = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);

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
    } catch {
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
            },
            {
                name: "get_vehicle_location",
                description: "Get your Tesla's current location (latitude, longitude). Like a parking monitor - where is my car right now. May wake the vehicle briefly.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: {
                            type: "string",
                            description: "Vehicle to get location for (id, vehicle_id, or vin)"
                        }
                    },
                    required: ["vehicle_id"]
                }
            },
            {
                name: "list_vehicles",
                description: "List your Tesla vehicles and get their IDs (id, vehicle_id, vin). Use these with wake_up, get_vehicle_location, etc.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            // --- Tier 1: Data tools ---
            {
                name: "get_battery_status",
                description: "Get your Tesla's battery level, range, charging state, charge limit, and time to full charge.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" }
                    },
                    required: ["vehicle_id"]
                }
            },
            {
                name: "get_climate_status",
                description: "Get your Tesla's climate info: inside/outside temperature, climate on/off, seat heaters, and temperature settings.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" }
                    },
                    required: ["vehicle_id"]
                }
            },
            {
                name: "get_vehicle_status",
                description: "Get your Tesla's status: locked/unlocked, doors, windows, trunk/frunk, sentry mode, odometer, and software update info.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" }
                    },
                    required: ["vehicle_id"]
                }
            },
            // --- Tier 2: Command tools ---
            {
                name: "lock_unlock",
                description: "Lock or unlock your Tesla.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        action: { type: "string", enum: ["lock", "unlock"], description: "lock or unlock" }
                    },
                    required: ["vehicle_id", "action"]
                }
            },
            {
                name: "climate_control",
                description: "Start/stop your Tesla's climate (AC/heat), or set the temperature.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        action: { type: "string", enum: ["start", "stop"], description: "start or stop climate" },
                        driver_temp: { type: "number", description: "Driver side temperature in Celsius (e.g. 21)" },
                        passenger_temp: { type: "number", description: "Passenger side temperature in Celsius (e.g. 21)" }
                    },
                    required: ["vehicle_id", "action"]
                }
            },
            {
                name: "charge_control",
                description: "Start/stop charging or set the charge limit for your Tesla.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        action: { type: "string", enum: ["start", "stop", "set_limit"], description: "start, stop, or set_limit" },
                        limit: { type: "number", description: "Charge limit percentage (50-100), required when action is set_limit" }
                    },
                    required: ["vehicle_id", "action"]
                }
            },
            {
                name: "open_trunk",
                description: "Open your Tesla's rear trunk or front trunk (frunk).",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        which: { type: "string", enum: ["rear", "front"], description: "rear trunk or front trunk (frunk)" }
                    },
                    required: ["vehicle_id", "which"]
                }
            },
            {
                name: "honk_flash",
                description: "Honk the horn or flash the lights on your Tesla to find it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        action: { type: "string", enum: ["honk", "flash"], description: "honk horn or flash lights" }
                    },
                    required: ["vehicle_id", "action"]
                }
            },
            // --- Tier 3: Nice-to-have tools ---
            {
                name: "send_navigation",
                description: "Send a destination address to your Tesla's navigation system.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        address: { type: "string", description: "Destination address (e.g. '1600 Amphitheatre Parkway, Mountain View, CA')" }
                    },
                    required: ["vehicle_id", "address"]
                }
            },
            {
                name: "nearby_charging",
                description: "Find nearby Superchargers and destination chargers for your Tesla.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" }
                    },
                    required: ["vehicle_id"]
                }
            },
            {
                name: "sentry_mode",
                description: "Turn sentry mode on or off for your Tesla.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        enabled: { type: "boolean", description: "true to enable, false to disable" }
                    },
                    required: ["vehicle_id", "enabled"]
                }
            },
            {
                name: "window_control",
                description: "Vent (open slightly) or close all windows on your Tesla.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        action: { type: "string", enum: ["vent", "close"], description: "vent or close windows" }
                    },
                    required: ["vehicle_id", "action"]
                }
            },
            {
                name: "media_control",
                description: "Control media playback in your Tesla: play/pause, next/previous track, or adjust volume.",
                inputSchema: {
                    type: "object",
                    properties: {
                        vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" },
                        action: { type: "string", enum: ["toggle_playback", "next_track", "prev_track", "volume_up", "volume_down"], description: "Media action" }
                    },
                    required: ["vehicle_id", "action"]
                }
            },
            ...(HAS_TWILIO ? [
                {
                    name: "get_recent_texts",
                    description: "Get recent inbound SMS messages received by your Twilio number. Use this to see new texts so you can respond.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            limit: {
                                type: "number",
                                description: "Max number of messages to return (default 10)"
                            }
                        },
                        required: []
                    }
                },
                {
                    name: "send_text",
                    description: "Send an SMS (text message) to a phone number. Use E.164 format (e.g. +15551234567).",
                    inputSchema: {
                        type: "object",
                        properties: {
                            to: {
                                type: "string",
                                description: "Phone number in E.164 format (e.g. +15551234567)"
                            },
                            body: {
                                type: "string",
                                description: "Message text to send"
                            }
                        },
                        required: ["to", "body"]
                    }
                }
            ] : [])
        ];
        return { tools };
    });

    // Handler for the vehicle control tools
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const teslaService = createUserTeslaService(sessionId);

        // Auto-inject server credentials into session so users don't need to set up their own Tesla Developer App
        if (HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
            sessionManager.updateSession(sessionId, {
                clientId: SERVER_CLIENT_ID,
                clientSecret: SERVER_CLIENT_SECRET,
            });
        }

        // Helper: generate the right auth URL for the current session
        const getAuthUrl = () => `${BASE_URL}/auth/login?session=${sessionId}`;

        switch (request.params.name) {
            case "list_vehicles": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.`
                        }]
                    };
                }

                const listVehicles = await getVehiclesForSession(sessionId);
                if (listVehicles.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: "No vehicles found. Try refresh_vehicles first."
                        }]
                    };
                }

                const lines = listVehicles.map((v, i) => {
                    return `${i + 1}. **${v.display_name || "Tesla"}**\n   id: \`${v.id}\`\n   vehicle_id: \`${v.vehicle_id}\`\n   vin: \`${v.vin}\`\n   state: ${v.state ?? "—"}`;
                });
                const text = `Your Tesla vehicles (use **id** or **vehicle_id** or **vin** with other tools):\n\n${lines.join("\n\n")}`;
                return {
                    content: [{ type: "text", text }]
                };
            }

            case "get_vehicle_location": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.`
                        }]
                    };
                }

                const locationVehicleId = String(request.params.arguments?.vehicle_id);
                if (!locationVehicleId) {
                    throw new Error("vehicle_id is required");
                }

                const locationVehicles = await getVehiclesForSession(sessionId);
                const locationVehicle = locationVehicles.find(v =>
                    String(v.id) === locationVehicleId ||
                    String(v.vehicle_id) === locationVehicleId ||
                    String(v.vin) === locationVehicleId
                );
                if (!locationVehicle) {
                    throw new Error(`Vehicle ${locationVehicleId} not found`);
                }

                try {
                    // Use the matched vehicle's id and request location data
                    const data = await teslaService.getVehicleData(String(locationVehicle.id), true);
                    const lat = data.latitude ?? data.native_latitude;
                    const lon = data.longitude ?? data.native_longitude;
                    const name = locationVehicle.display_name || "Tesla";

                    if (lat != null && lon != null) {
                        const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
                        const text = `${name} location:\n• Latitude: ${lat}\n• Longitude: ${lon}\n• Map: ${mapsUrl}\n• Heading: ${data.heading ?? "—"}\n• Speed: ${data.speed ?? "—"}\n• Shift: ${data.shift_state ?? "—"}`;
                        return {
                            content: [{ type: "text", text }]
                        };
                    }
                    if (data._location_scope_missing) {
                        return {
                            content: [{
                                type: "text",
                                text: `Location not available for ${name}.\n\nYour token is missing the **vehicle_location** scope. To fix:\n1. Go to developer.tesla.com and open your app\n2. Add **vehicle_location** to the allowed scopes\n3. Re-authenticate (run: npm run get-token)\n4. Restart the MCP server`
                            }]
                        };
                    }
                    const debugFields = data._debug_fields_present ?? Object.keys(data).slice(0, 20);
                    return {
                        content: [{
                            type: "text",
                            text: `Location not available for ${name}.\n\nPossible causes:\n• Vehicle may need wake_up first\n• "Allow Mobile Access" must be enabled in vehicle Settings > Safety\n\nAPI data sections: ${JSON.stringify(debugFields)}\ndrive_state: ${!!data.drive_state}, location_data: ${!!data.location_data}`
                        }]
                    };
                } catch (error: any) {
                    throw new Error(`Failed to get location: ${error.message}`);
                }
            }

            case "wake_up": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.`
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
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.`
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
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}`
                        }]
                    };
                }
                if (!teslaService.isAuthenticated()) {
                    return {
                        content: [{
                            type: "text",
                            text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.`
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

            // ========== Tier 1: Data Tools ==========

            case "get_battery_status": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);

                const data = await teslaService.getVehicleData(vid);
                const cs = data.charge_state as any;
                const name = veh.display_name || "Tesla";

                if (!cs) {
                    return { content: [{ type: "text", text: `Battery data not available for ${name}. Try wake_up first.` }] };
                }

                const lines = [
                    `${name} Battery Status:`,
                    `• Battery Level: ${cs.battery_level}%` + (cs.usable_battery_level != null && cs.usable_battery_level !== cs.battery_level ? ` (usable: ${cs.usable_battery_level}%)` : ''),
                    `• Range: ${cs.battery_range} mi` + (cs.est_battery_range ? ` (est: ${cs.est_battery_range} mi)` : ''),
                    `• Charge Limit: ${cs.charge_limit_soc}%`,
                    `• Charging: ${cs.charging_state ?? 'Unknown'}`,
                    ...(cs.charging_state === 'Charging' ? [
                        `• Charge Rate: ${cs.charge_rate} mph / ${cs.charger_power} kW`,
                        `• Time to Full: ${cs.minutes_to_full_charge} min`,
                        `• Energy Added: ${cs.charge_energy_added} kWh`,
                    ] : []),
                    `• Charge Port: ${cs.charge_port_door_open ? 'Open' : 'Closed'}` + (cs.conn_charge_cable && cs.conn_charge_cable !== '<invalid>' ? ` (${cs.conn_charge_cable})` : ''),
                    `• Scheduled Charging: ${cs.scheduled_charging_mode ?? 'Off'}`,
                ];
                return { content: [{ type: "text", text: lines.join('\n') }] };
            }

            case "get_climate_status": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);

                const data = await teslaService.getVehicleData(vid);
                const cl = data.climate_state as any;
                const gs = data.gui_settings as any;
                const name = veh.display_name || "Tesla";

                if (!cl) {
                    return { content: [{ type: "text", text: `Climate data not available for ${name}. Try wake_up first.` }] };
                }

                const tempUnit = gs?.gui_temperature_units === 'F' ? 'F' : 'C';
                const toDisplay = (c: number) => tempUnit === 'F' ? `${Math.round(c * 9/5 + 32)}°F` : `${c}°C`;

                const lines = [
                    `${name} Climate Status:`,
                    `• Climate: ${cl.is_climate_on ? 'ON' : 'OFF'}` + (cl.is_preconditioning ? ' (preconditioning)' : ''),
                    `• Inside Temp: ${toDisplay(cl.inside_temp)}`,
                    `• Outside Temp: ${toDisplay(cl.outside_temp)}`,
                    `• Driver Temp Setting: ${toDisplay(cl.driver_temp_setting)}`,
                    `• Passenger Temp Setting: ${toDisplay(cl.passenger_temp_setting)}`,
                    `• Fan Status: ${cl.fan_status}`,
                    `• Seat Heaters: Driver=${cl.seat_heater_left ?? '—'}, Passenger=${cl.seat_heater_right ?? '—'}`,
                    `• Steering Wheel Heater: ${cl.steering_wheel_heater ? 'ON' : 'OFF'}`,
                    `• Front Defroster: ${cl.is_front_defroster_on ? 'ON' : 'OFF'}`,
                    `• Rear Defroster: ${cl.is_rear_defroster_on ? 'ON' : 'OFF'}`,
                    `• Cabin Overheat Protection: ${cl.cabin_overheat_protection ?? 'Off'}`,
                ];
                return { content: [{ type: "text", text: lines.join('\n') }] };
            }

            case "get_vehicle_status": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);

                const data = await teslaService.getVehicleData(vid);
                const vs = data.vehicle_state as any;
                const vc = data.vehicle_config as any;
                const name = veh.display_name || "Tesla";

                if (!vs) {
                    return { content: [{ type: "text", text: `Vehicle status not available for ${name}. Try wake_up first.` }] };
                }

                const doorStatus = (val: number) => val ? 'Open' : 'Closed';
                const windowStatus = (val: number) => val ? 'Open' : 'Closed';

                const lines = [
                    `${name} Vehicle Status:`,
                    `• Locked: ${vs.locked ? 'Yes' : 'No'}`,
                    `• Doors: FL=${doorStatus(vs.df)}, FR=${doorStatus(vs.dr)}, RL=${doorStatus(vs.pf)}, RR=${doorStatus(vs.pr)}`,
                    `• Windows: FL=${windowStatus(vs.fd_window)}, FR=${windowStatus(vs.fp_window)}, RL=${windowStatus(vs.rd_window)}, RR=${windowStatus(vs.rp_window)}`,
                    `• Front Trunk: ${doorStatus(vs.ft)}`,
                    `• Rear Trunk: ${doorStatus(vs.rt)}`,
                    `• Sentry Mode: ${vs.sentry_mode ? 'ON' : 'OFF'}`,
                    `• Valet Mode: ${vs.valet_mode ? 'ON' : 'OFF'}`,
                    `• Odometer: ${Math.round(vs.odometer)} mi`,
                    `• Software: ${vs.car_version ?? '—'}`,
                    ...(vs.software_update?.status && vs.software_update.status !== '' ? [
                        `• Update Available: ${vs.software_update.version} (${vs.software_update.status})`,
                    ] : []),
                    `• Car Type: ${vc?.car_type ?? '—'}`,
                    `• User Present: ${vs.is_user_present ? 'Yes' : 'No'}`,
                ];
                return { content: [{ type: "text", text: lines.join('\n') }] };
            }

            // ========== Tier 2: Command Tools ==========

            case "lock_unlock": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const action = String(request.params.arguments?.action);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);

                const command = action === 'unlock' ? 'door_unlock' : 'door_lock';
                await teslaService.sendCommand(vid, command);
                const name = veh.display_name || "Tesla";
                return { content: [{ type: "text", text: `${name} is now ${action === 'unlock' ? 'unlocked' : 'locked'}.` }] };
            }

            case "climate_control": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const action = String(request.params.arguments?.action);
                const driverTemp = request.params.arguments?.driver_temp as number | undefined;
                const passengerTemp = request.params.arguments?.passenger_temp as number | undefined;
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                if (driverTemp != null || passengerTemp != null) {
                    const dt = driverTemp ?? passengerTemp ?? 21;
                    const pt = passengerTemp ?? driverTemp ?? 21;
                    await teslaService.sendCommand(vid, 'set_temps', { driver_temp: dt, passenger_temp: pt });
                }

                const command = action === 'start' ? 'auto_conditioning_start' : 'auto_conditioning_stop';
                await teslaService.sendCommand(vid, command);
                return { content: [{ type: "text", text: `${name} climate ${action === 'start' ? 'started' : 'stopped'}.` + (driverTemp != null ? ` Temperature set to ${driverTemp}°C.` : '') }] };
            }

            case "charge_control": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const action = String(request.params.arguments?.action);
                const limit = request.params.arguments?.limit as number | undefined;
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                if (action === 'set_limit') {
                    if (limit == null || limit < 50 || limit > 100) {
                        throw new Error("Charge limit must be between 50 and 100");
                    }
                    await teslaService.sendCommand(vid, 'set_charge_limit', { percent: limit });
                    return { content: [{ type: "text", text: `${name} charge limit set to ${limit}%.` }] };
                }

                const command = action === 'start' ? 'charge_start' : 'charge_stop';
                await teslaService.sendCommand(vid, command);
                return { content: [{ type: "text", text: `${name} charging ${action === 'start' ? 'started' : 'stopped'}.` }] };
            }

            case "open_trunk": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const which = String(request.params.arguments?.which);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                await teslaService.sendCommand(vid, 'actuate_trunk', { which_trunk: which });
                return { content: [{ type: "text", text: `${name} ${which === 'front' ? 'frunk' : 'rear trunk'} opened.` }] };
            }

            case "honk_flash": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const action = String(request.params.arguments?.action);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                const command = action === 'honk' ? 'honk_horn' : 'flash_lights';
                await teslaService.sendCommand(vid, command);
                return { content: [{ type: "text", text: `${name} ${action === 'honk' ? 'horn honked' : 'lights flashed'}.` }] };
            }

            // ========== Tier 3: Nice-to-Have Tools ==========

            case "send_navigation": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const address = String(request.params.arguments?.address);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                if (!address) throw new Error("address is required");
                await teslaService.sendCommand(vid, 'navigation_request', {
                    type: 'share_ext_content_raw',
                    locale: 'en-US',
                    timestamp_ms: Date.now().toString(),
                    value: { 'android.intent.extra.TEXT': address }
                });
                return { content: [{ type: "text", text: `Navigation to "${address}" sent to ${name}.` }] };
            }

            case "nearby_charging": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                const result = await teslaService.getNearbyCharging(vid);
                const superchargers = result?.superchargers ?? [];
                const destination = result?.destination_charging ?? [];

                const scLines = superchargers.slice(0, 5).map((sc: any, i: number) =>
                    `  ${i + 1}. ${sc.name} — ${sc.distance_mi?.toFixed(1) ?? '?'} mi, ${sc.available_stalls}/${sc.total_stalls} stalls`
                );
                const dcLines = destination.slice(0, 5).map((dc: any, i: number) =>
                    `  ${i + 1}. ${dc.name} — ${dc.distance_mi?.toFixed(1) ?? '?'} mi`
                );

                const lines = [
                    `Nearby Charging for ${name}:`,
                    '',
                    `Superchargers (${superchargers.length} found):`,
                    ...(scLines.length > 0 ? scLines : ['  None nearby']),
                    '',
                    `Destination Chargers (${destination.length} found):`,
                    ...(dcLines.length > 0 ? dcLines : ['  None nearby']),
                ];
                return { content: [{ type: "text", text: lines.join('\n') }] };
            }

            case "sentry_mode": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const enabled = Boolean(request.params.arguments?.enabled);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                await teslaService.sendCommand(vid, 'set_sentry_mode', { on: enabled });
                return { content: [{ type: "text", text: `${name} sentry mode ${enabled ? 'enabled' : 'disabled'}.` }] };
            }

            case "window_control": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const action = String(request.params.arguments?.action);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                // Window control requires lat/lon for security
                const vData = await teslaService.getVehicleData(vid, true);
                const lat = vData.latitude ?? vData.native_latitude ?? 0;
                const lon = vData.longitude ?? vData.native_longitude ?? 0;

                await teslaService.sendCommand(vid, 'window_control', {
                    command: action,
                    lat,
                    lon,
                });
                return { content: [{ type: "text", text: `${name} windows ${action === 'vent' ? 'vented' : 'closed'}.` }] };
            }

            case "media_control": {
                if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
                    return { content: [{ type: "text", text: `Set up credentials first: ${BASE_URL}/setup?session=${sessionId}` }] };
                }
                if (!teslaService.isAuthenticated()) {
                    return { content: [{ type: "text", text: `Connect your Tesla account first:\n\n**Open this link:** ${getAuthUrl()}\n\nLog in with your Tesla email and password, then try again.` }] };
                }

                const vid = String(request.params.arguments?.vehicle_id);
                const action = String(request.params.arguments?.action);
                const allVehicles = await getVehiclesForSession(sessionId);
                const veh = allVehicles.find(v => String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid);
                if (!veh) throw new Error(`Vehicle ${vid} not found`);
                const name = veh.display_name || "Tesla";

                const mediaCommands: Record<string, string> = {
                    'toggle_playback': 'media_toggle_playback',
                    'next_track': 'media_next_track',
                    'prev_track': 'media_prev_track',
                    'volume_up': 'adjust_volume',
                    'volume_down': 'adjust_volume',
                };
                const command = mediaCommands[action];
                if (!command) throw new Error(`Unknown media action: ${action}`);

                if (action === 'volume_up') {
                    await teslaService.sendCommand(vid, command, { volume: 1 });
                } else if (action === 'volume_down') {
                    await teslaService.sendCommand(vid, command, { volume: -1 });
                } else {
                    await teslaService.sendCommand(vid, command);
                }

                const actionLabels: Record<string, string> = {
                    'toggle_playback': 'playback toggled',
                    'next_track': 'skipped to next track',
                    'prev_track': 'went to previous track',
                    'volume_up': 'volume increased',
                    'volume_down': 'volume decreased',
                };
                return { content: [{ type: "text", text: `${name}: ${actionLabels[action] ?? action}.` }] };
            }

            case "get_recent_texts": {
                if (!HAS_TWILIO) {
                    throw new Error("SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.");
                }
                const limit = Math.min(Number(request.params.arguments?.limit) || 10, 50);
                const recent = smsInbox.slice(0, limit);
                if (recent.length === 0) {
                    return {
                        content: [{ type: "text", text: "No texts received yet. Inbound SMS will appear here once Twilio forwards them to the webhook." }]
                    };
                }
                const lines = recent.map((m, i) =>
                    `${i + 1}. From ${m.from} at ${new Date(m.receivedAt).toISOString()}:\n   ${m.body}`
                );
                return {
                    content: [{ type: "text", text: `Recent texts (${recent.length}):\n\n${lines.join("\n\n")}` }]
                };
            }

            case "send_text": {
                if (!HAS_TWILIO) {
                    throw new Error("SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.");
                }
                const to = String(request.params.arguments?.to ?? "").trim();
                const body = String(request.params.arguments?.body ?? "").trim();
                if (!to || !body) {
                    throw new Error("send_text requires 'to' and 'body' (phone in E.164 format and message text).");
                }
                try {
                    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
                    const resp = await axios.post(
                        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
                        new URLSearchParams({
                            To: to,
                            From: TWILIO_PHONE_NUMBER!,
                            Body: body,
                        }).toString(),
                        {
                            headers: {
                                "Content-Type": "application/x-www-form-urlencoded",
                                Authorization: `Basic ${auth}`,
                            },
                        }
                    );
                    const sid = resp.data?.sid;
                    return {
                        content: [{ type: "text", text: `Message sent to ${to}${sid ? ` (SID: ${sid})` : ""}.` }]
                    };
                } catch (err: unknown) {
                    const msg = axios.isAxiosError(err) && err.response?.data?.message
                        ? err.response.data.message
                        : err instanceof Error ? err.message : String(err);
                    throw new Error(`Failed to send SMS: ${msg}`);
                }
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

        // Auto-inject server credentials for prompt handler too
        if (HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
            sessionManager.updateSession(sessionId, {
                clientId: SERVER_CLIENT_ID,
                clientSecret: SERVER_CLIENT_SECRET,
            });
        }

        const loginUrl = `${BASE_URL}/auth/login?session=${sessionId}`;
        const setupUrl = `${BASE_URL}/setup?session=${sessionId}`;
        if (!HAS_SERVER_CREDENTIALS && !teslaService.hasCredentials()) {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Set up your Tesla Developer credentials first: ${setupUrl}`
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
                            text: `Log in with your Tesla account:\n\nOpen this link: ${loginUrl}`
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
// MCP OAuth 2.1 Authorization Server Endpoints
// ============================================

/** Validate a bearer token from the Authorization header, return userSessionId or null */
function authenticateMcpBearer(req: Request): string | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    const stored = mcpBearerTokens.get(token);
    if (!stored || stored.expiresAt < Date.now()) {
        if (stored) mcpBearerTokens.delete(token);
        return null;
    }
    return stored.userSessionId;
}

// Tesla Fleet API public key endpoint (required for partner registration)
app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (_req: Request, res: Response) => {
    // Try reading from keys/ directory first, then fall back to TESLA_PUBLIC_KEY env var
    const keyPath = path.join(__dirname, '../keys/public-key.pem');
    if (fs.existsSync(keyPath)) {
        res.setHeader('Content-Type', 'application/x-pem-file');
        res.sendFile(keyPath);
    } else if (process.env.TESLA_PUBLIC_KEY) {
        res.setHeader('Content-Type', 'application/x-pem-file');
        res.send(process.env.TESLA_PUBLIC_KEY);
    } else {
        res.status(404).send('Public key not found');
    }
});

// Protected Resource Metadata (RFC 9728) — tells the client where to find the authorization server
app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
        resource: BASE_URL,
        authorization_servers: [BASE_URL],
        scopes_supported: ['tesla'],
    });
});

// OAuth Authorization Server Metadata (RFC 8414)
app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/oauth/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`,
        registration_endpoint: `${BASE_URL}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['tesla'],
    });
});

// Dynamic Client Registration (RFC 7591) — MCP clients register to get a client_id
app.post('/oauth/register', (req: Request, res: Response) => {
    const { redirect_uris, client_name, grant_types, response_types, token_endpoint_auth_method } = req.body ?? {};
    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }
    const client_id = crypto.randomBytes(16).toString('hex');
    const client_secret = crypto.randomBytes(32).toString('hex');
    oauthClients.set(client_id, { client_id, client_secret, redirect_uris });
    res.status(201).json({
        client_id,
        client_secret,
        redirect_uris,
        client_name: client_name || 'MCP Client',
        grant_types: grant_types || ['authorization_code', 'refresh_token'],
        response_types: response_types || ['code'],
        token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post',
    });
});

// OAuth Authorization Endpoint — MCP client sends user here (popup opens this URL)
// We redirect straight to Tesla OAuth, then Tesla callback redirects back to MCP client
app.get('/oauth/authorize', (req: Request, res: Response) => {
    const client_id = req.query.client_id as string;
    const redirect_uri = req.query.redirect_uri as string;
    const state = req.query.state as string;
    const code_challenge = req.query.code_challenge as string;
    const code_challenge_method = (req.query.code_challenge_method as string) || 'S256';
    const response_type = req.query.response_type as string;

    if (response_type !== 'code') {
        return res.status(400).json({ error: 'unsupported_response_type' });
    }

    const client = oauthClients.get(client_id);
    if (!client) {
        return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id. Register first via /oauth/register.' });
    }

    if (!client.redirect_uris.includes(redirect_uri)) {
        return res.status(400).json({ error: 'invalid_redirect_uri' });
    }

    // Create a user session for Tesla auth
    const userSession = sessionManager.createSession();

    // Inject server Tesla credentials so user goes straight to Tesla login
    if (HAS_SERVER_CREDENTIALS) {
        sessionManager.updateSession(userSession.sessionId, {
            clientId: SERVER_CLIENT_ID,
            clientSecret: SERVER_CLIENT_SECRET,
        });
    }

    // Store MCP client's OAuth params so /auth/callback knows where to redirect
    sessionManager.updateSession(userSession.sessionId, {
        oauthClientId: client_id,
        oauthRedirectUri: redirect_uri,
        oauthClientState: state,
        oauthCodeChallenge: code_challenge,
        oauthCodeChallengeMethod: code_challenge_method,
    });

    // Redirect to Tesla auth (auto-redirects to Tesla login page)
    res.redirect(`${BASE_URL}/auth/login?session=${userSession.sessionId}`);
});

// OAuth Token Endpoint — MCP client exchanges auth code or refresh token for access token
app.post('/oauth/token', (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier, refresh_token } = req.body ?? {};

    if (grant_type === 'authorization_code') {
        const authCode = oauthAuthCodes.get(code);
        if (!authCode || authCode.expiresAt < Date.now()) {
            oauthAuthCodes.delete(code);
            return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
        }

        if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id or redirect_uri mismatch' });
        }

        // Verify PKCE
        if (authCode.codeChallenge) {
            const expectedChallenge = crypto.createHash('sha256').update(code_verifier || '').digest('base64url');
            if (expectedChallenge !== authCode.codeChallenge) {
                return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
            }
        }

        // Issue MCP access token + refresh token
        const accessToken = crypto.randomBytes(32).toString('hex');
        const mcpRefresh = crypto.randomBytes(32).toString('hex');
        const expiresIn = 3600; // 1 hour

        mcpBearerTokens.set(accessToken, {
            userSessionId: authCode.userSessionId,
            expiresAt: Date.now() + (expiresIn * 1000),
        });

        mcpRefreshTokens.set(mcpRefresh, {
            userSessionId: authCode.userSessionId,
            clientId: authCode.clientId,
        });

        oauthAuthCodes.delete(code);

        return res.json({
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: expiresIn,
            refresh_token: mcpRefresh,
        });
    }

    if (grant_type === 'refresh_token') {
        const stored = mcpRefreshTokens.get(refresh_token);
        if (!stored) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
        }

        const accessToken = crypto.randomBytes(32).toString('hex');
        const expiresIn = 3600;

        mcpBearerTokens.set(accessToken, {
            userSessionId: stored.userSessionId,
            expiresAt: Date.now() + (expiresIn * 1000),
        });

        return res.json({
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: expiresIn,
        });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
});

// ============================================
// Streamable HTTP MCP Endpoint (/mcp)
// ============================================

app.post('/mcp', async (req: Request, res: Response) => {
    // Require bearer token
    const userSessionId = authenticateMcpBearer(req);
    if (!userSessionId) {
        res.status(401).set({
            'WWW-Authenticate': `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
        }).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null });
        return;
    }

    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (mcpSessionId && mcpHttpTransports.has(mcpSessionId)) {
        // Existing session — forward to its transport
        const { transport } = mcpHttpTransports.get(mcpSessionId)!;
        await transport.handleRequest(req, res, req.body);
    } else if (!mcpSessionId) {
        // New session initialization
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
                mcpHttpTransports.set(sid, { transport, server, userSessionId });
            },
        });

        transport.onclose = () => {
            if (transport.sessionId) {
                mcpHttpTransports.delete(transport.sessionId);
            }
        };

        const server = createMCPServer(userSessionId);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid session. Reconnect without mcp-session-id.' }, id: null });
    }
});

app.get('/mcp', async (req: Request, res: Response) => {
    const userSessionId = authenticateMcpBearer(req);
    if (!userSessionId) {
        res.status(401).set({
            'WWW-Authenticate': `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
        }).send('Unauthorized');
        return;
    }

    const mcpSessionId = req.headers['mcp-session-id'] as string;
    if (!mcpSessionId || !mcpHttpTransports.has(mcpSessionId)) {
        res.status(400).json({ error: 'Invalid or missing mcp-session-id' });
        return;
    }

    const { transport } = mcpHttpTransports.get(mcpSessionId)!;
    await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req: Request, res: Response) => {
    const mcpSessionId = req.headers['mcp-session-id'] as string;
    if (mcpSessionId && mcpHttpTransports.has(mcpSessionId)) {
        const { transport, server } = mcpHttpTransports.get(mcpSessionId)!;
        await transport.close();
        await server.close();
        mcpHttpTransports.delete(mcpSessionId);
    }
    res.status(200).end();
});

// ============================================
// Twilio SMS webhook (inbound texts)
// ============================================
if (HAS_TWILIO) {
    app.post('/webhooks/twilio/sms', (req: Request, res: Response) => {
        const from = req.body?.From ?? '';
        const to = req.body?.To ?? '';
        const body = req.body?.Body ?? '';
        if (from && body) {
            smsInbox.unshift({
                from,
                to,
                body: String(body).trim(),
                receivedAt: Date.now(),
            });
            if (smsInbox.length > SMS_INBOX_MAX) smsInbox.pop();
        }
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });
}

// ============================================
// SSE/MCP Endpoints
// ============================================

// SSE endpoint - client connects here to receive messages
// The MCP SDK sends its own sessionId to the client in the "endpoint" event,
// so we must store the transport under that ID for POST /messages to find it.
// Use ?token=XXX or ?session=XXX to reuse an existing session (avoids re-auth on reconnect).
app.get('/sse', async (req: Request, res: Response) => {
    const token = req.query.token as string;
    const sessionParam = req.query.session as string;

    let userSessionId: string;

    if (token) {
        const existing = sessionManager.getSessionByToken(token);
        if (existing) {
            userSessionId = existing.sessionId;
        } else {
            const session = sessionManager.createSession();
            userSessionId = session.sessionId;
        }
    } else if (sessionParam && sessionManager.getSession(sessionParam)) {
        userSessionId = sessionParam;
    } else {
        const session = sessionManager.createSession();
        userSessionId = session.sessionId;
    }

    // Create SSE transport first - it generates the sessionId the client will use for POSTs
    const transport = new SSEServerTransport('/messages', res);
    const transportSessionId = transport.sessionId;

        // Do not log session IDs (security)

    // Create MCP server with user's session (Tesla credentials live there)
    const server = createMCPServer(userSessionId);
    
    // Store under transport's sessionId so client POSTs to /messages?sessionId=X find us
    activeTransports.set(transportSessionId, { transport, server });

    // Clean up on disconnect
    res.on('close', () => {
        // SSE connection closed
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
    
    if (!sessionId || !sessionManager.getSession(sessionId)) {
        const session = sessionManager.createSession();
        sessionId = session.sessionId;
    }

    // If server has Tesla app credentials, go straight to login page
    if (HAS_SERVER_CREDENTIALS) {
        return res.redirect(`${BASE_URL}/auth/login?session=${sessionId}`);
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
        
        <p style="font-size: 13px; margin-bottom: 16px; color: rgba(255,255,255,0.8);">In your Tesla Developer App, set the Redirect URI to <strong>exactly</strong>:</p>
        <div class="session-id" style="margin-bottom: 20px;">${BASE_URL}/auth/callback</div>
        <ol class="steps">
            <li>Go to <a href="https://developer.tesla.com" target="_blank">developer.tesla.com</a></li>
            <li>Create or open your application</li>
            <li>Set Redirect URI to the URL above (copy it exactly)</li>
            <li>Enter your Client ID and Client Secret below</li>
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

    // Show confirmation so users know credentials were saved
    const loginUrl = `${BASE_URL}/auth/login?session=${session}`;
    const redirectUri = `${BASE_URL}/auth/callback`;
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Credentials saved</title>
    <style>${commonStyles}</style>
</head>
<body>
    <div class="container">
        ${successSvg}
        <h1 style="color: #4CAF50;">Credentials saved successfully</h1>
        <p>Your <strong>Client ID</strong> and <strong>Client Secret</strong> were saved for this session. You can now log in with your Tesla account.</p>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7);">If setup keeps asking again, verify:</p>
        <ul style="text-align: left; margin: 12px 0; color: rgba(255,255,255,0.8); font-size: 13px;">
            <li>Client ID and Secret are correct (from developer.tesla.com)</li>
            <li>Redirect URI in your Tesla app is exactly: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px;">${redirectUri}</code></li>
        </ul>
        <a href="${loginUrl}" class="btn">Continue to Tesla login</a>
    </div>
</body>
</html>
    `);
});

// ============================================
// Authentication Endpoints
// ============================================

// Login page - redirects to Tesla OAuth
app.get('/auth/login', (req: Request, res: Response) => {
    let sessionId = req.query.session as string;
    
    if (!sessionId || !sessionManager.getSession(sessionId)) {
        const session = sessionManager.createSession();
        sessionId = session.sessionId;
        if (!HAS_SERVER_CREDENTIALS) {
            return res.redirect(`${BASE_URL}/setup?session=${sessionId}`);
        }
    }

    let session = sessionManager.getSession(sessionId);
    
    // Use server credentials if session doesn't have any
    if ((!session?.clientId || !session?.clientSecret) && HAS_SERVER_CREDENTIALS) {
        sessionManager.updateSession(sessionId, {
            clientId: SERVER_CLIENT_ID,
            clientSecret: SERVER_CLIENT_SECRET,
        });
        session = sessionManager.getSession(sessionId);
    } else if (!session?.clientId || !session?.clientSecret) {
        return res.redirect(`${BASE_URL}/setup?session=${sessionId}`);
    }

    const clientId = session?.clientId;
    const clientSecret = session?.clientSecret;
    if (!clientId || !clientSecret) {
        return res.redirect(`${BASE_URL}/setup?session=${sessionId}`);
    }

    // Generate OAuth state and PKCE
    const state = sessionManager.generateOAuthState(sessionId);
    const { challenge } = sessionManager.generatePKCE(sessionId);
    
    const redirectUri = `${BASE_URL}/auth/callback`;
    
    // Build Tesla OAuth URL
    const authUrl = new URL(`${AUTH_URL}/authorize`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', `${sessionId}:${state}`);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Redirect straight to Tesla OAuth — no intermediate page
    res.redirect(authUrl.toString());
});

// OAuth callback - receives authorization code from Tesla
app.get('/auth/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const stateParam = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
        // If this was an MCP OAuth flow, redirect error back to the MCP client
        if (stateParam) {
            const [errSessionId] = stateParam.split(':');
            const errSession = errSessionId ? sessionManager.getSession(errSessionId) : undefined;
            if (errSession?.oauthRedirectUri) {
                const redirectUrl = new URL(errSession.oauthRedirectUri);
                redirectUrl.searchParams.set('error', error);
                if (errSession.oauthClientState) {
                    redirectUrl.searchParams.set('state', errSession.oauthClientState);
                }
                return res.redirect(redirectUrl.toString());
            }
        }
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

        // If this was an MCP OAuth flow, generate auth code and redirect to MCP client
        const oauthSession = sessionManager.getSession(sessionId);
        if (oauthSession?.oauthRedirectUri) {
            const mcpAuthCode = crypto.randomBytes(32).toString('hex');
            oauthAuthCodes.set(mcpAuthCode, {
                userSessionId: sessionId,
                clientId: oauthSession.oauthClientId!,
                redirectUri: oauthSession.oauthRedirectUri,
                codeChallenge: oauthSession.oauthCodeChallenge || '',
                codeChallengeMethod: oauthSession.oauthCodeChallengeMethod || 'S256',
                expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
            });

            const redirectUrl = new URL(oauthSession.oauthRedirectUri);
            redirectUrl.searchParams.set('code', mcpAuthCode);
            if (oauthSession.oauthClientState) {
                redirectUrl.searchParams.set('state', oauthSession.oauthClientState);
            }
            return res.redirect(redirectUrl.toString());
        }

        // Regular SSE flow — show success page
        const connectionToken = sessionManager.createConnectionToken(sessionId);
        const connectionUrl = `${BASE_URL}/sse?token=${connectionToken}`;

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
        <p>You're all set. Close this window and return to your AI assistant.</p>
        <p><strong>Important:</strong> To stay logged in when your client reconnects, use this URL as your MCP server URL (keep it private):</p>
        <div class="session-id">${connectionUrl}</div>
        <p style="font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 16px;">Treat this URL like a password. If you don't add it to your client, you may be asked to set up again after reconnects.</p>
        <p style="font-size: 12px; margin-top: 20px;">You can close this window when you're done.</p>
    </div>
</body>
</html>
        `);

    } catch (error: any) {
        // If this was an MCP OAuth flow, redirect error back to the MCP client
        const failedSession = sessionManager.getSession(sessionId);
        if (failedSession?.oauthRedirectUri) {
            const redirectUrl = new URL(failedSession.oauthRedirectUri);
            redirectUrl.searchParams.set('error', 'server_error');
            redirectUrl.searchParams.set('error_description', 'Failed to exchange Tesla authorization code');
            if (failedSession.oauthClientState) {
                redirectUrl.searchParams.set('state', failedSession.oauthClientState);
            }
            return res.redirect(redirectUrl.toString());
        }

        // Do not log token/API response details (security)
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
            <li>After auth, use the <strong>connection URL</strong> from the success page as your MCP server URL so you stay logged in. Keep it private.</li>
        </ol>
        
        <h2 style="margin-top: 30px;">Endpoints</h2>
        
        <div class="endpoint">
            <code>GET /sse</code> or <code>GET /sse?token=XXX</code>
            <p>SSE endpoint for MCP client. Use the connection URL (with ?token=) from the success page after auth so reconnects keep you logged in.</p>
        </div>
        
        <div class="endpoint">
            <code>GET /setup</code>
            <p>Set up your Tesla Developer credentials</p>
        </div>
        
        <div class="endpoint">
            <code>GET /auth/login</code>
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
    console.log(`  - MCP:   http://${HOST}:${PORT}/mcp  (Streamable HTTP + OAuth)`);
    console.log(`  - SSE:   http://${HOST}:${PORT}/sse   (legacy SSE transport)`);
    console.log(`  - Setup: http://${HOST}:${PORT}/setup`);
    if (HAS_SERVER_CREDENTIALS) {
        console.log(`\n✓ Server Tesla credentials detected (TESLA_CLIENT_ID, TESLA_CLIENT_SECRET).`);
        console.log(`  Users will be prompted to log in with their Tesla account (no setup needed).`);
    } else {
        console.log(`\n⚠ No server Tesla credentials found.`);
        console.log(`  Set TESLA_CLIENT_ID and TESLA_CLIENT_SECRET environment variables`);
        console.log(`  so users can log in directly without creating their own Developer App.`);
    }
    console.log(`Set BASE_URL environment variable for production deployment.`);
});
