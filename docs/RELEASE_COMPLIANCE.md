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
maker and require that every verified application file enters the `.nupkg`
unchanged. The integrated Squirrel smoke test maps the complete regular-file
inventory to `lib/net45` by relative path, size, and SHA-256. It fails on a
missing or changed payload file and on any file outside the explicit
Squirrel/NuGet allowlist. Archive entry names are compared without path
normalization in the central directory, so backslashes, traversal segments,
and case changes fail rather
than being rewritten into an expected path. Inspection also applies bounded
compressed size, entry count, individual and total uncompressed size, output,
and execution time. Squirrel also adds its own files, so this application-payload
result is paired with a separate maker-provenance gate. That gate does not
expand the payload SBOM or decide whether redistribution is legally sufficient.

`electron-winstaller`'s default NuSpec template does not include Electron's
`LICENSES.chromium.html` or extensionless `version` file. The Forge maker
configuration stages both explicitly; the complete-inventory comparison is the
regression guard that proves they remain present in the full package.

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
Before Forge can load `electron-winstaller`, and again immediately before make,
it verifies every installed maker-package regular file except the declared
mutable, non-input `vendor/Squirrel-Releasify.log` and
`vendor/Squirrel-Unset.log` paths against a pinned count, total length, and
aggregate SHA-256. An excluded path may be absent; when present, it must still
be a regular file, so links and special files fail.
The final smoke test re-verifies the unpacked payload and byte-compares every
regular payload file against its Squirrel `.nupkg` entry using relative path,
size, and SHA-256. The two maker-added executable files and four NuGet metadata
files are required through a separate, fail-closed allowlist. The three
compliance files also receive named checks so their evidence boundary stays
visible.

With `--require-maker`, the smoke also verifies the outer Squirrel layer against
`apps/desktop/packaging/squirrel-maker-inputs.json`. That manifest pins the
installed `electron-winstaller@5.4.4` package identity, installed regular-file
tree with two explicit mutable-log exclusions, and six security-relevant
files by byte length and SHA-256.
The verifier requires an exact three-file maker directory, parses `RELEASES` as
one record and checks its SHA-1 and length, and parses the emitted setup PE. The
setup must retain the approved x86 GUI entry point, fixed header bytes, and
byte-identical `.text`, `.rdata`, `.data`, and `.reloc` sections; changed PE
layout fields must equal values derived from the resource size and file/section
alignments. No overlay or unexpected section is accepted. A strict resource
walker rejects nested metadata changes, aliases, overlaps, out-of-range data,
non-zero reserved fields, and bytes outside zero or the exact maker padding
pattern. The setup version resource is pinned, and its single `DATA/131`
resource must be a four-entry safe ZIP whose package, `RELEASES`, `Update.exe`,
and background bytes match their approved siblings. Its local headers,
compressed ranges, central directory, and EOCD are walked directly: names,
flags, methods, lengths, CRC-32, and offsets must agree; extras, comments,
attributes, gaps, and trailing bytes are rejected. The `.nupkg` copy of
`squirrel.exe` must match the approved input. The resource-modified execution
stub must retain the approved fixed PE origin, while all 52 resource keys and
bytes must match the verified packaged application executable. NuGet's nuspec,
content types, and core-properties XML are byte-pinned; relationships XML is
matched to an exact canonical structure with only its two bounded random IDs
and randomized core-properties path allowed. Passing evidence
is written atomically, without timestamps or absolute paths, to
`out/<build-id>/evidence/SQUIRREL-MAKER-PROVENANCE.json`.

These checks establish a constrained semantic transform from the pinned maker
package subtree to the inspected unsigned output container. They do not pin
root-hoisted build-dependency bytes or the excluded log contents, establish
build-host safety or bit-for-bit reproducibility, establish that the MIT
declaration or license text is
sufficient for every bundled component, add the maker layer to the payload
SBOM/notices, or approve publication.
The outputs remain unsigned, draft-only, and prohibited from public release
while the license hold applies.

The `.nupkg` checks currently consume central-directory semantics through .NET
and `yauzl`. They do not yet prove that every raw local header matches its
central record. A strict raw nupkg walker is therefore still required before a
public release; the strict Setup ZIP walker does not remove that separate
parser-differential boundary.

The audit is specifically an **application-payload** audit. During make,
Squirrel adds `lib/net45/squirrel.exe`,
`lib/net45/OwnContextDeveloperPreview_ExecutionStub.exe`, and package metadata
to the `.nupkg`; `Setup.exe` also carries maker-generated bootstrap/update
bytes. The provenance gate now checks the executable origins and outer-container
mapping described above. Those maker-added components are still not inventoried
by the payload SPDX document, third-party notices, or `SHA256SUMS`; a complete
maker-layer license/SBOM/notices review remains a public-release gate.

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
- the Squirrel full package omits or changes a verified payload file, or adds a
  file outside its explicit maker and NuGet metadata allowlist; or
- the pinned `electron-winstaller` installed file tree or a named input changes,
  the maker output inventory is
  not exact, `RELEASES` is malformed or mismatched, a setup ZIP member differs,
  a fixed PE byte changes, a derived PE layout value is inconsistent, resource
  metadata/padding is unexplained, or the execution stub does not copy the
  packaged application's resources exactly; or
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
- that Squirrel's maker-added execution stub, bootstrap/update components, and
  package metadata are covered by complete notices, SBOM, and release checksums
  beyond the draft provenance record;
- that every raw `.nupkg` local header, extra field, compressed range, and gap
  exactly agrees with its central-directory record without parser differential;
- that the locked development toolchain is advisory-clean: the packaged runtime
  currently passes `npm audit --omit=dev`, while the full audit still fails in
  Electron Forge's archive/extraction dependency tree and has no verified
  semver-compatible stable upgrade;
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
