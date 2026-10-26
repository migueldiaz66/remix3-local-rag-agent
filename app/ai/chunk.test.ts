// chunk.test.ts: the Markdown chunker, on a small sample and on the real article.
//
// Objective
//   Prove that chunkMarkdown cuts a document into passages that never cross a "## " chapter
//   heading or a "### " sub-heading, keep tables and fenced blocks whole, split long sections
//   between paragraphs or list items, keep a sub-heading with the paragraph under it and a
//   short sub-section as a small passage of its own, skip the table of contents, carry
//   exact 1-based line ranges, and get deterministic ids from slugified headings. The sample
//   pins the behavior line by line; the real article (data/rag-wikipedia.md, about nine
//   thousand characters) checks the sizes, the chapter coverage, the first chunk and the
//   sub-headings the RAG depends on.
//
// Dependencies
//   node:fs/promises: readFile, to load the article.
//   remix/assert: ok, equal, deepEqual and match, the assertions.
//   remix/test: describe and it, the runner's grouping and cases.
//   ./chunk.ts: DEFAULT_MAX_CHARS, chunkMarkdown and slugify, under test.
//   ./types.ts: Chunk, the shape every passage has.
//   The file data/rag-wikipedia.md at the repository root, read from disk by the second group;
//   it must exist for those cases to run. No service.
//
// Consumers
//   `npm test` (package.json) runs it; nothing imports it.
//   app/ai/chunk.ts is the module it covers: a change to the cutting rules must keep these cases
//   green. scripts/ingest.ts relies on the same chunks, and app/ai/rag.ts cites their chapters
//   and lines.
//
// How it relates to them
//   The invariants in assertInvariants are the contract every consumer relies on: a chunk's text
//   is exactly its source lines, ids are unique, and a table or fence is never cut. The counts
//   and line numbers for the real article change when the article does; the "real article"
//   group is where that shows up.
import { readFile } from 'node:fs/promises'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { DEFAULT_MAX_CHARS, chunkMarkdown, slugify } from './chunk.ts'
import type { Chunk } from './types.ts'

/**
 * Builds one numbered paragraph of about 300 characters, so a section of six paragraphs is long
 * enough to force splits at several maxChars values.
 *
 * Called by: this file: SAMPLE, the "balanced pieces" case
 * @param n the paragraph's number, which makes each one distinct
 * @returns the paragraph's text, with no leading or trailing space
 */
const paragraph = (n: number) =>
  `Paragraph ${n} of chapter two. `.repeat(10).trim() // about 300 characters

/**
 * A small document with every construct the chunker must handle: a title with front matter, a
 * table of contents, a table, a fence that contains a fake heading, a long section of six
 * paragraphs, an empty section, and a "### " heading over a list with a continuation line.
 *
 * Called by: this file: every case of the "small sample" group
 */
const SAMPLE = [
  '# Sample document',
  '',
  'Front matter paragraph, kept under the title.',
  '',
  '## Contents',
  '',
  '1. [One](#1-one)',
  '2. [Two](#2-two)',
  '',
  '## 1. One',
  '',
  'First paragraph of one.',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1',
  '',
  '## not a heading, inside a fence',
  'const y = 2',
  '```',
  '',
  '## 2. Two',
  '',
  paragraph(1),
  '',
  paragraph(2),
  '',
  paragraph(3),
  '',
  paragraph(4),
  '',
  paragraph(5),
  '',
  paragraph(6),
  '',
  '## 3. Empty',
  '',
  '## 4. Lists',
  '',
  '### Details',
  '',
  '- item one, the first entry of the list',
  '  continued on a second line',
  '- item two, the second entry of the list',
  '- item three, the third entry of the list',
  '',
].join('\n')

/**
 * Cuts the source lines a chunk claims, so its text can be compared with where it says it is.
 *
 * Called by: this file: assertInvariants
 * @param markdown the whole document, with LF or CRLF endings
 * @param chunk the chunk whose 1-based, inclusive line range is used
 * @returns the lines of that range joined with LF
 */
function sliceOf(markdown: string, chunk: Chunk): string {
  // 1-based inclusive to 0-based slice: start minus one, end as is.
  return markdown.split(/\r?\n/).slice(chunk.lines[0] - 1, chunk.lines[1]).join('\n')
}

