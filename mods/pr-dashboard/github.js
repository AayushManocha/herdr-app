// Finds the GitHub repositories behind the Herdr projects' spaces and asks GitHub, through the
// person's own `gh` login, for those repositories' open PRs. Nothing else is queried.

import { exec, panes, shared, spaces } from "herdr";
import { githubRepo, summarize } from "./summary.js";

const BATCH = 25; // exec gives a query 30 s; details cost far more than the id listing.
const WHO = "author { __typename login }";

const details = (ids) => `{ nodes(ids: ${JSON.stringify(ids)}) { ... on PullRequest {
  id number title url isDraft body updatedAt headRefName ${WHO} repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {
    totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
  comments(first: 100) { nodes { ${WHO} } }
  reviews(first: 100) { nodes { ${WHO} body } }
  reviewThreads(first: 100) { nodes { comments(first: 50) { nodes { ${WHO} } } } } } } }`;

export const projectStore = () => ({ projects: [], assign: {}, chats: {}, ...(shared("projects") ?? {}) });

// gh exits nonzero on a partial answer too (a repo the token can't see), so read the data first.
async function graphql(query, warnings) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
  let answer = null;
  try { answer = JSON.parse(r.stdout); } catch {}
  const message = answer?.errors?.[0]?.message;
  if (!answer?.data) throw new Error(message || r.stderr?.trim() || "GitHub didn't answer.");
  if (message) warnings.add(message);
  return answer.data;
}

// Where a space is now, as the projects sidebar has it, then where it was made.
function folders(space, allPanes) {
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  const live = allPanes.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd;
  return [...new Set([live, space.folder].filter(Boolean))];
}

// space id -> "owner/name", or null when it has no GitHub remote. A machine that can't be reached
// keeps its last answer: being offline says nothing about the repo.
export async function resolveSpaceRepos(previous) {
  const store = projectStore();
  const known = new Set(store.projects.map((project) => project.id));
  const allPanes = panes();
  const wanted = spaces().filter((space) => known.has(store.assign[space.id]) && !store.chats[space.id]);
  const answers = await Promise.all(wanted.map(async (space) => {
    let unreachable = false;
    for (const cwd of folders(space, allPanes)) {
      try {
        const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on: space.machine ?? null });
        const repo = r.code === 0 ? githubRepo(r.stdout) : null;
        if (repo) return [space.id, repo];
      } catch { unreachable = true; }
    }
    return [space.id, unreachable ? previous[space.id] ?? null : null];
  }));
  return Object.fromEntries(answers);
}

// Each PR's `source` is the name the space's remote uses: GitHub may answer with another spelling
// after a rename. A repo that failed is listed in `failed` so its last known PRs can stay.
export async function fetchPullRequests(repos) {
  const warnings = new Set();
  const failed = new Set();
  const sourceOf = new Map();
  for (let i = 0; i < repos.length; i += 50) {
    const part = repos.slice(i, i + 50);
    const data = await graphql(`{ ${part.map((repo, j) => {
      const [owner, name] = repo.split("/");
      return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequests(states: OPEN, first: 100) { nodes { id } } }`;
    }).join("\n")} }`, warnings);
    part.forEach((repo, j) => {
      if (!data[`r${j}`]) failed.add(repo);
      for (const pr of data[`r${j}`]?.pullRequests.nodes ?? []) sourceOf.set(pr.id, repo);
    });
  }

  const ids = [...sourceOf.keys()];
  const prs = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const data = await graphql(details(ids.slice(i, i + BATCH)), warnings);
    for (const pr of data.nodes) if (pr) prs.push({ ...summarize(pr), source: sourceOf.get(pr.id) });
  }
  return { prs, failed: [...failed], warnings: [...warnings] };
}
