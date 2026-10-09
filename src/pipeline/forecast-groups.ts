import type { ServiceInput } from "../types.js";
import { departureTime } from "../worker/update-policy.js";

export interface ForecastGroup {
  id: string; date: string; horizon: number; label: string; shipType: "jet" | "large"; members: ServiceInput[];
}

export function groupForecastServices(services: ServiceInput[], now: Date): ForecastGroup[] {
  const currentDay = Math.floor((now.getTime() + 9 * 3_600_000) / 86_400_000);
  const groups = new Map<string, ForecastGroup>();
  for (const service of services) {
    const jst = new Date(departureTime(service) + 9 * 3_600_000);
    const horizon = Math.floor(jst.getTime() / 86_400_000) - currentDay;
    if (horizon < 2 || horizon > 4) continue;
    const date = jst.toISOString().slice(0, 10);
    const period = jst.getUTCHours() < 12 ? "午前" : "午後";
    // Extra routes get explicit slots instead of being silently dropped or
    // incorrectly assigned to Tokyo/Atami.
    const route = service.counterpartTerminal;
    const label = service.shipType === "large" ? "大型船" : horizon === 4 ? "ジェット船" : horizon === 3 ? `${period}・ジェット船` : `${period}・${route}航路`;
    const id = `group:${date}:${horizon}:${label}`;
    if (!groups.has(id)) groups.set(id, { id, date, horizon, label, shipType: service.shipType, members: [] });
    groups.get(id)!.members.push(service);
  }
  return [...groups.values()];
}
