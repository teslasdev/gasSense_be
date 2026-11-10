import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  const email = "demo@gassense.local";
  const user = await db.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash: await bcrypt.hash("demo-password", 12),
      name: "Demo User",
    },
  });

  const existingMembership = await db.membership.findFirst({
    where: { userId: user.id, role: "OWNER" },
    include: { household: true },
  });
  const household =
    existingMembership?.household ??
    (await db.household.create({
      data: {
        name: "My household",
        timezone: "Africa/Lagos",
        memberships: { create: { userId: user.id, role: "OWNER" } },
        alertPreferences: { create: {} },
      },
    }));

  await db.alertPreference.upsert({
    where: { householdId: household.id },
    update: {},
    create: { householdId: household.id },
  });

  let device = await db.device.findFirst({
    where: { householdId: household.id },
    orderBy: { createdAt: "asc" },
  });
  if (!device) {
    device = await db.device.create({
      data: {
        householdId: household.id,
        sensorId: "GS-V2.1-DEMO",
        name: "Kitchen sensor",
        status: "OFFLINE",
      },
    });
  } else if (!device.sensorId) {
    device = await db.device.update({
      where: { id: device.id },
      data: { sensorId: `GS-${device.id.slice(-8).toUpperCase()}` },
    });
  }

  await db.cylinderConfiguration.upsert({
    where: { deviceId: device.id },
    update: {},
    create: {
      householdId: household.id,
      deviceId: device.id,
      tareGrams: 12000,
      capacityGrams: 12000,
      accessoryGrams: 500,
    },
  });

  console.log({
    email,
    password: "demo-password",
    householdId: household.id,
    deviceId: device.id,
  });
}

main().finally(() => db.$disconnect());
