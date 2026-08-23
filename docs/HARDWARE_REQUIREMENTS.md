# Hardware requirements and validation plan

Last updated: 2026-08-23

## Status

The numbers in this document are **initial support targets, not measured product claims**. OwnContext does not yet have a runnable release or a representative benchmark. A hardware tier becomes a published requirement only after the release candidate passes the validation matrix in this document on the named reference devices.

If a target is missed, the project must optimize the product, reduce the supported data scale, or raise the requirement. It must not silently publish the target as if it were verified.

## Scope and assumptions

These targets cover the local, single-user desktop product described in `IMPLEMENTATION_PLAN.md`:

- local SQLite vault and FTS5 keyword retrieval;
- one foreground import or indexing job at a time;
- local `stdio` MCP delivery;
- no local generative model;
- no remote sync; and
- no dense retrieval in the baseline.

A GPU is not required for the baseline. Optional local dense retrieval may change memory, storage, CPU-instruction, and GPU guidance, but it cannot change the baseline requirements until Milestone 6 benchmark evidence exists.

## Data-scale definitions

Limits are evaluated using normalized, searchable text after extraction. A vault belongs to the first tier for which **all** limits are satisfied; reaching any one ceiling moves it to the next tier.

| Workload tier | Documents | Searchable chunks | Normalized text | Intended machine tier |
| --- | ---: | ---: | ---: | --- |
| Starter | up to 10,000 | up to 100,000 | up to 1 GiB | Minimum |
| Standard | up to 50,000 | up to 500,000 | up to 5 GiB | Recommended |
| Large | up to 250,000 | up to 2,000,000 | up to 20 GiB | Large-vault |

Binary attachments, copied media, and original export archives do not count as normalized text, but they do consume storage. A single unusually large document, deeply nested archive, or parser-heavy format can exceed a tier's resource envelope even when the aggregate size is lower. Connector-specific limits must therefore remain enforceable.

Vaults beyond the Large tier are unsupported until a separate scale test is passed. This is a support boundary, not a deliberate product limit.

## Initial machine targets

| Tier | CPU | Memory | Storage | OS target | Validated workload |
| --- | --- | ---: | --- | --- | --- |
| Minimum | 64-bit CPU with at least 4 cores; Intel Core i5-8250U / AMD Ryzen 3 4300U class or Apple M1 | 8 GiB RAM | SSD with at least 15 GiB free, subject to the storage formula below | Windows 11 24H2 or later on x64; macOS 14 or later on Apple silicon or Intel x64 | Starter |
| Recommended | At least 6 modern cores or 8 hardware threads; Intel Core i5 11th generation / AMD Ryzen 5 Zen 3 class or Apple M1 or later | 16 GiB RAM | NVMe SSD with at least 50 GiB free, subject to the storage formula below | Latest vendor-supported Windows 11 or one of the latest three vendor-supported macOS major releases | Standard |
| Large-vault | At least 8 modern cores; Intel Core i7 12th generation / AMD Ryzen 7 Zen 3 class or Apple M1 Pro or later | 32 GiB RAM | NVMe SSD with at least 200 GiB free, subject to the storage formula below | Same as Recommended | Large |

Additional boundaries:

- Windows on ARM is not in the initial support matrix. It may be added after native dependencies and installers pass the same tests.
- Ubuntu 24.04 LTS x86-64 is a planned community/developer target, not an initial signed B2C support promise. Packaging, desktop integration, and secret-store behavior must be validated before promotion.
- Windows 10 is outside the initial target because the consumer product requires a vendor-supported OS at release time.
- HDD-only systems are unsupported for interactive indexing and retrieval.
- The exact supported OS patch levels will be frozen for each signed release. If the selected Electron runtime raises an OS floor, this table must be updated before packaging, not after users encounter an installation failure.

## Storage planning

The fixed free-space values above are easy onboarding checks. The following planning formula overrides them for a large source collection:

```text
Lexical baseline free space = 3 GiB + A + (3 × N) + B
Optional dense mode estimate = 10 GiB + A + (6 × N) + B
```

Where:

- `N` is normalized searchable text size;
- `A` is the size of original assets that the user elects to copy into the vault; and
- `B` is the largest permitted concurrent import's extracted working set.

The multipliers are conservative planning allowances for SQLite pages, FTS indexes, revisions, write-ahead logs, migration copies, and temporary files. They are not measured amplification factors. Validation must measure peak and steady-state use, after which the formula may be tightened. The application must run a preflight capacity check and must not begin an import that would consume the OS safety reserve.

## Named reference devices

These are provisional procurement and validation configurations. A materially equivalent substitution is allowed only if its CPU, RAM, storage medium, architecture, and thermal class are recorded alongside the result.

