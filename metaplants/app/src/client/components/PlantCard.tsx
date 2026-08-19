import { useEffect, useMemo, useRef, useState } from 'react';
import type { Plant, PlantAction, HealthIssue, HealthIssueType, PestType, DiseaseType, FungusType, SeasonalSchedule, PlantReadings, WateringPrediction } from '../../shared/types';
import { t } from '../i18n';
import { api } from '../api';
import { computeSeasonalSuggestions, getCurrentSeason } from '../season';
import { describeDue, getIntervalForSeason, DAY_MS } from '../plantStatus';
import { assessWater, isPredictionDueNow } from '../waterStatus';
import { withBase } from '../basePath';
import { ActionDialog, type ActionDialogType } from './ActionDialog';
import { WaterSplashEffect, DROPLET_FALL_DURATION_S, DROPLET_STAGGER_S, DROPLET_ARRIVAL_FRACTION, type SplashTarget } from './WaterSplashEffect';
import { WaterFillOverlay, FILL_DURATION_MS, type FillTarget } from './WaterFillOverlay';
import { FertilizeSproutEffect, SPROUT_DURATION_MS } from './FertilizeSproutEffect';
import { SoilHistoryChart } from './SoilHistoryChart';

interface PlantCardProps {
	plant: Plant;
	readings?: PlantReadings;
	/** Storico azioni della pianta, caricato una volta sola da App. */
	actions?: PlantAction[];
	onWater: (amountMl: number) => void | Promise<void>;
	onFertilize: (amountGrams: number) => void | Promise<void>;
	onEdit: () => void;
	onRefresh: () => void;
	onPatch: (plant: Plant) => void;
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
function getSoilHumidityStyle(value: number, dryReference: number, wetReference?: number): { background: string; color: string } {
	// 0 = terreno asciutto, 1 = bagnato. Con la calibrazione appresa i due estremi
	// sono quelli reali della pianta; altrimenti si usa soglia e soglia + 30 punti.
	const wet = wetReference != null && wetReference > dryReference ? wetReference : dryReference + 30;
	const ratio = Math.min(1, Math.max(0, (value - dryReference) / (wet - dryReference)));
	const bgColor = mixColor(SOIL_DRY_BG, SOIL_WET_BG, ratio);
	const bgColorSoft = mixColor(SOIL_DRY_BG, SOIL_WET_BG, Math.min(1, ratio + 0.15));
	const textColor = mixColor(SOIL_DRY_TEXT, SOIL_WET_TEXT, ratio);
	return {
		background: `linear-gradient(135deg, ${bgColor}, ${bgColorSoft})`,
		color: textColor,
	};
}

function getStatus(lastAction: string | undefined, intervalDays: number): { overdue: boolean; label: string; dueAt: number | null } {
	const due = describeDue(lastAction, intervalDays);
	if (due.dueAt === null) return { overdue: true, label: t('status.neverDone'), dueAt: null };

	if (due.overdue) {
		const label = due.overdueMs < DAY_MS
			? `${t('status.hoursAgo').replace('{hours}', String(due.overdueHours))} (${t('status.overdue')})`
			: `${t('status.daysAgo').replace('{days}', String(due.overdueDays))} (${t('status.overdue')})`;
		return { overdue: true, label, dueAt: due.dueAt };
	}

	// Giorni di CALENDARIO, non frazioni arrotondate per eccesso: "tra 2g" significa
	// che scade dopodomani, non "fra un tempo che potrebbe finire domani mattina".
	if (due.remainingMs < DAY_MS) {
		return { overdue: false, label: t('status.inHours').replace('{hours}', String(due.remainingHours)), dueAt: due.dueAt };
	}
	if (due.remainingDays <= 1) return { overdue: false, label: t('status.tomorrow'), dueAt: due.dueAt };
	return { overdue: false, label: t('status.inDays').replace('{days}', String(due.remainingDays)), dueAt: due.dueAt };
}

function formatDate(dateStr?: string): string {
	if (!dateStr) return '-';
	return new Date(dateStr).toLocaleDateString();
}

/** "18 ago, 09:12" — per gli elenchi, dove la data estesa ruberebbe tutta la riga. */
function formatShortDateTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function formatDateTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	});
}

