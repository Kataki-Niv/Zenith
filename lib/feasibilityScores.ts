// frontend/lib/feasibilityScores.ts

export function getFeasibilityScore(location: string): number {
  if (!location) return 7.5;

  const loc = location.toLowerCase();

  // High solar + good economics
  if (loc.includes("chennai")) return 9.5;        // high irradiance
  if (loc.includes("hyderabad")) return 9.2;      // good sun + decent tariff
  if (loc.includes("bhubaneswar")) return 9.3;    // best irradiance (1.05)

  // High tariff → good ROI
  if (loc.includes("mumbai")) return 9.0;         // very high tariff (8.2)
  if (loc.includes("kolkata")) return 8.7;

  // Balanced cities
  if (loc.includes("delhi")) return 8.2;
  if (loc.includes("lucknow")) return 8.0;
  if (loc.includes("patna")) return 8.1;

  // Lower performance zones
  if (loc.includes("guwahati")) return 7.5;       // lower irradiance
  if (loc.includes("arrah")) return 7.2;          // no net metering

  return 7.5;
}
export function getInvestmentLabel(paybackYears: number) {
  if (paybackYears <= 8) return "GOOD";
  if (paybackYears > 12) return "POOR";
  return "MODERATE";
}
