# Contributing to Axiom

Thanks for helping. Axiom is a Windows-only desktop app, so you need a Windows 11 machine.

## Set up

Prerequisites and build commands are in [docs/development.md](docs/development.md#build-from-source).

## Test

Run both suites before opening a pull request:

```powershell
npm test               # Node backend, retrieval and UI-adjacent tests
npm run desktop:test   # Rust tests for the Tauri shell
```

This project runs no automatic GitHub Actions, so CI is manual-only: there is no check that runs on your pull request. Run the tests locally and say in the pull request what you ran.

## Commits

- One subject line, imperative mood, capitalised, no trailing period, under about 72 characters.
- No type prefixes such as `feat:` or `fix:`.
- Add a short bullet body only when it adds detail. One commit is one coherent change.

Example: `Fix backup snapshot naming on case-insensitive paths`

## Proposing changes

Open an issue before large changes (new features, refactors, anything touching ownership, review or security behaviour) so we can agree the approach first. Small fixes can go straight to a pull request.

Keep screenshots and test data fictional; never commit a real vault, configuration or usage data.

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree your work is released under the [MIT license](LICENSE).
