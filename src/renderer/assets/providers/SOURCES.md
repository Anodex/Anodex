# Provider logo sources

These provider marks are copied from provider-owned websites, official downloadable asset packs, or simple-icons (CC0-licensed, built exactly for this kind of nominative brand-logo use). They are stored locally so the settings UI does not depend on a network request.

Retrieved 2026-07-15, except Kimi and Qwen (2026-07-24).

| Asset        | Official source                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI       | https://openai.com/brand/                                                                                                                                                                                                                                                                                                                   |
| Anthropic    | https://www.anthropic.com/                                                                                                                                                                                                                                                                                                                  |
| Google       | https://about.google/products/                                                                                                                                                                                                                                                                                                              |
| xAI          | https://x.ai/legal/brand-guidelines                                                                                                                                                                                                                                                                                                         |
| DeepSeek     | https://www.deepseek.com/en/                                                                                                                                                                                                                                                                                                                |
| Mistral AI   | https://mistral.ai/brand/                                                                                                                                                                                                                                                                                                                   |
| Groq         | https://groq.com/favicon.svg                                                                                                                                                                                                                                                                                                                |
| OpenRouter   | https://openrouter.ai/brand/v2/openrouter-glyph-light.svg                                                                                                                                                                                                                                                                                   |
| Azure OpenAI | https://learn.microsoft.com/en-us/azure/architecture/icons/                                                                                                                                                                                                                                                                                 |
| Kimi         | https://moonshotai.github.io/Branding-Guide/ (official Moonshot AI brand guide; used the "K only, light" variant, `#1783FF` + black, matching this panel's light logo-badge background)                                                                                                                                                     |
| Qwen         | Path data via [simple-icons](https://simpleicons.org) (CC0), already vetted and in use elsewhere in this codebase (`src/renderer/components/ModelLogo.tsx`); fill color `#615CED` is Qwen's documented brand color, cross-checked against multiple independent brand-asset aggregators since simpleicons.org itself blocked a direct fetch. |

The OpenAI, Anthropic, DeepSeek, and Mistral symbols are preserved from SVG artwork served by their official sites. The xAI and Azure OpenAI symbols come from the providers' official downloadable asset packages. Keep the artwork unmodified and use it only to identify the corresponding provider.

## Chip surfaces

Most marks sit on the shared light chip (`.providerLogoOfficial`), but several are drawn for a specific background and get their own in `AiModelsSettings.module.css` — the artwork itself is never recoloured, only the surface behind it:

- **OpenAI** — white glyph on black, its canonical tile. `openai.svg` fills with `currentColor`, so the chip's `color` drives the glyph.
- **Anthropic** — near-black on Anthropic's own cream (`#f0eee6`), their real brand pairing.
- **Mistral** — the multicolour M on black, as Mistral presents it; its amber top bars (`#ffaf01`) are close to illegible on a light chip.
- **Groq** — `groq.svg` is a complete tile (full-bleed orange field plus a white bolt), not a bare glyph, so it fills the chip edge to edge instead of being inset on another background.
- **Local model** — Anodex's own `app-icon.png`, which already ships its own dark rounded-square badge, so it also fills the chip edge to edge.
