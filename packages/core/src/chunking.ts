import { deterministicId } from "./ids.js";

export interface TextChunk {
  id: string;
  index: number;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  content: string;
}

interface Section {
  start: number;
  end: number;
  headingPath: string[];
}

interface Span {
  start: number;
  end: number;
}

const HEADING_LINE = /^(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/gmu;

export function normalizeText(value: string): string {
  const withoutBom = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  return withoutBom.replace(/\r\n?/gu, "\n").normalize("NFC");
}

export function titleFromText(content: string, fallback: string): string {
  const match = /^#[\t ]+(.+?)[\t ]*#*[\t ]*$/mu.exec(content);
  const title = (match?.[1] ?? fallback).trim();
  return (title || fallback).slice(0, 512);
}

export function chunkDocument(
  revisionId: string,
  content: string,
  targetSize = 1_400,
): TextChunk[] {
  const sections = markdownSections(content);
  const spans: Array<Span & { headingPath: string[] }> = [];

  for (const section of sections) {
    for (const span of splitSection(content, section.start, section.end, targetSize)) {
      spans.push({ ...span, headingPath: section.headingPath });
    }
  }

  if (spans.length === 0) {
    spans.push({ start: 0, end: 0, headingPath: [] });
  }

  return spans.map((span, index) => {
    const chunkContent = content.slice(span.start, span.end);
    return {
      id: deterministicId("chunk", revisionId, String(index), chunkContent),
      index,
      headingPath: [...span.headingPath],
      startOffset: span.start,
      endOffset: span.end,
      content: chunkContent,
    };
  });
}

function markdownSections(content: string): Section[] {
  if (content.length === 0) {
    return [];
  }

  const headings: Array<{ start: number; level: number; title: string }> = [];
  HEADING_LINE.lastIndex = 0;
  for (let match = HEADING_LINE.exec(content); match; match = HEADING_LINE.exec(content)) {
    headings.push({
      start: match.index,
      level: match[1]?.length ?? 1,
      title: (match[2] ?? "").trim(),
    });
  }

  if (headings.length === 0) {
    return [{ start: 0, end: content.length, headingPath: [] }];
  }

  const sections: Section[] = [];
  if ((headings[0]?.start ?? 0) > 0) {
    sections.push({ start: 0, end: headings[0]?.start ?? 0, headingPath: [] });
  }

  const path: string[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading) continue;
    path.length = heading.level - 1;
    path[heading.level - 1] = heading.title;
    sections.push({
      start: heading.start,
      end: headings[index + 1]?.start ?? content.length,
      headingPath: path.filter((part): part is string => part !== undefined),
    });
  }
  return sections;
}

function splitSection(
  content: string,
  rawStart: number,
  rawEnd: number,
  targetSize: number,
): Span[] {
  const spans: Span[] = [];
  let cursor = skipWhitespaceForward(content, rawStart, rawEnd);
  const sectionEnd = skipWhitespaceBackward(content, cursor, rawEnd);

  while (cursor < sectionEnd) {
    const hardEnd = Math.min(cursor + targetSize, sectionEnd);
    let end = hardEnd;
    if (hardEnd < sectionEnd) {
      const minimumBreak = cursor + Math.floor(targetSize * 0.5);
      end = preferredBreak(content, minimumBreak, hardEnd);
    }
    end = skipWhitespaceBackward(content, cursor, end);
    if (end <= cursor) end = hardEnd;
    spans.push({ start: cursor, end });
    cursor = skipWhitespaceForward(content, end, sectionEnd);
  }
  return spans;
}

function preferredBreak(content: string, minimum: number, maximum: number): number {
  const window = content.slice(minimum, maximum);
  for (const separator of ["\n\n", "\n", ". ", "! ", "? ", " "]) {
    const relative = window.lastIndexOf(separator);
    if (relative >= 0) return minimum + relative + separator.length;
  }
  return maximum;
}

function skipWhitespaceForward(content: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && /\s/u.test(content[cursor] ?? "")) cursor += 1;
  return cursor;
}

function skipWhitespaceBackward(content: string, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && /\s/u.test(content[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}
