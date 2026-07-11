import { teams, users } from "./schema";

export function tableNames(): string[] {
  return [String(teams), String(users)];
}
