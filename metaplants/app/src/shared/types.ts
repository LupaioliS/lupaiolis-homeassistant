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
}
export interface PlantReadings {
	temperature: number | null;
	ambientHumidity: number | null;
	soilHumidity: number | null;
	updatedAt: string;
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

export interface PlantAction {
	id: string;
	plantId: string;
	type: 'water' | 'fertilize' | 'repot' | 'prune';
	date: string;
	notes?: string;
	amountMl?: number;
	amountGrams?: number;
	potSizeCm?: number;
}

export interface PlantActionOptions {
	notes?: string;
	amountMl?: number;
	amountGrams?: number;
	potSizeCm?: number;
}
