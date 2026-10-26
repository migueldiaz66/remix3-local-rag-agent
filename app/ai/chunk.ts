// chunk.ts: splits the corpus into passages for the RAG.
//
// Objective
//   Turn one Markdown file into chunks that embed well and cite well. The rules:
//   - a chunk never crosses a "## " heading; the chapter is the nearest "## " heading above,
//     and the heading line itself belongs to no chunk;
//   - nor does a chunk cross a "### " heading: a sub-section is its own run of chunks, even a
//     short one, and its chunks are named by its own heading, so a citation never labels text
//     with the heading of its neighbour; a heading with nothing under it yields no chunk;
//   - long sections are split at block boundaries (paragraphs, list items, tables, fenced
//     blocks) into pieces of about maxChars, balanced so that the last piece is not a crumb;
//     the balancing and the crumb rule work inside one heading, never across two;
//   - tables and fenced blocks stay whole, even when longer than maxChars; so does a single
//     paragraph, since a chunk never breaks inside a block;
//   - every chunk keeps its 1-based line range, so the panel can cite "Process, lines
//     17-29", and its text is exactly those lines of the source;
//   - a section that is only a table of contents (lines of links to anchors) is skipped,
//     wherever it is; the text before the first "## " heading is kept unless it is one, under
//     the document title.
//
// Dependencies
//   ./types.ts: the Chunk shape this file produces. No service: pure functions over a string.
//
// Consumers
//   scripts/ingest.ts: chunkMarkdown, to cut the document before embedding it.
//   app/ai/chunk.test.ts: chunkMarkdown, slugify, DEFAULT_MAX_CHARS.
//
// How it relates to them
//   Deterministic: the same text gives the same chunks and the same ids, which is what makes a
//   re-ingest replace points instead of adding them (see qdrant.ts, pointId). Line numbers are
//   those of the input split on "\n" or "\r\n", so a citation points into the file on disk.
//   Nothing is rewritten: a chunk's text is a slice of the source, and the chapter is the
//   heading's own text.
import type { Chunk } from './types.ts'

/**
 * The knobs of chunkMarkdown. Only one today.
 *
 * Called by: chunkMarkdown (this file); no other file names it
 */
export interface ChunkOptions {
  // The size a piece aims for, in characters. A single table, fenced block or paragraph may
  // exceed it, since a chunk never breaks inside a block; a short sub-section stays under it,
  // since a chunk never spans two headings.
  maxChars?: number
}

/**
 * The default piece size: about 500 characters, a paragraph or less, chosen by measuring ten
 * questions at four sizes: 500 found the right passage first in 7, 800 in 6, 1500 in 5, before
 * pieces were kept inside their heading; with that rule 500 gives 6 first and 10 within the
 * top four. Small enough that config.ragLimit of them fit comfortably in the 4096-token context window with the
 * question and the answer. It equals the default of config.chunkMaxChars, which the ingest
 * passes in.
 *
 * Called by: chunkMarkdown (this file), app/ai/chunk.test.ts
 */
export const DEFAULT_MAX_CHARS = 500

/**
 * A Markdown heading: group 1 is the hashes (the level), group 2 the title without them.
 *
 * Called by: splitSections, parseBlocks (this file)
 */
