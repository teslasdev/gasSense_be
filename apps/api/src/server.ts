import dotenv from "dotenv";
import path from "node:path";
import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import mysql from "mysql2/promise";
import { z } from "zod";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();

const app = express();
const port = Number(process.env.API_PORT || 4000);
const webDir = path.basename(process.cwd()) === "api" ? path.resolve(process.cwd(), "../../web") : path.resolve(process.cwd(), "web");
const allowedOrigins = (process.env.WEB_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const estimatedUsageKgPerHour = 0.35;
const estimatedUsageHoursPerDay = 2;
const estimatedDailyUsageKg = estimatedUsageKgPerHour * estimatedUsageHoursPerDay;

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "gassense",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});

type Sensor = {
  sensorId: string; name: string; signalStrength: number; status: "READY_TO_PAIR" | "PAIRED";
  gasValveState: "UNKNOWN" | "OPEN" | "CLOSED"; powerState: "ON" | "OFF";
  tareWeightKg: number; gasCapacityKg: number; gasWeightKg: number; dayStartGasWeightKg: number;
  gasStatus: "GOOD" | "LOW" | "EMPTY"; serialNumber: string; firmwareVersion: string;
  gasType: string; provider: string; calibrationDate: string; nextCalibrationDate: string;
  lastUpdatedAt: string; pairedAt: string | null;
};

const error = (s: Response, status: number, code: string, message: string) => s.status(status).json({ error: { code, message } });
const asyncH = (fn: (r: Request, s: Response, n: NextFunction) => Promise<unknown>) => (r: Request, s: Response, n: NextFunction) => void fn(r, s, n).catch(n);

async function initDb() {
  await pool.execute(`CREATE TABLE IF NOT EXISTS sensors (
    sensor_id VARCHAR(80) PRIMARY KEY, name VARCHAR(120) NOT NULL, signal_strength INT NOT NULL DEFAULT -48,
    status ENUM('READY_TO_PAIR','PAIRED') NOT NULL DEFAULT 'READY_TO_PAIR', gas_valve_state ENUM('UNKNOWN','OPEN','CLOSED') NOT NULL DEFAULT 'CLOSED',
    power_state ENUM('ON','OFF') NOT NULL DEFAULT 'ON', tare_weight_kg DECIMAL(10,3) NOT NULL DEFAULT 6,
    gas_capacity_kg DECIMAL(10,3) NOT NULL DEFAULT 6, gas_weight_kg DECIMAL(10,3) NOT NULL DEFAULT 6, gas_status ENUM('GOOD','LOW','EMPTY') NOT NULL DEFAULT 'GOOD',
    day_start_gas_weight_kg DECIMAL(10,3) NOT NULL DEFAULT 6, serial_number VARCHAR(120) NOT NULL,
    firmware_version VARCHAR(80) NOT NULL DEFAULT 'v1.4.2', gas_type VARCHAR(120) NOT NULL DEFAULT 'LPG (Propane/Butane)',
    provider VARCHAR(120) NOT NULL DEFAULT 'Gas Nigeria Ltd.', calibration_date DATETIME NOT NULL,
    next_calibration_date DATETIME NOT NULL, last_updated_at DATETIME NOT NULL, paired_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS sensor_readings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, sensor_id VARCHAR(80) NOT NULL, gross_weight_grams INT NOT NULL,
    gas_remaining_grams INT NOT NULL, captured_at DATETIME NOT NULL, quality VARCHAR(30) NOT NULL DEFAULT 'VALID',
    INDEX idx_sensor_time (sensor_id, captured_at), CONSTRAINT fk_reading_sensor FOREIGN KEY (sensor_id) REFERENCES sensors(sensor_id) ON DELETE CASCADE
  )`);
  try {
    await pool.execute("ALTER TABLE sensors ADD COLUMN gas_status ENUM('GOOD','LOW','EMPTY') NOT NULL DEFAULT 'GOOD'");
  } catch (e: any) {
    if (e?.code !== "ER_DUP_FIELDNAME") throw e;
  }
}

function addMonths(value: Date, months: number) { const d = new Date(value); d.setMonth(d.getMonth() + months); return d; }
function formatHour(hour: number) { return `${hour % 12 || 12}:00 ${hour >= 12 ? "PM" : "AM"}`; }
function formatPeak(hours: number[]) { return hours.length ? `Dinner preparation peaks at ${formatHour(Math.min(...hours))} – ${formatHour(Math.min(23, Math.max(...hours) + 1))}.` : "Not enough data yet."; }