| ID | Reference device | Role |
| --- | --- | --- |
| `MIN-WIN-01` | Dell Latitude 5490, Core i5-8250U, 8 GiB RAM, 256 GB SSD, Windows 11 | Minimum Windows / Starter |
| `MIN-MAC-01` | MacBook Air (M1, 2020), 8 GiB unified memory, 256 GB SSD | Minimum macOS / Starter |
| `REC-WIN-01` | Dell Latitude 5430, Core i5-1245U, 16 GiB RAM, 512 GB NVMe SSD, Windows 11 | Recommended Windows / Standard |
| `REC-MAC-01` | MacBook Air (M2, 2022), 16 GiB unified memory, 512 GB SSD | Recommended macOS / Standard |
| `LARGE-WIN-01` | Lenovo ThinkPad T14 Gen 4 AMD, Ryzen 7 PRO 7840U, 32 GiB RAM, 1 TB NVMe SSD, Windows 11 | Large-vault Windows / Large |
| `LARGE-MAC-01` | MacBook Pro 14-inch (M2 Pro, 2023), 32 GiB unified memory, 1 TB SSD | Large-vault macOS / Large |

Device names do not constitute test evidence. Before publication, the test report must include the actual model, firmware, OS build, storage model and free space, power mode, OwnContext commit and package hash, and corpus hash.

## Validation corpus

Create deterministic Starter, Standard, and Large fixtures with the exact limits above. Each fixture must include:

- English, Korean, at least one additional CJK language, a right-to-left script, Latin diacritics, and emoji;
- Unicode, long, reserved-character, and normalization-equivalent file names;
- small and large documents, duplicate content, revisions, deletions, and nested directories;
- realistic title, timestamp, collection, and authorship metadata; and
- an agreed query set containing exact terms, phrases, date filters, collection filters, no-result queries, and known relevant-document judgments.

Synthetic data is sufficient for scale and failure testing. Retrieval-quality judgments require consented or redistributable realistic text and must be versioned separately.

## Benchmark method

For each release candidate and reference device:

1. Start from a clean application profile with the default OS security software enabled.
2. Verify the fixture and application hashes.
3. Perform a cold full import three times, recreating the vault between runs.
4. Perform an unchanged re-import, a 1% revision import, and a 1% deletion/purge run.
5. Run the fixed query set once for warm-up and then at least five measured passes.
6. Record elapsed import time, query p50/p95/p99, process peak resident memory, total CPU time, steady-state and peak disk use, temporary-file residue, crashes, retries, and integrity-check results.
7. Repeat while an MCP client performs bounded `search` and `fetch` calls.

Results and the benchmark harness must be committed or attached to the release evidence so another contributor can reproduce them.

## Initial performance gates

These are hypotheses to test, not achieved results.

| Machine and workload | Full cold import | Warm search p95 | OwnContext peak resident memory | Integrity |
| --- | ---: | ---: | ---: | --- |
| Minimum + Starter | no more than 30 minutes | no more than 2 seconds | no more than 3.5 GiB | zero failed deterministic integrity assertions; retrieval quality reported separately |
| Recommended + Standard | no more than 90 minutes | no more than 1 second | no more than 8 GiB | same |
| Large-vault + Large | no more than 6 hours | no more than 2 seconds | no more than 16 GiB | same |

In all tiers, the application must provide progress and cancellation, must not corrupt the last committed vault after forced termination, and must leave at least 2 GiB or 5% of the system volume free, whichever is greater.

## Failure conditions and resulting action

The claimed tier fails validation if any required Windows or macOS reference device:

- cannot install, launch, import, search, fetch, cancel, or recover after forced termination;
- crashes, exhausts memory, enters sustained swap thrashing, corrupts the vault, or returns a purged or unauthorized canary;
- misses a performance or memory gate in two of three clean runs;
- exceeds the documented disk estimate or leaves unbounded temporary data;
- requires a GPU, terminal, separately installed runtime, or API key for the lexical baseline; or
- fails with supported Unicode content or paths.

A failed minimum device blocks publication of that minimum. A Standard or Large failure may instead reduce that workload's published scale, provided the lower boundary is rerun and documented. Security or integrity failures block the release rather than merely changing the hardware label.

## Decision boundary

`[Verification limitation]` No hardware target has been measured because the executable, benchmark harness, and release corpus do not yet exist. This affects every numeric support claim. Milestones 1 through 3 may proceed using these targets, but a public release is blocked until Milestone 6 reproduces the relevant tier on both Windows and macOS reference devices. Dense retrieval, parser-heavy formats, and remote sync remain outside the verified boundary and require separate measurements.
