import { useState, useEffect, useCallback } from 'react';
import type { Plant } from '../shared/types';
import { api } from './api';
import { PlantCard } from './components/PlantCard';
import { PlantForm } from './components/PlantForm';
import { t, initLocale } from './i18n';

export function App() {
	const [plants, setPlants] = useState<Plant[]>([]);
	const [showForm, setShowForm] = useState(false);
	const [editingPlant, setEditingPlant] = useState<Plant | null>(null);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		initLocale().then(() => setReady(true));
	}, []);

	const loadPlants = useCallback(async () => {
		const data = await api.getPlants();
		setPlants(data);
	}, []);

	useEffect(() => {
		loadPlants();
	}, [loadPlants]);

	// Real-time updates via SSE
	useEffect(() => {
		const evtSource = new EventSource('/api/events');
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
				}
			} catch { /* ignore parse errors */ }
		};
		return () => evtSource.close();
	}, []);

	const handleWater = async (id: string) => {
		await api.logAction(id, 'water');
		loadPlants();
	};

	const handleFertilize = async (id: string) => {
		await api.logAction(id, 'fertilize');
		loadPlants();
	};

	const handleDelete = async (id: string) => {
		if (!confirm(t('plant.confirmDelete'))) return;
		await api.deletePlant(id);
		loadPlants();
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
		loadPlants();
	};

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
							onWater={() => handleWater(plant.id)}
							onFertilize={() => handleFertilize(plant.id)}
							onEdit={() => handleEdit(plant)}
							onDelete={() => handleDelete(plant.id)}
							onRefresh={loadPlants}
						/>
					))}
				</div>
			)}

			{showForm && (
				<PlantForm
					plant={editingPlant}
					onSubmit={handleFormSubmit}
					onClose={handleFormClose}
				/>
			)}
		</div>
	);
}
