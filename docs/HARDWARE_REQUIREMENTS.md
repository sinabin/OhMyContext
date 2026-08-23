# Platform scope and measurement plan

Last updated: 2026-08-23

## Decision

Numeric minimum and recommended hardware specifications are deferred. The
project must not publish CPU, memory, storage, document-count, or latency
numbers until they have been measured against a packaged build.

The current desktop development and first distribution target is **Windows
x64**. macOS support is outside the current release scope. Windows on ARM,
Linux, and macOS may be evaluated later, but no compatibility promise is made.

## Current baseline

The developer alpha uses a local SQLite vault and FTS5 retrieval, runs one
foreground import at a time, and does not bundle a local generative model. A
GPU is not part of the current architecture. These are implementation facts,
not a hardware support claim.

Until measurements exist, public-facing copy may state only:

- the packaged build's exact Windows architecture and tested OS version;
- that minimum and recommended hardware figures are not yet established; and
- that larger collections need more free storage and may take longer to index.

It must not describe an unmeasured device or collection size as supported.

## Windows package validation

Before a Windows public beta is offered, record the following evidence for the
candidate installer:

1. package version, commit, installer hash, signature result, Electron version,
   Windows edition/build, and x64 architecture;
2. install, launch, uninstall, and clean-profile relaunch results without a
   separately installed Node.js runtime or terminal;
3. deterministic import, unchanged re-import, local search, MCP search/fetch,
   cancellation, and forced-termination recovery results;
4. peak memory, elapsed time, and steady/peak disk use for each measured corpus;
5. whether antivirus or SmartScreen produced a warning and whether the binary
   signature verified; and
6. the exact fixture and machine configuration used for every reported number.

Failure to install, launch, preserve the last committed vault, remove purged
content from search, or keep MCP access within its read-only boundary blocks
the release. A performance miss narrows or postpones any performance claim; it
must not be hidden by presenting a planned value as measured.

## Later specification work

When enough representative measurements exist, this document may be expanded
with minimum and recommended tiers. Each tier must name the actual tested
hardware, workload, package hash, measurement method, and failure threshold.
Adding macOS requires a separate packaging, signing, secret-storage, update,
filesystem, Unicode-path, and MCP compatibility matrix; Windows results do not
transfer automatically.

## Decision boundary

`[Verification limitation]` No numeric hardware tier has been measured and the
maintainer has explicitly deferred both those figures and macOS support. This
does not block Windows x64 development or creation of an internal unsigned
installer. It does block numeric performance claims and macOS compatibility
claims. A public Windows beta additionally remains subject to the licensing,
encryption, code-signing, deletion/export, and release-compliance gates defined
elsewhere in the repository.
