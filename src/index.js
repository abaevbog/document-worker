import {
	writeAnnotations,
	importAnnotations,
	deletePages,
	rotatePages,
	getFulltext,
	getRecognizerData,
	getStructure as pdfGetStructure,
	importCitaviAnnotations,
	importMendeleyAnnotations,
	createSelectionAnnotations as createPDFAnnotations,
	hasAnnotations,
	renderAnnotations,
	renderArea
} from './pdf/index.js';
import { canvasToPNGArrayBuffer } from './pdf/render-runtime.js';
import { getEpubStructure } from './dom/epub/index';
import { getSnapshotStructure } from './dom/snapshot/index';
import { packStructuredDocumentText } from '../structured-document-text/src/pack/writer.js';
import { openStructuredDocumentTextPack } from '../structured-document-text/src/read.js';
import { getChunks, getAnchorContent, getAnchorSegments, getAnchorPositions, getPositionRanges, getRangeSelection, CHUNKER_VERSION } from '../structured-document-text/src/chunker/index.js';
import { deflateSync, inflateSync } from 'fflate';

const EPUB_CONTENT_TYPE = 'application/epub+zip';
const SOURCE_HASH_RE = /^[0-9a-f]{32}$/u;

function isEpub(contentType) {
	return contentType === EPUB_CONTENT_TYPE;
}

function isSnapshot(contentType) {
	return contentType === 'application/xhtml+xml' || contentType?.endsWith('html');
}

function assertSourceHash(value) {
	if (typeof value !== 'string' || !SOURCE_HASH_RE.test(value)) {
		throw new Error('options.sourceHash must be a 32-character lowercase MD5 hex string');
	}
}

function createProgressReporter(onProgress) {
	if (typeof onProgress !== 'function') {
		return () => {};
	}
	let lastProgress = -1;
	return (progress) => {
		progress = Math.round(Number(progress));
		if (!Number.isFinite(progress)) {
			return;
		}
		progress = Math.max(0, Math.min(100, progress));
		if (progress <= lastProgress) {
			return;
		}
		lastProgress = progress;
		try {
			onProgress(progress);
		}
		catch {
			// Progress reporting is best-effort and must not affect extraction.
		}
	};
}

async function createStructuredDocumentText(buf, options = {}) {
	let {
		contentType,
		password,
		dataProvider,
		nativeONNXRun,
		sourceHash,
		onProgress,
	} = options;
	assertSourceHash(sourceHash);

	if (isEpub(contentType) || isSnapshot(contentType)) {
		return isEpub(contentType)
			? await getEpubStructure(buf, { sourceHash })
			: await getSnapshotStructure(buf, contentType, { sourceHash });
	}
	return await pdfGetStructure(buf, password, dataProvider, {
		nativeONNXRun,
		sourceHash,
		onProgress,
	});
}

async function getStructuredDocumentText(buf, options = {}) {
	let onProgress = createProgressReporter(options.onProgress);
	onProgress(0);
	let structure = await createStructuredDocumentText(buf, {
		contentType: options.contentType,
		password: options.password,
		dataProvider: options.dataProvider,
		nativeONNXRun: options.nativeONNXRun,
		sourceHash: options.sourceHash,
		onProgress,
	});
	onProgress(95);
	let buffer = packStructuredDocumentText(structure, {
		destructive: true,
		deflate: bytes => deflateSync(bytes),
	});
	onProgress(100);
	return { buf: buffer };
}

/**
 * Cut a structured document text pack into chunks for embedding, off the
 * caller's thread: the pack is opened and materialized here, so the caller
 * neither inflates nor parses it.
 *
 * @param {ArrayBuffer} buf - The pack, as getStructuredDocumentText() produces it
 * @param {Object} [options]
 * @param {Object[]} [options.positions] - Reader positions, such as
 *   annotations', to locate in the structure
 * @param {Boolean} [options.segments=false] - Give each chunk its
 *   `segments` too, the structure of its text
 * @returns {Promise<{ chunks: Object[], positionRanges: Array[], sourceHash: string, chunkerVersion: number }>} -
 *   Each chunk with `positions`, the reader positions its anchor resolves
 *   to; `positionRanges` per given position, in order, the content ranges
 *   of the text it covers, one per text node, or null where it covers none
 */
