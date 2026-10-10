export type AgentModelProvider = {
  id: "ollama" | "groq" | "dashscope";
  label: string;
  kind: "local" | "cloud";
  baseURL: string;
  model: string;
  apiKey: string;
  sendsRawRows: false;
};

type ProviderEnvironment = Record<string, string | undefined>;

function enabled(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function getAgentProviderCandidates(environment: ProviderEnvironment): AgentModelProvider[] {
  const providers: AgentModelProvider[] = [{
    id: "ollama",
    label: "本地 Ollama",
    kind: "local",
    baseURL: environment.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    model: environment.OLLAMA_MODEL ?? "qwen3:8b",
    apiKey: environment.OLLAMA_API_KEY ?? "ollama-local",
    sendsRawRows: false,
  }];
  const cloudOnly = environment.AGENT_PROVIDER_MODE === "cloud-only";
  if (!enabled(environment.AGENT_CLOUD_FALLBACK)) return cloudOnly ? [] : providers;
  if (environment.GROQ_API_KEY && environment.GROQ_MODEL) {
    providers.push({
      id: "groq",
      label: "Groq",
      kind: "cloud",
      baseURL: environment.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
      model: environment.GROQ_MODEL,
      apiKey: environment.GROQ_API_KEY,
      sendsRawRows: false,
    });
  }
  if (environment.DASHSCOPE_API_KEY && environment.DASHSCOPE_MODEL) {
    providers.push({
      id: "dashscope",
      label: "阿里云百炼 DashScope",
      kind: "cloud",
      baseURL: environment.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: environment.DASHSCOPE_MODEL,
      apiKey: environment.DASHSCOPE_API_KEY,
      sendsRawRows: false,
    });
  }
  return cloudOnly ? providers.filter((provider) => provider.kind === "cloud") : providers;
}
