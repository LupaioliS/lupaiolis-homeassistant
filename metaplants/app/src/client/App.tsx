import { useState, useEffect, useCallback, useRef } from 'react';
import type { Plant, PlantAction, PlantReadings, WaterAmount, WaterSource } from '../shared/types';
import { api } from './api';
import { PlantCard, isDoneToday } from './components/PlantCard';
import { PlantForm } from './components/PlantForm';
import { ActionDialog, type ActionDialogResult } from './components/ActionDialog';
import { ActionHistory } from './components/ActionHistory';
import { AttentionSettings } from './components/AttentionSettings';
import { PlantNavigator, type PlantNeeds } from './components/PlantNavigator';
import { t, initLocale } from './i18n';
import { getCurrentSeason, seasonEmoji } from './season';
import { getIntervalForSeason, isOverdue } from './plantStatus';
import { assessWater } from './waterStatus';
import { adviseAmount } from './waterAmount';
import { loadAttentionPrefs, saveAttentionPrefs, type AttentionPrefs } from './attentionPrefs';
import { BASE_PATH } from './basePath';

type SortOption = 'name' | 'species' | 'attention';

const healthCategoryKey: Record<string, string> = { pest: 'pests', disease: 'diseases', fungus: 'fungi' };

// Il server manda un ping ogni 20s (server/events.ts). Senza eventi per più di
// così la connessione è morta anche se EventSource la crede aperta.
const SSE_STALE_MS = 50_000;
const SSE_WATCHDOG_MS = 10_000;

const cardAnchorId = (plantId: string) => `plant-${plantId}`;

