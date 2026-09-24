import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { parseUnifiedDiff } from "./codex/diff";
import {
  coverageNotes,
  mergeFindings,
  runDeterministicRules
} from "./codex/engine";
import { fetchPrFiles, GitHubError, type PrRef } from "./codex/github";
import { planLlmBatches, runLlmBatch, workersAiClient } from "./codex/llm";
import type { Finding, ScanResult } from "./codex/types";
import type { CodexAgent } from "./agent";

export type ScanSource =
  | { kind: "pr"; ref: PrRef }
  | { kind: "diff"; diff: string };

export interface ScanParams {
  scanId: string;
  source: ScanSource;
  /** Fixed at enqueue time so replays evaluate date rules identically. */
  now: string;
}

export interface ScanProgress {
  scanId: string;
  percent: number;
  message: string;
  [key: string]: unknown;
}

/**
 * One scan = one Workflow instance. Each model call is its own step, so a
 * Workers AI timeout retries that batch only, and a Worker eviction mid-scan
 * resumes from the last completed step instead of re-running (and re-paying
 * for) every call.
 */
export class ReviewWorkflow extends AgentWorkflow<
  CodexAgent,
  ScanParams,
  ScanProgress
> {
  async run(event: AgentWorkflowEvent<ScanParams>, step: AgentWorkflowStep) {
    const { scanId, source, now } = event.payload;
    const progress = (percent: number, message: string) =>
      this.reportProgress({ scanId, percent, message }).catch(() => {
        // Progress is cosmetic; never fail a scan because the UI is gone.
      });

    await progress(0.05, "Loading changes");
    const input = await step.do(
      "load-changes",
      {
        retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
        timeout: "1 minute"
      },
      async () => {
        if (source.kind === "diff") {
          return {
            files: parseUnifiedDiff(source.diff),
            notes: [] as string[]
          };
        }
        try {
          return await fetchPrFiles(source.ref, this.env.GITHUB_TOKEN);
        } catch (err) {
          if (err instanceof GitHubError && !err.retryable) {
            throw new NonRetryableError(err.message);
          }
          throw err;
        }
      }
    );
    if (input.files.length === 0) {
      throw new NonRetryableError("No file changes found in the input.");
    }

    await progress(
      0.15,
      `Running deterministic rules on ${input.files.length} file(s)`
    );
    const deterministic = await step.do("deterministic-rules", async () =>
      runDeterministicRules(input.files, { now: new Date(now) })
    );

    const plan = await step.do("plan-ai-review", async () =>
      planLlmBatches(input.files)
    );

    let completed = 0;
    let failed = 0;
    const total = plan.batches.length;
    if (total > 0) {
      await progress(0.25, `AI review: 0/${total} batch(es)`);
    }

    // Batches run concurrently (≤ MAX_LLM_BATCHES); each step retries alone.
    const settled = await Promise.allSettled(
      plan.batches.map(async (batch) => {
        const found = await step.do(
          `ai-review-${batch.index}`,
          {
            retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
            timeout: "2 minutes"
          },
          async () => runLlmBatch(batch, workersAiClient(this.env.AI))
        );
        completed++;
        await progress(
          0.25 + 0.65 * (completed / total),
          `AI review: ${completed}/${total} batch(es)`
        );
        return found;
      })
    );

    const llmFindings: Finding[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") llmFindings.push(...s.value);
      else {
        failed++;
        console.error(
          `scan ${scanId}: AI batch failed after retries`,
          s.reason
        );
      }
    }

    const notes = [
      ...input.notes,
      ...coverageNotes(input.files),
      ...plan.notes
    ];
    if (failed > 0) {
      // Degrade instead of failing: deterministic results are still valid.
      notes.push(
        `${failed} of ${total} AI review batch(es) failed after retries; AI-judged rules have partial coverage.`
      );
    }

    await progress(0.95, "Saving results");
    await step.do("save-results", async () => {
      const result: ScanResult = {
        findings: mergeFindings(deterministic, llmFindings),
        stats: {
          filesScanned: input.files.length,
          filesTruncated: input.files.filter((f) => f.truncated).length,
          addedLines: input.files.reduce((n, f) => n + f.addedLines.length, 0),
          llmBatches: total,
          llmBatchesFailed: failed,
          durationMs: Date.now() - event.timestamp.getTime()
        },
        notes
      };
      // completeScan is idempotent (upserts), so a retried step is safe.
      await this.agent.completeScan(scanId, result);
    });

    await step.reportComplete({ scanId });
    return { scanId };
  }
}
