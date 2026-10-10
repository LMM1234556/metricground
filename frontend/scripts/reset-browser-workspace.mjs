import WebSocket from "ws";

const targets = await fetch("http://127.0.0.1:9224/json/list").then((response) => response.json());
const target = targets.find((item) => item.url === "http://localhost:5173/")
  ?? targets.find((item) => item.url === "http://127.0.0.1:5173/");
if (!target) throw new Error("MetricGround browser target not found");
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
});
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
function command(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
await command("Runtime.enable");
// Leave the application first: its live IndexedDB connections can block deletion.
// This helper only targets the dedicated localhost regression browser, not user data.
const applicationUrl = target.url;
await command("Page.navigate", { url: "about:blank" });
let leftApplication = false;
for (let attempt = 0; attempt < 50; attempt++) {
  const state = await command("Runtime.evaluate", { expression: "location.href", returnByValue: true });
  if (state.result.value === "about:blank") { leftApplication = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!leftApplication) throw new Error("Workspace reset could not release application connections");
await command("Storage.clearDataForOrigin", {
  origin: new URL(applicationUrl).origin,
  storageTypes: "indexeddb",
});
await command("Page.navigate", { url: applicationUrl });
socket.close();
console.log(JSON.stringify({ reset: true }));
