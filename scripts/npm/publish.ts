import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { registry } from "./config.js";
import type { Distribution, PackedPackage } from "./prepare.js";
import { loadDistribution, requireVerification } from "./verify.js";

export interface RegistryPort {
  integrity(name: string, version: string): Promise<string | undefined>;
  publish(item: PackedPackage, distTag: Distribution["distTag"]): Promise<void>;
}

export interface PublishConfirmationOptions {
  /** Number of registry reads allowed after npm accepts a publish. */
  confirmationAttempts?: number;
  /** Delay between reads while the registry processes the package. */
  confirmationDelayMs?: number;
  /** Injectable delay for deterministic tests. */
  pause?: (delayMs: number) => Promise<void>;
}

const defaultConfirmationAttempts = 30;
const defaultConfirmationDelayMs = 5_000;

async function confirmPublished(
  item: PackedPackage,
  port: RegistryPort,
  options: Required<PublishConfirmationOptions>,
): Promise<void> {
  for (let attempt = 0; attempt < options.confirmationAttempts; attempt++) {
    const actual = await port.integrity(item.name, item.version);
    if (actual === item.integrity) return;
    if (actual !== undefined)
      throw new Error(`Published integrity did not match: ${item.name}@${item.version}`);
    if (attempt + 1 < options.confirmationAttempts)
      await options.pause(options.confirmationDelayMs);
  }
  throw new Error(
    `Published package was not visible after ${options.confirmationAttempts} registry checks: ${item.name}@${item.version}`,
  );
}

/** Preflight every immutable version before the first write. The launcher is always last. */
export async function publishVerified(
  distribution: Distribution,
  port: RegistryPort,
  options: PublishConfirmationOptions = {},
): Promise<string[]> {
  const confirmation = {
    confirmationAttempts: options.confirmationAttempts ?? defaultConfirmationAttempts,
    confirmationDelayMs: options.confirmationDelayMs ?? defaultConfirmationDelayMs,
    pause:
      options.pause ??
      ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
  };
  if (confirmation.confirmationAttempts < 1)
    throw new Error("confirmationAttempts must be at least 1");
  if (confirmation.confirmationDelayMs < 0)
    throw new Error("confirmationDelayMs must not be negative");
  const missing: PackedPackage[] = [];
  for (const item of distribution.packages) {
    const existing = await port.integrity(item.name, item.version);
    if (existing === undefined) missing.push(item);
    else if (existing !== item.integrity)
      throw new Error(
        `${item.name}@${item.version} already exists with different integrity; refusing the whole publish attempt`,
      );
  }
  const published: string[] = [];
  for (const item of missing) {
    await port.publish(item, distribution.distTag);
    await confirmPublished(item, port, confirmation);
    published.push(item.name);
  }
  return published;
}

export async function publishDistribution(
  directory: string,
  tag: string,
  name: string,
): Promise<string[]> {
  const distribution = await loadDistribution(directory, tag, name);
  await requireVerification(directory, distribution);
  if (!process.env.NODE_AUTH_TOKEN)
    throw new Error("NODE_AUTH_TOKEN is required for the publish command");
  return publishVerified(distribution, {
    async integrity(packageName, version) {
      const result = spawnSync(
        "npm",
        ["view", `${packageName}@${version}`, "dist.integrity", "--json", "--registry", registry],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      if (result.error)
        throw new Error(`npm view failed for ${packageName}@${version}: ${result.error.message}`);
      if (result.status !== 0) {
        let code: unknown;
        try {
          code = (JSON.parse(result.stdout) as { error?: { code?: string } }).error?.code;
        } catch {
          /* Never treat an unparseable/network/auth failure as a missing package. */
        }
        if (code === "E404") return undefined;
        throw new Error(
          `npm view could not confirm ${packageName}@${version} (exit ${result.status}, code ${String(code ?? "unknown")})`,
        );
      }
      const value: unknown = JSON.parse(result.stdout);
      if (typeof value !== "string" || !value.startsWith("sha512-"))
        throw new Error(`Registry returned no SHA-512 integrity for ${packageName}@${version}`);
      return value;
    },
    async publish(item, distTag) {
      const result = spawnSync(
        "npm",
        [
          "publish",
          resolve(directory, item.tarball),
          "--access",
          "public",
          "--tag",
          distTag,
          "--ignore-scripts",
          "--registry",
          registry,
        ],
        { stdio: "inherit", timeout: 120_000 },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `npm publish failed for ${item.name}@${item.version}; rerun with the identical verified tarballs after checking the registry`,
        );
    },
  });
}