const HEADING = /^(#{1,6})\s+(.+?)\s*$/
/**
 * The start or end of a fenced code block; group 1 is the fence itself, since a block opened
 * with backticks is closed only by backticks and one opened with tildes only by tildes.
 *
 * Called by: splitSections, isTableOfContents, parseBlocks (this file)
 */
const FENCE = /^(```|~~~)/
/**
 * A table row: a line that starts with a pipe. Consecutive rows form one block.
 *
 * Called by: isTableOfContents, parseBlocks (this file)
 */
const TABLE_ROW = /^\|/
/**
 * A top-level list item: a bullet, or a number of up to three digits followed by "." or ")".
 * Indented items do not match, so a nested list stays with its parent item.
 *
 * Called by: parseBlocks (this file)
 */
const LIST_ITEM = /^(?:[-*+]|\d{1,3}[.)])\s+/
/**
 * A link to an anchor in the same document, "](#", the mark of a table of contents line.
 *
 * Called by: isTableOfContents (this file)
 */
const ANCHOR_LINK = /\]\(#/

/**
 * The lines under one "## " heading; `start`..`end` are 1-based and inclusive, `end < start`
 * when the section is empty. The text before the first "## " heading is a section named by the
 * "# " title, or "Preamble" when there is none.
 *
 * Called by: splitSections, parseBlocks, chunkMarkdown (this file)
 */
interface Section {
  // The heading's text, which becomes Chunk.chapter.
  chapter: string
  // The first line of the body, 1-based: the line after the heading.
  start: number
  // The last line of the body, 1-based and inclusive: the line before the next "## " heading.
  end: number
}

/**
 * A run of lines that is never split: a paragraph, a list item, a table or a fenced block.
 *
 * Called by: parseBlocks, groupByHeading, pack (this file)
 */
interface Block {
  // What the run is; tables and fences grow by their own rules in parseBlocks.
  kind: 'text' | 'table' | 'fence'
  // First line, 1-based.
  start: number
  // Last line, 1-based and inclusive.
  end: number
  // The nearest heading above the block, of any level from "## " down.
  heading: string
  // True when the block starts on a heading of level 2 or 3. groupByHeading begins a new group
  // there, so no piece spans the line before it. Absent on every other block.
  opens?: boolean
}

/**
 * One or more consecutive blocks that become a chunk: a line range and the heading of its first
 * block.
 *
 * Called by: pack, chunkMarkdown (this file)
 */
interface Piece {
  // First line, 1-based.
  start: number
  // Last line, 1-based and inclusive.
  end: number
  // The heading of the first block, which becomes Chunk.heading.
  heading: string
}

/**
 * Splits a Markdown document into chunks following the rules in the file header.
 *
 * Called by: scripts/ingest.ts: main, app/ai/chunk.test.ts
 * @param markdown the whole document; "\n" or "\r\n" line endings, any size
 * @param options maxChars, the size a piece aims for; DEFAULT_MAX_CHARS when omitted
 * @returns the chunks in document order, possibly none for an empty or links-only document;
 *   never throws
 */
export function chunkMarkdown(markdown: string, options: ChunkOptions = {}): Chunk[] {
  // The target piece size.
  let maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  // Split on either line ending so Windows files cite the same line numbers as Unix ones.
  let lines = markdown.split(/\r?\n/)
  // A constant-time length of any line range, built once from prefix sums.
  let span = spanMeasure(lines)
  // How many times each chapter slug has been used, to keep chunk ids unique.
  let slugs = new Map<string, number>()
  // The result, filled section by section.
  let chunks: Chunk[] = []

  // Each "## " section becomes its own run of chunks; none crosses the boundary.
  for (let section of splitSections(lines)) {
    // The section's lines, to test whether it is a table of contents.
    let body = lines.slice(section.start - 1, section.end)
    // A table of contents says nothing the RAG should retrieve; skip it wherever it is.
    if (isTableOfContents(body)) continue
    // The section as unsplittable blocks: paragraphs, list items, tables, fences.
    let blocks = parseBlocks(lines, section)
    // An empty section (a heading followed directly by the next) yields no chunk.
    if (blocks.length === 0) continue

    // The blocks grouped by heading, so that no piece spans a "## " or "### " heading.
    let groups = groupByHeading(blocks)
    // Each group packed into pieces of about maxChars; the balancing and the crumb rule only
    // ever see the blocks of one heading.
    let pieces = groups.flatMap((group) => pack(group, span, maxChars))
    // Nothing left to keep: every sub-heading of the section was empty.
    if (pieces.length === 0) continue

    // The chapter slug that prefixes this section's chunk ids, made unique among sections.
    let slug = uniqueSlug(section.chapter, slugs)
    // One chunk per piece, numbered from 1 inside its chapter.
    pieces.forEach((piece, index) => {
      // The chunk: its id, where it is, and exactly the source lines it covers.
      chunks.push({
        id: `${slug}-${index + 1}`,
        chapter: section.chapter,
        heading: piece.heading,
        lines: [piece.start, piece.end],
        text: lines.slice(piece.start - 1, piece.end).join('\n'),
      })
    })
  }

  // All chunks, in document order.
  return chunks
}

/**
 * Cuts the document at every "## " heading outside fenced blocks. A "## " inside a fence is
 * code, not a heading. A "# " title names the first section; lower headings cut nothing here:
 * they name blocks in parseBlocks, and groupByHeading cuts the section at the "### " ones.
 *
 * Called by: chunkMarkdown (this file)
 * @param lines the document, one entry per line
 * @returns at least one section, in order; the first covers what precedes the first "## "
 *   heading and may be empty
 */
function splitSections(lines: string[]): Section[] {
  // The sections closed so far.
  let sections: Section[] = []
  // The section being read; starts as the front matter, named later by the "# " title.
  let current: Section = { chapter: '', start: 1, end: 0 }
  // The fence that opened the code block being read, null outside one.
  let fence: string | null = null

  // One pass over the lines; `i` is 0-based, line numbers are i + 1.
  for (let i = 0; i < lines.length; i++) {
    // The line; the index is in range, hence the assertion.
    let line = lines[i]!
    // Is this line a fence?
    let fenceMatch = FENCE.exec(line)
    // A fence opens a code block, or closes the open one when it is the same kind of fence.
    if (fenceMatch) {
      // Opening: remember which fence so only its twin closes the block.
      if (fence === null) fence = fenceMatch[1]!
      // Closing: only the same fence does it; a tilde fence inside a backtick block is code.
      else if (fenceMatch[1] === fence) fence = null
      // A fence line is never a heading.
      continue
    }
    // Inside a code block nothing is a heading.
    if (fence !== null) continue

    // Is this line a heading?
    let heading = HEADING.exec(line)
    // Only headings cut; any other line belongs to the current section.
    if (!heading) continue
    // The number of hashes: 1 is the title, 2 a chapter, 3 and more a subheading.
    let level = heading[1]!.length
    // A "# " title cuts nothing but names the front matter.
    if (level === 1) {
      // The document title names the front matter; the first one wins.
      if (sections.length === 0 && current.chapter === '') current.chapter = heading[2]!
      // The title line stays in the current section's range; parseBlocks drops it.
      continue
    }
    // Subheadings do not cut: they stay inside their chapter.
    if (level !== 2) continue

    // A "## " heading closes the current section on the line before it (i is 0-based, so the
    // previous line's 1-based number is i).
    current.end = i
    // Keep the closed section.
    sections.push(current)
    // Open the next section: named by this heading, starting on the line after it (i + 2 in
    // 1-based numbering), with no end yet.
    current = { chapter: heading[2]!, start: i + 2, end: 0 }
  }

  // The last section ends with the document.
  current.end = lines.length
  // Keep it.
  sections.push(current)
  // Front matter without a "# " title gets a name, so its chunks have a chapter and a slug.
  if (sections[0]!.chapter === '') sections[0]!.chapter = 'Preamble'
  // All sections, in order.
  return sections
}

/**
 * Tells whether a section is only a table of contents: a list of links to anchors in the same
 * document. Four lines in five, at least, carry one, and nothing else of substance is there.
 *
 * Called by: chunkMarkdown (this file)
 * @param body the section's lines, headings included
 * @returns true when the section is a table of contents and should be skipped; false for an
 *   empty section, one with a table or fence, or one with fewer than 80% of link lines
 */
function isTableOfContents(body: string[]): boolean {
  // The lines that could carry content: not blank, not a heading.
  let content = body.filter((line) => line.trim() !== '' && !/^#/.test(line))
  // An empty section is not a table of contents; it is skipped later for having no blocks.
  if (content.length === 0) return false
  // A table or a code block is substance, whatever the links around it.
  if (content.some((line) => FENCE.test(line) || TABLE_ROW.test(line))) return false
  // How many content lines link to an anchor.
  let links = content.filter((line) => ANCHOR_LINK.test(line)).length
  // Four in five or more: a table of contents, allowing a stray line of introduction.
  return links / content.length >= 0.8
}

/**
 * Reads one section into blocks, the units a chunk is made of and never breaks: a paragraph, a
 * top-level list item, a whole table or a whole fenced block. Each block remembers the nearest
 * heading above it. A subheading ("### " and deeper) opens a text block, so it travels with the
 * text under it, and one of level 2 or 3 marks the block as opening a group (see
 * groupByHeading); the "# " title belongs to no block. The section's own "## " line is outside
 * the range splitSections gives.
 *
 * Called by: chunkMarkdown (this file)
 * @param lines the whole document, one entry per line
 * @param section the range to read, 1-based and inclusive
 * @returns the blocks in order; none when the section has only blank lines or a title
 */
function parseBlocks(lines: string[], section: Section): Block[] {
  // The blocks closed so far.
  let blocks: Block[] = []
  // The heading the next block gets: the chapter until a subheading appears.
  let heading = section.chapter
  // The block being grown, null between blocks.
  let open: Block | null = null
  // The fence that opened the code block being read, null outside one.
  let fence: string | null = null
  // True while the open block is only a heading line, which waits for the paragraph under it.
  let headingOnly = false
  // Finishes the open block, if any, and leaves none open.
  let close = () => {
    // Keep the block being grown.
    if (open) blocks.push(open)
    // Nothing is open now.
    open = null
    // And no heading is waiting.
    headingOnly = false
  }

  // One pass over the section; `n` is the 1-based line number.
  for (let n = section.start; n <= section.end; n++) {
    // The line at n; the index is in range, hence the assertion.
    let line = lines[n - 1]!

    // Inside a fenced block every line belongs to it until the matching fence.
    if (fence !== null) {
      // Grow the fence block to this line; `open` is the fence block, set when it opened.
      open!.end = n
      // The matching fence closes the block; another kind of fence is content.
      if (FENCE.exec(line)?.[1] === fence) {
        // Back outside code.
        fence = null
        // The fenced block is complete.
        close()
      }
      // Fence content is never a heading, table row or list item.
      continue
    }

    // Does a fenced block open here?
    let fenceMatch = FENCE.exec(line)
    // A fence closes whatever was open and starts a block that only its twin fence closes.
    if (fenceMatch) {
      // The paragraph or table before the fence is complete.
      close()
      // Remember which fence, so only the same kind closes the block.
      fence = fenceMatch[1]!
      // The fence block starts and, for now, ends on the fence line.
      open = { kind: 'fence', start: n, end: n, heading }
      // Nothing else to read on a fence line.
      continue
    }

    // A blank line separates blocks and belongs to none.
    if (line.trim() === '') {
      // A heading line is not complete without its paragraph: the blank line after it keeps it
      // open, so a chunk never ends on a heading whose text starts the next chunk.
      if (headingOnly) continue
      // The block before the blank line is complete.
      close()
      // Nothing opens on a blank line.
      continue
    }

    // Is this line a heading?
    let headingMatch = HEADING.exec(line)
    // A heading closes the block above and names what follows.
    if (headingMatch) {
      // The text above the heading is complete.
      close()
      // The document title belongs to no chunk; a lower heading opens a block and names what
      // follows it.
      if (headingMatch[1]!.length === 1) continue
      // From here on, blocks carry this heading.
      heading = headingMatch[2]!
      // The heading line opens a text block so it travels with the paragraph under it. A heading
      // of level 2 or 3 also marks where groupByHeading will cut.
      open = { kind: 'text', start: n, end: n, heading, opens: headingMatch[1]!.length <= 3 }
      // It waits for that paragraph: a blank line right after it does not close the block.
      headingOnly = true
      // The heading line is consumed.
      continue
    }

    // A table row grows the open table or starts one.
    if (TABLE_ROW.test(line)) {
      // Another row of the open table.
      if (open?.kind === 'table') open.end = n
      // A row after text or a blank line: a new table.
      else {
        // The text before the table is complete.
        close()
        // The table starts and, for now, ends on this row.
        open = { kind: 'table', start: n, end: n, heading }
      }
      // A row is consumed.
      continue
    }
    // A line that is not a row ends the open table.
    if (open?.kind === 'table') close()

    // A top-level list item starts a block of its own, so a long list splits between items.
    if (LIST_ITEM.test(line)) {
      // The previous item or paragraph is complete.
      close()
      // The item starts and, for now, ends on this line; its continuation lines grow it below.
      open = { kind: 'text', start: n, end: n, heading }
      // The item line is consumed.
      continue
    }

    // Any other line continues the open text block, which is no longer a lone heading.
    if (open) {
      // Grow the block to this line.
      open.end = n
      // The paragraph under the heading has arrived.
      headingOnly = false
      // No block open: this line starts a paragraph.
    } else open = { kind: 'text', start: n, end: n, heading }
  }

  // The block still open at the section's end is complete too.
  close()
  // All blocks, in order.
  return blocks
}

/**
 * Cuts a section's blocks into groups, one per heading of level 2 or 3: a group begins at a
 * block that opens such a heading, and the blocks before the first one (the lead-in under the
 * chapter heading) form a group of their own. Pieces are made inside a group, never across two,
 * so a chunk's heading is the heading of all its text. A group that is only a heading line, with
 * nothing under it before the next heading, is dropped: it would be a chunk of a title and
 * nothing else.
 *
 * Called by: chunkMarkdown (this file)
 * @param blocks the section's blocks, in order; at least one
 * @returns the groups in order, each with at least one block; possibly none, when the section
 *   holds nothing but empty headings
 */
function groupByHeading(blocks: Block[]): Block[][] {
  // The groups closed or being filled; the last one takes the next block.
  let groups: Block[][] = []
  // One pass over the blocks in order.
  for (let block of blocks) {
    // A heading block starts a new group, and so does the very first block.
    if (block.opens || groups.length === 0) groups.push([block])
    // Any other block joins the group of the heading above it.
    else groups[groups.length - 1]!.push(block)
  }
  // Drop the groups that are a lone heading line: a heading with nothing under it.
  return groups.filter((group) => {
    // The group's first block, which is also its only one when the group is a lone heading.
    let only = group[0]!
    // A lone block that opens a heading and fits on one line is that heading and nothing else.
    return !(group.length === 1 && only.opens && only.start === only.end)
  })
}

/**
 * Groups consecutive blocks into pieces of about maxChars. The blocks are those of one heading
 * (see groupByHeading), so nothing here can join text across a heading. The target size is the
 * group's length divided evenly, so a 1000-character group gives two pieces of about 500 rather
 * than 800 and 200 (the numbers are an example). A block longer than maxChars is a piece of its
 * own. Afterwards a crumb, a piece shorter than a quarter of maxChars, joins a neighbour inside
 * the group, so no chunk is a lone line unless its group is that short; a short sub-section
 * stays one small passage, named by its own heading.
 *
 * Called by: chunkMarkdown (this file)
 * @param blocks the blocks of one group, in order; at least one
 * @param span the length in characters of a line range, from spanMeasure
 * @param maxChars the size a piece aims for; a single block may exceed it
 * @returns the pieces in order, at least one
 */
function pack(
  blocks: Block[],
  span: (start: number, end: number) => number,
  maxChars: number,
): Piece[] {
  // The group's first block; the caller guarantees there is one.
  let first = blocks[0]!
  // The group's last block.
  let last = blocks[blocks.length - 1]!
  // The group's whole length in characters.
  let total = span(first.start, last.end)
  // The even share: the total split into as few pieces of at most maxChars as possible.
  let target = total / Math.max(1, Math.ceil(total / maxChars))

  // The pieces made so far.
  let pieces: Piece[] = []
  // The piece being grown, null when the next block starts a new one.
  let open: Piece | null = null
  // Add blocks to the open piece until it is full, then start the next one.
  for (let block of blocks) {
    // Decide whether the open piece can take this block.
    if (open) {
      // The open piece's length without the block.
      let current = span(open.start, open.end)
      // Its length with the block appended, blank lines between included.
      let withBlock = span(open.start, block.end)
      // Close the piece when the block would overflow it or it has already reached its share.
      if (withBlock > maxChars || current >= target) {
        // Keep the full piece.
        pieces.push(open)
        // The block starts a new piece below.
        open = null
      }
    }
    // Append the block to the open piece.
    if (open) open.end = block.end
    // Or start a piece with it, named by its heading.
    else open = { start: block.start, end: block.end, heading: block.heading }
  }
  // The last piece is still open; keep it.
  if (open) pieces.push(open)

  // A crumb, less than a quarter of maxChars, joins a neighbour of the same group, that is, of
  // the same heading: the previous piece when the result still fits, else the next one, else,
  // when both are oversize blocks, the next one anyway (a one-line lead-in captions the table
  // under it) or the previous one at the end of the group. A group with a single piece has no
  // neighbour: a short sub-section stays a small passage of its own.
  let crumb = maxChars / 4
  // Walk the pieces; `i` steps back after a merge so the piece that moved into position i is
  // checked too.
  for (let i = 0; i < pieces.length; i++) {
    // The piece under test.
    let piece = pieces[i]!
    // Big enough: leave it.
    if (span(piece.start, piece.end) >= crumb) continue
    // The neighbour before, undefined for the first piece.
    let previous = pieces[i - 1]
    // The neighbour after, undefined for the last piece.
    let next = pieces[i + 1]
    // Which neighbour takes the crumb, decided below.
    let into: 'previous' | 'next' | null = null
    // First choice: the previous piece, when the merge stays within maxChars.
    if (previous && span(previous.start, piece.end) <= maxChars) into = 'previous'
    // Second: the next piece, when that merge stays within maxChars.
    else if (next && span(piece.start, next.end) <= maxChars) into = 'next'
    // Both neighbours are oversize blocks: the crumb captions what follows it.
    else if (next) into = 'next'
    // At the end of the group the crumb can only go backwards.
    else if (previous) into = 'previous'

    // Merge backwards: the previous piece grows to the crumb's end and keeps its own heading.
    if (into === 'previous') previous!.end = piece.end
    // Merge forwards: the next piece starts at the crumb and takes the crumb's heading, which
    // is the heading that introduces it.
    else if (into === 'next') {
      // The next piece now begins where the crumb began.
      next!.start = piece.start
      // And carries the crumb's heading.
      next!.heading = piece.heading
      // No neighbour at all: the crumb is the group's only piece and stays as it is.
    } else continue
    // The crumb is now part of a neighbour: remove it from the list.
    pieces.splice(i, 1)
    // Re-check position i, which the following piece now occupies.
    i--
  }

  // The pieces, each at least a crumb unless it is alone.
  return pieces
}

/**
 * Builds a function giving the length of lines start..end joined with newlines, in constant
 * time from prefix sums, so pack can measure ranges freely.
 *
 * Called by: chunkMarkdown (this file)
 * @param lines the document, one entry per line
 * @returns span(start, end) for 1-based inclusive line numbers: the characters of those lines
 *   plus the newlines between them
 */
function spanMeasure(lines: string[]): (start: number, end: number) => number {
  // offsets[k] is the length of the first k lines, each counted with its newline.
  let offsets = new Array<number>(lines.length + 1)
  // Zero lines take zero characters.
  offsets[0] = 0
  // Each line adds its length and one newline.
  for (let i = 0; i < lines.length; i++) offsets[i + 1] = offsets[i]! + lines[i]!.length + 1
  // The difference of two prefix sums, minus the newline that would follow the last line.
  return (start, end) => offsets[end]! - offsets[start - 1]! - 1
}

/**
 * The slug of a chapter, made unique among the sections already seen: a second "Notes" chapter
 * becomes "notes-2", so chunk ids never collide.
 *
 * Called by: chunkMarkdown (this file)
 * @param chapter the heading's text
 * @param seen how many times each slug was handed out; updated in place
 * @returns the slug, with "-2", "-3" and so on appended from the second use on
 */
function uniqueSlug(chapter: string, seen: Map<string, number>): string {
  // The chapter's slug before disambiguation.
  let base = slugify(chapter)
  // This use's ordinal: 1 for the first chapter with this slug.
  let times = (seen.get(base) ?? 0) + 1
  // Remember it for the next chapter with the same slug.
  seen.set(base, times)
  // The first use keeps the bare slug; later ones get their ordinal.
  return times === 1 ? base : `${base}-${times}`
}

/**
 * Turns a heading into an id-safe slug: lower case, accents removed, anything that is not a
 * letter or digit collapsed into one hyphen. "RAG and LLM limitations" gives
 * "rag-and-llm-limitations"; a heading with nothing usable gives "section".
 *
 * Called by: uniqueSlug (this file), app/ai/chunk.test.ts
 * @param text any string
 * @returns a non-empty string of [a-z0-9-] with no hyphen at either end
 */
export function slugify(text: string): string {
  // Lower-case, decompose accented letters, drop the combining marks (U+0300 to U+036F), then
  // replace every run of other characters with a hyphen and trim hyphens at the ends.
  let slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Never return an empty id.
  return slug || 'section'
}
