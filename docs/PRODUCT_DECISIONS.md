# Product decisions

Last updated: 2026-08-23

## Confirmed

| Decision | Result | Consequence |
| --- | --- | --- |
| Initial market | Global | English-first product copy with Unicode-safe ingestion; Korean remains a required retrieval benchmark. |
| Desktop installation | Accepted | A signed desktop application is the primary onboarding path. No terminal is required for end users. |
| Collection policy | All lawful routes | Prefer official export and read-only APIs, then user-initiated capture. Each connector must document authority and platform constraints. |
| License | Deferred | Do not publish releases or accept external contributions until a license is selected. |

## Product boundary

OwnContext is a personal context layer, not a new general-purpose chat application. It owns ingestion, provenance, local retrieval, access policy, export, and MCP delivery. The user's existing AI client performs generation.

## MVP assumptions

- Single user and single device.
- Local `stdio` MCP only.
- Text and Markdown folder ingestion first.
- Keyword retrieval is the measurable baseline; dense retrieval is added only after benchmark evidence.
- All MCP tools are read-only.
- The initial vault format uses local SQLite. Application-level encryption is a release gate, not claimed by the first developer prototype.
