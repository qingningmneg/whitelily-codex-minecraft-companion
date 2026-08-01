import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MemoryContextScope,
  ScopedMemoryExport,
  ScopedMemoryRecord,
} from "../../../../src/memory/scopedMemoryStore.js";
import { DocumentConflictNotice } from "../components/DocumentConflictNotice.js";
import { MemoryMigrationPreview } from "../components/MemoryMigrationPreview.js";
import type { MemoryMigrationPreviewResult, WhiteLilyTask5Api } from "../desktopApi.js";
import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface MemoryPageProps {
  api: Pick<
    WhiteLilyTask5Api,
    | "readMemories"
    | "searchMemories"
    | "addMemory"
    | "updateMemory"
    | "forgetMemory"
    | "pinMemory"
    | "setMemoryScope"
    | "previewMemoryMigration"
    | "commitMemoryMigration"
    | "rollbackMemoryMigration"
    | "exportMemories"
    | "readWorldProfile"
  >;
  locale: Locale;
  currentWorldId?: string;
  initialScope?: MemoryContextScope;
}

type MemoryCategory = ScopedMemoryRecord["category"];
type MemoryImportance = ScopedMemoryRecord["importance"];
type StoredMemoryScope = ScopedMemoryRecord["scope"];
type PendingMutation =
  | { kind: "add" }
  | { kind: "update"; id: number }
  | { kind: "forget"; id: number }
  | { kind: "pin"; id: number; pinned: boolean };

const categories: readonly MemoryCategory[] = [
  "preference",
  "place",
  "project",
  "promise",
  "experience",
];

