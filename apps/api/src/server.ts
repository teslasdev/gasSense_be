import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
const db = new PrismaClient();
const app = express();
const port = Number(process.env.API_PORT || 4000);
const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";
const webDir = path.basename(process.cwd()) === "api"
  ? path.resolve(process.cwd(), "../../web")
  : path.resolve(process.cwd(), "web");
app.use(helmet());
app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
type AuthReq = Request<any> & { user?: { id: string } };
const asyncH =
  (fn: (r: Request, s: Response, n: NextFunction) => Promise<unknown>) =>
  (r: Request, s: Response, n: NextFunction) => {
    void fn(r, s, n).catch(n);
  };
const error = (
  s: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) => s.status(status).json({ error: { code, message, details } });
const session = asyncH(async (r: AuthReq, s, n) => {
  const id = r.cookies.gassense_session;
  if (!id) {
    error(s, 401, "UNAUTHENTICATED", "Sign in required");
    return;
  }
  const x = await db.session.findUnique({ where: { id } });
  if (!x || x.expiresAt < new Date()) {
    error(s, 401, "UNAUTHENTICATED", "Session expired");
    return;
  }
  r.user = { id: x.userId };
  n();
});
const member = async (r: AuthReq, householdId: string | string[]) =>
  r.user &&
  db.membership.findUnique({
    where: {
      householdId_userId: {
        householdId: String(householdId),
        userId: r.user.id,
      },
    },
  });
app.get("/health", (_, s) => s.json({ ok: true }));

// Prototype-only Bluetooth discovery state. This lets the mobile prototype
// demonstrate discovery and pairing before the physical sensor is available.
// Replace these routes with the app's BLE scan results in the hardware build.
type PrototypeSensor = {
  sensorId: string;
  name: string;
  signalStrength: number;
  status: "READY_TO_PAIR" | "PAIRED";
  gasValveState: "UNKNOWN" | "OPEN" | "CLOSED";
  powerState: "ON" | "OFF";
  tareWeightKg: number;
  gasCapacityKg: number;
  gasWeightKg: number;
  dayStartGasWeightKg: number;
  gasStatus: "GOOD" | "LOW" | "EMPTY";
  lastSimulationAt: number;
  serialNumber: string;
  firmwareVersion: string;
  gasType: string;
  provider: string;
  calibrationDate: string;
  nextCalibrationDate: string;
  pairedAt?: string;
};

function updatePrototypeGas(sensor: PrototypeSensor) {
  const now = Date.now();
  if (
    sensor.powerState === "ON" &&
    sensor.gasValveState === "OPEN" &&
    sensor.gasWeightKg > 0
  ) {
    const minutes = Math.max(0, now - sensor.lastSimulationAt) / 60_000;
    sensor.gasWeightKg = Math.max(0, sensor.gasWeightKg - minutes * 0.02);
  }
  sensor.lastSimulationAt = now;
  const percent = sensor.gasCapacityKg ? sensor.gasWeightKg / sensor.gasCapacityKg : 0;
  sensor.gasStatus = percent <= 0 ? "EMPTY" : percent <= 0.2 ? "LOW" : "GOOD";
  return sensor;
}

function prototypeReading(sensor: PrototypeSensor) {
  updatePrototypeGas(sensor);
  return {
    grossWeightGrams: Math.round((sensor.tareWeightKg + sensor.gasWeightKg) * 1000),
    tareWeightGrams: Math.round(sensor.tareWeightKg * 1000),
    gasRemainingGrams: Math.round(sensor.gasWeightKg * 1000),
    gasRemainingPercent: Math.round((sensor.gasWeightKg / sensor.gasCapacityKg) * 100),
    quality: "VALID" as const,
    stable: true,
    capturedAt: new Date().toISOString(),
  };
}
const prototypeSensors = new Map<string, PrototypeSensor>([
  [
    "GS-V2.1-A4F7",
    {
      sensorId: "GS-V2.1-A4F7",
      name: "GasSense sensor",
      signalStrength: -48,
      status: "READY_TO_PAIR",
      gasValveState: "CLOSED",
      powerState: "ON",
      tareWeightKg: 6,
      gasCapacityKg: 6,
      gasWeightKg: 6,
      dayStartGasWeightKg: 6,
      gasStatus: "GOOD",
      lastSimulationAt: Date.now(),
      serialNumber: "A4F72E-0819",
      firmwareVersion: "v1.4.2",
      gasType: "LPG (Propane/Butane)",
      provider: "Gas Nigeria Ltd.",
      calibrationDate: "2026-08-15T00:00:00.000Z",
      nextCalibrationDate: "2027-02-15T00:00:00.000Z",
    },
  ],
]);
const estimatedUsageKgPerHour = 0.35;
const estimatedUsageHoursPerDay = 2;
const estimatedDailyUsageKg = estimatedUsageKgPerHour * estimatedUsageHoursPerDay;

function formatHour(hour: number) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 || 12;
  return `${display}:00 ${suffix}`;
}

