const esbuild = require("esbuild");
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * @type {import('esbuild').Plugin}
 */
const copyHtmlPlugin = {
	name: 'copy-html',
	setup(build) {
		build.onEnd(() => {
			const srcPath = path.join(__dirname, 'src', 'chatView.html');
			const destDir = path.join(__dirname, 'dist', 'src');
			const destPath = path.join(destDir, 'chatView.html');
			
			// Create the dist/src directory if it doesn't exist
			if (!fs.existsSync(destDir)) {
				fs.mkdirSync(destDir, { recursive: true });
			}
			
			// Copy the HTML file
			if (fs.existsSync(srcPath)) {
				fs.copyFileSync(srcPath, destPath);
				console.log('✅ Copied chatView.html to dist/src/');
			} else {
				console.warn('⚠️  chatView.html not found at:', srcPath);
			}
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
			copyHtmlPlugin, // Add this plugin
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});