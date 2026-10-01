import { fail } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { ActorContext, Participant } from "../core/types.js";
import type { WorkflowState } from "../orchestration/workflow.js";
import type { Store } from "../storage/store.js";
import type { TaskService } from "../tasks/service.js";
import {
  type DetailEntry,
  type DetailSegment,
  TASK_DETAIL_SECTION_HELP,
  TASK_DETAIL_SECTIONS,
  type TaskDetailSection,
  taskDetailSectionEntries,
  type WorkflowStateReader,
  workflowOf,
} from "./task-detail-sections.js";
import { modelBytes } from "./task-views.js";

export const TASK_DETAIL_DEFAULT_BYTES = 12_000;
export const TASK_DETAIL_MAX_BYTES = 16_000;
const CURSOR_VERSION = 2;
const FINGERPRINT_CHARS = 16;
/** Reserve for counter fields that are zero in the measured envelope. */
const ENVELOPE_SLACK = 12;
const PROGRESS_NOTE = "分页未结束：用 cursor 继续读取本记录剩余正文。";
const PAGE_NOTE = "cursor 只对同一任务、同一 section 且内容未变化时有效。";

/** One canonical text window returned on this page. */
export interface RenderedSegment {
  /** Canonical location inside the record, e.g. `snapshot.original`. */
  path: string;
  /** `json` means the canonical content is the serialized JSON of that value. */
  encoding: "text" | "json";
  /** Character offset inside the canonical segment where this window starts. */
  offset: number;
  /** Bytes of the complete canonical segment. */
  totalBytes: number;
  /** Characters in the complete canonical segment. */
  totalChars: number;
  /** True when this window reaches the end of the canonical segment. */
  complete: boolean;
  /** Character offset to continue from; absent when the segment is complete. */
  nextOffset?: number;
}

/**
 * One record, or one page-sized part of a record. A record whose field values
 * exceed the page budget is returned as several occurrences with the same `id`;
 * every occurrence except the last states `partial: true`. Canonical text of
 * oversized values is paged through `body`, and `segments` names its exact
 * canonical location, so concatenating pages reproduces the record losslessly.
 */
export interface RenderedEntry {
  id: string;
  /** Canonical field values delivered on this page; no field is ever dropped. */
  fields?: Record<string, unknown>;
  /** Exact canonical text delivered on this page, in canonical order. */
  body?: string;
  /** Characters of `body` on this occurrence; `segments[].offset` gives its place. */
  bodyChars?: number;
  segments?: RenderedSegment[];
  /** True when later pages still carry content of this record. */
  partial?: boolean;
  omitted?: string;
}

export interface TaskDetailPage {
  taskId: string;
  section: TaskDetailSection;
  sectionDescription?: string;
  entries: RenderedEntry[];
  returnedEntries: number;
  totalEntries: number;
  /** True only when this page returned the final content of every record. */
  complete: boolean;
  /** Records whose canonical content continues on a later page. */
  omittedFields: number;
  /** Opaque continuation for this task, this section and this exact content. */
  cursor?: string;
  interpretation?: string;
}

export interface TaskDetailServices {
  tasks: TaskService;
  store: Store;
}

export function isTaskDetailSection(value: unknown): value is TaskDetailSection {
  return typeof value === "string" && (TASK_DETAIL_SECTIONS as readonly string[]).includes(value);
}

/**
 * Content fingerprint: every canonical record id plus the digest of its full
 * content, so a same-length edit invalidates cursors instead of splicing two
 * different versions into one apparent original.
 */
function fingerprint(section: TaskDetailSection, entries: DetailEntry[]): string {
  return stableId(
    "task-detail-section-v2",
    section,
    ...entries.map((entry) => `${entry.id}\u0000${entry.digest}`),
  ).slice(0, FINGERPRINT_CHARS);
}

interface Cursor {
  entry: number;
  atom: number;
  offset: number;
}

function encodeCursor(
  taskId: string,
  section: TaskDetailSection,
  content: string,
  cursor: Cursor,
): string {
  return Buffer.from(
    JSON.stringify([
      CURSOR_VERSION,
      taskId,
      section,
      content,
      cursor.entry,
      cursor.atom,
      cursor.offset,
    ]),
  ).toString("base64url");
}

function index(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeCursor(
  value: string,
  taskId: string,
  section: TaskDetailSection,
  expected: string,
): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail("invalid_cursor", "详情分页游标无效，请重新读取该 section。");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 7 ||
    parsed[0] !== CURSOR_VERSION ||
    parsed[1] !== taskId ||
    parsed[2] !== section ||
    parsed[3] !== expected ||
    !index(parsed[4]) ||
    !index(parsed[5]) ||
    !index(parsed[6])
  )
    fail("invalid_cursor", "详情分页游标不属于当前任务或 section，或记录内容已更新，请重新读取。");
  return { entry: parsed[4], atom: parsed[5], offset: parsed[6] };
}

