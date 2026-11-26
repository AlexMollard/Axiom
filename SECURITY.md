# Security policy

## Supported versions

Only the latest release gets security fixes. The desktop app updates itself, so
staying current is usually automatic.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/AlexMollard/Axiom/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and the
version you tested. You should hear back within a week.

## Security model

Axiom is a local, single-user app. Knowing its boundaries helps you judge
whether something is a vulnerability:

- The backend listens on loopback (`127.0.0.1:4318`) only. Anything that lets a
  remote host or another web origin read or change the vault is in scope.
- The desktop-only page at `/` hides the UI from ordinary browsers but is not
  access control. Other processes running as the same Windows user are trusted.
- The real UI is served by the backend, which sends its own strict
  Content-Security-Policy. The Tauri-level `csp` in `tauri.conf.json` is unset
  because it only covers the bundled offline fallback page, which is static and
  shows no vault content.
- Owner notes are protected from agent writes by rules and guarded APIs, not OS
  isolation. An agent that can run arbitrary shell commands can bypass them.
- Vault passages sent to a cloud model (for example by the optimizer) leave the
  machine. That is by design, not a vulnerability.
