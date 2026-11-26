# Getting started

Set up a private vault and launch Axiom on Windows.

[Back to README](../README.md)

## Prerequisites and build

Install Node.js 22.13 or newer and PowerShell 7. Bun and omp are needed only for the omp integration. In PowerShell 7, from the application checkout, install dependencies, build the interface and link the CLI:

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

If you only use the desktop app, skip the installer. To install the native Claude Code hooks and omp extension wrapper, after creating the two owner files run:

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

## Optional local semantic retrieval

Lexical search requires no model. For semantic search, install and run [Ollama](https://ollama.com/download), then obtain the official [Qwen3-Embedding-0.6B Q8_0 GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf). The Apache-2.0 artifact is 639,150,592 bytes. Setup verifies SHA-256 `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439` before importing anything.

With the same private configuration selected as the application:

```powershell
npm run setup:embeddings -- --model-file "C:/models/Qwen3-Embedding-0.6B-Q8_0.gguf"
axiom-memory index-embeddings
./scripts/start.ps1 -Restart
```

Setup accepts `--config "C:/private/axiom/config.json"` and an optional loopback `--endpoint`. It imports the verified artifact as `axiom-qwen3-embedding:latest`, pins the local manifest digest in private configuration, backs up the previous configuration and preserves unrelated settings. It refuses to overwrite an existing alias with different/unverified weights. It does not download a model, start Ollama, alter its global settings, or configure its login startup. Ollama must be available; Axiom's watchdog supervises Axiom, not Ollama.

Ollama selects available GPU acceleration. Axiom requests a 2,048-token context, 256-token batch, 1,024 dimensions and a two-minute inference idle keep-alive. Cold loading can take tens of seconds; the app shows lexical results first. Model allocation is not a total VRAM guarantee. Restart cached harness sessions after upgrading. See [operation and disabling](operations.md#semantic-search-operation) and [measurement boundaries](development.md#retrieval-qualification-and-optional-embeddings).

## Start the application

```powershell
./scripts/start.ps1 -Register
```

This starts the local backend and registers it to start hidden at sign-in. Then open the **Axiom** desktop app from the Start menu. The backend serves the interface only to the desktop app; opening its address in a browser shows a short notice instead. This is a product boundary, not access control: the loopback API, CLI and MCP server work exactly as before.

The integration installer also installs the desktop app into `%LOCALAPPDATA%/AxiomDesktop` when a Velopack installer is available locally in `Releases/` or from GitHub Releases. Pass `--skip-desktop` to install only agent integrations. You can also run `AxiomDesktop-win-Setup.exe` from the latest GitHub release directly.

To pack or publish the self-contained Velopack desktop installer locally:

```powershell
npm run desktop:pack
npm run desktop:install
npm run desktop:release
```

After changing the desktop icon artwork, run `npm run desktop:icons` before packaging. The generator verifies that the Windows icon contains every size from 16 to 256 pixels used by the package.
The app, Windows taskbar, and installer artwork are generated from the same Keystone mark: a light "A" with a clay full stop on a neutral charcoal tile.
The main window picks a frame from the Windows icon resource at its monitor's DPI.

Opening `Setup.exe` without arguments shows the Axiom-themed Install, Update, Repair, or Downgrade confirmation. The launcher uses Velopack for the installation and opens Axiom after success. Command-line arguments, including `--silent` and `--installto`, go directly to the embedded Velopack installer. In-app updates still use Velopack directly. The Windows build uses the .NET Framework C# compiler already provided by Windows.
