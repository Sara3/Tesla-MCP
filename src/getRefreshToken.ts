/**
 * Utility script to obtain a Tesla API refresh token
 * Following the official Tesla Fleet API OAuth flow
 * 
 * Two-step usage:
 *   Step 1 (open auth URL):  npm run get-token
 *   Step 2 (exchange code):  npm run get-token -- "https://tesla-mcp.onrender.com/auth/callback?code=...&state=..."
 */

import axios from 'axios';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import * as crypto from 'crypto';

// Get current file's directory in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

// Get environment variables
const clientId = process.env.TESLA_CLIENT_ID;
const clientSecret = process.env.TESLA_CLIENT_SECRET;

if (!clientId || !clientSecret) {
    console.error('Error: TESLA_CLIENT_ID and TESLA_CLIENT_SECRET must be set in .env file');
    process.exit(1);
}

// Constants
const AUTH_URL = 'https://auth.tesla.com/oauth2/v3';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const AUDIENCE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const REDIRECT_URI = 'https://tesla-mcp.onrender.com/auth/callback';
const SCOPES = 'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds';

// Check if a callback URL was passed as argument (Step 2)
const callbackArg = process.argv[2];

async function exchangeCode(callbackUrl: string) {
    // Parse the callback URL to extract the code
    let code: string | null = null;
    try {
        const parsed = new URL(callbackUrl);
        code = parsed.searchParams.get('code');
    } catch {
        // Maybe they passed just the code itself
        code = callbackUrl;
    }

    if (!code) {
        console.error('Could not extract authorization code from the URL.');
        process.exit(1);
    }

    console.log('Exchanging authorization code for tokens...');

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', clientId!);
    params.append('client_secret', clientSecret!);
    params.append('code', code);
    params.append('audience', AUDIENCE);
    params.append('redirect_uri', REDIRECT_URI);

    try {
        const tokenResponse = await axios.post(TOKEN_URL, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        console.log('\nAuthentication successful!\n');
        console.log('Access token obtained.');
        console.log('Token expires in:', expires_in, 'seconds');

        // Update the .env file with the refresh token
        try {
            const envPath = path.resolve(process.cwd(), '.env');
            let envContent = fs.readFileSync(envPath, 'utf8');

            if (envContent.includes('TESLA_REFRESH_TOKEN=')) {
                envContent = envContent.replace(
                    /TESLA_REFRESH_TOKEN=.*/,
                    `TESLA_REFRESH_TOKEN=${refresh_token}`
                );
            } else {
                envContent += `\nTESLA_REFRESH_TOKEN=${refresh_token}\n`;
            }

            fs.writeFileSync(envPath, envContent);
            console.log('The refresh token has been saved to your .env file.');
        } catch (err) {
            console.error('Failed to update .env file automatically.');
            console.log('\nAdd this to your .env file:');
            console.log(`TESLA_REFRESH_TOKEN=${refresh_token}`);
        }
    } catch (error: any) {
        console.error('\nError exchanging authorization code for tokens:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(error.message);
        }
    }

    process.exit(0);
}

function openAuthUrl() {
    const state = crypto.randomBytes(16).toString('base64url');

    const authUrl = `${AUTH_URL}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&state=${state}`;

    console.log('Opening browser for Tesla authentication...\n');
    console.log('If the browser doesn\'t open, paste this URL manually:');
    console.log(authUrl);

    try {
        const command = process.platform === 'darwin' ? 'open' :
            process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${command} "${authUrl}"`);
    } catch {
        // Browser open failed silently
    }

    console.log('\n--- NEXT STEP ---');
    console.log('After logging in, you\'ll be redirected to tesla-mcp.onrender.com.');
    console.log('Copy the FULL URL from your browser and run:\n');
    console.log('  npm run get-token -- "PASTE_CALLBACK_URL_HERE"\n');
}

// Main
if (callbackArg) {
    exchangeCode(callbackArg);
} else {
    openAuthUrl();
} 