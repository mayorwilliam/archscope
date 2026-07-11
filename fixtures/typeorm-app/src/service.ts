import { Team } from "./entities/team";
import { UserAccount } from "./entities/user";

export function describeUser(user: UserAccount, team: Team): string {
  return `${user.email} @ ${team.name}`;
}
