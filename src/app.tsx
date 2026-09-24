import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  ArrowsClockwiseIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  GearIcon,
  GitPullRequestIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import type { CodexAgent } from "./agent";
import type { ExceptionRecord, ReviewedFinding } from "./codex/exceptions";
import { getRule } from "./codex/rules";
import type { Severity } from "./codex/types";
import { SAMPLE_DIFF, SAMPLE_FIX_DIFF } from "./fixtures/samples";
import type { CodexState, ScanSummary, StartScanInput } from "./shared";

// ── helpers ───────────────────────────────────────────────────────────

const WORKSPACE_KEY = "codex-guardian:workspace";

function newWorkspaceId() {
  return `ws-${crypto.randomUUID()}`;
}

function loadWorkspaceId(): string {
  try {
    const existing = localStorage.getItem(WORKSPACE_KEY);
    if (existing) return existing;
    const id = newWorkspaceId();
    localStorage.setItem(WORKSPACE_KEY, id);
    return id;
  } catch {
    // Storage blocked (private mode): memory lasts for this page view only.
    return newWorkspaceId();
  }
}

const SEVERITY_BADGE: Record<
  Severity,
  "red" | "orange" | "warning" | "neutral"
> = {
  critical: "red",
  high: "orange",
  medium: "warning",
  low: "neutral"
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge variant={SEVERITY_BADGE[severity]}>{severity}</Badge>;
}

const TOOL_LABELS: Record<string, string> = {
  getScanResults: "Read scan results",
  getRules: "Look up Codex rules",
  requestException: "Grant exception",
  listExceptions: "List exceptions",
  compareScans: "Compare scans"
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const future = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60_000);
  const fmt = (n: number, unit: string) =>
    future ? `in ${n}${unit}` : `${n}${unit} ago`;
  if (mins < 1) return future ? "in <1m" : "just now";
  if (mins < 60) return fmt(mins, "m");
  const hours = Math.round(mins / 60);
  if (hours < 48) return fmt(hours, "h");
  return fmt(Math.round(hours / 24), "d");
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    try {
      localStorage.setItem("theme", mode);
    } catch {
      // Non-essential preference.
    }
  }, [dark]);
  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── chat tool rendering ───────────────────────────────────────────────

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (r: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const label = TOOL_LABELS[name] ?? name;

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    const input = part.input as {
      ruleId?: string;
      repo?: string;
      reason?: string;
      expiresInDays?: number;
    };
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[90%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <ShieldWarningIcon size={16} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approve exception?
            </Text>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm mb-3">
            <dt className="text-kumo-subtle">Rule</dt>
            <dd className="font-mono">
              {input.ruleId}{" "}
              {getRule(input.ruleId ?? "")?.title
                ? `· ${getRule(input.ruleId ?? "")?.title}`
                : ""}
            </dd>
            <dt className="text-kumo-subtle">Repo</dt>
            <dd className="font-mono">{input.repo}</dd>
            <dt className="text-kumo-subtle">Duration</dt>
            <dd>{input.expiresInDays} day(s)</dd>
            <dt className="text-kumo-subtle">Reason</dt>
            <dd>{input.reason}</dd>
          </dl>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: true })
              }
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: false })
              }
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  const denied =
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false);
  const state =
    part.state === "output-available" && !denied
      ? "done"
      : part.state === "output-error"
        ? "error"
        : denied
          ? "rejected"
          : "running";

  return (
    <div className="flex justify-start">
      <details className="max-w-[90%] rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs">
        <summary className="flex items-center gap-2 cursor-pointer select-none text-kumo-subtle">
          <GearIcon
            size={12}
            className={state === "running" ? "animate-spin" : ""}
          />
          <span>{label}</span>
          {state === "done" && <Badge variant="secondary">done</Badge>}
          {state === "error" && <Badge variant="destructive">error</Badge>}
          {state === "rejected" && <Badge variant="secondary">rejected</Badge>}
        </summary>
        <pre className="mt-2 font-mono whitespace-pre-wrap overflow-auto max-h-64 text-kumo-subtle">
          {JSON.stringify(
            {
              input: part.input,
              output: "output" in part ? part.output : undefined,
              error: part.errorText
            },
            null,
            2
          )}
        </pre>
      </details>
    </div>
  );
}

// ── scan panel ────────────────────────────────────────────────────────

