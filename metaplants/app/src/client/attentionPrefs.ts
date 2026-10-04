/**
 * Quali bisogni finiscono in "Hanno bisogno di attenzioni".
 *
 * La concimazione è spenta di default: scade a calendario, non dal terreno, e
 * con tutte le piante in ritardo di qualche giorno sul concime il banner diventa
 * un elenco fisso che si smette di leggere — proprio quello che non deve fare
 * quando una pianta ha davvero sete.
 *
 * È una preferenza di chi guarda, non della pianta: vive nel browser. Se lo
 * storage non c'è (finestra privata, dati cancellati) valgono i default.
 */

export type AttentionKind = 'water' | 'fertilize' | 'health';
export type AttentionPrefs = Record<AttentionKind, boolean>;

export const ATTENTION_KINDS: AttentionKind[] = ['water', 'fertilize', 'health'];

export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = { water: true, fertilize: false, health: true };

const STORAGE_KEY = 'metaplants.attention';

export function loadAttentionPrefs(): AttentionPrefs {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_ATTENTION_PREFS;
		const parsed = JSON.parse(raw) as Partial<AttentionPrefs>;
		const prefs = { ...DEFAULT_ATTENTION_PREFS };
		for (const kind of ATTENTION_KINDS) {
			if (typeof parsed[kind] === 'boolean') prefs[kind] = parsed[kind];
		}
		return prefs;
	} catch {
		return DEFAULT_ATTENTION_PREFS;
	}
}

export function saveAttentionPrefs(prefs: AttentionPrefs): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch { /* storage non disponibile: la scelta vale fino alla chiusura */ }
}
