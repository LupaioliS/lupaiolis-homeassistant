import { useEffect, useState } from 'react';
import type { Plant, PlantSensors, SeasonalSchedule } from '../../shared/types';
import { t } from '../i18n';
import { api } from '../api';
import { computeSeasonalSuggestions, getCurrentSeason } from '../season';
import { withBase } from '../basePath';

interface PlantFormProps {
	plant: Plant | null;
	onSubmit: (data: Omit<Plant, 'id' | 'createdAt'>) => void;
	onClose: () => void;
	onDelete?: () => void;
}

const defaultSchedule: SeasonalSchedule = { spring: 3, summer: 2, autumn: 5, winter: 7 };

export function PlantForm({ plant, onSubmit, onClose, onDelete }: PlantFormProps) {
	const [name, setName] = useState(plant?.name ?? '');
	const [species, setSpecies] = useState(plant?.species ?? '');
	const [location, setLocation] = useState(plant?.location ?? '');
	const [purchaseDate, setPurchaseDate] = useState(plant?.purchaseDate ?? '');
	const [lastRepotted, setLastRepotted] = useState(plant?.lastRepotted ?? '');
	const [lastPruned, setLastPruned] = useState(plant?.lastPruned ?? '');
	const [recommendedFertilizer, setRecommendedFertilizer] = useState(plant?.recommendedFertilizer ?? '');
	const [wateringSchedule, setWateringSchedule] = useState<SeasonalSchedule>(plant?.wateringSchedule ?? {
		spring: plant?.wateringIntervalDays ?? defaultSchedule.spring,
		summer: plant?.wateringIntervalDays ?? defaultSchedule.summer,
		autumn: plant?.wateringIntervalDays ?? defaultSchedule.autumn,
		winter: plant?.wateringIntervalDays ?? defaultSchedule.winter,
	});
	const [fertilizingSchedule, setFertilizingSchedule] = useState<SeasonalSchedule>(plant?.fertilizingSchedule ?? {
		spring: plant?.fertilizingIntervalDays ?? 14,
		summer: plant?.fertilizingIntervalDays ?? 10,
		autumn: plant?.fertilizingIntervalDays ?? 21,
		winter: plant?.fertilizingIntervalDays ?? 30,
	});
	const [notes, setNotes] = useState(plant?.notes ?? '');
	const [imageUrl, setImageUrl] = useState(plant?.imageUrl ?? '');

	const [sensors, setSensors] = useState<PlantSensors>(plant?.sensors ?? {});

	const [uploading, setUploading] = useState(false);
	const [wateringSuggestions, setWateringSuggestions] = useState<Partial<SeasonalSchedule>>({});
	const [fertilizingSuggestions, setFertilizingSuggestions] = useState<Partial<SeasonalSchedule>>({});

	useEffect(() => {
		if (!plant) return;
		api.getActions(plant.id)
			.then((actions) => {
				setWateringSuggestions(computeSeasonalSuggestions(actions, 'water'));
				setFertilizingSuggestions(computeSeasonalSuggestions(actions, 'fertilize'));
			})
			.catch(() => { /* no suggestions without history */ });
	}, [plant]);

	const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		setUploading(true);
		try {
			const url = await api.uploadImage(file);
			setImageUrl(url);
		} catch {
			alert('Upload error');
		} finally {
			setUploading(false);
			e.target.value = '';
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const season = getCurrentSeason();
		onSubmit({
			name, species, location,
			imageUrl: imageUrl || undefined,
			purchaseDate: purchaseDate || undefined,
			lastRepotted: lastRepotted || undefined,
			lastPruned: lastPruned || undefined,
			recommendedFertilizer: recommendedFertilizer || undefined,
			// Keep legacy fields in sync for backward compatibility.
			wateringIntervalDays: wateringSchedule[season],
			fertilizingIntervalDays: fertilizingSchedule[season],
			wateringSchedule,
			fertilizingSchedule,
			sensors: (sensors.temperature?.trim() || sensors.humidity?.trim())
				? {
					temperature: sensors.temperature?.trim() || undefined,
					humidity: sensors.humidity?.trim() || undefined,
				}
			: undefined,
			notes,
		});
	};

	const seasons: Array<keyof SeasonalSchedule> = ['spring', 'summer', 'autumn', 'winter'];

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h2>{plant ? t('plant.edit') : t('plant.new')}</h2>
				<form onSubmit={handleSubmit}>
					<div className="form-group">
						<label>{t('plant.photo')}</label>
						<div className="photo-field">
							{imageUrl && <img className="photo-preview" src={withBase(imageUrl)} alt="" />}
							<div className="photo-actions">
								<label className="btn btn-secondary btn-sm">
									{uploading ? t('plant.uploading') : imageUrl ? t('plant.changePhoto') : t('plant.addPhoto')}
									<input type="file" accept="image/*" onChange={handlePhoto} disabled={uploading} hidden />
								</label>
								{imageUrl && (
									<button type="button" className="btn btn-danger btn-sm" onClick={() => setImageUrl('')}>{t('plant.removePhoto')}</button>
								)}
							</div>
						</div>
					</div>
					<div className="form-group">
						<label>{t('plant.name')}</label>
						<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="es. Monstera" />
					</div>
					<div className="form-group">
						<label>{t('plant.species')}</label>
						<input value={species} onChange={(e) => setSpecies(e.target.value)} required placeholder="es. Monstera deliciosa" />
					</div>
					<div className="form-group">
						<label>{t('plant.location')}</label>
						<input value={location} onChange={(e) => setLocation(e.target.value)} required placeholder="es. Soggiorno" />
					</div>
					<div className="form-group">
						<label>{t('plant.purchaseDate')}</label>
						<input type="date" value={purchaseDate ? purchaseDate.split('T')[0] : ''} onChange={(e) => setPurchaseDate(e.target.value ? new Date(e.target.value).toISOString() : '')} />
					</div>
					
					<div className="form-group">
						<label>{t('plant.recommendedFertilizer')}</label>
						<input value={recommendedFertilizer} onChange={(e) => setRecommendedFertilizer(e.target.value)} placeholder="es. NPK 20-20-20" />
					</div>
					<div className="form-group">
						<label>{t('plant.lastRepotted')}</label>
						<input type="date" value={lastRepotted ? lastRepotted.split('T')[0] : ''} onChange={(e) => setLastRepotted(e.target.value ? new Date(e.target.value).toISOString() : '')} />
					</div>
					<div className="form-group">
						<label>{t('plant.lastPruned')}</label>
						<input type="date" value={lastPruned ? lastPruned.split('T')[0] : ''} onChange={(e) => setLastPruned(e.target.value ? new Date(e.target.value).toISOString() : '')} />
					</div>

					<fieldset className="form-fieldset">
						<legend>{t('schedule.title')} - {t('schedule.watering')}</legend>
						<div className="schedule-grid">
							{seasons.map((s) => (
								<div key={s} className="form-group">
									<label>{t(`seasons.${s}`)}</label>
									<input type="number" min={1} value={wateringSchedule[s]} onChange={(e) => setWateringSchedule({ ...wateringSchedule, [s]: Number(e.target.value) })} />
									{wateringSuggestions[s] != null && wateringSuggestions[s] !== wateringSchedule[s] && (
										<button type="button" className="btn btn-secondary btn-sm suggestion-btn" title={t('schedule.suggested')} onClick={() => setWateringSchedule({ ...wateringSchedule, [s]: wateringSuggestions[s]! })}>
											💡 {wateringSuggestions[s]}
										</button>
									)}
								</div>
							))}
						</div>
					</fieldset>

					<fieldset className="form-fieldset">
						<legend>{t('schedule.title')} - {t('schedule.fertilizing')}</legend>
						<div className="schedule-grid">
							{seasons.map((s) => (
								<div key={s} className="form-group">
									<label>{t(`seasons.${s}`)}</label>
									<input type="number" min={1} value={fertilizingSchedule[s]} onChange={(e) => setFertilizingSchedule({ ...fertilizingSchedule, [s]: Number(e.target.value) })} />
									{fertilizingSuggestions[s] != null && fertilizingSuggestions[s] !== fertilizingSchedule[s] && (
										<button type="button" className="btn btn-secondary btn-sm suggestion-btn" title={t('schedule.suggested')} onClick={() => setFertilizingSchedule({ ...fertilizingSchedule, [s]: fertilizingSuggestions[s]! })}>
											💡 {fertilizingSuggestions[s]}
										</button>
									)}
								</div>
							))}
						</div>
					</fieldset>

					<fieldset className="form-fieldset">
						<legend>{t('plant.sensorsTitle')}</legend>
						<div className="form-group">
							<label>{t('plant.sensorTemperature')}</label>
							<input
								value={sensors.temperature ?? ''}
								onChange={(e) => setSensors({ ...sensors, temperature: e.target.value })}
								placeholder={t('plant.sensorTemperaturePlaceholder')}
							/>
						</div>
						<div className="form-group">
							<label>{t('plant.sensorHumidity')}</label>
							<input
								value={sensors.humidity ?? ''}
								onChange={(e) => setSensors({ ...sensors, humidity: e.target.value })}
								placeholder={t('plant.sensorHumidityPlaceholder')}
							/>
						</div>
					</fieldset>

					<div className="form-group">
						<label>{t('plant.notes')}</label>
						<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Note opzionali..." />
					</div>
					<div className="form-actions">
						{plant && onDelete && (
							<button type="button" className="btn btn-danger" onClick={onDelete}>🗑️ {t('plant.delete')}</button>
						)}
						<button type="button" className="btn btn-secondary" onClick={onClose}>{t('plant.cancel')}</button>
						<button type="submit" className="btn btn-primary">{plant ? t('plant.save') : t('plant.add')}</button>
					</div>
				</form>
			</div>
		</div>
	);
}