/**
 * Finds the 1-based line numbers of the "## " headings outside fenced blocks: the lines no chunk
 * may contain, since a chunk belongs to exactly one chapter.
 *
 * Called by: this file: assertInvariants
 * @param markdown the whole document
 * @returns the line numbers, ascending
 */
function headingLines(markdown: string): number[] {
  // Whether the current line is inside a fence, where a "## " is not a heading.
  let fence = false
  // The heading lines found.
  let result: number[] = []
  // Walk the lines, tracking fences and collecting headings.
  markdown.split(/\r?\n/).forEach((line, i) => {
    // A fence opener or closer flips the state; both styles count.
    if (/^(```|~~~)/.test(line)) fence = !fence
    // Outside a fence, a "## " line is a chapter heading.
    else if (!fence && /^## /.test(line)) result.push(i + 1)
  })
  // Hand back the positions.
  return result
}

/**
 * The 1-based line ranges of every table and fenced block, which must stay whole: a cut inside
 * one would leave a passage that is not readable on its own.
 *
 * Called by: this file: assertInvariants
 * @param markdown the whole document
 * @returns the ranges, inclusive, in document order
 */
function wholeBlocks(markdown: string): [number, number][] {
  // The document's lines.
  let lines = markdown.split(/\r?\n/)
  // The ranges found so far.
  let ranges: [number, number][] = []
  // The block being read, as a range that grows; null between blocks.
  let open: [number, number] | null = null
  // Whether the current line is inside a fence.
  let fence = false
  // Walk the lines, extending the open block or closing it.
  lines.forEach((line, i) => {
    // The 1-based line number.
    let n = i + 1
    // Inside a fence every line belongs to the block, until the closing fence.
    if (fence) {
      // Extend the block to this line.
      open![1] = n
      // The closing fence ends the block.
      if (/^```/.test(line)) {
        // Leave the fence.
        fence = false
        // Record the finished block.
        ranges.push(open!)
        // Nothing is open now.
        open = null
      }
      // The line is handled.
      return
    }
    // An opening fence starts a block; a table that ran up to it is closed first.
    if (/^```/.test(line)) {
      // A table right before the fence is a block of its own.
      if (open) ranges.push(open)
      // The fence starts here.
      open = [n, n]
      // Enter the fence.
      fence = true
      // The line is handled.
      return
    }
    // A table row extends the open table or starts one.
    if (/^\|/.test(line)) {
      // Extend the table.
      if (open) open[1] = n
      // Or start it.
      else open = [n, n]
      // The line is handled.
      return
    }
    // Any other line ends an open table.
    if (open) {
      // Record the finished table.
      ranges.push(open)
      // Nothing is open now.
      open = null
    }
  })
  // A table or fence that runs to the end of the document is still a block.
  if (open) ranges.push(open)
  // Hand back the ranges.
  return ranges
}

/**
 * Checks what every chunking of any document must satisfy: line ranges inside the file, no
 * chunk across a chapter heading, the text equal to its source lines, no blank chunk, unique
 * ids, and each table or fence inside exactly one chunk. Called from several cases so the
 * contract is checked at every maxChars tried.
 *
 * Called by: this file: five cases of the "small sample" group, the first "real article" case
 * @param markdown the document that was chunked
 * @param chunks the chunks chunkMarkdown returned for it
 */
function assertInvariants(markdown: string, chunks: Chunk[]) {
  // The number of lines, the upper bound of any range.
  let total = markdown.split(/\r?\n/).length
  // The chapter headings no chunk may contain.
  let headings = headingLines(markdown)
  // The ids seen, for the uniqueness check.
  let ids = new Set<string>()
  // Check each chunk on its own.
  for (let chunk of chunks) {
    // The chunk's inclusive range.
    let [first, last] = chunk.lines
    // The range is well-formed and inside the document.
    assert.ok(
      first >= 1 && first <= last && last <= total,
      `${chunk.id}: lines ${first}-${last} inside the file`,
    )
    // No chapter heading inside the range: a chunk belongs to one chapter.
    assert.ok(
      !headings.some((n) => n >= first && n <= last),
      `${chunk.id}: lines ${first}-${last} cross a "## " heading`,
    )
    // The text is exactly the source lines, so a citation by lines points at the same words.
    assert.equal(chunk.text, sliceOf(markdown, chunk), `${chunk.id}: text is its source lines`)
    // A blank chunk would be an empty passage in the index.
    assert.ok(chunk.text.trim() !== '', `${chunk.id}: not blank`)
    // Two chunks with one id would overwrite each other in Qdrant.
    assert.ok(!ids.has(chunk.id), `${chunk.id}: unique id`)
    // Remember the id.
    ids.add(chunk.id)
  }
  // Check that each table or fence is held whole by one chunk.
  for (let [start, end] of wholeBlocks(markdown)) {
    // The chunks whose range contains the whole block.
    let holders = chunks.filter((c) => c.lines[0] <= start && end <= c.lines[1])
    // Exactly one: zero means the block was cut, two would mean overlapping chunks.
    assert.equal(holders.length, 1, `lines ${start}-${end} (a table or fence) stay in one chunk`)
  }
}

// The hand-made sample, where every expectation can be pinned to a line.
describe('chunkMarkdown on a small sample', () => {
  // Proves that text under the "# " title becomes the first chunk, named after the title, and
  // that the "## Contents" section is dropped. Covers: app/ai/chunk.ts: chunkMarkdown.
  it('keeps the front matter under the document title and skips the table of contents', () => {
    // Chunk with the default size.
    let chunks = chunkMarkdown(SAMPLE)
    // The contract first.
    assertInvariants(SAMPLE, chunks)

    // The first chunk is the front matter.
    let [front] = chunks
    // Its chapter and heading are the document title; its range is the one paragraph line.
    assert.deepEqual(front, {
      id: 'sample-document-1',
      chapter: 'Sample document',
      heading: 'Sample document',
      lines: [3, 3],
      text: 'Front matter paragraph, kept under the title.',
    })
    // The table of contents is not a chapter anyone should retrieve.
    assert.ok(!chunks.some((c) => c.chapter === 'Contents'), 'the table of contents is skipped')
    // Nor do its link lines leak into another chunk.
    assert.ok(!chunks.some((c) => c.text.includes('](#')), 'no chunk is made of its links')
  })

  // Proves that the chapter is the nearest "## " heading, that ids are the heading's slug plus
  // a running number, that chunking is deterministic, and that an empty section yields nothing.
  // Covers: app/ai/chunk.ts: chunkMarkdown.
  it('names the chapter from the nearest "## " heading and gives deterministic ids', () => {
    // Chunk with the default size.
    let chunks = chunkMarkdown(SAMPLE)
    // The chunks of chapter one.
    let one = chunks.filter((c) => c.chapter === '1. One')
    // The chapter has content, so it has at least one chunk.
    assert.ok(one.length >= 1)
    // Ids are the slug of the heading and a 1-based counter, in order.
    assert.deepEqual(
      one.map((c) => c.id),
      one.map((_, i) => `1-one-${i + 1}`),
    )
    // Re-ingesting the same document must produce the same points.
    assert.deepEqual(chunkMarkdown(SAMPLE), chunks, 'the same input gives the same chunks')
    // A heading with nothing under it has no passage to index.
    assert.ok(!chunks.some((c) => c.chapter === '3. Empty'), 'an empty section has no chunk')
  })

  // Proves that a table and a fenced block each stay in one chunk although the limit is far
  // smaller than they are, and that a "## " inside the fence is not a heading.
  // Covers: app/ai/chunk.ts: chunkMarkdown.
  it('keeps tables and fenced blocks whole, even when they exceed maxChars', () => {
    // A limit so small that anything splittable is split.
    let chunks = chunkMarkdown(SAMPLE, { maxChars: 30 })
    // The contract, which includes the whole-block rule.
    assertInvariants(SAMPLE, chunks)
    // The chunk that starts with the table's header row.
    let table = chunks.find((c) => c.text.startsWith('| a | b |'))
    // It exists.
    assert.ok(table, 'the table is one chunk')
    // And spans exactly the table's three lines.
    assert.deepEqual(table.lines, [14, 16])
    // Under the chapter it sits in.
    assert.equal(table.chapter, '1. One')
    // The chunk that starts with the fence opener.
    let fence = chunks.find((c) => c.text.startsWith('```ts'))
    // It exists.
    assert.ok(fence, 'the fence is one chunk')
    // And spans from the opener to the closer.
    assert.deepEqual(fence.lines, [18, 23])
    // The fake heading inside the fence stayed inside the fence's chunk.
    assert.match(fence.text, /## not a heading, inside a fence/)
    // Still chapter one: the fake heading did not start a chapter.
    assert.equal(fence.chapter, '1. One')
  })

  // Proves that a section over the limit is cut between paragraphs into pieces of similar size,
  // with no crumbs, no lost text and no duplicated text. Covers: app/ai/chunk.ts: chunkMarkdown.
  it('splits a long section at paragraph boundaries into balanced pieces', () => {
    // 700 fits two 300-character paragraphs, not three.
    let chunks = chunkMarkdown(SAMPLE, { maxChars: 700 })
    // The contract first.
    assertInvariants(SAMPLE, chunks)
    // The chunks of the long chapter.
    let two = chunks.filter((c) => c.chapter === '2. Two')
    // Balanced: three pieces of two paragraphs, not five pieces and a crumb.
    assert.equal(two.length, 3, 'six paragraphs of 300 characters make three pieces of two')
    // Check each piece's size and edges.
    for (let chunk of two) {
      // Under the limit.
      assert.ok(chunk.text.length <= 700, `${chunk.id} is ${chunk.text.length} chars`)
      // And not a crumb: at least most of two paragraphs.
      assert.ok(chunk.text.length >= 500, `${chunk.id} is ${chunk.text.length} chars, not a crumb`)
      // The cut fell on the blank line between paragraphs, not inside one.
      assert.ok(
        !chunk.text.startsWith(' ') && !chunk.text.endsWith(' '),
        'cuts fall between paragraphs',
      )
    }
    // The line ranges are the paragraph pairs, with the blank lines between pairs left out.
    assert.deepEqual(
      two.map((c) => c.lines),
      [
        [27, 29],
        [31, 33],
        [35, 37],
      ],
    )
    // Joining the pieces gives back the six paragraphs exactly.
    assert.equal(
      two.map((c) => c.text).join('\n\n'),
      [1, 2, 3, 4, 5, 6].map(paragraph).join('\n\n'),
      'nothing is lost or duplicated',
    )
  })

  // Proves that a long list is cut between items, never inside one, and that a "### " heading
  // names the heading field while the chapter stays the "## " one.
  // Covers: app/ai/chunk.ts: chunkMarkdown.
  it('splits long lists between items and takes the heading from a "### " line', () => {
    // A limit that holds about one list item.
    let chunks = chunkMarkdown(SAMPLE, { maxChars: 80 })
    // The contract first.
    assertInvariants(SAMPLE, chunks)
    // The chunks of the list chapter.
    let lists = chunks.filter((c) => c.chapter === '4. Lists')
    // The list did not fit in one chunk.
    assert.ok(lists.length >= 2, 'the list is split')
    // Check each piece's heading and first line.
    for (let chunk of lists) {
      // The nearest "### " is the heading, finer than the chapter.
      assert.equal(chunk.heading, 'Details')
      // A piece begins at the heading or at an item, never at a continuation line.
      assert.match(
        chunk.text,
        /^(### Details|- item)/,
        'a piece starts at a heading or a list item',
      )
    }
    // The piece with the first item.
    let first = lists.find((c) => c.text.includes('item one'))
    // It exists.
    assert.ok(first)
    // The indented second line of the item travels with the item.
    assert.match(
      first.text,
      /continued on a second line/,
      'a continuation line stays with its item',
    )
  })

  // Proves that a sub-heading travels with the paragraph under it: a chunk never ends on a
  // heading whose text starts the next chunk. Covers: app/ai/chunk.ts: chunkMarkdown.
  it('keeps a sub-heading with the paragraph under it', () => {
    // Two paragraphs of 500 characters under one chapter, the second under a sub-heading.
    let doc = [
      '# T', '', '## A', '', 'a'.repeat(500), '', '### Sub', '', 'b'.repeat(500), '',
    ].join('\n')
    // Chunk with a size that fits one paragraph but not two.
    let chunks = chunkMarkdown(doc, { maxChars: 600 })
    // Two chunks, one per paragraph.
    assert.equal(chunks.length, 2)
    // The first chunk stops before the sub-heading instead of ending on it.
    assert.ok(!chunks[0]!.text.includes('### Sub'), 'the heading is not left at the end of a chunk')
    // The second starts on the sub-heading, followed by its paragraph.
    assert.ok(chunks[1]!.text.startsWith('### Sub\n\nb'), 'the heading opens the next chunk')
    // And it is named by that sub-heading.
    assert.equal(chunks[1]!.heading, 'Sub')
  })

  // Proves that a short sub-section stays a passage of its own, named by its own heading, and is
  // never joined to its neighbour to reach the target size. Covers: app/ai/chunk.ts:
  // chunkMarkdown.
  it('keeps a short sub-section as its own small passage', () => {
    // Three sub-sections of about 100 characters each, far under a target of 600.
    let doc = [
      '# T', '', '## A', '', '### One', '', 'a'.repeat(100), '',
      '### Two', '', 'b'.repeat(100), '', '### Three', '', 'c'.repeat(100), '',
    ].join('\n')
    // Chunk with a size that would fit all three together.
    let chunks = chunkMarkdown(doc, { maxChars: 600 })
    // One chunk per sub-section, named by it.
    assert.deepEqual(
      chunks.map((c) => c.heading),
      ['One', 'Two', 'Three'],
    )
    // Each starts on its own heading line.
    assert.ok(chunks.every((c) => c.text.startsWith('### ')))
  })

  // Proves that a heading with nothing under it yields no chunk, and does not swallow the
  // sub-section that follows. Covers: app/ai/chunk.ts: chunkMarkdown.
  it('yields no chunk for a heading with nothing under it', () => {
    // An empty sub-section right before a full one.
    let doc = [
      '# T', '', '## A', '', '### Empty', '', '### Full', '', 'text of the full one', '',
    ].join('\n')
    // Chunk it.
    let chunks = chunkMarkdown(doc)
    // Only the full sub-section remains.
    assert.deepEqual(
      chunks.map((c) => [c.heading, c.text]),
      [['Full', '### Full\n\ntext of the full one']],
    )
  })

  // Proves that Windows line endings give the same chunks and ranges as LF, with no carriage
  // return left in the text. Covers: app/ai/chunk.ts: chunkMarkdown.
  it('accepts CRLF line endings', () => {
    // The same sample with CRLF endings.
    let crlf = SAMPLE.replace(/\n/g, '\r\n')
    // Chunk it.
    let chunks = chunkMarkdown(crlf)
    // Same ids and same line ranges as the LF version.
    assert.deepEqual(
      chunks.map((c) => [c.id, c.lines]),
      chunkMarkdown(SAMPLE).map((c) => [c.id, c.lines]),
    )
    // The texts are clean; a stray CR would end up in the prompt.
    assert.ok(!chunks.some((c) => c.text.includes('\r')))
  })

  // Proves that nothing is produced from nothing: an empty string or a lone heading.
  // Covers: app/ai/chunk.ts: chunkMarkdown.
  it('returns nothing for an empty document', () => {
    // No text at all.
    assert.deepEqual(chunkMarkdown(''), [])
    // A heading with no content under it.
    assert.deepEqual(chunkMarkdown('## Only a heading\n'), [])
  })

  // Proves the id slug: lowercase, ASCII, hyphens for anything else, and a fallback for a
  // heading with no usable characters. Covers: app/ai/chunk.ts: slugify.
  it('slugifies headings', () => {
    // Words with a capital and an acronym: case drops, spaces become single hyphens.
    assert.equal(slugify('RAG and LLM limitations'), 'rag-and-llm-limitations')
    // A number and a word: dot and space become one hyphen.
    assert.equal(slugify('2. Process'), '2-process')
    // Accents are stripped, punctuation dropped, no doubled or trailing hyphens.
    assert.equal(slugify('Ñandú & Co.'), 'nandu-co')
    // Nothing usable gives a fixed word instead of an empty id.
    assert.equal(slugify('***'), 'section')
  })
})

// The real article, where the sizes and the coverage matter to the RAG.
describe('chunkMarkdown on the real article', () => {
  /**
   * The corpus file, two levels up from app/ai: data/rag-wikipedia.md at the repository root.
   *
   * Called by: this file: the cases of this group
   */
  const path = new URL('../../data/rag-wikipedia.md', import.meta.url)

  // Proves that the whole article gives a few dozen chunks of a sensible median size at the
  // default 500 characters, with the contract intact, that no chunk ends on a heading line, and
  // that any chunk far over the limit is an unsplittable block: a table, a fenced block, or a
  // single paragraph with at most a heading line before it.
  // Covers: app/ai/chunk.ts: chunkMarkdown, DEFAULT_MAX_CHARS.
  it('yields a reasonable number of chunks that never cross a chapter', async () => {
    // Load the article.
    let markdown = await readFile(path, 'utf-8')
    // Chunk with the default size.
    let chunks = chunkMarkdown(markdown)
    // The contract on the real thing: no chunk crosses a "## " heading, the ranges are inside
    // the file, the texts equal their source lines and the ids are unique.
    assertInvariants(markdown, chunks)

    // About ten thousand characters at about 500 per chunk, cut at paragraph boundaries and at
    // every sub-heading, so the short sub-sections are small passages of their own.
    assert.ok(chunks.length >= 20 && chunks.length <= 35, `${chunks.length} chunks`)
    // The sizes, sorted for the median.
    let sizes = chunks.map((c) => c.text.length).sort((a, b) => a - b)
    // The middle value.
    let median = sizes[Math.floor(sizes.length / 2)]!
    // Big enough to carry a thought, never over the limit.
    assert.ok(median >= 200 && median <= DEFAULT_MAX_CHARS, `median chunk is ${median} chars`)

    // Each chunk in turn.
    for (let chunk of chunks) {
      // The last line of the chunk's text.
      let last = chunk.text.split('\n').at(-1)!
      // A heading at the end would leave its paragraph in the next chunk.
      assert.ok(!/^#{1,6} /.test(last), `${chunk.id} ends on a heading`)
      // Only the clear outliers are examined for size.
      if (chunk.text.length <= DEFAULT_MAX_CHARS * 1.25) continue
      // The text without a heading line and its blank line at the start, which are not a break.
      let body = chunk.text.replace(/^#{1,6} .*\n\n/, '')
      // A table row anywhere, a fence at the start, or no paragraph break at all.
      let whole = /^\||\n\|/.test(body) || body.startsWith('```') || !body.includes('\n\n')
      // Anything else over the limit would have had a place to cut.
      assert.ok(whole, `${chunk.id} (${chunk.text.length} chars) is a block that cannot be split`)
    }
  })

  // Proves that no chunk of the article spans two headings: after its first line, a chunk holds
  // no "## " or "### " line, so the sub-heading that names it is the heading of all its text.
  // Covers: app/ai/chunk.ts: chunkMarkdown.
  it('never puts two headings of level 2 or 3 in one chunk', async () => {
    // Load the article.
    let markdown = await readFile(path, 'utf-8')
    // Chunk with the default size.
    let chunks = chunkMarkdown(markdown)
    // Each chunk in turn.
    for (let chunk of chunks) {
      // The lines after the first one, where a second heading would show.
      let rest = chunk.text.split('\n').slice(1)
      // A heading of level 2 or 3 among them would mean the chunk crosses a section.
      assert.ok(
        !rest.some((line) => /^#{2,3} /.test(line)),
        `${chunk.id} holds a second heading`,
      )
    }
    // The headings that start a chunk are the ones that name it.
    for (let chunk of chunks) {
      // A chunk that starts on a heading line is named by that heading.
      let first = /^#{2,3} (.+)$/.exec(chunk.text.split('\n')[0]!)
      // Only chunks that start on a heading are checked here.
      if (first) assert.equal(chunk.heading, first[1], `${chunk.id} is named by its heading`)
    }
  })

  // Proves that a smaller target size gives more chunks and keeps the contract, which is what
  // CHUNK_MAX_CHARS changes in the ingest. Covers: app/ai/chunk.ts: chunkMarkdown.
  it('gives more chunks for a smaller maxChars, with the contract intact', async () => {
    // Load the article.
    let markdown = await readFile(path, 'utf-8')
    // The default size and half of it.
    let normal = chunkMarkdown(markdown)
    // Half the target size.
    let small = chunkMarkdown(markdown, { maxChars: DEFAULT_MAX_CHARS / 2 })
    // The smaller target cuts more.
    assert.ok(small.length > normal.length, `${small.length} chunks against ${normal.length}`)
    // And the contract holds at that size too.
    assertInvariants(markdown, small)
  })

  // Proves that every "## " heading of the article has chunks, that the text under the "# "
  // title is kept under the title's name, and that the sub-headings travel in the chunks.
  // Covers: app/ai/chunk.ts: chunkMarkdown.
  it('covers every chapter, the title and the sub-headings', async () => {
    // Load the article.
    let markdown = await readFile(path, 'utf-8')
    // Chunk with the default size.
    let chunks = chunkMarkdown(markdown)
    // The distinct chapter names that got chunks.
    let chapters = new Set(chunks.map((c) => c.chapter))
    // Every "## " heading of the article, as the chunker would name the chapter.
    let headings = markdown
      .split('\n')
      .filter((line) => /^## /.test(line))
      .map((line) => line.slice(3).trim())
    // The article has the chapters the RAG's questions are about.
    assert.ok(headings.length >= 5, `${headings.length} chapters`)
    // Compare the two sets heading by heading: nothing is skipped, since this article has no
    // table of contents.
    for (let heading of headings) {
      // The chapter has chunks.
      assert.ok(chapters.has(heading), `chapter "${heading}" has chunks`)
    }
    // The text under the "# " title is kept under the title's name.
    assert.ok(chapters.has('Retrieval-augmented generation'), 'the introduction is kept')
    // The sub-headings that open chunks are the ones the article declares.
    let declared = new Set(
      markdown
        .split('\n')
        .filter((line) => /^###+ /.test(line))
        .map((line) => line.replace(/^#+\s+/, '').trim()),
    )
    // A chunk's heading is its chapter or one of the sub-headings; nothing else.
    for (let chunk of chunks) {
      // The heading is the chapter's own, or a declared sub-heading.
      assert.ok(chunk.heading === chunk.chapter || declared.has(chunk.heading), chunk.id)
    }
    // At least one chunk is named by a sub-heading, so the citations can show it.
    assert.ok(chunks.some((c) => c.heading !== c.chapter), 'a sub-heading names a chunk')
  })

  // Proves that the definition sentence opens the first chunk, with the id and line range that
  // the citation will use. Covers: app/ai/chunk.ts: chunkMarkdown.
  it('puts the definition of RAG in the first chunk', async () => {
    // Load the article.
    let markdown = await readFile(path, 'utf-8')
    // Chunk with the default size.
    let chunks = chunkMarkdown(markdown)
    // The first chunk in document order.
    let first = chunks[0]
    // There is one.
    assert.ok(first, 'the article yields chunks')
    // It opens with the definition.
    assert.ok(
      first.text.startsWith('Retrieval-augmented generation (RAG) is a technique'),
      first.text.slice(0, 80),
    )
    // It is attributed to the title's chapter, with the title's slug in its id.
    assert.equal(first.chapter, 'Retrieval-augmented generation')
    // The id is the slug plus the position.
    assert.equal(first.id, 'retrieval-augmented-generation-1')
    // The title is line 1 and a blank line follows, so the first paragraph is on line 3.
    assert.equal(first.lines[0], 3)
  })

  // Proves, on a passage the RAG's questions look for, that a known sentence lands under its
  // chapter and sub-heading, inside that chapter's line span. Covers: app/ai/chunk.ts:
  // chunkMarkdown.
  it('places the chunking passage under Improvements, Chunking', async () => {
    // Load the article.
    let markdown = await readFile(path, 'utf-8')
    // Chunk with the default size.
    let chunks = chunkMarkdown(markdown)
    // The chunk with the sentence about chunking.
    let found = chunks.find((c) => c.text.includes('Chunking involves various strategies'))
    // The sentence is still in the article.
    assert.ok(found, 'the passage exists')
    // It is attributed to its chapter, which is what the citation will say first.
    assert.equal(found.chapter, 'Improvements')
    // Its sub-heading names it, which is what the citation will say second.
    assert.equal(found.heading, 'Chunking')
    // The heading line travels with the text, so the passage says what it is about.
    assert.ok(found.text.startsWith('### Chunking'), found.text.slice(0, 40))
    // Its id carries the chapter's slug.
    assert.match(found.id, /^improvements-\d+$/)
    // The chapter's span in the current article: from the line after its heading to the line
    // before the next "## " heading.
    let lines = markdown.split('\n')
    // The line number of "## Improvements" (1-based) and of the heading after it.
    let from = lines.findIndex((line) => line === '## Improvements') + 1
    // The next chapter heading, searched after the first.
    let to = lines.findIndex((line, i) => i >= from && /^## /.test(line)) + 1
    // Its lines fall inside the span.
    assert.ok(found.lines[0] > from && found.lines[1] < to, `lines ${found.lines} are inside it`)
  })
})
