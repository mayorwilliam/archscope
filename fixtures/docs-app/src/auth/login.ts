/**
 * Log a user in and mint a session token.
 *
 * Second paragraph — must NOT appear in the extracted summary.
 * @param user the user name
 */
export function login(user: string): string {
  return `token:${user}`;
}

/**
 * @param token only tags, no prose — no doc must be extracted.
 */
export function logout(token: string): void {
  void token;
}

/** Retry budget for the login flow. */
export const MAX_RETRIES = 3;

/** Detached comment — the blank line below breaks the bond. */

export function refresh(): void {}

/**
 * Shape of a session record.
 */
export interface Session {
  token: string;
}
