// Turns one GitHub pull request into what the dashboard shows. No Herdr imports, so
// the rules for "human reviewer" and CI can be tested on their own.

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const UNFINISHED = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);

// A deleted account has no author; it was a person as far as anyone can tell.
const isBot = (author) => author?.__typename === "Bot" || /\[bot\]$/i.test(author?.login ?? "");

// Issue comments, inline review comments and review summaries. A bare approval says nothing,
// and the PR's author answering in their own thread isn't a reviewer.
export function humanComments(pr) {
  const written = [
    ...(pr.comments?.nodes ?? []),
    ...(pr.reviews?.nodes ?? []).filter((review) => review.body?.trim()),
    ...(pr.reviewThreads?.nodes ?? []).flatMap((thread) => thread.comments?.nodes ?? []),
  ].filter((comment) => !isBot(comment.author) && (!comment.author || comment.author.login !== pr.author?.login));
  return {
    count: written.length,
    people: [...new Set(written.map((comment) => comment.author?.login ?? "ghost"))],
  };
}

export function ciStatus(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return { state: "none", label: "No CI", detail: "" };
  const contexts = rollup.contexts ?? {};
  const total = contexts.totalCount ?? 0;
  const counts = [...(contexts.checkRunCountsByState ?? []), ...(contexts.statusContextCountsByState ?? [])];
  const sum = (states) => counts.reduce((n, c) => n + (states.has(c.state) ? c.count : 0), 0);
  if (rollup.state === "SUCCESS") return { state: "passing", label: "Passing", detail: `${total} ${total === 1 ? "check" : "checks"}` };
  if (rollup.state === "FAILURE" || rollup.state === "ERROR") return { state: "failing", label: "Failing", detail: `${sum(FAILED)} of ${total} failed` };
  return { state: "pending", label: "Running", detail: `${total - sum(UNFINISHED)} of ${total} done` };
}

// PR templates leave HTML comments behind, which would show as text.
export const cleanBody = (body) => (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();

export function summarize(pr) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    draft: pr.isDraft,
    repo: pr.repository.nameWithOwner,
    author: pr.author?.login ?? "ghost",
    branch: pr.headRefName,
    updatedAt: pr.updatedAt,
    body: cleanBody(pr.body),
    ci: ciStatus(pr),
    comments: humanComments(pr),
  };
}

// "owner/name" from a git remote URL, or null when it isn't on GitHub.
export function githubRepo(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec((url ?? "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// What one Herdr project shows now: its live spaces' repos and those repos' PRs. A repo can serve
// several projects, so its PRs show under each.
export function projectGroups(store, spaces, spaceRepos, prs) {
  return store.projects.map((project) => {
    const repos = [...new Set(spaces
      .filter((space) => store.assign[space.id] === project.id && !store.chats[space.id])
      .map((space) => spaceRepos[space.id])
      .filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const inProject = new Set(repos);
    return {
      project,
      repos,
      prs: prs.filter((pr) => inProject.has(pr.source)).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    };
  });
}
