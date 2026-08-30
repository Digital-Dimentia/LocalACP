import { describe, it, expect } from 'vitest';
import { parseArgs } from './parse-args';

describe('parseArgs', () => {
  it('splits on spaces', () => {
    expect(parseArgs('-y @example/agent')).toEqual(['-y', '@example/agent']);
  });

  it('returns nothing for empty or blank input', () => {
    expect(parseArgs('')).toEqual([]);
    expect(parseArgs('   ')).toEqual([]);
  });

  it('collapses runs of spaces rather than emitting empty args', () => {
    expect(parseArgs('  a    b  ')).toEqual(['a', 'b']);
  });

  it('keeps a quoted argument together', () => {
    expect(parseArgs('--path "/some dir/file.py"')).toEqual([
      '--path',
      '/some dir/file.py',
    ]);
    expect(parseArgs("--msg 'hello world'")).toEqual(['--msg', 'hello world']);
  });

  it('treats the other quote character as literal text inside quotes', () => {
    expect(parseArgs(`--msg "it's fine"`)).toEqual(['--msg', "it's fine"]);
  });

  it('does not split on a quote that opens mid-token', () => {
    expect(parseArgs('--flag="a b"')).toEqual(['--flag=a b']);
  });

  it('accepts an unterminated quote rather than throwing', () => {
    expect(parseArgs('--msg "unterminated')).toEqual(['--msg', 'unterminated']);
  });
});