async function getStructuredDocumentTextChunks(buf, { positions = [], segments = false } = {}) {
	let structure = await materializePack(buf);
	let chunks = getChunks(structure).map(chunk => ({
		...chunk,
		positions: getAnchorPositions(structure, chunk.anchor),
		...(segments ? { segments: getAnchorSegments(structure, chunk.anchor) } : {}),
	}));
	return {
		chunks,
		positionRanges: getPositionRanges(structure, positions),
		sourceHash: structure.metadata.source.hash,
		chunkerVersion: CHUNKER_VERSION,
	};
}

/**
 * Read chunk anchors back from a structured document text pack, off the
 * caller's thread
 *
 * @param {ArrayBuffer} buf - The pack, as getStructuredDocumentText() produces it
 * @param {Array<Object|null>} anchors - Chunk anchors, as getChunks() gives them
 * @param {Object} [options]
 * @param {Object[]} [options.positions] - Reader positions, such as
 *   annotations', to locate in the structure
 * @returns {Promise<{ chunks: Array<Object|null>, positionRanges: Array[] }>} -
 *   `chunks` per anchor, in order:
 *   - `text`: the chunk's text as the document reads it back
 *   - `outlinePath`, `pageLabel`: the headings over the text's start and
 *     the page it starts on
 *   - `sections`: where each section in the text starts
 *   - `segments`: the structure of `text`, one per stretch of it from a
 *     text node, with the node, the blocks over it and its style
 *   - `positions`: the reader positions the whole chunk resolves to, one
 *     per page for a PDF, selectors for EPUBs and snapshots
 *   or null where the anchor doesn't resolve, as after the file changed;
 *   `positionRanges` per given position, in order, the content ranges of
 *   the text it covers, one per text node, or null where it covers none
 */
async function readStructuredDocumentTextAnchors(buf, anchors, { positions = [] } = {}) {
	let structure = await materializePack(buf);
	let chunks = anchors.map((anchor) => {
		let content = anchor ? getAnchorContent(structure, anchor) : null;
		if (!content?.text) {
			return null;
		}
		return {
			...content,
			segments: getAnchorSegments(structure, anchor),
			positions: getAnchorPositions(structure, anchor),
		};
	});
	return { chunks, positionRanges: getPositionRanges(structure, positions) };
}

/**
 * Locate stretches of a document's structured text, each given as content
 * ranges: the text they cover and the source positions the reader would
 * store a selection of it as -- one per page of a PDF, or per two pages
 * where it runs onto the next one, one per section of an EPUB, one for a
 * snapshot
 *
 * @param {ArrayBuffer} buf - The pack, as getStructuredDocumentText() produces it
 * @param {Array[][]} selections - Per stretch, content ranges [start, end]
 *     of points [...ref, offset] into text nodes, in text order
 * @returns {Promise<Array<Object|null>>} - Per stretch, in order,
 *     { text, outlinePath, sections, pageLabel, positions }, or null where
 *     its ranges don't resolve
 */
async function locateStructuredDocumentTextRanges(buf, selections) {
	let structure = await materializePack(buf);
	return selections.map(ranges => getRangeSelection(structure, ranges));
}

/**
 * Annotate content ranges of a document's structured text: one annotation
 * in the reader's form per position the reader would store the selection
 * as -- per page of a PDF, or per two pages where it runs onto the next
 * one, per section of an EPUB, one for a snapshot -- with the text its
 * position covers. A PDF's page label and sort index
 * come from the file's page characters, as for an annotation made in the
 * reader. An EPUB's or snapshot's sort index is provisional, a zero offset
 * placing it at the top of its section or document until the reader
 * replaces it on opening the file.
 *
 * @param {ArrayBuffer} packBuf - The pack, as getStructuredDocumentText() produces it
 * @param {ArrayBuffer|null} fileBuf - The attachment file; needed for a PDF
 * @param {Object} options
 * @param {Array[]} options.ranges - The text selected: content ranges
 *     [start, end] of points [...ref, offset] into text nodes, in text order
 * @param {String} [options.type='highlight'] - 'highlight' or 'underline'
 * @param {String} [options.color]
 * @param {String} [options.password]
 * @param {Function} options.dataProvider
 * @returns {Promise<{ text: string, annotations: Object[] } | null>} - The
 *     selected text and its annotations, each with type, color, text,
 *     comment, tags, position, sortIndex and pageLabel; null when the
 *     ranges don't resolve
 */
