import { defaultPackageName, packageName, releaseVersion } from "./npm/config.js";
import { verifyRegistry } from "./npm/download.js";
import { prepareDistribution } from "./npm/prepare.js";
import { publishDistribution } from "./npm/publish.js";
import { verifyDistribution } from "./npm/verify.js";

const [command, tag, input, output] = process.argv.slice(2);
if (!command || command === "--help") {
  process.stdout.write(
    "Usage: node --import tsx scripts/npm.ts <validate|prepare|verify|publish|download> <vSEMVER> [archives-or-packages-dir|commit] [output-dir]\nNPM_PACKAGE_NAME defaults to myrix; prepare is offline, verify installs locally offline, download checks public registry installation, only publish writes to npm.\n",
  );
} else {
  if (!tag) throw new Error("A release tag is required");
  releaseVersion(tag);
  const name = packageName(process.env.NPM_PACKAGE_NAME || defaultPackageName);
  if (command === "validate") process.stdout.write(`${name}@${releaseVersion(tag).version}\n`);
  else if (command === "prepare" && input && output) {
    const distribution = await prepareDistribution(tag, name, input, output);
    process.stdout.write(
      `Packed ${distribution.packages.length} packages for ${name}@${distribution.version}\n`,
    );
  } else if (command === "verify" && input) {
    await verifyDistribution(input, tag, name);
    process.stdout.write(
      `Offline npm install and both command aliases verified for ${name}@${releaseVersion(tag).version}\n`,
    );
  } else if (command === "publish" && input) {
    const published = await publishDistribution(input, tag, name);
    process.stdout.write(
      `Published ${published.length} packages; identical existing versions were skipped\n`,
    );
  } else if (command === "download" && input) {
    await verifyRegistry(tag, name, input);
    process.stdout.write(
      `Public npm install and both aliases verified: ${name}@${releaseVersion(tag).version}, ${process.platform}/${process.arch}, ${input}\n`,
    );
  } else throw new Error("Invalid npm distribution command or arguments; use --help");
}
