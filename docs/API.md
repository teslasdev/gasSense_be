# GasSense API

Base URL:

```text
http://localhost:4000
```

The current prototype is sensor-first. It does not require user login, a user ID, or a household ID. The frontend discovers sensors, pairs one by its `sensorId`, and uses that same ID for all sensor data and controls.

## Main flow

```text
GET  /api/v1/prototype/sensors
POST /api/v1/prototype/sensors/:sensorId/pair
GET  /api/v1/prototype/sensors/:sensorId/overview
POST /api/v1/prototype/sensors/:sensorId/gas-control
POST /api/v1/prototype/admin/sensors/:sensorId/power
```

## Error format

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable explanation"
  }
}
```

## Discover sensors

```http
GET /api/v1/prototype/sensors
```

Example response:

```json
{
  "source": "prototype-simulator",
  "scannedAt": "2026-11-10T10:00:00.000Z",
  "sensors": [
    {
      "sensorId": "GS-V2.1-A4F7",
      "name": "GasSense sensor",
      "signalStrength": -48,
      "status": "READY_TO_PAIR",
      "powerState": "ON"
    }
  ]
}
```

Use `sensorId` as the unique connection key. Do not use a household ID.

## Pair a sensor

```http
POST /api/v1/prototype/sensors/GS-V2.1-A4F7/pair
```

No request body is required.

Response:

```json
{
  "success": true,
  "source": "prototype-simulator",
  "sensor": {
    "sensorId": "GS-V2.1-A4F7",
    "name": "GasSense sensor",
    "status": "PAIRED",
    "pairedAt": "2026-11-10T10:00:00.000Z"
  },
  "pairing": {
    "transport": "mock-ble",
    "backendConnected": true
  }
}
```

Store `sensor.sensorId` as the active sensor ID in the frontend.

## Get sensor overview

```http
GET /api/v1/prototype/sensors/GS-V2.1-A4F7/overview
```

The sensor must be paired first. The response contains all data needed by the dashboard:

```json
{
  "sensorId": "GS-V2.1-A4F7",
  "name": "GasSense sensor",
  "status": "PAIRED",
  "powerState": "ON",
  "gasValveState": "OPEN",
  "tareWeightGrams": 6000,
  "grossWeightGrams": 12000,
  "gasCapacityGrams": 6000,
  "gasRemainingGrams": 6000,
  "gasRemainingPercent": 100,
  "gasStatus": "GOOD",
  "estimatedUsageKgPerHour": 0.35,
  "estimatedUsageHoursPerDay": 2,
  "estimatedDailyUsageKg": 0.7,
  "estimatedDaysLeft": 9,
  "todaysUseKg": 0,
  "alertLimitPercent": 20,
  "alertChannel": "SMS",
  "batteryLevel": 96,
  "signalStrength": -48,
  "readingQuality": "VALID",
  "stable": true,
  "capturedAt": "2026-11-10T10:00:00.000Z",
  "pairedAt": "2026-11-10T09:58:00.000Z",
  "source": "prototype-simulator"
}
```

If the sensor is not paired:

```text
409 SENSOR_NOT_PAIRED
```

## Usage analytics

The Trends screen reads analytics by sensor ID:

```http
GET /api/v1/sensors/GS-V2.1-A4F7/analytics?period=weekly
```

Allowed periods are `daily`, `weekly`, and `monthly`.

Response:

```json
{
  "sensorId": "GS-V2.1-A4F7",
  "period": "weekly",
  "totalKg": 3.47,
  "buckets": [
    { "label": "Mon", "usageKg": 0.45 },
    { "label": "Tue", "usageKg": 0.32 },
    { "label": "Wed", "usageKg": 0.58 },
    { "label": "Thu", "usageKg": 0.4 },
    { "label": "Fri", "usageKg": 0.35 },
    { "label": "Sat", "usageKg": 0.62 },
    { "label": "Sun", "usageKg": 0.75 }
  ],
  "insights": {
    "cylinderDurationDays": 18,
    "comparisonPercent": 12,
    "peakCookingHours": [18, 19],
    "hasData": true,
    "details": {
      "cylinderDuration": {
        "title": "Your cylinder duration",
        "message": "You finish a cylinder every 18 days."
      },
      "consumptionComparison": {
        "title": "Consumption vs last period",
        "message": "This period's usage is 12% higher."
      },
      "peakCooking": {
        "title": "Peak cooking hours",
        "message": "Dinner preparation peaks at 6:00 PM – 8:00 PM."
      }
    }
  }
}
```

The API calculates usage from decreases in valid `gasRemainingGrams` readings. It does not fabricate chart readings. If fewer than two valid readings exist, return the empty buckets and show an unavailable-data state in the frontend.

For the no-login prototype, use the prototype route instead:

```http
GET /api/v1/prototype/sensors/GS-V2.1-A4F7/analytics?period=weekly
```

This route always resolves a paired or discovered prototype sensor. It returns zero-filled historical buckets until enough real readings exist, plus the current reading and any usage known since the prototype sensor was added.

## Gas valve control

Turn gas on or off using the paired sensor ID:

```http
POST /api/v1/prototype/sensors/GS-V2.1-A4F7/gas-control
Content-Type: application/json
```

Request:

```json
{
  "state": "ON",
  "confirmed": true
}
```

Use `"OFF"` to close the simulated gas valve.

Response:

```json
{
  "accepted": true,
  "command": "gas_on",
  "action": "OPEN_GAS_VALVE",
  "acknowledged": true,
  "sensor": {
    "sensorId": "GS-V2.1-A4F7",
    "gasValveState": "OPEN"
  }
}
```

## Device screen

Load the Device screen using the paired sensor ID:

```http
GET /api/v1/prototype/sensors/GS-V2.1-A4F7/device
```

This returns model, serial number, Bluetooth connection, pairing date, firmware, battery, signal strength, calibration dates, and cylinder details.

Recalibrate:

```http
POST /api/v1/prototype/sensors/GS-V2.1-A4F7/recalibrate
```

This sets the calibration date to now and the next calibration date six months later.

Unpair:

```http
DELETE /api/v1/prototype/sensors/GS-V2.1-A4F7/pair
```

This changes the sensor back to `READY_TO_PAIR` and closes the gas valve.

## Sensor power control

In the prototype admin flow, this is the main sensor ON/OFF control. ON powers the sensor and opens the simulated gas valve; OFF powers the sensor down, closes the valve, and stops gas consumption.

```http
POST /api/v1/prototype/admin/sensors/GS-V2.1-A4F7/power
Content-Type: application/json
```

Turn sensor off:

```json
{
  "state": "OFF",
  "confirmed": true
}
```

When the sensor is `ON`, the prototype simulates cooking and decreases gas weight. When it is `OFF`, gas weight does not change.

## Weight calculation

The prototype uses real scale logic:

```text
grossWeight = emptyCylinderWeight + gasRemainingWeight
```

Example:

```text
Empty cylinder: 6 kg
Gas remaining:  6 kg
Gross weight:  12 kg
```

When gas is consumed:

```text
Empty cylinder: 6 kg
Gas remaining:  5.98 kg
Gross weight:  11.98 kg
```

The admin add-sensor request accepts:

```http
POST /api/v1/prototype/admin/sensors
Content-Type: application/json
```

```json
{
  "name": "Kitchen sensor",
  "sensorId": "GS-V2.1-A4F7",
  "tareWeightKg": 6,
  "gasCapacityKg": 6,
  "gasWeightKg": 6
}
```

`sensorId` is optional. If omitted, the API generates one. The weight fields default to 6 kg.

## Admin sensor list

```http
GET /api/v1/prototype/admin/sensors
```

This returns the current list with live prototype readings. The admin UI uses it to render sensor status, power, gas weight, battery, signal, and reading quality.

## Optional production API

The repository also contains an authenticated production path for future hardware deployments:

```http
GET  /api/v1/sensors/:sensorId/overview
POST /api/v1/sensors/:sensorId/gas-control
POST /api/v1/device/readings
GET  /api/v1/device/control
```

The production sensor overview uses `sensorId` as the resource key. Authentication and database ownership remain internal production concerns and are not required for the current prototype flow.

## Health check

```http
GET /health
```

Response:

```json
{ "ok": true }
```

## Local development

```bash
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

Open the sensor admin dashboard at:

```text
http://localhost:4000/
```
