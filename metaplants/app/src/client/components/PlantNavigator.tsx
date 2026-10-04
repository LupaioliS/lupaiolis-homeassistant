import { useEffect, useRef } from 'react';
import type { Plant } from '../../shared/types';
import { t } from '../i18n';
import { withBase } from '../basePath';

export interface PlantNeeds {
	needsWater: boolean;
	needsFertilize: boolean;
	activeIssueCount: number;
}

interface PlantNavigatorProps {
	plants: Plant[];
	needs: Record<string, PlantNeeds>;
	/** Pianta la cui scheda è in cima allo schermo in questo momento. */
	activeId: string | null;
	onSelect: (plantId: string) => void;
	onSearch: () => void;
}

// Stessi colori dei pulsanti azione: azzurro acqua, ambra concime, rosso salute.
const RING_COLORS = { water: '#3b82f6', fertilize: '#f59e0b', health: '#ef4444' };
const RING_OK = '#4ade80';

/**
 * L'anello attorno alla foto è diviso in un arco per ogni bisogno attivo:
 * si legge lo stato di tutte le piante senza scorrere fino alle schede.
 */
function ringBackground(needs: PlantNeeds | undefined): string {
	const colors: string[] = [];
	if (needs?.needsWater) colors.push(RING_COLORS.water);
	if (needs?.needsFertilize) colors.push(RING_COLORS.fertilize);
	if (needs && needs.activeIssueCount > 0) colors.push(RING_COLORS.health);
	if (colors.length === 0) return RING_OK;
	if (colors.length === 1) return colors[0];
	const step = 100 / colors.length;
	const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`);
	return `conic-gradient(${stops.join(', ')})`;
}

/**
 * Barra delle piante in stile "storie", attaccata in cima allo schermo mentre si
 * scorre: un tocco porta alla scheda. Sul telefono le schede sono una colonna
 * sola e lunga, e arrivare all'ultima pianta voleva dire scorrere tutte le altre.
 */
export function PlantNavigator({ plants, needs, activeId, onSelect, onSearch }: PlantNavigatorProps) {
	const listRef = useRef<HTMLUListElement>(null);

	// Tiene la pianta attiva visibile nella barra mentre si scorrono le schede.
	// Solo in orizzontale: scrollIntoView sposterebbe anche la pagina.
	useEffect(() => {
		const list = listRef.current;
		if (!list || !activeId) return;
		const item = list.querySelector<HTMLElement>(`[data-plant-id="${CSS.escape(activeId)}"]`);
		if (!item) return;
		const target = item.offsetLeft - list.clientWidth / 2 + item.offsetWidth / 2;
		list.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
	}, [activeId]);

	return (
		<nav className="plant-nav" aria-label={t('nav.label')}>
			<ul className="plant-nav-list" ref={listRef}>
				<li>
					<button type="button" className="plant-nav-item" onClick={onSearch}>
						<span className="plant-nav-ring plant-nav-ring-search">
							<span className="plant-nav-avatar">🔍</span>
						</span>
						<span className="plant-nav-name">{t('nav.search')}</span>
					</button>
				</li>
				{plants.map((plant) => {
					const label = plant.nickname || plant.name;
					return (
						<li key={plant.id}>
							<button
								type="button"
								className={`plant-nav-item${plant.id === activeId ? ' active' : ''}`}
								data-plant-id={plant.id}
								onClick={() => onSelect(plant.id)}
								aria-current={plant.id === activeId ? 'true' : undefined}
							>
								<span className="plant-nav-ring" style={{ background: ringBackground(needs[plant.id]) }}>
									<span className="plant-nav-avatar">
										{plant.imageUrl
											? <img src={withBase(plant.imageUrl)} alt="" loading="lazy" decoding="async" width={52} height={52} />
											: '🪴'}
									</span>
								</span>
								<span className="plant-nav-name">{label}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
