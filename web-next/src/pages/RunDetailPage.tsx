import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Result,
  Row,
  Space,
  Statistic,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import { InfoCircleOutlined, LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { apiGet } from "../lib/api";
import { fmtCost, fmtCount, fmtDuration, relTime, shortSha } from "../lib/format";
import { useApi, useNow } from "../lib/hooks";
import { useQueryState } from "../lib/query";
import { sessionAnchor, workflowSessions } from "../lib/live-projection";
import { useLiveRun } from "../lib/use-live-run";
import { useLiveSessions } from "../lib/use-live-sessions";
import type { ActiveRunView, CoverageView, ProjectSummary, RunDetail, RunSummary } from "../lib/types";
import { ConnectionIndicator, ModeTag, RunStatusTag, VerdictTag } from "../components/StatusTags";
import { PageError, PageLoading } from "../components/PageState";
import { PageHeader } from "../components/PageHeader";
import { CopyButton } from "../components/CopyButton";
import { RunOverview } from "../components/RunOverview";
import { FindingsPanel } from "../components/FindingsPanel";
import { WorkflowPanel } from "../components/WorkflowPanel";
import { CoveragePanel } from "../components/CoveragePanel";
import { RunDetailsPanel } from "../components/RunDetailsPanel";

const TABS = ["overview", "findings", "workflow", "coverage", "details"] as const;
type Tab = (typeof TABS)[number];

function pickTab(raw: string): Tab {
  return (TABS as readonly string[]).includes(raw) ? (raw as Tab) : "overview";
}

interface Overview { projects: ProjectSummary[]; active: ActiveRunView[] }

export function RunDetailPage() {
  const { projectId = "", runId = "" } = useParams();
  const { get, update } = useQueryState({ tab: "overview" });
  const tab = pickTab(get("tab"));
  const findingId = get("finding") || null;
  const sessionParam = get("session") || null;
  const role = get("role") || "all";
  const sessionStatus = get("status") || "all";
  const sessionQuery = get("q") || "";

  const detail = useApi<RunDetail>((signal) => apiGet<RunDetail>(`/api/runs/${projectId}/${runId}`, signal), [projectId, runId]);
  const overview = useApi<Overview>((signal) => apiGet<Overview>("/api/overview", signal), [projectId]);
  const coverage = useApi<CoverageView>((signal) => apiGet<CoverageView>(`/api/runs/${projectId}/${runId}/coverage`, signal), [projectId, runId], { identity: [projectId, runId] });

  const run = detail.data?.run;
  const liveEnabled = Boolean(run && run.status === "running" && run.finishedAt === null)
    || Boolean(detail.data?.live !== undefined && detail.data.live !== null && detail.data.live.end === null);
  const live = useLiveRun({ projectId, runId, detail: detail.data, enabled: liveEnabled, reloadDetail: detail.reload });
  const liveSessions = useLiveSessions(live.events, `${projectId}/${runId}`);
  const workflow = useMemo(() => workflowSessions(live.events, detail.data?.sessions ?? []), [live.events, detail.data?.sessions]);
  const now = useNow(liveEnabled ? 1_000 : 0);
  const project = overview.data?.projects.find((candidate) => candidate.projectId === projectId);

  const projection = live.projection;
  const execution = projection.executionState !== "unknown" ? projection.executionState : run?.status ?? "unknown";
  const counts = projection.counts ?? detail.data?.live?.end?.counts ?? null;
  const rounds = Math.max(projection.round, counts?.rounds ?? 0, run?.rounds ?? 0);
  const confirmed = counts?.confirmed ?? run?.confirmed ?? 0;
  const rejected = counts?.rejected ?? run?.rejected ?? 0;
  const uncertain = counts?.uncertain ?? run?.uncertain ?? 0;
  const pending = counts?.pending ?? detail.data?.manifest?.rounds?.at(-1)?.pending ?? null;
  const duration = run
    ? projection.end?.durationMs
      ?? (liveEnabled ? Math.max(0, now - run.startedAt) : run.durationMs ?? (run.finishedAt ? run.finishedAt - run.startedAt : null))
    : null;
  const projectedRun: RunSummary | null = run
    ? {
        ...run,
        status: execution,
        confirmed,
        rejected,
        uncertain,
        rounds,
        candidates: counts?.candidates ?? run.candidates,
        incomplete: projection.end ? projection.end.status === "incomplete" : run.incomplete,
        stoppedBecause: projection.end?.stoppedBecause ?? run.stoppedBecause,
        durationMs: projection.end?.durationMs ?? duration,
        totalTokens: projection.end?.usage?.totalTokens ?? run.totalTokens,
        cost: projection.end?.usage?.cost ?? run.cost,
      }
    : null;
  const projectedDetail: RunDetail | null = detail.data && projectedRun ? { ...detail.data, run: projectedRun } : null;

  const selectedSessionKey = useMemo(() => {
    if (!sessionParam) return null;
    const match = workflow.find((session) =>
      session.aliases.includes(sessionParam) || session.key === sessionParam || session.file === sessionParam,
    );
    return match?.key ?? sessionParam;
  }, [sessionParam, workflow]);

  // Selecting a session in the evidence drawer or the rail must land on the
  // exact card, including after a live replay has re-keyed the same session.
  useEffect(() => {
    if (tab !== "workflow" || !selectedSessionKey) return;
    const timer = setTimeout(() => {
      document.getElementById(sessionAnchor(selectedSessionKey))?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 80);
    return () => clearTimeout(timer);
  }, [tab, selectedSessionKey, workflow.length]);

  const openTab = (next: Tab): void => {
    update({ tab: next, ...(next === "findings" ? {} : { finding: null }), ...(next === "workflow" ? {} : { session: null }) });
  };
  const openFinding = (displayId: string): void => {
    update({ tab: "findings", finding: displayId });
  };
  const openSession = (key: string): void => {
    const match = workflow.find((session) => session.aliases.includes(key) || session.key === key || session.file === key);
    update({ tab: "workflow", session: match?.key ?? key });
  };

  const refreshAll = (): void => {
    detail.reload();
    overview.reload();
    coverage.reload();
  };

  if (detail.loading && !detail.data) return <PageLoading label="Loading review run…" />;
  if (detail.error && !detail.data) return <PageError error={detail.error} status={detail.errorStatus} onRetry={detail.reload} />;
  if (!detail.data || !run || !projectedRun || !projectedDetail) {
    return <Result status="404" title="Run not found" subTitle="This review run is no longer available." extra={<Link to={`/projects/${projectId}`}>Back to the project</Link>} />;
  }

  const latestProgress = (live.events ?? []).filter((event) => event.kind === "progress").at(-1);
  const running = execution === "running";
  const title = run.base
    ? `${shortSha(run.base, 8)}…${shortSha(run.head, 8)}`
    : `Snapshot ${shortSha(run.head, 10)}`;
  const verdict = projectedRun.runVerdict ?? detail.data.manifest?.runVerdict ?? "unknown";
  const reportedFindings = detail.data.findings.items.filter((finding) => finding.status === "confirmed" || finding.status === "uncertain").length;
  const coveragePercent = coverage.data?.available
    ? coverage.data.mode === "change"
      ? (coverage.data.summary.hunksTotal > 0 ? Math.round((coverage.data.summary.hunksCovered / coverage.data.summary.hunksTotal) * 100) : null)
      : (coverage.data.summary.filesInScope > 0 ? Math.round((coverage.data.summary.filesReviewed / coverage.data.summary.filesInScope) * 100) : null)
    : null;
  const connectionNote = running && live.connection !== "open" && live.connection !== "connecting";
  const phaseLabel = projection.end
    ? projection.end.status === "completed" ? "Review finished" : `Review ${projection.end.status}`
    : projection.phase === "done" ? "Review finished"
    : running ? (latestProgress?.kind === "progress" ? `In progress · ${latestProgress.phase}` : "Review in progress")
    : execution === "completed" ? (verdict !== "unknown" ? `Review finished · ${verdict}` : "Review finished")
    : execution === "incomplete" ? "Review incomplete"
    : execution === "failed" ? "Review failed"
    : "Review state unavailable";

  return (
    <div>
      <PageHeader
        breadcrumb={[
          { title: "Projects", to: "/projects" },
          { title: project?.name ?? projectId.slice(0, 12), to: `/projects/${projectId}` },
          { title } ,
        ]}
        eyebrow={project?.name ?? "Review run"}
        title={<Tooltip title={`${run.base ?? "snapshot"} → ${run.head}`}><span>{title}</span></Tooltip>}
        subtitle={
          <Space size={8} wrap>
            <ModeTag mode={run.mode} />
            <RunStatusTag status={execution} />
            {running ? <Tag color="processing">Verdict pending</Tag> : <VerdictTag verdict={verdict} />}
            <span>Started {relTime(run.startedAt)}</span>
            <span>· {run.runId.slice(0, 8)}</span>
          </Space>
        }
        actions={
          <Space>
            {liveEnabled && <ConnectionIndicator status={live.connection} />}
            <Tooltip title="Refresh run, coverage and project state"><Button icon={<ReloadOutlined />} loading={detail.loading} onClick={refreshAll} aria-label="Refresh run" /></Tooltip>
            <CopyButton text={window.location.href} label="Copy link" icon={<LinkOutlined />} />
          </Space>
        }
      />

      <Card size="small" className="pir-run-summary" style={{ marginBottom: 16 }}>
        <div className="pir-summary-headline">
          <div>
            <div className="pir-sider-label" style={{ padding: 0 }}>Current phase / conclusion</div>
            <h2 className="pir-summary-title">{phaseLabel}</h2>
          </div>
          <Space wrap>
            <Button size="small" onClick={() => openTab("workflow")}>Open workflow</Button>
            <Button size="small" onClick={() => openTab("findings")}>Reported findings ({reportedFindings})</Button>
          </Space>
        </div>
        <p className="pir-summary-text">
          {running
            ? `${confirmed} confirmed, ${uncertain} uncertain, ${pending ?? "unknown"} pending. ${latestProgress?.kind === "progress" ? latestProgress.message : "Waiting for progress events."}`
            : `Verdict: ${verdict}. ${confirmed} confirmed · ${rejected} rejected · ${uncertain} uncertain. ${projectedRun.stoppedBecause ? `Stop reason: ${projectedRun.stoppedBecause}.` : ""}`}
        </p>
        <Row gutter={[18, 12]}>
          <Col xs={12} sm={8} lg={4}><Statistic title="Confirmed" value={confirmed} styles={{ content: { color: confirmed > 0 ? "var(--pir-danger)" : undefined, fontSize: 20 } }} /></Col>
          <Col xs={12} sm={8} lg={4}><Statistic title="Uncertain" value={uncertain} styles={{ content: { color: uncertain > 0 ? "var(--pir-warning)" : undefined, fontSize: 20 } }} /></Col>
          <Col xs={12} sm={8} lg={4}><Statistic title="Pending" value={pending ?? "—"} styles={{ content: { fontSize: 20 } }} /></Col>
          <Col xs={12} sm={8} lg={4}><Statistic title="Rounds" value={rounds} styles={{ content: { fontSize: 20 } }} /></Col>
          <Col xs={12} sm={8} lg={4}><Statistic title="Coverage" value={coveragePercent === null ? "—" : `${coveragePercent}%`} styles={{ content: { fontSize: 20 } }} /></Col>
          <Col xs={12} sm={8} lg={4}><Statistic title="Tokens / cost" value={projectedRun.totalTokens === null ? "—" : fmtCount(projectedRun.totalTokens)} styles={{ content: { fontSize: 20 } }} /></Col>
        </Row>
        <Descriptions size="small" column={{ xs: 1, md: 2, xl: 4 }} style={{ marginTop: 12 }} items={[
          { key: "duration", label: "Duration", children: fmtDuration(duration) },
          { key: "usage", label: "Cost", children: fmtCost(projectedRun.cost) },
          { key: "reviewer", label: "Reviewer", children: projectedRun.model ?? detail.data.manifest?.model ?? "pi default" },
          { key: "verifier", label: "Verifier", children: projectedRun.verifierModel ?? detail.data.manifest?.verifierModel ?? "same" },
        ]} />
      </Card>

      {connectionNote && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Live observation is not connected"
          description={
            <span>
              The review may still be executing; this view is showing the last REST snapshot. Connection trouble is not execution failure.{" "}
              <a role="button" tabIndex={0} onClick={refreshAll}>Refresh snapshot</a>
            </span>
          }
        />
      )}
      {detail.error && <Alert type="warning" showIcon style={{ marginBottom: 12 }} title="Background refresh failed" description={<span>{detail.error} <a role="button" tabIndex={0} onClick={detail.reload}>Retry</a></span>} />}
      {!run.transcriptsAvailable && <Alert type="info" showIcon style={{ marginBottom: 12 }} title="Transcripts were not captured for this run" description="Run metadata, findings, and coverage remain available." />}
      {projection.end?.status === "incomplete" && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} title="This review stopped before completion" description={`Stop reason: ${projection.end.stoppedBecause || "not recorded"}. Confirmed findings remain valid; pending candidates and unread coverage are not a clean result.`} />
      )}

      <Tabs
        activeKey={tab}
        onChange={(key) => openTab(pickTab(key))}
        items={[
          {
            key: "overview",
            label: "Overview",
            children: (
              <RunOverview
                detail={projectedDetail}
                coverage={coverage.data}
                events={live.events}
                execution={execution}
                connection={live.connection}
                pendingCount={pending}
                onOpenTab={openTab}
                onOpenFinding={openFinding}
              />
            ),
          },
          {
            key: "findings",
            label: `Findings (${detail.data.findings.total})`,
            children: (
              <FindingsPanel
                key={`${projectId}/${runId}`}
                projectId={projectId}
                runId={runId}
                detail={projectedDetail}
                selected={findingId}
                onSelect={(displayId) => update({ finding: displayId })}
                onOpenSession={openSession}
              />
            ),
          },
          {
            key: "workflow",
            label: "Workflow",
            children: (
              <WorkflowPanel
                key={`${projectId}/${runId}`}
                projectId={projectId}
                runId={runId}
                sessions={workflow}
                liveSessions={liveSessions}
                selected={selectedSessionKey}
                role={role}
                status={sessionStatus}
                query={sessionQuery}
                onSelect={(key) => update({ session: key })}
                onFilter={(key, value) => update({ [key]: value === "all" || value === "" ? null : value })}
                onFinding={openFinding}
              />
            ),
          },
          {
            key: "coverage",
            label: "Coverage",
            children: coverage.loading && !coverage.data
              ? <PageLoading label="Loading coverage…" />
              : coverage.error && !coverage.data
                ? <PageError error={coverage.error} status={coverage.errorStatus} onRetry={coverage.reload} />
                : <CoveragePanel coverage={coverage.data} />,
          },
          {
            key: "details",
            label: "Details",
            children: <RunDetailsPanel detail={projectedDetail} coverage={coverage.data} />,
          },
        ]}
      />
      {running && live.connection !== "open" && (
        <div className="pir-muted" style={{ marginTop: 10, fontSize: 12 }}>
          <InfoCircleOutlined /> Live events are {live.connection === "connecting" ? "connecting" : "unavailable"}; counts come from the last REST snapshot until the stream recovers.
        </div>
      )}
    </div>
  );
}
