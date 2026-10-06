import { useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { runMetrics, type RunSnapshot } from "../../shared/observability";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";

export function RunConsoleDock({
  children, runs,
}: { children: ReactNode; runs: RunSnapshot[] }) {
  const panel = useRef<PanelImperativeHandle>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<"events" | "metrics">("events");
  const [selected, setSelected] = useState<string | null>(null);
  const run = runs.find((run) => run.id === selected) ?? runs.at(-1);
  const metrics = run ? runMetrics(run) : null;
  const metric = (value: { value: number | null; partial: boolean } | undefined) =>
    value?.value == null ? "unavailable" : `${value.value.toLocaleString()}${value.partial ? " (partial)" : ""}`;
  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0">
      <ResizablePanel id="chat-workspace" minSize="35%" className="min-h-0">
        {children}
      </ResizablePanel>
      <ResizableHandle aria-label="Resize observability console" />
      <ResizablePanel
        ref={panel}
        id="run-console"
        defaultSize={200}
        minSize={100}
        maxSize="50%"
        collapsible
        collapsedSize={38}
        onResize={(size) => setCollapsed(size.inPixels < 50)}
        className="bg-muted/30 font-mono text-xs"
      >
        <div className="flex h-[38px] items-center gap-3 border-b px-3">
          <strong className="text-foreground">Execution console</strong>
          <button type="button" aria-pressed={view === "events"} onClick={() => setView("events")}>Events</button>
          <button type="button" aria-pressed={view === "metrics"} onClick={() => setView("metrics")}>Metrics</button>
          <select
            aria-label="Inspect authorized run"
            value={run?.id ?? ""}
            onChange={(event) => setSelected(event.target.value)}
            className="min-w-0 max-w-80 bg-transparent"
          >
            {!runs.length && <option value="">No measured run</option>}
            {runs.map((run, index) => <option key={run.id} value={run.id}>Run {index + 1} · {run.id}</option>)}
          </select>
          <button
            type="button" aria-label={collapsed ? "Expand execution console" : "Collapse execution console"}
            aria-expanded={!collapsed} className="ml-auto"
            onClick={() => collapsed ? panel.current?.expand() : panel.current?.collapse()}
          >{collapsed ? "Expand" : "Collapse"}</button>
        </div>
        {!collapsed && <div className="h-[calc(100%-38px)] overflow-auto p-3" role="region" aria-label="Authorized run observability">
          {!run ? <p>Metrics unavailable. Select a measured run; historical runs are not reconstructed.</p>
            : view === "events" ? (
              <ol className="space-y-1">
                {run.events.map((event) => (
                  <li key={event.id} className={event.errorCode ? "text-destructive" : ""}>
                    <time dateTime={event.timestamp}>{event.timestamp.slice(11, 23)}</time>{" "}
                    [{event.origin}] {event.stage ?? "run"} {event.kind}{" "}
                    {event.measurementKind === "model-step-with-tools" ? "(application model step, including tools) " : ""}
                    {event.model ?? event.provider ?? ""}{" "}
                    {event.elapsedMs === undefined ? "" : `${Math.round(event.elapsedMs)} ms`}
                    {event.errorCode ? ` · ${event.errorCode}` : ""}
                    {event.correlationId ? ` · correlation ${event.correlationId}` : ""}
                    {event.kind === "step-completed" || event.kind === "service-activity" ? (
                      <span className="text-muted-foreground">
                        {" · input "}{event.usage?.input ?? "unavailable"}
                        {" / output "}{event.usage?.output ?? "unavailable"}
                        {event.usage?.reasoning === undefined ? "" : ` / reasoning ${event.usage.reasoning}`}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="space-y-2">
                <p>Measured run latency: {metrics?.wallClockMs == null ? "unavailable (no terminal monotonic measurement)" : `${Math.round(metrics.wallClockMs)} ms`}</p>
                <p>Reported input: {metric(metrics?.input)} · output: {metric(metrics?.output)}</p>
                <p>Cache read: {metric(metrics?.cacheRead)} · cache write: {metric(metrics?.cacheWrite)}</p>
                <p>Reasoning tokens: {metric(metrics?.reasoning)} · other tokens: {metric(metrics?.other)}</p>
                <p className="text-muted-foreground">Cache and reasoning categories can be subsets; they are not added again. Parallel stage durations are not summed into run latency. No private chain-of-thought is displayed.</p>
                <p className="text-muted-foreground">Totals cover reported invocation usage only. Stages without provider usage remain unavailable; native MCP does not have a REST activity envelope.</p>
              </div>
            )}
        </div>}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
