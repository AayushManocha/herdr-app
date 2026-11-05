import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";

// Plan limits as the agents themselves report them; no credentials, no network.
// Claude Code gives `rate_limits` only to its status line, and `cc-hud statusline`
// saves them. Codex writes them into its session logs.
const CLAUDE = 'cat "${XDG_STATE_HOME:-$HOME/.local/state}/cc-hud/usage" 2>/dev/null';
// A limit window lasts at most 7 days, so older sessions can't hold a live number.
const CODEX = `find "\${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name 'rollout-*.jsonl' -mtime -8 -exec ls -t {} + 2>/dev/null | head -n 3 |
  while IFS= read -r f; do tail -c 262144 "$f" | grep '"rate_limits":{' | tail -n 20; done`;

const WARN = 70;
const DANGER = 90;
const POLL_MS = 30000;
const MIN_WIDTH = 160;

const shell = async (script) => (await exec("sh", ["-c", script])).stdout;

function parseClaude(text) {
  const data = JSON.parse(text);
  const limits = data.rate_limits ?? {};
  const windows = [
    ["5h", "5-hour", limits.five_hour],
    ["7d", "7-day", limits.seven_day],
    ["$", "spend", limits.spend_limit],
  ].filter(([, , w]) => w && Number.isFinite(w.used_percentage))
    .map(([label, name, w]) => ({ label, name, pct: w.used_percentage, resetsAt: w.resets_at }));
  return { name: "Claude", updated: data.updated, windows };
}

function codexWindow(w) {
  if (!w || !Number.isFinite(w.used_percentage)) return null;
  const m = w.window_minutes;
  const days = m % 1440 === 0;
  return {
    label: days ? `${m / 1440}d` : `${Math.round(m / 60)}h`,
    name: days ? `${m / 1440}-day` : `${Math.round(m / 60)}-hour`,
    pct: w.used_percentage,
    resetsAt: w.resets_at,
  };
}

function parseCodex(text) {
  let latest = null;
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line);
      const limits = entry.payload?.rate_limits;
      // Codex also reports per-model buckets; the plan's own has this id (or none, in older logs).
      if (!limits || (limits.limit_id && limits.limit_id !== "codex")) continue;
      if (!latest || entry.timestamp > latest.timestamp) latest = { timestamp: entry.timestamp, limits };
    } catch {
      // tail -c can cut the first line.
    }
  }
  if (!latest) return null;
  return {
    name: "Codex",
    updated: Date.parse(latest.timestamp) / 1000,
    windows: [codexWindow(latest.limits.primary), codexWindow(latest.limits.secondary)].filter(Boolean),
  };
}

function duration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export default class UsageLimits extends View {
  init(_props, cx) {
    this.sources = {};
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      await Promise.all([this.load("claude", CLAUDE, parseClaude), this.load("codex", CODEX, parseCodex)]);
      cx.notify();
    });
  }

  async load(key, script, parse) {
    try {
      const text = await shell(script);
      this.sources[key] = text.trim() ? parse(text) : null;
    } catch (error) {
      // Keep the last good numbers; this runs again at the next poll.
      console.log(`usage-limits: ${key}: ${error}`);
    }
  }

  meter(source, w, now, t) {
    const pct = Math.round(w.pct);
    const color = pct >= DANGER ? t.blocked : pct >= WARN ? t.ansi3 : null;
    const tip = `${source.name} ${w.name} limit: ${pct}% used · resets in ${duration(w.resetsAt - now)}`
      + (source.updated ? ` · updated ${duration(now - source.updated)} ago` : "");
    return h_flex().id(`usage-${source.name}-${w.label}`).gap(5).items_center().tooltip(tip)
      .child(div().text_color(t.dim).child(w.label))
      .child(div().w(22).h(4).rounded(2).bg(t.border).overflow_hidden()
        .child(div().h_full().w(22 * Math.min(pct, 100) / 100).bg(color ?? t.muted)))
      .child(div().w(30).text_color(color ?? t.muted).child(`${pct}%`));
  }

  render() {
    const t = theme();
    const now = Date.now() / 1000;
    const shown = [this.sources.claude, this.sources.codex]
      .filter(Boolean)
      // A window past its reset has no usage until the agent's next response reports it.
      .map((source) => ({ source, windows: source.windows.filter((w) => w.resetsAt > now) }))
      .filter(({ windows }) => windows.length > 0);
    // A folded sidebar is a rail with no room for numbers.
    const visible = shown.length > 0 && (this.size?.width ?? Infinity) >= MIN_WIDTH;
    return v_flex().id("root").size_full().px(16).gap(4).justify_center()
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .bg(t.chrome).text_size(11.8)
      .when(visible, (el) => el.border_t(1).border_color(t.border)
        .children(shown.map(({ source, windows }) => h_flex().gap(10).items_center()
          .child(div().w(44).text_color(t.muted).child(source.name))
          .children(windows.map((w) => this.meter(source, w, now, t))))));
  }
}
