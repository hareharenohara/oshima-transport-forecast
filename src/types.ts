export type ShipType = "jet" | "large";
export type Direction = "from_oshima" | "to_oshima";

export interface ServiceInput {
  serviceId: string;
  voyageNumber: string;
  shipType: ShipType;
  direction: Direction;
  counterpartTerminal: string;
  scheduledDepartureJst: string;
  scheduledArrivalJst: string;
}

export interface HourlyPoint {
  locationId: string;
  timestampMs: number;
  values: Record<string, number>;
}

export interface NormalizedForecasts {
  weather: HourlyPoint[];
  marine: HourlyPoint[];
  fetchedAt: string;
}
