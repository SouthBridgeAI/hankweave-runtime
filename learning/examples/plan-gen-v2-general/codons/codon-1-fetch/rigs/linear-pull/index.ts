import { LinearClient } from "@linear/sdk";
import { stringify } from "yaml";

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error("Error: LINEAR_API_KEY environment variable not set");
  process.exit(1);
}

const issueId = process.argv[2];
if (!issueId) {
  console.error("Usage: bun run index.ts <issue-id>");
  console.error("Example: bun run index.ts ABC-123");
  process.exit(1);
}

const client = new LinearClient({ apiKey });

async function main() {
  try {
    const issue = await client.issue(issueId);

    // Fetch related data
    const [state, assignee, creator, team, project, labels, comments, parent, children] =
      await Promise.all([
        issue.state,
        issue.assignee,
        issue.creator,
        issue.team,
        issue.project,
        issue.labels(),
        issue.comments(),
        issue.parent,
        issue.children(),
      ]);

    const output = {
      id: issue.identifier,
      title: issue.title,
      url: issue.url,
      status: state?.name,
      priority: issue.priority,
      estimate: issue.estimate,
      dueDate: issue.dueDate,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,

      team: team?.name,
      project: project?.name,
      assignee: assignee ? { name: assignee.name, email: assignee.email } : null,
      creator: creator ? { name: creator.name, email: creator.email } : null,

      labels: labels.nodes.map((l) => l.name),

      description: issue.description || null,

      parent: parent ? { id: parent.identifier, title: parent.title } : null,
      children: children.nodes.map((c) => ({ id: c.identifier, title: c.title })),

      comments: comments.nodes.map((c) => ({
        author: c.user?.then ? "[pending]" : (c as any).user?.name || "Unknown",
        createdAt: c.createdAt,
        body: c.body,
      })),
    };

    // Resolve comment authors (they're promises)
    for (let i = 0; i < comments.nodes.length; i++) {
      const user = await comments.nodes[i].user;
      output.comments[i].author = user?.name || "Unknown";
    }

    console.log(stringify(output));
  } catch (error: any) {
    console.error(`Error fetching issue: ${error.message}`);
    process.exit(1);
  }
}

main();
