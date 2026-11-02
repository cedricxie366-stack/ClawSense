# ClawSense agent distribution

This directory contains the shared **runtime** skill for external agent hosts. It is separate from the root OpenClaw plugin skill surface and from repo-local Codex development guidance.

The installer in src/agent-install.ts generates host-specific packages after a local ClawSense executable, companion URL, and private agent-scoped token-file path are known. It does not ship a guessed npm package, public service, secret, or marketplace listing.

Supported generation targets: Pi, Codex, Claude Code, OpenCode, WorkBuddy, TRAE / TraeCode, Doubao Work, QwenWork, and OpenClaw's companion-client mode. A generated configuration is not proof that the installed host version has passed an end-to-end test.

The `0.2.0-preview.2` candidate's [professional pilot guide](../docs/pilot/README.md) and [support matrix](../docs/pilot/support-matrix.json) distinguish actual DSH/Codex cases, retained OpenClaw entry points, configuration-only targets and pending human acceptance. This is a local candidate, not a public-market release.

- Codex: TOML configuration plus a local .codex-plugin compatibility package.
- OpenClaw: a configuration fragment for the installed native ClawSense plugin. `companionUrl` and `companionTokenFile` select a client that reads the shared library through `clawsense_tools` / `clawsense_call`; it creates no local capture service or second library writer. Its revocable identity is `openclaw-client`. With both settings absent, the original OpenClaw data plane and CLI remain in use.
- DSH: an opt-in `cordis.patch.yml` overlay using `@deepseek-ai/dsh-mcp-client`. Load it in the chosen profile with `--patch`; it references a private agent token file and preserves provider settings. Native image consumption requires both the configured endpoint and DSH attachment path to work; the generated overlay is not live acceptance.
- Claude Code: MCP configuration plus a native .claude-plugin package.
- OpenCode: its mcp map and command argument array.
- Pi: native MCP configuration; use a release that supports ~/.pi/agent/mcp.json.
- WorkBuddy: local MCP configuration with documented user/project import paths.
- TRAE: local MCP configuration and a TraeCode CN installation deep link containing a token-file path, never a token.
- QwenWork: local MCP configuration plus an expert-kit package; validate bundle loading in the target desktop release.
- Doubao Work: Streamable HTTP configuration with an explicit credential placeholder. Its custom connector and authorization flow require live verification; an optional STDIO candidate is not advertised as validated.

Generated files are written only into a fresh output directory. The separate apply installer can merge Pi, Claude Code, and OpenCode strict JSON settings, or append a new Codex TOML table. It preserves other settings, creates a private backup before changing an existing file, and refuses symlinks or unowned same-name entries. Other hosts use their native import UI or installation link.

Before claiming a host is ready, verify installation, pairing, evidence retrieval, correction, and a second query that respects the correction. OAuth, public HTTPS deployment, continuous media, proactive events, and marketplace review are separate capabilities.
