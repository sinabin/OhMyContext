# Security policy

OwnContext is pre-release software and has not completed a security audit. Do not use the current developer prototype for sensitive production data.

## Reporting

A private vulnerability-reporting address will be established before the public beta. Until then, do not open a public issue containing credentials, personal data, exploit payloads, or an unpatched vulnerability.

## Current security boundary

- The MVP MCP interface is read-only.
- Imported data is untrusted and must never be interpreted as authorization.
- Local retrieval results may leave the device when requested by a cloud AI client.
- The developer prototype does not yet claim application-level encryption.
- A compromised operating system or privileged local malware is outside the protection boundary while the vault is unlocked.

The detailed threat model and release gates are documented in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).
