import { useState } from 'react';
import type { AssistantAction, AssistantCard, AssistantState, Plant } from '../../shared/types';
import { api } from '../api';
import { t } from '../i18n';

interface AssistantPanelProps {
	state: AssistantState;
	plants: Plant[];
	onChange: (state: AssistantState) => void;
	onSelectPlant: (plantId: string) => void;
}

// Le card applicate da sola restano visibili così a lungo, col pulsante "annulla".
const AUTO_APPLIED_VISIBLE_MS = 2 * 24 * 60 * 60 * 1000;

const KIND_EMOJI: Record<AssistantCard['kind'], string> = {
	advice: '💡',
	question: '❓',
	action: '🛠️',
};

const HEALTH_GROUP: Record<string, string> = { pest: 'pests', disease: 'diseases', fungus: 'fungi' };

function formatShortDate(iso: string): string {
	return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Il cambio proposto in parole, con il valore attuale quando si conosce. */
function describeAction(action: AssistantAction, plant: Plant | undefined): string {
	switch (action.type) {
		case 'set_watering_schedule':
		case 'set_fertilizing_schedule': {
			const schedule = action.type === 'set_watering_schedule' ? plant?.wateringSchedule : plant?.fertilizingSchedule;
			const current = action.season ? schedule?.[action.season] : undefined;
			return t(`assistant.action.${action.type}`)
				.replace('{season}', t(`seasons.${action.season}`).toLowerCase())
				.replace('{from}', current != null ? `${current} → ` : '')
				.replace('{value}', String(action.value));
		}
		case 'set_soil_threshold':
			return t('assistant.action.set_soil_threshold').replace('{value}', String(action.value));
		case 'add_health_issue':
			return t('assistant.action.add_health_issue')
				.replace('{name}', t(`${HEALTH_GROUP[action.issueType ?? 'pest']}.${action.issueName}`));
		case 'resolve_health_issue':
			return t('assistant.action.resolve_health_issue');
		case 'append_note':
			return t('assistant.action.append_note').replace('{text}', action.text ?? '');
	}
}

function isVisible(card: AssistantCard, now: number): boolean {
	if (card.status === 'open') return true;
	return card.status === 'applied' && card.autoApplied === true && now - new Date(card.updatedAt).getTime() < AUTO_APPLIED_VISIBLE_MS;
}

export function AssistantPanel({ state, plants, onChange, onSelectPlant }: AssistantPanelProps) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState(false);

	if (!state.enabled) return null;

	const now = Date.now();
	const cards = state.cards.filter((c) => isVisible(c, now));
	const plantById = new Map(plants.map((p) => [p.id, p]));

	const run = async (key: string, work: () => Promise<AssistantState>) => {
		setBusy(key);
		setError(null);
		try {
			onChange(await work());
		} catch (err) {
			setError((err as Error).message === 'HTTP 429' ? t('assistant.tooSoon') : t('assistant.failed'));
		} finally {
			setBusy(null);
		}
	};

	return (
		<section className="assistant-panel">
			<header className="assistant-header">
				<button type="button" className="assistant-title" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
					🤖 {t('assistant.title')}
					{cards.length > 0 && <span className="assistant-count">{cards.length}</span>}
				</button>
				<button
					type="button"
					className="btn btn-secondary assistant-run"
					disabled={state.running || busy === 'run'}
					onClick={() => run('run', api.runAssistant)}
				>
					{state.running || busy === 'run' ? t('assistant.running') : t('assistant.runNow')}
				</button>
			</header>

			{!collapsed && (
				<>
					{error && <p className="assistant-error">{error}</p>}
					{state.lastError && !state.running && (
						<p className="assistant-error">{t('assistant.lastError')}: {state.lastError}</p>
					)}
					{cards.length === 0 ? (
						<p className="assistant-empty">
							{state.lastRunAt
								? t('assistant.empty').replace('{date}', formatShortDate(state.lastRunAt))
								: t('assistant.neverRun')}
						</p>
					) : (
						<ul className="assistant-cards">
							{cards.map((card) => {
								const plant = card.plantId ? plantById.get(card.plantId) : undefined;
								const pending = busy === card.id;
								return (
									<li key={card.id} className={`assistant-card assistant-card-${card.kind}${card.autoApplied ? ' is-auto' : ''}`}>
										<div className="assistant-card-head">
											<span className="assistant-card-emoji">{KIND_EMOJI[card.kind]}</span>
											<strong>{card.title}</strong>
											{plant && (
												<button type="button" className="assistant-card-plant" onClick={() => onSelectPlant(plant.id)}>
													{plant.nickname || plant.name}
												</button>
											)}
										</div>
										<p className="assistant-card-body">{card.body}</p>

										{card.action && (
											<p className="assistant-card-action">
												{card.autoApplied ? `✅ ${t('assistant.autoApplied')}: ` : ''}
												{describeAction(card.action, plant)}
											</p>
										)}

										<div className="assistant-card-buttons">
											{card.kind === 'question' && card.options?.map((option) => (
												<button
													key={option}
													type="button"
													className="btn btn-secondary"
													disabled={pending}
													onClick={() => run(card.id, () => api.answerAssistantCard(card.id, option))}
												>
													{option}
												</button>
											))}
											{card.action && card.status === 'open' && (
												<button
													type="button"
													className="btn btn-primary"
													disabled={pending}
													onClick={() => run(card.id, () => api.assistantCardAction(card.id, 'apply'))}
												>
													{t('assistant.apply')}
												</button>
											)}
											{card.status === 'applied' && (
												<button
													type="button"
													className="btn btn-secondary"
													disabled={pending}
													onClick={() => run(card.id, () => api.assistantCardAction(card.id, 'undo'))}
												>
													{t('assistant.undo')}
												</button>
											)}
											<button
												type="button"
												className="assistant-dismiss"
												disabled={pending}
												aria-label={t('assistant.dismiss')}
												title={t('assistant.dismiss')}
												onClick={() => run(card.id, () => api.assistantCardAction(card.id, 'dismiss'))}
											>
												✕
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</>
			)}
		</section>
	);
}