async function getSensor(sensorId: string): Promise<Sensor | null> {
  const [rows] = await pool.query("SELECT * FROM sensors WHERE sensor_id = ?", [sensorId]);
  const row = (rows as any[])[0];
  if (!row) return null;
  const sensor: Sensor = {
    sensorId: row.sensor_id,
    name: row.name,
    signalStrength: Number(row.signal_strength),
    status: row.status,
    gasValveState: row.gas_valve_state,
    powerState: row.power_state,
    tareWeightKg: Number(row.tare_weight_kg),
    gasCapacityKg: Number(row.gas_capacity_kg),
    gasWeightKg: Number(row.gas_weight_kg),
    dayStartGasWeightKg: Number(row.day_start_gas_weight_kg),
    gasStatus: row.gas_weight_kg <= 0 ? "EMPTY" : Number(row.gas_weight_kg) / Number(row.gas_capacity_kg) <= 0.2 ? "LOW" : "GOOD",
    serialNumber: row.serial_number,
    firmwareVersion: row.firmware_version,
    gasType: row.gas_type,
    provider: row.provider,
    calibrationDate: row.calibration_date,
    nextCalibrationDate: row.next_calibration_date,
    lastUpdatedAt: row.last_updated_at,
    pairedAt: row.paired_at,
  };
  const now = Date.now();
  const last = new Date(sensor.lastUpdatedAt).getTime();
  if (sensor.powerState === "ON" && sensor.gasValveState === "OPEN" && sensor.gasWeightKg > 0) {
    const minutes = Math.max(0, now - last) / 60000;
    sensor.gasWeightKg = Math.max(0, sensor.gasWeightKg - minutes * 0.02);
  }
  sensor.lastUpdatedAt = new Date(now).toISOString();
  const percent = sensor.gasCapacityKg ? sensor.gasWeightKg / sensor.gasCapacityKg : 0;
  sensor.gasStatus = percent <= 0 ? "EMPTY" : percent <= 0.2 ? "LOW" : "GOOD";
  await pool.execute("UPDATE sensors SET gas_weight_kg=?, gas_status=?, last_updated_at=? WHERE sensor_id=?", [sensor.gasWeightKg, sensor.gasStatus, sensor.lastUpdatedAt, sensorId]).catch(() => undefined);
  await pool.execute("INSERT INTO sensor_readings (sensor_id,gross_weight_grams,gas_remaining_grams,captured_at) VALUES (?,?,?,?)", [sensorId, Math.round((sensor.tareWeightKg + sensor.gasWeightKg) * 1000), Math.round(sensor.gasWeightKg * 1000), sensor.lastUpdatedAt]).catch(() => undefined);
  return sensor;
}

function overview(sensor: Sensor) {
  const percent = sensor.gasCapacityKg ? Math.max(0, Math.min(100, sensor.gasWeightKg / sensor.gasCapacityKg * 100)) : 0;
  return { sensorId: sensor.sensorId, name: sensor.name, status: sensor.status, powerState: sensor.powerState, gasValveState: sensor.gasValveState, tareWeightGrams: Math.round(sensor.tareWeightKg * 1000), grossWeightGrams: Math.round((sensor.tareWeightKg + sensor.gasWeightKg) * 1000), gasCapacityGrams: Math.round(sensor.gasCapacityKg * 1000), gasRemainingGrams: Math.round(sensor.gasWeightKg * 1000), gasRemainingPercent: Math.round(percent), gasStatus: sensor.gasStatus, estimatedUsageKgPerHour, estimatedUsageHoursPerDay, estimatedDailyUsageKg, estimatedDaysLeft: Math.ceil(sensor.gasWeightKg / estimatedDailyUsageKg), todaysUseKg: Math.max(0, Number((sensor.dayStartGasWeightKg - sensor.gasWeightKg).toFixed(2))), alertLimitPercent: 20, alertChannel: "SMS", batteryLevel: sensor.powerState === "ON" ? 98 : 0, signalStrength: sensor.powerState === "ON" ? sensor.signalStrength : 0, readingQuality: "VALID", stable: true, lastSeenAt: sensor.lastUpdatedAt, pairedAt: sensor.pairedAt };
}

async function listSensors() { const [rows] = await pool.query("SELECT * FROM sensors ORDER BY created_at DESC"); return Promise.all((rows as any[]).map(async (row) => { const sensor = await getSensor(row.sensor_id); return sensor ? overview(sensor) : null; })).then((items) => items.filter(Boolean)); }

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "32kb" }));
app.get("/health", async (_r, s) => { try { await pool.query("SELECT 1"); s.json({ ok: true }); } catch { error(s, 503, "DATABASE_UNAVAILABLE", "MySQL is unavailable"); } });

