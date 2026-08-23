# Windows-first vault encryption architecture

Last updated: 2026-08-24

Status: **Foundation prototype verified; vault encryption not implemented**

This document records the encryption architecture selected for the Windows-first
OwnContext release. It is an implementation contract and spike plan, not a
security claim. The current developer preview must continue to say that its
vault is plaintext and suitable only for non-sensitive fixtures until every
acceptance test in this document passes on the packaged application.

macOS support, numeric minimum/recommended hardware specifications, the project
license, and the final encrypted-SQLite provider are deliberately not decided
here. Provider licensing must be reviewed together with the still-open project
license decision before a dependency is shipped; no project-license candidates
are shortlisted by this architecture.

## Decision

OwnContext will use this topology on Windows:

```text
Codex / another stdio MCP host
             |
             | JSON-RPC on stdin/stdout
             v
thin packaged MCP bridge (Electron RunAsNode; no vault key and no SQL access)
             |
             | versioned, bounded RPC on an explicitly secured local named pipe
             v
normal Electron main process (single-instance vault and authorization broker)
       |                         |
       |                         +-- renderer through narrow Electron IPC
       |
       +-- Electron safeStorage / Windows DPAPI wraps one random DEK per vault
       |
       +-- selected SQLCipher-like native provider owns encrypted SQLite,
           FTS, WAL, temporary-state, integrity, and transaction behavior
```

The normal Electron main process is the only process allowed to unwrap a vault
data-encryption key (DEK) or open the encrypted database. The MCP executable
keeps the stdio interface required by existing AI hosts, but becomes a bridge;
it must not open a database, receive a DEK, or fall back to the current direct
`node:sqlite` path.

"SQLCipher-like" is an outcome-based provider contract, not a claim that the
SQLCipher product has already been selected. A conforming provider must encrypt
and authenticate database pages and all content-bearing auxiliary storage,
retain required SQLite/FTS5 semantics, accept raw key bytes without application
string interpolation, expose an encryption/integrity status check, and pass the
packaged Windows test matrix below.

## Evidence for the current plaintext boundary

The following facts are directly observable in the repository and current
Windows development runtime:

- `packages/core/src/vault.ts` now depends on a narrow storage-provider
  interface. The only shipped implementation, in `packages/core/src/storage.ts`,
  wraps `node:sqlite` and declares the exact profile
  `plaintext-development` / `none` / `none`. Desktop, MCP, and test callers must
  select it explicitly; no implicit fallback exists. This boundary does not
  supply a key or encrypt storage.
- `packages/core/src/schema.ts` stores normalized revision and chunk bodies in
  `TEXT` columns and copies titles, heading paths, and chunk content into the
  `chunks_fts` FTS5 virtual table.
- The same schema enables `PRAGMA journal_mode = WAL`, so SQLite may place
  recently written page content in `owncontext.sqlite-wal` while the database is
  active. The shared-memory and temporary-file behavior must also be treated as
  part of the at-rest surface.
- `PRAGMA secure_delete = ON` and FTS5's `secure-delete` option support logical
  deletion behavior; neither encrypts a database, index, WAL, backup, or
  temporary file.
- The packaged MCP command currently launches the Electron executable with
  `ELECTRON_RUN_AS_NODE=1` and directly opens the vault passed in its environment.
  On the installed Electron 43.4.1 Windows runtime, a RunAsNode probe returned
  an Electron module value of type `string` and `safeStorage` as `undefined`.
  Electron also documents `safeStorage` as a **main-process** API. Therefore the
  present packaged MCP process is not an acceptable key broker.

These observations prove only the current boundary: plaintext is possible and
application-level encryption is absent. They do not show that content can be
securely erased from SSD media, nor that adding a cipher to the main `.sqlite`
file would automatically protect every auxiliary artifact.

## Implemented foundation evidence

The first implementation slice deliberately remains separate from the real
vault:

