import { useState } from 'react';
import type { Plant } from '../../shared/types';

interface PlantFormProps {
	plant: Plant | null;
	onSubmit: (data: Omit<Plant, 'id' | 'createdAt'>) => void;
	onClose: () => void;
}

export function PlantForm({ plant, onSubmit, onClose }: PlantFormProps) {
	const [name, setName] = useState(plant?.name ?? '');
	const [species, setSpecies] = useState(plant?.species ?? '');
	const [location, setLocation] = useState(plant?.location ?? '');
	const [wateringIntervalDays, setWateringInterval] = useState(plant?.wateringIntervalDays ?? 3);
	const [fertilizingIntervalDays, setFertilizingInterval] = useState(plant?.fertilizingIntervalDays ?? 14);
	const [notes, setNotes] = useState(plant?.notes ?? '');

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		onSubmit({ name, species, location, wateringIntervalDays, fertilizingIntervalDays, notes });
	};

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h2>{plant ? 'Modifica Pianta' : 'Nuova Pianta'}</h2>
				<form onSubmit={handleSubmit}>
					<div className="form-group">
						<label>Nome</label>
						<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="es. Monstera" />
					</div>
					<div className="form-group">
						<label>Specie</label>
						<input value={species} onChange={(e) => setSpecies(e.target.value)} required placeholder="es. Monstera deliciosa" />
					</div>
					<div className="form-group">
						<label>Posizione</label>
						<input value={location} onChange={(e) => setLocation(e.target.value)} required placeholder="es. Soggiorno" />
					</div>
					<div className="form-group">
						<label>Intervallo irrigazione (giorni)</label>
						<input type="number" min={1} value={wateringIntervalDays} onChange={(e) => setWateringInterval(Number(e.target.value))} required />
					</div>
					<div className="form-group">
						<label>Intervallo fertilizzazione (giorni)</label>
						<input type="number" min={1} value={fertilizingIntervalDays} onChange={(e) => setFertilizingInterval(Number(e.target.value))} required />
					</div>
					<div className="form-group">
						<label>Note</label>
						<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Note opzionali..." />
					</div>
					<div className="form-actions">
						<button type="button" className="btn btn-secondary" onClick={onClose}>Annulla</button>
						<button type="submit" className="btn btn-primary">{plant ? 'Salva' : 'Aggiungi'}</button>
					</div>
				</form>
			</div>
		</div>
	);
}