async function createAnnotations(packBuf, fileBuf, options) {
	let { ranges, type = 'highlight', color, password, dataProvider } = options;
	if (!['highlight', 'underline'].includes(type)) {
		throw new Error(`Unsupported selection annotation type '${type}'`);
	}
	let structure = await materializePack(packBuf);
	let selection = getRangeSelection(structure, ranges);
	if (!selection) {
		return null;
	}
	let format = structure.metadata?.processor?.type;
	// One annotation per position, with the text it covers in the structure
	// and the page that text starts on
	let annotations = selection.positions.map((position) => {
		let content = getAnchorContent(structure, anchorOf(format, position));
		return {
			type,
			color,
			text: content?.text ?? '',
			comment: '',
			tags: [],
			pageLabel: content?.pageLabel ?? '',
			position,
		};
	}).filter(annotation => annotation.text);
	if (format === 'pdf') {
		if (!fileBuf) {
			throw new Error('The PDF file is needed to annotate it');
		}
		annotations = await createPDFAnnotations(fileBuf, annotations, password, dataProvider);
	}
	else {
		for (let annotation of annotations) {
			annotation.sortIndex = provisionalSortIndex(format, annotation.position);
		}
	}
	return { text: selection.text, annotations };
}

// A position as an anchor, to read back the text it covers
function anchorOf(format, position) {
	if (format !== 'pdf') {
		return { selectors: [position] };
	}
	let { pageIndex, rects, nextPageRects = [] } = position;
	return { pageRects: [
		...rects.map(rect => [pageIndex, ...rect]),
		...nextPageRects.map(rect => [pageIndex + 1, ...rect]),
	] };
}

// The reader's sort index for a position with a zero offset: the top of the
// EPUB section the position's CFI starts in, or of the snapshot. The section
// is the spine item the CFI's second step counts to -- the spine's element
// children by even numbers from 2 -- as the reader numbers them
function provisionalSortIndex(format, position) {
	if (format === 'epub') {
		let step = position.value?.match(/^epubcfi\(\/\d+\/(\d+)/)?.[1];
		if (!step) {
			throw new Error(`Not a CFI into the spine: ${position.value}`);
		}
		return String(Number(step) / 2 - 1).padStart(5, '0') + '|00000000';
	}
	return '0000000';
}

async function materializePack(buf) {
	let reader = await openStructuredDocumentTextPack(new Uint8Array(buf), {
		inflate: bytes => inflateSync(bytes),
	});
	return reader.materialize();
}

const pdf = {
	writeAnnotations,
	importAnnotations,
	deletePages,
	rotatePages,
	getFulltext,
	getRecognizerData,
	importCitaviAnnotations,
	importMendeleyAnnotations,
	hasAnnotations,
	renderAnnotations,
	renderArea,
};

export {
	pdf,
	getStructuredDocumentText,
	getStructuredDocumentTextChunks,
	readStructuredDocumentTextAnchors,
	locateStructuredDocumentTextRanges,
	createAnnotations,
};

function errObject(err) {
	return JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)));
}

let dataCache = {};
async function fetchData(path) {
	if (dataCache[path]) {
		return dataCache[path];
	}
	let data = await query('FetchData', path);
	dataCache[path] = data;
	return data;
}

async function renderedAnnotationSaver(libraryID, annotationKey, buf) {
	return await query('SaveRenderedAnnotation', { libraryID, annotationKey, buf }, [buf]);
}

