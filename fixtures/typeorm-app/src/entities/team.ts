import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "teams", schema: "org" })
export class Team {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "team_name" })
  name!: string;
}