/** "adesso" / "~5h" / "~3g": la stima è una durata, non una data di calendario. */
function formatPredictionEta(prediction: WateringPrediction): string {
	if (isPredictionDueNow(prediction)) return t('prediction.now');
	if (prediction.daysLeft < 1) {
		const hours = Math.max(1, Math.round(prediction.daysLeft * 24));
		return t('prediction.inHours').replace('{hours}', String(hours));
	}
	return t('prediction.inDays').replace('{days}', String(Math.round(prediction.daysLeft)));
}

// I dettagli sono restituiti come righe separate, non come stringa già unita:
// finiscono sia nel `title` (mouse) sia nel pannello che si apre al tocco, visto
// che sul telefono il long press non mostra i tooltip.
function buildPredictionInfo(prediction: WateringPrediction): string[] {
	const lines = [
		`${t('prediction.next')}: ${formatDateTime(new Date(prediction.nextWateringAt).getTime())}`,
		`${t('prediction.confidence')}: ${t(`prediction.confidence_${prediction.confidence}`)}`,
	];
	if (prediction.dryRatePerDay != null) {
		lines.push(t('prediction.dryRate').replace('{rate}', String(prediction.dryRatePerDay)));
	}
	if (prediction.averageCycleDays != null) {
		lines.push(t('prediction.averageCycle').replace('{days}', String(prediction.averageCycleDays)));
	}
	if (prediction.cycles > 0) {
		lines.push(t('prediction.learnedFrom').replace('{count}', String(prediction.cycles)));
	}
	return lines;
}

function buildCalibrationInfo(prediction: WateringPrediction): string[] {
	const calibration = prediction.calibration;
	if (!calibration) return [];
	const lines = [
		t('prediction.calibrationTitle'),
		t('prediction.calibrationDry').replace('{value}', String(calibration.dryPoint)),
		t('prediction.calibrationWet').replace('{value}', String(calibration.wetPoint)),
	];
	// La scala si muove solo sulle irrigazioni registrate: dirlo qui evita di
	// chiedersi perché il numero non cambia mentre quello grezzo balla.
	if (calibration.samples > 0) {
		lines.push(t('prediction.calibrationSamples').replace('{count}', String(calibration.samples)));
	} else {
		lines.push(t('prediction.calibrationPending'));
	}
	// Le singole irrigazioni da cui escono i due numeri. Il punto secco è la mediana
	// di questi minimi: senza vederli, un ciclo con una lettura anomala sposta la
	// scala e non c'è modo di accorgersene.
	if (calibration.observations?.length) {
		lines.push(t('prediction.calibrationCyclesTitle'));
		for (const o of calibration.observations) {
			lines.push(
				t('prediction.calibrationCycle')
					.replace('{date}', formatShortDateTime(new Date(o.at).getTime()))
					.replace('{dry}', o.dry == null ? '—' : String(o.dry))
					.replace('{wet}', o.wet == null ? '—' : String(o.wet)),
			);
		}
	}
	return lines;
}

/**
 * Pillola con dettagli: al passaggio del mouse li mostra come tooltip, al
 * tocco/click apre il pannello sotto. Senza dettagli resta uno span normale.
 */
function InfoPill({ id, className, style, lines, openId, onToggle, innerRef, children }: {
	id: string;
	className: string;
	style?: React.CSSProperties;
	lines: string[];
	openId: string | null;
	onToggle: (id: string | null) => void;
	innerRef?: React.RefObject<HTMLSpanElement | null>;
	children: React.ReactNode;
}) {
	if (lines.length === 0) {
		return <span ref={innerRef} className={className} style={style}>{children}</span>;
	}
	const isOpen = openId === id;
	const toggle = () => onToggle(isOpen ? null : id);
	return (
		<span
			ref={innerRef}
			className={`${className} has-info${isOpen ? ' is-open' : ''}`}
			style={style}
			title={lines.join('\n')}
			role="button"
			tabIndex={0}
			aria-expanded={isOpen}
			onClick={toggle}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					toggle();
				}
			}}
		>
			{children}
		</span>
	);
}

