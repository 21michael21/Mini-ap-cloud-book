# Ink & Glow Design System

Use this document as the foundation for every Telegram Library Mini App page.

## Tokens

- `--bg`: `#0B0D12`
- `--surface`: `#151821`
- `--surface-2`: `#1C2030`
- `--line`: `#262B3A`
- `--text`: `#EDEFF5`
- `--muted`: `#8B93A7`
- `--accent`: `#8B9BFF`
- `--accent-press`: `#6B7BE6`
- Skeleton gradient: `#1A1E2B -> #242A3C -> #1A1E2B`
- Radius: `14px` for chips/controls, `16px` for cards
- Progress: `4px` high, accent fill on `#1C2030` track
- UI font: Space Grotesk, weights `400-700`
- Reader/body font: Literata, optical sizing enabled

## CSP Contract

- Strict CSP only. Do not use `unsafe-inline` or `unsafe-eval`.
- Do not use inline `style=""` attributes or inline event handlers.
- Convert mockup inline styles into external CSS classes.
- Fonts are self-hosted from `miniapp/public/fonts` through `@font-face`.
- Do not load Google Fonts or other remote font CSS in `index.html`.
- If an asset needs a CSP change, propose the exact directive change first.

## Motion

- Reusable keyframes live in `miniapp/src/styles.css`.
- Prefer transform/opacity only.
- Keep interaction animations around `150-250ms`.
- Preserve the `prefers-reduced-motion` guard.
- Do not capture vertical swipe-down gestures; Telegram owns that gesture.

## Implementation Boundaries

- Wire pages to the existing API/data only.
- Do not invent endpoints for design work.
- Do not touch backend auth, initData validation, staleness checks, or ownership.
- Stack stays vanilla TypeScript and CSS. No React, Tailwind, or heavy UI framework.
