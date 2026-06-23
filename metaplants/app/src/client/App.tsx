import { useState, useEffect, useCallback } from 'react';
import type { Plant, PlantReadings } from '../shared/types';
import { api } from './api';
import { PlantCard } from './components/PlantCard';
import { PlantForm } from './components/PlantForm';
import { t, initLocale } from './i18n';
import { getCurrentSeason, seasonEmoji } from './season';
import { BASE_PATH } from './basePath';

export function App() {
	const [plants, setPlants] = useState<Plant[]>([]);
	const [showForm, setShowForm] = useState(false);
	const [editingPlant, setEditingPlant] = useState<Plant | null>(null);
	const [ready, setReady] = useState(false);
	const [readings, setReadings] = useState<Record<string, PlantReadings>>({});

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

	const handleWater = async (id: string) => {
		const now = new Date().toISOString();
		setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, lastWatered: now } : p)));
		api.logAction(id, 'water').catch(loadPlants);
	};

	const handleFertilize = async (id: string) => {
		const now = new Date().toISOString();
		setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, lastFertilized: now } : p)));
		api.logAction(id, 'fertilize').catch(loadPlants);
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

			{plants.length === 0 ? (
				<div className="empty-state">
					<div style={{ fontSize: '3rem' }}>🌿</div>
				</div>
			) : (
				<div className="plant-grid">
					{plants.map((plant) => (
						<PlantCard
							key={plant.id}
							plant={plant}
							readings={readings[plant.id]}
							onWater={() => handleWater(plant.id)}
							onFertilize={() => handleFertilize(plant.id)}
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
