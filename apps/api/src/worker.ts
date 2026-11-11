import dotenv from "dotenv";
import path from "node:path";
import mysql from "mysql2/promise";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "gassense",
  connectionLimit: 2,
});

const interval = Number(process.env.WORKER_INTERVAL_MS || 60_000);

async function tick() {
  await pool.query("SELECT 1");
}

console.log("GasSense MySQL worker running");
tick().catch(console.error);
setInterval(() => tick().catch(console.error), interval);