function ScanComposer({
  disabled,
  onScan
}: {
  disabled: boolean;
  onScan: (input: StartScanInput) => Promise<void>;
}) {
  const [mode, setMode] = useState<"pr" | "diff">("diff");
  const [url, setUrl] = useState("");
  const [diff, setDiff] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onScan(
        mode === "pr" ? { kind: "pr", url: url.trim() } : { kind: "diff", diff }
      );
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === "pr" ? url.trim().length > 0 : diff.trim().length > 0;

  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
      <div className="flex items-center justify-between">
        <Text size="sm" bold>
          New scan
        </Text>
        <div className="flex rounded-lg border border-kumo-line overflow-hidden text-xs">
          {(["diff", "pr"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 ${mode === m ? "bg-kumo-contrast text-kumo-inverse" : "text-kumo-subtle hover:bg-kumo-control"}`}
            >
              {m === "diff" ? "Paste diff" : "GitHub PR"}
            </button>
          ))}
        </div>
      </div>

      {mode === "pr" ? (
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request URL"
          className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono"
        />
      ) : (
        <textarea
          value={diff}
          onChange={(e) => setDiff(e.target.value)}
          placeholder="Paste `git diff` output…"
          aria-label="Unified diff"
          rows={6}
          className="w-full px-3 py-2 text-xs rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono resize-y"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={<ShieldCheckIcon size={14} />}
          disabled={disabled || busy || !ready}
          onClick={submit}
        >
          {busy ? "Starting…" : "Scan"}
        </Button>
        {mode === "diff" && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDiff(SAMPLE_DIFF)}
            >
              Load example
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDiff(SAMPLE_FIX_DIFF)}
            >
              Load fixed version
            </Button>
          </>
        )}
      </div>
      <Text size="xs" variant="secondary">
        Public GitHub PRs or any unified diff. Tip: paste either into the chat
        too.
      </Text>
    </Surface>
  );
}

function ScanStatusCard({ scan }: { scan: ScanSummary }) {
  const t = scan.target;
  const total =
    scan.counts.critical +
    scan.counts.high +
    scan.counts.medium +
    scan.counts.low;
  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {t.kind === "pr" && (
              <GitPullRequestIcon
                size={14}
                className="text-kumo-subtle shrink-0"
              />
            )}
            {t.url ? (
              <a
                href={t.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-kumo-default truncate hover:underline"
              >
                {t.label}
              </a>
            ) : (
              <span className="text-sm font-medium text-kumo-default truncate">
                {t.label}
              </span>
            )}
          </div>
          {t.prTitle && (
            <div className="text-xs text-kumo-subtle truncate">{t.prTitle}</div>
          )}
        </div>
        <Badge
          variant={
            scan.status === "complete"
              ? total > 0
                ? "warning"
                : "success"
              : scan.status === "failed"
                ? "error"
                : "info"
          }
        >
          {scan.status === "complete"
            ? total > 0
              ? `${total} finding${total === 1 ? "" : "s"}`
              : "no findings"
            : scan.status}
        </Badge>
      </div>

      {(scan.status === "queued" || scan.status === "running") && (
        <div>
          <div className="h-1.5 rounded-full bg-kumo-control overflow-hidden">
            <div
              className="h-full bg-kumo-brand transition-all duration-500"
              style={{
                width: `${Math.round((scan.progress?.percent ?? 0.02) * 100)}%`
              }}
            />
          </div>
          <Text size="xs" variant="secondary">
            {scan.progress?.message ?? "Queued"}
          </Text>
        </div>
      )}

      {scan.status === "complete" && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {(["critical", "high", "medium", "low"] as const).map((s) =>
            scan.counts[s] > 0 ? (
              <span key={s} className="flex items-center gap-1">
                <SeverityBadge severity={s} /> {scan.counts[s]}
              </span>
            ) : null
          )}
          {scan.suppressed > 0 && (
            <Badge variant="outline">{scan.suppressed} waived</Badge>
          )}
          {scan.stats && (
            <span className="text-kumo-subtle ml-auto">
              {scan.stats.filesScanned} files ·{" "}
              {(scan.stats.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}

      {scan.error && (
        <Text size="xs" variant="secondary">
          {scan.error}
        </Text>
      )}
      {scan.notes.map((n) => (
        <div key={n} className="text-xs text-kumo-warning">
          ⚠ {n}
        </div>
      ))}
    </Surface>
  );
}

function FindingsList({
  findings,
  onExplain,
  onWaive
}: {
  findings: ReviewedFinding[];
  onExplain: (f: ReviewedFinding) => void;
  onWaive: (f: ReviewedFinding) => void;
}) {
  const [showWaived, setShowWaived] = useState(false);
  const waived = findings.filter((f) => f.suppressedBy).length;
  const visible = findings.filter((f) => showWaived || !f.suppressedBy);

  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-kumo-subtle px-1">
        <CheckCircleIcon size={16} className="text-kumo-success" /> No findings
        in this scan.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {waived > 0 && (
        <button
          type="button"
          className="text-xs text-kumo-subtle hover:underline px-1"
          onClick={() => setShowWaived(!showWaived)}
        >
          {showWaived ? "Hide" : "Show"} {waived} waived finding(s)
        </button>
      )}
      {visible.map((f) => {
        const rule = getRule(f.ruleId);
        return (
          <Surface
            key={f.fingerprint}
            className={`rounded-lg ring ring-kumo-line p-3 space-y-1.5 ${f.suppressedBy ? "opacity-60" : ""}`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <SeverityBadge severity={f.severity} />
              <span className="font-mono text-xs text-kumo-default">
                {f.ruleId}
              </span>
              <span className="text-xs text-kumo-subtle truncate">
                {rule?.title}
              </span>
              {f.source === "llm" && <Badge variant="beta">AI</Badge>}
              {f.suppressedBy && <Badge variant="outline">waived</Badge>}
            </div>
            <div className="font-mono text-xs text-kumo-subtle break-all">
              {f.file}
              {f.line ? `:${f.line}` : ""}
            </div>
            <div className="text-sm text-kumo-default">{f.message}</div>
            {f.evidence && (
              <pre className="text-[11px] font-mono bg-kumo-control rounded px-2 py-1 overflow-x-auto whitespace-pre">
                {f.evidence}
              </pre>
            )}
            <div className="flex gap-2 pt-0.5">
              <Button variant="ghost" size="xs" onClick={() => onExplain(f)}>
                Explain &amp; fix
              </Button>
              {rule?.exceptable && !f.suppressedBy && (
                <Button variant="ghost" size="xs" onClick={() => onWaive(f)}>
                  Request exception
                </Button>
              )}
            </div>
          </Surface>
        );
      })}
    </div>
  );
}

function ExceptionsList({
  exceptions,
  onRevoke
}: {
  exceptions: ExceptionRecord[];
  onRevoke: (id: string) => void;
}) {
  if (exceptions.length === 0) {
    return (
      <Text size="xs" variant="secondary">
        No active exceptions.
      </Text>
    );
  }
  return (
    <div className="space-y-2">
      {exceptions.map((e) => (
        <div
          key={e.id}
          className="rounded-lg border border-kumo-line p-2.5 text-xs space-y-1"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-kumo-default">{e.ruleId}</span>
            <span className="font-mono text-kumo-subtle truncate">
              {e.repo}
            </span>
            <span className="ml-auto text-kumo-subtle shrink-0">
              expires {relativeTime(e.expiresAt)}
            </span>
          </div>
          <div className="text-kumo-subtle">{e.reason}</div>
          <Button variant="ghost" size="xs" onClick={() => onRevoke(e.id)}>
            Revoke
          </Button>
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  icon,
  children
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5 px-1 text-kumo-subtle">
        {icon}
        <Text size="xs" variant="secondary" bold>
          {title}
        </Text>
      </div>
      {children}
    </section>
  );
}

// ── main ──────────────────────────────────────────────────────────────

function Workspace({
  workspaceId,
  onNewWorkspace
}: {
  workspaceId: string;
  onNewWorkspace: () => void;
}) {
  const [connected, setConnected] = useState(false);
  const [codex, setCodex] = useState<CodexState>({
    scans: [],
    latest: null,
    exceptions: []
  });
  const [selected, setSelected] = useState<{
    scanId: string;
    findings: ReviewedFinding[];
  } | null>(null);
  const [tab, setTab] = useState<"chat" | "scans">("chat");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toasts = useKumoToastManager();

  const agent = useAgent<CodexAgent, CodexState>({
    agent: "CodexAgent",
    name: workspaceId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onStateUpdate: useCallback((state: CodexState) => setCodex(state), [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    experimental_throttle: 100
  });
  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
      setTab("chat");
    },
    [isStreaming, sendMessage]
  );

  const startScan = useCallback(
    async (scanInput: StartScanInput) => {
      try {
        const res = await agent.stub.startScan(scanInput);
        if (!res.ok) {
          toasts.add({
            title: "Scan not started",
            description: res.error,
            timeout: 6000
          });
        } else if (res.deduplicated) {
          toasts.add({
            title: "Already scanned",
            description: `${res.label} — showing the existing results.`,
            timeout: 4000
          });
        }
        setSelected(null);
      } catch (err) {
        toasts.add({
          title: "Scan failed to start",
          description: String(err),
          timeout: 6000
        });
      }
    },
    [agent, toasts]
  );

  const viewScan = useCallback(
    async (scanId: string) => {
      if (scanId === codex.latest?.scanId) return setSelected(null);
      const res = await agent.stub.getScanFindings(scanId);
      if (res) setSelected({ scanId, findings: res.findings });
    },
    [agent, codex.latest?.scanId]
  );

  const activeScan = codex.scans.find(
    (s) => s.status === "queued" || s.status === "running"
  );
  const shownScanId = selected?.scanId ?? codex.latest?.scanId;
  const shownScan = codex.scans.find((s) => s.id === shownScanId);
  const shownFindings = selected?.findings ?? codex.latest?.findings ?? [];

  const explain = (f: ReviewedFinding) =>
    send(
      `Explain ${f.ruleId} at ${f.file}${f.line ? `:${f.line}` : ""} and show me how to fix it.`
    );
  const waive = (f: ReviewedFinding) => {
    const repo =
      codex.scans.find((s) => s.id === shownScanId)?.target.repo ?? "";
    setInput(
      `Please grant an exception for ${f.ruleId} on ${repo} for 30 days. Reason: `
    );
    setTab("chat");
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const panel = (
    <div className="space-y-5">
      <ScanComposer disabled={!connected} onScan={startScan} />
      {activeScan && activeScan.id !== shownScanId && (
        <Section
          title="In progress"
          icon={<ArrowsClockwiseIcon size={12} className="animate-spin" />}
        >
          <ScanStatusCard scan={activeScan} />
        </Section>
      )}
      {shownScan && (
        <Section
          title={selected ? "Selected scan" : "Latest scan"}
          icon={<ShieldCheckIcon size={12} />}
        >
          <ScanStatusCard scan={shownScan} />
          <FindingsList
            findings={shownFindings}
            onExplain={explain}
            onWaive={waive}
          />
        </Section>
      )}
      <Section title="Active exceptions" icon={<ShieldWarningIcon size={12} />}>
        <ExceptionsList
          exceptions={codex.exceptions}
          onRevoke={(id) => agent.stub.revokeException(id)}
        />
      </Section>
      {codex.scans.length > 0 && (
        <Section title="History" icon={<ClockCounterClockwiseIcon size={12} />}>
          <div className="space-y-1">
            {codex.scans.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => s.status === "complete" && viewScan(s.id)}
                className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-left hover:bg-kumo-control ${s.id === shownScanId ? "bg-kumo-control" : ""}`}
              >
                <span className="font-mono truncate text-kumo-default">
                  {s.target.label}
                </span>
                {s.target.headSha && (
                  <span className="font-mono text-kumo-subtle">
                    {s.target.headSha.slice(0, 7)}
                  </span>
                )}
                <span className="ml-auto text-kumo-subtle shrink-0">
                  {s.status === "complete"
                    ? `${s.counts.critical + s.counts.high + s.counts.medium + s.counts.low} · ${relativeTime(s.createdAt)}`
                    : s.status}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-4 sm:px-5 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheckIcon
              size={22}
              weight="duotone"
              className="text-kumo-brand shrink-0"
            />
            <h1 className="text-lg font-semibold text-kumo-default truncate">
              Codex Guardian
            </h1>
            <Badge variant="secondary" className="hidden sm:inline-flex">
              Engineering Codex checks
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Connecting…"}
              </Text>
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              size="sm"
              icon={<TrashIcon size={14} />}
              onClick={clearHistory}
            >
              <span className="hidden sm:inline">Clear chat</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onNewWorkspace}
              title="Start over with an empty memory"
            >
              New workspace
            </Button>
          </div>
        </div>
      </header>

      {/* Mobile tabs */}
      <div className="lg:hidden flex border-b border-kumo-line bg-kumo-base text-sm">
        {(["chat", "scans"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 py-2 ${tab === t ? "text-kumo-default border-b-2 border-kumo-brand" : "text-kumo-subtle"}`}
          >
            {t === "chat" ? "Chat" : `Scans${activeScan ? " •" : ""}`}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 grid lg:grid-cols-[minmax(0,1fr)_440px]">
        {/* Chat column */}
        <div
          className={`flex-col min-h-0 ${tab === "chat" ? "flex" : "hidden"} lg:flex`}
        >
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-5 py-6 space-y-4">
              {messages.length === 0 && (
                <Empty
                  icon={<ChatCircleDotsIcon size={32} />}
                  title="Check a change against the Engineering Codex"
                  description="Paste a GitHub PR link or a diff here or in the panel. Scans run in the background; ask me about any finding."
                  contents={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!connected}
                        onClick={() =>
                          send(`Please review this change:\n\n${SAMPLE_DIFF}`)
                        }
                      >
                        Scan the example diff
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!connected}
                        onClick={() =>
                          send(
                            "What does the Codex check, and which rules can't be waived?"
                          )
                        }
                      >
                        What do you check?
                      </Button>
                    </div>
                  }
                />
              )}

              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLast = index === messages.length - 1;
                return (
                  <div key={message.id} className="space-y-2">
                    {message.parts.map((part, i) => {
                      const key = `${message.id}-${i}`;
                      if (isToolUIPart(part)) {
                        return (
                          <ToolPartView
                            key={key}
                            part={part}
                            addToolApprovalResponse={addToolApprovalResponse}
                          />
                        );
                      }
                      if (part.type !== "text" || !part.text) return null;
                      if (isUser) {
                        const isDiff = /^diff --git /m.test(part.text);
                        return (
                          <div key={key} className="flex justify-end">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                              {isDiff ? (
                                <details>
                                  <summary className="cursor-pointer">
                                    {part.text
                                      .split(/\ndiff --git /)[0]
                                      .slice(0, 200) || "Diff"}{" "}
                                    <span className="opacity-70">
                                      (diff attached)
                                    </span>
                                  </summary>
                                  <pre className="mt-2 text-[11px] whitespace-pre-wrap max-h-64 overflow-auto">
                                    {part.text}
                                  </pre>
                                </details>
                              ) : (
                                <span className="whitespace-pre-wrap">
                                  {part.text}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={key} className="flex justify-start">
                          <div className="max-w-[90%] min-w-0 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                            <Streamdown
                              className="sd-theme rounded-2xl rounded-bl-md p-3 overflow-x-auto"
                              plugins={{ code }}
                              controls={false}
                              isAnimating={isLast && isStreaming}
                            >
                              {part.text}
                            </Streamdown>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
                setInput("");
              }}
              className="max-w-3xl mx-auto px-4 sm:px-5 py-3"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent">
                <InputArea
                  ref={textareaRef}
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                      setInput("");
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  placeholder="Paste a PR link or diff, or ask about a finding…"
                  disabled={!connected || isStreaming}
                  rows={1}
                  className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    icon={<StopIcon size={18} />}
                    onClick={stop}
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send"
                    disabled={!input.trim() || !connected}
                    icon={<PaperPlaneRightIcon size={18} />}
                  />
                )}
              </div>
            </form>
            <div className="flex justify-center pb-2">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          </div>
        </div>

        {/* Scan panel */}
        <aside
          className={`min-h-0 overflow-y-auto border-l border-kumo-line bg-kumo-elevated px-4 py-5 ${tab === "scans" ? "block" : "hidden"} lg:block`}
        >
          {panel}
        </aside>
      </div>
    </div>
  );
}

export default function App() {
  const [workspaceId, setWorkspaceId] = useState(loadWorkspaceId);
  const startOver = () => {
    const id = newWorkspaceId();
    try {
      localStorage.setItem(WORKSPACE_KEY, id);
    } catch {
      // Falls back to an in-memory workspace.
    }
    setWorkspaceId(id);
  };
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading…
          </div>
        }
      >
        <Workspace
          key={workspaceId}
          workspaceId={workspaceId}
          onNewWorkspace={startOver}
        />
      </Suspense>
    </Toasty>
  );
}
