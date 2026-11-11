require("dotenv").config({
  path: require("path").resolve(process.cwd(), "../../.env"),
});
require("dotenv").config();
const mysql = require("mysql2/promise");
const db = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "gassense",
});
(async () => {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS sensors (sensor_id VARCHAR(80) PRIMARY KEY,name VARCHAR(120) NOT NULL,signal_strength INT NOT NULL DEFAULT -48,status ENUM('READY_TO_PAIR','PAIRED') NOT NULL DEFAULT 'READY_TO_PAIR',gas_valve_state ENUM('UNKNOWN','OPEN','CLOSED') NOT NULL DEFAULT 'CLOSED',power_state ENUM('ON','OFF') NOT NULL DEFAULT 'ON',tare_weight_kg DECIMAL(10,3) NOT NULL DEFAULT 6,gas_capacity_kg DECIMAL(10,3) NOT NULL DEFAULT 6,gas_weight_kg DECIMAL(10,3) NOT NULL DEFAULT 6,gas_status ENUM('GOOD','LOW','EMPTY') NOT NULL DEFAULT 'GOOD',day_start_gas_weight_kg DECIMAL(10,3) NOT NULL DEFAULT 6,serial_number VARCHAR(120) NOT NULL,firmware_version VARCHAR(80) NOT NULL DEFAULT 'v1.4.2',gas_type VARCHAR(120) NOT NULL DEFAULT 'LPG (Propane/Butane)',provider VARCHAR(120) NOT NULL DEFAULT 'Gas Nigeria Ltd.',calibration_date DATETIME NOT NULL,next_calibration_date DATETIME NOT NULL,last_updated_at DATETIME NOT NULL,paired_at DATETIME NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS sensor_readings (id BIGINT AUTO_INCREMENT PRIMARY KEY,sensor_id VARCHAR(80) NOT NULL,gross_weight_grams INT NOT NULL,gas_remaining_grams INT NOT NULL,captured_at DATETIME NOT NULL,quality VARCHAR(30) NOT NULL DEFAULT 'VALID',INDEX idx_sensor_time(sensor_id,captured_at),CONSTRAINT fk_reading_sensor FOREIGN KEY(sensor_id) REFERENCES sensors(sensor_id) ON DELETE CASCADE)`,
  );
  try {
    await db.execute("ALTER TABLE sensors ADD COLUMN gas_status ENUM('GOOD','LOW','EMPTY') NOT NULL DEFAULT 'GOOD'");
  } catch (e) {
    if (e.code !== "ER_DUP_FIELDNAME") throw e;
  }
  console.log("GasSense MySQL tables ready");
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.end());
