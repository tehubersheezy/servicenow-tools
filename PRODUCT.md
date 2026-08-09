# Product

## Register

product

## Users

One user: Abey, a software engineer doing ServiceNow development. He opens the explorer while coding — usually mid-task in an editor or terminal — to answer "is there an API for X?", "what's the exact path and params?", or to wander the catalogue looking for capabilities he didn't know existed. Sessions are short and goal-directed; the tool is a reference he returns to hundreds of times, not a destination.

## Product Purpose

`sn-api-explorer.html` is a self-contained, single-file explorer for the ~342 OpenAPI specs scraped from a ServiceNow instance into `openapi/`. It exists because ServiceNow's own REST API Explorer is slow, requires login, and hides discovery behind dropdowns. Success = any endpoint findable in under five seconds from a cold open, and the catalogue browsable enough that useful undocumented APIs surface serendipitously. The file is generated from `openapi/` by a committed build script, so a re-scrape regenerates the explorer with zero manual work.

## Brand Personality

Precise, quick, quietly confident. A well-made hand tool, not a product with a brand. It should feel like the fastest reference doc the user has ever used: dense where scanning happens, calm where reading happens.

## Anti-references

- **Monospace fonts — absolute ban, user-stated.** No `font-mono`, no code-style styling for paths, IDs, methods, or JSON. Sans stack everywhere, differentiated by weight/size/color instead.
- ServiceNow's own REST API Explorer: login walls, dropdown archaeology, one-API-at-a-time tunnel vision.
- Swagger UI / Redoc defaults: the green/orange method-badge soup, accordion fatigue, generated-doc blandness.
- AI dashboard clichés: hero metrics, identical card grids, gradient text, glassmorphism.

## Design Principles

1. **Search is the interface.** The search field is the primary control; everything else supports refining or acting on its results. Keyboard-first: focus on load, arrow-key navigation, no mouse required.
2. **Two densities, one screen.** Dense, scannable result list; calm, readable detail pane. Neither compromises for the other.
3. **Show the whole catalogue's shape.** Discovery matters as much as lookup — namespaces, counts, and coverage should be visible, not buried behind an empty search box.
4. **Copy-ready output.** Paths, curl commands, and param names exist to be lifted into code. One click, correct escaping, no ceremony.
5. **Regenerable, never hand-edited.** The HTML is a build artifact of `openapi/`. Anything worth changing changes in the generator.

## Accessibility & Inclusion

WCAG 2.1 AA: 4.5:1 body contrast, 3:1 for large text, visible focus rings, full keyboard operability. `prefers-reduced-motion` honored on every animation. Light theme (user-confirmed), so contrast discipline on tinted surfaces matters most.
