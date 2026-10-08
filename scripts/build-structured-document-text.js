import { mkdir } from 'node:fs/promises';
import * as esbuild from 'esbuild';

// The pack reader and the chunker, bundled separately for the main thread
const bundles = {
	'structured-document-text/src/read.js': 'build/structured-document-text.js',
	'structured-document-text/src/chunker/index.js': 'build/structured-document-text-chunker.js',
};

await mkdir('build', { recursive: true });

for (let [entryPoint, outfile] of Object.entries(bundles)) {
	await esbuild.build({
		entryPoints: [entryPoint],
		bundle: true,
		platform: 'browser',
		target: ['firefox140'],
		format: 'cjs',
		outfile,
	});
}
