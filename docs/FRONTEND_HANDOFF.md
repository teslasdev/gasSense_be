# GasSense frontend handoff

This document describes the frontend needed to reproduce the supplied GasSense screens and connect them to the current API.

## Product flow

```text
Setup screen 1: power on sensor
        ↓ Sensor is ready
Setup screen 2: discover and pair sensor
        ↓ Pair sensor
Dashboard: monitor gas and control valve
```

The current repository contains a working prototype dashboard at `/`. It uses the prototype simulator because physical hardware is not available yet.

## Screens

### 1. Power-on setup screen

Purpose: prepare the user before Bluetooth discovery.

Required content:

- Title: `Setup GasSense`
- Subtitle: `Get connected in 3 easy steps`
- Progress indicator: step 1 active, steps 2 and 3 inactive
- Sensor illustration with `Ready to pair`
- Heading: `Power on your sensor`
- Supporting text: `Get your GasSense smart sensor ready before connecting it to your phone.`
- Checklist:
  1. `Keep your sensor nearby` — `Place it next to your phone.`
  2. `Turn on the sensor` — `Press and hold the power button.`
  3. `Look for the blinking light` — `Your sensor is ready to pair.`
- Info message: `Wait to place the sensor under your cylinder until pairing is complete.`
- Primary button: `Sensor is ready`

Interaction:

- Button advances to screen 2.
- No backend request is required for this screen.

### 2. Bluetooth discovery and pairing screen

Purpose: find the nearby GasSense sensor and connect it to the backend account.

Required content:

- Title and subtitle remain visible.
- Progress indicator: steps 1 and 2 active, step 3 inactive
- Bluetooth illustration
- Dynamic count, for example `1 sensor found`
- Heading: `Connect your sensor`
- Supporting text: `Turn on Bluetooth and allow nearby device access, then select your sensor below.`
- Nearby sensor card:
  - Sensor ID, for example `GS-V2.1-A4F7`
  - Signal strength, for example `Strong signal`
  - Status, for example `Ready to pair`
  - Selected check state
- `Scan again` action
- Bluetooth permission reminder
- Primary button: `Pair sensor`

Frontend state:

```ts
type NearbySensor = {
  sensorId: string;
  name: string;
  signalStrength: number;
  status: "READY_TO_PAIR" | "PAIRED";
  gasValveState: "UNKNOWN" | "OPEN" | "CLOSED";
};
```

Prototype API flow:

```http
GET /api/v1/prototype/sensors
```

Use the returned `sensors` array to render the list and `sensors.length` for the count.

When the user selects a sensor:

```http
POST /api/v1/prototype/sensors/:sensorId/pair
Content-Type: application/json
```

```json
{
  "userId": "prototype-user",
  "householdId": "prototype-household"
}
```

On success, advance to the dashboard or the third setup screen. The response contains:

```json
{
  "success": true,
  "backendConnected": true,
  "sensor": {
    "sensorId": "GS-V2.1-A4F7",
    "status": "PAIRED"
  }
}
```

Store the paired `sensor.sensorId` as the active sensor ID. Load the overview by that ID:

```http
GET /api/v1/prototype/sensors/:sensorId/overview
```

Do not use a household ID to select the active prototype sensor.

For this prototype, no user login or household ID is required. Pairing is keyed only by `sensorId`. Production can add authentication later without changing the sensor discovery and overview shape. The backend does not replace native Bluetooth permissions or BLE scanning.

### 3. Main dashboard

Purpose: show gas status, consumption, alerts, and remote valve control.

Required content from the supplied screen:

- Header: `My GasSense`
- Model and serial: `GS-V2.1 • SN: A4F72E`
- Connection status: sensor/backend live indicator
- Smart sensor/cylinder illustration
- Live reading label
- Circular gas gauge: `64%` and quality label `Good`
- Remaining gas: `8.0 kg of 12.5 kg`
- Days left: `~11 Days`
- Today's use: `0.35 kg`
- Alert limit: `20%`, `Notify via SMS`
- Weekly usage trends card
- Bottom navigation: Home, Trends, Device, Settings

Additional required control card:

- Current valve state: `Gas on`, `Gas off`, or `Unknown`
- `Turn gas on` button
- `Turn gas off` button
- Pending/acknowledged status message
- Disable both buttons while a command is being sent
- Require confirmation before sending either command

## Dashboard data model

