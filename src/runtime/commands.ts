/** Explicit session controls bypass the model; ordinary language remains a pi turn. */
export function isClearCommand(text: string): boolean {
  return text.trim() === "/clear";
}
