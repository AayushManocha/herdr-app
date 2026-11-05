// Projects sidebar: exploratory chats, then spaces grouped by project or by repo.
// A project groups spaces (each usually one worktree), so one project can span
// repos and one repo can serve several projects. The grouping is display state in
// shared("projects"): removing it closes nothing. Dialogs live in projects-dialog.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, exec, theme, shared, layout, setAgentOrder, nextCommand } from "herdr";

const KEY = "projects";
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const PR_ICON = "mods/pr-dashboard/git-pull-request.svg";
const CHATS_SHOWN = 3;

const load = () => ({ projects: [], assign: {}, chats: {}, repos: [], ...(shared(KEY) ?? {}) });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const ago = (at) => {
  const m = (Date.now() - at) / 60000;
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};

const HEIGHT = { newChat: 330, newProject: 175, addWorktree: 345 };
function dialog(mode, extra = {}) {
  openOverlay({ mod: "projects-dialog", kind: "dialog", width: 480, height: HEIGHT[mode] ?? 175, props: { mode, ...extra } });
}
function menu(mode, extra = {}) {
  openOverlay({ mod: "projects-dialog", kind: "popup", width: 220, height: 260, props: { mode, ...extra } });
}

const openPrDashboard = () => run("mod.open", { name: "pr-dashboard" });

// The status mark differs by shape as well as color.
function dot(t, status) {
  const box = () => h_flex().size(14).flex_none().items_center().justify_center();
  if (status === "working") return box().child(svg(ICON("spinner")).size(13).text_color(t.working).spin(900));
  if (status === "blocked") return box().rounded(7).bg(t.blocked).text_size(10).font_bold().text_color(t.background).child("!");
  if (status === "done") return box().rounded(7).bg(t.done).child(svg(ICON("check")).size(9).text_color(t.background));
  return box().child(div().size(7).rounded(4).border_1().border_color(t.dim));
}

