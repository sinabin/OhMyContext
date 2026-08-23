# Release compliance evidence

Status: implemented foundation, not a public-release approval.

OwnContext does not yet have a selected open-source license. The commands in
this document do not override `LICENSE-STATUS.md`, authorize redistribution, or
replace legal review. Without `--draft`, the tooling deliberately fails until a
top-level `LICENSE` and SPDX license metadata exist for the root and every
OwnContext workspace.

## Evidence boundary

Compliance is evaluated against the **unpacked application payload**, not a
source tree and not a declared dependency list alone. Run the tool before the
maker and require that those verified application files enter the `.nupkg`
unchanged. Squirrel also adds its own files, so this application-payload result
does not describe the complete maker output. Before publication, extract the
setup artifact and verify both the application payload and the separately
inventoried maker layer.

Electron ASAR archives are inspected with the locked `@electron/asar` build
tool: the checker walks archive paths, rejects links and unsafe paths, and reads
bounded `package.json` metadata for dependency classification. The SPDX file
inventory and checksum manifest record the final ASAR file's SHA-256 rather
than substituting a temporary extracted tree. Malformed or unauditable ASAR
archives fail closed. Passing a source-tree scan does not establish that an
installer contains the same files.

The generated evidence is:

- `compliance/THIRD_PARTY_NOTICES.txt` — installed license texts for the locked
  production npm graph plus Electron;
- `compliance/SBOM.spdx.json` — SPDX 2.3 package and unpacked-payload file
  inventory, including explicit entries for Electron's bundled Chromium
  components and the pinned Electron FFmpeg binary when present;
- `compliance/SHA256SUMS` — SHA-256 for every payload and generated compliance
  file except the checksum manifest itself.

The SBOM conservatively records the complete locked production graph. A package
may be listed even if bundling removed an unused module. Artifact file hashes
remain the evidence for what was actually staged. Future bundler metafiles can
narrow this package set, but must not silently omit bundled code.

## Generate and verify

Development-only draft generation is explicit:

```powershell
npm run compliance:generate:draft -- "C:\path\to\unpacked-payload"
npm run compliance:verify:draft -- "C:\path\to\unpacked-payload"
```

Draft output is marked `DRAFT — NOT FOR PUBLIC RELEASE`. The release commands
omit that flag and remain blocked while the licensing hold is active:

```powershell
npm run compliance:generate -- "C:\path\to\unpacked-payload"
npm run compliance:verify -- "C:\path\to\unpacked-payload"
```

Use `--output` only for a proper subdirectory of the artifact. The default is
`<artifact>/compliance`. `SOURCE_DATE_EPOCH` may be set to make SPDX timestamps
reproducible. Advanced options are available by invoking
`node scripts/release-compliance.mjs` directly; this avoids PowerShell's native
argument handling of option-like values passed through npm.

### Integrated unsigned Windows draft

The desktop `make` command runs the compliance boundary as one orchestration:

```powershell
npm run make --workspace @owncontext/desktop
```

The orchestrator validates and pins one `OWNCONTEXT_FORGE_BUILD_ID`, creates the
unpacked package, generates and verifies draft evidence under
`resources/compliance`, and only then runs Forge make with `--skip-package`.
The final smoke test re-verifies the unpacked payload and byte-compares all three
compliance files against their entries in the Squirrel `.nupkg` using size and
SHA-256. This proves the inspected `.nupkg` contains the verified evidence.

The current automated smoke does not independently parse the setup executable's
embedded PE payload. `Setup.exe` is made in the same Forge invocation from the
verified `.nupkg`, but an extraction-and-byte-comparison test for that outer
container remains a release-evidence boundary. These outputs remain unsigned,
draft-only, and prohibited from public release while the license hold applies.

The audit is specifically an **application-payload** audit. During make,
Squirrel adds `lib/net45/squirrel.exe`,
`lib/net45/OwnContextDeveloperPreview_ExecutionStub.exe`, and package metadata
to the `.nupkg`; `Setup.exe` also carries maker-generated bootstrap/update
bytes. Those maker-added components are not inventoried by the payload SPDX
document, third-party notices, or `SHA256SUMS`. Public release therefore
requires a second inventory and license/provenance review for the maker-added
`.nupkg`, setup, and update components, plus exact outer-container extraction
evidence.

## Enforced checks

The tool fails closed when:

- the artifact or compliance output crosses a path boundary or uses symlinks;
- the payload is empty, or an ASAR is malformed, unsafe, or exceeds audit
  limits;
- the exact installed Electron `LICENSE` or `LICENSES.chromium.html` is absent;
- an `ffmpeg.dll` is present but does not exactly match the installed, locked
  Electron distribution;
- a package marked development-only in `package-lock.json` appears under the
  artifact's `node_modules` tree, an inspected ASAR path, or a matching package
  manifest;
- a locked production dependency is missing, mismatched, unlicensed, or lacks
  installed license text;
- the notices or SPDX package/file inventory no longer match their evidence;
- a file is changed, removed, or added after `SHA256SUMS` generation; or
- non-draft use finds the project license unresolved.

Electron is intentionally declared as a development dependency because its
binary is embedded by desktop packaging. Its runtime license evidence is added
as an explicit exception; copying the `node_modules/electron` npm tool package
into the payload is not allowed.

The Chromium aggregate SBOM entry uses `NOASSERTION`; the authoritative
per-component license collection remains the exact `LICENSES.chromium.html`
copied into the artifact. A matching Electron `ffmpeg.dll` is recorded as
having the upstream-declared `LGPL-2.1-or-later` license while its concluded
license remains `NOASSERTION`; neither field alone satisfies the corresponding
source and relinking conditions listed below.

## Remaining release gates

This foundation does not yet prove:

- which OwnContext license the maintainer will select;
- that the installed Electron FFmpeg binary has an exact corresponding-source
  archive, patch set, and build configuration available beside the download;
- that codec patent obligations are satisfied in every target jurisdiction;
- that anonymous code flattened into a bundle came only from production
  dependencies when no package path, manifest, or bundler provenance remains;
- that the setup executable's embedded Squirrel payload has been independently
  extracted and byte-compared with the verified `.nupkg`;
- that Squirrel's maker-added execution stub, bootstrap/update components, and
  package metadata are covered by complete notices, SBOM, and checksums;
- that an installer is signed, reproducible, encrypted at rest, or safe; or
- that a future installer format can be inspected without extraction.

Release automation must archive the verified unpacked payload, installer,
checksums, SPDX SBOM, notices, exact dependency lockfile, Electron/FFmpeg source
evidence, and signing provenance together.

## Primary references

- [SPDX 2.3 JSON schema](https://github.com/spdx/spdx-spec/blob/v2.3/schemas/spdx-schema.json)
- [Electron 43.4.1 release build arguments](https://github.com/electron/electron/blob/v43.4.1/build/args/release.gn)
- [FFmpeg upstream license overview](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)

These references explain the metadata basis; they do not establish that the
particular Electron FFmpeg binary has complete corresponding source or a
redistributable codec configuration. That remains a release gate above.
