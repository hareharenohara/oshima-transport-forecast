import type { ScheduleService } from "./types.js";

export interface RoundTripLink { roundTripId: string; partnerServiceId: string }

// A timetable does not identify hulls. These are route-operation pairs, not a claim
// that the same vessel physically operates both legs.
export function matchRoundTrips(services: ScheduleService[]): Map<string, RoundTripLink> {
  const links = new Map<string, RoundTripLink>();
  const routes = new Set(services.filter((s) => s.destination === "大島").map((s) => `${s.origin}|${s.shipType}`));
  for (const route of routes) {
    const [terminal, shipType] = route.split("|");
    const outbound = services.filter((s) => s.origin === terminal && s.destination === "大島" && s.shipType === shipType)
      .sort((a, b) => a.scheduledDepartureJst.localeCompare(b.scheduledDepartureJst));
    const returns = services.filter((s) => s.origin === "大島" && s.destination === terminal && s.shipType === shipType)
      .sort((a, b) => a.scheduledDepartureJst.localeCompare(b.scheduledDepartureJst));
    const used = new Set<string>();
    for (const first of outbound) {
      const arrived = Date.parse(first.scheduledArrivalJst);
      const jetReturnCode = first.shipType === "jet" && terminal === "東京"
        ? ({ "1210": "2230", "1220": "2220" } as Record<string, string>)[first.serviceNumber]
        : undefined;
      if (first.shipType === "jet" && terminal === "東京" && !jetReturnCode) continue;
      // Only the overnight large ship spans dates. A jet on the next day is
      // another scheduled operation, not evidence of a return trip.
      const lastEligible = first.shipType === "large" ? arrived + 24 * 60 * 60 * 1000 : null;
      const second = returns.find((candidate) => !used.has(candidate.id)
        && (!jetReturnCode || candidate.serviceNumber === jetReturnCode)
        && Date.parse(candidate.scheduledDepartureJst) > arrived
        && (lastEligible === null
          ? candidate.serviceDate === first.serviceDate
          : Date.parse(candidate.scheduledDepartureJst) <= lastEligible));
      if (!second) continue;
      used.add(second.id);
      links.set(first.id, { roundTripId: first.id, partnerServiceId: second.id });
      links.set(second.id, { roundTripId: first.id, partnerServiceId: first.id });
    }
  }
  return links;
}
