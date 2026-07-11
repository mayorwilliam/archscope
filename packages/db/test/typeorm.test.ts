import { describe, expect, it } from "vitest";
import { extractTypeormEntities } from "../src/typeorm.js";
import { parseTypescript } from "./helpers.js";

const SOURCE = `
import {
  Entity, Column, PrimaryGeneratedColumn, PrimaryColumn, CreateDateColumn,
  DeleteDateColumn, ManyToOne, OneToOne, OneToMany, JoinColumn,
} from "typeorm";
import { Team } from "./team";

@Entity({ name: "users", schema: "auth" })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "last_name", nullable: true })
  lastName?: string;

  @Column("varchar", { length: 255 })
  email!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => Team, (team) => team.users, { nullable: false })
  @JoinColumn({ name: "team_id", referencedColumnName: "id" })
  team!: Team;

  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[];

  notAColumn!: string;
}

@Entity()
export class UserProfile {
  @PrimaryColumn("uuid")
  id!: string;

  @Column()
  bio!: string;

  @OneToOne(() => User)
  @JoinColumn()
  user!: User;
}

@Entity("logs")
class AuditLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;
}

export class NotAnEntity {
  @Column()
  id!: number;
}
`;

describe("extractTypeormEntities", async () => {
  const entities = extractTypeormEntities("src/entities.ts", await parseTypescript(SOURCE));
  const byName = new Map(entities.map((e) => [e.name, e]));

  it("only @Entity-decorated classes are entities, exported or not", () => {
    expect([...byName.keys()].sort()).toEqual(["AuditLog", "User", "UserProfile"]);
  });

  it("explicit names (string or option) are certain; conventions inferred", () => {
    const user = byName.get("User");
    expect(user).toMatchObject({ table: "users", schema: "auth", tableExplicit: true });
    expect(byName.get("AuditLog")).toMatchObject({ table: "logs", tableExplicit: true });
    // DefaultNamingStrategy: snake_case of the class name.
    expect(byName.get("UserProfile")).toMatchObject({
      table: "user_profile",
      schema: "public",
      tableExplicit: false,
    });
  });

  it("reads column overrides, explicit types and nullability", () => {
    const fields = new Map(byName.get("User")?.fields.map((f) => [f.name, f]));
    expect(fields.get("id")).toMatchObject({ type: "int", isPk: true, nullable: false });
    expect(fields.get("lastName")).toMatchObject({ column: "last_name", nullable: true });
    expect(fields.get("email")).toMatchObject({ type: "varchar", nullable: false });
    expect(fields.get("createdAt")).toMatchObject({ type: "timestamp", nullable: false });
    expect(fields.has("notAColumn")).toBe(false);
    expect(fields.has("posts")).toBe(false);
  });

  it("maps TS annotations to TypeORM's default column types", () => {
    const bio = byName.get("UserProfile")?.fields.find((f) => f.name === "bio");
    expect(bio?.type).toBe("varchar");
    const id = byName.get("UserProfile")?.fields.find((f) => f.name === "id");
    expect(id).toMatchObject({ type: "uuid", isPk: true });
  });

  it("ManyToOne with JoinColumn yields the FK column and relation", () => {
    const user = byName.get("User");
    const team = user?.fields.find((f) => f.name === "team");
    expect(team).toMatchObject({ column: "team_id", isFk: true, nullable: false });
    expect(user?.relations).toEqual([
      { columns: ["team_id"], targetEntity: "Team", references: ["id"] },
    ]);
  });

  it("OneToOne owns the FK only via JoinColumn, with default naming", () => {
    const profile = byName.get("UserProfile");
    const userField = profile?.fields.find((f) => f.name === "user");
    // DefaultNamingStrategy.joinColumnName: camelCase(prop + "_" + "id").
    expect(userField).toMatchObject({ column: "userId", isFk: true, nullable: true });
    expect(profile?.relations).toEqual([
      { columns: ["userId"], targetEntity: "User", references: ["id"] },
    ]);
  });

  it("spans cover the class definition", () => {
    const user = byName.get("User");
    expect(user?.startLine).toBeLessThan(user?.endLine ?? 0);
  });
});