- `packages/core/src/storage.ts` defines the connection/provider contract and
  rejects missing or internally inconsistent security metadata before it
  creates a database directory. Vault handles expose an immutable descriptor
  snapshot. A provider that merely calls itself `encrypted-candidate` is not
  release evidence; the future provider must still pass the cipher-status and
  at-rest matrix in this document.
- `openEncryptedVaultCandidate` is a separate, key-required path. It accepts
  only a genuine 32-byte `Buffer`, captures provider/session operations once to
  prevent getter substitution, calls keyed open before schema work, requires an
  exact positive cipher/integrity attestation, and supports only
  `open-existing` or `create-exclusive`. A keyless caller is rejected, every
  post-open failure closes the candidate session, errors are content-free, and
  there is no plaintext fallback. These tests verify the adapter contract; no
  shipped provider yet demonstrates page encryption or key-before-page access.
- The plaintext provider inspects the 100-byte database header and, only when
  both header mode bytes declare WAL, checksum-valid WAL frames through
  read-only file descriptors before it opens SQLite. It caps WAL inspection at
  256 MiB and fails closed on a mismatched WAL sidecar or rollback journal. A
  stopped crash-style fixture whose main header is version 2 and
  committed WAL is version 99 is rejected with identical original inventory and
  exact main/WAL bytes; no SHM or plaintext snapshot is created. The probe/open
  calls are not atomic against a concurrent external writer. That generation
  race is a public-provider design gate, not a release property.
- `apps/desktop/src/electron/vault-key-envelope.ts` implements a strict,
  bounded v1 envelope for a random 32-byte synthetic DEK. It uses the async
  Electron `safeStorage` contract, exclusive same-directory publication,
  callback-scoped key access, best-effort Buffer zeroization, content-free
  errors, and reports `shouldReEncrypt` without silently rewriting the file.
- The dedicated `--owncontext-key-storage-smoke` path runs only in the packaged
  Electron main process with a new OS-temporary profile. On Windows x64,
  `npm run package:win --workspace @owncontext/desktop` completed the wrap,
  persist, reopen, unwrap, and equality checks. Before reporting success it
  decodes the stored wrapper payload and rejects any occurrence of the raw key
  or the tested UTF-8, UTF-16LE/BE, and UTF-32LE/BE string encodings; byte and
  UTF-16 no-op `safeStorage` counterexamples are regression tests. It writes no
  key, encoded key, envelope path, or ciphertext to its success result. This
  does not exclude arbitrary reversible transforms or independently attest
  DPAPI; direct DPAPI comparison and a different-Windows-account rejection test
  remain in the acceptance matrix.
- A full maker run records the content-free result as
  `evidence/WINDOWS-KEY-STORAGE-SMOKE.json`, and the outer draft bundle validates
  and hashes one bounded read of that file, so schema validation and the
  recorded digest cannot observe different file generations. The evidence
  explicitly says it does not cover the real SQLite vault or public release.

This slice demonstrates that the selected OS-key API and envelope state machine
can execute in the packaged Windows main process. It does not encrypt SQLite,
FTS, WAL, temporary files, client-configuration backups, or migration state;
the desktop UI therefore continues to report encryption as not implemented.

Primary references:

- SQLite database-header, WAL-frame, commit-marker, and checksum format:
  <https://www.sqlite.org/fileformat.html>
- Electron `safeStorage` and Windows DPAPI semantics:
  <https://www.electronjs.org/docs/latest/api/safe-storage>
- Windows DPAPI `CryptProtectData` contract:
  <https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata>
- Windows named-pipe security and default-descriptor warning:
  <https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights>
- SQLCipher keying, export, rekey, status, and integrity APIs (candidate
  capability reference, not a dependency choice):
  <https://www.zetetic.net/sqlcipher/sqlcipher-api/>

## Security properties and limits

### In scope

When the app is stopped or the vault is locked, a person who copies the
OwnContext data directory without the Windows user's credentials must not be
able to recover protected fixture canaries from:

