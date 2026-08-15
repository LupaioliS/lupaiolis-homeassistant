/**
 * Ridimensiona e ricomprime le foto nel browser prima di caricarle.
 *
 * Una foto scattata col telefono pesa 3-8 MB per 4000px di lato, mentre in scheda
 * viene mostrata a 160px di altezza: senza questo passaggio si carica e si riscarica
 * ogni volta un'immagine ~30 volte più grande del necessario.
 *
 * In caso di qualsiasi problema si restituisce il file originale: meglio un upload
 * pesante che un upload fallito.
 */

// Abbondante per lo zoom sulla foto, ma un ordine di grandezza sotto l'originale.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;
// Sotto questa soglia la ricompressione non vale il rischio di perdere qualità.
const SKIP_BELOW_BYTES = 300 * 1024;

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
	if (typeof createImageBitmap === 'function') {
		// imageOrientation: le foto dei telefoni sono spesso ruotate via EXIF.
		return createImageBitmap(file, { imageOrientation: 'from-image' });
	}
	const url = URL.createObjectURL(file);
	try {
		return await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('decode failed'));
			img.src = url;
		});
	} finally {
		// Il bitmap è già decodificato: l'URL può essere revocato subito.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareImageForUpload(file: File): Promise<File> {
	if (!file.type.startsWith('image/')) return file;
	// Le GIF perderebbero l'animazione passando dal canvas.
	if (file.type === 'image/gif') return file;
	if (file.size <= SKIP_BELOW_BYTES) return file;

	let source: ImageBitmap | HTMLImageElement | null = null;
	try {
		source = await loadBitmap(file);
		const width = source.width;
		const height = source.height;
		if (!width || !height) return file;

		const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(width * scale);
		canvas.height = Math.round(height * scale);

		const ctx = canvas.getContext('2d');
		if (!ctx) return file;
		ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

		const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
		// Se la ricompressione non guadagna nulla (es. foto già ottimizzata), si tiene l'originale.
		if (!blob || blob.size >= file.size) return file;

		const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
		return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
	} catch {
		return file;
	} finally {
		if (source && 'close' in source) source.close();
	}
}
