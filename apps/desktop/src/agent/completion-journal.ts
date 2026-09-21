import fs from "node:fs";
import path from "node:path";
import type { JobResultEnvelope } from "@automoney/shared";
import type { SpaceUpdate } from "./api";
import { completionJournalPath } from "./paths";

export interface CompletionEntry {
  jobId: string;
  attemptNo?: number;
  completionId: string;
  status: "SUCCEEDED" | "FAILED";
  result?: JobResultEnvelope;
  errorCode?: string;
  errorMessage?: string;
  spaceUpdate?: SpaceUpdate;
}

function readAll(): CompletionEntry[] {
  try {
    const value = JSON.parse(fs.readFileSync(completionJournalPath(), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeAll(entries: CompletionEntry[]): void {
  const target = completionJournalPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

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
};
