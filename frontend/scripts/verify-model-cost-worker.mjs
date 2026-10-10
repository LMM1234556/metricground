import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";

// Run the real Worker runtime, not Node's fetch. The upstream is synthetic: no keys or paid network calls.
const built = await build({ stdin: { contents: `
  import { createBudgetedModelFetch } from './app/lib/model-cost-policy.ts';
  export default { async fetch() {
    const provider = { id:'dashscope', kind:'cloud', model:'qwen-plus', baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey:'fake', sendsRawRows:false };
    const results = {};
    for (const bound of [false, true]) {
      const receipts=[];
      const limiter=createBudgetedModelFetch({ provider, reserve:async()=>crypto.randomUUID(), record:async(row)=>{receipts.push(row)}, ...(bound ? { fetchImpl:globalThis.fetch.bind(globalThis) } : {}) });
      try {
        const response=await limiter(provider.baseURL+'/chat/completions',{method:'POST',body:JSON.stringify({model:'qwen-plus',messages:[]}),signal:new AbortController().signal});
        results[bound ? 'bound' : 'default']={ok:response.ok,receipts};
      } catch(error) { results[bound ? 'bound' : 'default']={ok:false,code:error.code,receipts}; }
    }
    const redirectReceipts=[];
    const rejected=createBudgetedModelFetch({provider,reserve:async()=>crypto.randomUUID(),record:async(row)=>redirectReceipts.push(row)});
    try { await rejected(provider.baseURL+'/chat/completions',{method:'POST',body:JSON.stringify({model:'qwen-plus',messages:[],simulateRedirect:true})}); results.redirect={blocked:false}; }
    catch(error) { results.redirect={blocked:error.code==='MODEL_REDIRECT_BLOCKED',receipts:redirectReceipts}; }
    return Response.json(results);
  }};`, resolveDir: resolve("."), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
let upstreamRequests = 0;
const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-05-15",
  outboundService: async (request) => {
    upstreamRequests++;
    const body=await request.json();
    assert.equal(body.max_tokens,512);
    assert.equal(body.enable_thinking,false);
    if(body.simulateRedirect) return new Response(null,{status:302,headers:{Location:'https://unapproved.example/'}});
    return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
  } });
try {
  const result = await mf.dispatchFetch("http://worker.test/").then((response) => response.json());
  console.log(JSON.stringify({ result, upstreamRequests, scope: "Real workerd runtime with synthetic upstream; no billable requests" }, null, 2));
  assert.equal(result.bound.ok, true);
  assert.equal(result.default.ok, true);
  assert.equal(result.redirect.blocked,true);
  assert.equal(upstreamRequests,3,"Redirect not followed; exact two success requests and one rejected redirect");
} finally { await mf.dispose(); }
