import { useEffect, useState } from 'react';
import type { HaEntityList, HaEntityOption, Plant, PlantSensors, SeasonalSchedule } from '../../shared/types';
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

// Valore sentinella dell'opzione "scrivi a mano": non può collidere con un entity_id.
const MANUAL_OPTION = '__manual__';

interface SensorSelectProps {
	label: string;
	value: string;
	onChange: (value: string) => void;
	entityList: HaEntityList | null;
	/** device_class da mostrare per primi in questo campo. */
	preferred: string[];
	placeholder: string;
}

/**
 * Scelta del sensore da elenco invece che scrivendo l'entity_id a mano.
 *
 * L'elenco arriva dalle entità etichettate "metaplants" in Home Assistant. Resta
 * sempre disponibile l'inserimento manuale: senza token HA (sviluppo), con entità
 * non etichettate, o se l'elenco non si carica, il campo torna a essere di testo.
 */
function SensorSelect({ label, value, onChange, entityList, preferred, placeholder }: SensorSelectProps) {
	const entities = entityList?.entities ?? [];
	const knownValue = value !== '' && entities.some((e) => e.entityId === value);
	// Un valore già impostato ma assente dall'elenco (es. entità senza etichetta)
	// non va perso: si apre direttamente in modalità manuale.
	const [manual, setManual] = useState(value !== '' && entityList != null && !knownValue);

	useEffect(() => {
		if (value !== '' && entityList != null && !entities.some((e) => e.entityId === value)) setManual(true);
	}, [entityList, value, entities]);

	const useList = entityList?.available && entities.length > 0 && !manual;

	const describe = (entity: HaEntityOption) => {
		const detail = [entity.state != null && entity.state !== 'unavailable' ? `${entity.state}${entity.unit ?? ''}` : null]
			.filter(Boolean)
			.join('');
		return detail ? `${entity.name} — ${detail}` : entity.name;
	};

	const recommended = entities.filter((e) => e.deviceClass && preferred.includes(e.deviceClass));
	const others = entities.filter((e) => !recommended.includes(e));

	return (
		<div className="form-group">
			<label>{label}</label>
			{useList ? (
				<select
					value={value}
					onChange={(e) => {
						if (e.target.value === MANUAL_OPTION) setManual(true);
						else onChange(e.target.value);
					}}
				>
					<option value="">{t('plant.sensorNone')}</option>
					{recommended.length > 0 && (
						<optgroup label={t('plant.sensorRecommended')}>
							{recommended.map((e) => (
								<option key={e.entityId} value={e.entityId}>{describe(e)}</option>
							))}
						</optgroup>
					)}
					{others.length > 0 && (
						<optgroup label={t('plant.sensorOthers')}>
							{others.map((e) => (
								<option key={e.entityId} value={e.entityId}>{describe(e)}</option>
							))}
						</optgroup>
					)}
					<option value={MANUAL_OPTION}>{t('plant.sensorManual')}</option>
				</select>
			) : (
				<>
					<input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
					{entityList?.available && entities.length > 0 && (
						<button type="button" className="btn btn-link btn-sm" onClick={() => setManual(false)}>
							{t('plant.sensorBackToList')}
						</button>
					)}
				</>
			)}
		</div>
	);
}

export function PlantForm({ plant, onSubmit, onClose, onDelete }: PlantFormProps) {
	const [name, setName] = useState(plant?.name ?? '');
	const [nickname, setNickname] = useState(plant?.nickname ?? '');
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
	const [entityList, setEntityList] = useState<HaEntityList | null>(null);

	useEffect(() => {
		api.getHaEntities()
			.then(setEntityList)
			// Senza elenco i campi sensore restano di testo libero: nessun blocco.
			.catch(() => setEntityList({ available: false, labeled: false, label: 'metaplants', entities: [] }));
	}, []);

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

	const buildSensors = (): PlantSensors | undefined => {
		const temperature = sensors.temperature?.trim() || undefined;
		const ambientHumidity = sensors.ambientHumidity?.trim() || undefined;
		const soilHumidity = sensors.soilHumidity?.trim() || undefined;
		if (!temperature && !ambientHumidity && !soilHumidity) return undefined;

		// Si parte dai sensori salvati per non cancellare i campi che gestisce il
		// server (baseline umidità, salto in attesa di conferma): il PUT sostituisce
		// l'intero oggetto sensors, quindi quello che non si rimanda qui va perso.
		const next: PlantSensors = {
			...plant?.sensors,
			temperature,
			ambientHumidity,
			soilHumidity,
			soilHumidityThreshold: soilHumidity ? sensors.soilHumidityThreshold ?? undefined : undefined,
			soilJumpDelta: soilHumidity ? sensors.soilJumpDelta ?? undefined : undefined,
		};
		if (!soilHumidity) {
			// Senza sensore terreno lo stato che lo riguarda non ha più senso.
			delete next.lastSoilHumidity;
			delete next.soilJumpPendingAck;
			delete next.lastSoilJumpAt;
		}
		return next;
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const season = getCurrentSeason();
		onSubmit({
			name, nickname: nickname || undefined, species, location,
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
			sensors: buildSensors(),
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
							{imageUrl && <img className="photo-preview" src={withBase(imageUrl)} alt="" loading="lazy" decoding="async" />}
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
						<label>{t('plant.nickname')}</label>
						<input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="es. Nonna Carla" />
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
						{entityList?.available && !entityList.labeled && (
							<p className="form-hint">
								{t('plant.sensorLabelHint').replace('{label}', entityList.label)}
							</p>
						)}
						<SensorSelect
							label={t('plant.sensorTemperature')}
							value={sensors.temperature ?? ''}
							onChange={(value) => setSensors({ ...sensors, temperature: value })}
							entityList={entityList}
							preferred={['temperature']}
							placeholder={t('plant.sensorTemperaturePlaceholder')}
						/>
						<SensorSelect
							label={t('plant.sensorAmbientHumidity')}
							value={sensors.ambientHumidity ?? ''}
							onChange={(value) => setSensors({ ...sensors, ambientHumidity: value })}
							entityList={entityList}
							preferred={['humidity']}
							placeholder={t('plant.sensorAmbientHumidityPlaceholder')}
						/>
						<SensorSelect
							label={t('plant.sensorSoilHumidity')}
							value={sensors.soilHumidity ?? ''}
							onChange={(value) => setSensors({ ...sensors, soilHumidity: value })}
							entityList={entityList}
							preferred={['moisture', 'humidity']}
							placeholder={t('plant.sensorSoilHumidityPlaceholder')}
						/>
						{sensors.soilHumidity?.trim() && (
							<>
								<div className="form-group">
									<label>{t('plant.soilHumidityThreshold')}</label>
									<input
										type="number"
										min={0}
										max={100}
										value={sensors.soilHumidityThreshold ?? ''}
										onChange={(e) => setSensors({ ...sensors, soilHumidityThreshold: e.target.value ? Number(e.target.value) : undefined })}
										placeholder={t('plant.soilHumidityThresholdPlaceholder')}
									/>
								</div>
								<div className="form-group">
									<label>{t('plant.soilJumpDelta')}</label>
									<input
										type="number"
										min={1}
										max={100}
										value={sensors.soilJumpDelta ?? ''}
										onChange={(e) => setSensors({ ...sensors, soilJumpDelta: e.target.value ? Number(e.target.value) : undefined })}
										placeholder={t('plant.soilJumpDeltaPlaceholder')}
									/>
								</div>
							</>
						)}
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
