import { AnalysisQuery } from './model';

export interface Visit { name: string; query: AnalysisQuery; }
export class ExplorationHistory {
  readonly entries: Visit[] = [];
  get current() { return this.entries.at(-1); }
  visit(query: AnalysisQuery, name: string): boolean {
    const previous = this.entries.findIndex(entry => entry.query.file === query.file &&
      entry.query.offset === query.offset && entry.query.scope === query.scope);
    if (previous >= 0) {
      this.entries.splice(previous + 1);
      this.entries[previous].name = name;
      return true;
    }
    this.entries.push({ name, query: { ...query } });
    if (this.entries.length > 50) this.entries.shift();
    return false;
  }
  back() { if (this.entries.length > 1) this.entries.pop(); return this.current; }
  go(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) return undefined;
    this.entries.splice(index + 1);
    return this.current;
  }
  adjust(file: string, changes: readonly { rangeOffset: number; rangeLength: number; text: string }[]) {
    const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    for (const entry of this.entries.filter(entry => entry.query.file === file)) {
      for (const change of ordered) {
        if (entry.query.offset >= change.rangeOffset + change.rangeLength) {
          entry.query.offset += change.text.length - change.rangeLength;
        } else if (entry.query.offset >= change.rangeOffset) entry.query.offset = change.rangeOffset;
      }
    }
  }
}
