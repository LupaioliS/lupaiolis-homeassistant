import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	root: './src/client',
	base: './',
	build: {
		outDir: '../../dist/client',
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		host: true,
		hmr: {
			clientPort: 443,
		},
		allowedHosts: 'all',
		proxy: {
			'/api/events': {
				target: 'http://localhost:3000',
				headers: { 'Connection': 'keep-alive' },
			},
			'/api/': 'http://localhost:3000',
			'/uploads/': 'http://localhost:3000',
		},
	},
});
