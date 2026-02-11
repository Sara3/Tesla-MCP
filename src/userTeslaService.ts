/**
 * Per-User Tesla Fleet API service
 * A service for connecting to and interacting with the Tesla Fleet API
 * that uses user-specific tokens from the session manager
 */

import axios from 'axios';
import { sessionManager, UserSession } from './sessionManager.js';

// API constants - choose the appropriate endpoint based on your region
const BASE_URLS = {
    'NA': 'https://fleet-api.prd.na.vn.cloud.tesla.com', // North America, Asia-Pacific (excluding China)
    'EU': 'https://fleet-api.prd.eu.vn.cloud.tesla.com', // Europe, Middle East, Africa
    'CN': 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'   // China
};
const BASE_URL = BASE_URLS.NA; // Default to North America
const AUTH_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

// Types
export interface Vehicle {
    id: string;
    vin: string;
    display_name: string;
    state: string;
    vehicle_id: number;
    [key: string]: any;
}

// Tesla API Service class for a specific user session
export class UserTeslaService {
    private sessionId: string;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    /**
     * Get credentials from session
     */
    private getCredentials(): { clientId: string; clientSecret: string } {
        const session = sessionManager.getSession(this.sessionId);
        if (!session?.clientId || !session?.clientSecret) {
            throw new Error('Tesla app credentials not configured. Please set up your credentials first.');
        }
        return { clientId: session.clientId, clientSecret: session.clientSecret };
    }

    /**
     * Refresh the access token using the refresh token
     */
    private async refreshAccessToken(): Promise<void> {
        const session = sessionManager.getSession(this.sessionId);
        if (!session?.refreshToken) {
            throw new Error('No refresh token available. Please authenticate first.');
        }

        const { clientId, clientSecret } = this.getCredentials();

        try {
            const params = new URLSearchParams();
            params.append('grant_type', 'refresh_token');
            params.append('client_id', clientId);
            params.append('client_secret', clientSecret);
            params.append('refresh_token', session.refreshToken);
            params.append('scope', 'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds');

            const response = await axios.post(AUTH_URL, params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            sessionManager.updateSession(this.sessionId, {
                accessToken: response.data.access_token,
                tokenExpiration: Date.now() + (response.data.expires_in * 1000),
                // Update refresh token if a new one was provided
                ...(response.data.refresh_token && { refreshToken: response.data.refresh_token })
            });
        } catch (error: any) {
            const msg = error.response?.data?.error_description ?? error.response?.data?.error ?? error.message;
            throw new Error(`Failed to refresh token: ${String(msg)}`);
        }
    }

    /**
     * Get access token, refreshing if necessary
     */
    private async getAccessToken(): Promise<string> {
        const session = sessionManager.getSession(this.sessionId);
        
        if (!session) {
            throw new Error('Session not found');
        }

        // If token is not set or is expired, refresh it
        if (!session.accessToken || (session.tokenExpiration && Date.now() >= session.tokenExpiration)) {
            await this.refreshAccessToken();
        }

        const updatedSession = sessionManager.getSession(this.sessionId);
        if (!updatedSession?.accessToken) {
            throw new Error('Could not obtain access token');
        }

        return updatedSession.accessToken;
    }

    /**
     * Check if user has configured credentials
     */
    hasCredentials(): boolean {
        const session = sessionManager.getSession(this.sessionId);
        return !!(session?.clientId && session?.clientSecret);
    }

    /**
     * Check if user is authenticated
     */
    isAuthenticated(): boolean {
        const session = sessionManager.getSession(this.sessionId);
        return !!(session?.refreshToken && session?.clientId && session?.clientSecret);
    }

    /**
     * Get list of vehicles
     */
    async getVehicles(): Promise<Vehicle[]> {
        const token = await this.getAccessToken();

        try {
            const response = await axios.get(`${BASE_URL}/api/1/vehicles`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });

            return response.data.response || [];
        } catch (error: any) {
            throw new Error('Failed to fetch vehicles');
        }
    }

