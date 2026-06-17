---
name: tractus-ui-style
description: Michal's UI/design preferences for the Tractus web app
metadata:
  type: feedback
---

For the Tractus web app, Michal wants a futuristic command/terminal-style UI: dark "flight-deck/telemetry" aesthetic, monospace-forward typography, neat/intuitive UX. Dislikes "AI bloat text" — keep copy terse and functional, cut decorative descriptions.

**Why:** Tractus is an operator console for autonomous coding agents; the look should match the subject (mission control), not a generic SaaS template.

**How to apply:** Palette uses meaning-bearing signal colors (cyan=live/primary, amber=awaiting-human gate, violet=agents, red=blocked) on a cool slate-black `#080b12`. Fonts: Space Grotesk (display) + JetBrains Mono (data). Tokens live in `apps/web/src/theme.css`; the `❯` prompt motif appears in the appbar/modal/auth headers. When adding UI, prefer microcopy over paragraphs.
