"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, GitMerge, Play, RotateCcw, ShieldCheck, Table2 } from "lucide-react";
import {
  createJoinSpec,
  executeControlledJoin,
  executeJoinPipeline,
  previewJoin,
  validateJoinSpec,
  type JoinExecutionResult,
  type JoinPipelineResult,
  type JoinSpec,
  type JoinType,
} from "../lib/controlled-join";
import { createDatasetCatalog, profileRelationship, type RelationshipProfile } from "../lib/dataset-catalog";
import { profileRecords, type DatasetProfile } from "../lib/tabular-profile";
import { fieldDisplayName } from "../lib/field-label";

type Props = {
  profiles: DatasetProfile[];
  onUseJoinedProfile: (profile: DatasetProfile) => void;
};

type Confirmations = { key: boolean; relationship: boolean; grain: boolean; orphan: boolean; expansion: boolean };
const EMPTY_CONFIRMATIONS: Confirmations = { key: false, relationship: false, grain: false, orphan: false, expansion: false };

function baseName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function normalizedField(name: string) {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function relationshipExplanation(cardinality: string) {
  if (cardinality === "1:1") return "每条左表记录最多对应一条右表记录";
  if (cardinality === "N:1") return "多条左表记录可以对应同一条右表记录";
  if (cardinality === "1:N") return "一条左表记录可能展开为多条右表记录";
  return "左右两侧都可能重复，容易造成行数和金额膨胀";
}

export default function MultiTableJoin({ profiles, onUseJoinedProfile }: Props) {
  const catalog = useMemo(() => createDatasetCatalog(profiles.map((profile) => ({ profile, alias: baseName(profile.fileName) }))), [profiles]);
  const [leftTableId, setLeftTableId] = useState(catalog.tables[0]?.tableId ?? "");
  const [rightTableId, setRightTableId] = useState(catalog.tables[1]?.tableId ?? "");
  const leftTable = catalog.tables.find((table) => table.tableId === leftTableId) ?? catalog.tables[0];
  const rightTable = catalog.tables.find((table) => table.tableId === rightTableId) ?? catalog.tables.find((table) => table.tableId !== leftTable?.tableId);
  const common = leftTable && rightTable
    ? leftTable.profile.columns.find((left) => rightTable.profile.columns.some((right) => normalizedField(right.name) === normalizedField(left.name)))?.name ?? ""
    : "";
  const initialRightCommon = rightTable?.profile.columns.find((column) => normalizedField(column.name) === normalizedField(common))?.name ?? common;
  const [leftField, setLeftField] = useState(common || leftTable?.profile.columns[0]?.name || "");
  const [rightField, setRightField] = useState(initialRightCommon || rightTable?.profile.columns[0]?.name || "");
  const [leftField2, setLeftField2] = useState("");
  const [rightField2, setRightField2] = useState("");
  const [joinType, setJoinType] = useState<JoinType>("left");
  const [intendedGrainTableId, setIntendedGrainTableId] = useState(leftTable?.tableId ?? "");
  const [grainDescription, setGrainDescription] = useState("");
  const [confirmations, setConfirmations] = useState<Confirmations>(EMPTY_CONFIRMATIONS);
  const [result, setResult] = useState<JoinExecutionResult | null>(null);
  const [savedSpecs, setSavedSpecs] = useState<JoinSpec[]>([]);
  const [pipelineResult, setPipelineResult] = useState<JoinPipelineResult | null>(null);
  const [error, setError] = useState("");

  const pipelineStep = savedSpecs.length + 1;
  const includedTableIds = useMemo(() => {
    if (!savedSpecs.length) return new Set<string>();
    return new Set([savedSpecs[0].leftTableId, savedSpecs[0].rightTableId]);
  }, [savedSpecs]);
  const remainingTable = savedSpecs.length
    ? catalog.tables.find((table) => !includedTableIds.has(table.tableId))
    : null;

  function resetDecision() {
    setConfirmations(EMPTY_CONFIRMATIONS);
    setResult(null);
    setPipelineResult(null);
    setError("");
  }

  const relationship = useMemo(() => {
    if (!leftTable || !rightTable || leftTable.tableId === rightTable.tableId || !leftField || !rightField) return null;
    try {
      return profileRelationship(catalog, {
        leftTableId: leftTable.tableId,
        rightTableId: rightTable.tableId,
        leftFields: leftField2 && rightField2 ? [leftField, leftField2] : [leftField],
        rightFields: leftField2 && rightField2 ? [rightField, rightField2] : [rightField],
      });
    } catch {
      return null;
    }
  }, [catalog, leftTable, rightTable, leftField, rightField, leftField2, rightField2]);

  const spec = useMemo(() => {
    if (!relationship) return null;
    const draft = createJoinSpec(catalog, relationship, { joinType, intendedGrainTableId, intendedGrainDescription: grainDescription });
    return {
      ...draft,
      keyMeaningConfirmed: confirmations.key,
      relationshipConfirmed: confirmations.relationship,
      grainConfirmed: confirmations.grain,
      orphanRiskAcknowledged: confirmations.orphan,
      expansionRiskAcknowledged: confirmations.expansion,
      status: Object.values(confirmations).every(Boolean) ? "confirmed" as const : "draft" as const,
    };
  }, [catalog, relationship, joinType, intendedGrainTableId, grainDescription, confirmations]);
  const validation = spec ? validateJoinSpec(catalog, spec) : null;
  const preview = spec ? previewJoin(catalog, spec) : null;

  function selectCommonFields(nextLeftTableId: string, nextRightTableId: string, preferred?: RelationshipProfile) {
    const nextLeft = catalog.tables.find((table) => table.tableId === nextLeftTableId)!;
    const nextRight = catalog.tables.find((table) => table.tableId === nextRightTableId)!;
    const nextLeftField = preferred?.leftFields[0]
      ?? nextLeft.profile.columns.find((column) => nextRight.profile.columns.some((right) => normalizedField(right.name) === normalizedField(column.name)))?.name
      ?? nextLeft.profile.columns[0]?.name
      ?? "";
    const nextRightField = preferred?.rightFields[0]
      ?? nextRight.profile.columns.find((column) => normalizedField(column.name) === normalizedField(nextLeftField))?.name
      ?? nextRight.profile.columns[0]?.name
      ?? "";
    setLeftTableId(nextLeftTableId);
    setRightTableId(nextRightTableId);
    setLeftField(nextLeftField);
    setRightField(nextRightField);
    setLeftField2(preferred?.leftFields[1] ?? "");
    setRightField2(preferred?.rightFields[1] ?? "");
    setIntendedGrainTableId(preferred?.cardinality === "1:N" ? nextRightTableId : nextLeftTableId);
    setJoinType(preferred?.cardinality === "1:N" ? "inner" : "left");
    setConfirmations(EMPTY_CONFIRMATIONS);
    setResult(null);
    setPipelineResult(null);
    setError("");
  }

  function changeLeft(tableId: string) {
    const allowedRight = savedSpecs.length
      ? remainingTable
      : (tableId === rightTableId ? catalog.tables.find((table) => table.tableId !== tableId) : rightTable);
    if (!allowedRight) return;
    selectCommonFields(tableId, allowedRight.tableId);
  }

  function changeRight(tableId: string) {
    if (savedSpecs.length) return;
    selectCommonFields(leftTable.tableId, tableId);
  }

  function execute() {
    if (!spec || !validation?.valid) return;
    try {
      if (savedSpecs.length) {
        setPipelineResult(executeJoinPipeline(catalog, [...savedSpecs, spec]));
        setResult(null);
      } else {
        setResult(executeControlledJoin(catalog, spec));
        setPipelineResult(null);
      }
      setError("");
    } catch (caught) {
      setResult(null);
      setPipelineResult(null);
      setError(caught instanceof Error ? caught.message : "关联执行失败。");
    }
  }

  function bridgeCandidates(firstSpec: JoinSpec, thirdTableId: string) {
    const included = [firstSpec.leftTableId, firstSpec.rightTableId];
    const third = catalog.tables.find((table) => table.tableId === thirdTableId)!;
    return included.flatMap((includedId) => {
      const source = catalog.tables.find((table) => table.tableId === includedId)!;
      return source.profile.columns.flatMap((leftColumn) => third.profile.columns
        .filter((rightColumn) => normalizedField(rightColumn.name) === normalizedField(leftColumn.name))
        .map((rightColumn) => {
          try {
            return profileRelationship(catalog, {
              leftTableId: source.tableId,
              rightTableId: third.tableId,
              leftFields: [leftColumn.name],
              rightFields: [rightColumn.name],
            });
          } catch {
            return null;
          }
        })
        .filter((candidate): candidate is RelationshipProfile => candidate !== null));
    }).sort((left, right) => {
      const leftScore = (left.blockedByDefault ? 100 : 0) + left.leftOrphanRows + left.rightOrphanRows - left.leftRowCoverage;
      const rightScore = (right.blockedByDefault ? 100 : 0) + right.leftOrphanRows + right.rightOrphanRows - right.leftRowCoverage;
      return leftScore - rightScore;
    });
  }

  function continueWithThirdTable() {
    if (!spec || !validation?.valid || !result || profiles.length !== 3) return;
    const third = catalog.tables.find((table) => table.tableId !== spec.leftTableId && table.tableId !== spec.rightTableId);
    if (!third) return;
    const recommended = bridgeCandidates(spec, third.tableId)[0];
    const nextLeftId = recommended?.leftTableId ?? spec.leftTableId;
    setSavedSpecs([spec]);
    selectCommonFields(nextLeftId, third.tableId, recommended);
    setGrainDescription("");
  }

  function resetPipeline() {
    setSavedSpecs([]);
    const first = catalog.tables[0];
    const second = catalog.tables[1];
    if (first && second) selectCommonFields(first.tableId, second.tableId);
    setGrainDescription("");
  }

  function useResult() {
    const records = pipelineResult?.records ?? result?.records;
    if (!records?.length || !leftTable || !rightTable) return;
    const usedProfiles = pipelineResult ? profiles : profiles.filter((profile) => [leftTable.profile.fileName, rightTable.profile.fileName].includes(profile.fileName));
    const fileName = `${usedProfiles.map((profile) => baseName(profile.fileName)).join("-")}-joined.csv`;
    const joined = profileRecords(records, {
      fileName,
      fileSize: JSON.stringify(records).length,
      fileType: "CSV",
      sheetNames: ["关联结果"],
      activeSheet: "关联结果",
    });
    onUseJoinedProfile({
      ...joined,
      joinAmountReconciliations: pipelineResult?.amountReconciliations ?? result?.amountReconciliations ?? [],
    });
  }

  if (profiles.length < 2 || !leftTable || !rightTable) return (
    <div className="join-empty"><GitMerge size={22} /><div><strong>请先添加第二张表</strong><p>左侧“添加关联表”最多可再上传两张 Excel/CSV。</p></div></div>
  );

  const activeRecords = pipelineResult?.records ?? result?.records ?? [];
  const activeChecks = pipelineResult?.checks ?? result?.checks ?? [];
  const activeReconciliations = pipelineResult?.amountReconciliations ?? result?.amountReconciliations ?? [];

  return (
    <div className="join-workbench">
      <div className="join-intro"><div><span>受控多表关联</span><h3>先验证键、关系与粒度，再允许合并</h3><p>最多 3 张表；支持等值单键/双字段复合键、left/inner；N:N 默认禁止。</p></div><span className="engine-badge"><GitMerge size={14} />浏览器本地关联引擎</span></div>

      {profiles.length === 3 && (
        <section className="join-pipeline-status" aria-label="三表关联进度">
          <div className={pipelineStep === 1 ? "active" : "done"}><span>1</span><strong>确认第一条关系</strong><small>{savedSpecs.length ? "已锁定" : "当前步骤"}</small></div>
          <div className={pipelineResult ? "done" : pipelineStep === 2 ? "active" : "pending"}><span>2</span><strong>连接第三张表</strong><small>{pipelineResult ? "已完成" : pipelineStep === 2 ? "当前步骤" : "等待步骤 1"}</small></div>
          <div className={pipelineResult ? "done" : "pending"}><span>3</span><strong>整体结果校验</strong><small>{pipelineResult ? "已通过" : "尚未执行"}</small></div>
          {savedSpecs.length > 0 && <button type="button" onClick={resetPipeline}><RotateCcw size={13} />重新规划</button>}
        </section>
      )}

      {savedSpecs.length > 0 && (
        <section className="join-saved-step">
          <Check size={15} />
          <div><strong>步骤 1 已锁定</strong><p>{catalog.tables.find((table) => table.tableId === savedSpecs[0].leftTableId)?.alias} → {catalog.tables.find((table) => table.tableId === savedSpecs[0].rightTableId)?.alias}，{savedSpecs[0].expectedCardinality}，{savedSpecs[0].joinType.toUpperCase()} JOIN</p></div>
          <span>当前请选择已进入数据集的桥接表，与“{remainingTable?.alias}”建立第二条关系。</span>
        </section>
      )}

      <section className="join-config">
        <div className="execution-section-title"><strong>{pipelineStep}. 选择表与关联键</strong><span>{savedSpecs.length ? "第二步左表必须来自已关联的数据集" : "不会仅凭字段名自动执行"}</span></div>
        <div className="join-grid">
          <label><span>左表 *</span><select aria-label="关联左表" value={leftTable.tableId} onChange={(event) => changeLeft(event.target.value)}>{catalog.tables.filter((table) => !savedSpecs.length || includedTableIds.has(table.tableId)).map((table) => <option value={table.tableId} key={table.tableId}>{table.alias}</option>)}</select></label>
          <label><span>右表 *</span><select aria-label="关联右表" value={rightTable.tableId} onChange={(event) => changeRight(event.target.value)} disabled={savedSpecs.length > 0}>{catalog.tables.filter((table) => table.tableId !== leftTable.tableId && (!savedSpecs.length || table.tableId === remainingTable?.tableId)).map((table) => <option value={table.tableId} key={table.tableId}>{table.alias}</option>)}</select></label>
          <label><span>关联类型 *</span><select aria-label="关联类型" value={joinType} onChange={(event) => { setJoinType(event.target.value as JoinType); resetDecision(); }}><option value="left">Left join</option><option value="inner">Inner join</option></select></label>
          <label><span>左键 *</span><select aria-label="左关联键" value={leftField} onChange={(event) => { setLeftField(event.target.value); resetDecision(); }}>{leftTable.profile.columns.map((column) => <option value={column.name} key={column.name}>{fieldDisplayName(column.name)}</option>)}</select></label>
          <label><span>右键 *</span><select aria-label="右关联键" value={rightField} onChange={(event) => { setRightField(event.target.value); resetDecision(); }}>{rightTable.profile.columns.map((column) => <option value={column.name} key={column.name}>{fieldDisplayName(column.name)}</option>)}</select></label>
          <label><span>输出粒度所属表 *</span><select aria-label="输出粒度表" value={intendedGrainTableId} onChange={(event) => { setIntendedGrainTableId(event.target.value); resetDecision(); }}><option value={leftTable.tableId}>{leftTable.alias}</option><option value={rightTable.tableId}>{rightTable.alias}</option></select></label>
          <label><span>左复合键（可选）</span><select aria-label="左复合键" value={leftField2} onChange={(event) => { setLeftField2(event.target.value); resetDecision(); }}><option value="">不使用</option>{leftTable.profile.columns.filter((column) => column.name !== leftField).map((column) => <option value={column.name} key={column.name}>{fieldDisplayName(column.name)}</option>)}</select></label>
          <label><span>右复合键（可选）</span><select aria-label="右复合键" value={rightField2} onChange={(event) => { setRightField2(event.target.value); resetDecision(); }}><option value="">不使用</option>{rightTable.profile.columns.filter((column) => column.name !== rightField).map((column) => <option value={column.name} key={column.name}>{fieldDisplayName(column.name)}</option>)}</select></label>
          <label className="join-grain-description"><span>关联后每一行代表什么 *</span><input aria-label="关联后粒度说明" value={grainDescription} onChange={(event) => { setGrainDescription(event.target.value); resetDecision(); }} placeholder={savedSpecs.length ? "例如：附加区域属性后仍是一行一订单" : "例如：一行仍代表一笔订单"} /></label>
        </div>
      </section>

      {relationship && preview && (
        <section className="join-profile">
          <div className="execution-section-title"><strong>审核第 {pipelineStep} 步关联画像</strong><span>{relationship.cardinality}</span></div>
          <div className="join-stats">
            <div><span>关系类型</span><strong>{relationship.cardinality}</strong></div>
            <div><span>{savedSpecs.length ? "桥接表覆盖率" : "左表覆盖率"}</span><strong>{(relationship.leftRowCoverage * 100).toFixed(1)}%</strong></div>
            <div><span>左/右孤儿行</span><strong>{relationship.leftOrphanRows} / {relationship.rightOrphanRows}</strong></div>
            <div><span>{savedSpecs.length ? "桥接表预览行" : "预计输出行"}</span><strong>{preview.estimatedOutputRows}</strong></div>
            <div><span>预计膨胀</span><strong>{preview.estimatedExpansion.toFixed(2)}x</strong></div>
          </div>
          {relationship.warnings.map((warning) => <p className="execution-warning" key={warning}><AlertCircle size={13} />{warning}</p>)}
          {savedSpecs.length > 0 && <p className="join-preview-scope"><AlertCircle size={13} />本步骤画像基于原始桥接表；最终订单粒度行数会在完整三表管线执行后重新校验。</p>}
        </section>
      )}

      {relationship && (
        <section className="join-confirmations">
          <div className="execution-section-title"><strong>人工确认第 {pipelineStep} 步</strong><span>确认业务语义，不只是字段同名</span></div>
          {([
            ["key", `我确认两列都表示同一种业务对象：${fieldDisplayName(leftField)} ↔ ${fieldDisplayName(rightField)}。`],
            ["relationship", `我确认 ${relationship.cardinality} 的含义：${relationshipExplanation(relationship.cardinality)}。`],
            ["grain", `我确认关联后每一行仍表示：${grainDescription || "尚未填写"}。`],
            ["orphan", `我知晓有 ${relationship.leftOrphanRows} 行左表记录无法匹配；${joinType === "left" ? "Left join 会保留这些记录" : "Inner join 会排除这些记录"}。`],
            ["expansion", `我知晓预计行数为原来的 ${relationship.estimatedLeftJoinExpansion.toFixed(2)} 倍；若超过 1 倍，金额可能被重复累计。`],
          ] as Array<[keyof Confirmations, string]>).map(([key, label]) => <label key={key}><input type="checkbox" checked={confirmations[key]} onChange={(event) => { setConfirmations((current) => ({ ...current, [key]: event.target.checked })); setResult(null); setPipelineResult(null); }} /><ShieldCheck size={14} /><span>{label}</span></label>)}
        </section>
      )}

      {validation && !validation.valid && <div className="join-errors"><AlertCircle size={15} /><div><strong>尚不能执行关联</strong><p>{validation.errors.join("；")}</p></div></div>}
      {error && <div className="execution-error"><AlertCircle size={14} />{error}</div>}
      <div className="execution-approval"><div><strong>原始文件保持不变</strong><span>{savedSpecs.length ? "执行时将复用已确认的步骤 1，并对两步关联整体复核。" : "关联结果只在浏览器生成派生数据，不覆盖上传文件。"}</span></div><button type="button" disabled={!validation?.valid} onClick={execute}><Play size={15} />{savedSpecs.length ? "批准并执行三表关联" : "批准并执行关联"}</button></div>

      {(result || pipelineResult) && (
        <section className="join-result">
          <div className="join-result-heading"><div><Check size={15} /><span><strong>{pipelineResult ? "三表关联完成并通过校验" : "关联完成并通过校验"}</strong><small>{pipelineResult ? `${pipelineResult.steps.map((step) => `${step.beforeRows}→${step.afterRows}`).join("，")}；最终 ${pipelineResult.records.length} 行` : `${result!.sourceRows.left} + ${result!.sourceRows.right} 源行 → ${result!.outputRows} 结果行`}</small></span></div><button type="button" onClick={useResult}><Table2 size={14} />将关联结果用于分析</button></div>
          {pipelineResult && <div className="pipeline-step-results">{pipelineResult.steps.map((step, index) => <div key={step.joinSpecId}><span>步骤 {index + 1}</span><strong>{step.beforeRows} → {step.afterRows} 行</strong><small>匹配输出 {step.matchedOutputRows}，未匹配左表行 {step.unmatchedLeftRows}</small></div>)}</div>}
          {activeReconciliations.length > 0 && (
            <div className="join-reconciliation" aria-label="关联金额对账">
              <div className="execution-section-title"><strong>金额字段对账</strong><span>按来源记录追踪，而不是只比较结果行数</span></div>
              <div className="join-reconciliation-list">
                {activeReconciliations.map((item) => (
                  <article className={item.status === "balanced" ? "balanced" : "at-risk"} key={item.qualifiedField}>
                    <div><strong>{item.qualifiedField}</strong><span>{item.status === "balanced" ? "金额守恒" : item.status === "duplicated" ? "存在重复累计" : item.status === "excluded" ? "存在范围损失" : "重复与排除同时存在"}</span></div>
                    <dl>
                      <div><dt>源表合计</dt><dd>{item.sourceTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}</dd></div>
                      <div><dt>关联后合计</dt><dd>{item.outputTotal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}</dd></div>
                      <div><dt>净差额</dt><dd>{item.netDelta.toLocaleString("zh-CN", { maximumFractionDigits: 4, signDisplay: "always" })}</dd></div>
                      <div><dt>重复/排除源行</dt><dd>{item.duplicatedSourceRows} / {item.excludedSourceRows}</dd></div>
                    </dl>
                    {item.status !== "balanced" && <p><AlertCircle size={13} />该字段进入派生数据后会携带风险标记，后续求和或求平均将被确定性规则阻止。</p>}
                  </article>
                ))}
              </div>
            </div>
          )}
          <div className="execution-checks">{activeChecks.map((check) => <div className={check.passed ? "passed" : "failed"} key={check.label}><Check size={13} /><span>{check.label}</span><strong>{check.passed ? "通过" : "失败"}</strong></div>)}</div>
          <div className="join-preview-table"><table><thead><tr>{Object.keys(activeRecords[0] ?? {}).slice(0, 10).map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>{activeRecords.slice(0, 5).map((record, index) => <tr key={index}>{Object.keys(activeRecords[0] ?? {}).slice(0, 10).map((field) => <td key={field}>{record[field] instanceof Date ? record[field].toISOString().slice(0, 10) : String(record[field] ?? "")}</td>)}</tr>)}</tbody></table></div>
          {result && profiles.length === 3 && !savedSpecs.length && <div className="pipeline-continue"><div><strong>还剩 1 张表未关联</strong><span>保存本步骤后，Agent 会推荐可用桥接键；第二步仍需重新确认。</span></div><button type="button" onClick={continueWithThirdTable}><GitMerge size={14} />保存步骤 1，继续第三表</button></div>}
        </section>
      )}
    </div>
  );
}
