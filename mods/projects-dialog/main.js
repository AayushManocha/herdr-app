// The projects sidebar's forms and right-click menus, chosen by props().mode:
// newProject, renameProject, renameChat, newChat, addWorktree, promote,
// spaceMenu, projectMenu, projectAdd, chatMenu.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Select, Popup } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, shared, setShared, spaces, panes, exec, hc, home, knownAgents, pickFolder, notify } from "herdr";

const KEY = "projects";
const COLORS = ["#5b8def", "#d9649a", "#3fae6a", "#e3814f", "#8b7cf6", "#22a99a"];
const TRANSCRIPT_LIMIT = 8000;
const REPO_LIST_WIDTH = 442; // The trigger's width, measured; a popup can't take it by itself.

// Chats promise read-only, so only agents with a read-only switch are offered.
const READ_ONLY = { claude: ["--permission-mode", "plan"], codex: ["--sandbox", "read-only"] };

const load = () => ({ projects: [], assign: {}, chats: {}, repos: [], ...(shared(KEY) ?? {}) });
const save = (change) => setShared(KEY, change(load()));
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
// The repo list is kept most recently used first.
const usedRepo = (s, main) => ({ ...s, repos: [main, ...s.repos.filter((m) => m !== main)] });

function addProject(name) {
  const id = newId("pj");
  save((s) => ({ ...s, projects: [...s.projects, { id, name, color: COLORS[s.projects.length % COLORS.length] }] }));
  return id;
}

