const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || "Request failed");
  return body;
};
let sensors = [];
const $ = (id) => document.getElementById(id);
const toast = (message) => { const el = $("toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2400); };
function badge(sensor) { if (sensor.powerState === "OFF") return '<span class="badge off">Powered off</span>'; return sensor.status === "PAIRED" ? '<span class="badge paired">Paired</span>' : '<span class="badge ready">Ready to pair</span>'; }
function render() {
  const query = $("search").value.toLowerCase(); const filter = $("filter").value;
  const filtered = sensors.filter((sensor) => `${sensor.name} ${sensor.sensorId}`.toLowerCase().includes(query) && (filter === "all" || (filter === "OFF" ? sensor.powerState === "OFF" : sensor.status === filter)));
  $("totalSensors").textContent = sensors.length; $("onlineSensors").textContent = sensors.filter((s) => s.powerState === "ON").length; $("pairedSensors").textContent = sensors.filter((s) => s.status === "PAIRED").length; $("attentionSensors").textContent = sensors.filter((s) => s.status !== "PAIRED" || s.powerState === "OFF").length; $("navCount").textContent = sensors.length;
  $("sensorRows").innerHTML = filtered.length ? filtered.map((sensor) => `<tr><td><div class="sensor-name"><span class="sensor-chip"><svg class="icon" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4"/></svg></span><div>${sensor.name}<span class="sensor-id">${sensor.sensorId}</span></div></div></td><td>${badge(sensor)}</td><td><button class="power-toggle ${sensor.powerState === "ON" ? "on" : ""}" data-power="${sensor.sensorId}"><span class="toggle"></span>${sensor.powerState === "ON" ? "On" : "Off"}</button></td><td><strong class="gas-weight">${Number(sensor.remainingGrams / 1000).toFixed(1)} kg</strong><span class="gas-status ${sensor.gasStatus.toLowerCase()}">${sensor.gasStatus}</span><small class="gas-capacity">of ${sensor.gasCapacityKg} kg</small></td><td><span class="signal">${sensor.powerState === "ON" ? `${Math.abs(sensor.signalStrength)} dBm` : "—"}</span></td><td>${sensor.powerState === "ON" ? `${sensor.batteryLevel}%` : "—"}</td><td>${sensor.powerState === "ON" ? "Just now" : "Offline"}</td><td><div class="actions">${sensor.status !== "PAIRED" ? `<button class="row-action" data-pair="${sensor.sensorId}">Pair</button>` : ""}<button class="row-action" data-view="${sensor.sensorId}">Details</button></div></td></tr>`).join("") : '<tr><td colspan="8" class="empty">No sensors match your filters.</td></tr>';
  document.querySelectorAll("[data-power]").forEach((button) => button.addEventListener("click", () => setPower(button.dataset.power)));
  document.querySelectorAll("[data-pair]").forEach((button) => button.addEventListener("click", () => pairSensor(button.dataset.pair)));
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showDetails(button.dataset.view)));
}
async function loadSensors() { try { sensors = (await api("/api/v1/prototype/admin/sensors")).sensors; render(); } catch (error) { $("sensorRows").innerHTML = `<tr><td colspan="8" class="empty">${error.message}</td></tr>`; } }
async function setPower(sensorId) { const sensor = sensors.find((item) => item.sensorId === sensorId); try { await api(`/api/v1/prototype/admin/sensors/${sensorId}/power`, { method: "POST", body: JSON.stringify({ state: sensor.powerState === "ON" ? "OFF" : "ON", confirmed: true }) }); toast(`Sensor turned ${sensor.powerState === "ON" ? "off" : "on"}`); await loadSensors(); } catch (error) { toast(error.message); } }
async function pairSensor(sensorId) { try { await api(`/api/v1/prototype/admin/sensors/${sensorId}/pair`, { method: "POST" }); toast("Sensor paired successfully"); await loadSensors(); } catch (error) { toast(error.message); } }
function openModal() { $("modal").classList.add("open"); $("sensorForm").elements.name.focus(); }
function closeModal() { $("modal").classList.remove("open"); $("sensorForm").reset(); }
async function showDetails(sensorId) {
  try {
    const sensor = await api(`/api/v1/prototype/sensors/${sensorId}/overview`);
    $("detailsName").textContent = sensor.name;
    $("detailsBody").innerHTML = `<div><small>Sensor ID</small><strong>${sensor.sensorId}</strong></div><div><small>Status</small><strong>${sensor.status.replaceAll("_", " ")}</strong></div><div><small>Power</small><strong>${sensor.powerState}</strong></div><div><small>Gross weight</small><strong>${(sensor.grossWeightGrams / 1000).toFixed(2)} kg</strong></div><div><small>Empty cylinder</small><strong>${(sensor.tareWeightGrams / 1000).toFixed(2)} kg</strong></div><div><small>Gas remaining</small><strong>${(sensor.gasRemainingGrams / 1000).toFixed(2)} kg</strong></div><div><small>Gas status</small><strong>${sensor.gasStatus}</strong></div><div><small>Reading quality</small><strong>${sensor.readingQuality}</strong></div>`;
  } catch (error) { toast(error.message); return; }
  $("detailsModal").classList.add("open");
}
function closeDetails() { $("detailsModal").classList.remove("open"); }
$("addSensor").addEventListener("click", openModal); $("pairNext").addEventListener("click", openModal); $("closeModal").addEventListener("click", closeModal); $("cancelModal").addEventListener("click", closeModal); $("refresh").addEventListener("click", loadSensors); $("search").addEventListener("input", render); $("filter").addEventListener("change", render);
$("closeDetails").addEventListener("click", closeDetails);
$("sensorForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.target); try { await api("/api/v1/prototype/admin/sensors", { method: "POST", body: JSON.stringify({ name: form.get("name"), sensorId: form.get("sensorId") || undefined, tareWeightKg: Number(form.get("tareWeightKg")), gasCapacityKg: Number(form.get("gasCapacityKg")), gasWeightKg: Number(form.get("gasWeightKg")) }) }); closeModal(); toast("Sensor added"); await loadSensors(); } catch (error) { toast(error.message); } });
loadSensors();