export function App() {
	const [plants, setPlants] = useState<Plant[]>([]);
	const [showForm, setShowForm] = useState(false);
	const [editingPlant, setEditingPlant] = useState<Plant | null>(null);
	const [ready, setReady] = useState(false);
	const [readings, setReadings] = useState<Record<string, PlantReadings>>({});
	const [actionsByPlant, setActionsByPlant] = useState<Record<string, PlantAction[]>>({});
	const [searchTerm, setSearchTerm] = useState('');
	const [sortBy, setSortBy] = useState<SortOption>('name');
	const [soilWaterQueue, setSoilWaterQueue] = useState<Plant[]>([]);
	const [showHistory, setShowHistory] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [attentionPrefs, setAttentionPrefs] = useState<AttentionPrefs>(loadAttentionPrefs);
	const [activePlantId, setActivePlantId] = useState<string | null>(null);
	// Pianta a cui scorrere appena la sua scheda è di nuovo nella griglia (dopo aver
	// tolto un filtro di ricerca che la nascondeva).
	const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	// Ref keeps SSE handler (captured with [] deps) in sync with current plants state
	const plantsRef = useRef<Plant[]>([]);
	useEffect(() => { plantsRef.current = plants; }, [plants]);

	useEffect(() => {
		initLocale().then(() => setReady(true));
	}, []);


	const loadPlants = useCallback(async () => {
		const [data, initialReadings, allActions] = await Promise.all([
			api.getPlants(),
			api.getReadings().catch(() => ({} as Record<string, PlantReadings>)),
			api.getAllActions().catch(() => [] as PlantAction[]),
		]);
		setPlants(data);
		setReadings(initialReadings);

		// Una richiesta sola invece di una per scheda: le azioni servono a ogni
		// PlantCard per i suggerimenti stagionali e per le ultime quantità usate.
		const grouped: Record<string, PlantAction[]> = {};
		for (const action of allActions) {
			(grouped[action.plantId] ??= []).push(action);
		}
		setActionsByPlant(grouped);

		// Prompt for plants whose soil sensor jumped while the app was closed (server-persisted flag).
		// Plants already watered today don't need the prompt — auto-acknowledge those instead of asking again.
		const jumped = data.filter((p) => p.sensors?.soilJumpPendingAck === true);
		const alreadyWatered = jumped.filter((p) => isDoneToday(p.lastWatered));
		alreadyWatered.forEach((p) => api.acknowledgeSoilJump(p.id).catch(() => {/* best-effort */}));
		const toPrompt = jumped.filter((p) => !isDoneToday(p.lastWatered));
		if (toPrompt.length > 0) setSoilWaterQueue(toPrompt);
	}, []);

	useEffect(() => {
		loadPlants();
	}, [loadPlants]);

	// Real-time updates via SSE
	useEffect(() => {
		let source: EventSource | null = null;
		let lastEventAt = Date.now();

		const handleMessage = (event: MessageEvent) => {
			try {
				const data = JSON.parse(event.data);
				if (data.type === 'plant-updated' || data.type === 'plant-created') {
					setPlants((prev) => {
						const idx = prev.findIndex((p) => p.id === data.plant.id);
						if (idx >= 0) {
							const next = [...prev];
							next[idx] = data.plant;
							return next;
						}
						return [...prev, data.plant];
					});
				} else if (data.type === 'plant-deleted') {
					setPlants((prev) => prev.filter((p) => p.id !== data.plantId));
				} else if (data.type === 'soil-humidity-jumped') {
					// Real-time jump detection: app is open when soil sensor jumps
					const plant = plantsRef.current.find((p) => p.id === data.plantId);
					if (plant && isDoneToday(plant.lastWatered)) {
						api.acknowledgeSoilJump(plant.id).catch(() => {/* best-effort */});
					} else if (plant) {
						setSoilWaterQueue((prev) =>
							prev.some((p) => p.id === plant.id) ? prev : [...prev, plant]
						);
					}
				} else if (data.type === 'plant-readings') {
					setReadings((prev) => ({ ...prev, [data.plantId]: data.readings }));
				} else if (data.type === 'actions-changed') {
					// Una riga corretta dalla tabella storico cambia i suggerimenti stagionali
					// e le ultime quantità usate, che vivono qui e non nel payload della pianta.
					loadPlants();
				}
				// 'ping' non porta dati: conta solo che sia arrivato.
			} catch { /* ignore parse errors */ }
		};

		const connect = () => {
			source?.close();
			lastEventAt = Date.now();
			source = new EventSource(`${BASE_PATH}/api/events`);
			// Gli eventi persi mentre la connessione era giù non vengono ritrasmessi:
			// onopen scatta alla prima connessione e ad ogni riconnessione, quindi un
			// fetch completo qui riallinea il frontend in entrambi i casi.
			source.onopen = () => {
				lastEventAt = Date.now();
				loadPlants().catch(() => { /* riprova alla prossima riconnessione */ });
			};
			source.onmessage = (event) => {
				lastEventAt = Date.now();
				handleMessage(event);
			};
		};

		// La riconnessione automatica del browser non basta. Sul telefono, in
		// background, la connessione muore senza che EventSource se ne accorga e al
		// ritorno resta "aperta" e muta; e se un tentativo riceve un errore HTTP (es.
		// l'ingress di HA mentre la sessione si rinnova) EventSource smette di
		// riprovare per sempre. In entrambi i casi la pagina restava ferma finché non
		// la ricaricavi a mano. Il server manda un ping ogni 20s: se non arriva
		// niente da troppo, si riapre la connessione da capo.
		const isStale = () =>
			source == null || source.readyState === EventSource.CLOSED || Date.now() - lastEventAt > SSE_STALE_MS;
		const reconnectIfStale = () => {
			if (document.visibilityState === 'visible' && isStale()) connect();
		};

		connect();
		const watchdog = window.setInterval(reconnectIfStale, SSE_WATCHDOG_MS);
		// Al ritorno in primo piano non si aspetta il watchdog: i timer erano congelati.
		document.addEventListener('visibilitychange', reconnectIfStale);
		window.addEventListener('pageshow', reconnectIfStale);
		window.addEventListener('online', connect);
		return () => {
			window.clearInterval(watchdog);
			document.removeEventListener('visibilitychange', reconnectIfStale);
			window.removeEventListener('pageshow', reconnectIfStale);
			window.removeEventListener('online', connect);
			source?.close();
		};
	}, []);

	const patchPlant = useCallback((updated: Plant) => {
		setPlants((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
	}, []);

	const handleWater = async (id: string, amount: WaterAmount | undefined, source?: WaterSource) => {
		const now = new Date().toISOString();
		setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, lastWatered: now } : p)));
		api.logAction(id, 'water', { amount, source }).catch(loadPlants);
	};

	const handleSoilQueueConfirm = async ({ amount, source }: ActionDialogResult) => {
		const plant = soilWaterQueue[0];
		if (!plant) return;
		await handleWater(plant.id, amount, source);
		api.acknowledgeSoilJump(plant.id).catch(() => {/* best-effort */});
		setSoilWaterQueue((prev) => prev.slice(1));
	};

	const handleSoilQueueSkip = () => {
		const plant = soilWaterQueue[0];
		if (plant) api.acknowledgeSoilJump(plant.id).catch(() => {/* best-effort */});
		setSoilWaterQueue((prev) => prev.slice(1));
	};

	const handleFertilize = async (id: string, amountGrams: number) => {
		const now = new Date().toISOString();
		setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, lastFertilized: now } : p)));
		api.logAction(id, 'fertilize', { amountGrams }).catch(loadPlants);
	};

	const handleDelete = async (id: string) => {
		if (!confirm(t('plant.confirmDelete'))) return;
		setPlants((prev) => prev.filter((p) => p.id !== id));
		api.deletePlant(id).catch(loadPlants);
		handleFormClose();
	};

	const handleEdit = (plant: Plant) => {
		setEditingPlant(plant);
		setShowForm(true);
	};

	const handleFormClose = () => {
		setShowForm(false);
		setEditingPlant(null);
	};

	const handleFormSubmit = async (data: Omit<Plant, 'id' | 'createdAt'>) => {
		if (editingPlant) {
			await api.updatePlant(editingPlant.id, data);
		} else {
			await api.createPlant(data);
		}
		handleFormClose();
		// UI updates via SSE broadcast — no extra fetch needed
	};

	const currentSeason = getCurrentSeason();

	// Banner, ordinamento per attenzioni e anelli della barra in cima leggono tutti
	// da qui, quindi rispettano tutti la stessa scelta su cosa conta come "attenzione".
	const getAttention = (plant: Plant): PlantNeeds => {
		const fertIntervalDays = getIntervalForSeason(plant.fertilizingSchedule, currentSeason, plant.fertilizingIntervalDays ?? 14);
		// Stessa logica della scheda (sensore > stima matura > programma): banner e
		// scheda non possono più dire cose diverse sulla stessa pianta.
		const needsWater = attentionPrefs.water && assessWater(plant, readings[plant.id], currentSeason).overdue;
		const needsFertilize = attentionPrefs.fertilize && isOverdue(plant.lastFertilized, fertIntervalDays);
		const activeIssueCount = attentionPrefs.health ? (plant.healthIssues ?? []).filter((i) => !i.resolvedDate).length : 0;
		return { needsWater, needsFertilize, activeIssueCount };
	};

	const needsByPlant: Record<string, PlantNeeds> = Object.fromEntries(plants.map((plant) => [plant.id, getAttention(plant)]));

	const attentionPlants = plants
		.map((plant) => ({ plant, ...needsByPlant[plant.id] }))
		.filter((p) => p.needsWater || p.needsFertilize || p.activeIssueCount > 0);

	const handleAttentionPrefsChange = (prefs: AttentionPrefs) => {
		setAttentionPrefs(prefs);
		saveAttentionPrefs(prefs);
	};

	const term = searchTerm.trim().toLowerCase();
	const visiblePlants = plants.filter((plant) => {
		if (!term) return true;
		const activeIssues = (plant.healthIssues ?? []).filter((i) => !i.resolvedDate);
		const issueMatch = activeIssues.some((issue) => {
			const label = t(`${healthCategoryKey[issue.type]}.${issue.name}`).toLowerCase();
			return issue.name.toLowerCase().includes(term) || label.includes(term);
		});
		return (
			plant.name.toLowerCase().includes(term) ||
			(plant.nickname ?? '').toLowerCase().includes(term) ||
			plant.species.toLowerCase().includes(term) ||
			issueMatch
		);
	});

	const sortedPlants = [...visiblePlants].sort((a, b) => {
		if (sortBy === 'species') return a.species.localeCompare(b.species);
		if (sortBy === 'attention') {
			const scoreOf = (p: Plant) => {
				const { needsWater, needsFertilize, activeIssueCount } = needsByPlant[p.id];
				return (needsWater ? 1 : 0) + (needsFertilize ? 1 : 0) + activeIssueCount;
			};
			const diff = scoreOf(b) - scoreOf(a);
			if (diff !== 0) return diff;
		}
		return (a.nickname || a.name).localeCompare(b.nickname || b.name);
	});

	const scrollToCard = (plantId: string) => {
		const card = document.getElementById(cardAnchorId(plantId));
		if (!card) return;
		card.scrollIntoView({ behavior: 'smooth', block: 'start' });
		setActivePlantId(plantId);
		// Un lampo sulla scheda: con due colonne non è ovvio quale delle due fosse.
		card.classList.remove('plant-card-flash');
		void card.offsetWidth; // riavvia l'animazione se la stessa scheda viene scelta due volte
		card.classList.add('plant-card-flash');
		card.addEventListener('animationend', () => card.classList.remove('plant-card-flash'), { once: true });
	};

	// Banner e barra portano alla scheda; se la ricerca la nasconde, prima si toglie il filtro.
	const goToPlant = (plantId: string) => {
		if (sortedPlants.some((p) => p.id === plantId)) {
			scrollToCard(plantId);
		} else {
			setSearchTerm('');
			setPendingScrollId(plantId);
		}
	};

	useEffect(() => {
		if (!pendingScrollId) return;
		scrollToCard(pendingScrollId);
		setPendingScrollId(null);
	}, [pendingScrollId]);

	const focusSearch = () => {
		window.scrollTo({ top: 0, behavior: 'smooth' });
		searchInputRef.current?.focus({ preventScroll: true });
	};

	// Quale scheda sta in cima allo schermo, sotto la barra: è la pianta evidenziata
	// nella barra, che si sposta da sola mentre si scorre.
	const visibleIdsKey = sortedPlants.map((p) => p.id).join(',');
	useEffect(() => {
		if (!visibleIdsKey || typeof IntersectionObserver === 'undefined') return;
		const order = visibleIdsKey.split(',');
		const intersecting = new Set<string>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = (entry.target as HTMLElement).dataset.plantId;
					if (!id) continue;
					if (entry.isIntersecting) intersecting.add(id);
					else intersecting.delete(id);
				}
				const first = order.find((id) => intersecting.has(id));
				if (first) setActivePlantId(first);
			},
			// Una fascia subito sotto la barra in cima: conta la scheda che si sta leggendo.
			{ rootMargin: '-120px 0px -55% 0px' },
		);
		for (const id of order) {
			const card = document.getElementById(cardAnchorId(id));
			if (!card) continue;
			card.dataset.plantId = id;
			observer.observe(card);
		}
		return () => observer.disconnect();
	}, [visibleIdsKey, showHistory]);

	if (showHistory) {
		return (
			<div className="app">
				<header>
					<h1>🌱 {t('app.title')}</h1>
					<p style={{ color: '#16a34a', marginTop: 4 }}>{t('history.title')}</p>
				</header>
				<ActionHistory plants={plants} onBack={() => setShowHistory(false)} onChanged={loadPlants} />
			</div>
		);
	}

	return (
		<div className="app">
			<header>
				<h1>🌱 {t('app.title')}</h1>
				<p style={{ color: '#16a34a', marginTop: 4 }}>{t('app.subtitle')}</p>
			</header>

			<div style={{ marginBottom: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
				<button
					className="btn btn-secondary"
					onClick={() => setShowSettings(true)}
					title={t('app.settings')}
					aria-label={t('app.settings')}
				>
					⚙️
				</button>
				<button className="btn btn-secondary" onClick={() => setShowHistory(true)}>
					{t('history.open')}
				</button>
				<button className="btn btn-primary" onClick={() => setShowForm(true)}>
					{t('app.addPlant')}
				</button>
			</div>

			<div className="season-banner">
				<span className="season-banner-emoji">{seasonEmoji[currentSeason]}</span>
				<span>{t('app.currentSeason')}: <strong>{t(`seasons.${currentSeason}`)}</strong></span>
			</div>

			{attentionPlants.length > 0 && (
				<div className="attention-banner">
					<div className="attention-banner-title">⚠️ {t('app.needsAttention')}</div>
					<ul className="attention-banner-list">
						{attentionPlants.map(({ plant, needsWater, needsFertilize, activeIssueCount }) => (
							<li
								key={plant.id}
								className="attention-banner-pill"
								onClick={() => goToPlant(plant.id)}
							>
								<strong>{plant.nickname || plant.name}</strong>
								{/* Senza sensore del terreno la pianta non chiede acqua: chiede di toccare il terreno. */}
							{needsWater && <span className="attention-banner-tag">{plant.sensors?.soilHumidity ? '💧' : '👆'}</span>}
								{needsFertilize && <span className="attention-banner-tag">🧪</span>}
								{activeIssueCount > 0 && <span className="attention-banner-tag">🏥</span>}
							</li>
						))}
					</ul>
				</div>
			)}

			{plants.length > 0 && (
				<div className="plant-controls">
					<div className="plant-search-wrap">
						<input
							ref={searchInputRef}
							type="text"
							className="plant-search"
							placeholder={t('app.searchPlaceholder')}
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
						/>
						{searchTerm && (
							<button
								type="button"
								className="plant-search-clear"
								aria-label={t('app.clearSearch')}
								onClick={() => setSearchTerm('')}
							>
								×
							</button>
						)}
					</div>
					<select
						className="plant-sort"
						value={sortBy}
						onChange={(e) => setSortBy(e.target.value as SortOption)}
					>
						<option value="name">{t('app.sortName')}</option>
						<option value="species">{t('app.sortSpecies')}</option>
						<option value="attention">{t('app.sortAttention')}</option>
					</select>
				</div>
			)}

			{sortedPlants.length > 1 && (
				<PlantNavigator
					plants={sortedPlants}
					needs={needsByPlant}
					activeId={activePlantId}
					onSelect={goToPlant}
					onSearch={focusSearch}
				/>
			)}

			{plants.length === 0 ? (
				<div className="empty-state">
					<div style={{ fontSize: '3rem' }}>🌿</div>
				</div>
			) : sortedPlants.length === 0 ? (
				<div className="empty-state">
					<div style={{ fontSize: '3rem' }}>🔍</div>
					<p>{t('app.noResults')}</p>
				</div>
			) : (
				<div className="plant-grid">
					{sortedPlants.map((plant) => (
						<PlantCard
							key={plant.id}
							plant={plant}
							readings={readings[plant.id]}
							actions={actionsByPlant[plant.id]}
							anchorId={cardAnchorId(plant.id)}
							onWater={(amount, source) => handleWater(plant.id, amount, source)}
							onFertilize={(amountGrams) => handleFertilize(plant.id, amountGrams)}
							onEdit={() => handleEdit(plant)}
							onRefresh={loadPlants}
							onPatch={patchPlant}
						/>
					))}
				</div>
			)}

			{soilWaterQueue.length > 0 && (
				<ActionDialog
					type="water"
					plant={soilWaterQueue[0]}
					titleOverride={t('actions.soilJumpTitle')}
					subtitle={t('actions.soilJumpPrompt').replace('{name}', soilWaterQueue[0].nickname || soilWaterQueue[0].name)}
					defaultAmount={adviseAmount(
						actionsByPlant[soilWaterQueue[0].id],
						readings[soilWaterQueue[0].id]?.prediction,
						soilWaterQueue[0].lastWatered,
					).suggested}
					onConfirm={handleSoilQueueConfirm}
					onClose={handleSoilQueueSkip}
				/>
			)}

			{showSettings && (
				<AttentionSettings
					prefs={attentionPrefs}
					onChange={handleAttentionPrefsChange}
					onClose={() => setShowSettings(false)}
				/>
			)}

			{showForm && (
				<PlantForm
					plant={editingPlant}
					onSubmit={handleFormSubmit}
					onClose={handleFormClose}
					onDelete={editingPlant ? () => handleDelete(editingPlant.id) : undefined}
				/>
			)}
		</div>
	);
}
