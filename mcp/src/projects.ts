import type { PoolClient } from "pg";
import { isConfusable, toSlug } from "./slug.js";

export type Project = {
  readonly slug: string;
  readonly name: string;
  readonly cardCount: number;
  readonly changeCount: number;
};

export type ResolvedProject = {
  readonly id: string;
  readonly slug: string;
  readonly created: boolean;
};

export class ConfusableProjectError extends Error {
  constructor(
    readonly slug: string,
    readonly nearest: readonly string[],
  ) {
    super(
      `Nothing published. "${slug}" does not exist yet, but this organization ` +
        `already has ${nearest.map((s) => `"${s}"`).join(", ")}. Publish under ` +
        `that one, or repeat the call with create_project: true if the split is deliberate.`,
    );
    this.name = "ConfusableProjectError";
  }
}

export class UnusableProjectNameError extends Error {
  constructor(readonly attempted: string) {
    super(`"${attempted}" leaves no letters or digits to name a project with.`);
    this.name = "UnusableProjectNameError";
  }
}

/**
 * Both entities on the board hang off a project, so the counts are reported
 * side by side: a project with cards and no changes reads very differently from
 * one with changes and no cards.
 *
 * count(distinct) rather than count(): joining two child tables at once
 * multiplies the rows, and a plain count would report the product of the two.
 */
export async function listProjects(client: PoolClient): Promise<readonly Project[]> {
  const result = await client.query<{
    slug: string;
    name: string;
    card_count: string;
    change_count: string;
  }>(
    `select p.slug, p.name,
            count(distinct c.id)::text as card_count,
            count(distinct n.id)::text as change_count
       from projects p
       left join cards c        on c.project_id = p.id
       left join change_notes n on n.project_id = p.id
      group by p.slug, p.name
      order by p.slug`,
  );
  return result.rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    cardCount: Number(row.card_count),
    changeCount: Number(row.change_count),
  }));
}

/**
 * A project is a name, not a registration: an unknown one is created on the
 * spot, unless it reads as a misspelling of a project that already exists.
 * @throws ConfusableProjectError when a near-miss is found and allowCreate is false
 */
export async function resolveProject(
  client: PoolClient,
  orgId: string,
  name: string,
  allowCreate: boolean,
): Promise<ResolvedProject> {
  const slug = toSlug(name);
  if (slug === "") throw new UnusableProjectNameError(name);

  const existing = await client.query<{ id: string }>(
    "select id from projects where slug = $1",
    [slug],
  );
  const found = existing.rows[0]?.id;
  if (found !== undefined) return { id: found, slug, created: false };

  if (!allowCreate) {
    const nearest = (await listProjects(client))
      .map((project) => project.slug)
      .filter((candidate) => isConfusable(slug, candidate));
    if (nearest.length > 0) throw new ConfusableProjectError(slug, nearest);
  }

  // Two agents can publish into the same new project at once; the conflict
  // clause makes the loser read the winner's row instead of failing.
  const inserted = await client.query<{ id: string; created: boolean }>(
    `insert into projects (org_id, slug, name) values ($1, $2, $3)
       on conflict (org_id, slug) do update set name = projects.name
     returning id, (xmax = 0) as created`,
    [orgId, slug, name.trim()],
  );
  const project = inserted.rows[0];
  if (project === undefined) throw new Error("project upsert returned no row");
  return { id: project.id, slug, created: project.created };
}

export function formatProjects(projects: readonly Project[]): string {
  if (projects.length === 0) return "This organization has no projects yet.";
  return projects
    .map(
      (p) =>
        `- \`${p.slug}\` — ${p.name} (${p.cardCount} cards, ${p.changeCount} changes)`,
    )
    .join("\n");
}
