import assert from "node:assert/strict";
import { getAgentProviderCandidates } from "../app/lib/model-provider.ts";

const localOnly = getAgentProviderCandidates({});
assert.equal(localOnly.length, 1);
assert.equal(localOnly[0].id, "ollama");
assert.equal(localOnly[0].kind, "local");
assert.equal(localOnly[0].sendsRawRows, false);

const disabledCloud = getAgentProviderCandidates({ AGENT_CLOUD_FALLBACK: "false", GROQ_API_KEY: "secret", GROQ_MODEL: "configured-model" });
assert.equal(disabledCloud.length, 1, "云端未显式开启时不得使用 API Key");

const missingModel = getAgentProviderCandidates({ AGENT_CLOUD_FALLBACK: "true", GROQ_API_KEY: "secret" });
assert.equal(missingModel.length, 1, "未显式配置模型时不得猜测当前可用云模型");

const cloud = getAgentProviderCandidates({
  AGENT_CLOUD_FALLBACK: "true",
  GROQ_API_KEY: "groq-secret",
  GROQ_MODEL: "groq-configured-model",
  DASHSCOPE_API_KEY: "dash-secret",
  DASHSCOPE_MODEL: "dash-configured-model",
});
assert.deepEqual(cloud.map((provider) => provider.id), ["ollama", "groq", "dashscope"]);
assert(cloud.slice(1).every((provider) => provider.kind === "cloud" && provider.sendsRawRows === false));
assert.equal(cloud[1].baseURL, "https://api.groq.com/openai/v1");
assert.equal(cloud[2].baseURL, "https://dashscope.aliyuncs.com/compatible-mode/v1");

console.log(JSON.stringify({ checks: 10, defaultOrder: cloud.map((provider) => provider.id), localDefault: localOnly[0].model, cloudRequiresOptIn: true, rawRowsSent: false }, null, 2));
