import WebSocket from "ws";
import { writeFile } from "node:fs/promises";

const targets = await fetch("http://127.0.0.1:9224/json/list").then((response) => response.json());
const target = targets.find((item) => item.url === "http://localhost:5173/");

if (!target) {
  throw new Error("MetricGround browser target not found");
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
const runtimeErrors = [];

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") {
    runtimeErrors.push(message.params.exceptionDetails.text);
  }
});

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

function command(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function clickQuestion(label) {
  return evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return { clicked: false };
    button.click();
    const deadline = Date.now() + 15000;
    while (
      document.querySelector('.question-context strong')?.textContent?.trim() !== ${JSON.stringify(label)}
      || document.querySelector('.confidence')?.textContent?.includes('分析中')
      || !document.querySelector('.answer-header small')?.textContent?.includes('本地模型选择分析工具')
    ) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for model routing');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      clicked: true,
      question: document.querySelector('.question-context strong')?.textContent?.trim(),
      metricCards: document.querySelectorAll('.metric-card').length,
      hasChart: Boolean(document.querySelector('.chart-card')),
      summary: document.querySelector('.answer-summary')?.textContent?.replace(/\s+/g, ' ').trim(),
      routeLabel: document.querySelector('.answer-header small')?.textContent?.trim(),
    };
  })()`);
}

async function capture(name) {
  const result = await command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(
    new URL(`../../runtime/${name}.png`, import.meta.url),
    Buffer.from(result.data, "base64"),
  );
}

async function submitCustomQuestion(question) {
  return evaluate(`(async () => {
    const input = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    ).set;
    setter.call(input, ${JSON.stringify(question)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    document.querySelector('button[type="submit"]').click();
    const deadline = Date.now() + 15000;
    while (
      document.querySelector('.question-context strong')?.textContent?.trim() !== ${JSON.stringify(question)}
      || document.querySelector('.confidence')?.textContent?.includes('分析中')
      || !document.querySelector('.answer-header small')?.textContent?.includes('本地模型选择分析工具')
    ) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for model routing');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      question: document.querySelector('.question-context strong')?.textContent?.trim(),
      metricCards: document.querySelectorAll('.metric-card').length,
      hasChart: Boolean(document.querySelector('.chart-card')),
      summary: document.querySelector('.answer-summary')?.textContent?.replace(/\s+/g, ' ').trim(),
      routeLabel: document.querySelector('.answer-header small')?.textContent?.trim(),
    };
  })()`);
}

await command("Runtime.enable");
await command("Page.enable");
await command("Emulation.setDeviceMetricsOverride", {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await evaluate("document.body.innerText.length > 0");

const overview = await clickQuestion("核心经营指标");
await capture("metricground-overview-analysis");
const trend = await clickQuestion("月度 GMV 趋势");
const category = await clickQuestion("品类 GMV 排名");
await capture("metricground-category-analysis");
const delivery = await clickQuestion("延迟配送与差评");
await capture("metricground-delivery-analysis");
const unsupported = await submitCustomQuestion("哪个卖家的退款率最高？");
const overlay = await evaluate(
  "Boolean(document.querySelector('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay'))",
);

const checks = {
  pageHasContent: await evaluate("document.body.innerText.trim().length > 100"),
  noErrorOverlay: !overlay,
  noRuntimeExceptions: runtimeErrors.length === 0,
  modelRoutingVisible:
    [overview, trend, category, delivery, unsupported]
      .every((state) => state.routeLabel?.includes("本地模型选择分析工具")),
  overviewRoutesCorrectly:
    overview.clicked && overview.metricCards === 4 && overview.hasChart === false,
  trendRoutesCorrectly:
    trend.clicked && trend.metricCards === 0 && trend.hasChart === true,
  categoryRoutesCorrectly:
    category.clicked && category.metricCards === 0 && category.hasChart === true
    && category.summary.includes("health_beauty"),
  deliveryRoutesCorrectly:
    delivery.clicked && delivery.metricCards === 0 && delivery.hasChart === true
    && delivery.summary.includes("54.11%") && delivery.summary.includes("观察性关联"),
  unsupportedRoutesCorrectly:
    unsupported.metricCards === 0
    && unsupported.hasChart === false
    && unsupported.summary.includes("不会用默认答案"),
};

console.log(JSON.stringify({ checks, states: { overview, trend, category, delivery, unsupported }, runtimeErrors }, null, 2));
socket.close();

if (Object.values(checks).some((passed) => !passed)) {
  process.exitCode = 1;
}
