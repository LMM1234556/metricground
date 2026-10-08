import WebSocket from "ws";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const projectRoot = path.resolve("..");
const references = JSON.parse(await readFile(path.join(projectRoot, "evaluation/reference_metrics.json"), "utf8"));
const datasets = [
  {
    id: "sales_orders", file: "orders_quality_sample.csv", rows: 11, columns: 5, missing: 2,
    quality: ["完全重复", "无法识别", "统计异常值"], entity: "order_id", value: "amount", ratioField: "region", ratioValue: "华东",
  },
  {
    id: "marketing_customers", file: "marketing_customers_sample.csv", rows: 10, columns: 6, missing: 2,
    quality: ["完全重复", "无法识别", "统计异常值"], entity: "customer_id", value: "spend", ratioField: "exposed", ratioValue: "1",
  },
  {
    id: "inventory_operations", file: "inventory_operations_sample.csv", rows: 10, columns: 5, missing: 2,
    quality: ["完全重复", "无法识别", "统计异常值"], entity: "sku", value: "stock_qty", ratioField: "warehouse", ratioValue: "WH-2",
  },
];

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
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
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
  let timeout;
  try {
    const response = await Promise.race([
      command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Browser evaluation timed out after 120 seconds")), 120_000);
      }),
    ]);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

await command("Runtime.enable");
await command("Page.bringToFront");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1500));
const observed = [];

for (const dataset of datasets) {
  console.log(`[workbench] ${dataset.id}: loading ${dataset.file}`);
  await command("Page.bringToFront");
  const input = await command("Runtime.evaluate", { expression: 'document.querySelector(\'input[type="file"]\')', returnByValue: false });
  await command("DOM.setFileInputFiles", {
    objectId: input.result.objectId,
    files: [path.join(projectRoot, "evaluation", "fixtures", dataset.file)],
  });
  const result = await evaluate(`(async () => {
    const config = ${JSON.stringify(dataset)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const mark = (step) => { window.__metricgroundEvaluationStep = config.id + ':' + step; };
    const waitFor = async (predicate, description, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        const error = document.querySelector('.execution-error')?.textContent?.trim();
        if (error) throw new Error(description + ' failed: ' + error);
        if (Date.now() > deadline) throw new Error('Timed out waiting for ' + description + ' at ' + window.__metricgroundEvaluationStep);
        await sleep(80);
      }
    };
    mark('dataset-loaded');
    const deadline = Date.now() + 15000;
    while (!document.querySelector('.dataset-status')?.textContent.includes(config.file)) {
      if (Date.now() > deadline) throw new Error('Timed out loading ' + config.file);
      await sleep(80);
    }
    const clickByText = (selector, text) => {
      const node = [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));
      if (!node) throw new Error('Cannot find: ' + text);
      node.click();
    };
    const setText = (name, value) => {
      const node = document.querySelector('[name="' + name + '"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setSelect = (name, value) => {
      const node = document.querySelector('select[name="' + name + '"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(node, value);
      node.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const numericResult = () => {
      const text = document.querySelector('.execution-result-main strong')?.textContent.trim() ?? '';
      return text.endsWith('%') ? Number(text.replace('%', '')) / 100 : Number(text.replaceAll(',', ''));
    };

    const profileStats = [...document.querySelectorAll('.profile-stats strong')].map((item) => Number(item.textContent.replaceAll(',', '')));
    clickByText('.profile-tabs button', '质量检查');
    await sleep(50);
    const qualityTitles = [...document.querySelectorAll('.quality-issue h3')].map((item) => item.textContent.trim());
    clickByText('.profile-tabs button', '清洗方案');
    await sleep(50);
    [...document.querySelectorAll('.cleaning-option input')].forEach((checkbox) => { if (!checkbox.checked) checkbox.click(); });
    await sleep(60);
    document.querySelector('.cleaning-second-confirm input').click();
    await sleep(30);
    clickByText('.cleaning-submit-row button', '二次确认');
    mark('cleaning');
    await waitFor(
      () => document.querySelector('.dataset-status')?.textContent.includes('-cleaned.csv'),
      'cleaned dataset',
    );
    const cleanedRows = Number(document.querySelector('.dataset-status').textContent.match(/(\\d+) 行/)?.[1]);

    async function calculate(typeLabel, metricType) {
      const metricName = config.id + '-' + metricType;
      mark('contract-' + metricType);
      clickByText('.profile-tabs button', '指标口径');
      await sleep(40);
      clickByText('.metric-type-grid button', typeLabel);
      await sleep(30);
      setText('metricName', metricName);
      setText('decisionQuestion', '验证跨业务数据的指标结果');
      setSelect('entityField', config.entity);
      if (metricType === 'amount' || metricType === 'average') setSelect('valueField', config.value);
      if (metricType === 'ratio') {
        setText('numeratorDefinition', config.ratioField + ' 等于 ' + config.ratioValue);
        setText('denominatorDefinition', '全部非空业务对象');
      }
      [...document.querySelectorAll('.contract-confirmations input')].forEach((checkbox) => { if (!checkbox.checked) checkbox.click(); });
      clickByText('.contract-submit-row button', '生成并确认');
      await waitFor(
        () => document.querySelector('.metric-contract-output')?.textContent.includes(metricName),
        'metric contract ' + metricName,
      );
      clickByText('.profile-tabs button', '计算执行');
      await waitFor(
        () => [...document.querySelectorAll('.execution-approval button')].some((item) => item.textContent.includes('批准并执行')),
        'execution plan ' + metricName,
      );
      if (metricType === 'ratio') {
        const rules = document.querySelectorAll('.execution-rule');
        const numerator = rules[1];
        const selects = numerator.querySelectorAll('select');
        const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        selectSetter.call(selects[0], config.ratioField);
        selects[0].dispatchEvent(new Event('change', { bubbles: true }));
        const input = numerator.querySelector('input[placeholder="输入比较值"]');
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        inputSetter.call(input, config.ratioValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(30);
        document.querySelector('.execution-ratio-confirmation input')?.click();
        await sleep(20);
      }
      await waitFor(
        () => {
          const button = [...document.querySelectorAll('.execution-approval button')].find((item) => item.textContent.includes('批准并执行'));
          return button && !button.disabled;
        },
        'executable plan ' + metricName,
      );
      mark('execute-' + metricType);
      clickByText('.execution-approval button', '批准并执行');
      await waitFor(
        () => {
          const result = document.querySelector('.execution-result-main');
          const independent = document.querySelector('.independent-verification.passed');
          return result?.textContent.includes(metricName) && independent?.textContent.includes('已通过');
        },
        'validated result ' + metricName,
        60000,
      );
      return numericResult();
    }

    const metrics = {
      count: await calculate('计数指标', 'count'),
      amount: await calculate('金额/总量', 'amount'),
      average: await calculate('平均指标', 'average'),
      ratio: await calculate('比例指标', 'ratio'),
    };
    mark('complete');
    return { profileStats, qualityTitles, cleanedRows, metrics };
  })()`);
  observed.push({ dataset: dataset.id, ...result });
  console.log(`[workbench] ${dataset.id}: completed`);
}

