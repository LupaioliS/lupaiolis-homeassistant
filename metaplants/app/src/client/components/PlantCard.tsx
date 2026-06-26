import { useEffect, useState } from 'react';
import type { Plant, HealthIssue, HealthIssueType, PestType, DiseaseType, FungusType, SeasonalSchedule, PlantReadings } from '../../shared/types';
import { t } from '../i18n';
import { api } from '../api';
import { computeSeasonalSuggestions, getCurrentSeason } from '../season';
import { getIntervalForSeason, isOverdue } from '../plantStatus';
import { withBase } from '../basePath';
import { ActionDialog, type ActionDialogType } from './ActionDialog';

interface PlantCardProps {
	plant: Plant;
	readings?: PlantReadings;
	onWater: (amountMl: number) => void | Promise<void>;
	onFertilize: (amountGrams: number) => void | Promise<void>;
	onEdit: () => void;
	onRefresh: () => void;
	onPatch: (plant: Plant) => void;
}

function getDaysAgo(dateStr?: string): number | null {
	if (!dateStr) return null;
	const diff = Date.now() - new Date(dateStr).getTime();
	return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getHoursAgo(dateStr?: string): number | null {
	if (!dateStr) return null;
	const diff = Date.now() - new Date(dateStr).getTime();
	return Math.floor(diff / (1000 * 60 * 60));
}

// Stessa palette pastello dei pulsanti azione (.btn-water / .btn-fertilize): sfondo chiaro, testo scuro saturo.
const SOIL_DRY_BG = [253, 230, 200]; // pastello marrone/secco (tipo .btn-fertilize)
const SOIL_DRY_TEXT = [146, 64, 14];
const SOIL_WET_BG = [219, 234, 254]; // pastello azzurro/bagnato (.btn-water)
const SOIL_WET_TEXT = [29, 78, 216];

function mixColor(a: number[], b: number[], ratio: number): string {
	const [r, g, bch] = a.map((c, i) => Math.round(c + (b[i] - c) * ratio));
	return `rgb(${r}, ${g}, ${bch})`;
}

// Pillola con sfondo a sfumatura: più ci si avvicina alla soglia di irrigazione, più vira dal pastello
// azzurro (bagnato) al pastello marrone (secco), con un fade morbido invece di uno stacco netto.
function getSoilHumidityStyle(value: number, threshold: number): { background: string; color: string } {
	// 0 = al limite della soglia (secco), 1 = bagnato (soglia + 30 punti percentuali)
	const wetReference = threshold + 30;
	const ratio = Math.min(1, Math.max(0, (value - threshold) / (wetReference - threshold)));
	const bgColor = mixColor(SOIL_DRY_BG, SOIL_WET_BG, ratio);
	const bgColorSoft = mixColor(SOIL_DRY_BG, SOIL_WET_BG, Math.min(1, ratio + 0.15));
	const textColor = mixColor(SOIL_DRY_TEXT, SOIL_WET_TEXT, ratio);
	return {
		background: `linear-gradient(135deg, ${bgColor}, ${bgColorSoft})`,
		color: textColor,
	};
}

function getStatus(lastAction: string | undefined, intervalDays: number): { overdue: boolean; label: string } {
	if (!lastAction) return { overdue: true, label: t('status.neverDone') };

	const daysAgo = getDaysAgo(lastAction);
	const hoursAgo = getHoursAgo(lastAction);
	if (daysAgo === null) return { overdue: true, label: t('status.neverDone') };
	if (hoursAgo === null) return { overdue: true, label: t('status.neverDone') };

	const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
	const elapsedMs = Date.now() - new Date(lastAction).getTime();

	if (isOverdue(lastAction, intervalDays)) {
		if (elapsedMs - intervalMs < 24 * 60 * 60 * 1000) {
			return {
				overdue: true,
				label: `${t('status.hoursAgo').replace('{hours}', String(hoursAgo))} (${t('status.overdue')})`,
			};
		}
		return {
			overdue: true,
			label: `${t('status.daysAgo').replace('{days}', String(daysAgo))} (${t('status.overdue')})`,
		};
	}

	const remainingMs = intervalMs - elapsedMs;
	if (remainingMs < 24 * 60 * 60 * 1000) {
		const remainingHours = Math.max(1, Math.ceil(remainingMs / (1000 * 60 * 60)));
		return { overdue: false, label: t('status.inHours').replace('{hours}', String(remainingHours)) };
	}

	const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
	return { overdue: false, label: t('status.inDays').replace('{days}', String(remainingDays)) };
}

function formatDate(dateStr?: string): string {
	if (!dateStr) return '-';
	return new Date(dateStr).toLocaleDateString();
}

function isDoneToday(dateStr?: string): boolean {
	if (!dateStr) return false;
	const today = new Date().toISOString().split('T')[0];
	return dateStr.split('T')[0] === today;
}

const defaultSchedule: SeasonalSchedule = { spring: 3, summer: 2, autumn: 5, winter: 7 };

const pestOptions: PestType[] = ['aphids', 'spider_mites', 'mealybugs', 'scale', 'whiteflies', 'thrips', 'fungus_gnats', 'slugs'];
const diseaseOptions: DiseaseType[] = ['powdery_mildew', 'root_rot', 'leaf_spot', 'botrytis', 'rust', 'black_spot', 'downy_mildew'];
const fungusOptions: FungusType[] = ['fusarium', 'pythium', 'phytophthora', 'alternaria', 'cercospora', 'anthracnose'];

function ActionButton({ disabled: initialDisabled, className, onClick, label }: { disabled: boolean; className: string; onClick: () => void | Promise<void>; label: string }) {
	const [forced, setForced] = useState(false);
	const [loading, setLoading] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const isDisabled = initialDisabled && !forced;

	const handleClick = async () => {
		setForced(false);
		setLoading(true);
		setElapsed(0);
		const start = Date.now();
		const timer = setInterval(() => setElapsed(Date.now() - start), 100);
		try {
			await onClick();
		} finally {
			clearInterval(timer);
			setLoading(false);
		}
	};

	if (loading) {
		return (
			<button className={`${className} is-loading`} disabled>
				<span className="spinner" /> {(elapsed / 1000).toFixed(1)}s
			</button>
		);
	}

	if (!isDisabled) {
		return <button className={className} onClick={handleClick}>{label}</button>;
	}
	return (
		<div className="action-btn-wrapper">
			<button className={`${className} is-disabled`} disabled>{label} ✓</button>
			<button className="btn-force" onClick={() => setForced(true)} title="Forza">⟳</button>
		</div>
	);
}

export function PlantCard({ plant, readings, onWater, onFertilize, onEdit, onRefresh, onPatch }: PlantCardProps) {
	const [showHealth, setShowHealth] = useState(false);
	const [showProducts, setShowProducts] = useState(false);
	const [issueType, setIssueType] = useState<HealthIssueType>('pest');
	const [issueName, setIssueName] = useState('');
	const [issueImageUrl, setIssueImageUrl] = useState('');
	const [issueUploading, setIssueUploading] = useState(false);
	const [productName, setProductName] = useState('');
	const [productReason, setProductReason] = useState('');
	const [waterSuggestion, setWaterSuggestion] = useState<number | null>(null);
	const [fertSuggestion, setFertSuggestion] = useState<number | null>(null);
	const [activeDialog, setActiveDialog] = useState<ActionDialogType | null>(null);
	const [lastWaterMl, setLastWaterMl] = useState<number | null>(null);
	const [lastFertGrams, setLastFertGrams] = useState<number | null>(null);
	const [lastPotSizeCm, setLastPotSizeCm] = useState<number | null>(null);

	const season = getCurrentSeason();
	const waterIntervalDays = getIntervalForSeason(plant.wateringSchedule, season, plant.wateringIntervalDays ?? 3);
	const fertIntervalDays = getIntervalForSeason(plant.fertilizingSchedule, season, plant.fertilizingIntervalDays ?? 14);
	const fertStatus = getStatus(plant.lastFertilized, fertIntervalDays);

	const soilThreshold = plant.sensors?.soilHumidityThreshold;
	const soilHumidity = readings?.soilHumidity;
	const soilNeedsWater = soilThreshold != null && soilHumidity != null && soilHumidity <= soilThreshold;
	// Il sensore di umidità del terreno, se sotto soglia, vince sul programma a tempo.
	const waterStatus = soilNeedsWater
		? { overdue: true, label: t('status.soilSensorWater') }
		: getStatus(plant.lastWatered, waterIntervalDays);

	useEffect(() => {
		api.getActions(plant.id)
			.then((actions) => {
				const waterSuggestions = computeSeasonalSuggestions(actions, 'water');
				const fertSuggestions = computeSeasonalSuggestions(actions, 'fertilize');
				setWaterSuggestion(waterSuggestions[season] ?? null);
				setFertSuggestion(fertSuggestions[season] ?? null);

				const lastOfType = (type: string, field: 'amountMl' | 'amountGrams' | 'potSizeCm') => {
					const match = [...actions].reverse().find((a) => a.type === type && a[field] != null);
					return match ? (match[field] as number) : null;
				};
				setLastWaterMl(lastOfType('water', 'amountMl'));
				setLastFertGrams(lastOfType('fertilize', 'amountGrams'));
				setLastPotSizeCm(lastOfType('repot', 'potSizeCm'));
			})
			.catch(() => { /* no suggestions without history */ });
	}, [plant.id, season, plant.lastWatered, plant.lastFertilized, plant.lastRepotted]);

	const applyWaterSuggestion = () => {
		if (waterSuggestion == null) return;
		const wateringSchedule = { ...(plant.wateringSchedule ?? defaultSchedule), [season]: waterSuggestion };
		onPatch({ ...plant, wateringSchedule });
		api.updatePlant(plant.id, { wateringSchedule }).catch(onRefresh);
	};

	const applyFertSuggestion = () => {
		if (fertSuggestion == null) return;
		const fertilizingSchedule = { ...(plant.fertilizingSchedule ?? defaultSchedule), [season]: fertSuggestion };
		onPatch({ ...plant, fertilizingSchedule });
		api.updatePlant(plant.id, { fertilizingSchedule }).catch(onRefresh);
	};

	const handleRepot = async (potSizeCm: number) => {
		onPatch({ ...plant, lastRepotted: new Date().toISOString(), potSizeCm });
		api.logAction(plant.id, 'repot', { potSizeCm }).catch(onRefresh);
	};

	const handleDialogConfirm = async (value: number) => {
		if (activeDialog === 'water') await onWater(value);
		else if (activeDialog === 'fertilize') await onFertilize(value);
		else if (activeDialog === 'repot') await handleRepot(value);
		setActiveDialog(null);
	};

	const handlePrune = async () => {
		onPatch({ ...plant, lastPruned: new Date().toISOString() });
		api.logAction(plant.id, 'prune').catch(onRefresh);
	};

	const handleAddIssue = async () => {
		if (!issueName) return;
		const detectedDate = new Date().toISOString();
		const tempId = `tmp-${Date.now()}`;
		const imageUrl = issueImageUrl || undefined;
		// Optimistic update
		onPatch({
			...plant,
			healthIssues: [
				...(plant.healthIssues ?? []),
				{ id: tempId, type: issueType, name: issueName as HealthIssue['name'], detectedDate, imageUrl },
			],
		});
		setIssueName('');
		setIssueImageUrl('');
		// Sync in background; SSE will reconcile with the real ID
		api.addHealthIssue(plant.id, { type: issueType, name: issueName, detectedDate, imageUrl }).catch(onRefresh);
	};

	const handleIssuePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		setIssueUploading(true);
		try {
			const url = await api.uploadImage(file);
			setIssueImageUrl(url);
		} catch {
			onRefresh();
		} finally {
			setIssueUploading(false);
			e.target.value = '';
		}
	};

	const handleResolveIssue = async (issueId: string) => {
		// Optimistic update
		onPatch({
			...plant,
			healthIssues: (plant.healthIssues ?? []).map((i) =>
				i.id === issueId ? { ...i, resolvedDate: new Date().toISOString() } : i
			),
		});
		api.resolveHealthIssue(plant.id, issueId).catch(onRefresh);
	};

	const handleAddProduct = async () => {
		if (!productName) return;
		const date = new Date().toISOString();
		const tempId = `tmp-${Date.now()}`;
		const reason = productReason || undefined;
		// Optimistic update
		onPatch({
			...plant,
			productHistory: [
				...(plant.productHistory ?? []),
				{ id: tempId, productName, date, reason },
			],
		});
		setProductName('');
		setProductReason('');
		api.addProductUsage(plant.id, { productName, date, reason }).catch(onRefresh);
	};

	const getIssueOptions = () => {
		switch (issueType) {
			case 'pest': return pestOptions;
			case 'disease': return diseaseOptions;
			case 'fungus': return fungusOptions;
		}
	};

	const getIssueLabel = (issue: HealthIssue): string => {
		const category = issue.type === 'pest' ? 'pests' : issue.type === 'disease' ? 'diseases' : 'fungi';
		return t(`${category}.${issue.name}`);
	};

	const activeIssues = (plant.healthIssues ?? []).filter((i) => !i.resolvedDate);
	const resolvedIssues = (plant.healthIssues ?? []).filter((i) => i.resolvedDate);

	return (
		<div className="plant-card">
			{plant.imageUrl && (
				<img className="plant-photo" src={withBase(plant.imageUrl)} alt={plant.name} />
			)}
			<h3>{plant.name}{plant.nickname && <span className="nickname"> "{plant.nickname}"</span>}</h3>
			<div className="species">{plant.species}</div>
			<div className="location">📍 {plant.location}</div>

			{plant.purchaseDate && (
				<div className="info-row">🛒 {t('plant.purchaseDate')}: {formatDate(plant.purchaseDate)}</div>
			)}

			<div className="status">
				<span className={`status-item ${waterStatus.overdue ? 'overdue' : 'ok'}`}>
					💧 {waterStatus.label}
				</span>
				<span className={`status-item ${fertStatus.overdue ? 'overdue' : 'ok'}`}>
					🧪 {fertStatus.label}
				</span>
			</div>
		
			{readings && (readings.temperature !== null || readings.ambientHumidity !== null) && (
				<div className="status">
					{readings.temperature !== null && (
						<span className="status-item ok">🌡️ {readings.temperature}°</span>
					)}
					{readings.ambientHumidity !== null && (
						<span className="status-item ok">💦 {readings.ambientHumidity}%</span>
					)}
				</div>
			)}

			{readings?.soilHumidity != null && (
				<div className="status">
					<span
						className={`status-item soil-humidity-pill ${soilNeedsWater ? 'overdue' : ''}`}
						style={soilThreshold != null ? getSoilHumidityStyle(readings.soilHumidity, soilThreshold) : undefined}
						title={soilThreshold != null ? `${t('plant.soilHumidityThreshold')}: ${soilThreshold}%` : undefined}
					>
						🪴 {readings.soilHumidity}%
					</span>
				</div>
			)}

			{plant.wateringSchedule && (
				<div className="seasonal-info">
					<small>💧 {t(`seasons.${season}`)}: ogni {plant.wateringSchedule[season]}g</small>
					{plant.fertilizingSchedule && (
						<small> | 🧪 ogni {plant.fertilizingSchedule[season]}g</small>
					)}
				</div>
			)}

			{waterSuggestion != null && waterSuggestion !== plant.wateringSchedule?.[season] && (
				<button
					type="button"
					className="btn btn-secondary btn-sm suggestion-btn"
					title={t('schedule.suggested')}
					onClick={applyWaterSuggestion}
				>
					{t('schedule.newSuggestionWater').replace('{season}', t(`seasons.${season}`)).replace('{days}', String(waterSuggestion))}
				</button>
			)}
			{fertSuggestion != null && fertSuggestion !== plant.fertilizingSchedule?.[season] && (
				<button
					type="button"
					className="btn btn-secondary btn-sm suggestion-btn"
					title={t('schedule.suggested')}
					onClick={applyFertSuggestion}
				>
					{t('schedule.newSuggestionFertilize').replace('{season}', t(`seasons.${season}`)).replace('{days}', String(fertSuggestion))}
				</button>
			)}

			{plant.recommendedFertilizer && (
				<div className="info-row">🌿 {t('plant.recommendedFertilizer')}: {plant.recommendedFertilizer}</div>
			)}

			<div className="info-dates">
				{plant.lastRepotted && <small>🪴 {t('plant.lastRepotted')}: {formatDate(plant.lastRepotted)}</small>}
				{plant.lastPruned && <small>✂️ {t('plant.lastPruned')}: {formatDate(plant.lastPruned)}</small>}
				{plant.lastFertilized && <small>🧪 {t('plant.lastFertilized')}: {formatDate(plant.lastFertilized)}</small>}
			</div>

			{activeIssues.length > 0 && (
				<div className="health-alert">
					⚠️ {activeIssues.map((i) => getIssueLabel(i)).join(', ')}
				</div>
			)}

			{plant.notes && (
				<p style={{ fontSize: '0.85rem', color: '#666', marginBottom: 12 }}>{plant.notes}</p>
			)}

			<div className="actions">
				<ActionButton disabled={isDoneToday(plant.lastWatered)} className="btn btn-water" onClick={() => setActiveDialog('water')} label={`💧 ${t('actions.water')}`} />
				<ActionButton disabled={isDoneToday(plant.lastFertilized)} className="btn btn-fertilize" onClick={() => setActiveDialog('fertilize')} label={`🧪 ${t('actions.fertilize')}`} />
				<ActionButton disabled={isDoneToday(plant.lastRepotted)} className="btn btn-secondary" onClick={() => setActiveDialog('repot')} label={`🪴 ${t('actions.repot')}`} />
				<ActionButton disabled={isDoneToday(plant.lastPruned)} className="btn btn-secondary" onClick={handlePrune} label={`✂️ ${t('actions.prune')}`} />
				<button className="btn btn-secondary" onClick={onEdit}>✏️</button>
			</div>

			<div className="card-expandable">
				<button className="btn btn-link" onClick={() => setShowHealth(!showHealth)}>
					🏥 {t('health.title')} ({(plant.healthIssues ?? []).length})
				</button>
				<button className="btn btn-link" onClick={() => setShowProducts(!showProducts)}>
					📦 {t('products.title')} ({(plant.productHistory ?? []).length})
				</button>
			</div>

			{showHealth && (
				<div className="health-section">
					<div className="health-form">
						<select value={issueType} onChange={(e) => { setIssueType(e.target.value as HealthIssueType); setIssueName(''); }}>
							<option value="pest">🐛 {t('health.pest')}</option>
							<option value="disease">🦠 {t('health.disease')}</option>
							<option value="fungus">🍄 {t('health.fungus')}</option>
						</select>
						<select value={issueName} onChange={(e) => setIssueName(e.target.value)}>
							<option value="">--</option>
							{getIssueOptions().map((opt) => {
								const category = issueType === 'pest' ? 'pests' : issueType === 'disease' ? 'diseases' : 'fungi';
								return <option key={opt} value={opt}>{t(`${category}.${opt}`)}</option>;
							})}
						</select>
						<button className="btn btn-primary btn-sm" onClick={handleAddIssue} disabled={!issueName}>+</button>
					</div>
					<div className="health-photo-row">
						<label className="btn btn-secondary btn-sm">
							📷 {issueUploading ? t('plant.uploading') : issueImageUrl ? t('plant.changePhoto') : t('plant.addPhoto')}
							<input type="file" accept="image/*" onChange={handleIssuePhoto} disabled={issueUploading} hidden />
						</label>
						{issueImageUrl && <img className="issue-thumb" src={withBase(issueImageUrl)} alt="" />}
					</div>

					{activeIssues.length > 0 && (
						<div className="health-list">
							<strong>{t('health.active')}:</strong>
							{activeIssues.map((issue) => (
								<div key={issue.id} className="health-item active">
									<span>{getIssueLabel(issue)} - {formatDate(issue.detectedDate)}</span>
									{issue.imageUrl && <img className="issue-thumb" src={withBase(issue.imageUrl)} alt="" />}
									<button className="btn btn-sm btn-secondary" onClick={() => handleResolveIssue(issue.id)}>✓</button>
								</div>
							))}
						</div>
					)}

					{resolvedIssues.length > 0 && (
						<div className="health-list">
							<strong>{t('health.history')}:</strong>
							{resolvedIssues.map((issue) => (
								<div key={issue.id} className="health-item resolved">
									<span>{getIssueLabel(issue)} - {formatDate(issue.detectedDate)} → {formatDate(issue.resolvedDate)}</span>
									{issue.imageUrl && <img className="issue-thumb" src={withBase(issue.imageUrl)} alt="" />}
									{issue.treatment && <small>{issue.treatment}</small>}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{showProducts && (
				<div className="products-section">
					<div className="product-form">
						<input placeholder={t('products.productName')} value={productName} onChange={(e) => setProductName(e.target.value)} />
						<input placeholder={t('products.reason')} value={productReason} onChange={(e) => setProductReason(e.target.value)} />
						<button className="btn btn-primary btn-sm" onClick={handleAddProduct} disabled={!productName}>+</button>
					</div>
					{(plant.productHistory ?? []).length > 0 && (
						<div className="product-list">
							{[...(plant.productHistory ?? [])].reverse().map((p) => (
								<div key={p.id} className="product-item">
									<strong>{p.productName}</strong>
									<span>{formatDate(p.date)}</span>
									{p.reason && <small>{p.reason}</small>}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{activeDialog && (
				<ActionDialog
					type={activeDialog}
					plant={plant}
					defaultValue={
						activeDialog === 'water' ? lastWaterMl ?? undefined
						: activeDialog === 'fertilize' ? lastFertGrams ?? undefined
						: lastPotSizeCm ?? plant.potSizeCm ?? undefined
					}
					onConfirm={handleDialogConfirm}
					onClose={() => setActiveDialog(null)}
				/>
			)}
		</div>
	);
}