    /**
     * Wake up a vehicle
     */
    async wakeUp(vehicleId: string): Promise<Vehicle> {
        const token = await this.getAccessToken();

        try {
            const response = await axios.post(`${BASE_URL}/api/1/vehicles/${vehicleId}/wake_up`, {}, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });

            return response.data.response;
        } catch (error: any) {
            throw new Error(`Failed to wake up vehicle: ${error.message}`);
        }
    }

    /**
     * Get vehicle data (live call to vehicle - may wake it).
     * Returns the full vehicle data response including all requested endpoint data.
     */
    async getVehicleData(vehicleId: string, includeLocation: boolean = false): Promise<{
        latitude?: number;
        longitude?: number;
        heading?: number;
        gps_as_of?: number;
        speed?: number | null;
        shift_state?: string | null;
        native_latitude?: number;
        native_longitude?: number;
        native_location_supported?: boolean;
        charge_state?: any;
        climate_state?: any;
        vehicle_state?: any;
        vehicle_config?: any;
        gui_settings?: any;
        drive_state?: any;
        [key: string]: unknown;
    }> {
        const token = await this.getAccessToken();

        try {
            const baseEndpoints = 'charge_state;climate_state;vehicle_state;vehicle_config;gui_settings';
            const endpoints = includeLocation
                ? `drive_state;location_data;${baseEndpoints}`
                : `drive_state;${baseEndpoints}`;
            const response = await axios.get(`${BASE_URL}/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=${encodeURIComponent(endpoints)}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });

            const data = response.data?.response;
            if (!data) {
                throw new Error('No vehicle data in response');
            }

            // Fleet API may return location in drive_state, location_data, or both
            const driveState = data.drive_state;
            const locationData = data.location_data;

            const result: {
                latitude?: number;
                longitude?: number;
                heading?: number;
                gps_as_of?: number;
                speed?: number | null;
                shift_state?: string | null;
                native_latitude?: number;
                native_longitude?: number;
                native_location_supported?: boolean;
                _debug_fields_present?: string[];
                [key: string]: unknown;
            } = { ...data };

            // Track which data sections the API returned (for debugging)
            result._debug_fields_present = Object.keys(data).filter(k =>
                data[k] != null && typeof data[k] === 'object'
            );

            if (driveState) {
                result.latitude = driveState.latitude;
                result.longitude = driveState.longitude;
                result.heading = driveState.heading;
                result.gps_as_of = driveState.gps_as_of;
                result.speed = driveState.speed;
                result.shift_state = driveState.shift_state;
                result.native_latitude = driveState.native_latitude;
                result.native_longitude = driveState.native_longitude;
                result.native_location_supported = driveState.native_location_supported;
            }
            // location_data is the newer method (firmware 2023.38+)
            if (locationData) {
                result.latitude = result.latitude ?? locationData.latitude;
                result.longitude = result.longitude ?? locationData.longitude;
                result.native_latitude = result.native_latitude ?? locationData.native_latitude;
                result.native_longitude = result.native_longitude ?? locationData.native_longitude;
            }

            return result;
        } catch (error: any) {
            throw new Error(`Failed to get vehicle data: ${error.message}`);
        }
    }

    /**
     * Send a command to a vehicle.
     * Generic method for POST /api/1/vehicles/{id}/command/{command}
     */
    async sendCommand(vehicleId: string, command: string, body: Record<string, any> = {}): Promise<any> {
        const token = await this.getAccessToken();

        try {
            const response = await axios.post(
                `${BASE_URL}/api/1/vehicles/${vehicleId}/command/${command}`,
                body,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            return response.data.response;
        } catch (error: any) {
            const msg = error.response?.data?.error ?? error.message;
            throw new Error(`Command '${command}' failed: ${msg}`);
        }
    }

    /**
     * Get nearby charging sites for a vehicle.
     */
    async getNearbyCharging(vehicleId: string): Promise<any> {
        const token = await this.getAccessToken();

        try {
            const response = await axios.get(
                `${BASE_URL}/api/1/vehicles/${vehicleId}/nearby_charging_sites`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            return response.data.response;
        } catch (error: any) {
            throw new Error(`Failed to get nearby charging sites: ${error.message}`);
        }
    }
}

// Factory function to create a UserTeslaService for a session
export function createUserTeslaService(sessionId: string): UserTeslaService {
    return new UserTeslaService(sessionId);
}
