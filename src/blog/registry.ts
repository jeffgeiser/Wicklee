/**
 * Blog post registry — DEPRECATED.
 *
 * Posts are now discovered at runtime from /public/blog/index.json.
 * To publish a new post: add the slug to /public/blog/index.json and
 * drop the corresponding /public/blog/{slug}.md file.
 *
 * This file is kept as an empty export to avoid breaking any stale imports.
 */
export const POST_SLUGS: string[] = [];
