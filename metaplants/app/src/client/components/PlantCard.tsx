import { useState } from 'react';
import type { Plant, HealthIssue, HealthIssueType, PestType, DiseaseType, FungusType } from '../../shared/types';
import { t } from '../i18n';
import { api } from '../api';

interface PlantCardProps {
	plant: Plant;
	onWater: () => void;
	onFertilize: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onRefresh: () => void;
}

function getDaysAgo(dateStr?: string): number | null {
	if (!dateStr) return null;
	const diff = Date.now() - new Date(dateStr).getTime();
	return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getStatus(lastAction: string | undefined, intervalDays: number): { overdue: boolean; label: string } {
	const daysAgo = getDaysAgo(lastAction);
	if (daysAgo === null) return { overdue: true, label: t('status.neverDone') };
	if (daysAgo >= intervalDays) return { overdue: true, label: `${daysAgo}g fa (${t('status.overdue')})` };
	const remaining = intervalDays - daysAgo;
	return { overdue: false, label: t('status.inDays').replace('{days}', String(remaining)) };
}

function formatDate(dateStr?: string): string {
	if (!dateStr) return '-';
	return new Date(dateStr).toLocaleDateString();
}

function getCurrentSeason(): 'spring' | 'summer' | 'autumn' | 'winter' {
	const month = new Date().getMonth();
	if (month >= 2 && month <= 4) return 'spring';
	if (month >= 5 && month <= 7) return 'summer';
	if (month >= 8 && month <= 10) return 'autumn';
	return 'winter';
}

function isDoneToday(dateStr?: string): boolean {
	if (!dateStr) return false;
	const today = new Date().toISOString().split('T')[0];
	return dateStr.split('T')[0] === today;
}

const pestOptions: PestType[] = ['aphids', 'spider_mites', 'mealybugs', 'scale', 'whiteflies', 'thrips', 'fungus_gnats', 'slugs'];
const diseaseOptions: DiseaseType[] = ['powdery_mildew', 'root_rot', 'leaf_spot', 'botrytis', 'rust', 'black_spot', 'downy_mildew'];
const fungusOptions: FungusType[] = ['fusarium', 'pythium', 'phytophthora', 'alternaria', 'cercospora', 'anthracnose'];

function ActionButton({ disabled, className, onClick, label }: { disabled: boolean; className: string; onClick: () => void; label: string }) {
	if (!disabled) {
		return <button className={className} onClick={onClick}>{label}</button>;
	}
	return (
		<div className="action-btn-wrapper disabled">
			<button className={`${className} disabled`} disabled>{label} ✓</button>
			<button className="btn-force" onClick={onClick} title="Forza">⟳</button>
		</div>
	);
}

export function PlantCard({ plant, onWater, onFertilize, onEdit, onDelete, onRefresh }: PlantCardProps) {
	const [showHealth, setShowHealth] = useState(false);
	const [showProducts, setShowProducts] = useState(false);
	const [issueType, setIssueType] = useState<HealthIssueType>('pest');
	const [issueName, setIssueName] = useState('');
	const [productName, setProductName] = useState('');
	const [productReason, setProductReason] = useState('');

	const waterStatus = getStatus(plant.lastWatered, plant.wateringIntervalDays);
	const fertStatus = getStatus(plant.lastFertilized, plant.fertilizingIntervalDays);
	const season = getCurrentSeason();

	const handleRepot = async () => {
		await api.logAction(plant.id, 'repot');
		onRefresh();
	};

	const handlePrune = async () => {
		await api.logAction(plant.id, 'prune');
		onRefresh();
	};

	const handleAddIssue = async () => {
		if (!issueName) return;
		await api.addHealthIssue(plant.id, {
			type: issueType,
			name: issueName,
			detectedDate: new Date().toISOString(),
		});
		setIssueName('');
		onRefresh();
	};

	const handleResolveIssue = async (issueId: string) => {
		await api.resolveHealthIssue(plant.id, issueId);
		onRefresh();
	};

	const handleAddProduct = async () => {
		if (!productName) return;
		await api.addProductUsage(plant.id, {
			productName,
			date: new Date().toISOString(),
			reason: productReason || undefined,
		});
		setProductName('');
		setProductReason('');
		onRefresh();
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
			<h3>{plant.name}</h3>
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

			{plant.wateringSchedule && (
				<div className="seasonal-info">
					<small>💧 {t(`seasons.${season}`)}: ogni {plant.wateringSchedule[season]}g</small>
					{plant.fertilizingSchedule && (
						<small> | 🧪 ogni {plant.fertilizingSchedule[season]}g</small>
					)}
				</div>
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
				<ActionButton disabled={isDoneToday(plant.lastWatered)} className="btn btn-water" onClick={onWater} label={`💧 ${t('actions.water')}`} />
				<ActionButton disabled={isDoneToday(plant.lastFertilized)} className="btn btn-fertilize" onClick={onFertilize} label={`🧪 ${t('actions.fertilize')}`} />
				<ActionButton disabled={isDoneToday(plant.lastRepotted)} className="btn btn-secondary" onClick={handleRepot} label={`🪴 ${t('actions.repot')}`} />
				<ActionButton disabled={isDoneToday(plant.lastPruned)} className="btn btn-secondary" onClick={handlePrune} label={`✂️ ${t('actions.prune')}`} />
				<button className="btn btn-secondary" onClick={onEdit}>✏️</button>
				<button className="btn btn-danger" onClick={onDelete}>🗑️</button>
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

					{activeIssues.length > 0 && (
						<div className="health-list">
							<strong>{t('health.active')}:</strong>
							{activeIssues.map((issue) => (
								<div key={issue.id} className="health-item active">
									<span>{getIssueLabel(issue)} - {formatDate(issue.detectedDate)}</span>
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
		</div>
	);
}