export default class Projects extends View {
  init(_props, cx) {
    this.git = {}; // JSON [machine, place] -> { name } | null
    this.checked = {};
    this.closed = new Set(JSON.parse(localStorage.getItem("closed") ?? "[]"));
    this.lens = localStorage.getItem("lens") ?? "projects";
    this.allChats = false;
    cx.timer.every(2000, (cx) => this.refresh(cx));
    this.refresh(cx);
    // Bindable in keys.json: "projects.newChat", "projects.newProject".
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        const name = typeof c === "string" ? c : c?.name;
        if (name === "newChat" || name === "newProject") dialog(name);
      }
    });
  }

  // Which repo each space is in. Asked again only when a space moves, or once a minute.
  refresh(cx) {
    if (this.busy) return;
    const ps = panes();
    const now = Date.now();
    const keys = [...new Set(spaces().map((s) => JSON.stringify([s.machine ?? null, place(s, ps)])))]
      .filter((k) => JSON.parse(k)[1] && (!(k in this.git) || now - (this.checked[k] ?? 0) > 60000));
    if (!keys.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      for (const k of keys) {
        const [on, cwd] = JSON.parse(k);
        this.checked[k] = Date.now();
        try {
          const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
          if (r.code !== 0) { this.git[k] = null; continue; }
          const common = r.stdout.trim();
          const main = common.endsWith("/.git") ? common.slice(0, -5) : common.replace(/\.git$/, "");
          this.git[k] = { name: main.replace(/\/+$/, "").split("/").pop() };
        } catch { this.git[k] ??= null; }
      }
      this.busy = false;
      cx.notify();
    });
  }

  toggle(key, cx) {
    this.closed.has(key) ? this.closed.delete(key) : this.closed.add(key);
    localStorage.setItem("closed", JSON.stringify([...this.closed]));
    cx.notify();
  }

  setLens(lens, cx) {
    this.lens = lens;
    localStorage.setItem("lens", lens);
    cx.notify();
  }

  repoName(s, ps) {
    return this.git[JSON.stringify([s.machine ?? null, place(s, ps)])]?.name ?? null;
  }

  chatRows(t, store, sp) {
    const all = sp.filter((s) => store.chats[s.id])
      .map((s) => ({ s, chat: store.chats[s.id] }))
      .sort((a, b) => b.chat.at - a.chat.at);
    const shown = this.allChats ? all : all.filter(({ s }, i) => i < CHATS_SHOWN || s.active);
    const rows = shown.map(({ s, chat }) => h_flex().id(`chat-${s.id}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7)
      .when(s.active, (el) => el.bg(t.selected))
      .when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => menu("chatMenu", { space: s.id }))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(chat.title))
      .when(s.status === "blocked" || s.status === "working" || s.status === "done", (el) => el.child(dot(t, s.status)))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(ago(chat.at))));
    if (all.length > CHATS_SHOWN) {
      rows.push(div().id("chats-more").h(26).flex_none().px(8).flex().items_center().rounded(7).text_size(12).text_color(t.muted)
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { this.allChats = !this.allChats; cx.notify(); })
        .child(this.allChats ? "Show fewer" : `See all ${all.length}`));
    }
    if (!rows.length) rows.push(div().px(8).py(4).text_size(12).text_color(t.dim).child("Ask something without starting a project."));
    return rows;
  }

  spaceRow(t, s, g, byProject, store, ps) {
    const repo = this.repoName(s, ps);
    const project = store.projects.find((p) => p.id === store.assign[s.id]);
    const line1 = byProject ? (repo ?? s.name) : (s.branch ?? s.name);
    const line2 = byProject ? (s.branch ?? (repo ? "detached" : "Not a repo")) : (project?.name ?? "Unfiled");
    const tabs = (s.tabs ?? []).filter((c) => !c.settled);
    return v_flex().flex_none()
      .child(h_flex().id(`space-${g}-${s.id}`).h(42).flex_none().pl(14).pr(8).gap(9).items_center().rounded(7)
        .when(s.active, (el) => el.bg(t.selected))
        .when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click(() => run("space.select", { id: s.id }))
        .on_mouse_down("right", () => menu("spaceMenu", { space: s.id }))
        .child(dot(t, s.status))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(line1))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(line2)))
        .when(!byProject && Boolean(project), (el) => el.child(div().size(9).flex_none().rounded(3).bg(project.color))))
      .when(s.active && tabs.length > 1, (el) => el.child(v_flex().pl(37).py(2).children(tabs.map((c) =>
        h_flex().id(`tab-${c.id}`).h(24).flex_none().px(6).gap(7).items_center().rounded(5).text_size(12.5)
          .text_color(c.active ? t.foreground : t.muted).hover((st) => st.bg(t.hover))
          .on_click(() => run("tab.select", { id: c.id }))
          .child(div().flex_1().min_w(0).truncate().child(c.named ? c.name : `Tab ${c.name}`))
          .when(c.status === "blocked", (e2) => e2.child(dot(t, c.status)))))));
  }

  group(t, key, name, color, list, byProject, store, ps, project) {
    const waiting = list.filter((s) => s.status === "blocked").length;
    const open = !this.closed.has(key);
    return v_flex().flex_none().gap(1)
      .child(h_flex().id(`group-${key}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => this.toggle(key, cx))
        .when(Boolean(project), (el) => el.on_mouse_down("right", () => menu("projectMenu", { project: project.id })))
        .when(Boolean(color), (el) => el.child(div().size(9).flex_none().rounded(3).bg(color)))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(name))
        .when(waiting > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.blocked).child(`${waiting} waiting`)))
        .when(Boolean(project), (el) => el.child(h_flex().id(`add-${key}`).size(20).flex_none().items_center().justify_center().rounded(5).text_color(t.dim)
          .hover((st) => st.bg(t.raised).text_color(t.foreground))
          .tooltip("Add worktree")
          .on_click((_e, cx) => { cx.stop_propagation(); dialog("addWorktree", { project: project.id }); })
          .child(svg(ICON("plus")).size(12))))
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim)))
      .when(open, (el) => el.children(list.length
        ? list.map((s) => this.spaceRow(t, s, key, byProject, store, ps))
        : [div().pl(14).py(4).text_size(12).text_color(t.dim).child("No worktrees yet")]));
  }

  groups(t, store, work, ps) {
    if (this.lens === "repos") {
      const names = [...new Set(work.map((s) => this.repoName(s, ps) ?? "Other"))].sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b));
      return names.map((n) => this.group(t, `repo:${n}`, n, null, work.filter((s) => (this.repoName(s, ps) ?? "Other") === n), false, store, ps));
    }
    const known = new Set(store.projects.map((p) => p.id));
    const out = store.projects.map((p) => this.group(t, p.id, p.name, p.color, work.filter((s) => store.assign[s.id] === p.id), true, store, ps, p));
    const loose = work.filter((s) => !known.has(store.assign[s.id]));
    if (loose.length) out.push(this.group(t, "unfiled", "Unfiled", null, loose, true, store, ps));
    return out;
  }

  rail(t, sp) {
    return v_flex().size_full().min_h(0).bg(t.chrome).items_center().gap(2).py(6).overflow_y_scrollbar()
      .child(h_flex().id("rail-pr-dashboard").h(26).w_full().flex_none().items_center().justify_center().text_color(t.muted)
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("PR Dashboard")
        .on_click(openPrDashboard)
        .child(svg(PR_ICON).size(14)))
      .children(sp.map((s, i) => h_flex().id(`rail-${s.id}`).h(26).w_full().flex_none().gap(4).items_center().justify_center()
        .when(s.active, (el) => el.bg(t.raised)).hover((st) => st.bg(t.hover))
        .on_click(() => run("space.select", { id: s.id }))
        .child(div().text_size(12).text_color(s.active ? t.foreground : t.muted).child(String(i + 1)))
        .child(dot(t, s.status))));
  }

  render() {
    const t = theme();
    const store = load();
    const sp = spaces();
    const ps = panes();
    if (narrow()) return this.rail(t, sp);
    const work = sp.filter((s) => !store.chats[s.id]);

    // agent.next and agent.prev follow the order shown: chats, then the tree.
    const rank = new Map();
    sp.filter((s) => store.chats[s.id]).concat(work).forEach((s, i) => (s.tabs ?? []).forEach((c) => rank.set(c.id, i)));
    setAgentOrder(agents().slice().sort((a, b) => (rank.get(a.tab) ?? 1e9) - (rank.get(b.tab) ?? 1e9)).map((a) => a.address));

    const seg = (id, text, on, lens) => div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(11.5)
      .bg(on ? t.raised : "#00000000").text_color(on ? t.foreground : t.muted)
      .on_click((_e, cx) => this.setLens(lens, cx)).child(text);

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().flex_none().px(10).pb(8).gap(6)
        .child(h_flex().id("new-chat").flex_1().h(32).gap(7).items_center().justify_center().rounded(8).border_1().border_color(t.input)
          .font_medium().text_color(t.foreground).hover((st) => st.bg(t.hover))
          .on_click(() => dialog("newChat"))
          .child(svg(ICON("plus")).size(13)).child("New chat")))
      .child(h_flex().id("pr-dashboard").h(30).flex_none().mx(10).mb(8).px(8).gap(8).items_center().rounded(7).text_color(t.muted)
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click(openPrDashboard)
        .child(svg(PR_ICON).size(14)).child("PR Dashboard"))
      .child(v_flex().flex_1().min_h(0).px(8).pb(12).gap(10).overflow_y_scrollbar()
        .child(v_flex().flex_none().gap(1)
          .child(div().px(8).py(4).text_size(11.5).font_medium().text_color(t.muted).child("Chats"))
          .children(this.chatRows(t, store, sp)))
        .child(div().h(1).flex_none().mx(4).bg(t.border))
        .child(h_flex().flex_none().pl(8).pr(4).gap(6).items_center()
          .child(h_flex().flex_none().gap(2).p(2).rounded(7).bg(t.surface)
            .child(seg("lens-projects", "Projects", this.lens !== "repos", "projects"))
            .child(seg("lens-repos", "Repos", this.lens === "repos", "repos")))
          .child(div().flex_1())
          .child(h_flex().id("new-project").size(24).flex_none().items_center().justify_center().rounded(6).text_color(t.muted)
            .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("New project")
            .on_click(() => dialog("newProject"))
            .child(svg(ICON("plus")).size(13))))
        .children(this.groups(t, store, work, ps)));
  }
}
