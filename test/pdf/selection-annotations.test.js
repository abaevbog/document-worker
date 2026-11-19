import '../../scripts/pdfjs-setup.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
	getStructuredDocumentText,
	getStructuredDocumentTextChunks,
	readStructuredDocumentTextAnchors,
	createAnnotations,
} from '../../src/index.js';
import { readFixtureArrayBuffer, readFixtureSourceHash } from '../helpers/fixtures.js';
import { dataProvider } from '../helpers/data-provider.js';

const PDF = ['pdf', 'full', '1.pdf'];
const SORT_INDEX = /^\d{5}\|\d{6}\|\d{5}$/;

describe('annotating content ranges in a document\'s structure', { timeout: 120000 }, () => {
	let fileBuf, packBuf, chunk, recovered, segments;

	// The chunk of the fixture that opens its abstract, with the text its
	// anchor reads back: what offsets index
	before(async () => {
		fileBuf = readFixtureArrayBuffer(...PDF);
		({ buf: packBuf } = await getStructuredDocumentText(fileBuf.slice(0), {
			contentType: 'application/pdf',
			dataProvider,
			sourceHash: readFixtureSourceHash(...PDF),
		}));
		let { chunks } = await getStructuredDocumentTextChunks(packBuf);
		chunk = chunks.find(chunk => chunk.text.includes('statically typed languages'));
		assert.ok(chunk?.anchor, 'Fixture must chunk its abstract with an anchor');
		({ chunks: [{ text: recovered, segments }] } = await readStructuredDocumentTextAnchors(packBuf, [chunk.anchor]));
	});

	// The ranges of the segments between two offsets into the recovered
	// text, one per segment
	let rangesAt = (segments, start, end) => {
		let point = (segment, offset) => [...segment.ref, segment.offset + offset - segment.start];
		return segments.filter(segment => Math.max(start, segment.start) < Math.min(end, segment.end))
			.map(segment => [point(segment, Math.max(start, segment.start)), point(segment, Math.min(end, segment.end))]);
	};
	// Annotate the text between two offsets of the chunk
	let annotate = (start, end, options = {}) => createAnnotations(packBuf, fileBuf, {
		ranges: rangesAt(segments, start, end), dataProvider, ...options,
	});
	let offsets = (text, phrase) => [text.indexOf(phrase), text.indexOf(phrase) + phrase.length];

	it('describes the structure of a chunk when asked, in the cut and in the read-back', async () => {
		assert.ok(segments.length);
		assert.equal(segments.at(-1).end, recovered.length);
		assert.ok(!('segments' in chunk));
		let { chunks } = await getStructuredDocumentTextChunks(packBuf.slice(0), { segments: true });
		assert.deepEqual(chunks.find(other => other.text === chunk.text).segments, segments);
	});

	it('makes a highlight over the selected words, placed as the reader places one', async () => {
		let phrase = 'Compilers for statically typed languages rely on type information to generate efficient machine code';
		let result = await annotate(...offsets(recovered, phrase));
		assert.equal(result.text, phrase);
		assert.equal(result.annotations.length, 1);
		let [annotation] = result.annotations;
		assert.equal(annotation.type, 'highlight');
		assert.equal(annotation.text, phrase);
		assert.equal(annotation.comment, '');
		assert.deepEqual(annotation.tags, []);
		assert.equal(annotation.pageLabel, '1');
		assert.equal(annotation.position.pageIndex, 0);
		assert.equal(annotation.position.nextPageRects, undefined);
		// Two lines, within the page, at most three decimals
		assert.equal(annotation.position.rects.length, 2);
		for (let rect of annotation.position.rects) {
			assert.ok(rect.every(n => n >= 0 && n <= 800 && Number.isInteger(n * 1000)), JSON.stringify(rect));
		}
		// The same character offset as the fixture's embedded highlight of
		// these words gets on import, which is what the reader sorts by
		assert.match(annotation.sortIndex, SORT_INDEX);
		assert.equal(annotation.sortIndex.split('|')[1], '002514');
	});

	it('makes one highlight of a selection running onto the next page, as the reader does', async () => {
		let { chunks } = await getStructuredDocumentTextChunks(packBuf.slice(0), { segments: true });
		let pagesOf = chunk => [...new Set(chunk.anchor?.pageRects.map(rect => rect[0]))];
		let across = chunks.find(chunk => pagesOf(chunk).length === 2);
		assert.deepEqual(pagesOf(across), [0, 1], 'Fixture must chunk text across its first two pages');
		let { chunks: [{ text, segments }] } = await readStructuredDocumentTextAnchors(packBuf, [across.anchor]);
		let ranges = rangesAt(segments, 0, text.length);
		let result = await createAnnotations(packBuf, fileBuf, { ranges, dataProvider });
		assert.equal(result.annotations.length, 1);
		let [annotation] = result.annotations;
		assert.equal(annotation.position.pageIndex, 0);
		assert.ok(annotation.position.nextPageRects.length);
		for (let rect of [...annotation.position.rects, ...annotation.position.nextPageRects]) {
			assert.ok(rect.every(n => Number.isInteger(n * 1000)), JSON.stringify(rect));
		}
		// Placed by its first page, with the text of both
		assert.equal(annotation.pageLabel, '1');
		assert.match(annotation.sortIndex, /^00000\|/);
		assert.equal(annotation.text, result.text);
		// Its position reads back from the selection's first point to its last
		let { positionRanges: [found] } = await readStructuredDocumentTextAnchors(packBuf, [across.anchor],
			{ positions: [annotation.position] });
		assert.deepEqual(found[0][0], ranges[0][0]);
		assert.deepEqual(found.at(-1)[1], ranges.at(-1)[1]);
	});

	it('takes the type and color given', async () => {
		let { annotations: [annotation] } = await annotate(...offsets(recovered, 'statically typed'), { type: 'underline', color: '#ff6666' });
		assert.equal(annotation.type, 'underline');
		assert.equal(annotation.color, '#ff6666');
		assert.equal(annotation.text, 'statically typed');
		await assert.rejects(annotate(...offsets(recovered, 'statically typed'), { type: 'note' }), /Unsupported/);
	});

	it('gives nothing for a selection that does not resolve', async () => {
		assert.equal(await annotate(5, 5), null);
		for (let ranges of [null, [], [[[999, 0, 0], [999, 0, 3]]], [[[...segments[0].ref, 5], [...segments[0].ref, 2]]]]) {
			assert.equal(await createAnnotations(packBuf, fileBuf, { ranges, dataProvider }), null);
		}
	});

	it('reads back where its annotation falls in the structure', async () => {
		let { annotations: [annotation] } = await annotate(...offsets(recovered, 'statically typed'));
		let elsewhere = { pageIndex: 0, rects: [[0, 0, 1, 1]] };
		let { chunks: [read], positionRanges } = await readStructuredDocumentTextAnchors(packBuf, [chunk.anchor],
			{ positions: [annotation.position, elsewhere, null] });
		assert.equal(read.text, recovered);
		// The ranges the selection was made from
		let ranges = rangesAt(segments, ...offsets(recovered, 'statically typed'));
		assert.deepEqual(positionRanges, [ranges, null, null]);
		// Nothing asked, nothing found
		let plain = await readStructuredDocumentTextAnchors(packBuf, [chunk.anchor]);
		assert.deepEqual(plain.positionRanges, []);
		// The cut finds the same
		let cut = await getStructuredDocumentTextChunks(packBuf, { positions: [annotation.position, elsewhere] });
		assert.deepEqual(cut.positionRanges, [ranges, null]);
		assert.ok(cut.chunks.every(other => !('overlaps' in other)));
	});

	// EPUBs and snapshots are annotated from the pack alone, one annotation
	// per position with the text it covers; only the reader can count the
	// sort index, so the one given is provisional -- a zero offset at the
	// top of the section or document, for the reader to replace
	for (let [format, parts, contentType] of [
		['epub', ['epub', '1.epub'], 'application/epub+zip'],
		['snapshot', ['snapshot', '1.html'], 'text/html'],
	]) {
		it(`annotates a selection across blocks of ${format === 'epub' ? 'an EPUB' : 'a snapshot'} as one annotation at the top of its ${format === 'epub' ? 'section' : 'document'}`, async () => {
			let { buf } = await getStructuredDocumentText(readFixtureArrayBuffer(...parts), {
				contentType, dataProvider, sourceHash: readFixtureSourceHash(...parts),
			});
			let { chunks } = await getStructuredDocumentTextChunks(buf.slice(0), { segments: true });
			// The chunk over the most blocks, selected from inside its first
			// word to inside its last
			let blocks = chunk => new Set(chunk.segments.map(s => s.blocks.at(-1).ref.join())).size;
			let chunk = chunks.filter(chunk => chunk.anchor).sort((a, b) => blocks(b) - blocks(a))[0];
			assert.ok(blocks(chunk) > 1, 'Fixture must chunk across blocks');
			let [first, last] = [chunk.segments[0], chunk.segments.at(-1)];
			let ranges = rangesAt(chunk.segments, first.start + 1, last.end - 1);
			let result = await createAnnotations(buf, null, { ranges, dataProvider, color: '#ff6666' });
			assert.ok(result.text.includes('\n\n'), 'Selection must cross blocks');
			assert.equal(result.annotations.length, 1);
			// The annotation covers the selection and whatever the document
			// has between the blocks selected
			for (let annotation of result.annotations) {
				assert.deepEqual([annotation.type, annotation.color, annotation.comment, annotation.tags, annotation.pageLabel],
					['highlight', '#ff6666', '', [], '']);
				let [head, tail] = [result.text.split('\n\n')[0], result.text.split('\n\n').at(-1)];
				assert.ok(annotation.text.startsWith(head) && annotation.text.endsWith(tail), annotation.text);
				if (format === 'epub') {
					let [, step] = annotation.position.value.match(/^epubcfi\(\/\d+\/(\d+)!/);
					assert.equal(annotation.sortIndex, String(step / 2 - 1).padStart(5, '0') + '|00000000');
				}
				else {
					assert.equal(annotation.position.type, 'TextPositionSelector');
					assert.equal(annotation.sortIndex, '0000000');
				}
			}
			// Its position reads back from the selection's first point to its last
			let { positionRanges: [found] } = await readStructuredDocumentTextAnchors(buf, [chunk.anchor],
				{ positions: [result.annotations[0].position] });
			assert.deepEqual(found[0][0], ranges[0][0]);
			assert.deepEqual(found.at(-1)[1], ranges.at(-1)[1]);
		});
	}
});
