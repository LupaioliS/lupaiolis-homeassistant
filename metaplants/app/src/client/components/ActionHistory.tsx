import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Plant, PlantAction, PlantActionOptions, PlantActionPatch, WaterSource } from '../../shared/types';
import { api } from '../api';
import { t, getLocale } from '../i18n';

type ActionType = PlantAction['type'];

const ACTION_TYPES: ActionType[] = ['water', 'fertilize', 'repot', 'prune'];
const WATER_SOURCES: WaterSource[] = ['manual', 'rain', 'irrigation'];

const TYPE_EMOJI: Record<ActionType, string> = { water: '💧', fertilize: '🧪', repot: '🪴', prune: '✂️' };
const SOURCE_EMOJI: Record<WaterSource, string> = { manual: '💧', rain: '🌧️', irrigation: '🚿' };

/** Dove finisce la quantità: ogni tipo ne ha una sola, la potatura nessuna. */
const AMOUNT_FIELD = {
	water: 'amountMl',
	fertilize: 'amountGrams',
	repot: 'potSizeCm',
	prune: null,
} as const satisfies Record<ActionType, 'amountMl' | 'amountGrams' | 'potSizeCm' | null>;

const AMOUNT_UNIT: Record<ActionType, string> = { water: 'ml', fertilize: 'g', repot: 'cm', prune: '' };

interface Draft {
	plantId: string;
	type: ActionType;
	/** Valore di un <input type="datetime-local">, quindi ora locale senza fuso. */
	date: string;
	amount: string;
	source: WaterSource;
	notes: string;
}

