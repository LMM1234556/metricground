import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";
import { build } from "esbuild";

// Static React render checks accessibility and the initial confirmation surface.
// This does not claim browser interaction or visual-layout verification.
const bundle = await build({
  stdin: { contents: `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import BusinessAnalysis from './app/components/business-analysis';
    import { profileRows } from './app/lib/tabular-profile';
    const profile = profileRows([['order_id','region','status','amount'], ['A','East','已送达',100], ['B','East','已取消',200]],
      { fileName:'ratio-ui.csv',fileSize:100,fileType:'CSV',activeSheet:'CSV 数据',sheetNames:['CSV 数据'] });
    export const html = renderToStaticMarkup(<BusinessAnalysis profile={profile} agentPlan={null} question="比较不同地区的送货成功率" />);`,
    loader: "tsx", resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false, jsx: "automatic", logLevel: "silent",
});
const filename = path.resolve("scripts/.ratio-render.cjs");
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, filename);
const { html } = compiled.exports;
assert(html.includes('aria-label="分子状态字段"'));
assert(html.includes('aria-label="分子状态值"'));
assert(html.includes('aria-label="分母范围"'));
assert(html.includes('value="ratio" selected=""'));
assert(!html.includes('aria-label="数值字段"'));
assert(html.includes('请选择并核实状态含义'));
assert(html.includes('取消、在途及未知状态的订单也计入分母'));
assert(html.includes('批准并执行分析'));
assert(html.includes('disabled=""'));
console.log(JSON.stringify({ passed: true, initialRatioSelected: true, successRequiresSelection: true,
  denominatorExplained: true, amountFieldHidden: true, executionDisabledBeforeApproval: true, verificationScope: "React静态渲染，未执行浏览器交互" }));
