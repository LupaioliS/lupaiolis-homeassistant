import { it } from './it';
import { en } from './en';

export type Locale = 'it' | 'en';

const translations: Record<Locale, typeof it> = { it, en };

let currentLocale: Locale = 'it';

export async function initLocale(): Promise<void> {
	try {
		const res = await fetch('/api/locale');
		if (res.ok) {
			const data = await res.json();
			if (data.locale && translations[data.locale as Locale]) {
				currentLocale = data.locale as Locale;
			}
		}
	} catch { /* fallback to default */ }
}

export function getLocale(): Locale {
	return currentLocale;
}

export function t(key: string): string {
	const keys = key.split('.');
	let value: unknown = translations[currentLocale];
	for (const k of keys) {
		if (value && typeof value === 'object') {
			value = (value as Record<string, unknown>)[k];
		} else {
			return key;
		}
	}
	return typeof value === 'string' ? value : key;
}