function formatPeakWindow(hours: number[]) {
  if (!hours.length) return "Not enough data yet.";
  const start = Math.min(...hours);
  const end = Math.min(23, Math.max(...hours) + 1);
  return `Dinner preparation peaks at ${formatHour(start)} – ${formatHour(end)}.`;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

app.get("/api/v1/prototype/sensors", (_r, s) => {
  s.json({
    source: "prototype-simulator",
    scannedAt: new Date().toISOString(),
    sensors: [...prototypeSensors.values()],
  });
});

// Prototype admin routes. These are intentionally simple until admin
// authentication and real device provisioning are connected.
app.get("/api/v1/prototype/admin/sensors", (_r, s) => {
  const sensors = [...prototypeSensors.values()].map((sensor) => {
    const current = updatePrototypeGas(sensor);
    return {
      ...current,
      ...prototypeReading(current),
      lastSeenAt: new Date().toISOString(),
      batteryLevel: current.powerState === "ON" ? 96 : 0,
      gasWeightKg: current.gasWeightKg,
      remainingGrams: Math.round(current.gasWeightKg * 1000),
      remainingPercent: Math.round((current.gasWeightKg / current.gasCapacityKg) * 100),
    };
  });
  s.json({ sensors, total: sensors.length });
});

app.post(
  "/api/v1/prototype/admin/sensors",
  asyncH(async (r, s) => {
    const p = z
      .object({
        sensorId: z.string().min(4).max(80).optional(),
        name: z.string().min(1).max(80),
        tareWeightKg: z.number().min(0).max(1000).default(6),
        gasCapacityKg: z.number().positive().max(1000).default(6),
        gasWeightKg: z.number().min(0).max(1000).optional(),
      })
      .parse(r.body);
    const sensorId = p.sensorId || `GS-V2.1-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    if (prototypeSensors.has(sensorId))
      return error(s, 409, "SENSOR_EXISTS", "A sensor with this ID already exists");
    const sensor: PrototypeSensor = {
      sensorId,
      name: p.name,
      signalStrength: -52,
      status: "READY_TO_PAIR",
      gasValveState: "CLOSED",
      powerState: "ON",
      tareWeightKg: p.tareWeightKg,
      gasCapacityKg: p.gasCapacityKg,
      gasWeightKg: p.gasWeightKg ?? p.gasCapacityKg,
      dayStartGasWeightKg: p.gasWeightKg ?? p.gasCapacityKg,
      gasStatus: "GOOD",
      lastSimulationAt: Date.now(),
      serialNumber: sensorId.replace("GS-V2.1-", "") + "-0001",
      firmwareVersion: "v1.4.2",
      gasType: "LPG (Propane/Butane)",
      provider: "Gas Nigeria Ltd.",
      calibrationDate: new Date().toISOString(),
      nextCalibrationDate: addMonths(new Date(), 6).toISOString(),
    };
    prototypeSensors.set(sensorId, sensor);
    s.status(201).json({ success: true, sensor });
  }),
);

app.post(
  "/api/v1/prototype/admin/sensors/:sensorId/pair",
  asyncH(async (r, s) => {
    const sensor = prototypeSensors.get(String(r.params.sensorId));
    if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found");
    const paired = { ...sensor, status: "PAIRED" as const, pairedAt: new Date().toISOString() };
    prototypeSensors.set(sensor.sensorId, paired);
    s.json({ success: true, sensor: paired });
  }),
);

app.post(
  "/api/v1/prototype/admin/sensors/:sensorId/power",
  asyncH(async (r, s) => {
    const sensor = prototypeSensors.get(String(r.params.sensorId));
    if (!sensor) return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found");
    const p = z.object({ state: z.enum(["ON", "OFF"]), confirmed: z.literal(true) }).parse(r.body);
    const updated: PrototypeSensor = {
      ...sensor,
      powerState: p.state,
      gasValveState: p.state === "ON" ? "OPEN" : "CLOSED",
    };
    prototypeSensors.set(sensor.sensorId, updated);
    s.status(202).json({ success: true, command: p.state === "ON" ? "sensor_on" : "sensor_off", sensor: updated });
  }),
);

app.post(
  "/api/v1/prototype/sensors/:sensorId/pair",
  asyncH(async (r, s) => {
    const sensor = prototypeSensors.get(String(r.params.sensorId));
    if (!sensor)
      return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
    const paired: PrototypeSensor = {
      ...sensor,
      status: "PAIRED",
      pairedAt: new Date().toISOString(),
    };
    prototypeSensors.set(sensor.sensorId, paired);
    s.status(201).json({
      success: true,
      source: "prototype-simulator",
      sensor: paired,
      pairing: {
        transport: "mock-ble",
        backendConnected: true,
      },
    });
  }),
);

app.get("/api/v1/prototype/sensors/:sensorId/status", (r, s) => {
  const sensor = prototypeSensors.get(String(r.params.sensorId));
  if (!sensor)
    return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
  s.json({
    success: true,
    sensor,
    backendConnected: true,
    reading: {
      ...prototypeReading(sensor),
      batteryLevel: sensor.powerState === "ON" ? 96 : 0,
    },
  });
});

app.get("/api/v1/prototype/sensors/:sensorId/overview", (r, s) => {
  const sensor = prototypeSensors.get(String(r.params.sensorId));
  if (!sensor)
    return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
  if (sensor.status !== "PAIRED")
    return error(s, 409, "SENSOR_NOT_PAIRED", "Pair the sensor before requesting its overview");
  const reading = prototypeReading(sensor);
  s.json({
    sensorId: sensor.sensorId,
    name: sensor.name,
    status: sensor.status,
    powerState: sensor.powerState,
    gasValveState: sensor.gasValveState,
    tareWeightGrams: reading.tareWeightGrams,
    grossWeightGrams: reading.grossWeightGrams,
    gasCapacityGrams: Math.round(sensor.gasCapacityKg * 1000),
    gasRemainingGrams: reading.gasRemainingGrams,
    gasRemainingPercent: reading.gasRemainingPercent,
    gasStatus: sensor.gasStatus,
    estimatedUsageKgPerHour,
    estimatedUsageHoursPerDay,
    estimatedDailyUsageKg,
    estimatedDaysLeft: Math.ceil(sensor.gasWeightKg / estimatedDailyUsageKg),
    todaysUseKg: Math.max(0, Number((sensor.dayStartGasWeightKg - sensor.gasWeightKg).toFixed(2))),
    alertLimitPercent: 20,
    alertChannel: "SMS",
    batteryLevel: sensor.powerState === "ON" ? 96 : 0,
    signalStrength: sensor.powerState === "ON" ? sensor.signalStrength : null,
    readingQuality: reading.quality,
    stable: reading.stable,
    capturedAt: reading.capturedAt,
    pairedAt: sensor.pairedAt ?? null,
    source: "prototype-simulator",
  });
});

app.get("/api/v1/prototype/sensors/:sensorId/analytics", (r, s) => {
  const sensor = prototypeSensors.get(String(r.params.sensorId));
  if (!sensor)
    return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
  const period = z.enum(["daily", "weekly", "monthly"]).parse(String(r.query.period || "weekly"));
  const bucketCount = period === "daily" ? 24 : period === "weekly" ? 7 : 30;
  const labels = period === "daily"
    ? Array.from({ length: bucketCount }, (_, index) => `${String(index).padStart(2, "0")}:00`)
    : Array.from({ length: bucketCount }, (_, index) => `Day ${index + 1}`);
  const reading = prototypeReading(sensor);
  const todaysUseKg = Math.max(0, Number((sensor.dayStartGasWeightKg - sensor.gasWeightKg).toFixed(2)));
  const buckets = labels.map((label) => ({ label, usageKg: 0 }));
  if (period === "daily") buckets[new Date().getHours()].usageKg = todaysUseKg;
  return s.json({
    sensorId: sensor.sensorId,
    period,
    totalKg: period === "daily" ? todaysUseKg : 0,
    buckets,
    insights: {
      cylinderDurationDays: Math.ceil(sensor.gasWeightKg / estimatedDailyUsageKg),
      comparisonPercent: 0,
      peakCookingHours: todaysUseKg > 0 ? [new Date().getHours()] : [],
      hasData: todaysUseKg > 0,
      dataSource: "prototype-current-reading",
      details: {
        cylinderDuration: {
          title: "Your cylinder duration",
          message: `You finish a cylinder every ${Math.ceil(sensor.gasWeightKg / estimatedDailyUsageKg)} days.`,
        },
        consumptionComparison: {
          title: "Consumption vs last period",
          message: "Not enough previous data for comparison.",
        },
        peakCooking: {
          title: "Peak cooking hours",
          message: formatPeakWindow(todaysUseKg > 0 ? [new Date().getHours()] : []),
        },
      },
    },
    currentReading: reading,
  });
});

app.get("/api/v1/prototype/sensors/:sensorId/device", (r, s) => {
  const sensor = prototypeSensors.get(String(r.params.sensorId));
  if (!sensor)
    return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
  s.json({
    sensorId: sensor.sensorId,
    name: sensor.name,
    model: "GasSense v2.1",
    serialNumber: sensor.serialNumber,
    connection: sensor.status === "PAIRED" && sensor.powerState === "ON" ? "CONNECTED_VIA_BLUETOOTH" : "DISCONNECTED",
    paired: sensor.status === "PAIRED",
    pairedAt: sensor.pairedAt ?? null,
    firmwareVersion: sensor.firmwareVersion,
    firmwareStatus: "UP_TO_DATE",
    batteryLevel: sensor.powerState === "ON" ? 98 : 0,
    batteryStatus: sensor.powerState === "ON" ? "EXCELLENT" : "OFFLINE",
    signalStrengthDbm: sensor.powerState === "ON" ? sensor.signalStrength : 0,
    signalStatus: sensor.powerState === "ON" ? "STRONG" : "OFFLINE",
    calibrationDate: sensor.calibrationDate,
    nextCalibrationDate: sensor.nextCalibrationDate,
    cylinder: {
      sizeKg: sensor.gasCapacityKg,
      gasType: sensor.gasType,
      provider: sensor.provider,
      tareWeightKg: sensor.tareWeightKg,
    },
  });
});

app.post("/api/v1/prototype/sensors/:sensorId/recalibrate", (r, s) => {
  const sensor = prototypeSensors.get(String(r.params.sensorId));
  if (!sensor)
    return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
  const now = new Date();
  sensor.calibrationDate = now.toISOString();
  sensor.nextCalibrationDate = addMonths(now, 6).toISOString();
  s.json({ success: true, sensorId: sensor.sensorId, calibrationDate: sensor.calibrationDate, nextCalibrationDate: sensor.nextCalibrationDate });
});

app.delete("/api/v1/prototype/sensors/:sensorId/pair", (r, s) => {
  const sensor = prototypeSensors.get(String(r.params.sensorId));
  if (!sensor)
    return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
  sensor.status = "READY_TO_PAIR";
  sensor.pairedAt = undefined;
  sensor.gasValveState = "CLOSED";
  s.json({ success: true, sensorId: sensor.sensorId, status: sensor.status });
});

app.post(
  "/api/v1/prototype/sensors/:sensorId/gas-control",
  asyncH(async (r, s) => {
    const sensor = prototypeSensors.get(String(r.params.sensorId));
    if (!sensor)
      return error(s, 404, "SENSOR_NOT_FOUND", "Prototype sensor not found");
    if (sensor.status !== "PAIRED")
      return error(
        s,
        409,
        "SENSOR_NOT_PAIRED",
        "Pair the sensor before controlling gas",
      );
    const p = z
      .object({ state: z.enum(["ON", "OFF"]), confirmed: z.literal(true) })
      .parse(r.body);
    const updated: PrototypeSensor = {
      ...sensor,
      gasValveState: p.state === "ON" ? "OPEN" : "CLOSED",
    };
    prototypeSensors.set(sensor.sensorId, updated);
    s.status(202).json({
      accepted: true,
      source: "prototype-simulator",
      action: p.state === "ON" ? "OPEN_GAS_VALVE" : "CLOSE_GAS_VALVE",
      command: p.state === "ON" ? "gas_on" : "gas_off",
      sensor: updated,
      backendConnected: true,
      acknowledged: true,
    });
  }),
);

app.use(express.static(webDir));
app.get("/", (_r, s) => s.sendFile(path.join(webDir, "index.html")));
const authSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(80).optional(),
});
app.post(
  "/api/v1/auth/register",
  asyncH(async (r, s) => {
    const p = authSchema.parse(r.body);
    if (await db.user.findUnique({ where: { email: p.email.toLowerCase() } }))
      return error(s, 409, "EMAIL_EXISTS", "Email is already registered");
    const u = await db.user.create({
      data: {
        email: p.email.toLowerCase(),
        name: p.name || p.email.split("@")[0],
        passwordHash: await bcrypt.hash(p.password, 12),
      },
    });
    const h = await db.household.create({
      data: {
        name: `${u.name}'s household`,
        memberships: { create: { userId: u.id, role: "OWNER" } },
        alertPreferences: { create: {} },
      },
    });
    await setSession(u.id, s);
    s.status(201).json({
      user: { id: u.id, email: u.email, name: u.name },
      householdId: h.id,
    });
  }),
);
app.post(
  "/api/v1/auth/login",
  asyncH(async (r, s) => {
    const p = authSchema.pick({ email: true, password: true }).parse(r.body);
    const u = await db.user.findUnique({
      where: { email: p.email.toLowerCase() },
    });
    if (!u || !(await bcrypt.compare(p.password, u.passwordHash)))
      return error(
        s,
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect",
      );
    await setSession(u.id, s);
    s.json({ user: { id: u.id, email: u.email, name: u.name } });
  }),
);
app.post(
  "/api/v1/auth/logout",
  asyncH(async (r, s) => {
    if (r.cookies.gassense_session)
      await db.session.deleteMany({
        where: { id: r.cookies.gassense_session },
      });
    s.clearCookie("gassense_session", { httpOnly: true, sameSite: "lax" });
    s.status(204).end();
  }),
);
app.get(
  "/api/v1/auth/me",
  session,
  asyncH(async (r: AuthReq, s) => {
    const u = await db.user!.findUnique({
      where: { id: r.user!.id },
      select: {
        id: true,
        email: true,
        name: true,
        memberships: {
          select: {
            household: {
              select: {
                devices: {
                  select: {
                    id: true,
                    sensorId: true,
                    name: true,
                    status: true,
                    gasValveState: true,
                    batteryLevel: true,
                    lastSeenAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!u) {
      error(s, 404, "USER_NOT_FOUND", "User not found");
      return;
    }
    const sensors = u.memberships.flatMap((membership) => membership.household.devices);
    s.json({
      id: u.id,
      email: u.email,
      name: u.name,
      sensors,
    });
  }),
);
async function setSession(userId: string, s: Response) {
  const id = crypto.randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      id,
      userId,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    },
  });
  s.cookie("gassense_session", id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

app.get(
  "/api/v1/sensors/:sensorId/overview",
  session,
  asyncH(async (r: AuthReq, s) => {
    const sensorId = String(r.params.sensorId);
    const device = await db.device.findUnique({
      where: { sensorId },
      include: {
        cylinder: true,
        readings: { orderBy: { capturedAt: "desc" }, take: 1 },
      },
    });
    if (!device || !(await member(r, device.householdId)))
      return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found");
    const reading = device.readings[0];
    const capacity = device.cylinder?.capacityGrams ?? 0;
    const gasRemaining = reading?.gasRemainingGrams ?? 0;
    const gasPercent = capacity
      ? Math.max(0, Math.min(100, (gasRemaining / capacity) * 100))
      : 0;
    const preferences = await db.alertPreference.findUnique({
      where: { householdId: device.householdId },
    });
    s.json({
      sensorId: device.sensorId,
      name: device.name,
      status: device.status,
      powerState: device.simulationState === "paused" ? "OFF" : "ON",
      simulationState: device.simulationState,
      gasValveState: device.gasValveState,
      tareWeightGrams: device.cylinder?.tareGrams ?? 0,
      accessoryWeightGrams: device.cylinder?.accessoryGrams ?? 0,
      gasCapacityGrams: capacity,
      grossWeightGrams: reading?.grossWeightGrams ?? 0,
      gasRemainingGrams: gasRemaining,
      gasRemainingPercent: gasPercent,
      gasStatus: gasPercent <= 0 ? "EMPTY" : gasPercent <= (preferences?.lowGasPercent ?? 20) ? "LOW" : "GOOD",
      estimatedUsageKgPerHour,
      estimatedUsageHoursPerDay,
      estimatedDailyUsageKg,
      estimatedDaysLeft: Math.ceil((gasRemaining / 1000) / estimatedDailyUsageKg),
      todaysUseKg: 0,
      alertLimitPercent: preferences?.lowGasPercent ?? 20,
      alertChannel: "SMS",
      batteryLevel: device.batteryLevel ?? reading?.batteryLevel ?? 0,
      firmwareVersion: device.firmwareVersion ?? reading?.firmwareVersion ?? "unknown",
      readingQuality: reading?.quality ?? "NO_READING",
      stable: reading?.stable ?? false,
      lastSeenAt: device.lastSeenAt ?? reading?.receivedAt ?? null,
      lastReadingAt: reading?.capturedAt ?? null,
      stale: !reading || Date.now() - reading.receivedAt.getTime() > 15 * 60_000,
    });
  }),
);

app.post(
  "/api/v1/sensors/:sensorId/gas-control",
  session,
  asyncH(async (r: AuthReq, s) => {
    const sensorId = String(r.params.sensorId);
    const device = await db.device.findUnique({
      where: { sensorId },
      select: { id: true, householdId: true },
    });
    if (!device || !(await member(r, device.householdId)))
      return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found");
    const p = z
      .object({ state: z.enum(["ON", "OFF"]), confirmed: z.literal(true) })
      .parse(r.body);
    const valveState = p.state === "ON" ? "OPEN" : "CLOSED";
    const command = p.state === "ON" ? "gas_on" : "gas_off";
    const updated = await db.device.update({
      where: { id: device.id },
      data: { gasValveState: valveState, controlCommand: command, controlUpdatedAt: new Date() },
      select: { sensorId: true, gasValveState: true, controlCommand: true, controlUpdatedAt: true },
    });
    s.status(202).json({ accepted: true, ...updated });
  }),
);

app.get(
  "/api/v1/sensors/:sensorId/analytics",
  session,
  asyncH(async (r: AuthReq, s) => {
    const sensorId = String(r.params.sensorId);
    const period = z.enum(["daily", "weekly", "monthly"]).parse(String(r.query.period || "weekly"));
    const device = await db.device.findUnique({
      where: { sensorId },
      include: { cylinder: true },
    });
    if (!device || !(await member(r, device.householdId)))
      return error(s, 404, "SENSOR_NOT_FOUND", "Sensor not found");

    const now = new Date();
    const days = period === "daily" ? 1 : period === "monthly" ? 30 : 7;
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const previousFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
    const readings = await db.reading.findMany({
      where: {
        deviceId: device.id,
        quality: "VALID",
        gasRemainingGrams: { not: null },
        capturedAt: { gte: previousFrom, lte: now },
      },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, gasRemainingGrams: true },
    });
    const currentReadings = readings.filter((reading) => reading.capturedAt >= from);
    const previousReadings = readings.filter((reading) => reading.capturedAt < from);
    const bucketCount = period === "daily" ? 24 : days;
    const bucketMs = (days * 24 * 60 * 60 * 1000) / bucketCount;
    const usage = Array.from({ length: bucketCount }, (_, index) => ({
      label: period === "daily"
        ? `${String(index).padStart(2, "0")}:00`
        : new Date(from.getTime() + index * bucketMs).toLocaleDateString("en", { weekday: "short" }),
      usageKg: 0,
    }));
    let previousGas = previousReadings.at(-1)?.gasRemainingGrams ?? null;
    let totalGrams = 0;
    for (const reading of currentReadings) {
      if (previousGas !== null && reading.gasRemainingGrams !== null) {
        const consumed = Math.max(0, previousGas - reading.gasRemainingGrams);
        totalGrams += consumed;
        const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((reading.capturedAt.getTime() - from.getTime()) / bucketMs)));
        usage[index].usageKg += consumed / 1000;
      }
      previousGas = reading.gasRemainingGrams;
    }
    const previousTotalGrams = previousReadings.reduce((total, reading, index) => {
      const before = index > 0 ? previousReadings[index - 1].gasRemainingGrams : null;
      return before !== null && reading.gasRemainingGrams !== null
        ? total + Math.max(0, before - reading.gasRemainingGrams)
        : total;
    }, 0);
    const totalKg = Number((totalGrams / 1000).toFixed(2));
    const previousTotalKg = Number((previousTotalGrams / 1000).toFixed(2));
    const changePercent = previousTotalKg > 0 ? Math.round(((totalKg - previousTotalKg) / previousTotalKg) * 100) : 0;
    const dailyAverageKg = days ? totalKg / days : 0;
    const durationDays = dailyAverageKg > 0 && device.cylinder
      ? Math.ceil((device.cylinder.capacityGrams / 1000) / dailyAverageKg)
      : null;
    const peak = currentReadings.reduce<Record<number, number>>((hours, reading, index) => {
      const before = index > 0 ? currentReadings[index - 1].gasRemainingGrams : null;
      if (before !== null && reading.gasRemainingGrams !== null) {
        const hour = reading.capturedAt.getHours();
        hours[hour] = (hours[hour] || 0) + Math.max(0, before - reading.gasRemainingGrams);
      }
      return hours;
    }, {});
    const peakHours = Object.entries(peak).sort(([, a], [, b]) => b - a).slice(0, 2).map(([hour]) => Number(hour));
    s.json({
      sensorId,
      period,
      from,
      to: now,
      totalKg,
      buckets: usage.map((bucket) => ({ ...bucket, usageKg: Number(bucket.usageKg.toFixed(2)) })),
      insights: {
        cylinderDurationDays: durationDays,
        comparisonPercent: changePercent,
        peakCookingHours: peakHours,
        hasData: currentReadings.length > 1,
        details: {
          cylinderDuration: {
            title: "Your cylinder duration",
            message: durationDays ? `You finish a cylinder every ${durationDays} days.` : "Not enough data to estimate cylinder duration.",
          },
          consumptionComparison: {
            title: "Consumption vs last period",
            message: previousTotalKg > 0
              ? `This period's usage is ${Math.abs(changePercent)}% ${changePercent >= 0 ? "higher" : "lower"}.`
              : "Not enough previous data for comparison.",
          },
          peakCooking: {
            title: "Peak cooking hours",
            message: formatPeakWindow(peakHours),
          },
        },
      },
    });
  }),
);

app.get(
  "/api/v1/households/:hid/overview",
  session,
  asyncH(async (r: AuthReq, s) => {
    const hid = String(r.params.hid);
    if (!(await member(r, hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    const devices = await db.device.findMany({
      where: { householdId: hid },
      include: {
        cylinder: true,
        readings: { orderBy: { capturedAt: "desc" }, take: 1 },
      },
    });
    const prefs = await db.alertPreference.findUnique({
      where: { householdId: hid },
    });
    const all = devices.map((d: any) => {
      const x = d.readings[0];
      const remaining = x?.gasRemainingGrams ?? 0;
      const capacity = d.cylinder?.capacityGrams ?? 0;
      const tare = d.cylinder?.tareGrams ?? 0;
      const accessory = d.cylinder?.accessoryGrams ?? 0;
      const percentage = capacity
        ? Math.max(0, Math.min(100, (remaining / capacity) * 100))
        : 0;
      const gasStatus =
        percentage <= 0 ? "EMPTY" : percentage <= (prefs?.lowGasPercent ?? 20) ? "LOW" : "GOOD";
      return {
        id: d.id,
        name: d.name,
        status: d.status,
        simulationState: d.simulationState,
        powerState: d.simulationState === "paused" ? "OFF" : "ON",
        lastSeenAt: d.lastSeenAt ?? x?.receivedAt ?? null,
        firmwareVersion: d.firmwareVersion ?? x?.firmwareVersion ?? "unknown",
        batteryLevel: d.batteryLevel ?? x?.batteryLevel ?? 0,
        gasValveState: d.gasValveState,
        tareWeightGrams: tare,
        accessoryWeightGrams: accessory,
        gasCapacityGrams: capacity,
        grossWeightGrams: x?.grossWeightGrams ?? 0,
        gasRemainingGrams: remaining,
        gasStatus,
        gasRemainingPercent: percentage,
        readingQuality: x?.quality ?? "NO_READING",
        stable: x?.stable ?? false,
        lastReadingAt: x?.capturedAt ?? null,
        lowGasThreshold: prefs?.lowGasPercent ?? 20,
        stale: !x || Date.now() - x.receivedAt.getTime() > 15 * 60_000,
      };
    });
    s.json({
      devices: all,
      lowGasThreshold: prefs?.lowGasPercent ?? 20,
    });
  }),
);
app.get(
  "/api/v1/households/:hid/notifications",
  session,
  asyncH(async (r: AuthReq, s) => {
    if (!(await member(r, r.params.hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    s.json(
      await db.notification.findMany({
        where: { householdId: r.params.hid, userId: r.user!.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    );
  }),
);
app.get(
  "/api/v1/households/:hid/readings",
  session,
  asyncH(async (r: AuthReq, s) => {
    const hid = String(r.params.hid);
    if (!(await member(r, hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    const readings = await db.reading.findMany({
      where: { householdId: hid },
      orderBy: { capturedAt: "desc" },
      take: 100,
      include: { device: { select: { name: true } } },
    });
    s.json(readings);
  }),
);
app.get(
  "/api/v1/households/:hid/devices/:did",
  session,
  asyncH(async (r: AuthReq, s) => {
    const hid = String(r.params.hid),
      did = String(r.params.did);
    if (!(await member(r, hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    const device = await db.device.findFirst({
      where: { id: did, householdId: hid },
      include: {
        cylinder: true,
        credentials: {
          select: {
            id: true,
            label: true,
            lastUsedAt: true,
            createdAt: true,
            revokedAt: true,
          },
        },
        readings: { orderBy: { capturedAt: "desc" }, take: 20 },
      },
    });
    if (!device) return error(s, 404, "DEVICE_NOT_FOUND", "Device not found");
    s.json(device);
  }),
);
app.post(
  "/api/v1/households/:hid/devices/:did/control",
  session,
  asyncH(async (r: AuthReq, s) => {
    const hid = String(r.params.hid),
      did = String(r.params.did);
    if (!(await member(r, hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    const p = z
      .object({ command: z.enum(["pause", "start", "resume", "restart"]) })
      .parse(r.body);
    const state =
      p.command === "pause"
        ? "paused"
        : p.command === "restart"
          ? "restarting"
          : "running";
    const device = await db.device.updateMany({
      where: { id: did, householdId: hid },
      data: {
        controlCommand: p.command,
        controlUpdatedAt: new Date(),
        simulationState: state,
      },
    });
    if (!device.count)
      return error(s, 404, "DEVICE_NOT_FOUND", "Device not found");
    s.json({ accepted: true, command: p.command, state });
  }),
);

app.post(
  "/api/v1/households/:hid/devices/:did/gas-control",
  session,
  asyncH(async (r: AuthReq, s) => {
    const hid = String(r.params.hid);
    const did = String(r.params.did);
    if (!(await member(r, hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    const p = z
      .object({
        state: z.enum(["ON", "OFF"]),
        confirmed: z.literal(true),
      })
      .parse(r.body);
    const device = await db.device.findFirst({
      where: { id: did, householdId: hid },
      select: { id: true },
    });
    if (!device) return error(s, 404, "DEVICE_NOT_FOUND", "Device not found");
    const valveState = p.state === "ON" ? "OPEN" : "CLOSED";
    const command = p.state === "ON" ? "gas_on" : "gas_off";
    const updated = await db.device.update({
      where: { id: did },
      data: {
        gasValveState: valveState,
        controlCommand: command,
        controlUpdatedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        gasValveState: true,
        controlCommand: true,
        controlUpdatedAt: true,
      },
    });
    s.status(202).json({
      accepted: true,
      action: p.state === "ON" ? "OPEN_GAS_VALVE" : "CLOSE_GAS_VALVE",
      command,
      device: updated,
      note: "The sensor must acknowledge this command before physical valve state is trusted.",
    });
  }),
);
app.post(
  "/api/v1/devices/:did/control",
  session,
  asyncH(async (r: AuthReq, s) => {
    const did = String(r.params.did);
    const device = await db.device.findUnique({
      where: { id: did },
      select: { householdId: true },
    });
    if (!device || !(await member(r, device.householdId)))
      return error(s, 403, "FORBIDDEN", "Device access denied");
    const p = z
      .object({ command: z.enum(["pause", "start", "resume", "restart"]) })
      .parse(r.body);
    const state =
      p.command === "pause"
        ? "paused"
        : p.command === "restart"
          ? "restarting"
          : "running";
    await db.device.update({
      where: { id: did },
      data: {
        controlCommand: p.command,
        controlUpdatedAt: new Date(),
        simulationState: state,
      },
    });
    s.json({ accepted: true, command: p.command, state });
  }),
);
app.delete(
  "/api/v1/devices/:did",
  session,
  asyncH(async (r: AuthReq, s) => {
    const did = String(r.params.did);
    const device = await db.device.findUnique({
      where: { id: did },
      select: { householdId: true },
    });
    if (!device || !(await member(r, device.householdId)))
      return error(s, 403, "FORBIDDEN", "Device access denied");
    await db.device.delete({ where: { id: did } });
    s.status(204).end();
  }),
);
app.get(
  "/api/v1/device/control",
  asyncH(async (r, s) => {
    const token = String(r.headers.authorization || "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (!token)
      return error(
        s,
        401,
        "DEVICE_AUTH_REQUIRED",
        "Bearer device credential required",
      );
    const creds = await db.deviceCredential.findMany({
      where: { revokedAt: null },
      include: { device: true },
    });
    const c = await (async () => {
      for (const x of creds) if (await bcrypt.compare(token, x.hash)) return x;
    })();
    if (!c)
      return error(
        s,
        401,
        "INVALID_DEVICE_CREDENTIAL",
        "Credential is invalid or revoked",
      );
    const d = await db.device.findUnique({
      where: { id: c.deviceId },
      select: { controlCommand: true, controlUpdatedAt: true },
    });
    if (!d) return error(s, 404, "DEVICE_NOT_FOUND", "Device not found");
    if (d.controlCommand)
      await db.device.update({
        where: { id: c.deviceId },
        data: { controlCommand: null },
      });
    s.json({ command: d.controlCommand, updatedAt: d.controlUpdatedAt });
  }),
);
const deviceSchema = z.object({
  name: z.string().min(1).max(80),
  tareGrams: z.number().int().min(0).max(100000),
  capacityGrams: z.number().int().positive().max(100000),
  accessoryGrams: z.number().int().min(0).max(20000),
});
app.post(
  "/api/v1/households/:hid/devices",
  session,
  asyncH(async (r: AuthReq, s) => {
    if (!(await member(r, r.params.hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    const p = deviceSchema.parse(r.body);
    const secret = "gs_" + crypto.randomBytes(24).toString("base64url");
    const d = await db.device.create({
      data: {
        householdId: r.params.hid,
        sensorId: `GS-V2.1-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
        name: p.name,
        status: "PENDING",
        credentials: {
          create: {
            label: "Initial credential",
            hash: await bcrypt.hash(secret, 12),
          },
        },
        cylinder: {
          create: {
            householdId: r.params.hid,
            tareGrams: p.tareGrams,
            capacityGrams: p.capacityGrams,
            accessoryGrams: p.accessoryGrams,
          },
        },
      },
      include: { cylinder: true },
    });
    s.status(201).json({ device: d, credential: secret });
  }),
);
app.post(
  "/api/v1/households/:hid/devices/:did/rotate-credential",
  session,
  asyncH(async (r: AuthReq, s) => {
    const d = await db.device.findFirst({
      where: { id: r.params.did, householdId: r.params.hid },
    });
    if (!d || !(await member(r, r.params.hid)))
      return error(s, 403, "FORBIDDEN", "Device access denied");
    const secret = "gs_" + crypto.randomBytes(24).toString("base64url");
    await db.deviceCredential.updateMany({
      where: { deviceId: d.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await db.deviceCredential.create({
      data: {
        deviceId: d.id,
        label: "Rotated credential",
        hash: await bcrypt.hash(secret, 12),
      },
    });
    s.json({ credential: secret });
  }),
);
app.patch(
  "/api/v1/households/:hid/alerts",
  session,
  asyncH(async (r: AuthReq, s) => {
    if (!(await member(r, r.params.hid)))
      return error(s, 403, "FORBIDDEN", "Household access denied");
    const p = z
      .object({
        lowGasPercent: z.number().int().min(1).max(99),
        offlineMinutes: z.number().int().min(5).max(10080),
        enabled: z.boolean(),
      })
      .parse(r.body);
    s.json(
      await db.alertPreference.upsert({
        where: { householdId: r.params.hid },
        create: { householdId: r.params.hid, ...p },
        update: p,
      }),
    );
  }),
);
const readingSchema = z.object({
  readingId: z.string().min(1).max(120),
  bootId: z.string().min(1).max(120),
  sequence: z.number().int().nonnegative(),
  capturedAt: z.string().datetime({ offset: true }),
  grossWeightGrams: z.number().int().min(0).max(150000),
  stable: z.boolean(),
  firmwareVersion: z.string().max(80).optional(),
  batteryLevel: z.number().int().min(0).max(100).optional(),
  gasValveState: z.enum(["UNKNOWN", "OPEN", "CLOSED"]).optional(),
  simulatorState: z.enum(["running", "paused", "restarting"]).optional(),
});
app.post(
  "/api/v1/device/readings",
  rateLimit({
    windowMs: 60_000,
    max: 300,
    message: { error: { code: "RATE_LIMITED", message: "Too many readings" } },
  }),
  asyncH(async (r, s) => {
    const token = String(r.headers.authorization || "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (!token)
      return error(
        s,
        401,
        "DEVICE_AUTH_REQUIRED",
        "Bearer device credential required",
      );
    const creds = await db.deviceCredential.findMany({
      where: { revokedAt: null },
      include: { device: true },
    });
    const c = await (async () => {
      for (const x of creds) if (await bcrypt.compare(token, x.hash)) return x;
    })();
    if (!c)
      return error(
        s,
        401,
        "INVALID_DEVICE_CREDENTIAL",
        "Credential is invalid or revoked",
      );
    const p = readingSchema.parse(r.body);
    const captured = new Date(p.capturedAt);
    if (Math.abs(Date.now() - captured.getTime()) > 1000 * 60 * 60 * 24 * 30)
      return error(
        s,
        422,
        "TIMESTAMP_IMPLAUSIBLE",
        "capturedAt must be within 30 days",
      );
    const existing = await db.reading.findUnique({
      where: {
        deviceId_readingId: { deviceId: c.deviceId, readingId: p.readingId },
      },
    });
    if (existing)
      return s
        .status(200)
        .json({ accepted: true, duplicate: true, reading: existing });
    const cfg = await db.cylinderConfiguration.findUnique({
      where: { deviceId: c.deviceId },
    });
    if (!cfg)
      return error(
        s,
        409,
        "CYLINDER_CONFIGURATION_REQUIRED",
        "A cylinder configuration is required before readings can be calculated",
      );
    const raw =
      p.grossWeightGrams - cfg.tareGrams - cfg.accessoryGrams;
    // A small margin prevents scale noise around an empty/full cylinder from
    // turning the first reading after startup into a false implausible value.
    const measurementMargin = 500;
    const quality = !p.stable
      ? "UNSTABLE"
      : raw < -measurementMargin || raw > cfg.capacityGrams + measurementMargin
        ? "IMPLAUSIBLE"
        : "VALID";
    const previous = await db.reading.findFirst({
      where: {
        deviceId: c.deviceId,
        quality: "VALID",
        gasRemainingGrams: { not: null },
      },
      orderBy: { receivedAt: "desc" },
      select: { gasRemainingGrams: true },
    });
    const now = new Date();
    const x = await db.reading.create({
      data: {
        deviceId: c.deviceId,
        householdId: c.device.householdId,
        readingId: p.readingId,
        bootId: p.bootId,
        sequence: p.sequence,
        capturedAt: captured,
        receivedAt: now,
        grossWeightGrams: p.grossWeightGrams,
        stable: p.stable,
        firmwareVersion: p.firmwareVersion,
        batteryLevel: p.batteryLevel,
        simulatorState: p.simulatorState,
        quality: quality as any,
        // Keep the last trusted estimate through a transient startup/noisy
        // reading. The raw reading and its quality are still retained above.
        gasRemainingGrams:
          quality === "VALID" && p.stable
            ? Math.max(0, Math.min(cfg.capacityGrams, raw))
            : (previous?.gasRemainingGrams ?? 0),
      },
    });
    await db.device.update({
      where: { id: c.deviceId },
      data: {
        status: "ONLINE",
        lastSeenAt: now,
        firmwareVersion: p.firmwareVersion,
        batteryLevel: p.batteryLevel,
        gasValveState: p.gasValveState,
        simulationState: p.simulatorState || undefined,
      },
    });
    await db.deviceCredential.update({
      where: { id: c.id },
      data: { lastUsedAt: now },
    });
    s.status(201).json({
      accepted: true,
      duplicate: false,
      reading: {
        id: x.id,
        quality: x.quality,
        simulatorState: x.simulatorState,
      },
    });
  }),
);
app.use((e: unknown, _r: Request, s: Response, _n: NextFunction) => {
  if (e instanceof z.ZodError)
    return error(
      s,
      422,
      "VALIDATION_ERROR",
      "Request validation failed",
      e.flatten(),
    );
  console.error(e);
  return error(s, 500, "INTERNAL_ERROR", "Unexpected server error");
});
app.listen(port, () => console.log(`GasSense API listening on :${port}`));