interface EntryPlan {
  id: string;
  fields: Array<[string, unknown]>;
  segments: DetailSegment[];
}

function planEntry(entry: DetailEntry): EntryPlan {
  return { id: entry.id, fields: Object.entries(entry.fields), segments: entry.segments };
}

function atomCount(plan: EntryPlan): number {
  // Every record carries at least one identity atom, so a page can always name it.
  return Math.max(1, plan.fields.length + plan.segments.length);
}

interface Occurrence {
  id: string;
  fields: Record<string, unknown>;
  hasFields: boolean;
  body: string;
  segments: RenderedSegment[];
  finished: boolean;
}

function newOccurrence(plan: EntryPlan): Occurrence {
  return {
    id: plan.id,
    fields: {},
    hasFields: false,
    body: "",
    segments: [],
    finished: false,
  };
}

function rendered(occurrence: Occurrence): RenderedEntry {
  return {
    id: occurrence.id,
    ...(occurrence.hasFields ? { fields: occurrence.fields } : {}),
    ...(occurrence.body ? { body: occurrence.body, bodyChars: occurrence.body.length } : {}),
    ...(occurrence.segments.length ? { segments: occurrence.segments } : {}),
    ...(occurrence.finished ? {} : { partial: true, omitted: PROGRESS_NOTE }),
  };
}

/**
 * Render one section into byte-bounded pages. The complete returned envelope —
 * UTF-8 escaping, section metadata, and the continuation cursor — is measured
 * against `limitBytes`; irreducible framing fails with a typed `context_budget`
 * error rather than returning an oversized page or silently dropping content.
 */