export function MemoryPage({ api, locale, currentWorldId, initialScope }: MemoryPageProps) {
  const defaultScope =
    initialScope ??
    (currentWorldId
      ? { mode: "layered" as const, worldId: currentWorldId }
      : { mode: "global" as const });
  const [envelope, setEnvelope] = useState<ScopedMemoryExport | null>(null);
  const [resolvedWorldId, setResolvedWorldId] = useState(currentWorldId);
  const [activeScope, setActiveScope] = useState<MemoryContextScope>(defaultScope);
  const [scopeDraft, setScopeDraft] = useState<MemoryContextScope>(defaultScope);
  const [rollbackScope, setRollbackScope] = useState<MemoryContextScope | null>(null);
  const [migrationTarget, setMigrationTarget] = useState<StoredMemoryScope>("global");
  const [migrationPreview, setMigrationPreview] = useState<MemoryMigrationPreviewResult | null>(
    null,
  );
  const [migrationCommitted, setMigrationCommitted] = useState(false);
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("preference");
  const [importance, setImportance] = useState<MemoryImportance>(3);
  const [newStoredScope, setNewStoredScope] = useState<StoredMemoryScope>("global");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSummary, setEditSummary] = useState("");
  const [editStoredScope, setEditStoredScope] = useState<StoredMemoryScope>("global");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    fields: string[];
    mutation: PendingMutation;
  } | null>(null);

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const [latestMemories, world] = await Promise.all([
        api.readMemories(),
        currentWorldId ? Promise.resolve(null) : api.readWorldProfile(),
      ]);
      const worldId = currentWorldId ?? world?.value?.id;
      setResolvedWorldId(worldId);
      if (!initialScope && worldId) {
        const scope = { mode: "layered" as const, worldId };
        setActiveScope(scope);
        setScopeDraft(scope);
      }
      setEnvelope(latestMemories);
    } catch {
      setMessage(translate(locale, "memory.error"));
    }
  }, [api, currentWorldId, initialScope, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const runMutation = async (mutation: PendingMutation, reapplying = false): Promise<void> => {
    if (!envelope || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await invokeMutation(api, envelope, mutation, {
        summary,
        category,
        importance,
        editSummary,
        newStoredScope,
        editStoredScope,
      });
      setEnvelope(result.envelope);
      setConflict(null);
      if (mutation.kind === "add") setSummary("");
      if (mutation.kind === "update") setEditingId(null);
    } catch (error) {
      if (isDocumentConflict(error)) {
        try {
          const latest = await api.readMemories();
          setEnvelope(latest);
          setConflict({
            fields: memoryChangedFields(locale, envelope, latest, mutation),
            mutation,
          });
        } catch {
          setMessage(translate(locale, "memory.error"));
        }
      } else {
        setMessage(translate(locale, "memory.error"));
      }
      if (reapplying && !isDocumentConflict(error)) setConflict(null);
    } finally {
      setPending(false);
    }
  };

  const scopeCount = useMemo(
    () => (envelope ? recordsForScope(envelope.records, scopeDraft).length : 0),
    [envelope, scopeDraft],
  );

  if (!envelope) {
    return (
      <main className="content-page">
        <p className="state-panel">{message ?? translate(locale, "page.loading")}</p>
      </main>
    );
  }

  const previewVisible = !sameScope(scopeDraft, activeScope) || rollbackScope !== null;

  const applyScope = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      await api.setMemoryScope(scopeDraft);
      setRollbackScope(activeScope);
      setActiveScope(scopeDraft);
    } catch {
      setMessage(translate(locale, "memory.error"));
    } finally {
      setPending(false);
    }
  };
  const rollback = async (): Promise<void> => {
    if (!rollbackScope || pending) return;
    setPending(true);
    try {
      await api.setMemoryScope(rollbackScope);
      setActiveScope(rollbackScope);
      setScopeDraft(rollbackScope);
      setRollbackScope(null);
    } catch {
      setMessage(translate(locale, "memory.error"));
    } finally {
      setPending(false);
    }
  };

  const previewMigration = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      setMigrationPreview(await api.previewMemoryMigration(migrationTarget));
      setMigrationCommitted(false);
    } catch {
      setMessage(translate(locale, "memory.error"));
    } finally {
      setPending(false);
    }
  };

  const commitMigration = async (): Promise<void> => {
    if (!migrationPreview || pending) return;
    setPending(true);
    try {
      await api.commitMemoryMigration({
        migrationId: migrationPreview.migrationId,
        sourceRevision: migrationPreview.sourceRevision,
      });
      setMigrationCommitted(true);
      setEnvelope(await api.readMemories());
    } catch {
      setMessage(translate(locale, "memory.error"));
    } finally {
      setPending(false);
    }
  };

  const rollbackMigration = async (): Promise<void> => {
    if (!migrationPreview || !migrationCommitted || pending) return;
    setPending(true);
    try {
      await api.rollbackMemoryMigration(migrationPreview.migrationId);
      setEnvelope(await api.readMemories());
      setMigrationPreview(null);
      setMigrationCommitted(false);
    } catch {
      setMessage(translate(locale, "memory.error"));
    } finally {
      setPending(false);
    }
  };

  const search = async (): Promise<void> => {
    setPending(true);
    try {
      setEnvelope(await api.searchMemories({ query, scope: activeScope }));
    } catch {
      setMessage(translate(locale, "memory.error"));
    } finally {
      setPending(false);
    }
  };

  const exportMemories = async (): Promise<void> => {
    setPending(true);
    try {
      const result = await api.exportMemories();
      if (result.status === "saved") setMessage(translate(locale, "memory.exported"));
    } catch {
      setMessage(translate(locale, "memory.error"));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="content-page">
      <header className="page-header">
        <p className="page-eyebrow">{translate(locale, "memory.eyebrow")}</p>
        <h1>{translate(locale, "memory.title")}</h1>
        <p>{translate(locale, "memory.subtitle")}</p>
      </header>
      {conflict ? (
        <DocumentConflictNotice
          locale={locale}
          changedFields={conflict.fields}
          pending={pending}
          onReapply={() => void runMutation(conflict.mutation, true)}
        />
      ) : null}
      {message ? (
        <p className="page-message" role="status">
          {message}
        </p>
      ) : null}

      <section className="settings-card scope-panel">
        <label>
          <span>{translate(locale, "memory.scope")}</span>
          <select
            value={scopeDraft.mode}
            onChange={(event) => setScopeDraft(scopeFromMode(event.target.value, resolvedWorldId))}
          >
            <option value="global">{translate(locale, "memory.scope.global")}</option>
            <option value="world" disabled={!resolvedWorldId}>
              {translate(locale, "memory.scope.world")}
            </option>
            <option value="layered" disabled={!resolvedWorldId}>
              {translate(locale, "memory.scope.layered")}
            </option>
          </select>
        </label>
        {previewVisible ? (
          <div className="migration-preview" aria-live="polite">
            <p>{translate(locale, "memory.previewCount", { count: scopeCount })}</p>
            <div className="inline-actions">
              <button
                className="primary-button"
                type="button"
                disabled={pending}
                onClick={() => void applyScope()}
              >
                {translate(locale, "memory.applyScope")}
              </button>
              {rollbackScope ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={pending}
                  onClick={() => void rollback()}
                >
                  {translate(locale, "memory.rollbackScope")}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-card scope-panel">
        <label>
          <span>{translate(locale, "memory.migrationTarget")}</span>
          <select
            value={migrationTarget}
            onChange={(event) => {
              setMigrationTarget(event.target.value as StoredMemoryScope);
              setMigrationPreview(null);
              setMigrationCommitted(false);
            }}
          >
            <option value="global">{translate(locale, "memory.scope.global")}</option>
            <option value="world" disabled={!resolvedWorldId}>
              {translate(locale, "memory.scope.world")}
            </option>
          </select>
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={pending}
          onClick={() => void previewMigration()}
        >
          {translate(locale, "memory.previewMigration")}
        </button>
        {migrationPreview ? (
          <MemoryMigrationPreview
            locale={locale}
            preview={migrationPreview}
            pending={pending}
            committed={migrationCommitted}
            onCommit={() => void commitMigration()}
            onRollback={() => void rollbackMigration()}
          />
        ) : null}
      </section>

      <section className="settings-card memory-toolbar">
        <div className="memory-add">
          <label>
            <span>{translate(locale, "memory.new")}</span>
            <input
              value={summary}
              maxLength={160}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label>
            <span>{translate(locale, "memory.category")}</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as MemoryCategory)}
            >
              {categories.map((value) => (
                <option key={value} value={value}>
                  {translate(locale, `memory.category.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{translate(locale, "memory.importance")}</span>
            <select
              value={importance}
              onChange={(event) => setImportance(Number(event.target.value) as MemoryImportance)}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{translate(locale, "memory.newStorage")}</span>
            <select
              value={newStoredScope}
              onChange={(event) => setNewStoredScope(event.target.value as StoredMemoryScope)}
            >
              <option value="global">{translate(locale, "memory.scope.global")}</option>
              <option value="world" disabled={!resolvedWorldId}>
                {translate(locale, "memory.scope.world")}
              </option>
            </select>
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={pending || summary.trim().length === 0}
            onClick={() => void runMutation({ kind: "add" })}
          >
            {translate(locale, "memory.add")}
          </button>
        </div>
        <div className="memory-search">
          <label>
            <span>{translate(locale, "memory.search")}</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={pending}
            onClick={() => void search()}
          >
            {translate(locale, "memory.searchAction")}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={pending}
            onClick={() => void exportMemories()}
          >
            {translate(locale, "memory.export")}
          </button>
        </div>
      </section>

      {envelope.records.length === 0 ? (
        <p className="empty-state">{translate(locale, "memory.empty")}</p>
      ) : (
        <ul className="memory-list">
          {envelope.records.map((record) => (
            <li key={record.id} aria-label={record.summary}>
              <div className="memory-record__body">
                <div>
                  <span className="memory-source">
                    {translate(locale, `memory.source.${record.source}`)}
                  </span>
                  <p>{record.summary}</p>
                </div>
                <span>{"★".repeat(record.importance)}</span>
              </div>
              {editingId === record.id ? (
                <div className="memory-edit">
                  <label>
                    <span>{translate(locale, "memory.editLabel")}</span>
                    <input
                      value={editSummary}
                      onChange={(event) => setEditSummary(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{translate(locale, "memory.recordStorage")}</span>
                    <select
                      value={editStoredScope}
                      onChange={(event) =>
                        setEditStoredScope(event.target.value as StoredMemoryScope)
                      }
                    >
                      <option value="global">{translate(locale, "memory.scope.global")}</option>
                      <option value="world" disabled={!resolvedWorldId}>
                        {translate(locale, "memory.scope.world")}
                      </option>
                    </select>
                  </label>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={pending}
                    onClick={() => void runMutation({ kind: "update", id: record.id })}
                  >
                    {translate(locale, "memory.save")}
                  </button>
                </div>
              ) : null}
              <div className="inline-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setEditingId(record.id);
                    setEditSummary(record.summary);
                    setEditStoredScope(record.scope);
                  }}
                >
                  {translate(locale, "memory.edit")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={record.source === "automatic" || pending}
                  aria-label={
                    record.source === "automatic"
                      ? translate(locale, "memory.automaticNoPin")
                      : translate(locale, record.pinned ? "memory.unpin" : "memory.pin")
                  }
                  onClick={() =>
                    void runMutation({ kind: "pin", id: record.id, pinned: !record.pinned })
                  }
                >
                  {record.source === "automatic"
                    ? translate(locale, "memory.automaticNoPin")
                    : translate(locale, record.pinned ? "memory.unpin" : "memory.pin")}
                </button>
                <button
                  className="secondary-button danger-button"
                  type="button"
                  disabled={pending}
                  onClick={() => void runMutation({ kind: "forget", id: record.id })}
                >
                  {translate(locale, "memory.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

async function invokeMutation(
  api: MemoryPageProps["api"],
  envelope: ScopedMemoryExport,
  mutation: PendingMutation,
  draft: {
    summary: string;
    category: MemoryCategory;
    importance: MemoryImportance;
    editSummary: string;
    newStoredScope: StoredMemoryScope;
    editStoredScope: StoredMemoryScope;
  },
) {
  if (mutation.kind === "add") {
    return api.addMemory({
      expectedRevision: envelope.revision,
      memory: {
        category: draft.category,
        summary: draft.summary.trim(),
        importance: draft.importance,
        scope: draft.newStoredScope,
      },
    });
  }
  const record = envelope.records.find((item) => item.id === mutation.id);
  if (!record) throw new Error("memory is no longer available");
  const common = {
    id: record.id,
    expectedRevision: envelope.revision,
    recordRevision: record.revision,
  };
  if (mutation.kind === "update") {
    return api.updateMemory({
      ...common,
      patch: { summary: draft.editSummary.trim(), scope: draft.editStoredScope },
    });
  }
  if (mutation.kind === "forget") return api.forgetMemory(common);
  return api.pinMemory({ ...common, pinned: mutation.pinned });
}

function recordsForScope(
  records: readonly ScopedMemoryRecord[],
  scope: MemoryContextScope,
): ScopedMemoryRecord[] {
  if (scope.mode === "global") return records.filter((record) => record.scope === "global");
  if (scope.mode === "world") {
    return records.filter((record) => record.scope === "world" && record.worldId === scope.worldId);
  }
  return records.filter((record) => record.scope === "global" || record.worldId === scope.worldId);
}

function scopeFromMode(mode: string, worldId?: string): MemoryContextScope {
  if (mode === "global" || !worldId) return { mode: "global" };
  return mode === "world" ? { mode: "world", worldId } : { mode: "layered", worldId };
}

function sameScope(left: MemoryContextScope, right: MemoryContextScope): boolean {
  return left.mode === right.mode && left.worldId === right.worldId;
}

function isDocumentConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("DOCUMENT_CONFLICT:");
}

function memoryChangedFields(
  locale: Locale,
  previous: ScopedMemoryExport,
  latest: ScopedMemoryExport,
  mutation: PendingMutation,
): string[] {
  if (mutation.kind === "add") return [translate(locale, "memory.title")];
  const before = previous.records.find((record) => record.id === mutation.id);
  const after = latest.records.find((record) => record.id === mutation.id);
  if (!before || !after) return [translate(locale, "memory.title")];
  const changed = ["summary", "category", "importance", "scope", "pinned"].filter(
    (field) =>
      JSON.stringify(before[field as keyof ScopedMemoryRecord]) !==
      JSON.stringify(after[field as keyof ScopedMemoryRecord]),
  );
  return changed.length > 0 ? changed : [translate(locale, "memory.title")];
}
