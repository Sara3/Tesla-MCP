/**
 * Session Manager for multi-user Tesla MCP Server
 * Handles user sessions, token storage, and authentication state
 */

import crypto from 'crypto';

export interface UserSession {
    sessionId: string;
    // User's Tesla Developer App credentials
    clientId?: string;
    clientSecret?: string;
    // OAuth tokens
    accessToken?: string;
    refreshToken?: string;
    tokenExpiration?: number;
    state?: string;  // OAuth state for CSRF protection
    codeVerifier?: string;  // PKCE code verifier
    createdAt: number;
    lastActivity: number;
}

class SessionManager {
    private sessions: Map<string, UserSession> = new Map();
    private readonly SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
    private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

    constructor() {
        // Periodically clean up expired sessions
        setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    }

    /**
     * Create a new session
     */
    createSession(): UserSession {
        const sessionId = crypto.randomBytes(32).toString('hex');
        const session: UserSession = {
            sessionId,
            createdAt: Date.now(),
            lastActivity: Date.now(),
        };
        this.sessions.set(sessionId, session);
        return session;
    }

    /**
     * Get session by ID
     */
    getSession(sessionId: string): UserSession | undefined {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.lastActivity = Date.now();
        }
        return session;
    }

    /**
     * Update session data
     */
    updateSession(sessionId: string, data: Partial<UserSession>): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }
        Object.assign(session, data, { lastActivity: Date.now() });
        return true;
    }

    /**
     * Check if session has valid tokens
     */
    hasValidTokens(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        if (!session.accessToken) return false;
        if (session.tokenExpiration && Date.now() >= session.tokenExpiration) return false;
        return true;
    }

    /**
     * Delete a session
     */
    deleteSession(sessionId: string): boolean {
        return this.sessions.delete(sessionId);
    }

    /**
     * Generate OAuth state for CSRF protection
     */
    generateOAuthState(sessionId: string): string {
        const state = crypto.randomBytes(16).toString('base64url');
        this.updateSession(sessionId, { state });
        return state;
    }

    /**
     * Generate PKCE code verifier and challenge
     */
    generatePKCE(sessionId: string): { verifier: string; challenge: string } {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        this.updateSession(sessionId, { codeVerifier: verifier });
        return { verifier, challenge };
    }

    /**
     * Validate OAuth state
     */
    validateState(sessionId: string, state: string): boolean {
        const session = this.sessions.get(sessionId);
        return session?.state === state;
    }

    /**
     * Get code verifier for token exchange
     */
    getCodeVerifier(sessionId: string): string | undefined {
        return this.sessions.get(sessionId)?.codeVerifier;
    }

    /**
     * Clean up expired sessions
     */
    private cleanup(): void {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastActivity > this.SESSION_TTL) {
                this.sessions.delete(sessionId);
            }
        }
    }

    /**
     * Get session count (for monitoring)
     */
    getSessionCount(): number {
        return this.sessions.size;
    }
}

// Export singleton instance
export const sessionManager = new SessionManager();
export default sessionManager;
