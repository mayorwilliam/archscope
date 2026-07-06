// Deliberate circular import: session → login → session.
import { LOGIN_TIMEOUT } from "./login.js";

export interface Session {
  token: string;
  expiresAt: number;
}

export function createSession(token: string): string {
  const session: Session = { token, expiresAt: Date.now() + LOGIN_TIMEOUT };
  return session.token;
}
