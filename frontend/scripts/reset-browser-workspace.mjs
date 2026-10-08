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
const response = await command("Runtime.evaluate", {
  expression: `new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('metricground-workspace');
    request.onsuccess = () => resolve({ deleted: true });
    request.onerror = () => resolve({ deleted: false, error: request.error?.message ?? 'unknown' });
    request.onblocked = () => resolve({ deleted: false, error: 'blocked' });
  })`,
  awaitPromise: true,
  returnByValue: true,
});
if (!response.result.value?.deleted) throw new Error(`Workspace reset failed: ${response.result.value?.error ?? "unknown"}`);
await command("Page.reload", { ignoreCache: true });
socket.close();
console.log(JSON.stringify({ reset: true }));