export function isDoneToday(dateStr?: string): boolean {
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
			<button className="btn-force" onClick={() => setForced(true)} title="Forza">🔓</button>
		</div>
	);
}

export function PlantCard({ plant, readings, actions, onWater, onFertilize, onEdit, onRefresh, onPatch }: PlantCardProps) {
	const [showHealth, setShowHealth] = useState(false);
	const [showProducts, setShowProducts] = useState(false);
	const [issueType, setIssueType] = useState<HealthIssueType>('pest');
	const [issueName, setIssueName] = useState('');
	const [issueImageUrl, setIssueImageUrl] = useState('');
	const [issueUploading, setIssueUploading] = useState(false);
	const [productName, setProductName] = useState('');
	const [productReason, setProductReason] = useState('');
	const [activeDialog, setActiveDialog] = useState<ActionDialogType | null>(null);
	const [localActions, setLocalActions] = useState<PlantAction[]>([]);
	// Pillola di cui è aperto il pannello dei dettagli (equivalente al tooltip, ma toccabile).
	const [openInfo, setOpenInfo] = useState<string | null>(null);
	// Il grafico si monta (e quindi scarica lo storico) solo quando viene aperto:
	// altrimenti sarebbe una richiesta per scheda ad ogni caricamento della pagina.
	const [showChart, setShowChart] = useState(false);
	const cardRef = useRef<HTMLDivElement>(null);
	const waterPillRef = useRef<HTMLSpanElement>(null);
	const waterButtonRef = useRef<HTMLDivElement>(null);
	const fertPillRef = useRef<HTMLSpanElement>(null);
	const fertButtonRef = useRef<HTMLDivElement>(null);
	const targetRectsRef = useRef<Record<string, FillTarget>>({});
	const [splashTargets, setSplashTargets] = useState<SplashTarget[]>([]);
	const [fillTargets, setFillTargets] = useState<FillTarget[]>([]);
	const [sproutTargets, setSproutTargets] = useState<FillTarget[]>([]);

	const season = getCurrentSeason();
	const fertIntervalDays = getIntervalForSeason(plant.fertilizingSchedule, season, plant.fertilizingIntervalDays ?? 14);
	const fertStatus = getStatus(plant.lastFertilized, fertIntervalDays);

	const water = assessWater(plant, readings, season);
	const prediction = water.prediction;
	const soilThreshold = plant.sensors?.soilHumidityThreshold;
	// Il punto "asciutto" appreso descrive la pianta meglio della soglia scritta a mano.
	const soilDryReference = prediction?.calibration?.dryPoint ?? soilThreshold;
	const soilNeedsWater = water.soilNeedsWater;
	// % sulla scala della pianta: quando c'è è lei a comandare, e la grezza scala a margine.
	const normalizedSoil = water.soil.normalized;
	const scheduleStatus = getStatus(plant.lastWatered, water.intervalDays);

	// Finché la stima non ha imparato abbastanza resta a margine: qui comanda solo
	// quando assessWater la promuove (confidence alta).
	const waterStatus = soilNeedsWater
		? {
			overdue: true,
			label: water.soil.source === 'ai' ? t('status.aiSoilWater') : t('status.soilSensorWater'),
			dueAt: scheduleStatus.dueAt,
		}
		: water.source === 'prediction' && prediction
			? { overdue: water.overdue, label: `🧠 ${formatPredictionEta(prediction)}`, dueAt: scheduleStatus.dueAt }
			: scheduleStatus;

	const waterInfo = [
		...(water.source === 'prediction' && prediction ? buildPredictionInfo(prediction) : []),
		...(scheduleStatus.dueAt != null ? [`${t('status.scheduleDue')}: ${formatDateTime(scheduleStatus.dueAt)}`] : []),
	];
	const fertInfo = fertStatus.dueAt != null
		? [`${t('status.scheduleDue')}: ${formatDateTime(fertStatus.dueAt)}`]
		: [];
	const soilInfo = [
		// Con una scala calibrata la soglia manuale non innesca più niente: dirlo evita
		// di andarla a ritoccare quando l'allerta non arriva al numero che ci si aspetta.
		...(water.soil.learned ? [t('prediction.rawSecondary')] : []),
		...(soilThreshold != null
			? [`${t('plant.soilHumidityThreshold')}: ${soilThreshold}%${water.soil.learned ? ` (${t('prediction.thresholdUnused')})` : ''}`]
			: []),
		...(prediction ? buildCalibrationInfo(prediction) : []),
	];
	const calibratedInfo = prediction ? buildCalibrationInfo(prediction) : [];
	const predictionInfo = prediction ? buildPredictionInfo(prediction) : [];

	const infoByPill: Record<string, string[]> = {
		water: waterInfo,
		fert: fertInfo,
		soil: soilInfo,
		calibrated: calibratedInfo,
		prediction: predictionInfo,
	};
	const openInfoLines = openInfo ? infoByPill[openInfo] ?? [] : [];

	// Le azioni arrivano già caricate da App (una richiesta per tutte le piante).
	// localActions tiene quelle registrate in questa sessione, che il server non
	// ritrasmette via SSE: si azzerano da sole al prossimo caricamento completo.
	useEffect(() => { setLocalActions([]); }, [actions]);

	const allActions = useMemo(
		() => (localActions.length > 0 ? [...(actions ?? []), ...localActions] : actions ?? []),
		[actions, localActions],
	);

	// Istanti delle irrigazioni registrate: il grafico ci mette i marker 💧, che sono
	// esattamente i momenti in cui la scala calibrata si è mossa.
	const wateringTimes = useMemo(
		() => allActions
			.filter((a) => a.type === 'water')
			.map((a) => new Date(a.date).getTime())
			.filter((ms) => Number.isFinite(ms)),
		[allActions],
	);

	const waterSuggestion = useMemo(
		() => computeSeasonalSuggestions(allActions, 'water')[season] ?? null,
		[allActions, season],
	);
	const fertSuggestion = useMemo(
		() => computeSeasonalSuggestions(allActions, 'fertilize')[season] ?? null,
		[allActions, season],
	);

	const lastOfType = (type: string, field: 'amountMl' | 'amountGrams' | 'potSizeCm'): number | null => {
		const match = [...allActions].reverse().find((a) => a.type === type && a[field] != null);
		return match ? (match[field] as number) : null;
	};
	const lastWaterMl = lastOfType('water', 'amountMl');
	const lastFertGrams = lastOfType('fertilize', 'amountGrams');
	const lastPotSizeCm = lastOfType('repot', 'potSizeCm');

	const rememberAction = (type: PlantAction['type'], options: { amountMl?: number; amountGrams?: number; potSizeCm?: number } = {}) => {
		setLocalActions((prev) => [...prev, {
			id: `local-${Date.now()}`,
			plantId: plant.id,
			type,
			date: new Date().toISOString(),
			...options,
		}]);
	};

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
		rememberAction('repot', { potSizeCm });
		api.logAction(plant.id, 'repot', { potSizeCm }).catch(onRefresh);
	};

	const computeFillTarget = (id: string, el: HTMLElement, cardRect: DOMRect): FillTarget => {
		const rect = el.getBoundingClientRect();
		const radius = getComputedStyle(el).borderRadius;
		return {
			id,
			left: rect.left - cardRect.left,
			top: rect.top - cardRect.top,
			width: rect.width,
			height: rect.height,
			radius,
		};
	};

	const measureTarget = (id: string, el: HTMLElement, cardRect: DOMRect): SplashTarget => {
		const fillTarget = computeFillTarget(id, el, cardRect);
		targetRectsRef.current[id] = fillTarget;
		return { id, x: fillTarget.left + fillTarget.width / 2, y: fillTarget.top + fillTarget.height / 2 };
	};

	const startWaterFill = (id: string) => {
		const rect = targetRectsRef.current[id];
		if (!rect) return;
		setFillTargets((prev) => [...prev, rect]);
		setTimeout(() => setFillTargets((prev) => prev.filter((t) => t.id !== id)), FILL_DURATION_MS);
	};

	const launchWaterDroplets = () => {
		const cardRect = cardRef.current?.getBoundingClientRect();
		if (!cardRect) return;
		const targets: SplashTarget[] = [];
		if (waterPillRef.current) targets.push(measureTarget('pill', waterPillRef.current, cardRect));
		const buttonEl = waterButtonRef.current?.querySelector('button');
		if (buttonEl) targets.push(measureTarget('button', buttonEl, cardRect));
		setSplashTargets(targets);
		// Il riempimento parte mentre la goccia tocca il target, non quando finisce di rimbalzare.
		targets.forEach((target, i) => {
			const arrivalMs = (i * DROPLET_STAGGER_S + DROPLET_ARRIVAL_FRACTION * DROPLET_FALL_DURATION_S) * 1000;
			setTimeout(() => startWaterFill(target.id), arrivalMs);
		});
	};

	const handleDropletSettle = (id: string) => {
		setSplashTargets((prev) => prev.filter((t) => t.id !== id));
	};

	const launchFertilizeSprouts = () => {
		const cardRect = cardRef.current?.getBoundingClientRect();
		if (!cardRect) return;
		const targets: FillTarget[] = [];
		if (fertPillRef.current) targets.push(computeFillTarget('fert-pill', fertPillRef.current, cardRect));
		const buttonEl = fertButtonRef.current?.querySelector('button');
		if (buttonEl) targets.push(computeFillTarget('fert-button', buttonEl, cardRect));
		setSproutTargets(targets);
		setTimeout(() => setSproutTargets([]), SPROUT_DURATION_MS);
	};

	const handleDialogConfirm = async (value: number) => {
		if (activeDialog === 'water') {
			rememberAction('water', { amountMl: value });
			await onWater(value);
			launchWaterDroplets();
		}
		else if (activeDialog === 'fertilize') {
			rememberAction('fertilize', { amountGrams: value });
			await onFertilize(value);
			launchFertilizeSprouts();
		}
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
		<div className="plant-card" ref={cardRef}>
			<WaterSplashEffect targets={splashTargets} onSettle={handleDropletSettle} />
			<WaterFillOverlay targets={fillTargets} />
			<FertilizeSproutEffect targets={sproutTargets} />
			{plant.imageUrl && (
				<img
					className="plant-photo"
					src={withBase(plant.imageUrl)}
					alt={plant.name}
					loading="lazy"
					decoding="async"
					width={400}
					height={160}
				/>
			)}
			<h3>{plant.name}{plant.nickname && <span className="nickname"> "{plant.nickname}"</span>}</h3>
			<div className="species">{plant.species}</div>
			<div className="location">📍 {plant.location}</div>

			{plant.purchaseDate && (
				<div className="info-row">🛒 {t('plant.purchaseDate')}: {formatDate(plant.purchaseDate)}</div>
			)}

			<div className="status">
				<InfoPill
					id="water"
					innerRef={waterPillRef}
					className={`status-item ${waterStatus.overdue ? 'overdue' : 'ok'}`}
					lines={waterInfo}
					openId={openInfo}
					onToggle={setOpenInfo}
				>
					💧 {waterStatus.label}
				</InfoPill>
				<InfoPill
					id="fert"
					innerRef={fertPillRef}
					className={`status-item ${fertStatus.overdue ? 'overdue' : 'ok'}`}
					lines={fertInfo}
					openId={openInfo}
					onToggle={setOpenInfo}
				>
					🧪 {fertStatus.label}
				</InfoPill>
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
					{/* Prima la lettura riportata sulla scala della pianta: se innaffi sempre
					    al 30%, quel 30% grezzo qui è 0% — ed è questo 0% a far scattare
					    l'allerta, non il numero del sensore, che si scalibra. */}
					{normalizedSoil != null && (
						<InfoPill
							id="calibrated"
							className={`status-item soil-humidity-pill ${soilNeedsWater ? 'overdue' : ''}`}
							style={getSoilHumidityStyle(normalizedSoil, 0, 100)}
							lines={calibratedInfo}
							openId={openInfo}
							onToggle={setOpenInfo}
						>
							🧠 {normalizedSoil}%
						</InfoPill>
					)}
					<InfoPill
						id="soil"
						className={
							normalizedSoil != null
								? 'status-item soil-raw-pill'
								: `status-item soil-humidity-pill ${soilNeedsWater ? 'overdue' : ''}`
						}
						style={normalizedSoil == null && soilDryReference != null
							? getSoilHumidityStyle(readings.soilHumidity, soilDryReference, prediction?.calibration?.wetPoint)
							: undefined}
						lines={soilInfo}
						openId={openInfo}
						onToggle={setOpenInfo}
					>
						🪴 {readings.soilHumidity}%
					</InfoPill>
					<button
						type="button"
						className={`status-item chart-toggle ${showChart ? 'active' : ''}`}
						onClick={() => setShowChart((v) => !v)}
						title={t('chart.title')}
						aria-expanded={showChart}
					>
						📈
					</button>
				</div>
			)}

			{showChart && (
				<SoilHistoryChart
					plantId={plant.id}
					waterings={wateringTimes}
					calibration={prediction?.calibration}
					threshold={soilThreshold}
					jumpDelta={plant.sensors?.soilJumpDelta}
				/>
			)}

			{/* Finché la stima non guida lo stato resta un'informazione a margine. */}
			{prediction && water.source !== 'prediction' && (
				<div className="status">
					<InfoPill
						id="prediction"
						className={`status-item prediction-pill confidence-${prediction.confidence}`}
						lines={predictionInfo}
						openId={openInfo}
						onToggle={setOpenInfo}
					>
						🧠 {t('prediction.label')}: {formatPredictionEta(prediction)}
						{prediction.confidence === 'low' && ` · ${t('prediction.learning')}`}
					</InfoPill>
				</div>
			)}

			{/* Sul telefono il tooltip non esiste: gli stessi dettagli si aprono qui al tocco. */}
			{openInfoLines.length > 0 && (
				<div className="info-panel" onClick={() => setOpenInfo(null)}>
					{openInfoLines.map((line, i) => (
						<div key={i} className="info-panel-line">{line}</div>
					))}
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
				<div ref={waterButtonRef} className="action-btn-measure-wrap">
					<ActionButton disabled={isDoneToday(plant.lastWatered)} className="btn btn-water" onClick={() => setActiveDialog('water')} label={`💧 ${t('actions.water')}`} />
				</div>
				<div ref={fertButtonRef} className="action-btn-measure-wrap">
					<ActionButton disabled={isDoneToday(plant.lastFertilized)} className="btn btn-fertilize" onClick={() => setActiveDialog('fertilize')} label={`🧪 ${t('actions.fertilize')}`} />
				</div>
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
						{issueImageUrl && <img className="issue-thumb" src={withBase(issueImageUrl)} alt="" loading="lazy" decoding="async" />}
					</div>

					{activeIssues.length > 0 && (
						<div className="health-list">
							<strong>{t('health.active')}:</strong>
							{activeIssues.map((issue) => (
								<div key={issue.id} className="health-item active">
									<span>{getIssueLabel(issue)} - {formatDate(issue.detectedDate)}</span>
									{issue.imageUrl && <img className="issue-thumb" src={withBase(issue.imageUrl)} alt="" loading="lazy" decoding="async" />}
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
									{issue.imageUrl && <img className="issue-thumb" src={withBase(issue.imageUrl)} alt="" loading="lazy" decoding="async" />}
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
