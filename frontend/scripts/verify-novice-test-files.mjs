import path from "node:path";
import WebSocket from "ws";

const cases = [
  ["novice_test_p01.xlsx", 16],
  ["novice_test_p02.xlsx", 16],
  ["novice_test_p03.xlsx", 15],
  ["novice_test_p04.xlsx", 18],
  ["novice_test_p05.xlsx", 17],
].map(([file, rows]) => ({ file: path.resolve("../evaluation/novice_test_files", file), rows }));

const targets = await fetch("http://127.0.0.1:9224/json/list").then((response) => response.json());
const target = targets.find((item) => item.url === "http://localhost:5173/");
if (!target) throw new Error("MetricGround browser target not found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const runtimeErrors = [];
let requestId = 0;
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
});
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

function command(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

await command("Runtime.enable");
await command("DOM.enable");

const results = [];
for (const testCase of cases) {
  await command("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 8000;
    while (!document.querySelector('input[type=file]')) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for upload control');
      await sleep(60);
    }
  })()`);
  const input = await command("Runtime.evaluate", { expression: 'document.querySelector("input[type=file]")', returnByValue: false });
  if (!input.result.objectId) throw new Error("Upload input not found");
  await command("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [testCase.file] });
  await command("Runtime.callFunctionOn", {
    objectId: input.result.objectId,
    functionDeclaration: "function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }",
  });
  const pageState = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 10000;
    while (!document.body.innerText.includes(${JSON.stringify(path.basename(testCase.file))}) || !document.querySelector('.profile-card')) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for workbook profile');
      await sleep(80);
    }
    return {
      body: document.body.innerText.replace(/\\s+/g, ' '),
      profile: document.querySelector('.profile-card')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
    };
  })()`);
  results.push({
    file: path.basename(testCase.file),
    expectedRows: testCase.rows,
    fileVisible: pageState.body.includes(path.basename(testCase.file)),
    rowCountVisible: pageState.body.includes(`${testCase.rows} 行`),
    profileVisible: Boolean(pageState.profile),
  });
}

socket.close();
const checksPassed = results.every((item) => item.fileVisible && item.rowCountVisible && item.profileVisible) && runtimeErrors.length === 0;
console.log(JSON.stringify({ checksPassed, results, runtimeErrors }, null, 2));
if (!checksPassed) process.exitCode = 1;