/** ISO → valore per <input type="datetime-local">, in ora locale. */
function toLocalInput(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
	const time = new Date(value).getTime();
	return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parseAmount(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === '') return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

/** `null` svuota il campo: da tabella un input vuoto vuole dire "cancellalo". */
function amountPatch(type: ActionType, amount: number | null): PlantActionPatch {
	switch (type) {
		case 'water': return { amountMl: amount };
		case 'fertilize': return { amountGrams: amount };
		case 'repot': return { potSizeCm: amount };
		default: return {};
	}
}

function amountOptions(type: ActionType, amount: number | null): PlantActionOptions {
	if (amount == null) return {};
	switch (type) {
		case 'water': return { amountMl: amount };
		case 'fertilize': return { amountGrams: amount };
		case 'repot': return { potSizeCm: amount };
		default: return {};
	}
}

function draftOf(action: PlantAction): Draft {
	const field = AMOUNT_FIELD[action.type];
	const amount = field ? action[field] : undefined;
	return {
		plantId: action.plantId,
		type: action.type,
		date: toLocalInput(action.date),
		amount: amount == null ? '' : String(amount),
		source: action.source ?? 'manual',
		notes: action.notes ?? '',
	};
}

interface ActionHistoryProps {
	plants: Plant[];
	onBack: () => void;
	/** Lo storico è la stessa sorgente da cui le schede leggono: dopo una modifica vanno riallineate. */
	onChanged: () => void;
}

/**
 * Lo storico azioni in tabella, modificabile.
 *
 * Non è solo una comodità: la calibrazione del sensore (server/predict.ts) impara
 * dall'orario di ogni irrigazione registrata, quindi una riga sbagliata sposta il
 * livello a cui la pianta chiede acqua. Dentro il container di Home Assistant i
 * JSON non sono raggiungibili, e questa è l'unica strada per correggerli.
 */
export function ActionHistory({ plants, onBack, onChanged }: ActionHistoryProps) {
	const [actions, setActions] = useState<PlantAction[] | null>(null);
	const [error, setError] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [newRow, setNewRow] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [plantFilter, setPlantFilter] = useState('');
	const [typeFilter, setTypeFilter] = useState<ActionType | ''>('');

	const load = useCallback(async () => {
		try {
			setActions(await api.getAllActions());
			setError(false);
		} catch {
			setError(true);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const plantName = useMemo(() => {
		const byId = new Map(plants.map((p) => [p.id, p.nickname || p.name]));
		return (id: string) => byId.get(id) ?? id;
	}, [plants]);

	const visible = useMemo(() => {
		return (actions ?? [])
			.filter((a) => (plantFilter ? a.plantId === plantFilter : true))
			.filter((a) => (typeFilter ? a.type === typeFilter : true))
			.sort((a, b) => b.date.localeCompare(a.date));
	}, [actions, plantFilter, typeFilter]);

	const startEdit = (action: PlantAction) => {
		setNewRow(null);
		setEditingId(action.id);
		setDraft(draftOf(action));
	};

	const cancelEdit = () => {
		setEditingId(null);
		setDraft(null);
	};

	const saveEdit = async () => {
		if (!editingId || !draft) return;
		const date = fromLocalInput(draft.date);
		if (!date) return;
		const patch: PlantActionPatch = {
			date,
			notes: draft.notes.trim() || null,
			...amountPatch(draft.type, parseAmount(draft.amount)),
			...(draft.type === 'water' ? { source: draft.source } : {}),
		};

		setBusy(true);
		try {
			await api.updateAction(editingId, patch);
			cancelEdit();
			await load();
			onChanged();
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (action: PlantAction) => {
		if (!confirm(t('history.confirmDelete'))) return;
		setBusy(true);
		try {
			await api.deleteAction(action.id);
			if (editingId === action.id) cancelEdit();
			await load();
			onChanged();
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};

	const startAdd = () => {
		cancelEdit();
		setNewRow({
			plantId: plantFilter || plants[0]?.id || '',
			type: (typeFilter || 'water') as ActionType,
			date: toLocalInput(new Date().toISOString()),
			amount: '',
			source: 'manual',
			notes: '',
		});
	};

	const saveNew = async () => {
		if (!newRow || !newRow.plantId) return;
		const date = fromLocalInput(newRow.date);
		if (!date) return;

		setBusy(true);
		try {
			await api.logAction(newRow.plantId, newRow.type, {
				date,
				notes: newRow.notes.trim() || undefined,
				...amountOptions(newRow.type, parseAmount(newRow.amount)),
				...(newRow.type === 'water' ? { source: newRow.source } : {}),
			});
			setNewRow(null);
			await load();
			onChanged();
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};

	const renderEditor = (value: Draft, set: (next: Draft) => void, withPlant: boolean) => (
		<>
			<td>
				<input
					type="datetime-local"
					value={value.date}
					onChange={(e) => set({ ...value, date: e.target.value })}
				/>
			</td>
			<td>
				{withPlant ? (
					<select value={value.plantId} onChange={(e) => set({ ...value, plantId: e.target.value })}>
						{plants.map((p) => (
							<option key={p.id} value={p.id}>{p.nickname || p.name}</option>
						))}
					</select>
				) : (
					plantName(value.plantId)
				)}
			</td>
			<td>
				{withPlant ? (
					<select value={value.type} onChange={(e) => set({ ...value, type: e.target.value as ActionType })}>
						{ACTION_TYPES.map((type) => (
							<option key={type} value={type}>{TYPE_EMOJI[type]} {t(`actions.${type}`)}</option>
						))}
					</select>
				) : (
					<>{TYPE_EMOJI[value.type]} {t(`actions.${value.type}`)}</>
				)}
			</td>
			<td>
				{AMOUNT_FIELD[value.type] && (
					<span className="history-amount-edit">
						<input
							type="number"
							min={0}
							value={value.amount}
							onChange={(e) => set({ ...value, amount: e.target.value })}
						/>
						<small>{AMOUNT_UNIT[value.type]}</small>
					</span>
				)}
			</td>
			<td>
				{value.type === 'water' && (
					<select value={value.source} onChange={(e) => set({ ...value, source: e.target.value as WaterSource })}>
						{WATER_SOURCES.map((source) => (
							<option key={source} value={source}>{SOURCE_EMOJI[source]} {t(`actions.source_${source}`)}</option>
						))}
					</select>
				)}
			</td>
			<td>
				<input
					type="text"
					value={value.notes}
					onChange={(e) => set({ ...value, notes: e.target.value })}
					placeholder={t('plant.notes')}
				/>
			</td>
		</>
	);

	return (
		<div className="history-page">
			<div className="history-toolbar">
				<button type="button" className="btn btn-secondary" onClick={onBack}>{t('history.back')}</button>
				<select value={plantFilter} onChange={(e) => setPlantFilter(e.target.value)}>
					<option value="">{t('history.allPlants')}</option>
					{plants.map((p) => (
						<option key={p.id} value={p.id}>{p.nickname || p.name}</option>
					))}
				</select>
				<select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ActionType | '')}>
					<option value="">{t('history.allTypes')}</option>
					{ACTION_TYPES.map((type) => (
						<option key={type} value={type}>{TYPE_EMOJI[type]} {t(`actions.${type}`)}</option>
					))}
				</select>
				<button
					type="button"
					className="btn btn-primary"
					onClick={startAdd}
					disabled={plants.length === 0 || newRow != null}
				>
					{t('history.add')}
				</button>
			</div>

			<p className="history-hint">{t('history.hint')}</p>
			{error && <p className="history-error">{t('history.error')}</p>}

			{actions == null ? (
				<p className="history-hint">{t('chart.loading')}</p>
			) : (
				<div className="history-table-wrap">
					<table className="history-table">
						<thead>
							<tr>
								<th>{t('history.colDate')}</th>
								<th>{t('history.colPlant')}</th>
								<th>{t('history.colType')}</th>
								<th>{t('history.colAmount')}</th>
								<th>{t('history.colSource')}</th>
								<th>{t('history.colNotes')}</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{newRow && (
								<tr className="history-row-new">
									{renderEditor(newRow, setNewRow, true)}
									<td className="history-row-actions">
										<button type="button" className="btn btn-sm btn-primary" onClick={saveNew} disabled={busy}>✓</button>
										<button type="button" className="btn btn-sm btn-secondary" onClick={() => setNewRow(null)} disabled={busy}>✕</button>
									</td>
								</tr>
							)}
							{visible.map((action) => {
								const field = AMOUNT_FIELD[action.type];
								const amount = field ? action[field] : undefined;
								return editingId === action.id && draft ? (
									<tr key={action.id} className="history-row-editing">
										{renderEditor(draft, setDraft, false)}
										<td className="history-row-actions">
											<button type="button" className="btn btn-sm btn-primary" onClick={saveEdit} disabled={busy}>✓</button>
											<button type="button" className="btn btn-sm btn-secondary" onClick={cancelEdit} disabled={busy}>✕</button>
										</td>
									</tr>
								) : (
									<tr key={action.id}>
										<td>{new Date(action.date).toLocaleString(getLocale())}</td>
										<td>{plantName(action.plantId)}</td>
										<td>{TYPE_EMOJI[action.type]} {t(`actions.${action.type}`)}</td>
										<td>{amount == null ? '—' : `${amount} ${AMOUNT_UNIT[action.type]}`}</td>
										<td>
											{action.type === 'water'
												? `${SOURCE_EMOJI[action.source ?? 'manual']} ${t(`actions.source_${action.source ?? 'manual'}`)}`
												: '—'}
										</td>
										<td className="history-notes">{action.notes || '—'}</td>
										<td className="history-row-actions">
											<button type="button" className="btn btn-sm btn-secondary" onClick={() => startEdit(action)} disabled={busy}>✏️</button>
											<button type="button" className="btn btn-sm btn-danger" onClick={() => remove(action)} disabled={busy}>🗑️</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					{visible.length === 0 && !newRow && <p className="history-hint">{t('history.empty')}</p>}
				</div>
			)}
		</div>
	);
}
