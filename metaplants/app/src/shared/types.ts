export interface Plant {
	id: string;
	name: string;
	species: string;
	location: string;
	imageUrl?: string;
	wateringIntervalDays: number;
	fertilizingIntervalDays: number;
	lastWatered?: string;
	lastFertilized?: string;
	notes?: string;
	createdAt: string;
}

export interface PlantAction {
	id: string;
	plantId: string;
	type: 'water' | 'fertilize';
	date: string;
	notes?: string;
}