- canonical content, revisions, chunks, titles, paths, URLs, collections, and
  other sensitive metadata;
- FTS tables and future derived indexes;
- the main database, WAL, shared-memory state, temporary files, eligible
  backups, migration staging, and crash-recovery artifacts; or
- the wrapped-key envelope, configuration, logs, diagnostics, MCP framing, or
  process arguments.

Wrong, missing, corrupted, or temporarily unavailable key material must fail
closed. The application must never create a replacement empty vault over an
unreadable encrypted vault and must never reopen it through plaintext SQLite.

### Explicit limits

Windows `safeStorage` uses DPAPI and protects against other users on the same
machine, not malicious software already running as the same logged-in user.
OwnContext also cannot protect plaintext while an authorized, unlocked broker
is serving it, or after an AI client sends an excerpt to an external provider.
Administrators, malware controlling the session, screenshots, intentional
exports, and downstream provider retention remain outside the at-rest claim.

Deleting plaintext previously written by the developer alpha is not provable
secure erasure on SSDs. The migration flow must describe this residue honestly
and recommend whole-device encryption; it may issue a logical deletion receipt
but not a physical-erasure claim.

## Key hierarchy and lifecycle

Each vault gets an independent 256-bit random DEK generated with the operating
system cryptographic random source. There is no repository key, default key,
machine-wide shared key, user password derived by the application, or recovery
key in the first Windows design.

The broker stores a small versioned envelope beside, but not inside, the vault:

```text
envelope version
vault identifier
key identifier
key-provider identifier (Windows user-scoped safeStorage / DPAPI)
wrapped DEK bytes
creation and rotation metadata without user content
```

The envelope and rendezvous files require an explicit current-user ACL and
atomic replace/write-through behavior. ACLs are defense in depth; confidentiality
of the DEK comes from DPAPI wrapping. The raw DEK must never enter SQLite,
renderer IPC, the named-pipe protocol, Codex configuration, command arguments,
environment variables, logs, crash reports, telemetry, exports, or diagnostics.

The target sequence is:

1. Wait for the normal Electron application to be ready and verify that
   `safeStorage` encryption is available. Unavailability is a locked/error state,
   never permission to use plaintext.
2. For a new vault, generate the DEK, wrap it with the asynchronous safeStorage
   API when supported by the pinned Electron version, atomically persist the
   envelope, and only then create/key the database.
3. For an existing encrypted vault, unwrap the DEK in the broker and pass its raw
   bytes directly to the selected native database provider before the first
   schema read or write. A provider-specific cipher-status query must succeed.
4. Keep plaintext key buffers and query results in the broker for the shortest
   practical lifetime. Lock closes all database handles, invalidates MCP
   sessions, clears application caches, and performs best-effort zeroization of
   owned key buffers. JavaScript garbage-collector behavior prevents an absolute
   memory-erasure claim.
5. Rotation uses a journaled, versioned protocol with old/new key identifiers
   and explicit recovery states. The old envelope is not removed until the
   rekeyed database has passed an integrity check and a close/reopen test. Every
   forced-termination point must recover to exactly one usable key generation.

Electron `safeStorage` accepts a JavaScript string rather than raw bytes. The
Windows spike must therefore compare its transient encoded-key copies with a
minimal direct DPAPI byte wrapper. If `safeStorage` is retained, the design must
record that those garbage-collected string copies cannot be deterministically
zeroized; no stronger in-memory erasure claim is permitted.

Loss of the Windows profile credentials or wrapped-key envelope makes the vault
unrecoverable in this first design. Portable encrypted recovery/export is a
separate reviewed design and must not reuse or expose the local DEK.

## Encrypted database-provider contract

The core vault now depends on a narrow storage interface; direct `DatabaseSync`
construction is confined to the explicit plaintext development provider. The
keyed candidate entry point enforces call ordering and positive attestation at
the adapter boundary. The selected native provider must still demonstrate all
of the following before adoption:

