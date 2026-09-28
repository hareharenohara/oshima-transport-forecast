import type { ShipType } from "../types.js";

export interface ScheduleService {
  id: string;
  serviceDate: string;
  serviceNumber: string;
  shipType: ShipType;
  origin: string;
  destination: string;
  counterpartTerminal: string;
  scheduledDepartureJst: string;
  scheduledArrivalJst: string;
  sourceUrl: string;
  sourceVersion: string;
}

export interface ScheduleProvider {
  readonly name: string;
  readonly sourceUrl: string;
  readonly sourceVersion: string;
  load(fromDate: string, toDate: string): Promise<ScheduleService[]>;
}
