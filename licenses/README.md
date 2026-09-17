# Bundled third-party license sources

`npm run build` generates `dist/LICENSES/` from packages that contribute code to the esbuild bundle, plus the embedded `fs-ext` addon, its `nan` headers, and the Node distribution's complete license/third-party notice. Release archives must retain this directory alongside the executable and this project's LICENSE.

Most declarations are copied from the installed npm package. `agent-base` and `https-proxy-agent` include their complete MIT permission text in a README section, which is copied verbatim. The following fixed-version packages omit that text from their npm tarballs:

- `@earendil-works/{pi-agent-core,pi-ai,chord,pi-telemetry}@0.85.1`: registry `gitHead` is `d981de1229ef899957bbe968bc8dcda02a21f477`; `vendor/pi-0.85.1-LICENSE.txt` is the unmodified repository root LICENSE at that commit.
- `standardwebhooks@1.1.1`: registry `gitHead` is `b4d2c14fc5b4ccff3ff271e3b087dff812254c59`; `vendor/standardwebhooks-1.1.1-LICENSE.txt` is the unmodified **libraries/LICENSE** at that commit. The repository root has a different license and is not substituted for this library's MIT declaration.

`vendor/sources.json` records exact package/version keys, source URLs and SHA-256 digests. Builds do not download notices: an unrecognized package with no complete declaration, a changed vendor file, or a missing Node distribution LICENSE fails the build. Dependency updates must retain the applicable original declarations. Third-party legal texts are copied materials, not hand-written application source; do not truncate them to satisfy source-file line limits.