- Windows x64 support for the pinned Electron ABI and a reproducible source-build
  fallback; native binaries are unpacked from ASAR and included in SBOM,
  checksums, notices, vulnerability review, and signing evidence;
- FTS5 with the current `unicode61 remove_diacritics 2` behavior, strict tables,
  foreign keys, transactions, WAL recovery, busy timeouts, and current migration
  and purge semantics;
- a binary key API equivalent to SQLCipher's `sqlite3_key_v2`, called before the
  first page access, plus positive cipher-status and integrity checks;
- authenticated page encryption with documented, pinned settings and no
  plaintext database header selected merely for tool compatibility;
- encrypted or memory-only handling for WAL, rollback journals, temporary files,
  sorting spill, FTS indexes, online backup, and migration staging; and
- no content/key logging and no silent compatibility downgrade when a key,
  cipher setting, native binary, or integrity check is wrong.

The adapter must preserve existing deterministic identities and domain behavior
without exposing raw SQL, database paths, or key operations to the renderer or
MCP bridge.

## Broker and authenticated named-pipe boundary

The Electron main process becomes a long-lived, single-instance broker while a
UI window or authorized MCP connection is active. A missing broker may be
started by the bridge in normal Electron mode with
`ELECTRON_RUN_AS_NODE` explicitly removed; the bridge waits for a bounded ready
signal and never opens the vault itself.

On Windows, the broker creates a local named pipe using a native Win32 boundary,
not Node's default security descriptor. The pipe must:

- use an explicit DACL limited to the current logon SID (and only unavoidable
  operating-system principals), reject anonymous/network access, and bind to the
  current interactive session;
- verify the client access token/logon SID obtained from the pipe, rather than a
  PID or username asserted in a request; verify the actual client process and,
  once releases are signed, the expected installed bridge identity;
- use a versioned handshake with fresh nonces and a new random session identifier
  for every connection; nonces provide freshness, while the Windows access token
  and signed-process check provide identity;
- bind one visible OwnContext connection grant and its collection scope to that
  pipe session. Reconnection creates a new authorization/session boundary and
  invalidates search-issued document IDs from the old session; and
- impose frame length, method, concurrency, timeout, response-size, and idle
  limits before parsing or executing a request.

The Windows default named-pipe descriptor is unacceptable because Microsoft
documents that it also grants read access to Everyone and anonymous accounts.
A high-entropy pipe name is useful collision defense but is not authentication.
Likewise, a client-supplied PID, a file-path check alone, or an unprotected token
in `config.toml` is not authentication.

The bridge exposes only the MCP protocol on stdout, keeps diagnostics
content-free on stderr, and relays a closed allowlist equivalent to
`initialize`, `tools/list`, and bounded `search`/`fetch`. The broker performs the
final collection authorization, search-issued-ID check, and disclosure audit.
There is no pipe method for an arbitrary path, URL, SQL statement, key operation,
import, export, delete, connector action, or shell command.

If the broker is locked, unavailable, incompatible, or fails authentication, the
bridge returns a bounded MCP error and exits/fails closed. It does not ask for a
DEK, create a second database connection, or start a plaintext compatibility
server.

## Shortcuts rejected

