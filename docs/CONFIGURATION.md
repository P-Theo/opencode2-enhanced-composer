# Configuration

Open **Customize footer** from the command palette or type `/customize-footer`. Changes appear in the preview. **Save** applies them to the footer and writes them to `cli.json`. **Reset** restores the defaults in the preview until you save.

## Placement and defaults

The plugin fits two independent rows. `topLeft` and `topRight` render in `session.composer.top`, so those corners appear only inside a session. `bottomLeft` and `bottomRight` render in `prompt.footer`; the location widgets can also appear on the home screen when OpenCode exposes a location, while session metrics remain absent without a session.

The default layout is:

| Zone | Widgets in display order |
| :- | :- |
| `topLeft` | `spinner`, `bgagent` |
| `topRight` | `tps` |
| `bottomLeft` | `directory`, `branch` |
| `bottomRight` | `input`, `output`, `cache`, `cost`, `context` |

If `layout` is omitted, this arrangement is used. If a `layout` object is supplied, an omitted zone is empty. A widget is shown at most once across all zones; duplicate IDs keep their first occurrence in zone order (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`). Widgets are hidden as whole units when a row is too narrow.

## Widget data

The session counters come from OpenCode's cumulative session token and cost fields. The `input` and `output` widgets therefore describe the session's accumulated accounting, while `context` describes the latest usable assistant message.

| Widget | Data and availability |
| :- | :- |
| `spinner` | Appears while the session is running. |
| `directory` | The current working directory. |
| `branch` | The current Git branch when one is available. |
| `input` | Cumulative fresh input plus cache reads plus cache writes: `tokens.input + cache.read + cache.write`. |
| `output` | Cumulative generated output plus reasoning: `tokens.output + tokens.reasoning`. |
| `cache` | Cache-read share of the input side, `(cache.read / input) × 100`, shown to one decimal place. |
| `cost` | Cumulative session cost in USD. |
| `context` | The latest assistant usage after the latest completed compaction and before the session's revert boundary. Percentage and bars require a known model context limit. |
| `tps` | A live token-throughput estimate while output is observable, held across tool execution and between steps, then the frozen average for the completed run. It appears only once a rate exists. |
| `bgagent` | The number of running direct subagents of the session; it hides when the count is zero. |

While a run streams, TPS (tokens per second) is estimated from observed UTF-8 bytes using `bytesPerToken`. When the model stream ends, the last live estimate is held across tool execution and between steps; new observable output resumes the live estimate. Once a step reports its output and reasoning usage, those exact tokens replace that step's estimate, and at run end the cumulative average stays frozen until the next prompt. The label always reads `~N t/s`, so TPS has no appearance setting. The tracker shares its lineage with the standalone [opencode2-tps](https://github.com/P-Theo/opencode2-tps) plugin, minus its `display` option, but the held running display and its refresh behavior differ. See [TPS rate tuning](#tps-rate-tuning) for `refreshHz` and `bytesPerToken`.

## Appearance options

Missing appearance fields use the defaults below. Presets are the literal values accepted in `cli.json`; the custom forms are single-line Unicode text objects. Short hexadecimal values such as `f115` are Nerd Font codepoints (`f115` means U+F115) and render as icons only with a Nerd Font.

| Option | Default | Accepted values and effect |
| :- | :- | :- |
| `appearance.spinner` | `blocks` (■⬝) | `braille` (⠋), `blocks` (■⬝), or `text` (`Running`). |
| `appearance.directory.format` | `name` | `name` or `path`. |
| `appearance.directory.icon` | `f115` | `f115`, `f07b`, `f07c`, `none`, or `{ "text": "..." }`. Empty custom text hides the icon. |
| `appearance.branch` | `f418` | `e0a0`, `f418`, `colon`, or `{ "text": "..." }`. |
| `appearance.worktree` | `e5fb` | `e5fb`, `ec7d`, `none`, or `{ "text": "..." }`. `none` or empty custom text falls back to the ordinary folder icon. |
| `appearance.tokens` | `words` (in/out) | `words` (in/out), `arrows` (↑/↓), or `{ "input": "...", "output": "..." }`. |
| `appearance.cache` | `text` (cache 61%) | `text` (cache 61%), `f49b`, `none` (61%), or `{ "text": "..." }`. `none` and empty custom text keep only the percentage. |
| `appearance.cost` | `currency` ($0.42) | `currency` ($0.42), `labeled` (cost $0.42), or `{ "text": "..." }`. |
| `appearance.bgagent` | `ec20` | `arrow` (↓), `ec20`, `text`, or `{ "text": "..." }`. |
| `appearance.context.format` | `tokens` | `tokens`, `tokens-percent`, `percent`, `tokens-limit`, or `off`. Formats needing a limit fall back to the token count when the limit is unknown. |
| `appearance.context.bar` | `slanted` ([▰▰▰▱▱]) | `solid` ([█████░░░░░]), `slanted` ([▰▰▰▱▱]), or `off`. The bar is omitted when the model limit is unknown. |
| `appearance.context.label` | `context` | `none`, `ctx`, or `context`. |
| `appearance.context.order` | `bar-text-label` | `bar-text-label`, `bar-label-text`, `text-bar-label`, `text-label-bar`, `label-bar-text`, or `label-text-bar`. Hidden pieces are skipped. |
| `appearance.separator` | `pipe` | `dot` (·), `pipe`, `space`, or `{ "text": "..." }` between adjacent metric widgets. |

Choose **custom** in Appearance and press `Enter` to type or paste your own text, symbols, or emoji. Input and output token labels have separate fields, switched with `Tab`. Empty text removes a label or icon according to the rules above. Include any spaces you want in a custom separator. Colors follow your OpenCode theme. A Nerd Font is required for the default glyphs.

## Overflow options

The selected list is ordered from hide first to hide last. The fitting pass considers only widgets that have data in that row, and it recomputes separators after each removal.

| Preset | Hide-first order |
| :- | :- |
| `balanced` (default) | `cost`, `branch`, `cache`, `output`, `input`, `tps`, `directory`, `context`, `spinner`, `bgagent` |
| `usage-first` | `branch`, `directory`, `cost`, `cache`, `tps`, `output`, `input`, `context`, `spinner`, `bgagent` |
| `location-first` | `cost`, `cache`, `tps`, `output`, `input`, `context`, `branch`, `directory`, `spinner`, `bgagent` |
| `custom` | Supply `hideFirst` as a list of widget IDs. Missing IDs are appended in Balanced order. |

## TPS rate tuning

`refreshHz` and `bytesPerToken` are top-level fields in the plugin's `options` object, beside `layout` and `appearance` rather than inside them. Both are `cli.json` only: **Customize footer** does not expose them. Values outside the ranges below are clamped.

| Option | Default | Range | What it changes |
| :- | :- | :- | :- |
| `refreshHz` | `8` | `1`–`60` | How often the live TPS label refreshes per second. |
| `bytesPerToken` | `4.75` | `1`–`16` | Bytes per estimated token until OpenCode reports step usage. |

```json
{
  "plugins": [
    {
      "package": "opencode2-enhanced-composer",
      "options": { "refreshHz": 12, "bytesPerToken": 4.2 }
    }
  ]
}
```

## Editing `cli.json`

Settings go in this plugin's `options` object. For example, this changes only the directory display:

```json
{
  "plugins": [
    {
      "package": "opencode2-enhanced-composer",
      "options": {
        "appearance": { "directory": { "format": "path" } }
      }
    }
  ]
}
```

Use [options.schema.json](../options.schema.json) when editing by hand. The schema lists the same enums, defaults, ranges, and custom text forms described here.

Invalid sections and appearance values are normalized to defaults. Invalid or duplicate widget IDs are dropped, keeping the first occurrence in layout order. Unknown top-level options are preserved for future versions.