export async function taskDetailPage(
  services: TaskDetailServices,
  actor: ActorContext,
  taskId: string,
  options: { section: string; cursor?: string; limitBytes?: number },
): Promise<TaskDetailPage> {
  if (!isTaskDetailSection(options.section))
    fail("input", `section 必须是：${TASK_DETAIL_SECTIONS.join("、")}。`);
  const section = options.section;
  const limitBytes = options.limitBytes ?? TASK_DETAIL_DEFAULT_BYTES;
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 512 || limitBytes > TASK_DETAIL_MAX_BYTES)
    fail("input", `limitBytes 必须是 512 到 ${TASK_DETAIL_MAX_BYTES} 之间的整数。`);
  // TaskService.get enforces owner, chat and bound-task scope before any read.
  const task = services.tasks.get(actor, taskId);
  // Resolved at most once, and only when the requested section needs it: a
  // participants page must not read or deserialize the workflow record.
  let cachedState: WorkflowState | undefined;
  let stateRead = false;
  const state: WorkflowStateReader = () => {
    if (!stateRead) {
      cachedState = workflowOf(services.store, task.id);
      stateRead = true;
    }
    return cachedState;
  };
  const participants = task.participants as unknown as Participant[];
  const entries = await taskDetailSectionEntries(
    services.store,
    task,
    state,
    participants,
    section,
  );
  const content = fingerprint(section, entries);
  const plans = entries.map(planEntry);
  const start: Cursor = options.cursor
    ? decodeCursor(options.cursor, task.id, section, content)
    : { entry: 0, atom: 0, offset: 0 };
  const firstPlan = start.entry < entries.length ? (plans[start.entry] as EntryPlan) : undefined;
  let position: Cursor = {
    entry: Math.min(start.entry, entries.length),
    atom: firstPlan ? Math.min(start.atom, atomCount(firstPlan)) : 0,
    offset: start.offset,
  };
  // The probe is the longest cursor this page could carry, so a measured page
  // that includes it is an upper bound for the page actually returned.
  const probe = encodeCursor(task.id, section, content, {
    entry: 999_999,
    atom: 999_999,
    offset: 999_999_999,
  });
  const description = TASK_DETAIL_SECTION_HELP[section];
  let decorated = true;
  const measure = (occurrences: Occurrence[]): number =>
    modelBytes({
      taskId: task.id,
      section,
      ...(decorated ? { sectionDescription: description, interpretation: PAGE_NOTE } : {}),
      entries: occurrences.map(rendered),
      returnedEntries: occurrences.length,
      totalEntries: entries.length,
      complete: false,
      omittedFields: occurrences.filter((occurrence) => !occurrence.finished).length,
      cursor: probe,
    }) + ENVELOPE_SLACK;
  const occurrences: Occurrence[] = [];
  let emitted = 0;
  let budgetError = false;
  while (position.entry < entries.length) {
    const plan = plans[position.entry] as EntryPlan;
    const count = atomCount(plan);
    if (position.atom >= count) {
      position = { entry: position.entry + 1, atom: 0, offset: 0 };
      continue;
    }
    const isField = position.atom < plan.fields.length;
    const field = isField ? plan.fields[position.atom] : undefined;
    const segment = isField ? undefined : plan.segments[position.atom - plan.fields.length];
    // The occurrence content is added to: reopen the previous one only when it
    // still belongs to this record, so a page never shows a phantom record.
    const tail = occurrences.at(-1);
    let current = tail && !tail.finished && tail.id === plan.id ? tail : { ...newOccurrence(plan) };
    let open = current === tail;
    const withContent = (patch: Partial<Occurrence>): Occurrence => ({ ...current, ...patch });
    const place = (patch: Partial<Occurrence>): void => {
      current = withContent(patch);
      if (open) occurrences[occurrences.length - 1] = current;
      else occurrences.push(current);
      open = true;
    };
    const pending = (candidate: Occurrence): Occurrence[] =>
      open ? [...occurrences.slice(0, -1), candidate] : [...occurrences, candidate];
    if (field) {
      const candidate = withContent({
        fields: { ...current.fields, [field[0]]: field[1] },
        hasFields: true,
      });
      if (measure(pending(candidate)) > limitBytes) {
        // This field value cannot be inlined within the page budget. It is
        // already a bounded projection, so fail typed instead of dropping it.
        if (!emitted && decorated) {
          decorated = false;
          continue;
        }
        if (emitted) break;
        budgetError = true;
        break;
      }
      place(candidate);
      emitted++;
      position = { entry: position.entry, atom: position.atom + 1, offset: 0 };
      if (position.atom >= count) current.finished = true;
      continue;
    }
    if (!segment) {
      // A record with no projected content still reports its identity once.
      place({ finished: true });
      emitted++;
      position = { entry: position.entry + 1, atom: 0, offset: 0 };
      continue;
    }
    // A cursor offset inside a segment is only meaningful for that segment; a
    // cursor from a different location restarts at its beginning.
    const from = position.offset < segment.text.length ? position.offset : 0;
    const rest = segment.text.slice(from);
    const totalBytes = Buffer.byteLength(segment.text, "utf8");
    const windowFor = (window: string): Occurrence => {
      const consumed = from + window.length;
      const completed = consumed >= segment.text.length;
      return withContent({
        body: current.body + window,
        segments: [
          ...current.segments,
          {
            path: segment.path,
            encoding: segment.encoding,
            offset: from,
            totalBytes,
            totalChars: segment.text.length,
            complete: completed,
            ...(completed ? {} : { nextOffset: consumed }),
          },
        ],
      });
    };
    // Only a non-empty window counts as progress; an empty one would leave the
    // cursor where it was and repeat this same position forever.
    const chosen = fitWindow(rest, (window) => {
      if (!window.length) return false;
      return measure(pending(windowFor(window))) <= limitBytes;
    });
    if (chosen === undefined) {
      if (!emitted && decorated) {
        decorated = false;
        continue;
      }
      if (emitted) break;
      budgetError = true;
      break;
    }
    place(windowFor(chosen));
    emitted++;
    const consumed = from + chosen.length;
    if (consumed >= segment.text.length) {
      position = { entry: position.entry, atom: position.atom + 1, offset: 0 };
      if (position.atom >= count) current.finished = true;
    } else {
      position = { entry: position.entry, atom: position.atom, offset: consumed };
    }
  }
  if (!emitted && !budgetError && entries.length) budgetError = true;
  if (budgetError)
    fail(
      "context_budget",
      "详情分页的必需元数据超过本页字节预算，已保留记录原文；请调大 limitBytes 或改用更细的 section。",
    );
  const complete = position.entry >= entries.length && position.offset === 0;
  const cursor = complete ? undefined : encodeCursor(task.id, section, content, position);
  // Every record the cursor has not moved past still has content on a later page.
  const partialRecords = Math.max(0, entries.length - position.entry);
  return {
    taskId: task.id,
    section,
    ...(decorated ? { sectionDescription: description, interpretation: PAGE_NOTE } : {}),
    entries: occurrences.map(rendered),
    returnedEntries: new Set(occurrences.map((occurrence) => occurrence.id)).size,
    totalEntries: entries.length,
    complete,
    omittedFields: complete ? 0 : Math.max(1, partialRecords),
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * Longest non-empty window of `text` accepted by `fits`, never splitting a
 * surrogate pair. `undefined` means even one character does not fit, so the
 * caller must end the page (or fail typed) instead of stalling the cursor.
 */
function fitWindow(text: string, fits: (window: string) => boolean): string | undefined {
  if (fits(text)) return text;
  let low = 1;
  let high = text.length;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let candidate = text.slice(0, middle);
    const last = candidate.charCodeAt(candidate.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) candidate = candidate.slice(0, -1);
    if (candidate.length && fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export { TASK_DETAIL_SECTION_HELP, TASK_DETAIL_SECTIONS };

/** True when this actor may read a section page for this task at all. */
export function canReadTaskDetail(
  services: TaskDetailServices,
  actor: ActorContext,
  taskId: string,
) {
  try {
    services.tasks.get(actor, taskId);
    return true;
  } catch {
    return false;
  }
}
