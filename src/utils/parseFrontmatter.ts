export interface PostFrontmatter {
  title?: string;
  date?: string;
  description?: string;
  tags?: string[];
}

export interface ParsedPost {
  frontmatter: PostFrontmatter;
  content: string;
}

/** Parse YAML frontmatter (simple subset: string values + inline tag arrays). */
export function parseFrontmatter(raw: string): ParsedPost {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };

  const yamlStr = match[1];
  const content = match[2];
  const frontmatter: PostFrontmatter = {};

  for (const line of yamlStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (!key || key.startsWith('#')) continue;

    if (key === 'tags') {
      const arrMatch = val.match(/^\[(.+)\]$/);
      if (arrMatch) {
        frontmatter.tags = arrMatch[1]
          .split(',')
          .map(t => t.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      }
    } else {
      (frontmatter as Record<string, string>)[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter, content };
}

/** Convert a slug like "wes-the-mpg-for-local-ai-inference" to a readable title. */
export function slugToTitle(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Strip basic Markdown syntax to produce plain text. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/`{1,3}[^`\n]+`{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^\s*[-_*]{3,}\s*$/gm, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\n+/g, ' ')
    .trim();
}

/** Format "YYYY-MM-DD" → "Month D, YYYY". Returns '' on invalid input. */
export function formatDate(dateStr: string): string {
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const parts = dateStr.split('-');
  if (parts.length !== 3) return '';
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d) || m < 0 || m > 11) return '';
  return `${MONTHS[m]} ${d}, ${y}`;
}
