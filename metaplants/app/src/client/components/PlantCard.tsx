import type { Plant } from '../../shared/types';

interface PlantCardProps {
	plant: Plant;
	onWater: () => void;
	onFertilize: () => void;
	onEdit: () => void;
	onDelete: () => void;
}

function getDaysAgo(dateStr?: string): number | null {
	if (!dateStr) return null;
	const diff = Date.now() - new Date(dateStr).getTime();
	return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getStatus(lastAction: string | undefined, intervalDays: number): { overdue: boolean; label: string } {
	const daysAgo = getDaysAgo(lastAction);
	if (daysAgo === null) return { overdue: true, label: 'Mai fatto' };
	if (daysAgo >= intervalDays) return { overdue: true, label: `${daysAgo}g fa (scaduto!)` };
	const remaining = intervalDays - daysAgo;
	return { overdue: false, label: `tra ${remaining}g` };
}

export function PlantCard({ plant, onWater, onFertilize, onEdit, onDelete }: PlantCardProps) {
	const waterStatus = getStatus(plant.lastWatered, plant.wateringIntervalDays);
	const fertStatus = getStatus(plant.lastFertilized, plant.fertilizingIntervalDays);

	return (
		<div className="plant-card">
			<h3>{plant.name}</h3>
			<div className="species">{plant.species}</div>
			<div className="location">📍 {plant.location}</div>

			<div className="status">
				<span className={`status-item ${waterStatus.overdue ? 'overdue' : 'ok'}`}>
					💧 {waterStatus.label}
				</span>
				<span className={`status-item ${fertStatus.overdue ? 'overdue' : 'ok'}`}>
					🧪 {fertStatus.label}
				</span>
			</div>

			{plant.notes && (
				<p style={{ fontSize: '0.85rem', color: '#666', marginBottom: 12 }}>{plant.notes}</p>
			)}

			<div className="actions">
				<button className="btn btn-water" onClick={onWater}>💧 Acqua</button>
				<button className="btn btn-fertilize" onClick={onFertilize}>🧪 Fertilizza</button>
				<button className="btn btn-secondary" onClick={onEdit}>✏️</button>
				<button className="btn btn-danger" onClick={onDelete}>🗑️</button>
			</div>
		</div>
	);
}
