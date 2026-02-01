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
const AUTH_URL = 'https://auth.tesla.com/oauth2/v3/token';

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
            const errorDetails = error.response?.data || error.message;
            throw new Error(`Failed to refresh token: ${JSON.stringify(errorDetails)}`);
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
            console.error('Error fetching vehicles:', error.response?.data || error.message);
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
            console.error('Error waking up vehicle:', error.response?.data || error.message);
            throw new Error(`Failed to wake up vehicle: ${error.message}`);
        }
    }
}

// Factory function to create a UserTeslaService for a session
export function createUserTeslaService(sessionId: string): UserTeslaService {
    return new UserTeslaService(sessionId);
}
