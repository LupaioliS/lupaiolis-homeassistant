import { useState, useEffect, useCallback } from 'react';
import type { Plant } from '../shared/types';
import { api } from './api';
import { PlantCard } from './components/PlantCard';
import { PlantForm } from './components/PlantForm';
import { t, setLocale, getLocale, type Locale } from './i18n';

export function App() {
	const [plants, setPlants] = useState<Plant[]>([]);
	const [showForm, setShowForm] = useState(false);
	const [editingPlant, setEditingPlant] = useState<Plant | null>(null);
	const [locale, setCurrentLocale] = useState<Locale>(getLocale());

	const loadPlants = useCallback(async () => {
		const data = await api.getPlants();
		setPlants(data);
	}, []);

	useEffect(() => {
		loadPlants();
	}, [loadPlants]);

	useEffect(() => {
		const handler = () => setCurrentLocale(getLocale());
		window.addEventListener('locale-changed', handler);
		return () => window.removeEventListener('locale-changed', handler);
	}, []);

	const handleLocaleChange = (newLocale: Locale) => {
		setLocale(newLocale);
	};

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
				<div className="locale-switcher">
					<button className={`btn btn-sm ${locale === 'it' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => handleLocaleChange('it')}>🇮🇹 IT</button>
					<button className={`btn btn-sm ${locale === 'en' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => handleLocaleChange('en')}>🇬🇧 EN</button>
				</div>
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
