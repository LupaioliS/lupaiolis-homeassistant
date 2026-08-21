export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export type PestType = 'aphids' | 'spider_mites' | 'mealybugs' | 'scale' | 'whiteflies' | 'thrips' | 'fungus_gnats' | 'slugs';
export type DiseaseType = 'powdery_mildew' | 'root_rot' | 'leaf_spot' | 'botrytis' | 'rust' | 'black_spot' | 'downy_mildew';
export type FungusType = 'fusarium' | 'pythium' | 'phytophthora' | 'alternaria' | 'cercospora' | 'anthracnose';

export type HealthIssueType = 'pest' | 'disease' | 'fungus';

export interface HealthIssue {
	id: string;
	type: HealthIssueType;
	name: PestType | DiseaseType | FungusType;
	detectedDate: string;
	resolvedDate?: string;
	treatment?: string;
	notes?: string;
	imageUrl?: string;
}

export interface ProductUsage {
	id: string;
	productName: string;
	date: string;
	reason?: string;
	notes?: string;
}

export interface SeasonalSchedule {
	spring: number;
	summer: number;
	autumn: number;
	winter: number;

}

export interface PlantSensors {
	temperature?: string;       // es "sensor.salotto_temperatura"
	ambientHumidity?: string;   // es "sensor.salotto_umidita" (umidità dell'aria)
	soilHumidity?: string;      // es "sensor.vaso_monstera_umidita_terreno"
	// % sotto la quale il terreno è considerato troppo secco: vince sul programma a tempo.
	soilHumidityThreshold?: number;
	// Ultima lettura persistita del sensore terreno (aggiornata ad ogni poll).
	lastSoilHumidity?: number;
	// Il server ha rilevato un salto improvviso di umidità (probabile irrigazione):
	// il client mostra il prompt e poi chiama ack-soil-jump per azzerare questo flag.
	soilJumpPendingAck?: boolean;
	// Punti percentuali di risalita entro SOIL_JUMP_WINDOW_MS che fanno scattare il
	// rilevamento di un'irrigazione. Opzionale: senza valore vale SOIL_JUMP_DELTA.
	soilJumpDelta?: number;
	// Ultimo salto rilevato: evita di richiedere conferma due volte per la stessa
	// irrigazione mentre il terreno è ancora bagnato.
	lastSoilJumpAt?: string;
	// Deprecati: lo storico letture vive in history.json (vedi server/history.ts), che
	// tiene giorni di dati invece di 10 campioni e non riscrive plants.json ad ogni poll.
	// Restano solo per migrare i dati salvati dalle versioni <= 1.9.3.
	temperatureHistory?: number[];
	ambientHumidityHistory?: number[];
	soilHumidityHistory?: number[];
}

/**
 * Un campione dello storico sensori (history.json, vedi server/history.ts).
 * Vive qui perché la scheda ne disegna la curva: il grafico è client, i dati server.
 */
export interface SensorSample {
	/** epoch ms */
	t: number;
	v: number;
	/**
	 * Valore massimo osservato dentro il bucket, presente solo se superiore a `v`.
	 *
	 * Serve perché il picco subito dopo un'irrigazione dura pochi minuti: tenendo
	 * solo l'ultimo valore del bucket (giusto per la curva di asciugatura) il picco
	 * andava perso, e la calibrazione finiva per credere che il terreno "pieno"
	 * fosse molto più asciutto di quanto sia davvero.
	 */
	peak?: number;
	/**
	 * Valore minimo osservato dentro il bucket, presente solo se inferiore a `v`.
	 *
	 * Speculare a `peak`, e per un motivo speculare: il punto SECCO della scala è
	 * l'ultima lettura prima che l'acqua arrivi, e quella lettura cade spesso nello
	 * stesso quarto d'ora della risalita che la segue. Tenendo solo l'ultimo valore
	 * del bucket veniva sovrascritta dallo schizzo post-irrigazione, e il modello
	 * imparava come "secco" un terreno già bagnato.
	 */
	trough?: number;
}

/** Cosa ha visto il sensore attorno a una singola irrigazione registrata. */
export interface CalibrationObservation {
	/** Quando è stata registrata l'irrigazione. */
	at: string;
	/** Minimo grezzo nelle 12h precedenti = "qui era secco". */
	dry: number | null;
	/** Massimo grezzo attorno all'irrigazione = "qui era pieno". */
	wet: number | null;
	/** Chi ha dato l'acqua, se registrato: spiega un ciclo fuori scala. */
	source?: WaterSource;
}

/**
 * Rimappatura della scala grezza del sensore su quella che conta per la pianta,
 * imparata da come innaffi davvero: se innaffi sempre al 30%, per questa pianta
 * il 30% grezzo è "terra asciutta", cioè lo 0% utile.
 */
export interface SoilCalibration {
	// % grezza a cui l'utente innaffia di solito = 0% di acqua disponibile.
	dryPoint: number;
	// % grezza raggiunta subito dopo l'irrigazione = 100%.
	wetPoint: number;
	// Numero di irrigazioni con dati sensore da cui è stata ricavata.
	// 0 = nessuna irrigazione ancora osservata, la scala parte dalla soglia manuale.
	samples: number;
	// Ultima irrigazione registrata che ha aggiornato la scala. null finché non ce n'è.
	lastCalibratedAt?: string | null;
	// Le singole irrigazioni da cui esce la scala, dalla più vecchia alla più recente.
	// Servono a capire da dove arrivano i due numeri: il punto secco è la MEDIANA di
	// questi minimi, quindi un ciclo con una lettura anomala si vede solo qui.
	observations?: CalibrationObservation[];
}

