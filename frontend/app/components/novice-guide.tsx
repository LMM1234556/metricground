"use client";

import { Check, ChevronRight, GraduationCap } from "lucide-react";

export type GuideStep = "upload" | "join" | "quality" | "define" | "execute" | "verify";

const BASE_STEPS: Array<{ id: GuideStep; label: string }> = [
  { id: "upload", label: "上传数据" },
  { id: "quality", label: "检查质量" },
  { id: "define", label: "明确口径" },
  { id: "execute", label: "执行分析" },
  { id: "verify", label: "验证结果" },
];

type Props = {
  step: GuideStep;
  title: string;
  description: string;
  actionLabel: string;
  detail?: string;
  templates?: string[];
  includeJoinStep?: boolean;
  completed?: boolean;
  onAction: () => void;
  onUseTemplate: (template: string) => void;
};

export default function NoviceGuide({
  step,
  title,
  description,
  actionLabel,
  detail,
  templates = [],
  includeJoinStep = false,
  completed = false,
  onAction,
  onUseTemplate,
}: Props) {
  const steps = includeJoinStep
    ? [BASE_STEPS[0], { id: "join" as const, label: "确认关联" }, ...BASE_STEPS.slice(1)]
    : BASE_STEPS;
  const activeIndex = steps.findIndex((item) => item.id === step);

  return (
    <section className="novice-guide" aria-label="新手分析向导">
      <div className="novice-guide-heading">
        <span className="novice-guide-icon"><GraduationCap size={18} /></span>
        <div><strong>新手引导</strong><span>系统只推荐当前最需要完成的一步</span></div>
      </div>

      <ol className="novice-steps">
        {steps.map((item, index) => {
          const state = completed || index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
          return (
            <li className={state} key={item.id} aria-current={state === "active" ? "step" : undefined}>
              <span>{state === "done" ? <Check size={12} /> : index + 1}</span>
              <strong>{item.label}</strong>
            </li>
          );
        })}
      </ol>

      <div className="novice-guide-body">
        <div>
          <span className="novice-guide-kicker">当前任务</span>
          <h2>{title}</h2>
          <p>{description}</p>
          {detail && <small>{detail}</small>}
        </div>
        <button type="button" onClick={onAction}>{actionLabel}<ChevronRight size={15} /></button>
      </div>

      {templates.length > 0 && (
        <div className="novice-templates">
          <span>可直接套用：</span>
          {templates.map((template) => (
            <button type="button" key={template} onClick={() => onUseTemplate(template)}>{template}</button>
          ))}
        </div>
      )}
    </section>
  );
}
