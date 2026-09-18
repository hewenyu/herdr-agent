import { createHash } from "node:crypto";
import { OperationError } from "../core/errors.js";

export type Fields = Record<string, unknown>;
export interface SourceFile {
  name: string;
  bytes: Buffer;
  sha256: string;
  modifiedAt: string;
  data?: Fields;
}
export interface ImportRecord {
  namespace: string;
  key: string;
  value: unknown;
}
export const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\0")).digest("hex");
export function fields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Fields;
}
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
export function invalid(detail = "旧版状态格式不完整或无法验证"): never {
  throw new OperationError("migration_invalid", `${detail}；未修改旧文件或导入数据库。`);
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
export function version(data: Fields): void {
  if (data.version !== 1) invalid("旧版状态版本不受支持");
}
export function booleans(data: Fields, keys: string[]): void {
  for (const key of keys)
    if (data[key] !== undefined && typeof data[key] !== "boolean") invalid("旧版布尔状态格式无效");
}
export function generation(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid("旧会话代数不安全");
  return value;
}
export function timestamp(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    !value.startsWith("0001-")
    ? value
    : fallback;
}
export function sessionId(owner: string, chat: string, task = "", archive = ""): string {
  return `legacy_s_${hash(owner, chat, task, archive).slice(0, 32)}`;
}
export class ImportPlan {
  private readonly records = new Map<string, ImportRecord>();
  readonly warnings = new Set<string>();
  add(namespace: string, key: string, value: unknown): void {
    this.records.set(`${namespace}\0${key}`, { namespace, key, value });
  }
  get<T>(namespace: string, key: string): T | undefined {
    return this.records.get(`${namespace}\0${key}`)?.value as T | undefined;
  }
  all(): ImportRecord[] {
    return [...this.records.values()];
  }
}