| Shortcut | Reason rejected |
| --- | --- |
| Keep the RunAsNode MCP server as a direct database reader | The process has no Electron `safeStorage`; giving it a key would duplicate the key boundary and expand compromise impact. |
| Put a DEK or bearer secret in arguments, environment, `config.toml`, stdout, or stderr | These surfaces are inspectable, inherited, copied, or logged; they violate the existing secret-handling contract. |
| Encrypt document-body columns but leave SQLite/FTS metadata plaintext | Titles, paths, URLs, collections, access patterns, FTS tokens, and deleted content remain recoverable. |
| Call `safeStorage` for every row instead of encrypting SQLite pages | Search/indexing still requires plaintext derived state and creates incomplete, hard-to-audit coverage. |
| Rely only on BitLocker or filesystem permissions | Useful defense in depth, but it is not the required application-level vault encryption and does not make a copied unlocked-profile vault self-protecting. |
| Use a user password as the only local key | It creates password-strength and recovery UX risks for non-developers. Password-protected portable export is a separate decision. |
| Interpolate a key into `PRAGMA key` text | It creates avoidable string copies and diagnostic exposure. A raw-byte native key API is required. |
| Use localhost TCP or a default/unverified named pipe | It adds an unauthenticated local service boundary; default Windows pipe ACLs are broader than the chosen boundary. |
| Preserve a plaintext FTS or vector sidecar for performance | The derived index is sensitive and must meet the same at-rest test as canonical content. |
| Rekey the current plaintext alpha file in place | Power loss, failed conversion, backups, WAL, and filesystem recovery can retain ambiguous plaintext residue. |
| Fall back to plaintext when DPAPI/provider/native-module loading fails | A silent downgrade would turn a recoverability issue into an undisclosed confidentiality failure. |

## Fresh-vault-first migration boundary

The first encryption milestone supports **new encrypted vaults only**. It does
not perform an in-place conversion of `owncontext.sqlite` and must not treat a
successful schema open as evidence that encryption is active.

1. Development spikes use a new isolated application-data directory and
   synthetic canary fixtures. They never point at the existing alpha vault.
2. The encrypted build recognizes the SQLite plaintext header and known legacy
   filenames before opening. Detection places the legacy vault in a blocked,
   read-only migration state; the encrypted provider must not overwrite, rekey,
   rename, or silently copy it.
3. Because the alpha is explicitly restricted to disposable fixtures, the first
   supported transition is to create a new encrypted vault and re-import from
   the original authorized sources. The new vault is closed, reopened, checked
   for cipher/integrity status, and compared by source/document counts and
   content hashes before it can become active.
4. Only after that comparison may the user explicitly request removal of the
   legacy database, `-wal`, `-shm`, and known backups. Removal is best effort and
   produces a content-free logical receipt; the UI must continue to warn that
   physical recovery from SSD/storage history cannot be disproved.
5. If original sources are unavailable or real personal data was put into the
   developer alpha, automatic conversion remains unsupported. A later migration
   tool needs its own crash-consistent copy/export design, disk-residue tests,
   rollback policy, and explicit consent before being offered.

No plaintext backup is created as part of this flow. The words "encrypted" or
"protected at rest" may be shown only for the newly created vault after the
packaged acceptance suite passes; they do not retroactively describe legacy
files.

## Windows native-provider spike matrix

Every candidate is a spike, not an approved dependency. Scores and package
availability must be recorded against exact versions and release hashes when the
spike runs; this table deliberately avoids turning today's package metadata into
a permanent support claim.

| Candidate | Why spike it | Required evidence | Known rejection/decision boundary |
| --- | --- | --- | --- |
| SQLCipher Community source + minimal OwnContext N-API adapter | Strongest control over a raw-byte key API, pinned cipher settings, FTS5 compile flags, and Windows artifacts | Reproducible Windows x64/Electron build; `sqlite3_key_v2`; cipher status/integrity; FTS/WAL parity; complete transitive license/SBOM review | Highest native maintenance and patch burden; adoption waits for license and update-operations review |
| Official SQLCipher Windows distribution behind the same adapter | Vendor-maintained cipher implementation and documented APIs may reduce crypto build risk | Exact redistribution terms/cost; offline reproducible packaging or vendor provenance; Electron-compatible adapter; all acceptance tests | A paid or redistribution-restricted artifact may conflict with a universally free open-source distribution; maintainer decision required |
| `better-sqlite3-multiple-ciphers` | Fast Windows proof of the storage interface and native packaging path | Exact Electron 43 x64 load/rebuild; selected cipher provenance/settings; binary key handling; FTS/WAL/temp tests; fork and bundled-library license/SBOM audit | Third-party fork and multiple cipher modes increase configuration/downgrade risk; no adoption solely because a prebuild exists |
| `@journeyapps/sqlcipher` | Useful API/reference comparison with an Electron rebuild path | Upstream-supported Windows x64 build and packaged tests | Upstream currently states Windows is unsupported; reject for the Windows-first release unless that boundary changes and is verified |
| Current `node:sqlite` | Baseline for behavior and performance comparisons | Existing functional suite and representative import/search benchmark | No application-level page-encryption provider in the current code path; cannot be the release storage backend |

