import { useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  DiffOutlined,
  FileTextOutlined,
  FlagOutlined,
  LoadingOutlined,
  SearchOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  classifyTool,
  outcomeTitle,
  toolGroupFailed,
  toolGroupRunning,
  toolGroupTitle,
  toolHint,
  type TimelineTool,
  type ToolCategory,
} from "../lib/workflow-timeline";
import { ToolResultView } from "./ToolResultView";

function CategoryIcon({ category }: { category: ToolCategory }) {
  if (category === "read") return <FileTextOutlined />;
  if (category === "search") return <SearchOutlined />;
  if (category === "memory") return <DatabaseOutlined />;
  if (category === "change") return <DiffOutlined />;
  if (category === "outcome") return <FlagOutlined />;
  return <ToolOutlined />;
}

function ToolStatus({ tool }: { tool: TimelineTool }) {
  if (tool.running) return <LoadingOutlined spin className="wf-tool-status is-running" />;
  if (tool.result?.isError) return <CloseCircleFilled className="wf-tool-status is-error" />;
  return <CheckCircleFilled className="wf-tool-status is-ok" />;
}

function ToolRow({ tool }: { tool: TimelineTool }) {
  const hint = toolHint(tool);
  return (
    <details className="wf-tool" open={tool.result?.isError === true || tool.running}>
      <summary className="wf-tool-summary">
        <ToolStatus tool={tool} />
        <span className="wf-tool-name">{tool.name}</span>
        {hint && <span className="wf-tool-hint" title={hint}>{hint}</span>}
        <span className="wf-tool-chevron" aria-hidden>›</span>
      </summary>
      <div className="wf-tool-body">
        <ToolResultView name={tool.name} args={tool.args} result={tool.result} running={tool.running} />
      </div>
    </details>
  );
}

/**
 * OpenCode-style grouped tool activity: one compact row per category, with the
 * individual calls and their outputs disclosed on demand. Failures and the
 * outcome tools (candidate/verdict/round) open themselves.
 */
export function WorkflowToolGroup({ tools }: { tools: TimelineTool[]; category: ToolCategory }) {
  const category = classifyTool(tools[0]?.name ?? "");
  const failed = toolGroupFailed(tools);
  const running = toolGroupRunning(tools);
  const autoOpen = failed || running;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Until the reader toggles, the group follows its live state (running,
  // failed, or an outcome artifact open themselves).
  const open = userOpen ?? autoOpen;

  const title = category === "outcome" && tools.length === 1 ? outcomeTitle(tools[0]!) : toolGroupTitle(tools);
  return (
    <section className={`wf-tools is-${category}${failed ? " has-error" : ""}`}>
      <button
        type="button"
        className="wf-tools-head"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <span className="wf-tools-icon"><CategoryIcon category={category} /></span>
        <span className="wf-tools-title">{title}</span>
        {running && <span className="wf-tools-state is-running">running</span>}
        {failed && <span className="wf-tools-state is-error">failed</span>}
        <span className={`wf-tools-chevron${open ? " is-open" : ""}`} aria-hidden>⌄</span>
      </button>
      {open && (
        <div className="wf-tools-body">
          {tools.map((tool) => <ToolRow key={tool.key} tool={tool} />)}
        </div>
      )}
    </section>
  );
}