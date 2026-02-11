#!/usr/bin/env node

/**
 * Tesla MCP Server
 * A Model Context Protocol server that connects to the Tesla Fleet API
 * and allows controlling Tesla vehicles through AI assistants.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import teslaService, { Vehicle } from "./teslaService.js";

/**
 * Cache for Tesla vehicles to avoid repeated API calls
 */
let vehiclesCache: Vehicle[] = [];
let lastVehicleFetch: number = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Check if vehicles cache needs refreshing and update if necessary
 */
async function getVehicles(forceRefresh = false): Promise<Vehicle[]> {
  const now = Date.now();

  if (forceRefresh || vehiclesCache.length === 0 || (now - lastVehicleFetch) > CACHE_TTL) {
    try {
      vehiclesCache = await teslaService.getVehicles();
      lastVehicleFetch = now;
    } catch (error) {
      console.error("Error fetching vehicles:", error);
      // Return empty array if error, but don't update last fetch time
      if (vehiclesCache.length === 0) {
        return [];
      }
    }
  }

  return vehiclesCache;
}

/**
 * Create an MCP server with capabilities for resources (to list/view vehicles),
 * tools (to control vehicles), and prompts.
 */
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

/**
 * Handler for listing available vehicles as resources.
 * Each vehicle is exposed as a resource with:
 * - A tesla:// URI scheme
 * - JSON MIME type
 * - Vehicle display name and VIN
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const vehicles = await getVehicles();

  return {
    resources: vehicles.map((vehicle) => ({
      uri: `tesla://${vehicle.id}`,
      mimeType: "application/json",
      name: vehicle.display_name || `Tesla (${vehicle.vin})`,
      description: `Tesla vehicle: ${vehicle.display_name || 'Unknown'} (VIN: ${vehicle.vin})`
    }))
  };
});

/**
 * Handler for reading the details of a specific vehicle.
 * Takes a tesla:// URI and returns the vehicle data as JSON.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);
  const vehicleId = url.hostname;
  const vehicles = await getVehicles();

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

/**
 * Handler that lists available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const vehicles = await getVehicles();

  if (vehicles.length === 0) {
    return {
      tools: []
    };
  }

  return {
    tools: [
      {
        name: "list_vehicles",
        description: "List your Tesla vehicles and get their IDs (id, vehicle_id, vin).",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      {
        name: "wake_up",
        description: "Wake up your Tesla vehicle from sleep mode.",
        inputSchema: {
          type: "object",
          properties: { vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" } },
          required: ["vehicle_id"]
        }
      },
      {
        name: "refresh_vehicles",
        description: "Refresh the list of Tesla vehicles from the API.",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      {
        name: "debug_vehicles",
        description: "Show debug information about available vehicles.",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      // --- Data tools ---
      {
        name: "get_vehicle_location",
        description: "Get your Tesla's current location (latitude, longitude, map link).",
        inputSchema: {
          type: "object",
          properties: { vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" } },
          required: ["vehicle_id"]
        }
      },
      {
        name: "get_battery_status",
        description: "Get your Tesla's battery level, range, charging state, charge limit, and time to full charge.",
        inputSchema: {
          type: "object",
          properties: { vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" } },
          required: ["vehicle_id"]
        }
      },
      {
        name: "get_climate_status",
        description: "Get your Tesla's climate info: inside/outside temperature, climate on/off, seat heaters, and temperature settings.",
        inputSchema: {
          type: "object",
          properties: { vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" } },
          required: ["vehicle_id"]
        }
      },
      {
        name: "get_vehicle_status",
        description: "Get your Tesla's status: locked/unlocked, doors, windows, trunk/frunk, sentry mode, odometer, software update info.",
        inputSchema: {
          type: "object",
          properties: { vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" } },
          required: ["vehicle_id"]
        }
      },
      {
        name: "nearby_charging",
        description: "Find nearby Superchargers and destination chargers for your Tesla.",
        inputSchema: {
          type: "object",
          properties: { vehicle_id: { type: "string", description: "Vehicle (id, vehicle_id, or vin)" } },
          required: ["vehicle_id"]
        }
      }
    ]
  };
});

/**
 * Handler for the vehicle control tools.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Helper to find a vehicle by id/vehicle_id/vin
  const findVehicle = async (vid: string) => {
    const vehicles = await getVehicles();
    const v = vehicles.find(v =>
      String(v.id) === vid || String(v.vehicle_id) === vid || String(v.vin) === vid
    );
    if (!v) throw new Error(`Vehicle ${vid} not found`);
    return v;
  };

  switch (request.params.name) {

    case "list_vehicles": {
      const vehicles = await getVehicles();
      if (vehicles.length === 0) {
        return { content: [{ type: "text", text: "No vehicles found. Try refresh_vehicles first." }] };
      }
      const lines = vehicles.map((v, i) =>
        `${i + 1}. **${v.display_name || "Tesla"}**\n   id: ${v.id}\n   vehicle_id: ${v.vehicle_id}\n   vin: ${v.vin}\n   state: ${v.state ?? "—"}`
      );
      return { content: [{ type: "text", text: `Your Tesla vehicles:\n\n${lines.join("\n\n")}` }] };
    }

    case "wake_up": {
      const vid = String(request.params.arguments?.vehicle_id);
      const vehicle = await findVehicle(vid);
      const result = await teslaService.wakeUp(vid);
      return {
        content: [{
          type: "text",
          text: result
            ? `Successfully woke up ${vehicle.display_name || 'your Tesla'} (state: ${result.state})`
            : `Failed to wake up ${vehicle.display_name || 'your Tesla'}`
        }]
      };
    }

    case "refresh_vehicles": {
      await getVehicles(true);
      return { content: [{ type: "text", text: `Successfully refreshed the vehicle list. Found ${vehiclesCache.length} vehicles.` }] };
    }

    case "debug_vehicles": {
      const vehicles = await getVehicles();
      if (vehicles.length === 0) {
        return { content: [{ type: "text", text: "No vehicles found. Make sure your Tesla account is properly connected." }] };
      }
      const debugInfo = vehicles.map(v =>
        `Vehicle: ${v.display_name || 'Tesla'}\n- id: ${v.id}\n- vehicle_id: ${v.vehicle_id}\n- vin: ${v.vin}\n- state: ${v.state}`
      ).join('\n\n');
      return { content: [{ type: "text", text: `Found ${vehicles.length} vehicles:\n\n${debugInfo}` }] };
    }

    case "get_vehicle_location": {
      const vid = String(request.params.arguments?.vehicle_id);
      const vehicle = await findVehicle(vid);
      // Use the matched vehicle's id and request location data
      const data = await teslaService.getVehicleData(String(vehicle.id), true);
      const lat = data.latitude ?? data.native_latitude;
      const lon = data.longitude ?? data.native_longitude;
      const name = vehicle.display_name || "Tesla";

      if (lat != null && lon != null) {
        const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
        return { content: [{ type: "text", text: `${name} location:\n• Latitude: ${lat}\n• Longitude: ${lon}\n• Map: ${mapsUrl}\n• Heading: ${data.heading ?? "—"}\n• Speed: ${data.speed ?? "—"}\n• Shift: ${data.shift_state ?? "—"}` }] };
      }
      if (data._location_scope_missing) {
        return { content: [{ type: "text", text: `Location not available for ${name}.\n\nYour token is missing the **vehicle_location** scope. To fix:\n1. Go to developer.tesla.com and open your app\n2. Add **vehicle_location** to the allowed scopes\n3. Re-authenticate (run: npm run get-token)\n4. Restart the MCP server` }] };
      }
      const debugFields = data._debug_fields_present ?? Object.keys(data).slice(0, 20);
      return { content: [{ type: "text", text: `Location not available for ${name}.\n\nPossible causes:\n• Vehicle may need wake_up first\n• "Allow Mobile Access" must be enabled in vehicle Settings > Safety\n\nAPI data sections: ${JSON.stringify(debugFields)}\ndrive_state: ${!!data.drive_state}, location_data: ${!!data.location_data}` }] };
    }

    case "get_battery_status": {
      const vid = String(request.params.arguments?.vehicle_id);
      const vehicle = await findVehicle(vid);
      const data = await teslaService.getVehicleData(vid);
      const cs = data.charge_state;
      const name = vehicle.display_name || "Tesla";

      if (!cs) return { content: [{ type: "text", text: `Battery data not available for ${name}. Try wake_up first.` }] };

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
      const vid = String(request.params.arguments?.vehicle_id);
      const vehicle = await findVehicle(vid);
      const data = await teslaService.getVehicleData(vid);
      const cl = data.climate_state;
      const gs = data.gui_settings;
      const name = vehicle.display_name || "Tesla";

      if (!cl) return { content: [{ type: "text", text: `Climate data not available for ${name}. Try wake_up first.` }] };

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
      const vid = String(request.params.arguments?.vehicle_id);
      const vehicle = await findVehicle(vid);
      const data = await teslaService.getVehicleData(vid);
      const vs = data.vehicle_state;
      const vc = data.vehicle_config;
      const name = vehicle.display_name || "Tesla";

      if (!vs) return { content: [{ type: "text", text: `Vehicle status not available for ${name}. Try wake_up first.` }] };

      const d = (val: number) => val ? 'Open' : 'Closed';
      const lines = [
        `${name} Vehicle Status:`,
        `• Locked: ${vs.locked ? 'Yes' : 'No'}`,
        `• Doors: FL=${d(vs.df)}, FR=${d(vs.dr)}, RL=${d(vs.pf)}, RR=${d(vs.pr)}`,
        `• Windows: FL=${d(vs.fd_window)}, FR=${d(vs.fp_window)}, RL=${d(vs.rd_window)}, RR=${d(vs.rp_window)}`,
        `• Front Trunk: ${d(vs.ft)}`,
        `• Rear Trunk: ${d(vs.rt)}`,
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

    case "nearby_charging": {
      const vid = String(request.params.arguments?.vehicle_id);
      const vehicle = await findVehicle(vid);
      const name = vehicle.display_name || "Tesla";
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
        `Nearby Charging for ${name}:`, '',
        `Superchargers (${superchargers.length} found):`,
        ...(scLines.length > 0 ? scLines : ['  None nearby']), '',
        `Destination Chargers (${destination.length} found):`,
        ...(dcLines.length > 0 ? dcLines : ['  None nearby']),
      ];
      return { content: [{ type: "text", text: lines.join('\n') }] };
    }

    default:
      throw new Error("Unknown tool");
  }
});

/**
 * Handler that lists available prompts.
 * Exposes a prompt to get information about all Tesla vehicles.
 */
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

/**
 * Handler for the summarize_vehicles prompt.
 * Returns a prompt that includes all vehicle information embedded as resources.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "summarize_vehicles") {
    throw new Error("Unknown prompt");
  }

  const vehicles = await getVehicles();

  if (vehicles.length === 0) {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "I don't have any Tesla vehicles connected. Please make sure you've set up your Tesla API credentials correctly in the .env file."
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

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  try {
    // Preload vehicles on startup to catch any auth errors early
    await getVehicles();
    // Don't log this to stdout as it interferes with MCP protocol
    // console.error("Successfully connected to Tesla API");
  } catch (error) {
    // Use stderr instead of stdout for error messages
    console.error("Warning: Failed to connect to Tesla API on startup. Please check your credentials.");
    // Don't include the full error as it might contain sensitive information
    // console.error(error);
    // Continue anyway, since credentials might be updated later
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // Log to stderr, not stdout
  console.error("Server error:", error);
  process.exit(1);
});
