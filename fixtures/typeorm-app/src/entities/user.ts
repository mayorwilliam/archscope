import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Team } from "./team";

// No explicit name: DefaultNamingStrategy → table "user_account" (inferred).
@Entity()
export class UserAccount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar", { length: 255 })
  email!: string;

  @Column({ nullable: true })
  bio?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => Team, { nullable: false })
  @JoinColumn({ name: "team_id" })
  team!: Team;
}