const taskResults = [];
function record(id, dataset, category, expected, actual, passed) {
  taskResults.push({ id, dataset, category, expected, actual, passed });
}
for (const dataset of datasets) {
  const actual = observed.find((item) => item.dataset === dataset.id);
  record(`${dataset.id}-profile-rows`, dataset.id, "数据理解", dataset.rows, actual.profileStats[0], actual.profileStats[0] === dataset.rows);
  record(`${dataset.id}-profile-columns`, dataset.id, "数据理解", dataset.columns, actual.profileStats[1], actual.profileStats[1] === dataset.columns);
  record(`${dataset.id}-profile-missing`, dataset.id, "数据理解", dataset.missing, actual.profileStats[2], actual.profileStats[2] === dataset.missing);
  dataset.quality.forEach((keyword, index) => {
    const found = actual.qualityTitles.some((title) => title.includes(keyword));
    record(`${dataset.id}-quality-${index + 1}`, dataset.id, "质量检查", keyword, found ? keyword : "未发现", found);
  });
  const reference = references[dataset.id];
  for (const metric of ["count", "amount", "average", "ratio"]) {
    const expected = reference.metrics[metric];
    const value = actual.metrics[metric];
    const tolerance = metric === "ratio" ? 0.000051 : metric === "average" ? 0.011 : 0.001;
    const passed = Math.abs(value - expected) <= tolerance && actual.cleanedRows === reference.cleaned_rows;
    record(`${dataset.id}-metric-${metric}`, dataset.id, "受控计算", expected, value, passed);
  }
}

const passed = taskResults.filter((item) => item.passed).length;
const report = {
  generatedAt: new Date().toISOString(),
  referenceEngine: "pandas 3.0.2",
  executionEngine: "MetricGround browser-deterministic",
  taskCount: taskResults.length,
  passed,
  failed: taskResults.length - passed,
  passRate: passed / taskResults.length,
  runtimeErrors,
  tasks: taskResults,
};
await writeFile(path.join(projectRoot, "evaluation", "workbench-results-latest.json"), JSON.stringify(report, null, 2), "utf8");
const rows = taskResults.map((item) => `| ${item.id} | ${item.category} | ${item.passed ? "通过" : "失败"} | ${item.expected} | ${item.actual} |`).join("\n");
const markdown = `# MetricGround 通用工作台固定任务测评\n\n- 数据集：销售订单、客户营销、库存运营\n- 任务数：${report.taskCount}\n- 通过：${report.passed}\n- 失败：${report.failed}\n- 通过率：${(report.passRate * 100).toFixed(1)}%\n- 参考实现：独立 pandas 脚本\n- 产品实现：浏览器本地确定性引擎\n\n> 这是项目自建的小规模功能回归集，只证明下列固定任务通过，不代表覆盖所有公司或所有表格。\n\n| 任务 | 类别 | 结果 | 预期 | 实际 |\n|---|---|---:|---:|---:|\n${rows}\n`;
await writeFile(path.join(projectRoot, "evaluation", "workbench-report-latest.md"), markdown, "utf8");
console.log(JSON.stringify({ taskCount: report.taskCount, passed: report.passed, failed: report.failed, passRate: report.passRate, runtimeErrors }, null, 2));
socket.close();
if (report.failed > 0 || runtimeErrors.length > 0) process.exitCode = 1;
