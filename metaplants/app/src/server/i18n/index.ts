import { mqtt_it } from './mqtt_it';
import { mqtt_en } from './mqtt_en';

export type MqttLocale = 'it' | 'en';

const translations: Record<MqttLocale, typeof mqtt_it> = { it: mqtt_it, en: mqtt_en };

const locale: MqttLocale = (process.env.METAPLANTS_LANG || process.env.LANG?.split('.')[0]?.split('_')[0] || 'it') as MqttLocale;

const currentTranslation = translations[locale] || translations.it;

export function mt(key: string, vars?: Record<string, string | number>): string {
	const keys = key.split('.');
	let value: unknown = currentTranslation;
	for (const k of keys) {
		if (value && typeof value === 'object') {
			value = (value as Record<string, unknown>)[k];
		} else {
			return key;
		}
	}
	if (typeof value !== 'string') return key;
	if (!vars) return value;
	return value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}