if (typeof self !== 'undefined') {
	let promiseID = 0;
	let waitingPromises = {};

	self.query = async function (action, data, transfer) {
		return new Promise(function (resolve, reject) {
			promiseID++;
			waitingPromises[promiseID] = { resolve, reject };
			self.postMessage({ id: promiseID, action, data }, transfer);
		});
	};

	self.onmessage = async function (e) {
		let message = e.data;

		if (message.responseID) {
			let waiting = waitingPromises[message.responseID];
			if (waiting) {
				delete waitingPromises[message.responseID];
				if (message.error) {
					waiting.reject(message.error);
				}
				else {
					waiting.resolve(message.data);
				}
			}
			return;
		}

		if (message.action === 'pdf.writeAnnotations') {
			let buf;
			try {
				buf = await writeAnnotations(
					message.data.buf,
					message.data.annotations,
					message.data.password,
					fetchData
				);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				console.log(e);
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.importAnnotations') {
			try {
				let { buf, existingAnnotations, password, transfer } = message.data;
				let data = await importAnnotations(
					buf,
					existingAnnotations,
					password,
					transfer,
					fetchData
				);
				self.postMessage({ responseID: message.id, data }, data.buf ? [data.buf] : []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.importMendeleyAnnotations') {
			try {
				let annotations = await importMendeleyAnnotations(
					message.data.buf,
					message.data.mendeleyAnnotations,
					message.data.password,
					fetchData
				);
				self.postMessage({
					responseID: message.id,
					data: annotations
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.importCitaviAnnotations') {
			try {
				let annotations = await importCitaviAnnotations(
					message.data.buf,
					message.data.citaviAnnotations,
					message.data.password,
					fetchData
				);
				self.postMessage({
					responseID: message.id,
					data: annotations
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.deletePages') {
			try {
				let buf = await deletePages(message.data.buf, message.data.pageIndexes, message.data.password);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.rotatePages') {
			try {
				let buf = await rotatePages(
					message.data.buf,
					message.data.pageIndexes,
					message.data.degrees,
					message.data.password
				);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.getFulltext') {
			try {
				let data = await getFulltext(
					message.data.buf,
					message.data.maxPages || message.data.pageIndexes,
					message.data.password,
					fetchData
				);
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.getRecognizerData') {
			try {
				let data = await getRecognizerData(
					message.data.buf,
					message.data.password,
					fetchData
				);
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'getStructuredDocumentText') {
			try {
				let reportProgress = !!message.data.reportProgress;
				let data = await getStructuredDocumentText(message.data.buf, {
					contentType: message.data.contentType,
					password: message.data.password,
					dataProvider: fetchData,
					nativeONNXRun: message.data.nativeONNX ? data => query('NativeONNXRun', data) : null,
					sourceHash: message.data.sourceHash,
					onProgress: reportProgress
						? progress => self.postMessage({
							progressID: message.id,
							data: { progress },
						}, [])
						: null,
				});
				self.postMessage({
					responseID: message.id,
					data
				}, [data.buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'sdt.getChunks') {
			try {
				let data = await getStructuredDocumentTextChunks(
					message.data.buf,
					{ positions: message.data.positions, segments: message.data.segments }
				);
				self.postMessage({
					responseID: message.id,
					data
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'sdt.readAnchors') {
			try {
				let data = await readStructuredDocumentTextAnchors(
					message.data.buf,
					message.data.anchors,
					{ positions: message.data.positions }
				);
				self.postMessage({
					responseID: message.id,
					data
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'sdt.locateRanges') {
			try {
				let data = await locateStructuredDocumentTextRanges(message.data.buf, message.data.selections);
				self.postMessage({
					responseID: message.id,
					data
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'createAnnotations') {
			try {
				let { packBuf, fileBuf, ...options } = message.data;
				let data = await createAnnotations(packBuf, fileBuf, { ...options, dataProvider: fetchData });
				self.postMessage({
					responseID: message.id,
					data
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.renderAnnotations') {
			try {
				let data = await renderAnnotations(
					message.data.libraryID,
					message.data.buf,
					message.data.annotations,
					message.data.password,
					fetchData,
					renderedAnnotationSaver
				);
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.renderArea') {
			try {
				let canvas = await renderArea(
					message.data.buf,
					message.data.pageIndex,
					message.data.rect,
					{
						password: message.data.password,
						scale: message.data.scale,
						dataProvider: fetchData
					}
				);
				if (!canvas) {
					self.postMessage({ responseID: message.id, data: { buf: null } }, []);
					return;
				}
				let buf = await canvasToPNGArrayBuffer(canvas);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.hasAnnotations') {
			try {
				let data = {
					hasAnnotations: await hasAnnotations(
						message.data.buf,
						message.data.password
					)
				};
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
	};
}
