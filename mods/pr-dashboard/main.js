// A full-window list of open pull requests, by Herdr project: title, CI, human review comments,
// and a description folded away. A PR's row opens it on GitHub; Esc goes back. The last answer
// shows at once from the local cache while a spinner says a fresh one is on its way.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, exec, props, closeOverlay, notify, window, spaces } from "herdr";
import { fetchPullRequests, projectStore, resolveSpaceRepos } from "./github.js";
import { projectGroups } from "./summary.js";

const REFRESH_MS = 2 * 60 * 1000;
const CACHE = "cache";
const icon = (name) => `mods/pr-dashboard/${name}.svg`;
const shared = (name) => `mods/workspace-chrome/${name}.svg`;

function ago(at) {
  const minutes = (Date.now() - new Date(at).getTime()) / 60000;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function openOnGitHub(url) {
  try {
    const r = await exec("open", [url]);
    if (r.code !== 0) throw new Error(r.stderr);
  } catch (e) {
    notify({ title: "Couldn't open GitHub", body: String(e?.message ?? e), level: "error" });
  }
}

export default class PrDashboard extends View {
  init(_props, cx) {
    this.prs = null; // null until the first answer; [] means none are open.
    this.spaceRepos = {};
    this.error = "";
    this.warnings = [];
    this.loading = false;
    this.expanded = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE) ?? "null");
      if (saved) { this.prs = saved.prs; this.spaceRepos = saved.spaceRepos; this.fetchedAt = saved.at; }
    } catch {}
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const spaceRepos = await resolveSpaceRepos(this.spaceRepos);
        const repos = [...new Set(Object.values(spaceRepos).filter(Boolean))];
        const { prs, failed, warnings } = await fetchPullRequests(repos);
        this.prs = [...prs, ...(this.prs ?? []).filter((pr) => failed.includes(pr.source))];
        this.spaceRepos = spaceRepos;
        this.warnings = warnings;
        this.error = "";
        this.fetchedAt = Date.now();
        try { localStorage.setItem(CACHE, JSON.stringify({ prs: this.prs, spaceRepos, at: this.fetchedAt })); } catch {}
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  toggle(id, cx) {
    this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id);
    cx.notify();
  }

  header(t, groups) {
    const shown = new Set(groups.flatMap((group) => group.prs.map((pr) => pr.id))).size;
    const withPrs = groups.filter((group) => group.prs.length).length;
    const macButtons = window()?.platform === "macos" && !window()?.fullscreen;
    const iconButton = (id, tip, child, action) => h_flex().id(id).size(28).flex_none().items_center().justify_center().rounded(6)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(child);
    return h_flex().h(46).flex_none().pl(macButtons ? 84 : 18).pr(12).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(svg(icon("git-pull-request")).size(15).flex_none().text_color(t.muted))
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Pull requests"))
      .when(this.prs !== null, (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(shown ? `${plural(shown, "open PR")} in ${plural(withPrs, "project")}` : "No open PRs")))
      .child(div().flex_1().min_w(0))
      .when(this.loading && this.prs !== null, (el) => el.child(h_flex().flex_none().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(svg(shared("spinner")).size(13).spin(900)).child("Updating…")))
      .when(Boolean(this.fetchedAt), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${this.loading ? "Showing data from" : "Updated"} ${ago(this.fetchedAt)}`)))
      .when(!this.loading, (el) => el.child(iconButton("refresh", "Refresh", svg(icon("refresh-cw")).size(14), (_e, cx) => this.refresh(cx))))
      .child(iconButton("close", "Close (Esc)", svg(shared("x")).size(15), () => closeOverlay(props().overlay)));
  }

  ci(t, ci) {
    const look = {
      passing: { path: shared("circle-check"), color: t.ansi2 },
      failing: { path: icon("circle-x"), color: t.ansi1 },
      pending: { path: shared("clock"), color: t.ansi3 },
      none: { path: shared("minus"), color: t.dim },
    }[ci.state];
    return h_flex().w(128).flex_none().gap(8).items_center()
      .child(svg(look.path).size(15).flex_none().text_color(look.color))
      .child(v_flex().min_w(0)
        .child(div().truncate().text_color(ci.state === "none" ? t.dim : t.foreground).child(ci.label))
        .when(Boolean(ci.detail), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(ci.detail))));
  }

  comments(t, { count, people }) {
    const some = count > 0;
    return h_flex().w(176).flex_none().gap(8).items_center()
      .child(svg(icon("message-square")).size(14).flex_none().text_color(some ? t.accent : t.dim))
      .child(v_flex().min_w(0)
        .child(div().truncate().text_color(some ? t.foreground : t.dim).child(some ? plural(count, "human comment") : "No human comments"))
        .when(some, (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(people.join(", ")))));
  }

  row(t, pr) {
    const open = this.expanded.has(pr.id);
    const meta = [`${pr.repo.split("/")[1]} #${pr.number}`, pr.author, pr.branch, `updated ${ago(pr.updatedAt)}`].join("  ·  ");
    return v_flex().flex_none().rounded(8).bg(t.background).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().id(`pr-${pr.id}`).min_h(56).px(14).py(9).gap(16).flex_wrap().items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip("Open on GitHub")
        .on_click(() => openOnGitHub(pr.url))
        .child(v_flex().flex_1().min_w(260).max_w_full().gap(2)
          .child(h_flex().gap(8).items_center().min_w(0)
            .child(div().min_w(0).truncate().font_medium().text_size(13.5).text_color(t.foreground).child(pr.title))
            .when(pr.draft, (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child("Draft"))))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(meta)))
        .child(this.ci(t, pr.ci))
        .child(this.comments(t, pr.comments))
        .child(svg(icon("external-link")).size(13).flex_none().text_color(t.dim)))
      .child(pr.body
        ? h_flex().id(`toggle-${pr.id}`).h(28).px(14).gap(6).items_center().border_t(1).border_color(t.border)
          .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.toggle(pr.id, cx))
          .child(svg(shared(open ? "chevron-down" : "chevron-right")).size(11))
          .child("Description")
        : h_flex().h(28).px(14).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.dim).child("No description"))
      .when(open && Boolean(pr.body), (el) => el.child(div().px(14).pb(12).pt(2).text_color(t.foreground).child(TextView.markdown(`body-${pr.id}`, pr.body))));
  }

  group(t, { project, repos, prs }) {
    const note = !repos.length ? "No GitHub repository in this project" : !prs.length ? "No open pull requests" : "";
    return v_flex().flex_none().gap(8)
      .child(h_flex().flex_none().gap(8).items_center().px(2)
        .child(div().size(9).flex_none().rounded(3).bg(project.color))
        .child(div().flex_none().font_semibold().text_size(14).text_color(t.foreground).child(project.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(repos.join(", ")))
        .when(prs.length > 0, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(String(prs.length)))))
      .when(Boolean(note), (el) => el.child(div().px(2).text_size(12.5).text_color(t.dim).child(note)))
      .children(prs.map((pr) => this.row(t, pr)));
  }

  message(t, title, body) {
    return v_flex().flex_1().items_center().justify_center().gap(6).p(24)
      .child(div().font_medium().text_color(t.foreground).child(title))
      .when(Boolean(body), (el) => el.child(div().max_w(560).text_color(t.muted).child(body)));
  }

  content(t, groups) {
    if (!groups.length) return this.message(t, "No Herdr projects yet", "Create a project in the sidebar and its pull requests will show here.");
    if (this.prs === null) {
      return this.error
        ? this.message(t, "Couldn't reach GitHub", `${this.error} Check that \`gh auth status\` works, then refresh.`)
        : v_flex().flex_1().items_center().justify_center().gap(10)
          .child(svg(shared("spinner")).size(20).text_color(t.muted).spin(900))
          .child(div().text_color(t.muted).child("Looking through your projects…"));
    }
    const notice = this.error ? `Couldn't refresh, so this may be out of date: ${this.error}` : this.warnings.length ? `Some repositories couldn't be read: ${this.warnings[0]}` : "";
    return v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().w_full().max_w(1080).mx_auto().px(20).py(18).gap(22)
        .when(Boolean(notice), (el) => el.child(div().flex_none().px(12).py(8).rounded(8).border_1().border_color(t.ansi3).text_size(12).text_color(t.foreground).child(notice)))
        .children(groups.map((group) => this.group(t, group))));
  }

  render() {
    const t = theme();
    const groups = projectGroups(projectStore(), spaces(), this.spaceRepos, this.prs ?? []);
    return v_flex().size_full().min_h(0).bg(t.canvas).text_size(13)
      .child(this.header(t, groups))
      .child(this.content(t, groups));
  }
}
