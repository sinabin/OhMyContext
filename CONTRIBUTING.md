# Contributing

OhMyContext is not yet accepting external contributions because its open-source license is undecided. See [LICENSE-STATUS.md](LICENSE-STATUS.md).

Once the licensing hold is resolved, this document will define the DCO process, development environment, connector review, security requirements, and pull-request checks.

Internal development currently follows these rules:

- Keep canonical user data independent from derived indexes.
- Do not add write-capable MCP tools to the MVP.
- Treat imported content as untrusted data.
- Add deterministic fixtures for every connector.
- Add a regression test for each fixed security or data-loss defect.
- State whether a feature is implemented, experimental, or planned.

Run the local verification suite before committing:

```bash
npm run check
```
