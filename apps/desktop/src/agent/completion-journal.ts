import fs from "node:fs";
import path from "node:path";
import type { JobResultEnvelope } from "@automoney/shared";
import type { SpaceUpdate } from "./api";
import { completionJournalPath, completionQuarantinePath } from "./paths";

export interface CompletionEntry {
  jobId: string;
  attemptNo?: number;
  /** Attempt fencing secret returned by claim. Required when replaying a completion. */
  leaseToken?: string;
  completionId: string;
  status: "SUCCEEDED" | "FAILED";
  result?: JobResultEnvelope;
  errorCode?: string;
  errorMessage?: string;
  spaceUpdate?: SpaceUpdate;
}

export interface QuarantinedCompletionEntry extends Omit<CompletionEntry, "leaseToken"> {
  leaseTokenPresent: boolean;
  quarantinedAt: number;
  quarantineReason: string;
}

function readFile<T>(target: string): T[] {
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeFile<T>(target: string, entries: T[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

const readAll = () => readFile<CompletionEntry>(completionJournalPath());
const writeAll = (entries: CompletionEntry[]) => writeFile(completionJournalPath(), entries);
const readQuarantined = () => readFile<QuarantinedCompletionEntry>(completionQuarantinePath());
const writeQuarantined = (entries: QuarantinedCompletionEntry[]) => writeFile(completionQuarantinePath(), entries);

export const completionJournal = {
  list: readAll,
  put(entry: CompletionEntry): void {
    const entries = readAll().filter((item) => item.completionId !== entry.completionId);
    entries.push(entry);
    writeAll(entries);
  },
  remove(completionId: string): void {
    writeAll(readAll().filter((item) => item.completionId !== completionId));
  },
  quarantine(completionId: string, reason: string): void {
    const entries = readAll();
    const entry = entries.find((item) => item.completionId === completionId);
    if (!entry) return;
    const { leaseToken, ...safeEntry } = entry;
    const quarantined: QuarantinedCompletionEntry = {
      ...safeEntry,
      leaseTokenPresent: Boolean(leaseToken),
      quarantinedAt: Date.now(),
      quarantineReason: reason.slice(0, 300),
    };
    writeQuarantined([
      ...readQuarantined().filter((item) => item.completionId !== completionId),
      quarantined,
    ]);
    writeAll(entries.filter((item) => item.completionId !== completionId));
  },
  quarantined: readQuarantined,
};
