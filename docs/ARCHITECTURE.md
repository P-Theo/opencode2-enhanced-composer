# Architecture

The plugin reads OpenCode session data, formats widgets, fits them into two rows, and renders them around the composer. The settings preview uses the same formatting, fitting, and rendering code.

## Rendering

```text
Host data + options
  → footer.tsx: StatusSnapshot
  → format.ts: widget text and widths
  → layout.ts: fitted rows
  → status-row.tsx: terminal output
```

[`footer.tsx`](../src/footer.tsx) owns host subscriptions, refresh scheduling, and plugin lifecycle. It replaces `prompt.footer` for the bottom row, appends to `session.composer.top` for the top row, and registers **Customize footer** through the `app` slot.

| Module | Responsibility |
| :- | :- |
| [`options.ts`](../src/options.ts) | Shared types, defaults, validation, and settings drafts. |
| [`format.ts`](../src/format.ts) | Widget text, data availability, and directory path variants. |
| [`layout.ts`](../src/layout.ts) | Terminal-cell measurement and hiding widgets until both corners fit. |
| [`status-row.tsx`](../src/status-row.tsx) | Render the fitted rows and report their available width. |
| [`widgets.tsx`](../src/widgets.tsx) | Animated spinners and context bars. |
| [`tps.ts`](../src/tps.ts) | Estimate live token throughput and reconcile it with reported usage. |

## Settings

[`settings.tsx`](../src/settings.tsx) owns the dialog. [`settings-model.ts`](../src/settings-model.ts) manages its draft and preview, then passes changed fields to [`config-file.ts`](../src/config-file.ts) for saving to `cli.json`.

Runtime reads fall back on defaults for invalid values. Saves require valid values, preserve unrelated settings, and report conflicting external edits. `cli.json` is the only persistent settings store.

See [Development](DEVELOPMENT.md) for commands and packaging. Host quirks and implementation constraints are documented beside the code they affect.
