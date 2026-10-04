import { t } from '../i18n';
import { ATTENTION_KINDS, type AttentionPrefs } from '../attentionPrefs';

interface AttentionSettingsProps {
	prefs: AttentionPrefs;
	onChange: (prefs: AttentionPrefs) => void;
	onClose: () => void;
}

/**
 * Sta in un dialog e non dentro il banner: spegnendo l'ultima voce attiva il
 * banner sparirebbe, e con lui l'unico modo per riaccenderla.
 */
export function AttentionSettings({ prefs, onChange, onClose }: AttentionSettingsProps) {
	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h2>{t('settings.title')}</h2>
				<div className="settings-section-title">{t('settings.attentionTitle')}</div>
				<div className="settings-toggles">
					{ATTENTION_KINDS.map((kind) => (
						<label key={kind} className="settings-toggle">
							<span>{t(`settings.${kind}`)}</span>
							<input
								type="checkbox"
								role="switch"
								checked={prefs[kind]}
								onChange={(e) => onChange({ ...prefs, [kind]: e.target.checked })}
							/>
						</label>
					))}
				</div>
				<p className="settings-hint">{t('settings.attentionHint')}</p>
				<div className="form-actions">
					<button type="button" className="btn btn-primary" onClick={onClose}>{t('settings.close')}</button>
				</div>
			</div>
		</div>
	);
}
