import { useCallback, useEffect, useRef, useState } from "react";
import { useRunEvents, type SseStatus } from "./hooks";
import { mergeEvents } from "./live-fold";
import {
  createLiveRunProjection,
  reduceLiveRunProjection,
  type LiveRunProjection,
} from "./live-projection";
import type { RunDetail, RunEvent } from "./types";

export interface LiveRunState {
  events: RunEvent[] | null;
  projection: LiveRunProjection;
  connection: SseStatus;
  calibrating: boolean;
}

/**
 * Bridges the REST snapshot, the SSE replay, and transport health.
 *
 * Execution state and connection state are independent facts: losing the
 * observation stream never marks a running review interrupted. REST is
 * recalibrated (throttled) at semantic boundaries — replay start, round end,
 * verifier session end, run end — so long audits do not keep stale counts.
 */
export function useLiveRun(input: {
  projectId: string;
  runId: string;
  detail: RunDetail | null;
  enabled: boolean;
  reloadDetail: () => void;
}): LiveRunState {
  const { projectId, runId, detail, enabled, reloadDetail } = input;
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [projection, setProjection] = useState(() => createLiveRunProjection(runId));
  const [calibrating, setCalibrating] = useState(false);

  const pendingRef = useRef<RunEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxSeqRef = useRef(0);
  const readyRef = useRef(false);
  const verifierIdsRef = useRef(new Set<string>());
  const calibrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCalibrationRef = useRef(0);
  const reloadRef = useRef(reloadDetail);
  reloadRef.current = reloadDetail;

  const calibrate = useCallback(() => {
    if (calibrationTimerRef.current !== null) return;
    const wait = Math.max(240, 1_000 - (Date.now() - lastCalibrationRef.current));
    calibrationTimerRef.current = setTimeout(() => {
      calibrationTimerRef.current = null;
      lastCalibrationRef.current = Date.now();
      setCalibrating(true);
      reloadRef.current();
    }, wait);
  }, []);

  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    setEvents((previous) => mergeEvents(previous ?? [], pending));
    setProjection((previous) => pending.reduce((state, event) => reduceLiveRunProjection(state, { type: "event", event }), previous));
  }, []);

  // A different run owns a different sequence space; reset everything before
  // the next SSE connection opens, otherwise its early events are dropped.
  useEffect(() => {
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
    if (calibrationTimerRef.current !== null) clearTimeout(calibrationTimerRef.current);
    flushTimerRef.current = null;
    calibrationTimerRef.current = null;
    pendingRef.current = [];
    verifierIdsRef.current = new Set();
    maxSeqRef.current = 0;
    readyRef.current = false;
    lastCalibrationRef.current = 0;
    setEvents(null);
    setProjection(createLiveRunProjection(runId));
    setCalibrating(false);
    return () => {
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
      if (calibrationTimerRef.current !== null) clearTimeout(calibrationTimerRef.current);
    };
  }, [projectId, runId]);

  useEffect(() => {
    if (!detail) return;
    setProjection((previous) => reduceLiveRunProjection(previous, { type: "detail", detail }));
    setCalibrating(false);
  }, [detail]);

  const onEvent = useCallback((event: RunEvent) => {
    if (event.kind === "ready") {
      // The first ready frame is the initial replay boundary. A later one is a
      // reconnect: pull one REST snapshot to repair anything missed offline.
      if (readyRef.current) calibrate();
      readyRef.current = true;
      return;
    }
    if (event.kind === "unavailable") {
      calibrate();
      return;
    }
    if (event.runId !== runId || event.projectId !== projectId || event.seq <= maxSeqRef.current) return;
    maxSeqRef.current = event.seq;
    if (event.kind === "session-start" && event.sessionKind === "verifier") verifierIdsRef.current.add(event.sessionId);
    pendingRef.current.push(event);
    if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flush, 80);
    if (
      event.kind === "run-end" ||
      (event.kind === "progress" && event.phase === "round-end") ||
      (event.kind === "session-end" && verifierIdsRef.current.has(event.sessionId))
    ) {
      calibrate();
    }
  }, [calibrate, flush, projectId, runId]);

  const connection = useRunEvents(enabled ? runId : null, true, onEvent);

  useEffect(() => {
    setProjection((previous) => reduceLiveRunProjection(previous, { type: "connection", state: connection }));
  }, [connection]);

  return { events, projection, connection, calibrating };
}