app.get("/api/v1/prototype/sensors", asyncH(async (_r, s) => s.json({ source: "mysql", scannedAt: new Date().toISOString(), sensors: await listSensors() })));
app.get("/api/v1/prototype/admin/sensors", asyncH(async (_r, s) => { const sensors = await listSensors(); s.json({ sensors, total: sensors.length }); }));
app.get("/api/v1/sensors", asyncH(async (_r, s) => s.json({ sensors: await listSensors() })));
app.get("/api/v1/admin/sensors", asyncH(async (_r, s) => s.json({ sensors: await listSensors() })));

app.post("/api/v1/prototype/admin/sensors", asyncH(async (r, s) => {
  const p = z.object({ sensorId: z.string().min(4).max(80).optional(), name: z.string().min(1).max(120), tareWeightKg: z.number().min(0).max(1000).default(6), gasCapacityKg: z.number().positive().max(1000).default(6), gasWeightKg: z.number().min(0).max(1000).optional() }).parse(r.body);
  const sensorId = p.sensorId || `GS-V2.1-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const now = new Date(); const serial = `${sensorId.replace("GS-V2.1-", "")}-0001`;
  await pool.execute("INSERT INTO sensors (sensor_id,name,signal_strength,status,gas_valve_state,power_state,tare_weight_kg,gas_capacity_kg,gas_weight_kg,day_start_gas_weight_kg,serial_number,calibration_date,next_calibration_date,last_updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [sensorId, p.name, -52, "READY_TO_PAIR", "CLOSED", "ON", p.tareWeightKg, p.gasCapacityKg, p.gasWeightKg ?? p.gasCapacityKg, p.gasWeightKg ?? p.gasCapacityKg, serial, now, addMonths(now, 6), now]);
  const sensor = await getSensor(sensorId); s.status(201).json({ success: true, sensor: sensor && overview(sensor) });
}));

async function pair(r: Request, s: Response) { const id = String(r.params.sensorId); const sensor = await getSensor(id); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); await pool.execute("UPDATE sensors SET status='PAIRED', paired_at=? WHERE sensor_id=?", [new Date(), id]); s.json({ success: true, sensorId: id, status: "PAIRED" }); }
app.post("/api/v1/prototype/sensors/:sensorId/pair", asyncH(pair)); app.post("/api/v1/prototype/admin/sensors/:sensorId/pair", asyncH(pair));

async function power(r: Request, s: Response) { const id = String(r.params.sensorId); const p = z.object({ state: z.enum(["ON", "OFF"]), confirmed: z.literal(true) }).parse(r.body); const sensor = await getSensor(id); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); await pool.execute("UPDATE sensors SET power_state=?, gas_valve_state=? WHERE sensor_id=?", [p.state, p.state === "ON" ? "OPEN" : "CLOSED", id]); s.status(202).json({ success: true, sensorId: id, powerState: p.state, gasValveState: p.state === "ON" ? "OPEN" : "CLOSED" }); }
app.post("/api/v1/prototype/admin/sensors/:sensorId/power", asyncH(power));

app.get("/api/v1/prototype/sensors/:sensorId/overview", asyncH(async (r, s) => { const sensor = await getSensor(String(r.params.sensorId)); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); if (sensor.status !== "PAIRED") return error(s, 409, "SENSOR_NOT_PAIRED", "Pair the sensor before requesting its overview"); s.json(overview(sensor)); }));
app.get("/api/v1/sensors/:sensorId/overview", asyncH(async (r, s) => { const sensor = await getSensor(String(r.params.sensorId)); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); s.json(overview(sensor)); }));

async function gasControl(r: Request, s: Response) { const id = String(r.params.sensorId); const p = z.object({ state: z.enum(["ON", "OFF"]), confirmed: z.literal(true) }).parse(r.body); const sensor = await getSensor(id); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); await pool.execute("UPDATE sensors SET gas_valve_state=? WHERE sensor_id=?", [p.state === "ON" ? "OPEN" : "CLOSED", id]); s.status(202).json({ accepted: true, sensorId: id, command: p.state === "ON" ? "gas_on" : "gas_off", gasValveState: p.state === "ON" ? "OPEN" : "CLOSED" }); }
app.post("/api/v1/prototype/sensors/:sensorId/gas-control", asyncH(gasControl)); app.post("/api/v1/sensors/:sensorId/gas-control", asyncH(gasControl));

app.get("/api/v1/prototype/sensors/:sensorId/device", asyncH(async (r, s) => { const sensor = await getSensor(String(r.params.sensorId)); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); s.json({ sensorId: sensor.sensorId, name: sensor.name, model: "GasSense v2.1", serialNumber: sensor.serialNumber, connection: sensor.status === "PAIRED" && sensor.powerState === "ON" ? "CONNECTED_VIA_BLUETOOTH" : "DISCONNECTED", paired: sensor.status === "PAIRED", pairedAt: sensor.pairedAt, firmwareVersion: sensor.firmwareVersion, firmwareStatus: "UP_TO_DATE", batteryLevel: sensor.powerState === "ON" ? 98 : 0, batteryStatus: sensor.powerState === "ON" ? "EXCELLENT" : "OFFLINE", signalStrengthDbm: sensor.powerState === "ON" ? sensor.signalStrength : 0, signalStatus: sensor.powerState === "ON" ? "STRONG" : "OFFLINE", calibrationDate: sensor.calibrationDate, nextCalibrationDate: sensor.nextCalibrationDate, cylinder: { sizeKg: sensor.gasCapacityKg, gasType: sensor.gasType, provider: sensor.provider, tareWeightKg: sensor.tareWeightKg } }); }));
app.post("/api/v1/prototype/sensors/:sensorId/recalibrate", asyncH(async (r, s) => { const sensor = await getSensor(String(r.params.sensorId)); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); const now = new Date(); await pool.execute("UPDATE sensors SET calibration_date=?, next_calibration_date=? WHERE sensor_id=?", [now, addMonths(now, 6), sensor.sensorId]); s.json({ success: true, sensorId: sensor.sensorId, calibrationDate: now, nextCalibrationDate: addMonths(now, 6) }); }));
app.delete("/api/v1/prototype/sensors/:sensorId/pair", asyncH(async (r, s) => { const id = String(r.params.sensorId); const sensor = await getSensor(id); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); await pool.execute("UPDATE sensors SET status='READY_TO_PAIR', paired_at=NULL, gas_valve_state='CLOSED' WHERE sensor_id=?", [id]); s.json({ success: true, sensorId: id, status: "READY_TO_PAIR" }); }));

app.get("/api/v1/prototype/sensors/:sensorId/analytics", asyncH(async (r, s) => { const sensor = await getSensor(String(r.params.sensorId)); if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found"); const period = z.enum(["daily", "weekly", "monthly"]).parse(String(r.query.period || "weekly")); const count = period === "daily" ? 24 : period === "weekly" ? 7 : 30; const [rows] = await pool.query("SELECT gas_remaining_grams,captured_at FROM sensor_readings WHERE sensor_id=? AND captured_at>=DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY captured_at ASC", [sensor.sensorId, period === "monthly" ? 30 : period === "weekly" ? 7 : 1]); const readings = rows as any[]; const buckets = Array.from({ length: count }, (_, i) => ({ label: period === "daily" ? `${String(i).padStart(2, "0")}:00` : `Day ${i + 1}`, usageKg: 0 })); let total = 0; for (let i = 1; i < readings.length; i++) { const used = Math.max(0, Number(readings[i - 1].gas_remaining_grams) - Number(readings[i].gas_remaining_grams)); total += used; const index = period === "daily" ? new Date(readings[i].captured_at).getHours() : Math.min(count - 1, Math.floor(i / Math.max(1, readings.length / count))); buckets[index].usageKg += used / 1000; } const duration = total > 0 ? Math.ceil(sensor.gasCapacityKg / (total / 1000 / (period === "monthly" ? 30 : period === "weekly" ? 7 : 1))) : Math.ceil(sensor.gasWeightKg / estimatedDailyUsageKg); s.json({ sensorId: sensor.sensorId, period, totalKg: Number((total / 1000).toFixed(2)), buckets: buckets.map((b) => ({ ...b, usageKg: Number(b.usageKg.toFixed(2)) })), insights: { cylinderDurationDays: duration, comparisonPercent: 0, peakCookingHours: [], hasData: readings.length > 1 } }); }));

app.use(express.static(webDir)); app.get("/", (_r, s) => s.sendFile(path.join(webDir, "index.html")));
app.use((e: unknown, _r: Request, s: Response, _n: NextFunction) => { if (e instanceof z.ZodError) return error(s, 422, "VALIDATION_ERROR", "Request validation failed"); console.error(e); return error(s, 500, "INTERNAL_ERROR", "Unexpected server error"); });

initDb().then(() => app.listen(port, () => console.log(`GasSense API listening on :${port}`))).catch((e) => { console.error("Unable to initialize MySQL", e); process.exit(1); });
