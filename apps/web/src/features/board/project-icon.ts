/** Emoji picked from a project's name when none was chosen: the first keyword that matches wins. */
const BY_KEYWORD: [RegExp, string][] = [
  [/\binbox\b/, '📥'],
  [/\b(home|house|flat|apartment|family|chores?)\b/, '🏠'],
  [/\b(work|job|office|client|meeting|team)s?\b/, '💼'],
  [/\b(garden|plants?|yard|balcony)\b/, '🌱'],
  [/\b(trip|travel|vacation|holiday|flights?|journey|visit)\b/, '✈️'],
  [/\b(health|doctor|dentist|medical|therapy)\b/, '🩺'],
  [/\b(gym|fitness|sport|run|running|training|workout|yoga)\b/, '🏃'],
  [/\b(money|finance|budget|bank|tax|taxes|bills?|invoice)s?\b/, '💰'],
  [/\b(study|learn|learning|school|course|class|exam|university|lesson)s?\b/, '📚'],
  [/\b(code|dev|app|software|website|site|portfolio|programming)s?\b/, '💻'],
  [/\b(shop|shopping|groceries|grocery|errands?)\b/, '🛒'],
  [/\b(car|bike|repair|garage)s?\b/, '🔧'],
  [/\b(kids?|children|baby|school run)\b/, '🧸'],
  [/\b(pets?|dog|cat|vet)\b/, '🐾'],
  [/\b(music|guitar|piano|band|song)s?\b/, '🎵'],
  [/\b(books?|reading|read)\b/, '📖'],
  [/\b(writing|write|blog|newsletter|journal)\b/, '✍️'],
  [/\b(cook|cooking|food|recipes?|meal|kitchen)s?\b/, '🍳'],
  [/\b(clean|cleaning|tidy)\b/, '🧹'],
  [/\b(admin|paperwork|documents?|forms?)\b/, '🗂️'],
  [/\b(friends?|social|party|birthday|gifts?)\b/, '🎉'],
  [/\b(boat|sail|sailing)\b/, '⛵'],
  [/\b(ideas?|someday|later|maybe)\b/, '💡'],
  [/\b(language|russian|english|spanish|french|german)s?\b/, '🗣️'],
  [/\b(photo|photos|photography|camera)\b/, '📷'],
  [/\b(move|moving|renovation|diy|build)\b/, '🔨'],
];

/** Offered in the project dialog, most common first. */
export const ICON_CHOICES = [
  '🏠', '💼', '🌱', '✈️', '💰', '📚', '💻', '🛒', '🩺', '🏃', '🎵', '📖',
  '✍️', '🍳', '🐾', '🎉', '🔧', '🗂️', '💡', '⛵', '🧭', '⭐', '🔥', '🎯',
];

export function autoIcon(name: string): string | null {
  const n = name.toLowerCase();
  return BY_KEYWORD.find(([re]) => re.test(n))?.[1] ?? null;
}

/** What to show beside a project's name: its chosen icon, one picked from the name, or none. */
export function projectIcon(project: { name: string; icon: string | null } | null): string | null {
  if (!project) return '📥';
  return project.icon ?? autoIcon(project.name);
}

/** A project's name with its icon in front when it has one: "🏠 Home", or just "Helm". */
export function projectTitle(project: { name: string; icon: string | null } | null): string {
  const icon = projectIcon(project);
  const name = project?.name ?? 'Inbox';
  return icon ? `${icon} ${name}` : name;
}