The first spike should implement the storage adapter twice: the current
`node:sqlite` baseline and one raw-key encrypted candidate. This distinguishes
domain/API regressions from encryption/provider failures. Provider selection is
made only after security, operability, licensing, and packaged-artifact evidence
are compared; benchmark speed alone is insufficient. Numeric hardware claims
remain deferred even though comparative timings and peak-memory data are
recorded.

The native named-pipe boundary is a parallel Windows spike:

| Primitive | Use | Acceptance boundary |
| --- | --- | --- |
| Electron `safeStorage` in normal main | Wrap/unwrap the per-vault DEK with user-scoped DPAPI | Available only after app readiness; wrong Windows user and unavailable provider fail closed; raw DEK never crosses IPC |
| Minimal reviewed Win32/N-API pipe helper | Create the explicit security descriptor and inspect the actual client token/process | Current logon SID/session allowed; anonymous, network, different-user, stale-process, and unsigned/wrong bridge cases denied |
| Node `net` streams | Framing after the secure pipe handle exists | May carry bounded messages; must not be treated as the ACL/authentication implementation by itself |

## Acceptance and failure tests

All security canary tests require zero unauthorized disclosure. Results must be
captured from a packaged Windows x64 release candidate, not only unit tests.

### 1. Provider compatibility

- Import Korean/English UTF-8 Markdown and text fixtures, repeat an unchanged
  import, update a revision, cancel and force-kill imports, search FTS, fetch a
  search-issued ID, purge a source, and verify current counts/hashes against the
  `node:sqlite` baseline.
- Exercise strict tables, foreign keys, Unicode tokenizer behavior, transactions,
  WAL checkpoint/recovery, disk-full handling, busy contention, backup, close,
  reopen, and schema migration.
- Fail the provider if any required SQLite/FTS behavior changes without an
  explicit versioned product decision.

### 2. At-rest confidentiality and integrity

- Place unique canaries in body, title, heading, relative/absolute path, source
  URI, collection, author-like metadata, FTS tokens, deleted revisions, and audit
  activity. Lock and stop the app, then scan the database, WAL, SHM, temporary
  directories, backups, envelope, logs, crash data, and installer-created data
  in UTF-8 and UTF-16 forms. Finding any protected canary fails release.
- Verify a positive provider cipher-status check after every open and a clean
  provider integrity check after import, recovery, and rekey. Corrupt pages,
  native-module substitution, wrong cipher settings, and wrong keys must fail
  closed without creating or truncating files.
- Copy the database without its envelope and copy database plus envelope to a
  different Windows account. Both must remain unreadable. Record explicitly that
  a malicious process under the same unlocked account is outside the DPAPI
  boundary.
- Force termination at every database-create and key-rotation journal step. On
  restart, exactly one authenticated key generation must open; no plaintext or
  ambiguous half-migrated fallback may exist.
- Force SQLite temporary spill, large FTS updates, WAL growth, checkpoint, online
  backup, and interrupted purge. Repeat disk scanning before and after cleanup.

### 3. Key and lock behavior

- Simulate unavailable `safeStorage`, corrupted/truncated envelope, denied ACL,
  changed Windows account, missing key identifier, and unwrap/rekey exceptions.
  Each case leaves the vault locked and unchanged with a content-free error.
