# dsh-usage-popup

A glassmorphism usage popup for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It tells you what the current hour costs before you spend it, and what the last turn did spend after it lands.

- **Peak / off-peak reminder** at the start of every turn — red for peak hours, green for off-peak, with a live countdown to the boundary.
- **Turn receipt** when the reply lands — what this turn cost, its average cache hit rate, its tokens, and the running daily total.
- **Status badge** at the left of the composer status row — the current period and its countdown, always visible, no popup required.
- Built-in DeepSeek **flash** and **Pro** pricing, plus fully custom rates for any other model.
- Turn the popup, the badge, the glass blur, the chime, the daily total and the dwell time on or off in **Settings → 消耗弹窗 / Usage popup**.

## Install

```bash
dsh plugin add dsh-usage-popup
```

Or in the GUI: **Plugins → Add plugin** and enter `dsh-usage-popup`.

## Peak and off-peak

The built-in schedule follows DeepSeek's published policy:

| Period | When |
| --- | --- |
| Peak | Monday to Friday, 09:00–12:00 and 14:00–18:00 (UTC+8), excluding statutory holidays |
| Off-peak | Everything else — weekday nights, all weekend, all holidays |

Off-peak bills at 50% of the peak rate. Holidays are carried in the source for 2025 and 2026; a custom window can be set in Settings when your provider differs.

## Cost and cache hit rate

Nothing is billed by a remote service; every number is computed locally from the session's own `tokenUsage` projection:

```
context = uncachedInput + cacheRead + cacheWrite
hitRate = cacheRead / context
cost    = uncachedInput/1e6 * missPrice
        + cacheRead/1e6     * hitPrice
        + output/1e6        * outputPrice
```

Prices are per million tokens, in yuan by default. The three fields are editable, and both the miss and hit prices are halved off-peak for the built-in presets.

A turn is measured as the delta between the projection when the turn started and when it finished, so the receipt describes that turn rather than the whole conversation.

## Privacy

The plugin reads token counts that Harness already keeps for the open session and stores your preferences in the renderer's local storage. It makes no network requests, sends nothing anywhere, and needs no credentials. Turning it off removes every card and badge and leaves no trace in the transcript.

## Development

```bash
# render the component tree to static HTML, then screenshot it
node test/preview.mjs

# 93 assertions over the popup, the badge, the settings page and the confirm dialog
node test/client.test.mjs
```

The package has no build step: `client.js` is the browser half, `index.js` is a no-op Host entry, and the bundle patch inserts the single plugin row.

## License

MIT
