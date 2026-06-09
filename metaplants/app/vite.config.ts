import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	root: './src/client',
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
			'/api/': 'http://localhost:3000',
		},
	},
});