```ts
type DashboardDevice = {
  id: string;
  name: string;
  status: "PENDING" | "ONLINE" | "OFFLINE" | "REVOKED";
  gasValveState: "UNKNOWN" | "OPEN" | "CLOSED";
  lastSeenAt: string | null;
  firmwareVersion: string | null;
  batteryLevel: number | null;
  tareWeightGrams: number;
  accessoryWeightGrams: number;
  gasCapacityGrams: number;
  grossWeightGrams: number;
  gasRemainingGrams: number;
  gasStatus: "GOOD" | "LOW" | "EMPTY";
  gasRemainingPercent: number;
  readingQuality: "VALID" | "UNSTABLE" | "IMPLAUSIBLE" | "SENSOR_FAULT" | "NO_READING";
  stable: boolean;
  lastReadingAt: string | null;
  stale: boolean;
};

type Reading = {
  grossWeightGrams: number;
  gasRemainingGrams: number | null;
  batteryLevel: number | null;
  stable: boolean;
  quality: "VALID" | "UNSTABLE" | "IMPLAUSIBLE" | "SENSOR_FAULT";
  capturedAt: string;
  receivedAt: string;
  gasValveState?: "UNKNOWN" | "OPEN" | "CLOSED";
};
```

## Dashboard API calls

### Load the dashboard

Production route:

```http
GET /api/v1/households/:householdId/overview
Cookie: gassense_session=<session>
```

Use `devices[0]` for the primary dashboard device. The overview now returns all dashboard values directly:

```ts
const percent = device.gasRemainingPercent;
const kilograms = device.gasRemainingGrams / 1000;
const totalWeight = device.grossWeightGrams / 1000;
```

The current prototype dashboard can use:

```http
GET /api/v1/prototype/sensors/GS-V2.1-A4F7/status
```

### Turn gas on or off in the prototype

```http
POST /api/v1/prototype/sensors/:sensorId/gas-control
Content-Type: application/json
```

```json
{
  "state": "ON",
  "confirmed": true
}
```

For gas off, use `"state": "OFF"`.

Response:

```json
{
  "accepted": true,
  "action": "OPEN_GAS_VALVE",
  "command": "gas_on",
  "sensor": {
    "sensorId": "GS-V2.1-A4F7",
    "gasValveState": "OPEN"
  },
  "backendConnected": true,
  "acknowledged": true
}
```

### Turn gas on or off with a real authenticated device

```http
POST /api/v1/households/:householdId/devices/:deviceId/gas-control
Cookie: gassense_session=<session>
Content-Type: application/json
```

```json
{
  "state": "OFF",
  "confirmed": true
}
```

The API returns `202 Accepted` because the command is queued for the physical sensor. The UI should display a pending state until the sensor acknowledges the command in a later reading.

## Optional production authentication

```http
POST /api/v1/auth/register
POST /api/v1/auth/login
GET  /api/v1/auth/me
POST /api/v1/auth/logout
```

These calls are not required for the current sensor-first prototype. They are reserved for a future production account layer.

```ts
fetch(`${API_URL}/api/v1/auth/me`, {
  credentials: "include",
});
```

## API client requirements

Create one shared client with:

- `baseUrl` from `VITE_API_URL` or an equivalent environment variable
- JSON request/response handling
- `credentials: "include"` for authenticated routes
- Consistent error parsing from `error.code` and `error.message`
- Loading, empty, error, and offline states
- A request timeout
- Prevention of duplicate gas-control requests

Example:

```ts
export async function api<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || "Request failed");
  return body as T;
}
```

## Visual requirements

- Background: very light blue-green gradient
- Primary color: teal/green
- Text: deep navy
- Cards: white with pale blue-gray borders and large rounded corners
- Primary actions: full-width teal buttons with white text
- Secondary/danger gas-off action: pale red background with dark red text
- Use large touch targets, minimum 44px height
- Keep the dashboard responsive for a narrow phone width and desktop web width
- Use accessible labels and visible focus states
- Never rely on color alone to communicate valve state

## Safety and hardware boundary

The prototype buttons simulate valve changes. In production:

- The physical valve must be fail-safe.
- The sensor must authenticate commands.
- The web client must never receive or store the device credential.
- `202 Accepted` means the command was queued, not that the valve physically moved.
- Show `UNKNOWN` or `PENDING` when the sensor has not acknowledged the final state.
- Require confirmation for gas ON and gas OFF.
- Log who requested each valve change and when it was acknowledged.

## Local development

```bash
docker compose up -d mysql
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

Then open [http://localhost:4000/](http://localhost:4000/).
