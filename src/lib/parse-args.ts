/**
 * Split a command-line argument string the way the settings forms accept it:
 * space-separated, with single or double quotes grouping an argument that
 * contains spaces.
 *
 * This is deliberately not a shell parser — there is no escaping, no variable
 * expansion and no operator handling, because the result is passed straight to
 * the agent host as an argv array rather than to a shell.
 */
export function parseArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (const char of argsString) {
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}
