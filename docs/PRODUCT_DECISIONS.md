# Product decisions

Last updated: 2026-08-25

## Confirmed

| Decision | Result | Consequence |
| --- | --- | --- |
| Initial market | Global | English-first product copy with Unicode-safe ingestion; Korean remains a required retrieval benchmark. |
| Desktop installation | Confirmed | The supported Windows onboarding path is a free Portable ZIP. Users extract it and run the executable; no installer, Authenticode signature, Node.js, or terminal is required. |
| Collection policy | All lawful routes | Prefer official export and read-only APIs, then user-initiated capture. Each connector must document authority and platform constraints. |
| First desktop platform | Windows x64 | Continue Windows development and packaging. macOS support is deferred without a compatibility promise. |
| Hardware specifications | Deferred | Publish no numeric minimum or recommended figures until a packaged build is measured; disclose only the tested Windows build and architecture. |
| First public beta price | Free download | Do not add a payment or license-key gate to the Windows beta. This does not replace the separate open-source license decision. |
| License | Deferred | Do not publish releases or accept external contributions until a license is selected. |

## Portable distribution policy

OhMyContext will continue to distribute the Windows x64 consumer build as a
Portable ZIP. Authenticode signing, installer packaging, and an automatic update
channel are intentionally out of scope for this product path. Every release
must clearly disclose that the executable is unsigned, provide a SHA-256
sidecar, identify the exact GitHub tag and source commit, and warn users to
use non-sensitive data while the local vault remains plaintext.

## Product boundary

OhMyContext is a personal context layer, not a new general-purpose chat application. It owns ingestion, provenance, local retrieval, access policy, export, and MCP delivery. The user's existing AI client performs generation.

## MVP assumptions

- Single user and single device.
- Local `stdio` MCP only.
- Text and Markdown folder ingestion first.
- Keyword retrieval is the measurable baseline; dense retrieval is added only after benchmark evidence.
- All MCP tools are read-only.
- The initial vault format uses local SQLite. Application-level encryption is a release gate, not claimed by the first developer prototype.
