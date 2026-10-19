'use strict';
// Data-driven harness registry. Paths are written with ~ and expanded at use.
// update.type: npm | pypi | github | cmd (native "check" command) | none
// secret items are excluded from backups unless the user opts in, and are never shown in the editor.

const NPM_LOCAL = 'npm i -g --prefix ~/.local';

const cfg = (path, label, o = {}) => ({ path, label: label || path.split('/').pop(), kind: 'file', ...o });
const dir = (path, label, o = {}) => ({ path, label: label || path.split('/').pop() + '/', kind: 'dir', ...o });
const secret = (path, label) => ({ path, label: label || path.split('/').pop(), kind: 'file', secret: true });

module.exports = [
  {
    id: 'claude', name: 'Claude Code', desc: 'Anthropic coding agent', bins: ['claude'], configDir: '~/.claude',
    homepage: 'https://claude.com/claude-code',
    update: { type: 'npm', pkg: '@anthropic-ai/claude-code' }, updateCmd: 'claude update',
    installCmd: 'curl -fsSL https://claude.ai/install.sh | bash',
    items: [
      cfg('~/.claude/settings.json'), cfg('~/.claude/CLAUDE.md'), cfg('~/.claude/keybindings.json'),
      dir('~/.claude/agents', null, { browse: true }), dir('~/.claude/commands', null, { browse: true }),
      dir('~/.claude/hooks', null, { browse: true }), dir('~/.claude/skills', null, { heavy: true }),
      secret('~/.claude.json', '.claude.json (accounts, MCP servers)'), secret('~/.claude/.credentials.json'),
    ],
  },
  {
    id: 'codex', name: 'Codex CLI', desc: 'OpenAI coding agent', bins: ['codex'], configDir: '~/.codex',
    homepage: 'https://github.com/openai/codex',
    update: { type: 'npm', pkg: '@openai/codex' }, updateCmd: `${NPM_LOCAL} @openai/codex@latest`,
    installCmd: 'npm i -g @openai/codex',
    items: [
      cfg('~/.codex/config.toml'), cfg('~/.codex/AGENTS.md'), cfg('~/.codex/hooks.json'),
      dir('~/.codex/rules', null, { browse: true }), dir('~/.codex/agents', null, { browse: true }),
      dir('~/.codex/skills', null, { heavy: true }), secret('~/.codex/auth.json'),
    ],
  },
  {
    id: 'opencode', name: 'OpenCode', desc: 'Open-source terminal agent', bins: ['opencode'], extraBins: ['~/.opencode/bin/opencode'],
    configDir: '~/.config/opencode', homepage: 'https://opencode.ai',
    update: { type: 'npm', pkg: 'opencode-ai' }, updateCmd: 'opencode upgrade',
    installCmd: 'curl -fsSL https://opencode.ai/install | bash',
    items: [
      cfg('~/.config/opencode/opencode.json'), cfg('~/.config/opencode/opencode.jsonc'), cfg('~/.config/opencode/AGENTS.md'),
      cfg('~/.config/opencode/package.json'),
      dir('~/.config/opencode/agent', null, { browse: true }), dir('~/.config/opencode/agents', null, { browse: true }),
      dir('~/.config/opencode/commands', null, { browse: true }), dir('~/.config/opencode/plugins', null, { browse: true }),
      dir('~/.config/opencode/skills', null, { heavy: true }), secret('~/.local/share/opencode/auth.json'),
    ],
  },
  {
    id: 'grok', name: 'Grok CLI', desc: 'xAI coding agent', bins: ['grok'], extraBins: ['~/.grok/bin/grok'], configDir: '~/.grok',
    homepage: 'https://x.ai',
    update: { type: 'cmd', check: ['grok', 'update', '--check', '--json'] }, updateCmd: 'grok update',
    installCmd: 'See https://x.ai for the Grok CLI installer',
    items: [cfg('~/.grok/config.toml'), dir('~/.grok/skills', null, { heavy: true }), secret('~/.grok/auth.json')],
  },
  {
    id: 'gemini', name: 'Gemini CLI', desc: 'Google coding agent', bins: ['gemini'], configDir: '~/.gemini',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    update: { type: 'npm', pkg: '@google/gemini-cli' }, updateCmd: 'mise upgrade gemini-cli',
    installCmd: 'npm i -g @google/gemini-cli',
    items: [
      cfg('~/.gemini/settings.json'), cfg('~/.gemini/GEMINI.md'), cfg('~/.gemini/trustedFolders.json'),
      dir('~/.gemini/agents', null, { browse: true }), dir('~/.gemini/skills', null, { heavy: true }),
      secret('~/.gemini/oauth_creds.json'), secret('~/.gemini/google_accounts.json'), secret('~/.gemini/.env'),
    ],
  },
  {
    id: 'agy', name: 'Antigravity CLI', desc: 'Google Antigravity agent', bins: ['agy'], configDir: '~/.gemini/antigravity',
    homepage: 'https://antigravity.google',
    update: { type: 'none' }, updateCmd: null, installCmd: 'See https://antigravity.google for the installer',
    items: [cfg('~/.gemini/antigravity/mcp_config.json'), dir('~/.gemini/antigravity/skills', null, { heavy: true })],
  },
  {
    id: 'pi', name: 'Pi', desc: 'Minimal terminal coding agent', bins: ['pi'], configDir: '~/.pi',
    homepage: 'https://github.com/earendil-works/pi',
    update: { type: 'npm', pkg: '@earendil-works/pi-coding-agent' }, updateCmd: 'pi update self',
    installCmd: 'npm i -g @earendil-works/pi-coding-agent',
    items: [cfg('~/.pi/agent/models-store.json'), dir('~/.pi/agent/skills', null, { heavy: true }), secret('~/.pi/agent/auth.json')],
  },
  {
    id: 'hermes', name: 'Hermes Agent', desc: 'Nous Research agent', bins: ['hermes'], configDir: '~/.hermes',
    homepage: 'https://github.com/NousResearch/hermes-agent',
    update: { type: 'cmd', check: ['hermes', 'update', '--check'], timeout: 30000 }, updateCmd: 'hermes update --yes',
    installCmd: 'See the Hermes Agent repository',
    note: 'Hermes manages its own config — edit with `hermes config set`. Files here are read-only in the editor.',
    items: [
      cfg('~/.hermes/config.yaml', null, { readonly: true }), cfg('~/.hermes/SOUL.md', null, { readonly: true }),
      cfg('~/.hermes/USER.md', null, { readonly: true }), cfg('~/.hermes/AGENTS.md', null, { readonly: true }),
      dir('~/.hermes/skills', null, { heavy: true }), secret('~/.hermes/.env'), secret('~/.hermes/auth.json'),
    ],
  },
  {
    id: 'goose', name: 'Goose', desc: 'Block open-source agent', bins: ['goose'], configDir: '~/.config/goose',
    homepage: 'https://github.com/aaif-goose/goose',
    update: { type: 'github', repo: 'aaif-goose/goose' }, updateCmd: 'goose update',
    installCmd: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
    items: [cfg('~/.config/goose/config.yaml'), dir('~/.config/goose/skills', null, { heavy: true })],
  },
  {
    id: 'openclaude', name: 'OpenClaude', desc: 'Claude Code fork, any model', bins: ['openclaude'], configDir: '~/.openclaude',
    homepage: 'https://github.com/gitlawb/openclaude',
    update: { type: 'npm', pkg: '@gitlawb/openclaude' }, updateCmd: `${NPM_LOCAL} @gitlawb/openclaude@latest`,
    installCmd: 'npm i -g @gitlawb/openclaude',
    items: [cfg('~/.openclaude/settings.json'), dir('~/.openclaude/plugins', null, { heavy: true })],
  },
  {
    id: 'cursor', name: 'Cursor Agent', desc: 'Cursor CLI agent', bins: ['cursor-agent'], configDir: '~/.cursor',
    homepage: 'https://cursor.com/cli', update: { type: 'none' }, updateCmd: 'cursor-agent update',
    installCmd: 'curl https://cursor.com/install -fsS | bash',
    items: [cfg('~/.cursor/cli-config.json'), cfg('~/.cursor/mcp.json')],
  },
  {
    id: 'qwen', name: 'Qwen Code', desc: 'Alibaba coding agent', bins: ['qwen'], configDir: '~/.qwen',
    homepage: 'https://github.com/QwenLM/qwen-code',
    update: { type: 'npm', pkg: '@qwen-code/qwen-code' }, updateCmd: 'npm i -g @qwen-code/qwen-code@latest',
    installCmd: 'npm i -g @qwen-code/qwen-code',
    items: [cfg('~/.qwen/settings.json'), cfg('~/.qwen/QWEN.md'), secret('~/.qwen/oauth_creds.json')],
  },
  {
    id: 'amp', name: 'Amp', desc: 'Sourcegraph coding agent', bins: ['amp'], configDir: '~/.config/amp',
    homepage: 'https://ampcode.com',
    update: { type: 'npm', pkg: '@sourcegraph/amp' }, updateCmd: 'npm i -g @sourcegraph/amp@latest',
    installCmd: 'npm i -g @sourcegraph/amp',
    items: [cfg('~/.config/amp/settings.json'), cfg('~/.config/amp/AGENTS.md')],
  },
  {
    id: 'crush', name: 'Crush', desc: 'Charm terminal agent', bins: ['crush'], configDir: '~/.config/crush',
    homepage: 'https://github.com/charmbracelet/crush',
    update: { type: 'npm', pkg: '@charmland/crush' }, updateCmd: 'npm i -g @charmland/crush@latest',
    installCmd: 'npm i -g @charmland/crush',
    items: [cfg('~/.config/crush/crush.json'), cfg('~/.config/crush/AGENTS.md')],
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', desc: 'GitHub coding agent', bins: ['copilot'], configDir: '~/.copilot',
    homepage: 'https://github.com/github/copilot-cli',
    update: { type: 'npm', pkg: '@github/copilot' }, updateCmd: 'npm i -g @github/copilot@latest',
    installCmd: 'npm i -g @github/copilot',
    items: [cfg('~/.copilot/config.json'), cfg('~/.copilot/mcp-config.json')],
  },
  {
    id: 'cline', name: 'Cline CLI', desc: 'Cline coding agent', bins: ['cline'], configDir: '~/.cline',
    homepage: 'https://cline.bot',
    update: { type: 'npm', pkg: 'cline' }, updateCmd: 'npm i -g cline@latest', installCmd: 'npm i -g cline',
    items: [dir('~/.cline/data/settings', null, { browse: true })],
  },
  {
    id: 'kilo', name: 'Kilo Code CLI', desc: 'Kilo Code agent', bins: ['kilo', 'kilocode'], configDir: '~/.config/kilo',
    homepage: 'https://kilo.ai',
    update: { type: 'npm', pkg: '@kilocode/cli' }, updateCmd: 'npm i -g @kilocode/cli@latest', installCmd: 'npm i -g @kilocode/cli',
    items: [cfg('~/.config/kilo/kilo.json'), cfg('~/.config/kilo/kilo.jsonc')],
  },
  {
    id: 'aider', name: 'Aider', desc: 'Pair-programming in the terminal', bins: ['aider'], configDir: '~/.aider',
    homepage: 'https://aider.chat',
    update: { type: 'pypi', pkg: 'aider-chat' }, updateCmd: 'uv tool upgrade aider-chat', installCmd: 'uv tool install aider-chat',
    items: [cfg('~/.aider.conf.yml'), cfg('~/.aider.model.settings.yml'), cfg('~/.aider.model.metadata.json'), secret('~/.env', '~/.env (shared)')],
  },
  {
    id: 'kimi', name: 'Kimi CLI', desc: 'Moonshot coding agent', bins: ['kimi'], configDir: '~/.kimi',
    homepage: 'https://github.com/MoonshotAI/kimi-cli',
    update: { type: 'pypi', pkg: 'kimi-cli' }, updateCmd: 'uv tool upgrade kimi-cli', installCmd: 'uv tool install kimi-cli',
    items: [cfg('~/.kimi/config.toml'), cfg('~/.kimi/mcp.json')],
  },
  {
    id: 'droid', name: 'Droid', desc: 'Factory coding agent', bins: ['droid'], configDir: '~/.factory',
    homepage: 'https://factory.ai', update: { type: 'none' }, updateCmd: 'droid update',
    installCmd: 'curl -fsSL https://app.factory.ai/cli | sh',
    items: [cfg('~/.factory/settings.json'), cfg('~/.factory/mcp.json'), dir('~/.factory/droids', null, { browse: true })],
  },
];
