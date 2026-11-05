// The projects sidebar's forms and right-click menus, chosen by props().mode:
// newProject, renameProject, renameChat, newChat, addWorktree, promote,
// spaceMenu, projectMenu, chatMenu.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, shared, setShared, spaces, panes, exec, hc, home, knownAgents, pickFolder, notify } from "herdr";

const KEY = "projects";
const COLORS = ["#5b8def", "#d9649a", "#3fae6a", "#e3814f", "#8b7cf6", "#22a99a"];
const TRANSCRIPT_LIMIT = 8000;

// Chats promise read-only, so only agents with a read-only switch are offered.
const READ_ONLY = { claude: ["--permission-mode", "plan"], codex: ["--sandbox", "read-only"] };

const load = () => ({ projects: [], assign: {}, chats: {}, repos: [], ...(shared(KEY) ?? {}) });
const save = (change) => setShared(KEY, change(load()));
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

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

    const store = load();
    const start = {
      renameProject: store.projects.find((x) => x.id === p.project)?.name,
      renameChat: store.chats[p.space]?.title,
    }[this.mode] ?? "";
    if (["newProject", "renameProject", "renameChat", "newChat", "addWorktree", "promote"].includes(this.mode)) {
      this.input = InputState.new({ value: start, placeholder: this.placeholder() });
      this.input.on("submit", (_e, cx) => this.submit(cx));
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    if (this.mode === "promote") {
      this.newName = InputState.new({ placeholder: "New project name" });
      this.creating = !store.projects.length;
    }
    if (["newChat", "addWorktree", "promote"].includes(this.mode)) this.loadRepos(cx);
    if (["newChat"].includes(this.mode)) this.loadAgents(cx);
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

  // Repos worth offering: ones open in a space, and ones chosen before.
  loadRepos(cx) {
    cx.spawn(async (cx) => {
      const found = new Map();
      const add = async (folder) => {
        if (!folder) return;
        try { const r = await repoOf(folder); if (r) found.set(r.main, r); } catch {}
      };
      const ps = panes();
      for (const s of spaces()) if (!s.machine) await add(place(s, ps));
      for (const main of load().repos) await add(main);
      this.repos = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
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
      save((s) => ({ ...s, repos: [...new Set([...s.repos, repo.main])] }));
      this.repos = [...this.repos.filter((r) => r.main !== repo.main), repo].sort((a, b) => a.name.localeCompare(b.name));
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
        save((s) => ({ ...s, assign: { ...s.assign, [made.space]: project }, repos: [...new Set([...s.repos, repo.main])] }));
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
    save((s) => ({ ...s, assign: { ...s.assign, [made.space]: projectId }, repos: [...new Set([...s.repos, repo.main])] }));
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
      .children(items.map(([text, action, muted], i) => h_flex().id(`item-${i}`).h(28).flex_none().px(9).items_center().rounded(6)
        .text_color(muted ? t.muted : t.foreground).hover((s) => s.bg(t.hover))
        .on_click(() => { this.close(); action(); }).child(text)));
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
          this.repoChips(t, false),
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
