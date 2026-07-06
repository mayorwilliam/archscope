import { login } from "./auth";
import { formatDate } from "@utils/format";
import express from "express";
import path from "node:path";

export function bootstrap(): void {
  const app = express();
  console.log(formatDate(new Date()), path.sep);
  login(app, "admin", "secret");
}
