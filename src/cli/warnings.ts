/**
 * SEA forwards application arguments without Node's normal flag parsing.
 * Node 24's native warning renderer reads this switch for every warning;
 * set it before loading runtime dependencies and leave all handlers intact.
 */
export function configureWarningTraces(enabled: boolean): void {
  const runtime = process as NodeJS.Process & { traceProcessWarnings?: boolean };
  // Native --trace-warnings already sets a read-only true alias. Do not assign it again.
  if (enabled && !runtime.traceProcessWarnings) runtime.traceProcessWarnings = true;
}
