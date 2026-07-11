import { integer, pgSchema, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const teams = pgTable("teams", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

const auth = pgSchema("auth");

export const users = auth.table("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  teamId: integer("team_id").references(() => teams.id),
  bio: text(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
