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
import { useState } from "react";
import {
  classifyTool,
  outcomeTitle,
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

/**
 * Tool activity is listed row by row — no "N searches" summary wrapper. Each
 * row carries its own status, target and disclosure, so the reader scans the
 * actual calls instead of a count.
 *
 * The body is mounted only while a row is open: a long session holds dozens of
 * calls, and eagerly rendering every argument block, diff parse and output <pre>
 * made the timeline pay for evidence nobody had asked to see yet (dogfood F-214).
 */
export function WorkflowToolList({ tools }: { tools: TimelineTool[] }) {
  return (
    <div className="wf-tools">
      {tools.map((tool) => <ToolRow key={tool.key} tool={tool} />)}
    </div>
  );
}

function ToolRow({ tool }: { tool: TimelineTool }) {
  const category = classifyTool(tool.name);
  // Until the reader toggles, the row follows the call's live state: a running
  // call shows its progress, then folds away when it settles, and a failed call
  // reveals its error. A user toggle pins the choice (dogfood F-217/F-218/F-219).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const autoOpen = tool.running || tool.result?.isError === true;
  const open = userOpen ?? autoOpen;
  const hint = category === "outcome" ? outcomeTitle(tool) : toolHint(tool);
  return (
    <details
      className={`wf-tool${tool.result?.isError ? " is-error" : ""}`}
      open={open}
      onToggle={(event) => setUserOpen(event.currentTarget.open)}
    >
      <summary className="wf-tool-summary">
        <span className="wf-tool-icon"><CategoryIcon category={category} /></span>
        <ToolStatus tool={tool} />
        <span className="wf-tool-name">{tool.name}</span>
        {hint && <span className="wf-tool-hint" title={hint}>{hint}</span>}
        <span className="wf-tool-chevron" aria-hidden>›</span>
      </summary>
      {open && (
        <div className="wf-tool-body">
          <ToolResultView name={tool.name} args={tool.args} result={tool.result} running={tool.running} />
        </div>
      )}
    </details>
  );
}