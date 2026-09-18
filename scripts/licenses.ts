import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Metafile } from "esbuild";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
interface VendorEntry {
  file: string;
  source: string;
  sha256: string;
}
interface LicenseFile {
  name: string;
  bytes: Buffer;
  source: string;
}
interface PackageManifest {
  name: string;
  version: string;
  declaredLicense: unknown;
  files: Array<{ path: string; sha256: string; source: string }>;
}
interface Options {
  root?: string;
  nativePackages?: string[];
  nodeLicensePath?: string;
  vendorDirectory?: string;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const declaration = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i;

/** Resolve the package root, ignoring nested package.json files used only for module format. */
export function packageRoot(input: string, root = sourceRoot): string | undefined {
  const normalized = input.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const index = parts.lastIndexOf("node_modules");
  const name = parts[index + 1];
  if (index < 0 || !name) return undefined;
  const packageParts = parts.slice(0, index + (name.startsWith("@") ? 3 : 2));
  return resolve(root, packageParts.join("/"));
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function packageLicenses(
  directory: string,
  identity: string,
  root: string,
  vendorDirectory: string,
): Promise<LicenseFile[]> {
  const files: LicenseFile[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    if (declaration.test(name) && (await exists(path))) {
      const bytes = await readFile(path);
      if (!bytes.toString("utf8").trim())
        throw new Error(`Empty license declaration: ${identity}/${name}`);
      files.push({ name, bytes, source: relative(root, path) });
    }
  }
  // Some npm tarballs retain the complete permission and copyright text only in README.
  if (!files.some((file) => /^(licen[cs]e|copying)/i.test(file.name))) {
    for (const name of (await readdir(directory)).filter((file) => /^readme(?:\.|$)/i.test(file))) {
      const content = await readFile(join(directory, name), "utf8");
      const heading = /(?:^|\n)(?:#{1,6} License\s*\n|License\s*\n[-=]+\s*\n)/i.exec(content);
      const section = heading
        ? content.slice(heading.index + Number(content[heading.index] === "\n"))
        : "";
      if (
        section.includes("Permission is hereby granted") &&
        /THE SOFTWARE IS PROVIDED/i.test(section)
      ) {
        files.push({
          name: "README-LICENSE.txt",
          bytes: Buffer.from(section),
          source: `${relative(root, join(directory, name))}#license`,
        });
        break;
      }
    }
  }
  if (!files.some((file) => /^(licen[cs]e|copying|README-LICENSE)/i.test(file.name))) {
    let entries: Record<string, VendorEntry> = {};
    const index = join(vendorDirectory, "sources.json");
    if (await exists(index)) entries = JSON.parse(await readFile(index, "utf8"));
    const pinned = entries[identity];
    if (!pinned || basename(pinned.file) !== pinned.file)
      throw new Error(`Missing complete license: ${identity}`);
    const bytes = await readFile(join(vendorDirectory, pinned.file));
    if (hash(bytes) !== pinned.sha256)
      throw new Error(`Vendored license hash mismatch: ${identity}`);
    files.push({ name: "LICENSE.txt", bytes, source: pinned.source });
  }
  return files;
}

async function nodeLicense(explicit?: string): Promise<string> {
  const candidates = explicit
    ? [explicit]
    : [
        resolve(dirname(process.execPath), "../LICENSE"),
        resolve(dirname(process.execPath), "../share/doc/node/LICENSE"),
        resolve(dirname(process.execPath), "../share/doc/nodejs/LICENSE"),
      ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error(
    "Missing Node distribution LICENSE; install Node from its official distribution with the complete LICENSE file",
  );
}

/** Offline build step. Release archives must include the generated LICENSES directory. */
export async function generateLicenses(
  metafile: Metafile,
  outdir: string,
  options: Options = {},
): Promise<void> {
  const root = resolve(options.root ?? sourceRoot);
  const vendorDirectory = options.vendorDirectory ?? join(root, "licenses", "vendor");
  const inputs = Object.values(metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, info]) => info.bytesInOutput > 0)
      .map(([input]) => input),
  );
  const packages = new Set(
    inputs.map((input) => packageRoot(input, root)).filter((value): value is string => !!value),
  );
  for (const name of options.nativePackages ?? ["fs-ext", "nan"])
    packages.add(join(root, "node_modules", name));
  const prepared: Array<{ manifest: PackageManifest; files: LicenseFile[]; folder: string }> = [];
  const identities = new Map<string, string>();
  for (const directory of [...packages].sort()) {
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
      throw new Error(`Invalid dependency metadata: ${relative(root, directory)}`);
    const identity = `${pkg.name}@${pkg.version}`;
    const files = await packageLicenses(directory, identity, root, vendorDirectory);
    const signature = files.map((file) => `${file.name}:${hash(file.bytes)}`).join("\n");
    const prior = identities.get(identity);
    if (prior && prior !== signature) throw new Error(`Conflicting license copies: ${identity}`);
    if (prior) continue;
    identities.set(identity, signature);
    const folder = identity.replace(/[^a-zA-Z0-9._-]/g, "_");
    prepared.push({
      folder,
      files,
      manifest: {
        name: pkg.name,
        version: pkg.version,
        declaredLicense: pkg.license ?? pkg.licenses ?? null,
        files: files.map((file) => ({
          path: `${folder}/${file.name}`,
          sha256: hash(file.bytes),
          source: file.source,
        })),
      },
    });
  }
  const runtimeLicense = await nodeLicense(options.nodeLicensePath);
  const runtimeBytes = await readFile(runtimeLicense);
  if (!runtimeBytes.toString("utf8").includes("Node.js is licensed for use as follows"))
    throw new Error("Node LICENSE is not the complete distribution notice");
  const destination = resolve(outdir, "LICENSES");
  const temporary = resolve(outdir, `.LICENSES-${process.pid}-${Date.now()}`);
  await mkdir(temporary, { recursive: true });
  try {
    for (const { folder, files } of prepared) {
      await mkdir(join(temporary, folder));
      for (const file of files) await writeFile(join(temporary, folder, file.name), file.bytes);
    }
    await copyFile(runtimeLicense, join(temporary, "NODE-LICENSE.txt"));
    await writeFile(
      join(temporary, "manifest.json"),
      `${JSON.stringify(
        {
          version: 1,
          node: {
            version: process.versions.node,
            file: "NODE-LICENSE.txt",
            sha256: hash(runtimeBytes),
            source: `https://github.com/nodejs/node/blob/v${process.versions.node}/LICENSE`,
          },
          packages: prepared.map((entry) => entry.manifest),
        },
        null,
        2,
      )}\n`,
    );
    const index = [
      "# Third-party notices",
      "",
      "This directory accompanies the herdr-agent executable. Keep it with redistributed release archives.",
      "Original license and notice texts are copied without rewriting. Native fs-ext/nan and the complete Node distribution notice are included.",
      "",
      `Node ${process.versions.node}: NODE-LICENSE.txt`,
      "",
      "| Package | Version | Declaration files |",
      "| --- | --- | --- |",
      ...prepared.map(
        ({ manifest }) =>
          `| ${manifest.name} | ${manifest.version} | ${manifest.files.map((file) => file.path).join(", ")} |`,
      ),
      "",
      "manifest.json records exact package versions, source locations and SHA-256 digests.",
      "",
    ];
    await writeFile(join(temporary, "README.md"), index.join("\n"));
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
