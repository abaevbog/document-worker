export const mainExportNames = [
	'pdf',
	'getStructuredDocumentText',
	'getStructuredDocumentTextChunks',
	'readStructuredDocumentTextAnchors',
	'locateStructuredDocumentTextRanges',
	'createAnnotations',
];

export const mainAbsentExportNames = [
	'getFulltext',
	'getStructure',
	'getStructuredDocumentTextJSON',
	'getEpubFulltext',
	'getSnapshotFulltext',
];

export const mainPdfNamespaceExportNames = [
	'writeAnnotations',
	'importAnnotations',
	'deletePages',
	'rotatePages',
	'getFulltext',
	'getRecognizerData',
	'importCitaviAnnotations',
	'importMendeleyAnnotations',
	'hasAnnotations',
	'renderAnnotations',
	'renderArea',
];

export const workerActionNames = [
	'pdf.writeAnnotations',
	'pdf.importAnnotations',
	'pdf.importMendeleyAnnotations',
	'pdf.importCitaviAnnotations',
	'pdf.deletePages',
	'pdf.rotatePages',
	'pdf.getFulltext',
	'pdf.getRecognizerData',
	'getStructuredDocumentText',
	'sdt.getChunks',
	'sdt.readAnchors',
	'sdt.locateRanges',
	'createAnnotations',
	'pdf.renderAnnotations',
	'pdf.renderArea',
	'pdf.hasAnnotations',
];
