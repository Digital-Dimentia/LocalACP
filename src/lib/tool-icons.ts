// Glyphs for tool calls, shared by every row that shows one.

/** Icon for an ACP tool `kind`. Unknown kinds fall back to a generic tool. */
export function toolKindIcon(kind: string): string {
  switch (kind) {
    case 'read': return '📖';
    case 'edit': return '✏️';
    case 'write': return '📝';
    case 'delete': return '🗑️';
    case 'move': return '📦';
    case 'search': return '🔍';
    case 'execute': return '▶️';
    case 'think': return '💭';
    case 'fetch': return '🌐';
    default: return '🔧';
  }
}

/** Icon for a tool call's lifecycle status. */
export function toolStatusIcon(status: string): string {
  switch (status) {
    case 'pending': return '⏳';
    case 'in_progress': return '⚙️';
    case 'completed': return '✓';
    case 'failed': return '✗';
    default: return '';
  }
}
