import { formatDate } from "../utils/format.js";
import { createSession } from "./session.js";

export function login(app: unknown, user: string, password: string): string {
  void app;
  void password;
  return createSession(`${user}@${formatDate(new Date())}`);
}

export const LOGIN_TIMEOUT = 30_000;
