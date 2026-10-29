# Getting started

Set up a private vault and launch Axiom on Windows.

[Back to README](../README.md)

## Prerequisites and build

Install Node.js 22.13 or newer and PowerShell 7. Bun and omp are needed only for the omp integration. In PowerShell 7, from the application checkout, install dependencies, build the browser application and link the CLI:

```powershell
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
```

## Private configuration and vault

Axiom normally reads `%LOCALAPPDATA%/Axiom/config.json`; if `LOCALAPPDATA` is unavailable, it uses `~/.config/Axiom/config.json`. Alternatively, set `SHARED_BRAIN_CONFIG` to an absolute private configuration path. Make the override available to login-started processes and agent sessions as well as your interactive shell. Keep the configuration, vault and backups outside the Git checkout.

If the chosen configuration does not already exist, create its parent directory and copy `config.example.json` there. Do not overwrite an existing configuration. Edit the copy to use your own absolute paths and an available port. For example:

```json
{
  "vault": "C:/private/axiom/vault",
  "backupDir": "C:/private/axiom/backups",
  "port": 4317,
  "projects": [
    { "id": "sample", "root": "C:/work/sample", "additionalRoots": ["C:/work/sample-other"] }
  ]
}
```

The vault and backup directories must be separate, with neither inside the other. `projects` may be empty. Project IDs must be unique and use lowercase letters, digits and hyphens, beginning with a letter or digit. Project roots and optional `additionalRoots` must be absolute; the longest matching root selects the workspace.

Create the vault and its `Owner` directory. A human must write both `Owner/Policies.md` and `Owner/Preferences.md` with the owner's actual rules and preferences. These are required policy inputs, not generated defaults; do not invent policy text for the owner.

## Optional agent integrations

For browser-only use, skip the installer. To install the native Claude Code hooks and omp extension wrapper, after creating the two owner files run:

```powershell
node scripts/install.mjs
```

The installer preserves unrelated settings and saves rollback copies and an installation report in private backup storage. It does not install dependencies, link the CLI or edit global instruction files. When relocating an existing installation, supply the absolute old application root so matching old Axiom handlers can be replaced:

```powershell
node scripts/install.mjs --previous-root "C:/absolute/old/app"
```

Restart Claude Code and omp in fresh sessions so the integrations load. See [agent memory](agent-memory.md#integrations-and-the-cli) for supported harnesses, existing memory-store settings, ownership and usage workflows.

### Other MCP clients

The official-SDK stdio server exposes policy, search, read, guarded agent writes, unused icons and capture suggestions. It does not expose human editing, review, deletion, administration or history restore. Configure it in the client's MCP settings; the exact configuration wrapper depends on the client:

```json
{
  "mcpServers": {
    "axiom": {
      "command": "node",
      "args": [
        "C:/apps/Axiom/integrations/mcp.mjs",
        "--config", "C:/private/axiom/config.json",
        "--cwd", "C:/work/sample"
      ]
    }
  }
}
```

Use your actual checkout, private configuration and project directory. Keep the host session's project and MCP `--cwd` aligned. Without `--cwd`, the server uses its launch working directory; some hosts do not launch it in the project root. `SHARED_BRAIN_CONFIG` is also supported. After linking the package, `axiom-memory-mcp` is the equivalent executable.

Each stdio client starts a process; Axiom does not add a permanently running MCP daemon. Enable only the integrations you use. The native installer does not register MCP servers or edit other clients' settings. MCP makes tools available, not mandatory; retain native policy hooks where configured and validate a fresh session before disabling another memory system.

## Start the application

```powershell
./scripts/start.ps1 -Register -Open
```

This starts the application, registers current-user automatic startup and opens the browser. Use the URL reported by the launcher; the configured port may differ from the example. For supervision, recovery and security details, see [operations](operations.md).
