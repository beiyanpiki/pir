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
 */
export function WorkflowToolList({ tools }: { tools: TimelineTool[] }) {
  return (
    <div className="wf-tools">
      {tools.map((tool) => {
        const category = classifyTool(tool.name);
        const hint = toolHint(tool);
        return (
          <details className={`wf-tool${tool.result?.isError ? " is-error" : ""}`} key={tool.key} open={tool.running}>
            <summary className="wf-tool-summary">
              <span className="wf-tool-icon"><CategoryIcon category={category} /></span>
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
      })}
    </div>
  );
}