function place(s, all) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// "herdr-app do" reports the ids it made, which run() doesn't.
async function act(name, args) {
  const r = await exec("herdr-app", ["do", name, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch {}
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr || `${name} failed.`);
  return out;
}

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

async function repoOf(folder) {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out.replace(/\.git$/, "");
  return { main, name: main.replace(/\/+$/, "").split("/").pop() };
}

// The same place the shipped worktree mod uses, so its Remove worktree still works.
async function addWorktree(repo, branch) {
  const path = `${home()}/.herdr/worktrees/${repo.name}/${slug(branch)}`;
  const exists = (await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  const r = await git(repo.main, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (!r.ok) throw new Error(r.err.split("\n").pop().replace(/^fatal: /, "") || "git worktree add failed.");
  return path;
}

export default class ProjectsDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.mode;
    this.error = "";
    this.busy = false;
    this.picked = new Set();
    this.repos = [];
    this.agents = [];
    this.agent = null;
    this.project = p.project ?? load().projects[0]?.id ?? null;
    this.handle = cx.focus_handle();
    this.repoOpen = false;
    this.repoAt = 0;
    this.repoTrigger = cx.focus_handle();
    this.repoList = cx.focus_handle();

    const store = load();
    const start = {
      renameProject: store.projects.find((x) => x.id === p.project)?.name,
      renameChat: store.chats[p.space]?.title,
    }[this.mode] ?? "";
    if (["newProject", "renameProject", "renameChat", "newChat", "addWorktree", "promote"].includes(this.mode)) {
      this.input = InputState.new({ value: start, placeholder: this.placeholder() });
      this.input.on("submit", (_e, cx) => this.submit(cx));
      this.input.focus();
      cx.timer.after(600, () => { if (!this.repoOpen) this.input.focus(); });
    }
    if (this.mode === "promote") {
      this.newName = InputState.new({ placeholder: "New project name" });
      this.creating = !store.projects.length;
    }
    if (["newChat", "addWorktree", "promote"].includes(this.mode)) this.loadRepos(cx);
    if (["newChat"].includes(this.mode)) this.loadAgents(cx);
    if (this.mode === "spaceMenu") this.loadLinked(cx);
  }

  // Whether the space sits in a linked worktree: only those have their own git dir
  // apart from the common one, so a repo's main checkout and a submodule don't count.
  loadLinked(cx) {
    const space = spaces().find((s) => s.id === props().space);
    const folder = space && place(space, panes());
    if (!folder) return;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: folder, on: space.machine });
        const [dir, common] = r.stdout.trim().split("\n");
        this.linked = r.code === 0 && dir !== common;
      } catch { this.linked = false; }
      cx.notify();
    });
  }

  placeholder() {
    return {
      newProject: "Project name",
      renameProject: "Project name",
      renameChat: "Chat title",
      newChat: "What do you want to explore?",
      addWorktree: "Branch, like feat/priority-lanes",
      promote: "New branch, like feat/priority-lanes",
    }[this.mode];
  }

  // Repos worth offering, most recent first: ones chosen before, then ones open in a space.
  loadRepos(cx) {
    cx.spawn(async (cx) => {
      const found = new Map();
      const add = async (folder) => {
        if (!folder) return;
        try { const r = await repoOf(folder); if (r) found.set(r.main, r); } catch {}
      };
      for (const main of load().repos) await add(main);
      const ps = panes();
      for (const s of spaces()) if (!s.machine) await add(place(s, ps));
      this.repos = [...found.values()];
      if (this.mode === "promote") {
        const from = load().chats[props().space]?.context;
        const own = from && this.repos.find((r) => r.main === from);
        if (own) this.picked.add(own.main);
      }
      cx.notify();
    });
  }

  loadAgents(cx) {
    cx.spawn(async (cx) => {
      try {
        const all = await knownAgents();
        this.agents = all.filter((a) => a.installed && READ_ONLY[a.run?.[0]]);
        this.agent = this.agents[0] ?? null;
      } catch (e) { this.error = String(e.message ?? e); }
      if (!this.agents.length && !this.error) this.error = "Chats need Claude Code or Codex, because they run read-only.";
      cx.notify();
    });
  }

  chooseFolder(cx, single) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Use repo" });
      if (!folder) return;
      const repo = await repoOf(folder);
      if (!repo) {
        if (this.mode === "newChat") { // A chat can read any folder.
          const entry = { main: folder, name: folder.replace(/\/+$/, "").split("/").pop() };
          this.repos = [...this.repos.filter((r) => r.main !== folder), entry];
          this.picked = new Set([folder]);
        } else this.error = "That folder isn't a git repo.";
        cx.notify();
        return;
      }
      save((s) => usedRepo(s, repo.main));
      this.repos = [repo, ...this.repos.filter((r) => r.main !== repo.main)];
      if (single) this.picked = new Set([repo.main]);
      else this.picked.add(repo.main);
      this.error = "";
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  submit(cx) {
    if (this.busy) return;
    const text = this.input.value().trim();
    const p = props();
    if (this.mode === "newProject" || this.mode === "renameProject") {
      if (!text) return;
      if (this.mode === "newProject") addProject(text);
      else save((s) => ({ ...s, projects: s.projects.map((x) => (x.id === p.project ? { ...x, name: text } : x)) }));
      return this.close();
    }
    if (this.mode === "renameChat") {
      if (!text) return;
      save((s) => ({ ...s, chats: { ...s.chats, [p.space]: { ...s.chats[p.space], title: text } } }));
      run("space.rename", { id: p.space, name: text });
      return this.close();
    }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.mode === "newChat") await this.startChat(text);
        else if (this.mode === "addWorktree") await this.createWorktrees(text);
        else await this.promote(text);
        this.close();
      } catch (e) {
        this.error = String(e.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  async startChat(question) {
    if (!this.agent) throw new Error("Choose an agent first.");
    const base = this.agent.run;
    let folder = [...this.picked][0] ?? null;
    if (!folder) {
      // One folder for every chat: agents ask to trust a new folder, so this asks once.
      folder = `${home()}/.herdr/chats`;
      const made = await exec("mkdir", ["-p", folder]);
      if (made.code !== 0) throw new Error(made.stderr || "Couldn't make the chat's folder.");
    }
    const title = question ? question.slice(0, 48) : "New chat";
    const args = { name: title, folder, tab: "chat", argv: [...base, ...READ_ONLY[base[0]]], machine: "" };
    if (question) args.task = question;
    const made = await act("space.new", args);
    save((s) => ({ ...s, chats: { ...s.chats, [made.space]: { title, at: Date.now(), base, context: [...this.picked][0] ?? null } } }));
    run("space.select", { id: made.space });
  }

  async createWorktrees(branch) {
    if (!branch) throw new Error("Name a branch.");
    const chosen = this.repos.filter((r) => this.picked.has(r.main));
    if (!chosen.length) throw new Error("Choose at least one repo.");
    const project = props().project;
    const failed = [];
    let last = null;
    for (const repo of chosen) {
      try {
        const folder = await addWorktree(repo, branch);
        const made = await act("space.new", { folder, machine: "" });
        save((s) => usedRepo({ ...s, assign: { ...s.assign, [made.space]: project } }, repo.main));
        last = made.space;
      } catch (e) { failed.push(`${repo.name}: ${e.message ?? e}`); }
    }
    if (last) run("space.select", { id: last });
    if (failed.length) {
      // Worktrees that were made stay; retrying with the others is safe.
      this.picked = new Set(chosen.filter((r) => failed.some((f) => f.startsWith(`${r.name}:`))).map((r) => r.main));
      throw new Error(failed.join("\n"));
    }
  }

  // A plain shell in its own space, filed under the project. The menu stays open until
  // the space is assigned: closing it would cancel this task and leave the space unfiled.
  newTerminal(project, cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async () => {
      try {
        const made = await act("space.new", { name: "Terminal", folder: home(), machine: "" });
        save((s) => ({ ...s, assign: { ...s.assign, [made.space]: project } }));
        run("space.select", { id: made.space });
      } catch (e) {
        notify({ title: "Couldn't open a terminal", body: String(e?.message ?? e), level: "error" });
      }
      this.close();
    });
  }

  // A new worktree, its agent told what the chat found. The chat stays until closed:
  // agents keep a conversation per folder, so it can't move there itself.
  async promote(branch) {
    const p = props();
    if (!branch) throw new Error("Name a branch.");
    const repo = this.repos.find((r) => this.picked.has(r.main));
    if (!repo) throw new Error("Choose a repo.");
    let project = this.project;
    if (this.creating) {
      const name = this.newName.value().trim();
      if (!name) throw new Error("Name the new project.");
      project = name;
    } else if (!project) throw new Error("Choose a project.");

    const chat = load().chats[p.space];
    const space = spaces().find((s) => s.id === p.space);
    const tabs = new Set((space?.tabs ?? []).map((c) => c.id));
    const terminal = panes().find((x) => tabs.has(x.tab) && x.terminal)?.terminal;
    let transcript = "";
    if (terminal) {
      const r = await hc(["read", terminal, "--lines", "400"]);
      if (r.code === 0) transcript = r.stdout.slice(-TRANSCRIPT_LIMIT);
    }

    const folder = await addWorktree(repo, branch);
    const task = transcript
      ? `Continue this work from an exploratory chat. You may now edit files in this worktree. Here is the end of the chat:\n\n${transcript}`
      : `Continue the exploratory chat titled "${chat?.title ?? ""}". You may now edit files in this worktree.`;
    const made = await act("space.new", { folder, tab: chat?.title ?? "session", argv: chat?.base ?? ["claude"], task, machine: "" });
    const projectId = this.creating ? addProject(project) : project;
    save((s) => usedRepo({ ...s, assign: { ...s.assign, [made.space]: projectId } }, repo.main));
    run("space.select", { id: made.space });
    notify({ title: "Worktree created", body: `The chat "${chat?.title ?? ""}" is still open. Close it when you're done with it.`, level: "info" });
  }

  // ---- Drawing ----

  button(t, id, text, primary, action) {
    return h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .when(this.busy && primary, (el) => el.opacity(0.6))
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
  }

  chip(t, id, text, on, action) {
    return h_flex().id(id).h(28).px(10).items_center().rounded(14).border_1().text_size(12.5).cursor_pointer()
      .border_color(on ? t.accent : t.input).bg(on ? t.selected : t.background)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(action).child(text);
  }

  label(t, text) {
    return div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
  }

  field(t, state) {
    return Input.new(state).h(36).px(10).rounded(9).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
  }

  repoChips(t, single) {
    const chips = this.repos.map((r) => this.chip(t, `repo-${r.main}`, r.name, this.picked.has(r.main), (_e, cx) => {
      if (this.picked.has(r.main)) this.picked.delete(r.main);
      else { if (single) this.picked.clear(); this.picked.add(r.main); }
      cx.notify();
    }));
    chips.push(this.chip(t, "repo-pick", this.mode === "newChat" ? "Choose a folder…" : "Choose a repo…", false, (_e, cx) => this.chooseFolder(cx, single)));
    return h_flex().flex_wrap().gap(6).children(chips);
  }

  setRepoOpen(open, cx) {
    this.repoOpen = open;
    if (open) { this.repoAt = 0; this.repoList.focus(); }
    cx.notify();
  }

  // The row at this index: a repo, or past the last repo, the folder chooser.
  activateRepoRow(i, cx) {
    const r = this.repos[i];
    if (!r) {
      this.setRepoOpen(false, cx);
      this.chooseFolder(cx, false);
      return;
    }
    if (this.picked.has(r.main)) this.picked.delete(r.main);
    else this.picked.add(r.main);
    this.repoAt = i;
    cx.notify();
  }

  repoKey(e, cx) {
    const rows = this.repos.length + 1;
    if (e.key === "down") this.repoAt = (this.repoAt + 1) % rows;
    else if (e.key === "up") this.repoAt = (this.repoAt + rows - 1) % rows;
    else if (e.key === "space") return this.activateRepoRow(this.repoAt, cx);
    else return;
    cx.notify();
  }

  // Select holds only the keyboard and the open state; the pointer is ours. A press on
  // the trigger also counts as outside the list, so that case is left to the trigger.
  repoSelect(t) {
    const names = this.repos.filter((r) => this.picked.has(r.main)).map((r) => r.name);
    const trigger = h_flex().id("repo-trigger").h(36).px(10).gap(8).items_center().rounded(9).border_1()
      .border_color(this.repoOpen ? t.accent : t.input).bg(t.background).text_size(12.8).cursor_pointer()
      .on_hover((over) => { this.overRepoTrigger = over; })
      .on_click((_e, cx) => this.setRepoOpen(!this.repoOpen, cx))
      .child(div().flex_1().min_w(0).truncate().text_color(names.length ? t.foreground : t.muted).child(names.join(", ") || "Select repos…"))
      .child(div().flex_none().text_color(t.dim).child(this.repoOpen ? "▴" : "▾"));

    const row = (key, i, content, on) => h_flex().id(key).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(i === this.repoAt, (el) => el.bg(t.hover).aria_active_descendant())
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.activateRepoRow(i, cx))
      .role("list_box_option").aria_selected(on)
      .children(content);
    const rows = this.repos.map((r, i) => {
      const on = this.picked.has(r.main);
      return row(`repo-${r.main}`, i, [
        div().flex_none().w(14).text_color(t.accent).child(on ? "✓" : ""),
        div().flex_none().text_color(t.foreground).child(r.name),
        div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.main.replace(home(), "~")),
      ], on);
    });

    const list = v_flex().id("repo-list").track_focus(this.repoList).w(REPO_LIST_WIDTH).mt(4).p(4).rounded(9).border_1()
      .border_color(t.input).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => this.repoKey(e, cx))
      .on_mouse_down_out((_e, cx) => { if (!this.overRepoTrigger) this.setRepoOpen(false, cx); })
      .child(v_flex().id("repo-options").max_h(180).overflow_y_scrollbar().children(rows)
        .when(!rows.length, (el) => el.child(div().p(8).text_color(t.dim).child("No recent repos yet."))))
      .child(div().my(4).h(1).bg(t.border))
      .child(row("repo-pick", this.repos.length, [
        div().flex_none().w(14).text_color(t.dim).child("+"),
        div().flex_1().text_color(t.muted).child("Choose a repo…"),
      ], false));

    return Select.new("repo-select").accessibility_label("Repos")
      .open(this.repoOpen)
      .track_focus(this.repoTrigger)
      .content_focus_handle(this.repoList)
      .on_open_change((open, cx) => this.setRepoOpen(open, cx))
      .on_confirm((_e, cx) => this.activateRepoRow(this.repoAt, cx))
      .child(Popup.new("repo-popup", trigger).anchor("top_left").when(this.repoOpen, (el) => el.content(list)));
  }

  form(t, title, submitLabel, body) {
    return v_flex().id("projects-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .children(body)
      .when(Boolean(this.error), (el) => el.child(div().pt(12).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(18).gap(8).justify_end()
        .child(this.button(t, "cancel", "Cancel", false, () => this.close()))
        .child(this.button(t, "save", this.busy ? "Working…" : submitLabel, true, (_e, cx) => this.submit(cx))));
  }

  menu(t, items) {
    return v_flex().id("projects-menu").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full().p(5).bg(t.popover).text_size(13).text_color(t.foreground)
      .children(items.map(([text, action, muted, closesItself], i) => h_flex().id(`item-${i}`).h(28).flex_none().px(9).items_center().rounded(6)
        .text_color(muted ? t.muted : t.foreground).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (!closesItself) this.close(); action(cx); }).child(text)));
  }

  open(mode, extra) {
    const height = { newProject: 175, renameProject: 175, renameChat: 175, addWorktree: 345, promote: 470 }[mode];
    openOverlay({ mod: "projects-dialog", kind: "dialog", width: 480, height, props: { mode, ...extra } });
  }

  spaceMenu(t) {
    const id = props().space;
    const store = load();
    const assign = (project) => save((s) => ({ ...s, assign: { ...s.assign, [id]: project } }));
    const items = store.projects.filter((p) => p.id !== store.assign[id]).map((p) => [`Move to ${p.name}`, () => assign(p.id)]);
    if (store.assign[id]) items.push(["Remove from project", () => save((s) => {
      const next = { ...s.assign };
      delete next[id];
      return { ...s, assign: next };
    })]);
    items.push(["New project…", () => this.open("newProject")]);
    items.push(["Space options…", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id } } }), true]);
    // Last, so it appearing once git answers moves nothing under the pointer. The
    // shipped dialog confirms it and warns about uncommitted or unpushed work.
    if (this.linked) items.push(["Remove worktree…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: id, action: "remove" } })]);
    return this.menu(t, items);
  }

  projectMenu(t) {
    const id = props().project;
    return this.menu(t, [
      ["Add worktree…", () => this.open("addWorktree", { project: id })],
      ["Rename…", () => this.open("renameProject", { project: id })],
      // Only the grouping goes: its spaces fall back to Unfiled, still running.
      ["Remove project", () => save((s) => ({
        ...s,
        projects: s.projects.filter((p) => p.id !== id),
        assign: Object.fromEntries(Object.entries(s.assign).filter(([, v]) => v !== id)),
      }))],
    ]);
  }

  projectAdd(t) {
    const id = props().project;
    return this.menu(t, [
      ["New worktree…", () => this.open("addWorktree", { project: id })],
      ["New terminal", (cx) => this.newTerminal(id, cx), false, true],
    ]);
  }

  chatMenu(t) {
    const id = props().space;
    return this.menu(t, [
      ["Turn into project work…", () => this.open("promote", { space: id })],
      ["Rename…", () => this.open("renameChat", { space: id })],
      ["Close chat", () => run("space.close", { id })],
    ]);
  }

  render() {
    const t = theme();
    switch (this.mode) {
      case "spaceMenu": return this.spaceMenu(t);
      case "projectMenu": return this.projectMenu(t);
      case "projectAdd": return this.projectAdd(t);
      case "chatMenu": return this.chatMenu(t);
      case "newProject":
        return this.form(t, "New project", "Create", [this.label(t, "Name"), this.field(t, this.input)]);
      case "renameProject":
        return this.form(t, "Rename project", "Save", [this.label(t, "Name"), this.field(t, this.input)]);
      case "renameChat":
        return this.form(t, "Rename chat", "Save", [this.label(t, "Title"), this.field(t, this.input)]);
      case "newChat":
        return this.form(t, "New chat", "Start chat", [
          this.label(t, "Question (optional)"),
          this.field(t, this.input),
          this.label(t, "Agent"),
          h_flex().flex_wrap().gap(6).children(this.agents.map((a) => this.chip(t, `agent-${a.run[0]}`, a.name, this.agent === a, (_e, cx) => { this.agent = a; cx.notify(); }))),
          this.label(t, "Optional context"),
          this.repoChips(t, true),
          div().pt(12).text_size(12).text_color(t.dim).child(this.picked.size
            ? "Runs read-only in that folder. No worktree is created."
            : "Runs read-only in a scratch folder. No worktree is created."),
        ]);
      case "addWorktree": {
        const name = load().projects.find((p) => p.id === props().project)?.name ?? "project";
        return this.form(t, `Add worktree to ${name}`, "Create", [
          this.label(t, "Repos"),
          this.repoSelect(t),
          this.label(t, "Branch"),
          this.field(t, this.input),
          div().pt(8).text_size(12).text_color(t.dim).child("Each repo gets its own worktree on this branch."),
        ]);
      }
      case "promote": {
        const projects = load().projects;
        return this.form(t, "Turn this chat into project work", "Create worktree", [
          this.label(t, "Project"),
          h_flex().flex_wrap().gap(6).children([
            ...projects.map((p) => this.chip(t, `project-${p.id}`, p.name, !this.creating && this.project === p.id, (_e, cx) => { this.creating = false; this.project = p.id; cx.notify(); })),
            this.chip(t, "project-new", "New project", this.creating, (_e, cx) => { this.creating = true; cx.notify(); }),
          ]),
          ...(this.creating ? [div().pt(8).child(this.field(t, this.newName))] : []),
          this.label(t, "Repo"),
          this.repoChips(t, true),
          this.label(t, "New branch"),
          this.field(t, this.input),
          div().pt(8).text_size(12).text_color(t.dim).child("A new agent starts in the worktree with the end of this chat, and can edit files there. The chat stays open until you close it."),
        ]);
      }
      default:
        return div().p(12).text_color(t.blocked).child(`Unknown dialog: ${this.mode}`);
    }
  }
}
