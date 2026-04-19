import { createSignal } from "solid-js";
import {
  CLOSE_SHELL_RECORD_CMD,
  LIST_SHELL_RECORDS_CMD,
  SET_SHELL_PERSIST_ON_QUIT_CMD,
  UPDATE_SHELL_RECORD_CMD,
  type ShellRecord,
  type ShellRecordStatus,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;

function sortShellRecords(records: ShellRecord[]): ShellRecord[] {
  return [...records].sort(
    (a, b) => (b.last_attached_at ?? 0) - (a.last_attached_at ?? 0) || (b.created_at ?? 0) - (a.created_at ?? 0),
  );
}

export function isRestorableShell(record: ShellRecord): boolean {
  return record.persist_on_quit && (record.status === "detached" || record.status === "active");
}

export function shellStatusLabel(status: ShellRecordStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "detached":
      return "Restorable";
    case "crashed":
      return "Crashed";
    default:
      return "Closed";
  }
}

export function formatShellTime(timestamp?: number | null): string {
  if (!timestamp) return "Unknown";
  return new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function useShellRegistry() {
  const [shellRecords, setShellRecords] = createSignal<ShellRecord[]>([]);

  const applyShellRecord = (record: ShellRecord) => {
    setShellRecords((current) =>
      sortShellRecords([record, ...current.filter((existing) => existing.id !== record.id)]));
  };

  const refreshShellRecords = async (): Promise<ShellRecord[]> => {
    const records = ((await invoke(LIST_SHELL_RECORDS_CMD).catch(() => [])) as ShellRecord[]) ?? [];
    const next = sortShellRecords(records);
    setShellRecords(next);
    return next;
  };

  const initializeRecords = (records: ShellRecord[]) => {
    setShellRecords(sortShellRecords(records));
  };

  const closeShellRecords = async (shellIds: string[]) => {
    const closed = await Promise.all(
      shellIds.map(async (shellId) => {
        try {
          return (await invoke(CLOSE_SHELL_RECORD_CMD, { shellId })) as ShellRecord;
        } catch {
          return null;
        }
      }),
    );
    closed.filter((record): record is ShellRecord => Boolean(record)).forEach(applyShellRecord);
  };

  const syncShellRecord = async (
    shellId: string,
    updates: { title?: string; cwd?: string; status?: ShellRecordStatus },
  ) => {
    try {
      const record = (await invoke(UPDATE_SHELL_RECORD_CMD, {
        shellId,
        title: updates.title,
        cwd: updates.cwd,
        status: updates.status,
      })) as ShellRecord;
      applyShellRecord(record);
    } catch {
      // Ignore shell registry update failures; the workspace remains usable.
    }
  };

  const closeShellRecordById = async (shellId: string) => {
    try {
      const record = (await invoke(CLOSE_SHELL_RECORD_CMD, { shellId })) as ShellRecord;
      applyShellRecord(record);
    } catch {
      // Ignore registry close failures during terminal teardown.
    }
  };

  const setShellPersistOnQuit = async (shellId: string, persistOnQuit: boolean) => {
    try {
      const record = (await invoke(SET_SHELL_PERSIST_ON_QUIT_CMD, {
        shellId,
        persistOnQuit,
      })) as ShellRecord;
      applyShellRecord(record);
    } catch {
      // Ignore toggle failures; button state will refresh the next time the landing opens.
    }
  };

  return {
    shellRecords,
    initializeRecords,
    refreshShellRecords,
    closeShellRecords,
    syncShellRecord,
    closeShellRecordById,
    setShellPersistOnQuit,
    applyShellRecord,
  };
}
