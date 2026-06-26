import { useState, useEffect, useCallback } from 'react';
import type { Plant, PlantReadings } from '../shared/types';
import { api } from './api';
import { PlantCard } from './components/PlantCard';
import { PlantForm } from './components/PlantForm';
import { t, initLocale } from './i18n';
import { getCurrentSeason, seasonEmoji } from './season';
import { getIntervalForSeason, isOverdue } from './plantStatus';
import { BASE_PATH } from './basePath';

type SortOption = 'name' | 'species' | 'attention';

const healthCategoryKey: Record<string, string> = { pest: 'pests', disease: 'diseases', fungus: 'fungi' };

export function App() {
	const [plants, setPlants] = useState<Plant[]>([]);
	const [showForm, setShowForm] = useState(false);
	const [editingPlant, setEditingPlant] = useState<Plant | null>(null);
	const [ready, setReady] = useState(false);
	const [readings, setReadings] = useState<Record<string, PlantReadings>>({});
	const [searchTerm, setSearchTerm] = useState('');
	const [sortBy, setSortBy] = useState<SortOption>('name');

	useEffect(() => {
		initLocale().then(() => setReady(true));
	}, []);


	const loadPlants = useCallback(async () => {
		const [data, initialReadings] = await Promise.all([
			api.getPlants(),
			api.getReadings().catch(() => ({} as Record<string, PlantReadings>)),
		]);
		setPlants(data);
		setReadings(initialReadings);
	}, []);

	useEffect(() => {
		loadPlants();
	}, [loadPlants]);

	// Real-time updates via SSE
	useEffect(() => {
		const evtSource = new EventSource(`${BASE_PATH}/api/events`);
		// Il browser riconnette automaticamente dopo una caduta della connessione, ma
		// gli eventi persi nel frattempo non vengono ritrasmessi: senza un resync qui,
		// il frontend resta con dati stantii finché non arriva un nuovo evento o l'utente
		// ricarica la pagina a mano. onopen scatta sia alla prima connessione che a ogni
		// riconnessione, quindi un fetch completo qui copre entrambi i casi.
		evtSource.onopen = () => {
			loadPlants();
		};
		evtSource.onmessage = (event) => {
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
				} else if (data.type === 'plant-readings') {
					setReadings((prev) => ({ ...prev, [data.plantId]: data.readings }));
				}
			} catch { /* ignore parse errors */ }
		};
		return () => evtSource.close();
	}, []);

	const patchPlant = useCallback((updated: Plant) => {
		setPlants((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
	}, []);

	const handleWater = async (id: string, amountMl: number) => {
		const now = new Date().toISOString();
		setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, lastWatered: now } : p)));
		api.logAction(id, 'water', { amountMl }).catch(loadPlants);
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

	const getAttention = (plant: Plant) => {
		const waterIntervalDays = getIntervalForSeason(plant.wateringSchedule, currentSeason, plant.wateringIntervalDays ?? 3);
		const fertIntervalDays = getIntervalForSeason(plant.fertilizingSchedule, currentSeason, plant.fertilizingIntervalDays ?? 14);
		const soilThreshold = plant.sensors?.soilHumidityThreshold;
		const soilHumidity = readings[plant.id]?.soilHumidity;
		// Il sensore di umidità del terreno, se sotto soglia, vince sul programma a tempo.
		const soilNeedsWater = soilThreshold != null && soilHumidity != null && soilHumidity <= soilThreshold;
		const needsWater = soilNeedsWater || isOverdue(plant.lastWatered, waterIntervalDays);
		const needsFertilize = isOverdue(plant.lastFertilized, fertIntervalDays);
		const activeIssueCount = (plant.healthIssues ?? []).filter((i) => !i.resolvedDate).length;
		return { needsWater, needsFertilize, activeIssueCount };
	};

	const attentionPlants = plants
		.map((plant) => ({ plant, ...getAttention(plant) }))
		.filter((p) => p.needsWater || p.needsFertilize || p.activeIssueCount > 0);

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
				const { needsWater, needsFertilize, activeIssueCount } = getAttention(p);
				return (needsWater ? 1 : 0) + (needsFertilize ? 1 : 0) + activeIssueCount;
			};
			const diff = scoreOf(b) - scoreOf(a);
			if (diff !== 0) return diff;
		}
		return (a.nickname || a.name).localeCompare(b.nickname || b.name);
	});

	return (
		<div className="app">
			<header>
				<h1>🌱 {t('app.title')}</h1>
				<p style={{ color: '#16a34a', marginTop: 4 }}>{t('app.subtitle')}</p>
			</header>

			<div style={{ marginBottom: 20, textAlign: 'right' }}>
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
								onClick={() => setSearchTerm(plant.nickname || plant.name)}
							>
								<strong>{plant.nickname || plant.name}</strong>
								{needsWater && <span className="attention-banner-tag">💧</span>}
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
							onWater={(amountMl) => handleWater(plant.id, amountMl)}
							onFertilize={(amountGrams) => handleFertilize(plant.id, amountGrams)}
							onEdit={() => handleEdit(plant)}
							onRefresh={loadPlants}
							onPatch={patchPlant}
						/>
					))}
				</div>
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
