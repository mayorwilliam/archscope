const fs = require("node:fs");

export async function connect(): Promise<void> {
  const { formatDate } = await import("../utils/format.js");
  console.log("connected at", formatDate(new Date()), fs.constants.R_OK);
}