export type PredictionConfidence = 'low' | 'medium' | 'high';

export interface WateringPrediction {
	// Data stimata della prossima irrigazione.
	nextWateringAt: string;
	// Giorni residui stimati (frazionari).
	daysLeft: number;
	// Velocità di asciugatura stimata, punti percentuali al giorno (> 0).
	dryRatePerDay: number | null;
	calibration: SoilCalibration | null;
	// Lettura corrente riportata sulla scala calibrata (0-100), se disponibile.
	normalizedSoilHumidity: number | null;
	// Media dei giorni fra irrigazioni osservata nella stagione corrente.
	averageCycleDays: number | null;
	/**
	 * Quanti giorni impiega il terreno ad andare dal pieno al livello a cui innaffi,
	 * alla velocità di asciugatura attuale: (bagnato − secco) / velocità.
	 *
	 * È la stessa domanda a cui risponde il programma stagionale, ma misurata sulla
	 * pianta invece che sulle tue abitudini — la media dei divari fra irrigazioni
	 * registra anche le ferie, i giorni saltati e la pioggia. Attenzione: il punto
	 * secco resta imparato da quando innaffi tu, quindi è "quanto ci mette ad
	 * arrivare al livello a cui la porti di solito", non un fabbisogno assoluto.
	 */
	fullCycleDays: number | null;
	// Cicli completi di irrigazione usati per addestrare il modello.
	cycles: number;
	confidence: PredictionConfidence;
	// 'sensor' = curva di asciugatura, 'history' = solo ritmo storico, 'blend' = entrambi.
	source: 'sensor' | 'history' | 'blend';
}
export interface PlantReadings {
	temperature: number | null;
	ambientHumidity: number | null;
	soilHumidity: number | null;
	updatedAt: string;
	// Stima interna: quando servirà la prossima irrigazione e come leggere la % grezza.
	prediction?: WateringPrediction | null;
	/**
	 * Il punto secco che verrebbe imparato registrando un'irrigazione ADESSO.
	 *
	 * Serve a non dover indovinare: prima di premere "acqua" si vede che numero
	 * finirà nella scala, e soprattutto se ne finirà uno. `null` = quel momento non
	 * insegnerebbe niente (troppi pochi dati prima della risalita), che è una cosa
	 * da sapere prima, non dopo.
	 *
	 * Sta qui e non dentro `prediction` di proposito: la previsione non esiste
	 * finché il modello non ha abbastanza dati, cioè proprio quando questa
	 * informazione serve di più.
	 */
	nextDryPoint?: number | null;
}

/** Un'entità di Home Assistant proposta nella scelta dei sensori. */
export interface HaEntityOption {
	entityId: string;
	name: string;
	deviceClass?: string;
	unit?: string;
	state?: string;
}

export interface HaEntityList {
	// false = nessun token HA (dev senza credenziali): il client resta sull'input libero.
	available: boolean;
	// true = l'elenco arriva dall'etichetta, false = fallback su tutti i sensori compatibili.
	labeled: boolean;
	label: string;
	entities: HaEntityOption[];
}

export interface Plant {
	id: string;
	name: string;
	nickname?: string;
	species: string;
	location: string;
	imageUrl?: string;
	// Deprecated: use wateringSchedule instead.
	wateringIntervalDays?: number;
	// Deprecated: use fertilizingSchedule instead.
	fertilizingIntervalDays?: number;
	lastWatered?: string;
	lastFertilized?: string;
	lastRepotted?: string;
	lastPruned?: string;
	purchaseDate?: string;
	recommendedFertilizer?: string;
	potSizeCm?: number;
	wateringSchedule?: SeasonalSchedule;
	fertilizingSchedule?: SeasonalSchedule;
	healthIssues?: HealthIssue[];
	productHistory?: ProductUsage[];
	notes?: string;
	createdAt: string;
	//Homeassistant:
	sensors?: PlantSensors;
}

/**
 * Chi ha dato l'acqua. È solo provenienza: la calibrazione tratta le tre allo
 * stesso modo, perché il sensore misura l'acqua arrivata al vaso, non chi l'ha
 * versata. Una pioggia che sul balcone coperto non bagna il terreno non produce
 * nessuna risalita, quindi non insegna niente — se ne occupa già la curva.
 */
export type WaterSource = 'manual' | 'rain' | 'irrigation';

export interface PlantAction {
	id: string;
	plantId: string;
	type: 'water' | 'fertilize' | 'repot' | 'prune';
	date: string;
	notes?: string;
	amountMl?: number;
	amountGrams?: number;
	potSizeCm?: number;
	// Solo per le irrigazioni. Assente = 'manual', così le azioni già registrate
	// restano valide senza migrazione.
	source?: WaterSource;
}

export interface PlantActionOptions {
	notes?: string;
	amountMl?: number;
	amountGrams?: number;
	potSizeCm?: number;
	source?: WaterSource;
}
