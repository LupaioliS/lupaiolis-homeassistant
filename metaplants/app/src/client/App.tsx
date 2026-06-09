import { useState, useEffect, useCallback } from 'react';
import type { Plant } from '../shared/types';
import { api } from './api';
import { PlantCard } from './components/PlantCard';
import { PlantForm } from './components/PlantForm';

export function App() {
	const [plants, setPlants] = useState<Plant[]>([]);
	const [showForm, setShowForm] = useState(false);
	const [editingPlant, setEditingPlant] = useState<Plant | null>(null);

	const loadPlants = useCallback(async () => {
		const data = await api.getPlants();
		setPlants(data);
	}, []);

	useEffect(() => {
		loadPlants();
	}, [loadPlants]);

	const handleWater = async (id: string) => {
		await api.logAction(id, 'water');
		loadPlants();
	};

	const handleFertilize = async (id: string) => {
		await api.logAction(id, 'fertilize');
		loadPlants();
	};

	const handleDelete = async (id: string) => {
		if (!confirm('Sei sicuro di voler eliminare questa pianta?')) return;
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
				<h1>🌱 MetaPlants</h1>
				<p style={{ color: '#16a34a', marginTop: 4 }}>Gestisci le tue piante</p>
			</header>

			<div style={{ marginBottom: 20, textAlign: 'right' }}>
				<button className="btn btn-primary" onClick={() => setShowForm(true)}>
					+ Aggiungi Pianta
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