- Search, fetch, import, source listing, renderer IPC, and named-pipe requests all
  fail while locked. Existing MCP sessions and issued IDs become invalid at lock
  and remain invalid after unlock.
- Instrument arguments, environment, config, stdout/stderr, renderer messages,
  pipe frames, logs, crash reports, diagnostics, exports, and heap snapshots used
  in the controlled test. Raw or encoded DEK canaries must not appear outside the
  broker/provider memory boundary.

### 4. Named-pipe and bridge behavior

- Connect as the intended current-user bridge and complete MCP initialize,
  tool-list, search, and fetch. Verify that only granted collections are
  candidates and disclosure audit records contain no excerpt body.
- Attempt anonymous, remote, different-user/session, direct arbitrary-process,
  stale PID, wrong installed path/signature, wrong protocol version, replayed
  nonce/session, malformed/oversized frame, excessive concurrency, and idle
  connections. Access must be denied before vault content or existence is
  revealed.
- Guess document IDs and reuse issued IDs after reconnect, lock, grant removal,
  broker restart, or another AI connection. Every request must fail without an
  existence oracle.
- Stop the broker. The bridge may start only normal Electron with RunAsNode
  removed, wait a bounded interval, and reconnect. Startup failure returns a
  bounded MCP error; it never opens SQLite or receives a key.
- Inspect stdout byte-for-byte as JSON-RPC only and stderr/logs for content/key
  canaries. Kill either side during a response and verify bounded cleanup and a
  new authorization session on reconnect.

### 5. Fresh-vault transition and packaged artifact

- Present a synthetic legacy plaintext DB with live WAL/SHM files. The encrypted
  build detects it without mutating it and refuses to label it encrypted.
- Re-import into a separate encrypted vault, compare counts and content hashes,
  close/reopen/integrity-check it, then inject failures before every activation
  step. The legacy vault remains the unchanged fallback until explicit removal.
- Verify best-effort removal covers the main legacy DB, WAL, SHM, and known
  backups and emits no secure-erasure claim. Scan remaining application files and
  report residue rather than hiding it.
- Audit the native provider and pipe helper in the unpacked app and installer
  payload: exact source/version/hash, license/notices, SBOM, ASAR-unpack path,
  Authenticode signature, load path, and tamper rejection. A development build
  passing functional tests is not enough.

## Delivery sequence and claim gate

1. Introduce storage and key-provider interfaces with the existing plaintext
   backend retained only for tests/developer fixtures and visibly labeled.
   **Prototype verified.** The fail-closed keyed candidate contract and packaged
   synthetic safeStorage envelope are also verified, but neither supplies a
   real encrypted database provider or connects OS key unwrapping to the vault.
2. Run the Windows encrypted-provider and named-pipe spikes; record exact version,
   build, license, performance, and adversarial evidence.
3. Implement the broker/bridge split and make direct MCP database opening an
   impossible packaged-code path.
4. Implement new encrypted vault creation, lock/unlock, rotation recovery, and
   fresh-vault re-import without an in-place plaintext migration.
5. Run the complete packaged matrix plus the wider security/release gates in
   `SECURITY_MODEL.md` and `RELEASE_COMPLIANCE.md`.

Until step 5 passes, the only accurate product status is **key-management
foundation verified; vault encryption not implemented**. This work does not
unblock public sensitive-data claims, public binary distribution, or a signed
update channel by itself.

## Decision boundary

The topology, ownership boundary, key hierarchy, migration posture, storage
interface, and isolated safeStorage envelope behavior are selected. The exact
native encrypted-SQLite provider and Win32 pipe helper are `[verification
limitation]` items because no candidate has yet passed the packaged Windows
spike, dependency-license review, cipher/integrity tests, and native
supply-chain audit. This does not block continued local development with
synthetic non-sensitive fixtures. It blocks implementation claims and any
public statement that OwnContext protects personal vault data at rest.
