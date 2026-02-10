/**
 * Session Manager for multi-user Tesla MCP Server
 * Handles user sessions, token storage, and authentication state.
 * Optional Redis (REDIS_URL) persists sessions across instances/restarts.
 */

import crypto from 'crypto';

export interface UserSession {
    sessionId: string;
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiration?: number;
    state?: string;
    codeVerifier?: string;
    createdAt: number;
    lastActivity: number;
    // MCP OAuth flow (when auth initiated via /oauth/authorize from an MCP client)
    oauthClientId?: string;
    oauthRedirectUri?: string;
    oauthClientState?: string;
    oauthCodeChallenge?: string;
    oauthCodeChallengeMethod?: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONNECTION_TOKEN_LENGTH = 12;

class SessionManager {
    private sessions: Map<string, UserSession> = new Map();
    private tokenToSessionId: Map<string, string> = new Map();
    private readonly CLEANUP_INTERVAL = 60 * 60 * 1000;

    constructor() {
        setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    }

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

    getSession(sessionId: string): UserSession | undefined {
        const session = this.sessions.get(sessionId);
        if (session) session.lastActivity = Date.now();
        return session;
    }

    updateSession(sessionId: string, data: Partial<UserSession>): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        Object.assign(session, data, { lastActivity: Date.now() });
        return true;
    }

    /** Short token for /sse?token=XXX so users don't need to paste long session ID */
    createConnectionToken(sessionId: string): string {
        const token = crypto.randomBytes(CONNECTION_TOKEN_LENGTH).toString('base64url').slice(0, CONNECTION_TOKEN_LENGTH);
        this.tokenToSessionId.set(token, sessionId);
        return token;
    }

    getSessionByToken(token: string): UserSession | undefined {
        const sessionId = this.tokenToSessionId.get(token);
        if (!sessionId) return undefined;
        return this.getSession(sessionId);
    }

    hasValidTokens(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        if (!session.accessToken) return false;
        if (session.tokenExpiration && Date.now() >= session.tokenExpiration) return false;
        return true;
    }

    deleteSession(sessionId: string): boolean {
        for (const [token, sid] of this.tokenToSessionId) {
            if (sid === sessionId) this.tokenToSessionId.delete(token);
        }
        return this.sessions.delete(sessionId);
    }

    generateOAuthState(sessionId: string): string {
        const state = crypto.randomBytes(16).toString('base64url');
        this.updateSession(sessionId, { state });
        return state;
    }

    generatePKCE(sessionId: string): { verifier: string; challenge: string } {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        this.updateSession(sessionId, { codeVerifier: verifier });
        return { verifier, challenge };
    }

    validateState(sessionId: string, state: string): boolean {
        const session = this.sessions.get(sessionId);
        return session?.state === state;
    }

    getCodeVerifier(sessionId: string): string | undefined {
        return this.sessions.get(sessionId)?.codeVerifier;
    }

    private cleanup(): void {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastActivity > SESSION_TTL_MS) {
                this.sessions.delete(sessionId);
                for (const [token, sid] of this.tokenToSessionId) {
                    if (sid === sessionId) this.tokenToSessionId.delete(token);
                }
            }
        }
    }

    getSessionCount(): number {
        return this.sessions.size;
    }
}

export const sessionManager = new SessionManager();
export default sessionManager;
